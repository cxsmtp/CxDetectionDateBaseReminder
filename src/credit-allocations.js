/**
 * Per-project credit allocations for AI Triage and AI Remediation.
 *
 * An allocation is the total a project has been granted; what is left is the
 * allocation minus what the credit ledger says the project has used. Both
 * follow a per-project rule — which severities it covers, critical and high
 * by default — recalculated from the findings' current states:
 *
 *   triage       used + findings of those severities still to verify
 *   remediation  used + 3 per finding of those severities confirmed (or
 *                urgent) and not yet remediated through this utility
 *
 * so a project with nothing left to act on has nothing left over. Extra
 * credits the administrator adds on top are kept separately, and shown; they
 * are used up by actions on findings the rule does not cover.
 */

import fs from 'node:fs';
import path from 'node:path';

import { AI_SCANNERS } from './cxone/ai-assist.js';
import { CREDIT_COST } from './credits.js';

export const KINDS = ['triage', 'remediation'];
export const DEFAULT_TRIAGE_SEVERITIES = ['CRITICAL', 'HIGH'];
const EXTRA = { triage: 'extraTriage', remediation: 'extraRemediation' };
/** Allocations saved before this rule have their extras cleared once. */
const RULE_VERSION = 2;

const RECENTLY_REQUESTED_MS = 30 * 60 * 1000;
const aiScanner = (r) => AI_SCANNERS.has(String(r.scanner || '').toUpperCase());

/**
 * Findings of these severities that AI Triage can still act on: SAST or SCA,
 * state To verify (or unknown), and not sent for triage in the last 30 minutes.
 */
export function toTriageCount(risks, severities, now = Date.now()) {
  const wanted = new Set(severities.map((s) => String(s).toUpperCase()));
  return risks.filter(
    (r) =>
      wanted.has(r.severity) &&
      aiScanner(r) &&
      (!r.state || r.state === 'TO_VERIFY') &&
      !(r.triageRequestedAt && now - r.triageRequestedAt < RECENTLY_REQUESTED_MS),
  ).length;
}

/**
 * Findings of these severities AI Remediation is needed for: SAST or SCA,
 * confirmed (or urgent), and not already remediated through this utility.
 */
