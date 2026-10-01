/**
 * The interactive reports that went out by email, kept so the email's
 * "Let's start fixing the vulnerabilities" button can download the very same
 * file from the reminder server (mail clients cannot link to an attachment).
 *
 * One gzipped file per report, named by the report's id, in
 * <state folder>/report-files/. Files older than `ttlDays` (the life of the
 * signed grants inside them) are removed. Not part of backups: they expire,
 * and the attached copy in each email stays valid.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ID = /^[0-9a-f-]{36}$/i;

export class ReportFiles {
  #dir;
  #ttlMs;
  #lastPurge = 0;

  constructor({ dir, ttlDays = 30 }) {
    this.#dir = dir;
    this.#ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  }

  #file(id) {
    if (!ID.test(String(id))) return null;
    return path.join(this.#dir, `${id.toLowerCase()}.html.gz`);
  }

  save(id, html, { filename = '' } = {}) {
    const file = this.#file(id);
    if (!file) throw new Error('Invalid report id.');
    fs.mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, zlib.gzipSync(Buffer.from(String(html))), { mode: 0o600 });
    fs.renameSync(tmp, file);
    if (filename) fs.writeFileSync(`${file}.name`, String(filename).slice(0, 120), { mode: 0o600 });
    this.purge();
  }

  /** {html, filename, savedAt} or null when unknown or expired. */
  get(id, now = Date.now()) {
    const file = this.#file(id);
    if (!file) return null;
    try {
      const stat = fs.statSync(file);
      if (now - stat.mtimeMs > this.#ttlMs) return null;
      let filename = '';
      try {
        filename = fs.readFileSync(`${file}.name`, 'utf8');
      } catch {}
      return { html: zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'), filename, savedAt: stat.mtime.toISOString() };
    } catch {
      return null;
    }
  }

  /** Remove expired files; at most once an hour unless forced. */
  purge({ force = false, now = Date.now() } = {}) {
    if (!force && now - this.#lastPurge < 60 * 60 * 1000) return 0;
    this.#lastPurge = now;
    let removed = 0;
    let names = [];
    try {
      names = fs.readdirSync(this.#dir);
    } catch {
      return 0;
    }
    for (const name of names) {
      const file = path.join(this.#dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > this.#ttlMs) {
          fs.rmSync(file, { force: true });
          removed += 1;
        }
      } catch {}
    }
    return removed;
  }
}
