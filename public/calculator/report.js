// Cx Credits Calculator: the projection report, one self-contained HTML file (no scripts, nothing
// loaded from anywhere), from the data a generated report keeps. Prints to PDF from the browser.
// Every name and figure is escaped: the data may hold what a customer's exports or projects said.

import { FREQUENCIES, SEVERITIES, creditSummary } from './model.js';
import { SEVERITY_COLOURS, backlogTrendChart, forecastChart, monthLabel, ratesChart, severityChart } from './charts.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (n, digits = 0) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: digits }));
const pct = (n) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`);
const date = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '');
const REPORT_PALETTE = { ink: '#111827', muted: '#6b7280', grid: '#e5e7eb', forecast: '#dc2626', plan: '#7c3aed', fixRate: '#16a34a', debtRate: '#dc2626', severity: SEVERITY_COLOURS };
const frequencyLabel = (id) => FREQUENCIES.find((f) => f.id === id)?.label ?? '—';
const FROM = { default: 'Default', frequency: 'Scan frequency', criticality: 'Criticality', project: 'Set for the project' };

/** The file name: the customer, what it is, and when (local time), safe on every system. */
export function reportFileName(customer, at = new Date()) {
  const d = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  const name = String(customer || 'Customer').normalize('NFKD').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'Customer';
  return `${name}_Cx-credits-projection_${stamp}.html`;
}

function trSection(tr) {
  const rows = SEVERITIES.map((s) => tr.rows[s]);
  const cell = (fn) => rows.map((r) => `<td>${fn(r)}</td>`).join('');
  return `<section>
  <h2>Triage &amp; remediation</h2>
  <p class="sub">Backlog as of ${esc(date(tr.asOf))}, against ${esc(date(tr.previousDate))}. Debt growth and fix rate over ${tr.lookbackMonths ? `the last ${tr.lookbackMonths} months` : 'the latest week'}.</p>
  <div class="tiles">
    <div class="tile"><span>Findings to triage</span><b>${num(tr.totals.selected)}</b><small>of ${num(tr.totals.backlog)} open</small></div>
    <div class="tile"><span>Estimated true positives</span><b>${num(tr.totals.truePositives)}</b><small>to remediate</small></div>
    <div class="tile gold"><span>Credits</span><b>${num(tr.totals.credits, 1)}</b><small>${num(tr.totals.triageCredits, 1)} triage + ${num(tr.totals.remediationCredits, 1)} remediation</small></div>
    <div class="tile"><span>Backlog cleared</span><b>${tr.totals.backlog ? ((tr.totals.selected / tr.totals.backlog) * 100).toFixed(1) : '—'}%</b><small>of the current backlog</small></div>
  </div>
  <table>
    <thead><tr><th>By severity</th>${SEVERITIES.map((s) => `<th><i class="dot" style="background:${SEVERITY_COLOURS[s]}"></i>${s}</th>`).join('')}<th>Total</th></tr></thead>
    <tbody>
      <tr><td>Current backlog</td>${cell((r) => num(r.backlog))}<td>${num(tr.totals.backlog)}</td></tr>
      <tr class="muted"><td>Debt increase</td>${SEVERITIES.map((s) => `<td>${pct(tr.analysis[s].debtRate)}</td>`).join('')}<td>${pct(tr.analysis.total.debtRate)}</td></tr>
      <tr class="muted"><td>Fix rate</td>${SEVERITIES.map((s) => `<td>${pct(tr.analysis[s].fixRate)}</td>`).join('')}<td>${pct(tr.analysis.total.fixRate)}</td></tr>
      <tr class="strong"><td>To triage</td>${cell((r) => num(r.selected))}<td>${num(tr.totals.selected)}</td></tr>
      <tr class="muted"><td>Credits per triage</td>${cell((r) => num(r.triageCost, 2))}<td>—</td></tr>
      <tr class="muted"><td>False positives (estimated)</td>${cell((r) => `${num(r.fp)}%`)}<td>—</td></tr>
      <tr><td>True positives (estimated)</td>${cell((r) => num(r.truePositives))}<td>${num(tr.totals.truePositives)}</td></tr>
      <tr class="muted"><td>Credits per remediation</td>${cell((r) => num(r.remediationCost, 2))}<td>—</td></tr>
      <tr><td>Triage credits</td>${cell((r) => num(r.triageCredits, 1))}<td>${num(tr.totals.triageCredits, 1)}</td></tr>
      <tr><td>Remediation credits</td>${cell((r) => num(r.remediationCredits, 1))}<td>${num(tr.totals.remediationCredits, 1)}</td></tr>
      <tr class="gold"><td>Credits</td>${cell((r) => num(r.credits, 1))}<td>${num(tr.totals.credits, 1)}</td></tr>
      <tr><td>Backlog after</td>${cell((r) => num(r.backlogAfter))}<td>${num(tr.totals.backlogAfter)}</td></tr>
    </tbody>
  </table>
  ${tr.weekly?.length ? `<h3>Last ${Math.round(tr.weekly.length / 4.345)} months, week by week</h3><div class="pair">${backlogTrendChart(tr.weekly, REPORT_PALETTE)}${ratesChart(tr.weekly, REPORT_PALETTE)}</div>` : ''}
  ${tr.forecast?.length ? `<h3>Backlog trend and forecast</h3><p class="sub">${tr.monthlyChange >= 0 ? `The backlog grew by ${num(tr.monthlyChange)} a month on average recently.` : `The backlog shrank by ${num(-tr.monthlyChange)} a month on average recently.`}</p>${forecastChart(tr.forecast, REPORT_PALETTE)}` : ''}
  ${tr.severityForecast?.length ? `<h3>3-month plan by severity</h3><p class="sub">Solid: the backlog so far. Dashed: the next 3 months with the findings above fixed evenly, against the pace new ones arrive. Log scale.</p>${severityChart(tr.severityForecast, REPORT_PALETTE)}` : ''}
