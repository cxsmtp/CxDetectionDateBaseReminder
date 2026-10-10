// Cx Credits Calculator: the charts, as SVG text, for the page and for the report it downloads.
// Colours come as CSS values (`var(--text)` on the page, fixed colours in the report). Every
// point carries a <title>, so pointing at it says what it is.

import { SEVERITIES } from './model.js';

export const SEVERITY_COLOURS = { Critical: '#dc2626', High: '#ea580c', Medium: '#d97706', Low: '#2563eb' };
export const PAGE_PALETTE = { ink: 'var(--text)', muted: 'var(--muted)', grid: 'var(--border)', forecast: '#dc2626', plan: '#7c3aed', fixRate: '#16a34a', debtRate: '#dc2626', severity: SEVERITY_COLOURS };

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n, digits = 0) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: digits }));
export const monthLabel = (month) => {
  const [y, m] = String(month).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });
};
export const weekLabel = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

/**
 * Lines over shared x labels. `lines`: [{ key, colour, dash?, label }]; `points`: [{ label, [key]: n|null }].
 * `log`: a log vertical axis (severities differ by orders of magnitude).
 */
export function lineChart(points, lines, { palette = PAGE_PALETTE, width = 760, height = 300, log = false, suffix = '', zeroBased = true, valueLabels = 'ends', title = '' } = {}) {
  const padR = 18;
  const padT = 22;
  const padB = 30;
  const plotH = height - padT - padB;
  const values = points.flatMap((p) => lines.map((l) => p[l.key])).filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  if (!points.length || !values.length) return '';
  // Room for the longest axis label (2,767,277 needs more than 120).
  const padL = 14 + 6.4 * Math.max(...[...values, 0].map((v) => `${num(Math.abs(v))}${suffix}`.length + (v < 0 ? 1 : 0)));
  const plotW = width - padL - padR;
  let max = Math.max(...values);
  let min = zeroBased ? Math.min(0, ...values) : Math.min(...values);
  if (max === min) max = min + 1;
  const n = points.length;
  const x = (i) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  let y;
  let ticks;
  if (log) {
    const positive = values.filter((v) => v > 0);
    const lo = Math.floor(Math.log10(Math.max(1, positive.length ? Math.min(...positive) : 1)));
    const hi = Math.log10(Math.max(10, max));
    const span = hi - lo || 1;
    y = (v) => padT + plotH - ((Math.log10(Math.max(1, v)) - lo) / span) * plotH;
    ticks = [];
    for (let p = Math.floor(lo); p <= Math.ceil(hi); p += Math.ceil(hi) - Math.floor(lo) > 6 ? 2 : 1) ticks.push(10 ** p);
  } else {
    y = (v) => padT + plotH - ((v - min) / (max - min)) * plotH;
    ticks = [0, 1, 2, 3, 4].map((g) => min + ((max - min) / 4) * g);
  }
  const grid = ticks
    .map((v) => `<line x1="${padL}" x2="${width - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" style="stroke:${palette.grid};stroke-width:1"/><text x="${padL - 8}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" style="fill:${palette.muted};font-size:10.5px">${esc(num(v))}${esc(suffix)}</text>`)
    .join('');
  const stride = Math.max(1, Math.ceil(n / 8));
  const xLabels = points
    .map((p, i) => {
      const last = i === n - 1;
      if (!(last || (i % stride === 0 && x(n - 1) - x(i) > 48))) return '';
      return `<text x="${x(i).toFixed(1)}" y="${height - 9}" text-anchor="${i === 0 ? 'start' : last ? 'end' : 'middle'}" style="fill:${palette.muted};font-size:10.5px">${esc(p.label)}</text>`;
    })
    .join('');
  const path = (key) => {
    let d = '';
    let on = false;
    points.forEach((p, i) => {
      const v = p[key];
      if (v === null || v === undefined || !Number.isFinite(v)) {
        on = false;
        return;
      }
      d += `${on ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      on = true;
    });
    return d.trim();
  };
  const series = lines
    .map((l) => {
      const d = path(l.key);
      if (!d) return '';
      const marks = points
        .map((p, i) => {
          const v = p[l.key];
          if (v === null || v === undefined || !Number.isFinite(v)) return '';
          return `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="4" style="fill:${l.colour};stroke:none"><title>${esc(`${l.label}, ${p.label}: ${num(v, 1)}${suffix}`)}</title></circle>`;
        })
        .join('');
      const shown = points.map((p, i) => [p[l.key], i]).filter(([v]) => v !== null && v !== undefined && Number.isFinite(v));
      const labelled = l.noLabel ? [] : valueLabels === 'all' ? shown : valueLabels === 'ends' ? shown.slice(-1) : [];
      const labels = labelled
        .map(([v, i]) => `<text x="${x(i).toFixed(1)}" y="${(y(v) - 8).toFixed(1)}" text-anchor="${i === n - 1 ? 'end' : 'middle'}" style="fill:${l.colour};font-size:10px;font-weight:600">${esc(num(v))}${esc(suffix)}</text>`)
        .join('');
      return `<path d="${d}" style="fill:none;stroke:${l.colour};stroke-width:2;${l.dash ? `stroke-dasharray:${l.dash};` : ''}stroke-linejoin:round;stroke-linecap:round"/>${marks}${labels}`;
    })
    .join('');
  const legend = lines
    .map((l) => `<span class="cc-key"><i class="cc-swatch${l.dash ? ' dashed' : ''}" translate="no" style="--c:${l.colour}"></i>${esc(l.label)}</span>`)
    .join('');
  return `<figure class="cc-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}" style="width:100%;height:auto;display:block">${grid}${xLabels}${series}</svg><figcaption class="cc-legend">${legend}</figcaption></figure>`;
}

/** The backlog over the last weeks. */
export function backlogTrendChart(weekly, palette = PAGE_PALETTE) {
  return lineChart(weekly.map((w) => ({ label: weekLabel(w.date), backlog: w.backlog })), [{ key: 'backlog', colour: palette.ink, label: 'Backlog' }], { palette, width: 380, height: 210, title: 'Backlog' });
}

/** Fix rate against how fast the debt grows, per week. */
export function ratesChart(weekly, palette = PAGE_PALETTE) {
  return lineChart(
    weekly.map((w) => ({ label: weekLabel(w.date), fixRate: w.fixRate, debtRate: w.debtRate })),
    [
      { key: 'fixRate', colour: palette.fixRate, label: 'Fix rate' },
      { key: 'debtRate', colour: palette.debtRate, dash: '5 4', label: 'Debt increase rate' },
    ],
    { palette, width: 380, height: 210, suffix: '%', zeroBased: false, title: 'Fix rate and debt increase rate' },
  );
}

/** Backlog by month, and 6 months ahead with and without the plan. */
export function forecastChart(points, palette = PAGE_PALETTE) {
  return lineChart(
    points.map((p) => ({ label: monthLabel(p.month), actual: p.actual, forecast: p.forecast, withPlan: p.withPlan })),
    [
      { key: 'actual', colour: palette.ink, label: 'Actual backlog', noLabel: true },
      { key: 'forecast', colour: palette.forecast, dash: '5 4', label: 'Forecast, no action' },
      { key: 'withPlan', colour: palette.plan, dash: '5 4', label: 'Forecast, with this plan' },
    ],
    { palette, title: 'Backlog trend and forecast' },
  );
}

/** Per severity: history, and 3 months of the plan (dashed). Log scale. */
export function severityChart(points, palette = PAGE_PALETTE) {
  const lines = SEVERITIES.flatMap((s) => [
    { key: s, colour: palette.severity[s], label: s, noLabel: true },
    { key: `${s}F`, colour: palette.severity[s], dash: '5 4', label: `${s}, with the plan` },
  ]);
  return lineChart(points.map((p) => ({ ...p, label: monthLabel(p.month) })), lines, { palette, log: true, height: 330, title: '3-month fix plan by severity' });
}
