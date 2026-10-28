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
// reports once it scans the code.
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
  lookbackMonths: 12,
  includeFuture: true,
  fusionUpliftPercent: 5,
  // New findings fall as teams adopt AI (assist, triage, remediation): this much fewer over a year.
  aiDeclinePercent: 2,
});
// The trend is always read over months (a single week says too little to project from).
export const LOOKBACKS = [3, 6, 9, 12];
export const UNIT_LOC = 10000;
// Projects one read from Checkmarx One takes: 10,000 unless the customer sets another number, never
// more than MAX_PROJECTS (also the most a customer or a report keeps).
export const DEFAULT_READ_PROJECTS = 10_000;
export const MAX_PROJECTS = 50_000;

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

/** How many projects a read takes: the number set (1 to MAX_PROJECTS), else DEFAULT_READ_PROJECTS. */
export function readLimit(value) {
  const n = wholeNumber(value);
  return n ? clamp(n, 1, MAX_PROJECTS) : DEFAULT_READ_PROJECTS;
}
const monthKey = (iso) => String(iso).slice(0, 7);

// ---------------------------------------------------------------------------------------------
// Triage & remediation
// ---------------------------------------------------------------------------------------------

/**
 * The two exports as rows: totals [{date, Critical, High, Medium, Low}] by week, and fixed
 * [{date, severity, count}]. `totals` / `fixed` are the parser's weekly series
 * ({ weeks: ['2026-06-20', …], bySeverity: { Critical: [n, …], … } }).
 */
