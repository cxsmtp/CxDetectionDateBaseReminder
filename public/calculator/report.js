// Cx Credits Calculator: the projection report, one self-contained HTML file (nothing loaded from
// anywhere), from the data a generated report keeps. Prints to PDF from the browser. Made with its
// levers (`live`), it carries its figures and one script (report-live.js and what it imports, allowed
// by its hash alone) so the customer can try other numbers in the file, with no connection anywhere.
// Every name and figure is escaped: the data may hold what a customer's exports or projects said.
// It is written in the language the page is in (`t`, the page's translator), and has a light and
// a dark theme the reader switches between with CSS alone (Auto follows their system).
//
// It says the answer first (the credits, the bundles, over how long), then that it comes from live
// Checkmarx One data, then how the number was reached, the assumptions, and last every figure.

import { describeEngines } from '../engines.js';
import { NEXTGEN_ACCENTS, lookPalette, reportLook } from '../look.js';
import { FREQUENCIES, SEVERITIES, cleanScope, creditSummary, fusionTotal } from './model.js';
import { allSections, moneyText, sectionHtml } from './explain.js';
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
    toTriage: v('toTriage', v('selected')),
    truePositives: v('truePositives'),
    triageCredits: v('triageCredits'),
    remediationCredits: v('remediationCredits'),
    credits: v('credits'),
    backlogCredits: v('backlogCredits', v('credits')),
    aheadCredits: v('aheadCredits'),
  };
}

/** The open vulnerabilities the plan takes, and those it leaves, per severity: "Included: Critical 17,449 · High 92,786" (none: ''). */
export function scopeLines(tr, L) {
  const { w, num } = L;
  const part = (n) => SEVERITIES.map((s) => [s, n(tr.rows?.[s] ?? {})]).filter(([, x]) => x > 0).map(([s, x]) => `${w(s)} ${num(x)}`).join(' · ');
  const included = part((r) => r.selected ?? 0);
  const excluded = part((r) => (r.backlog ?? 0) - (r.selected ?? 0));
  return [included && w('Included: {0}', included), excluded && w('Excluded: {0}', excluded)].filter(Boolean);
}

/** The false positives the plan takes (triaged, never remediated): one % for every severity counted, or each its own. */
export function falsePositiveLine(tr, L) {
  const { w, num } = L;
  const counted = SEVERITIES.filter((s) => (tr.rows?.[s]?.selected ?? 0) + (tr.rows?.[s]?.future ?? 0) > 0);
  const fps = [...new Set(counted.map((s) => tr.rows[s].fp))];
  if (!fps.length) return '';
  return fps.length === 1
    ? w('{0}% taken as false positives: triaged, not remediated.', num(fps[0]))
    : w('Taken as false positives, triaged and not remediated: {0}.', counted.map((s) => `${w(s)} ${num(tr.rows[s].fp)}%`).join(', '));
}

/** The one line that says which projects were counted, when the customer narrowed them. */
function scopeLine(source, L) {
  const { w } = L;
  if (!source?.scoped) return '';
  const sc = cleanScope(source.scope);
  const parts = [
    sc.applications.length && `${w('Applications')}: ${esc(sc.applications.join(', '))}`,
    sc.projects.length && (source.details === false ? `${w('Projects')}: ${w('{0} picked one by one', L.num(sc.projects.length))}` : `${w('Projects')}: ${esc((source.projectNames ?? sc.projects).slice(0, 20).join(', '))}${sc.projects.length > 20 ? ` ${esc(w('and {0} more', L.num(sc.projects.length - 20)))}` : ''}`),
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
    data.fusion && { key: 'fusion', label: data.fusionNew ? w('Fusion — existing customer') : w('Fusion scans'), value: data.fusion.totals.credits ?? 0, colour: '#0d9488' },
    data.fusionNew && { key: 'fusion-new', label: w('Fusion — new customer'), value: data.fusionNew.totals.credits ?? 0, colour: '#b7791f' },
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
    out.noOrigin > 0 && w('Left out: {0} projects with no scan from those scan origins.', num(out.noOrigin)),
  ].filter(Boolean).map((t) => `<p class="sub">${t}</p>`).join('');
  // At the end, closed: what the data is and how it was read, for whoever wants it.
  return `<details class="live"><summary><span class="live-dot" aria-hidden="true"></span>${w('Data source')}</summary><div><p>${line}</p>${tr?.lookbackMonths ? `<p class="sub">${w('The trend is measured over the last {0} months of that data, week by week, and carried forward.', num(tr.lookbackMonths))}</p>` : ''}${engines}${branches}${leftOut}${scopeLine(src, L)}</div></details>`;
}

