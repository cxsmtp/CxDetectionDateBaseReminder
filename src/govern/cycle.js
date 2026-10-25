/**
 * Govern (beta): one tenant's governance — its state, its cycle, and everything a request may ask of it
 * (SPEC §4.6).
 *
 * The cycle, never two at once per tenant (an in-process mutex; MZ's instance lock covers other processes):
 *   1. read phase — org (when due), /credits/info, consumption for every dimension, through Govern's own
 *      Checkmarx One budget (≤ 4 calls at once, ≤ 5 per second, background priority), so Workbench and report
 *      traffic is never starved; nothing is written to Checkmarx One or to Govern's state yet;
 *   2. commit — complete polls only, then one new UsageIndex swapped in;
 *   3. evaluate every budget (pure), record what should be held, raise alerts (outbox);
 *   4. enforce — holds per target, write-ahead, verified, a few at a time, stopping new writes at the deadline.
 * Requests (a budget edit, an import, a decision, an approval, an admin's restore) change Govern's state and
 * re-evaluate in memory at once; the Checkmarx One side follows in the background (kick()), never inside them.
 *
 * Run now answers at once with a run id (202); the run's progress is read from memory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { tenantCredits } from '../fusion-usage.js';
import { Semaphore } from '../ttl-cache.js';
import { attribute, decide as decideAttribution } from './attribution.js';
import { CxOps, HoldStore, KINDS, enforce, reconcileRefs, refKeyOf } from './enforce.js';
import { evaluateBudget, periodWindow, planTargets } from './evaluate.js';
import { DIMENSIONS, loadSeries, readConsumption, readOrg } from './ingest.js';
import { Notifier } from './notify.js';
import { expireRequests } from './requests.js';
import { GovernStore, readJson, writeAtomic } from './store.js';
import { IndexHolder, UsageIndex } from './usage-index.js';
import { buildView, entityLabel } from './view.js';

const MINUTE = 60_000;
const DEADLINE_MS = 10 * MINUTE;

/**
 * Govern's own budget of Checkmarx One calls, inside the client's: at most `concurrency` at once and `rate` per
 * second, at background priority. Counts the calls it made.
 */
export function governClient(client, { concurrency = 4, rate = 5 } = {}) {
  const gate = new Semaphore(concurrency);
  let next = 0;
  const stats = { calls: 0, writes: 0 };
  const take = async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + 1000 / rate;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  };
  return {
    stats,
    request: (p, options = {}) =>
      gate.run(async () => {
        await take();
        stats.calls += 1;
        if (options.method && options.method !== 'GET') stats.writes += 1;
        return client.request(p, { ...options, background: true });
      }),
  };
}

const mapOf = (obj) => new Map(Object.entries(obj ?? {}).filter(([k]) => !['__proto__', 'constructor', 'prototype'].includes(k)));

export class GovernService {
  #deps;
  #busy = null;
  #again = false;
  #view = null;
  #viewSeq = 0;
  #runs = new Map();
  #cycleNo = 0;
  #jitter = 0;
  /** Write permission outcomes seen on real writes (403 → monitor only on this key). */
  writes = {};
  permissions = null;
  #checking = null;

  /**
   * @param {object} deps
   * @param {string} deps.dir                 the tenant's govern/ folder
   * @param {() => object|null} deps.clientOf  the tenant's Checkmarx One client (the integration), or null
   * @param {() => object|null} deps.connectionOf  { iamUrl, tenant }
   * @param {(entry) => void} deps.audit      records one Govern audit entry (type govern)
   * @param {(message, to) => Promise} deps.sendMail
   * @param {() => object} [deps.meta]        { tenant, version, allowLoopback }
   * @param {() => object} [deps.pool]        MZ's credit pool { limit, used, period }
   */
  constructor(deps) {
    this.#deps = deps;
    this.dir = deps.dir;
    this.store = new GovernStore({ dir: deps.dir });
    this.holds = new HoldStore({ dir: deps.dir });
    this.notifier = new Notifier({ dir: deps.dir, settings: () => this.store.settings, sendMail: deps.sendMail, post: deps.post, meta: deps.meta ?? (() => ({})) });
    this.series = loadSeries(deps.dir);
    this.holder = new IndexHolder();
    const org = readJson(path.join(deps.dir, 'org.json'), null);
    this.org = { users: mapOf(org?.users), groups: mapOf(org?.groups), projects: mapOf(org?.projects), applications: mapOf(org?.applications), readAt: org?.readAt ?? null };
    this.dimState = readJson(path.join(deps.dir, 'dimensions.json'), {});
    this.credits = readJson(path.join(deps.dir, 'credits.json'), null);
    this.queue = [];
    this.nextRunAt = null;
    this.#jitter = Math.round((Math.random() * 2 - 1) * MINUTE);
    this.#rebuildIndex();
    this.#evaluate(Date.now(), { quiet: true });
    this.#refreshView();
  }

