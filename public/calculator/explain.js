// Cx Credits Calculator: how every number is worked out, with the figures in, for the "?" on the
// page, the report's "How each number is calculated" and the PDF's appendix. One source, so the
// three always say the same thing. `L` is the report's wording (`w` escapes, `num` formats).

import { FREQUENCIES, HOURS_A_YEAR, SEVERITIES, aheadMonths, creditSummary, fusionTotal } from './model.js';

const FREQUENCY_LABEL = Object.fromEntries(FREQUENCIES.map((f) => [f.id, f.label]));

const pctOf = (n) => (Number.isFinite(n) ? n * 100 : 0);

/** The severities worth a line: chosen, or adding findings still to come. */
function counted(tr) {
  return SEVERITIES.filter((s) => (tr.rows?.[s]?.selected ?? 0) > 0 || (tr.rows?.[s]?.future ?? 0) > 0);
}

/**
 * Triage & remediation, one section per number: { key, title, lines: [{ text, sub }] }, each text
 * already in the reader's language (escaped HTML). `tr` is the report's tr (page.js reportData()).
 */
export function trSections(tr, L) {
  const { w, num } = L;
  const rows = tr.rows ?? {};
  const T = tr.totals ?? {};
  const A = tr.ahead ?? {};
  const an = (s) => tr.analysis?.[s] ?? {};
  const name = (s) => w(s);
  const months = tr.months ?? 12;
  const paced = tr.paced ?? aheadMonths(months, A.aiDeclinePercent ?? 0);
  const span = tr.analysis?.spanMonths ?? tr.lookbackMonths;
  const list = counted(tr);
  const total = (n, digits = 0) => ({ text: w('Total: {0}.', num(n, digits)), total: true });
  const line = (text, sub = false) => ({ text, sub });
  const sections = [];

  sections.push({
    key: 'backlog',
    title: w('Backlog today'),
    lines: [
      line(w('The open findings chosen under Customize per severity, of {0} open:', num(T.backlog))),
      ...SEVERITIES.map((s) => line(w('{0}: {1} of {2}', name(s), num(rows[s]?.selected), num(rows[s]?.backlog)), true)),
      total(T.selected),
    ],
  });

  const future = [];
  if (A.includeFuture === false) future.push(line(w('Findings still to come are not counted.')));
  else {
    future.push(line(w('New findings a month, per severity, over the last {0} months: open now − open then + fixed in between, divided by {1} months.', num(tr.lookbackMonths), num(span, 2))));
    for (const s of SEVERITIES) {
      const a = an(s);
      if (Number.isFinite(a.prior) && Number.isFinite(a.fixed)) future.push(line(w('{0}: ({1} − {2} + {3}) ÷ {4} = {5} a month', name(s), num(a.current), num(a.prior), num(a.fixed), num(span, 2), num(a.arrivals)), true));
      else future.push(line(w('{0}: {1} a month', name(s), num(a.arrivals)), true));
    }
    future.push(line(w('Counted in the share of each severity\'s backlog chosen:')));
    for (const s of SEVERITIES) {
      const share = rows[s]?.share ?? 1;
      const arrivals = rows[s]?.arrivals ?? (an(s).arrivals ?? 0) * share;
      future.push(line(w('{0}: {1} × {2}% = {3} a month', name(s), num(an(s).arrivals), num(pctOf(share)), num(arrivals)), true));
    }
    const monthly = T.arrivals ?? SEVERITIES.reduce((sum, s) => sum + (rows[s]?.arrivals ?? an(s).arrivals ?? 0), 0);
    future.push(line(A.aiDeclinePercent ? w('Over {0} months, falling by {1}% over a year as teams adopt AI: {2} months\' worth.', num(months), num(A.aiDeclinePercent), num(paced, 2)) : w('Over {0} months at today\'s pace: {1} months\' worth.', num(months), num(paced, 2))));
    future.push(line(w('{0} a month × {1} = {2}.', num(monthly), num(paced, 2), num(T.future))));
  }
  sections.push({ key: 'future', title: w('Still to come'), lines: future });

  sections.push({
    key: 'fusion',
    title: w('More found by Fusion'),
    lines: !tr.fusion
      ? [line(w('Fusion is not in this projection: no project is counted on the Fusion tab.'))]
      : tr.sastOnly
        ? [
            line(w('SAST findings among the backlog chosen and the findings still to come, in SAST\'s share of each severity: {0}.', num(T.fusionBase))),
            line(w('{0}% more SAST findings: {0}% × {1} = {2}.', num(A.fusionUpliftPercent), num(T.fusionBase), num(T.fusionExtra))),
          ]
        : [line(w('{0}% more findings on the backlog chosen and the findings still to come: {0}% × ({1} + {2}) = {3}.', num(A.fusionUpliftPercent), num(T.selected), num(T.future), num(T.fusionExtra)))],
  });

  sections.push({
    key: 'triage',
    title: w('To triage'),
    lines: [line(w('Backlog chosen + still to come + found by Fusion:')), line(`${num(T.selected)} + ${num(T.future)} + ${num(T.fusionExtra)} = ${num(T.toTriage)}`, true)],
  });

  sections.push({
    key: 'remediate',
    title: w('To remediate'),
    lines: [
      line(w('The true positives among everything reported:')),
      ...list.map((s) => {
        const r = rows[s] ?? {};
        return line(w('{0}: {1} × {2}% = {3}', name(s), num((r.selected ?? 0) + (r.future ?? 0) + (r.fusionExtra ?? 0)), num(100 - (r.fp ?? 0)), num(r.truePositives)), true);
      }),
      total(T.truePositives),
    ],
  });

  sections.push({
    key: 'credits',
    title: w('Credits'),
    lines: [
      line(w('Triage: each finding to triage × its credits per triage:')),
      ...list.map((s) => line(`${name(s)}: ${num(rows[s]?.toTriage)} × ${num(rows[s]?.triageCost, 2)} = ${num(rows[s]?.triageCredits)}`, true)),
      line(w('Remediation: each true positive × its credits per remediation:')),
      ...list.map((s) => line(`${name(s)}: ${num(rows[s]?.truePositives)} × ${num(rows[s]?.remediationCost, 2)} = ${num(rows[s]?.remediationCredits)}`, true)),
      line(w('{0} + {1} = {2} credits.', num(T.triageCredits, 1), num(T.remediationCredits, 1), num(T.credits, 1)), false),
      line(w('Today\'s backlog: {0}; findings ahead: {1}.', num(T.backlogCredits, 1), num(T.aheadCredits, 1))),
    ],
  });
  return sections;
}