/** How the number was reached: today, what is ahead, and Fusion. */
function story(data, L) {
  const { w, num, pct } = L;
  const cards = [];
  const tr = data.tr;
  if (tr) {
    const f = trFigures(tr);
    const months = tr.months ?? data.months ?? 12;
    cards.push(`<div class="card">
      <h3>${w('Today')}</h3>
      <p class="figure">${num(f.selected)} <span>${w('open vulnerabilities in scope')}</span></p>
      ${scopeLines(tr, L).map((x) => `<p class="sub">${x}</p>`).join('')}
    </div>`);
    cards.push(`<div class="card">
      <h3>${w('The next {0} months', num(months))}</h3>
      <table class="calc">
        <tr><td>${w('Backlog to triage')}</td><td>${num(f.selected)}</td></tr>
        ${tr.ahead?.includeFuture === false ? '' : `<tr><td>${tr.ahead?.aiDeclinePercent ? w('Still to come, {0}% fewer over a year with AI', num(tr.ahead.aiDeclinePercent)) : w('Still to come, at the current pace')}</td><td>+${num(f.future)}</td></tr>`}
        ${tr.fusion ? `<tr><td>${tr.sastOnly ? w('More found by Fusion ({0}% of SAST)', num(tr.ahead?.fusionUpliftPercent ?? 0)) : w('More found by Fusion ({0}%)', num(tr.ahead?.fusionUpliftPercent ?? 0))}</td><td>+${num(f.fusionExtra)}</td></tr>` : ''}
        <tr class="sum"><td>${w('To triage')}</td><td>${num(f.toTriage)}</td></tr>
        <tr><td>${w('To remediate (true positives)')}</td><td>${num(f.truePositives)}</td></tr>
        <tr class="sum gold"><td>${w('Triage & remediation credits')}</td><td>${num(f.credits, 1)}</td></tr>
      </table>
      ${falsePositiveLine(tr, L) ? `<p class="sub">${falsePositiveLine(tr, L)}</p>` : ''}
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
  if (data.fusionNew) {
    const t = data.fusionNew.totals;
    cards.push(`<div class="card">
      <h3>${w('Fusion — new customer')}</h3>
      <table class="calc">
        <tr><td>${w('Projects')}</td><td>${num(t.projects)}</td></tr>
        <tr><td>${w('Code lines (no blank or comment lines)')}</td><td>${num(t.lines)}</td></tr>
        <tr><td>${w('10K LOC units')}</td><td>${num(t.units)}</td></tr>
        <tr><td>${w('Fusion scans over {0} months', num(data.fusionNew.periodMonths))}</td><td>${num(t.scans)}</td></tr>
        ${t.withActivity ? `<tr><td>${w('Developers in the last 90 days (added up per project)')}</td><td>${num(t.developers)}</td></tr>` : ''}
        <tr class="sum gold"><td>${w('Fusion credits')}</td><td>${num(t.credits, 1)}</td></tr>
      </table>
      ${fusionNewScansNote(data.fusionNew, L)}
      ${t.unknownRate ? `<p class="sub warn">${w('{0} projects without a model rate are not counted', num(t.unknownRate))}</p>` : ''}
    </div>`);
  }
  if (!cards.length) return '';
  const ask = data.fusion || data.fusionNew ? '' : `<p class="sub">${w('Checkmarx Fusion is not in this projection: please ask your Checkmarx team to help with a Fusion forecast, if required.')}</p>`;
  const chart = tr?.forecast?.length ? `<h3 class="chart-title">${w('Backlog trend and forecast')}</h3><p class="sub">${tr.monthlyChange >= 0 ? w('The backlog grew by {0} a month on average recently.', num(tr.monthlyChange)) : w('The backlog shrank by {0} a month on average recently.', num(-tr.monthlyChange))}</p>${forecastChart(tr.forecast, palette(L.t))}` : '';
  return `<section><h2>${w('How we got there')}</h2><div class="cards">${cards.join('')}</div>${chart}${ask}</section>`;
}

/** What the credits give back (model.js trImpact, fusionImpact, overallImpact, worked out when the report was made). */
function impactSection(data, L) {
  const m = data.impact?.tr;
  const f = data.impact?.fusion;
  const o = data.impact?.overall;
  if (!m && !f) return '';
  const { w, num } = L;
  const cur = (m ?? f).settings.currency;
  const cash = (n) => esc(moneyText(n, cur, L.locale));
  const tile = (label, value, sub, cls = '') => `<div class="card impact-tile ${cls}"><h3>${label}</h3><p class="figure">${value}</p><p class="sub">${sub}</p></div>`;
  const overall = o && o.value !== null ? `<div class="cards">${[
    tile(w('All the credits give back'), cash(o.value), w('Triage & remediation and Fusion, over {0} months', num(o.months)), 'gold'),
    tile(w('What the credits cost'), cash(o.cost), o.cost === null ? w('Enter what a credit costs') : w('Every credit in this projection')),
    tile(w('Return'), o.roi === null ? '—' : `${num(o.roi * 100)}%`, o.net === null ? w('Once the hour and the credit have a price') : `${w('{0} net', cash(o.net))}${o.paybackMonths !== null ? ` · ${w('paid back in {0} months', num(o.paybackMonths, 1))}` : ''}`),
  ].join('')}</div>` : '';
  let trHtml = '';
  if (m) {
    const tiles = [
      tile(w('Hours given back'), num(m.hours), w('About {0} developer-years over {1} months', num(m.developerYears, 1), num(m.months)), 'gold'),
      tile(w('Value of that time'), cash(m.value), m.value === null ? w('Enter what a developer\'s hour costs') : w('{0} hours × {1}', num(m.hours), cash(m.settings.hourlyRate))),
      tile(w('What the credits cost'), cash(m.cost), m.cost === null ? w('Enter what a credit costs') : w('{0} credits', num(m.credits, 1))),
      tile(w('Return'), m.roi === null ? '—' : `${num(m.roi * 100)}%`, m.net === null ? w('Once the hour and the credit have a price') : `${w('{0} net', cash(m.net))}${m.paybackMonths !== null ? ` · ${w('paid back in {0} months', num(m.paybackMonths, 1))}` : ''}`),
      tile(w('False positives cleared'), num(m.cleared), w('Never reach a developer')),
    ];
    const rows = (m.bySeverity ?? []).filter((r) => r.triaged || r.fixes)
      .map((r) => `<tr><td>${w(r.severity)}</td><td>${num(r.triaged)}</td><td>${num(r.cleared)}</td><td>${num(r.fixes)}</td><td>${num(r.hours)}</td></tr>`).join('');
    trHtml = `<h3 class="impact-part">${w('Triage & remediation')}</h3>
  <p class="sub">${w('Every finding AI Triage looks at is one a person does not triage by hand; every false positive it clears never reaches a developer; every true positive AI Remediation fixes saves the fix by hand, less the time to review it.')}</p>
  <div class="cards">${tiles.join('')}</div>
  ${rows ? table(`<thead><tr><th>${w('Severity')}</th><th>${w('Triaged by AI')}</th><th>${w('False positives cleared')}</th><th>${w('Fixed by AI')}</th><th>${w('Hours saved')}</th></tr></thead><tbody>${rows}<tr class="strong"><td>${w('Total')}</td><td>${num(m.triaged)}</td><td>${num(m.cleared)}</td><td>${num(m.fixes)}</td><td>${num(m.hours)}</td></tr></tbody>`) : ''}
  <p class="sub">${w('Assumed: {0} minutes to triage a finding by hand, {1} to fix one, {2} to review an AI fix.', num(m.settings.triageMinutes), num(m.settings.fixMinutes), num(m.settings.reviewMinutes))}</p>`;
  }
  let fuHtml = '';
  if (f) {
    const tiles = [
      tile(w('Expert review replaced'), `${num(f.expertHours)} ${w('hours')}`, f.expertValue === null ? w('{0} lines read at {1} an hour', num(f.linesRead), num(f.settings.linesPerHour)) : w('Worth {0}', cash(f.expertValue)), 'gold'),
      tile(w('Every line read'), w('{0} times', num(f.timesRead, 1)), w('{0} lines in {1} projects, over {2} months', num(f.linesOnce), num(f.projects), num(f.months))),
      tile(w('Cost per 10K lines read'), f.costPer10k === null ? '—' : cash(f.costPer10k), f.expertPer10k === null ? w('Enter what a developer\'s hour costs') : w('An expert: {0}', cash(f.expertPer10k))),
      tile(w('Reviewers to keep pace'), num(f.reviewersNeeded, 1), w('Full-time, reading what Fusion reads')),
      tile(w('A team reading it once'), w('{0} weeks', num(f.teamWeeks, 1)), w('{0} reviewers, 40 hours a week', num(f.settings.reviewers))),
      f.extraTrue !== null ? tile(w('Found earlier, fixed cheaper'), f.earlyValue === null ? `${num(f.earlyHours)} ${w('hours')}` : cash(f.earlyValue), w('{0} more true positives fixed while coding, not after release', num(f.extraTrue))) : '',
      f.breachAvoided !== null ? tile(w('Breach cost avoided'), cash(f.breachAvoided), f.settings.countBreach ? w('{0} critical and high found earlier; counted in the return', num(f.extraCriticalHigh)) : w('{0} critical and high found earlier; an expected cost, not counted', num(f.extraCriticalHigh))) : '',
    ];
    fuHtml = `<h3 class="impact-part">${w('Checkmarx Fusion')}</h3>
  <p class="sub">${w('Fusion has frontier AI models read every line of each project on every Fusion scan: the review an expert would otherwise do by hand, and the findings it adds are fixed while the code is being written.')}</p>
  <div class="cards">${tiles.join('')}</div>
  <p class="sub">${w('Assumed: an expert reviews {0} lines an hour; a team of {1}; a fix after release costs {2} times as much; {3}% of critical and high findings lead to a breach, which costs {4}.', num(f.settings.linesPerHour), num(f.settings.reviewers), num(f.settings.laterFixMultiplier, 1), num(f.settings.breachChancePercent, 2), cash(f.settings.breachCost))}</p>`;
  }
  return `<section class="impact"><h2>${w('What the credits give back')}</h2>
  ${overall}
  ${trHtml}
  ${fuHtml}
</section>`;
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
      else if (tr.ahead.aiDeclinePercent) items.push(w('New findings arrive at the pace of the last {0} months, falling by {1}% over a year as teams adopt AI.', num(tr.lookbackMonths), num(tr.ahead.aiDeclinePercent)));
      else items.push(w('New findings keep arriving at the pace of the last {0} months.', num(tr.lookbackMonths)));
      if (tr.fusion) items.push(tr.sastOnly ? w('Fusion reports {0}% more SAST findings than today.', num(tr.ahead.fusionUpliftPercent)) : w('Fusion reports {0}% more findings than today.', num(tr.ahead.fusionUpliftPercent)));
    }
  }
  // Not every scan origin: the scans counted (how often projects are scanned, and the backlog and its trend) are from these only.
  const origins = data.source?.origins;
  if (Array.isArray(origins)) {
    const named = esc(origins.join(', '));
    items.push(!origins.length ? w('Scans from: no scan origin.') : data.source.originsFusionOnly ? w('Scans from: {0} (for Fusion: the two exports count every scan).', named) : w('Scans from: {0}.', named));
  }
  if (data.fusion || data.fusionNew) items.push(w("Each project's lines of code are rounded up to whole 10K units on their own; one scan costs its model's credits per 10K LOC."));
  if (data.fusionNew?.leftOut?.length) items.push(w('New customer: code lines without blank and comment lines (counted from git with cloc-fusion\'s engine, read from a cloc-fusion report, or counted with cloc); not counted: {0}.', data.fusionNew.leftOut.map(esc).join(', ')));
  if (data.fusionNew?.totals?.byRule) items.push(w('New customer: a project whose change frequency is known (commits on its default branch in the last year) gets the Fusion scans of that frequency, as a Checkmarx One project scanned that often does on the Fusion tab.'));
  if (sum.settings.extraPercent) items.push(w('{0}% extra credits on top.', num(sum.settings.extraPercent, 2)));
  items.push(w('Bundles of {0} credits, rounded up to whole bundles.', num(sum.settings.bundleCredits)));
  return items;
}

/** How every number is calculated, with the figures in: closed until the reader opens it. */
function calculations(data, L) {
  // Findings still to come not counted: no section for them (the page's ? still says so).
  const sections = allSections(data, L).filter((x) => x.key !== 'future' || data.tr?.ahead?.includeFuture !== false);
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
  // A month's share of today's backlog, as a %.
  const rate = (share) => (Number.isFinite(share) ? `${num(share, 1)}%` : '—');
  // True positives: what is left once the false positives are taken out, one % for every severity counted or each its own.
  const fpOf = [...new Set(rows.filter((r) => (r.toTriage ?? r.selected) > 0).map((r) => r.fp))];
  const oneFp = fpOf.length === 1 ? fpOf[0] : null;
  const tpLabel = oneFp !== null ? w('True positives, after {0}% false positives', num(oneFp)) : w('True positives, after each severity\'s false positives');
  return `<section class="appendix">
  <h2>${w('Triage & remediation')}</h2>
  <p class="sub">${w('Backlog as of {0}, against {1}.', esc(date(tr.asOf)), esc(date(tr.previousDate)))}</p>
  ${table(`
    <thead><tr><th>${w('By severity')}</th>${SEVERITIES.map((s) => `<th><i class="dot" style="background:${SEVERITY_COLOURS[s]}"></i>${w(s)}</th>`).join('')}<th>${w('Total')}</th></tr></thead>
    <tbody>
      <tr><td>${w('Current backlog')}</td>${cell((r) => num(r.backlog))}<td>${num(f.backlog)}</td></tr>
      ${tr.recent ? `<tr><td title="${w('New vulnerabilities reported a month, as a share of the backlog, averaged over the last {0} months', num(tr.recent.months))}">${w('Debt rate ({0}-month average)', num(tr.recent.months))}</td>${SEVERITIES.map((s) => `<td>${rate(tr.recent[s]?.addedPct)}</td>`).join('')}<td>${rate(tr.recent.total?.addedPct)}</td></tr>
      <tr><td title="${w('Vulnerabilities fixed a month, as a share of the backlog, averaged over the last {0} months', num(tr.recent.months))}">${w('Fixing rate ({0}-month average)', num(tr.recent.months))}</td>${SEVERITIES.map((s) => `<td>${rate(tr.recent[s]?.fixedPct)}</td>`).join('')}<td>${rate(tr.recent.total?.fixedPct)}</td></tr>` : ''}
      ${hasDebtFix || tr.recent ? '' : `<tr class="muted"><td>${w('Debt increase')}</td>${SEVERITIES.map((s) => `<td>${pct(an(s).debtRate)}</td>`).join('')}<td>${pct(tr.analysis?.total?.debtRate)}</td></tr>
      <tr class="muted"><td>${w('Fix rate')}</td>${SEVERITIES.map((s) => `<td>${pct(an(s).fixRate)}</td>`).join('')}<td>${pct(tr.analysis?.total?.fixRate)}</td></tr>`}
      ${hasAhead ? `<tr class="strong"><td>${w('To triage')}</td>${cell((r) => num(r.toTriage))}<td>${num(f.toTriage)}</td></tr>` : ''}
      <tr><td>${tpLabel}</td>${cell((r) => `${num(r.truePositives)}${oneFp === null && r.toTriage > 0 ? `<small class="fp">${w('{0}% false positives', num(r.fp))}</small>` : ''}`)}<td>${num(f.truePositives)}</td></tr>
      <tr><td>${w('Triage credits')}</td>${cell((r) => num(r.triageCredits, 1))}<td>${num(f.triageCredits, 1)}</td></tr>
      <tr><td>${w('Remediation credits')}</td>${cell((r) => num(r.remediationCredits, 1))}<td>${num(f.remediationCredits, 1)}</td></tr>
      <tr class="gold"><td>${w('Credits')}</td>${cell((r) => num(r.credits, 1))}<td>${num(f.credits, 1)}</td></tr>
    </tbody>`)}
  ${tr.weekly?.length ? `<h3>${w('The last {0} months, week by week', num(months))}</h3>${hasWeeklyDebt ? debtFixChart(tr.weekly, P) : `<div class="pair">${backlogTrendChart(tr.weekly, P)}${ratesChart(tr.weekly, P)}</div>`}` : ''}
  ${tr.bySeverity ? `<h3>${w('By severity')}</h3>${severityCharts(tr.bySeverity, P)}` : tr.severityForecast?.length ? `<h3>${w('By severity')}</h3>${severityChart(tr.severityForecast, P)}` : ''}
</section>`;
}

/** Appendix: every Fusion figure. */
function fusionAppendix(f, L, edit = false) {
  const { w, num, frequency } = L;
  const models = new Map(f.models.map((m) => [m.id, m]));
  const modelName = (id) => esc(models.get(id)?.name || '—');
  // With the levers, every box below can be changed and the whole report follows.
  const box = (key, value, label, placeholder = '') => `<input class="lv-num" type="number" min="0" step="any" inputmode="decimal" data-lever="${esc(key)}" value="${value ?? ''}"${placeholder !== '' ? ` placeholder="${esc(placeholder)}"` : ''} aria-label="${label}">`;
  const pick = (key, chosen, label) => `<select class="lv-pick" data-lever="${esc(key)}" aria-label="${label}">${f.models.map((m) => `<option value="${esc(m.id)}"${m.id === chosen ? ' selected' : ''}>${esc(m.name || '—')}</option>`).join('')}</select>`;
  const scansCell = (b) => (edit ? box(`fscans.${b.id}`, f.rules[b.id]?.scans, w('Fusion scans per project'), f.defaultScans) : f.rules[b.id]?.scans ?? w('{0} (default)', num(f.defaultScans)));
  const rows = (f.rows ?? []).filter((r) => r.included);
  const fast = f.byFrequency.find((b) => b.id === 'more-5-week');
  const left = f.details === false
    ? `<p class="lv-note">${w('Project names and details were left out of this report.')} ${fast?.projects ? w('{0} projects are scanned more than 5 times a week, with {1} Fusion scans each chosen for them.', num(fast.projects), num(f.rules['more-5-week']?.scans ?? f.defaultScans)) : ''} ${w('{0} projects in all, {1} Fusion scans, {2} models to choose from.', num(f.totals.projects), num(f.totals.scans), num(f.models.length))}</p>`
    : '';
  return `<section class="appendix" id="fusion">
  <h2>${w('Checkmarx Fusion')}</h2>
  <p class="sub">${w('Fusion scans over {0} months.', num(f.periodMonths))} ${w('Projects scanned most often come first.')}${edit ? ` <b>${w('Every box can be changed: the whole report follows.')}</b>` : ''}</p>
  ${left}
  <h3>${w('Models')}</h3>
  ${table(`<thead><tr><th>${w('Model')}</th><th>${w('Credits per 10K LOC')}</th><th>${w('Projects')}</th><th>${w('10K units × scans')}</th><th>${w('Credits')}</th></tr></thead><tbody>
    ${f.byModel.map((m) => `<tr><td class="name">${esc(m.name || '—')}</td><td>${edit ? box(`rate.${m.id}`, m.rate, w('Credits per 10K LOC for {0}', esc(m.name || '—')), L.t('Not set')) : m.rate === null ? '—' : num(m.rate, 2)}</td><td>${num(m.projects)}</td><td>${num(m.unitScans)}</td><td>${num(m.credits, 1)}</td></tr>`).join('') || `<tr><td colspan="5">${w('No model set.')}</td></tr>`}
  </tbody>`)}
  <h3>${w('By scan frequency')}</h3>
  ${table(`<thead><tr><th>${w('Scanned today')}</th><th>${w('Projects')}</th><th>${w('Fusion scans per project')}</th><th>${w('Model')}</th><th>${w('10K units')}</th><th>${w('Credits')}</th></tr></thead><tbody>
    ${f.byFrequency.filter((b) => b.projects).map((b) => `<tr><td>${frequency(b.id)}</td><td>${num(b.projects)}</td><td>${scansCell(b)}</td><td class="name">${edit && f.models.length ? pick(`fmodel.${b.id}`, f.rules[b.id]?.model ?? f.defaultModel, w('Model')) : modelName(f.rules[b.id]?.model ?? f.defaultModel)}</td><td>${num(b.units)}</td><td>${num(b.credits, 1)}</td></tr>`).join('')}
  </tbody>`)}
  ${rows.length ? `<h3>${w('Projects')}</h3>
  ${table(`<thead><tr><th>${w('Project')}</th><th>${w('Criticality')}</th><th>${w('Scanned today')}</th><th>${w('Lines of code')}</th><th>${w('10K units')}</th><th>${w('Fusion scans')}</th><th>${w('Set by')}</th><th>${w('Model')}</th><th>${w('Credits')}</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td class="name">${esc(r.name)}</td><td>${r.criticality ?? '—'}</td><td class="wrap">${frequency(r.frequency)}${r.scansPerWeek ? ` <small>${w('({0}/week)', num(r.scansPerWeek, 1))}</small>` : ''}</td><td>${num(r.lines)}</td><td>${num(r.units)}</td><td>${edit && Number.isInteger(r.key) ? box(`pscans.${r.key}`, r.scans, w('Fusion scans for {0}', esc(r.name))) : num(r.scans)}</td><td>${FROM[r.scansFrom] ? w(FROM[r.scansFrom]) : ''}</td><td class="name">${edit && Number.isInteger(r.key) && f.models.length ? pick(`pmodel.${r.key}`, r.model, w('Model for {0}', esc(r.name))) : modelName(r.model)}</td><td>${r.credits === null || !r.units ? '—' : num(r.credits, 1)}</td></tr>`).join('')}
  </tbody>`, 'dense')}` : ''}
</section>`;
}

// Where a new customer's project's Fusion scans came from.
const FROM_NEW = { default: 'Default', frequency: 'Change frequency', criticality: 'Criticality', project: 'Set for the project' };

/** One line under the new customer's card: how many projects' scans follow how often they change, and the default for the rest. */
function fusionNewScansNote(f, L) {
  const { w, num } = L;
  const t = f.totals ?? {};
  if (!t.byRule && !t.byProject) return `<p class="sub">${w('Fusion scans: {0} a project (how often each one changes is not known).', num(f.defaultScans))}</p>`;
  return `<p class="sub">${w('Fusion scans: {0} projects by how often they change (commits on the default branch, as on the Fusion tab), {1} at the default of {2}, {3} set for the project.', num(t.byRule ?? 0), num(t.byDefault ?? 0), num(f.defaultScans), num(t.byProject ?? 0))}</p>`;
}

/** Appendix: every figure of Fusion for the new customer (counted from git, from a cloc-fusion report, or with cloc). */
function fusionNewAppendix(f, L) {
  const { w, num, frequency } = L;
  const models = new Map(f.models.map((m) => [m.id, m]));
  const modelName = (id) => esc(models.get(id)?.name || '—');
  const activity = f.rows.some((r) => r.frequency);
  const freqCell = (r) => (r.frequency ? `${frequency(r.frequency)}${r.commits !== null && r.commits !== undefined ? ` <small>${w('({0} commits in {1} days)', num(r.commits), num(r.windowDays ?? 365))}</small>` : ''}` : '—');
  return `<section class="appendix">
  <h2>${w('Fusion — new customer')}</h2>
  <p class="sub">${w('Fusion scans over {0} months.', num(f.periodMonths))} ${w('Code lines without blank and comment lines: counted from git with cloc-fusion\'s engine, read from a cloc-fusion report, or counted with cloc.')}</p>
  ${fusionNewScansNote(f, L)}
  ${f.details === false ? `<p class="lv-note">${w('Project names and details were left out of this report.')} ${w('{0} projects in all, {1} lines of code, {2} Fusion scans.', num(f.totals.projects), num(f.totals.lines), num(f.totals.scans))}</p>` : table(`<thead><tr><th>${w('Project')}</th><th>${w('Languages')}</th><th>${w('Lines of code')}</th>${activity ? `<th>${w('Change frequency')}</th><th>${w('Developers (90 days)')}</th>` : ''}<th>${w('10K units')}</th><th>${w('Fusion scans')}</th><th>${w('Set by')}</th><th>${w('Model')}</th><th>${w('Credits')}</th></tr></thead><tbody>
    ${f.rows.filter((r) => r.included).map((r) => `<tr><td class="name">${esc(r.name)}</td><td class="wrap">${(r.languages ?? []).map((l) => `${esc(l.name)} ${num(l.lines)}`).join(', ') || '—'}</td><td>${num(r.lines)}</td>${activity ? `<td class="wrap">${freqCell(r)}</td><td>${r.devs90 === null || r.devs90 === undefined ? '—' : num(r.devs90)}</td>` : ''}<td>${num(r.units)}</td><td>${num(r.scans)}</td><td>${FROM_NEW[r.scansFrom] ? w(FROM_NEW[r.scansFrom]) : ''}</td><td class="name">${modelName(r.model)}</td><td>${r.credits === null || !r.units ? '—' : num(r.credits, 1)}</td></tr>`).join('')}
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
.live{margin:18px 0 0;border:1px solid var(--soft-line);border-radius:10px;padding:10px 16px;font-size:13px;color:var(--muted)}
.live summary{cursor:pointer;display:flex;align-items:center;gap:10px;font-weight:600;color:var(--ink)}
.live[open] summary{margin-bottom:8px} .live p{margin:0} .live .sub{margin-top:4px}
.live-dot{flex:none;width:8px;height:8px;border-radius:50%;background:#16a34a;box-shadow:0 0 0 3px rgb(22 163 74 / .18)}
.scope{margin:6px 0 0;font-size:13px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(270px,100%),1fr));gap:12px}
.card{border:1px solid var(--line);border-radius:8px;padding:14px 16px;min-width:0}
.card h3{margin:0 0 8px}
.figure{margin:0 0 6px;font-size:26px;font-weight:600;font-variant-numeric:tabular-nums} .figure span{font-size:13px;color:var(--muted);font-weight:400}
.impact .cards{grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr))} .impact-tile h3{font-size:13px;color:var(--muted);font-weight:500} .impact-tile.gold .figure{color:var(--gold)} .impact .figure{overflow-wrap:anywhere} .impact-part{margin:22px 0 4px;font-size:16px} .impact>.cards+.cards{margin-top:12px}
.sevs{list-style:none;margin:0 0 8px;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:2px 12px;font-size:13px}
.sevs li{display:flex;align-items:center;gap:6px} .sevs i{width:8px;height:8px;border-radius:2px;display:inline-block} .sevs b{margin-inline-start:auto;font-variant-numeric:tabular-nums;font-weight:500}
table.calc{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
table.calc td{padding:4px 0;border:0;text-align:start} table.calc td:last-child{text-align:end;white-space:nowrap;padding-inline-start:12px}
table.calc tr.sum td{border-top:1px solid var(--line);padding-top:7px;font-weight:600} table.calc tr.gold td{color:var(--gold)} table.calc td small.sel{display:block;color:var(--muted);font-size:12px;font-weight:400;margin-top:2px} td small.fp{display:block;color:var(--muted);font-size:11px}
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
.levers{border-color:var(--soft-line);background:var(--soft)}
.lv-head{display:flex;flex-wrap:wrap;gap:12px 24px;justify-content:space-between;align-items:flex-start}
.lv-head>div:first-child{flex:1 1 320px;max-width:62ch} .levers h2{margin:0 0 4px}
.lv-total{display:grid;justify-items:end;gap:2px;text-align:end;font-size:13px;color:var(--muted)}
.lv-eyebrow{font-size:12px} .lv-total b{font-size:32px;line-height:1.1;color:var(--accent);font-variant-numeric:tabular-nums}
.lv-acts{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:8px}
.lv-acts button{font:inherit;font-size:13px;padding:6px 12px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}
.lv-acts button:disabled{opacity:.5;cursor:default} .lv-acts .lv-primary{background:var(--accent);border-color:transparent;color:#fff}
:root:has(#theme-dark:checked) .lv-acts .lv-primary{color:#0d0f12}
@media (prefers-color-scheme:dark){:root:not(:has(#theme-light:checked)) .lv-acts .lv-primary{color:#0d0f12}}
.lv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(280px,100%),1fr));gap:12px;margin-top:14px}
.lv-card{border:1px solid var(--line);border-radius:8px;padding:10px 14px 12px;margin:0;background:var(--card);min-width:0} .lv-card legend{font-weight:600;padding:0 6px} .lv-wide{grid-column:1/-1}
.lv-card p{margin:6px 0 0}
.lv-scroll{overflow-x:auto} table.lv-sev{width:100%;border-collapse:collapse;font-size:13px}
.lv-sev th,.lv-sev td{padding:6px;text-align:start;border-bottom:1px solid var(--row);vertical-align:middle} .lv-sev thead th{font-size:12px;color:var(--muted);font-weight:500} .lv-sev tbody tr:last-child>*{border-bottom:0}
.lv-sev th[scope=row]{white-space:nowrap;font-weight:600}
.lv-slide{display:inline-flex;align-items:center;gap:8px;min-width:0} .lv-slide input{width:150px;max-width:100%;accent-color:var(--accent)}
.lv-slide output{min-width:9ch;font-variant-numeric:tabular-nums;white-space:nowrap}
.lv-num{width:84px;font:inherit;font-size:13px;padding:4px 6px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink);text-align:end}
.lv-pick{font:inherit;font-size:13px;padding:3px 4px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink);max-width:16ch}
.lv-row{display:flex;flex-wrap:wrap;gap:8px 22px;align-items:center;margin-top:10px;font-size:13px} .lv-row label{display:inline-flex;flex-wrap:wrap;align-items:center;gap:8px}
.lv-check input{accent-color:var(--accent)}
.lv-field{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 10px;margin:8px 0 0;font-size:13px}
.lv-field select{font:inherit;font-size:13px;padding:3px 4px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink)}
.lv-note{margin:0 0 8px;padding:10px 12px;border-radius:8px;background:var(--soft);border:1px solid var(--soft-line);font-size:13px}
.lv-on .scroll .lv-num{width:76px}
.lv-pill{position:fixed;inset-inline-end:16px;bottom:16px;margin:0;padding:8px 14px;border-radius:999px;background:var(--head1);color:#fff;font-size:13px;box-shadow:0 6px 20px rgb(0 0 0 / .18);z-index:5} .lv-pill span{opacity:.75}
.lv-panel-seen .lv-pill{display:none} .lv-pdf-opt{margin-top:6px;font-size:12.5px}
@media (max-width:600px){.lv-total{justify-items:start;text-align:start} .lv-acts{justify-content:flex-start} .lv-sev thead{display:none} .lv-sev tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 10px;padding:8px 0;border-bottom:1px solid var(--row)} .lv-sev tr>*{border:0;padding:0} .lv-sev th[scope=row]{grid-column:1/-1}
  .lv-sev td::before{content:attr(data-label);display:block;font-size:11px;color:var(--muted)} .lv-sev td:nth-child(2),.lv-sev td:nth-child(3){grid-column:1/-1} .lv-slide{display:flex} .lv-slide input{flex:1;width:auto}}
