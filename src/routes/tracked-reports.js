/**
 * Tracked reports: saved scopes whose progress is followed over time (src/tracked-reports.js).
 *
 * - Following a report: its current findings, the refresh in the background, what has gone from Checkmarx One.
 * - Verification: the rescan that proves a round's fixes, then the next round (src/verification.js), and the
 *   developer's own turn to rescan, from their report or the emailed link (/rescan, /api/relay/rescan).
 * - Follow-up: reminders, their schedule, the report as HTML, and the report's Triage tab (allocate what is
 *   needed, triage, remediate), which shares its rules with the Credits page.
 * - The routes under /api/tracked-reports.
 */
import express from 'express';
import { config } from '../config.js';
import { getLastScans, listProjects } from '../cxone/projects.js';
import { BRANCH_HOW, branchScopeOf, onBranch, primaryScans } from '../cxone/branches.js';
import { AGE_BUCKETS, createRiskSource, normalizeRisk, selectRisks, summariseProject } from '../cxone/risks.js';
import { engineScope, inEngines } from '../engines.js';
import { collectInitiators, scanInitiator, scanInitiatorEmail } from '../cxone/initiators.js';
import { mapWithConcurrency } from '../cxone/client.js';
import { remediable, remediationCandidates } from '../credit-allocations.js';
import { knownAddresses } from '../known-addresses.js';
import { TtlCache } from '../ttl-cache.js';
import { baselineReadAt, computeProgress, foundSince, matchesFilters, outcomeOf, reportSummary } from '../tracked-reports.js';
import { TERMINAL, closure, newerThan, rescanRequest, verificationResult } from '../verification.js';
import { buildReportEmail } from '../reminder.js';
import { projectUrl } from '../links.js';
import { sendReminderMail } from '../mailer.js';
import { isVerified, parseAddressList } from '../settings.js';
import { isPaused } from '../hands-off.js';
import { scoped } from '../tenancy.js';
import { HOUR_MS, currentWindow, graceHoursOf, newWindow, rescanGrants, windowAction, windowState } from '../rescan-window.js';
import { resolveWindow } from '../window.js';
import { SYSTEM_ACTOR, escapeHtmlText, idList, logSafe } from './shared.js';

