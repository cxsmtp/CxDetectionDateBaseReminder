/**
 * Credits → Fusion credits (src/fusion-credits.js): the page's view, reading the tenant's Fusion projects (each on its
 * branch), the rates (Admins only), the plan (from the Cx Credits Calculator, or changed here), allocating and taking
 * back, scheduling the planned Fusion scans, and the check that pauses Fusion for a project whose credits are spent,
 * puts it back once credits are added, and asks for more when its lines of code have grown past what it was given.
 *
 *   GET  /api/fusion-credits                 the page (credits.view)
 *   POST /api/fusion-credits/read            read the tenant's Fusion projects again, in the background (credits.allocate)
 *   PUT  /api/fusion-credits/rates           every model's rate, and warn only or warn and pause (an Admin)
 *   PUT  /api/fusion-credits/plan            the period and the Fusion scans for each change frequency (credits.allocate)
 *   GET  /api/fusion-credits/plans           the plans saved in the Cx Credits Calculator here (credits.allocate)
 *   POST /api/fusion-credits/plan/import     { calculatorId } or { file } a calculator plan becomes the plan (credits.allocate)
 *   GET  /api/fusion-credits/branches        ?project= its branches, the usual protected ones first (credits.view)
 *   PUT  /api/fusion-credits/branch          { projectId, branch } read (and scan) it on that branch; '' its primary (credits.allocate)
 *   POST /api/fusion-credits/allocate        { projects: [{ id, credits, mode: 'set' | 'add' }] } (credits.allocate)
 *   POST /api/fusion-credits/take-back       { projectIds } what each has not used goes back (credits.allocate)
 *   POST /api/fusion-credits/schedule        { projectIds } schedule each one's planned Fusion scans (credits.allocate)
 *   POST /api/fusion-credits/schedule/stop   { projectIds } (credits.allocate)
 */
import { sendReminderMail } from '../mailer.js';
import { systemEmail } from '../hands-off.js';
import { FREQUENCIES, unitsOf } from '../../public/calculator/model.js';
import {
  MONTH_MS, cleanCredits, fusionScanRequest, modelKey, orderBranches, pauseFusion, perScan, planFromCalculator, projectBranches,
  protectedPattern, readFusionProjects, recommend, resumeFusion, standingOf, usedSince,
} from '../fusion-credits.js';
import { SYSTEM_ACTOR, logSafe } from './shared.js';

const CHECK_EVERY_MS = 30 * 60_000;
const MAX_PLAN_FILE = 8 * 1024 * 1024;
const round2 = (n) => Math.round(n * 100) / 100;
const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en', { maximumFractionDigits: 2 }));
const text = (v, max = 200) => String(v ?? '').trim().slice(0, max);