@media print{.levers,.lv-pill{display:none} .lv-num,.lv-pick{border:0;padding:0;background:none;appearance:none;-webkit-appearance:none;width:auto}}
@media (max-width:600px){header{padding:20px 16px} header h1{font-size:20px} main{padding:16px 10px 32px} section{padding:16px 14px}}
@media print{:root{color-scheme:light;--bg:#fff;--card:#fff;--ink:#14171c;--muted:#5c636e;--line:#e2e5e9;--grid:#e2e5e9;--row:#eef0f3;--soft:#f4f6fb;--soft-line:#d5dcef;--gold:#2856c9;--accent:#2856c9}
  .theme{display:none} header,.bar,.live-dot{-webkit-print-color-adjust:exact;print-color-adjust:exact} section{break-inside:avoid-page;border:0;padding:0 0 12px}
  .appendix-title{break-before:page} .scroll{overflow:visible;border:0} table.dense{font-size:10px} td:not(.name):not(:first-child){white-space:normal}}
`;

/**
 * The command-center look, laid over STYLE: warm paper or night ink, the console's ink behind the header,
 * headings and figures in a serif (Fraunces where the reader has it, else Palatino or Georgia), no gradients.
 */
function nextgenStyle(accentName) {
  const [inkLight, inkDark, from] = NEXTGEN_ACCENTS[accentName] ?? NEXTGEN_ACCENTS.indigo;
  const dark = `color-scheme:dark;--bg:#131518;--card:#1a1d21;--ink:#ebe6dc;--muted:#a39d91;--line:#2a2e33;--grid:#2a2e33;--row:#22262b;--soft:color-mix(in srgb,${inkDark} 9%,#1a1d21);--soft-line:color-mix(in srgb,${inkDark} 28%,#2a2e33);--gold:${inkDark};--accent:${inkDark}`;
  return `
:root{--bg:#f3f0e8;--card:#fbfaf6;--ink:#1e2226;--muted:#67625a;--line:#e3ddd0;--grid:#e3ddd0;--row:#ebe6da;--soft:color-mix(in srgb,${inkLight} 6%,#fbfaf6);--soft-line:color-mix(in srgb,${inkLight} 22%,#e3ddd0);--gold:${inkLight};--accent:${inkLight};--head1:#1e2226;
  --ng-font:"IBM Plex Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;--ng-display:"Fraunces","Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;--ng-mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root:not(:has(#theme-light:checked)){${dark}}}
:root:has(#theme-dark:checked){${dark}}
body{font-family:var(--ng-font)}
header{background:#1b1f23;border-bottom:1px solid #2e3338}
header h1,h2{font-family:var(--ng-display);font-weight:600;letter-spacing:-.01em}
.theme{border-radius:8px} .theme label{border-radius:6px}
section{border-radius:12px;position:relative;overflow:hidden}
section.answer::before{content:"";position:absolute;inset:0 0 auto;height:3px;background:${from}}
.card,.scroll{border-radius:10px}
.answer .big,.figure,.keys b,.sevs b{font-family:var(--ng-display);font-variant-numeric:lining-nums tabular-nums}
.answer .big{font-weight:600;letter-spacing:-.01em}
table.calc,ol.calc-how,.scroll table{font-variant-numeric:tabular-nums}
th{font-size:12px;letter-spacing:0;text-transform:none;font-weight:600} table.dense th{font-size:11px}
@media print{:root{color-scheme:light;--bg:#fff;--card:#fff;--ink:#1e2226;--muted:#67625a;--line:#e3ddd0;--grid:#e3ddd0;--row:#ebe6da;--gold:${inkLight};--accent:${inkLight}} body{background:#fff}}
`;
}

