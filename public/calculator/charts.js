// Cx Credits Calculator: the charts, as SVG text, for the page and for the report it downloads.
// Colours come as CSS values (`var(--text)` on the page, the report's own theme in the report). Thin
// lines, a light grid, a dot only where a line ends; pointing anywhere on a line says the value
// (each point has a wide invisible target with a <title>). The report passes its translator as
// `palette.t` (the page translates the legends where they are shown).

import { SEVERITIES } from './model.js';

const same = (text) => text;
/** The wording in the reader's language: `{0}` in `text` is `args[0]`. */
const words = (palette, text, ...args) => (palette.t ?? same)(text).replace(/\{(\d+)\}/g, (whole, i) => args[i] ?? whole);

export const SEVERITY_COLOURS = { Critical: '#dc2626', High: '#ea580c', Medium: '#d97706', Low: '#2563eb' };
export const PAGE_PALETTE = { ink: 'var(--text)', muted: 'var(--muted)', grid: 'var(--border)', forecast: '#dc2626', plan: 'var(--accent)', fixRate: '#16a34a', debtRate: '#dc2626', severity: SEVERITY_COLOURS };

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Rounding never shows "-0".
const num = (n, digits = 0) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : (Math.abs(n) < 0.5 * 10 ** -digits ? 0 : Number(n)).toLocaleString(undefined, { maximumFractionDigits: digits }));
/** Axis labels stay short: 250K, 1.2M. */
const compact = (n) => {
  if (!Number.isFinite(n)) return '';
  try {
    return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: Math.abs(n) < 10 ? 1 : 0 }).format(Math.abs(n) < 1e-9 ? 0 : n);
  } catch {
    return num(n);
  }
};
export const monthLabel = (month) => {
  const [y, m] = String(month).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });
};
export const weekLabel = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

/** A tidy step for an axis that reaches `span` in about `count` steps (1, 2, 2.5 or 5 × 10ⁿ). */
function niceStep(span, count) {
  const raw = span / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map((m) => m * power).find((step) => step >= raw) ?? raw;
}

/**
 * Lines over shared x labels. `lines`: [{ key, colour, dash?, label, area? }]; `points`:
 * [{ label, [key]: n|null }]. `area` fills under that line, faintly. `endLabels` writes the last
 * value of each line beside it. `divider`: the index from which points are projections (a faint band).
 */
