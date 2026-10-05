/**
 * What AI Triage and AI Remediation did for the backlog, worked out from the
 * finding journal (src/finding-journal.js) and the credit ledger: hours saved,
 * findings shown not exploitable, time to fix (AI-assisted against manual,
 * over the same weeks), and the security debt week by week.
 *
 * Kept deliberately conservative:
 *   - one Checkmarx One result counts once, however many rows it has;
 *   - a fix counts only once Checkmarx One no longer reports the finding;
 *   - every figure comes with the settings it used (minutes, rate, price).
 */

const DAY = 86_400_000;
const WEEK = 7 * DAY;
export const SEVERITY_WEIGHTS = { CRITICAL: 10, HIGH: 5, MEDIUM: 2, LOW: 1 };
export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
export const IMPACT_DEFAULTS = { triageMinutes: 20, fixMinutes: 120, hourlyRate: 0, creditPrice: 0, currency: 'USD' };

const median = (list) => {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return Math.round((sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10;
};
const earlier = (a, b) => (!a ? b : !b ? a : a < b ? a : b);
const round1 = (n) => Math.round(n * 10) / 10;
const money = (n) => Math.round(n * 100) / 100;

/**
 * Checkmarx One results (rows sharing one result are one unit), each with
 * when it was first open, when it closed and how, and what AI did to it.
 */
export function resultsOf(journal, ledger) {
  const triagedByRisk = new Map();
  const triagedByUnit = new Map();
  const remediatedByRisk = new Map();
  for (const e of ledger) {
    const put = (map, key) => map.set(key, earlier(map.get(key), e.at));
    if (e.kind === 'remediation') {
      for (const id of e.riskIds ?? []) put(remediatedByRisk, `${e.projectId}|${id}`);
    } else {
      for (const id of e.riskIds ?? []) put(triagedByRisk, `${e.projectId}|${id}`);
      for (const id of e.alternateIds ?? []) put(triagedByUnit, `${e.projectId}|a:${id}`);
      for (const id of e.groupIds ?? []) put(triagedByUnit, `${e.projectId}|g:${id}`);
    }
  }
  const units = new Map();
  for (const row of journal) {
    const key = `${row.p}|${row.u ?? `r:${row.r}`}`;
    let unit = units.get(key);
    if (!unit) {
      unit = { projectId: row.p, projectName: row.n ?? '', severity: row.s, detected: null, rows: [], triaged: triagedByUnit.get(key) ?? null, remediated: null };
      units.set(key, unit);
    }
    unit.rows.push(row);
    if (row.n) unit.projectName = row.n;
    if ((SEVERITY_WEIGHTS[row.s] ?? 0) > (SEVERITY_WEIGHTS[unit.severity] ?? 0)) unit.severity = row.s;
    unit.detected = earlier(unit.detected, row.d ? `${row.d}T00:00:00.000Z` : row.o);
    unit.triaged = earlier(unit.triaged, triagedByRisk.get(`${row.p}|${row.r}`));
    unit.remediated = earlier(unit.remediated, remediatedByRisk.get(`${row.p}|${row.r}`));
  }
  for (const unit of units.values()) {
    unit.firstSeen = unit.rows.reduce((t, r) => earlier(t, r.o), null);
    const open = unit.rows.some((r) => !r.g && !r.x);
    unit.closed = open ? null : unit.rows.reduce((t, r) => ((r.g ?? r.x) > (t ?? '') ? r.g ?? r.x : t), null);
    // Fixed when Checkmarx One stopped reporting it; otherwise judged not exploitable.
    unit.how = open ? null : unit.rows.some((r) => r.g) ? 'fixed' : 'notExploitable';
    unit.aiFixed = unit.how === 'fixed' && Boolean(unit.remediated) && unit.remediated <= unit.closed;
    unit.aiNoise = unit.how === 'notExploitable' && Boolean(unit.triaged) && unit.triaged <= unit.closed;
  }
  return [...units.values()];
}

/** The debt (severity-weighted open results) at a moment, and the open count by severity. */
function debtAt(units, at) {
  const bySeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  let score = 0;
  for (const u of units) {
    if (!(u.severity in SEVERITY_WEIGHTS)) continue;
    const since = earlier(u.detected, u.firstSeen);
    if (!since || since > at || (u.closed && u.closed <= at)) continue;
    bySeverity[u.severity] += 1;
    score += SEVERITY_WEIGHTS[u.severity];
  }
  return { score, bySeverity };
}

/**
 * Everything the Impact page shows, for `from` (inclusive) to `to` (exclusive), ISO times.
 * `settings`: minutes per manual triage and fix, hourly rate and price per credit (0 = not set).
 */
export function computeImpact({ journal, ledger, settings = {}, from, to, now = new Date() }) {
  const s = { ...IMPACT_DEFAULTS, ...settings };
  const nowIso = now.toISOString();
  const end = to && to < nowIso ? to : nowIso;
  const inPeriod = (t) => Boolean(t) && t >= from && t < end;
  const units = resultsOf(journal, ledger);
  const since = journal.reduce((t, r) => earlier(t, r.o), null);

  // Credits used in the period: 1 per result triaged, 3 per finding remediated.
  const credits = { triage: 0, remediation: 0 };
  const creditsByProject = new Map();
  for (const e of ledger) {
    if (!inPeriod(e.at)) continue;
    const kind = e.kind === 'remediation' ? 'remediation' : 'triage';
    credits[kind] += e.credits;
    creditsByProject.set(e.projectId, (creditsByProject.get(e.projectId) ?? 0) + e.credits);
  }

  const closedNow = units.filter((u) => inPeriod(u.closed));
  const aiFixed = closedNow.filter((u) => u.aiFixed);
  const manualFixed = closedNow.filter((u) => u.how === 'fixed' && !u.aiFixed);
  const noise = closedNow.filter((u) => u.aiNoise);
  const triagedNow = units.filter((u) => inPeriod(u.triaged));

  const hours = {
    triage: round1((credits.triage * s.triageMinutes) / 60),
    fix: round1((aiFixed.length * s.fixMinutes) / 60),
  };
  hours.total = round1(hours.triage + hours.fix);
  const creditsTotal = credits.triage + credits.remediation;
  const value = s.hourlyRate > 0 ? money(hours.total * s.hourlyRate) : null;
  const cost = s.creditPrice > 0 ? money(creditsTotal * s.creditPrice) : null;
  const closedByAi = aiFixed.length + noise.length;

  // Days from first detection to closed, by severity: AI-fixed against fixed by hand, over the same weeks.
  const days = (u) => Math.max(0, (Date.parse(u.closed) - Date.parse(u.detected ?? u.firstSeen)) / DAY);
  const timeToFix = SEVERITIES.map((severity) => {
    const ai = aiFixed.filter((u) => u.severity === severity).map(days);
    const manual = manualFixed.filter((u) => u.severity === severity).map(days);
    return { severity, ai: median(ai), aiCount: ai.length, manual: median(manual), manualCount: manual.length };
  });
  const all = (list) => median(list.map(days));

  // The debt, week by week, from when the journal started (at most two years back).
  const series = [];
  if (since) {
    const start = Math.max(Date.parse(since), Date.parse(nowIso) - 104 * WEEK);
    for (let t = Date.parse(nowIso); t >= start - WEEK + 1; t -= WEEK) {
      const at = new Date(Math.max(t, start)).toISOString();
      series.unshift({ at, ...debtAt(units, at) });
      if (t <= start) break;
    }
  }
  const startDebt = debtAt(units, since && since > from ? since : from).score;
  const nowDebt = debtAt(units, nowIso).score;
  // At the pace of the last four weeks, when the debt reaches zero.
  let zeroBy = null;
  const recent = series.slice(-5);
  if (recent.length >= 2 && nowDebt > 0) {
    const first = recent[0];
    const last = recent.at(-1);
    const perDay = (last.score - first.score) / ((Date.parse(last.at) - Date.parse(first.at)) / DAY || 1);
    if (perDay < 0) {
      const daysLeft = last.score / -perDay;
      if (daysLeft < 5 * 365) zeroBy = new Date(Date.parse(last.at) + daysLeft * DAY).toISOString().slice(0, 10);
    }
  }

  // Per project, for the AppSec team.
  const projects = new Map();
  const row = (u) => {
    let p = projects.get(u.projectId);
    if (!p) projects.set(u.projectId, (p = { projectId: u.projectId, projectName: u.projectName, aiTriaged: 0, notExploitable: 0, aiFixed: 0, manualFixed: 0, open: 0, aiDays: [], manualDays: [], credits: creditsByProject.get(u.projectId) ?? 0 }));
    if (u.projectName) p.projectName = u.projectName;
    return p;
  };
  for (const u of units) {
    if (!u.closed) row(u).open += 1;
    if (inPeriod(u.triaged)) row(u).aiTriaged += 1;
    if (!inPeriod(u.closed)) continue;
    if (u.aiNoise) row(u).notExploitable += 1;
    if (u.aiFixed) {
      row(u).aiFixed += 1;
      row(u).aiDays.push(days(u));
    } else if (u.how === 'fixed') {
      row(u).manualFixed += 1;
      row(u).manualDays.push(days(u));
    }
  }
  const byProject = [...projects.values()]
    .map(({ aiDays, manualDays, ...p }) => ({
      ...p,
      aiMedianDays: median(aiDays),
      manualMedianDays: median(manualDays),
      creditsPerClosed: p.aiFixed + p.notExploitable ? round1(p.credits / (p.aiFixed + p.notExploitable)) : null,
    }))
    .sort((a, b) => b.aiFixed + b.notExploitable - (a.aiFixed + a.notExploitable) || b.open - a.open || a.projectName.localeCompare(b.projectName));

  return {
    from,
    to: end,
    since,
    partial: Boolean(since && since > from),
    settings: s,
    credits: { ...credits, total: creditsTotal },
    hours,
    money: { value, cost, net: value !== null && cost !== null ? money(value - cost) : null, currency: s.currency },
    noiseRemoved: noise.length,
    aiTriaged: triagedNow.length,
    aiFixed: aiFixed.length,
    manualFixed: manualFixed.length,
    creditsPerClosed: closedByAi ? round1(creditsTotal / closedByAi) : null,
    costPerClosed: closedByAi && cost !== null ? money(cost / closedByAi) : null,
    medianDays: { ai: all(aiFixed), manual: all(manualFixed) },
    timeToFix,
    debt: { start: startDebt, now: nowDebt, change: startDebt ? Math.round(((nowDebt - startDebt) / startDebt) * 100) : null, zeroBy, weights: SEVERITY_WEIGHTS },
    series,
    byProject,
  };
}
