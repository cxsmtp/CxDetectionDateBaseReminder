// Cx Credits Calculator: the projection report, one self-contained HTML file (no scripts, nothing
// loaded from anywhere), from the data a generated report keeps. Prints to PDF from the browser.
// Every name and figure is escaped: the data may hold what a customer's exports or projects said.
// It is written in the language the page is in (`t`, the page's translator), and has a light and
// a dark theme the reader switches between with CSS alone (Auto follows their system).

import { FREQUENCIES, SEVERITIES, creditSummary } from './model.js';
import { SEVERITY_COLOURS, backlogTrendChart, forecastChart, monthLabel, ratesChart, severityChart } from './charts.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const FROM = { default: 'Default', frequency: 'Scan frequency', criticality: 'Criticality', project: 'Set for the project' };

/** The file name: the customer, what it is, and when (local time), safe on every system. */
export function reportFileName(customer, at = new Date()) {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const name = String(customer || 'Customer').normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'Customer';
  return `${name}_Cx-credits-projection_${stamp}.html`;
}

/** Everything the report says, in one language: `w('… {0} …', n)` is the wording, escaped, with the figures in. */
function wording({ t = (text) => text, lang = 'en' } = {}) {
  let locale;
  try {
    locale = new Intl.NumberFormat(lang).resolvedOptions().locale;
  } catch {
    locale = undefined;
  }
  const w = (text, ...args) => esc(t(text)).replace(/\{(\d+)\}/g, (whole, i) => args[i] ?? whole);
  const num = (n, digits = 0) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString(locale, { maximumFractionDigits: digits }));
  const pct = (n) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : ''}${n.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`);
  const date = (iso) => (iso ? new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'long', year: 'numeric' }) : '');
  const frequency = (id) => w(FREQUENCIES.find((f) => f.id === id)?.label ?? '—');
  return { w, t, num, pct, date, frequency, locale };
}

/** Colours the charts take from the report's theme, so they follow it. */
const palette = (t) => ({ ink: 'var(--ink)', muted: 'var(--muted)', grid: 'var(--grid)', forecast: '#dc2626', plan: 'var(--plan)', fixRate: '#16a34a', debtRate: '#dc2626', severity: SEVERITY_COLOURS, t });
const table = (html, cls = '') => `<div class="scroll"><table${cls ? ` class="${cls}"` : ''}>${html}</table></div>`;

function trSection(tr, L) {
  const { w, num, pct, date } = L;
  const rows = SEVERITIES.map((s) => tr.rows[s]);
  const cell = (fn) => rows.map((r) => `<td>${fn(r)}</td>`).join('');
  const P = palette(L.t);
  const months = Math.round((tr.weekly?.length ?? 0) / 4.345);
  return `<section>
  <h2>${w('Triage & remediation')}</h2>
  <p class="sub">${w('Backlog as of {0}, against {1}.', esc(date(tr.asOf)), esc(date(tr.previousDate)))} ${tr.lookbackMonths ? w('Debt growth and fix rate over the last {0} months.', num(tr.lookbackMonths)) : w('Debt growth and fix rate over the latest week.')}</p>
  <div class="tiles">
    <div class="tile"><span>${w('Findings to triage')}</span><b>${num(tr.totals.selected)}</b><small>${w('of {0} open', num(tr.totals.backlog))}</small></div>
    <div class="tile"><span>${w('Estimated true positives')}</span><b>${num(tr.totals.truePositives)}</b><small>${w('to remediate')}</small></div>
    <div class="tile gold"><span>${w('Credits')}</span><b>${num(tr.totals.credits, 1)}</b><small>${w('{0} triage + {1} remediation', num(tr.totals.triageCredits, 1), num(tr.totals.remediationCredits, 1))}</small></div>
    <div class="tile"><span>${w('Backlog cleared')}</span><b>${tr.totals.backlog ? `${num((tr.totals.selected / tr.totals.backlog) * 100, 1)}%` : '—'}</b><small>${w('of the current backlog')}</small></div>
  </div>
  ${table(`
    <thead><tr><th>${w('By severity')}</th>${SEVERITIES.map((s) => `<th><i class="dot" style="background:${SEVERITY_COLOURS[s]}"></i>${w(s)}</th>`).join('')}<th>${w('Total')}</th></tr></thead>
    <tbody>
      <tr><td>${w('Current backlog')}</td>${cell((r) => num(r.backlog))}<td>${num(tr.totals.backlog)}</td></tr>
      <tr class="muted"><td>${w('Debt increase')}</td>${SEVERITIES.map((s) => `<td>${pct(tr.analysis[s].debtRate)}</td>`).join('')}<td>${pct(tr.analysis.total.debtRate)}</td></tr>
      <tr class="muted"><td>${w('Fix rate')}</td>${SEVERITIES.map((s) => `<td>${pct(tr.analysis[s].fixRate)}</td>`).join('')}<td>${pct(tr.analysis.total.fixRate)}</td></tr>
      <tr class="strong"><td>${w('To triage')}</td>${cell((r) => num(r.selected))}<td>${num(tr.totals.selected)}</td></tr>
      <tr class="muted"><td>${w('Credits per triage')}</td>${cell((r) => num(r.triageCost, 2))}<td>—</td></tr>
      <tr class="muted"><td>${w('False positives (estimated)')}</td>${cell((r) => `${num(r.fp)}%`)}<td>—</td></tr>
      <tr><td>${w('True positives (estimated)')}</td>${cell((r) => num(r.truePositives))}<td>${num(tr.totals.truePositives)}</td></tr>
      <tr class="muted"><td>${w('Credits per remediation')}</td>${cell((r) => num(r.remediationCost, 2))}<td>—</td></tr>
      <tr><td>${w('Triage credits')}</td>${cell((r) => num(r.triageCredits, 1))}<td>${num(tr.totals.triageCredits, 1)}</td></tr>
      <tr><td>${w('Remediation credits')}</td>${cell((r) => num(r.remediationCredits, 1))}<td>${num(tr.totals.remediationCredits, 1)}</td></tr>
      <tr class="gold"><td>${w('Credits')}</td>${cell((r) => num(r.credits, 1))}<td>${num(tr.totals.credits, 1)}</td></tr>
      <tr><td>${w('Backlog after')}</td>${cell((r) => num(r.backlogAfter))}<td>${num(tr.totals.backlogAfter)}</td></tr>
    </tbody>`)}
  ${tr.weekly?.length ? `<h3>${w('The last {0} months, week by week', num(months))}</h3><div class="pair">${backlogTrendChart(tr.weekly, P)}${ratesChart(tr.weekly, P)}</div>` : ''}
  ${tr.forecast?.length ? `<h3>${w('Backlog trend and forecast')}</h3><p class="sub">${tr.monthlyChange >= 0 ? w('The backlog grew by {0} a month on average recently.', num(tr.monthlyChange)) : w('The backlog shrank by {0} a month on average recently.', num(-tr.monthlyChange))}</p>${forecastChart(tr.forecast, P)}` : ''}
  ${tr.severityForecast?.length ? `<h3>${w('3-month plan by severity')}</h3><p class="sub">${w('Solid: the backlog so far. Dashed: the next 3 months with the findings above fixed evenly, against the pace new ones arrive. Log scale.')}</p>${severityChart(tr.severityForecast, P)}` : ''}
</section>`;
}

function fusionSection(f, L) {
  const { w, num, frequency } = L;
  const models = new Map(f.models.map((m) => [m.id, m]));
  const modelName = (id) => esc(models.get(id)?.name || '—');
  return `<section>
  <h2>${w('Checkmarx Fusion')}</h2>
  <p class="sub">${w('Fusion scans over {0} months.', num(f.periodMonths))} ${w("Each project's lines of code are rounded up to whole 10K units on their own; one scan costs its model's credits per 10K LOC. Projects scanned most often come first.")}</p>
  <div class="tiles">
    <div class="tile"><span>${w('Projects')}</span><b>${num(f.totals.projects)}</b><small>${w('{0} lines of code', num(f.totals.lines))}</small></div>
    <div class="tile"><span>${w('10K LOC units')}</span><b>${num(f.totals.units)}</b><small>${w('each project rounded up')}</small></div>
    <div class="tile"><span>${w('Fusion scans')}</span><b>${num(f.totals.scans)}</b><small>${w('over {0} months', num(f.periodMonths))}</small></div>
    <div class="tile gold"><span>${w('Credits')}</span><b>${num(f.totals.credits, 1)}</b><small>${f.totals.unknownRate ? w('{0} projects without a model rate are not counted', num(f.totals.unknownRate)) : w('every project counted')}</small></div>
  </div>
  ${f.remainingCredits !== null && f.remainingCredits !== undefined ? `<p class="note">${w('Credits remaining in the Checkmarx One tenant when this was made: {0}.', `<b>${num(f.remainingCredits)}</b>`)}</p>` : ''}
  <h3>${w('Models')}</h3>
  ${table(`<thead><tr><th>${w('Model')}</th><th>${w('Credits per 10K LOC')}</th><th>${w('Projects')}</th><th>${w('10K units × scans')}</th><th>${w('Credits')}</th></tr></thead><tbody>
    ${f.byModel.map((m) => `<tr><td class="name">${esc(m.name || '—')}</td><td>${m.rate === null ? '—' : num(m.rate, 2)}</td><td>${num(m.projects)}</td><td>${num(m.unitScans)}</td><td>${num(m.credits, 1)}</td></tr>`).join('') || `<tr><td colspan="5">${w('No model set.')}</td></tr>`}
  </tbody>`)}
  <h3>${w('By scan frequency')}</h3>
  ${table(`<thead><tr><th>${w('Scanned today')}</th><th>${w('Projects')}</th><th>${w('Fusion scans per project')}</th><th>${w('Model')}</th><th>${w('10K units')}</th><th>${w('Credits')}</th></tr></thead><tbody>
    ${f.byFrequency.filter((b) => b.projects).map((b) => `<tr><td>${frequency(b.id)}</td><td>${num(b.projects)}</td><td>${f.rules[b.id]?.scans ?? w('{0} (default)', num(f.defaultScans))}</td><td class="name">${modelName(f.rules[b.id]?.model ?? f.defaultModel)}</td><td>${num(b.units)}</td><td>${num(b.credits, 1)}</td></tr>`).join('')}
  </tbody>`)}
  <h3>${w('Projects')}</h3>
  ${table(`<thead><tr><th>${w('Project')}</th><th>${w('Criticality')}</th><th>${w('Scanned today')}</th><th>${w('Lines of code')}</th><th>${w('10K units')}</th><th>${w('Fusion scans')}</th><th>${w('Set by')}</th><th>${w('Model')}</th><th>${w('Credits')}</th></tr></thead><tbody>
    ${f.rows.filter((r) => r.included).map((r) => `<tr><td class="name">${esc(r.name)}</td><td>${r.criticality ?? '—'}</td><td class="wrap">${frequency(r.frequency)}${r.scansPerWeek ? ` <small>${w('({0}/week)', num(r.scansPerWeek, 1))}</small>` : ''}</td><td>${num(r.lines)}</td><td>${num(r.units)}</td><td>${num(r.scans)}</td><td>${FROM[r.scansFrom] ? w(FROM[r.scansFrom]) : ''}</td><td class="name">${modelName(r.model)}</td><td>${r.credits === null || !r.units ? '—' : num(r.credits, 1)}</td></tr>`).join('')}
  </tbody>`, 'dense')}
</section>`;
}

const STYLE = `
:root{color-scheme:light;--bg:#f6f7fb;--card:#fff;--ink:#111827;--muted:#5b6474;--line:#e5e7eb;--grid:#e5e7eb;--row:#eef0f4;--soft:#eef2ff;--soft-line:#c7d2fe;--gold:#4338ca;--plan:#7c3aed;--head1:#14171c;--head2:#4f46e5}
${'' /* Dark: chosen, or Auto on a system set to dark. */}
@media (prefers-color-scheme:dark){:root:not(:has(#theme-light:checked)){color-scheme:dark;--bg:#0b0f19;--card:#141925;--ink:#e5e7eb;--muted:#9aa3b2;--line:#273042;--grid:#273042;--row:#1d2433;--soft:#1e2140;--soft-line:#3b3f7a;--gold:#a5b4fc;--plan:#c4b5fd;--head1:#0d0f12;--head2:#3730a3}}
:root:has(#theme-dark:checked){color-scheme:dark;--bg:#0b0f19;--card:#141925;--ink:#e5e7eb;--muted:#9aa3b2;--line:#273042;--grid:#273042;--row:#1d2433;--soft:#1e2140;--soft-line:#3b3f7a;--gold:#a5b4fc;--plan:#c4b5fd;--head1:#0d0f12;--head2:#3730a3}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;overflow-wrap:anywhere}
header{background:var(--head1);color:#fff;padding:28px 32px}
header .top{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:10px 20px}
header .eyebrow{opacity:.85;font-size:12px;letter-spacing:.04em;text-transform:uppercase}
header h1{margin:4px 0 6px;font-size:26px;line-height:1.25}
header .meta{opacity:.9;font-size:13px}
.theme{display:inline-flex;align-items:center;gap:2px;border:1px solid rgb(255 255 255 / .35);border-radius:999px;padding:2px;font-size:12px}
.theme legend{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.theme input{position:absolute;opacity:0;pointer-events:none}
.theme label{padding:3px 10px;border-radius:999px;cursor:pointer;color:#fff;opacity:.85}
.theme input:checked+label{background:#fff;color:#1e1b4b;opacity:1;font-weight:600}
.theme input:focus-visible+label{outline:2px solid #fff;outline-offset:1px}
main{max-width:1060px;margin:0 auto;padding:24px 20px 48px}
section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px 24px;margin:0 0 20px;min-width:0}
h2{margin:0 0 4px;font-size:20px} h3{margin:22px 0 6px;font-size:15px}
.sub{color:var(--muted);margin:0 0 14px;font-size:13px} .note{background:var(--soft);border-radius:10px;padding:10px 14px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr));gap:12px;margin:0 0 16px}
.grand{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr));gap:12px}
.tile{border:1px solid var(--line);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;min-width:0}
.tile span{color:var(--muted);font-size:12px;font-weight:600} .tile b{font-size:clamp(18px,2.6vw,24px);font-variant-numeric:tabular-nums} .tile small{color:var(--muted)}
.tile.gold{background:var(--soft);border-color:var(--soft-line)} .tile.gold b{color:var(--gold)}
.scroll{max-width:100%;overflow-x:auto;margin:6px 0 4px;border:1px solid var(--line);border-radius:10px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{padding:7px 10px;border-bottom:1px solid var(--row);text-align:end;vertical-align:top}
tbody tr:last-child td{border-bottom:0}
th:first-child,td:first-child,td.name{text-align:start}
td.name{min-width:12ch;max-width:40ch;overflow-wrap:anywhere;word-break:break-word}
th{font-size:11.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.03em;overflow-wrap:break-word} table.dense th{font-size:10.5px;letter-spacing:.01em}
td{white-space:normal} td:not(.name):not(.wrap):not(:first-child){white-space:nowrap} td.wrap{min-width:12ch}
tr.muted td{color:var(--muted)} tr.strong td{font-weight:600}
tr.gold td{font-weight:700;color:var(--gold)} table.dense td{padding:5px 8px;font-size:12.5px} table.dense td small{color:var(--muted)}
.dot{display:inline-block;width:9px;height:9px;border-radius:2px;margin-inline-end:6px}
.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:16px}
.cc-chart{margin:0;min-width:0} .cc-legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--muted);margin-top:4px}
.cc-key{display:inline-flex;align-items:center;gap:6px} .cc-swatch{display:inline-block;width:16px;height:3px;border-radius:2px;background:var(--c)}
.cc-swatch.dashed{background:repeating-linear-gradient(90deg,var(--c) 0 5px,transparent 5px 9px)}
footer{color:var(--muted);font-size:12px;max-width:1060px;margin:0 auto;padding:0 20px 32px}
@media (max-width:600px){header{padding:20px 16px} header h1{font-size:21px} main{padding:16px 10px 32px} section{padding:16px 14px}}
@media print{:root{color-scheme:light;--bg:#fff;--card:#fff;--ink:#111827;--muted:#5b6474;--line:#e5e7eb;--grid:#e5e7eb;--row:#eef0f4;--soft:#eef2ff;--soft-line:#c7d2fe;--gold:#4338ca;--plan:#7c3aed}
  .theme{display:none} header{-webkit-print-color-adjust:exact;print-color-adjust:exact} section{break-inside:avoid-page;border:0;padding:0 0 12px}
  .scroll{overflow:visible;border:0} table.dense{font-size:10px} td:not(.name):not(:first-child){white-space:normal}}
`;

/**
 * The report's HTML. `data` is what generating it saved: see page.js reportData().
 * `options`: `t` the page's translator, `lang` its language and `dir` its direction ("rtl" for Arabic and Hebrew).
 */
export function buildReport(data, { t, lang = 'en', dir = 'ltr' } = {}) {
  const L = wording({ t, lang });
  const { w, num } = L;
  const customer = esc(data.customer || L.t('Customer'));
  // Reports made before the extra % and bundles were added carry no summary: work it out with none.
  const sum = creditSummary(data.tr?.totals.credits ?? null, data.fusion?.totals.credits ?? null, data.summary?.settings);
  const made = esc(new Date(data.generatedAt).toLocaleString(L.locale));
  return `<!doctype html>
<html lang="${esc(lang)}" dir="${dir === 'rtl' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${w('{0}: Checkmarx credits projection', customer)}</title>
<style>${STYLE}</style></head>
<body>
<header>
  <div class="top">
    <div>
      <div class="eyebrow">${data.organisation ? esc(data.organisation) : w('Checkmarx credits projection')}</div>
      <h1>${w('{0}: credits projection', customer)}</h1>
      <div class="meta">${data.preparedBy ? w('Made {0} by {1}', made, esc(data.preparedBy)) : w('Made {0}', made)}</div>
    </div>
    <fieldset class="theme"><legend>${w('Theme')}</legend>
      <input type="radio" name="theme" id="theme-auto" checked><label for="theme-auto">${w('Auto')}</label>
      <input type="radio" name="theme" id="theme-light"><label for="theme-light">${w('Light')}</label>
      <input type="radio" name="theme" id="theme-dark"><label for="theme-dark">${w('Dark')}</label>
    </fieldset>
  </div>
</header>
<main>
<section>
  <h2>${w('Credits required')}</h2>
  <div class="grand">
    ${data.tr ? `<div class="tile"><span>${w('Triage & remediation')}</span><b>${num(data.tr.totals.credits, 1)}</b><small>${w('{0} findings', num(data.tr.totals.selected))}</small></div>` : ''}
    ${data.fusion ? `<div class="tile"><span>${w('Fusion scans')}</span><b>${num(data.fusion.totals.credits, 1)}</b><small>${w('{0} scans, {1} months', num(data.fusion.totals.scans), num(data.fusion.periodMonths))}</small></div>` : ''}
    ${sum.settings.extraPercent ? `<div class="tile"><span>${w('Extra credits')}</span><b>${num(sum.extra, 1)}</b><small>${w('{0}% on top of {1}', num(sum.settings.extraPercent, 2), num(sum.base, 1))}</small></div>` : ''}
    <div class="tile gold"><span>${w('Total credits required')}</span><b>${num(sum.total, 1)}</b><small>${sum.settings.extraPercent ? w('including {0}% extra', num(sum.settings.extraPercent, 2)) : w('credits')}</small></div>
    <div class="tile gold"><span>${w('Bundles')}</span><b>${num(sum.bundles)}</b><small>${w('of {0} credits: {1} ÷ {2} = {3}', num(sum.settings.bundleCredits), num(sum.total, 1), num(sum.settings.bundleCredits), num(sum.exactBundles, 2))}${sum.bundles !== sum.exactBundles && sum.total ? w(', rounded up') : ''}</small></div>
  </div>
</section>
${data.tr ? trSection(data.tr, L) : ''}
${data.fusion ? fusionSection(data.fusion, L) : ''}
</main>
<footer>${w("An estimate made with CxMissionZero's Cx Credits Calculator from Checkmarx One data and the assumptions above. Credit rates and the credits actually used are set by Checkmarx and your agreement with them.")}${data.tr?.history?.length ? ` ${w('Backlog history: {0} to {1}.', esc(monthLabel(data.tr.history[0].month)), esc(monthLabel(data.tr.history[data.tr.history.length - 1].month)))}` : ''}</footer>
</body></html>`;
}
