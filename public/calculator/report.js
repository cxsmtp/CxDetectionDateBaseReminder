// Cx Credits Calculator: the projection report, one self-contained HTML file (no scripts, nothing
// loaded from anywhere), from the data a generated report keeps. Prints to PDF from the browser.
// Every name and figure is escaped: the data may hold what a customer's exports or projects said.
// It is written in the language the page is in (`t`, the page's translator), and has a light and
// a dark theme the reader switches between with CSS alone (Auto follows their system).
//
// It says the answer first (the credits, the bundles, over how long), then that it comes from live
// Checkmarx One data, then how the number was reached, the assumptions, and last every figure.

import { describeEngines } from '../engines.js';
import { NEXTGEN_ACCENTS, reportLook } from '../look.js';
import { FREQUENCIES, SEVERITIES, cleanScope, creditSummary } from './model.js';
import { allSections, sectionHtml } from './explain.js';
import { SEVERITY_COLOURS, backlogTrendChart, debtFixChart, forecastChart, monthLabel, ratesChart, severityChart, severityCharts } from './charts.js';

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
export function wording({ t = (text) => text, lang = 'en' } = {}) {
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
const palette = (t) => ({ ink: 'var(--ink)', muted: 'var(--muted)', grid: 'var(--grid)', forecast: '#dc2626', plan: 'var(--accent)', fixRate: '#16a34a', debtRate: '#dc2626', severity: SEVERITY_COLOURS, t });
const table = (html, cls = '') => `<div class="scroll"><table${cls ? ` class="${cls}"` : ''}>${html}</table></div>`;

/**
 * The triage & remediation figures, whichever version made them: a report from before MZ-01.00.67
 * counted the backlog chosen only (nothing ahead).
 */
export function trFigures(tr) {
  const T = tr.totals ?? {};
  const v = (key, fallback = 0) => (Number.isFinite(T[key]) ? T[key] : fallback);
  return {
    backlog: v('backlog'),
    selected: v('selected'),
    future: v('future'),
    fusionExtra: v('fusionExtra'),
    faeAvoided: v('faeAvoided'),
    toTriage: v('toTriage', v('selected')),
    truePositives: v('truePositives'),
    triageCredits: v('triageCredits'),
    remediationCredits: v('remediationCredits'),
    credits: v('credits'),
    backlogCredits: v('backlogCredits', v('credits')),
    aheadCredits: v('aheadCredits'),
  };
}

/** The one line that says which projects were counted, when the customer narrowed them. */
function scopeLine(source, L) {
  const { w } = L;
  if (!source?.scoped) return '';
  const sc = cleanScope(source.scope);
  const parts = [
    sc.applications.length && `${w('Applications')}: ${esc(sc.applications.join(', '))}`,
    sc.projects.length && `${w('Projects')}: ${esc((source.projectNames ?? sc.projects).slice(0, 20).join(', '))}${sc.projects.length > 20 ? ` ${esc(w('and {0} more', num(sc.projects.length - 20)))}` : ''}`,
    sc.groups.length && `${w('Groups')}: ${esc(sc.groups.join(', '))}`,
    sc.names.length && `${w('Project names')}: ${esc(sc.names.join(', '))}`,
    sc.initiators.length && `${w('Last scanned by')}: ${esc(sc.initiators.join(', '))}`,
    sc.frequencies.length && `${w('How often they are scanned')}: ${sc.frequencies.map((id) => L.frequency(id)).join(', ')}`,
    sc.criticalities.length && `${w('Criticality')}: ${esc(sc.criticalities.join(', '))}`,
  ].filter(Boolean);
  return parts.length ? `<p class="scope">${w('Projects counted')}: ${parts.join(' · ')}</p>` : '';
}

/** The answer: the credits, the bundles, and what they are made of, as one bar. */
function answer(data, sum, L) {
  const { w, num } = L;
  const tr = data.tr ? trFigures(data.tr) : null;
  const months = data.months ?? data.fusion?.periodMonths ?? null;
  const parts = [
    tr && { key: 'backlog', label: w('Backlog today'), value: tr.backlogCredits, colour: 'var(--ink)' },
    tr && tr.aheadCredits > 0 && { key: 'ahead', label: w('Findings ahead'), value: tr.aheadCredits, colour: 'var(--accent)' },
    data.fusion && { key: 'fusion', label: w('Fusion scans'), value: data.fusion.totals.credits ?? 0, colour: '#0d9488' },
    sum.extra > 0 && { key: 'extra', label: w('Extra credits'), value: sum.extra, colour: 'var(--muted)' },
  ].filter((p) => p && p.value > 0);
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  const bar = parts.map((p) => `<span style="width:${((p.value / total) * 100).toFixed(2)}%;background:${p.colour}" title="${esc(`${p.label}: ${num(p.value, 1)}`)}"></span>`).join('');
  const keys = parts.map((p) => `<li><i style="background:${p.colour}"></i><span>${p.label}</span><b>${num(p.value, 1)}</b></li>`).join('');
  return `<section class="answer">
  <div class="answer-main">
    <span class="eyebrow">${w('Total credits required')}</span>
    <b class="big">${num(sum.total, 0)}</b>
    <span class="answer-sub">${w('{0} bundles of {1} credits', num(sum.bundles), num(sum.settings.bundleCredits))}${months ? ` · ${w('over {0} months', num(months))}` : ''}${sum.settings.extraPercent ? ` · ${w('including {0}% extra', num(sum.settings.extraPercent, 2))}` : ''}</span>
  </div>
  ${parts.length ? `<div class="bar" role="img" aria-label="${w('What the credits are for')}">${bar}</div><ul class="keys">${keys}</ul>` : ''}
</section>`;
}

/** Where the figures come from: live Checkmarx One data, when it was read, and how much of it. */
function provenance(data, L) {
  const { w, num, date } = L;
  const src = data.source ?? {};
  const tr = data.tr;
  const open = tr?.analysis?.total?.current ?? (tr ? trFigures(tr).backlog : null);
  let line;
  if (src.kind === 'cxone' || (!src.kind && tr?.weekly?.length)) {
    line = w('Read live from Checkmarx One on {0}: {1} projects, {2} scans, {3} open vulnerabilities.', esc(date(src.readAt ?? data.generatedAt)), num(src.projects ?? data.fusion?.totals?.projects), num(src.scans), num(open));
  } else if (src.kind === 'upload') {
    line = w("From the customer's Checkmarx One exports, up to {0}: {1} open vulnerabilities.", esc(date(tr?.asOf)), num(open));
  } else {
    line = w('From the projects entered for this projection.');
  }
  // Read from Checkmarx One: which engines' findings are counted (a report made before says nothing).
  const engines = Array.isArray(src.engines) ? `<p class="sub">${src.engines.length ? w('Engines counted: {0}.', `<span translate="no">${esc(describeEngines(src.engines))}</span>`) : w('Engines counted: all.')}</p>` : '';
  // Which branches' scans were counted (a report made before says nothing), and the projects left out as having nothing to analyse.
  const branches = src.branches === 'primary'
    ? `<p class="sub">${w("Branch counted: each project's primary branch (else main, else master), so no finding is counted twice.")}</p>`
    : src.branches === 'all'
      ? `<p class="sub">${w('Branches counted: every branch scanned.')}</p>`
      : '';
  const out = src.leftOut ?? {};
  const leftOut = [
    out.noCode > 0 && w('Left out: {0} projects whose latest scan counted no lines of code.', num(out.noCode)),
    out.noFindings > 0 && w('Left out: {0} projects with no open findings.', num(out.noFindings)),
  ].filter(Boolean).map((t) => `<p class="sub">${t}</p>`).join('');
  return `<section class="live"><span class="live-dot" aria-hidden="true"></span><div><p>${line}</p>${tr?.lookbackMonths ? `<p class="sub">${w('The trend is measured over the last {0} months of that data, week by week, and carried forward.', num(tr.lookbackMonths))}</p>` : ''}${engines}${branches}${leftOut}${scopeLine(src, L)}</div></section>`;
}

/** How the number was reached: today, what is ahead, and Fusion. */
function story(data, L) {
  const { w, num, pct } = L;
  const cards = [];
  const tr = data.tr;
  if (tr) {
    const f = trFigures(tr);
    const months = tr.months ?? data.months ?? 12;
    const a = tr.analysis?.total ?? {};
    cards.push(`<div class="card">
      <h3>${w('Today')}</h3>
      <p class="figure">${num(f.backlog)} <span>${w('open vulnerabilities')}</span></p>
      <ul class="sevs">${SEVERITIES.map((s) => `<li><i style="background:${SEVERITY_COLOURS[s]}"></i>${w(s)} <b>${num(tr.rows?.[s]?.backlog)}</b></li>`).join('')}</ul>
      ${Number.isFinite(a.arrivals) ? `<p class="sub">${w('{0} new a month; {1} fixed over the last {2} months.', num(a.arrivals), pct(a.fixRate).replace(/^\+/, ''), num(tr.lookbackMonths))}</p>` : ''}
    </div>`);
    cards.push(`<div class="card">
      <h3>${w('The next {0} months', num(months))}</h3>
      <table class="calc">
        <tr><td>${w('Backlog to triage')}</td><td>${num(f.selected)}</td></tr>
        <tr><td>${tr.ahead?.aiDeclinePercent ? w('Still to come, {0}% fewer each month with AI', num(tr.ahead.aiDeclinePercent)) : w('Still to come, at the current pace')}</td><td>+${num(f.future)}</td></tr>
        <tr><td>${w('More found by Fusion ({0}%)', num(tr.ahead?.fusionUpliftPercent ?? 0))}</td><td>+${num(f.fusionExtra)}</td></tr>
        <tr><td>${w('Fewer false positives with FAE ({0}%)', num(tr.ahead?.faePercent ?? 0))}</td><td>−${num(f.faeAvoided)}</td></tr>
        <tr class="sum"><td>${w('To triage')}</td><td>${num(f.toTriage)}</td></tr>
        <tr><td>${w('To remediate (true positives)')}</td><td>${num(f.truePositives)}</td></tr>
        <tr class="sum gold"><td>${w('Triage & remediation credits')}</td><td>${num(f.credits, 1)}</td></tr>
      </table>
    </div>`);
  }
  if (data.fusion) {
    const t = data.fusion.totals;
    cards.push(`<div class="card">
      <h3>${w('Checkmarx Fusion')}</h3>
      <table class="calc">
        <tr><td>${w('Projects')}</td><td>${num(t.projects)}</td></tr>
        <tr><td>${w('Lines of code')}</td><td>${num(t.lines)}</td></tr>
        <tr><td>${w('10K LOC units')}</td><td>${num(t.units)}</td></tr>
        <tr><td>${w('Fusion scans over {0} months', num(data.fusion.periodMonths))}</td><td>${num(t.scans)}</td></tr>
        <tr class="sum gold"><td>${w('Fusion credits')}</td><td>${num(t.credits, 1)}</td></tr>
      </table>
      ${t.unknownRate ? `<p class="sub warn">${w('{0} projects without a model rate are not counted', num(t.unknownRate))}</p>` : ''}
      ${data.fusion.remainingCredits !== null && data.fusion.remainingCredits !== undefined ? `<p class="sub">${w('Credits remaining in the Checkmarx One tenant when this was made: {0}.', `<b>${num(data.fusion.remainingCredits)}</b>`)}</p>` : ''}
    </div>`);
  }
  if (!cards.length) return '';
  const chart = tr?.forecast?.length ? `<h3 class="chart-title">${w('Backlog trend and forecast')}</h3><p class="sub">${tr.monthlyChange >= 0 ? w('The backlog grew by {0} a month on average recently.', num(tr.monthlyChange)) : w('The backlog shrank by {0} a month on average recently.', num(-tr.monthlyChange))}</p>${forecastChart(tr.forecast, palette(L.t))}` : '';
  return `<section><h2>${w('How we got there')}</h2><div class="cards">${cards.join('')}</div>${chart}</section>`;
}

/** The assumptions behind the number, in one short list. */
function assumptions(data, sum, L) {
  return `<section><h2>${L.w('Assumptions')}</h2><ul class="assume">${assumptionItems(data, sum, L).map((i) => `<li>${i}</li>`).join('')}</ul></section>`;
}

/** The assumptions behind the number, each a sentence (escaped HTML). */
export function assumptionItems(data, sum, L) {
  const { w, num } = L;
  const items = [];
  const tr = data.tr;
  if (tr) {
    items.push(w('The trend is measured over the last {0} months; the projection covers the next {1} months.', num(tr.lookbackMonths), num(tr.months ?? data.months ?? 12)));
    const rows = SEVERITIES.map((s) => tr.rows?.[s]).filter(Boolean);
    const same = (key) => rows.every((r) => r[key] === rows[0]?.[key]);
    const each = (key, digits = 2) => (same(key) ? num(rows[0]?.[key], digits) : SEVERITIES.map((s) => `${w(s)} ${num(tr.rows?.[s]?.[key], digits)}`).join(', '));
    items.push(w('{0} credit(s) per triage; {1} per remediation.', each('triageCost'), each('remediationCost')));
    items.push(w('False positives expected: {0}%.', each('fp', 0)));
    if (tr.ahead) {
      if (!tr.ahead.includeFuture) items.push(w('Findings still to come are not counted.'));
      else if (Number.isFinite(tr.totals?.selected) && tr.totals.selected < tr.totals.backlog) items.push(w('New findings are counted in the same share per severity as the backlog chosen.'));
      else if (tr.ahead.aiDeclinePercent) items.push(w('New findings arrive at the pace of the last {0} months, then {1}% fewer each month as teams adopt AI.', num(tr.lookbackMonths), num(tr.ahead.aiDeclinePercent)));
      else items.push(w('New findings keep arriving at the pace of the last {0} months.', num(tr.lookbackMonths)));
      if (tr.fusion) items.push(w('Fusion reports {0}% more findings than today.', num(tr.ahead.fusionUpliftPercent)));
      items.push(w('FAE keeps {0}% of the new findings from being reported, among the false positives only.', num(tr.ahead.faePercent)));
    }
  }
  if (data.fusion) items.push(w("Each project's lines of code are rounded up to whole 10K units on their own; one scan costs its model's credits per 10K LOC."));
  if (sum.settings.extraPercent) items.push(w('{0}% extra credits on top.', num(sum.settings.extraPercent, 2)));
  items.push(w('Bundles of {0} credits, rounded up to whole bundles.', num(sum.settings.bundleCredits)));
  return items;
}

/** How every number is calculated, with the figures in: closed until the reader opens it. */
function calculations(data, L) {
  const sections = allSections(data, L);
  return `<section class="how"><details><summary><h2>${L.w('How each number is calculated')}</h2><span class="sub">${L.w('Every step, with the figures in. Select to open.')}</span></summary>
  ${sections.map((x) => `<h3>${x.title}</h3>${sectionHtml(x)}`).join('')}
</details></section>`;
}

/** Appendix: every triage & remediation figure by severity, and the weekly charts. */
function trAppendix(tr, L) {
  const { w, num, pct, date } = L;
  const rows = SEVERITIES.map((s) => tr.rows?.[s] ?? {});
  const f = trFigures(tr);
  const cell = (fn) => rows.map((r) => `<td>${fn(r)}</td>`).join('');
  const P = palette(L.t);
  const months = Math.round((tr.weekly?.length ?? 0) / 4.345);
  const an = (s) => tr.analysis?.[s] ?? {};
  const hasAhead = Number.isFinite(tr.totals?.toTriage);
  // Reports from MZ-01.00.69 on: debt added against fixes a month; earlier ones keep their two rates.
  const hasDebtFix = Number.isFinite(tr.analysis?.total?.fixedMonthly);
  const signed = (v) => (!Number.isFinite(v) ? '—' : Math.round(v) > 0 ? `+${num(v)}` : Math.round(v) < 0 ? `−${num(-v)}` : '0');
  const hasWeeklyDebt = tr.weekly?.some((x) => x.addedRate !== undefined);
  return `<section class="appendix">
  <h2>${w('Triage & remediation')}</h2>
  <p class="sub">${w('Backlog as of {0}, against {1}.', esc(date(tr.asOf)), esc(date(tr.previousDate)))}</p>
  ${table(`
    <thead><tr><th>${w('By severity')}</th>${SEVERITIES.map((s) => `<th><i class="dot" style="background:${SEVERITY_COLOURS[s]}"></i>${w(s)}</th>`).join('')}<th>${w('Total')}</th></tr></thead>
    <tbody>
      <tr><td>${w('Current backlog')}</td>${cell((r) => num(r.backlog))}<td>${num(f.backlog)}</td></tr>
      ${hasDebtFix ? `<tr class="muted"><td>${w('Added a month')}</td>${SEVERITIES.map((s) => `<td>${num(an(s).arrivals)}</td>`).join('')}<td>${num(tr.analysis?.total?.arrivals)}</td></tr>
      <tr class="muted"><td>${w('Fixed a month')}</td>${SEVERITIES.map((s) => `<td>${num(an(s).fixedMonthly)}</td>`).join('')}<td>${num(tr.analysis?.total?.fixedMonthly)}</td></tr>
      <tr class="muted"><td>${w('Change a month')}</td>${SEVERITIES.map((s) => `<td>${signed(an(s).netMonthly)}</td>`).join('')}<td>${signed(tr.analysis?.total?.netMonthly)}</td></tr>`
    : `<tr class="muted"><td>${w('Debt increase')}</td>${SEVERITIES.map((s) => `<td>${pct(an(s).debtRate)}</td>`).join('')}<td>${pct(tr.analysis?.total?.debtRate)}</td></tr>
      <tr class="muted"><td>${w('Fix rate')}</td>${SEVERITIES.map((s) => `<td>${pct(an(s).fixRate)}</td>`).join('')}<td>${pct(tr.analysis?.total?.fixRate)}</td></tr>
      ${hasAhead ? `<tr class="muted"><td>${w('New findings a month')}</td>${SEVERITIES.map((s) => `<td>${num(an(s).arrivals)}</td>`).join('')}<td>${num(tr.analysis?.total?.arrivals)}</td></tr>` : ''}`}
      <tr><td>${w('Backlog to triage')}</td>${cell((r) => num(r.selected))}<td>${num(f.selected)}</td></tr>
      ${hasAhead ? `<tr><td>${w('Still to come')}</td>${cell((r) => num(r.future))}<td>${num(f.future)}</td></tr>
      <tr><td>${w('More found by Fusion')}</td>${cell((r) => num(r.fusionExtra))}<td>${num(f.fusionExtra)}</td></tr>
      <tr class="muted"><td>${w('Kept away by FAE')}</td>${cell((r) => signed(-r.faeAvoided))}<td>${signed(-f.faeAvoided)}</td></tr>
      <tr class="strong"><td>${w('To triage')}</td>${cell((r) => num(r.toTriage))}<td>${num(f.toTriage)}</td></tr>` : ''}
      <tr class="muted"><td>${w('Credits per triage')}</td>${cell((r) => num(r.triageCost, 2))}<td>—</td></tr>
      <tr class="muted"><td>${w('False positives (estimated)')}</td>${cell((r) => `${num(r.fp)}%`)}<td>—</td></tr>
      <tr><td>${w('True positives (estimated)')}</td>${cell((r) => num(r.truePositives))}<td>${num(f.truePositives)}</td></tr>
      <tr class="muted"><td>${w('Credits per remediation')}</td>${cell((r) => num(r.remediationCost, 2))}<td>—</td></tr>
      <tr><td>${w('Triage credits')}</td>${cell((r) => num(r.triageCredits, 1))}<td>${num(f.triageCredits, 1)}</td></tr>
      <tr><td>${w('Remediation credits')}</td>${cell((r) => num(r.remediationCredits, 1))}<td>${num(f.remediationCredits, 1)}</td></tr>
      <tr class="gold"><td>${w('Credits')}</td>${cell((r) => num(r.credits, 1))}<td>${num(f.credits, 1)}</td></tr>
    </tbody>`)}
  ${tr.weekly?.length ? `<h3>${w('The last {0} months, week by week', num(months))}</h3>${hasWeeklyDebt ? debtFixChart(tr.weekly, P) : `<div class="pair">${backlogTrendChart(tr.weekly, P)}${ratesChart(tr.weekly, P)}</div>`}` : ''}
  ${tr.bySeverity ? `<h3>${w('By severity')}</h3>${severityCharts(tr.bySeverity, P)}` : tr.severityForecast?.length ? `<h3>${w('By severity')}</h3>${severityChart(tr.severityForecast, P)}` : ''}
</section>`;
}

/** Appendix: every Fusion figure. */
function fusionAppendix(f, L) {
  const { w, num, frequency } = L;
  const models = new Map(f.models.map((m) => [m.id, m]));
  const modelName = (id) => esc(models.get(id)?.name || '—');
  return `<section class="appendix">
  <h2>${w('Checkmarx Fusion')}</h2>
  <p class="sub">${w('Fusion scans over {0} months.', num(f.periodMonths))} ${w('Projects scanned most often come first.')}</p>
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
:root{color-scheme:light;--bg:#f5f6f8;--card:#fff;--ink:#14171c;--muted:#5c636e;--line:#e2e5e9;--grid:#e2e5e9;--row:#eef0f3;--soft:#f4f6fb;--soft-line:#d5dcef;--gold:#2856c9;--accent:#2856c9;--head1:#14171c}
${'' /* Dark: chosen, or Auto on a system set to dark. */}
@media (prefers-color-scheme:dark){:root:not(:has(#theme-light:checked)){color-scheme:dark;--bg:#0d0f12;--card:#14171b;--ink:#e6e8eb;--muted:#9097a1;--line:#252a31;--grid:#252a31;--row:#1d2127;--soft:#1a1f2b;--soft-line:#2c3854;--gold:#82a4f4;--accent:#82a4f4;--head1:#0a0c0f}}
:root:has(#theme-dark:checked){color-scheme:dark;--bg:#0d0f12;--card:#14171b;--ink:#e6e8eb;--muted:#9097a1;--line:#252a31;--grid:#252a31;--row:#1d2127;--soft:#1a1f2b;--soft-line:#2c3854;--gold:#82a4f4;--accent:#82a4f4;--head1:#0a0c0f}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 "IBM Plex Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;overflow-wrap:anywhere;-webkit-font-smoothing:antialiased}
header{background:var(--head1);color:#fff;padding:26px 32px}
header .top{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:10px 20px;max-width:1000px;margin:0 auto}
header .eyebrow{opacity:.8;font-size:12px;letter-spacing:.02em}
header h1{margin:4px 0 6px;font-size:24px;line-height:1.25;font-weight:600}
header .meta{opacity:.8;font-size:13px}
.theme{display:inline-flex;align-items:center;gap:2px;border:1px solid rgb(255 255 255 / .3);border-radius:6px;padding:2px;font-size:12px}
.theme legend{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.theme input{position:absolute;opacity:0;pointer-events:none}
.theme label{padding:3px 10px;border-radius:4px;cursor:pointer;color:#fff;opacity:.8}
.theme input:checked+label{background:#fff;color:#14171c;opacity:1;font-weight:600}
.theme input:focus-visible+label{outline:2px solid #fff;outline-offset:1px}
main{max-width:1000px;margin:0 auto;padding:24px 20px 48px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:22px 24px;margin:0 0 16px;min-width:0}
h2{margin:0 0 12px;font-size:18px;font-weight:600} h3{margin:18px 0 6px;font-size:14px;font-weight:600}
.sub{color:var(--muted);margin:0 0 10px;font-size:13px} .warn{color:#b45309}
.answer{display:grid;gap:14px;padding:26px 28px}
.answer .eyebrow{color:var(--muted);font-size:13px;font-weight:500}
.answer-main{display:grid;gap:2px}
.answer .big{font-size:clamp(34px,6vw,52px);line-height:1.1;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.answer-sub{color:var(--muted);font-size:14px}
.bar{display:flex;height:12px;border-radius:6px;overflow:hidden;background:var(--row);gap:2px}
.bar span{display:block;height:100%;min-width:3px}
.keys{display:flex;flex-wrap:wrap;gap:6px 22px;margin:0;padding:0;list-style:none;font-size:13px}
.keys li{display:inline-flex;align-items:center;gap:7px} .keys i{width:10px;height:10px;border-radius:3px;display:inline-block} .keys span{color:var(--muted)} .keys b{font-variant-numeric:tabular-nums}
.live{display:flex;gap:12px;align-items:flex-start;background:var(--soft);border-color:var(--soft-line);padding:14px 18px}
.live p{margin:0} .live .sub{margin-top:4px}
.live-dot{flex:none;width:9px;height:9px;margin-top:6px;border-radius:50%;background:#16a34a;box-shadow:0 0 0 4px rgb(22 163 74 / .18)}
.scope{margin:6px 0 0;font-size:13px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(270px,100%),1fr));gap:12px}
.card{border:1px solid var(--line);border-radius:8px;padding:14px 16px;min-width:0}
.card h3{margin:0 0 8px}
.figure{margin:0 0 6px;font-size:26px;font-weight:600;font-variant-numeric:tabular-nums} .figure span{font-size:13px;color:var(--muted);font-weight:400}
.sevs{list-style:none;margin:0 0 8px;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:2px 12px;font-size:13px}
.sevs li{display:flex;align-items:center;gap:6px} .sevs i{width:8px;height:8px;border-radius:2px;display:inline-block} .sevs b{margin-inline-start:auto;font-variant-numeric:tabular-nums;font-weight:500}
table.calc{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
table.calc td{padding:4px 0;border:0;text-align:start} table.calc td:last-child{text-align:end;white-space:nowrap;padding-inline-start:12px}
table.calc tr.sum td{border-top:1px solid var(--line);padding-top:7px;font-weight:600} table.calc tr.gold td{color:var(--gold)}
.chart-title{margin-top:22px}
.how summary{cursor:pointer;list-style:none;display:grid;gap:2px}.how summary::-webkit-details-marker{display:none}
.how summary h2{display:inline;margin:0}.how summary h2::before{content:"▸ ";color:var(--muted)}.how details[open] summary h2::before{content:"▾ "}
.how h3{margin:16px 0 4px}ol.calc-how{list-style:none;margin:0;padding:0;display:grid;gap:3px;font-size:13.5px;font-variant-numeric:tabular-nums}
ol.calc-how li{margin:0}ol.calc-how li.calc-sub{padding-inline-start:16px;color:var(--muted)}ol.calc-how li.calc-total{font-weight:600}
.assume{margin:0;padding-inline-start:18px;display:grid;gap:4px;font-size:13.5px}
.appendix-title{font-size:12px;color:var(--muted);letter-spacing:.04em;margin:28px 4px 10px;font-weight:500}
.scroll{max-width:100%;overflow-x:auto;margin:6px 0 4px;border:1px solid var(--line);border-radius:8px}
.scroll table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.scroll th,.scroll td{padding:7px 10px;border-bottom:1px solid var(--row);text-align:end;vertical-align:top}
.scroll tbody tr:last-child td{border-bottom:0}
.scroll th:first-child,.scroll td:first-child,td.name{text-align:start}
td.name{min-width:12ch;max-width:40ch;overflow-wrap:anywhere;word-break:break-word}
th{font-size:12px;color:var(--muted);font-weight:500;overflow-wrap:break-word} table.dense th{font-size:11px}
td{white-space:normal} td:not(.name):not(.wrap):not(:first-child){white-space:nowrap} td.wrap{min-width:12ch}
tr.muted td{color:var(--muted)} tr.strong td{font-weight:600}
tr.gold td{font-weight:600;color:var(--gold)} table.dense td{padding:5px 8px;font-size:12.5px} table.dense td small{color:var(--muted)}
.dot{display:inline-block;width:9px;height:9px;border-radius:2px;margin-inline-end:6px}
.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:16px}
.cc-chart{margin:0;min-width:0} .cc-legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--muted);margin-top:4px}
.cc-key{display:inline-flex;align-items:center;gap:6px} .cc-swatch{display:inline-block;width:16px;height:3px;border-radius:2px;background:var(--c)}
.cc-swatch.dashed{background:repeating-linear-gradient(90deg,var(--c) 0 5px,transparent 5px 9px)}
.cc-minis{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 18px} .cc-legend[hidden]{display:none}
@media (max-width:640px){.cc-minis{grid-template-columns:minmax(0,1fr)}}
.cc-mini h4{display:flex;align-items:center;gap:7px;margin:4px 0 2px;font-size:12.5px;font-weight:500;color:var(--muted)} .cc-mini .cc-swatch{width:10px;height:10px;border-radius:3px}
footer{color:var(--muted);font-size:12px;max-width:1000px;margin:0 auto;padding:0 20px 32px}
@media (max-width:600px){header{padding:20px 16px} header h1{font-size:20px} main{padding:16px 10px 32px} section{padding:16px 14px}}
@media print{:root{color-scheme:light;--bg:#fff;--card:#fff;--ink:#14171c;--muted:#5c636e;--line:#e2e5e9;--grid:#e2e5e9;--row:#eef0f3;--soft:#f4f6fb;--soft-line:#d5dcef;--gold:#2856c9;--accent:#2856c9}
  .theme{display:none} header,.bar,.live-dot{-webkit-print-color-adjust:exact;print-color-adjust:exact} section{break-inside:avoid-page;border:0;padding:0 0 12px}
  .appendix-title{break-before:page} .scroll{overflow:visible;border:0} table.dense{font-size:10px} td:not(.name):not(:first-child){white-space:normal}}
`;

/** The next-gen look, laid over STYLE: Daylight and Obsidian, a deep header lit by the accent, figures in a monospaced face. */
function nextgenStyle(accentName) {
  const [inkLight, inkDark, from, to] = NEXTGEN_ACCENTS[accentName] ?? NEXTGEN_ACCENTS.indigo;
  const dark = `color-scheme:dark;--bg:#06080f;--card:#0e1422;--ink:#e2e8f0;--muted:#94a3b8;--line:#1d2638;--grid:#1d2638;--row:#1a2335;--soft:color-mix(in srgb,${from} 10%,#0e1422);--soft-line:color-mix(in srgb,${from} 30%,#1d2638);--gold:${inkDark};--accent:${inkDark}`;
  return `
:root{--bg:#f3f5fb;--card:#fff;--ink:#0b1020;--muted:#5a6478;--line:#e2e6f0;--grid:#e2e6f0;--row:#eceff7;--soft:color-mix(in srgb,${from} 6%,#fff);--soft-line:color-mix(in srgb,${from} 22%,#e2e6f0);--gold:${inkLight};--accent:${inkLight};--head1:#0b1020;
  --ng-font:"Plus Jakarta Sans","MZ Jakarta",Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;--ng-mono:"JetBrains Mono","MZ Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root:not(:has(#theme-light:checked)){${dark}}}
:root:has(#theme-dark:checked){${dark}}
body{font-family:var(--ng-font);background-image:radial-gradient(600px 340px at 22% 0,color-mix(in srgb,${from} 9%,transparent),transparent 70%),radial-gradient(520px 420px at 105% 40%,color-mix(in srgb,${to} 7%,transparent),transparent 70%);background-attachment:fixed}
header{background-color:#0b1020;background-image:radial-gradient(520px 260px at 12% -40%,color-mix(in srgb,${from} 55%,transparent),transparent 70%),radial-gradient(520px 300px at 100% 0,color-mix(in srgb,${to} 38%,transparent),transparent 70%),linear-gradient(180deg,#0b1020,#0e1630);border-bottom:1px solid rgb(255 255 255 / .06)}
header h1{font-weight:700;letter-spacing:-.02em} h2{font-weight:700;letter-spacing:-.01em}
.theme{border-radius:10px} .theme label{border-radius:7px}
section{border-radius:16px;position:relative;overflow:hidden}
section.answer::before{content:"";position:absolute;inset:0 0 auto;height:2px;background:linear-gradient(90deg,${from},${to})}
.card,.scroll{border-radius:12px}
.answer .big,.figure,.keys b,.sevs b,table.calc,ol.calc-how,.scroll table{font-family:var(--ng-mono)}
.answer .big{font-weight:600;letter-spacing:-.03em}
th{font-family:var(--ng-mono);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;font-weight:600} table.dense th{font-size:10px}
@media print{:root{color-scheme:light;--bg:#fff;--card:#fff;--ink:#0b1020;--muted:#5a6478;--line:#e2e6f0;--grid:#e2e6f0;--row:#eceff7;--gold:${inkLight};--accent:${inkLight}} body{background:#fff}}
`;
}

/**
 * The report's HTML. `data` is what generating it saved: see page.js reportData().
 * `options`: `t` the page's translator, `lang` its language and `dir` its direction ("rtl" for Arabic and Hebrew),
 * `look` how it looks: `{ui: 'nextgen'|'classic', theme: 'auto'|'light'|'dark', accent}`, the app's own when made from it.
 */
export function buildReport(data, { t, lang = 'en', dir = 'ltr', look } = {}) {
  const { ui, theme, accent } = reportLook(look);
  const L = wording({ t, lang });
  const { w } = L;
  const customer = esc(data.customer || L.t('Customer'));
  // Reports made before the extra % and bundles were added carry no summary: work it out with none.
  const sum = creditSummary(data.tr?.totals?.credits ?? null, data.fusion?.totals?.credits ?? null, data.summary?.settings);
  const made = esc(new Date(data.generatedAt).toLocaleString(L.locale));
  return `<!doctype html>
<html lang="${esc(lang)}" dir="${dir === 'rtl' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${w('{0}: Checkmarx credits projection', customer)}</title>
<style>${STYLE}${ui === 'nextgen' ? nextgenStyle(accent) : ''}</style></head>
<body>
<header>
  <div class="top">
    <div>
      <div class="eyebrow">${data.organisation ? esc(data.organisation) : w('Checkmarx credits projection')}</div>
      <h1>${w('{0}: credits projection', customer)}</h1>
      <div class="meta">${data.preparedBy ? w('Made {0} by {1}', made, esc(data.preparedBy)) : w('Made {0}', made)}</div>
    </div>
    <fieldset class="theme"><legend>${w('Theme')}</legend>
      <input type="radio" name="theme" id="theme-auto"${theme === 'auto' ? ' checked' : ''}><label for="theme-auto">${w('Auto')}</label>
      <input type="radio" name="theme" id="theme-light"${theme === 'light' ? ' checked' : ''}><label for="theme-light">${w('Light')}</label>
      <input type="radio" name="theme" id="theme-dark"${theme === 'dark' ? ' checked' : ''}><label for="theme-dark">${w('Dark')}</label>
    </fieldset>
  </div>
</header>
<main>
${answer(data, sum, L)}
${provenance(data, L)}
${story(data, L)}
${assumptions(data, sum, L)}
${data.tr || data.fusion ? `<p class="appendix-title">${w('Appendix: every figure')}</p>` : ''}
${data.tr ? trAppendix(data.tr, L) : ''}
${data.fusion ? fusionAppendix(data.fusion, L) : ''}
${calculations(data, L)}
</main>
<footer>${w("An estimate made with CxMissionZero's Cx Credits Calculator from Checkmarx One data and the assumptions above. Credit rates and the credits actually used are set by Checkmarx and your agreement with them.")}${data.tr?.history?.length ? ` ${w('Backlog history: {0} to {1}.', esc(monthLabel(data.tr.history[0].month)), esc(monthLabel(data.tr.history[data.tr.history.length - 1].month)))}` : ''}</footer>
</body></html>`;
}
