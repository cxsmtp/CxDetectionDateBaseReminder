/**
 * Tracked reports: a saved scope (windows, projects, severities, ages) with a
 * baseline of the findings it covered when saved, so progress on them can be
 * followed over time — and a live count of what the scope matches now.
 *
 * Outcomes of a baseline finding, from its current Checkmarx One state:
 *   awaiting        still To verify
 *   confirmed       Confirmed or Urgent
 *   notExploitable  Proposed not exploitable or Not exploitable
 *   resolved        no longer reported by Checkmarx One (fixed, or removed)
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { AI_SCANNERS } from './cxone/ai-assist.js';
import { withinWindow } from './window.js';

export const OUTCOMES = ['awaiting', 'confirmed', 'notExploitable', 'resolved'];
const MAX_HISTORY = 500;

export function outcomeOf(finding) {
  if (!finding) return 'resolved';
  const state = String(finding.state || '').toUpperCase();
  if (state === 'CONFIRMED' || state === 'URGENT') return 'confirmed';
  if (state === 'NOT_EXPLOITABLE' || state === 'PROPOSED_NOT_EXPLOITABLE') return 'notExploitable';
  return 'awaiting';
}

/** Does a finding match a report's severity / age / detection filters? */
export function matchesFilters(risk, filters, detectionWindow) {
  if (filters.severities?.length && !filters.severities.includes(risk.severity)) return false;
  if (filters.buckets?.length && !filters.buckets.includes(risk.bucket)) return false;
  return withinWindow(detectionWindow, risk.firstDetectedAt);
}

const emptyOutcomes = () => Object.fromEntries(OUTCOMES.map((o) => [o, 0]));

/**
 * Progress of a report against current findings.
 *
 * @param {object} report
 * @param {Map<string, Array>} currentByProject  every current finding per project (unfiltered)
 * @param {object|null} detectionWindow  the report's detection window, resolved now
 * @param {(projectIds: string[], since: string) => {triage: number, remediation: number}} aiActions
 */
export function computeProgress(report, currentByProject, detectionWindow, aiActions, now = new Date()) {
  const byProject = new Map(
    report.projects.map((p) => [
      p.projectId,
      { projectId: p.projectId, projectName: p.projectName, baseline: 0, ...emptyOutcomes(), newFindings: 0, currentMatching: 0 },
    ]),
  );
  const current = new Map();
  for (const [projectId, risks] of currentByProject) {
    for (const risk of risks) current.set(`${projectId}|${risk.riskId}`, risk);
  }

  // Open findings AI Triage can still act on, by severity.
  const toTriage = {};
  const countToTriage = (risk) => {
    if (outcomeOf(risk) === 'awaiting' && AI_SCANNERS.has(String(risk.scanner || '').toUpperCase())) {
      toTriage[risk.severity] = (toTriage[risk.severity] ?? 0) + 1;
    }
  };

  const outcomes = emptyOutcomes();
  const baselineKeys = new Set();
  let changed = 0;
  for (const f of report.baseline.findings) {
    const key = `${f.projectId}|${f.riskId}`;
    baselineKeys.add(key);
    if (current.has(key)) countToTriage(current.get(key));
    const outcome = outcomeOf(current.get(key));
    outcomes[outcome] += 1;
    if (outcome !== outcomeOf(f)) changed += 1;
    const row = byProject.get(f.projectId);
    if (row) {
      row.baseline += 1;
      row[outcome] += 1;
    }
  }

  let newFindings = 0;
  let newOpen = 0;
  let currentMatching = 0;
  for (const [projectId, risks] of currentByProject) {
    const row = byProject.get(projectId);
    for (const risk of risks) {
      if (!matchesFilters(risk, report.filters, detectionWindow)) continue;
      currentMatching += 1;
      if (row) row.currentMatching += 1;
      if (!baselineKeys.has(`${projectId}|${risk.riskId}`)) {
        newFindings += 1;
        if (outcomeOf(risk) !== 'notExploitable') newOpen += 1;
        countToTriage(risk);
        if (row) row.newFindings += 1;
      }
    }
  }

  const baseline = report.baseline.findings.length;
  const actioned = outcomes.confirmed + outcomes.notExploitable + outcomes.resolved;
  return {
    at: now.toISOString(),
    baseline,
    outcomes,
    actioned,
    percentActioned: baseline ? Math.round((actioned / baseline) * 100) : 100,
    changed,
    open: outcomes.awaiting + outcomes.confirmed + newOpen,
    newFindings,
    currentMatching,
    toTriage,
    aiActions: aiActions(report.projects.map((p) => p.projectId), report.createdAt),
    byProject: [...byProject.values()].sort((a, b) => b.baseline - a.baseline),
  };
}

export class TrackedReports {
  #file;
  #reports;

  constructor({ file } = {}) {
    this.#file = file ?? path.join(process.cwd(), 'data', 'tracked-reports.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
      this.#reports = Array.isArray(raw.reports) ? raw.reports : [];
    } catch {
      this.#reports = [];
    }
  }

  list() {
    return this.#reports;
  }

  get(id) {
    return this.#reports.find((r) => r.id === id) ?? null;
  }

  create({ name, filters, scopeLabel, projects, findings }, now = new Date()) {
    const report = {
      id: randomUUID(),
      name: String(name).trim().slice(0, 120),
      createdAt: now.toISOString(),
      scopeLabel,
      filters,
      projects,
      baseline: {
        at: now.toISOString(),
        findings: findings.map((f) => ({
          projectId: f.projectId,
          riskId: f.riskId,
          severity: f.severity,
          state: f.state,
          title: f.title,
          scanner: f.scanner,
        })),
      },
      latest: null,
      history: [],
    };
    this.#reports.unshift(report);
    this.save();
    return report;
  }

  /** Store a fresh progress reading, and a compact point for the trend. */
  record(report, progress) {
    report.latest = progress;
    report.history.push({
      at: progress.at,
      ...progress.outcomes,
      newFindings: progress.newFindings,
      currentMatching: progress.currentMatching,
    });
    if (report.history.length > MAX_HISTORY) report.history = report.history.slice(-MAX_HISTORY);
    this.save();
  }

  delete(id) {
    const before = this.#reports.length;
    this.#reports = this.#reports.filter((r) => r.id !== id);
    if (this.#reports.length !== before) this.save();
    return this.#reports.length !== before;
  }

  save() {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ reports: this.#reports }), { mode: 0o600 });
    fs.renameSync(tmp, this.#file);
  }
}

/** The report without its bulky baseline, for listings. */
export function reportSummary(report) {
  const { baseline, history, ...rest } = report;
  return { ...rest, baselineCount: baseline.findings.length, history: history.slice(-60) };
}
