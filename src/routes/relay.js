/**
 * The relay for the emailed report. Checkmarx One does not accept API calls from a page opened as a local file,
 * so the report's actions come here and run on this server's own stored connection. Nobody has signed in on
 * these routes: only findings carrying a valid grant from the report are ever acted on, and every spend follows
 * the rules in src/routes/credit-rules.js.
 *
 * - registerRelayPingRoutes: GET /api/relay/ping and /api/relay/report-words/:code, which need no connection.
 * - registerRelayRoutes: GET /api/report-server (the address reports are given), and the report's own calls:
 *   status, hello, credits, triage and its results, remediation, its status and details, and the fix as a patch.
 *
 * The body size limit, the CORS answer and the admission control for /api/relay are middleware, in
 * src/server.js, in front of these.
 */
import { config } from '../config.js';
import { PACKAGE_VERSION } from '../version.js';
import { createRiskSource, normalizeRisk } from '../cxone/risks.js';
import { mapWithConcurrency } from '../cxone/client.js';
import { gitPatch } from '../remediation-patch.js';
import { CREDIT_COST } from '../credits.js';
import { alreadySent, REMEDIABLE_STATE } from '../credit-allocations.js';
import { randomUUID } from 'node:crypto';
import { reportWords } from '../report-i18n.js';
import { scoped } from '../tenancy.js';
import { clientIp, logSafe } from './shared.js';

/**
 * What a report can ask without a connection: is this the server, and the report's wording in another language.
 * @param {import('express').Express} app
 */
export function registerRelayPingRoutes(app) {
  /** Lets a report (or the Settings page) check an address really is this server. Never needs a connection. */
  app.get('/api/relay/ping', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ service: 'mission-zero-relay', ok: true });
  });

  /**
   * The report's wording in another language, for a reader who picks it in a report (it carries only
   * its reader's own). Open languages only: a language behind an activation code travels inside the
   * reports of the people it is on for, and is never served here.
   */
  app.get('/api/relay/report-words/:code', (req, res) => {
    const strings = reportWords(String(req.params.code));
    if (!strings) return res.status(404).json({ error: 'That language is not available.' });
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ language: req.params.code, version: PACKAGE_VERSION, strings });
  });
}

