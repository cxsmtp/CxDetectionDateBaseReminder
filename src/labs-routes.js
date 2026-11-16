/**
 * Labs → Status board and Labs → Consolidated view (Beta): their routes, and the few hooks the Workbench fetch calls
 * (registered by one call in src/server.js).
 *
 * Status board (feature:statusBoard): GET /api/status-board reads the session's last Workbench fetch; the side panel's
 * GET /api/status-board/projects/:id/scans reads one project's last five scans, kept (a completed scan never changes).
 *
 * Consolidated view (feature:consolidated, and the per-person grant consolidated.view): GET /api/consolidated and
 * /api/consolidated/{summary,projects,status-board} read each tenant's own in-memory state (the copy of its last
 * Workbench fetch, its last-read credits, its credit pool, Govern's view): no Checkmarx One call, no write to a
 * tenant but one line in each tenant's audit log per call. PUT /api/iam/users/:id/consolidated is the Admin's tick.
 *
 * The view loads tenants itself (from MZ-01.01.14): POST /api/consolidated/load starts, in each tenant asked for, a
 * read of every open finding with that tenant's stored Checkmarx One connection, and of its Checkmarx One credits;
 * GET /api/consolidated/load says how far each has got. It needs Fetch findings as well as the view, changes nothing
 * in Checkmarx One, and writes one line to each tenant's audit log.
 */
import { TtlCache } from './ttl-cache.js';
import { listApplications } from './cxone/projects.js';
import { safeUrl } from './links.js';
import { FAILED_DAYS, applicationsByProject, boardFigures, boardOf, failedScansSince, recentScans } from './status-board.js';
import { tenantColours } from '../public/tenant-colour.js';
import { consolidatedFigures, crossProjects, governSummary, tenantHealth, tenantSummary, workbenchSnapshot } from './consolidated.js';
import { tenantCredits } from './fusion-usage.js';
import { DEFAULT_ENGINES } from './engines.js';

/** A load that has not finished after this long is taken to have died (the server keeps none across a restart). */
const LOAD_LOCK_MS = 30 * 60_000;
/** Tenants loaded at once: each has its own Checkmarx One, so the limit is this server's own work. */
const LOADS_AT_ONCE = 2;
/**
 * What the consolidated view loads in a tenant: every open finding of the engines AI works on, on each project's
 * primary branch, for projects scanned in the last 90 days (the Workbench's own starting scope, at any age).
 */
const LOAD_SCOPE = Object.freeze({ engines: DEFAULT_ENGINES.join(','), activityPreset: '90d', detectionPreset: 'any' });

/** How long the tenant-wide reads the fetch adds are kept (per Checkmarx One key). */
const APPLICATIONS_MS = 5 * 60_000;
const FAILED_MS = 2 * 60_000;
/** One project's last scans (the side panel). */
const SCANS_MS = 10 * 60_000;

/**
 * @param {import('express').Express} app
 * @param {object} d  what the server lends: its guards, tenancy, audit and credit helpers
 */
