// Cx Credits Calculator: the arithmetic, shared by the page (public/calculator/page.js), the
// report it downloads (report.js), the server (src/projections.js) and the tests.
//
// Triage & remediation: two Checkmarx One exports (the open backlog by severity at each week's end,
// and what was fixed each week) give the backlog, its trend and how fast it grows; a plan per
// severity (how many findings to triage, the expected false positives, the credits each step
// takes) gives the credits. False positives pay their triage credit only.
//
// Ahead: over the projection period, the findings still to come at the pace of the lookback
// (arrivals: what the backlog grew by, plus what was fixed meanwhile), the extra findings Fusion
// reports once it scans the code, and those FAE keeps from being reported (false positives only).
//
// Fusion: one Fusion scan of a project costs its model's credits per 10K lines of code, with each
// project rounded up to whole 10K units on its own (12,000 lines are 2 units). How many Fusion
// scans each project needs follows from a default, how often the project is scanned today, and
// its criticality in Checkmarx One.

export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
export const DEFAULT_TR = Object.freeze({
  triageCost: { Critical: 1, High: 1, Medium: 1, Low: 1 },
  remediationCost: { Critical: 3, High: 3, Medium: 3, Low: 3 },
  fpPercent: { Critical: 30, High: 30, Medium: 30, Low: 30 },
  lookbackMonths: 3,
  includeFuture: true,
  fusionUpliftPercent: 5,
  faePercent: 10,
  // New findings fall as teams adopt AI (assist, triage, remediation): this much fewer each month.
  aiDeclinePercent: 2,
});
// The trend is always read over months (a single week says too little to project from).
export const LOOKBACKS = [3, 6, 9, 12];
export const UNIT_LOC = 10000;

