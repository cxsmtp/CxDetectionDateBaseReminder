/**
 * Checkmarx One credits spent on AI Triage and AI Remediation started from
 * emailed reports.
 *
 * This is the utility's own record, not Checkmarx One's billing: one credit
 * per finding in a request Checkmarx One accepted as a new job. Requests
 * Checkmarx One de-duplicated (published: false) are not counted. Credits
 * are reserved before the call, so concurrent requests cannot jointly
 * overrun the monthly limit.
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_ENTRIES = 20_000;

export const monthOf = (date = new Date()) => date.toISOString().slice(0, 7);

/** Checkmarx One credits per finding: AI Triage 1, AI Remediation 3. */
export const CREDIT_COST = { triage: 1, remediation: 3 };

export class CreditLedger {
  #file;
  #entries;
  #reserved = 0;
  #reservedBy = new Map();

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

  /** Credits a project has used for one kind of action, all time. */
  usedBy(projectId, kind) {
    return this.#entries.reduce(
      (sum, e) => sum + (e.projectId === projectId && (e.kind ?? 'triage') === kind ? e.credits : 0),
      0,
    );
  }

  /**
   * Of those, the credits spent on findings the project's rule covered when
   * they were spent (entries from before this was recorded count as covered).
   * The rest came out of extra credits the administrator added.
   */
  coveredBy(projectId, kind) {
    return this.#entries.reduce(
      (sum, e) => sum + (e.projectId === projectId && (e.kind ?? 'triage') === kind ? Math.min(e.credits, e.covered ?? e.credits) : 0),
      0,
    );
  }

  /** Findings of a project already sent for AI Remediation through this utility. */
  remediatedIds(projectId) {
    const ids = new Set();
    for (const e of this.#entries) {
      if (e.projectId === projectId && e.kind === 'remediation') for (const id of e.riskIds ?? []) ids.add(id);
    }
    return ids;
  }

  /** Credits these projects used since `since` (ISO time), by kind. */
  usedSince(projectIds, since) {
    const wanted = new Set(projectIds);
    const out = { triage: 0, remediation: 0 };
    for (const e of this.#entries) {
      if (e.at >= since && wanted.has(e.projectId)) out[e.kind === 'remediation' ? 'remediation' : 'triage'] += e.credits;
    }
    return out;
  }

  /** Credits held for requests still in flight for this project and kind. */
  reservedFor(projectId, kind) {
    return this.#reservedBy.get(`${projectId}|${kind}`) ?? 0;
  }

  /**
   * Hold `credits` against the month's limit (0 = no limit) and, when
   * `allowance` is given, against that project's allocation for `kind`.
   * Returns a reservation to release once the request is settled, or null
   * when either would be exceeded.
   */
  reserve(credits, limit, now = new Date(), { projectId, kind = 'triage', allowance } = {}) {
    const monthLeft = limit > 0 ? limit - this.usedInMonth(monthOf(now)) - this.#reserved : Infinity;
    if (credits > monthLeft) return null;
    const key = `${projectId}|${kind}`;
    if (allowance !== undefined && credits > allowance - this.usedBy(projectId, kind) - this.reservedFor(projectId, kind)) {
      return null;
    }
    this.#reserved += credits;
    if (projectId) this.#reservedBy.set(key, this.reservedFor(projectId, kind) + credits);
    let open = true;
    return {
      release: () => {
        if (!open) return;
        open = false;
        this.#reserved -= credits;
        if (projectId) this.#reservedBy.set(key, this.reservedFor(projectId, kind) - credits);
      },
    };
  }

  remaining(limit, now = new Date()) {
    return limit > 0 ? Math.max(0, limit - this.usedInMonth(monthOf(now)) - this.#reserved) : null;
  }

  /** Record credits Checkmarx One accepted, one entry per project per request. */
  record({ projectId, projectName = '', credits, scanId = '', kind = 'triage', riskIds, covered }, now = new Date()) {
    if (!credits) return;
    this.#entries.push({
      at: now.toISOString(),
      projectId,
      projectName,
      credits,
      scanId,
      kind,
      ...(riskIds?.length ? { riskIds } : {}),
      ...(Number.isFinite(covered) ? { covered: Math.max(0, Math.min(credits, covered)) } : {}),
    });
    if (this.#entries.length > MAX_ENTRIES) this.#entries = this.#entries.slice(-MAX_ENTRIES);
    this.#persist();
  }

  /** Usage per project for one month (default: this month), most-used first. */
  summary(month = monthOf()) {
    const byProject = new Map();
    for (const e of this.#entries) {
      if (!e.at.startsWith(month)) continue;
      const row = byProject.get(e.projectId) ?? {
        projectId: e.projectId,
        projectName: '',
        credits: 0,
        triageCredits: 0,
        remediationCredits: 0,
        requests: 0,
        lastUsedAt: '',
      };
      row.credits += e.credits;
      if (e.kind === 'remediation') row.remediationCredits += e.credits;
      else row.triageCredits += e.credits;
      row.requests += 1;
      if (e.projectName) row.projectName = e.projectName;
      if (e.at > row.lastUsedAt) row.lastUsedAt = e.at;
      byProject.set(e.projectId, row);
    }
    const projects = [...byProject.values()].sort((a, b) => b.credits - a.credits);
    const sum = (key) => projects.reduce((total, p) => total + p[key], 0);
    return {
      month,
      total: sum('credits'),
      triageTotal: sum('triageCredits'),
      remediationTotal: sum('remediationCredits'),
      projects,
    };
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
