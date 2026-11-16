/**
 * Fusion results (Labs): what Checkmarx One's AI found and what it cost, read from the tenant, and the same
 * allocate / triage / remediate as a tracked report's Triage tab, on those findings.
 *
 * The routes under /api/beta/fusion (feature:fusionResults): the page, usage and credits, the troubleshooting
 * trace and probe (integration.cxone), acting on the results (credits.allocate, triage.run), and the read and
 * fetch that fill the page.
 */
import { getLastScans, listApplications, listProjects } from '../cxone/projects.js';
import { createRiskSource } from '../cxone/risks.js';
import { mapWithConcurrency } from '../cxone/client.js';
import { CREDIT_COST } from '../credits.js';
import { remediable, remediationCandidates } from '../credit-allocations.js';
import { validLogin } from '../github/identity.js';
import { projectUrl, riskUrl } from '../links.js';
import { apiPath } from '../settings.js';
import { PROBE_DEFAULTS, probeFusion } from '../fusion.js';
import { aiFindings, cleanEngines as cleanFusionEngines, readRiskFusion } from '../fusion-ai.js';
import { DEFAULT_PERIOD as FUSION_PERIOD, USAGE_PERIODS, fusionUsage, projectFacts, scanTypeOf, scanTypes, tenantAi } from '../fusion-usage.js';
import { globMatch } from '../../public/calculator/model.js';
import { logSafe } from './shared.js';