/** A whole number ≥ 0 from whatever was typed or read; null when there is none. */
export function wholeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[\s,_]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/** A number ≥ 0 (decimals kept, e.g. 2.5 credits); null when there is none. */
export function amount(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[\s,_]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const monthKey = (iso) => String(iso).slice(0, 7);

// ---------------------------------------------------------------------------------------------
// Triage & remediation
// ---------------------------------------------------------------------------------------------

/**
 * The two exports as rows: totals [{date, Critical, High, Medium, Low}] by week, and fixed
 * [{date, severity, count}]. `totals` / `fixed` are the parser's weekly series
 * ({ weeks: ['2026-06-20', …], bySeverity: { Critical: [n, …], … } }).
 */
export function seriesRows(totals, fixed) {
  const weeks = Array.isArray(totals?.weeks) ? totals.weeks : [];
  const totalRows = weeks
    .map((week, i) => ({ date: week, ...Object.fromEntries(SEVERITIES.map((s) => [s, Number(totals.bySeverity?.[s]?.[i]) || 0])) }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}/.test(r.date))
    .sort((a, b) => a.date.localeCompare(b.date));
  const fixedRows = [];
  (Array.isArray(fixed?.weeks) ? fixed.weeks : []).forEach((week, i) => {
    for (const s of SEVERITIES) {
      const count = Number(fixed.bySeverity?.[s]?.[i]) || 0;
      if (count && /^\d{4}-\d{2}-\d{2}/.test(week)) fixedRows.push({ date: week, severity: s, count });
    }
  });
  fixedRows.sort((a, b) => a.date.localeCompare(b.date));
  return { totalRows, fixedRows };
}

const daysBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;

/**
 * Where the backlog stands: the latest week against `lookbackMonths` before (0: the week before),
 * per severity: open now and then, fixed in between, how much the debt grew and the fix rate.
 * Also the month-end backlog history and its average monthly change over the last 3 months.
 */
export function analyse(totalRows, fixedRows, lookbackMonths = DEFAULT_TR.lookbackMonths) {
  if (!totalRows.length) return null;
  const latest = totalRows[totalRows.length - 1];
  let previous = totalRows.length > 1 ? totalRows[totalRows.length - 2] : totalRows[0];
  if (lookbackMonths > 0) {
    previous = totalRows[0];
    for (const row of totalRows) if (daysBetween(row.date, latest.date) >= Math.round(lookbackMonths * 30.4)) previous = row;
  }
  const fixedSince = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const r of fixedRows) if (r.date > previous.date && r.date <= latest.date) fixedSince[r.severity] += r.count;
  const perSeverity = {};
  for (const s of SEVERITIES) {
    const current = latest[s];
    const prior = previous[s];
    perSeverity[s] = { current, prior, fixed: fixedSince[s], debtRate: prior ? ((current - prior) / prior) * 100 : null, fixRate: current ? (fixedSince[s] / current) * 100 : null };
  }
  // New findings a month over the lookback: what the backlog grew by, plus what was fixed meanwhile.
  const spanMonths = Math.max(0.25, daysBetween(previous.date, latest.date) / 30.44);
  for (const s of SEVERITIES) perSeverity[s].arrivals = Math.max(0, (perSeverity[s].current - perSeverity[s].prior + perSeverity[s].fixed) / spanMonths);
  const sum = (key) => SEVERITIES.reduce((a, s) => a + perSeverity[s][key], 0);
  const total = { current: sum('current'), prior: sum('prior'), fixed: sum('fixed'), arrivals: sum('arrivals') };
  total.debtRate = total.prior ? ((total.current - total.prior) / total.prior) * 100 : null;
  total.fixRate = total.current ? (total.fixed / total.current) * 100 : null;
  // Debt against fixes, a month, on one footing: what new findings add and what fixes take away,
  // each as a share of today's backlog; their difference is how fast the backlog moves.
  for (const x of [...SEVERITIES.map((s) => perSeverity[s]), total]) {
    x.fixedMonthly = x.fixed / spanMonths;
    x.netMonthly = x.arrivals - x.fixedMonthly;
    x.addedPct = x.current ? (x.arrivals / x.current) * 100 : null;
    x.fixedPct = x.current ? (x.fixedMonthly / x.current) * 100 : null;
  }
  // The last week of each month stands for the month.
  const byMonth = new Map();
  for (const r of totalRows) byMonth.set(monthKey(r.date), r);
  const history = [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, r]) => ({ month, ...Object.fromEntries(SEVERITIES.map((s) => [s, r[s]])), open: SEVERITIES.reduce((a, s) => a + r[s], 0) }));
  const tail = history.slice(-4);
  const avgChange = (key) => (tail.length < 2 ? 0 : (tail[tail.length - 1][key] - tail[0][key]) / (tail.length - 1));
  return {
    latestDate: latest.date,
    previousDate: previous.date,
    lookbackMonths,
    spanMonths,
    perSeverity,
    total,
    history,
    monthlyChange: avgChange('open'),
    monthlyChangeBySeverity: Object.fromEntries(SEVERITIES.map((s) => [s, avgChange(s)])),
  };
}

/** The plan's credits per severity and in total. `plan` = { selected, triageCost, fpPercent, remediationCost } by severity. */
export function trCost(analysis, plan) {
  const rows = {};
  const totals = { backlog: 0, selected: 0, truePositives: 0, triageCredits: 0, remediationCredits: 0, credits: 0, backlogAfter: 0 };
  for (const s of SEVERITIES) {
    const backlog = analysis?.perSeverity[s].current ?? 0;
    const selected = clamp(wholeNumber(plan.selected?.[s]) ?? 0, 0, backlog);
    const triageCost = amount(plan.triageCost?.[s]) ?? DEFAULT_TR.triageCost[s];
    const fp = clamp(amount(plan.fpPercent?.[s]) ?? DEFAULT_TR.fpPercent[s], 0, 100);
    const remediationCost = amount(plan.remediationCost?.[s]) ?? DEFAULT_TR.remediationCost[s];
    const truePositives = selected * (1 - fp / 100);
    const triageCredits = selected * triageCost;
    const remediationCredits = truePositives * remediationCost;
    const row = { backlog, selected, triageCost, fp, remediationCost, truePositives, triageCredits, remediationCredits, credits: triageCredits + remediationCredits, backlogAfter: backlog - selected };
    rows[s] = row;
    for (const key of Object.keys(totals)) totals[key] += row[key];
  }
  return { rows, totals };
}

