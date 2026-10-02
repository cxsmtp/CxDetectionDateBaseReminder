/**
 * Per-project credit allocations for AI Triage and AI Remediation.
 *
 * An allocation is what someone using this utility has given a project — and
 * only that: nothing is ever allocated on its own. What is left is the
 * allocation minus what the credit ledger says the project has used.
 *
 * What a project needs is worked out from its findings, per its rule (which
 * severities it covers, critical and high by default), and shown next to what
 * it has, so the person allocating can confirm it:
 *
 *   triage       1 per finding of those severities still to verify, not yet sent
 *   remediation  3 per finding of those severities CONFIRMED (only that state —
 *                never one proposed not exploitable) and not yet remediated
 *
 * "Allocate what is needed" gives a project the difference. Extra credits on
 * top are allowed and kept separately, and shown.
 */

import fs from 'node:fs';
import path from 'node:path';

import { AI_SCANNERS } from './cxone/ai-assist.js';
import { CREDIT_COST } from './credits.js';

export const KINDS = ['triage', 'remediation'];
export const DEFAULT_TRIAGE_SEVERITIES = ['CRITICAL', 'HIGH'];
const EXTRA = { triage: 'extraTriage', remediation: 'extraRemediation' };
/** Allocations saved before allocations became explicit drop what was allocated on its own (see #migrate). */
const RULE_VERSION = 3;

const RECENTLY_REQUESTED_MS = 30 * 60 * 1000;
const aiScanner = (r) => AI_SCANNERS.has(String(r.scanner || '').toUpperCase());

/**
 * What Checkmarx One charges for: one result. Findings that share a result
 * (an SCA vulnerability listed twice, SAST findings of one similarity group)
 * are triaged — and charged — once, so they are counted once.
 */
export const billingUnit = (r) =>
  r.alternateId ? `a:${r.alternateId}` : r.groupId ? `g:${r.groupId}` : r.riskId ? `r:${r.riskId}` : r; // no id at all: itself

/** Was this finding (or its result) already sent through this utility? `sent` is CreditLedger.triagedAt(). */
export function alreadySent(r, sent) {
  if (!sent?.size) return false;
  return sent.has(r.riskId) || (r.alternateId && sent.has(`a:${r.alternateId}`)) || (r.groupId && sent.has(`g:${r.groupId}`));
}

const unique = (risks) => new Set(risks.map(billingUnit)).size;

/**
 * Findings of these severities that AI Triage can still act on: SAST or SCA,
 * state To verify (or unknown), and not sent for triage in the last 30 minutes.
 */
export function toTriageCount(risks, severities, now = Date.now(), triaged = new Map()) {
  return unique(triageRows(risks, severities, now, triaged));
}

/** The findings (rows) still to triage; several rows can share one billed result. */
export function triageRows(risks, severities, now = Date.now(), triaged = new Map()) {
  const wanted = new Set(severities.map((s) => String(s).toUpperCase()));
  return risks.filter(
    (r) =>
      wanted.has(r.severity) &&
      aiScanner(r) &&
      (!r.state || r.state === 'TO_VERIFY') &&
      // Already sent for AI Triage through this utility: still "To verify" while AI Triage
      // runs (and after a vulnerable verdict), but paid for — never counted twice.
      !alreadySent(r, triaged) &&
      !(r.triageRequestedAt && now - r.triageRequestedAt < RECENTLY_REQUESTED_MS),
  );
}

/** AI Remediation only ever runs on a finding triaged and confirmed: never one proposed not exploitable, or still to verify. */
export const REMEDIABLE_STATE = 'CONFIRMED';
export const remediable = (r) => aiScanner(r) && r.state === REMEDIABLE_STATE;

/**
 * Findings of these severities AI Remediation is needed for: SAST or SCA,
 * confirmed, and not already remediated through this utility.
 */
export function remediationCandidates(risks, severities, remediated = new Set()) {
  const wanted = new Set(severities.map((s) => String(s).toUpperCase()));
  const seen = new Set();
  return risks.filter((r) => {
    if (!wanted.has(r.severity) || !remediable(r) || remediated.has(r.riskId)) return false;
    const unit = billingUnit(r);
    if (seen.has(unit)) return false;
    seen.add(unit);
    return true;
  });
}

