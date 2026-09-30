/**
 * Per-project credit allocations for AI Triage and AI Remediation.
 *
 * An allocation is the total a project has been granted; what is left is the
 * allocation minus what the credit ledger says the project has used. Triage
 * starts from a default — the project's critical and high findings still to
 * verify — so a report's "Triage all critical / high" has exactly enough and
 * no more. Remediation starts at nothing: the administrator grants it.
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

  /** Allocation, used and remaining credits for one project. */
  balance(projectId) {
    const entry = this.#projects[projectId] ?? {};
    const out = { source: entry.source ?? 'none' };
    for (const kind of KINDS) {
      const allocated = Number(entry[kind]) || 0;
      const used = this.#ledger.usedBy(projectId, kind);
      out[kind] = { allocated, used, remaining: Math.max(0, allocated - used - this.#ledger.reservedFor(projectId, kind)) };
    }
    return out;
  }

  /**
   * Keep a project's default triage allocation in step with its findings:
   * enough for every critical and high finding still to verify. Allocations
   * an administrator set are left alone, and a default never shrinks.
   */
  applyDefault(projectId, projectName, risks) {
    const entry = this.#projects[projectId] ?? { triage: 0, remediation: 0, source: 'default' };
    if (entry.source === 'admin') {
      if (projectName && entry.projectName !== projectName) {
        entry.projectName = projectName;
        this.#projects[projectId] = entry;
        return true;
      }
      return false;
    }
    const wanted = this.#ledger.usedBy(projectId, 'triage') + toTriageCount(risks, DEFAULT_TRIAGE_SEVERITIES);
    if (this.#projects[projectId] && entry.triage >= wanted && entry.projectName === projectName) return false;
    this.#projects[projectId] = {
      ...entry,
      projectName,
      triage: Math.max(entry.triage ?? 0, wanted),
      source: 'default',
      updatedAt: new Date().toISOString(),
    };
    return true;
  }

  /** Allow exactly enough triage to cover `severities` (never less than used). */
  allocateTriageFor(projectId, projectName, risks, severities) {
    const entry = this.#projects[projectId] ?? { triage: 0, remediation: 0 };
    const triage = this.#ledger.usedBy(projectId, 'triage') + toTriageCount(risks, severities);
    this.#projects[projectId] = { ...entry, projectName, triage, source: 'admin', updatedAt: new Date().toISOString() };
    return triage;
  }

  /** Grant `credits` more of `kind`. */
  add(projectId, projectName, kind, credits) {
    if (!KINDS.includes(kind)) throw new Error(`Unknown credit kind: ${kind}`);
    const entry = this.#projects[projectId] ?? { triage: 0, remediation: 0 };
    this.#projects[projectId] = {
      ...entry,
      projectName: projectName || entry.projectName || '',
      [kind]: Math.max(0, (Number(entry[kind]) || 0) + credits),
      source: 'admin',
      updatedAt: new Date().toISOString(),
    };
  }

  save() {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ projects: this.#projects }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.#file);
  }
}
