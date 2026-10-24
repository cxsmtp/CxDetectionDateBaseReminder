/**
 * Govern (beta): reading what Checkmarx One reports — credit consumption for every dimension, and the org
 * (users, groups, projects, applications) — and turning consecutive complete polls into increments.
 *
 * Consumption (SPEC §3.2): GET /api/credits/consumption?viewBy=<dimension>&period=<window>&page=&size=, 1-based
 * pages driven by totalPages. A dimension's poll is accepted only when every page arrived and the distinct
 * subjects match totalItems (B10, B31): otherwise the previous good poll stays current and the dimension is stale.
 * An unknown viewBy answers 200 with the *user* view (the silent fallback trap): a dimension whose support is not
 * known yet is compared with a deliberate probe (viewBy=__mz_unsupported_probe__), at most once per cycle.
 *
 * Usage over a period (B16): Checkmarx One reports totals over a sliding window W, not events. Each new complete
 * poll at t2 after one at t1 gives each subject an increment inc(t1,t2] = total(t2) − total(t1) + agedOut, where
 * agedOut is what MZ itself reconstructed for (t1−W, t2−W]. The first poll seeds one increment spread over its
 * window, flagged estimated; once MZ has W of history every new increment is exact. Period usage is the sum of
 * increments inside the period, prorated by time.
 */
import fs from 'node:fs';
import path from 'node:path';

import { extractItems } from '../cxone/client.js';
import { checkServiceUrl } from '../cxone/endpoints.js';
import { WINDOW_DAYS, hashOf, readJson, writeAtomic } from './store.js';

export const DIMENSIONS = ['user', 'action', 'application', 'project', 'group'];
export const PROBE_VIEW = '__mz_unsupported_probe__';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MAX_PAGES = 500;

const text = (v, max = 300) => (v === null || v === undefined ? '' : String(v).trim().slice(0, max));
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Action types as Checkmarx One names them, normalised (SPEC §3.2). */
export function actionType(value) {
  const t = text(value, 80).toLowerCase().replace(/[\s-]+/g, '_');
  if (/^(ai_)?triage$/.test(t)) return 'triage';
  if (/^auto_?triage$/.test(t)) return 'auto_triage';
  if (/^(ai_)?remediation$/.test(t)) return 'remediation';
  if (/^fusion(_scan)?$/.test(t)) return 'fusion';
  return t || 'other';
}

/** Pseudo-users that are automation, never a person (counted tenant- and project-wide, never at user level). */
const AUTOMATION = new Set(['auto-triage', 'auto triage', 'autotriage', 'auto_triage', 'auto-remediation', 'auto remediation', 'system']);
export const isAutomation = (name) => AUTOMATION.has(text(name).toLowerCase());

/**
 * One consumption row, normalised: { key, name, email, id, credits, transactions, actions }. The key is the
 * lower-cased email, else name, else id; null when the row has none of them.
 */
export function consumptionRow(dimension, item) {
  if (!item || typeof item !== 'object') return null;
  let name = text(item.name ?? item.displayName ?? item.userName ?? item.username ?? (dimension === 'action' ? item.actionType : ''));
  let email = text(item.userEmail ?? item.email ?? item.userPrincipalName).toLowerCase();
  if (!email && dimension === 'user' && EMAIL.test(name)) email = name.toLowerCase();
  if (email && !EMAIL.test(email)) email = '';
  const id = text(item.id ?? item.userId ?? item.applicationId ?? item.projectId ?? item.groupId, 120);
  if (dimension === 'action') name = actionType(item.actionType ?? name);
  const key = (dimension === 'user' ? email || name.toLowerCase() || id : dimension === 'action' ? name : id || name.toLowerCase()).slice(0, 300);
  if (!key || ['__proto__', 'constructor', 'prototype'].includes(key)) return null;
  const raw = Number(item.creditsUsed ?? item.credits);
  const credits = Number.isFinite(raw) && raw >= 0 ? Math.round(raw * 10000) / 10000 : 0;
  const actions = {};
  let transactions = Number(item.actionsPerformed?.total ?? item.transactionCount) || 0;
  for (const a of Array.isArray(item.actionsPerformed?.actions) ? item.actionsPerformed.actions : []) {
    const type = actionType(a?.actionType);
    if (['__proto__', 'constructor', 'prototype'].includes(type)) continue;
    actions[type] = (actions[type] ?? 0) + (Number(a?.transactionCount) || 0);
  }
  if (dimension === 'action' && !Object.keys(actions).length) actions[name] = transactions;
  if (!transactions) transactions = Object.values(actions).reduce((n, v) => n + v, 0);
  return { key, name, email, id, credits, transactions, actions };
}