export function toRemediateCount(risks, severities, remediated = new Set()) {
  return remediationCandidates(risks, severities, remediated).length;
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
   * Earlier releases allocated on their own, from the findings at every fetch.
   * Those allocations are dropped: a project keeps what it used, plus extra
   * credits someone gave it and it has not used yet. What the projects need
   * is shown on the Dashboard, to allocate on purpose. `migrated` lists the
   * projects changed, for the audit log.
   */
  #migrate() {
    this.migrated = [];
    for (const [projectId, entry] of Object.entries(this.#projects)) {
      if (entry.version === RULE_VERSION) continue;
      const before = { triage: Number(entry.triage) || 0, remediation: Number(entry.remediation) || 0 };
      for (const kind of KINDS) {
        const used = this.#ledger.usedBy(projectId, kind);
        const beyondRule = Math.max(0, used - this.#ledger.coveredBy(projectId, kind));
        const extraLeft = Math.max(0, (Number(entry[EXTRA[kind]]) || 0) - beyondRule);
        entry[kind] = used + extraLeft;
        entry[EXTRA[kind]] = extraLeft;
      }
      entry.initial = { triage: entry.triage, remediation: entry.remediation, at: new Date().toISOString() };
      delete entry.source;
      entry.version = RULE_VERSION;
      this.migrated.push({ projectId, projectName: entry.projectName || '', before, after: { triage: entry.triage, remediation: entry.remediation } });
    }
    if (this.migrated.length && fs.existsSync(this.#file)) this.save();
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
   * are also confirmed. `info` maps a risk id to {severity, state}.
   */
  covered(projectId, kind, riskIds, info) {
    const rule = new Set(this.severitiesOf(projectId));
    return riskIds.filter((id) => {
      const risk = info.get(id);
      if (!risk) return true; // unknown: never charge the extras for it
      if (!rule.has(risk.severity)) return false;
      return kind === 'triage' || risk.state === REMEDIABLE_STATE;
    }).length;
  }

  /** Severities a project's triage allocation covers (critical + high unless changed). */
  severitiesOf(projectId) {
    const chosen = this.#projects[projectId]?.severities;
    return Array.isArray(chosen) ? chosen : DEFAULT_TRIAGE_SEVERITIES;
  }

  /**
   * What a project needs from its findings and its rule (see the top of this
   * file), and how much of it is not allocated yet. Never changes anything.
   */
  need(projectId, risks) {
    const rule = this.severitiesOf(projectId);
    const toTriage = toTriageCount(risks, rule, Date.now(), this.#ledger.triagedAt?.(projectId) ?? new Map());
    const toRemediate = toRemediateCount(risks, rule, this.#ledger.remediatedIds?.(projectId) ?? new Set());
    const need = { triage: toTriage, remediation: CREDIT_COST.remediation * toRemediate };
    // Spendable now: allocated minus used and in flight — below zero when a project
    // used more than it was allocated (older data), so allocating still leaves it `need`.
    const spendable = (kind) => (Number(this.#projects[projectId]?.[kind]) || 0) - this.#ledger.usedBy(projectId, kind) - this.#ledger.reservedFor(projectId, kind);
    return {
      toTriage,
      toRemediate,
      need,
      // Needed but not allocated: what "allocate what is needed" would give.
      shortfall: { triage: Math.max(0, need.triage - spendable('triage')), remediation: Math.max(0, need.remediation - spendable('remediation')) },
    };
  }

  /** Give a project what it needs of `kind` and does not have yet. Returns the credits given. */
  allocateNeeded(projectId, projectName, kind, risks) {
    const given = this.need(projectId, risks).shortfall[kind];
    if (given) this.grant(projectId, projectName, kind, given);
    return given;
  }

  /** Change which severities a project's needs cover. Allocations stay as they are. */
  setSeverities(projectId, projectName, severities) {
    const entry = this.#entry(projectId, projectName);
    entry.severities = [...new Set(severities)];
    entry.updatedAt = new Date().toISOString();
  }

  /** Allocate `credits` more of `kind` to a project (someone confirmed it). */
  grant(projectId, projectName, kind, credits) {
    if (!KINDS.includes(kind)) throw new Error(`Unknown credit kind: ${kind}`);
    const entry = this.#entry(projectId, projectName);
    entry[kind] = Math.max(0, (Number(entry[kind]) || 0) + Math.floor(credits));
    entry.initial ??= { triage: entry.triage, remediation: entry.remediation, at: new Date().toISOString() };
    entry.updatedAt = new Date().toISOString();
  }

  #entry(projectId, projectName = '') {
    const entry = (this.#projects[projectId] ??= { triage: 0, remediation: 0, extraTriage: 0, extraRemediation: 0, version: RULE_VERSION });
    if (projectName) entry.projectName = projectName;
    return entry;
  }

  /** Set a project's extra credits of `kind` to exactly `credits` (0 removes them). */
  setExtra(projectId, projectName, kind, credits) {
    if (!KINDS.includes(kind)) throw new Error(`Unknown credit kind: ${kind}`);
    const current = Number(this.#projects[projectId]?.[EXTRA[kind]]) || 0;
    const target = Math.max(0, Math.floor(Number(credits) || 0));
    if (target !== current) this.add(projectId, projectName, kind, target - current);
  }

  /** Take back the extra credits added (never below what was used). */
  clearExtras(projectId) {
    const entry = this.#projects[projectId];
    if (!entry) return;
    entry.triage = Math.max(this.#ledger.usedBy(projectId, 'triage'), (Number(entry.triage) || 0) - (Number(entry.extraTriage) || 0));
    entry.remediation = Math.max(this.#ledger.usedBy(projectId, 'remediation'), (Number(entry.remediation) || 0) - (Number(entry.extraRemediation) || 0));
    entry.extraTriage = 0;
    entry.extraRemediation = 0;
  }

  /** Extra credits: allocated on top of what the findings need, and shown as such. */
  add(projectId, projectName, kind, credits) {
    if (!KINDS.includes(kind)) throw new Error(`Unknown credit kind: ${kind}`);
    const entry = this.#entry(projectId, projectName);
    this.grant(projectId, projectName, kind, credits);
    entry[EXTRA[kind]] = Math.max(0, (Number(entry[EXTRA[kind]]) || 0) + credits);
  }

  save() {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ projects: this.#projects }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.#file);
  }
}
