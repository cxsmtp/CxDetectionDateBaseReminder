/**
 * Credits on the dashboard: what the Workbench and the Credits pages do with AI Triage and AI Remediation credits
 * (src/credits.js, src/credit-allocations.js). The rules every spend follows, and the audit entry of each
 * decision, are in src/routes/credit-rules.js.
 *
 * Registered in three steps, because tracked reports' and other areas' routes were always registered in between
 * and the order is kept (test/fixtures/routes.txt):
 * - registerCreditRunRoutes: verifying what findings need, allocating, and the triage and remediation runs;
 * - registerCreditRoutes: the Credits page (the pool, taking credits back, giving them, a run across projects);
 * - registerCreditUsageRoute: GET /api/credits/usage, the usage chart.
 */
import { config } from '../config.js';
import { listProjects } from '../cxone/projects.js';
import { onBranch } from '../cxone/branches.js';
import { collectProjectRisks, readGate } from '../cxone/risks.js';
import { engineScope, inEngines, describeEngines } from '../engines.js';
import { collectInitiators } from '../cxone/initiators.js';
import { AI_SCANNERS, resolveAiIds, warmScanResults } from '../cxone/ai-assist.js';
import { mapWithConcurrency } from '../cxone/client.js';
import { matchesVulnerability, vulnerabilityQuery } from '../vuln-search.js';
import { CREDIT_COST, monthOf } from '../credits.js';
import { REMEDIABLE_STATE, alreadySent, billingUnit, remediable, remediationCandidates, triageRows } from '../credit-allocations.js';
import { resolveRange, usageSeries } from '../credit-usage.js';
import { knownAddresses } from '../known-addresses.js';
import { randomUUID } from 'node:crypto';
import { sendReminderMail } from '../mailer.js';
import { escapeHtmlText, idList, logSafe } from './shared.js';