/** Fusion: units × scans × each model's credits per 10K LOC. */
export function fusionSection(f, L) {
  const { w, num } = L;
  if (!f) return { key: 'fusion-credits', title: w('Fusion credits'), lines: [{ text: w('Fusion is not in this projection: no project is counted on the Fusion tab.') }] };
  return {
    key: 'fusion-credits',
    title: w('Fusion credits'),
    lines: [
      { text: w('Each project\'s lines of code are rounded up to whole 10K units; units × Fusion scans × the model\'s credits per 10K LOC:') },
      ...(f.byModel ?? []).filter((m) => m.credits > 0).map((m) => ({ text: `${String(m.name || '—').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])}: ${num(m.unitScans)} × ${num(m.rate, 2)} = ${num(m.credits, 1)}`, sub: true })),
      { text: w('Total: {0}.', num(f.totals?.credits, 1)), total: true },
    ],
  };
}

/**
 * Fusion for the new customer: each project's scans (by how often it changes, when that is known: the commits on
 * its default branch, bucketed as Checkmarx One projects' scans are; else this tab's default; or its own), then
 * units × scans × each model's credits per 10K LOC.
 */
export function fusionNewSection(f, L) {
  const { w, num } = L;
  const T = f.totals ?? {};
  const lines = [];
  if (T.withActivity) lines.push({ text: w('{0} projects counted from git or read from a cloc-fusion report: their commits on the default branch in the last year set how often they change, and that change frequency sets their Fusion scans, as for a Checkmarx One project scanned that often:', num(T.withActivity)) });
  for (const b of f.byFrequency ?? []) {
    if (!b.projects) continue;
    lines.push({ text: w('{0}: {1} projects, {2} Fusion scans each by the Fusion tab\'s rule, {3} in all', w(FREQUENCY_LABEL[b.id] ?? b.id), num(b.projects), num(f.rules?.[b.id]?.scans ?? f.defaultScans), num(b.scans)), sub: true });
  }
  if (T.byDefault) lines.push({ text: w('{0} projects without a known change frequency: {1} Fusion scans each (the default).', num(T.byDefault), num(f.defaultScans)) });
  if (T.byProject) lines.push({ text: w('{0} projects with Fusion scans set for them.', num(T.byProject)) });
  lines.push({ text: w('Each project\'s lines of code are rounded up to whole 10K units; units × Fusion scans × the model\'s credits per 10K LOC:') });
  for (const m of (f.byModel ?? []).filter((x) => x.credits > 0)) lines.push({ text: `${String(m.name || '—').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])}: ${num(m.unitScans)} × ${num(m.rate, 2)} = ${num(m.credits, 1)}`, sub: true });
  lines.push({ text: w('Total: {0}.', num(T.credits, 1)), total: true });
  return { key: 'fusion-new-credits', title: w('Fusion — new customer credits'), lines };
}

