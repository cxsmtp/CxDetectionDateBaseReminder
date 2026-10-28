// Vendored from cloc-fusion 1.3.2 (commit 1a320621d0f5), MIT licence: src/cloc-fusion/LICENSE. Do not edit here: scripts/sync-cloc-fusion.mjs copies it again.
// Fusion credits: the same arithmetic as the Cx Credits Calculator (CxDetectionDateBaseReminder,
// public/calculator/model.js), fed from the source-control side instead of Checkmarx One.
//
// One Fusion scan of a repository costs its model's credits per 10K lines of code, each repository
// rounded up to whole 10K units on its own (12,000 lines are 2 units). How many Fusion scans a
// repository needs over the period follows from how often it changes: in the calculator that is how
// often Checkmarx One scanned it; here it is how many commits landed on its default branch, since
// each commit is a pipeline run (more than 5 commits a week = more than 5 pipelines a week = one
// Fusion scan a week). A per-repository criticality (1–5) can raise or replace that, as there.

export const UNIT_LOC = 10000;
export const BUNDLE_CREDITS = 10000;
export const MAX_EXTRA_PERCENT = 500;

/**
 * How often a repository changes, busiest first. `days` is the longest average gap between commits
 * the bucket takes, with some slack (26 a year is every 14.04 days: once in 2 weeks). `perYear` is
 * the Fusion scans a year suggested for it: weekly for the busiest, never more often than it changes.
 */
