/**
 * Sign-ins that outlive the server process.
 *
 * Every password sign-in is written to the state folder as it happens, and
 * each person's fetched data shortly after it changes, so a restart of any kind
 * keeps them signed in with their Dashboard data:
 * - an update (podman run --replace, podman stop);
 * - a crash, `podman kill`, or a host reboot.
 * The next server picks each session up when its browser next calls.
 *
 * - Session ids are stored only as a SHA-256 hash: nothing here can be used to
 *   sign in; only the browser that holds the cookie gets its session back.
 * - Sessions opened with a person's own Checkmarx One API key are never
 *   written: that key never touches the disk, so those people sign in again.
 * - Everything is owner-only (0700 folder, 0600 files). Signing out, idling
 *   out, being disabled or removed, and a password reset delete the entry.
 *
 * Layout: <dataDir>/sessions/index.json (who is signed in) and
 * <dataDir>/sessions/<key>.scan.json.gz (what each fetched).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

/** From MZ-01.00.10, which handed sessions over only on a clean stop: read once, if present. */
export const HANDOVER_FILE = 'handover.json.gz';
const LEGACY_MAX_AGE_MS = 60 * 60 * 1000;

export const sessionKey = (id) => createHash('sha256').update(`mz-session|${id}`).digest('hex');

/** Dates in the fetched data that JSON turns into strings. */
function reviveScan(scan) {
  const w = scan?.detectionWindow;
  if (w) for (const key of ['from', 'to']) if (typeof w[key] === 'string') w[key] = new Date(w[key]);
  return scan;
}

const meta = ({ key, userId, via, createdAt, lastUsedAt }) => ({ key, userId, via, createdAt, lastUsedAt });

export class SessionPersistence {
  #dir;
  #legacy;
  #pending = new Map(); // key -> latest scan to write (coalesced)
  #writing = null;
  #latest = new Map(); // key -> scan waiting for its turn
  #timers = new Map(); // key -> timer
  #savedAt = new Map(); // key -> when it was last queued for writing
  #saveEveryMs = Math.max(0, Number(process.env.SESSION_SAVE_SECONDS ?? 30)) * 1000;

  constructor(dataDir) {
    this.#dir = path.join(dataDir, 'sessions');
    this.#legacy = path.join(dataDir, HANDOVER_FILE);
    fs.mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
  }

  #scanFile(key) {
    return path.join(this.#dir, `${key}.scan.json.gz`);
  }

  /**
   * Everyone signed in when the last server stopped (or died):
   * [{key, userId, via, createdAt, lastUsedAt, lastScan?}]. Fetched data is
   * read when the session is picked up (readScan), not all at start-up.
   */
  load() {
    const entries = new Map();
    try {
      const index = JSON.parse(fs.readFileSync(path.join(this.#dir, 'index.json'), 'utf8'));
      for (const s of index?.sessions ?? []) if (s && typeof s.key === 'string' && /^[0-9a-f]{64}$/.test(s.key) && s.userId) entries.set(s.key, meta(s));
    } catch {}
    // A clean stop of MZ-01.00.10 left its sessions in one file.
    if (fs.existsSync(this.#legacy)) {
      try {
        const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(this.#legacy)).toString('utf8'));
        if (data?.version === 1 && Date.now() - Number(data.savedAt) <= LEGACY_MAX_AGE_MS) {
          for (const s of data.sessions ?? []) if (s?.key && s.userId) entries.set(s.key, { ...meta(s), lastScan: reviveScan(s.lastScan) });
        }
      } catch {}
      fs.rmSync(this.#legacy, { force: true });
    }
    return [...entries.values()];
  }

  /** The fetched data saved for a session (or null). */
  readScan(key) {
    try {
      return reviveScan(JSON.parse(zlib.gunzipSync(fs.readFileSync(this.#scanFile(key))).toString('utf8')));
    } catch {
      return null;
    }
  }

  /** Who is signed in, now: [{key, userId, via, createdAt, lastUsedAt}]. Written at once, atomically. Unknown scan files are removed. */
  saveIndex(entries) {
    const file = path.join(this.#dir, 'index.json');
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, savedAt: Date.now(), sessions: entries.map(meta) }), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    const keep = new Set(entries.map((e) => `${e.key}.scan.json.gz`));
    for (const name of fs.readdirSync(this.#dir)) {
      if (name.endsWith('.scan.json.gz') && !keep.has(name) && !this.#pending.has(name.slice(0, 64)) && !this.#latest.has(name.slice(0, 64))) fs.rmSync(path.join(this.#dir, name), { force: true });
    }
  }

  /**
   * Save a session's fetched data in the background: at once the first time, then at most
   * every SESSION_SAVE_SECONDS (30) per session, the latest one winning. Turning a large
   * fetch into JSON blocks the server for a moment, and people who re-fetch often paid it
   * every time. A stop or update writes everything still waiting at once (flushSync).
   */
  saveScan(key, scan) {
    if (!scan) return;
    this.#latest.set(key, scan);
    if (this.#timers.has(key)) return; // already due
    const wait = Math.max(0, (this.#savedAt.get(key) ?? 0) + this.#saveEveryMs - Date.now());
    const due = () => {
      this.#timers.delete(key);
      const latest = this.#latest.get(key);
      this.#latest.delete(key);
      if (!latest) return;
      this.#savedAt.set(key, Date.now());
      this.#pending.set(key, latest);
      this.#writing ??= this.#drain().finally(() => (this.#writing = null));
    };
    if (!wait) return due();
    const timer = setTimeout(due, wait);
    timer.unref?.();
    this.#timers.set(key, timer);
  }

  async #drain() {
    while (this.#pending.size) {
      const [key, scan] = this.#pending.entries().next().value;
      this.#pending.delete(key);
      try {
        const body = await new Promise((resolve, reject) => zlib.gzip(JSON.stringify(scan), (error, out) => (error ? reject(error) : resolve(out))));
        const file = this.#scanFile(key);
        await fs.promises.writeFile(`${file}.tmp`, body, { mode: 0o600 });
        await fs.promises.rename(`${file}.tmp`, file);
      } catch {}
    }
  }

  /** Write everything still queued, now (on stop). Also saves the given scans: [{key, scan}]. */
  flushSync(scans = []) {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    for (const [key, scan] of this.#latest) this.#pending.set(key, scan);
    this.#latest.clear();
    for (const { key, scan } of scans) if (scan) this.#pending.set(key, scan);
    for (const [key, scan] of this.#pending) {
      try {
        const file = this.#scanFile(key);
        fs.writeFileSync(`${file}.tmp`, zlib.gzipSync(JSON.stringify(scan)), { mode: 0o600 });
        fs.renameSync(`${file}.tmp`, file);
      } catch {}
    }
    this.#pending.clear();
  }

  /** A session ended: its fetched data goes too. */
  forget(key) {
    this.#pending.delete(key);
    this.#latest.delete(key);
    this.#savedAt.delete(key);
    clearTimeout(this.#timers.get(key));
    this.#timers.delete(key);
    fs.rmSync(this.#scanFile(key), { force: true });
  }

  /** Start afresh (after a restore from backup). */
  clear() {
    this.#pending.clear();
    fs.rmSync(this.#dir, { recursive: true, force: true });
    fs.mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    fs.rmSync(this.#legacy, { force: true });
  }
}