export function registerFusionCreditRoutes(app, d) {
  const {
    tenancy, fusionCredits, projections, audit, iam, asyncRoute, requirePermission, can, resolveAutomationSession, creditPool,
    adminActor, sendingSettings, settingsStore,
  } = d;

  const isAdmin = (req) => req.user?.role === 'admin';
  /**
   * A project given Fusion credits (even 0, or all its unused ones taken back): 'unknown' when what it used is not
   * known, 'spent' when nothing is left, 'low' when less than one more scan is, else 'ok'.
   */
  const standingFor = (allocated, used, next) => (used === null ? 'unknown' : standingOf({ allocated: Math.max(allocated, Number.EPSILON), used: allocated - used <= 0 ? Infinity : used, next }));
  /** The running tenant's read: { state, step, done, total, startedAt, finishedAt, error } (one at a time). */
  const jobOf = () => (tenancy.current().state.fusionCreditsRead ??= { state: 'none' });
  const rowsById = () => new Map((fusionCredits.read?.projects ?? []).map((r) => [r.id, r]));
  /** One scan of a project as planned: its lines today × the rate of the plan's model (else its own). */
  const scanCost = (row, a, rates) => perScan({ loc: row?.loc, model: a?.plan?.model || row?.model }, rates);

  /** Credits given for Fusion and not used yet, over every project (what Fusion holds of the tenant's credits). */
  function fusionHeld() {
    const rows = rowsById();
    const rates = fusionCredits.rates;
    let held = 0;
    for (const a of fusionCredits.list()) {
      const used = usedSince(rows.get(a.id), a.allocatedAt, rates).credits;
      held += Math.max(0, (Number(a.allocated) || 0) - (used ?? 0));
    }
    return round2(held);
  }

  /**
   * What a project still needs for the rest of its plan, at its lines of code today: its planned scans not run yet ×
   * one scan's cost, less what it has left. Null when its plan, lines or rate are not known.
   */
  function shortfall(a, row, used, rates) {
    if (!a?.plan || used === null || !row) return null;
    const cost = scanCost(row, a, rates);
    if (cost === null) return null;
    const done = usedSince(row, a.allocatedAt, rates).scans;
    const remaining = Math.max(0, (Number(a.plan.scans) || 0) - done);
    const need = remaining * cost;
    const left = (Number(a.allocated) || 0) - used;
    return { remaining, need: round2(need), left: round2(left), extra: round2(Math.max(0, need - left)), units: unitsOf(row.loc), unitsPlanned: a.plan.units ?? null };
  }

  /** Every project's figures, as the page shows them. */
  function projectRows() {
    const read = fusionCredits.read;
    const rates = fusionCredits.rates;
    const rows = read?.projects ?? [];
    const plan = fusionCredits.plan;
    const recs = recommend(rows, rates, plan);
    const chosen = fusionCredits.branches;
    const seen = new Set();
    const out = rows.map((r) => {
      seen.add(r.id);
      const a = fusionCredits.get(r.id);
      const rec = recs.get(r.id) ?? { units: 0, scans: 0, rate: null, credits: null, model: null, included: true };
      const used = a ? usedSince(r, a.allocatedAt, rates) : { scans: 0, credits: null };
      const allocated = a ? Number(a.allocated) || 0 : 0;
      const next = a ? scanCost(r, a, rates) : perScan(r, rates);
      const usedCredits = a ? used.credits : null;
      const sched = a?.schedule ?? null;
      return {
        id: r.id,
        name: r.name,
        branch: r.branch,
        branchHow: r.branchHow,
        branchChosen: Boolean(chosen[r.id]),
        branchProtected: protectedPattern(r.branch),
        scanType: r.scanType,
        model: r.model,
        modelFrom: r.modelFrom,
        plannedModel: rec.model,
        loc: r.loc,
        units: rec.units,
        frequency: r.frequency,
        scansYear: r.scansYear,
        planned: rec.scans,
        plannedFrom: rec.scansFrom,
        inPlan: rec.included !== false,
        rate: rec.rate,
        recommended: rec.credits,
        allocated: a ? allocated : null,
        allocatedAt: a?.allocatedAt ?? null,
        plan: a?.plan ?? null,
        usedScans: a ? used.scans : null,
        used: usedCredits,
        left: a && usedCredits !== null ? round2(allocated - usedCredits) : null,
        next,
        standing: a ? standingFor(allocated, usedCredits, next) : 'none',
        paused: a?.paused ? { at: a.paused.at } : null,
        shortfall: a ? shortfall(a, r, usedCredits, rates) : null,
        locAlert: a?.locAlert ?? null,
        schedule: sched ? { every: sched.every, next: sched.next, left: sched.left, started: (sched.started ?? []).slice(-10), blocked: sched.blocked ?? '', stopped: Boolean(sched.stopped) } : null,
        canSchedule: Boolean(r.latestScanId),
        recent: (r.fusionScans ?? []).slice(0, 20),
      };
    });
    // Given credits but not in the last read (removed from Checkmarx One, or no read yet).
    for (const a of fusionCredits.list()) {
      if (seen.has(a.id)) continue;
      out.push({ id: a.id, name: a.name || a.id, branch: chosen[a.id] ?? '', scanType: '', model: '', loc: null, units: 0, frequency: null, scansYear: null, planned: null, rate: null, recommended: null, allocated: Number(a.allocated) || 0, allocatedAt: a.allocatedAt, plan: a.plan ?? null, usedScans: null, used: null, left: null, next: null, standing: 'unknown', paused: a.paused ? { at: a.paused.at } : null, shortfall: null, locAlert: a.locAlert ?? null, schedule: a.schedule ?? null, canSchedule: false, recent: [], notRead: true });
    }
    return out;
  }

  function view(req) {
    const read = fusionCredits.read;
    const projects = projectRows();
    const available = read?.tenant?.available ?? null;
    const pool = creditPool();
    const trHeld = round2(pool?.outstanding?.total ?? 0);
    const fHeld = fusionHeld();
    const job = jobOf();
    const plan = fusionCredits.plan;
    return {
      settings: { ...fusionCredits.settings, plan: { ...plan, projects: undefined, projectCount: Object.keys(plan.projects).length } },
      frequencies: FREQUENCIES.map((f) => ({ id: f.id, label: f.label })),
      read: read ? { at: read.at, checkedAt: read.checkedAt ?? null, models: read.models ?? [], tenantModel: read.tenantModel ?? '' } : null,
      job: { state: job.state, step: job.step ?? '', done: job.done ?? 0, total: job.total ?? 0, startedAt: job.startedAt ?? null, finishedAt: job.finishedAt ?? null, error: job.error ?? '' },
      tenant: { available, readAt: read?.tenant?.readAt ?? null, triageRemediationHeld: trHeld, fusionHeld: fHeld, free: available === null ? null : round2(available - trHeld - fHeld) },
      recommended: round2(projects.filter((p) => p.scanType === 'fusion' && p.inPlan !== false).reduce((n, p) => n + (p.recommended ?? 0), 0)),
      projects,
      may: { allocate: can(req, 'credits.allocate'), rates: isAdmin(req), calculator: Boolean(projections) },
    };
  }

  app.get('/api/fusion-credits', requirePermission('credits.view'), (req, res) => res.json(view(req)));

  /** Read the tenant's Fusion projects (every one), then check what the projects given credits used. */
  async function readAll(client, actor) {
    const job = jobOf();
    Object.assign(job, { state: 'running', step: 'projects', done: 0, total: 0, startedAt: Date.now(), finishedAt: null, error: '' });
    try {
      const read = await readFusionProjects(client, {
        allocated: fusionCredits.list().map((a) => a.id),
        branches: fusionCredits.branches,
        onProgress: (step, done, total) => Object.assign(job, { step, done, total }),
      });
      fusionCredits.setRead(read);
      await enforce(client, actor);
      Object.assign(job, { state: 'done', finishedAt: Date.now() });
    } catch (error) {
      Object.assign(job, { state: 'failed', finishedAt: Date.now(), error: String(error?.message ?? error).slice(0, 300) });
      if (!(error?.status >= 400 && error.status < 600)) console.warn(`! [fusion-credits] read: ${logSafe(error?.stack ?? error?.message)}`);
    }
  }

  /** Read these projects again (their branch changed, or the regular check), into the last read. */
  async function readSome(client, list) {
    const branches = fusionCredits.branches;
    const fresh = await readFusionProjects(client, { only: list.map((p) => ({ id: p.id, name: p.name, branch: branches[p.id] ?? '' })), branches, concurrency: 4 });
    const before = fusionCredits.read;
    const merged = new Map((before?.projects ?? []).map((r) => [r.id, r]));
    for (const r of fresh.projects) merged.set(r.id, r);
    fusionCredits.setRead({ ...(before ?? {}), at: before?.at ?? fresh.at, checkedAt: fresh.at, projects: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)), tenant: fresh.tenant ?? before?.tenant ?? null, models: before?.models ?? fresh.models, tenantModel: before?.tenantModel ?? fresh.tenantModel });
  }

  app.post('/api/fusion-credits/read', requirePermission('credits.allocate'), asyncRoute(async (req, res) => {
    const client = req.session?.client;
    if (!client) return res.status(409).json({ error: 'Connect to Checkmarx One first (Settings → Checkmarx One).' });
    if (jobOf().state === 'running') return res.status(202).json({ started: false, job: jobOf() });
    const actor = await adminActor(req);
    tenancy.run(tenancy.current().id, () => readAll(client, actor));
    res.status(202).json({ started: true });
  }));

  app.put('/api/fusion-credits/rates', requirePermission('credits.view'), asyncRoute(async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an Admin sets the Fusion rates.' });
    const given = Array.isArray(req.body?.rates) ? req.body.rates : null;
    if (!given) return res.status(400).json({ error: 'Send every model with its rate: { rates: [{ model, creditsPer10k }] }.' });
    const rates = {};
    for (const r of given.slice(0, 30)) {
      const name = modelKey(r?.model);
      if (!name) continue;
      if (!/^[a-z0-9][a-z0-9 ._-]*$/.test(name)) return res.status(400).json({ error: `"${String(r?.model).slice(0, 60)}" is not a model name: letters, digits, dots, dashes and spaces.` });
      const raw = r?.creditsPer10k;
      const rate = raw === null || raw === undefined || raw === '' ? null : Number(raw);
      if (rate !== null && (!Number.isFinite(rate) || rate < 0 || rate > 1000)) return res.status(400).json({ error: `The rate for ${name} must be a number from 0 to 1,000 (credits per 10,000 lines of code), or empty.` });
      rates[name] = rate;
    }
    const before = fusionCredits.settings;
    const pause = typeof req.body?.pauseWhenSpent === 'boolean' ? req.body.pauseWhenSpent : undefined;
    const actor = await adminActor(req);
    fusionCredits.setRates(rates, { by: actor.user || req.user?.email || '', pauseWhenSpent: pause });
    const after = fusionCredits.settings;
    const changed = Object.keys({ ...before.rates, ...after.rates }).filter((k) => before.rates[k] !== after.rates[k]);
    if (changed.length || before.pauseWhenSpent !== after.pauseWhenSpent) {
      audit.record({
        type: 'settings',
        outcome: 'changed',
        actor,
        reason: [
          changed.length ? `Fusion rates changed (credits per 10,000 lines of code): ${changed.map((k) => `${k} ${fmt(before.rates[k])} → ${fmt(after.rates[k])}`).join(', ')}.` : '',
          before.pauseWhenSpent !== after.pauseWhenSpent ? (after.pauseWhenSpent ? 'When a project\'s Fusion credits are spent: warn and pause Fusion in Checkmarx One.' : 'When a project\'s Fusion credits are spent: warn only.') : '',
        ].filter(Boolean).join(' '),
        details: { before: { rates: before.rates, pauseWhenSpent: before.pauseWhenSpent }, after: { rates: after.rates, pauseWhenSpent: after.pauseWhenSpent } },
      });
    }
    // Warn only now: what CxMissionZero paused is put back; new rates: what is spent may have changed.
    if (req.session?.client) await enforce(req.session.client, actor).catch(() => {});
    res.json(view(req));
  }));

  app.put('/api/fusion-credits/plan', requirePermission('credits.allocate'), asyncRoute(async (req, res) => {
    const actor = await adminActor(req);
    fusionCredits.setPlan({ periodMonths: req.body?.periodMonths, byFrequency: req.body?.byFrequency }, { by: actor.user || '' });
    res.json(view(req));
  }));

  /** The plans saved in the Cx Credits Calculator here that have Fusion projects. */
  app.get('/api/fusion-credits/plans', requirePermission('credits.allocate'), (req, res) => {
    if (!projections) return res.json({ plans: [] });
    res.json({ plans: projections.list().filter((p) => p.fusionProjects > 0).map((p) => ({ id: p.id, name: p.name, projects: p.fusionProjects, updatedAt: p.updatedAt, updatedBy: p.updatedBy })) });
  });

  app.post('/api/fusion-credits/plan/import', requirePermission('credits.allocate'), asyncRoute(async (req, res) => {
    const actor = await adminActor(req);
    let fusion = null;
    let name = '';
    let kind = 'calculator';
    if (req.body?.calculatorId) {
      if (!projections) return res.status(404).json({ error: 'There is no Cx Credits Calculator on this server: export the Fusion plan from the calculator and open the file here.' });
      const profile = projections.get(String(req.body.calculatorId).slice(0, 100));
      fusion = profile.fusion;
      name = profile.name;
    } else if (req.body?.file && typeof req.body.file === 'object') {
      if (JSON.stringify(req.body.file).length > MAX_PLAN_FILE) return res.status(413).json({ error: 'That plan file is too large.' });
      const file = req.body.file;
      if (file.kind !== 'cx-fusion-plan' || !file.fusion || typeof file.fusion !== 'object') return res.status(400).json({ error: 'That is not a Fusion plan exported from the Cx Credits Calculator (Fusion → Download the Fusion plan).' });
      fusion = file.fusion;
      name = text(file.customer, 200) || 'Fusion plan file';
      kind = 'file';
    } else return res.status(400).json({ error: 'Choose a plan saved in the Cx Credits Calculator, or open a Fusion plan file.' });
    const plan = planFromCalculator(fusion, { name, kind, by: actor.user || '' });
    fusionCredits.usePlan(plan);
    audit.record({ type: 'settings', outcome: 'changed', actor, reason: `Fusion credits now follow the Cx Credits Calculator's plan "${name}" (${kind === 'file' ? 'from a file' : 'saved in the calculator here'}): ${plan.periodMonths} months, ${Object.keys(plan.projects).length} project(s) with choices of their own.`, details: { source: plan.source, periodMonths: plan.periodMonths, combine: plan.combine } });
    // The plan may read projects on other branches: those projects are read again on theirs.
    const client = req.session?.client;
    const moved = (fusionCredits.read?.projects ?? []).filter((r) => plan.projects[r.id]?.branch && plan.projects[r.id].branch !== r.branch);
    if (client && moved.length) await readSome(client, moved).catch(() => {});
    res.json(view(req));
  }));

  app.get('/api/fusion-credits/branches', requirePermission('credits.view'), asyncRoute(async (req, res) => {
    const id = text(req.query.project, 80);
    const client = req.session?.client;
    if (!id) return res.status(400).json({ error: 'Which project?' });
    if (!client) return res.status(409).json({ error: 'Connect to Checkmarx One first (Settings → Checkmarx One).' });
    const row = rowsById().get(id);
    const names = await projectBranches(client, id);
    const primary = row && !fusionCredits.branches[id] ? row.branch : '';
    res.json({ branches: orderBranches(names, primary || row?.branch || '').map((b) => ({ name: b, protected: protectedPattern(b) })), current: row?.branch ?? '', chosen: fusionCredits.branches[id] ?? '' });
  }));

  app.put('/api/fusion-credits/branch', requirePermission('credits.allocate'), asyncRoute(async (req, res) => {
    const id = text(req.body?.projectId, 80);
    const branch = text(req.body?.branch, 200);
    const client = req.session?.client;
    if (!id) return res.status(400).json({ error: 'Which project?' });
    if (!client) return res.status(409).json({ error: 'Connect to Checkmarx One first (Settings → Checkmarx One).' });
    const row = rowsById().get(id);
    const before = fusionCredits.branches[id] ?? '';
    fusionCredits.setBranch(id, branch);
    await readSome(client, [{ id, name: row?.name ?? fusionCredits.get(id)?.name ?? id }]);
    const actor = await adminActor(req);
    audit.record({ type: 'settings', outcome: 'changed', actor, project: { id, name: row?.name ?? id }, reason: `Fusion credits read ${row?.name ?? id} on ${branch ? `the branch ${branch}` : 'its primary branch'} (was ${before ? `the branch ${before}` : 'its primary branch'}).` });
    res.json(view(req));
  }));

  app.post('/api/fusion-credits/allocate', requirePermission('credits.allocate'), asyncRoute(async (req, res) => {
    const list = Array.isArray(req.body?.projects) ? req.body.projects.slice(0, 5000) : [];
    if (!list.length) return res.status(400).json({ error: 'Choose the projects to give Fusion credits to.' });
    const known = rowsById();
    const rates = fusionCredits.rates;
    const plan = fusionCredits.plan;
    const recs = recommend([...known.values()], rates, plan);
    const changes = [];
    for (const item of list) {
      const id = String(item?.id ?? '').slice(0, 80);
      const credits = cleanCredits(item?.credits);
      const mode = item?.mode === 'add' ? 'add' : 'set';
      if (!id || credits === null) return res.status(400).json({ error: 'Each project needs an id and a number of credits, 0 or more.' });
      const row = known.get(id);
      const current = fusionCredits.get(id);
      if (!row && !current) return res.status(400).json({ error: 'Read the projects first: a project is given Fusion credits once CxMissionZero has read it.' });
      const before = current ? Number(current.allocated) || 0 : 0;
      const after = mode === 'add' ? before + credits : credits;
      const used = current ? usedSince(row, current.allocatedAt, rates).credits ?? 0 : 0;
      // What the credits were worked out for (the plan, and the lines of code now): when the lines grow, more are asked for.
      const rec = row ? recs.get(id) : null;
      const snapshot = rec && (mode === 'set' || !current?.plan) ? { scans: rec.scans, model: rec.model, rate: rec.rate, units: rec.units, loc: row.loc, branch: row.branch, periodMonths: plan.periodMonths, source: plan.source.name || (plan.source.kind === 'here' ? 'Fusion credits' : '') } : null;
      changes.push({ id, name: row?.name ?? current?.name ?? id, credits, mode, before, after, heldBefore: Math.max(0, before - used), heldAfter: Math.max(0, after - used), snapshot });
    }
    // Together with what Triage & Remediation hold, never more than the tenant has left in Checkmarx One.
    const more = round2(changes.reduce((n, c) => n + (c.heldAfter - c.heldBefore), 0));
    const available = fusionCredits.read?.tenant?.available ?? null;
    if (more > 0 && available !== null) {
      const free = round2(available - (creditPool()?.outstanding?.total ?? 0) - fusionHeld());
      if (more > free) return res.status(409).json({ error: `Checkmarx One has ${fmt(available)} credits left for this tenant, and ${fmt(Math.max(0, free))} of them are not held for Triage, Remediation or Fusion: ${fmt(more)} more cannot be given. Give less, or take back what projects have not used.`, free });
    }
    const actor = await adminActor(req);
    for (const c of changes) {
      fusionCredits.allocate(c.id, c.name, c.credits, { mode: c.mode, by: actor.user || req.user?.email || '', plan: c.snapshot });
      audit.record({
        type: 'allocation',
        outcome: 'changed',
        actor,
        project: { id: c.id, name: c.name },
        reason: `Fusion credits ${c.before ? `changed from ${fmt(c.before)} to ${fmt(c.after)}` : `allocated: ${fmt(c.after)}`} (for Fusion scans only)${c.snapshot ? `, for ${c.snapshot.scans} Fusion scan(s) over ${c.snapshot.periodMonths} months on ${c.snapshot.branch || 'its branch'} with ${c.snapshot.model || 'its model'}` : ''}.`,
        credits: { kind: 'fusion', requested: 0, charged: 0, triageDelta: 0, remediationDelta: 0, fusionDelta: round2(c.after - c.before) },
        details: { change: c.mode === 'add' ? 'fusion-add' : 'fusion-set', before: c.before, after: c.after, plan: c.snapshot },
      });
    }
    fusionCredits.save();
    // A project paused for want of credits goes on again as soon as it has some.
    if (req.session?.client) await enforce(req.session.client, actor, changes.map((c) => c.id)).catch(() => {});
    res.json(view(req));
  }));

  app.post('/api/fusion-credits/take-back', requirePermission('credits.allocate'), asyncRoute(async (req, res) => {
    const ids = Array.isArray(req.body?.projectIds) ? req.body.projectIds.map((id) => String(id ?? '').slice(0, 80)).filter(Boolean).slice(0, 5000) : [];
    if (!ids.length) return res.status(400).json({ error: 'Choose the projects to take Fusion credits back from.' });
    const rows = rowsById();
    const rates = fusionCredits.rates;
    const actor = await adminActor(req);
    let back = 0;
    for (const id of ids) {
      const a = fusionCredits.get(id);
      if (!a) continue;
      const used = usedSince(rows.get(id), a.allocatedAt, rates).credits;
      if (used === null) continue;
      const to = Math.min(Number(a.allocated) || 0, used);
      if (to === Number(a.allocated)) continue;
      back += (Number(a.allocated) || 0) - to;
      fusionCredits.allocate(id, a.name, to, { mode: 'set', by: actor.user || '' });
      audit.record({
        type: 'allocation',
        outcome: 'changed',
        actor,
        project: { id, name: a.name },
        reason: `Unused Fusion credits taken back: ${fmt(a.allocated)} → ${fmt(to)}.`,
        credits: { kind: 'fusion', requested: 0, charged: 0, triageDelta: 0, remediationDelta: 0, fusionDelta: round2(to - a.allocated) },
        details: { change: 'fusion-take-back', before: a.allocated, after: to },
      });
    }
    fusionCredits.save();
    // No credits left: Fusion is paused for them as for any project whose credits are spent.
    if (req.session?.client) await enforce(req.session.client, actor, ids).catch(() => {});
    res.json({ ...view(req), takenBack: round2(back) });
  }));

  /**
   * Schedule each project's planned Fusion scans: the scans of its plan not run yet, spread evenly over the plan's
   * period, the first one now. Each is started only while the project has credits for it.
   */
  app.post('/api/fusion-credits/schedule', requirePermission('credits.allocate'), asyncRoute(async (req, res) => {
    const ids = Array.isArray(req.body?.projectIds) ? req.body.projectIds.map((id) => String(id ?? '').slice(0, 80)).filter(Boolean).slice(0, 5000) : [];
    if (!ids.length) return res.status(400).json({ error: 'Choose the projects whose planned Fusion scans to schedule.' });
    const client = req.session?.client;
    if (!client) return res.status(409).json({ error: 'Connect to Checkmarx One first (Settings → Checkmarx One).' });
    const rows = rowsById();
    const rates = fusionCredits.rates;
    const actor = await adminActor(req);
    const skipped = [];
    const now = Date.now();
    for (const id of ids) {
      const a = fusionCredits.get(id);
      const row = rows.get(id);
      if (!a || !a.plan) {
        skipped.push({ id, why: 'Give it Fusion credits for the plan first.' });
        continue;
      }
      if (!row?.latestScanId) {
        skipped.push({ id, why: 'It has no scan on its branch to scan again like.' });
        continue;
      }
      const done = usedSince(row, a.allocatedAt, rates).scans;
      const total = Math.max(0, Number(a.plan.scans) || 0);
      const left = Math.max(0, total - done);
      if (!left) {
        skipped.push({ id, why: 'Its planned Fusion scans have all run.' });
        continue;
      }
      // The rest of the plan's period, from the first allocation.
      const end = Date.parse(a.allocatedAt) + (Number(a.plan.periodMonths) || 12) * MONTH_MS;
      const span = Math.max(end - now, left * 86_400_000);
      fusionCredits.setSchedule(id, { by: actor.user || '', at: new Date(now).toISOString(), every: Math.floor(span / left), next: new Date(now).toISOString(), left, branch: row.branch, model: a.plan.model || row.model, started: a.schedule?.started ?? [] });
      audit.record({ type: 'system', outcome: 'changed', actor, project: { id, name: a.name }, reason: `${left} planned Fusion scan(s) of ${a.name || id} scheduled on ${row.branch || 'its branch'}, one about every ${Math.max(1, Math.round(span / left / 86_400_000))} day(s), the first now; each starts only while it has Fusion credits for it.` });
    }
    fusionCredits.save();
    await runSchedules(client, actor).catch((error) => console.warn(`! [fusion-credits] schedule: ${logSafe(error?.message)}`));
    res.json({ ...view(req), skipped });
  }));

  app.post('/api/fusion-credits/schedule/stop', requirePermission('credits.allocate'), asyncRoute(async (req, res) => {
    const ids = Array.isArray(req.body?.projectIds) ? req.body.projectIds.map((id) => String(id ?? '').slice(0, 80)).filter(Boolean).slice(0, 5000) : [];
    const actor = await adminActor(req);
    for (const id of ids) {
      const a = fusionCredits.get(id);
      if (!a?.schedule || a.schedule.stopped) continue;
      fusionCredits.setSchedule(id, { ...a.schedule, stopped: true, stoppedAt: new Date().toISOString() });
      audit.record({ type: 'system', outcome: 'changed', actor, project: { id, name: a.name }, reason: `Planned Fusion scans of ${a.name || id} stopped (${a.schedule.left ?? 0} not started).` });
    }
    fusionCredits.save();
    res.json(view(req));
  }));

  /** Start the planned Fusion scans that are due, while each project has credits for one more. */
  async function runSchedules(client, actor = SYSTEM_ACTOR) {
    const rows = rowsById();
    const rates = fusionCredits.rates;
    for (const a of fusionCredits.list()) {
      const s = a.schedule;
      if (!s || s.stopped || !(s.left > 0) || Date.parse(s.next) > Date.now()) continue;
      const row = rows.get(a.id);
      const used = usedSince(row, a.allocatedAt, rates).credits;
      const cost = scanCost(row, a, rates);
      const left = used === null ? null : (Number(a.allocated) || 0) - used;
      if (a.paused || left === null || cost === null || left < cost) {
        if (s.blocked !== 'credits') {
          fusionCredits.setSchedule(a.id, { ...s, blocked: 'credits' });
          audit.record({ type: 'system', outcome: 'failed', actor, project: { id: a.id, name: a.name }, reason: `The planned Fusion scan of ${a.name || a.id} was not started: ${left === null || cost === null ? 'what it used or one scan costs is not known' : `it has ${fmt(Math.max(0, left))} Fusion credits left and one scan costs ${fmt(cost)}`}. It starts once credits are added.` });
        }
        continue;
      }
      try {
        const last = await client.request(`/api/scans/${encodeURIComponent(row.latestScanId)}`, { retries: 1 });
        const request = fusionScanRequest(a.id, last, { branch: s.branch || row.branch, model: s.model, requestedBy: `planned Fusion scans (${s.by || 'CxMissionZero'})` });
        if (request.waiting) {
          fusionCredits.setSchedule(a.id, { ...s, blocked: 'upload', stopped: true });
          audit.record({ type: 'system', outcome: 'failed', actor, project: { id: a.id, name: a.name }, reason: `Planned Fusion scans of ${a.name || a.id} stopped: ${request.reason}` });
          continue;
        }
        const created = await client.request('/api/scans', { method: 'POST', body: request.body, retries: 1 });
        const scanId = text(created?.id, 80);
        fusionCredits.setSchedule(a.id, { ...s, blocked: '', left: s.left - 1, next: new Date(Date.parse(s.next) + s.every).toISOString(), started: [...(s.started ?? []), { at: new Date().toISOString(), scanId }].slice(-100) });
        audit.record({ type: 'system', outcome: 'changed', actor, project: { id: a.id, name: a.name }, reason: `Planned Fusion scan of ${a.name || a.id} started on ${request.branch} (${scanId || 'no id given'}); ${s.left - 1} more planned.` });
      } catch (error) {
        fusionCredits.setSchedule(a.id, { ...s, blocked: 'error', next: new Date(Date.now() + 3_600_000).toISOString() });
        audit.record({ type: 'system', outcome: 'failed', actor, project: { id: a.id, name: a.name }, reason: `The planned Fusion scan of ${a.name || a.id} could not be started: ${String(error?.message ?? error).slice(0, 200)}. It is tried again in an hour.` });
      }
    }
    fusionCredits.save();
  }

  /**
   * What the projects given credits used, against what they were given: a project whose credits are spent is
   * flagged and its Admins and owner told (once), and Fusion is paused in Checkmarx One unless an Admin chose to warn
   * only; one paused here that has credits again (or once warning only is chosen) gets Fusion back as it was. A
   * project whose lines of code grew so that its credits no longer cover the rest of its plan: Admins and Security
   * Analysts are asked for the extra credits (once for each growth). `ids`: these projects only. Audited.
   */
  async function enforce(client, actor = SYSTEM_ACTOR, ids = null) {
    const rows = rowsById();
    const rates = fusionCredits.rates;
    const pauseWhenSpent = fusionCredits.pauseWhenSpent;
    const results = [];
    for (const a of fusionCredits.list()) {
      if (ids && !ids.includes(a.id)) continue;
      const row = rows.get(a.id);
      // Not read yet (or gone from Checkmarx One): what it used is not known, so nothing is changed.
      if (!row) continue;
      const used = usedSince(row, a.allocatedAt, rates).credits;
      const allocated = Number(a.allocated) || 0;
      const spent = standingFor(allocated, used, scanCost(row, a, rates)) === 'spent';
      try {
        if (spent && pauseWhenSpent && !a.paused) {
          const before = await pauseFusion(client, a.id);
          fusionCredits.setPaused(a.id, { at: new Date().toISOString(), before });
          audit.record({ type: 'system', outcome: 'changed', actor, project: { id: a.id, name: a.name }, reason: `Fusion paused in Checkmarx One for ${a.name || a.id}: its Fusion credits are spent (${fmt(used)} used of ${fmt(allocated)}). It goes on once credits are added.` });
          results.push({ id: a.id, did: 'paused' });
        } else if (a.paused && (!spent || !pauseWhenSpent)) {
          const how = await resumeFusion(client, a.id, a.paused.before);
          fusionCredits.setPaused(a.id, null);
          audit.record({ type: 'system', outcome: 'changed', actor, project: { id: a.id, name: a.name }, reason: `Fusion back on in Checkmarx One for ${a.name || a.id}: ${!spent ? 'it has Fusion credits again' : 'an Admin chose to warn only'} (${how === 'restored' ? 'its own setting put back' : how === 'inherited' ? 'the tenant\'s setting applies again' : 'set on'}).` });
          results.push({ id: a.id, did: 'resumed' });
        }
      } catch (error) {
        audit.record({ type: 'system', outcome: 'failed', actor, project: { id: a.id, name: a.name }, reason: `Fusion could not be ${a.paused ? 'switched back on' : 'paused'} in Checkmarx One for ${a.name || a.id}: ${String(error?.message ?? error).slice(0, 200)}` });
        results.push({ id: a.id, did: 'failed' });
      }
      if (spent && !a.warnedAt) {
        fusionCredits.setWarned(a.id, new Date().toISOString());
        await warnSpent(a, row, used, allocated, pauseWhenSpent && Boolean(fusionCredits.get(a.id)?.paused));
      }
      // More lines of code than the credits were worked out for, and not enough left for the rest of the plan.
      const short = shortfall(a, row, used, rates);
      if (short && short.extra > 0 && short.unitsPlanned !== null && short.units > short.unitsPlanned && (a.locAlert?.units ?? 0) < short.units) {
        fusionCredits.setLocAlert(a.id, { units: short.units, loc: row.loc, at: new Date().toISOString(), extra: short.extra });
        audit.record({ type: 'allocation', outcome: 'refused', actor, project: { id: a.id, name: a.name }, reason: `${a.name || a.id} needs ${fmt(short.extra)} more Fusion credits to finish its plan: its lines of code grew from ${fmt(a.plan.loc)} (${short.unitsPlanned} 10K blocks) to ${fmt(row.loc)} (${short.units}).`, credits: { kind: 'fusion', requested: short.extra, charged: 0 } });
        await warnGrowth(a, row, short);
      }
    }
    fusionCredits.save();
    return results;
  }

  const appNameNow = () => settingsStore.get().branding?.appName || 'CxMissionZero';
  const people = (roles) => iam.users().filter((u) => roles.includes(u.role) && !u.disabled && u.email).map((u) => u.email);

  async function send(to, message, what) {
    if (!to.length) return;
    try {
      await sendReminderMail(sendingSettings(), message, { to: [...new Set(to)], cc: [], bcc: [], exact: true });
    } catch (error) {
      console.warn(`[fusion-credits] ${what} was not sent: ${logSafe(error?.message)}`);
    }
  }

  /** The email to Admins and the project's owner (its latest scan's initiator, when an address) that its credits are spent. */
  function warnSpent(a, row, used, allocated, paused) {
    return send([...people(['admin']), ...(row?.owner ? [row.owner] : [])], systemEmail({
      appName: appNameNow(),
      subject: `Fusion credits spent: ${a.name || a.id}`,
      lines: [
        `${a.name || a.id} has used the Fusion credits it was given.`,
        paused ? 'Fusion is paused for it in Checkmarx One: its scans go on without the AI engine until more Fusion credits are allocated under Credits → Fusion credits.' : 'Its Fusion scans in Checkmarx One go on: allocate more under Credits → Fusion credits, or switch Fusion off for it.',
      ],
      facts: [['Allocated', fmt(allocated)], ['Used', fmt(used)], ['Branch', row?.branch || '—'], ['Fusion', paused ? 'Paused' : 'On']],
      replyHelp: false,
    }), `the email that ${a.name || a.id}'s Fusion credits are spent`);
  }

  /** The email to Admins and Security Analysts: the project's lines of code grew, and its plan needs more credits. */
  function warnGrowth(a, row, short) {
    return send(people(['admin', 'analyst']), systemEmail({
      appName: appNameNow(),
      subject: `More Fusion credits needed: ${a.name || a.id}`,
      lines: [
        `${a.name || a.id} has more lines of code than its Fusion credits were worked out for, so what it has left no longer covers the rest of its plan.`,
        'Allocate the extra credits under Credits → Fusion credits to keep its Fusion coverage, or change its plan.',
      ],
      facts: [
        ['Lines of code', `${fmt(a.plan.loc)} → ${fmt(row.loc)}`],
        ['10K blocks', `${short.unitsPlanned} → ${short.units}`],
        ['Planned Fusion scans still to run', String(short.remaining)],
        ['Credits needed for them', fmt(short.need)],
        ['Credits left', fmt(short.left)],
        ['Extra credits needed', fmt(short.extra)],
        ['Branch', row.branch || '—'],
        ['Plan', a.plan.source || '—'],
      ],
      replyHelp: false,
    }), `the email that ${a.name || a.id} needs more Fusion credits`);
  }

  /** Every half hour, in every tenant with projects given Fusion credits: read their scans again, check, and start what is due. */
  async function checkTenants() {
    for (const id of tenancy.ids()) {
      await tenancy.run(id, async () => {
        const given = fusionCredits.list();
        if (!given.length || jobOf().state === 'running') return;
        const integration = await resolveAutomationSession().catch(() => null);
        if (!integration?.client) return;
        try {
          await readSome(integration.client, given.map((a) => ({ id: a.id, name: a.name })));
          await enforce(integration.client, SYSTEM_ACTOR);
          await runSchedules(integration.client, SYSTEM_ACTOR);
        } catch (error) {
          console.warn(`! [fusion-credits] check: ${logSafe(error?.message)}`);
        }
      }).catch(() => {});
    }
  }
  const timer = setInterval(() => checkTenants().catch(() => {}), CHECK_EVERY_MS);
  timer.unref?.();

  return { fusionHeld, checkTenants, enforce, runSchedules };
}