/**
 * The reader's own look over the command-center style (Cabin, Circuit, Residence…: public/look.js), the
 * same colours as the app: page and cards, the band at the top with a line of the look's colour, its face.
 */
function lookStyle(name, accentName) {
  const p = lookPalette(name, accentName);
  if (!p) return '';
  const vars = (c) => `--bg:${c.bg};--card:${c.surface};--ink:${c.ink};--muted:${c.muted};--line:${c.line};--grid:${c.line};--row:${c.surface2};--soft:color-mix(in srgb,${c.accent} 7%,${c.surface});--soft-line:color-mix(in srgb,${c.accent} 26%,${c.line});--gold:${c.accent};--accent:${c.accent}`;
  const dark = `color-scheme:dark;${vars(p.dark)}`;
  return `
:root{${vars(p.light)};--head1:${p.head};--ng-display:${p.display}}
@media (prefers-color-scheme:dark){:root:not(:has(#theme-light:checked)){${dark}}}
:root:has(#theme-dark:checked){${dark}}
header{background:${p.head};border-bottom:2px solid var(--accent)}
header h1,h2{font-family:var(--ng-display);font-weight:${p.displayWeight}}
.answer .big,.figure,.keys b,.sevs b{font-family:var(--ng-display);font-weight:${p.displayWeight}${p.italicFigures ? ';font-style:italic' : ''}}
section{border-radius:${p.radius}px} .card,.scroll{border-radius:${Math.min(p.radius, 12)}px}
section.answer::before{background:var(--accent)}
${p.labels === 'caps' ? 'th{text-transform:uppercase;letter-spacing:.08em;font-size:10.5px}' : ''}
@media print{:root{color-scheme:light;${vars(p.light)};--bg:#fff;--card:#fff}}
`;
}