export function registerLabsRoutes(app, d) {
  const { requireFeature, requirePermission, asyncRoute, tenancy, featureLocked } = d;
  const reads = new TtlCache({ max: 2_000 });
  const scans = new TtlCache({ max: 5_000 });
  const unlocked = (id) => !featureLocked(id);
  const stateOf = (id) => tenancy.loaded().find((c) => c.id === id)?.state ?? null;

  // ---- Hooks for the Workbench fetch -------------------------------------------------------------------------

  /** Whether the fetch should read the board's facts (only while one of the two pages is unlocked). */
  const factsWanted = () => unlocked('statusBoard') || unlocked('consolidated');

  /**
   * The tenant-wide facts the board adds to a fetch: each project's applications, and the scans that failed in the
   * last FAILED_DAYS days. Each is cached per Checkmarx One key and fails quietly (null: not known).
   */
  async function readFacts(client, identity) {
    if (!factsWanted() || !client) return { applications: null, failed: null };
    const key = identity || 'anonymous';
    const since = new Date(Date.now() - FAILED_DAYS * 86_400_000).toISOString();
    const [applications, failed] = await Promise.all([
      reads.wrap(`apps|${key}`, async () => applicationsByProject(await listApplications(client)), APPLICATIONS_MS).catch(() => null),
      reads.wrap(`failed|${key}`, () => failedScansSince(client, { since, background: false }), FAILED_MS).catch(() => null),
    ]);
    return { applications, failed };
  }

  /** A fetch finished in the running tenant: keep a slim copy for the consolidated view and the tenant switcher. */
  function noteFetch(req, result, projectsTotal, { narrowed = false } = {}) {
    const state = tenancy.current().state;
    const by = req.user?.email ?? '';
    // A load narrowed to an age, a search or named projects is that person's Workbench data, not the tenant's figures:
    // the copy kept from a whole load stays (the view then says how old it is, and loads the tenant again itself).
    if (narrowed) return;
    // Kept whether or not the view is unlocked yet (a row per project, no findings): unlocking it later shows them at once.
    state.workbench = workbenchSnapshot(result, { by, projectsTotal });
  }

  /** A fetch failed in the running tenant. */
  function noteFetchFailed(error) {
    // Checkmarx One's own answers (they carry a status) are shown; anything else stays in the server log.
    const expected = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600;
    const message = expected ? String(error.message ?? '').slice(0, 300) : 'Something went wrong on the server. The details are in its log.';
    tenancy.current().state.workbenchError = { at: new Date().toISOString(), message };
  }

  /** The Checkmarx One credits the running tenant has just read. */
  function noteCredits(value) {
    if (value) tenancy.current().state.cxCredits = { at: Date.now(), value };
  }

  /** For the tenant switcher: when a tenant last fetched, and whether that failed (loaded tenants only). */
  function fetchInfo(id) {
    const state = stateOf(id);
    const at = state?.workbench?.at ?? null;
    const failedAt = state?.workbenchError?.at ?? null;
    return { colour: tenantColours(tenancy.ids())[id] ?? 0, fetchedAt: at, fetchFailed: Boolean(failedAt && (!at || Date.parse(failedAt) > Date.parse(at))) };
  }

  // ---- Status board ------------------------------------------------------------------------------------------

  const boardGuard = [requireFeature('statusBoard'), requirePermission('findings.fetch')];

  app.get('/api/status-board', ...boardGuard, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const board = boardOf(req.session.lastScan);
    res.json({ board, connected: Boolean(req.session.client), fetching: d.fetchInProgress(req.session) });
  });

  /** A Checkmarx One link to one scan (its results), or to the project's page when the scan did not complete. */
  function scanLink(req, row, scan) {
    const base = String(d.linkBase(req) ?? '').replace(/\/+$/, '');
    if (!base) return '';
    if (/completed/i.test(scan.status)) return safeUrl(`${base}/results/${encodeURIComponent(scan.id)}/${encodeURIComponent(row.projectId)}/sast`);
    return row.url || '';
  }

  app.get('/api/status-board/projects/:id/scans', ...boardGuard, asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const board = boardOf(req.session.lastScan);
    const row = board?.rows.find((r) => r.projectId === String(req.params.id ?? ''));
    if (!row) return res.status(404).json({ error: 'That project is not in the data loaded on the Workbench.' });
    const client = req.session.client;
    if (!client) return res.status(409).json({ error: 'Not connected to Checkmarx One.' });
    // Kept per key, project and latest scan: a new scan (or a new failure) reads them again.
    const key = `${d.identityOf(req.session) || 'anonymous'}|${row.projectId}|${row.scanId}|${row.failed?.at ?? ''}`;
    try {
      const list = await scans.wrap(key, () => recentScans(client, row.projectId, { limit: 5 }), SCANS_MS);
      res.json({ projectId: row.projectId, name: row.name, url: row.url, scans: list.map((s) => ({ ...s, url: scanLink(req, row, s) })) });
    } catch (error) {
      res.status(502).json({ error: `Checkmarx One did not list this project's scans: ${String(error.message ?? '').slice(0, 200)}` });
    }
  }));

  // ---- Consolidated view -------------------------------------------------------------------------------------

  const viewGuard = [requireFeature('consolidated'), requirePermission('consolidated.view')];

  /** The tenants this person may see (every one they work in), each with what it holds in memory. */
  function gather(req) {
    const ids = d.tenantsOf(req.user, req.permissions);
    const governLocked = featureLocked('govern');
    // Colours in the server's order of tenants: the same for everyone, never two alike side by side.
    const colours = tenantColours(tenancy.ids());
    return ids.map((id) => {
      const context = tenancy.context(id);
      const state = context.state ?? {};
      let pool = null;
      try {
        pool = tenancy.run(id, () => d.creditPool());
      } catch {}
      const summary = tenantSummary({
        id,
        name: d.tenantName(id),
        colour: colours[id],
        snapshot: state.workbench ?? null,
        error: state.workbenchError ?? null,
        credits: state.cxCredits?.value ?? null,
        pool,
        govern: governSummary(context, { locked: governLocked }),
      });
      summary.loading = loadView(loadOf(state));
      return { id, context, summary, snapshot: state.workbench ?? null };
    });
  }

  /** Every call is in each tenant's own audit log. */
  async function audited(req, what, tenants) {
    const actor = await d.adminActor(req);
    for (const t of tenants) {
      try {
        t.context.audit.record({ type: 'access', outcome: 'info', reason: `Viewed in the consolidated view by ${req.user.email} (${what}).`, actor, details: { consolidated: { view: what, tenants: tenants.length } } });
      } catch (error) {
        console.warn(`! [consolidated] audit in ${String(t.id).replace(/[^\w.-]/g, '_')}: ${String(error.message ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 200)}`);
      }
    }
  }

  const summaryOf = (tenants) => {
    const list = tenants.map((t) => t.summary);
    return { figures: consolidatedFigures(list), tenants: list };
  };
  const projectsOf = (tenants) => crossProjects(tenants.map((t) => ({ id: t.id, name: t.summary.name, colour: t.summary.colour, snapshot: t.snapshot })));
  const statusOf = (tenants) => ({ boards: tenants.map((t) => ({ id: t.id, name: t.summary.name, colour: t.summary.colour, health: t.summary.health, figures: boardFigures(t.snapshot?.rows ?? []) })) });

  // ---- Loading tenants from the view itself ------------------------------------------------------------------

  const loadGuard = [...viewGuard, requirePermission('findings.fetch')];
  /** The load under way in a tenant's state, or null (one that never finished is forgotten after LOAD_LOCK_MS). */
  const loadOf = (state) => (state?.workbenchLoad && Date.now() - state.workbenchLoad.startedAt < LOAD_LOCK_MS ? state.workbenchLoad : null);
  const loadView = (load) => (load ? { startedAt: new Date(load.startedAt).toISOString(), by: load.by, done: load.done, total: load.total, waiting: load.waiting === true } : null);
  /** Loads wait here for a free place (LOADS_AT_ONCE): a queue of functions that start one. */
  const waiting = [];
  let running = 0;
  const next = () => {
    while (running < LOADS_AT_ONCE && waiting.length) {
      running += 1;
      waiting.shift()().finally(() => {
        running -= 1;
        next();
      });
    }
  };

  /**
   * Read one tenant, as its Workbench would with nothing narrowed, with the tenant's own stored connection: the slim
   * copy is kept by the fetch itself (noteFetch), then the tenant's Checkmarx One credits are read. What goes wrong
   * is kept for the card (noteFetchFailed); nothing is thrown.
   */
  async function loadTenant(id, load) {
    await tenancy.run(id, async () => {
      const state = tenancy.current().state;
      load.waiting = false;
      load.startedAt = Date.now();
      try {
        const integration = await d.resolveAutomationSession();
        if (!integration?.client) throw Object.assign(new Error('This tenant has no stored Checkmarx One connection. Open the tenant and connect it once under Settings → Checkmarx One.'), { status: 409 });
        // A session of its own for this read: the findings are let go once the slim copy is made.
        const session = { client: integration.client, connection: integration.connection };
        await d.runScan({ session, user: { email: load.by }, query: { ...LOAD_SCOPE } }, { onStart: ({ total }) => (load.total = total), onProject: () => (load.done += 1) });
        noteCredits(await tenantCredits(integration.client, { background: false }).catch(() => null));
      } catch (error) {
        const expected = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600;
        if (!expected) console.warn(`! [consolidated] loading ${String(id).replace(/[^\w.-]/g, '_')}: ${String(error?.stack ?? error?.message ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 400)}`);
        noteFetchFailed(error);
      } finally {
        if (state.workbenchLoad === load) state.workbenchLoad = null;
      }
    });
  }

  /** How far each of this person's tenants has got: read from memory, so the page may ask every few seconds. */
  app.get('/api/consolidated/load', ...viewGuard, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const tenants = d.tenantsOf(req.user, req.permissions).map((id) => {
      const state = tenancy.context(id).state ?? {};
      return { id, health: tenantHealth(state.workbench ?? null, state.workbenchError ?? null), loading: loadView(loadOf(state)), fetchedAt: state.workbench?.at ?? null };
    });
    res.json({ tenants, canLoad: req.permissions.has('findings.fetch') });
  });

  /**
   * Load tenants: { tenants: [ids] } for those named, else every tenant this person works in; { only: 'missing' }
   * keeps to those never loaded or not loaded for a day (what the page asks for by itself when it is opened). A
   * tenant already being loaded is left to finish. Answers at once; the loads go on behind.
   */
  app.post('/api/consolidated/load', ...loadGuard, asyncRoute(async (req, res) => {
    const mine = d.tenantsOf(req.user, req.permissions);
    const asked = Array.isArray(req.body?.tenants) ? req.body.tenants.map((id) => String(id)).filter((id) => mine.includes(id)) : mine;
    const onlyMissing = req.body?.only === 'missing';
    const actor = await d.adminActor(req);
    const started = [];
    const skipped = [];
    for (const id of [...new Set(asked)]) {
      const context = tenancy.context(id);
      const state = context.state;
      const health = tenantHealth(state.workbench ?? null, state.workbenchError ?? null);
      if (loadOf(state) || (onlyMissing && health !== 'notLoaded' && health !== 'stale')) {
        skipped.push(id);
        continue;
      }
      const load = (state.workbenchLoad = { startedAt: Date.now(), by: req.user.email, done: 0, total: null, waiting: true });
      try {
        context.audit.record({ type: 'access', outcome: 'info', reason: `Findings and credits read for the consolidated view, asked by ${req.user.email}${onlyMissing ? ' (on opening the view)' : ''}.`, actor, details: { consolidated: { load: true } } });
      } catch {}
      waiting.push(() => loadTenant(id, load));
      started.push(id);
    }
    next();
    res.status(202).json({ started, skipped });
  }));

  const route = (path, what, build) =>
    app.get(path, ...viewGuard, asyncRoute(async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const tenants = gather(req);
      await audited(req, what, tenants);
      res.json({ readAt: new Date().toISOString(), current: req.tenantId, canLoad: req.permissions.has('findings.fetch'), ...build(tenants) });
    }));

  route('/api/consolidated', 'overview, projects, Fusion, credits and status board', (tenants) => ({ ...summaryOf(tenants), projects: projectsOf(tenants), ...statusOf(tenants) }));
  route('/api/consolidated/summary', 'summary', (tenants) => summaryOf(tenants));
  route('/api/consolidated/projects', 'projects', (tenants) => ({ projects: projectsOf(tenants) }));
  route('/api/consolidated/status-board', 'status board', (tenants) => ({ ...statusOf(tenants), rows: projectsOf(tenants) }));

  /** An Admin lets a person see the consolidated view (all connected tenants they work in), or not. */
  app.put('/api/iam/users/:id/consolidated', requirePermission('iam.manage'), asyncRoute(async (req, res) => {
    if (featureLocked('consolidated')) return res.status(403).json({ error: '“Consolidated view” needs its activation code (Settings → Activation codes).', locked: true });
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an Admin can let someone see the consolidated view.' });
    const user = d.visibleUser(req, req.params.id);
    const on = req.body?.on === true;
    const { before, after } = d.iam.setConsolidated(user.id, on);
    if (before.consolidated !== after.consolidated) await d.auditIam(req, `${after.email} ${on ? 'may now see' : 'may no longer see'} the consolidated view (every tenant they work in, read only).`, { before: { consolidated: before.consolidated }, after: { consolidated: after.consolidated } });
    res.json(d.iamView(req));
  }));

  return { factsWanted, readFacts, noteFetch, noteFetchFailed, noteCredits, fetchInfo };
}
