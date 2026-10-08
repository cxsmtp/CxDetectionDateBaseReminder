/*
 * charts.js — the small SVG chart set the calculator and its exported report
 * share. No chart library: every mark is emitted as SVG markup so the exported
 * HTML file stays self-contained and works with no network at all.
 *
 * Every renderer returns an HTML string. Colours arrive as arguments — the
 * palette lives in brand.js — and each chart is paired with a table view by
 * the caller, so no value is reachable only through a tooltip.
 */
window.CxCharts = {
  W: 860,
  H: 300,
  PAD: { top: 18, right: 20, bottom: 34, left: 62 },

  esc(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  /* ---------------------------------------------------------------- scales -- */

  niceTicks(min, max, count) {
    if (!isFinite(min) || !isFinite(max)) return { ticks: [0, 1], min: 0, max: 1 };
    if (min === max) { max = min + 1; }
    const span = max - min;
    const rough = span / Math.max(1, count);
    const magnitude = Math.pow(10, Math.floor(Math.log10(rough)));
    const candidates = [1, 2, 2.5, 5, 10].map((m) => m * magnitude);
    const step = candidates.find((c) => c >= rough) || candidates[candidates.length - 1];
    const start = Math.floor(min / step) * step;
    const end = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = start; v <= end + step * 0.5; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    return { ticks, min: start, max: end };
  },

  shortDate(iso) {
    if (!iso) return '';
    const [y, m, d] = String(iso).split('-').map(Number);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[(m || 1) - 1]} ${d}`;
  },

  axisLabel(value) {
    const abs = Math.abs(value);
    if (abs >= 1e9) return (value / 1e9).toFixed(abs % 1e9 === 0 ? 0 : 1) + 'B';
    if (abs >= 1e6) return (value / 1e6).toFixed(abs % 1e6 === 0 ? 0 : 1) + 'M';
    if (abs >= 1e3) return (value / 1e3).toFixed(abs % 1e3 === 0 ? 0 : 1) + 'k';
    return String(Math.round(value));
  },

  /* ------------------------------------------------------------- chrome ---- */

  frame(id, opts) {
    const pad = Object.assign({}, CxCharts.PAD, opts.pad || {});
    const width = opts.width || CxCharts.W;
    const height = opts.height || CxCharts.H;
    return {
      id, pad, width, height,
      plotW: width - pad.left - pad.right,
      plotH: height - pad.top - pad.bottom,
      x0: pad.left,
      y0: pad.top,
    };
  },

  yAxis(f, scale) {
    const parts = [];
    for (const t of scale.ticks) {
      const y = f.y0 + f.plotH - ((t - scale.min) / (scale.max - scale.min)) * f.plotH;
      parts.push(
        `<line class="cx-grid" x1="${f.x0}" y1="${y.toFixed(1)}" x2="${(f.x0 + f.plotW).toFixed(1)}" y2="${y.toFixed(1)}"/>` +
        `<text class="cx-tick" x="${f.x0 - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end">${CxCharts.axisLabel(t)}</text>`
      );
    }
    return parts.join('');
  },

  xAxis(f, labels) {
    const n = labels.length;
    if (!n) return '';
    const every = Math.max(1, Math.ceil(n / 9));
    const step = n > 1 ? f.plotW / (n - 1) : 0;
    const parts = [
      `<line class="cx-axis" x1="${f.x0}" y1="${f.y0 + f.plotH}" x2="${f.x0 + f.plotW}" y2="${f.y0 + f.plotH}"/>`,
    ];
    labels.forEach((label, i) => {
      if (i % every !== 0 && i !== n - 1) return;
      const x = f.x0 + (n > 1 ? i * step : f.plotW / 2);
      parts.push(
        `<text class="cx-tick" x="${x.toFixed(1)}" y="${f.y0 + f.plotH + 18}" text-anchor="middle">${CxCharts.esc(label)}</text>`
      );
    });
    return parts.join('');
  },

  /* Invisible per-column hit targets: the hover layer every chart shares. */
  hitLayer(f, count, tips) {
    if (!count) return '';
    const band = f.plotW / Math.max(1, count - (count > 1 ? 1 : 0));
    const parts = [`<g class="cx-hits">`];
    for (let i = 0; i < count; i++) {
      const centre = count > 1 ? f.x0 + i * band : f.x0 + f.plotW / 2;
      const left = Math.max(f.x0, centre - band / 2);
      const width = Math.min(band, f.x0 + f.plotW - left);
      parts.push(
        `<rect class="cx-hit" x="${left.toFixed(1)}" y="${f.y0}" width="${Math.max(1, width).toFixed(1)}" height="${f.plotH}" ` +
        `data-cx-index="${i}" data-cx-x="${centre.toFixed(1)}" data-cx-tip="${CxCharts.esc(tips[i] || '')}"/>`
      );
    }
    parts.push('</g>');
    return parts.join('');
  },

  crosshair(f) {
    return `<line class="cx-crosshair" x1="0" y1="${f.y0}" x2="0" y2="${f.y0 + f.plotH}" style="opacity:0"/>`;
  },

  open(f, cls) {
    return `<svg class="cx-chart ${cls || ''}" viewBox="0 0 ${f.width} ${f.height}" ` +
      `preserveAspectRatio="xMidYMid meet" role="img">`;
  },

  /* ------------------------------------------------------- stacked area ---- */

  /** Backlog composition over time — one band per severity, worst at the bottom. */
  stackedArea(opts) {
    const { labels, series, tipRows } = opts;
    const f = CxCharts.frame(opts.id, opts);
    const n = labels.length;
    if (!n) return '';

    const totals = labels.map((_, i) => series.reduce((a, s) => a + (s.values[i] || 0), 0));
    const scale = CxCharts.niceTicks(0, Math.max(...totals, 1), 4);
    const xAt = (i) => f.x0 + (n > 1 ? (i / (n - 1)) * f.plotW : f.plotW / 2);
    const yAt = (v) => f.y0 + f.plotH - ((v - scale.min) / (scale.max - scale.min)) * f.plotH;

    const baseline = new Array(n).fill(0);
    const bands = [];
    for (const s of series) {
      const top = baseline.map((b, i) => b + (s.values[i] || 0));
      const up = top.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' L');
      const down = baseline.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).reverse().join(' L');
      bands.push(
        `<path class="cx-band" d="M${up} L${down} Z" fill="${s.color}" fill-opacity="0.9"/>` +
        `<path class="cx-band-edge" d="M${up}" fill="none" stroke="var(--surface)" stroke-width="2"/>`
      );
      for (let i = 0; i < n; i++) baseline[i] = top[i];
    }

    return CxCharts.open(f, 'cx-stacked') +
      CxCharts.yAxis(f, scale) +
      bands.join('') +
      CxCharts.xAxis(f, labels) +
      CxCharts.crosshair(f) +
      CxCharts.hitLayer(f, n, tipRows) +
      '</svg>';
  },

  /* --------------------------------------------------------- grouped bars -- */

  /**
   * Arrivals against clearances, week by week. Both series are counts of
   * findings on one shared axis — never a percentage of a backlog that moves,
   * which is what makes a rate chart unreadable the moment coverage changes.
   */
  flow(opts) {
    const { labels, groups, tipRows } = opts;
    const f = CxCharts.frame(opts.id, opts);
    const n = labels.length;
    if (!n) return '';

    const values = groups.flatMap((g) => g.values.filter((v) => v !== null && isFinite(v)));
    const scale = CxCharts.niceTicks(0, Math.max(1, ...values), 4);

    const band = f.plotW / n;
    const gap = 2;
    const barW = Math.max(2, (band * 0.64 - gap * (groups.length - 1)) / groups.length);
    const yAt = (v) => f.y0 + f.plotH - ((v - scale.min) / (scale.max - scale.min)) * f.plotH;
    const zero = yAt(0);

    const bars = [];
    labels.forEach((_, i) => {
      const groupLeft = f.x0 + band * i + (band - (barW * groups.length + gap * (groups.length - 1))) / 2;
      groups.forEach((g, gi) => {
        const v = g.values[i];
        if (v === null || v === undefined || !isFinite(v)) return;
        const y = Math.min(zero, yAt(Math.max(0, v)));
        const h = Math.max(1, Math.abs(zero - yAt(Math.max(0, v))));
        const x = groupLeft + gi * (barW + gap);
        bars.push(
          `<rect class="cx-bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" ` +
          `height="${h.toFixed(1)}" rx="${Math.min(4, barW / 2).toFixed(1)}" fill="${g.color}"/>`
        );
      });
    });

    return CxCharts.open(f, 'cx-flow') +
      CxCharts.yAxis(f, scale) +
      bars.join('') +
      CxCharts.xAxis(f, labels) +
      CxCharts.crosshair(f) +
      CxCharts.hitLayer(f, n, tipRows) +
      '</svg>';
  },

  /* ---------------------------------------------------------------- lines -- */

  /** Forecast comparison: one line per future, endpoint direct-labelled. */
  lines(opts) {
    const { labels, series, tipRows } = opts;
    const f = CxCharts.frame(opts.id, Object.assign({ pad: { right: 104 } }, opts));
    const n = labels.length;
    if (!n) return '';

    const values = series.flatMap((s) => s.values.filter((v) => v !== null && isFinite(v)));
    const scale = CxCharts.niceTicks(0, Math.max(1, ...values), 4);
    const xAt = (i) => f.x0 + (n > 1 ? (i / (n - 1)) * f.plotW : f.plotW / 2);
    const yAt = (v) => f.y0 + f.plotH - ((v - scale.min) / (scale.max - scale.min)) * f.plotH;

    const paths = series.map((s) => {
      const points = s.values
        .map((v, i) => (v === null || !isFinite(v) ? null : `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`))
        .filter(Boolean);
      if (points.length < 2) return '';
      const last = points[points.length - 1].split(',');
      const dash = s.dashed ? ' stroke-dasharray="6 4"' : '';
      return `<path class="cx-line" d="M${points.join(' L')}" fill="none" stroke="${s.color}" stroke-width="2.5"${dash}/>` +
        `<circle class="cx-dot" cx="${last[0]}" cy="${last[1]}" r="4" fill="${s.color}"/>` +
        `<text class="cx-endlabel" x="${(Number(last[0]) + 8).toFixed(1)}" y="${(Number(last[1]) + 4).toFixed(1)}" fill="${s.color}">${CxCharts.esc(s.endLabel || '')}</text>`;
    });

    return CxCharts.open(f, 'cx-lines') +
      CxCharts.yAxis(f, scale) +
      paths.join('') +
      CxCharts.xAxis(f, labels) +
      CxCharts.crosshair(f) +
      CxCharts.hitLayer(f, n, tipRows) +
      '</svg>';
  },

  /* -------------------------------------------------------------- tooltip -- */

  /**
   * One delegated hover layer for every chart on the page. Values are
   * duplicated in the table views, so the tooltip is an enhancement rather
   * than the only route to a number.
   */
  bind(root) {
    const scope = root || document;
    let tip = document.getElementById('cx-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'cx-tooltip';
      tip.className = 'cx-tooltip';
      tip.setAttribute('role', 'status');
      document.body.appendChild(tip);
    }

    const hide = () => { tip.classList.remove('is-visible'); };

    const show = (target, clientX, clientY) => {
      const html = target.getAttribute('data-cx-tip');
      if (!html) return;
      tip.innerHTML = html;
      tip.classList.add('is-visible');
      const box = tip.getBoundingClientRect();
      let left = clientX + 14;
      let top = clientY - box.height - 12;
      if (left + box.width > window.innerWidth - 8) left = clientX - box.width - 14;
      if (top < 8) top = clientY + 18;
      tip.style.left = `${Math.max(8, left)}px`;
      tip.style.top = `${top}px`;

      const svg = target.closest('svg');
      const crosshair = svg && svg.querySelector('.cx-crosshair');
      const x = target.getAttribute('data-cx-x');
      if (crosshair && x) {
        crosshair.setAttribute('x1', x);
        crosshair.setAttribute('x2', x);
        crosshair.style.opacity = '1';
      }
    };

    scope.addEventListener('mousemove', (event) => {
      const target = event.target.closest('[data-cx-tip]');
      if (target) show(target, event.clientX, event.clientY);
      else {
        hide();
        scope.querySelectorAll('.cx-crosshair').forEach((c) => { c.style.opacity = '0'; });
      }
    });
    scope.addEventListener('mouseleave', hide, true);
    scope.addEventListener('scroll', hide, true);
  },
};
