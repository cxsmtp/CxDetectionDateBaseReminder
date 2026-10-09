// Cx Credits Calculator: the arithmetic, shared by the page (public/calculator/page.js), the
// report it downloads (report.js), the server (src/projections.js) and the tests.
//
// Triage & remediation: two Checkmarx One exports (the open backlog by severity at each week's end,
// and what was fixed each week) give the backlog, its trend and how fast it grows; a plan per
// severity (how many findings to triage, the expected false positives, the credits each step
// takes) gives the credits. False positives pay their triage credit only.
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
});
export const LOOKBACKS = [0, 3, 6, 9, 12];
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
  const sum = (key) => SEVERITIES.reduce((a, s) => a + perSeverity[s][key], 0);
  const total = { current: sum('current'), prior: sum('prior'), fixed: sum('fixed') };
  total.debtRate = total.prior ? ((total.current - total.prior) / total.prior) * 100 : null;
  total.fixRate = total.current ? (total.fixed / total.current) * 100 : null;
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

/** The last `weeks` weeks: the backlog, what was fixed, the fix rate and how fast the debt grew. */
export function weeklyTrend(totalRows, fixedRows, weeks = 52) {
  const fixedByWeek = new Map();
  for (const r of fixedRows) fixedByWeek.set(r.date, (fixedByWeek.get(r.date) ?? 0) + r.count);
  const rows = totalRows.slice(-weeks);
  return rows.map((r, i) => {
    const backlog = SEVERITIES.reduce((a, s) => a + r[s], 0);
    const fixed = fixedByWeek.get(r.date) ?? 0;
    const prev = i ? SEVERITIES.reduce((a, s) => a + rows[i - 1][s], 0) : null;
    return { date: r.date, backlog, fixed, fixRate: backlog ? (fixed / backlog) * 100 : null, debtRate: prev ? ((backlog - prev) / prev) * 100 : null };
  });
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
  return {
    periodMonths: clamp(wholeNumber(v.periodMonths) ?? 12, 1, 60),
    defaultScans: scans(v.defaultScans) ?? 1,
    defaultModel: model(v.defaultModel) ?? models[0]?.id ?? null,
    combine: COMBINE.includes(v.combine) ? v.combine : 'higher',
    models,
    byFrequency: Object.fromEntries(FREQUENCIES.map((f) => [f.id, rule(v.byFrequency?.[f.id])])),
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
