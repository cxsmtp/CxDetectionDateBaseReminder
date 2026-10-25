/**
 * Govern (beta): restrictions in Checkmarx One, as reference-counted holds per target (SPEC §3.6-3.8, §4.6).
 *
 * A target is one thing Govern changes: a user's AI roles on ast-app (user_roles), a project's Auto Triage
 * (auto_triage), a project's PR remediation severities (pr_remediation). Each budget that wants it restricted
 * holds a reference on it; the target is restricted while it has at least one. The first hold captures the
 * state before (preState), the last release puts it back (B15) — so overlapping budgets never fight.
 *
 * Every Checkmarx One write is preceded by a durable record in holds.jsonl (state 'writing' with the preState),
 * then verified by reading the state again (B33): a crash in the middle leaves the undo record behind, and the next
 * cycle resolves it from what Checkmarx One says. Writes are never retried blindly (retries: 0); a failed one is
 * tried again next cycle.
 *
 * Users: the effective roles (…/role-mappings/clients/{uuid}/composite) decide. Direct AI roles are removed; an
 * AI role from a group is removed by leaving that group only when an admin marked it "AI-only"; otherwise — or
 * when a composite role grants it — the hold ends 'partial', never "restricted" while an AI role remains (B7).
 * Auto Triage: the whole configuration read just before is written back with only auto_triage.enabled changed
 * (B19). PR remediation: an unreadable setting is not disabled (no exact undo) unless the admin allowed it, and
 * then restoreMode is 'default' (B18).
 */
import path from 'node:path';

import { mapWithConcurrency } from '../cxone/client.js';
import { checkServiceUrl } from '../cxone/endpoints.js';
import { appendDurable, readJsonl, writeAtomic } from './store.js';

export const KINDS = { user_roles: 'AI roles removed', auto_triage: 'Auto Triage off', pr_remediation: 'PR remediation off' };
const ACTIVE = new Set(['pending', 'writing', 'applied', 'partial', 'failed', 'skipped']);
const RESTORE_DEFAULT = ['CRITICAL', 'HIGH'];
const HOUR = 3_600_000;
const text = (v, max = 300) => String(v ?? '').slice(0, max);

export const targetKeyOf = (kind, targetId) => `${kind}|${targetId}`;
export const refKeyOf = (budgetId, periodKey, seq, kind, targetId) => `${budgetId}|${periodKey}#${seq}|${kind}|${targetId}`;

/** The holds of a tenant: Map(targetKey → record), every change appended to holds.jsonl before it matters. */
export class HoldStore {
  #file;
  #lines = 0;
  targets = new Map();