/**
 * Every page of one dimension: { complete, rows: Map(key → row), totalItems, totalPages, pagesFetched, pagesHash,
 * status, error }. `complete` only when every page answered and the distinct subjects match what it said it has.
 */
export async function readDimension(cx, dimension, { window = 'last_30_days', pageSize = 1000, sort = true } = {}) {
  const rows = new Map();
  let totalPages = null;
  let totalItems = null;
  let pagesFetched = 0;
  let size = pageSize;
  const hashes = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let body;
    try {
      body = await cx.request('/api/credits/consumption', { query: { viewBy: dimension, period: window, page, size, ...(sort ? { sort_by: 'creditsUsed', sort_order: 'desc' } : {}) }, retries: 1 });
    } catch (error) {
      // A tenant that refuses the large page size: once more with Checkmarx One's usual 100.
      if (page === 1 && error.status === 400 && size > 100 && !/period/i.test(String(error.body ?? ''))) {
        size = 100;
        page = 0;
        continue;
      }
      return { complete: false, rows, totalItems, totalPages, pagesFetched, status: error.status || 0, error: text(error.message, 300) };
    }
    pagesFetched += 1;
    const items = Array.isArray(body?.items) ? body.items : extractItems(body);
    hashes.push(hashOf(items));
    if (page === 1) {
      totalPages = Number.isFinite(Number(body?.totalPages)) ? Number(body.totalPages) : null;
      totalItems = Number.isFinite(Number(body?.totalItems)) ? Number(body.totalItems) : null;
    }
    for (const item of items) {
      const row = consumptionRow(dimension, item);
      // A row that moved across a page boundary between two requests: kept once, its latest figure (B31).
      if (row) rows.set(row.key, row);
    }
    if (!items.length) break;
    if (totalPages !== null ? page >= totalPages : items.length < size) break;
  }
  const pagesOk = totalPages === null || pagesFetched >= totalPages || (totalPages === 0 && pagesFetched === 1);
  const countOk = totalItems === null || rows.size === totalItems || totalItems === 0;
  return {
    complete: pagesOk && countOk,
    rows,
    totalItems,
    totalPages,
    pagesFetched,
    pagesHash: hashOf(hashes.join('')),
    status: 200,
    error: pagesOk ? (countOk ? '' : `${rows.size} distinct subjects where Checkmarx One said ${totalItems}: rows moved between pages, read again next cycle`) : `${pagesFetched} of ${totalPages} pages arrived`,
  };
}

/** Who a row names, whatever the dimension: compared between a dimension and the probe. */
const ident = (r) => r.email || r.name.toLowerCase() || r.id;

/** Do two polls name the same subjects (both non-empty)? Then the dimension is really the user view. */
export function sameSubjects(a, b) {
  if (!a?.size || !b?.size || a.size !== b.size) return false;
  for (const key of a.keys()) if (!b.has(key)) return false;
  return true;
}

/**
 * Consumption for every dimension, read-only. `support`: what is known per dimension (true / false / null).
 * Returns { at, dims: { dim: { result, supported, note } }, probe }.
 */
export async function readConsumption(cx, { window, pageSize, support = {}, dimensions = DIMENSIONS } = {}) {
  const at = Date.now();
  const dims = {};
  let probe;
  const probeKeys = async () => {
    if (probe !== undefined) return probe;
    const p = await readDimension(cx, PROBE_VIEW, { window, pageSize, sort: false });
    // Compared by the user view's keys: the probe answers in the user view when the trap is there.
    const keys = new Map();
    for (const row of p.rows.values()) keys.set(ident(row), true);
    probe = p.complete ? keys : null;
    return probe;
  };
  for (const dim of dimensions) {
    if (support[dim] === false) {
      dims[dim] = { result: null, supported: false, note: 'Checkmarx One does not report consumption by this dimension.' };
      continue;
    }
    const result = await readDimension(cx, dim, { window, pageSize });
    if (!result.complete && result.status !== 200) {
      if (result.status === 403) dims[dim] = { result, supported: null, note: 'The API key may not read credit consumption (403).' };
      else if (result.status === 404 || (result.status >= 400 && result.status < 500 && result.status !== 429)) dims[dim] = { result, supported: false, note: `Checkmarx One answered ${result.status} for this dimension.` };
      else dims[dim] = { result, supported: support[dim] ?? null, note: `Not read this cycle: ${result.error}` };
      continue;
    }
    let supported = support[dim] ?? null;
    if (dim !== 'user' && supported !== true && result.complete) {
      const keys = await probeKeys().catch(() => null);
      // The probe answered with the same subjects: this dimension silently fell back to the user view.
      if (keys && sameSubjects(new Map([...result.rows.values()].map((r) => [ident(r), true])), keys)) supported = false;
      else if (keys && keys.size && result.rows.size) supported = true;
      // A probe that failed, or an empty side, is inconclusive: never "unsupported".
    }
    if (dim === 'user' && result.complete) supported = true;
    dims[dim] = { result: supported === false ? null : result, supported, note: supported === false ? 'Checkmarx One answers this dimension with the user view: not reported.' : result.complete ? '' : result.error };
  }
  return { at, dims, probe: probe === undefined ? 'not needed' : probe ? 'compared' : 'inconclusive' };
}