/**
 * The report's HTML. `data` is what generating it saved: see page.js reportData().
 * `options`: `t` the page's translator, `lang` its language and `dir` its direction ("rtl" for Arabic and Hebrew),
 * `look` how it looks: `{look, ui: 'nextgen'|'classic', theme: 'auto'|'light'|'dark', accent}`, the app's own when made from it.
 */
/**
 * The report's data with only the Fusion parts that count: a part with no credits (left out, nothing
 * counted, or no model rate) is not shown, and one line asks the customer's Checkmarx team instead.
 */
export function countedFusion(data) {
  const counts = (part) => (Number(part?.totals?.credits) > 0 ? part : null);
  return { ...data, fusion: counts(data.fusion), fusionNew: counts(data.fusionNew) };
}


/** The total of a report's data, as its answer says it. */
const reportTotal = (data) => creditSummary(data.tr?.totals?.credits ?? null, fusionTotal(data.fusion, data.fusionNew), data.summary?.settings);

/**
 * The levers, under the answer: per severity the backlog to include, the false positives and the credits
 * per finding; what is still to come; Fusion's extra findings; the period, the extra % and the bundle.
 * Each control is named by `data-lever`; the figures it moves are named by `data-out` (report-live.js).
 */
function leversPanel(data, live, L) {
  const { w, num } = L;
  const sum = reportTotal(data);
  const sent = live.sentTotal;
  const tr = data.tr;
  const plan = live.inputs.tr?.plan;
  const slider = (key, value, max, label, out) => `<span class="lv-slide"><input type="range" min="0" max="${max}" step="1" value="${Math.round(value)}" data-lever="${key}" aria-label="${label}"><output data-out="${key}">${out}</output></span>`;
  const box = (key, value, label, extra = '') => `<input class="lv-num" type="number" min="0" step="any" inputmode="decimal" data-lever="${key}" value="${value ?? ''}" aria-label="${label}"${extra}>`;
  const sevRows = tr ? SEVERITIES.map((s) => {
    const r = tr.rows[s];
    return `<tr><th scope="row"><i class="dot" style="background:${SEVERITY_COLOURS[s]}"></i>${w(s)}</th>
      <td data-label="${w('Backlog to include')}">${slider(`sel.${s}`, r.selected, r.backlog, w('{0}: backlog to include', w(s)), w('{0} of {1}', num(r.selected), num(r.backlog)))}</td>
      <td data-label="${w('False positives')}">${slider(`fp.${s}`, r.fp, 100, w('{0}: false positives %', w(s)), `${num(r.fp)}%`)}</td>
      <td data-label="${w('Credits to triage one')}">${box(`tc.${s}`, r.triageCost, w('{0}: credits to triage one finding', w(s)))}</td>
      <td data-label="${w('Credits to remediate one')}">${box(`rc.${s}`, r.remediationCost, w('{0}: credits to remediate one finding', w(s)))}</td></tr>`;
  }).join('') : '';
  const ahead = tr?.ahead ?? {};
  const periods = [...new Set([3, 6, 12, 18, 24, 36, live.inputs.months])].sort((a, b) => a - b);
  const changed = JSON.stringify(live.inputs) !== JSON.stringify(live.sentInputs);
  return `<section class="levers" id="levers" aria-labelledby="levers-h">
  <div class="lv-head">
    <div><h2 id="levers-h">${w('Try other numbers')}</h2><p class="sub">${w('Move any lever and every figure in this report follows. Nothing is sent anywhere and no Checkmarx One connection is needed: the changes stay in this file until you download your version.')}</p></div>
    <div class="lv-total" aria-live="polite"><span class="lv-eyebrow">${w('Your version')}</span><b data-out="total">${num(sum.total)}</b><span data-out="bundles">${w('credits · {0} bundles of {1}', num(sum.bundles), num(sum.settings.bundleCredits))}</span><span class="lv-was" data-out="was">${w('As sent: {0} credits', num(sent))}</span>
      <span class="lv-acts"><button type="button" data-act="reset"${changed ? '' : ' disabled'}>${w('Back to the plan as sent')}</button><button type="button" data-act="pdf">${w('Download PDF')}</button><button type="button" class="lv-primary" data-act="download">${w('Download my version')}</button></span>
      <label class="lv-check lv-pdf-opt"><input type="checkbox" data-pdf-calculations> ${w('Include the calculations in the PDF')}</label></div>
  </div>
  <div class="lv-grid">
    ${tr && plan ? `<fieldset class="lv-card lv-wide"><legend>${w('Triage & remediation, by severity')}</legend>
      <div class="lv-scroll"><table class="lv-sev"><thead><tr><th></th><th>${w('Backlog to include')}</th><th>${w('False positives')}</th><th>${w('Credits to triage one')}</th><th>${w('Credits to remediate one')}</th></tr></thead><tbody>${sevRows}</tbody></table></div>
      <div class="lv-row">
        <label class="lv-check"><input type="checkbox" data-lever="future"${ahead.includeFuture !== false ? ' checked' : ''}> ${w('Count the findings still to come')}</label>
        <label>${w('New findings fall with AI')} ${slider('ai', ahead.aiDeclinePercent ?? 0, 90, w('New findings fall with AI'), w('{0}% over a year', num(ahead.aiDeclinePercent ?? 0)))}</label>
        ${tr.fusion ? `<label>${w('More found by Fusion')} ${slider('up', ahead.fusionUpliftPercent ?? 0, 100, w('More found by Fusion'), `${num(ahead.fusionUpliftPercent ?? 0)}%`)}</label>` : ''}
      </div>
    </fieldset>` : ''}
    ${data.fusion ? `<fieldset class="lv-card"><legend>${w('Checkmarx Fusion')}</legend>
      <p class="sub">${data.fusion.details === false ? w('Each model\'s credits per 10K LOC and the Fusion scans and model by scan frequency are changed in the Fusion tables of the appendix.') : w('Each model\'s credits per 10K LOC and the Fusion scans and model by scan frequency and for each project are changed in the Fusion tables of the appendix.')}</p>
      <p><a href="#fusion">${w('Go to the Fusion tables')}</a></p>
    </fieldset>` : ''}
    <fieldset class="lv-card"><legend>${w('Overall')}</legend>
      <label class="lv-field">${w('Projection period')} <select data-lever="months">${periods.map((m) => `<option value="${m}"${m === live.inputs.months ? ' selected' : ''}>${w('{0} months', num(m))}</option>`).join('')}</select></label>
      ${data.fusion ? `<p class="sub">${w('Fusion scans follow the period: 6 in 12 months are 12 in 24.')}</p>` : ''}
      <label class="lv-field">${w('Extra credits (%)')} ${box('extra', sum.settings.extraPercent, w('Extra credits (%)'))}</label>
      <label class="lv-field">${w('Credits per bundle')} ${box('bundle', sum.settings.bundleCredits, w('Credits per bundle'), ' step="1"')}</label>
    </fieldset>
  </div>
</section>
<p class="lv-pill" aria-hidden="true"><span>${w('Your version')}</span> <b data-out="pill">${num(sum.total)}</b> ${w('credits')}</p>`;
}

