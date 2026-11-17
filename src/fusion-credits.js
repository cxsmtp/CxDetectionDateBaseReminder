/**
 * Fusion credits (Credits → Fusion credits): credits given to projects for their Fusion scans, and nothing else.
 *
 * They are kept apart from the AI Triage and AI Remediation credits (src/credit-allocations.js): neither can be
 * spent as the other. Both come out of the credits the tenant has left in Checkmarx One, and together they are never
 * allocated beyond them.
 *
 *   - Rates: each model's credits per 10,000 lines of code for one Fusion scan, set by an Admin (the rates of the
 *     organisation's Checkmarx One agreement): opus-5.5 2, opus-4.7 2.5 and haiku-4.5 1.5 to start with.
 *   - The plan: how many Fusion scans each project is planned for over a period, from how often it is scanned
 *     today, as the Cx Credits Calculator's Fusion plan works it out (public/calculator/model.js, fusionEstimate):
 *     recommended = its lines in whole 10K blocks × its planned Fusion scans × its model's rate.
 *   - Used: CxMissionZero never starts a Fusion scan (pipelines do, in Checkmarx One), so what a project used is
 *     worked out the same way from the Fusion scans it completed since its credits were first allocated: each scan
 *     × its 10K blocks today × the rate of the model the scan ran with (else the project's). Checkmarx One does not
 *     say one scan's own credits.
 *   - Spent: a project whose Fusion credits are used up is flagged, its Admins and owners are told, and (unless an
 *     Admin chose to warn only) Fusion is switched off in its Checkmarx One settings, and back to what it was once
 *     credits are added. A pipeline that asks for Fusion in the scan itself is not stopped by the project's setting.
 *
 * Only projects given Fusion credits here are ever paused: the others are left as they are.
 */
import { mapWithConcurrency } from './cxone/client.js';
import { getLastScans, listProjects } from './cxone/projects.js';
import { branchOf, primaryScans } from './cxone/branches.js';
import { FREQUENCIES, frequencyOf, fusionEstimate, suggestedScans, unitsOf } from '../public/calculator/model.js';
import { modelIn, projectFacts, scanAiConfig, scanTypeOf, scanTypes, tenantAi, tenantCredits } from './fusion-usage.js';
import { readState, writeState } from './state-file.js';

export const FUSION_KEY = 'scan.config.ai.fusionEnabled';
/** The rates a new installation starts with (credits per 10K lines of code, one Fusion scan); null: none set yet. */
export const DEFAULT_RATES = Object.freeze({ 'opus-5.5': 2, 'opus-4.7': 2.5, 'haiku-4.5': 1.5, 'opus-5.0': null, 'mythos-5.1': null });
export const MAX_RATES = 30;
export const MAX_CREDITS = 10_000_000;
const MAX_HISTORY = 50;
const MAX_SCANS_KEPT = 1000;
const DAY = 86_400_000;

const text = (v, max = 120) => (v === null || v === undefined ? '' : String(v).trim().slice(0, max));
/** A model's name as rates are keyed: lower case, no spaces around it. */
export const modelKey = (name) => text(name, 60).toLowerCase();
/** A rate as given: a number from 0 to 1,000 with at most two decimals, else null (not set). */
export function cleanRate(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1000) return null;
  return Math.round(n * 100) / 100;
}
/** Credits as given: a whole or half-precision number from 0 up (rates like 2.5 make halves), else null. */
export function cleanCredits(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_CREDITS) return null;
  return Math.round(n * 100) / 100;
}
const round2 = (n) => Math.round(n * 100) / 100;

/** The plan, made safe: a period of 1 to 60 months and the Fusion scans planned for each change frequency. */
export function cleanPlan(value = {}) {
  const v = value && typeof value === 'object' ? value : {};
  const periodMonths = Math.min(60, Math.max(1, Math.round(Number(v.periodMonths) || 12)));
  const byFrequency = {};
  for (const f of FREQUENCIES) {
    const given = Number(v.byFrequency?.[f.id]);
    byFrequency[f.id] = Number.isFinite(given) && given >= 0 ? Math.min(10_000, Math.round(given)) : suggestedScans(f.id, periodMonths);
  }
  return { periodMonths, byFrequency };
}