// ---------------------------------------------------------------------------
// The org: users, groups, projects, applications
// ---------------------------------------------------------------------------

const iamBase = (connection, admin) => {
  const iam = checkServiceUrl(connection.iamUrl, 'IAM URL');
  return `${iam}/auth/${admin ? 'admin/' : ''}realms/${encodeURIComponent(connection.tenant)}`;
};

/** Every user of the tenant (GET users/v2, first page without parameters, then first/max): { users, complete, warning }. */
export async function readUsers(cx, connection) {
  const base = iamBase(connection, false);
  const users = new Map();
  let expected = null;
  let first = 0;
  let complete = true;
  for (let i = 0; i < 1000; i += 1) {
    const body = await cx.request(`${base}/users/v2`, { query: i === 0 ? {} : { first, max: 100 }, retries: 1 });
    const list = Array.isArray(body?.users) ? body.users : extractItems(body);
    if (i === 0) {
      const n = Number(body?.filteredCount ?? body?.totalCount ?? body?.count);
      expected = Number.isFinite(n) ? n : null;
    }
    let added = 0;
    for (const u of list) {
      const id = text(u?.id, 80);
      if (!id || users.has(id)) continue;
      added += 1;
      users.set(id, {
        id,
        username: text(u.username, 200).toLowerCase(),
        email: EMAIL.test(text(u.email).toLowerCase()) ? text(u.email).toLowerCase() : '',
        firstName: text(u.firstName, 120),
        lastName: text(u.lastName, 120),
        enabled: u.isEnabled ?? u.enabled ?? true,
        groups: (Array.isArray(u.groups) ? u.groups : []).map((g) => text(typeof g === 'string' ? g : g?.name ?? g?.path, 300)).filter(Boolean),
        roles: (Array.isArray(u.roles) ? u.roles : []).map((r) => text(typeof r === 'string' ? r : r?.name, 120)).filter(Boolean),
      });
    }
    first += list.length;
    if (!list.length || !added || expected === null || users.size >= expected) break;
  }
  if (expected !== null && users.size < expected) complete = false;
  return { users, complete, warning: complete ? '' : `${users.size} of ${expected} users read` };
}

/** Every group, flattened with its path and parent: Map(id → { id, name, path, parentId }). */
export async function readGroups(cx, connection) {
  const base = iamBase(connection, false);
  const body = await cx.request(`${base}/groups`, { retries: 1 });
  const groups = new Map();
  const walk = (list, parentId, parentPath) => {
    for (const g of Array.isArray(list) ? list : []) {
      const id = text(g?.id, 80);
      if (!id) continue;
      const name = text(g.name, 200);
      const p = text(g.path, 500) || `${parentPath}/${name}`;
      groups.set(id, { id, name, path: p, parentId });
      walk(g.subGroups, id, p);
    }
  };
  walk(Array.isArray(body) ? body : body?.groups, null, '');
  return groups;
}

/** A paged collection read to its end (an empty page or the reported total), never stopping early on a short page (B30). */
async function readAll(cx, apiPath, key) {
  const out = [];
  let total = null;
  for (let offset = 0, i = 0; i < 1000; i += 1) {
    const body = await cx.request(apiPath, { query: { limit: 100, offset }, retries: 1 });
    const list = Array.isArray(body?.[key]) ? body[key] : extractItems(body, key);
    if (i === 0) {
      const n = Number(body?.filteredTotalCount ?? body?.totalCount);
      total = Number.isFinite(n) ? n : null;
    }
    out.push(...list);
    offset += list.length;
    if (!list.length || (total !== null && out.length >= total)) break;
  }
  return { list: out, total, complete: total === null || out.length >= total };
}