/** The total and the bundles. */
export function totalSection(data, L) {
  const { w, num } = L;
  // Both Fusion parts: the customer's projects in Checkmarx One and its new code.
  const sum = creditSummary(data.tr?.totals?.credits ?? null, fusionTotal(data.fusion, data.fusionNew), data.summary?.settings);
  const lines = [{ text: w('Triage & remediation {0} + Fusion {1} = {2}.', num(sum.tr ?? 0, 1), num(sum.fusion ?? 0, 1), num(sum.base, 1)) }];
  if (sum.extra) lines.push({ text: w('Plus {0}% extra: {1}.', num(sum.settings.extraPercent, 2), num(sum.total, 1)) });
  lines.push({ text: w('{0} ÷ {1} credits a bundle = {2}, rounded up to {3} bundles.', num(sum.total, 1), num(sum.settings.bundleCredits), num(sum.exactBundles, 2), num(sum.bundles)) });
  return { key: 'total', title: w('Total credits required'), lines };
}

/** An amount of money in the impact's currency. */
export function moneyText(n, currency, locale) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  try {
    return n.toLocaleString(locale, { style: 'currency', currency, maximumFractionDigits: 0 });
  } catch {
    return `${Math.round(n).toLocaleString(locale)} ${currency}`;
  }
}

/** Impact (model.js trImpact): the hours given back, their value, what the credits cost, the return. */
export function impactSections(m, L) {
  const { w, num } = L;
  if (!m) return [];
  const s = m.settings;
  const cash = (n) => moneyText(n, s.currency, L.locale);
  const lines = [
    { text: w('Triage: every finding AI triages × the minutes to triage it by hand ÷ 60:') },
    { text: w('{0} × {1} ÷ 60 = {2} hours.', num(m.triaged), num(s.triageMinutes), num(m.triageHours)), sub: true },
    { text: w('Fixing: every true positive AI fixes × (the minutes to fix it by hand − the minutes to review the AI fix) ÷ 60:') },
    { text: w('{0} × ({1} − {2}) ÷ 60 = {3} hours.', num(m.fixes), num(s.fixMinutes), num(s.reviewMinutes), num(m.fixHours)), sub: true },
    { text: w('{0} + {1} = {2} hours, about {3} developer-years at {4} hours a year.', num(m.triageHours), num(m.fixHours), num(m.hours), num(m.developerYears, 1), num(HOURS_A_YEAR)), total: true },
    { text: w('False positives cleared: findings triaged − true positives, {0} − {1} = {2}; none of them reaches a developer.', num(m.triaged), num(m.fixes), num(m.cleared)) },
  ];
  const money = [];
  if (m.value === null) money.push({ text: w('Enter what a developer\'s hour costs to put a value on the time.') });
  else money.push({ text: w('Value of the time: {0} hours × {1} = {2}.', num(m.hours), cash(s.hourlyRate), cash(m.value)) });
  if (m.cost === null) money.push({ text: w('Enter what a credit costs to set the value against it.') });
  else money.push({ text: w('What the credits cost: {0} credits × {1} = {2}.', num(m.credits, 1), s.creditPrice.toLocaleString(L.locale, { maximumFractionDigits: 2 }), cash(m.cost)) });
  if (m.roi !== null) {
    money.push({ text: w('Return: ({0} − {1}) ÷ {1} = {2}%.', cash(m.value), cash(m.cost), num(m.roi * 100)), total: true });
    if (m.paybackMonths !== null) money.push({ text: w('Paid back in: {0} ÷ ({1} ÷ {2} months) = {3} months.', cash(m.cost), cash(m.value), num(m.months), num(m.paybackMonths, 1)) });
  }
  return [
    { key: 'impact-hours', title: w('Hours given back'), lines },
    { key: 'impact-money', title: w('Value and return'), lines: money },
  ];
}

