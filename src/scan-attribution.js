/**
 * Who a rescan is really for.
 *
 * Checkmarx One records a scan's initiator as the owner of the API key that
 * started it: the verification rescans CxMissionZero starts would all show
 * this server's key. So each one is recorded here with the developer whose
 * work it verifies (the previous scan's initiator) and who asked for it; when
 * the latest scan of a project is one of these, reminders, reports and the
 * dashboard still name that developer. The rescan also carries the same names
 * as Checkmarx One tags, so it reads right there too.
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_ENTRIES = 5000;
const KEEP_MS = 400 * 24 * 60 * 60 * 1000;

export class ScanAttribution {
  #file;
  #entries = new Map();

  constructor({ dataDir }) {
    this.#file = path.join(dataDir, 'scan-attribution.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
      for (const [scanId, entry] of Object.entries(raw?.scans ?? {})) {
        if (typeof scanId === 'string' && entry && typeof entry.initiator === 'string') this.#entries.set(scanId, entry);
      }
    } catch {}
  }

  /** The developer a scan this server started is credited to, or null. */
  get(scanId) {
    return this.#entries.get(String(scanId ?? '')) ?? null;
  }

  /** Credit `scanId` to {initiator, email} (who asked for it is kept too). */
  record(scanId, { projectId = '', initiator = '', email = '', requestedBy = '', reason = '' } = {}) {
    if (!scanId || !initiator) return;
    this.#entries.set(String(scanId), { projectId, initiator, email, requestedBy, reason, at: new Date().toISOString() });
    const cutoff = Date.now() - KEEP_MS;
    for (const [id, entry] of this.#entries) if (Date.parse(entry.at) < cutoff) this.#entries.delete(id);
    while (this.#entries.size > MAX_ENTRIES) this.#entries.delete(this.#entries.keys().next().value);
    this.#save();
  }

  #save() {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ scans: Object.fromEntries(this.#entries) }), { mode: 0o600 });
    fs.renameSync(tmp, this.#file);
  }
}

/** A Checkmarx One tag value: letters, digits and the characters of an address, at most 120. */
export const tagValue = (text) => String(text ?? '').replace(/[^\w@.+-]+/g, '_').slice(0, 120);