export async function readProjects(cx) {
  const { list, total, complete } = await readAll(cx, '/api/projects', 'projects');
  const projects = new Map();
  for (const p of list) {
    const id = text(p?.id, 80);
    if (!id || (p?.tags && Object.hasOwn(p.tags, 'mz-fae-flush'))) continue;
    const repo = p.repoId ?? p.repositoryId ?? p.repo_id;
    projects.set(id, {
      id,
      name: text(p.name, 300) || id,
      groups: (Array.isArray(p.groups) ? p.groups : []).map((g) => text(g, 80)).filter(Boolean),
      applicationIds: (Array.isArray(p.applicationIds ?? p.applicationIDs) ? p.applicationIds ?? p.applicationIDs : []).map((a) => text(a, 80)).filter(Boolean),
      repoId: repo === 0 || typeof repo === 'boolean' || repo === null || repo === undefined || repo === '' ? '' : text(repo, 80),
    });
  }
  return { projects, total, complete };
}

export async function readApplications(cx) {
  const { list, total, complete } = await readAll(cx, '/api/applications', 'applications');
  const applications = new Map();
  for (const a of list) {
    const id = text(a?.id, 80);
    if (!id) continue;
    applications.set(id, { id, name: text(a.name, 300) || id, projectIds: (Array.isArray(a.projectIds ?? a.projects) ? a.projectIds ?? a.projects : []).map((p) => text(typeof p === 'string' ? p : p?.id, 80)).filter(Boolean) });
  }
  return { applications, total, complete };
}

/**
 * The org, read-only, each part on its own: a part that fails, or reads implausibly few (under half of the last
 * good count without Checkmarx One saying so), keeps the previous one (B30, B35). Returns { org, warnings }.
 */
export async function readOrg(cx, connection, previous = null) {
  const warnings = [];
  const prev = previous ?? { users: new Map(), groups: new Map(), projects: new Map(), applications: new Map() };
  const org = { ...prev, readAt: new Date().toISOString() };
  const plausible = (label, next, before, complete) => {
    if (!complete) {
      warnings.push(`${label}: only part was read, the previous list is kept.`);
      return false;
    }
    if (before.size >= 10 && next.size < before.size / 2) {
      warnings.push(`${label}: ${next.size} read where there were ${before.size}; kept the previous list until it is confirmed.`);
      return false;
    }
    return true;
  };
  const step = async (label, fn) => {
    try {
      return await fn();
    } catch (error) {
      warnings.push(`${label}: ${text(error.message, 200)}`);
      return null;
    }
  };
  if (connection?.iamUrl && connection?.tenant) {
    const groups = await step('Groups', () => readGroups(cx, connection));
    if (groups && plausible('Groups', groups, prev.groups, true)) org.groups = groups;
    const users = await step('Users', () => readUsers(cx, connection));
    if (users && plausible('Users', users.users, prev.users, users.complete)) org.users = users.users;
  } else warnings.push('No IAM address for this connection: users and groups were not read.');
  const projects = await step('Projects', () => readProjects(cx));
  if (projects && plausible('Projects', projects.projects, prev.projects, projects.complete)) org.projects = projects.projects;
  const applications = await step('Applications', () => readApplications(cx));
  if (applications && plausible('Applications', applications.applications, prev.applications, applications.complete)) org.applications = applications.applications;
  return { org, warnings };
}

// ---------------------------------------------------------------------------
// Increments: usage over any period from consecutive complete polls
// ---------------------------------------------------------------------------

/** What part of the increment (t1,t2] lies inside (from,to], prorated by time. */
function overlap(t1, t2, from, to) {
  const a = Math.max(t1, from);
  const b = Math.min(t2, to);
  if (b <= a) return 0;
  return t2 > t1 ? (b - a) / (t2 - t1) : 1;
}

/** Sum of increments in (from, to]: { sum, estimated }. */
export function sumIncrements(list, from, to) {
  let sum = 0;
  let estimated = false;
  for (const [t1, t2, inc, est] of list ?? []) {
    if (t2 <= from) continue;
    if (t1 >= to) break;
    const part = overlap(t1, t2, from, to);
    if (part > 0) {
      sum += inc * part;
      if (est) estimated = true;
    }
  }
  return { sum, estimated };
}

/**
 * One dimension's series: the last complete poll and every subject's increments, kept in memory and written as
 * one file per dimension (usage-<dimension>.json).
 */
export class UsageSeries {
  #file;
  window = '';
  lastAt = 0;
  seedAt = 0;
  /** Map(key → credits) of the last accepted poll. */
  lastTotals = new Map();
  /** Map(key → row) of the last accepted poll (names, email, id, actions). */
  latest = new Map();
  /** Map(key → [[t1, t2, inc, estimated]]) sorted by time. */
  increments = new Map();
  pagesHash = '';

