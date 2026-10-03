/**
 * Audit log: an append-only, tamper-evident record of everything that spends
 * or governs Checkmarx One credits.
 *
 * One JSON object per line, one file per month (audit/audit-YYYY-MM.jsonl).
 * Each entry carries a sequence number and `mac`: an HMAC over the previous
 * entry's mac and this entry, keyed by audit.key. Editing, removing or
 * reordering any entry breaks the chain from that point on, which verify()
 * reports. Nothing is ever trimmed or rewritten.
 *
 * Entry shape (fields present when they apply):
 *   seq, id, at, type, outcome, reason
 *   actor:    {kind: report|admin|automation|system, user, recipient, reportId, ip, userAgent}
 *   project:  {id, name}
 *   findings: [{riskId, alternateId, scanId, scanner}]
 *   credits:  {kind: triage|remediation, requested, charged}
 *   balance:  {before: {allocated, used, remaining}, after: {…}}
 *   month:    {limit, remaining}
 *   upstream: {call, status, published, jobId, error, ms}
 *   details:  free-form, e.g. changed settings
 *
 * Outcomes: charged (credits consumed), not-charged (accepted, Checkmarx One
 * started no new job), refused (policy or credits: nothing sent), failed
 * (sent, and Checkmarx One or the network failed), changed, info.
 */

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const GENESIS = 'genesis';
export const OUTCOMES = ['charged', 'not-charged', 'refused', 'failed', 'changed', 'info'];
export const TYPES = ['triage', 'remediation', 'allocation', 'settings', 'report', 'backup', 'audit', 'access', 'iam'];

const monthOf = (iso) => {
  const month = String(iso).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`Not an audit month: ${month}`);
  return month;
};

function loadOrCreateKey(file) {
  try {
    const key = fs.readFileSync(file);
    if (key.length >= 32) return key;
  } catch {}
  const key = randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}