/**
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerTrackedReportRoutes(app, d) {
  const {
    sessions, tenancy, tstate, settingsStore, creditLedger, allocations, SEVERITIES, trackedReports, findingJournal,
    audit, touchedProjects, creditView, reportGrants, tenantQuery, resolveAutomationSession, productActive,
    asyncRoute, requirePermission, activeConfig, sendingSettings, afterFetch, readerIdentity, NOT_EXPLOITABLE_STATES,
    runReminder, resolveReportServer, reportServerUrl, adminActor, allocationSnapshot, auditAllocation,
    cleanSeverities, notifyOnBehalf, doubleRead, DISAGREED, adminTriage, adminRemediate, scanAttribution, creditFor,
    monthlyImpact, tenantRefusal, creditPool, buildInteractiveReport, runHtmlReminder,
  } = d;

  // ---------------------------------------------------------------------------
  // Tracked reports: saved scopes whose progress is followed over time
  // ---------------------------------------------------------------------------

  const TRACK_REFRESH_MS = 60 * 60 * 1000;
  const TRACK_TOUCHED_WINDOW_MS = 30 * 60 * 1000;
  const TRACK_TOUCHED_EVERY_MS = 3 * 60 * 1000;
  const refreshing = scoped(tenancy, 'refreshing');


  /** Every current finding (no filters) for each of a report's projects. */
  /** Each project's primary branch as Checkmarx One names it, per key, read again after ten minutes. */
  const mainBranches = new TtlCache({ max: 200 });
  const mainBranchesOf = (session) =>
    mainBranches.wrap(readerIdentity(session) || `session-${session.id ?? ''}`, async () => new Map((await listProjects(session.client)).map((p) => [p.id, p.mainBranch ?? ''])), 10 * 60_000);

  /**
   * The branch that counts for each of these projects ({projectId, projectName}) and its latest scan
   * there (src/cxone/branches.js); null for every branch, or when it cannot be told now.
   */
  async function branchChoiceFor(session, projects, branches = 'primary') {
    if (branchScopeOf(branches) === 'all' || !projects.length) return null;
    const mains = await mainBranchesOf(session).catch(() => new Map());
    const list = projects.map(({ projectId, projectName }) => ({ id: projectId, name: projectName, mainBranch: mains.get(projectId) ?? '' }));
    return primaryScans(session.client, list, { identity: readerIdentity(session), concurrency: 4 }).catch(() => null);
  }

  /** The branch choice a Workbench fetch made, from its rows (null: it read every branch). */
  function branchChoiceOfScan(scan) {
    if (!scan || scan.branchScope !== 'primary') return null;
    const branches = Object.create(null);
    const scans = Object.create(null);
    for (const p of scan.projects ?? []) {
      if (p.branchHow) branches[p.projectId] = { branch: p.branch ?? '', how: p.branchHow };
      const id = scan.initiators?.[p.projectId]?.scanId;
      if (id) scans[p.projectId] = { id };
    }
    return { branches, scans };
  }

  /**
   * Projects' current findings, read fresh. On the branch that counts for each (its primary branch:
   * src/cxone/branches.js), unless `branches` is "all" (every branch, as tracked reports made before
   * branches were told apart keep).
   */
  async function currentFindings(session, projects, { branches = 'primary', skipGone = false } = {}) {
    const cfg = activeConfig();
    const byProject = new Map();
    const identity = readerIdentity(session);
    const all = branchScopeOf(branches) === 'all';
    const choice = await branchChoiceFor(session, projects, branches);
    // Projects deleted from Checkmarx One (or out of this key's sight) since they were given credits.
    const gone = [];
    await mapWithConcurrency(projects, 3, async ({ projectId, projectName }) => {
      try {
        await readCurrent({ projectId, projectName });
      } catch (error) {
        if (!(await goneFromCheckmarx(session.client, projectId, error))) throw error;
        gone.push({ projectId, projectName });
        if (!skipGone) throw Object.assign(new Error(goneText([{ projectName }])), { status: 409 });
      }
    });
    byProject.gone = gone;
    return byProject;

    async function readCurrent({ projectId, projectName }) {
      const project = { id: projectId, name: projectName };
      const how = choice?.branches[projectId]?.how;
      const source = createRiskSource(session.client, cfg);
      if (source.prime) await source.prime([project], choice ? { [projectId]: choice.scans[projectId] } : null);
      const raw = await source.fetchForProject(project);
      let risks = raw.map((r) => normalizeRisk(r, project));
      if (choice) risks = await onBranch(session.client, choice, projectId, risks, { identity });
      byProject.set(projectId, risks);
      // Every current finding of the project on its branch: those no longer among them are gone (the Impact page).
      // Not from a read of every branch (others' findings would be mixed in), nor of a primary branch never scanned.
      if (!all && how !== BRANCH_HOW.none) findingJournal.observe({ projectId, projectName }, risks, { complete: true });
    }
  }

  /** A read that found nothing (404) because the project itself is no longer in Checkmarx One. */
  async function goneFromCheckmarx(client, projectId, error) {
    return error?.status === 404 && projectMissing(client, projectId);
  }

  /** Checkmarx One answers 404 for the project itself: deleted, or out of this key's sight. */
  async function projectMissing(client, projectId) {
    if (!client) return false;
    try {
      await client.request(`/api/projects/${encodeURIComponent(projectId)}`, { retries: 0 });
      return false;
    } catch (lookup) {
      return lookup?.status === 404;
    }
  }

  function goneText(gone) {
    const names = gone.map((p) => p.projectName || p.projectId).join(', ');
    return gone.length === 1
      ? `${names} is no longer in Checkmarx One (deleted, or this key cannot see it). Take its credits back under Credit Control.`
      : `${gone.length} projects are no longer in Checkmarx One (deleted, or this key cannot see them): ${names}. Take their credits back under Credit Control.`;
  }

  function progressFor(report, byProject) {
    let detection = null;
    try {
      detection = resolveWindow(report.filters.detection, 'First detection');
    } catch {}
    const progress = computeProgress(report, byProject, detection, (ids, since) => creditLedger.usedSince(ids, since), new Date(), remediatedOf);
    // Whether the round's scope is closed (every finding dealt with): ready for a verification rescan.
    progress.closure = closure(report, byProject, remediatedOf);
    return progress;
  }

  /** Refresh one report (collapsing concurrent refreshes of the same report). */
  function refreshTrackedReport(report, session) {
    if (!refreshing.has(report.id)) {
      refreshing.set(
        report.id,
        currentFindings(session, report.projects, { branches: report.filters.branches ?? 'all' })
          .then((byProject) => {
            trackedReports.record(report, progressFor(report, byProject));
            report.lastError = null;
            return report;
          })
          .catch((error) => {
            report.lastError = error.message;
            throw error;
          })
          .finally(() => refreshing.delete(report.id)),
      );
    }
    return refreshing.get(report.id);
  }

  async function backgroundRefresh() {
    const session = await resolveAutomationSession();
    if (!session) return;
    const now = Date.now();
    for (const [projectId, at] of touchedProjects) if (now - at > TRACK_TOUCHED_WINDOW_MS) touchedProjects.delete(projectId);
    for (const report of trackedReports.list()) {
      const last = report.latest ? Date.parse(report.latest.at) : 0;
      const touched = report.projects.some((p) => touchedProjects.has(p.projectId));
      if (now - last > TRACK_REFRESH_MS || (touched && now - last > TRACK_TOUCHED_EVERY_MS)) {
        await refreshTrackedReport(report, session).catch((error) =>
          console.warn(`[tracked reports] ${logSafe(report.name)}: ${logSafe(error.message)}`),
        );
      }
    }
  }
  setInterval(() => {
    // Deactivated (the product licence): nothing reads Checkmarx One or sends anything on its own.
    if (!productActive()) return;
    tenancy.each(() => {
      backgroundRefresh().catch(() => {});
      monthlyImpact().catch((error) => console.warn(`[impact] ${error.message}`));
      resolveAutomationSession()
        .then((session) => session && runVerifications(session).then(() => session))
        .then((session) => session && runDueTrackedReminders(session))
        .catch((error) => console.warn(`[tracked reminders] ${error.message}`));
    });
  }, 60 * 1000).unref?.();

  // ---- Follow-up reminders, schedules and triage for a tracked report -------

  const DAY_MS = 86_400_000;
  // ---- Verification: rescan to prove a round's fixes, then the next round ----

  /** Projects whose rescan could not start wait this long for a scan from elsewhere (a pipeline). */
  const VERIFY_WAIT_MS = 30 * DAY_MS;
  const remediatedOf = (projectId) => creditLedger.remediatedIds(projectId);
  const cxErrorText = (error) => `${error?.status ? `HTTP ${error.status}: ` : ''}${String(error?.body?.message ?? error?.message ?? error).slice(0, 200)}`;
  const scanIdOfSummary = (scan) => String(scan?.id ?? scan?.scanId ?? '');

  /** Ask Checkmarx One to scan each of the report's projects again, like its last scan. */
  async function startVerification(report, session, { by = '', automatic = false, reason = '' } = {}) {
    if (report.verification && !report.verification.finishedAt) {
      throw Object.assign(new Error('A verification is already running for this report.'), { status: 409 });
    }
    // Scanned again like the latest scan of the branch that counts (a report made before branches were told apart: any branch's).
    const branchChoice = await branchChoiceFor(session, report.projects, report.filters.branches ?? 'all');
    const last = branchChoice?.scans ?? (await getLastScans(session.client, report.projects.map((p) => p.projectId)));
    const known = new Map((session.lastScan?.projects ?? []).map((p) => [p.projectId, p]));
    const requestedAt = new Date().toISOString();
    const projects = report.projects.map((p) => ({ projectId: p.projectId, projectName: p.projectName, status: 'Queued', scanId: '', lastScanId: '', error: '' }));
    await mapWithConcurrency(projects, 3, async (entry) => {
      entry.lastScanId = scanIdOfSummary(last[entry.projectId]);
      if (!entry.lastScanId) {
        entry.status = 'waiting';
        entry.error = branchChoice ? 'No completed scan of its primary branch yet: the first one verifies it.' : 'No completed scan yet: the first one verifies it.';
        return;
      }
      try {
        const scan = await session.client.request(`/api/scans/${encodeURIComponent(entry.lastScanId)}`, { retries: 1 });
        // Whose work this verifies: the last scan's initiator (or, after an earlier rescan, the developer it was credited to).
        const summary = last[entry.projectId];
        const earlier = creditFor(entry.lastScanId);
        const resolved = session.lastScan?.initiators?.[entry.projectId];
        const owner = earlier ?? {
          initiator: scanInitiator(summary) || scanInitiator(scan),
          email: scanInitiatorEmail(summary) || (resolved?.scanId === entry.lastScanId ? resolved.email : '') || '',
        };
        entry.creditedTo = owner.initiator;
        const request = rescanRequest(entry.projectId, scan, known.get(entry.projectId) ?? {}, { initiator: owner.email || owner.initiator, requestedBy: by || 'automatic verification' });
        if (request.waiting) {
          entry.status = 'waiting';
          entry.error = request.reason;
          return;
        }
        const created = await session.client.request('/api/scans', { method: 'POST', body: request.body, retries: 1 });
        entry.scanId = String(created?.id ?? '');
        entry.status = String(created?.status || 'Queued');
        scanAttribution.record(entry.scanId, { projectId: entry.projectId, initiator: owner.initiator, email: owner.email, requestedBy: by || 'automatic verification', reason: `verification of "${report.name}"` });
        entry.branch = request.branch;
        entry.engines = request.engines;
        if (!entry.scanId) throw new Error('Checkmarx One did not return a scan id.');
      } catch (error) {
        entry.status = 'waiting';
        entry.error = `Checkmarx One did not start a scan (${cxErrorText(error)}): the next scan of this project, from your pipeline or Checkmarx One, verifies it.`;
      }
    });
    const round = report.round ?? 1;
    report.verification = { round, requestedAt, by, automatic, projects, finishedAt: null, result: null };
    audit.record({
      type: 'verification',
      outcome: 'info',
      reason: `Verification rescan of "${report.name}" (round ${round}) ${reason || (automatic ? 'started automatically: every finding in scope was dealt with' : 'started')}.`,
      actor: automatic ? SYSTEM_ACTOR : { kind: 'user', user: by },
      details: { reportId: report.id, round, scans: projects.map(({ projectName, status, scanId, error }) => ({ projectName, status, scanId, error })) },
    });
    trackedReports.save();
    return report.verification;
  }

  /** Follow a running verification: scan statuses, scans from elsewhere, and the result once scans are done. */
  async function advanceVerification(report, session) {
    const v = report.verification;
    if (!v || v.finishedAt) return;
    const now = new Date().toISOString();
    let changed = false;
    const waiting = v.projects.filter((e) => e.status === 'waiting');
    if (waiting.length) {
      const waitingProjects = report.projects.filter((p) => waiting.some((e) => e.projectId === p.projectId));
      const branchChoice = await branchChoiceFor(session, waitingProjects, report.filters.branches ?? 'all');
      const last = branchChoice?.scans ?? (await getLastScans(session.client, waiting.map((e) => e.projectId)).catch(() => ({})));
      for (const entry of waiting) {
        const scan = last[entry.projectId];
        if (scan && scanIdOfSummary(scan) !== entry.lastScanId && newerThan(scan, v.requestedAt)) {
          Object.assign(entry, { scanId: scanIdOfSummary(scan), status: 'Completed', completedAt: now, error: '', fromElsewhere: true });
          changed = true;
        }
      }
    }
    for (const entry of v.projects) {
      if (entry.status === 'waiting' || TERMINAL.has(entry.status) || !entry.scanId) continue;
      try {
        const scan = await session.client.request(`/api/scans/${encodeURIComponent(entry.scanId)}`, { retries: 1, background: true });
        const status = String(scan?.status ?? '');
        if (status && status !== entry.status) {
          entry.status = status;
          if (TERMINAL.has(status)) entry.completedAt = now;
          changed = true;
        }
      } catch (error) {
        entry.error = `Could not read the scan's status (${cxErrorText(error)}).`;
      }
    }
    const scanning = v.projects.some((e) => e.status !== 'waiting' && !TERMINAL.has(e.status));
    const verified = v.projects.filter((e) => e.status === 'Completed' || e.status === 'Partial');
    const stillWaiting = v.projects.some((e) => e.status === 'waiting');
    if (changed && !scanning && verified.length) {
      const byProject = await currentFindings(session, report.projects, { branches: report.filters.branches ?? 'all' });
      trackedReports.record(report, progressFor(report, byProject));
      v.result = verificationResult(report, byProject, {
        verifiedProjects: new Set(verified.map((e) => e.projectId)),
        remediated: remediatedOf,
        newInScope: report.latest?.newFindings ?? 0,
      });
      v.checkedAt = now;
      const r = v.result;
      audit.record({
        type: 'verification',
        outcome: r.zero ? 'success' : 'info',
        reason: `Verification of "${report.name}" (round ${v.round}): ${r.fixed} fixed, ${r.stillFound.length} still found${r.ineffective ? ` (${r.ineffective} after AI Remediation)` : ''}, ${r.newInScope} new in scope${r.zero ? ' — the scope is at zero' : ''}.`,
        actor: SYSTEM_ACTOR,
        details: { reportId: report.id, round: v.round, fixed: r.fixed, stillFound: r.stillFound.length, ineffective: r.ineffective, accepted: r.accepted, newInScope: r.newInScope, notChecked: r.notChecked },
      });
      trackedReports.save();
      await developerResult(report, session).catch((error) => console.warn(`[verification] ${logSafe(report.name)}: ${logSafe(error.message)}`));
    }
    const expired = Date.now() - Date.parse(v.requestedAt) > VERIFY_WAIT_MS;
    if (!scanning && (!stillWaiting || expired)) {
      v.finishedAt = now;
      changed = true;
    }
    if (changed) trackedReports.save();
  }

  /**
   * Follow a report's verification. When its scope is closed, the developers get their turn to
   * rescan first (src/rescan-window.js); when that window ends with nobody rescanning, and
   * automatic verification is on, the rescan starts on their behalf.
   */
  async function verificationStep(report, session) {
    await advanceVerification(report, session);
    const action = windowAction(report);
    if (action === 'open') await openRescanWindow(report, session);
    else if (action === 'cancel') {
      report.verifyWindow = null;
      trackedReports.save();
    } else if (action === 'start') await rescanOnBehalf(report, session);
  }

  // ---- The developer's turn to rescan ----------------------------------------------------

  const rescanTokens = rescanGrants((text) => reportGrants.macText(text));
  /** The rescan button in a developer's report works for as long as the report's own grants (30 days). */
  const RESCAN_REPORT_GRANT_MS = 30 * DAY_MS;
  /** A developer's rescan link stays usable this long after their window ends (it then shows the result). */
  const RESCAN_LINK_EXTRA_MS = 14 * DAY_MS;

  /** Who fixed what: each project's latest scan initiator (as credited), with an address. */
  async function reportDevelopers(session, report) {
    const scan = await openScanFor(session, report);
    const byEmail = new Map();
    for (const p of report.projects) {
      const info = scan.initiators?.[p.projectId];
      const email = String(info?.email || '').trim().toLowerCase();
      if (!email) continue;
      if (!byEmail.has(email)) byEmail.set(email, { email, name: info.initiator || email, projects: [] });
      byEmail.get(email).projects.push(p.projectName);
    }
    return [...byEmail.values()];
  }

  /** The signed link a developer rescans this report's round with. */
  function rescanLink(report, email, window = currentWindow(report)) {
    const server = resolveReportServer(null, settingsStore.get());
    if (!server.url || !window) return '';
    const grant = rescanTokens.issue({ reportId: report.id, round: window.round, email, exp: Date.parse(window.dueAt) + RESCAN_LINK_EXTRA_MS });
    return `${server.url.replace(/\/+$/, '')}/rescan?g=${encodeURIComponent(grant)}${tenantQuery('&')}`;
  }

  /** The scope is closed: the developers' turn to rescan begins, and they are told. */
  async function openRescanWindow(report, session) {
    const developers = await reportDevelopers(session, report).catch(() => []);
    report.verifyWindow = newWindow(report, developers);
    trackedReports.save();
    audit.record({
      type: 'verification',
      outcome: 'info',
      reason: `Every finding in "${report.name}" (round ${report.verifyWindow.round}) was dealt with: its developers have until ${report.verifyWindow.dueAt} to rescan${report.verify?.auto ? ', then it is rescanned on their behalf' : ''}.`,
      actor: SYSTEM_ACTOR,
      details: { reportId: report.id, round: report.verifyWindow.round, dueAt: report.verifyWindow.dueAt, developers: developers.map((d) => d.email) },
    });
    await mailDevelopers(report, 'ready').catch((error) => console.warn(`[verification] ${logSafe(report.name)}: ${logSafe(error.message)}`));
  }

  /** Nobody rescanned in time: rescan on the developers' behalf, and tell them. */
  async function rescanOnBehalf(report, session) {
    const window = currentWindow(report);
    await startVerification(report, session, { automatic: true, reason: `started on its developers' behalf: nobody rescanned within ${window.graceHours} hours` });
    window.startedAt = new Date().toISOString();
    window.startedBy = '';
    trackedReports.save();
    await mailDevelopers(report, 'onBehalf').catch((error) => console.warn(`[verification] ${logSafe(report.name)}: ${logSafe(error.message)}`));
  }

  /** A developer starts the rescan of their own fixes (from their report, or the emailed link). */
  async function rescanByDeveloper(report, email) {
    const window = currentWindow(report);
    if (!window) return { status: 409, error: report.latest?.closure?.closed ? 'The rescan opens in a moment: try again shortly.' : 'Not every finding in this report is dealt with yet: triage or fix the rest first.' };
    if (window.startedAt || report.verification?.round === window.round) return { status: 409, error: 'This round is already being rescanned.' };
    const session = await resolveAutomationSession();
    if (!session) return { status: 503, error: 'The reminder server has no Checkmarx One connection right now.' };
    await startVerification(report, session, { by: email, reason: `started by ${email}, who fixed the findings` });
    window.startedAt = new Date().toISOString();
    window.startedBy = email;
    trackedReports.save();
    return { status: 200 };
  }

  /** One email to each developer of the report: their turn to rescan, a rescan on their behalf, or the result. */
  async function mailDevelopers(report, kind) {
    const settings = sendingSettings();
    const window = currentWindow(report);
    if (!window?.developers?.length || !isVerified(settings)) return 0;
    const brand = settings.branding?.companyName || settings.branding?.appName || 'Application security';
    const accent = /^#[0-9a-f]{6}$/i.test(settings.branding?.accentColor ?? '') ? settings.branding.accentColor : '#2856c9';
    const result = report.verification?.result;
    const due = new Date(window.dueAt).toUTCString().replace(/:\d\d GMT$/, ' UTC');
    let sent = 0;
    for (const dev of window.developers) {
      const link = rescanLink(report, dev.email, window);
      const button = link ? `<p style="margin:20px 0"><a href="${escapeHtmlText(link)}" style="background:${accent};color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Rescan now</a></p>` : '';
      const projects = escapeHtmlText(dev.projects.join(', '));
      const text = {
        ready: {
          subject: `${report.name}: your fixes are in, rescan to prove them`,
          lines: [
            `Every finding in scope for ${projects} has been dealt with. Thank you.`,
            `You get the first chance to prove the fixes: rescan now, before ${due}.`,
            report.verify?.auto ? 'If nobody rescans by then, CxMissionZero rescans on your behalf.' : 'After that, your security team rescans it.',
          ],
          button,
        },
        onBehalf: {
          subject: `${report.name}: rescanned on your behalf`,
          lines: [
            `No rescan was started within ${window.graceHours} hours, so CxMissionZero has started one for ${projects} on your behalf, to check that the fixes work.`,
            'You will get the updated report when it finishes.',
          ],
          button: '',
        },
        result: {
          subject: result?.zero ? `${report.name}: verified at zero` : `${report.name}: rescan result, ${result?.fixed ?? 0} fixed, ${result?.stillFound?.length ?? 0} still found`,
          lines: result?.zero
            ? [`The rescan of ${projects} found nothing left in scope: every fix worked. Mission Zero for this scope.`]
            : [
                `The rescan of ${projects} is done: ${result?.fixed ?? 0} fixed, ${result?.stillFound?.length ?? 0} still found${result?.ineffective ? ` (${result.ineffective} of them after an AI fix that did not work)` : ''}${result?.newInScope ? `, ${result.newInScope} new` : ''}.`,
                'The updated report with what is left follows in a separate email.',
              ],
          button: '',
        },
      }[kind];
      const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827;max-width:640px">
      <p style="font-size:13px;color:#6b7280;margin:0 0 4px">${escapeHtmlText(brand)}</p>
      <h2 style="margin:0 0 12px;font-size:18px">${escapeHtmlText(text.subject)}</h2>
      <p>Hi ${escapeHtmlText(dev.name || dev.email)},</p>
      ${text.lines.map((line) => `<p>${line}</p>`).join('')}
      ${text.button}
    </div>`;
      try {
        await sendReminderMail(settings, { subject: text.subject, html, text: `Hi ${dev.name || dev.email},\n\n${text.lines.join('\n\n').replace(/<[^>]+>/g, '')}${link && kind === 'ready' ? `\n\nRescan now: ${link}` : ''}\n` }, { exact: true, to: [dev.email] });
        sent += 1;
      } catch (error) {
        console.warn(`[verification] could not email ${logSafe(dev.email)}: ${logSafe(error.message)}`);
      }
    }
    window.notified = { ...(window.notified ?? {}), [kind]: new Date().toISOString() };
    trackedReports.save();
    return sent;
  }

  /** The result is in: tell the developers, and send the updated report of what is left. */
  async function developerResult(report, session) {
    if (!currentWindow(report)) return;
    await mailDevelopers(report, 'result');
    if (!report.verification?.result?.zero && isVerified(sendingSettings())) {
      const server = resolveReportServer(null, settingsStore.get());
      await remindTrackedReport(session, report, { sendTo: audienceSetting(), attachHtml: true }, server.url, { automatic: true });
    }
  }

  /** Every minute, for every report (and on each Refresh, for that one). */
  async function runVerifications(session) {
    for (const report of trackedReports.list()) {
      await verificationStep(report, session).catch((error) => console.warn(`[verification] ${logSafe(report.name)}: ${logSafe(error.message)}`));
    }
  }

  const MAX_REMINDERS_KEPT = 50;

  /**
   * A tracked report's open findings, fetched fresh: baseline findings not yet
   * resolved or triaged as not exploitable, plus new findings its filters match.
   * Shaped like a dashboard fetch so the reminder senders can use it directly.
   */
  async function openScanFor(session, report) {
    const byProject = await currentFindings(session, report.projects, { branches: report.filters.branches ?? 'all' });
    trackedReports.record(report, progressFor(report, byProject));
    let detection = null;
    try {
      detection = resolveWindow(report.filters.detection, 'First detection');
    } catch {}
    const baselineKeys = new Set(report.baseline.findings.map((f) => `${f.projectId}|${f.riskId}`));
    const since = baselineReadAt(report);
    const settings = settingsStore.get();
    // The same findings the report counts as open: its baseline, and those first found since (not older ones that now match).
    const projects = report.projects.map(({ projectId, projectName }) => {
      const risks = (byProject.get(projectId) ?? []).filter(
        (r) =>
          !NOT_EXPLOITABLE_STATES.has(r.state) &&
          (baselineKeys.has(`${projectId}|${r.riskId}`) || (matchesFilters(r, report.filters, detection) && foundSince(r, since))),
      );
      const summary = summariseProject({ id: projectId, name: projectName }, risks);
      summary.url = projectUrl(summary, session.connection, settings.links);
      return summary;
    });
    // Looked up fresh: a rescan moves a reminder to whoever ran it.
    const initiators = await collectInitiators(
      session.client,
      session.connection,
      report.projects.map((p) => ({ id: p.projectId, name: p.projectName })),
      { rules: settings.initiators, useDirectory: settings.initiators.useDirectory, concurrency: config.concurrency, memory: knownAddresses, attributed: creditFor },
    );
    return { projects, initiators: initiators.byProject, byProject, detectionWindow: detection, engines: engineScope(report.filters.engines), branchScope: report.filters.branches ?? 'all' };
  }

  /** Settings → Who gets reminders: 'initiator', 'list' or 'both'. */
  const audienceSetting = (settings = settingsStore.get()) => (['initiator', 'list', 'both'].includes(settings.reminders?.audience) ? settings.reminders.audience : 'initiator');

  const countSent = (body) => (Array.isArray(body?.sent) ? body.sent.length : body?.messageId ? 1 : 0);

  /** Send (or preview) a follow-up reminder for a report's open findings. */
  async function remindTrackedReport(session, report, options, relayUrl, { automatic = false } = {}) {
    // A report follows Settings → Who gets reminders, unless it was given its own choice ('developers', 'list' or
    // 'both'). 'initiator' was the old default every report was saved with, so it follows the setting too.
    const own = { developers: 'initiator', list: 'list', both: 'both' }[options.sendTo];
    const sendTo = own ?? audienceSetting();
    const emailContent = options.emailContent === 'per-project' ? 'per-project' : 'summary';
    const attachHtml = options.attachHtml === true;
    const dryRun = options.dryRun === true;
    // "Send only to": these addresses and nobody else, one summary email.
    const onlyTo = parseAddressList(options.onlyTo ?? []);

    const scan = await openScanFor(session, report);
    const open = scan.projects.reduce((n, p) => n + p.risks.length, 0);
    if (!open) return { status: 400, body: { error: 'Nothing is left open in this report, so no reminder is needed.' } };

    const result = onlyTo.length
      ? await sendReportOnlyTo(session, report, scan, onlyTo, { attachHtml, dryRun, relayUrl })
      : attachHtml && !dryRun
        ? await runHtmlReminder(session, scan, {
            groupBy: sendTo === 'list' ? 'none' : emailContent === 'per-project' ? 'project' : 'initiator',
            alsoConsolidated: sendTo === 'both',
            tracked: report,
          }, relayUrl)
        : await runReminder(session, scan, {
            groupBy: sendTo === 'list' ? 'none' : emailContent === 'per-project' ? 'project' : 'initiator',
            alsoConsolidated: sendTo === 'both',
            dryRun,
          });

    if (!dryRun) {
      report.reminders = [
        {
          at: new Date().toISOString(),
          automatic,
          sendTo: onlyTo.length ? 'only' : sendTo,
          onlyTo,
          emailContent,
          attachHtml,
          openFindings: open,
          sent: result.status === 200 ? countSent(result.body) : 0,
          error: result.status === 200 ? '' : result.body?.error || 'Failed',
        },
        ...(report.reminders ?? []),
      ].slice(0, MAX_REMINDERS_KEPT);
      trackedReports.save();
    }
    return result;
  }

  /** Every open finding of a tracked report, as one list. */
  const openRisksOf = (scan) => selectRisks(scan.projects, { projectIds: null, buckets: [], severities: null });

  /** The interactive HTML report of a tracked report's open findings. */
  async function trackedReportHtml(session, report, scan, relayUrl, audience = {}, publish = '') {
    return buildInteractiveReport(session, openRisksOf(scan), {
      settings: settingsStore.get(),
      relayUrl,
      publish,
      initiatorsByProject: scan.initiators,
      audience: { purpose: `for tracked report "${report.name}"`, ...audience },
      tracked: report,
      // Its own engines and branches, not the Workbench's.
      scope: { buckets: [], engines: engineScope(report.filters.engines), branches: report.filters.branches ?? 'all' },
    });
  }

  /** One summary email of a tracked report's open findings to exactly these addresses. */
  async function sendReportOnlyTo(session, report, scan, addresses, { attachHtml, dryRun, relayUrl }) {
    const settings = sendingSettings();
    if (!attachHtml) {
      const result = await runReminder(session, scan, { groupBy: 'none', dryRun, recipients: { to: addresses, exact: true } });
      if (dryRun && result.status === 200) result.body.recipients = { to: addresses, cc: [], bcc: [] };
      return result;
    }
    const filename = reportFileName(report);
    const { reportData, findings, html, downloadUrl } = await trackedReportHtml(session, report, scan, relayUrl, {
      recipient: addresses.join(', '),
      purpose: `emailed (only to) for tracked report "${report.name}"`,
    }, filename);
    const body = buildReportEmail(reportData, { greeting: 'Hi', topCount: findings.length, downloadUrl });
    const total = reportData.totalRisks ?? openRisksOf(scan).length;
    const message = { subject: `${report.name}: ${total} open vulnerabilities to triage`, html: body.html, text: body.text };
    if (dryRun) {
      return { status: 200, body: { dryRun: true, groupBy: 'none', subject: message.subject, html: message.html, recipients: { to: addresses, cc: [], bcc: [] }, canSend: isVerified(settings) } };
    }
    const result = await sendReminderMail(settings, message, {
      exact: true,
      to: addresses,
      attachments: [{ filename, content: html, contentType: 'text/html' }],
    });
    return { status: 200, body: { ...result, groupBy: 'none', sent: [{ email: addresses.join(', '), messageId: result.messageId }] } };
  }

  const reportFileName = (report) =>
    `${String(report.name).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'report'}-${new Date().toISOString().slice(0, 10)}.html`;

  /** The next time at `hour`, in this machine's time zone, that is at least `from`. */
  function nextRunAt(hour, from = new Date()) {
    const next = new Date(from);
    next.setHours(hour, 0, 0, 0);
    if (next < from) next.setDate(next.getDate() + 1);
    return next.toISOString();
  }

  /** This machine's time zone, which schedules run in. */
  function serverTimeZone() {
    const name = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const offset = -new Date().getTimezoneOffset();
    const sign = offset < 0 ? '-' : '+';
    const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
    const mm = String(Math.abs(offset) % 60).padStart(2, '0');
    return { name, offset: `UTC${sign}${hh}:${mm}` };
  }

  async function runDueTrackedReminders(session) {
    const settings = sendingSettings();
    const now = Date.now();
    // Hands-off mode, paused from an email: scheduled follow-ups wait too (they run when it resumes).
    if (isPaused(settings.handsOff, now)) return;
    for (const report of trackedReports.list()) {
      const auto = report.automation;
      if (!auto?.enabled || !auto.nextRunAt || Date.parse(auto.nextRunAt) > now) continue;
      // Move the schedule on first, so a failing send is not retried every minute.
      const next = new Date(auto.nextRunAt);
      while (next.getTime() <= now) next.setDate(next.getDate() + auto.everyDays);
      if (Number.isInteger(auto.hour)) next.setHours(auto.hour, 0, 0, 0);
      auto.nextRunAt = next.toISOString();
      trackedReports.save();
      if (!isVerified(settings)) {
        auto.lastError = 'Email is not set up yet (Settings → Email server), so nothing was sent.';
        trackedReports.save();
        continue;
      }
      try {
        const server = resolveReportServer(null, settings);
        if (!server.url) console.warn(`! [reports] "${logSafe(report.name)}": sent without a reminder server address — set it in Settings → Links or REPORT_SERVER_URL.`);
        const result = await remindTrackedReport(session, report, auto, server.url, { automatic: true });
        auto.lastError = result.status === 200 ? '' : result.body?.error || 'Failed';
      } catch (error) {
        auto.lastError = error.message;
      }
      auto.lastRunAt = new Date().toISOString();
      trackedReports.save();
    }
  }

  app.post(
    '/api/tracked-reports/:id/remind',
    requirePermission('reports.remind'),
    asyncRoute(async (req, res) => {
      const report = trackedReports.get(req.params.id);
      if (!report) return res.status(404).json({ error: 'No such report.' });
      const settings = sendingSettings();
      if (req.body?.dryRun !== true && !isVerified(settings)) {
        return res.status(400).json({ error: 'Test the SMTP connection on the Settings page before sending.' });
      }
      const { status, body } = await remindTrackedReport(req.session, report, req.body ?? {}, reportServerUrl(req, settings));
      res.status(status).json({ ...body, report: trackedView(report) });
    }),
  );

  app.put('/api/tracked-reports/:id/automation', requirePermission('reports.manage'), (req, res) => {
    const report = trackedReports.get(req.params.id);
    if (!report) return res.status(404).json({ error: 'No such report.' });
    const input = req.body ?? {};
    const everyDays = Math.min(90, Math.max(1, Math.floor(Number(input.everyDays) || 7)));
    const hour = Math.min(23, Math.max(0, Math.floor(Number(input.hour) || 0)));
    const enabled = input.enabled === true;
    report.automation = {
      enabled,
      everyDays,
      hour,
      // 'settings' (or nothing): follow Settings → Who gets reminders; a report keeps its own choice only when given one.
      sendTo: ['developers', 'list', 'both'].includes(input.sendTo) ? input.sendTo : 'settings',
      emailContent: input.emailContent === 'per-project' ? 'per-project' : 'summary',
      attachHtml: input.attachHtml === true,
      onlyTo: parseAddressList(input.onlyTo ?? []),
      nextRunAt: enabled ? nextRunAt(hour) : null,
      lastRunAt: report.automation?.lastRunAt ?? null,
      lastError: '',
    };
    trackedReports.save();
    res.json(trackedView(report));
  });

  /** Download the interactive HTML report a follow-up reminder would attach. */
  app.get(
    '/api/tracked-reports/:id/html',
    requirePermission('reports.view'),
    asyncRoute(async (req, res) => {
      const report = trackedReports.get(req.params.id);
      if (!report) return res.status(404).json({ error: 'No such report.' });
      const scan = await openScanFor(req.session, report);
      if (!openRisksOf(scan).length) return res.status(400).json({ error: 'Nothing is left open in this report.' });
      const actor = await adminActor(req);
      const { html } = await trackedReportHtml(req.session, report, scan, reportServerUrl(req, settingsStore.get()), {
        actor,
        recipient: `downloaded by ${actor.user || 'administrator'}`,
        purpose: `downloaded for tracked report "${report.name}"`,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${reportFileName(report)}"`);
      res.send(html);
    }),
  );

  /**
   * Allocate credits to a tracked report's projects, so their developers can
   * triage from their own reports: the severities join each project's triage
   * rule, and any extra credits are added on top.
   */
  /**
   * Give `projects` what the `wanted` severities of their findings still need
   * (confirmed by two agreeing reads of Checkmarx One, never an estimate), plus
   * extra credits each, out of the credit pool. The severities join each
   * project's rule. Those two reads are the only reads: extra credits alone need
   * none. A project deleted from Checkmarx One is left out and named.
   * Returns { error, gone } when refused, else { gone, byProject } (the verified findings).
   */
  async function allocateNeeded(req, projects, { wanted, extraTriage, extraRemediation, where, details, engines = null, branches = 'primary', kinds = CREDIT_KINDS, keep = null }) {
    const actor = await adminActor(req);
    const verifiedRisks = new Map();
    const gone = [];
    const ruleWith = (projectId) => SEVERITIES.filter((s) => wanted.includes(s) || allocations.severitiesOf(projectId).includes(s));
    if (wanted.length) {
      // Each project's latest scan on the branch that counts (every branch's latest, when asked for).
      const branchChoice = await branchChoiceFor(req.session, projects, branches);
      const lastScans = branchChoice?.scans ?? (await getLastScans(req.session.client, projects.map((p) => p.projectId)).catch(() => ({})));
      const scanIdOf = (id) => String(lastScans?.[id]?.id ?? lastScans?.[id]?.scanId ?? '');
      const refused = [];
      await mapWithConcurrency(projects, 3, async (p) => {
        try {
          // Read under the rule it is about to get (its own severities and the wanted ones), as the need is counted.
          const { second, agreed } = await doubleRead(req.session, p, { scanIdOf, branchChoice, severities: ruleWith(p.projectId) });
          if (agreed) verifiedRisks.set(p.projectId, second.summary.risks);
          else refused.push(`${p.projectName}: ${DISAGREED}`);
        } catch (error) {
          if (await projectMissing(req.session.client, p.projectId)) gone.push({ projectId: p.projectId, projectName: p.projectName });
          else refused.push(`${p.projectName}: could not read Checkmarx One (${error.message})`);
        }
      });
      if (refused.length) {
        const reason = `Not allocated: what the projects need could not be confirmed twice with Checkmarx One. ${refused[0]}`;
        audit.record({ type: 'allocation', outcome: 'refused', reason, actor, credits: { kind: 'allocation', requested: 0, charged: 0 }, details });
        return { error: reason, gone };
      }
    }
    projects = projects.filter((p) => !gone.some((g) => g.projectId === p.projectId));
    if (!projects.length) return { error: goneText(gone), gone };
    const before = new Map(projects.map((p) => [p.projectId, allocationSnapshot(p.projectId)]));
    for (const { projectId, projectName } of projects) {
      if (wanted.length) allocations.setSeverities(projectId, projectName, ruleWith(projectId));
    }
    const plan = projects.map(({ projectId, projectName }) => {
      // Only the findings of the engines chosen (and, when given, those `keep` names) count towards the need.
      const risks = (verifiedRisks.get(projectId) ?? []).filter((r) => inEngines(r, engines) && (!keep || keep(projectId, r)));
      const { shortfall } = allocations.need(projectId, risks);
      const wants = (kind) => wanted.length > 0 && kinds.includes(kind);
      return { projectId, projectName, triage: wants('triage') ? shortfall.triage : 0, remediation: wants('remediation') ? shortfall.remediation : 0 };
    });
    const given = plan.reduce((n, x) => n + x.triage + x.remediation + extraTriage + extraRemediation, 0);
    const pool = creditPool();
    if (pool.limited && given > pool.unallocated) {
      allocations.save();
      const reason = `Only ${pool.unallocated} credit${pool.unallocated === 1 ? '' : 's'} left in the credit pool to give; ${given} needed for ${where}.`;
      audit.record({ type: 'allocation', outcome: 'refused', reason, actor, credits: { kind: 'allocation', requested: given, charged: 0 }, details: { ...details, pool } });
      return { error: `${reason} Raise the pool under Settings → AI & credit pool.`, pool, gone };
    }
    const beyond = await tenantRefusal(req, given, pool);
    if (beyond) {
      allocations.save();
      audit.record({ type: 'allocation', outcome: 'refused', reason: beyond, actor, credits: { kind: 'allocation', requested: given, charged: 0 }, details: { ...details, pool } });
      return { error: beyond, pool, gone };
    }
    for (const { projectId, projectName, triage, remediation } of plan) {
      if (triage) allocations.grant(projectId, projectName, 'triage', triage);
      if (remediation) allocations.grant(projectId, projectName, 'remediation', remediation);
      if (extraTriage) allocations.add(projectId, projectName, 'triage', extraTriage);
      if (extraRemediation) allocations.add(projectId, projectName, 'remediation', extraRemediation);
    }
    allocations.save();
    for (const { projectId, projectName } of projects) {
      auditAllocation({
        actor, projectId, projectName, before: before.get(projectId),
        change: { severities: wanted, addTriage: extraTriage || undefined, addRemediation: extraRemediation || undefined },
        reason: `Changed from ${where}.`,
      });
    }
    return { gone, byProject: verifiedRisks };
  }

  const CREDIT_KINDS = ['triage', 'remediation'];
  /** The credits one allocation gives: triage only, remediation only, or (unnamed) both. */
  const kindsOf = (kind) => (CREDIT_KINDS.includes(kind) ? [kind] : CREDIT_KINDS);

  /**
   * Credit Control: give the ticked projects (none ticked: every project holding
   * credits) what the chosen severities need, plus any extra.
   */
  app.post('/api/credits/allocate-needed', requirePermission('credits.allocate'), afterFetch, asyncRoute(async (req, res) => {
    const wanted = cleanSeverities(req.body?.severities);
    const extraTriage = Math.max(0, Math.floor(Number(req.body?.triageAdd) || 0));
    const extraRemediation = Math.max(0, Math.floor(Number(req.body?.remediationAdd) || 0));
    if (!wanted.length && !extraTriage && !extraRemediation) return res.status(400).json({ error: 'Pick severities, or enter credits to add.' });
    if (!req.session.client) return res.status(409).json({ error: 'Connect to Checkmarx One first.' });
    const chosen = new Set(idList(req.body?.projectIds));
    const projects = allocations.list().filter((p) => !chosen.size || chosen.has(p.projectId)).map((p) => ({ projectId: p.projectId, projectName: p.projectName || p.projectId }));
    if (!projects.length) return res.status(400).json({ error: 'Give credits to a project first.' });
    const engines = engineScope(req.body?.engines);
    const done = await allocateNeeded(req, projects, {
      wanted, extraTriage, extraRemediation, engines, branches: req.body?.branches, kinds: kindsOf(req.body?.kind), where: 'Credit Control', details: { projectIds: projects.map((p) => p.projectId), engines: engines ?? 'all', kind: req.body?.kind ?? 'both' },
    });
    if (done.error) return res.status(409).json(done);
    const { gone } = done;
    for (const p of req.session.lastScan?.projects ?? []) if (allocations.get(p.projectId)) p.credits = creditView(p);
    res.json({ pool: creditPool(), allocations: allocations.list(), gone, goneNote: gone.length ? `Skipped: ${goneText(gone)}` : '' });
  }));

  app.post(
    '/api/tracked-reports/:id/allocate',
    requirePermission('credits.allocate'),
    afterFetch,
    asyncRoute(async (req, res) => {
      const report = trackedReports.get(req.params.id);
      if (!report) return res.status(404).json({ error: 'No such report.' });
      const wanted = cleanSeverities(req.body?.severities);
      const extraTriage = Math.max(0, Math.floor(Number(req.body?.triageAdd) || 0));
      const extraRemediation = Math.max(0, Math.floor(Number(req.body?.remediationAdd) || 0));
      if (!wanted.length && !extraTriage && !extraRemediation) {
        return res.status(400).json({ error: 'Pick severities, or enter credits to add.' });
      }
      const done = await allocateNeeded(req, report.projects, {
        wanted, extraTriage, extraRemediation, engines: report.filters.engines, branches: report.filters.branches ?? 'all', kinds: kindsOf(req.body?.kind), where: `tracked report "${report.name}"`, details: { report: report.id, kind: req.body?.kind ?? 'both' },
      });
      if (done.error) return res.status(409).json(done);
      const { gone } = done;
      // The two reads that confirmed the need are the report's current findings too.
      if (wanted.length && !gone.length) trackedReports.record(report, progressFor(report, done.byProject));
      res.json({ report: trackedView(report), gone, goneNote: gone.length ? `Skipped: ${goneText(gone)}` : '' });
    }),
  );

  app.post(
    '/api/tracked-reports/:id/triage',
    requirePermission('triage.run'),
    afterFetch,
    asyncRoute(async (req, res) => {
      const report = trackedReports.get(req.params.id);
      if (!report) return res.status(404).json({ error: 'No such report.' });
      const wanted = cleanSeverities(req.body?.severities);
      if (!wanted.length) return res.status(400).json({ error: 'Pick at least one severity to triage.' });
      const scan = await openScanFor(req.session, report);
      const findings = scan.projects.flatMap((p) =>
        p.risks
          .filter((r) => wanted.includes(r.severity) && (!r.state || r.state === 'TO_VERIFY'))
          .map((r) => ({ ...r, projectId: p.projectId, projectName: p.projectName })),
      );
      if (!findings.length) return res.json({ requested: 0, started: 0, failed: 0, skipped: 0, errors: [], report: trackedView(report) });
      const { startedFindings, ...summary } = await adminTriage(req.session, findings, scan.initiators, {
        actor: await adminActor(req),
        origin: `Tracked report "${report.name}": triage the open findings`,
      });
      const notified = req.body?.notifyInitiators === false ? null : await notifyOnBehalf(req.session, 'triage', startedFindings, scan.initiators, await adminActor(req));
      res.json({ ...summary, notified, report: trackedView(report) });
    }),
  );

  /**
   * AI Remediation for a tracked report's confirmed findings (and only those) of
   * the chosen severities, read fresh: 3 credits each, from remediation credits
   * already given to its projects.
   */
  app.post(
    '/api/tracked-reports/:id/remediate',
    requirePermission('triage.run'),
    afterFetch,
    asyncRoute(async (req, res) => {
      const report = trackedReports.get(req.params.id);
      if (!report) return res.status(404).json({ error: 'No such report.' });
      const wanted = cleanSeverities(req.body?.severities);
      if (!wanted.length) return res.status(400).json({ error: 'Pick at least one severity to remediate.' });
      const scan = await openScanFor(req.session, report);
      const summary = await remediateConfirmed(req, scan, wanted, `Tracked report "${report.name}": remediate the confirmed findings`);
      // What is left to remediate, now that these are sent (the button stops glowing when nothing is).
      if (summary.started && report.latest) {
        report.latest = { ...report.latest, toRemediate: progressFor(report, scan.byProject).toRemediate };
        trackedReports.save();
      }
      res.json({ ...summary, report: trackedView(report) });
    }),
  );

  /** Remediate the confirmed findings of these severities in a freshly read scan; tell the developers unless asked not to. */
  async function remediateConfirmed(req, scan, wanted, origin) {
    const { allowReremediation = false } = settingsStore.get().aiTriage ?? {};
    const findings = scan.projects.flatMap((p) => {
      const remediated = allowReremediation ? new Set() : creditLedger.remediatedIds(p.projectId);
      return p.risks.filter((r) => remediable(r) && !remediated.has(r.riskId)).map((r) => ({ ...r, projectId: p.projectId, projectName: p.projectName }));
    });
    const unique = remediationCandidates(findings, wanted);
    if (!unique.length) return { requested: 0, started: 0, failed: 0, skipped: 0, errors: [] };
    const actor = await adminActor(req);
    const { startedFindings, ...summary } = await adminRemediate(req.session, unique, scan.initiators, { actor, origin });
    const notified = req.body?.notifyInitiators === false ? null : await notifyOnBehalf(req.session, 'remediation', startedFindings, scan.initiators, actor);
    return { ...summary, notified };
  }

  /** A report for listing, with its projects' credit balance summed. */
  function trackedView(report) {
    const credits = { triage: { allocated: 0, used: 0, remaining: 0 }, remediation: { allocated: 0, used: 0, remaining: 0 } };
    for (const { projectId } of report.projects) {
      const balance = allocations.balance(projectId);
      for (const kind of ['triage', 'remediation']) {
        for (const key of ['allocated', 'used', 'remaining']) credits[kind][key] += balance[kind][key];
      }
    }
    return { ...reportSummary(report), credits };
  }

  /**
   * AI credits used across the measured reports: a project in two reports is counted once,
   * from the earlier report's start (summing each report's own figure would count it twice).
   */
  function portfolioCredits(reports) {
    const since = new Map();
    for (const report of reports) {
      if (!report.latest) continue;
      for (const { projectId } of report.projects) {
        if (!since.has(projectId) || report.createdAt < since.get(projectId)) since.set(projectId, report.createdAt);
      }
    }
    return creditLedger.usedSinceEach(since);
  }

  app.get('/api/tracked-reports', requirePermission('reports.view'), asyncRoute(async (req, res) => {
    const reports = trackedReports.list();
    res.json({
      timeZone: serverTimeZone(),
      reports: reports.map(trackedView),
      portfolio: { aiActions: portfolioCredits(reports) },
      autoRefresh: Boolean(sessions.get(tstate.automationSessionId) ?? sessions.get(tstate.bootstrapSessionId) ?? settingsStore.get().automationApiKey),
    });
  }));

  app.post('/api/tracked-reports', requirePermission('reports.manage'), (req, res) => {
    const { lastScan } = req.session;
    if (!lastScan) return res.status(409).json({ error: 'Load findings on the Workbench first.' });
    const { name, severities = null, buckets = [], windows = {}, scopeLabel = '' } = req.body ?? {};
    const projectIds = idList(req.body?.projectIds);
    if (!String(name ?? '').trim()) return res.status(400).json({ error: 'Give the report a name.' });

    const wantedSeverities = (Array.isArray(severities) ? severities : []).map((s) => String(s).toUpperCase()).filter((s) => SEVERITIES.includes(s));
    const wantedBuckets = (Array.isArray(buckets) ? buckets : []).map(String).filter((b) => AGE_BUCKETS.some((a) => a.id === b));
    const risks = selectRisks(lastScan.projects, {
      projectIds: projectIds.length ? projectIds : null,
      buckets: wantedBuckets,
      severities: wantedSeverities.length ? wantedSeverities : null,
    });
    const inScope = lastScan.projects.filter((p) => !p.error && (!projectIds.length || projectIds.includes(p.projectId)));
    const clean = (w) => ({ preset: String(w?.preset ?? 'any'), from: w?.from ? String(w.from) : undefined, to: w?.to ? String(w.to) : undefined });

    const report = trackedReports.create({
      name,
      scopeLabel: String(scopeLabel).slice(0, 300),
      filters: {
        activity: clean(windows.activity),
        detection: clean(windows.detection),
        severities: wantedSeverities,
        buckets: wantedBuckets,
        // The engines the Workbench loaded ([] = every engine): refreshes and new rounds keep to them.
        engines: lastScan.engines ?? [],
        // One branch per project, or every branch, as the Workbench read them (a report made before: every branch).
        branches: lastScan.branchScope ?? 'primary',
      },
      projects: inScope.map((p) => ({ projectId: p.projectId, projectName: p.projectName })),
      findings: risks,
      readAt: lastScan.view?.fetchedAt,
    });
    // The first reading comes straight from the data just fetched.
    trackedReports.record(report, progressFor(report, new Map(inScope.map((p) => [p.projectId, p.risks ?? []]))));
    res.status(201).json(trackedView(report));
  });

  app.post(
    '/api/tracked-reports/:id/refresh',
    requirePermission('reports.view'),
    asyncRoute(async (req, res) => {
      const report = trackedReports.get(req.params.id);
      if (!report) return res.status(404).json({ error: 'No such report.' });
      await refreshTrackedReport(report, req.session);
      await verificationStep(report, req.session).catch((error) => {
        report.lastError = `Verification: ${error.message}`;
      });
      res.json(trackedView(report));
    }),
  );

  /** Rescan the report's projects in Checkmarx One to verify the round's fixes. */
  app.post(
    '/api/tracked-reports/:id/verify',
    requirePermission('reports.manage'),
    asyncRoute(async (req, res) => {
      const report = trackedReports.get(req.params.id);
      if (!report) return res.status(404).json({ error: 'No such report.' });
      const session = req.session?.client ? req.session : await resolveAutomationSession();
      if (!session) return res.status(409).json({ error: 'Connect to Checkmarx One first.' });
      await startVerification(report, session, { by: req.user?.email ?? '' });
      res.json(trackedView(report));
    }),
  );

  /**
   * How a round is verified: the developers' window to rescan themselves (24 hours to 14 days,
   * 48 by default), and whether it is rescanned on their behalf when nobody did.
   */
  app.put('/api/tracked-reports/:id/verify-settings', requirePermission('reports.manage'), (req, res) => {
    const report = trackedReports.get(req.params.id);
    if (!report) return res.status(404).json({ error: 'No such report.' });
    const auto = 'auto' in (req.body ?? {}) ? req.body.auto === true : Boolean(report.verify?.auto);
    const graceHours = 'graceHours' in (req.body ?? {}) ? graceHoursOf({ verify: { graceHours: req.body.graceHours } }) : graceHoursOf(report);
    report.verify = { ...(report.verify ?? {}), auto, graceHours };
    // An open window keeps its developers; its end moves with the new length.
    const window = currentWindow(report);
    if (window && !window.startedAt) {
      window.graceHours = graceHours;
      window.dueAt = new Date(Date.parse(window.openedAt) + graceHours * HOUR_MS).toISOString();
    }
    trackedReports.save();
    audit.record({ type: 'verification', outcome: 'changed', reason: `Verification of "${report.name}": developers have ${graceHours} hours to rescan, then ${auto ? 'it is rescanned on their behalf' : 'it waits for a rescan by hand'}.`, actor: { kind: 'user', user: req.user?.email ?? '' }, details: { reportId: report.id, auto, graceHours } });
    res.json(trackedView(report));
  });

  // ---- A developer rescans their own fixes: from their report, or the emailed link ----

  /** Each developer's own rescan link, to send by hand (when email is not set up, for example). */
  app.get('/api/tracked-reports/:id/rescan-links', requirePermission('reports.manage'), (req, res) => {
    const report = trackedReports.get(req.params.id);
    if (!report) return res.status(404).json({ error: 'No such report.' });
    const window = currentWindow(report);
    if (!window) return res.status(409).json({ error: 'Not every finding in scope is dealt with yet: the developers\' rescan opens then.' });
    const links = (window.developers ?? []).map((d) => ({ email: d.email, name: d.name, projects: d.projects, link: rescanLink(report, d.email, window) }));
    if (links.some((l) => !l.link)) return res.status(409).json({ error: 'Set the reminder server address (Settings → Server address) so the links can reach this server.' });
    res.json({ dueAt: window.dueAt, links });
  });

  /** {report, grant} for a valid rescan grant, or an error to show. */
  function rescanFromGrant(token) {
    const grant = rescanTokens.verify(token);
    if (!grant) return { error: 'This rescan link is not valid any more. Ask your security team for a new report.' };
    const report = trackedReports.get(grant.reportId);
    if (!report) return { error: 'This report is no longer tracked.' };
    return { report, grant };
  }

  /** Where the developer's rescan stands (the emailed report asks this). */
  app.post('/api/relay/rescan-state', (req, res) => {
    const { report, grant, error } = rescanFromGrant(req.body?.grant);
    if (error) return res.status(403).json({ error });
    res.json({ name: report.name, round: report.round ?? 1, sameRound: grant.round === (report.round ?? 1), ...windowState(report) });
  });

  /** Start the rescan, as the developer (the emailed report's button). */
  app.post(
    '/api/relay/rescan',
    asyncRoute(async (req, res) => {
      const { report, grant, error } = rescanFromGrant(req.body?.grant);
      if (error) return res.status(403).json({ error });
      if (grant.round !== (report.round ?? 1)) return res.status(409).json({ error: 'That round is over: a newer report is on its way.' });
      const started = await rescanByDeveloper(report, grant.email);
      if (started.status !== 200) return res.status(started.status).json({ error: started.error, ...windowState(report) });
      res.json({ name: report.name, ...windowState(report) });
    }),
  );

  /** The emailed link: one page, no script, one button. */
  const rescanPage = (title, body, { grant = '', button = false } = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="/app-icon"><title>${escapeHtmlText(title)}</title>
<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f5f6fa;color:#111827;display:grid;place-items:center;min-height:100vh}main{max-width:520px;margin:16px;background:#fff;border:1px solid #e3e6ee;border-radius:10px;padding:28px}h1{font-size:20px;margin:0 0 12px}p{line-height:1.5;color:#374151}button{margin-top:12px;background:#14171c;color:#fff;border:0;border-radius:9px;padding:12px 20px;font:inherit;font-weight:600;cursor:pointer}small{color:#6b7280}@media(prefers-color-scheme:dark){body{background:#0f1117;color:#e5e7eb}main{background:#171a23;border-color:#2a2f3c}p{color:#cbd5e1}}</style></head>
<body><main><h1>${escapeHtmlText(title)}</h1>${body}${button ? `<form method="post" action="/rescan${escapeHtmlText(tenantQuery('?'))}"><input type="hidden" name="g" value="${escapeHtmlText(grant)}"><button type="submit">Rescan now</button></form>` : ''}<p><small>CxMissionZero</small></p></main></body></html>`;

  function rescanPageFor(report, grant, token, note = '') {
    const s = windowState(report);
    const intro = note ? `<p>${escapeHtmlText(note)}</p>` : '';
    if (grant.round !== (report.round ?? 1)) return rescanPage(report.name, `${intro}<p>That round is over. A newer report is on its way.</p>`);
    if (s.state === 'ready') {
      return rescanPage(`${report.name}: rescan your fixes`, `${intro}<p>Every finding in scope has been dealt with. Rescan now to prove the fixes work: Checkmarx One scans the same repository, branch and engines again, and you get the result.</p><p>You have until <strong>${escapeHtmlText(new Date(s.dueAt).toUTCString())}</strong> (${s.hoursLeft} hour${s.hoursLeft === 1 ? '' : 's'} left)${s.onBehalf ? '. After that it is rescanned on your behalf' : ''}.</p>`, { grant: token, button: true });
    }
    if (s.state === 'scanning') return rescanPage(`${report.name}: rescanning`, `${intro}<p>The rescan is running${s.startedBy ? `, started by ${escapeHtmlText(s.startedBy)}` : s.automatic ? ', started on your behalf' : ''}. You will get the result by email.</p>`);
    if (s.state === 'zero') return rescanPage(`${report.name}: verified at zero`, `${intro}<p>The rescan found nothing left in scope. Every fix worked.</p>`);
    if (s.state === 'verified') return rescanPage(`${report.name}: rescanned`, `${intro}<p>${s.result.fixed} fixed, ${s.result.stillFound} still found. The updated report has been sent to you.</p>`);
    return rescanPage(report.name, `${intro}<p>Not every finding in scope is dealt with yet${s.open ? ` (${s.open} left)` : ''}: triage or fix the rest from your report first.</p>`);
  }

  app.get('/rescan', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const token = String(req.query.g ?? '');
    const { report, grant, error } = rescanFromGrant(token);
    if (error) return res.status(403).type('html').send(rescanPage('Rescan', `<p>${escapeHtmlText(error)}</p>`));
    res.type('html').send(rescanPageFor(report, grant, token));
  });

  app.post(
    '/rescan',
    express.urlencoded({ extended: false, limit: '4kb' }),
    asyncRoute(async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const token = String(req.body?.g ?? '');
      const { report, grant, error } = rescanFromGrant(token);
      if (error) return res.status(403).type('html').send(rescanPage('Rescan', `<p>${escapeHtmlText(error)}</p>`));
      const started = grant.round === (report.round ?? 1) ? await rescanByDeveloper(report, grant.email) : { status: 409 };
      res.status(started.status === 200 ? 200 : started.status).type('html').send(rescanPageFor(report, grant, token, started.status === 200 ? 'Rescan started. Thank you.' : started.error ?? ''));
    }),
  );

  /**
   * The next round: the round so far is kept in the report's history, and a new
   * baseline is taken from the findings Checkmarx One reports now (after the
   * rescan), with a new scope, e.g. medium and low once critical and high are at zero.
   */
  app.post(
    '/api/tracked-reports/:id/next-round',
    requirePermission('reports.manage'),
    asyncRoute(async (req, res) => {
      const report = trackedReports.get(req.params.id);
      if (!report) return res.status(404).json({ error: 'No such report.' });
      if (report.verification && !report.verification.finishedAt && report.verification.projects.some((e) => e.status !== 'waiting' && !TERMINAL.has(e.status))) {
        return res.status(409).json({ error: 'Wait for the verification scans to finish first.' });
      }
      const severities = (Array.isArray(req.body?.severities) ? req.body.severities : []).map((x) => String(x).toUpperCase()).filter((x) => SEVERITIES.includes(x));
      const buckets = (Array.isArray(req.body?.buckets) ? req.body.buckets : []).map(String).filter((b) => AGE_BUCKETS.some((a) => a.id === b));
      if (!severities.length) return res.status(400).json({ error: 'Choose the severities for the next round.' });
      const session = req.session?.client ? req.session : await resolveAutomationSession();
      if (!session) return res.status(409).json({ error: 'Connect to Checkmarx One first.' });
      const byProject = await currentFindings(session, report.projects, { branches: report.filters.branches ?? 'all' });
      const filters = { ...report.filters, severities, buckets };
      let detection = null;
      try {
        detection = resolveWindow(filters.detection, 'First detection');
      } catch {}
      const findings = [];
      for (const [, risks] of byProject) {
        for (const r of risks) if (matchesFilters(r, filters, detection) && outcomeOf(r) !== 'notExploitable') findings.push(r);
      }
      const round = report.round ?? 1;
      const latest = report.latest ?? {};
      report.rounds = [
        ...(report.rounds ?? []),
        {
          round,
          severities: report.filters.severities,
          buckets: report.filters.buckets,
          startedAt: report.roundStartedAt ?? report.createdAt,
          endedAt: new Date().toISOString(),
          baseline: report.baseline.findings.length,
          outcomes: latest.outcomes ?? null,
          verification: report.verification
            ? { requestedAt: report.verification.requestedAt, automatic: report.verification.automatic, result: report.verification.result ? { ...report.verification.result, stillFound: report.verification.result.stillFound.slice(0, 50) } : null }
            : null,
        },
      ].slice(-50);
      report.round = round + 1;
      report.roundStartedAt = new Date().toISOString();
      report.filters = filters;
      report.baseline = {
        at: report.roundStartedAt,
        readAt: report.roundStartedAt,
        findings: findings.map((r) => ({ projectId: r.projectId, riskId: r.riskId, severity: r.severity, state: r.state, title: r.title, scanner: r.scanner })),
      };
      report.verification = null;
      trackedReports.record(report, progressFor(report, byProject));
      audit.record({
        type: 'verification',
        outcome: 'changed',
        reason: `"${report.name}" moved to round ${report.round}: ${severities.join(', ').toLowerCase()} (${findings.length} findings in scope).`,
        actor: { kind: 'user', user: req.user?.email ?? '' },
        details: { reportId: report.id, round: report.round, severities, buckets, baseline: findings.length },
      });
      res.json(trackedView(report));
    }),
  );

  app.delete('/api/tracked-reports/:id', requirePermission('reports.delete'), (req, res) => {
    if (!trackedReports.delete(req.params.id)) return res.status(404).json({ error: 'No such report.' });
    res.json({ deleted: true });
  });

  return {
    branchChoiceFor, branchChoiceOfScan, currentFindings, goneText, cxErrorText, rescanTokens,
    RESCAN_REPORT_GRANT_MS, audienceSetting, serverTimeZone, allocateNeeded, kindsOf, remediateConfirmed,
  };
}
