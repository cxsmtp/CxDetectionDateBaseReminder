/**
 * Credits → Fusion credits (src/fusion-credits.js): the page's view, reading the tenant's Fusion projects, the rates
 * (Admins only), the plan, allocating and taking back, and the check that pauses Fusion for a project whose credits
 * are spent and puts it back once credits are added.
 *
 *   GET  /api/fusion-credits            the page (credits.view)
 *   POST /api/fusion-credits/read       read the tenant's Fusion projects again, in the background (credits.allocate)
 *   PUT  /api/fusion-credits/rates      every model's rate, and warn only or warn and pause (an Admin)
 *   PUT  /api/fusion-credits/plan       the period and the Fusion scans planned for each change frequency (credits.allocate)
 *   POST /api/fusion-credits/allocate   { projects: [{ id, credits, mode: 'set' | 'add' }] } (credits.allocate)
 *   POST /api/fusion-credits/take-back  { projectIds } what each has not used goes back (credits.allocate)
 */
import { sendReminderMail } from '../mailer.js';
import { systemEmail } from '../hands-off.js';
import { FREQUENCIES } from '../../public/calculator/model.js';
import { cleanCredits, modelKey, pauseFusion, perScan, readFusionProjects, recommend, resumeFusion, standingOf, usedSince } from '../fusion-credits.js';
import { SYSTEM_ACTOR, logSafe } from './shared.js';

const CHECK_EVERY_MS = 30 * 60_000;
const round2 = (n) => Math.round(n * 100) / 100;
const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en', { maximumFractionDigits: 2 }));

