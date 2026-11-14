/**
 * One server per state folder.
 *
 * Credits, the ledger, the audit log's hash chain and the duplicate-send guard
 * all assume a single process owns the folder. Two containers on one volume
 * (for example an attempt at a side-by-side update) would corrupt them, so the
 * server holds a lock file with a heartbeat:
 *
 * - A clean stop removes it, so the next server starts at once.
 * - A lock that has not changed for staleMs, as watched by the server that
 *   wants it and timed on that server's own clock, belongs to a server that
 *   died; it is taken over. The time written in the file is never compared
 *   with this machine's clock: the other server may be on another machine.
 * - A lock that changes while it is watched belongs to a live server: wait up
 *   to waitMs for it to go, then refuse to start, saying why.
 * - A lock that cannot be read is treated as held, never as free.
 *
 * Node has no flock, so the file's own operations carry the guarantees:
 *
 * - The heartbeat is written to a temporary file and renamed over the lock,
 *   so a reader sees the old lock or the new one, never half of one.
 * - A dead server's lock is taken by renaming it aside, which only one of
 *   several starting servers can do, and then creating the new lock
 *   exclusively; the others find it gone or already replaced and wait.
 *   Only one starting server at a time may try: it holds a second file,
 *   created exclusively, for those few steps, so none of them ever moves
 *   aside the new lock another has just made.
 * - Before every heartbeat the holder reads the lock. If it no longer names
 *   this server, this server has lost it: it stops beating and onLost runs.
 *   By default that ends the process at once, without the usual clean stop,
 *   because a clean stop saves everything, into a folder that now belongs
 *   to another server.
 *
 * What a file cannot give: a server that was frozen for longer than staleMs
 * (a suspended machine) and taken over meanwhile only finds out at its next
 * heartbeat, which is the first thing it does when it wakes.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export const LOCK_FILE = '.instance-lock';

/** How many times a lock that is missing or cannot be parsed is read again before anything is decided. */
const READ_TRIES = 5;
/** A heartbeat interval read from somebody else's lock is believed up to this. */
const MAX_FOREIGN_BEAT_MS = 60_000;

const pause = (ms, { keepAlive = true } = {}) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (!keepAlive) timer.unref?.();
  });

function parse(raw) {
  try {
    const held = JSON.parse(raw);
    return held && typeof held === 'object' && typeof held.id === 'string' ? held : null;
  } catch {
    return null;
  }
}

/**
 * What a lock file looks like now: {there, sig, raw, held, error}.
 * `sig` changes whenever the file's content or its modified time does; `held`
 * is its content when that is a whole lock, else null.
 */