export function lineChart(points, lines, { palette = PAGE_PALETTE, width = 760, height = 260, suffix = '', zeroBased = true, endLabels = true, title = '', divider = null, compactAxis = true } = {}) {
  // Room for the widest label at each side, in any of the app's fonts (about 7.4 px a character at 10.5 px).
  const CHAR = 7.4;
  const lastValues = lines.map((l) => [...points].reverse().find((p) => p[l.key] !== null && p[l.key] !== undefined && Number.isFinite(p[l.key]))?.[l.key]).filter((v) => v !== undefined);
  const padR = endLabels ? 14 + CHAR * Math.max(3, ...lastValues.map((v) => `${compactAxis ? compact(v) : num(v)}${suffix}`.length)) : 14;
  const padT = 14;
  const padB = 26;
  const plotH = height - padT - padB;
  const values = points.flatMap((p) => lines.map((l) => p[l.key])).filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  if (!points.length || !values.length) return '';
  let max = Math.max(...values);
  let min = zeroBased ? Math.min(0, ...values) : Math.min(...values);
  if (max === min) max = min + 1;
  const step = niceStep(max - min, 3);
  min = Math.floor(min / step) * step;
  max = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(v);
  const label = (v) => `${compactAxis ? compact(v) : num(v)}${suffix}`;
  const padL = 14 + CHAR * Math.max(...ticks.map((v) => label(v).length));
  const plotW = width - padL - padR;
  const n = points.length;
  const x = (i) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v) => padT + plotH - ((v - min) / (max - min)) * plotH;
  const grid = ticks
    .map((v) => `<line x1="${padL}" x2="${width - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" style="stroke:${palette.grid};stroke-width:1${v === 0 || v === min ? '' : ';stroke-dasharray:2 4'}"/><text x="${padL - 8}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" style="fill:${palette.muted};font-size:10.5px">${esc(label(v))}</text>`)
    .join('');
  const band = divider !== null && divider > 0 && divider < n ? `<rect x="${x(divider - 1).toFixed(1)}" y="${padT}" width="${(x(n - 1) - x(divider - 1)).toFixed(1)}" height="${plotH}" style="fill:${palette.grid};opacity:.28"/>` : '';
  const stride = Math.max(1, Math.ceil(n / 6));
  const xLabels = points
    .map((p, i) => {
      const last = i === n - 1;
      if (!(last || (i % stride === 0 && x(n - 1) - x(i) > 64 && (i === 0 || x(i) - x(0) > 64)))) return '';
      return `<text x="${x(i).toFixed(1)}" y="${height - 8}" text-anchor="${i === 0 ? 'start' : last ? 'end' : 'middle'}" style="fill:${palette.muted};font-size:10.5px">${esc(p.label)}</text>`;
    })
    .join('');
  const segments = (key) => {
    const out = [];
    let run = [];
    points.forEach((p, i) => {
      const v = p[key];
      if (v === null || v === undefined || !Number.isFinite(v)) {
        if (run.length) out.push(run);
        run = [];
      } else run.push([x(i), y(v), v, i]);
    });
    if (run.length) out.push(run);
    return out;
  };
  const base = y(Math.max(min, 0));
  const series = lines
    .map((l) => {
      const runs = segments(l.key);
      if (!runs.length) return '';
      const d = runs.map((run) => run.map(([px, py], k) => `${k ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join(' ')).join(' ');
      const area = l.area ? runs.map((run) => `<path d="M${run[0][0].toFixed(1)},${base.toFixed(1)} ${run.map(([px, py]) => `L${px.toFixed(1)},${py.toFixed(1)}`).join(' ')} L${run[run.length - 1][0].toFixed(1)},${base.toFixed(1)} Z" style="fill:${l.colour};opacity:.08;stroke:none"/>`).join('') : '';
      const all = runs.flat();
      const [lx, ly, lv] = all[all.length - 1];
      const end = `<circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3.5" style="fill:${l.colour};stroke:var(--card, var(--surface, #fff));stroke-width:1.5"/>`;
      const endLabel = endLabels && !l.noLabel ? `<text x="${(lx + 6).toFixed(1)}" y="${(ly + 3.5).toFixed(1)}" style="fill:${l.colour};font-size:10.5px;font-weight:600">${esc(compactAxis ? compact(lv) : num(lv))}${esc(suffix)}</text>` : '';
      const hits = all.map(([px, py, v, i]) => `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="9" style="fill:transparent;stroke:none"><title>${esc(`${l.label} · ${points[i].label}: ${num(v, 1)}${suffix}`)}</title></circle>`).join('');
      return `${area}<path d="${d}" style="fill:none;stroke:${l.colour};stroke-width:${l.dash ? 1.75 : 2};${l.dash ? `stroke-dasharray:${l.dash};` : ''}stroke-linejoin:round;stroke-linecap:round"/>${end}${endLabel}${hits}`;
    })
    .join('');
  const legend = lines.length > 1
    ? `<figcaption class="cc-legend">${lines.map((l) => `<span class="cc-key"><i class="cc-swatch${l.dash ? ' dashed' : ''}" translate="no" style="--c:${l.colour}"></i>${esc(l.label)}</span>`).join('')}</figcaption>`
    : '';
  return `<figure class="cc-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}" style="width:100%;max-width:${Math.round(width * 1.25)}px;height:auto;display:block;direction:ltr;overflow:hidden">${band}${grid}${xLabels}${series}</svg>${legend}</figure>`;
}

/** The backlog over the last weeks. */
export function backlogTrendChart(weekly, palette = PAGE_PALETTE) {
  return lineChart(weekly.map((w) => ({ label: weekLabel(w.date), backlog: w.backlog })), [{ key: 'backlog', colour: palette.ink, label: words(palette, 'Backlog'), area: true }], { palette, width: 380, height: 190, title: words(palette, 'Backlog') });
}

/** Fix rate against how fast the debt grows, per week, each over the last 4 weeks (a single week jumps about). */
export function ratesChart(weekly, palette = PAGE_PALETTE) {
  const has4 = weekly.some((w) => w.fixRate4 !== undefined);
  return lineChart(
    weekly.map((w) => ({ label: weekLabel(w.date), fixRate: has4 ? w.fixRate4 : w.fixRate, debtRate: has4 ? w.debtRate4 : w.debtRate })),
    [
      { key: 'fixRate', colour: palette.fixRate, label: words(palette, 'Fix rate') },
      { key: 'debtRate', colour: palette.debtRate, dash: '4 3', label: words(palette, 'Debt increase rate') },
    ],
    { palette, width: 380, height: 190, suffix: '%', zeroBased: false, compactAxis: false, title: words(palette, 'Fix rate and debt increase rate') },
  );
}

/**
 * Debt added against fixes, week by week (4-week average), each as a share of the backlog a month:
 * while the red line is above the green one the backlog grows; the gap is how fast.
 */
export function debtFixChart(weekly, palette = PAGE_PALETTE) {
  const MONTH = 4.345;
  const monthly = (v) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * MONTH * 10) / 10);
  return lineChart(
    weekly.map((w) => ({ label: weekLabel(w.date), added: monthly(w.addedRate4 ?? w.addedRate), fixed: monthly(w.fixedRate4 ?? w.fixedRate) })),
    [
      { key: 'added', colour: palette.debtRate, label: words(palette, 'Debt added') },
      { key: 'fixed', colour: palette.fixRate, label: words(palette, 'Fixed') },
    ],
    { palette, height: 240, suffix: '%', compactAxis: false, title: words(palette, 'Debt added against fixes, % of the backlog a month') },
  );
}

/** Backlog by month, then over the projection period: as it goes, and with the plan. Old forecasts (forecast/withPlan) still draw. */
export function forecastChart(points, palette = PAGE_PALETTE) {
  const divider = points.findIndex((p) => p.actual === null || p.actual === undefined);
  return lineChart(
    points.map((p) => ({ label: monthLabel(p.month), actual: p.actual, asIs: p.asIs ?? p.forecast, withPlan: p.withPlan })),
    [
      { key: 'actual', colour: palette.ink, label: words(palette, 'Backlog'), area: true, noLabel: true },
      { key: 'asIs', colour: palette.forecast, dash: '4 3', label: words(palette, 'If nothing changes') },
      { key: 'withPlan', colour: palette.plan, dash: '4 3', label: words(palette, 'With this plan') },
    ],
    { palette, height: 250, divider: divider > 0 ? divider : null, title: words(palette, 'Backlog trend and forecast') },
  );
}

/** One small chart per severity: the backlog so far, and with the plan (dashed). Each on its own scale. */
export function severityCharts(bySeverity, palette = PAGE_PALETTE) {
  const cells = SEVERITIES.filter((s) => bySeverity?.[s]?.length).map((s) => {
    const points = bySeverity[s];
    const divider = points.findIndex((p) => p.actual === null || p.actual === undefined);
    const chart = lineChart(
      points.map((p) => ({ label: monthLabel(p.month), actual: p.actual, withPlan: p.withPlan })),
      [
        { key: 'actual', colour: palette.severity[s], label: words(palette, s), area: true, noLabel: true },
        { key: 'withPlan', colour: palette.severity[s], dash: '4 3', label: words(palette, '{0}, with the plan', words(palette, s)) },
      ],
      { palette, width: 360, height: 150, divider: divider > 0 ? divider : null, title: words(palette, s) },
    ).replace('<figcaption class="cc-legend">', '<figcaption class="cc-legend" hidden>');
    return `<div class="cc-mini"><h4><i class="cc-swatch" translate="no" style="--c:${palette.severity[s]}"></i>${esc(words(palette, s))}</h4>${chart}</div>`;
  });
  return cells.length ? `<div class="cc-minis">${cells.join('')}</div>` : '';
}

/** Kept for reports made before MZ-01.00.67: per severity on one log-scale chart. */
export function severityChart(points, palette = PAGE_PALETTE) {
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, points.map((p) => ({ month: p.month, actual: p[s], withPlan: p[`${s}F`] }))]));
  return severityCharts(bySeverity, palette);
}