/**
 * Every project's recommendation under the rates and the plan, exactly as the calculator's Fusion plan works it out:
 * `rows` are the projects read ({ id, name, loc, frequency, model }).
 */
export function recommend(rows, rates, plan) {
  const p = cleanPlan(plan);
  const names = new Set([...Object.keys(rates ?? {}), ...rows.map((r) => modelKey(r.model)).filter(Boolean)]);
  const models = [...names].map((name) => ({ id: name, name, creditsPer10k: rates?.[name] ?? null }));
  const settings = {
    periodMonths: p.periodMonths,
    defaultScans: 1,
    combine: 'frequency',
    models,
    byFrequency: Object.fromEntries(Object.entries(p.byFrequency).map(([id, scans]) => [id, { scans }])),
    defaultModel: null,
  };
  const estimate = fusionEstimate(rows.map((r) => ({ id: r.id, name: r.name, loc: r.loc, frequency: r.frequency, modelOverride: modelKey(r.model) || null })), settings);
  return new Map(estimate.rows.map((r) => [r.id, { units: r.units, scans: r.scans, rate: r.rate, credits: r.credits === null ? null : round2(r.credits) }]));
}

/**
 * What a project used since `since`: each of its Fusion scans completed from then on × its 10K blocks × the rate of
 * the model the scan ran with (else the project's model). Null when a scan's model has no rate, or the lines are not known.
 */
export function usedSince(row, since, rates) {
  if (!row || !since) return { scans: 0, credits: 0 };
  const from = Date.parse(since);
  const scans = (row.fusionScans ?? []).filter((s) => Date.parse(s.at) >= from);
  const units = unitsOf(row.loc);
  if (!scans.length) return { scans: 0, credits: 0 };
  if (!units) return { scans: scans.length, credits: null };
  let credits = 0;
  for (const s of scans) {
    const rate = rates?.[modelKey(s.model || row.model)];
    if (rate === null || rate === undefined) return { scans: scans.length, credits: null };
    credits += units * rate;
  }
  return { scans: scans.length, credits: round2(credits) };
}

/** Credits one more Fusion scan of the project costs (null: not known). */
export function perScan(row, rates) {
  const units = unitsOf(row?.loc);
  const rate = rates?.[modelKey(row?.model)];
  return units && rate !== null && rate !== undefined ? round2(units * rate) : null;
}

/** A project's standing: 'none' (nothing allocated), 'unknown', 'spent', 'low' (less than one more scan), 'ok'. */
export function standingOf({ allocated, used, next }) {
  if (!allocated) return 'none';
  if (used === null) return 'unknown';
  const left = allocated - used;
  if (left <= 0) return 'spent';
  if (next !== null && left < next) return 'low';
  return 'ok';
}

export class FusionCredits {
  #file;
  #state;

