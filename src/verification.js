/**
 * Verifying a tracked report's fixes with a rescan: the step that proves
 * Mission Zero instead of assuming it.
 *
 *  1. A round is closed when every finding in its scope has been dealt with:
 *     triaged as not exploitable, or confirmed and sent for remediation (or
 *     already gone).
 *  2. Then (by hand, or automatically) each project is scanned again in
 *     Checkmarx One, from the repository and branch of its last scan, with
 *     the same engines. A project Checkmarx One cannot clone (uploaded code,
 *     a pipeline scan) is verified by its next scan instead.
 *  3. When the scans are done the findings are read again: what is gone is
 *     fixed (verified), what is still reported after being remediated is a
 *     fix that did not work, and anything new in scope is counted too.
 *  4. The analyst starts the next round on the new scan, with a new scope
 *     (for example medium and low once critical and high are at zero).
 */

import { codeVersion } from './github/blame.js';
import { outcomeOf } from './tracked-reports.js';

export const TERMINAL = new Set(['Completed', 'Failed', 'Partial', 'Canceled']);
const ENGINES = new Set(['sast', 'sca', 'kics', 'apisec', 'containers', 'microengines']);

/**
 * Where the current round stands: closed when nothing in scope is still
 * waiting for triage and every confirmed finding has been sent for
 * remediation. `remediated(projectId)` is the set of risk ids sent for AI
 * Remediation.
 */
export function closure(report, currentByProject, remediated) {
  const current = new Map();
  for (const [projectId, risks] of currentByProject) for (const r of risks) current.set(`${projectId}|${r.riskId}`, r);
  const sent = new Map();
  const counts = { inScope: 0, gone: 0, notExploitable: 0, remediated: 0, awaiting: 0, confirmedNotRemediated: 0 };
  for (const f of report.baseline.findings) {
    counts.inScope += 1;
    const now = current.get(`${f.projectId}|${f.riskId}`);
    const outcome = outcomeOf(now);
    if (!sent.has(f.projectId)) sent.set(f.projectId, remediated(f.projectId));
    if (outcome === 'resolved') counts.gone += 1;
    else if (outcome === 'notExploitable') counts.notExploitable += 1;
    else if (sent.get(f.projectId).has(f.riskId)) counts.remediated += 1;
    else if (outcome === 'confirmed') counts.confirmedNotRemediated += 1;
    else counts.awaiting += 1;
  }
  const open = counts.awaiting + counts.confirmedNotRemediated;
  return { ...counts, open, closed: counts.inScope > 0 && open === 0 };
}

/**
 * What the rescan proved, from the findings read after it, for the projects
 * whose scan completed: {fixed, stillFound: [...], accepted, newInScope, zero}.
 */
export function verificationResult(report, currentByProject, { verifiedProjects, remediated, newInScope = 0 }) {
  const current = new Map();
  for (const [projectId, risks] of currentByProject) for (const r of risks) current.set(`${projectId}|${r.riskId}`, r);
  const result = { checked: 0, fixed: 0, accepted: 0, stillFound: [], notChecked: 0, newInScope };
  for (const f of report.baseline.findings) {
    if (!verifiedProjects.has(f.projectId)) {
      result.notChecked += 1;
      continue;
    }
    result.checked += 1;
    const now = current.get(`${f.projectId}|${f.riskId}`);
    const outcome = outcomeOf(now);
    if (outcome === 'resolved') result.fixed += 1;
    else if (outcome === 'notExploitable') result.accepted += 1;
    else {
      result.stillFound.push({
        projectId: f.projectId,
        projectName: report.projects.find((p) => p.projectId === f.projectId)?.projectName ?? '',
        riskId: f.riskId,
        title: f.title,
        severity: f.severity,
        remediated: remediated(f.projectId).has(f.riskId),
      });
    }
  }
  result.stillFound = result.stillFound.slice(0, 200);
  result.ineffective = result.stillFound.filter((f) => f.remediated).length;
  result.zero = result.checked > 0 && result.stillFound.length === 0 && newInScope === 0 && result.notChecked === 0;
  return result;
}

/** The body that rescans a project like its last scan (same repository, branch and engines), or a reason it cannot. */
export function rescanRequest(projectId, lastScan, project = {}) {
  const { repoUrl, branch } = codeVersion(lastScan, project);
  const type = String(lastScan?.sourceType || lastScan?.type || '').toLowerCase();
  if (!/^https?:\/\//i.test(repoUrl) || !branch || /upload|zip/.test(type)) {
    return { waiting: true, reason: 'Checkmarx One scanned uploaded code here, not a repository it can fetch: the next scan from your pipeline verifies it.' };
  }
  const engines = (Array.isArray(lastScan?.engines) ? lastScan.engines : []).map((e) => String(e).toLowerCase()).filter((e) => ENGINES.has(e));
  const config = (engines.length ? engines : ['sast', 'sca']).map((engine) => ({ type: engine, value: engine === 'sast' ? { incremental: 'false' } : {} }));
  return {
    body: {
      project: { id: projectId },
      type: 'git',
      handler: { repoUrl, branch },
      config,
      tags: { cxmissionzero: 'verification' },
    },
    repoUrl,
    branch,
    engines: config.map((c) => c.type),
  };
}

/** Did a scan finish after the verification was asked for? */
export const newerThan = (scan, since) => {
  const at = Date.parse(scan?.updatedAt || scan?.createdAt || scan?.created_at || '');
  return Number.isFinite(at) && at >= Date.parse(since);
};