/** Findings to triage per severity: the plan's number, or every open one when it is not set (null). */
export function resolveSelected(analysis, selected = {}) {
  return Object.fromEntries(SEVERITIES.map((s) => {
    const open = analysis?.perSeverity[s].current ?? 0;
    const n = selected?.[s];
    return [s, n === null || n === undefined ? open : clamp(wholeNumber(n) ?? 0, 0, open)];
  }));
}

/** The assumptions about what is still to come, made safe to compute with. */
export function aheadSettings(value = {}) {
  const v = value && typeof value === 'object' ? value : {};
  const pct = (x, fallback, hi) => clamp(amount(x) ?? fallback, 0, hi);
  return {
    includeFuture: v.includeFuture !== false,
    fusionUpliftPercent: pct(v.fusionUpliftPercent, DEFAULT_TR.fusionUpliftPercent, 300),
    faePercent: pct(v.faePercent, DEFAULT_TR.faePercent, 100),
    aiDeclinePercent: pct(v.aiDeclinePercent, DEFAULT_TR.aiDeclinePercent, 20),
  };
}

/**
 * How many months' worth of new findings arrive over `months` when each month brings
 * `declinePercent` fewer than the one before (the first at today's pace): 12 at 0%, about 10.9 at 2%.
 */
export function aheadMonths(months, declinePercent = 0) {
  const keep = 1 - clamp(Number(declinePercent) || 0, 0, 100) / 100;
  let total = 0;
  for (let m = 0; m < months; m += 1) total += keep ** m;
  return total;
}

/**
 * The credits over the projection period, per severity: the backlog chosen now, the findings still
 * to come at the lookback's pace, the extra Fusion reports (when Fusion is part of it) on both,
 * less the false positives FAE keeps from being reported. FAE never removes more than the false
 * positives among the new findings, so true positives (what remediation pays for) stay the same.
 * `plan` = the saved T&R plan; `months` the projection period; `fusion` whether Fusion is in it.
 */
export function trProjection(analysis, plan = {}, { months = 12, fusion = false } = {}) {
  const ahead = aheadSettings(plan);
  const selected = resolveSelected(analysis, plan.selected);
  const period = clamp(Number(months) || 12, 1, 60);
  const paced = aheadMonths(period, ahead.aiDeclinePercent);
  const rows = {};
  const keys = ['backlog', 'selected', 'arrivals', 'future', 'fusionExtra', 'faeAvoided', 'toTriage', 'truePositives', 'triageCredits', 'remediationCredits', 'credits', 'backlogCredits', 'aheadCredits', 'backlogAfter'];
  const totals = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const s of SEVERITIES) {
    const backlog = analysis?.perSeverity[s].current ?? 0;
    const triageCost = amount(plan.triageCost?.[s]) ?? DEFAULT_TR.triageCost[s];
    const fp = clamp(amount(plan.fpPercent?.[s]) ?? DEFAULT_TR.fpPercent[s], 0, 100);
    const remediationCost = amount(plan.remediationCost?.[s]) ?? DEFAULT_TR.remediationCost[s];
    const chosen = selected[s];
    // New findings in the same share as the backlog chosen for this severity: none chosen, none to come.
    const share = backlog > 0 ? chosen / backlog : 1;
    const arrivals = ahead.includeFuture ? (analysis?.perSeverity[s].arrivals ?? 0) * share : 0;
    const future = arrivals * paced;
    const fusionExtra = fusion ? ((chosen + future) * ahead.fusionUpliftPercent) / 100 : 0;
    const fresh = future + fusionExtra;
    const faeAvoided = Math.min((fresh * ahead.faePercent) / 100, (fresh * fp) / 100);
    const reported = chosen + fresh;
    const toTriage = reported - faeAvoided;
    const truePositives = reported * (1 - fp / 100);
    const triageCredits = toTriage * triageCost;
    const remediationCredits = truePositives * remediationCost;
    const backlogCredits = chosen * triageCost + chosen * (1 - fp / 100) * remediationCost;
    const row = { backlog, selected: chosen, share, arrivals, future, fusionExtra, faeAvoided, toTriage, truePositives, triageCost, fp, remediationCost, triageCredits, remediationCredits, credits: triageCredits + remediationCredits, backlogCredits, aheadCredits: triageCredits + remediationCredits - backlogCredits, backlogAfter: backlog - chosen };
    rows[s] = row;
    for (const k of keys) totals[k] += row[k];
  }
  return { rows, totals, months: period, paced, ahead, fusion: Boolean(fusion) };
}

