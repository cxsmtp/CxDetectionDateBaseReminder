/**
 * Checkmarx One credits spent on AI Triage started from emailed reports.
 *
 * This is the utility's own record, not Checkmarx One's billing: one credit
 * per finding in an AI Triage request that Checkmarx One accepted as a new
 * job. Requests Checkmarx One de-duplicated (published: false) are not
 * counted. Credits are reserved before the call, so concurrent requests
 * cannot jointly overrun the monthly limit.
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_ENTRIES = 20_000;

export const monthOf = (date = new Date()) => date.toISOString().slice(0, 7);

export class CreditLedger {
  #file;
  #entries;
  #reserved = 0;

  constructor({ file } = {}) {
    this.#file = file ?? path.join(process.cwd(), 'data', 'triage-credits.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
      this.#entries = Array.isArray(raw.entries) ? raw.entries : [];
    } catch {
      this.#entries = [];
    }
  }

  usedInMonth(month = monthOf()) {
    return this.#entries.reduce((sum, e) => sum + (e.at.startsWith(month) ? e.credits : 0), 0);
  }

  /**
   * Hold `credits` against the month's limit (0 = no limit). Returns a
   * reservation to settle, or null when the limit would be exceeded.
   */
  reserve(credits, limit, now = new Date()) {
    const remaining = limit > 0 ? limit - this.usedInMonth(monthOf(now)) - this.#reserved : Infinity;
    if (credits > remaining) return null;
    this.#reserved += credits;
    let open = true;
    return {
      release: () => {
        if (open) this.#reserved -= credits;
        open = false;
      },
    };
  }

  remaining(limit, now = new Date()) {
    return limit > 0 ? Math.max(0, limit - this.usedInMonth(monthOf(now)) - this.#reserved) : null;
  }

  /** Record credits Checkmarx One accepted, one entry per project per request. */
  record({ projectId, projectName = '', credits, scanId = '' }, now = new Date()) {
    if (!credits) return;
    this.#entries.push({ at: now.toISOString(), projectId, projectName, credits, scanId });
    if (this.#entries.length > MAX_ENTRIES) this.#entries = this.#entries.slice(-MAX_ENTRIES);
    this.#persist();
  }

  /** Usage per project for one month (default: this month), most-used first. */
  summary(month = monthOf()) {
    const byProject = new Map();
    for (const e of this.#entries) {
      if (!e.at.startsWith(month)) continue;
      const row = byProject.get(e.projectId) ?? { projectId: e.projectId, projectName: '', credits: 0, requests: 0, lastUsedAt: '' };
      row.credits += e.credits;
      row.requests += 1;
      if (e.projectName) row.projectName = e.projectName;
      if (e.at > row.lastUsedAt) row.lastUsedAt = e.at;
      byProject.set(e.projectId, row);
    }
    const projects = [...byProject.values()].sort((a, b) => b.credits - a.credits);
    return { month, total: projects.reduce((sum, p) => sum + p.credits, 0), projects };
  }

  months() {
    return [...new Set(this.#entries.map((e) => e.at.slice(0, 7)))].sort().reverse();
  }

  #persist() {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ entries: this.#entries }), { mode: 0o600 });
    fs.renameSync(tmp, this.#file);
  }
}
