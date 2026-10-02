/**
 * One server per state folder.
 *
 * Credits, the ledger, the audit log's hash chain and the duplicate-send guard
 * all assume a single process owns the folder. Two containers on one volume
 * (for example an attempt at a side-by-side update) would corrupt them, so the
 * server holds a lock file with a heartbeat:
 *
 * - A clean stop removes it, so the next server starts at once.
 * - A lock whose heartbeat is older than staleMs belongs to a server that
 *   died; it is taken over.
 * - A live lock from another server: wait up to waitMs for it to go, then
 *   refuse to start, saying why.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export const LOCK_FILE = '.instance-lock';

export class InstanceLock {
  #file;
  #id = randomUUID();
  #staleMs;
  #beatMs;
  #timer = null;

  constructor(dataDir, { staleMs = 30_000, beatMs = 10_000 } = {}) {
    this.#file = path.join(dataDir, LOCK_FILE);
    this.#staleMs = staleMs;
    this.#beatMs = beatMs;
  }

  #read() {
    try {
      return JSON.parse(fs.readFileSync(this.#file, 'utf8'));
    } catch {
      return null;
    }
  }

  #write(flag) {
    fs.writeFileSync(this.#file, JSON.stringify({ id: this.#id, host: os.hostname(), pid: process.pid, startedAt: this.startedAt, beat: Date.now() }), { mode: 0o600, flag });
  }

  /** Take the lock, waiting for another live server to let go. Throws if it does not within waitMs. */
  async acquire({ waitMs = 45_000, onWait = () => {} } = {}) {
    this.startedAt = new Date().toISOString();
    const until = Date.now() + waitMs;
    let told = false;
    for (;;) {
      try {
        this.#write('wx'); // created only if nobody holds it
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const held = this.#read();
      if (!held || Date.now() - Number(held.beat) > this.#staleMs) {
        fs.rmSync(this.#file, { force: true }); // a server that died: take over
        continue;
      }
      if (Date.now() > until) {
        throw new Error(`Another Mission Zero server (host ${held.host}, started ${held.startedAt}) is using this data folder. Stop it first; two servers on one data folder would corrupt credits and the audit log.`);
      }
      if (!told) onWait(held);
      told = true;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    this.#timer = setInterval(() => {
      try {
        this.#write('w');
      } catch {}
    }, this.#beatMs);
    this.#timer.unref?.();
    return this;
  }

  /** Let go (only if it is still ours). */
  release() {
    clearInterval(this.#timer);
    if (this.#read()?.id === this.#id) fs.rmSync(this.#file, { force: true });
  }
}