const addMonths = (month, n) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};

/** Backlog history and 6 months ahead: as it goes (no action), and with the plan's findings fixed now. */
export function backlogForecast(analysis, fixedNow, months = 6) {
  if (!analysis?.history.length) return [];
  const points = analysis.history.map((h) => ({ month: h.month, actual: h.open, forecast: null, withPlan: null }));
  const last = points[points.length - 1];
  let f = last.actual;
  let w = Math.max(0, last.actual - fixedNow);
  last.forecast = f;
  last.withPlan = w;
  for (let i = 1; i <= months; i += 1) {
    f = Math.max(0, f + analysis.monthlyChange);
    w = Math.max(0, w + analysis.monthlyChange);
    points.push({ month: addMonths(analysis.history[analysis.history.length - 1].month, i), actual: null, forecast: f, withPlan: w });
  }
  return points;
}

/** Per severity: history, then 3 months with the plan's findings fixed evenly over them. */
export function severityForecast(analysis, cost, months = 3) {
  if (!analysis?.history.length) return [];
  const points = analysis.history.map((h) => ({ month: h.month, ...Object.fromEntries(SEVERITIES.flatMap((s) => [[s, h[s]], [`${s}F`, null]])) }));
  const last = points[points.length - 1];
  const now = {};
  for (const s of SEVERITIES) now[s] = last[`${s}F`] = last[s];
  for (let i = 1; i <= months; i += 1) {
    const p = { month: addMonths(last.month, i) };
    for (const s of SEVERITIES) {
      now[s] = Math.max(0, now[s] + analysis.monthlyChangeBySeverity[s] - cost.rows[s].selected / months);
      p[s] = null;
      p[`${s}F`] = now[s];
    }
    points.push(p);
  }
  return points;
}

/**
 * How the backlog still moves each month with the plan: what it is not triaging keeps its own trend.
 * With findings still to come counted, that is the share of each severity not chosen; without, all of it.
 */
function untriagedDrift(analysis, projection) {
  const { rows, ahead } = projection;
  return SEVERITIES.reduce((sum, s) => sum + (analysis.monthlyChangeBySeverity?.[s] ?? 0) * (ahead.includeFuture ? 1 - (rows[s]?.share ?? 1) : 1), 0);
}

/**
 * Backlog by month, then over the projection period: as it goes (the lookback's net change each
 * month), and with the plan: the chosen backlog worked down evenly, new findings triaged as they come.
 */
export function planForecast(analysis, projection) {
  if (!analysis?.history.length || !projection) return [];
  const points = analysis.history.map((h) => ({ month: h.month, actual: h.open, asIs: null, withPlan: null }));
  const last = points[points.length - 1];
  last.asIs = last.actual;
  last.withPlan = last.actual;
  const { months, totals } = projection;
  const drift = untriagedDrift(analysis, projection);
  for (let i = 1; i <= months; i += 1) {
    points.push({
      month: addMonths(last.month, i),
      actual: null,
      asIs: Math.max(0, last.actual + analysis.monthlyChange * i),
      withPlan: Math.max(0, last.actual - (totals.selected * i) / months + drift * i),
    });
  }
  return points;
}

/** Per severity: the backlog by month, then with the plan over the projection period (one small chart each). */
export function severityPlan(analysis, projection) {
  if (!analysis?.history.length || !projection) return {};
  const out = {};
  for (const s of SEVERITIES) {
    const points = analysis.history.map((h) => ({ month: h.month, actual: h[s], withPlan: null }));
    const last = points[points.length - 1];
    last.withPlan = last.actual;
    const { months, rows, ahead } = projection;
    for (let i = 1; i <= months; i += 1) {
      const drift = analysis.monthlyChangeBySeverity[s] * (ahead.includeFuture ? 1 - (rows[s].share ?? 1) : 1) * i;
      points.push({ month: addMonths(last.month, i), actual: null, withPlan: Math.max(0, last.actual - (rows[s].selected * i) / months + drift) });
    }
    out[s] = points;
  }
  return out;
}