</section>`;
}

function fusionSection(f) {
  const models = new Map(f.models.map((m) => [m.id, m]));
  const modelName = (id) => models.get(id)?.name || '—';
  return `<section>
  <h2>Checkmarx Fusion</h2>
  <p class="sub">Fusion scans over ${num(f.periodMonths)} months. Each project's lines of code are rounded up to whole 10K units on their own; one scan costs its model's credits per 10K LOC. Projects scanned most often come first.</p>
  <div class="tiles">
    <div class="tile"><span>Projects</span><b>${num(f.totals.projects)}</b><small>${num(f.totals.lines)} lines of code</small></div>
    <div class="tile"><span>10K LOC units</span><b>${num(f.totals.units)}</b><small>each project rounded up</small></div>
    <div class="tile"><span>Fusion scans</span><b>${num(f.totals.scans)}</b><small>over ${num(f.periodMonths)} months</small></div>
    <div class="tile gold"><span>Credits</span><b>${num(f.totals.credits, 1)}</b><small>${f.totals.unknownRate ? `${num(f.totals.unknownRate)} projects without a model rate are not counted` : 'every project counted'}</small></div>
  </div>
  ${f.remainingCredits !== null && f.remainingCredits !== undefined ? `<p class="note">Credits remaining in the Checkmarx One tenant when this was made: <b>${num(f.remainingCredits)}</b>.</p>` : ''}
  <h3>Models</h3>
  <table><thead><tr><th>Model</th><th>Credits per 10K LOC</th><th>Projects</th><th>10K units × scans</th><th>Credits</th></tr></thead><tbody>
    ${f.byModel.map((m) => `<tr><td>${esc(m.name || '—')}</td><td>${m.rate === null ? '—' : num(m.rate, 2)}</td><td>${num(m.projects)}</td><td>${num(m.unitScans)}</td><td>${num(m.credits, 1)}</td></tr>`).join('') || '<tr><td colspan="5">No model set.</td></tr>'}
  </tbody></table>
  <h3>By scan frequency</h3>
  <table><thead><tr><th>Scanned today</th><th>Projects</th><th>Fusion scans per project</th><th>Model</th><th>10K units</th><th>Credits</th></tr></thead><tbody>
    ${f.byFrequency.filter((b) => b.projects).map((b) => `<tr><td>${esc(frequencyLabel(b.id))}</td><td>${num(b.projects)}</td><td>${f.rules[b.id]?.scans ?? `${num(f.defaultScans)} (default)`}</td><td>${esc(modelName(f.rules[b.id]?.model ?? f.defaultModel))}</td><td>${num(b.units)}</td><td>${num(b.credits, 1)}</td></tr>`).join('')}
  </tbody></table>
  <h3>Projects</h3>
  <table class="dense"><thead><tr><th>Project</th><th>Criticality</th><th>Scanned today</th><th>Lines of code</th><th>10K units</th><th>Fusion scans</th><th>Set by</th><th>Model</th><th>Credits</th></tr></thead><tbody>
    ${f.rows.filter((r) => r.included).map((r) => `<tr><td>${esc(r.name)}</td><td>${r.criticality ?? '—'}</td><td>${esc(frequencyLabel(r.frequency))}${r.scansPerWeek ? ` <small>(${num(r.scansPerWeek, 1)}/week)</small>` : ''}</td><td>${num(r.lines)}</td><td>${num(r.units)}</td><td>${num(r.scans)}</td><td>${esc(FROM[r.scansFrom] ?? '')}</td><td>${esc(modelName(r.model))}</td><td>${r.credits === null || !r.units ? '—' : num(r.credits, 1)}</td></tr>`).join('')}
  </tbody></table>