  constructor({ dir }) {
    this.#file = path.join(dir, 'holds.jsonl');
    for (const r of readJsonl(this.#file)) {
      this.#lines += 1;
      if (r?.key && typeof r.key === 'string') this.targets.set(r.key, r);
    }
    for (const [k, r] of this.targets) if (r.state === 'released' && !Object.keys(r.refs ?? {}).length) this.targets.delete(k);
  }

  /** Record a target's new state durably (fsync'd) before anything relies on it. */
  put(record) {
    const r = { ...record, refs: { ...(record.refs ?? {}) }, at: new Date().toISOString() };
    appendDurable(this.#file, JSON.stringify(r));
    this.#lines += 1;
    if (r.state === 'released' && !Object.keys(r.refs).length) this.targets.delete(r.key);
    else this.targets.set(r.key, r);
    if (this.#lines > Math.max(2000, this.targets.size * 4)) this.compact();
    return r;
  }

  compact() {
    writeAtomic(this.#file, [...this.targets.values()].map((r) => JSON.stringify(r)).join('\n') + (this.targets.size ? '\n' : ''));
    this.#lines = this.targets.size;
  }

  /** Targets still restricted, or being restricted or released. */
  active() {
    return [...this.targets.values()].filter((r) => Object.keys(r.refs ?? {}).length || r.state !== 'released');
  }

  /** Release every reference on a target (an admin's restore): the enforcement worker then puts it back. */
  releaseAll(key, reason, by = '') {
    const r = this.targets.get(key);
    if (!r) return null;
    const refs = Object.values(r.refs ?? {});
    this.put({ ...r, refs: {}, releaseReason: reason, releasedBy: by, history: [...(r.history ?? []).slice(-19), { at: new Date().toISOString(), event: 'released', reason, by, refs: refs.length }] });
    return refs;
  }
}

/**
 * Make the holds match what the budgets want. `desired`: Map(refKey → { budgetId, periodKey, seq, kind, targetId,
 * type, label, repoId }). `leave`: Set of budget ids whose existing references are left alone (stale usage, or
 * held until released). `reasons`: Map(budgetId → release reason). Returns the references added and released.
 */
export function reconcileRefs(store, desired, { leave = new Set(), reasons = new Map(), now = new Date() } = {}) {
  const added = [];
  const released = [];
  const at = now.toISOString();
  const touched = new Map();
  const get = (key, seed) => {
    if (touched.has(key)) return touched.get(key);
    const r = store.targets.get(key);
    const copy = r ? { ...r, refs: { ...r.refs } } : { key, kind: seed.kind, targetId: seed.targetId, type: seed.type, label: seed.label, repoId: seed.repoId ?? '', refs: {}, state: 'pending', preState: null, attempts: 0, history: [] };
    touched.set(key, copy);
    return copy;
  };
  for (const r of store.targets.values()) {
    for (const [refKey, ref] of Object.entries(r.refs ?? {})) {
      if (desired.has(refKey) || leave.has(ref.budgetId)) continue;
      const t = get(r.key);
      delete t.refs[refKey];
      const reason = reasons.get(ref.budgetId) ?? 'limit_removed';
      released.push({ target: r.key, refKey, budgetId: ref.budgetId, reason });
      t.releaseReason = reason;
    }
  }
  for (const [refKey, d] of desired) {
    const key = targetKeyOf(d.kind, d.targetId);
    const existing = store.targets.get(key);
    if (existing?.refs?.[refKey]) continue;
    const t = get(key, d);
    t.refs[refKey] = { budgetId: d.budgetId, periodKey: d.periodKey, seq: d.seq, since: at };
    if (d.label) t.label = d.label;
    if (d.repoId) t.repoId = d.repoId;
    if (t.state === 'released' || !ACTIVE.has(t.state)) t.state = 'pending';
    added.push({ target: key, refKey, budgetId: d.budgetId });
  }
  for (const t of touched.values()) store.put(t);
  return { added, released };
}

// ---------------------------------------------------------------------------
// Checkmarx One operations
// ---------------------------------------------------------------------------

const names = (list) => (Array.isArray(list) ? list.map((r) => String(r?.name ?? r ?? '')).filter(Boolean) : []);
const roleRefs = (list) => (Array.isArray(list) ? list.filter((r) => r?.id && r?.name).map((r) => ({ id: String(r.id), name: String(r.name) })) : []);

export class CxOps {
  #cx;
  #admin = '';
  #uuid = null;

  /** `cx`: { request(path, options) } (Govern's budgeted client); `connection`: { iamUrl, tenant }. */
  constructor(cx, connection = {}) {
    this.#cx = cx;
    if (connection.iamUrl && connection.tenant) {
      try {
        this.#admin = `${checkServiceUrl(connection.iamUrl, 'IAM URL')}/auth/admin/realms/${encodeURIComponent(connection.tenant)}`;
      } catch {}
    }
  }

  get canUsers() {
    return Boolean(this.#admin);
  }

  #get(p, query) {
    return this.#cx.request(p, { query, retries: 1 });
  }

  /** A write: never retried blindly. */
  #write(method, p, body, query) {
    return this.#cx.request(p, { method, body, query, retries: 0 });
  }

  /** ast-app's client UUID (exact clientId, else the first with a warning). */
  async clientUuid() {
    if (this.#uuid) return this.#uuid;
    if (!this.#admin) throw Object.assign(new Error('No IAM address for this connection: users cannot be restricted.'), { status: 0 });
    const list = await this.#get(`${this.#admin}/clients`, { clientId: 'ast-app', max: 1, search: true });
    const arr = Array.isArray(list) ? list : [];
    const hit = arr.find((c) => c?.clientId === 'ast-app') ?? arr[0];
    if (!hit?.id) throw Object.assign(new Error('Checkmarx One has no ast-app client in IAM: users cannot be restricted on this tenant.'), { status: 404 });
    this.#uuid = String(hit.id);
    return this.#uuid;
  }

  async userRoles(uid) {
    const uuid = await this.clientUuid();
    const base = `${this.#admin}/users/${encodeURIComponent(uid)}/role-mappings/clients/${encodeURIComponent(uuid)}`;
    const [effective, direct] = await Promise.all([this.#get(`${base}/composite`), this.#get(base)]);
    return { effective: names(effective), direct: roleRefs(direct), base };
  }

  /** Where an AI role comes from when it is not mapped directly: the user's groups that grant it. */
  async groupSources(uid, aiRoles) {
    const uuid = await this.clientUuid();
    const groups = await this.#get(`${this.#admin}/users/${encodeURIComponent(uid)}/groups`);
    const out = [];
    for (const g of Array.isArray(groups) ? groups : []) {
      if (!g?.id) continue;
      const granted = names(await this.#get(`${this.#admin}/groups/${encodeURIComponent(g.id)}/role-mappings/clients/${encodeURIComponent(uuid)}/composite`)).filter((n) => aiRoles.includes(n));
      if (granted.length) out.push({ id: String(g.id), path: String(g.path ?? g.name ?? g.id), roles: granted });
    }
    return out;
  }

  removeRoles(base, roles) {
    return this.#write('DELETE', base, roles);
  }

  addRoles(base, roles) {
    return this.#write('POST', base, roles);
  }

  leaveGroup(uid, gid) {
    return this.#write('DELETE', `${this.#admin}/users/${encodeURIComponent(uid)}/groups/${encodeURIComponent(gid)}`);
  }

  joinGroup(uid, gid) {
    return this.#write('PUT', `${this.#admin}/users/${encodeURIComponent(uid)}/groups/${encodeURIComponent(gid)}`);
  }

  /** The project's AI agents configuration, refusing a shape it does not know (never invents one). */
  async autoTriage(pid) {
    const p = `/api/ai-agents-coordinator/projects/${encodeURIComponent(pid)}/configuration`;
    const body = await this.#get(p);
    if (!body || typeof body !== 'object' || !Array.isArray(body.configurations)) throw Object.assign(new Error('Checkmarx One answered the AI agents configuration in a shape Govern does not know: left unchanged.'), { status: 0, shape: true });
    const entry = body.configurations.find((c) => c?.feature === 'auto_triage') ?? null;
    return { path: p, body, entry };
  }

  /** Write back exactly what was read, only auto_triage.enabled changed. */
  setAutoTriage({ path: p, body, entry }, enabled) {
    return this.#write('PUT', p, { ...body, configurations: body.configurations.map((c) => (c === entry ? { ...c, enabled } : c)) });
  }

  async prSeverities(repoId, pid) {
    const body = await this.#get(`/api/repos-manager/repo/${encodeURIComponent(repoId)}`, { projectId: pid });
    if (!Array.isArray(body?.remediationSeverities)) throw Object.assign(new Error('The PR remediation setting could not be read.'), { status: 0 });
    return body.remediationSeverities.map((s) => String(s));
  }

  setPrSeverities(repoId, pid, severities) {
    return this.#write('PATCH', `/api/repos-manager/repo/${encodeURIComponent(repoId)}`, { remediationSeverities: severities }, { projectId: pid });
  }
}

// ---------------------------------------------------------------------------
// Applying and releasing
// ---------------------------------------------------------------------------

/**
 * Restrict one target (write-ahead, write, verify). Returns { state, note, partial[] }; throws on a Checkmarx One
 * error (the caller records 'failed').
 */
async function applyTarget(ops, store, r, settings) {
  const aiRoles = settings.aiRoles;
  if (r.kind === 'user_roles') {
    const { effective, direct, base } = await ops.userRoles(r.targetId);
    let pre = r.preState;
    if (!pre) {
      const directAi = direct.filter((x) => aiRoles.includes(x.name));
      const effAi = effective.filter((n) => aiRoles.includes(n));
      const remaining = effAi.filter((n) => !directAi.some((d) => d.name === n));
      const groupsLeft = [];
      const partial = [];
      if (remaining.length) {
        const sources = await ops.groupSources(r.targetId, aiRoles);
        const covered = new Set();
        for (const g of sources) {
          g.roles.forEach((n) => covered.add(n));
          if ((settings.aiOnlyGroups ?? []).some((x) => x === g.id || x === g.path)) groupsLeft.push({ id: g.id, path: g.path });
          else partial.push(`Group ${g.path} grants ${g.roles.join(', ')}`);
        }
        const still = remaining.filter((n) => !covered.has(n));
        if (still.length) partial.push(`A composite role grants ${still.join(', ')}`);
      }
      pre = { directRemoved: directAi, groupsLeft, explained: partial, rolesBefore: effAi };
    }
    store.put({ ...r, state: 'writing', preState: pre, attempts: (r.attempts ?? 0) + 1 });
    if (pre.directRemoved.length) await ops.removeRoles(base, pre.directRemoved);
    for (const g of pre.groupsLeft) await ops.leaveGroup(r.targetId, g.id);
    const after = await ops.userRoles(r.targetId);
    const left = after.effective.filter((n) => aiRoles.includes(n));
    return { state: left.length ? 'partial' : 'applied', preState: pre, partial: left.length ? [...pre.explained, `Still holds ${left.join(', ')}`] : [], note: pre.rolesBefore.length ? '' : 'The user held none of the AI roles.' };
  }
  if (r.kind === 'auto_triage') {
    const read = await ops.autoTriage(r.targetId);
    const pre = r.preState ?? { enabledBefore: read.entry?.enabled === true, restoreMode: 'exact' };
    if (read.entry?.enabled !== true) {
      store.put({ ...r, state: 'writing', preState: pre });
      return { state: 'applied', preState: pre, partial: [], note: 'Auto Triage was already off.' };
    }
    store.put({ ...r, state: 'writing', preState: pre, attempts: (r.attempts ?? 0) + 1 });
    await ops.setAutoTriage(read, false);
    const check = await ops.autoTriage(r.targetId);
    if (check.entry?.enabled === true) throw Object.assign(new Error('Auto Triage is still on after turning it off.'), { status: 0 });
    return { state: 'applied', preState: pre, partial: [] };
  }
  if (r.kind === 'pr_remediation') {
    let before = null;
    try {
      before = await ops.prSeverities(r.repoId, r.targetId);
    } catch (error) {
      if (!r.preState && !settings.prDisableUnreadable) return { state: 'skipped', preState: null, partial: [`PR remediation left on: its setting could not be read (${text(error.message, 120)}), so it could not be put back exactly.`] };
    }
    const pre = r.preState ?? (before ? { severitiesBefore: before, restoreMode: 'exact' } : { severitiesBefore: RESTORE_DEFAULT, restoreMode: 'default' });
    if (before && !before.length) {
      store.put({ ...r, state: 'writing', preState: pre });
      return { state: 'applied', preState: pre, partial: [], note: 'PR remediation was already off.' };
    }
    store.put({ ...r, state: 'writing', preState: pre, attempts: (r.attempts ?? 0) + 1 });
    await ops.setPrSeverities(r.repoId, r.targetId, []);
    let after = null;
    try {
      after = await ops.prSeverities(r.repoId, r.targetId);
    } catch {}
    if (after && after.length) throw Object.assign(new Error('PR remediation is still on after turning it off.'), { status: 0 });
    return { state: 'applied', preState: pre, partial: [], note: after ? '' : 'Could not read it back to check.' };
  }
  throw new Error(`Unknown restriction ${r.kind}.`);
}

/** Put a target back as it was before the first hold. */
async function releaseTarget(ops, store, r) {
  const pre = r.preState;
  store.put({ ...r, state: 'releasing' });
  if (!pre) return;
  if (r.kind === 'user_roles') {
    const { base } = await ops.userRoles(r.targetId);
    if (pre.directRemoved?.length) await ops.addRoles(base, pre.directRemoved);
    for (const g of pre.groupsLeft ?? []) await ops.joinGroup(r.targetId, g.id);
    const after = await ops.userRoles(r.targetId);
    const missing = (pre.directRemoved ?? []).filter((x) => !after.direct.some((d) => d.name === x.name));
    if (missing.length) throw Object.assign(new Error(`${missing.map((m) => m.name).join(', ')} not back after restoring.`), { status: 0 });
  } else if (r.kind === 'auto_triage') {
    if (!pre.enabledBefore) return;
    const read = await ops.autoTriage(r.targetId);
    if (!read.entry) throw Object.assign(new Error('Auto Triage is no longer in the project configuration: not put back.'), { status: 0 });
    if (read.entry.enabled !== true) await ops.setAutoTriage(read, true);
  } else if (r.kind === 'pr_remediation') {
    if (pre.severitiesBefore?.length) await ops.setPrSeverities(r.repoId, r.targetId, pre.severitiesBefore);
  }
}

/** Has an applied restriction been undone in Checkmarx One since (drift)? */
async function drifted(ops, r, settings) {
  if (r.kind === 'user_roles') return (await ops.userRoles(r.targetId)).effective.some((n) => settings.aiRoles.includes(n) && r.state === 'applied');
  if (r.kind === 'auto_triage') return (await ops.autoTriage(r.targetId)).entry?.enabled === true;
  if (r.kind === 'pr_remediation') return (await ops.prSeverities(r.repoId, r.targetId)).length > 0;
  return false;
}

/**
 * Do what the holds say, for every target that needs it, a few at a time, stopping new work at the deadline.
 * Returns events: [{ event: applied|partial|skipped|failed|released|release_failed|drift, record, error }].
 */
export async function enforce(store, ops, settings, { concurrency = 4, deadline = Infinity, cycle = 0, now = Date.now(), verifyOnly = false } = {}) {
  const events = [];
  const work = [];
  for (const r of store.targets.values()) {
    const held = Object.keys(r.refs ?? {}).length > 0;
    if (held && ['pending', 'writing', 'failed'].includes(r.state)) work.push({ r, op: 'apply' });
    else if (held && r.state === 'skipped' && now - Date.parse(r.lastAttemptAt ?? 0) > HOUR) work.push({ r, op: 'apply' });
    else if (held && ['applied', 'partial'].includes(r.state) && settings.driftEveryCycles && cycle % settings.driftEveryCycles === 0 && now - Date.parse(r.lastVerifiedAt ?? 0) > HOUR) work.push({ r, op: 'verify' });
    else if (!held && r.state !== 'released') work.push({ r, op: 'release' });
  }
  if (verifyOnly) work.splice(0, work.length, ...work.filter((w) => w.op === 'release'));
  await mapWithConcurrency(work, concurrency, async ({ r: initial, op }) => {
    if (Date.now() > deadline) return;
    // The record as it is now: an admin's restore may have changed it while this run waited.
    const r = store.targets.get(initial.key);
    if (!r) return;
    const at = new Date().toISOString();
    if (op === 'release' && Object.keys(r.refs ?? {}).length) return;
    if (op !== 'release' && !Object.keys(r.refs ?? {}).length) return;
    try {
      if (op === 'verify') {
        if (!(await drifted(ops, r, settings))) {
          store.put({ ...r, lastVerifiedAt: at });
          return;
        }
        const day = at.slice(0, 10);
        // Audited and alerted once per target per day, not per cycle (B18).
        events.push({ event: 'drift', record: r, firstToday: r.driftDay !== day });
        const result = await applyTarget(ops, store, { ...r, state: 'writing' }, settings);
        store.put({ ...r, state: result.state, preState: r.preState ?? result.preState, partial: result.partial, lastVerifiedAt: at, lastAttemptAt: at, driftDay: day });
        return;
      }
      if (op === 'apply') {
        const result = await applyTarget(ops, store, r, settings);
        const current = store.targets.get(r.key) ?? r;
        const rec = store.put({ ...current, state: result.state, preState: result.preState ?? current.preState, partial: result.partial, note: result.note ?? '', error: '', appliedAt: current.appliedAt ?? at, lastVerifiedAt: at, lastAttemptAt: at, restoreMode: result.preState?.restoreMode ?? 'exact', history: [...(current.history ?? []).slice(-19), { at, event: result.state }] });
        events.push({ event: result.state, record: rec });
        // Released by an admin while it was being written: put back at once.
        if (!Object.keys(rec.refs ?? {}).length) await releaseOne(rec);
        return;
      }
      await releaseOne(r);
    } catch (error) {
      const current = store.targets.get(r.key) ?? r;
      const state = op === 'release' ? 'release_failed' : 'failed';
      const rec = store.put({ ...current, state: op === 'release' ? 'release_failed' : current.state === 'writing' || current.state === 'pending' ? 'failed' : current.state, error: text(error.message, 300), lastAttemptAt: at });
      events.push({ event: state, record: rec, error: text(error.message, 300), status: error.status ?? 0 });
    }
  });
  async function releaseOne(r) {
    const at = new Date().toISOString();
    try {
      await releaseTarget(ops, store, r);
      const rec = store.put({ ...r, state: 'released', releasedAt: at, error: '', history: [...(r.history ?? []).slice(-19), { at, event: 'released', reason: r.releaseReason ?? '' }] });
      events.push({ event: 'released', record: rec });
    } catch (error) {
      const rec = store.put({ ...r, state: 'release_failed', error: text(error.message, 300), lastAttemptAt: at });
      events.push({ event: 'release_failed', record: rec, error: text(error.message, 300), status: error.status ?? 0 });
    }
  }
  return events;
}
