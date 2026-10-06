/**
 * Self-check: every few minutes the server looks at itself (Checkmarx One, the
 * mail server, the automatic runs, its own error rate), tries to put right what
 * it can, and keeps the administrators told. This module is the bookkeeping:
 * which problems are open, since when, what was tried, when to tell people and
 * when to raise a support case. The checks and the repairs live in server.js.
 *
 *  - A problem seen on one check is noted; on the second check in a row the
 *    administrators get an email (MissionZero has tried to fix it by then).
 *  - On the third, if auto-update is on and the server reached the internet on
 *    its last update check, a support case is raised by itself, and the email
 *    asks an administrator to forward it to the maintainer.
 *  - A problem that clears is "recovered": whoever was told hears so.
 *  - A version that came in less than a day ago and broke what worked before is
 *    put back to the previous version (once), when the launcher runs the server.
 */

import fs from 'node:fs';
import path from 'node:path';

export const NOTIFY_AFTER = 2;
export const CASE_AFTER = 3;
const EVENTS_KEPT = 200;
const DAY_MS = 86_400_000;

export class Watchdog {
  #file;
  #state;

  constructor({ file }) {
    this.#file = file;
    this.#state = this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
      return {
        problems: raw.problems && typeof raw.problems === 'object' ? raw.problems : {},
        events: Array.isArray(raw.events) ? raw.events.slice(0, EVENTS_KEPT) : [],
        healthy: raw.healthy && typeof raw.healthy === 'object' ? raw.healthy : {},
        rolledBack: Array.isArray(raw.rolledBack) ? raw.rolledBack : [],
        lastCheckAt: raw.lastCheckAt ?? '',
      };
    } catch {
      return { problems: {}, events: [], healthy: {}, rolledBack: [], lastCheckAt: '' };
    }
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
      const tmp = `${this.#file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.#state, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, this.#file);
    } catch {
      /* the self-check never breaks the app */
    }
  }

  get state() {
    return structuredClone(this.#state);
  }

  /** Open problems, oldest first. */
  problems() {
    return Object.entries(this.#state.problems).map(([key, p]) => ({ key, ...p })).sort((a, b) => a.since.localeCompare(b.since));
  }

  problem(key) {
    return this.#state.problems[key] ? { key, ...this.#state.problems[key] } : null;
  }

  events(limit = 50) {
    return this.#state.events.slice(0, limit);
  }

  event(kind, message, fields = {}, now = new Date()) {
    this.#state.events.unshift({ at: now.toISOString(), kind, message, ...fields });
    this.#state.events = this.#state.events.slice(0, EVENTS_KEPT);
    this.#save();
  }

  /**
   * The result of one check: `found` is every problem seen now ({ key, title, detail, tenant }).
   * Returns what changed: { started, continuing, recovered } (each a list of problems).
   */
  record(found, { version = '', now = new Date() } = {}) {
    const at = now.toISOString();
    const seen = new Map(found.map((p) => [p.key, p]));
    const started = [];
    const continuing = [];
    const recovered = [];
    for (const [key, open] of Object.entries(this.#state.problems)) {
      if (seen.has(key)) continue;
      recovered.push({ key, ...open, recoveredAt: at });
      delete this.#state.problems[key];
      this.#state.events.unshift({ at, kind: 'recovered', key, message: `${open.title}: working again.`, tenant: open.tenant ?? '' });
    }
    for (const [key, p] of seen) {
      const open = this.#state.problems[key];
      if (open) {
        open.checks += 1;
        open.lastAt = at;
        open.detail = p.detail ?? open.detail;
        continuing.push({ key, ...open });
      } else {
        this.#state.problems[key] = { title: p.title, detail: p.detail ?? '', tenant: p.tenant ?? '', since: at, lastAt: at, checks: 1, version, tried: [], notifiedAt: '', caseId: '' };
        started.push({ key, ...this.#state.problems[key] });
        this.#state.events.unshift({ at, kind: 'problem', key, message: `${p.title}: ${p.detail ?? ''}`.trim(), tenant: p.tenant ?? '' });
      }
    }
    // A version is "healthy" once a whole check passes while it runs.
    if (!found.length && version) this.#state.healthy[version] = at;
    this.#state.lastCheckAt = at;
    this.#state.events = this.#state.events.slice(0, EVENTS_KEPT);
    this.#save();
    return { started, continuing, recovered };
  }

  /** A problem put right by a repair: closed now, without waiting for the next check. */
  resolve(key, now = new Date()) {
    const open = this.#state.problems[key];
    if (!open) return;
    delete this.#state.problems[key];
    this.#state.events.unshift({ at: now.toISOString(), kind: 'recovered', key, message: `${open.title}: fixed by itself.`, tenant: open.tenant ?? '' });
    this.#save();
  }

  /** Remember a repair that was tried for a problem (each is tried once while it lasts). */
  tried(key, repair, outcome, now = new Date()) {
    const open = this.#state.problems[key];
    if (open && !open.tried.includes(repair)) open.tried.push(repair);
    this.#state.events.unshift({ at: now.toISOString(), kind: outcome === 'fixed' ? 'healed' : 'tried', key, message: `${repair}: ${outcome}.`, tenant: open?.tenant ?? '' });
    this.#state.events = this.#state.events.slice(0, EVENTS_KEPT);
    this.#save();
  }

  hasTried(key, repair) {
    return Boolean(this.#state.problems[key]?.tried.includes(repair));
  }

  markNotified(key, now = new Date()) {
    if (this.#state.problems[key]) this.#state.problems[key].notifiedAt = now.toISOString();
    this.#save();
  }

  markCase(key, caseId) {
    if (this.#state.problems[key]) this.#state.problems[key].caseId = caseId;
    this.#save();
  }

  /** Forget a problem's case once it is closed, so a new occurrence raises a new one. */
  forgetCase(caseId) {
    for (const p of Object.values(this.#state.problems)) if (p.caseId === caseId) p.caseId = '';
    this.#save();
  }

  wasHealthy(version) {
    return Boolean(this.#state.healthy[version]);
  }

  markRolledBack(version, now = new Date()) {
    this.#state.rolledBack.push({ version, at: now.toISOString() });
    this.#save();
  }

  hasRolledBack(version) {
    return this.#state.rolledBack.some((r) => r.version === version);
  }
}

/** Tell the administrators about this problem now? */
export const shouldNotify = (p) => p.checks >= NOTIFY_AFTER && !p.notifiedAt;

/** Raise a support case for it now? Only with auto-update on and the internet reachable. */
export const shouldRaiseCase = (p, { autoUpdate, online }) => p.checks >= CASE_AFTER && !p.caseId && Boolean(autoUpdate) && Boolean(online);

/**
 * The version to go back to, or '': the running version came in less than a day
 * ago, a problem started after it did, the previous version passed a whole check,
 * and this version was not rolled back from before.
 */
export function rollbackTarget({ problems, running, previous, switchedAt, wasHealthy, hasRolledBack, now = Date.now() }) {
  if (!previous || !switchedAt || previous === running || hasRolledBack(running)) return '';
  if (now - Date.parse(switchedAt) > DAY_MS) return '';
  const after = problems.filter((p) => p.checks >= NOTIFY_AFTER && Date.parse(p.since) >= Date.parse(switchedAt));
  return after.length && wasHealthy(previous) ? previous : '';
}