function look(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { mtimeMs } = fs.fstatSync(fd);
    const raw = fs.readFileSync(fd, 'utf8');
    return { there: true, sig: `${mtimeMs} ${raw}`, raw, held: parse(raw), error: null };
  } catch (error) {
    if (error.code === 'ENOENT') return { there: false, sig: '!ENOENT', raw: '', held: null, error: null };
    return { there: true, sig: `!${error.code}`, raw: '', held: null, error };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

/**
 * The default when the lock is lost: say why and end the process at once.
 * Not process.exit and not the server's clean stop: both save what is in
 * memory, and the folder now belongs to another server.
 */
function stopAtOnce(reason) {
  try {
    fs.writeSync(2, `! ${reason} Stopping at once, without saving anything more: two servers must never write one data folder.\n`);
  } catch {}
  try {
    process.kill(process.pid, 'SIGKILL');
  } catch {}
  process.exit(1);
}

export class InstanceLock {
  #file;
  #tmp;
  #gate;
  #id = randomUUID();
  #staleMs;
  #beatMs;
  #pollMs;
  #retryMs;
  #onLost;
  #timer = null;
  #state = 'idle'; // idle → held → lost | released
  #seq = 0;
  #beating = false;
  #confirmedAt = 0;

  /**
   * staleMs: how long a lock must go unchanged before it is taken over.
   * beatMs: how often the holder rewrites it (at most a third of staleMs).
   * pollMs: how often a waiting server looks at it.
   * retryMs: the pause before reading again a lock that is missing or cannot be parsed.
   * onLost(reason, holder): called once if another server takes the lock from this one.
   */
  constructor(dataDir, { staleMs = 30_000, beatMs = 10_000, pollMs, retryMs = 50, onLost = stopAtOnce } = {}) {
    this.#file = path.join(dataDir, LOCK_FILE);
    this.#tmp = `${this.#file}.${this.#id}.tmp`;
    this.#gate = `${this.#file}.takeover`;
    this.#staleMs = staleMs;
    // At least three beats per stale window, or a live server's lock looks dead between beats.
    this.#beatMs = Math.max(10, Math.min(beatMs, Math.floor(staleMs / 3)));
    this.#pollMs = Math.max(1, pollMs ?? Math.min(1000, Math.floor(staleMs / 20)));
    this.#retryMs = Math.max(1, retryMs);
    this.#onLost = onLost;
  }

  /** This server's name in the lock file. */
  get id() {
    return this.#id;
  }

  /** True from a successful acquire() until release(), or until the lock is lost. */
  get held() {
    return this.#state === 'held';
  }

  #body() {
    this.#seq += 1;
    // `beat` is this machine's time, kept for people reading the file and for servers up to MZ-01.01.09;
    // `seq` makes every beat differ; `beatMs` tells a waiting server how often to expect one.
    return JSON.stringify({ id: this.#id, host: os.hostname(), pid: process.pid, startedAt: this.startedAt, beat: Date.now(), seq: this.#seq, beatMs: this.#beatMs });
  }

  /** Look at the lock, reading again a few times while it is there but not a whole lock (a writer in the middle of it). */
  async #read() {
    for (let attempt = 1; ; attempt += 1) {
      const seen = look(this.#file);
      if (!seen.there || seen.held || attempt >= READ_TRIES) return seen;
      await pause(this.#retryMs);
    }
  }

  /** Create the lock if nobody has one. False if there is one. */
  #create() {
    let fd;
    try {
      fd = fs.openSync(this.#file, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    }
    try {
      fs.writeSync(fd, this.#body());
      fs.closeSync(fd);
    } catch (error) {
      // Ours, and empty or half written (a full disk): do not leave it in the next server's way.
      try {
        fs.closeSync(fd);
      } catch {}
      fs.rmSync(this.#file, { force: true });
      throw error;
    }
    return true;
  }

  /**
   * Take a dead server's lock, the one that looked like `staleSig` for the whole stale time.
   * Renaming it aside is the step only one starting server can win. True if the lock is now
   * ours, false if not, 'busy' if another starting server is in the middle of taking it.
   */
  #takeOver(staleSig) {
    // One at a time. Without this, a second server could move aside the lock the first has
    // just made, and a third could make its own in that instant.
    let gate;
    try {
      gate = fs.openSync(this.#gate, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') return 'busy';
      throw error;
    }
    const aside = `${this.#file}.stale-${this.#id}`;
    try {
      try {
        fs.writeSync(gate, this.#id);
      } catch {}
      fs.closeSync(gate);
      if (look(this.#file).sig !== staleSig) return false; // it moved on at the last moment
      try {
        fs.renameSync(this.#file, aside);
      } catch (error) {
        if (error.code === 'ENOENT') return false; // let go, or taken by an older version, just now
        throw error;
      }
      if (look(aside).sig !== staleSig) {
        // Its server beat between our last look and the rename: it is alive, only slow.
        // Put its lock back, unless a new one has been made meanwhile.
        try {
          fs.linkSync(aside, this.#file);
        } catch (error) {
          if (error.code !== 'EEXIST') {
            try {
              fs.copyFileSync(aside, this.#file, fs.constants.COPYFILE_EXCL); // a folder without hard links
            } catch {}
          }
        }
        return false;
      }
      return this.#create(); // false: a server starting at this very moment made its own first
    } finally {
      for (const file of [aside, this.#gate]) {
        try {
          fs.rmSync(file, { force: true, recursive: true });
        } catch {}
      }
    }
  }

  /**
   * A takeover somebody began and never finished (it was killed in the middle) would keep
   * every later server out. One that looked like `deadSig` for a whole stale time is cleared.
   */
  #clearTakeOver(deadSig) {
    const seen = look(this.#gate);
    if (seen.sig !== deadSig) return;
    const aside = `${this.#gate}.dead-${this.#id}`;
    try {
      fs.renameSync(this.#gate, aside);
    } catch {
      return; // another starting server cleared it first
    }
    // What that server had moved aside, if it got that far: the file carries its name.
    const leftover = /^[0-9a-f-]{36}$/.test(seen.raw) ? [`${this.#file}.stale-${seen.raw}`] : [];
    for (const file of [aside, ...leftover]) {
      try {
        fs.rmSync(file, { force: true, recursive: true });
      } catch {}
    }
  }

  /** Take the lock, waiting for another live server to let go. Throws if it does not within waitMs. */
  async acquire({ waitMs = 45_000, onWait = () => {} } = {}) {
    this.startedAt = new Date().toISOString();
    const began = performance.now();
    let sig = null; // what the lock looked like when last seen
    let since = 0; // since when, on this server's own clock
    let alive = false; // it changed while we watched: its server is running
    let told = false;
    let retried = false;
    let gate = null; // {sig, since}: a takeover by another starting server that is in our way
    for (;;) {
      if (this.#create()) break; // created only if nobody holds it
      const seen = await this.#read();
      if (!seen.there && !retried) {
        retried = true; // let go between our two steps: try again at once
        continue;
      }
      retried = false;
      const now = performance.now();
      if (seen.sig !== sig) {
        if (sig !== null) alive = true;
        sig = seen.sig;
        since = now;
      }
      // Never sooner than three of the holder's own beats, should it beat more slowly than we expect.
      const staleMs = Math.max(this.#staleMs, 3 * Math.min(Number(seen.held?.beatMs) || 0, MAX_FOREIGN_BEAT_MS));
      if (now - since >= staleMs) {
        const took = this.#takeOver(sig);
        if (took === true) {
          // Taken over. Should its server have been alive after all and beating at that very
          // moment, its beat has replaced our new lock: look once more before believing it.
          await pause(this.#retryMs);
          if (look(this.#file).held?.id === this.#id) break;
        }
        const busy = took === 'busy' ? look(this.#gate).sig : null;
        if (busy === null || busy !== gate?.sig) gate = busy === null ? null : { sig: busy, since: now };
        else if (now - gate.since >= staleMs) {
          this.#clearTakeOver(gate.sig);
          gate = null;
        }
      }
      const holder = seen.held ?? { host: 'unknown', startedAt: 'unknown' };
      // Refused only on evidence that it is alive. A lock that never changes is taken over
      // above once it is stale, even when waitMs is shorter than the stale time.
      if (alive && seen.there && now - began >= waitMs) {
        const error = new Error(`Another CxMissionZero server (host ${holder.host}, started ${holder.startedAt}) is using this data folder. Stop it first; two servers on one data folder would corrupt credits and the audit log.`);
        error.code = 'ELOCKED';
        error.holder = holder;
        throw error;
      }
      if (!told && seen.there) {
        told = true;
        onWait(holder);
      }
      await pause(this.#pollMs);
    }
    this.#state = 'held';
    this.#confirmedAt = performance.now();
    this.#timer = setInterval(() => this.#beat(), this.#beatMs);
    this.#timer.unref?.();
    return this;
  }

  /** One heartbeat: check the lock is still ours, then replace it with a fresh one. */
  async #beat() {
    if (this.#state !== 'held' || this.#beating) return;
    this.#beating = true;
    try {
      // Written first, so that nothing but the rename stands between the check and the beat.
      let ready = false;
      try {
        fs.writeFileSync(this.#tmp, this.#body(), { mode: 0o600 });
        ready = true;
      } catch {}
      for (let attempt = 1; ; attempt += 1) {
        const seen = look(this.#file);
        if (this.#state !== 'held') return; // released while we waited to look again
        if (seen.held?.id === this.#id) {
          this.#confirmedAt = performance.now();
          try {
            if (!ready) throw new Error('no new lock to put in place');
            fs.renameSync(this.#tmp, this.#file);
          } catch {
            // A full disk, or a file held open on Windows: a new modified time is a beat too.
            try {
              const now = new Date();
              fs.utimesSync(this.#file, now, now);
            } catch {}
          }
          return;
        }
        if (seen.held) return this.#lose(`another CxMissionZero server (host ${seen.held.host ?? 'unknown'}, started ${seen.held.startedAt ?? 'unknown'}) has taken it over`, seen.held);
        if (seen.error) {
          // Not readable just now (the disk, the network share). Without proof for a whole
          // stale time that it is still ours, another server may rightly have taken it.
          if (performance.now() - this.#confirmedAt >= this.#staleMs) return this.#lose(`it could not be read for ${Math.round(this.#staleMs / 1000)} s (${seen.error.code ?? seen.error.message})`, null);
          return;
        }
        // Missing, or not a whole lock: look again a few times before believing it.
        if (attempt >= READ_TRIES) return this.#lose(seen.there ? 'it was overwritten with something that is not a lock' : 'the lock file was removed', null);
        await pause(this.#retryMs, { keepAlive: false });
      }
    } catch {
      // Never out of a timer: the next beat tries again.
    } finally {
      this.#beating = false;
    }
  }

  #lose(why, holder) {
    this.#state = 'lost';
    clearInterval(this.#timer);
    this.#timer = null;
    try {
      fs.rmSync(this.#tmp, { force: true });
    } catch {}
    this.#onLost(`Lost the lock on the data folder ${path.dirname(this.#file)}: ${why}.`, holder);
  }

  /** Let go (only if it is still ours). */
  release() {
    clearInterval(this.#timer);
    this.#timer = null;
    const was = this.#state;
    this.#state = 'released';
    try {
      fs.rmSync(this.#tmp, { force: true });
    } catch {}
    if (was !== 'held') return; // never taken, or lost: whatever is there is not ours to remove
    if (look(this.#file).held?.id === this.#id) fs.rmSync(this.#file, { force: true });
  }
}