/** The body of the report: the runtime renders it again when a lever moves. */
export function reportMain(raw, { t, lang = 'en', live = null } = {}) {
  const data = countedFusion(raw);
  const L = wording({ t, lang });
  const { w } = L;
  const sum = creditSummary(data.tr?.totals?.credits ?? null, fusionTotal(data.fusion, data.fusionNew), data.summary?.settings);
  return `${answer(data, sum, L)}
${live ? leversPanel(data, live, L) : ''}
${story(data, L)}
${impactSection(data, L)}
${assumptions(data, sum, L)}
${data.tr || data.fusion || data.fusionNew ? `<p class="appendix-title">${w('Appendix: every figure')}</p>` : ''}
${data.tr ? trAppendix(data.tr, L) : ''}
${data.fusion ? fusionAppendix(data.fusion, L, Boolean(live)) : ''}
${data.fusionNew ? fusionNewAppendix(data.fusionNew, L) : ''}
${calculations(data, L)}
${provenance(data, L)}`;
}

/** A report with its levers runs that one script, by its hash, and reaches nothing: no connection, no form, no other script. */
export const liveCspMeta = (hash) => `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${hash}; script-src-attr 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`;

/** The figures and levers the runtime reads, as JSON that cannot end its <script> element. */
const liveJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

