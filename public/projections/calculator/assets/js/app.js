/*
 * app.js — UI wiring for the Backlog Cost Calculator.
 *
 * Vendored into CxMissionZero (Credit projections → À la carte) from
 * github.com/cxsmtp/CxBacklogCostCalculator at 5da1f84. The only change is the
 * "CxMissionZero profiles" section at the end, which lets the page around it save
 * and reopen what is here.
 *
 * Everything happens in the browser: the workbooks are read locally, the model
 * runs locally, and the exported report is assembled locally. No network call
 * is made at any point, which is what makes it safe to drop customer data in.
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const SEVERITIES = CxModel.SEVERITIES;
  const esc = CxCharts.esc;

  const state = {
    customer: '',
    preparedBy: '',
    logoDataUrl: null,
    totals: null,
    fixed: null,
    frames: null,
    plan: null,            // { severity: { selected, fp } } — null until data lands
    planTouched: false,
    assumptions: {
      triageCredits: CxModel.DEFAULTS.triageCredits,
      remediationCredits: CxModel.DEFAULTS.remediationCredits,
      falsePositive: Object.assign({}, CxModel.DEFAULTS.falsePositive),
    },
    windowWeeks: CxModel.monthsToWeeks(CxModel.DEFAULTS.windowMonths),
    windowOptions: [],
    horizonMonths: CxModel.DEFAULTS.horizonMonths,
    pace: null,            // null until the data can set a sensible default
    stats: null,
    cost: null,
    forecast: null,
  };

  /* ------------------------------------------------------------- utilities -- */

  const severityDot = (severity, colors) =>
    `<span class="sev-dot" style="background:${colors[severity]}"></span>`;

  const slug = (text) =>
    (text || 'customer').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  function showMessages(items) {
    $('input-messages').innerHTML = items
      .map((m) => `<div class="callout ${m.kind}">${m.text}</div>`).join('');
  }

  /* ------------------------------------------------------------ file intake -- */

  let pendingKind = null;

  async function ingest(file, kind) {
    const slot = kind === 'fixed' ? 'fixed' : 'totals';
    const zone = kind === 'fixed' ? $('drop-fixed') : $('drop-total');
    const label = kind === 'fixed' ? $('file-fixed') : $('file-total');
    label.textContent = `Reading ${file.name}…`;
    try {
      const sheets = await CxXlsx.readFile(file);
      const parsed = CxParse.parseWorkbook(sheets, file.name);
      state[slot] = parsed;
      state.planTouched = false;            // new data, new default plan
      zone.classList.add('is-loaded');
      label.innerHTML =
        `<span class="status">✓ ${esc(file.name)}</span><br>` +
        `${parsed.weeks.length} weeks, ${esc(parsed.weeks[0])} → ${esc(parsed.weeks[parsed.weeks.length - 1])}` +
        `<br><button type="button" class="ghost" data-clear="${kind}" style="margin-top:8px;padding:4px 10px;font-size:12px">Replace</button>`;
      label.querySelector('[data-clear]').addEventListener('click', (event) => {
        event.stopPropagation();
        clearSlot(kind);
      });
    } catch (error) {
      zone.classList.remove('is-loaded');
      label.textContent = 'Drop the .xlsx here, or click to choose';
      showMessages([{ kind: 'bad', text: esc(error.message) }]);
      return;
    }
    recompute();
  }

  function clearSlot(kind) {
    state[kind === 'fixed' ? 'fixed' : 'totals'] = null;
    state.planTouched = false;
    const zone = kind === 'fixed' ? $('drop-fixed') : $('drop-total');
    const label = kind === 'fixed' ? $('file-fixed') : $('file-total');
    zone.classList.remove('is-loaded');
    label.textContent = 'Drop the .xlsx here, or click to choose';
    recompute();
  }

  /** Route files by filename and content, so both can be dropped at once. */
  async function routeFiles(files, forcedKind) {
    const list = Array.from(files);
    for (const file of list) {
      let kind = list.length > 1 ? null : forcedKind;
      if (!kind) {
        let sheets = null;
        try { sheets = await CxXlsx.readFile(file); } catch (_) { /* fall back to the name */ }
        kind = CxParse.guessKind(file.name, sheets) || forcedKind || (state.totals ? 'fixed' : 'total');
      }
      await ingest(file, kind === 'fixed' ? 'fixed' : 'total');
    }
  }

  function wireDropzone(zone, kind) {
    const open = () => {
      if (zone.classList.contains('is-loaded')) return;
      pendingKind = kind;
      $('file-input').click();
    };
    zone.addEventListener('click', open);
    zone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
    });
    ['dragenter', 'dragover'].forEach((type) => zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.add('is-over');
    }));
    ['dragleave', 'drop'].forEach((type) =>
      zone.addEventListener(type, () => zone.classList.remove('is-over')));
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      if (event.dataTransfer.files.length) routeFiles(event.dataTransfer.files, kind);
    });
  }

  async function loadSample() {
    const files = [
      ['samples/Total_Vulnerabilities_by_Severity.xlsx', 'total'],
      ['samples/Fixed_Vulnerabilities_by_Severity.xlsx', 'fixed'],
    ];
    try {
      for (const [path, kind] of files) {
        const response = await fetch(path);
        if (!response.ok) throw new Error(`${path} (${response.status})`);
        const blob = await response.blob();
        await ingest(new File([blob], path.split('/').pop()), kind);
      }
      if (!$('customer-name').value) $('customer-name').value = 'Sample Customer';
      recompute();
    } catch (error) {
      showMessages([{
        kind: 'warn',
        text: `Could not load the bundled sample (${esc(error.message)}). Opening index.html ` +
          'straight from disk blocks it — serve the folder with ' +
          '<code>python3 -m http.server</code>, or upload the two files by hand.',
      }]);
    }
  }

  /* ------------------------------------------------------------ computation -- */

  function dataMessages() {
    const items = [];
    for (const [slot, name] of [['totals', 'Total vulnerabilities'], ['fixed', 'Fixed vulnerabilities']]) {
      for (const warning of (state[slot] && state[slot].warnings) || []) {
        items.push({ kind: 'warn', text: `<strong>${name}:</strong> ${esc(warning)}` });
      }
    }
    if (!state.frames) return items;

    if (state.frames.missingTotals.length) {
      items.push({
        kind: 'warn',
        text: `${state.frames.missingTotals.length} week(s) appear only in the fixed export ` +
          `(${esc(state.frames.missingTotals.slice(0, 3).join(', '))}). They are charted but skipped in the rate averages.`,
      });
    }
    if (state.frames.missingFixed.length) {
      items.push({
        kind: 'warn',
        text: `${state.frames.missingFixed.length} week(s) appear only in the totals export ` +
          `(${esc(state.frames.missingFixed.slice(0, 3).join(', '))}).`,
      });
    }

    // A negative implied influx means more was closed than the backlog fell by:
    // usually a rescope, a deleted project, or mismatched filters between exports.
    const negatives = CxModel.rollup(state.frames.introduced).filter((v) => v !== null && v < 0).length;
    if (negatives) {
      items.push({
        kind: 'warn',
        text: `${negatives} week(s) imply a negative arrival rate — more findings were closed ` +
          'than the backlog fell by. That usually means projects left the scope, or the two ' +
          'exports were filtered differently. Compare the Filters tab of both files.',
      });
    }

    const provenance = [];
    for (const slot of ['totals', 'fixed']) {
      const meta = state[slot] && state[slot].meta;
      if (meta && meta.exportedAt) {
        provenance.push(`${slot === 'fixed' ? 'Fixed' : 'Totals'} exported ${esc(String(meta.exportedAt).slice(0, 10))}`);
      }
    }
    if (provenance.length) items.push({ kind: 'good', text: provenance.join(' · ') });
    return items;
  }

  function defaultPace() {
    const measured = Math.max(0, state.stats.total.fixRate);
    return measured > 0 ? Math.round(measured) : Math.max(1, Math.round(state.stats.total.backlog / 52));
  }

  function syncPaceSlider() {
    const selected = state.cost.count;
    const ceiling = Math.max(
      10, state.stats.total.debtRate * 2, state.stats.total.fixRate * 2, selected / 13, 1);
    const paceMax = Math.ceil(ceiling / 10) * 10;
    const input = $('pace');
    input.max = String(paceMax);
    input.step = String(Math.max(1, Math.round(paceMax / 200)));
    input.value = String(Math.min(state.pace, paceMax));
    state.pace = Number(input.value);
  }

  function recompute() {
    state.customer = $('customer-name').value.trim();
    state.preparedBy = $('prepared-by').value.trim();

    const ready = state.totals && state.fixed;
    $('results').classList.toggle('hidden', !ready);
    $('btn-export').disabled = !ready;

    if (!ready) { state.frames = null; showMessages(dataMessages()); notifyHost(); return; }

    state.frames = CxModel.align(state.totals, state.fixed);
    showMessages(dataMessages());

    // Only offer timelines this dataset can actually cover, and snap the
    // current choice to the closest one that survives.
    state.windowOptions = CxModel.windowOptions(state.frames);
    const resolved = CxModel.resolveWindow(state.frames, state.windowWeeks);
    if (resolved) state.windowWeeks = resolved.weeks;
    state.stats = CxModel.stats(state.frames, state.windowWeeks);

    if (!state.plan || !state.planTouched) {
      state.plan = CxModel.defaultPlan(state.stats, state.assumptions);
    } else {
      state.plan = CxModel.clampPlan(state.plan, state.stats);
    }
    if (state.pace === null) state.pace = defaultPace();

    renderWindowChips();
    renderHorizonChips();
    renderSevGrid();
    computePlan();
    renderHistory();
    notifyHost();
  }

  /* ------------------------------------------------------------ timelines -- */

  function renderWindowChips() {
    $('window-chips').innerHTML = state.windowOptions.map((o) =>
      `<button type="button" class="chip ${o.weeks === state.windowWeeks ? 'is-on' : ''}" ` +
      `data-window="${o.weeks}" aria-pressed="${o.weeks === state.windowWeeks}">${o.label}</button>`).join('');
    $('window-chips').querySelectorAll('button[data-window]').forEach((button) => {
      button.addEventListener('click', () => {
        state.windowWeeks = Number(button.dataset.window);
        recompute();
      });
    });

    const stats = state.stats;
    $('window-caption').textContent =
      `Rates measured from ${stats.windowStart} to ${stats.lastWeek} — ` +
      `${stats.windowWeeks} week${stats.windowWeeks === 1 ? '' : 's'} of movement. ` +
      `${state.frames.weeks.length} weekly snapshots available in total.`;
  }

  function renderHorizonChips() {
    const options = [3, 6, 9, 12, 18, 24];
    $('horizon-chips').innerHTML = options.map((m) =>
      `<button type="button" class="chip ${m === state.horizonMonths ? 'is-on' : ''}" ` +
      `data-horizon="${m}" aria-pressed="${m === state.horizonMonths}">${m} months</button>`).join('');
    $('horizon-chips').querySelectorAll('button[data-horizon]').forEach((button) => {
      button.addEventListener('click', () => {
        state.horizonMonths = Number(button.dataset.horizon);
        renderHorizonChips();
        computePlan();
      });
    });
  }

  /** Everything downstream of the sliders — cheap enough to run on every drag. */
  function computePlan() {
    state.cost = CxModel.cost(state.plan, state.stats, state.assumptions);
    syncPaceSlider();
    state.forecast = CxModel.forecast({
      backlog: state.stats.total.backlog,
      debtRate: state.stats.total.debtRate,
      selected: state.cost.count,
      pace: state.pace,
      horizonWeeks: CxModel.monthsToWeeks(state.horizonMonths),
      startWeek: state.stats.lastWeek,
    });

    renderCostKpis();
    renderCostTable();
    renderForecast();
    $('pace-out').textContent = CxModel.int(state.pace);
    $('pace-hint').textContent =
      `Measured pace is ${CxModel.int(state.stats.total.fixRate)}/week. ` +
      `${CxModel.int(state.stats.total.debtRate)}/week arrive, so anything below that loses ground.`;
    notifyHost();
  }

  /* ---------------------------------------------------------- plan sliders -- */

  function renderSevGrid() {
    const colors = CxBrand.severityColors();
    $('sev-grid').innerHTML = SEVERITIES.map((s) => {
      const backlog = Math.round(state.stats.bySeverity[s].backlog);
      const row = state.plan[s];
      return `<div class="sev-box">
        <div class="sev-head">
          ${severityDot(s, colors)}<strong>${s}</strong>
          <span class="sev-open">${CxModel.int(backlog)} open</span>
        </div>
        <div class="slider-row">
          <span>To triage</span><output data-sel-out="${s}">${CxModel.int(row.selected)}</output>
        </div>
        <input type="range" min="0" max="${backlog}" step="${Math.max(1, Math.round(backlog / 500))}"
               value="${row.selected}" data-sel="${s}" aria-label="Findings to triage for ${s}">
        <div class="slider-row">
          <span>Est. false positive %</span><output data-fp-out="${s}">${row.fp}%</output>
        </div>
        <input type="range" min="0" max="100" step="1" value="${row.fp}" data-fp="${s}"
               aria-label="False-positive rate for ${s}">
        <p class="sev-foot" data-cost-out="${s}"></p>
      </div>`;
    }).join('');

    $('sev-grid').querySelectorAll('input[data-sel]').forEach((slider) => {
      slider.addEventListener('input', () => {
        state.planTouched = true;
        state.plan[slider.dataset.sel].selected = Number(slider.value);
        $('sev-grid').querySelector(`[data-sel-out="${slider.dataset.sel}"]`).textContent =
          CxModel.int(Number(slider.value));
        computePlan();
      });
    });
    $('sev-grid').querySelectorAll('input[data-fp]').forEach((slider) => {
      slider.addEventListener('input', () => {
        state.planTouched = true;
        state.plan[slider.dataset.fp].fp = Number(slider.value);
        $('sev-grid').querySelector(`[data-fp-out="${slider.dataset.fp}"]`).textContent = `${slider.value}%`;
        computePlan();
      });
    });
  }

  /** Push plan values back into the sliders after a bulk change. */
  function syncSevGrid() {
    SEVERITIES.forEach((s) => {
      const row = state.plan[s];
      const sel = $('sev-grid').querySelector(`input[data-sel="${s}"]`);
      const fp = $('sev-grid').querySelector(`input[data-fp="${s}"]`);
      if (sel) { sel.value = String(row.selected); $('sev-grid').querySelector(`[data-sel-out="${s}"]`).textContent = CxModel.int(row.selected); }
      if (fp) { fp.value = String(row.fp); $('sev-grid').querySelector(`[data-fp-out="${s}"]`).textContent = `${row.fp}%`; }
    });
  }

  function setPlan(mutate) {
    state.planTouched = true;
    SEVERITIES.forEach((s) => mutate(s, state.plan[s], Math.round(state.stats.bySeverity[s].backlog)));
    state.plan = CxModel.clampPlan(state.plan, state.stats);
    syncSevGrid();
    computePlan();
  }

  /* ------------------------------------------------------ history rendering -- */

  function renderHistory() {
    const colors = CxBrand.severityColors();
    const flow = CxBrand.flowColors();
    const stats = state.stats;

    renderKpis(stats);
    renderHeadline(stats);
    renderBacklogChart(colors);
    renderFlowChart(flow);

    $('trend-sub').textContent =
      `All ${stats.weeksOfData} weeks of history, ${stats.firstWeek} → ${stats.lastWeek}.`;
  }

  function kpiCard(label, value, sub, tone) {
    return `<div class="kpi ${tone || ''}">
      <span class="label">${label}</span>
      <span class="value">${value}</span>
      <span class="sub">${sub}</span>
    </div>`;
  }

  function renderKpis(stats) {
    const t = stats.total;
    const losing = t.change > 0;

    $('kpis').innerHTML = [
      kpiCard('Open findings', CxModel.int(t.backlog), `as of ${stats.lastWeek}`),
      kpiCard('Debt increase', CxModel.pct(t.debtIncrease, 1),
        `${CxModel.signed(t.change)} findings since ${stats.windowStart}`, losing ? 'bad' : 'good'),
      kpiCard('Cleared', CxModel.pct(t.clearedShare, 1),
        `${CxModel.int(t.fixed)} closed, against the backlog at ${stats.windowStart}`, 'good'),
      kpiCard('Kept up with', CxModel.pct(t.keepUp),
        `${CxModel.int(t.fixed)} closed of ${CxModel.int(t.introduced)} that arrived`,
        (t.keepUp || 0) >= 1 ? 'good' : 'bad'),
    ].join('');
  }

  function renderHeadline(stats) {
    const t = stats.total;
    const perHundred = Math.round((t.keepUp || 0) * 100);
    const doubles = t.netWeekly > 0 ? t.backlog / t.netWeekly : null;
    $('headline').innerHTML = t.netWeekly > 0
      ? `For every <strong>100</strong> findings that arrive, the team clears <strong>${perHundred}</strong>. ` +
        `That is <strong>${CxModel.int(t.debtRate)}</strong> in and <strong>${CxModel.int(t.fixRate)}</strong> out ` +
        `a week, so the backlog grows by <strong>${CxModel.int(t.netWeekly)}</strong> a week — it doubles in about ` +
        `<strong>${CxModel.weeksAsDuration(doubles)}</strong> if nothing changes.`
      : `The team clears <strong>${perHundred}</strong> of every 100 findings that arrive — ` +
        `<strong>${CxModel.int(t.debtRate)}</strong> in against <strong>${CxModel.int(t.fixRate)}</strong> out ` +
        `a week. The backlog is shrinking on its own.`;
  }

  function renderBacklogChart(colors) {
    const frames = state.frames;
    const labels = frames.weeks.map(CxCharts.shortDate);
    const series = SEVERITIES.slice().reverse().map((s) => ({
      key: s, color: colors[s], values: frames.open[s].map((v) => v ?? 0),
    }));
    const tips = frames.weeks.map((week, i) => {
      const rows = SEVERITIES.map((s) =>
        `<div class="t-row"><span>${s}</span><span>${CxModel.int(frames.open[s][i])}</span></div>`).join('');
      const total = CxModel.sum(SEVERITIES.map((s) => frames.open[s][i] || 0));
      return `<div class="t-title">${week}</div>${rows}` +
        `<div class="t-row t-total"><span>Open</span><span>${CxModel.int(total)}</span></div>`;
    });

    $('chart-backlog').innerHTML = CxCharts.stackedArea({
      id: 'backlog', labels, series, tipRows: tips,
    });
    $('legend-backlog').innerHTML = SEVERITIES.map((s) =>
      `<span class="item"><span class="swatch" style="background:${colors[s]}"></span>${s}</span>`).join('');

    const open = CxModel.rollup(frames.open);
    $('table-backlog').innerHTML = table(
      ['Week ending'].concat(SEVERITIES).concat(['Total open']),
      frames.weeks.map((week, i) =>
        [week].concat(SEVERITIES.map((s) => CxModel.int(frames.open[s][i]))).concat([CxModel.int(open[i])])));
  }

  function renderFlowChart(flow) {
    const frames = state.frames;
    const introduced = CxModel.rollup(frames.introduced);
    const cleared = CxModel.rollup(frames.fixed);
    const labels = frames.weeks.map(CxCharts.shortDate);

    const tips = frames.weeks.map((week, i) => {
      const arrived = introduced[i];
      const closed = cleared[i];
      const keepUp = arrived > 0 ? Math.round((closed / arrived) * 100) : null;
      return `<div class="t-title">${week}</div>` +
        `<div class="t-row"><span>Arrived</span><span>${CxModel.int(arrived)}</span></div>` +
        `<div class="t-row"><span>Closed</span><span>${CxModel.int(closed)}</span></div>` +
        `<div class="t-row t-total"><span>Net</span><span>${CxModel.signed(
          arrived === null || closed === null ? null : arrived - closed)}</span></div>` +
        (keepUp === null ? '' : `<div class="t-row"><span>Kept up with</span><span>${keepUp}%</span></div>`);
    });

    $('chart-flow').innerHTML = CxCharts.flow({
      id: 'flow',
      labels,
      groups: [
        { key: 'introduced', color: flow.introduced, values: introduced },
        { key: 'cleared', color: flow.cleared, values: cleared },
      ],
      tipRows: tips,
      height: 260,
    });
    $('legend-flow').innerHTML =
      `<span class="item"><span class="swatch" style="background:${flow.introduced}"></span>New findings (debt rate)</span>` +
      `<span class="item"><span class="swatch" style="background:${flow.cleared}"></span>Findings closed (fix rate)</span>`;

    $('table-flow').innerHTML = table(
      ['Week ending', 'Arrived', 'Closed', 'Net', 'Kept up with'],
      frames.weeks.map((week, i) => {
        const arrived = introduced[i];
        const closed = cleared[i];
        return [
          week, CxModel.int(arrived), CxModel.int(closed),
          CxModel.signed(arrived === null || closed === null ? null : arrived - closed),
          arrived > 0 ? `${Math.round((closed / arrived) * 100)}%` : '—',
        ];
      }));
  }

  /* --------------------------------------------------------- cost rendering -- */

  function renderCostKpis() {
    const cost = state.cost;
    const f = state.forecast;
    const reduction = cost.backlog > 0 ? cost.count / cost.backlog : 0;
    $('cost-kpis').innerHTML = [
      kpiCard('Total cost', `${CxModel.int(cost.total)} cr`,
        `${CxModel.int(cost.triage)} triage + ${CxModel.int(cost.remediation)} remediation`, 'accent'),
      kpiCard('Selected to triage', CxModel.int(cost.count),
        `of ${CxModel.int(cost.backlog)} open · ${cost.creditsEach.toFixed(2)} credits each`),
      kpiCard('Backlog reduction', CxModel.pct(reduction, 1),
        `leaves ${CxModel.int(cost.backlogAfter)} of today's backlog open`),
      kpiCard('Time to work through it',
        cost.count > 0 ? CxModel.weeksAsDuration(f.weeksToFinishPlan) : '—',
        cost.count > 0 ? `at ${CxModel.int(state.pace)} findings a week` : 'nothing selected yet'),
    ].join('');

    const colors = CxBrand.severityColors();
    cost.rows.forEach((row) => {
      const foot = $('sev-grid') && $('sev-grid').querySelector(`[data-cost-out="${row.severity}"]`);
      if (!foot) return;
      foot.innerHTML = row.selected === 0
        ? 'Not in the plan — no credits.'
        : `<strong>${CxModel.int(row.total)} credits</strong> · ${CxModel.int(row.truePositives)} to fix` +
          (row.deferred > 0 ? ` · ${CxModel.int(row.deferred)} left open` : '');
      foot.style.borderTopColor = colors[row.severity];
    });
  }

  /**
   * The matrix: one row per metric, one column per severity, a Total column.
   * Reading down a column answers "what does Critical cost"; reading across a
   * row answers "where does the money go". Both are questions people ask out
   * loud in the meeting, which a severity-per-row table answers only one of.
   */
  function renderCostTable() {
    const cost = state.cost;
    const stats = state.stats;
    const colors = CxBrand.severityColors();
    const SEVS = SEVERITIES;
    const windowLabel = windowName();

    const head = ['<th style="text-align:left">Metric</th>']
      .concat(SEVS.map((s) =>
        `<th><span class="sev-head-cell">${severityDot(s, colors)}${s}</span></th>`))
      .concat(['<th class="total-col">Total</th>']).join('');

    const row = (label, cells, total, cls) =>
      `<tr class="${cls || ''}"><td>${label}</td>` +
      cells.map((c) => `<td>${c}</td>`).join('') +
      `<td class="total-col">${total}</td></tr>`;

    const rows = [
      row('Open backlog', SEVS.map((s) => CxModel.int(stats.bySeverity[s].backlog)),
        CxModel.int(stats.total.backlog)),
      row(`Debt increase (${windowLabel})`,
        SEVS.map((s) => CxModel.pct(stats.bySeverity[s].debtIncrease, 1)),
        CxModel.pct(stats.total.debtIncrease, 1), 'is-muted'),
      row(`Cleared (${windowLabel})`,
        SEVS.map((s) => CxModel.pct(stats.bySeverity[s].clearedShare, 1)),
        CxModel.pct(stats.total.clearedShare, 1), 'is-muted'),
      row(`Kept up with arrivals (${windowLabel})`,
        SEVS.map((s) => CxModel.pct(stats.bySeverity[s].keepUp)),
        CxModel.pct(stats.total.keepUp), 'is-muted'),
      row('Selected to triage', SEVS.map((s) => CxModel.int(cost.bySeverity[s].selected)),
        CxModel.int(cost.count), 'is-highlight'),
      row('False positive %', SEVS.map((s) => `${Math.round(cost.bySeverity[s].fp)}%`),
        cost.count > 0 ? `${Math.round((cost.falsePositives / cost.count) * 100)}%` : '—', 'is-muted'),
      row('True positives (est.)', SEVS.map((s) => CxModel.int(cost.bySeverity[s].truePositives)),
        CxModel.int(cost.truePositives)),
      row(`Triage credits (${state.assumptions.triageCredits}/item)`,
        SEVS.map((s) => CxModel.int(cost.bySeverity[s].triage)), CxModel.int(cost.triage)),
      row(`Remediation credits (${state.assumptions.remediationCredits}/true positive)`,
        SEVS.map((s) => CxModel.int(cost.bySeverity[s].remediation)), CxModel.int(cost.remediation)),
      row('Total credits', SEVS.map((s) => `<strong>${CxModel.int(cost.bySeverity[s].total)}</strong>`),
        `<strong>${CxModel.int(cost.total)}</strong>`, 'is-total'),
      row("Backlog after this plan", SEVS.map((s) => CxModel.int(cost.bySeverity[s].backlogAfter)),
        CxModel.int(cost.backlogAfter)),
    ].join('');

    $('table-cost').innerHTML =
      `<table class="data matrix"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>` +
      '<p class="hint" style="margin-top:10px">' +
      '“Backlog after this plan” is today’s backlog minus what the plan clears. ' +
      'It is not a backlog at a future date — new findings keep arriving, which is what the forecast below shows.' +
      '</p>';
  }

  /** Short form of the chosen window, for use inside a table label. */
  function windowName() {
    const match = state.windowOptions.find((o) => o.weeks === state.windowWeeks);
    return match ? match.short : `${state.windowWeeks} weeks`;
  }

  function renderForecast() {
    const f = state.forecast;
    const scenario = CxBrand.scenarioColors();
    const labels = f.weeks.map((w) => CxCharts.shortDate(w.date));
    const series = [
      { key: 'nothing', color: scenario.nothing, dashed: true,
        values: f.weeks.map((w) => w.noAction), endLabel: CxModel.compact(f.endNoAction) },
      { key: 'plan', color: scenario.target,
        values: f.weeks.map((w) => w.withPlan), endLabel: CxModel.compact(f.endWithPlan) },
    ];
    const tips = f.weeks.map((w) =>
      `<div class="t-title">Week ${w.week} — ${CxCharts.shortDate(w.date)}</div>` +
      `<div class="t-row"><span>Do nothing</span><span>${CxModel.int(w.noAction)}</span></div>` +
      `<div class="t-row"><span>With this plan</span><span>${CxModel.int(w.withPlan)}</span></div>` +
      `<div class="t-row t-total"><span>Difference</span><span>${CxModel.int(w.noAction - w.withPlan)}</span></div>`);

    $('chart-forecast').innerHTML = CxCharts.lines({
      id: 'forecast', labels, series, tipRows: tips, height: 280,
    });
    $('legend-forecast').innerHTML =
      `<span class="item"><span class="swatch line" style="background:${scenario.nothing}"></span>Do nothing</span>` +
      `<span class="item"><span class="swatch line" style="background:${scenario.target}"></span>This plan at ${CxModel.int(state.pace)}/week</span>`;

    $('forecast-sub').textContent =
      `Next ${state.horizonMonths} months. Both futures take the same ${CxModel.int(f.arrivals)} ` +
      'new findings a week — measured, not assumed. Only the pace differs.';

    if (f.scope <= 0) {
      $('forecast-note').innerHTML =
        'Nothing is selected, so this plan costs nothing and moves nothing — the backlog keeps taking ' +
        `<strong>${CxModel.int(f.arrivals)}</strong> new findings a week. Move a slider above to build a plan.`;
      return;
    }

    const holds = f.pace >= f.arrivals;
    $('forecast-note').innerHTML =
      `<strong>${CxModel.int(f.pace)} findings a week</strong> works through the ` +
      `${CxModel.int(f.scope)} selected in <strong>${CxModel.weeksAsDuration(f.weeksToFinishPlan)}</strong>, ` +
      `for ${CxModel.int(state.cost.total)} credits. ` +
      (holds
        ? `That also outruns the ${CxModel.int(f.arrivals)} arriving each week, so the whole backlog reaches zero in ` +
          `<strong>${CxModel.weeksAsDuration(f.weeksToZero)}</strong>.`
        : `It does not keep up with the ${CxModel.int(f.arrivals)} arriving each week, so the backlog still grows: ` +
          `sustaining <strong>${CxModel.int(f.paceToHold)}/week</strong> is what holds the line, and anything above ` +
          'that starts killing the debt.');
  }

  /* -------------------------------------------------------------- table -- */

  function table(head, rows, foot) {
    return `<table class="data"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>` +
      `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>` +
      (foot ? `<tfoot><tr>${foot.map((c) => `<td>${c}</td>`).join('')}</tr></tfoot>` : '') +
      '</table>';
  }

  /* ----------------------------------------------------------------- export -- */

  function exportContext() {
    return {
      customer: state.customer,
      preparedBy: state.preparedBy,
      logoDataUrl: state.logoDataUrl,
      title: $('report-title').value.trim() || 'Security debt: the cost to clear it',
      validity: $('report-validity').value.trim(),
      generatedAt: new Date().toISOString(),
      frames: state.frames,
      plan: state.plan,
      assumptions: state.assumptions,
      windowWeeks: state.windowWeeks,
      windowOptions: state.windowOptions,
      horizonMonths: state.horizonMonths,
      pace: state.pace,
      palette: {
        severity: CxBrand.severity,
        flow: CxBrand.flow,
        scenario: CxBrand.scenario,
      },
      provenance: { totals: state.totals.meta, fixed: state.fixed.meta },
    };
  }

  function download(filename, content, type) {
    const blob = new Blob([content], { type: type || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function doExport() {
    download(`checkmarx-backlog-cost-${slug(state.customer)}.html`,
      CxReport.build(exportContext()), 'text/html;charset=utf-8');
  }

  function doCsv() {
    const frames = state.frames;
    const introduced = CxModel.rollup(frames.introduced);
    const cleared = CxModel.rollup(frames.fixed);
    const open = CxModel.rollup(frames.open);
    const header = ['week_ending']
      .concat(SEVERITIES.map((s) => `open_${s.toLowerCase()}`))
      .concat(SEVERITIES.map((s) => `fixed_${s.toLowerCase()}`))
      .concat(['open_total', 'introduced_total', 'closed_total', 'net_total']);

    const lines = frames.weeks.map((week, i) => [week]
      .concat(SEVERITIES.map((s) => frames.open[s][i] ?? ''))
      .concat(SEVERITIES.map((s) => frames.fixed[s][i] ?? ''))
      .concat([
        open[i] ?? '',
        introduced[i] ?? '',
        cleared[i] ?? '',
        introduced[i] === null || cleared[i] === null ? '' : introduced[i] - cleared[i],
      ]).join(','));

    download(`checkmarx-backlog-${slug(state.customer)}.csv`,
      [header.join(','), ...lines].join('\n'), 'text/csv;charset=utf-8');
  }

  /* ------------------------------------------------------------------ wiring -- */

  function wire() {
    $('brandmark').innerHTML = CxBrand.logoSvg(28);

    wireDropzone($('drop-total'), 'total');
    wireDropzone($('drop-fixed'), 'fixed');

    $('file-input').addEventListener('change', (event) => {
      if (event.target.files.length) routeFiles(event.target.files, pendingKind);
      event.target.value = '';
    });

    $('logo-file').addEventListener('change', (event) => {
      const file = event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        state.logoDataUrl = reader.result;
        $('brandmark').innerHTML = `<img src="${state.logoDataUrl}" alt="${esc(state.customer || 'Logo')}">`;
        notifyHost();
      };
      reader.readAsDataURL(file);
    });

    ['customer-name', 'prepared-by'].forEach((id) =>
      $(id).addEventListener('input', () => { if (state.frames) recompute(); }));

    $('rate-triage').addEventListener('input', () => {
      state.assumptions.triageCredits = Math.max(0, Number($('rate-triage').value) || 0);
      if (state.frames) computePlan();
    });
    $('rate-remediation').addEventListener('input', () => {
      state.assumptions.remediationCredits = Math.max(0, Number($('rate-remediation').value) || 0);
      if (state.frames) computePlan();
    });
    $('pace').addEventListener('input', () => {
      state.pace = Number($('pace').value);
      if (state.frames) computePlan();
    });

    $('fp-all').addEventListener('input', () => {
      const value = Number($('fp-all').value);
      $('fp-all-out').textContent = `${value}%`;
      if (!state.frames) return;
      setPlan((s, row) => { row.fp = value; });
    });

    $('btn-all').addEventListener('click', () => {
      if (state.frames) setPlan((s, row, backlog) => { row.selected = backlog; });
    });
    $('btn-none').addEventListener('click', () => {
      if (state.frames) setPlan((s, row) => { row.selected = 0; });
    });
    $('btn-critical-high').addEventListener('click', () => {
      if (state.frames) setPlan((s, row, backlog) => {
        row.selected = (s === 'Critical' || s === 'High') ? backlog : 0;
      });
    });
    $('btn-reset').addEventListener('click', () => {
      if (!state.frames) return;
      state.plan = CxModel.defaultPlan(state.stats, state.assumptions);
      state.planTouched = false;
      syncSevGrid();
      computePlan();
    });

    $('btn-sample').addEventListener('click', loadSample);
    $('btn-export').addEventListener('click', doExport);
    $('btn-export-2').addEventListener('click', doExport);
    $('btn-csv').addEventListener('click', doCsv);

    $('btn-theme').addEventListener('click', () => {
      const next = CxBrand.currentTheme() === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('cx-theme', next); } catch (_) { /* private mode */ }
      if (state.frames) redraw();
    });
    CxBrand.onThemeChange(() => { if (state.frames) redraw(); });

    function redraw() {
      renderWindowChips();
      renderHorizonChips();
      renderSevGrid();
      computePlan();
      renderHistory();
    }

    try {
      const saved = localStorage.getItem('cx-theme');
      if (saved) document.documentElement.setAttribute('data-theme', saved);
    } catch (_) { /* private mode */ }

    CxCharts.bind(document);
  }

  /* ---------------------------------------------- CxMissionZero profiles -- */
  // Inside CxMissionZero (Credit projections) this page is one profile's à la carte projection:
  // the page around it saves what is here, and hands it back when the profile is opened again.
  // Only the page around it, on this same server, is listened to.
  const host = window.parent !== window ? window.parent : null;
  let restoring = false;
  let hostTimer = null;

  function snapshot() {
    return {
      version: 1,
      customer: $('customer-name').value.trim(),
      preparedBy: $('prepared-by').value.trim(),
      logoDataUrl: state.logoDataUrl,
      totals: state.totals,
      fixed: state.fixed,
      plan: state.plan,
      planTouched: state.planTouched,
      assumptions: state.assumptions,
      windowWeeks: state.windowWeeks,
      horizonMonths: state.horizonMonths,
      pace: state.pace,
      reportTitle: $('report-title') ? $('report-title').value : '',
      reportValidity: $('report-validity') ? $('report-validity').value : '',
    };
  }

  function notifyHost() {
    if (!host || restoring) return;
    clearTimeout(hostTimer);
    hostTimer = setTimeout(() => host.postMessage({ type: 'mz-calc-change', state: snapshot() }, location.origin), 500);
  }

  function markLoaded(kind, parsed) {
    const zone = kind === 'fixed' ? $('drop-fixed') : $('drop-total');
    const label = kind === 'fixed' ? $('file-fixed') : $('file-total');
    if (!parsed) {
      zone.classList.remove('is-loaded');
      label.textContent = 'Drop the .xlsx here, or click to choose';
      return;
    }
    const name = (parsed.meta && parsed.meta.fileName) || 'saved data';
    zone.classList.add('is-loaded');
    label.innerHTML =
      `<span class="status">✓ ${esc(name)}</span><br>` +
      `${parsed.weeks.length} weeks, ${esc(parsed.weeks[0])} → ${esc(parsed.weeks[parsed.weeks.length - 1])}` +
      `<br><button type="button" class="ghost" data-clear="${kind}" style="margin-top:8px;padding:4px 10px;font-size:12px">Replace</button>`;
    label.querySelector('[data-clear]').addEventListener('click', (event) => {
      event.stopPropagation();
      clearSlot(kind);
    });
  }

  const series = (value) => value && Array.isArray(value.weeks) && value.bySeverity && typeof value.bySeverity === 'object' ? value : null;

  function restore(saved) {
    saved = saved && typeof saved === 'object' ? saved : {};
    restoring = true;
    try {
      $('customer-name').value = String(saved.customer || '');
      $('prepared-by').value = String(saved.preparedBy || '');
      if ($('report-title')) $('report-title').value = String(saved.reportTitle || '');
      if ($('report-validity')) $('report-validity').value = String(saved.reportValidity || '');
      const logo = typeof saved.logoDataUrl === 'string' && /^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(saved.logoDataUrl) ? saved.logoDataUrl : null;
      state.logoDataUrl = logo;
      $('brandmark').innerHTML = logo ? `<img src="${logo}" alt="${esc(saved.customer || 'Logo')}">` : CxBrand.logoSvg(28);
      state.totals = series(saved.totals);
      state.fixed = series(saved.fixed);
      markLoaded('total', state.totals);
      markLoaded('fixed', state.fixed);
      const a = saved.assumptions || {};
      state.assumptions = {
        triageCredits: Number.isFinite(a.triageCredits) ? a.triageCredits : CxModel.DEFAULTS.triageCredits,
        remediationCredits: Number.isFinite(a.remediationCredits) ? a.remediationCredits : CxModel.DEFAULTS.remediationCredits,
        falsePositive: Object.assign({}, CxModel.DEFAULTS.falsePositive, a.falsePositive || {}),
      };
      $('rate-triage').value = String(state.assumptions.triageCredits);
      $('rate-remediation').value = String(state.assumptions.remediationCredits);
      state.plan = saved.plan && typeof saved.plan === 'object' ? saved.plan : null;
      state.planTouched = Boolean(saved.planTouched && state.plan);
      state.windowWeeks = Number(saved.windowWeeks) || CxModel.monthsToWeeks(CxModel.DEFAULTS.windowMonths);
      state.horizonMonths = Number(saved.horizonMonths) || CxModel.DEFAULTS.horizonMonths;
      state.pace = Number.isFinite(saved.pace) ? saved.pace : null;
      showMessages([]);
      recompute();
    } finally {
      restoring = false;
    }
  }

  if (host) {
    window.addEventListener('message', (event) => {
      if (event.origin !== location.origin || event.source !== host) return;
      if (event.data && event.data.type === 'mz-calc-load') restore(event.data.state);
    });
    // The page around this one sizes it to fit, so there is one scroll bar, not two.
    const sendHeight = () => host.postMessage({ type: 'mz-calc-height', height: document.documentElement.scrollHeight }, location.origin);
    new ResizeObserver(sendHeight).observe(document.body);
    ['customer-name', 'prepared-by', 'report-title', 'report-validity'].forEach((id) => $(id) && $(id).addEventListener('input', notifyHost));
  }

  wire();
  if (host) host.postMessage({ type: 'mz-calc-ready' }, location.origin);
})();