  // -------------------------------------------------------------------------
  // Reading (every page): from memory
  // -------------------------------------------------------------------------

  get view() {
    if (!this.#view || Date.now() - this.#view.at > MINUTE) this.#refreshView();
    return this.#view;
  }

  runs() {
    return [...this.#runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).concat(this.store.runs.filter((r) => !this.#runs.has(r.id))).slice(0, 20);
  }

  run(id) {
    return this.#runs.get(id) ?? this.store.runs.find((r) => r.id === id) ?? null;
  }

  get running() {
    return Boolean(this.#busy);
  }

  #refreshView(now = Date.now()) {
    this.#viewSeq += 1;
    this.#view = buildView({ store: this.store, holds: this.holds, holder: this.holder, notifier: this.notifier, series: this.series, runs: () => this.runs(), nextRunAt: this.nextRunAt, pool: this.#deps.pool }, now, this.#viewSeq);
    this.#indexSpend();
  }

  // -------------------------------------------------------------------------
  // MZ's own spend (CreditLedger.reserve): refused for a scope whose Enforce budget is over
  // -------------------------------------------------------------------------

  #blockedProjects = new Map();
  #blockedUsers = new Map();

  #indexSpend() {
    const projects = new Map();
    const users = new Map();
    const index = this.holder.current;
    for (const row of this.#view.budgets) {
      if (row.mode !== 'enforce' || !row.enforcedBy || !row.active || row.exempt || row.grace) continue;
      // Used up and enforced: MZ's own spend stops at once (instant and reversible), even while a large fan-out awaits confirmation.
      if (!['over', 'restricted', 'partial', 'restricting', 'needs_confirmation'].includes(row.status)) continue;
      const why = `Govern: the ${row.entityType} budget for ${row.entityLabel} is used up (${row.used} of ${row.limit} credits) and enforced, so CxMissionZero spends no more credits on it until it is raised or restored.`;
      if (row.entityType === 'user') {
        const email = index.org.users.get(row.entityId)?.email;
        if (email) users.set(email, why);
      } else for (const pid of index.projectsOf(row.entityType, row.entityId, { includeSubgroups: row.includeSubgroups })) if (!projects.has(pid)) projects.set(pid, why);
    }
    this.#blockedProjects = projects;
    this.#blockedUsers = users;
  }

  /** Why MZ may not spend for this project or requester now ('' when it may). O(1). */
  spendRefusal({ projectId = '', requester = '' } = {}) {
    return this.#blockedProjects.get(String(projectId)) ?? this.#blockedUsers.get(String(requester).toLowerCase()) ?? '';
  }

  // -------------------------------------------------------------------------
  // In memory, no Checkmarx One call: index, evaluation, holds to record
  // -------------------------------------------------------------------------

  #rebuildIndex(now = Date.now()) {
    const latest = Object.fromEntries(DIMENSIONS.map((d) => [d, this.series[d].latest]));
    const { map, rows, aliasesAdded } = attribute(latest, this.org, this.store.decisions);
    if (aliasesAdded.length) {
      for (const [key, alias] of aliasesAdded) {
        const d = this.store.decisions.get(key);
        if (d) this.store.decisions.set(key, { ...d, aliases: [...new Set([...(d.aliases ?? []), alias])].slice(-50) });
      }
      this.store.saveDecisions();
    }
    const intervalMs = (this.store.settings.cycleMinutes || 15) * MINUTE;
    const dims = {};
    for (const d of DIMENSIONS) {
      const s = this.dimState[d] ?? {};
      const old = this.series[d].lastAt && now - this.series[d].lastAt > this.store.settings.staleAfterCycles * intervalMs + 5 * MINUTE;
      dims[d] = { supported: s.supported ?? null, stale: Boolean(s.lastFailed) || Boolean(old), error: s.lastError ?? '', note: s.note ?? '' };
    }
    this.queue = rows;
    this.holder.swap(new UsageIndex({ at: now, series: this.series, org: this.org, attribution: map, dims, credits: this.credits, queue: rows }));
  }