export function seriesRows(totals, fixed, part = 'bySeverity') {
  const weeks = Array.isArray(totals?.weeks) ? totals.weeks : [];
  const totalRows = weeks
    .map((week, i) => ({ date: week, ...Object.fromEntries(SEVERITIES.map((s) => [s, Number(totals[part]?.[s]?.[i]) || 0])) }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}/.test(r.date))
    .sort((a, b) => a.date.localeCompare(b.date));
  const fixedRows = [];
  (Array.isArray(fixed?.weeks) ? fixed.weeks : []).forEach((week, i) => {
    for (const s of SEVERITIES) {
      const count = Number(fixed[part]?.[s]?.[i]) || 0;
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
    aiDeclinePercent: pct(v.aiDeclinePercent, DEFAULT_TR.aiDeclinePercent, 90),
  };
}

/**
 * How many months' worth of new findings arrive over `months` when they fall by `declinePercent`
 * over a year, a little each month (the first at today's pace): 12 at 0%, about 11.9 at 2%.
 */
export function aheadMonths(months, declinePercent = 0) {
  const keep = (1 - clamp(Number(declinePercent) || 0, 0, 100) / 100) ** (1 / 12);
  let total = 0;
  for (let m = 0; m < months; m += 1) total += keep ** m;
  return total;
}

/**
 * The credits over the projection period, per severity: the backlog chosen now, the findings still
 * to come at the lookback's pace, and the extra Fusion reports (when Fusion is part of it) on both.
 * `plan` = the saved T&R plan; `months` the projection period; `fusion` whether Fusion is in it.
 * Fusion finds more SAST findings only: `sast` is the analysis of SAST's own part, so its extra
 * findings are counted on SAST's share of each severity's backlog and new findings. Without it (the
 * two exports, a read that counted every engine together) they are counted on every finding.
 */
export function trProjection(analysis, plan = {}, { months = 12, fusion = false, sast = null } = {}) {
  const ahead = aheadSettings(plan);
  const selected = resolveSelected(analysis, plan.selected);
  const period = clamp(Number(months) || 12, 1, 60);
  const paced = aheadMonths(period, ahead.aiDeclinePercent);
  const rows = {};
  const keys = ['backlog', 'selected', 'arrivals', 'future', 'fusionBase', 'fusionExtra', 'toTriage', 'truePositives', 'triageCredits', 'remediationCredits', 'credits', 'backlogCredits', 'aheadCredits', 'backlogAfter'];
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
    // The SAST findings among those chosen and still to come, in SAST's share of the backlog and of new findings.
    const part = (own, all) => (!sast ? 1 : all > 0 ? clamp(own / all, 0, 1) : 0);
    const fusionBase = chosen * part(sast?.perSeverity[s].current ?? 0, backlog) + future * part(sast?.perSeverity[s].arrivals ?? 0, analysis?.perSeverity[s].arrivals ?? 0);
    const fusionExtra = fusion ? (fusionBase * ahead.fusionUpliftPercent) / 100 : 0;
    const reported = chosen + future + fusionExtra;
    const toTriage = reported;
    const truePositives = reported * (1 - fp / 100);
    const triageCredits = toTriage * triageCost;
    const remediationCredits = truePositives * remediationCost;
    const backlogCredits = chosen * triageCost + chosen * (1 - fp / 100) * remediationCost;
    const row = { backlog, selected: chosen, share, arrivals, future, fusionBase, fusionExtra, toTriage, truePositives, triageCost, fp, remediationCost, triageCredits, remediationCredits, credits: triageCredits + remediationCredits, backlogCredits, aheadCredits: triageCredits + remediationCredits - backlogCredits, backlogAfter: backlog - chosen };
    rows[s] = row;
    for (const k of keys) totals[k] += row[k];
  }
  return { rows, totals, months: period, paced, ahead, fusion: Boolean(fusion), sastOnly: Boolean(sast) };
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

/**
 * The models Checkmarx One offers a Fusion scan (its "LLM Model" setting, scan.config.ai.llmModel), as a new
 * customer starts with them: named, their credits per 10K lines of code left to type (no API says them).
 */
export const CHECKMARX_MODELS = Object.freeze(['opus-4.7', 'haiku-4.5', 'opus-5.0', 'opus-5.5', 'mythos-5.1']);
/** Models by name, as the calculator keeps them: `source` 'tenant' when read from Checkmarx One, else 'catalog'. */
export const modelsNamed = (names = CHECKMARX_MODELS, source = 'catalog') =>
  [...new Set(names.map((n) => String(n ?? '').trim()).filter(Boolean))].slice(0, 20).map((name) => ({ id: `cx-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 60), name: name.slice(0, 80), description: '', creditsPer10k: null, source }));

/** The Fusion settings, made safe to compute with. */
export function fusionSettings(value = {}) {
  const v = value && typeof value === 'object' ? value : {};
  const models = (Array.isArray(v.models) ? v.models : []).slice(0, 20).map((m, i) => ({
    id: String(m?.id ?? `model-${i + 1}`).slice(0, 60) || `model-${i + 1}`,
    name: String(m?.name ?? '').trim().slice(0, 80),
    description: String(m?.description ?? '').trim().slice(0, 200),
    creditsPer10k: amount(m?.creditsPer10k),
    source: m?.source === 'tenant' || m?.source === 'catalog' ? m.source : 'manual',
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
    // The customer opted out of Fusion: nothing of it is counted.
    optOut: v.optOut === true,
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

// --- Fusion for a new customer: code not in Checkmarx One yet, its lines counted with cloc -------
//
// The customer runs cloc (github.com/AlDanial/cloc, Count Lines of Code) on each repository and sends
// the report: per language, its files, blank, comment and code lines. Only code lines count, and only
// for languages Fusion scans: documentation, data and markup are left out (the reader can change that).

/** Languages cloc reports that are not code Fusion scans: left out unless the reader counts them. */
export const CLOC_LEFT_OUT = Object.freeze(['JSON', 'YAML', 'Markdown', 'XML', 'CSV', 'Text', 'SVG', 'HTML']);
export const MAX_CLOC_LANGUAGES = 80;
/** Fusion scans a new customer's project is given over the period, until the reader says otherwise. */
export const NEW_CUSTOMER_SCANS = 12;
const CLOC_META = new Set(['header', 'SUM', 'by_file', 'by_lang']);

/** "C:\\code\\payments-api.json" → "payments-api". */
export const clocName = (fileName) => String(fileName ?? '').split(/[\\/]/).pop().replace(/\.(json|csv|txt)$/i, '').replace(/\.cloc$/i, '').trim() || 'Project';

/** One CSV line's fields (cloc quotes a field that has a comma or a quote in it). */
function csvFields(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), (i += 1);
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') out.push(cur), (cur = '');
    else cur += ch;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

/**
 * Files of several repositories (cloc --by-file run on the folder that holds them): grouped by the first
 * folder under what they all share, each group a project.
 */
function byTopFolder(files) {
  const split = files.map((f) => ({ ...f, parts: String(f.path).replace(/\\/g, '/').replace(/^\.\//, '').split('/').filter(Boolean) }));
  const dirs = split.map((f) => f.parts.slice(0, -1));
  let common = 0;
  while (dirs.length && dirs.every((d) => d.length > common && d[common] === dirs[0][common])) common += 1;
  const groups = new Map();
  for (const f of split) {
    // A file straight in the shared folder belongs to a project named after that folder.
    const name = f.parts.length - 1 > common ? f.parts[common] : f.parts[common - 1] ?? 'Project';
    if (!groups.has(name)) groups.set(name, {});
    const langs = groups.get(name);
    langs[f.language] = (langs[f.language] ?? 0) + f.code;
  }
  return [...groups].map(([name, langs]) => ({ name, langs }));
}

const codeOf = (v) => wholeNumber(v?.code) ?? 0;

/**
 * A cloc report as projects: [{ name, langs: { Language: code lines } }]. Reads --json and --csv, for one
 * repository (a project named after the file) or --by-file over many (one project per top folder).
 * Throws with what is wrong when the file is not a cloc report.
 */
export function parseCloc(text, fileName = '') {
  const source = String(text ?? '').replace(/^\uFEFF/, '').trim();
  const name = clocName(fileName);
  const notCloc = () => Object.assign(new Error(`${fileName || 'This file'} is not a cloc report: run cloc with --json or --csv.`), { notCloc: true });
  if (source.startsWith('{')) {
    let json;
    try {
      json = JSON.parse(source);
    } catch {
      throw notCloc();
    }
    const table = json.by_lang && typeof json.by_lang === 'object' ? json.by_lang : json;
    const entries = Object.entries(table).filter(([key, v]) => !CLOC_META.has(key) && v && typeof v === 'object' && 'code' in v);
    if (!entries.length) throw notCloc();
    // --by-file: the keys are files, each naming its language.
    if (entries.every(([, v]) => typeof v.language === 'string')) {
      return byTopFolder(entries.map(([path, v]) => ({ path, language: v.language, code: codeOf(v) })));
    }
    return [{ name, langs: Object.fromEntries(entries.map(([lang, v]) => [lang, codeOf(v)])) }];
  }
  const lines = source.split(/\r?\n/).filter((l) => l.trim());
  const head = csvFields(lines[0] ?? '').map((h) => h.toLowerCase());
  const at = (key) => head.indexOf(key);
  if (at('language') < 0 || at('code') < 0) throw notCloc();
  const rows = lines.slice(1).map(csvFields).filter((r) => r[at('language')] && r[at('language')] !== 'SUM');
  if (at('filename') >= 0) {
    return byTopFolder(rows.map((r) => ({ path: r[at('filename')], language: r[at('language')], code: wholeNumber(r[at('code')]) ?? 0 })));
  }
  return [{ name, langs: Object.fromEntries(rows.map((r) => [r[at('language')], wholeNumber(r[at('code')]) ?? 0])) }];
}

/** A new customer's project's lines: typed, else its code lines in the languages counted. */
export function clocLines(project, leftOut = CLOC_LEFT_OUT) {
  const typed = wholeNumber(project?.locOverride);
  if (typed !== null) return typed;
  const out = new Set(leftOut);
  const langs = project?.langs && typeof project.langs === 'object' ? project.langs : {};
  const keys = Object.keys(langs);
  return keys.length ? keys.filter((l) => !out.has(l)).reduce((n, l) => n + (wholeNumber(langs[l]) ?? 0), 0) : null;
}

/** The new customer page's own choices, made safe to compute with (the models are the Fusion page's). */
export function newCustomerSettings(value = {}) {
  const v = value && typeof value === 'object' ? value : {};
  const scans = wholeNumber(v.defaultScans);
  return {
    defaultScans: scans === null ? NEW_CUSTOMER_SCANS : Math.min(scans, 10000),
    defaultModel: typeof v.defaultModel === 'string' && v.defaultModel ? v.defaultModel.slice(0, 60) : null,
    leftOut: Array.isArray(v.leftOut) ? [...new Set(v.leftOut.map((l) => String(l ?? '').trim().slice(0, 60)).filter(Boolean))].slice(0, MAX_CLOC_LANGUAGES) : [...CLOC_LEFT_OUT],
    optOut: v.optOut === true,
  };
}

const FREQUENCY_IDS = new Set(FREQUENCIES.map((f) => f.id));

/**
 * A new customer's project's change frequency: from the commits on its default branch in the window, as
 * cloc-fusion measured them (Count from git, or its report); null when not known (cloc results, typed, or
 * counted before MZ-01.01.05).
 */
export const changeFrequencyOf = (project) => (FREQUENCY_IDS.has(project?.activity?.frequency) ? project.activity.frequency : null);

/**
 * A new customer's Fusion need over the period, the same way as a customer's in Checkmarx One: each
 * project's lines rounded up to whole 10K units, × its Fusion scans, × its model's credits per 10K.
 * `fusionValue` gives the models, the period and the rules (the Fusion page's). A project whose change
 * frequency is known (commits on its default branch) gets that frequency's Fusion scans and model, as a
 * Checkmarx One project of that scan frequency does, and a criticality its rule, combined as the Fusion
 * page says; one without either gets this tab's own scans and model; one with scans of its own keeps them.
 */
export function newCustomerEstimate(value = {}, fusionValue = {}) {
  const fusion = fusionSettings(fusionValue);
  const own = newCustomerSettings(value);
  const models = new Map(fusion.models.map((m) => [m.id, m]));
  const defaultModel = models.has(own.defaultModel) ? own.defaultModel : fusion.defaultModel;
  // The Fusion page's rules, with this tab's own scans and model where no rule applies.
  const rules = { ...fusion, defaultScans: own.defaultScans, defaultModel };
  const projects = Array.isArray(value?.projects) ? value.projects : [];
  const out = new Set(own.leftOut);
  const rows = projects.map((p) => {
    const lines = clocLines(p, own.leftOut);
    const included = p.included !== false;
    const units = unitsOf(lines);
    const frequency = changeFrequencyOf(p);
    const criticality = CRITICALITIES.includes(Number(p.criticality)) ? Number(p.criticality) : null;
    const { scans, from, model } = allocate({ frequency, criticality, scansOverride: p.scansOverride, modelOverride: p.modelOverride }, rules);
    const rate = models.get(model)?.creditsPer10k ?? null;
    const credits = included && units && rate !== null ? units * scans * rate : included && units && scans ? null : 0;
    const languages = Object.entries(p.langs ?? {})
      .map(([name, n]) => ({ name, lines: wholeNumber(n) ?? 0, counted: !out.has(name) }))
      .sort((a, b) => b.lines - a.lines);
    const devs90 = wholeNumber(p.activity?.devs90);
    const commits = wholeNumber(p.activity?.commits);
    return { ...p, lines, included, units, frequency, criticality, commits, devs90, scans, scansFrom: from, model, rate, credits, languages, unknownLines: lines === null, unknownRate: included && units > 0 && scans > 0 && rate === null };
  });
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
    // Where the scans came from: the change frequency (or criticality), this tab's default, or the project's own.
    byRule: counted.filter((r) => r.scansFrom === 'frequency' || r.scansFrom === 'criticality').length,
    byDefault: counted.filter((r) => r.scansFrom === 'default').length,
    byProject: counted.filter((r) => r.scansFrom === 'project').length,
    // People who committed in the last 90 days, added up per project (one person in two projects counts twice).
    developers: counted.reduce((a, r) => a + (r.devs90 ?? 0), 0),
    withActivity: counted.filter((r) => r.frequency).length,
  };
  const byModel = fusion.models.map((m) => {
    const mine = counted.filter((r) => r.model === m.id);
    return { id: m.id, name: m.name, rate: m.creditsPer10k, projects: mine.length, unitScans: mine.reduce((a, r) => a + r.units * r.scans, 0), credits: mine.reduce((a, r) => a + (r.credits ?? 0), 0) };
  });
  const byFrequency = FREQUENCIES.map((f) => {
    const mine = counted.filter((r) => r.frequency === f.id);
    return { id: f.id, projects: mine.length, units: mine.reduce((a, r) => a + r.units, 0), scans: mine.reduce((a, r) => a + r.scans, 0), credits: mine.reduce((a, r) => a + (r.credits ?? 0), 0) };
  });
  return { settings: { ...own, defaultModel, periodMonths: fusion.periodMonths, models: fusion.models, byFrequency: fusion.byFrequency, combine: fusion.combine }, rows, totals, byModel, byFrequency };
}

// --- A cloc-fusion report (cloc-fusion-report.json): the same projects, measured where the code is --------

/** The largest cloc-fusion report read (its API answers are capped the same). */
export const MAX_CLOC_FUSION_BYTES = 64 * 1024 * 1024;
const LANGUAGE_NAME = /^[\p{L}\p{N} +#./()_'-]{1,60}$/u;
const NOT_A_KEY = new Set(['__proto__', 'constructor', 'prototype']);
const textOf = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isoOf = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);

/**
 * cloc-fusion's JSON report (its src/report/build.js) as new customer projects: one per repository measured, with
 * its code lines by language, commits on the default branch in the window, change frequency, last commit and
 * developers in the last 90 days (a count: the report's names and emails are not read), where it is (its clone
 * address, branch and commit, never a token: the report has none), and the hints its plan gave it (criticality,
 * scans of its own, and a model pinned to it when one of `models` has that model's name). Repositories skipped,
 * failed or not measured are left out and counted. Throws with what is wrong when it is not such a report.
 * {projects, developers, skipped, version, windowDays}.
 */
export function parseClocFusionReport(text, fileName = '', { models = [] } = {}) {
  const notReport = () => Object.assign(new Error(`${fileName || 'This file'} is not a cloc-fusion report: use cloc-fusion-report.json from cloc-fusion's output.`), { notReport: true });
  if (String(text ?? '').length > MAX_CLOC_FUSION_BYTES) throw new Error(`${fileName || 'This file'} is over 64 MB.`);
  let json;
  try {
    json = JSON.parse(String(text ?? '').replace(/^﻿/, ''));
  } catch {
    throw notReport();
  }
  if (!json || typeof json !== 'object' || json.tool !== 'cloc-fusion' || !Array.isArray(json.repos)) throw notReport();
  const windowDefault = clamp(Number(json.settings?.windowDays) || 365, 1, 3660);
  // The plan's models, by id: a repository pinned to one gets this calculator's model of the same name.
  const theirs = new Map((Array.isArray(json.settings?.fusion?.models) ? json.settings.fusion.models : []).map((m) => [String(m?.id ?? ''), String(m?.name ?? '').trim().toLowerCase()]));
  const ours = new Map(models.map((m) => [String(m.name ?? '').trim().toLowerCase(), m.id]));
  let skipped = 0;
  const projects = [];
  for (const r of json.repos.slice(0, MAX_PROJECTS)) {
    if (!r || typeof r !== 'object' || r.skip || r.error || !r.analyzedAt) {
      skipped += 1;
      continue;
    }
    const langs = {};
    for (const [name, t] of Object.entries(r.languages && typeof r.languages === 'object' ? r.languages : {}).slice(0, MAX_CLOC_LANGUAGES)) {
      if (NOT_A_KEY.has(name) || !LANGUAGE_NAME.test(name)) continue;
      langs[name] = wholeNumber(t?.code) ?? 0;
    }
    const loc = wholeNumber(r.locOverride) ?? (Object.keys(langs).length ? null : wholeNumber(r.loc));
    const windowDays = clamp(Number(r.windowDays) || windowDefault, 1, 3660);
    const commits = wholeNumber(r.commits) ?? 0;
    const frequency = FREQUENCY_IDS.has(r.frequency) ? r.frequency : frequencyOf(commits, windowDays).id;
    const pinned = r.modelOverride ? ours.get(theirs.get(String(r.modelOverride)) ?? '') ?? null : null;
    projects.push({
      name: textOf(r.name, 200) || textOf(r.fullName, 200).split('/').pop() || 'Unnamed project',
      fullName: textOf(r.fullName, 300),
      file: textOf(String(fileName).split(/[\\/]/).pop(), 200),
      langs,
      locOverride: loc,
      git: { url: textOf(r.cloneUrl, 500), branch: textOf(r.branch ?? r.defaultBranch, 200), commit: textOf(r.headSha, 40), countedAt: isoOf(r.analyzedAt) },
      activity: { commits, windowDays: Math.round(windowDays * 10) / 10, lastCommitAt: isoOf(r.lastCommitAt), frequency, devs90: wholeNumber(r.devs90), engine: 'report' },
      criticality: CRITICALITIES.includes(Number(r.criticality)) ? Number(r.criticality) : null,
      scansOverride: wholeNumber(r.scansOverride),
      modelOverride: pinned,
    });
  }
  if (!projects.length && !skipped) throw notReport();
  return { projects, developers: wholeNumber(json.developers?.total), skipped, version: textOf(json.version, 20), windowDays: windowDefault };
}

/** Both Fusion parts' credits (the customer's projects in Checkmarx One, and its new code): null when neither counts. */
export function fusionTotal(existing, fresh) {
  const value = (x) => (Number.isFinite(Number(x?.totals?.credits)) && x?.totals?.credits !== null ? Number(x.totals.credits) : null);
  const a = value(existing);
  const b = value(fresh);
  return a === null && b === null ? null : (a ?? 0) + (b ?? 0);
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
    projects: list(v.projects, 200, MAX_PROJECTS),
    groups: list(v.groups, 200),
    initiators: list(v.initiators, 254),
    names: list(v.names, 100, 20),
    frequencies: list(v.frequencies, 20).filter((f) => ids.has(f)),
    criticalities: [...new Set((Array.isArray(v.criticalities) ? v.criticalities : []).map(Number).filter((c) => CRITICALITIES.includes(c)))],
    // Projects whose latest scan counted no lines of code are left out unless kept; those with no open finding, when asked.
    leaveOutNoCode: v.leaveOutNoCode !== false,
    leaveOutNoFindings: v.leaveOutNoFindings === true,
    // How many of the tenant's projects a read takes.
    maxProjects: readLimit(v.maxProjects),
    // The scan origins whose scans count (null: every one, also those a later read finds).
    origins: cleanOrigins(v.origins),
  };
}

/** Scan origins by name ("Jenkins", "CLI"…), each once; null (every origin) unless a list is given. */
export const cleanOrigins = (value) => (Array.isArray(value) ? list(value, 60, 200) : null);

/**
 * A project as only its scans from these scan origins see it (null: every origin): its scans in the year
 * from them and how often that is. null when it has no scan from them (it is left out). A project added by
 * hand, or read before scan origins were recorded, is as it was.
 */
export function byOrigins(project, origins) {
  const own = project?.origins;
  if (!Array.isArray(origins) || project?.source === 'manual' || !own || typeof own !== 'object') return project;
  const all = Object.keys(own);
  const mine = all.filter((o) => origins.includes(o));
  if (!mine.length) return null;
  if (mine.length === all.length) return project;
  const scanCount = mine.reduce((n, o) => n + (wholeNumber(own[o]) ?? 0), 0);
  const f = frequencyOf(scanCount, Number(project.scanDays) || 365);
  return { ...project, scanCount, frequency: f.id, scansPerWeek: Math.round(f.perWeek * 100) / 100 };
}

/**
 * Every scan origin the projects read have, with its scans in the year and the projects scanned from it,
 * most scans first ("Not said" last); [] when the read did not record them.
 */
export function originCounts(projects = []) {
  const by = new Map();
  for (const p of projects) {
    if (p?.source === 'manual' || !p?.origins || typeof p.origins !== 'object') continue;
    for (const [origin, n] of Object.entries(p.origins)) {
      const x = by.get(origin) ?? { origin, scans: 0, projects: 0 };
      x.scans += wholeNumber(n) ?? 0;
      x.projects += 1;
      by.set(origin, x);
    }
  }
  return [...by.values()].sort((a, b) => (a.origin === 'Not said') - (b.origin === 'Not said') || b.scans - a.scans || a.origin.localeCompare(b.origin));
}

/**
 * The settings at the top of the calculator that wait for Apply, and what they are now: every branch,
 * Add Fusion (existing and new customer), the projection period, the extra % and bundle size, and the
 * scope (Projects to read, scan origins, and which projects).
 */
export function topSettings(value = {}) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    allBranches: v.allBranches === true,
    fusionOn: v.fusionOn !== false,
    fusionNewOn: v.fusionNewOn !== false,
    periodMonths: clamp(wholeNumber(v.periodMonths) ?? 12, 1, 60),
    ...totalsSettings(v),
    scope: cleanScope(v.scope),
  };
}

/** What each setting is called where it is changed, in the order the page shows them. */
const SETTING_NAMES = [
  ['allBranches', 'Every branch'],
  ['maxProjects', 'Projects to read'],
  ['fusionOn', 'Add Fusion: Existing customer'],
  ['fusionNewOn', 'Add Fusion: New customer'],
  ['origins', 'Include scans from'],
  ['applications', 'Applications'],
  ['projects', 'Projects'],
  ['leaveOutNoCode', 'Leave out projects with no lines of code'],
  ['leaveOutNoFindings', 'Leave out projects with no open findings'],
  ['groups', 'Groups'],
  ['names', 'Project names'],
  ['initiators', 'Last scanned by'],
  ['frequencies', 'How often they are scanned'],
  ['criticalities', 'Criticality'],
  ['periodMonths', 'Projection period'],
  ['extraPercent', 'Extra credits (%)'],
  ['bundleCredits', 'Credits per bundle'],
];
const SCOPE_KEYS = new Set(['maxProjects', 'origins', 'applications', 'projects', 'leaveOutNoCode', 'leaveOutNoFindings', 'groups', 'names', 'initiators', 'frequencies', 'criticalities']);

/**
 * What changed from `applied` to `next` (both topSettings), each { key, label, reads }: `reads` when it takes
 * reading Checkmarx One again, as the last read (`read`: { at, branches, limit, origins }) cannot answer it:
 * a branch choice it was not made with, more projects than it stopped at, or scan origins it did not record.
 */
export function settingChanges(applied, next, read = {}) {
  const a = topSettings(applied);
  const b = topSettings(next);
  const same = (x, y) => (Array.isArray(x) && Array.isArray(y) ? [...x].map(String).sort().join('\n') === [...y].map(String).sort().join('\n') : x === y);
  const out = [];
  for (const [key, label] of SETTING_NAMES) {
    const from = SCOPE_KEYS.has(key) ? a.scope[key] : a[key];
    const to = SCOPE_KEYS.has(key) ? b.scope[key] : b[key];
    if (same(from, to)) continue;
    let reads = false;
    if (key === 'allBranches') reads = to !== (read.branches === 'all');
    else if (key === 'maxProjects') reads = Boolean(read.at && read.limit && to > read.limit);
    else if (key === 'origins') reads = Boolean(read.at && read.origins === false);
    out.push({ key, label, reads });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The Fusion projects table, sorted by any of its columns
// ---------------------------------------------------------------------------------------------

/** The columns the Fusion projects table sorts by. */
export const PROJECT_SORT_KEYS = ['name', 'criticality', 'frequency', 'lines', 'units', 'scans', 'model', 'credits'];

/**
 * The estimate's rows (fusionEstimate) in the order of one column, as the table shows them:
 * `dir` 'asc' or 'desc'. A value the table shows as "—" (not known, or a project left out)
 * always comes last, whichever way; ties keep the order they had. `modelName(id)` names a model.
 */
export function sortProjects(rows, { key, dir = 'asc' } = {}, { modelName = (id) => id ?? '' } = {}) {
  if (!PROJECT_SORT_KEYS.includes(key)) return rows;
  const rank = new Map(FREQUENCIES.map((f, i) => [f.id, FREQUENCIES.length - i]));
  const shown = (r) => r.included && r.units;
  const value = {
    name: (r) => String(r.name ?? ''),
    criticality: (r) => (Number.isFinite(Number(r.criticality)) && r.criticality !== null ? Number(r.criticality) : null),
    // How often it is scanned: its frequency, then how many scans it had in the last year.
    frequency: (r) => (rank.has(r.frequency) ? rank.get(r.frequency) * 1e6 + Math.min(999_999, Number(r.scanCount) || 0) : null),
    lines: (r) => (r.lines === null || r.lines === undefined ? null : Number(r.lines)),
    units: (r) => (shown(r) ? r.units : null),
    scans: (r) => (Number.isFinite(Number(r.scans)) ? Number(r.scans) : null),
    model: (r) => (r.model ? String(modelName(r.model) ?? '') || null : null),
    credits: (r) => (shown(r) && r.credits !== null ? r.credits : null),
  }[key];
  const sign = dir === 'desc' ? -1 : 1;
  return rows
    .map((row, at) => ({ row, at, v: value(row) }))
    .sort((a, b) => {
      if (a.v === null || b.v === null) return a.v === null && b.v === null ? a.at - b.at : a.v === null ? 1 : -1;
      const order = typeof a.v === 'string' ? a.v.localeCompare(b.v, undefined, { numeric: true, sensitivity: 'base' }) : a.v - b.v;
      return order * sign || a.at - b.at;
    })
    .map((x) => x.row);
}

/** Is anything picked (applications, projects, groups, names, people, frequencies, criticalities)? Scan origins pick scans, not projects. */
export const scopeActive = (scope) => Object.entries(cleanScope(scope)).some(([key, v]) => key !== 'origins' && Array.isArray(v) && v.length);

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

// ---------------------------------------------------------------------------------------------
// Impact: what using the triage & remediation credits gives back
// ---------------------------------------------------------------------------------------------

/**
 * The assumptions behind the impact, each customer's own (started from Settings → Impact): the
 * minutes a person spends triaging one finding by hand, fixing one, and reviewing a fix AI wrote;
 * what an hour of a developer costs; what a credit costs; the currency.
 */
export const IMPACT_DEFAULTS = {
  triageMinutes: 20,
  fixMinutes: 120,
  reviewMinutes: 15,
  hourlyRate: 0,
  creditPrice: 0,
  currency: 'USD',
  // Fusion: lines of code an expert reviews in an hour, the reviewers in a team, how many times more a
  // fix costs once released, the chance a critical or high finding leads to a breach (%), what a breach
  // costs (IBM's Cost of a Data Breach 2024 average), and whether that expected cost counts in the return.
  linesPerHour: 200,
  reviewers: 3,
  laterFixMultiplier: 5,
  breachChancePercent: 0.5,
  breachCost: 4880000,
  countBreach: false,
};
/** Working hours in a developer's year, to say the hours as people. */
export const HOURS_A_YEAR = 1800;

export function impactSettings(value = {}, base = IMPACT_DEFAULTS) {
  const pick = (key, max) => {
    const v = amount(value?.[key]);
    return v === null ? clamp(Number(base?.[key] ?? IMPACT_DEFAULTS[key]) || 0, 0, max) : clamp(v, 0, max);
  };
  const currency = String(value?.currency || base?.currency || IMPACT_DEFAULTS.currency).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'USD';
  const count = value?.countBreach ?? base?.countBreach ?? IMPACT_DEFAULTS.countBreach;
  return {
    triageMinutes: pick('triageMinutes', 600),
    fixMinutes: pick('fixMinutes', 6000),
    reviewMinutes: pick('reviewMinutes', 600),
    hourlyRate: pick('hourlyRate', 100000),
    creditPrice: pick('creditPrice', 100000),
    currency,
    linesPerHour: Math.max(1, pick('linesPerHour', 100000)),
    reviewers: Math.max(1, Math.round(pick('reviewers', 1000))),
    laterFixMultiplier: Math.max(1, pick('laterFixMultiplier', 1000)),
    breachChancePercent: pick('breachChancePercent', 100),
    breachCost: pick('breachCost', 1e11),
    countBreach: count === true || count === 'true',
  };
}

/**
 * The impact of the triage & remediation projection (its rows by severity, over `months`):
 * every finding AI triages is one a person does not look at by hand; every false positive it
 * clears never reaches a developer; every true positive it fixes saves the hand fix, less the
 * time a developer reviews AI's fix. Hours become money at the hourly cost, set against what the
 * credits cost. Money figures are null until a rate (and a credit price) is given.
 */
export function trImpact(rows = {}, months = 12, settings = {}) {
  const s = impactSettings(settings);
  const period = clamp(Number(months) || 12, 1, 60);
  const fixSaved = Math.max(0, s.fixMinutes - s.reviewMinutes);
  const bySeverity = SEVERITIES.map((severity) => {
    const r = rows?.[severity] ?? {};
    const triaged = Math.max(0, Number(r.toTriage) || 0);
    const fixes = Math.max(0, Number(r.truePositives) || 0);
    const cleared = Math.max(0, triaged - fixes);
    const triageHours = (triaged * s.triageMinutes) / 60;
    const fixHours = (fixes * fixSaved) / 60;
    const credits = Math.max(0, Number(r.credits) || 0);
    return { severity, triaged, cleared, fixes, triageHours, fixHours, hours: triageHours + fixHours, credits };
  });
  const sum = (key) => bySeverity.reduce((n, r) => n + r[key], 0);
  const hours = sum('hours');
  const credits = sum('credits');
  const value = s.hourlyRate > 0 ? hours * s.hourlyRate : null;
  const cost = s.creditPrice > 0 ? credits * s.creditPrice : null;
  const net = value !== null ? value - (cost ?? 0) : null;
  return {
    settings: s,
    months: period,
    bySeverity,
    triaged: sum('triaged'),
    cleared: sum('cleared'),
    fixes: sum('fixes'),
    triageHours: sum('triageHours'),
    fixHours: sum('fixHours'),
    hours,
    hoursPerMonth: hours / period,
    developerYears: hours / HOURS_A_YEAR,
    credits,
    value,
    cost,
    net,
    // Return on what the credits cost: net ÷ cost; and how many months of savings pay for them.
    roi: value !== null && cost ? net / cost : null,
    paybackMonths: value && cost !== null ? cost / (value / period) : null,
  };
}

/**
 * The impact of Fusion: frontier models reading every line of each project on every Fusion scan.
 *   - Expert review replaced: the lines read (lines × scans) at what an expert reviews in an hour.
 *   - How often every line is read, the cost per 10K lines read against an expert's, the full-time
 *     reviewers it would take to keep pace, and how long a team takes to read the code once.
 *   - Found earlier, fixed cheaper: the true positives Fusion adds (the triage & remediation
 *     projection's "more found by Fusion" less their false positives) fixed while the code is being
 *     written, where a fix after release costs `laterFixMultiplier` times as much.
 *   - Breach risk reduced: the critical and high ones of those × the chance one leads to a breach ×
 *     what a breach costs; an expected cost, in the return only when `countBreach`.
 * `rows` are the Fusion estimate's rows (included, units, lines, scans); `trRows` the projection's rows.
 */
export function fusionImpact(rows = [], credits = 0, months = 12, settings = {}, trRows = null) {
  const s = impactSettings(settings);
  const period = clamp(Number(months) || 12, 1, 60);
  const counted = (rows ?? []).filter((r) => r.included && r.units && r.lines);
  const linesOnce = counted.reduce((n, r) => n + r.lines, 0);
  const linesRead = counted.reduce((n, r) => n + r.lines * (r.scans || 0), 0);
  const expertHours = linesRead / s.linesPerHour;
  const rate = s.hourlyRate > 0 ? s.hourlyRate : null;
  const expertValue = rate === null ? null : expertHours * rate;
  const cost = s.creditPrice > 0 ? (Number(credits) || 0) * s.creditPrice : null;
  const extra = (severities) => severities.reduce((n, sev) => {
    const r = trRows?.[sev] ?? {};
    return n + (Number(r.fusionExtra) || 0) * (1 - (Number(r.fp) || 0) / 100);
  }, 0);
  const extraTrue = trRows ? extra(SEVERITIES) : null;
  const extraCriticalHigh = trRows ? extra(['Critical', 'High']) : null;
  const earlyHours = extraTrue === null ? null : (extraTrue * (s.laterFixMultiplier - 1) * s.fixMinutes) / 60;
  const earlyValue = earlyHours === null || rate === null ? null : earlyHours * rate;
  const breachAvoided = extraCriticalHigh === null ? null : extraCriticalHigh * (s.breachChancePercent / 100) * s.breachCost;
  const parts = [expertValue, earlyValue, s.countBreach ? breachAvoided : null].filter((v) => v !== null);
  const value = parts.length ? parts.reduce((a, b) => a + b, 0) : null;
  const net = value === null ? null : value - (cost ?? 0);
  return {
    settings: s,
    months: period,
    projects: counted.length,
    linesOnce,
    linesRead,
    timesRead: linesOnce ? linesRead / linesOnce : 0,
    expertHours,
    expertValue,
    reviewersNeeded: expertHours / (HOURS_A_YEAR * (period / 12)),
    teamWeeks: linesOnce ? linesOnce / s.linesPerHour / (s.reviewers * 40) : 0,
    credits: Number(credits) || 0,
    cost,
    // Only once Fusion has credits to cost: a model without a rate costs nothing yet, which is not free.
    costPer10k: cost && linesRead ? cost / (linesRead / 10000) : null,
    expertPer10k: rate === null ? null : (10000 / s.linesPerHour) * rate,
    extraTrue,
    extraCriticalHigh,
    earlyHours,
    earlyValue,
    breachAvoided,
    value,
    net,
    roi: value !== null && cost ? net / cost : null,
    paybackMonths: value && cost !== null ? cost / (value / period) : null,
  };
}

/** Triage & remediation and Fusion together: everything the credits give back against what they cost. */
export function overallImpact(tr, fusion) {
  const parts = [tr, fusion].filter(Boolean);
  if (!parts.length) return null;
  const sum = (key) => (parts.some((p) => p[key] !== null && p[key] !== undefined) ? parts.reduce((n, p) => n + (p[key] ?? 0), 0) : null);
  const value = sum('value');
  const cost = sum('cost');
  const months = Math.max(...parts.map((p) => p.months));
  const net = value === null ? null : value - (cost ?? 0);
  return {
    months,
    currency: parts[0].settings.currency,
    hours: (tr?.hours ?? 0) + (fusion?.expertHours ?? 0) + (fusion?.earlyHours ?? 0),
    value,
    cost,
    net,
    roi: value !== null && cost ? net / cost : null,
    paybackMonths: value && cost !== null ? cost / (value / months) : null,
    // Where the value comes from, for the slide's bars.
    sources: [
      tr && { key: 'triage', value: tr.value === null ? null : tr.triageHours * tr.settings.hourlyRate, hours: tr.triageHours },
      tr && { key: 'fixes', value: tr.value === null ? null : tr.fixHours * tr.settings.hourlyRate, hours: tr.fixHours },
      fusion && { key: 'expert', value: fusion.expertValue, hours: fusion.expertHours },
      fusion && fusion.earlyHours !== null && { key: 'early', value: fusion.earlyValue, hours: fusion.earlyHours },
      fusion && fusion.settings.countBreach && fusion.breachAvoided !== null && { key: 'breach', value: fusion.breachAvoided, hours: 0 },
    ].filter(Boolean),
  };
}