  constructor({ file }) {
    this.#file = file;
    const raw = readState(file, { fallback: {}, holds: 'the credits given to projects for their Fusion scans' }) ?? {};
    const rates = raw.rates && typeof raw.rates === 'object' ? raw.rates : { ...DEFAULT_RATES };
    this.#state = {
      rates: Object.fromEntries(Object.entries(rates).slice(0, MAX_RATES).map(([k, v]) => [modelKey(k), cleanRate(v)]).filter(([k]) => k)),
      ratesAt: text(raw.ratesAt, 40),
      ratesBy: text(raw.ratesBy, 200),
      plan: cleanPlan(raw.plan),
      // Unless an Admin chose to warn only, a project whose credits are spent has Fusion paused in Checkmarx One.
      pauseWhenSpent: raw.pauseWhenSpent !== false,
      projects: raw.projects && typeof raw.projects === 'object' ? raw.projects : {},
      read: raw.read && typeof raw.read === 'object' ? raw.read : null,
    };
  }

  get rates() {
    return { ...this.#state.rates };
  }

  get plan() {
    return cleanPlan(this.#state.plan);
  }

  get pauseWhenSpent() {
    return this.#state.pauseWhenSpent;
  }

  get settings() {
    return { rates: this.rates, ratesAt: this.#state.ratesAt, ratesBy: this.#state.ratesBy, plan: this.plan, pauseWhenSpent: this.pauseWhenSpent };
  }

  /** The last read of the tenant's Fusion projects (kept, so the page shows it at once). */
  get read() {
    return this.#state.read;
  }

  setRead(read) {
    this.#state.read = read;
    this.save();
  }

  /** New rates (every model at once; a model left out is removed) and the choice of what happens when credits are spent. */
  setRates(rates, { by = '', pauseWhenSpent } = {}) {
    const next = {};
    for (const [name, rate] of Object.entries(rates ?? {}).slice(0, MAX_RATES)) {
      const key = modelKey(name);
      if (key && /^[a-z0-9][a-z0-9 ._-]*$/.test(key)) next[key] = cleanRate(rate);
    }
    this.#state.rates = next;
    if (typeof pauseWhenSpent === 'boolean') this.#state.pauseWhenSpent = pauseWhenSpent;
    this.#state.ratesAt = new Date().toISOString();
    this.#state.ratesBy = text(by, 200);
    this.save();
  }

  setPlan(plan) {
    this.#state.plan = cleanPlan(plan);
    this.save();
  }

  get(projectId) {
    return this.#state.projects[projectId] ?? null;
  }

  /** Every project given Fusion credits. */
  list() {
    return Object.entries(this.#state.projects).map(([id, p]) => ({ id, ...p }));
  }

  /**
   * Give a project credits: `mode` 'set' makes its allocation this many, 'add' adds them. Its usage is counted from
   * the first allocation on (a later one adds to it); taking back what is unused sets it to what was used.
   */
  allocate(projectId, projectName, credits, { mode = 'set', by = '', now = new Date() } = {}) {
    const id = text(projectId, 80);
    const amount = cleanCredits(credits);
    if (!id || amount === null) throw Object.assign(new Error('Give a number of credits, 0 or more.'), { status: 400 });
    const entry = (this.#state.projects[id] ??= { name: '', allocated: 0, allocatedAt: '', history: [], paused: null });
    entry.name = text(projectName, 200) || entry.name;
    const before = Number(entry.allocated) || 0;
    entry.allocated = round2(mode === 'add' ? before + amount : amount);
    if (!entry.allocatedAt) entry.allocatedAt = now.toISOString();
    entry.updatedAt = now.toISOString();
    entry.history = [...(entry.history ?? []), { at: now.toISOString(), by: text(by, 200), from: before, to: entry.allocated }].slice(-MAX_HISTORY);
    // More credits: a warning already sent may be sent again when these are spent too.
    if (entry.allocated > before) entry.warnedAt = '';
    return { before, after: entry.allocated };
  }

  /** Remove a project's allocation altogether (it must not be paused by CxMissionZero any more). */
  remove(projectId) {
    const had = this.#state.projects[projectId];
    delete this.#state.projects[projectId];
    return had ?? null;
  }

  /** Note that CxMissionZero paused (or resumed) Fusion for a project, and what its own setting was before. */
  setPaused(projectId, paused) {
    const entry = this.#state.projects[projectId];
    if (entry) entry.paused = paused;
  }

  setWarned(projectId, at) {
    const entry = this.#state.projects[projectId];
    if (entry) entry.warnedAt = at;
  }

  save() {
    writeState(this.#file, { version: 1, ...this.#state });
  }
}

/**
 * The tenant's Fusion projects: every project whose latest scan on its branch ran Fusion, or that was given Fusion
 * credits here, each read on one branch: the one chosen for it (`branches`: { projectId: name }, from here or from a
 * Cx Credits Calculator plan), else its primary branch as Checkmarx One sets it, else main or master
 * (src/cxone/branches.js). For each: its model, lines of code, how often that branch is scanned (its completed scans
 * in the last year), its Fusion scans there (when, which model), and its latest scan (for scheduling). Also the
 * credits the tenant has left, and the models it offers.
 */
export async function readFusionProjects(client, { allocated = [], only = null, branches = {}, concurrency = 6, now = Date.now(), onProgress = () => {}, maxProjects = 10_000 } = {}) {
  // `only` ([{ id, name, branch }]): just these projects (the regular check of those given credits), not the whole tenant.
  const listed = only ? only.map((p) => ({ id: p.id, name: p.name || p.id, mainBranch: p.branch || '' })) : await listProjects(client, { maxItems: maxProjects });
  const projects = listed.map((p) => ({ ...p, mainBranch: text(branches[p.id], 200) || p.mainBranch || '' }));
  const byId = new Map(projects.map((p) => [p.id, p]));
  onProgress('projects', 0, projects.length);
  const ids = projects.map((p) => p.id);
  const anyBranch = await getLastScans(client, ids);
  const choice = await primaryScans(client, projects, { lastScans: anyBranch, concurrency, background: true }).catch(() => ({ scans: anyBranch, branches: {} }));
  const latest = choice.scans ?? {};
  const kinds = await scanTypes(client, latest, { background: true }).catch(() => ({}));
  const keep = new Set(allocated.filter((id) => byId.has(id)));
  if (only) for (const p of only) keep.add(p.id);
  else for (const id of Object.keys(latest)) if (kinds[id] === 'fusion') keep.add(id);
  const chosen = [...keep];
  onProgress('facts', 0, chosen.length);
  const [facts, credits, ai] = await Promise.all([
    projectFacts(client, chosen.filter((id) => latest[id]), latest, { concurrency }).catch(() => ({})),
    tenantCredits(client, { background: true }).catch(() => null),
    tenantAi(client).catch(() => null),
  ]);
  const yearAgo = new Date(now - 365 * DAY).toISOString();
  let done = 0;
  const rows = await mapWithConcurrency(chosen, concurrency, async (id) => {
    const project = byId.get(id);
    const branch = choice.branches?.[id]?.branch ?? '';
    const history = await projectScans(client, id, yearAgo, branch).catch(() => null);
    onProgress('scans', (done += 1), chosen.length);
    const f = facts[id] ?? {};
    const created = Date.parse(project?.createdAt ?? '');
    const windowDays = Number.isFinite(created) ? Math.max(1, Math.min(365, (now - created) / DAY)) : 365;
    const scan = latest[id] ?? null;
    return {
      id,
      name: project?.name ?? id,
      branch,
      branchHow: choice.branches?.[id]?.how ?? '',
      branchChosen: Boolean(text(branches[id], 200)),
      scanType: f.scanType ?? kinds[id] ?? 'none',
      model: modelKey(f.model),
      modelFrom: f.modelFrom ?? '',
      loc: Number.isFinite(Number(f.loc)) && f.loc !== null ? Number(f.loc) : null,
      latestScanId: text(scan?.id ?? scan?.scanId, 80),
      latestScanAt: scan?.createdAt ?? scan?.updatedAt ?? null,
      owner: initiatorEmail(scan ?? anyBranch[id]),
      scansYear: history?.all ?? null,
      frequency: history ? frequencyOf(history.all, windowDays).id : null,
      fusionScans: history?.fusion ?? [],
    };
  });
  return {
    at: new Date(now).toISOString(),
    projects: rows.sort((a, b) => a.name.localeCompare(b.name)),
    tenant: credits ? { available: credits.available, total: credits.total, readAt: credits.readAt } : null,
    models: [...new Set([...(ai?.models ?? []), ...rows.map((r) => r.model).filter(Boolean)].map(modelKey).filter(Boolean))],
    tenantModel: modelKey(ai?.model ?? ''),
  };
}

/** The email address a scan's initiator is known by, when it is one. */
function initiatorEmail(scan) {
  const who = text(scan?.initiator ?? scan?.userName ?? '', 200);
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(who) ? who.toLowerCase() : '';
}

/** One project's completed scans since `from` (on `branch`, when given): how many, and its Fusion scans (when, which model). */
export async function projectScans(client, projectId, from, branch = '') {
  const fusion = [];
  let all = 0;
  for (let offset = 0; offset < 20_000; offset += 1000) {
    const body = await client.request('/api/scans', { query: { 'project-id': projectId, statuses: 'Completed', 'from-date': from, limit: 1000, offset, ...(branch ? { branch } : {}) }, retries: 1, background: true });
    // On its branch only (a tenant that ignores the filter, or scans that do not say their branch, are taken as given).
    const list = (Array.isArray(body?.scans) ? body.scans : []).filter((s) => (!s.createdAt || Date.parse(s.createdAt) >= Date.parse(from)) && (!branch || !branchOf(s) || branchOf(s) === branch));
    for (const s of list) {
      all += 1;
      const ai = scanAiConfig(s);
      const fusionOn = ai?.fusionEnabled === undefined || ai?.fusionEnabled === null ? null : String(ai.fusionEnabled).toLowerCase() === 'true';
      if (Array.isArray(s.engines) && scanTypeOf(s.engines, fusionOn) === 'fusion') fusion.push({ at: text(s.createdAt, 40), model: modelKey(modelIn(s)) });
    }
    if (list.length < 1000) break;
  }
  fusion.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { all, fusion: fusion.slice(0, MAX_SCANS_KEPT) };
}

/**
 * Fusion's own setting on a project in Checkmarx One: { own, value } (own: set on the project itself, not inherited).
 * Null when Checkmarx One does not answer.
 */
export async function fusionSettingOf(client, projectId) {
  const body = await client.request('/api/configuration/project', { query: { 'project-id': projectId }, retries: 1 });
  const entries = Array.isArray(body) ? body : Array.isArray(body?.configEntries) ? body.configEntries : [];
  const entry = entries.find((e) => e?.key === FUSION_KEY);
  if (!entry) return { own: false, value: '' };
  return { own: String(entry.originLevel ?? '').toLowerCase() === 'project', value: text(entry.value, 10).toLowerCase() };
}

/** Switch Fusion off for a project in Checkmarx One; what its setting was before, to put back later. */
export async function pauseFusion(client, projectId) {
  const before = await fusionSettingOf(client, projectId);
  await client.request('/api/configuration/project', { method: 'PATCH', query: { 'project-id': projectId }, body: [{ key: FUSION_KEY, value: 'false' }], retries: 1 });
  return before;
}

/**
 * Put Fusion back as it was before CxMissionZero paused it: the project's own value, or (when it had none) the
 * tenant's again, by removing the project's own; where Checkmarx One will not remove it, Fusion is set on.
 */
export async function resumeFusion(client, projectId, before) {
  if (before?.own && before.value) {
    await client.request('/api/configuration/project', { method: 'PATCH', query: { 'project-id': projectId }, body: [{ key: FUSION_KEY, value: before.value }], retries: 1 });
    return 'restored';
  }
  try {
    await client.request('/api/configuration/project', { method: 'DELETE', query: { 'project-id': projectId, 'config-keys': FUSION_KEY }, retries: 1 });
    return 'inherited';
  } catch {
    await client.request('/api/configuration/project', { method: 'PATCH', query: { 'project-id': projectId }, body: [{ key: FUSION_KEY, value: 'true' }], retries: 1 });
    return 'on';
  }
}
