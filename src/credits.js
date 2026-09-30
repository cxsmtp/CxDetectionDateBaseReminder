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


export const monthOf = (date = new Date()) => date.toISOString().slice(0, 7);

/** Checkmarx One credits per finding: AI Triage 1, AI Remediation 3. */
export const CREDIT_COST = { triage: 1, remediation: 3 };

export class CreditLedger {
  #file;
  #entries;
  #reserved = 0;
  #reservedBy = new Map();
  // Running totals, so balance checks stay O(1) however long the ledger grows.
  #totals = new Map(); // `${projectId}|${kind}` -> {used, covered}
  #months = new Map(); // 'YYYY-MM' -> credits
  #remediated = new Map(); // projectId -> Set of risk ids
  #writeTimer = null;
  #writeDelay;

  constructor({ file, writeDelayMs = 200 } = {}) {
    this.#file = file ?? path.join(process.cwd(), 'data', 'triage-credits.json');
    this.#writeDelay = writeDelayMs;
    try {
      const raw = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
      this.#entries = Array.isArray(raw.entries) ? raw.entries : [];
    } catch {
      this.#entries = [];
    }
    this.#reindex();
  }

  #reindex() {
    this.#totals.clear();
    this.#months.clear();
    this.#remediated.clear();
    for (const e of this.#entries) this.#index(e);
  }

  #index(e) {
    const key = `${e.projectId}|${e.kind ?? 'triage'}`;
    const t = this.#totals.get(key) ?? { used: 0, covered: 0 };
    t.used += e.credits;
    t.covered += Math.min(e.credits, e.covered ?? e.credits);
    this.#totals.set(key, t);
    const month = e.at.slice(0, 7);
    this.#months.set(month, (this.#months.get(month) ?? 0) + e.credits);
    if (e.kind === 'remediation' && e.riskIds?.length) {
      if (!this.#remediated.has(e.projectId)) this.#remediated.set(e.projectId, new Set());
      for (const id of e.riskIds) this.#remediated.get(e.projectId).add(id);
    }
  }

  usedInMonth(month = monthOf()) {
    return this.#months.get(month) ?? 0;
  }

  /** Credits a project has used for one kind of action, all time. */
  usedBy(projectId, kind) {
    return this.#totals.get(`${projectId}|${kind}`)?.used ?? 0;
  }

  /**
   * Of those, the credits spent on findings the project's rule covered when
   * they were spent (entries from before this was recorded count as covered).
   * The rest came out of extra credits the administrator added.
   */
  coveredBy(projectId, kind) {
    return this.#totals.get(`${projectId}|${kind}`)?.covered ?? 0;
  }

  /** Findings of a project already sent for AI Remediation through this utility. */
  remediatedIds(projectId) {
    return new Set(this.#remediated.get(projectId) ?? []);
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
  record({ projectId, projectName = '', credits, scanId = '', kind = 'triage', riskIds, covered, auditId }, now = new Date()) {
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
      ...(auditId ? { auditId } : {}),
    });
    const entry = this.#entries.at(-1);
    // Never trimmed: this is the record of credits spent, and the audit log refers to it.
    this.#index(entry);
    this.#schedule();
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

  /** The ledger's own entries for a month (for reconciliation). */
  entriesInMonth(month) {
    return this.#entries.filter((e) => e.at.startsWith(month)).map((e) => ({ ...e }));
  }

  months() {
    return [...new Set(this.#entries.map((e) => e.at.slice(0, 7)))].sort().reverse();
  }

  /**
   * Writes are batched: a burst of requests costs one write of the file, not
   * one each. flush() writes now (on shutdown, and in tests).
   */
  #schedule() {
    if (this.#writeDelay <= 0) return this.flush();
    this.#writeTimer ??= setTimeout(() => this.flush(), this.#writeDelay);
    this.#writeTimer.unref?.();
  }

  flush() {
    clearTimeout(this.#writeTimer);
    this.#writeTimer = null;
    fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ entries: this.#entries }), { mode: 0o600 });
    fs.renameSync(tmp, this.#file);
  }
}