export function registerFusionCreditRoutes(app, d) {
  const {
    tenancy, fusionCredits, audit, iam, asyncRoute, requirePermission, can, resolveAutomationSession, creditPool, adminActor,
    sendingSettings, settingsStore,
  } = d;

  const isAdmin = (req) => req.user?.role === 'admin';
  /**
   * A project given Fusion credits (even 0, or all its unused ones taken back): 'unknown' when what it used is not
   * known, 'spent' when nothing is left, 'low' when less than one more scan is, else 'ok'.
   */
  const standingFor = (allocated, used, next) => (used === null ? 'unknown' : standingOf({ allocated: Math.max(allocated, Number.EPSILON), used: allocated - used <= 0 ? Infinity : used, next }));
  /** The running tenant's read: { state, step, done, total, startedAt, finishedAt, error } (one at a time). */
  const jobOf = () => (tenancy.current().state.fusionCreditsRead ??= { state: 'none' });

  /** Credits given for Fusion and not used yet, over every project (what Fusion holds of the tenant's credits). */
  function fusionHeld() {
    const read = fusionCredits.read;
    const rows = new Map((read?.projects ?? []).map((r) => [r.id, r]));
    const rates = fusionCredits.rates;
    let held = 0;
    for (const a of fusionCredits.list()) {
      const used = usedSince(rows.get(a.id), a.allocatedAt, rates).credits;
      held += Math.max(0, (Number(a.allocated) || 0) - (used ?? 0));
    }
    return round2(held);
  }

  /** Every project's figures, as the page shows them. */
  function projectRows() {
    const read = fusionCredits.read;
    const rates = fusionCredits.rates;
    const rows = read?.projects ?? [];
    const recs = recommend(rows, rates, fusionCredits.plan);
    const seen = new Set();
    const out = rows.map((r) => {
      seen.add(r.id);
      const a = fusionCredits.get(r.id);
      const rec = recs.get(r.id) ?? { units: 0, scans: 0, rate: null, credits: null };
      const used = a ? usedSince(r, a.allocatedAt, rates) : { scans: 0, credits: null };
      const allocated = a ? Number(a.allocated) || 0 : 0;
      const next = perScan(r, rates);
      const usedCredits = a ? used.credits : null;
      return {
        id: r.id,
        name: r.name,
        scanType: r.scanType,
        model: r.model,
        modelFrom: r.modelFrom,
        loc: r.loc,
        units: rec.units,
        frequency: r.frequency,
        scansYear: r.scansYear,
        planned: rec.scans,
        rate: rec.rate,
        recommended: rec.credits,
        allocated: a ? allocated : null,
        allocatedAt: a?.allocatedAt ?? null,
        usedScans: a ? used.scans : null,
        used: usedCredits,
        left: a && usedCredits !== null ? round2(allocated - usedCredits) : null,
        next,
        standing: a ? standingFor(allocated, usedCredits, next) : 'none',
        paused: a?.paused ? { at: a.paused.at } : null,
        recent: (r.fusionScans ?? []).slice(0, 20),
      };
    });
    // Given credits but not in the last read (removed from Checkmarx One, or no read yet).
    for (const a of fusionCredits.list()) {
      if (seen.has(a.id)) continue;
      out.push({ id: a.id, name: a.name || a.id, scanType: '', model: '', loc: null, units: 0, frequency: null, scansYear: null, planned: null, rate: null, recommended: null, allocated: Number(a.allocated) || 0, allocatedAt: a.allocatedAt, usedScans: null, used: null, left: null, next: null, standing: 'unknown', paused: a.paused ? { at: a.paused.at } : null, recent: [], notRead: true });
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
    return {
      settings: fusionCredits.settings,
      frequencies: FREQUENCIES.map((f) => ({ id: f.id, label: f.label })),
      read: read ? { at: read.at, models: read.models ?? [], tenantModel: read.tenantModel ?? '' } : null,
      job: { state: job.state, step: job.step ?? '', done: job.done ?? 0, total: job.total ?? 0, startedAt: job.startedAt ?? null, finishedAt: job.finishedAt ?? null, error: job.error ?? '' },
      tenant: { available, readAt: read?.tenant?.readAt ?? null, triageRemediationHeld: trHeld, fusionHeld: fHeld, free: available === null ? null : round2(available - trHeld - fHeld) },
      recommended: round2(projects.filter((p) => p.scanType === 'fusion').reduce((n, p) => n + (p.recommended ?? 0), 0)),
      projects,
      may: { allocate: can(req, 'credits.allocate'), rates: isAdmin(req) },
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

  app.post('/api/fusion-credits/read', requirePermission('credits.allocate'), asyncRoute(async (req, res) => {
    const client = req.session?.client;
    if (!client) return res.status(409).json({ error: 'Connect to Checkmarx One first (Settings → Checkmarx One).' });
    if (jobOf().state === 'running') return res.status(202).json({ started: false, job: jobOf() });
    const actor = await adminActor(req);
    const id = tenancy.current().id;
    tenancy.run(id, () => readAll(client, actor));
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
    fusionCredits.setPlan({ periodMonths: req.body?.periodMonths, byFrequency: req.body?.byFrequency });
    res.json(view(req));
  }));

  app.post('/api/fusion-credits/allocate', requirePermission('credits.allocate'), asyncRoute(async (req, res) => {
    const list = Array.isArray(req.body?.projects) ? req.body.projects.slice(0, 5000) : [];
    if (!list.length) return res.status(400).json({ error: 'Choose the projects to give Fusion credits to.' });
    const known = new Map((fusionCredits.read?.projects ?? []).map((r) => [r.id, r]));
    const rates = fusionCredits.rates;
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
      // What it holds now and would hold then: given and not used yet.
      changes.push({ id, name: row?.name ?? current?.name ?? id, credits, mode, before, after, heldBefore: Math.max(0, before - used), heldAfter: Math.max(0, after - used) });
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
      fusionCredits.allocate(c.id, c.name, c.credits, { mode: c.mode, by: actor.user || req.user?.email || '' });
      audit.record({
        type: 'allocation',
        outcome: 'changed',
        actor,
        project: { id: c.id, name: c.name },
        reason: `Fusion credits ${c.before ? `changed from ${fmt(c.before)} to ${fmt(c.after)}` : `allocated: ${fmt(c.after)}`} (for Fusion scans only).`,
        credits: { kind: 'fusion', requested: 0, charged: 0, triageDelta: 0, remediationDelta: 0, fusionDelta: round2(c.after - c.before) },
        details: { change: c.mode === 'add' ? 'fusion-add' : 'fusion-set', before: c.before, after: c.after },
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
    const rows = new Map((fusionCredits.read?.projects ?? []).map((r) => [r.id, r]));
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
    res.json({ ...view(req), takenBack: round2(back) });
  }));

  /**
   * What the projects given credits used, against what they were given: a project whose credits are spent is
   * flagged and its Admins and owner told (once), and Fusion is paused in Checkmarx One unless an Admin chose to warn
   * only; one paused here that has credits again (or once warning only is chosen) gets Fusion back as it was.
   * `ids`: these projects only. Each change is in the audit log.
   */
  async function enforce(client, actor = SYSTEM_ACTOR, ids = null) {
    const rows = new Map((fusionCredits.read?.projects ?? []).map((r) => [r.id, r]));
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
      const spent = standingFor(allocated, used, perScan(row, rates)) === 'spent';
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
        await warn(a, row, used, allocated, pauseWhenSpent && Boolean(fusionCredits.get(a.id)?.paused));
      }
    }
    fusionCredits.save();
    return results;
  }

  /** The email to Admins and the project's owner (its latest scan's initiator, when an address) that its credits are spent. */
  async function warn(a, row, used, allocated, paused) {
    const admins = iam.users().filter((u) => u.role === 'admin' && !u.disabled && u.email).map((u) => u.email);
    const to = [...new Set([...admins, ...(row?.owner ? [row.owner] : [])])];
    if (!to.length) return;
    const appName = settingsStore.get().branding?.appName || 'CxMissionZero';
    const message = systemEmail({
      appName,
      subject: `Fusion credits spent: ${a.name || a.id}`,
      lines: [
        `${a.name || a.id} has used the Fusion credits it was given.`,
        paused ? 'Fusion is paused for it in Checkmarx One: its scans go on without the AI engine until more Fusion credits are allocated under Credits → Fusion credits.' : 'Its Fusion scans in Checkmarx One go on: allocate more under Credits → Fusion credits, or switch Fusion off for it.',
      ],
      facts: [['Allocated', fmt(allocated)], ['Used', fmt(used)], ['Fusion', paused ? 'Paused' : 'On']],
      replyHelp: false,
    });
    try {
      await sendReminderMail(sendingSettings(), message, { to, cc: [], bcc: [], exact: true });
    } catch (error) {
      console.warn(`[fusion-credits] the email that ${logSafe(a.name || a.id)}'s Fusion credits are spent was not sent: ${logSafe(error?.message)}`);
    }
  }

  /** Every half hour, in every tenant with projects given Fusion credits: read their scans again, then check. */
  async function checkTenants() {
    for (const id of tenancy.ids()) {
      await tenancy.run(id, async () => {
        const given = fusionCredits.list();
        if (!given.length || jobOf().state === 'running') return;
        const integration = await resolveAutomationSession().catch(() => null);
        if (!integration?.client) return;
        try {
          const fresh = await readFusionProjects(integration.client, { only: given.map((a) => ({ id: a.id, name: a.name })), concurrency: 4 });
          const before = fusionCredits.read;
          const merged = new Map((before?.projects ?? []).map((r) => [r.id, r]));
          for (const r of fresh.projects) merged.set(r.id, r);
          fusionCredits.setRead({ ...(before ?? {}), at: before?.at ?? fresh.at, checkedAt: fresh.at, projects: [...merged.values()], tenant: fresh.tenant ?? before?.tenant ?? null, models: before?.models ?? fresh.models, tenantModel: before?.tenantModel ?? fresh.tenantModel });
          await enforce(integration.client, SYSTEM_ACTOR);
        } catch (error) {
          console.warn(`! [fusion-credits] check: ${logSafe(error?.message)}`);
        }
      }).catch(() => {});
    }
  }
  const timer = setInterval(() => checkTenants().catch(() => {}), CHECK_EVERY_MS);
  timer.unref?.();

  return { fusionHeld, checkTenants, enforce };
}