/**
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerFusionRoutes(app, d) {
  const {
    settingsStore, creditLedger, allocations, creditView, asyncRoute, can, requirePermission, requireFeature,
    activeConfig, afterFetch, adminActor, stateCache, projectStates, scanProjects, cleanSeverities, notifyOnBehalf,
    VERIFY_AT_ONCE, adminTriage, adminRemediate, goneText, allocateNeeded, kindsOf, tenantCreditsOf, creditPool,
  } = d;

  /** Usernames worth matching: scan initiators that are not already addresses. */
  function initiatorLogins(lastScan) {
    const logins = new Set();
    for (const info of Object.values(lastScan?.initiators ?? {})) {
      const name = String(info?.initiator ?? '').trim();
      if (name && !name.includes('@') && validLogin(name)) logins.add(name);
    }
    return [...logins];
  }

  /**
   * Fusion results (Labs, src/fusion.js): Fusion's results only, worked on only, with the page's own
   * line (applications and projects by name) and its own fetch, apart from the Workbench's. Kept with
   * the session (session.fusionScope and session.lastFusion).
   */
  /** Each Fusion result's link in Checkmarx One: its project's Risk Hub with the risk open, as the Workbench links it. */
  function linkFusion(req, fusion) {
    const { links } = settingsStore.get();
    for (const r of fusion?.results ?? []) {
      if (!r.projectId || r.projectId.startsWith('app:')) continue;
      r.url = riskUrl({ projectId: r.projectId, id: r.riskId || r.resultId, scanner: r.scanner || 'SAST' }, req.session.connection, links, r.scanId);
    }
    // Each project's own page in Checkmarx One, to go into its detail there.
    for (const [projectId, p] of Object.entries(fusion?.projects ?? {})) p.url = projectUrl({ projectId }, req.session.connection, links);
    return fusion;
  }

  /**
   * Fusion (AI-generated SAST results, src/fusion-ai.js) for these projects, from each one's latest completed
   * scan; kept with the session, with the results as findings the credit, triage and remediation code acts on.
   */
  /**
   * The credits a project's latest AI scan used: none for a LAST scan, nor for a Fusion scan whose steps say Fusion
   * credits are disabled; otherwise the Fusion credits it used over the last year per AI scan (Checkmarx One does not
   * say a scan's own), marked an estimate; null when not known.
   */
  function scanCreditsOf(project, used) {
    if (project.scanType === 'last' || project.fusionCredits === 'off') return { credits: 0, estimate: false };
    if (used?.perScan !== null && used?.perScan !== undefined) return { credits: used.perScan, estimate: true };
    return null;
  }

  async function loadAiFusion(req, names) {
    const ids = Object.keys(names);
    const client = req.session.client;
    const scans = await getLastScans(client, ids);
    const trace = fusionTrace(req);
    // First, which latest scans ran the AI engine at all: from their engines, else a hundred scans to a call. Only
    // those are read further (most of a tenant's projects never ran it).
    const kinds = await scanTypes(client, Object.fromEntries(ids.filter((id) => scans[id]).map((id) => [id, scans[id]])), { background: false, trace }).catch(() => ({}));
    const aiScanned = ids.filter((id) => scans[id] && kinds[id] !== 'none');
    // Each of those: Fusion or LAST (its settings say), its model and where that was set, its lines of code. The
    // tenant's AI settings and credits beside them, at the same time.
    const [facts, ai, credits] = await Promise.all([
      projectFacts(client, aiScanned, scans, { trace, concurrency: 8 }).catch((error) => (console.warn(`[fusion] facts: ${logSafe(error.message)}`), {})),
      tenantAi(client, { trace }).catch(() => null),
      tenantCreditsOf(req, { fresh: true }),
    ]);
    const types = Object.fromEntries(ids.map((id) => [id, facts[id]?.scanType ?? kinds[id] ?? scanTypeOf(scans[id]?.engines, null)]));
    // The AI-scanned projects' Risk Hub lists, as the Workbench reads them; and, at the same time, the Fusion credits
    // each used per AI scan over the last year (for what its latest scan cost).
    const riskSource = createRiskSource(client, activeConfig());
    const [read, usage] = await Promise.all([
      readRiskFusion(client, ids.map((id) => ({ id, name: names[id] })), scans, { types, riskSource, trace, concurrency: 8 }),
      fusionUsage(client, aiScanned.map((id) => ({ id, name: names[id] })), { period: 'last_year', scopeIds: ids, trace }).catch((error) => (console.warn(`[fusion] usage: ${logSafe(error.message)}`), null)),
    ]);
    const fusion = linkFusion(req, read);
    for (const [id, f] of Object.entries(facts)) if (fusion.projects[id]) Object.assign(fusion.projects[id], f, { scanType: fusion.projects[id].scanType });
    // Fusion credits: whether the tenant charges them, as the latest Fusion scans' steps say.
    const charged = Object.values(facts).map((f) => f.fusionCredits).filter(Boolean);
    fusion.tenant = { ai, credits, fusionCredits: charged.includes('reserved') ? 'reserved' : charged.length ? 'off' : '' };
    // Their AI scans and credits over the year, kept to the projects shown.
    if (usage?.projects) {
      for (const id of Object.keys(usage.projects)) if (!fusion.projects[id]) delete usage.projects[id];
      usage.totals = Object.values(usage.projects).reduce((t, u) => ({ scans: t.scans + (u.scans ?? 0), fusionScans: t.fusionScans + (u.fusionScans ?? 0), lastScans: t.lastScans + (u.lastScans ?? 0), credits: t.credits + (u.credits ?? 0), fusion: t.fusion + (u.fusion ?? 0) }), { scans: 0, fusionScans: 0, lastScans: 0, credits: 0, fusion: 0 });
    }
    fusion.usage = usage;
    for (const [id, p] of Object.entries(fusion.projects)) p.scanCredits = scanCreditsOf(p, fusion.usage?.projects?.[id]);
    req.session.lastFusion = fusion;
    req.session.fusionScan = aiFindings(fusion);
    // A new read: the projects shown are the page's again; the Fusion and LAST ticks stay.
    if (req.session.fusionFocus) req.session.fusionFocus.projectIds = null;
    return fusion;
  }

  /**
   * What the page's credits and actions are for: the results of the engines ticked (Fusion, LAST or both) in the
   * projects it shows (null: every one loaded). Taken from the request when it says, kept with the session.
   */
  function fusionFocus(req) {
    const body = req.body ?? {};
    // A project's side panel asks for that project alone, without changing what the page's bar acts on.
    if (body.once === true) return { engines: cleanFusionEngines(body.engines), projectIds: Array.isArray(body.projectIds) ? body.projectIds.map((id) => String(id ?? '').slice(0, 80)).filter(Boolean).slice(0, 50) : null };
    const focus = (req.session.fusionFocus ??= { engines: cleanFusionEngines(), projectIds: null });
    if ('engines' in body) focus.engines = cleanFusionEngines(body.engines);
    if ('projectIds' in body) focus.projectIds = Array.isArray(body.projectIds) ? [...new Set(body.projectIds.map((id) => String(id ?? '').slice(0, 80)).filter(Boolean))].slice(0, 5000) : null;
    return focus;
  }

  app.get('/api/beta/fusion', requireFeature('fusionResults'), (req, res) => {
    res.json({ fusion: req.session.lastFusion ?? null, scope: req.session.fusionScope ?? null, focus: fusionFocus(req), credits: fusionCredits(req) });
  });

  // The AI scans and credits over another period (the page's period picker), for the projects loaded.
  app.post('/api/beta/fusion/usage', requireFeature('fusionResults'), asyncRoute(async (req, res) => {
    const fusion = req.session.lastFusion;
    if (!fusion) return res.status(409).json({ error: 'Load results first.' });
    const period = USAGE_PERIODS[req.body?.period] ? req.body.period : FUSION_PERIOD;
    req.session.fusionPeriod = period;
    const names = req.session.fusionScope?.names ?? {};
    fusion.usage = await fusionUsage(req.session.client, Object.keys(fusion.projects).map((id) => ({ id, name: names[id] ?? fusion.projects[id].projectName })), { period, scopeIds: Object.keys(names), trace: fusionTrace(req) });
    res.json({ usage: fusion.usage });
  }));

  // The credits the page's lanes show, for what it shows now (the ticks, and the projects its filters leave).
  app.post('/api/beta/fusion/credits', requireFeature('fusionResults'), (req, res) => {
    res.json({ focus: fusionFocus(req), credits: fusionCredits(req) });
  });

  // ---- Troubleshooting Fusion (Admins who manage the Checkmarx One integration): test paths, and a
  // debug log of every Fusion call in full (the access token never in it), kept with the session only.
  const FUSION_LOG_MAX = 100;
  const fusionDebugOf = (req) => (req.session.fusionDebug ??= { on: false, log: [] });
  /** Where a Fusion call's full exchange goes while debug mode is on (null when off). */
  function fusionTrace(req, always = null) {
    const debug = req.session.fusionDebug;
    if (!debug?.on && !always) return null;
    return (entry) => {
      always?.push(entry);
      if (debug?.on) {
        debug.log.push(entry);
        if (debug.log.length > FUSION_LOG_MAX) debug.log.splice(0, debug.log.length - FUSION_LOG_MAX);
      }
    };
  }

  app.get('/api/beta/fusion/debug', requireFeature('fusionResults'), requirePermission('integration.cxone'), (req, res) => {
    const { endpoints = {} } = settingsStore.get();
    const debug = fusionDebugOf(req);
    res.json({ on: debug.on, log: debug.log, defaults: PROBE_DEFAULTS, pinned: { results: endpoints.fusionResultsPath ?? '', dispatcher: endpoints.fusionDispatcherPath ?? '' } });
  });

  app.put('/api/beta/fusion/debug', requireFeature('fusionResults'), requirePermission('integration.cxone'), (req, res) => {
    const debug = fusionDebugOf(req);
    if ('on' in (req.body ?? {})) debug.on = req.body.on === true;
    if (req.body?.clear === true) debug.log = [];
    res.json({ on: debug.on, log: debug.log });
  });

  app.post('/api/beta/fusion/probe', requireFeature('fusionResults'), requirePermission('integration.cxone'), asyncRoute(async (req, res) => {
    const asked = (Array.isArray(req.body?.paths) ? req.body.paths : []).map((p) => String(p ?? '').trim()).filter(Boolean);
    if (!asked.length) return res.status(400).json({ error: 'Enter at least one path to test.' });
    if (asked.length > 20) return res.status(400).json({ error: 'Test at most 20 paths at a time.' });
    const bad = asked.filter((p) => !apiPath(p));
    if (bad.length) return res.status(400).json({ error: `Only paths under /api on this Checkmarx One, without a query: ${bad.slice(0, 3).join(', ')}` });
    // {appId}: an application holding a fetched project, else the tenant's first.
    const appId = req.session.lastFusion?.applications?.[0]?.id
      ?? (await listApplications(req.session.client, { maxItems: 1 }).catch(() => []))[0]?.id ?? '';
    const exchanges = [];
    const results = await probeFusion(req.session.client, asked, { appId, trace: fusionTrace(req, exchanges) });
    res.json({ appId, results, exchanges });
  }));

  // ---- Acting on Fusion's results: the same allocate / triage / remediate as a tracked report's Triage tab,
  // for Admins, on only the fetched findings Fusion re-scored (matched by result id; severities are the
  // findings' own in Checkmarx One, which credits and AI Triage go by).

  /** A result id as Fusion and the results API may write it (URL-encoded once or twice), plain. */
  const plainId = (id) => {
    let s = String(id ?? '');
    for (let i = 0; i < 2; i += 1) {
      try {
        const d = decodeURIComponent(s);
        if (d === s) break;
        s = d;
      } catch {
        break;
      }
    }
    return s;
  };

  /** Which loaded results the page acts on (the engines ticked, the projects shown): (projectId, finding) → true. */
  function fusionKeep(req) {
    const { engines, projectIds: shown } = fusionFocus(req);
    const only = shown ? new Set(shown) : null;
    const ids = new Map();
    for (const r of req.session.lastFusion?.results ?? []) {
      if (!r.projectId || !r.resultId) continue;
      if ((r.engine && !engines.includes(r.engine)) || (only && !only.has(r.projectId))) continue;
      if (!ids.has(r.projectId)) ids.set(r.projectId, new Set());
      ids.get(r.projectId).add(plainId(r.resultId));
    }
    const keep = (projectId, r) => {
      const set = ids.get(projectId);
      return Boolean(set && [r.riskId, r.alternateId, r.similarityId].some((id) => id && set.has(plainId(id))));
    };
    return { keep, projectIds: [...ids.keys()] };
  }

  const FUSION_RECENT_MS = 30 * 60 * 1000;

  /** The projects whose Fusion results are acted on: those the Fusion page loaded (else the Workbench's fetch). */
  const fusionProjects = (req, projectIds) => (req.session.fusionScan?.projects ?? scanProjects(req, projectIds)).filter((p) => projectIds.includes(p.projectId));
  /** Each project's scan the results come from, for AI Triage and AI Remediation. */
  const fusionInitiators = (req) => ({ ...(req.session.lastScan?.initiators ?? {}), ...(req.session.fusionScan?.initiators ?? {}) });

  /** The Fusion page's two lanes: credits needed by severity (1 to triage, 3 to remediate) and what its projects hold. */
  function fusionCredits(req) {
    const { keep, projectIds } = fusionKeep(req);
    const projects = fusionProjects(req, projectIds);
    const triage = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    const remediation = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    const left = { triage: 0, remediation: 0 };
    let matched = 0;
    const { allowReremediation = false } = settingsStore.get().aiTriage ?? {};
    for (const p of projects) {
      const remediated = allowReremediation ? new Set() : creditLedger.remediatedIds(p.projectId);
      for (const r of p.risks ?? []) {
        if (!keep(p.projectId, r) || !(r.severity in triage)) continue;
        matched += 1;
        const recent = r.triageRequestedAt && Date.now() - r.triageRequestedAt < FUSION_RECENT_MS;
        if ((!r.state || r.state === 'TO_VERIFY') && !recent) triage[r.severity] += 1;
        if (remediable(r) && !remediated.has(r.riskId)) remediation[r.severity] += CREDIT_COST.remediation;
      }
      const balance = allocations.balance(p.projectId);
      left.triage += balance.triage.remaining;
      left.remediation += balance.remediation.remaining;
    }
    // What projects already hold and have not used, beside what the tenant has left in Checkmarx One (as last read).
    const pool = creditPool();
    return { triage, remediation, left, matched, projects: projects.length, held: pool.outstanding.total, pool: { limited: pool.limited, size: pool.size, unallocated: pool.unallocated }, tenant: req.session.tenantCredits?.value ?? null };
  }

  /** Admins only (those who set the credit pool), with the Beta feature. */
  function requireFusionAdmin(req, res, next) {
    if (can(req, 'credits.limit')) return next();
    res.status(403).json({ error: 'Only an Admin can allocate credits or run AI on Fusion results.', permission: 'credits.limit' });
  }

  app.post('/api/beta/fusion/allocate', requireFeature('fusionResults'), requirePermission('credits.allocate'), requireFusionAdmin, afterFetch, asyncRoute(async (req, res) => {
    if (!req.session.lastFusion) return res.status(409).json({ error: 'Read Fusion first.' });
    const wanted = cleanSeverities(req.body?.severities);
    if (!wanted.length) return res.status(400).json({ error: 'Pick severities to allocate for.' });
    const { keep, projectIds } = fusionKeep(req);
    const projects = fusionProjects(req, projectIds);
    if (!projects.length) return res.status(409).json({ error: 'None of the loaded projects has Fusion results.' });
    const done = await allocateNeeded(req, projects, {
      wanted, extraTriage: 0, extraRemediation: 0, kinds: kindsOf(req.body?.kind), keep, where: 'Labs → Fusion results',
      details: { projectIds: projects.map((p) => p.projectId), kind: req.body?.kind ?? 'both', fusion: true },
    });
    if (done.error) return res.status(409).json(done);
    for (const p of projects) p.credits = creditView(p);
    res.json({ credits: fusionCredits(req), gone: done.gone, goneNote: done.gone.length ? `Skipped: ${goneText(done.gone)}` : '' });
  }));

  app.post('/api/beta/fusion/triage', requireFeature('fusionResults'), requirePermission('triage.run'), requireFusionAdmin, afterFetch, asyncRoute(async (req, res) => {
    if (!req.session.lastFusion) return res.status(409).json({ error: 'Read Fusion first.' });
    const wanted = cleanSeverities(req.body?.severities);
    if (!wanted.length) return res.status(400).json({ error: 'Pick at least one severity to triage.' });
    const { keep, projectIds } = fusionKeep(req);
    const projects = fusionProjects(req, projectIds);
    const candidate = (p, r) => keep(p.projectId, r) && wanted.includes(r.severity) && (!r.state || r.state === 'TO_VERIFY');
    const lives = await mapWithConcurrency(projects, VERIFY_AT_ONCE, async (p) => ((p.risks ?? []).some((r) => candidate(p, r)) ? projectStates(req.session, p.projectId).catch(() => null) : null));
    const originals = new Map();
    const findings = [];
    for (const [i, p] of projects.entries()) {
      for (const r of p.risks ?? []) {
        if (!keep(p.projectId, r) || !wanted.includes(r.severity)) continue;
        const state = lives[i]?.get(r.riskId) ?? r.state;
        if (state && state !== 'TO_VERIFY') continue;
        if (r.triageRequestedAt && Date.now() - r.triageRequestedAt < FUSION_RECENT_MS) continue;
        const copy = { ...r, projectId: p.projectId, projectName: p.projectName };
        originals.set(copy, r);
        findings.push(copy);
      }
    }
    if (!findings.length) return res.json({ requested: 0, started: 0, failed: 0, skipped: 0, errors: [], credits: fusionCredits(req) });
    const actor = await adminActor(req);
    const outcome = await adminTriage(req.session, findings, fusionInitiators(req), { actor, origin: `Labs → Fusion results: triage ${wanted.map((s) => s.toLowerCase()).join(', ')}` });
    for (const f of outcome.startedFindings) originals.get(f).triageRequestedAt = Date.now();
    for (const p of projects) p.credits = creditView(p);
    const { startedFindings, ...summary } = outcome;
    const notified = req.body?.notifyInitiators === false ? null : await notifyOnBehalf(req.session, 'triage', startedFindings, fusionInitiators(req), actor);
    res.json({ ...summary, notified, credits: fusionCredits(req) });
  }));

  app.post('/api/beta/fusion/remediate', requireFeature('fusionResults'), requirePermission('triage.run'), requireFusionAdmin, afterFetch, asyncRoute(async (req, res) => {
    if (!req.session.lastFusion) return res.status(409).json({ error: 'Read Fusion first.' });
    const wanted = cleanSeverities(req.body?.severities);
    if (!wanted.length) return res.status(400).json({ error: 'Pick at least one severity to remediate.' });
    const { keep, projectIds } = fusionKeep(req);
    const projects = fusionProjects(req, projectIds);
    const { allowReremediation = false } = settingsStore.get().aiTriage ?? {};
    const findings = [];
    for (const p of projects) {
      if (!(p.risks ?? []).some((r) => keep(p.projectId, r) && wanted.includes(r.severity))) continue;
      stateCache.delete(p.projectId);
      const live = await projectStates(req.session, p.projectId).catch(() => null);
      const remediated = allowReremediation ? new Set() : creditLedger.remediatedIds(p.projectId);
      for (const r of p.risks ?? []) {
        if (!keep(p.projectId, r)) continue;
        const state = live?.get(r.riskId) ?? r.state;
        if (state && state !== r.state) r.state = state;
        if (remediable({ ...r, state }) && !remediated.has(r.riskId)) findings.push({ ...r, projectId: p.projectId, projectName: p.projectName });
      }
    }
    const unique = remediationCandidates(findings, wanted);
    if (!unique.length) return res.json({ requested: 0, started: 0, failed: 0, skipped: 0, errors: [], credits: fusionCredits(req) });
    const actor = await adminActor(req);
    const { startedFindings, ...summary } = await adminRemediate(req.session, unique, fusionInitiators(req), { actor, origin: `Labs → Fusion results: remediate the confirmed ${wanted.map((s) => s.toLowerCase()).join(', ')}` });
    for (const p of projects) p.credits = creditView(p);
    const notified = req.body?.notifyInitiators === false ? null : await notifyOnBehalf(req.session, 'remediation', startedFindings, fusionInitiators(req), actor);
    res.json({ ...summary, notified, credits: fusionCredits(req) });
  }));

  app.post(
    '/api/beta/fusion/read',
    requireFeature('fusionResults'),
    asyncRoute(async (req, res) => {
      // Read again for what the page's line last loaded.
      const scope = req.session.fusionScope;
      if (!scope?.projects) return res.status(400).json({ error: 'Choose applications or projects above, then Load Fusion results.' });
      const fusion = await loadAiFusion(req, scope.names);
      res.json({ fusion, scope, credits: fusionCredits(req) });
    }),
  );

  /**
   * The Fusion page's own fetch: the projects of the applications named, plus the projects named (names or ids,
   * `*` and `?` as wildcards); nothing named is every project. Only Fusion's results are read for them.
   */
  app.post(
    '/api/beta/fusion/fetch',
    requireFeature('fusionResults'),
    asyncRoute(async (req, res) => {
      const names = (value) => (Array.isArray(value) ? value : String(value ?? '').split(','))
        .map((v) => String(v).trim().slice(0, 200))
        .filter(Boolean)
        .slice(0, 50);
      const wantedApps = names(req.body?.applications);
      const wantedProjects = names(req.body?.projects);
      const matches = (list, item) => list.some((n) => n === item.id || globMatch(n, item.name));
      const client = req.session.client;
      const [projects, apps] = await Promise.all([listProjects(client), listApplications(client).catch(() => [])]);
      const byId = new Map(projects.map((p) => [p.id, p]));
      const ids = new Set();
      if (!wantedApps.length && !wantedProjects.length) for (const p of projects) ids.add(p.id);
      for (const a of apps) if (matches(wantedApps, a)) for (const id of a.projectIds) ids.add(id);
      for (const p of projects) if (matches(wantedProjects, p)) ids.add(p.id);
      if (!ids.size) return res.status(400).json({ error: 'No application or project has those names.' });
      const scope = {
        projects: ids.size,
        openFindings: 0,
        bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
        names: Object.fromEntries([...ids].map((id) => [id, byId.get(id)?.name ?? id])),
        fetchedAt: new Date().toISOString(),
        own: { applications: wantedApps, projects: wantedProjects },
      };
      req.session.fusionScope = scope;
      const fusion = await loadAiFusion(req, scope.names);
      res.json({ fusion, scope, credits: fusionCredits(req) });
    }),
  );

  return { initiatorLogins };
}
