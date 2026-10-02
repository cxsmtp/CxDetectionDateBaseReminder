/**
 * Last known good connection settings, so the utility keeps working while an
 * administrator edits them.
 *
 * Settings save as they are typed. The two that can break the utility — the
 * Checkmarx One integration and the mail server — are checked before they
 * count: whenever a check passes, that configuration becomes the "last known
 * good" one. When a changed configuration does not work (wrong key, wrong host,
 * a connection that times out), the server puts the last known good one back
 * and leaves a notice that every administrator sees once, at their next
 * sign-in if they were not there when it happened.
 *
 * Kept in its own file in the state folder, owner-readable only: it holds the
 * integration key and the SMTP password, like settings.json does.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_NOTICES = 50;

/** What a notice shows about a mail server: never the password. */
export function describeSmtp(smtp = {}) {
  return {
    host: smtp.host ?? '',
    port: smtp.port ?? '',
    secure: Boolean(smtp.secure),
    user: smtp.user ?? '',
    fromName: smtp.fromName ?? '',
    fromAddress: smtp.fromAddress ?? '',
  };
}

/** What a notice shows about a Checkmarx One connection: never the key. */
export function describeCxone(entry = {}) {
  const c = entry.connection ?? {};
  const o = entry.overrides ?? {};
  return {
    tenant: c.tenant || o.tenant || '',
    baseUrl: c.baseUrl || o.baseUrl || '',
    iamUrl: c.iamUrl || o.iamUrl || '',
  };
}

export class ConnectionGuard {
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
        lkg: { cxone: raw.lkg?.cxone ?? null, smtp: raw.lkg?.smtp ?? null },
        notices: Array.isArray(raw.notices) ? raw.notices : [],
        changedAt: raw.changedAt ?? null,
      };
    } catch {
      return { lkg: { cxone: null, smtp: null }, notices: [], changedAt: null };
    }
  }

  #save() {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.#state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.#file);
  }

  /** The last configuration of `part` ('cxone' | 'smtp') that worked, or null. */
  lastGood(part) {
    const entry = this.#state.lkg[part];
    return entry ? structuredClone(entry) : null;
  }

  /**
   * Remember a configuration that just worked.
   * cxone: {apiKey, overrides, connection: {tenant, baseUrl, iamUrl}}; smtp: the SMTP settings.
   */
  recordGood(part, value, now = new Date()) {
    this.#state.lkg[part] = { ...structuredClone(value), at: now.toISOString() };
    this.#save();
  }

  /** An administrator changed a connection setting: the idle check counts from now. */
  touch(now = new Date()) {
    this.#state.changedAt = now.toISOString();
    this.#save();
  }

  /** The changes were checked: nothing waits for the idle check any more. */
  settle() {
    if (this.#state.changedAt === null) return;
    this.#state.changedAt = null;
    this.#save();
  }

  get changedAt() {
    return this.#state.changedAt;
  }

  /**
   * A rollback happened: `parts` is [{part, error, timedOut, attempted, restored}].
   * Returns the notice.
   */
  addNotice({ trigger, actor = '', parts }, now = new Date()) {
    const notice = { id: randomUUID(), at: now.toISOString(), trigger, actor, parts, seenBy: [] };
    this.#state.notices.push(notice);
    this.#state.notices = this.#state.notices.slice(-MAX_NOTICES);
    this.#save();
    return structuredClone(notice);
  }

  /** Notices this person has not acknowledged yet, oldest first. */
  unseen(userId) {
    return this.#state.notices.filter((n) => !n.seenBy.includes(userId)).map(({ seenBy, ...n }) => structuredClone(n));
  }

  /** Mark notices seen by this person (all of them when `ids` is empty). Returns how many. */
  acknowledge(userId, ids = []) {
    const wanted = new Set(ids);
    let count = 0;
    for (const notice of this.#state.notices) {
      if ((wanted.size && !wanted.has(notice.id)) || notice.seenBy.includes(userId)) continue;
      notice.seenBy.push(userId);
      count += 1;
    }
    if (count) this.#save();
    return count;
  }
}