/** Stable JSON: keys sorted, so the mac does not depend on property order. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export class AuditLog {
  #dir;
  #key;
  #cache = new Map(); // month file -> {size, hash of those bytes, entries}
  #seq = 0;
  #lastMac = GENESIS;
  #unwritten = [];
  #lastError = '';

  constructor({ dir, keyFile }) {
    this.#dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.#key = loadOrCreateKey(keyFile ?? path.join(path.dirname(dir), 'audit.key'));
    this.#resume();
  }

  get dir() {
    return this.#dir;
  }

  /** Month files, oldest first. */
  files() {
    return fs
      .readdirSync(this.#dir)
      .filter((f) => /^audit-\d{4}-\d{2}\.jsonl$/.test(f))
      .sort();
  }

  /** Carry on the chain from the last entry written. */
  #resume() {
    this.#resumeChain();
    this.#remember();
  }

  #resumeChain() {
    const files = this.files();
    for (let i = files.length - 1; i >= 0; i -= 1) {
      const file = path.join(this.#dir, files[i]);
      const text = fs.readFileSync(file, 'utf8');
      // A crash mid-write leaves a torn last line: end it, so the next entry
      // starts on its own line (verify() reports the torn one).
      if (text && !text.endsWith('\n')) fs.appendFileSync(file, '\n');
      const lines = text.split('\n').filter(Boolean);
      for (let j = lines.length - 1; j >= 0; j -= 1) {
        try {
          const last = JSON.parse(lines[j]);
          this.#seq = last.seq;
          this.#lastMac = last.mac;
          return;
        } catch {
          // unreadable: try the line before
        }
      }
    }
  }

  #mac(entry, prevMac) {
    const { mac, ...body } = entry;
    return createHmac('sha256', this.#key).update(prevMac).update('\n').update(canonical(body)).digest('base64url');
  }

  /**
   * Append an entry; returns it (with seq, id, at and mac). Written before
   * this returns, so an answered request is never missing from the log. If
   * the disk refuses, the entry is held and written with the next one (or at
   * shutdown); `writeError` says so until then.
   */
  record(event, now = new Date()) {
    // Another process (e.g. an admin command run next to the server) may have
    // appended since: carry on the chain from what is really on disk.
    if (!this.#unwritten.length && this.#changedOnDisk()) this.#resume();
    // Number and time are the log's own (the time names the file). An event may bring the id
    // it was linked by beforehand (the credit ledger does), as long as it is a UUID.
    const id = typeof event.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.id) ? event.id : randomUUID();
    const entry = { ...event, seq: this.#seq + 1, id, at: now.toISOString() };
    entry.prev = this.#lastMac;
    entry.mac = this.#mac(entry, this.#lastMac);
    this.#seq = entry.seq;
    this.#lastMac = entry.mac;
    this.#unwritten.push(entry);
    this.flushSync();
    return entry;
  }

  /** Entries not yet on disk, and why (null when everything is written). */
  get writeError() {
    return this.#unwritten.length ? { entries: this.#unwritten.length, error: this.#lastError } : null;
  }

  #lastFile = '';
  #lastSize = -1;

  #changedOnDisk() {
    const files = this.files();
    const last = files.at(-1) ?? '';
    let size = -1;
    try {
      size = last ? fs.statSync(path.join(this.#dir, last)).size : -1;
    } catch {}
    return last !== this.#lastFile || size !== this.#lastSize;
  }

  #remember() {
    const last = this.files().at(-1) ?? '';
    this.#lastFile = last;
    try {
      this.#lastSize = last ? fs.statSync(path.join(this.#dir, last)).size : -1;
    } catch {
      this.#lastSize = -1;
    }
  }

  /** Write held entries, in order. */
  flushSync() {
    while (this.#unwritten.length) {
      const e = this.#unwritten[0];
      try {
        fs.appendFileSync(path.join(this.#dir, `audit-${monthOf(e.at)}.jsonl`), `${JSON.stringify(e)}\n`, { mode: 0o600 });
      } catch (error) {
        if (this.#lastError !== error.message) console.error(`[audit] could not write the audit log (${this.#unwritten.length} entries held): ${error.message}`);
        this.#lastError = error.message;
        return false;
      }
      this.#unwritten.shift();
    }
    this.#lastError = '';
    this.#remember();
    return true;
  }

  /** Kept for callers that wait for writes: entries are written synchronously. */
  async settled() {
    this.flushSync();
  }

  /**
   * A month file's entries, parsed. Parsing every line on every browse and check grew with
   * the log, so the parsed entries are kept and only lines appended since are parsed. The
   * part already parsed must still be byte for byte what it was (its hash is compared on
   * every call), so an edited, removed or reordered entry is always read again and seen by
   * the integrity check. Entries are shared between callers, so they are frozen.
   */
  #parsed(file) {
    let buffer;
    try {
      buffer = fs.readFileSync(path.join(this.#dir, file));
    } catch {
      return [];
    }
    const parseLine = (line) => {
      try {
        return Object.freeze(JSON.parse(line));
      } catch {
        return Object.freeze({ corrupt: true, file, line: line.slice(0, 200) });
      }
    };
    let cached = this.#cache.get(file);
    const prefixHash = (length) => createHash('sha256').update(buffer.subarray(0, length)).digest('base64');
    if (!cached || buffer.length < cached.size || prefixHash(cached.size) !== cached.hash) cached = { size: 0, hash: prefixHash(0), entries: [] };
    if (buffer.length > cached.size) {
      // Only whole lines are kept; a last line without its newline is shown but parsed again next time.
      const end = buffer.lastIndexOf(0x0a) + 1;
      const entries = cached.entries.slice();
      if (end > cached.size) {
        for (const line of buffer.subarray(cached.size, end).toString('utf8').split('\n')) if (line) entries.push(parseLine(line));
        cached = { size: end, hash: prefixHash(end), entries };
        this.#cache.set(file, cached);
      }
      const tail = buffer.subarray(Math.max(end, cached.size)).toString('utf8');
      if (tail.trim()) return [...cached.entries, parseLine(tail)];
    }
    return cached.entries;
  }

  /** Every entry of the months overlapping [from, to], oldest first. */
  *entries({ from = '', to = '' } = {}) {
    for (const file of this.files()) {
      const month = file.slice(6, 13);
      if (from && month < from.slice(0, 7)) continue;
      if (to && month > to.slice(0, 7)) continue;
      yield* this.#parsed(file);
    }
  }

  /**
   * Filtered entries, newest first, plus totals over everything matching.
   * filters: from/to (ISO dates), types, outcomes, project (id or name part), q (free text), before (seq), limit.
   */
  query({ from = '', to = '', types = [], outcomes = [], project = '', q = '', before = 0, limit = 200 } = {}) {
    const toEnd = to && to.length <= 10 ? `${to}T23:59:59.999Z` : to;
    const projectQ = String(project).toLowerCase();
    const text = String(q).toLowerCase();
    const matches = [];
    const totals = { entries: 0, charged: 0, triageCharged: 0, remediationCharged: 0, byOutcome: {}, byProject: {} };
    for (const e of this.entries({ from, to })) {
      if (e.corrupt) continue;
      if (from && e.at < from) continue;
      if (toEnd && e.at > toEnd) continue;
      if (types.length && !types.includes(e.type)) continue;
      if (outcomes.length && !outcomes.includes(e.outcome)) continue;
      if (projectQ && !`${e.project?.id ?? ''} ${e.project?.name ?? ''}`.toLowerCase().includes(projectQ)) continue;
      if (text && !JSON.stringify(e).toLowerCase().includes(text)) continue;
      totals.entries += 1;
      totals.byOutcome[e.outcome] = (totals.byOutcome[e.outcome] ?? 0) + 1;
      const charged = e.credits?.charged ?? 0;
      if (charged) {
        totals.charged += charged;
        if (e.credits.kind === 'remediation') totals.remediationCharged += charged;
        else totals.triageCharged += charged;
        const key = e.project?.id ?? '';
        const p = (totals.byProject[key] ??= { id: key, name: e.project?.name ?? '', charged: 0 });
        p.charged += charged;
      }
      if (before && e.seq >= before) continue;
      matches.push(e);
    }
    matches.sort((a, b) => b.seq - a.seq);
    const page = matches.slice(0, Math.max(1, Math.min(1000, limit)));
    return { entries: page, more: matches.length > page.length, next: page.at(-1)?.seq ?? 0, totals };
  }

  /**
   * Walk the whole chain. Returns {ok, entries, first, last, problems[]}: any
   * edited, missing, reordered or unreadable entry is reported with its place.
   */
  verify() {
    let prevMac = GENESIS;
    let expectedSeq = 1;
    let count = 0;
    const problems = [];
    let first = null;
    let last = null;
    for (const e of this.entries()) {
      if (e.corrupt) {
        problems.push({ file: e.file, problem: 'Unreadable line (edited, or a torn write).' });
        continue;
      }
      count += 1;
      first ??= e.at;
      last = e.at;
      if (e.seq !== expectedSeq) problems.push({ seq: e.seq, problem: `Expected entry #${expectedSeq}: entries missing or reordered.` });
      if (e.prev !== prevMac) problems.push({ seq: e.seq, problem: 'Does not follow the previous entry (chain broken).' });
      if (this.#mac(e, e.prev) !== e.mac) problems.push({ seq: e.seq, problem: 'Contents changed after it was written.' });
      prevMac = e.mac;
      expectedSeq = e.seq + 1;
      if (problems.length > 50) break;
    }
    return { ok: problems.length === 0, entries: count, first, last, problems };
  }
}