  constructor({ file }) {
    this.#file = file;
    const raw = file ? readJson(file, null) : null;
    if (raw && raw.v === 1) {
      this.window = String(raw.window ?? '');
      this.lastAt = Number(raw.lastAt) || 0;
      this.seedAt = Number(raw.seedAt) || 0;
      this.pagesHash = String(raw.pagesHash ?? '');
      for (const [k, v] of Object.entries(raw.lastTotals ?? {})) this.lastTotals.set(k, Number(v) || 0);
      for (const row of Array.isArray(raw.latest) ? raw.latest : []) if (row?.key) this.latest.set(row.key, row);
      for (const [k, list] of Object.entries(raw.increments ?? {})) if (Array.isArray(list)) this.increments.set(k, list.filter((e) => Array.isArray(e) && e.length >= 3));
    }
  }

  /**
   * Accept a complete poll taken at `at` (ms) over `window`. The first poll, a change of window, or a gap longer
   * than the window seeds: each subject's total spread over the window before, flagged estimated.
   */
  add({ at, window, rows, pagesHash = '' }) {
    const W = (WINDOW_DAYS[window] ?? 30) * DAY;
    const totals = new Map([...rows.values()].map((r) => [r.key, r.credits]));
    const reseed = !this.lastAt || window !== this.window || at - this.lastAt > W || at <= this.lastAt;
    if (reseed) {
      if (at > this.lastAt) {
        this.seedAt = at;
        for (const [key, credits] of totals) if (credits > 0) this.#push(key, [at - W, at, credits, 1]);
      }
    } else {
      const t1 = this.lastAt;
      for (const key of new Set([...totals.keys(), ...this.lastTotals.keys()])) {
        const delta = (totals.get(key) ?? 0) - (this.lastTotals.get(key) ?? 0);
        const aged = sumIncrements(this.increments.get(key), t1 - W, at - W);
        const inc = Math.round((delta + aged.sum) * 10000) / 10000;
        if (inc > 0) this.#push(key, [t1, at, inc, aged.estimated ? 1 : 0]);
      }
    }
    this.window = window;
    this.lastAt = at;
    this.lastTotals = totals;
    this.latest = new Map(rows);
    this.pagesHash = pagesHash;
  }

  /** Copy-on-write: a UsageIndex built earlier keeps the arrays it was given, unchanged. */
  #push(key, entry) {
    this.increments.set(key, [...(this.increments.get(key) ?? []), entry]);
  }

  /** Usage of one subject in (from, to]. */
  usage(key, from, to) {
    return sumIncrements(this.increments.get(key), from, to);
  }

  /**
   * Bound the series: increments older than 7 days merged into hours, older than 90 days into days. Sums are kept,
   * only their spread within the hour or day is coarser.
   */
  compact(now = Date.now()) {
    for (const [key, list] of this.increments) {
      const out = [];
      let bucket = null;
      for (const e of list) {
        const age = now - e[1];
        const size = age > 90 * DAY ? DAY : age > 7 * DAY ? HOUR : 0;
        if (!size) {
          if (bucket) out.push(bucket);
          bucket = null;
          out.push(e);
          continue;
        }
        const start = Math.floor(e[0] / size) * size;
        if (bucket && bucket[0] === start && e[1] <= start + size) {
          bucket[2] = Math.round((bucket[2] + e[2]) * 10000) / 10000;
          bucket[3] = bucket[3] || e[3];
          bucket[1] = Math.max(bucket[1], e[1]);
        } else {
          if (bucket) out.push(bucket);
          bucket = e[1] <= start + size ? [start, e[1], e[2], e[3]] : null;
          if (!bucket) out.push(e);
        }
      }
      if (bucket) out.push(bucket);
      if (out.length) this.increments.set(key, out);
      else this.increments.delete(key);
    }
  }

  save() {
    if (!this.#file) return;
    writeAtomic(this.#file, JSON.stringify({
      v: 1,
      window: this.window,
      lastAt: this.lastAt,
      seedAt: this.seedAt,
      pagesHash: this.pagesHash,
      lastTotals: Object.fromEntries(this.lastTotals),
      latest: [...this.latest.values()],
      increments: Object.fromEntries(this.increments),
    }));
  }
}

/** Each dimension's series for a tenant: govern/usage-<dimension>.json (in every backup with the rest of govern/). */
export function loadSeries(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return Object.fromEntries(DIMENSIONS.map((d) => [d, new UsageSeries({ file: path.join(dir, `usage-${d}.json`) })]));
}