</section>`;
}

/** The report's HTML. `data` is what generating it saved: see page.js reportData(). */
export function buildReport(data) {
  const title = `${data.customer || 'Customer'}: Checkmarx credits projection`;
  // Reports made before the extra % and bundles were added carry no summary: work it out with none.
  const sum = creditSummary(data.tr?.totals.credits ?? null, data.fusion?.totals.credits ?? null, data.summary?.settings);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#f6f7fb;color:#111827;font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
header{background:linear-gradient(120deg,#1e1b4b,#4f46e5);color:#fff;padding:28px 32px}
header .eyebrow{opacity:.8;font-size:12px;letter-spacing:.04em;text-transform:uppercase}
header h1{margin:4px 0 6px;font-size:26px}
header .meta{opacity:.9;font-size:13px}
main{max-width:1060px;margin:0 auto;padding:24px 20px 48px}
section{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:22px 24px;margin:0 0 20px}
h2{margin:0 0 4px;font-size:20px} h3{margin:22px 0 6px;font-size:15px}
.sub{color:#6b7280;margin:0 0 14px;font-size:13px} .note{background:#eef2ff;border-radius:10px;padding:10px 14px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:0 0 16px}
.tile{border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px;display:flex;flex-direction:column}
.tile span{color:#6b7280;font-size:12px;font-weight:600} .tile b{font-size:24px} .tile small{color:#6b7280}
.tile.gold{background:#eef2ff;border-color:#c7d2fe} .tile.gold b{color:#4338ca}
.grand{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
table{width:100%;border-collapse:collapse;margin:6px 0 4px;font-variant-numeric:tabular-nums}
th,td{padding:7px 10px;border-bottom:1px solid #eef0f4;text-align:end} th:first-child,td:first-child{text-align:start}
th{font-size:11.5px;color:#6b7280;text-transform:uppercase;letter-spacing:.03em} tr.muted td{color:#6b7280} tr.strong td{font-weight:600}
tr.gold td{font-weight:700;color:#4338ca} table.dense td{padding:5px 8px;font-size:12.5px}
.dot{display:inline-block;width:9px;height:9px;border-radius:2px;margin-inline-end:6px}
.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
.cc-chart{margin:0} .cc-legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:#6b7280;margin-top:4px}
.cc-key{display:inline-flex;align-items:center;gap:6px} .cc-swatch{display:inline-block;width:16px;height:3px;border-radius:2px;background:var(--c)}
.cc-swatch.dashed{background:repeating-linear-gradient(90deg,var(--c) 0 5px,transparent 5px 9px)}
footer{color:#6b7280;font-size:12px;max-width:1060px;margin:0 auto;padding:0 20px 32px}
@media print{body{background:#fff} header{-webkit-print-color-adjust:exact;print-color-adjust:exact} section{break-inside:avoid-page;border:0;padding:0 0 12px}}
</style></head>
<body>
<header>
  <div class="eyebrow">${esc(data.organisation || 'Checkmarx credits projection')}</div>
  <h1>${esc(data.customer || 'Customer')}: credits projection</h1>
  <div class="meta">Made ${esc(new Date(data.generatedAt).toLocaleString())}${data.preparedBy ? ` by ${esc(data.preparedBy)}` : ''}${data.organisation ? `, ${esc(data.organisation)}` : ''}</div>
</header>
<main>
<section>
  <h2>Credits required</h2>
  <div class="grand">
    ${data.tr ? `<div class="tile"><span>Triage &amp; remediation</span><b>${num(data.tr.totals.credits, 1)}</b><small>${num(data.tr.totals.selected)} findings</small></div>` : ''}
    ${data.fusion ? `<div class="tile"><span>Fusion scans</span><b>${num(data.fusion.totals.credits, 1)}</b><small>${num(data.fusion.totals.scans)} scans, ${num(data.fusion.periodMonths)} months</small></div>` : ''}
    ${sum.settings.extraPercent ? `<div class="tile"><span>Extra credits</span><b>${num(sum.extra, 1)}</b><small>${num(sum.settings.extraPercent, 2)}% on top of ${num(sum.base, 1)}</small></div>` : ''}
    <div class="tile gold"><span>Total credits required</span><b>${num(sum.total, 1)}</b><small>${sum.settings.extraPercent ? `including ${num(sum.settings.extraPercent, 2)}% extra` : 'credits'}</small></div>
    <div class="tile gold"><span>Bundles</span><b>${num(sum.bundles)}</b><small>of ${num(sum.settings.bundleCredits)} credits: ${num(sum.total, 1)} ÷ ${num(sum.settings.bundleCredits)} = ${num(sum.exactBundles, 2)}${sum.bundles !== sum.exactBundles && sum.total ? ', rounded up' : ''}</small></div>
  </div>
</section>
${data.tr ? trSection(data.tr) : ''}
${data.fusion ? fusionSection(data.fusion) : ''}
</main>
<footer>An estimate made with CxMissionZero's Cx Credits Calculator from Checkmarx One data and the assumptions above. Credit rates and the credits actually used are set by Checkmarx and your agreement with them.${data.tr?.history?.length ? ` Backlog history: ${esc(monthLabel(data.tr.history[0].month))} to ${esc(monthLabel(data.tr.history[data.tr.history.length - 1].month))}.` : ''}</footer>
</body></html>`;
}
