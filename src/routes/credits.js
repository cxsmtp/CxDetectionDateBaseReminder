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
import { describeEngines, engineScope, inEngines } from '../engines.js';
import { collectInitiators } from '../cxone/initiators.js';
import { monthOf } from '../credits.js';
import { triageRows } from '../credit-allocations.js';
import { resolveRange, usageSeries } from '../credit-usage.js';
import { knownAddresses } from '../known-addresses.js';
import { idList } from './shared.js';

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