/**
 * From the Workbench: telling the people a run was made for, verifying what each project's findings need (read
 * twice), allocating, and the AI Triage and AI Remediation runs an administrator starts.
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerCreditRunRoutes(app, d) {
  const {
    settingsStore, creditLedger, recordCreditUse, allocations, SEVERITIES, audit, sendGuard, diagnostics,
    BUSY_REASON, noteBusy, touchProject, creditView, asyncRoute, requirePermission, activeConfig, afterFetch,
    projectRow, readerIdentity, poolPeriod, governRequester, tenantLeft, tenantShortfall, poolName, adminActor,
    balanceOf, auditCredit, allocationSnapshot, auditAllocation, auditRefusedRequest, creditRefusal, stateCache,
    projectRiskInfo, actedOn, projectStates, branchChoiceOfScan, tenantRefusal, creditPool,
  } = d;

  // ---------------------------------------------------------------------------
  // Credit allocation and triage by the administrator (dashboard)
  // ---------------------------------------------------------------------------

  function scanProjects(req, projectIds) {
    const projects = req.session.lastScan?.projects ?? [];
    const wanted = Array.isArray(projectIds) && projectIds.length ? new Set(projectIds.map(String)) : null;
    return projects.filter((p) => !p.error && (!wanted || wanted.has(p.projectId)));
  }

  const cleanSeverities = (list) =>
    [...new Set((Array.isArray(list) ? list : []).map((s) => String(s).toUpperCase()))].filter((s) => SEVERITIES.includes(s));

  // ---------------------------------------------------------------------------
  // Acting on a developer's behalf: tell them, about their own projects only
  // ---------------------------------------------------------------------------

  const KIND_TITLES = { triage: 'AI Triage', remediation: 'AI Remediation' };

  /**
   * After the administrator ran AI Triage or Remediation from the Workbench or a
   * tracked report, each scan initiator gets one email about their own projects:
   * what was started on their behalf, and what to do next (fetch the changes in
   * their report, review and approve the pull requests).
   */
  async function notifyOnBehalf(session, kind, started, initiatorsByProject, actor) {
    const out = { emailed: 0, recipients: [], noAddress: [], failed: 0 };
    if (!started.length) return out;
    const settings = settingsStore.get();
    const byProject = new Map();
    for (const f of started) {
      const p = byProject.get(f.projectId) ?? { name: f.projectName || f.projectId, results: new Set(), severities: new Set() };
      p.results.add(f.alternateId || f.groupId || f.riskId);
      p.severities.add(String(f.severity || '').toLowerCase());
      byProject.set(f.projectId, p);
    }
    const byPerson = new Map();
    for (const [projectId, p] of byProject) {
      const email = initiatorsByProject?.[projectId]?.email || '';
      if (!email) {
        out.noAddress.push(p.name);
        continue;
      }
      if (!byPerson.has(email)) byPerson.set(email, []);
      byPerson.get(email).push(p);
    }
    const title = KIND_TITLES[kind];
    const by = actor?.user ? `${actor.user}` : 'Your security team';
    const next = kind === 'remediation'
      ? ['Open your CxMissionZero report for these projects and click Refresh to fetch the suggested fixes.', 'Review and approve the pull requests AI Remediation opens in your repository (or apply the fix shown in Checkmarx One).']
      : ['Open your CxMissionZero report for these projects and click Refresh to see the verdicts.', 'Confirmed findings can then be remediated from the report; proposed not exploitable ones drop out of it.'];
    for (const [email, projects] of byPerson) {
      const total = projects.reduce((n, p) => n + p.results.size, 0);
      const lines = projects.map((p) => `${p.name}: ${p.results.size} finding${p.results.size === 1 ? '' : 's'} (${[...p.severities].filter(Boolean).join(', ')})`);
      const subject = `${title} was started on your behalf: ${total} finding${total === 1 ? '' : 's'}`;
      const text = `Hello,\n\n${by} started Checkmarx One ${title} on your behalf, using the credits allocated to these projects you last scanned:\n\n${lines.map((l) => `  - ${l}`).join('\n')}\n\nWhat to do now:\n${next.map((l) => `  - ${l}`).join('\n')}\n\nNothing more is needed to start it, and no credits of yours were spent beyond these.\n`;
      const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827;max-width:640px">
      <h2 style="margin:0 0 12px;font-size:18px">${escapeHtmlText(title)} was started on your behalf</h2>
      <p>${escapeHtmlText(by)} started Checkmarx One ${escapeHtmlText(title)} on your behalf, using the credits allocated to these projects you last scanned:</p>
      <ul>${lines.map((l) => `<li>${escapeHtmlText(l)}</li>`).join('')}</ul>
      <p><strong>What to do now</strong></p>
      <ul>${next.map((l) => `<li>${escapeHtmlText(l)}</li>`).join('')}</ul>
      <p style="color:#6b7280;font-size:12px">Nothing more is needed to start it, and no credits of yours were spent beyond these.</p>
    </div>`;
      try {
        await sendReminderMail(settings, { subject, text, html }, { exact: true, to: [email] });
        out.emailed += 1;
        out.recipients.push(email);
      } catch (error) {
        out.failed += 1;
        console.warn(`[on behalf] could not email a scan initiator: ${logSafe(error.message)}`);
      }
    }
    audit.record({
      type: kind, outcome: 'changed', actor,
      reason: `Told ${out.emailed} scan initiator(s) that ${title} was started on their behalf${out.noAddress.length ? `; no address for ${out.noAddress.length} project(s)` : ''}${out.failed ? `; ${out.failed} email(s) failed` : ''}.`,
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Verified credit needs: confirmed with Checkmarx One twice before any demand
  // ---------------------------------------------------------------------------

  /** A verification is good for this long; allocating "what is needed" asks for a fresh one after that. */
  const VERIFY_TTL_MS = 10 * 60 * 1000;
  /** Projects verified at once (each with its two reads side by side); the connection's limit still caps the calls. */
  const VERIFY_AT_ONCE = Math.max(1, Number(process.env.CX_VERIFY_CONCURRENCY) || 8);
  /** Calls to Checkmarx One one verify keeps waiting or running at once (3 projects × 4 pages ahead, as before MZ-01.00.65). */
  const VERIFY_SLOTS = 12;

  /**
   * One complete, independent read from Checkmarx One of what a project needs:
   * its findings and their live states (risks API), then the scan results that
   * AI Triage and AI Remediation would be sent (results API). Returns the exact
   * billed result ids, not an estimate.
   */
  async function readProjectNeed(session, project, { detectionWindow = null, scanIdOf = () => '', severities = null, keep = null, gate = null, branchChoice = null } = {}) {
    const started = Date.now();
    // Only the branch that counts for the project (branchChoice), as the findings it replaces were read.
    const scan = branchChoice?.scans?.[project.projectId];
    const read = await collectProjectRisks(session.client, activeConfig(), [{ id: project.projectId, name: project.projectName }], {
      detectionWindow,
      keep,
      gate,
      scans: branchChoice ? { [project.projectId]: scan } : null,
      refine: branchChoice ? (p, risks) => onBranch(session.client, branchChoice, p.id, risks, { identity: readerIdentity(session), gate }) : null,
    });
    const summary = read.projects[0];
    if (summary.error) throw Object.assign(new Error(`${project.projectName}: ${summary.error}`), { status: 502 });
    const rule = severities?.length ? severities : allocations.severitiesOf(project.projectId);
    const ai = summary.risks.filter((r) => rule.includes(r.severity) && AI_SCANNERS.has(r.scanner));
    const readAt = Date.now();
    await resolveAiIds(session.client, ai, () => scanIdOf(project.projectId));
    const timing = { readMs: readAt - started, lookupMs: Date.now() - readAt };
    const triage = triageRows(summary.risks, rule, Date.now(), creditLedger.triagedAt(project.projectId));
    const remediate = remediationCandidates(summary.risks, rule, creditLedger.remediatedIds(project.projectId));
    const units = (rows) => [...new Set(rows.map(billingUnit))].sort();
    return {
      summary,
      rule,
      triage: { rows: triage.length, results: units(triage) },
      remediation: { rows: remediate.length, results: units(remediate) },
      // Findings the AI cannot act on (no result id in the latest scan): never billed, shown apart.
      unresolved: ai.filter((r) => r.aiUnavailable).length,
      timing,
    };
  }

  /**
   * The scans whose result ids a credit check of this project will look up: those its fetched
   * findings name, and its latest scan. Reading them is the slow part of a check on a large scan.
   */
  function warmProject(session, project, severities = null) {
    // Only what the check will look up: AI-eligible findings of the severities counted, not yet matched.
    const rule = severities?.length ? severities : allocations.severitiesOf(project.projectId);
    const latest = session.lastScan?.initiators?.[project.projectId]?.scanId ?? '';
    const ids = new Set();
    for (const r of project.risks ?? []) {
      if (!AI_SCANNERS.has(r.scanner) || r.alternateId || !rule.includes(r.severity)) continue;
      const id = r.scanId || latest;
      if (id) ids.add(id);
    }
    for (const id of [...ids].slice(0, 5)) warmScanResults(session.client, id);
  }

  /**
   * Verify what projects need: two independent reads from Checkmarx One that must
   * agree, result id for result id. On agreement the project's findings and
   * credit needs are replaced by what Checkmarx One said; on disagreement (the
   * data is changing, e.g. someone is triaging) nothing is trusted.
   */
  /**
   * Two independent reads of one project, side by side (each its own requests to Checkmarx One);
   * `agreed` only when every billed result id matches.
   */
  async function doubleRead(session, project, options) {
    const [first, second] = await Promise.all([readProjectNeed(session, project, options), readProjectNeed(session, project, options)]);
    const same = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);
    const agreed =
      same(first.triage.results, second.triage.results) &&
      same(first.remediation.results, second.remediation.results) &&
      first.rule.join() === second.rule.join();
    return { first, second, agreed };
  }

  const DISAGREED = 'Checkmarx One gave different results on the two reads — the findings are changing (someone may be triaging). Refresh again in a moment.';

  async function verifyNeeds(session, projects, { severities = null } = {}) {
    const scan = session.lastScan;
    // The same findings the Workbench shows: its date window, its engines and its vulnerability search
    // (the verified read replaces the loaded findings, so it must keep to the same ones).
    const vulnerability = vulnerabilityQuery(scan?.vulnerability);
    const engines = scan?.engines ?? null;
    const keep = vulnerability || engines ? (risk) => inEngines(risk, engines) && (!vulnerability || matchesVulnerability(vulnerability, risk)) : null;
    // Its projects and their two reads side by side, never queuing more calls than one verify did before (VERIFY_SLOTS).
    const options = { detectionWindow: scan?.detectionWindow ?? null, scanIdOf: (id) => scan?.initiators?.[id]?.scanId ?? '', severities, keep, gate: readGate(session.client, VERIFY_SLOTS), branchChoice: branchChoiceOfScan(scan) };
    const out = await mapWithConcurrency(projects, VERIFY_AT_ONCE, async (p) => {
      try {
        const { first, second, agreed } = await doubleRead(session, p, options);
        const verified = {
          at: Date.now(),
          agreed,
          severities: second.rule,
          triage: { rows: second.triage.rows, results: second.triage.results.length },
          remediation: { rows: second.remediation.rows, results: second.remediation.results.length, credits: CREDIT_COST.remediation * second.remediation.results.length },
          reads: [first.triage.results.length, second.triage.results.length],
          unresolved: second.unresolved,
          timing: { readMs: Math.max(first.timing.readMs, second.timing.readMs), lookupMs: Math.max(first.timing.lookupMs, second.timing.lookupMs) },
        };
        if (agreed) {
          // The second read is what Checkmarx One holds now: it replaces the fetched rows.
          const { risks, counts, bySeverity, totalRisks, oldestFirstDetectedAt, maxAgeDays } = second.summary;
          Object.assign(p, { risks, counts, bySeverity, totalRisks, oldestFirstDetectedAt, maxAgeDays });
          p.credits = creditView(p);
          // The count the allocation will use must be the verified one, to the credit.
          const need = allocations.need(p.projectId, p.risks);
          const sameRule = second.rule.join() === allocations.severitiesOf(p.projectId).join();
          if (sameRule && (need.toTriage !== verified.triage.results || need.toRemediate !== verified.remediation.results)) {
            verified.agreed = false;
            verified.reason = 'The credit count did not match the verified Checkmarx One results.';
            diagnostics.discrepancy('credit-count-mismatch', { project: p.projectId, results: verified.triage.results, credits: need.toTriage });
          }
        } else {
          verified.reason = DISAGREED;
          diagnostics.discrepancy('credit-verify-disagreed', { project: p.projectId, reads: [first.triage.results.length, second.triage.results.length] });
        }
        p.verified = verified;
        return { projectId: p.projectId, ...verified };
      } catch (error) {
        p.verified = { at: Date.now(), agreed: false, reason: `Could not read Checkmarx One: ${error.message}` };
        diagnostics.error('verify-read-failed', error, { project: p.projectId });
        return { projectId: p.projectId, ...p.verified };
      }
    });
    return out;
  }

  const freshlyVerified = (p) =>
    p.verified?.agreed && Date.now() - p.verified.at < VERIFY_TTL_MS && p.verified.severities.join() === allocations.severitiesOf(p.projectId).join();

  /**
   * Refresh & verify: re-read the chosen projects from Checkmarx One twice. Their
   * rows and credit needs are replaced by what Checkmarx One holds now, and only
   * a verified need can be allocated.
   */
  app.post(
    '/api/credits/verify',
    requirePermission('credits.view'),
    afterFetch,
    asyncRoute(async (req, res) => {
      if (!req.session.lastScan) return res.status(409).json({ error: 'Load findings on the Workbench first.' });
      const projects = scanProjects(req, req.body?.projectIds);
      for (const p of projects) stateCache.delete(p.projectId);
      const severities = cleanSeverities(req.body?.severities);
      const started = Date.now();
      const results = await verifyNeeds(req.session, projects, { severities: severities.length ? SEVERITIES.filter((s) => severities.includes(s)) : null });
      const ms = Date.now() - started;
      const slowest = (key) => results.reduce((n, r) => Math.max(n, r.timing?.[key] ?? 0), 0);
      // How long each part took, so a slow check says where the time went (no names or ids).
      diagnostics.usage('credit-verify', { projects: projects.length, ms, readMs: slowest('readMs'), lookupMs: slowest('lookupMs') });
      res.json({
        ms,
        timing: { readMs: slowest('readMs'), lookupMs: slowest('lookupMs') },
        verified: results,
        projects: Object.fromEntries(projects.map((p) => [p.projectId, { ...projectRow(p), credits: p.credits, verified: p.verified }])),
      });
    }),
  );

  /**
   * Projects someone picked on the Workbench, before they allocate or run anything: their scans'
   * result ids are read now, in the background, so the check that follows does not wait for them.
   * Reads nothing else, changes nothing, answers at once.
   */
  app.post('/api/credits/prepare', requirePermission('credits.view'), (req, res) => {
    if (!req.session.lastScan) return res.status(204).end();
    const ids = Array.isArray(req.body?.projectIds) ? req.body.projectIds.slice(0, 25).map(String) : [];
    if (ids.length) for (const p of scanProjects(req, ids)) warmProject(req.session, p);
    res.status(202).end();
  });

  /**
   * Allocate credits to projects — only ever because someone asked here:
   *   allocate: ['triage', 'remediation']  give each project what its findings need and it does not have
   *                                        (remediation: 3 per confirmed finding, once triage has confirmed them)
   *   triageAdd / remediationAdd           extra credits on top, for every project
   *   setExtra {triage, remediation}       one project's extra credits, exactly
   *   clearExtras                          take extra credits back
   *   ruleChanges                          which severities the projects' needs cover (allocates nothing)
   * Everything given comes out of the credit pool, and never more than it has free.
   */
  app.post('/api/credits/allocate', requirePermission('credits.allocate'), afterFetch, asyncRoute(async (req, res) => {
    if (!req.session.lastScan) return res.status(409).json({ error: 'Load findings on the Workbench first.' });
    const { projectIds, ruleChanges, triageAdd = 0, remediationAdd = 0, clearExtras = false, setExtra = null } = req.body ?? {};
    // Take back what projects were given and did not use (people did not act on it).
    const reclaim = (Array.isArray(req.body?.reclaimUnused) ? req.body.reclaimUnused : []).filter((k) => k === 'triage' || k === 'remediation');
    if (reclaim.length) {
      const projects = scanProjects(req, projectIds);
      const actor = await adminActor(req);
      let total = 0;
      for (const p of projects) {
        const before = allocationSnapshot(p.projectId);
        const back = allocations.reclaimUnused(p.projectId, reclaim);
        const n = back.triage + back.remediation;
        if (!n) continue;
        total += n;
        auditAllocation({ actor, projectId: p.projectId, projectName: p.projectName, before, change: { reclaimed: back }, reason: `Took back ${n} unused credit${n === 1 ? '' : 's'} (${[back.triage && `${back.triage} triage`, back.remediation && `${back.remediation} remediation`].filter(Boolean).join(', ')}) to the credit pool.` });
      }
      allocations.save();
      for (const p of projects) p.credits = creditView(p);
      return res.json({ reclaimed: total, projects: Object.fromEntries(projects.map((p) => [p.projectId, p.credits])), pool: creditPool() });
    }
    const changes = (Array.isArray(ruleChanges) ? ruleChanges : [])
      .map((c) => ({ severity: String(c?.severity ?? '').toUpperCase(), include: c?.include === true }))
      .filter((c) => SEVERITIES.includes(c.severity));
    const needed = (Array.isArray(req.body?.allocate) ? req.body.allocate : []).filter((k) => k === 'triage' || k === 'remediation');
    const extraTriage = Math.max(0, Math.floor(Number(triageAdd) || 0));
    const extraRemediation = Math.max(0, Math.floor(Number(remediationAdd) || 0));
    // Exact extras for one project at a time (the per-project editor).
    const exact = setExtra && typeof setExtra === 'object' ? setExtra : null;
    if (!changes.length && !needed.length && !extraTriage && !extraRemediation && clearExtras !== true && !exact) {
      return res.status(400).json({ error: 'Choose what to allocate, severities, or credits to add.' });
    }
    if (exact && (!Array.isArray(projectIds) || projectIds.length !== 1)) {
      return res.status(400).json({ error: 'Set exact extra credits for one project at a time.' });
    }

    const projects = scanProjects(req, projectIds);
    const actor = await adminActor(req);
    const before = new Map(projects.map((p) => [p.projectId, allocationSnapshot(p.projectId)]));

    // Severities first: they decide what "needed" means below.
    if (changes.length) {
      for (const p of projects) {
        const next = new Set(allocations.severitiesOf(p.projectId));
        for (const { severity, include } of changes) include ? next.add(severity) : next.delete(severity);
        allocations.setSeverities(p.projectId, p.projectName, SEVERITIES.filter((s) => next.has(s)));
      }
    }

    // "What is needed" is only ever a need Checkmarx One confirmed twice, just now:
    // read again here (after any severity change), and refused if the reads disagree.
    if (needed.length) {
      await verifyNeeds(req.session, projects.filter((p) => !freshlyVerified(p)));
      const unverified = projects.filter((p) => !freshlyVerified(p));
      if (unverified.length) {
        if (changes.length) allocations.save();
        const reason = `Not allocated: what ${unverified.length === 1 ? unverified[0].projectName : `${unverified.length} projects`} need${unverified.length === 1 ? 's' : ''} could not be confirmed twice with Checkmarx One. ${unverified[0].verified?.reason ?? ''}`.trim();
        audit.record({ type: 'allocation', outcome: 'refused', reason, actor, credits: { kind: 'allocation', requested: 0, charged: 0 }, details: { projectIds: unverified.map((p) => p.projectId) } });
        return res.status(409).json({ error: reason, unverified: unverified.map((p) => ({ projectId: p.projectId, projectName: p.projectName, reason: p.verified?.reason ?? '' })) });
      }
    }

    // What would be given, before giving anything: it must fit in the pool.
    const plan = projects.map((p) => {
      const { shortfall } = allocations.need(p.projectId, p.risks ?? []);
      const extras = allocations.balance(p.projectId);
      const exactDelta = (kind) => (exact && kind in exact ? Math.max(0, Math.floor(Number(exact[kind]) || 0)) - extras[kind === 'triage' ? 'extraTriage' : 'extraRemediation'] : 0);
      return {
        p,
        triage: (needed.includes('triage') ? shortfall.triage : 0) + extraTriage,
        remediation: (needed.includes('remediation') ? shortfall.remediation : 0) + extraRemediation,
        exact: { triage: exactDelta('triage'), remediation: exactDelta('remediation') },
      };
    });
    const given = plan.reduce((n, x) => n + x.triage + x.remediation + Math.max(0, x.exact.triage) + Math.max(0, x.exact.remediation), 0);
    const pool = creditPool();
    if (pool.limited && given > pool.unallocated) {
      const reason = `Only ${pool.unallocated} credit${pool.unallocated === 1 ? '' : 's'} left in the credit pool to give (pool ${pool.size}${pool.period === 'month' ? ' this month' : ''}, ${pool.used.total} used, ${pool.outstanding.total} given to projects and not used yet); ${given} asked for.`;
      if (changes.length) allocations.save();
      audit.record({ type: 'allocation', outcome: 'refused', reason, actor, credits: { kind: 'allocation', requested: given, charged: 0 }, details: { projectIds: projects.map((p) => p.projectId), pool } });
      return res.status(409).json({ error: `${reason} Raise the pool under Settings → AI & credit pool.`, pool });
    }
    const beyond = await tenantRefusal(req, given, pool);
    if (beyond) {
      if (changes.length) allocations.save();
      audit.record({ type: 'allocation', outcome: 'refused', reason: beyond, actor, credits: { kind: 'allocation', requested: given, charged: 0 }, details: { projectIds: projects.map((p) => p.projectId), pool } });
      return res.status(409).json({ error: beyond, pool });
    }

    for (const { p, triage, remediation, exact: delta } of plan) {
      if (clearExtras === true) allocations.clearExtras(p.projectId);
      const neededTriage = triage - extraTriage;
      const neededRemediation = remediation - extraRemediation;
      if (neededTriage) allocations.grant(p.projectId, p.projectName, 'triage', neededTriage);
      if (neededRemediation) allocations.grant(p.projectId, p.projectName, 'remediation', neededRemediation);
      if (extraTriage) allocations.add(p.projectId, p.projectName, 'triage', extraTriage);
      if (extraRemediation) allocations.add(p.projectId, p.projectName, 'remediation', extraRemediation);
      for (const kind of ['triage', 'remediation']) if (delta[kind]) allocations.add(p.projectId, p.projectName, kind, delta[kind]);
    }
    allocations.save();
    const change = {
      ...(changes.length ? { ruleChanges: changes } : {}),
      ...(needed.length ? { allocateNeeded: needed } : {}),
      ...(extraTriage ? { addTriage: extraTriage } : {}),
      ...(extraRemediation ? { addRemediation: extraRemediation } : {}),
      ...(clearExtras === true ? { clearExtras: true } : {}),
      ...(exact ? { setExtra: exact } : {}),
    };
    for (const p of projects) {
      auditAllocation({ actor, projectId: p.projectId, projectName: p.projectName, before: before.get(p.projectId), change, reason: needed.length ? `Allocated what the findings need (${needed.join(' and ')}) on the Workbench.` : 'Changed on the Workbench.' });
      p.credits = creditView(p);
    }
    res.json({ given, projects: Object.fromEntries(projects.map((p) => [p.projectId, p.credits])), pool: creditPool() });
  }));

  /**
   * Run AI Triage for `findings` on the administrator's behalf: one request per
   * scan and scanner. Credits count against each project's allocation, which
   * is raised to cover the request, since the administrator is the one allocating.
   */
  async function adminTriage(session, findings, initiatorsByProject = {}, { actor = { kind: 'admin' }, origin = '' } = {}) {
    await resolveAiIds(session.client, findings, (f) => initiatorsByProject[f.projectId]?.scanId ?? '');
    let eligible = findings.filter((f) => !f.aiUnavailable);
    const ineligible = findings.filter((f) => f.aiUnavailable);
    if (ineligible.length) auditRefusedRequest('triage', actor, ineligible, `Not eligible for AI Triage (${ineligible[0].aiUnavailable})`);
    // Already sent for AI Triage through this utility (a "vulnerable" verdict stays To verify):
    // not again, and not charged again, unless re-triage is allowed.
    let alreadyTriaged = 0;
    if (!settingsStore.get().aiTriage?.allowRetriage) {
      const sent = new Map();
      const before = (f) => alreadySent(f, (sent.has(f.projectId) ? sent : sent.set(f.projectId, creditLedger.triagedAt(f.projectId))).get(f.projectId));
      const again = eligible.filter(before);
      if (again.length) {
        alreadyTriaged = again.length;
        auditRefusedRequest('triage', actor, again, 'Already triaged through this utility; re-triage is switched off.');
        eligible = eligible.filter((f) => !before(f));
      }
    }

    // Fail-safe: claim before sending; then look again at what was sent, since a
    // request that just finished has recorded it.
    const claim = sendGuard.claim('triage', eligible);
    if (claim.busy.length) auditRefusedRequest('triage', actor, claim.busy, BUSY_REASON);
    noteBusy('triage', claim.busy);
    eligible = claim.claimed;
    if (!settingsStore.get().aiTriage?.allowRetriage) {
      const sentNow = eligible.filter((f) => alreadySent(f, creditLedger.triagedAt(f.projectId)));
      if (sentNow.length) {
        alreadyTriaged += sentNow.length;
        eligible = eligible.filter((f) => !sentNow.includes(f));
      }
    }
    try {
      const buckets = new Map();
      for (const f of eligible) {
        const key = `${f.scanId}|${f.scanner}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(f);
      }

      const limit = settingsStore.get().aiTriage?.monthlyCreditLimit ?? 0;
      let failed = 0;
      const errors = [];
      const startedFindings = [];
      let stopped = '';
      for (const group of buckets.values()) {
        const { scanId, scanner, projectId, projectName } = group[0];
        const alternateIds = [...new Set(group.map((f) => f.alternateId))];
        const base = { type: 'triage', actor, findings: group, kind: 'triage', requested: alternateIds.length, before: balanceOf(projectId, 'triage'), details: { origin } };
        if (stopped) {
          failed += group.length;
          auditCredit({ ...base, outcome: 'refused', reason: `Not sent: ${stopped}` });
          continue;
        }
        const reservation = creditLedger.reserve(alternateIds.length, limit, new Date(), { period: poolPeriod(), cap: tenantLeft(), forProject: projectId, requester: governRequester(actor) });
        if (!reservation) {
          const why = creditLedger.lastRefusal || tenantShortfall(alternateIds.length) || `${poolName(limit)} is used up (credit limit reached).`;
          failed += group.length;
          errors.push(`${projectName}: ${why}`);
          auditCredit({ ...base, outcome: 'refused', reason: why });
          continue;
        }
        const started = Date.now();
        try {
          const body = await session.client.request('/api/ai-triage/triage', {
            method: 'POST',
            body: { scanID: scanId, buckets: [{ scannerType: scanner.toLowerCase(), resultIDs: alternateIds }] },
            retries: 1,
          });
          const upstream = { call: 'POST /api/ai-triage/triage', status: 200, published: body?.published !== false, jobId: body?.triageID ?? body?.id ?? '', ms: Date.now() - started };
          if (body?.published !== false) {
            // The person who confirmed this run allocated what it needed beyond what the project had: recorded as theirs.
            const balance = allocations.balance(projectId).triage;
            const raised = Math.max(0, alternateIds.length - balance.remaining);
            if (raised) {
              const snapshot = allocationSnapshot(projectId);
              allocations.grant(projectId, projectName, 'triage', raised);
              auditAllocation({ actor, projectId, projectName, before: snapshot, change: { allocatedForRun: raised }, reason: `Allocated ${raised} triage credit${raised === 1 ? '' : 's'} for the AI Triage run ${actor?.user || 'the administrator'} confirmed.` });
            }
            // The administrator's own triage never uses up the developers' extras.
            const auditId = randomUUID();
            reservation.release();
            recordCreditUse({
              projectId, projectName, credits: alternateIds.length, scanId, kind: 'triage', covered: alternateIds.length,
              riskIds: [...new Set(group.map((f) => f.riskId))], alternateIds, groupIds: [...new Set(group.map((f) => f.groupId).filter(Boolean))], auditId,
            });
            auditCredit({ ...base, id: auditId, outcome: 'charged', charged: alternateIds.length, upstream, details: { origin, allocationRaisedBy: raised || undefined } });
          } else {
            auditCredit({ ...base, outcome: 'not-charged', reason: 'Checkmarx One already had this triage job; no new credits.', upstream });
          }
          actedOn('triage', group);
          touchProject(projectId);
          startedFindings.push(...group);
        } catch (error) {
          failed += group.length;
          errors.push(`${projectName}: ${error.message}`);
          auditCredit({
            ...base, outcome: 'failed', reason: error.message,
            upstream: { call: 'POST /api/ai-triage/triage', status: error.status ?? 0, error: String(error.body || error.message).slice(0, 500), ms: Date.now() - started },
          });
          if (error.status === 402 || error.status === 403) stopped = `Checkmarx One refused an earlier request (${error.status}).`;
        } finally {
          reservation.release();
        }
      }
      allocations.save();
      return {
        requested: findings.length,
        started: startedFindings.length,
        failed,
        skipped: findings.length - eligible.length,
        alreadyTriaged,
        errors,
        startedFindings,
      };
    } finally {
      claim.release();
    }
  }

  /**
   * Re-read the live state of the fetched projects' findings (verdicts arrive
   * minutes after a triage run), so what each project needs — confirmed
   * findings to remediate — follows without another full fetch.
   */
  app.post(
    '/api/credits/refresh',
    requirePermission('credits.view'),
    asyncRoute(async (req, res) => {
      if (!req.session.lastScan) return res.status(409).json({ error: 'Load findings on the Workbench first.' });
      const projects = scanProjects(req, req.body?.projectIds);
      await mapWithConcurrency(projects, 3, async (p) => {
        stateCache.delete(p.projectId);
        let live;
        try {
          live = await projectRiskInfo(req.session, p.projectId);
        } catch (error) {
          console.warn(`[credits] could not re-read ${logSafe(p.projectName)}: ${logSafe(error.message)}`);
          return;
        }
        for (const r of p.risks ?? []) {
          const now = live.info.get(r.riskId);
          if (now?.state && now.state !== r.state) r.state = now.state;
        }
      });
      // New verdicts change what is needed (e.g. confirmed findings to remediate), never what is allocated.
      for (const p of projects) p.credits = creditView(p);
      res.json({ projects: Object.fromEntries(projects.map((p) => [p.projectId, p.credits])) });
    }),
  );

  /**
   * The administrator triages chosen severities of chosen projects straight
   * away (e.g. before reports go out). Uses the dashboard's own connection;
   * credits count against each project's allocation, which is raised to cover
   * the request since the administrator is the one allocating.
   */
  app.post(
    '/api/triage/run',
    requirePermission('triage.run'),
    afterFetch,
    asyncRoute(async (req, res) => {
      if (!req.session.lastScan) return res.status(409).json({ error: 'Load findings on the Workbench first.' });
      const wanted = cleanSeverities(req.body?.severities);
      if (!wanted.length) return res.status(400).json({ error: 'Pick at least one severity to triage.' });

      const projects = scanProjects(req, req.body?.projectIds);
      const RECENT_MS = 30 * 60 * 1000;
      const originals = new Map();
      const findings = [];
      // Live states, read side by side, and only for projects with a finding of these severities left to triage.
      const candidate = (r) => wanted.includes(r.severity) && (!r.state || r.state === 'TO_VERIFY');
      const lives = await mapWithConcurrency(projects, VERIFY_AT_ONCE, async (p) => ((p.risks ?? []).some(candidate) ? projectStates(req.session, p.projectId).catch(() => null) : null));
      for (const [i, p] of projects.entries()) {
        const live = lives[i];
        for (const r of p.risks ?? []) {
          const state = live?.get(r.riskId) ?? r.state;
          if (!wanted.includes(r.severity) || (state && state !== 'TO_VERIFY')) continue;
          if (r.triageRequestedAt && Date.now() - r.triageRequestedAt < RECENT_MS) continue;
          const copy = { ...r, projectId: p.projectId, projectName: p.projectName };
          originals.set(copy, r);
          findings.push(copy);
        }
      }
      if (!findings.length) return res.json({ requested: 0, started: 0, failed: 0, skipped: 0, errors: [], projects: {} });

      const outcome = await adminTriage(req.session, findings, req.session.lastScan.initiators ?? {}, {
        actor: await adminActor(req),
        origin: `Workbench: triage ${wanted.map((s) => s.toLowerCase()).join(', ')} now`,
      });
      for (const f of outcome.startedFindings) originals.get(f).triageRequestedAt = Date.now();
      for (const p of projects) p.credits = creditView(p);
      const { startedFindings, ...summary } = outcome;
      const notified = req.body?.notifyInitiators === false ? null : await notifyOnBehalf(req.session, 'triage', startedFindings, req.session.lastScan.initiators ?? {}, await adminActor(req));
      res.json({ ...summary, notified, projects: Object.fromEntries(projects.map((p) => [p.projectId, p.credits])) });
    }),
  );

  /**
   * Run AI Remediation for confirmed findings on the administrator's behalf:
   * one request per scan and scanner, 3 credits per finding, out of each
   * project's remediation allocation (and the credit pool). Only findings
   * confirmed in Checkmarx One right now are sent — the fence also applies here.
   * The results reach developers as they do when they click Remediate in a
   * report: a pull request where the project is set up for it, otherwise the
   * remediation details in the report.
   */
  async function adminRemediate(session, findings, initiatorsByProject = {}, { actor = { kind: 'admin' }, origin = '' } = {}) {
    const cost = CREDIT_COST.remediation;
    await resolveAiIds(session.client, findings, (f) => initiatorsByProject[f.projectId]?.scanId ?? '');
    let eligible = findings.filter((f) => !f.aiUnavailable);
    const ineligible = findings.filter((f) => f.aiUnavailable);
    if (ineligible.length) auditRefusedRequest('remediation', actor, ineligible, `Not eligible for AI Remediation (${ineligible[0].aiUnavailable})`);

    // Fail-safe: claim before sending; then drop what has been remediated meanwhile.
    const claim = sendGuard.claim('remediation', eligible);
    if (claim.busy.length) auditRefusedRequest('remediation', actor, claim.busy, BUSY_REASON);
    noteBusy('remediation', claim.busy);
    eligible = claim.claimed;
    if (!settingsStore.get().aiTriage?.allowReremediation) {
      eligible = eligible.filter((f) => !creditLedger.remediatedIds(f.projectId).has(f.riskId));
    }
    try {
      const buckets = new Map();
      for (const f of eligible) {
        const key = `${f.projectId}|${f.scanId}|${f.scanner}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(f);
      }
      const limit = settingsStore.get().aiTriage?.monthlyCreditLimit ?? 0;
      let failed = 0;
      let notAllocated = 0;
      const errors = [];
      const startedFindings = [];
      for (const group of buckets.values()) {
        const { scanId, scanner, projectId, projectName } = group[0];
        const alternateIds = [...new Set(group.map((f) => f.alternateId))];
        const credits = cost * alternateIds.length;
        const base = { type: 'remediation', actor, findings: group, kind: 'remediation', requested: credits, before: balanceOf(projectId, 'remediation'), details: { origin } };
        // Allocated first, on purpose: remediation spends only what was given to the project.
        const refusal = creditRefusal(projectId, projectName, 'remediation', credits, limit);
        if (refusal) {
          failed += group.length;
          if (/credits? left/.test(refusal) && !/pool/.test(refusal)) notAllocated += credits - allocations.balance(projectId).remediation.remaining;
          errors.push(refusal);
          auditCredit({ ...base, outcome: 'refused', reason: refusal });
          continue;
        }
        const reservation = creditLedger.reserve(credits, limit, new Date(), { period: poolPeriod(), projectId, kind: 'remediation', allowance: allocations.balance(projectId).remediation.allocated, cap: tenantLeft(), requester: governRequester(actor) });
        if (!reservation) {
          failed += group.length;
          errors.push(`${projectName}: ${creditLedger.lastRefusal || 'credits are busy with another request; try again in a moment.'}`);
          auditCredit({ ...base, outcome: 'refused', reason: creditLedger.lastRefusal || 'Credits reserved by concurrent requests; nothing sent.' });
          continue;
        }
        const started = Date.now();
        try {
          const body = await session.client.request('/api/remediation/remediate', {
            method: 'POST',
            body: { scanID: scanId, buckets: [{ scannerType: scanner.toLowerCase(), resultIDs: alternateIds }] },
            retries: 1,
          });
          const published = body?.published !== false;
          const upstream = { call: 'POST /api/remediation/remediate', status: 200, published, jobId: body?.remediationJobId ?? '', ms: Date.now() - started };
          if (published) {
            const auditId = randomUUID();
            reservation.release();
            recordCreditUse({ projectId, projectName, credits, scanId, kind: 'remediation', riskIds: [...new Set(group.map((f) => f.riskId))], covered: credits, auditId });
            auditCredit({ ...base, id: auditId, outcome: 'charged', charged: credits, upstream });
          } else {
            auditCredit({ ...base, outcome: 'not-charged', reason: 'Checkmarx One already had this remediation job; no new credits.', upstream });
          }
          actedOn('remediation', group);
          touchProject(projectId);
          startedFindings.push(...group);
        } catch (error) {
          failed += group.length;
          errors.push(`${projectName}: ${error.status === 402 ? 'Checkmarx One has no credits left for AI Remediation' : error.message}`);
          auditCredit({
            ...base, outcome: 'failed', reason: error.message,
            upstream: { call: 'POST /api/remediation/remediate', status: error.status ?? 0, error: String(error.body || error.message).slice(0, 500), ms: Date.now() - started },
          });
        } finally {
          reservation.release();
        }
      }
      return { requested: findings.length, started: startedFindings.length, failed, busy: claim.busy.length, skipped: ineligible.length, notAllocated, errors: [...new Set(errors)], startedFindings };
    } finally {
      claim.release();
    }
  }

  /**
   * The Workbench's "Remediate selected": AI Remediation for the confirmed
   * findings (and only those) of the chosen severities in the chosen projects,
   * read live. Spends 3 credits each, from remediation credits already
   * allocated — "Allocate for remediation" first.
   */
  app.post(
    '/api/remediation/run',
    requirePermission('triage.run'),
    afterFetch,
    asyncRoute(async (req, res) => {
      if (!req.session.lastScan) return res.status(409).json({ error: 'Load findings on the Workbench first.' });
      const wanted = cleanSeverities(req.body?.severities);
      if (!wanted.length) return res.status(400).json({ error: 'Pick at least one severity to remediate.' });
      const { allowReremediation = false } = settingsStore.get().aiTriage ?? {};
      const projects = scanProjects(req, req.body?.projectIds);
      const findings = [];
      let notConfirmed = 0;
      for (const p of projects) {
        stateCache.delete(p.projectId);
        let live = null;
        try {
          live = await projectStates(req.session, p.projectId);
        } catch {}
        const remediated = allowReremediation ? new Set() : creditLedger.remediatedIds(p.projectId);
        for (const r of p.risks ?? []) {
          const state = live?.get(r.riskId) ?? r.state;
          if (state && state !== r.state) r.state = state;
          if (!wanted.includes(r.severity)) continue;
          if (!remediable({ ...r, state })) {
            if (state && state !== REMEDIABLE_STATE) notConfirmed += 1;
            continue;
          }
          if (remediated.has(r.riskId)) continue;
          findings.push({ ...r, projectId: p.projectId, projectName: p.projectName });
        }
      }
      // One finding per result: duplicates of one result are remediated (and charged) once.
      const unique = remediationCandidates(findings, wanted);
      if (!unique.length) {
        for (const p of projects) p.credits = creditView(p);
        return res.json({ requested: 0, started: 0, failed: 0, skipped: 0, notConfirmed, errors: [], projects: Object.fromEntries(projects.map((p) => [p.projectId, p.credits])) });
      }
      const outcome = await adminRemediate(req.session, unique, req.session.lastScan.initiators ?? {}, {
        actor: await adminActor(req),
        origin: `Workbench: remediate confirmed ${wanted.map((s) => s.toLowerCase()).join(', ')}`,
      });
      for (const p of projects) p.credits = creditView(p);
      const { startedFindings, ...summary } = outcome;
      const notified = req.body?.notifyInitiators === false ? null : await notifyOnBehalf(req.session, 'remediation', startedFindings, req.session.lastScan.initiators ?? {}, await adminActor(req));
      res.json({ ...summary, notConfirmed, notified, projects: Object.fromEntries(projects.map((p) => [p.projectId, p.credits])) });
    }),
  );

  return {
    scanProjects, cleanSeverities, notifyOnBehalf, VERIFY_AT_ONCE, doubleRead, DISAGREED, adminTriage,
    adminRemediate,
  };
}

/**
 * The Credits page: the pool and every project's credits, taking unused ones back, giving them to projects, a run
 * across projects, and who looked.
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerCreditRoutes(app, d) {
  const {
    sessions, tstate, settingsStore, creditLedger, allocations, audit, creditView, asyncRoute, requirePermission,
    afterFetch, creditsRemaining, adminActor, allocationSnapshot, auditAllocation, cleanSeverities, notifyOnBehalf,
    adminTriage, creditFor, currentFindings, goneText, remediateConfirmed, tenantCreditsOf, tenantRefusal,
    creditPool,
  } = d;

  // Administrator view of AI Triage credits used from reports.
  app.get('/api/credits', requirePermission('credits.view'), asyncRoute(async (req, res) => {
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month ?? '')) ? String(req.query.month) : monthOf();
    // What the tenant has left in Checkmarx One: the pool and what projects are given stay within it. Shown as last
    // read, never waited for here, unless asked to read it again (?fresh=1).
    const tenant = await tenantCreditsOf(req, req.query.fresh ? { fresh: true } : { wait: false });
    const { aiTriage } = settingsStore.get();
    const list = allocations.list();
    res.json({
      ...creditLedger.summary(month),
      months: [...new Set([monthOf(), ...creditLedger.months()])],
      enabled: Boolean(aiTriage?.enabled),
      remediationEnabled: Boolean(aiTriage?.remediationEnabled),
      monthlyCreditLimit: aiTriage?.monthlyCreditLimit ?? 0,
      remaining: month === monthOf() ? creditsRemaining() : null,
      pool: creditPool(undefined, list),
      allocations: list,
      relayConnected: Boolean(sessions.get(tstate.automationSessionId) ?? sessions.get(tstate.bootstrapSessionId) ?? settingsStore.get().automationApiKey),
      tenant,
      // Whether Fusion scans charge credits on this tenant, when the Fusion page has read it.
      fusionCharged: req.session.lastFusion?.tenant?.fusionCredits ?? '',
    });
  }));

  /**
   * Take credits back, from the Credit Control page: what the projects were given
   * and have not used (nor have in flight) goes back to the credit pool. Works on
   * every project with an allocation, without loading findings first: `all: true`
   * is the clean slate, `projectIds` a few projects. Used credits stay counted.
   */
  app.post('/api/credits/reclaim', requirePermission('credits.allocate'), asyncRoute(async (req, res) => {
    const known = allocations.list();
    const wanted = req.body?.all === true ? null : new Set((Array.isArray(req.body?.projectIds) ? req.body.projectIds : []).map(String));
    if (wanted && !wanted.size) return res.status(400).json({ error: 'Choose the projects, or take back from all of them.' });
    const projects = known.filter((p) => !wanted || wanted.has(p.projectId));
    const actor = await adminActor(req);
    const total = { triage: 0, remediation: 0, projects: 0 };
    for (const p of projects) {
      const before = allocationSnapshot(p.projectId);
      const back = allocations.reclaimUnused(p.projectId);
      const n = back.triage + back.remediation;
      if (!n) continue;
      total.triage += back.triage;
      total.remediation += back.remediation;
      total.projects += 1;
      auditAllocation({ actor, projectId: p.projectId, projectName: p.projectName, before, change: { reclaimed: back }, reason: `Took back ${n} unused credit${n === 1 ? '' : 's'} (${[back.triage && `${back.triage} triage`, back.remediation && `${back.remediation} remediation`].filter(Boolean).join(', ')}) to the credit pool${wanted ? '' : ' (clean slate: every project)'}.` });
    }
    allocations.save();
    // Projects loaded on this person's Workbench show the new balances.
    for (const p of req.session.lastScan?.projects ?? []) if (allocations.get(p.projectId)) p.credits = creditView(p);
    res.json({ reclaimed: total.triage + total.remediation, ...total, pool: creditPool(), allocations: allocations.list() });
  }));

  /**
   * The projects credits can be given to from the Credit Control page: every
   * Checkmarx One project, with those that already hold an allocation. Kept for
   * five minutes per session; no findings are read.
   */
  async function givableProjects(req, { refresh = false } = {}) {
    const cached = req.session.givableProjects;
    if (cached && !refresh && Date.now() - cached.at < 5 * 60_000) return cached;
    const byId = new Map(allocations.list().map((p) => [p.projectId, { projectId: p.projectId, projectName: p.projectName || p.projectId, allocated: true }]));
    let warning = null;
    if (req.session.client) {
      try {
        for (const p of await listProjects(req.session.client)) {
          const known = byId.get(p.id);
          byId.set(p.id, { projectId: p.id, projectName: p.name || known?.projectName || p.id, allocated: Boolean(known) });
        }
      } catch (error) {
        warning = `The Checkmarx One project list could not be read (${error.message}): only projects that already hold credits are listed.`;
      }
    } else {
      warning = 'Not connected to Checkmarx One: only projects that already hold credits are listed.';
    }
    const result = { at: Date.now(), projects: [...byId.values()].sort((a, b) => a.projectName.localeCompare(b.projectName)), warning };
    if (!warning) req.session.givableProjects = result;
    return result;
  }

  app.get('/api/credits/projects', requirePermission('credits.allocate'), asyncRoute(async (req, res) => {
    const { projects, warning } = await givableProjects(req, { refresh: req.query.refresh === '1' });
    res.json({ projects, warning });
  }));

  const GIVE_MAX = 100_000;

  /**
   * Give credits from the Credit Control page: extra AI Triage and AI Remediation
   * credits for one project, out of the credit pool, without loading findings
   * first (giving exactly what the findings need stays on the Workbench, which
   * confirms it with Checkmarx One). Recorded in the audit log like any allocation.
   */
  app.post('/api/credits/give', requirePermission('credits.allocate'), asyncRoute(async (req, res) => {
    const projectId = String(req.body?.projectId ?? '').trim().slice(0, 200);
    if (!projectId) return res.status(400).json({ error: 'Choose a project.' });
    const amount = (kind) => {
      const value = Number(req.body?.[kind] ?? 0);
      return Number.isInteger(value) && value >= 0 && value <= GIVE_MAX ? value : NaN;
    };
    const triage = amount('triage');
    const remediation = amount('remediation');
    if (Number.isNaN(triage) || Number.isNaN(remediation)) return res.status(400).json({ error: `Credits must be whole numbers, not negative, and no more than ${GIVE_MAX} at a time.` });
    if (!triage && !remediation) return res.status(400).json({ error: 'Give at least one AI Triage or AI Remediation credit.' });

    // The project must be one Checkmarx One knows, or one that already holds credits.
    const loaded = req.session.lastScan?.projects?.find((p) => p.projectId === projectId && !p.error);
    let projectName = allocations.get(projectId)?.projectName || loaded?.projectName || '';
    if (!projectName && !allocations.get(projectId)) {
      const { projects } = await givableProjects(req);
      projectName = projects.find((p) => p.projectId === projectId)?.projectName ?? '';
      if (!projectName) return res.status(404).json({ error: 'No such project in Checkmarx One.' });
    }

    const actor = await adminActor(req);
    const pool = creditPool();
    const given = triage + remediation;
    if (pool.limited && given > pool.unallocated) {
      const reason = `Only ${pool.unallocated} credit${pool.unallocated === 1 ? '' : 's'} left in the credit pool to give (pool ${pool.size}${pool.period === 'month' ? ' this month' : ''}, ${pool.used.total} used, ${pool.outstanding.total} given to projects and not used yet); ${given} asked for.`;
      audit.record({ type: 'allocation', outcome: 'refused', reason, actor, project: { id: projectId, name: projectName }, credits: { kind: 'allocation', requested: given, charged: 0 }, details: { pool, from: 'credit-control' } });
      return res.status(409).json({ error: `${reason} Raise the pool under Settings → AI & credit pool.`, pool });
    }
    const beyond = await tenantRefusal(req, given, pool);
    if (beyond) {
      audit.record({ type: 'allocation', outcome: 'refused', reason: beyond, actor, project: { id: projectId, name: projectName }, credits: { kind: 'allocation', requested: given, charged: 0 }, details: { pool, from: 'credit-control' } });
      return res.status(409).json({ error: beyond, pool });
    }

    const before = allocationSnapshot(projectId);
    if (triage) allocations.add(projectId, projectName, 'triage', triage);
    if (remediation) allocations.add(projectId, projectName, 'remediation', remediation);
    allocations.save();
    const parts = [triage && `${triage} AI Triage`, remediation && `${remediation} AI Remediation`].filter(Boolean).join(' and ');
    auditAllocation({ actor, projectId, projectName, before, change: { addTriage: triage, addRemediation: remediation }, reason: `Gave ${parts} credit${given === 1 ? '' : 's'} on the Credit Control page.` });
    if (loaded) loaded.credits = creditView(loaded);
    if (req.session.givableProjects) {
      const listed = req.session.givableProjects.projects.find((p) => p.projectId === projectId);
      if (listed) listed.allocated = true;
    }
    res.json({ given, triage, remediation, projectId, projectName, credits: loaded?.credits ?? null, pool: creditPool(), allocations: allocations.list() });
  }));

  /**
   * Spend the credits from the Credit Control page: AI Triage (or AI Remediation
   * of confirmed findings) for the chosen severities of projects that hold
   * credits, read fresh from Checkmarx One. No Workbench fetch needed.
   */
  app.post('/api/credits/run', requirePermission('triage.run'), afterFetch, asyncRoute(async (req, res) => {
    const kind = req.body?.kind === 'remediation' ? 'remediation' : req.body?.kind === 'triage' ? 'triage' : '';
    if (!kind) return res.status(400).json({ error: 'Choose triage or remediation.' });
    const wanted = cleanSeverities(req.body?.severities);
    if (!wanted.length) return res.status(400).json({ error: `Pick at least one severity to ${kind === 'triage' ? 'triage' : 'remediate'}.` });
    if (!req.session.client) return res.status(409).json({ error: 'Connect to Checkmarx One first.' });
    const chosen = new Set(idList(req.body?.projectIds));
    const listed = allocations.list().filter((p) => !chosen.size || chosen.has(p.projectId)).map((p) => ({ projectId: p.projectId, projectName: p.projectName || p.projectId }));
    if (!listed.length) return res.status(400).json({ error: 'Give credits to a project first.' });

    const settings = settingsStore.get();
    const byProject = await currentFindings(req.session, listed, { branches: req.body?.branches, skipGone: true });
    const { gone } = byProject;
    const projects = listed.filter((p) => !gone.some((g) => g.projectId === p.projectId));
    if (!projects.length) return res.status(409).json({ error: goneText(gone), gone });
    // Only the engines chosen (SAST and SCA unless more are ticked).
    const engines = engineScope(req.body?.engines);
    for (const [id, risks] of byProject) byProject.set(id, risks.filter((r) => inEngines(r, engines)));
    const initiators = await collectInitiators(
      req.session.client,
      req.session.connection,
      projects.map((p) => ({ id: p.projectId, name: p.projectName })),
      { rules: settings.initiators, useDirectory: settings.initiators.useDirectory, concurrency: config.concurrency, memory: knownAddresses, attributed: creditFor },
    );
    const scan = { projects: projects.map((p) => ({ ...p, risks: byProject.get(p.projectId) ?? [] })), initiators: initiators.byProject };
    const where = `Credit Control: ${kind === 'triage' ? 'triage' : 'remediate confirmed'} ${wanted.map((s) => s.toLowerCase()).join(', ')} (${describeEngines(engines)})`;
    let summary;
    if (kind === 'remediation') {
      summary = await remediateConfirmed(req, scan, wanted, where);
    } else {
      const findings = scan.projects.flatMap((p) => triageRows(p.risks, wanted).map((r) => ({ ...r, projectId: p.projectId, projectName: p.projectName })));
      if (!findings.length) {
        summary = { requested: 0, started: 0, failed: 0, skipped: 0, errors: [] };
      } else {
        const actor = await adminActor(req);
        const { startedFindings, ...outcome } = await adminTriage(req.session, findings, scan.initiators, { actor, origin: where });
        const notified = req.body?.notifyInitiators === false ? null : await notifyOnBehalf(req.session, 'triage', startedFindings, scan.initiators, actor);
        summary = { ...outcome, notified };
      }
    }
    // Projects loaded on this person's Workbench show the new balances.
    for (const p of req.session.lastScan?.projects ?? []) if (allocations.get(p.projectId)) p.credits = creditView(p);
    res.json({ ...summary, pool: creditPool(), allocations: allocations.list(), gone, goneNote: gone.length ? `Skipped: ${goneText(gone)}` : '' });
  }));

  /**
   * The credits of the projects loaded on this person's Workbench, worked out
   * again: after credits are given or taken back on another page.
   */
  app.get('/api/credits/views', requirePermission('credits.view'), (req, res) => {
    const projects = (req.session.lastScan?.projects ?? []).filter((p) => !p.error);
    for (const p of projects) p.credits = creditView(p);
    res.json({ projects: Object.fromEntries(projects.map((p) => [p.projectId, p.credits])) });
  });
}

/**
 * GET /api/credits/usage.
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerCreditUsageRoute(app, d) {
  const { creditLedger, allocations, requirePermission, creditPool } = d;

  /** Credits used over a period, for the Credits page: by day / week / month, by kind and by project. */
  app.get('/api/credits/usage', requirePermission('credits.view'), (req, res) => {
    const range = resolveRange({ from: req.query.from, to: req.query.to, bucket: req.query.bucket });
    const projectId = String(req.query.projectId ?? '').slice(0, 200);
    const end = new Date(Date.parse(`${range.to}T00:00:00.000Z`) + 24 * 60 * 60 * 1000).toISOString();
    const usage = usageSeries(creditLedger.entriesBetween(`${range.from}T00:00:00.000Z`, end), { ...range, projectId });
    const list = allocations.list();
    res.json({
      ...usage,
      days: range.days,
      projectId,
      pool: creditPool(undefined, list),
      allocations: projectId ? list.filter((p) => p.projectId === projectId) : list,
      projects: list.map((p) => ({ projectId: p.projectId, projectName: p.projectName })),
    });
  });
}