/**
 * `live`: the report with its levers: `{ inputs, sentInputs, base, words, runtime: { text, hash } }`, `inputs` from
 * levers.js leverInputs (now and as sent), `base` the data that does not move, `words` the wording in the report's
 * language, `runtime` the bundled report-live.js and its CSP hash. Without it, the report has no script at all.
 */
export function buildReport(raw, { t, lang = 'en', dir = 'ltr', look, live = null } = {}) {
  const data = countedFusion(raw);
  const { look: lookName, ui, theme, accent } = reportLook(look);
  const L = wording({ t, lang });
  const { w } = L;
  const customer = esc(data.customer || L.t('Customer'));
  const made = esc(new Date(data.generatedAt).toLocaleString(L.locale));
  return `<!doctype html>
<html lang="${esc(lang)}" dir="${dir === 'rtl' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${live ? liveCspMeta(live.runtime.hash) : ''}<title>${w('{0}: Checkmarx credits projection', customer)}</title>
<style>${STYLE}${ui === 'nextgen' ? nextgenStyle(accent) + lookStyle(lookName, accent) : ''}</style></head>
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
<main${live ? ' class="lv-on"' : ''}>
${reportMain(raw, { t, lang, live })}
</main>
<footer>${w("An estimate made with CxMissionZero's Cx Credits Calculator from Checkmarx One data and the assumptions above. Credit rates and the credits actually used are set by Checkmarx and your agreement with them.")}${data.tr?.history?.length ? ` ${w('Backlog history: {0} to {1}.', esc(monthLabel(data.tr.history[0].month)), esc(monthLabel(data.tr.history[data.tr.history.length - 1].month)))}` : ''}</footer>
${live ? `<script type="application/json" id="cx-live">${liveJson({ base: live.base, inputs: live.inputs, sentInputs: live.sentInputs, sentTotal: live.sentTotal, words: live.words ?? {}, lang, dir, look: look ?? null })}</script>
<script>${live.runtime.text}</script>` : ''}
</body></html>`;
}