  /** Evaluate every budget on the current index; record holds wanted and alerts. Never calls Checkmarx One. */
  #evaluate(now = Date.now(), { quiet = false } = {}) {
    const index = this.holder.current;
    const isExempt = (t, id) => this.store.isExempt(t, id);
    const ctx = { index, isExempt, graceGrowBy: this.store.settings.graceGrowBy };
    const desired = new Map();
    const leave = new Set();
    const reasons = new Map();
    const notices = [];
    for (const b of this.store.budgets.values()) {
      const win = periodWindow(b, now);
      const prev = win.error ? null : this.store.periods.get(`${b.id}|${win.key}`) ?? null;
      const res = evaluateBudget(b, prev, ctx, now);
      if (res.state) {
        res.state.needsConfirmation = false;
        this.store.periods.set(`${b.id}|${res.state.periodKey}`, res.state);
      }
      for (const n of res.notices) notices.push({ ...n, budget: b });
      if (res.hold === null) {
        leave.add(b.id);
        continue;
      }
      if (res.hold) {
        const targets = planTargets(b, index, isExempt);
        if (targets.length > b.maxTargets && !b.fanoutConfirmedAt) {
          res.state.needsConfirmation = true;
          reasons.set(b.id, 'limit_removed');
          notices.push({ kind: 'fanout', severity: 'warning', title: `Confirm restricting ${targets.length} projects for ${b.entityLabel || b.entityId}`, body: `The budget is over and set to Enforce, but restricting would change ${targets.length} projects, more than its limit of ${b.maxTargets}. Nothing is restricted until someone confirms it on the budget.`, dedupe: `fanout:${b.id}:${res.state.periodKey}:${res.state.breachSeq}`, budget: b });
          continue;
        }
        for (const t of targets) desired.set(refKeyOf(b.id, res.state.periodKey, res.state.breachSeq, t.kind, t.targetId), { budgetId: b.id, periodKey: res.state.periodKey, seq: res.state.breachSeq, ...t });
      } else reasons.set(b.id, res.releaseReason);
      // Held until an admin releases it: last period's restrictions stay through the rollover.
      if (b.holdUntilReleased && b.active && b.mode === 'enforce' && !this.store.isExempt(b.entityType, b.entityId)) {
        for (const r of this.holds.targets.values()) for (const [refKey, ref] of Object.entries(r.refs ?? {})) if (ref.budgetId === b.id && ref.periodKey !== res.state?.periodKey) desired.set(refKey, { budgetId: b.id, periodKey: ref.periodKey, seq: ref.seq, kind: r.kind, targetId: r.targetId, type: r.type, label: r.label, repoId: r.repoId });
      }
    }
    const { added, released } = reconcileRefs(this.holds, desired, { leave, reasons, now: new Date(now) });
    this.#prunePeriods();
    this.store.savePeriods();
    if (!quiet) {
      for (const n of notices) {
        this.notifier.raise({ severity: n.severity, category: ['breach', 'fanout'].includes(n.kind) ? 'enforcement' : n.kind === 'recovered' ? 'restoration' : n.kind === 'misconfigured' || n.kind === 'error' ? 'sync_error' : 'warning', title: n.title, body: n.body, entity: { type: n.budget.entityType, id: n.budget.entityId, label: n.budget.entityLabel || entityLabel(index, n.budget.entityType, n.budget.entityId) }, dedupe: n.dedupe });
      }
    }
    const byBudget = (list) => list.reduce((m, x) => m.set(x.budgetId, [...(m.get(x.budgetId) ?? []), x]), new Map());
    for (const [budgetId, list] of byBudget(added)) this.#audit({ event: 'hold.recorded', reason: `Govern: ${list.length} restriction${list.length === 1 ? '' : 's'} recorded for the budget of ${this.#labelOf(budgetId)} (applied in Checkmarx One by the next enforcement pass).`, after: { targets: list.map((x) => x.target) } });
    for (const [budgetId, list] of byBudget(released)) this.#audit({ event: 'hold.released', reason: `Govern: ${list.length} restriction${list.length === 1 ? '' : 's'} of the budget of ${this.#labelOf(budgetId)} to be lifted (${list[0].reason}).`, before: { targets: list.map((x) => x.target) }, after: { reason: list[0].reason } });
    return { added, released };
  }

  #labelOf(budgetId) {
    const b = this.store.budgets.get(budgetId);
    return b ? `${b.entityType} ${b.entityLabel || b.entityId}` : `a deleted budget (${budgetId})`;
  }

  #prunePeriods() {
    const byBudget = new Map();
    for (const [key, p] of this.store.periods) {
      if (!this.store.budgets.has(p.budgetId)) {
        this.store.periods.delete(key);
        continue;
      }
      (byBudget.get(p.budgetId) ?? byBudget.set(p.budgetId, []).get(p.budgetId)).push(key);
    }
    for (const keys of byBudget.values()) if (keys.length > 24) for (const key of keys.sort().slice(0, keys.length - 24)) this.store.periods.delete(key);
  }

  /** One Govern entry in MZ's audit chain (routes use it too): who, what, before and after. */
  audit(entry) {
    this.#audit(entry);
  }

  #audit({ event, reason, actor = null, before = undefined, after = undefined, outcome = 'changed' }) {
    try {
      this.#deps.audit({ type: 'govern', outcome, reason, actor: actor ?? { kind: 'system', user: 'Govern' }, details: { govern: { event, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) } } });
    } catch {}
  }

  /** After a change made by a request: re-evaluate in memory, refresh the view, and let enforcement follow in the background. */
  changed({ rebuild = false } = {}) {
    if (rebuild) this.#rebuildIndex();
    this.#evaluate();
    this.#refreshView();
    this.kick();
  }

  // -------------------------------------------------------------------------
  // The cycle
  // -------------------------------------------------------------------------

  /** When the next scheduled run is due (ms), from the last start, the interval and this tenant's jitter. */
  #nextDue() {
    const minutes = this.store.settings.cycleMinutes;
    if (!minutes) return null;
    const last = this.store.runs.find((r) => r.trigger === 'schedule' || r.trigger === 'manual');
    const lastAt = last ? Date.parse(last.startedAt) : 0;
    // Never run yet: soon after start, at a moment fixed once (so tenants do not all start together).
    this.#firstDue ??= Date.now() + Math.abs(this.#jitter) / 2;
    return lastAt ? lastAt + minutes * MINUTE + this.#jitter : this.#firstDue;
  }

  #firstDue = null;

  /** The scheduler's turn: start a cycle when one is due. */
  tick(now = Date.now()) {
    this.nextRunAt = this.#nextDue();
    if (this.nextRunAt === null || now < this.nextRunAt || this.#busy) return null;
    return this.runNow({ trigger: 'schedule' });
  }

  /** Start a cycle now, or say which one is already running: { runId, started }. */
  runNow({ trigger = 'manual', by = '' } = {}) {
    if (this.#busy) return { runId: this.#busy.runId, started: false };
    const run = { id: randomUUID(), trigger, by, startedAt: new Date().toISOString(), finishedAt: null, status: 'running', steps: {}, error: '' };
    this.#runs.set(run.id, run);
    if (this.#runs.size > 20) this.#runs.delete([...this.#runs.keys()][0]);
    const promise = this.#cycle(run)
      .catch((error) => {
        run.status = 'failed';
        run.error = String(error.message).slice(0, 300);
      })
      .finally(() => {
        run.finishedAt = new Date().toISOString();
        this.store.runs = [{ ...run }, ...this.store.runs.filter((r) => r.id !== run.id)].slice(0, 20);
        try {
          this.store.saveRuns();
        } catch {}
        this.#busy = null;
        this.nextRunAt = this.#nextDue();
        this.#refreshView();
        if (this.#again) {
          this.#again = false;
          this.kick();
        }
      });
    this.#busy = { runId: run.id, promise };
    return { runId: run.id, started: true, promise };
  }

  /** Enforcement only (after a request changed what should be held): in the background, never two at once. */
  kick() {
    if (this.#busy) {
      this.#again = true;
      return null;
    }
    const client = this.#deps.clientOf();
    if (!client) return null;
    const run = { id: randomUUID(), trigger: 'enforce', by: '', startedAt: new Date().toISOString(), finishedAt: null, status: 'running', steps: {}, error: '' };
    const promise = (async () => {
      const cx = governClient(client);
      const events = await enforce(this.holds, new CxOps(cx, this.#deps.connectionOf() ?? {}), this.store.settings, { deadline: Date.now() + DEADLINE_MS, cycle: -1 });
      this.#handle(events);
      run.steps.enforce = { events: events.length, calls: cx.stats.calls };
      run.status = 'success';
    })()
      .catch((error) => {
        run.status = 'failed';
        run.error = String(error.message).slice(0, 300);
      })
      .finally(() => {
        run.finishedAt = new Date().toISOString();
        this.#busy = null;
        this.#refreshView();
        if (this.#again) {
          this.#again = false;
          this.kick();
        }
      });
    this.#busy = { runId: run.id, promise };
    return promise;
  }

  /** Wait for whatever is running (tests, shutdown). */
  async settled() {
    while (this.#busy) await this.#busy.promise.catch(() => {});
  }

  async #cycle(run) {
    const client = this.#deps.clientOf();
    if (!client) {
      run.status = 'skipped';
      run.error = 'The server is not connected to Checkmarx One (Settings → Checkmarx One).';
      return;
    }
    this.#cycleNo += 1;
    const deadline = Date.now() + DEADLINE_MS;
    const settings = this.store.settings;
    const cx = governClient(client);
    const connection = this.#deps.connectionOf() ?? {};
    const partial = [];
    // 1. Read: nothing changes in Checkmarx One or in Govern's state yet.
    let org = null;
    const orgDue = !this.org.readAt || Date.now() - Date.parse(this.org.readAt) > settings.orgRefreshMinutes * MINUTE || run.trigger === 'manual';
    if (orgDue) {
      const read = await readOrg(cx, connection, this.org);
      org = read.org;
      run.steps.org = { users: org.users.size, groups: org.groups.size, projects: org.projects.size, applications: org.applications.size, warnings: read.warnings };
      if (read.warnings.length) partial.push('org');
      for (const w of read.warnings) this.notifier.raise({ severity: 'warning', category: 'sync_error', title: 'Part of the Checkmarx One org could not be read', body: w, dedupe: `sync:org:${w.split(':')[0]}:${new Date().toISOString().slice(0, 10)}` });
    }
    const credits = await tenantCredits(cx, { background: true }).catch(() => null);
    const support = Object.fromEntries(DIMENSIONS.map((d) => [d, this.dimState[d]?.supported ?? null]));
    const consumption = await readConsumption(cx, { window: settings.window, pageSize: settings.pageSize, support });
    // 2. Commit complete polls, then swap the index.
    run.steps.consumption = {};
    for (const d of DIMENSIONS) {
      const r = consumption.dims[d];
      const state = { ...(this.dimState[d] ?? {}) };
      state.supported = r.supported;
      state.note = r.note;
      state.lastAttemptAt = new Date(consumption.at).toISOString();
      if (r.result?.complete) {
        this.series[d].add({ at: consumption.at, window: settings.window, rows: r.result.rows, pagesHash: r.result.pagesHash });
        this.series[d].compact(consumption.at);
        this.series[d].save();
        state.lastFailed = false;
        state.lastError = '';
        state.lastGoodAt = state.lastAttemptAt;
      } else if (r.supported !== false) {
        state.lastFailed = true;
        state.lastError = r.result?.error ?? r.note ?? '';
        partial.push(d);
        this.notifier.raise({ severity: 'warning', category: 'sync_error', title: `Credit consumption by ${d} not read this cycle`, body: `${state.lastError || r.note} The last complete figures stay in use; nothing is held or released on this dimension until it is read again.`, dedupe: `sync:${d}:${new Date().toISOString().slice(0, 10)}` });
      } else state.lastFailed = false;
      this.dimState[d] = state;
      run.steps.consumption[d] = { complete: Boolean(r.result?.complete), subjects: r.result?.rows?.size ?? 0, pages: r.result?.pagesFetched ?? 0, supported: r.supported, error: state.lastFailed ? state.lastError : '' };
    }
    run.steps.probe = consumption.probe;
    writeAtomic(path.join(this.dir, 'dimensions.json'), JSON.stringify(this.dimState));
    if (credits) {
      this.credits = credits;
      writeAtomic(path.join(this.dir, 'credits.json'), JSON.stringify(credits));
    }
    if (org) {
      this.org = org;
      const plain = (m) => Object.fromEntries(m);
      writeAtomic(path.join(this.dir, 'org.json'), JSON.stringify({ readAt: org.readAt, users: plain(org.users), groups: plain(org.groups), projects: plain(org.projects), applications: plain(org.applications) }));
    }
    this.#rebuildIndex();
    this.#alertUncounted();
    // 3. Evaluate; expire requests.
    const evaluation = this.#evaluate();
    run.steps.evaluate = { budgets: this.store.budgets.size, holdsAdded: evaluation.added.length, holdsReleased: evaluation.released.length };
    const expired = expireRequests(this.store.requests, { days: settings.requestExpiryDays });
    if (expired.length) {
      for (const r of expired) {
        this.store.requests.set(r.id, r);
        this.#audit({ event: 'request.expired', reason: `Govern: ${r.by}'s request for ${r.amount} credits expired unanswered.`, before: { status: 'open' }, after: { status: 'expired' } });
      }
      this.store.saveRequests();
    }
    // 4. Enforce.
    const events = await enforce(this.holds, new CxOps(cx, connection), settings, { deadline, cycle: this.#cycleNo });
    this.#handle(events);
    run.steps.enforce = { events: events.length };
    run.steps.calls = cx.stats.calls;
    run.steps.writes = cx.stats.writes;
    run.status = Date.now() > deadline ? 'partial' : partial.length ? 'partial' : 'success';
    if (partial.length) run.error = `Not complete this cycle: ${partial.join(', ')}.`;
    void this.notifier.drain();
  }

  /** Alert when the credits nobody counts grow (one definition of "not counted", B21). */
  #alertUncounted() {
    const credits = this.queue.filter((r) => !['exact', 'pinned', 'auto', 'automation'].includes(r.status)).reduce((n, r) => n + r.credits, 0);
    const step = Math.floor(credits / 100);
    if (step >= 1) this.notifier.raise({ severity: 'warning', category: 'attribution', title: 'Credits nobody counts', body: `${Math.round(credits)} credits in the lookback window are not attributed to anyone: Govern → Attribution.`, dedupe: `uncounted:${step}` });
  }

  /** Audit and alert what enforcement did: once per state change (failures once a day, B20). */
  #handle(events) {
    const day = new Date().toISOString().slice(0, 10);
    for (const e of events) {
      const r = e.record;
      const what = `${KINDS[r.kind] ?? r.kind} for ${r.type} ${r.label}`;
      const entity = { type: r.type, id: r.targetId, label: r.label };
      if (e.status === 403) this.writes[r.kind] = 'denied';
      else if (['applied', 'partial', 'released'].includes(e.event)) this.writes[r.kind] = 'ok';
      if (e.event === 'applied' || e.event === 'partial') {
        this.#audit({ event: `enforcement.${e.event}`, reason: `Govern: ${what}${e.event === 'partial' ? ` only in part: ${(r.partial ?? []).join('; ')}` : ''}.`, before: r.preState, after: { state: r.state, refs: Object.keys(r.refs ?? {}).length } });
        this.notifier.raise({ severity: 'critical', category: 'enforcement', title: e.event === 'partial' ? `Partly restricted: ${what}` : `Restricted: ${what}`, body: e.event === 'partial' ? `Not everything could be restricted: ${(r.partial ?? []).join('; ')}.` : `${r.note || 'Restricted because a budget in Enforce mode is used up.'} Reversible: Restore puts back what was there before.`, entity, targetKey: r.key, dedupe: `hold:${r.key}:${e.event}:${r.appliedAt}` });
      } else if (e.event === 'skipped') {
        this.notifier.raise({ severity: 'warning', category: 'enforcement', title: `Not restricted: ${what}`, body: (r.partial ?? []).join('; '), entity, targetKey: r.key, dedupe: `hold:${r.key}:skipped:${day}` });
      } else if (e.event === 'failed') {
        this.#audit({ event: 'enforcement.failed', outcome: 'failed', reason: `Govern: could not restrict ${what}: ${e.error}`, after: { state: r.state, attempts: r.attempts } });
        this.notifier.raise({ severity: 'error', category: 'enforcement', title: `Could not restrict ${what}`, body: `${e.error}${e.status === 403 ? ' The API key may not change this: Govern is monitor-only for it on this key.' : ' Tried again next cycle.'}`, entity, targetKey: r.key, dedupe: `hold:${r.key}:failed:${day}` });
      } else if (e.event === 'released') {
        this.#audit({ event: 'enforcement.released', reason: `Govern: ${what} lifted (${r.releaseReason || 'released'}).`, before: { state: 'applied' }, after: r.preState });
        this.notifier.raise({ severity: 'info', category: 'restoration', title: `Restored: ${what}`, body: `Put back as it was before (${r.releaseReason || 'released'}).`, entity, targetKey: r.key, dedupe: `released:${r.key}:${r.releasedAt}` });
      } else if (e.event === 'release_failed') {
        this.#audit({ event: 'enforcement.release_failed', outcome: 'failed', reason: `Govern: could not lift ${what}: ${e.error}`, after: { state: r.state } });
        this.notifier.raise({ severity: 'error', category: 'restoration', title: `Could not restore ${what}`, body: `${e.error} Tried again next cycle until it is restored.`, entity, targetKey: r.key, dedupe: `hold:${r.key}:release_failed:${day}` });
      } else if (e.event === 'drift' && e.firstToday) {
        this.#audit({ event: 'enforcement.reasserted', reason: `Govern: ${what} had been undone in Checkmarx One while its budget is still over; restricted again.` });
        this.notifier.raise({ severity: 'warning', category: 'enforcement', title: `Restricted again: ${what}`, body: 'Someone undid the restriction in Checkmarx One while the budget is still used up.', entity, targetKey: r.key, dedupe: `hold:${r.key}:drift:${day}` });
      }
    }
  }

  // -------------------------------------------------------------------------
  // What requests do
  // -------------------------------------------------------------------------

  /**
   * An admin's restore of targets: every hold on them released (reason admin), and each budget behind them given a
   * grace — no new hold until usage grows past the figure now, or until `graceUntil` (default: the period's end).
   */
  restore(keys, { by, actor, graceUntil = null }) {
    const out = [];
    for (const key of keys) {
      const target = this.holds.targets.get(key);
      if (!target) continue;
      const refs = this.holds.releaseAll(key, 'admin', by) ?? [];
      for (const ref of refs) {
        const pkey = `${ref.budgetId}|${ref.periodKey}`;
        const state = this.store.periods.get(pkey);
        if (!state) continue;
        const until = graceUntil ?? state.end ?? null;
        this.store.periods.set(pkey, { ...state, grace: { until, usageAtRestore: state.used, growBy: this.store.settings.graceGrowBy, by, at: new Date().toISOString() } });
      }
      out.push({ key, label: target.label, kind: target.kind, budgets: [...new Set(refs.map((r) => r.budgetId))] });
      this.#audit({ event: 'restore', actor, reason: `Govern: ${by} restored ${KINDS[target.kind] ?? target.kind} for ${target.type} ${target.label}; no new restriction until usage grows${graceUntil ? ` or until ${graceUntil}` : ' or the period ends'}.`, before: { refs: refs.length, state: target.state }, after: { refs: 0, graceUntil } });
    }
    this.store.savePeriods();
    this.changed();
    return out;
  }

  /** An attribution decision, applied to the index at once (no Checkmarx One call). */
  decide(input, { by, actor }) {
    const row = this.queue.find((r) => r.key === input.key);
    const result = decideAttribution(this.store.decisions, { ...input, currentMatch: row?.entityId ?? null, name: row?.name ?? '', email: row?.email ?? '' }, { by });
    this.store.saveDecisions();
    this.#audit({ event: 'attribution.decided', actor, reason: `Govern: ${by} chose "${input.action}" for consumption reported as ${row?.name || row?.email || input.key}${input.why ? ` (${String(input.why).slice(0, 200)})` : ''}.`, before: result.before, after: result.after });
    this.changed({ rebuild: true });
    return result;
  }

  // -------------------------------------------------------------------------
  // Permission check (Settings): cheap read probes, in the background
  // -------------------------------------------------------------------------

  checkPermissions() {
    if (this.#checking) return this.#checking;
    const client = this.#deps.clientOf();
    if (!client) {
      this.permissions = { at: new Date().toISOString(), error: 'The server is not connected to Checkmarx One.', reads: [], writes: { ...this.writes } };
      return Promise.resolve(this.permissions);
    }
    const cx = governClient(client);
    const connection = this.#deps.connectionOf() ?? {};
    const iam = connection.iamUrl && connection.tenant ? `${String(connection.iamUrl).replace(/\/+$/, '')}/auth` : '';
    const realm = iam ? `${iam}/realms/${encodeURIComponent(connection.tenant)}` : '';
    const admin = iam ? `${iam}/admin/realms/${encodeURIComponent(connection.tenant)}` : '';
    const sample = [...this.org.projects.keys()][0];
    const probes = [
      ['Credit consumption', '/api/credits/consumption', { viewBy: 'user', period: 'last_month', page: 1, size: 1 }],
      ['Tenant credits', '/api/credits/info'],
      ['IAM users', realm && `${realm}/users/v2`, { first: 0, max: 1 }],
      ['IAM groups', realm && `${realm}/groups`],
      ['Projects', '/api/projects', { limit: 1, offset: 0 }],
      ['Applications', '/api/applications', { limit: 1, offset: 0 }],
      ['IAM administration (ast-app client)', admin && `${admin}/clients`, { clientId: 'ast-app', max: 1, search: true }],
      ['Project AI agents configuration', sample ? `/api/ai-agents-coordinator/projects/${encodeURIComponent(sample)}/configuration` : ''],
    ];
    this.#checking = (async () => {
      const reads = [];
      for (const [label, p, query] of probes) {
        if (!p) {
          reads.push({ label, ok: null, status: 0, note: 'Not checked (nothing to check it on yet).' });
          continue;
        }
        try {
          await cx.request(p, { query, retries: 0 });
          reads.push({ label, ok: true, status: 200, note: '' });
        } catch (error) {
          reads.push({ label, ok: false, status: error.status ?? 0, note: error.status === 403 ? 'Refused (403): the API key lacks this permission.' : String(error.message).slice(0, 200) });
        }
      }
      this.permissions = { at: new Date().toISOString(), reads, writes: { ...this.writes }, note: 'Write permissions cannot be probed safely: each shows after the first real write (denied → Govern is monitor-only for it on this key).' };
      return this.permissions;
    })().finally(() => (this.#checking = null));
    return this.#checking;
  }

  // -------------------------------------------------------------------------
  // Diagnose a figure: attribution failure, or a period effect?
  // -------------------------------------------------------------------------

  diagnose(entityType, entityId, now = Date.now()) {
    const index = this.holder.current;
    const known = entityType === 'user' ? index.org.users.has(entityId) : entityType === 'group' ? index.org.groups.has(entityId) : entityType === 'project' ? index.org.projects.has(entityId) : index.org.applications.has(entityId);
    const dim = entityType;
    const subjects = this.queue.filter((r) => r.dimension === dim && (r.entityId === entityId || r.suggestions.some((s) => s.id === entityId)));
    const budget = this.store.budgetFor(entityType, entityId);
    const win = budget ? periodWindow(budget, now) : null;
    const state = budget && !win.error ? this.store.periods.get(`${budget.id}|${win.key}`) ?? null : null;
    const steps = [
      { step: 'In Checkmarx One', ok: known, detail: known ? `${entityType} ${entityLabel(index, entityType, entityId)} is in the org Govern last read (${index.org.readAt ?? 'never'}).` : `No ${entityType} ${entityId} in the org Govern last read (${index.org.readAt ?? 'never'}).` },
      { step: 'Reported by Checkmarx One', ok: index.available(dim) && !index.dims[dim].stale, detail: index.dims[dim].supported === false ? `Checkmarx One does not report consumption by ${dim}; ${['application', 'group'].includes(dim) ? 'its projects are summed instead.' : 'nothing is assumed to be zero.'}` : index.dims[dim].stale ? `The last poll by ${dim} failed (${index.dims[dim].error}); the figures are from ${new Date(index.dims[dim].lastAt).toISOString()}.` : index.dims[dim].lastAt ? `Last complete poll ${new Date(index.dims[dim].lastAt).toISOString()} over ${index.dims[dim].window}.` : 'Not polled yet.' },
      { step: 'Attributed', ok: subjects.some((s) => s.entityId === entityId), detail: subjects.length ? subjects.map((s) => `"${s.name || s.email || s.subjectKey}" ${s.credits} credits: ${s.status}${s.entityId === entityId ? '' : ' (only suggested)'}`).join('; ') : 'No consumption row is attributed to it (or suggested for it).' },
    ];
    if (budget) {
      const u = index.usage(entityType, entityId, { from: budget.countExisting ? -Infinity : win.start, to: Math.min(now, win.end ?? Infinity), includeMembers: budget.includeMembers, includeSubgroups: budget.includeSubgroups });
      steps.push({ step: 'Budget period', ok: !win.error, detail: win.error || `${budget.period} ${win.key}: from ${budget.countExisting ? 'everything MZ knows of' : new Date(win.start).toISOString()} to ${win.end ? new Date(win.end).toISOString() : 'open'}.` });
      steps.push({ step: 'Usage in the period', ok: u.available, detail: u.available ? `${u.used} credits used in the period (${u.source}); ${u.reported} reported over the lookback window${u.estimated ? '; estimated: Govern has less history than the window, so earlier usage is spread evenly' : ''}.` : 'Not available: nothing is held or released on it.' });
      steps.push({ step: 'Budget state', ok: true, detail: state ? `${state.status}${state.grace ? ', grace after a restore' : ''}; limit ${state.limit}.` : 'Not evaluated yet.' });
    } else steps.push({ step: 'Budget', ok: null, detail: 'No budget for it.' });
    const verdict = !known ? 'not_in_org' : !index.available(dim) && !['application', 'group'].includes(dim) ? 'not_reported' : !steps[2].ok && subjects.length ? 'attribution' : state?.estimated ? 'estimated' : 'ok';
    return { entityType, entityId, label: entityLabel(index, entityType, entityId), verdict, steps };
  }
}

/** Whether a tenant has Govern state (for backups and the like). */
export const hasGovern = (dir) => fs.existsSync(path.join(dir, 'budgets.json'));
