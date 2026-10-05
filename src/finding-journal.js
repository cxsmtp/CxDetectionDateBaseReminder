/**
 * When each finding was first seen open, and when it stopped being open: no
 * longer reported by Checkmarx One (fixed, or removed), or judged not
 * exploitable. The Impact page (src/impact.js) works out time to fix, the
 * debt burn-down and the work AI saved from it.
 *
 * Filled from reads the server makes anyway (a Dashboard fetch, a tracked
 * report's refresh), never by extra calls to Checkmarx One. A finding is
 * marked gone only by a complete read of its project: every finding, no
 * date window, read without error.
 */

import fs from 'node:fs';
import path from 'node:path';

import { billingUnit } from './credit-allocations.js';

const DAY = 86_400_000;
/** Closed findings are kept this long, then forgotten (open ones are always kept). */
const KEEP_CLOSED_MS = 2 * 365 * DAY;
const NOT_EXPLOITABLE = new Set(['NOT_EXPLOITABLE', 'PROPOSED_NOT_EXPLOITABLE']);
const CONFIRMED = new Set(['CONFIRMED', 'URGENT']);

/**
 * One entry per finding, short keys to keep the file small:
 *   p project id · n project name · r risk id · u Checkmarx One result (billing unit)
 *   s severity · d first detected (Checkmarx One) · o first seen open here
 *   c confirmed at · x judged not exploitable at · g seen gone at
 */
export class FindingJournal {
  #file;
  #byProject = new Map(); // projectId -> Map(riskId -> entry)
  #count = 0;
  #dirty = false;
  #timer = null;
  #writeDelay;

  constructor({ file = null, writeDelayMs = 5000 } = {}) {
    this.#file = file;
    this.#writeDelay = writeDelayMs;
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const cutoff = new Date(Date.now() - KEEP_CLOSED_MS).toISOString();
      for (const e of Array.isArray(raw.findings) ? raw.findings : []) {
        if (!e?.p || !e?.r) continue;
        const closed = e.g ?? e.x;
        if (closed && closed < cutoff) continue;
        this.#put(e);
      }
    } catch {}
  }

  get size() {
    return this.#count;
  }

  #put(e) {
    let map = this.#byProject.get(e.p);
    if (!map) this.#byProject.set(e.p, (map = new Map()));
    if (!map.has(e.r)) this.#count += 1;
    map.set(e.r, e);
  }

  /**
   * What a read of one project showed. `complete`: every current finding of the
   * project was read, so those not among them are gone.
   */
  observe(project, risks, { complete = false, now = new Date() } = {}) {
    const projectId = String(project?.projectId ?? project?.id ?? '');
    if (!projectId) return;
    const projectName = String(project?.projectName ?? project?.name ?? '');
    const at = now.toISOString();
    const seen = complete ? new Set() : null;
    const known = this.#byProject.get(projectId);
    for (const risk of risks ?? []) {
      if (!risk?.riskId) continue;
      const riskId = String(risk.riskId);
      seen?.add(riskId);
      const state = String(risk.state ?? '').toUpperCase();
      let e = known?.get(riskId);
      if (!e) {
        e = { p: projectId, r: riskId, u: String(billingUnit(risk)), s: risk.severity, d: risk.firstDetectedAt ? String(risk.firstDetectedAt).slice(0, 10) : undefined, o: at };
        if (projectName) e.n = projectName;
        this.#put(e);
        this.#dirty = true;
      }
      if (e.g) {
        // Reported again: it was not fixed after all.
        delete e.g;
        this.#dirty = true;
      }
      if (risk.severity && e.s !== risk.severity) {
        e.s = risk.severity;
        this.#dirty = true;
      }
      if (projectName && e.n !== projectName) {
        e.n = projectName;
        this.#dirty = true;
      }
      if (NOT_EXPLOITABLE.has(state)) {
        if (!e.x) {
          e.x = at;
          this.#dirty = true;
        }
      } else if (e.x) {
        // Reopened (the verdict was changed back).
        delete e.x;
        this.#dirty = true;
      }
      if (CONFIRMED.has(state) && !e.c) {
        e.c = at;
        this.#dirty = true;
      }
    }
    if (seen && known) {
      for (const [riskId, e] of known) {
        if (seen.has(riskId) || e.g || e.x) continue;
        e.g = at;
        this.#dirty = true;
      }
    }
    if (this.#dirty) this.#schedule();
  }

  /** Every entry (copies), for the Impact page. */
  entries() {
    const out = [];
    for (const map of this.#byProject.values()) for (const e of map.values()) out.push({ ...e });
    return out;
  }

  #schedule() {
    if (!this.#file) return;
    if (this.#writeDelay <= 0) return this.flush();
    this.#timer ??= setTimeout(() => this.flush(), this.#writeDelay);
    this.#timer.unref?.();
  }

  flush() {
    clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.#file || !this.#dirty) return;
    this.#dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
      const tmp = `${this.#file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ findings: this.entries() }), { mode: 0o600 });
      fs.renameSync(tmp, this.#file);
    } catch (error) {
      this.#dirty = true;
      console.warn(`[journal] could not save ${this.#file}: ${error.message}`);
    }
  }
}
