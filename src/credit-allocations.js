/**
 * Per-project credit allocations for AI Triage and AI Remediation.
 *
 * An allocation is the total a project has been granted; what is left is the
 * allocation minus what the credit ledger says the project has used. Triage
 * follows a per-project rule — which severities it covers, critical and high
 * by default — recalculated on every fetch so it always covers exactly the
 * findings of those severities still to verify, plus any extra credits the
 * administrator added. Remediation starts at nothing: the administrator grants it.
 */

import fs from 'node:fs';
import path from 'node:path';

import { AI_SCANNERS } from './cxone/ai-assist.js';

export const KINDS = ['triage', 'remediation'];
export const DEFAULT_TRIAGE_SEVERITIES = ['CRITICAL', 'HIGH'];

const RECENTLY_REQUESTED_MS = 30 * 60 * 1000;

/**
 * Findings of these severities that AI Triage can still act on: SAST or SCA,
 * state To verify (or unknown), and not sent for triage in the last 30 minutes.
 */
export function toTriageCount(risks, severities, now = Date.now()) {
  const wanted = new Set(severities.map((s) => String(s).toUpperCase()));
  return risks.filter(
    (r) =>
      wanted.has(r.severity) &&
      AI_SCANNERS.has(String(r.scanner || '').toUpperCase()) &&
      (!r.state || r.state === 'TO_VERIFY') &&
      !(r.triageRequestedAt && now - r.triageRequestedAt < RECENTLY_REQUESTED_MS),
  ).length;
}

export class CreditAllocations {
  #file;
  #projects;
  #ledger;

  /** @param {{file?: string, ledger: import('./credits.js').CreditLedger}} options */
  constructor({ file, ledger }) {
    this.#file = file ?? path.join(process.cwd(), 'data', 'credit-allocations.json');
    this.#ledger = ledger;
    try {
      const raw = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
      this.#projects = raw && typeof raw.projects === 'object' ? raw.projects : {};
    } catch {
      this.#projects = {};
    }
  }

  get(projectId) {
    return this.#projects[projectId] ?? null;
  }

  /** Allocation, used and remaining credits for one project, and its triage rule. */
  balance(projectId) {
    const entry = this.#projects[projectId] ?? {};
    const out = { severities: this.severitiesOf(projectId), extraTriage: Number(entry.extraTriage) || 0 };
    for (const kind of KINDS) {
      const allocated = Number(entry[kind]) || 0;
      const used = this.#ledger.usedBy(projectId, kind);
      out[kind] = { allocated, used, remaining: Math.max(0, allocated - used - this.#ledger.reservedFor(projectId, kind)) };
    }
    return out;
  }

  /** Severities a project's triage allocation covers (critical + high unless changed). */
  severitiesOf(projectId) {
    const chosen = this.#projects[projectId]?.severities;
    return Array.isArray(chosen) ? chosen : DEFAULT_TRIAGE_SEVERITIES;
  }

  /**
   * Recalculate a project's triage allocation from its rule: what it has used,
   * plus its findings of the rule's severities still to triage, plus any extra
   * credits the administrator added. Passing `severities` changes the rule.
   * Returns whether anything changed.
   */
  applyRule(projectId, projectName, risks, severities) {
    const entry = { ...(this.#projects[projectId] ?? { triage: 0, remediation: 0 }) };
    if (entry.extraTriage === undefined) {
      // Allocations saved before rules existed: keep anything granted above the default as extra.
      const base = this.#ledger.usedBy(projectId, 'triage') + toTriageCount(risks, DEFAULT_TRIAGE_SEVERITIES);
      entry.extraTriage = entry.source === 'admin' ? Math.max(0, (Number(entry.triage) || 0) - base) : 0;
      delete entry.source;
    }
    if (severities) entry.severities = [...new Set(severities)];
    const rule = Array.isArray(entry.severities) ? entry.severities : DEFAULT_TRIAGE_SEVERITIES;
    const triage = this.#ledger.usedBy(projectId, 'triage') + toTriageCount(risks, rule) + entry.extraTriage;
    const before = this.#projects[projectId];
    const next = { ...entry, projectName: projectName || entry.projectName || '', triage };
    if (before && JSON.stringify(before) === JSON.stringify(next)) return false;
    this.#projects[projectId] = { ...next, updatedAt: new Date().toISOString() };
    return true;
  }

  /** Grant `credits` more of `kind`; extra triage credits are kept across recalculations. */
  add(projectId, projectName, kind, credits) {
    if (!KINDS.includes(kind)) throw new Error(`Unknown credit kind: ${kind}`);
    const entry = this.#projects[projectId] ?? { triage: 0, remediation: 0, extraTriage: 0 };
    this.#projects[projectId] = {
      ...entry,
      projectName: projectName || entry.projectName || '',
      [kind]: Math.max(0, (Number(entry[kind]) || 0) + credits),
      ...(kind === 'triage' ? { extraTriage: Math.max(0, (Number(entry.extraTriage) || 0) + credits) } : {}),
      updatedAt: new Date().toISOString(),
    };
  }

  /** Cover credits the administrator spent beyond the allocation (not kept as extra). */
  raise(projectId, credits) {
    const entry = this.#projects[projectId];
    if (entry) entry.triage = (Number(entry.triage) || 0) + credits;
  }

  save() {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ projects: this.#projects }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.#file);
  }
}