export function toRemediateCount(risks, severities, remediated = new Set()) {
  const wanted = new Set(severities.map((s) => String(s).toUpperCase()));
  return risks.filter(
    (r) => wanted.has(r.severity) && aiScanner(r) && (r.state === 'CONFIRMED' || r.state === 'URGENT') && !remediated.has(r.riskId),
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
    this.#migrate();
  }

  /**
   * Allocations saved before the current rule kept whatever had been granted
   * (e.g. a bulk "give each project 10") as a standing balance. Start them
   * from the rule instead: the next fetch fills in what each project needs.
   */
  #migrate() {
    let changed = false;
    for (const [projectId, entry] of Object.entries(this.#projects)) {
      if (entry.version === RULE_VERSION) continue;
      entry.triage = Math.max(this.#ledger.usedBy(projectId, 'triage'), (Number(entry.triage) || 0) - (Number(entry.extraTriage) || 0));
      entry.remediation = this.#ledger.usedBy(projectId, 'remediation');
      entry.extraTriage = 0;
      entry.extraRemediation = 0;
      delete entry.source;
      delete entry.initial;
      entry.version = RULE_VERSION;
      changed = true;
    }
    if (changed && fs.existsSync(this.#file)) this.save();
  }

  get(projectId) {
    return this.#projects[projectId] ?? null;
  }

  /** Allocation, used and remaining credits for one project, and its triage rule. */
  balance(projectId) {
    const entry = this.#projects[projectId] ?? {};
    const out = {
      severities: this.severitiesOf(projectId),
      extraTriage: Number(entry.extraTriage) || 0,
      extraRemediation: Number(entry.extraRemediation) || 0,
    };
    for (const kind of KINDS) {
      const allocated = Number(entry[kind]) || 0;
      const used = this.#ledger.usedBy(projectId, kind);
      out[kind] = { allocated, used, remaining: Math.max(0, allocated - used - this.#ledger.reservedFor(projectId, kind)) };
    }
    return out;
  }

  /**
   * Every project with an allocation: what it was first allocated, what it
   * is allocated now, and what it has used through this utility.
   */
  list() {
    return Object.entries(this.#projects)
      .map(([projectId, entry]) => {
        const balance = this.balance(projectId);
        const initial = entry.initial ?? {};
        return {
          projectId,
          projectName: entry.projectName || '',
          severities: balance.severities,
          initialAt: initial.at ?? entry.updatedAt ?? '',
          triage: { ...balance.triage, initial: Number(initial.triage ?? entry.triage) || 0, extra: balance.extraTriage },
          remediation: { ...balance.remediation, initial: Number(initial.remediation ?? entry.remediation) || 0, extra: balance.extraRemediation },
        };
      })
      .sort((a, b) => b.triage.used + b.remediation.used - (a.triage.used + a.remediation.used) || a.projectName.localeCompare(b.projectName));
  }

  /**
   * How many of these findings the project's rule covers, for the ledger:
   * triage covers findings of the rule's severities, remediation those that
   * are also confirmed (or urgent). `info` maps a risk id to {severity, state}.
   */
  covered(projectId, kind, riskIds, info) {
    const rule = new Set(this.severitiesOf(projectId));
    return riskIds.filter((id) => {
      const risk = info.get(id);
      if (!risk) return true; // unknown: never charge the extras for it
      if (!rule.has(risk.severity)) return false;
      return kind === 'triage' || risk.state === 'CONFIRMED' || risk.state === 'URGENT';
    }).length;
  }

  /** Severities a project's triage allocation covers (critical + high unless changed). */
  severitiesOf(projectId) {
    const chosen = this.#projects[projectId]?.severities;
    return Array.isArray(chosen) ? chosen : DEFAULT_TRIAGE_SEVERITIES;
  }

  /**
   * Recalculate a project's allocations from its rule and its findings'
   * current states (see the top of this file). Passing `severities` changes
   * the rule. Returns whether anything changed.
   */
  applyRule(projectId, projectName, risks, severities) {
    const entry = { ...(this.#projects[projectId] ?? {}) };
    entry.version = RULE_VERSION;
    if (severities) entry.severities = [...new Set(severities)];
    const rule = Array.isArray(entry.severities) ? entry.severities : DEFAULT_TRIAGE_SEVERITIES;
    const remediated = this.#ledger.remediatedIds?.(projectId) ?? new Set();
    // Credits spent on covered findings stay allocated; anything spent
    // beyond the rule came out of the extras, so it is not added back.
    const triage = this.#ledger.coveredBy(projectId, 'triage') + toTriageCount(risks, rule) + (Number(entry.extraTriage) || 0);
    const remediation =
      this.#ledger.coveredBy(projectId, 'remediation') +
      CREDIT_COST.remediation * toRemediateCount(risks, rule, remediated) +
      (Number(entry.extraRemediation) || 0);
    const before = this.#projects[projectId];
    const next = { ...entry, projectName: projectName || entry.projectName || '', triage, remediation };
    next.initial ??= { triage, remediation, at: new Date().toISOString() };
    const same = (a, b) => JSON.stringify({ ...a, updatedAt: 0 }) === JSON.stringify({ ...b, updatedAt: 0 });
    if (before && same(before, next)) return false;
    this.#projects[projectId] = { ...next, updatedAt: new Date().toISOString() };
    return true;
  }

  /** Drop the extra credits the administrator added; the rule alone decides again. */
  clearExtras(projectId) {
    const entry = this.#projects[projectId];
    if (!entry) return;
    entry.triage = Math.max(0, (Number(entry.triage) || 0) - (Number(entry.extraTriage) || 0));
    entry.remediation = Math.max(0, (Number(entry.remediation) || 0) - (Number(entry.extraRemediation) || 0));
    entry.extraTriage = 0;
    entry.extraRemediation = 0;
  }

  /** Grant `credits` more of `kind`, kept on top of the rule across recalculations. */
  add(projectId, projectName, kind, credits) {
    if (!KINDS.includes(kind)) throw new Error(`Unknown credit kind: ${kind}`);
    const entry = this.#projects[projectId] ?? { triage: 0, remediation: 0, extraTriage: 0, extraRemediation: 0, version: RULE_VERSION };
    this.#projects[projectId] = {
      ...entry,
      projectName: projectName || entry.projectName || '',
      [kind]: Math.max(0, (Number(entry[kind]) || 0) + credits),
      [EXTRA[kind]]: Math.max(0, (Number(entry[EXTRA[kind]]) || 0) + credits),
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