/** The last `weeks` weeks: the backlog, what was fixed, the fix rate and how fast the debt grew. */
export function weeklyTrend(totalRows, fixedRows, weeks = 52) {
  const fixedByWeek = new Map();
  for (const r of fixedRows) fixedByWeek.set(r.date, (fixedByWeek.get(r.date) ?? 0) + r.count);
  const rows = totalRows.slice(-weeks);
  const out = rows.map((r, i) => {
    const backlog = SEVERITIES.reduce((a, s) => a + r[s], 0);
    const fixed = fixedByWeek.get(r.date) ?? 0;
    const prev = i ? SEVERITIES.reduce((a, s) => a + rows[i - 1][s], 0) : null;
    // Added: what the backlog grew by plus what was fixed; added and fixed as a share of the week's starting backlog.
    const added = prev === null ? null : Math.max(0, backlog - prev + fixed);
    return { date: r.date, backlog, fixed, fixRate: backlog ? (fixed / backlog) * 100 : null, debtRate: prev ? ((backlog - prev) / prev) * 100 : null, added, addedRate: prev ? (added / prev) * 100 : null, fixedRate: prev ? (fixed / prev) * 100 : null };
  });
  // The same rates over the last 4 weeks: a week alone jumps about too much to read a trend from.
  out.forEach((w, i) => {
    const span = out.slice(Math.max(0, i - 3), i + 1);
    const avg = (key) => {
      const vals = span.map((x) => x[key]).filter((v) => v !== null && Number.isFinite(v));
      return vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null;
    };
    w.fixRate4 = avg('fixRate');
    w.debtRate4 = avg('debtRate');
    w.addedRate4 = avg('addedRate');
    w.fixedRate4 = avg('fixedRate');
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Fusion
// ---------------------------------------------------------------------------------------------

/**
 * How often a project is scanned, slowest last. `days` is the longest average gap between scans
 * the bucket takes, with some slack (26 scans a year is every 14.04 days: once in 2 weeks).
 */
export const FREQUENCIES = [
  { id: 'more-5-week', label: 'More than 5 times a week', days: 7 / 5.0001, perYear: 52 },
  { id: '1-5-week', label: '1 to 5 times a week', days: 7.5, perYear: 26 },
  { id: '2-weeks', label: 'About once in 2 weeks', days: 15.5, perYear: 12 },
  { id: 'month', label: 'About once a month', days: 31.5, perYear: 6 },
  { id: '2-months', label: 'About once in 2 months', days: 63, perYear: 4 },
  { id: '3-months', label: 'About once in 3 months', days: 95, perYear: 4 },
  { id: '6-months', label: 'About once in 6 months', days: 190, perYear: 2 },
  { id: 'year', label: 'About once a year', days: 366, perYear: 1 },
  { id: 'rare', label: 'Not in the last year', days: Infinity, perYear: 1 },
];
export const CRITICALITIES = [5, 4, 3, 2, 1];
export const COMBINE = ['higher', 'frequency', 'criticality'];

/**
 * A project's scan frequency from its completed scans: how many in the window (`windowDays`, up
 * to a year, shorter for a newer project). No scan in the window: "Not in the last year".
 */
export function frequencyOf(scanCount, windowDays) {
  const count = wholeNumber(scanCount) ?? 0;
  const days = Math.max(1, Number(windowDays) || 365);
  if (!count) return { id: 'rare', perWeek: 0 };
  const gap = days / count;
  const found = FREQUENCIES.find((f) => gap <= f.days) ?? FREQUENCIES[FREQUENCIES.length - 1];
  return { id: found.id, perWeek: (count / days) * 7 };
}

/** Fusion scans suggested for a frequency over `periodMonths`: never more than the scans it runs today. */
export function suggestedScans(frequencyId, periodMonths = 12) {
  const f = FREQUENCIES.find((x) => x.id === frequencyId) ?? FREQUENCIES[FREQUENCIES.length - 1];
  return Math.max(1, Math.ceil((f.perYear * clamp(Number(periodMonths) || 12, 1, 60)) / 12));
}

/** 10K units a project counts as: its own lines, rounded up. No lines, no unit. */
export function unitsOf(loc) {
  const lines = wholeNumber(loc);
  return lines ? Math.ceil(lines / UNIT_LOC) : 0;
}

export const linesOf = (project) => wholeNumber(project?.locOverride) ?? wholeNumber(project?.loc);

/** The Fusion settings, made safe to compute with. */
export function fusionSettings(value = {}) {
  const v = value && typeof value === 'object' ? value : {};
  const models = (Array.isArray(v.models) ? v.models : []).slice(0, 20).map((m, i) => ({
    id: String(m?.id ?? `model-${i + 1}`).slice(0, 60) || `model-${i + 1}`,
    name: String(m?.name ?? '').trim().slice(0, 80),
    description: String(m?.description ?? '').trim().slice(0, 200),
    creditsPer10k: amount(m?.creditsPer10k),
    source: m?.source === 'tenant' ? 'tenant' : 'manual',
  }));
  const ids = new Set(models.map((m) => m.id));
  const model = (id) => (ids.has(String(id ?? '')) ? String(id) : null);
  const scans = (n) => {
    const w = wholeNumber(n);
    return w === null ? null : Math.min(w, 10000);
  };
  const rule = (r) => ({ scans: scans(r?.scans), model: model(r?.model) });
  const periodMonths = clamp(wholeNumber(v.periodMonths) ?? 12, 1, 60);
  // A new projection starts from the scans each frequency runs today; one saved keeps what it has.
  const byFrequency = v.byFrequency && typeof v.byFrequency === 'object' ? v.byFrequency : Object.fromEntries(FREQUENCIES.map((f) => [f.id, { scans: suggestedScans(f.id, periodMonths) }]));
  return {
    periodMonths,
    defaultScans: scans(v.defaultScans) ?? 1,
    defaultModel: model(v.defaultModel) ?? models[0]?.id ?? null,
    combine: COMBINE.includes(v.combine) ? v.combine : 'higher',
    models,
    byFrequency: Object.fromEntries(FREQUENCIES.map((f) => [f.id, rule(byFrequency[f.id])])),
    byCriticality: Object.fromEntries(CRITICALITIES.map((c) => [c, rule(v.byCriticality?.[c])])),
  };
}

/** Fusion scans and model for one project under the settings, and where each came from. */
export function allocate(project, settings) {
  const crit = CRITICALITIES.includes(Number(project.criticality)) ? Number(project.criticality) : null;
  const freq = settings.byFrequency[project.frequency] ?? { scans: null, model: null };
  const byCrit = crit ? settings.byCriticality[crit] : { scans: null, model: null };
  let scans = settings.defaultScans;
  let from = 'default';
  const f = freq.scans;
  const c = byCrit.scans;
  if (f !== null || c !== null) {
    if (settings.combine === 'frequency') [scans, from] = f !== null ? [f, 'frequency'] : [c, 'criticality'];
    else if (settings.combine === 'criticality') [scans, from] = c !== null ? [c, 'criticality'] : [f, 'frequency'];
    else [scans, from] = (f ?? -1) >= (c ?? -1) ? [f, 'frequency'] : [c, 'criticality'];
  }
  const override = wholeNumber(project.scansOverride);
  if (override !== null) [scans, from] = [override, 'project'];
  const modelOrder = settings.combine === 'criticality' ? [byCrit.model, freq.model] : [freq.model, byCrit.model];
  const model = (project.modelOverride && settings.models.some((m) => m.id === project.modelOverride) ? project.modelOverride : null) ?? modelOrder.find(Boolean) ?? settings.defaultModel;
  return { scans, from, model };
}

/**
 * Every project's Fusion need over the period, most often scanned first: 10K units × scans ×
 * the model's credits per 10K LOC. A model without a rate leaves the project's credits unknown.
 */
export function fusionEstimate(projects = [], value = {}) {
  const settings = fusionSettings(value);
  const models = new Map(settings.models.map((m) => [m.id, m]));
  const order = new Map(FREQUENCIES.map((f, i) => [f.id, i]));
  const rows = projects.map((p) => {
    const lines = linesOf(p);
    const included = p.included !== false;
    const units = unitsOf(lines);
    const { scans, from, model } = allocate(p, settings);
    const rate = models.get(model)?.creditsPer10k ?? null;
    const credits = included && units && rate !== null ? units * scans * rate : included && units && scans ? null : 0;
    return { ...p, lines, included, units, scans, scansFrom: from, model, rate, credits, unknownLines: lines === null, unknownRate: included && units > 0 && scans > 0 && rate === null };
  });
  rows.sort((a, b) => (order.get(a.frequency) ?? 99) - (order.get(b.frequency) ?? 99) || (b.scansPerWeek ?? 0) - (a.scansPerWeek ?? 0) || String(a.name).localeCompare(String(b.name)));
  const counted = rows.filter((r) => r.included && r.units);
  const totals = {
    projects: counted.length,
    lines: counted.reduce((a, r) => a + r.lines, 0),
    units: counted.reduce((a, r) => a + r.units, 0),
    scans: counted.reduce((a, r) => a + r.scans, 0),
    unitScans: counted.reduce((a, r) => a + r.units * r.scans, 0),
    credits: counted.reduce((a, r) => a + (r.credits ?? 0), 0),
    unknownLines: rows.filter((r) => r.included && r.unknownLines).length,
    unknownRate: rows.filter((r) => r.unknownRate).length,
  };
  const byFrequency = FREQUENCIES.map((f) => {
    const mine = counted.filter((r) => r.frequency === f.id);
    return { id: f.id, projects: rows.filter((r) => r.frequency === f.id).length, units: mine.reduce((a, r) => a + r.units, 0), scans: mine.reduce((a, r) => a + r.scans, 0), credits: mine.reduce((a, r) => a + (r.credits ?? 0), 0) };
  });
  const byModel = settings.models.map((m) => {
    const mine = counted.filter((r) => r.model === m.id);
    return { id: m.id, name: m.name, rate: m.creditsPer10k, projects: mine.length, unitScans: mine.reduce((a, r) => a + r.units * r.scans, 0), credits: mine.reduce((a, r) => a + (r.credits ?? 0), 0) };
  });
  return { settings, rows, totals, byFrequency, byModel };
}

// --- Credits required: both parts, the extra asked for on top, and the bundles that buys --------

export const BUNDLE_CREDITS = 10000;
export const MAX_EXTRA_PERCENT = 500;

/** The extra credits (a % on top of what is worked out) and the credits in one bundle, cleaned. */
export function totalsSettings(value = {}) {
  const extra = amount(value?.extraPercent);
  const bundle = wholeNumber(value?.bundleCredits);
  return {
    extraPercent: extra === null ? 0 : Math.round(clamp(extra, 0, MAX_EXTRA_PERCENT) * 100) / 100,
    bundleCredits: bundle ? clamp(bundle, 1, 100000000) : BUNDLE_CREDITS,
  };
}

/**
 * The credits required: triage & remediation plus Fusion (either may be null: not worked out),
 * the extra % on top, and the bundles that covers: total ÷ credits per bundle, rounded up to a
 * whole bundle (exactBundles keeps the fraction).
 */
export function creditSummary(trCredits, fusionCredits, value = {}) {
  const settings = totalsSettings(value);
  const tr = Number.isFinite(trCredits) ? trCredits : null;
  const fusion = Number.isFinite(fusionCredits) ? fusionCredits : null;
  const base = (tr ?? 0) + (fusion ?? 0);
  const extra = (base * settings.extraPercent) / 100;
  const total = base + extra;
  const exactBundles = total / settings.bundleCredits;
  return { settings, tr, fusion, base, extra, total, exactBundles, bundles: total > 0 ? Math.ceil(exactBundles - 1e-9) : 0 };
}

// ---------------------------------------------------------------------------------------------
// Which projects count: the same choices as narrowing the Dashboard, for both parts
// ---------------------------------------------------------------------------------------------

const MAX_SCOPE_ITEMS = 50;
const list = (value, max, size = MAX_SCOPE_ITEMS) =>
  [...new Set((Array.isArray(value) ? value : []).map((v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)).filter(Boolean))].slice(0, size);

/**
 * The scope, cleaned: applications, groups and people (who ran the last scan) by name, scan
 * frequencies, criticalities, and project names with wildcards (* any text, ? one character).
 * Empty everywhere: every project.
 */
export function cleanScope(value = {}) {
  const v = value && typeof value === 'object' ? value : {};
  const ids = new Set(FREQUENCIES.map((f) => f.id));
  return {
    applications: list(v.applications, 200),
    // Projects picked one by one, by id.
    projects: list(v.projects, 200, 5000),
    groups: list(v.groups, 200),
    initiators: list(v.initiators, 254),
    names: list(v.names, 100, 20),
    frequencies: list(v.frequencies, 20).filter((f) => ids.has(f)),
    criticalities: [...new Set((Array.isArray(v.criticalities) ? v.criticalities : []).map(Number).filter((c) => CRITICALITIES.includes(c)))],
    // Projects whose latest scan counted no lines of code are left out unless kept; those with no open finding, when asked.
    leaveOutNoCode: v.leaveOutNoCode !== false,
    leaveOutNoFindings: v.leaveOutNoFindings === true,
  };
}

/** Is anything picked (applications, projects, groups, names, people, frequencies, criticalities)? */
export const scopeActive = (scope) => Object.values(cleanScope(scope)).some((v) => Array.isArray(v) && v.length);

/** A project's open findings now, of these engines (every engine when none given); null when not known. */
export function openFindings(project, engines = null) {
  const by = project?.openByEngine;
  if (!by || typeof by !== 'object') return null;
  const keys = Array.isArray(engines) && engines.length ? engines : Object.keys(by);
  return keys.reduce((n, key) => n + (Number(by[key]) || 0), 0);
}

/**
 * Does `text` match `pattern`, ignoring case? `*` is any text, `?` one character. A linear walk
 * with one step back to the last `*`, so no pattern can make it slow.
 */
export function globMatch(pattern, text) {
  const p = String(pattern ?? '').toLowerCase();
  const t = String(text ?? '').toLowerCase();
  let i = 0;
  let j = 0;
  let star = -1;
  let mark = 0;
  while (j < t.length) {
    if (i < p.length && (p[i] === '?' || p[i] === t[j])) {
      i += 1;
      j += 1;
    } else if (i < p.length && p[i] === '*') {
      star = i;
      mark = j;
      i += 1;
    } else if (star !== -1) {
      i = star + 1;
      mark += 1;
      j = mark;
    } else return false;
  }
  while (i < p.length && p[i] === '*') i += 1;
  return i === p.length;
}

/**
 * Is this project in the scope? Every choice made must hold (any one of its values will do). `engines`:
 * the engines counted, for "no open findings".
 */
export function inScope(project, scope, engines = null) {
  const sc = cleanScope(scope);
  // Nothing to analyse: no lines of code in its scan, or (when asked) no open finding of these engines. Unknown is kept.
  if (sc.leaveOutNoCode && linesOf(project) === 0) return false;
  if (sc.leaveOutNoFindings && openFindings(project, engines) === 0) return false;
  const lower = (v) => String(v ?? '').toLowerCase();
  const anyOf = (wanted, have) => !wanted.length || (Array.isArray(have) ? have : [have]).some((h) => wanted.some((w) => lower(w) === lower(h)));
  // Applications and projects picked: these applications' projects, plus these projects (as on the Dashboard).
  if (sc.applications.length || sc.projects.length) {
    const byApp = sc.applications.length > 0 && anyOf(sc.applications, project?.applications ?? []);
    const byId = sc.projects.includes(String(project?.id ?? ''));
    if (!byApp && !byId) return false;
  }
  if (!anyOf(sc.groups, project?.groups ?? [])) return false;
  if (!anyOf(sc.initiators, project?.initiator ?? '')) return false;
  if (sc.frequencies.length && !sc.frequencies.includes(project?.frequency)) return false;
  if (sc.criticalities.length && !sc.criticalities.includes(Number(project?.criticality))) return false;
  if (sc.names.length && !sc.names.some((pattern) => globMatch(pattern.includes('*') || pattern.includes('?') ? pattern : `*${pattern}*`, project?.name))) return false;
  return true;
}
