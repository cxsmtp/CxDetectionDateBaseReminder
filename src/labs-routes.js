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
 */
import { TtlCache } from './ttl-cache.js';
import { listApplications } from './cxone/projects.js';
import { safeUrl } from './links.js';
import { FAILED_DAYS, applicationsByProject, boardFigures, boardOf, failedScansSince, recentScans } from './status-board.js';
import { tenantColours } from '../public/tenant-colour.js';
import { consolidatedFigures, crossProjects, governSummary, tenantSummary, workbenchSnapshot } from './consolidated.js';

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
  function noteFetch(req, result, projectsTotal) {
    const state = tenancy.current().state;
    const by = req.user?.email ?? '';
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

  const route = (path, what, build) =>
    app.get(path, ...viewGuard, asyncRoute(async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const tenants = gather(req);
      await audited(req, what, tenants);
      res.json({ readAt: new Date().toISOString(), current: req.tenantId, ...build(tenants) });
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