/** Fusion's impact (model.js fusionImpact): expert review replaced, and the rest it leads to. */
export function fusionImpactSections(f, L) {
  const { w, num } = L;
  if (!f) return [];
  const s = f.settings;
  const cash = (n) => moneyText(n, s.currency, L.locale);
  const review = [
    { text: w('Lines read: each project\'s lines of code × its Fusion scans, {0} lines × {1} times on average = {2}.', num(f.linesOnce), num(f.timesRead, 1), num(f.linesRead)) },
    { text: w('Expert hours: {0} lines ÷ {1} lines an hour = {2} hours.', num(f.linesRead), num(s.linesPerHour), num(f.expertHours)), total: true },
  ];
  if (f.expertValue !== null) review.push({ text: w('Worth: {0} hours × {1} = {2}.', num(f.expertHours), cash(s.hourlyRate), cash(f.expertValue)) });
  review.push({ text: w('Reviewers to keep pace: {0} hours ÷ ({1} hours a year × {2} months ÷ 12) = {3}.', num(f.expertHours), num(HOURS_A_YEAR), num(f.months), num(f.reviewersNeeded, 1)) });
  review.push({ text: w('A team reading it once: {0} lines ÷ {1} lines an hour ÷ ({2} reviewers × 40 hours) = {3} weeks.', num(f.linesOnce), num(s.linesPerHour), num(s.reviewers), num(f.teamWeeks, 1)) });
  if (f.costPer10k !== null) review.push({ text: w('Cost per 10K lines read: {0} ÷ ({1} ÷ {3}) = {2}.', cash(f.cost), num(f.linesRead), cash(f.costPer10k), num(10000)) });
  if (f.expertPer10k !== null) review.push({ text: w('An expert: {3} ÷ {0} lines an hour × {1} = {2}.', num(s.linesPerHour), cash(s.hourlyRate), cash(f.expertPer10k), num(10000)) });
  const sections = [{ key: 'fusion-review', title: w('Expert review replaced'), lines: review }];
  if (f.extraTrue !== null) {
    const early = [
      { text: w('More true positives Fusion finds: more found by Fusion × (100% − false positives) = {0}.', num(f.extraTrue)) },
      { text: w('Fixed while coding, not after release, where a fix costs {0} times as much: {1} × ({0} − 1) × {2} minutes ÷ 60 = {3} hours.', num(s.laterFixMultiplier, 1), num(f.extraTrue), num(s.fixMinutes), num(f.earlyHours)), total: true },
    ];
    if (f.earlyValue !== null) early.push({ text: w('Worth: {0} hours × {1} = {2}.', num(f.earlyHours), cash(s.hourlyRate), cash(f.earlyValue)) });
    early.push({ text: w('Breach cost avoided: {0} critical and high × {1}% × {2} = {3}{4}', num(f.extraCriticalHigh), num(s.breachChancePercent, 2), cash(s.breachCost), cash(f.breachAvoided), s.countBreach ? w('; counted in the return.') : w('; an expected cost, not counted in the return.')) });
    sections.push({ key: 'fusion-early', title: w('Found earlier, fixed cheaper'), lines: early });
  }
  return sections;
}

/** Everything together: the value of all the credits against what they cost. */
export function overallImpactSection(o, L) {
  const { w, num } = L;
  if (!o || o.value === null) return [];
  const cash = (n) => moneyText(n, o.currency, L.locale);
  const lines = [{ text: w('All the credits give back: {0}.', cash(o.value)) }];
  if (o.cost !== null) lines.push({ text: w('What the credits cost: {0}.', cash(o.cost)) });
  if (o.roi !== null) lines.push({ text: w('Return: ({0} − {1}) ÷ {1} = {2}%.', cash(o.value), cash(o.cost), num(o.roi * 100)), total: true });
  if (o.paybackMonths !== null) lines.push({ text: w('Paid back in: {0} ÷ ({1} ÷ {2} months) = {3} months.', cash(o.cost), cash(o.value), num(o.months), num(o.paybackMonths, 1)) });
  return [{ key: 'impact-overall', title: w('Return on all the credits'), lines }];
}

/** Every section, in the order the numbers are reached. */
export function allSections(data, L) {
  return [
    ...(data.tr ? trSections(data.tr, L) : []),
    fusionSection(data.fusion, L),
    ...(data.fusionNew ? [fusionNewSection(data.fusionNew, L)] : []),
    totalSection(data, L),
    ...impactSections(data.impact?.tr, L),
    ...fusionImpactSections(data.impact?.fusion, L),
    ...overallImpactSection(data.impact?.overall, L),
  ];
}

/** A section as HTML: the lines, figures already in. */
export function sectionHtml(section) {
  return `<ol class="calc-how">${section.lines.map((l) => `<li class="${l.sub ? 'calc-sub' : ''}${l.total ? ' calc-total' : ''}">${l.text}</li>`).join('')}</ol>`;
}