/**
 * The report's calls, and the caches of Checkmarx One's answers they share.
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerRelayRoutes(app, d) {
  const {
    tenancy, settingsStore, creditLedger, recordCreditUse, allocations, relayCache, audit, sendGuard, BUSY_REASON,
    noteBusy, touchProject, tenantQuery, patchTokens, httpsManager, asyncRoute, requireSession, activeConfig,
    requestOrigin, resolveReportServer, reportServerUrl, reportServerWarnings, relayError, grantedFindings,
    relaySession, actionAllowed, triageAllowed, poolPeriod, governRequester, creditsRemaining, tenantLeft,
    adminContact, projectCredits, reportActor, balanceOf, auditCredit, auditRefusedRequest, attributedReport,
    creditNeed, creditRefusal, reportOpens, httpsOrigin,
  } = d;

  app.get('/api/report-server', requireSession, (req, res) => {
    const settings = settingsStore.get();
    const effective = resolveReportServer(req, settings);
    res.json({
      ...effective,
      configured: settings.links.reportServerUrl,
      environment: config.reportServerUrl,
      automatic: resolveReportServer(null, settings),
      warnings: reportServerWarnings(effective.url),
    });
  });

  app.post(
    '/api/relay/status',
    asyncRoute(async (req, res) => {
      const { aiTriage } = settingsStore.get();
      if (!aiTriage?.enabled && !aiTriage?.remediationEnabled) {
        return res.status(403).json({
          error: 'AI Triage and Remediation from reports are switched off. Ask your Checkmarx One reminder administrator to allow them.',
        });
      }
      const session = await relaySession(res);
      if (session) res.json(relayStatus(session, aiTriage));
    }),
  );

  function relayStatus(session, aiTriage) {
    return {
      connected: true,
      tenant: session.connection.tenant,
      triage: Boolean(aiTriage.enabled),
      remediation: Boolean(aiTriage.remediationEnabled),
      retriage: Boolean(aiTriage.allowRetriage),
      reremediation: Boolean(aiTriage.allowReremediation),
      adminContact: adminContact(),
      creditsRemaining: creditsRemaining(),
    };
  }

  /**
   * Everything a report needs when it opens, in one round trip: the status
   * (as /status), its projects' credits (as /credits, from `credits`: one
   * signed finding per project), and where AI Triage and AI Remediation stand
   * (as /triage-results for `findings`, /remediation-status for `remediation`).
   * Each list is optional. Reports from before this call use the separate ones.
   */
  app.post(
    '/api/relay/hello',
    asyncRoute(async (req, res) => {
      const { aiTriage } = settingsStore.get();
      if (!aiTriage?.enabled && !aiTriage?.remediationEnabled) {
        return res.status(403).json({
          error: 'AI Triage and Remediation from reports are switched off. Ask your Checkmarx One reminder administrator to allow them.',
        });
      }
      const session = await relaySession(res);
      if (!session) return;
      const given = (key) => (Array.isArray(req.body?.[key]) && req.body[key].length ? req.body[key] : null);
      const lists = {};
      for (const key of ['credits', 'findings', 'remediation']) {
        if (!given(key)) continue;
        lists[key] = grantedFindings(req, res, { list: given(key) });
        if (!lists[key]) return;
      }
      const answer = relayStatus(session, aiTriage);
      reportOpens.record(req.secure);
      // HTTP and HTTPS side by side: the report tries HTTPS, and keeps to it when it works from the reader's machine.
      if (!req.secure && httpsManager.mode === 'both') answer.httpsUrl = httpsOrigin(req);
      if (lists.credits) answer.projects = projectCredits(lists.credits.map((f) => f.projectId));
      if (lists.remediation) answer.remediationStatus = remediationStatusFor(session, lists.remediation);
      if (lists.findings) answer.triageResults = await triageResultsFor(session, lists.findings);
      res.json(answer);
    }),
  );

  /** Credits available to the projects of a report (one signed finding per project). */
  app.post(
    '/api/relay/credits',
    asyncRoute(async (req, res) => {
      const findings = grantedFindings(req, res);
      if (!findings) return;
      res.json({ projects: projectCredits(findings.map((f) => f.projectId)), creditsRemaining: creditsRemaining() });
    }),
  );

  app.post(
    '/api/relay/triage',
    asyncRoute(async (req, res) => {
      const actor = reportActor(req);
      const findings = grantedFindings(req, res, { type: 'triage', actor });
      if (!findings) return;
      if (!attributedReport(res, 'triage', actor, findings)) return;
      if (!triageAllowed(res)) {
        auditRefusedRequest('triage', actor, findings, 'AI Triage from reports is switched off.');
        return;
      }
      const session = await relaySession(res);
      if (!session) {
        auditRefusedRequest('triage', actor, findings, 'No stored Checkmarx One connection on the reminder server.', 'failed');
        return;
      }

      // One AI Triage request per scan and scanner, however many projects.
      const buckets = new Map();
      for (const finding of findings) {
        const key = `${finding.scanId}|${finding.scanner}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(finding);
      }

      const { monthlyCreditLimit: limit = 0, allowRetriage = false } = settingsStore.get().aiTriage ?? {};
      const results = [];

      // Findings that already have a verdict are only triaged again when the
      // administrator allows it: every run spends credits.
      if (!allowRetriage) {
        const statesByProject = new Map();
        await mapWithConcurrency([...new Set(findings.map((f) => f.projectId))], 3, async (projectId) => {
          try {
            statesByProject.set(projectId, await projectStates(session, projectId));
          } catch (error) {
            console.warn(`[relay] could not read risk states for project ${logSafe(projectId)}: ${logSafe(error.message)}`);
          }
        });
        const sentBefore = new Map([...new Set(findings.map((f) => f.projectId))].map((id) => [id, creditLedger.triagedAt(id)]));
        for (const [key, group] of buckets) {
          const triaged = group.filter((f) => {
            if (alreadySent(f, sentBefore.get(f.projectId))) return true;
            const states = statesByProject.get(f.projectId);
            const state = states?.get(f.riskId) ?? states?.get(f.alternateId) ?? '';
            return state && state !== 'TO_VERIFY';
          });
          if (!triaged.length) continue;
          results.push({
            alternateIds: [...new Set(triaged.map((f) => f.alternateId))],
            ok: false,
            status: 409,
            retriage: true,
            error: `${triaged.length === 1 ? 'This finding is' : `${triaged.length} findings are`} already triaged. Triaging again is switched off by your administrator.`,
          });
          auditCredit({
            type: 'triage', outcome: 'refused', reason: 'Already triaged; re-triage is switched off.', actor,
            findings: triaged, kind: 'triage', requested: new Set(triaged.map((f) => f.alternateId)).size,
          });
          const rest = group.filter((f) => !triaged.includes(f));
          if (rest.length) buckets.set(key, rest);
          else buckets.delete(key);
        }
      }

      // Fail-safe: claim everything about to be sent; anything another request is
      // sending right now is answered, not sent twice.
      const claim = sendGuard.claim('triage', [...buckets.values()].flat());
      if (claim.busy.length) {
        results.push({ alternateIds: [...new Set(claim.busy.map((f) => f.alternateId))], ok: false, status: 409, busy: true, error: BUSY_REASON });
        auditRefusedRequest('triage', actor, claim.busy, BUSY_REASON);
        noteBusy('triage', claim.busy);
      }
      const sentNow = allowRetriage ? new Map() : new Map([...new Set(findings.map((f) => f.projectId))].map((id) => [id, creditLedger.triagedAt(id)]));
      for (const [key, group] of buckets) {
        const rest = group.filter((f) => claim.claimed.includes(f) && !alreadySent(f, sentNow.get(f.projectId)));
        if (rest.length) buckets.set(key, rest);
        else buckets.delete(key);
      }
      try {
        let stopped = '';
        for (const group of buckets.values()) {
          const { scanId, scanner, projectId, projectName } = group[0];
          const alternateIds = [...new Set(group.map((f) => f.alternateId))];
          const before = balanceOf(projectId, 'triage');
          const base = { type: 'triage', actor, findings: group, kind: 'triage', requested: alternateIds.length, before };

          if (stopped) {
            results.push({ alternateIds, ok: false, status: 409, error: stopped });
            auditCredit({ ...base, outcome: 'refused', reason: `Not sent: ${stopped}` });
            continue;
          }
          const refusal = creditRefusal(projectId, projectName, 'triage', alternateIds.length, limit);
          if (refusal) {
            results.push({ alternateIds, ok: false, status: 402, error: refusal, credits: creditNeed(projectId, projectName, 'triage', alternateIds.length) });
            auditCredit({ ...base, outcome: 'refused', reason: refusal });
            continue;
          }
          const reservation = creditLedger.reserve(alternateIds.length, limit, new Date(), {
            period: poolPeriod(),
            projectId,
            kind: 'triage',
            allowance: allocations.balance(projectId).triage.allocated,
            cap: tenantLeft(),
            requester: governRequester(base.actor),
          });
          if (!reservation) {
            // Govern (beta): a used-up budget in Enforce mode says so; otherwise concurrent requests hold the credits.
            results.push({ alternateIds, ok: false, status: 402, error: creditLedger.lastRefusal || 'Credits are busy with another request; try again in a moment.' });
            auditCredit({ ...base, outcome: 'refused', reason: creditLedger.lastRefusal || 'Credits reserved by concurrent requests; nothing sent.' });
            continue;
          }
          const started = Date.now();
          try {
            const body = await session.client.request('/api/ai-triage/triage', {
              method: 'POST',
              body: { scanID: scanId, buckets: [{ scannerType: scanner.toLowerCase(), resultIDs: alternateIds }] },
              retries: 1,
            });
            const published = body?.published !== false;
            const upstream = { call: 'POST /api/ai-triage/triage', status: 200, published, jobId: body?.triageID ?? body?.id ?? '', ms: Date.now() - started };
            // Checkmarx One only starts (and charges for) a new job when published.
            if (published) {
              const riskIds = [...new Set(group.map((f) => f.riskId))];
              const covered = await coveredCount(session, projectId, 'triage', riskIds);
              // Ledger first (so the balance after is right), linked to its audit entry both ways.
              const auditId = randomUUID();
              reservation.release();
              recordCreditUse({
                projectId, projectName, credits: alternateIds.length, scanId, kind: 'triage', riskIds, alternateIds,
                groupIds: [...new Set(group.map((f) => f.groupId).filter(Boolean))], covered: Math.min(covered, alternateIds.length), auditId,
              });
              auditCredit({ ...base, id: auditId, outcome: 'charged', charged: alternateIds.length, upstream, details: { covered: Math.min(covered, alternateIds.length) } });
            } else {
              auditCredit({ ...base, outcome: 'not-charged', reason: 'Checkmarx One already had this triage job; no new credits.', upstream });
            }
            actedOn('triage', group);
            touchProject(projectId);
            results.push({ alternateIds, ok: true, published });
          } catch (error) {
            results.push({ alternateIds, ok: false, status: error.status ?? 0, error: relayError(error) });
            auditCredit({
              ...base, outcome: 'failed', reason: error.message,
              upstream: { call: 'POST /api/ai-triage/triage', status: error.status ?? 0, error: String(error.body || error.message).slice(0, 500), ms: Date.now() - started },
            });
            // No credits or no permission: every further request would fail the same way.
            if (error.status === 402 || error.status === 403) stopped = `Checkmarx One refused an earlier request (${error.status}).`;
          } finally {
            reservation.release();
          }
        }
        res.json({ results, creditsRemaining: creditsRemaining(), projects: projectCredits(findings.map((f) => f.projectId)) });
      } finally {
        claim.release();
      }
    }),
  );

  /**
   * Current Checkmarx One state (To verify, Confirmed, Proposed not
   * exploitable, ...) of every risk in a project, by risk id — the same state
   * Risk Hub shows. AI Triage's own record can lag it (still "To verify" after
   * the risk has settled) or be missing for a finding it changed, so the
   * report shows this. Cached briefly because every report poll asks.
   */
  const STATE_CACHE_MS = 30_000;
  const stateCache = { delete: (projectId) => relayCache.delete(`risks|${projectId}`) };
  // Findings sent for triage or remediation recently: their answers change soon, so look again sooner.
  const recentActions = scoped(tenancy, 'recentActions');
  const ACTION_WATCH_MS = 45 * 60 * 1000;

  async function projectRiskInfo(session, projectId) {
    return relayCache.wrap(`risks|${projectId}`, () => loadRiskInfo(session, projectId), STATE_CACHE_MS);
  }

  async function loadRiskInfo(session, projectId) {
    const cfg = activeConfig();
    const project = { id: projectId, name: '' };
    const source = createRiskSource(session.client, cfg);
    if (source.prime) await source.prime([project]);
    const states = new Map();
    const info = new Map();
    const risks = [];
    for (const raw of await source.fetchForProject(project)) {
      const risk = normalizeRisk(raw, project);
      risks.push(risk);
      info.set(risk.riskId, { severity: risk.severity, state: risk.state });
      if (risk.state) {
        states.set(risk.riskId, risk.state);
        if (risk.alternateId) states.set(risk.alternateId, risk.state);
      }
    }
    return { at: Date.now(), states, info, risks };
  }

  const SETTLED_TTL = 10 * 60_000;
  const WATCHED_TTL = 8_000;
  const QUIET_TTL = 5 * 60_000;

  /** How to load a finding's AI Triage record ({found, body}) and how long to keep it. */
  function triageLookup(session, finding, { background = false } = {}) {
    const key = `triage|${finding.projectId}|${finding.groupId}`;
    const load = async () => {
      try {
        const body = await session.client.request(
          `/api/ai-triage/triage/${encodeURIComponent(finding.projectId)}/${encodeURIComponent(finding.groupId)}`,
          { retries: 1, background },
        );
        return { found: true, body };
      } catch (error) {
        if (error.status === 404) return { found: false };
        throw error;
      }
    };
    // Settled verdicts rarely change; ones being worked on are looked at again soon.
    const ttl = (answer) => {
      const status = answer.body?.triageStatus || answer.body?.jobStatus || '';
      if (answer.found && status && !['IN_PROGRESS', 'TO_VERIFY', 'PENDING', 'QUEUED', 'RUNNING'].includes(status)) return SETTLED_TTL;
      return recentActions.get(key) !== undefined || answer.found ? WATCHED_TTL : QUIET_TTL;
    };
    return { key, load, ttl };
  }

  /** How to load a finding's AI Remediation details (or null) and how long to keep them. */
  function remediationLookup(session, finding, { background = false } = {}) {
    const key = `remed|${finding.scanId}|${finding.alternateId}`;
    const load = async () => {
      try {
        return await session.client.request(
          `/api/remediation/remediation-details/${encodeURIComponent(finding.scanId)}/${encodeURIComponent(finding.alternateId)}`,
          { retries: 1, background },
        );
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    };
    const ttl = (body) => {
      const r = body?.results?.[0];
      if (r && (r.finishedAt || r.data?.summary || String(r.jobStatus || '').toUpperCase() === 'FAILED')) return SETTLED_TTL;
      return recentActions.get(key) !== undefined || r ? WATCHED_TTL : QUIET_TTL;
    };
    return { key, load, ttl };
  }

  /**
   * Background lookups queue behind interactive ones; past this many waiting,
   * new ones are skipped (the report asks again and they are picked up then).
   */
  const BACKGROUND_QUEUE_MAX = Math.max(100, Number(process.env.RELAY_BACKGROUND_QUEUE) || 2000);
  const backgroundRoom = (session) => (session.client.load?.waitingBackground ?? 0) < BACKGROUND_QUEUE_MAX;

  function remediationDetails(session, finding) {
    const { key, load, ttl } = remediationLookup(session, finding);
    return relayCache.wrap(key, load, ttl);
  }

  /** Forget cached answers for findings just acted on, and watch them closely for a while. */
  function actedOn(kind, findings) {
    for (const f of findings) {
      const key = kind === 'triage' ? `triage|${f.projectId}|${f.groupId}` : `remed|${f.scanId}|${f.alternateId}`;
      relayCache.delete(key);
      recentActions.set(key, true, ACTION_WATCH_MS);
      stateCache.delete(f.projectId);
    }
  }

  /** Current Checkmarx One state of every risk in a project, by risk id (and alternate id). */
  async function projectStates(session, projectId) {
    return (await projectRiskInfo(session, projectId)).states;
  }

  /**
   * A finding's state in Checkmarx One now ('' when it cannot be read). A cached
   * answer other than confirmed is read again, so a verdict that just arrived counts.
   */
  async function liveState(session, finding) {
    try {
      const cached = (await projectRiskInfo(session, finding.projectId)).info.get(finding.riskId)?.state ?? '';
      if (cached === REMEDIABLE_STATE) return cached;
      stateCache.delete(finding.projectId);
      return (await projectRiskInfo(session, finding.projectId)).info.get(finding.riskId)?.state ?? '';
    } catch (error) {
      console.warn(`[remediation] could not read the state of ${logSafe(finding.riskId)}: ${logSafe(error.message)}`);
      return '';
    }
  }

  const stateName = (state) => String(state).toLowerCase().replace(/_/g, ' ');

  /** How many of these findings the project's rule covered, read from their live severity and state. */
  async function coveredCount(session, projectId, kind, riskIds) {
    try {
      const { info } = await projectRiskInfo(session, projectId);
      return allocations.covered(projectId, kind, riskIds, info);
    } catch {
      return riskIds.length;
    }
  }

  app.post(
    '/api/relay/triage-results',
    asyncRoute(async (req, res) => {
      const findings = grantedFindings(req, res);
      if (!findings) return;
      const session = await relaySession(res);
      if (!session) return;
      res.json(await triageResultsFor(session, findings));
    }),
  );

  /** Where AI Triage stands for these findings, answered from what is known now (see /api/relay/triage-results). */
  async function triageResultsFor(session, findings) {
    const statesByProject = new Map();
    const stateErrors = new Map();
    const projectIds = [...new Set(findings.map((f) => f.projectId))];
    const sentBefore = new Map(projectIds.map((id) => [id, creditLedger.triagedAt(id)]));
    await mapWithConcurrency(projectIds, 3, async (projectId) => {
      try {
        // States read in the last 30 s, or (while they are read again in the background) the last
        // ones known: a report polling every few seconds never waits on Checkmarx One for them.
        const known = relayCache.peek(`risks|${projectId}`, () => loadRiskInfo(session, projectId), STATE_CACHE_MS);
        statesByProject.set(projectId, known ? known.value.states : await projectStates(session, projectId));
      } catch (error) {
        stateErrors.set(projectId, relayError(error));
        console.warn(`[relay] could not read risk states for project ${logSafe(projectId)}: ${logSafe(error.message)}`);
      }
    });

    // Answer from what is known now; anything not known yet is fetched in the
    // background and marked pending, so the report asks again shortly. No
    // request ever waits on thousands of upstream lookups.
    const results = findings.map((finding) => {
      const states = statesByProject.get(finding.projectId);
      const state = states?.get(finding.riskId) ?? states?.get(finding.alternateId) ?? '';
      const { key, load, ttl } = triageLookup(session, finding, { background: true });
      const known = relayCache.peek(key, backgroundRoom(session) ? load : null, ttl);
      // When this utility sent it for AI Triage, so the report can say so even before Checkmarx One has a verdict.
      const sent = sentBefore.get(finding.projectId);
      const sentAt = sent?.get(finding.riskId) || sent?.get(`a:${finding.alternateId}`) || (finding.groupId && sent?.get(`g:${finding.groupId}`));
      const extra = {
        ...(sentAt ? { triagedAt: sentAt } : {}),
        ...(stateErrors.has(finding.projectId) ? { stateError: stateErrors.get(finding.projectId) } : {}),
      };
      if (!known) return { found: false, state, pending: true, ...extra };
      return { ...known.value, state, ...extra, ...(known.fresh ? {} : { stale: true }) };
    });
    return { results, checkedAt: new Date().toISOString() };
  }

  /**
   * Where AI Remediation stands for a finding in Checkmarx One:
   * 'none', 'running', 'done' or 'failed' (with the details, when there are any).
   * A finding remediated through this utility counts as done even when
   * Checkmarx One no longer returns its details.
   */
  async function remediationState(session, finding) {
    // Asked right before spending credits: look now, at interactive priority,
    // rather than wait on a background refresh that may be queued for it.
    const { key, load, ttl } = remediationLookup(session, finding);
    const body = await load();
    relayCache.set(key, body, ttl(body));
    return remediationStatusOf(finding, body);
  }

  /** 'none', 'running', 'done' or 'failed', from remediation details (or null). */
  function remediationStatusOf(finding, body) {
    const r = body?.results?.[0];
    if (r) {
      const job = String(r.jobStatus || r.status || '').toUpperCase();
      if (job === 'FAILED' || r.data?.error) return { status: 'failed', body };
      if (r.finishedAt || r.data?.summary || r.data?.file_changes?.length) return { status: 'done', body };
      return { status: 'running', body };
    }
    return { status: creditLedger.remediatedIds(finding.projectId).has(finding.riskId) ? 'done' : 'none', body: null };
  }

  /** Which of these findings are already remediated (or being remediated), for the report. */
  app.post(
    '/api/relay/remediation-status',
    asyncRoute(async (req, res) => {
      const findings = grantedFindings(req, res);
      if (!findings) return;
      const session = await relaySession(res);
      if (!session) return;
      res.json(remediationStatusFor(session, findings));
    }),
  );

  /** Which of these findings are already remediated, answered from what is known now. */
  function remediationStatusFor(session, findings) {
    // As with triage results: answer from what is known, fill the rest in the background.
    const results = findings.map((finding) => {
      const { key, load, ttl } = remediationLookup(session, finding, { background: true });
      const known = relayCache.peek(key, backgroundRoom(session) ? load : null, ttl);
      if (!known) {
        return creditLedger.remediatedIds(finding.projectId).has(finding.riskId)
          ? { status: 'done', body: null }
          : { status: 'unknown', pending: true };
      }
      return { ...remediationStatusOf(finding, known.value), ...(known.fresh ? {} : { stale: true }) };
    });
    return { results };
  }

  /**
   * AI Remediation for one finding. Checkmarx One first triages it, then
   * suggests a fix; for repository-integrated projects it opens a pull request.
   */
  app.post(
    '/api/relay/remediate',
    asyncRoute(async (req, res) => {
      const actor = reportActor(req);
      const findings = grantedFindings(req, res, { type: 'remediation', actor });
      if (!findings) return;
      if (!attributedReport(res, 'remediation', actor, findings)) return;
      if (findings.length !== 1) return res.status(400).json({ error: 'Remediate one finding at a time.' });
      if (!actionAllowed(res, 'remediationEnabled')) {
        auditRefusedRequest('remediation', actor, findings, 'AI Remediation from reports is switched off.');
        return;
      }
      const session = await relaySession(res);
      if (!session) {
        auditRefusedRequest('remediation', actor, findings, 'No stored Checkmarx One connection on the reminder server.', 'failed');
        return;
      }

      // Fail-safe: one request at a time per vulnerability.
      const claim = sendGuard.claim('remediation', findings);
      if (claim.busy.length) {
        auditRefusedRequest('remediation', actor, findings, BUSY_REASON);
        noteBusy('remediation', claim.busy);
        return res.status(409).json({ busy: true, error: BUSY_REASON });
      }
      try {
        const [finding] = findings;
        const { monthlyCreditLimit: limit = 0, allowReremediation = false } = settingsStore.get().aiTriage ?? {};
        const cost = CREDIT_COST.remediation;
        const before = balanceOf(finding.projectId, 'remediation');
        const base = { type: 'remediation', actor, findings: [finding], kind: 'remediation', requested: cost, before };

        // The fence: AI Remediation only for a finding triaged and confirmed — never one proposed
        // not exploitable or still to verify. Read live, whatever the report says.
        const state = await liveState(session, finding);
        if (state !== REMEDIABLE_STATE) {
          const reason = state
            ? `AI Remediation runs only on confirmed findings; this one is ${stateName(state)}.`
            : 'Could not confirm this finding is confirmed in Checkmarx One, so AI Remediation was not started.';
          auditCredit({ ...base, outcome: 'refused', reason, details: { state: state || 'unknown' } });
          return res.status(409).json({ error: reason, notConfirmed: true, state: state || null });
        }

        // A finding already remediated is only remediated again when the
        // administrator allows it: every run spends credits and may open another pull request.
        let current = { status: 'none', body: null };
        try {
          current = await remediationState(session, finding);
        } catch (error) {
          console.warn(`[relay] could not read the remediation state of ${logSafe(finding.riskId)}: ${logSafe(error.message)}`);
        }
        if (current.status === 'running') {
          auditCredit({ ...base, outcome: 'refused', reason: 'AI Remediation already running for this finding; followed it instead.' });
          return res.status(409).json({ running: true, body: current.body, error: 'AI Remediation is already running for this finding.' });
        }
        if (current.status === 'done' && !allowReremediation) {
          auditCredit({ ...base, outcome: 'refused', reason: 'Already remediated; re-remediation is switched off.' });
          return res.status(409).json({
            remediated: true,
            body: current.body,
            error: 'This finding is already remediated. Remediating again is switched off by your administrator.',
          });
        }
        const refusal = creditRefusal(finding.projectId, finding.projectName, 'remediation', cost, limit);
        if (refusal) {
          auditCredit({ ...base, outcome: 'refused', reason: refusal });
          return res.status(402).json({
            error: refusal,
            credits: creditNeed(finding.projectId, finding.projectName, 'remediation', cost),
            creditsRemaining: creditsRemaining(),
            projects: projectCredits([finding.projectId]),
          });
        }
        const reservation = creditLedger.reserve(cost, limit, new Date(), {
          period: poolPeriod(),
          projectId: finding.projectId,
          kind: 'remediation',
          allowance: allocations.balance(finding.projectId).remediation.allocated,
          cap: tenantLeft(),
          requester: governRequester(base.actor),
        });
        if (!reservation && creditLedger.lastRefusal) {
          // Govern (beta): a used-up budget in Enforce mode.
          auditCredit({ ...base, outcome: 'refused', reason: creditLedger.lastRefusal });
          return res.status(402).json({ error: creditLedger.lastRefusal });
        }
        if (!reservation) {
          auditCredit({ ...base, outcome: 'refused', reason: 'Credits reserved by concurrent requests; nothing sent.' });
          return res.status(402).json({ error: 'Credits are busy with another request; try again in a moment.' });
        }
        const started = Date.now();
        try {
          const body = await session.client.request('/api/remediation/remediate', {
            method: 'POST',
            body: {
              scanID: finding.scanId,
              buckets: [{ scannerType: finding.scanner.toLowerCase(), resultIDs: [finding.alternateId] }],
            },
            retries: 1,
          });
          const published = body?.published !== false;
          const upstream = { call: 'POST /api/remediation/remediate', status: 200, published, jobId: body?.remediationJobId ?? '', ms: Date.now() - started };
          if (published) {
            const covered = (await coveredCount(session, finding.projectId, 'remediation', [finding.riskId])) ? cost : 0;
            const auditId = randomUUID();
            reservation.release();
            recordCreditUse({
              projectId: finding.projectId,
              projectName: finding.projectName,
              credits: cost,
              scanId: finding.scanId,
              kind: 'remediation',
              riskIds: [finding.riskId],
              covered,
              auditId,
            });
            auditCredit({ ...base, id: auditId, outcome: 'charged', charged: cost, upstream, details: { covered, existingState: body?.existingState ?? null } });
          } else {
            auditCredit({ ...base, outcome: 'not-charged', reason: 'Checkmarx One already had this remediation job; no new credits.', upstream });
          }
          actedOn('remediation', [finding]);
          touchProject(finding.projectId);
          reservation.release();
          res.json({
            ok: true,
            published,
            existingState: body?.existingState ?? null,
            creditsRemaining: creditsRemaining(),
            projects: projectCredits([finding.projectId]),
          });
        } catch (error) {
          auditCredit({
            ...base, outcome: 'failed', reason: error.message,
            upstream: { call: 'POST /api/remediation/remediate', status: error.status ?? 0, error: String(error.body || error.message).slice(0, 500), ms: Date.now() - started },
          });
          res.status(error.status && error.status >= 400 ? error.status : 502).json({
            error: error.status === 402
              ? 'Checkmarx One has no credits left for AI Remediation.'
              : error.status === 403
                ? "The reminder server's Checkmarx One account is not allowed to run AI Remediation."
                : `AI Remediation could not start: ${relayError(error)}`,
          });
        } finally {
          reservation.release();
        }
      } finally {
        claim.release();
      }
    }),
  );

  app.post(
    '/api/relay/remediation-details',
    asyncRoute(async (req, res) => {
      const findings = grantedFindings(req, res);
      if (!findings) return;
      if (findings.length !== 1) return res.status(400).json({ error: 'Ask about one finding at a time.' });
      const session = await relaySession(res);
      if (!session) return;
      const [finding] = findings;
      try {
        const body = await remediationDetails(session, finding);
        res.json(body ? { found: true, body } : { found: false });
      } catch (error) {
        console.warn(`[relay] could not read the AI Remediation result of ${logSafe(finding.riskId)}: ${logSafe(error.message)}`);
        res.status(502).json({ error: `Could not read the AI Remediation result: ${relayError(error)}` });
      }
    }),
  );

  /**
   * "Apply with git": a signed link to one finding's AI Remediation fix as a
   * patch, for `curl … -o mz-fix.patch && git apply mz-fix.patch` in the
   * reader's checkout. The report's grant is the permission, as for every
   * relay action; the link only ever reads that one finding's fix.
   */
  app.post(
    '/api/relay/patch-link',
    asyncRoute(async (req, res) => {
      const findings = grantedFindings(req, res);
      if (!findings) return;
      if (findings.length !== 1) return res.status(400).json({ error: 'Ask about one finding at a time.' });
      const [finding] = findings;
      if (!finding.scanId || !finding.alternateId) return res.status(400).json({ error: 'This finding has no AI Remediation result.' });
      const base = reportServerUrl(req, settingsStore.get()).replace(/\/+$/, '') || requestOrigin(req);
      res.json({ url: `${base}/api/relay/patch/${patchTokens.issue(finding)}${tenantQuery('?')}` });
    }),
  );

  app.get(
    '/api/relay/patch/:token',
    asyncRoute(async (req, res) => {
      res.set('Cache-Control', 'no-store');
      res.set('X-Content-Type-Options', 'nosniff');
      const target = patchTokens.verify(req.params.token);
      if (!target) return res.status(404).type('text').send('This fix link is incomplete or was changed. Copy the command from the report again.\n');
      if (target.expired) return res.status(410).type('text').send('This fix link has expired (they last 7 days). Copy the command from the report again.\n');
      const session = await relaySession(res);
      if (!session) return;
      let body;
      try {
        body = await remediationDetails(session, target);
      } catch (error) {
        console.warn(`[relay] could not read an AI Remediation result for a patch: ${logSafe(error.message)}`);
        return res.status(502).type('text').send(`Could not read the fix: ${relayError(error)}\n`);
      }
      const patch = gitPatch(body);
      if (!patch) return res.status(404).type('text').send('Checkmarx One has no code changes for this finding yet.\n');
      audit.record({
        type: 'report',
        outcome: 'info',
        reason: 'AI Remediation fix downloaded as a patch for git apply.',
        actor: { kind: 'report', ip: clientIp(req), userAgent: String(req.get('user-agent') ?? '').slice(0, 200) },
        details: { scanId: target.scanId, alternateId: target.alternateId },
      });
      res.set('Content-Disposition', 'attachment; filename="mz-fix.patch"');
      res.type('text/x-diff').send(patch);
    }),
  );

  return { stateCache, projectRiskInfo, triageLookup, actedOn, projectStates };
}