export const FREQUENCIES = [
  { id: 'more-5-week', label: 'More than 5 commits a week', days: 7 / 5.0001, perYear: 52 },
  { id: '1-5-week', label: '1 to 5 commits a week', days: 7.5, perYear: 26 },
  { id: '2-weeks', label: 'About once in 2 weeks', days: 15.5, perYear: 12 },
  { id: 'month', label: 'About once a month', days: 31.5, perYear: 6 },
  { id: '2-months', label: 'About once in 2 months', days: 63, perYear: 4 },
  { id: '3-months', label: 'About once in 3 months', days: 95, perYear: 4 },
  { id: '6-months', label: 'About once in 6 months', days: 190, perYear: 2 },
  { id: 'year', label: 'About once a year', days: 366, perYear: 1 },
  { id: 'rare', label: 'Not in the window', days: Infinity, perYear: 1 },
];
export const CRITICALITIES = [5, 4, 3, 2, 1];
export const COMBINE = ['higher', 'frequency', 'criticality'];

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** A whole number ≥ 0 from whatever was typed or read; null when there is none. */
export function wholeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[,_\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

/** A number ≥ 0 (decimals allowed); null when there is none. */
export function amount(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[,_\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * A repository's change frequency from its commits: how many in the window (`windowDays`, shorter
 * for a younger repository). No commit in the window: "Not in the window".
 */
export function frequencyOf(commitCount, windowDays) {
  const count = wholeNumber(commitCount) ?? 0;
  const days = Math.max(1, Number(windowDays) || 365);
  if (!count) return { id: 'rare', perWeek: 0 };
  const gap = days / count;
  const found = FREQUENCIES.find((f) => gap <= f.days) ?? FREQUENCIES[FREQUENCIES.length - 1];
  return { id: found.id, perWeek: (count / days) * 7 };
}

export const frequencyLabel = (id) => FREQUENCIES.find((f) => f.id === id)?.label ?? id;

/** Fusion scans suggested for a frequency over `periodMonths`. */
export function suggestedScans(frequencyId, periodMonths = 12) {
  const f = FREQUENCIES.find((x) => x.id === frequencyId) ?? FREQUENCIES[FREQUENCIES.length - 1];
  return Math.max(1, Math.ceil((f.perYear * clamp(Number(periodMonths) || 12, 1, 60)) / 12));
}

/** 10K units a repository counts as: its own lines, rounded up. No lines, no unit. */
export function unitsOf(loc) {
  const lines = wholeNumber(loc);
  return lines ? Math.ceil(lines / UNIT_LOC) : 0;
}

export const linesOf = (repo) => wholeNumber(repo?.locOverride) ?? wholeNumber(repo?.loc);

/** The Fusion settings, made safe to compute with. */
export function fusionSettings(value = {}) {
  const v = value && typeof value === 'object' ? value : {};
  const models = (Array.isArray(v.models) ? v.models : []).slice(0, 20).map((m, i) => ({
    id: String(m?.id ?? `model-${i + 1}`).slice(0, 60) || `model-${i + 1}`,
    name: String(m?.name ?? '').trim().slice(0, 80),
    creditsPer10k: amount(m?.creditsPer10k),
  }));
  const ids = new Set(models.map((m) => m.id));
  const model = (id) => (ids.has(String(id ?? '')) ? String(id) : null);
  const scans = (n) => {
    const w = wholeNumber(n);
    return w === null ? null : Math.min(w, 10000);
  };
  const rule = (r) => ({ scans: scans(r?.scans), model: model(r?.model) });
  const periodMonths = clamp(wholeNumber(v.periodMonths) ?? 12, 1, 60);
  const saved = v.byFrequency && typeof v.byFrequency === 'object' ? v.byFrequency : {};
  // Each frequency starts from its suggested scans; a saved rule keeps what it says.
  const byFrequency = Object.fromEntries(
    FREQUENCIES.map((f) => {
      const r = rule(saved[f.id]);
      return [f.id, { scans: r.scans ?? suggestedScans(f.id, periodMonths), model: r.model }];
    }),
  );
  return {
    periodMonths,
    defaultScans: scans(v.defaultScans) ?? 1,
    defaultModel: model(v.defaultModel) ?? models[0]?.id ?? null,
    combine: COMBINE.includes(v.combine) ? v.combine : 'higher',
    models,
    byFrequency,
    byCriticality: Object.fromEntries(CRITICALITIES.map((c) => [c, rule(v.byCriticality?.[c])])),
  };
}

/** Fusion scans and model for one repository under the settings, and where each came from. */
export function allocate(repo, settings) {
  const crit = CRITICALITIES.includes(Number(repo.criticality)) ? Number(repo.criticality) : null;
  const freq = settings.byFrequency[repo.frequency] ?? { scans: null, model: null };
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
  const override = wholeNumber(repo.scansOverride);
  if (override !== null) [scans, from] = [override, 'repo'];
  const modelOrder = settings.combine === 'criticality' ? [byCrit.model, freq.model] : [freq.model, byCrit.model];
  const pinned = repo.modelOverride && settings.models.some((m) => m.id === repo.modelOverride) ? repo.modelOverride : null;
  const model = pinned ?? modelOrder.find(Boolean) ?? settings.defaultModel;
  return { scans, from, model };
}

/**
 * Every repository's Fusion need over the period, busiest first: 10K units × scans × the model's
 * credits per 10K LOC. A model without a rate leaves the repository's credits unknown (null).
 */
export function fusionEstimate(repos = [], value = {}) {
  const settings = fusionSettings(value);
  const models = new Map(settings.models.map((m) => [m.id, m]));
  const order = new Map(FREQUENCIES.map((f, i) => [f.id, i]));
  const rows = repos.map((r) => {
    const lines = linesOf(r);
    const included = r.included !== false && !r.error;
    const units = unitsOf(lines);
    const { scans, from, model } = allocate(r, settings);
    const rate = models.get(model)?.creditsPer10k ?? null;
    const credits = included && units && rate !== null ? units * scans * rate : included && units && scans ? null : 0;
    return { ...r, lines, included, units, scans, scansFrom: from, model, rate, credits, unknownRate: included && units > 0 && scans > 0 && rate === null };
  });
  rows.sort(
    (a, b) =>
      (order.get(a.frequency) ?? 99) - (order.get(b.frequency) ?? 99) ||
      (b.commitsPerWeek ?? 0) - (a.commitsPerWeek ?? 0) ||
      String(a.fullName).localeCompare(String(b.fullName)),
  );
  const counted = rows.filter((r) => r.included && r.units);
  const sum = (list, f) => list.reduce((a, r) => a + (f(r) ?? 0), 0);
  const totals = {
    repos: counted.length,
    lines: sum(counted, (r) => r.lines),
    units: sum(counted, (r) => r.units),
    scans: sum(counted, (r) => r.scans),
    unitScans: sum(counted, (r) => r.units * r.scans),
    credits: sum(counted, (r) => r.credits),
    commits: sum(counted, (r) => r.commits),
    unknownRate: rows.filter((r) => r.unknownRate).length,
  };
  const byFrequency = FREQUENCIES.map((f) => {
    const mine = counted.filter((r) => r.frequency === f.id);
    return { id: f.id, label: f.label, repos: mine.length, lines: sum(mine, (r) => r.lines), units: sum(mine, (r) => r.units), scans: sum(mine, (r) => r.scans), credits: sum(mine, (r) => r.credits) };
  });
  const byModel = settings.models.map((m) => {
    const mine = counted.filter((r) => r.model === m.id);
    return { id: m.id, name: m.name, rate: m.creditsPer10k, repos: mine.length, unitScans: sum(mine, (r) => r.units * r.scans), credits: sum(mine, (r) => r.credits) };
  });
  const orgKeys = [...new Set(rows.map((r) => `${r.connection}\u0000${r.org}`))];
  const byOrg = orgKeys.map((k) => {
    const [connection, org] = k.split('\u0000');
    const all = rows.filter((r) => r.connection === connection && r.org === org);
    const mine = all.filter((r) => r.included && r.units);
    return { connection, org, provider: all[0]?.provider, repos: all.length, counted: mine.length, lines: sum(mine, (r) => r.lines), commits: sum(mine, (r) => r.commits), scans: sum(mine, (r) => r.scans), unitScans: sum(mine, (r) => r.units * r.scans), credits: sum(mine, (r) => r.credits) };
  });
  return { settings, rows, totals, byFrequency, byModel, byOrg };
}

/** The extra credits (a % on top of what is worked out) and the credits in one bundle, cleaned. */
export function totalsSettings(value = {}) {
  const extra = amount(value?.extraPercent);
  const bundle = wholeNumber(value?.bundleCredits);
  return {
    extraPercent: extra === null ? 0 : Math.round(clamp(extra, 0, MAX_EXTRA_PERCENT) * 100) / 100,
    bundleCredits: bundle ? clamp(bundle, 1, 100000000) : BUNDLE_CREDITS,
  };
}

/** The credits required: Fusion, the extra % on top, and the bundles that covers (rounded up). */
export function creditSummary(fusionCredits, value = {}) {
  const settings = totalsSettings(value);
  const base = Number.isFinite(fusionCredits) ? fusionCredits : 0;
  const extra = (base * settings.extraPercent) / 100;
  const total = base + extra;
  const exactBundles = total / settings.bundleCredits;
  return { settings, base, extra, total, exactBundles, bundles: total > 0 ? Math.ceil(exactBundles - 1e-9) : 0 };
}
