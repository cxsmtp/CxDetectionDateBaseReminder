/**
 * Primary branches: Settings → Primary branches, and the branches the Workbench offers for a project.
 *
 *   GET  /api/branches                 the order, the last read (each project's primary branch in Checkmarx One,
 *                                      what its git host protects, the suggestion), and the read in progress (findings.fetch)
 *   POST /api/branches/read            read every project again, in the background (integration.cxone)
 *   PUT  /api/branches/order           { order: [..] } or { reset: true }: the order protected branches are suggested in (Admins)
 *   POST /api/branches/primary         { projects: [{ id, branch }] }: write each primary branch to Checkmarx One (Admins)
 *   GET  /api/branches/project?id=     one project's branches for the Workbench: protected first, then the others
 *                                      Checkmarx One scanned, each with its latest scan (findings.fetch)
 *
 * Nothing is written to Checkmarx One but on an Admin's click, and every write is audited.
 */

import { listProjects } from '../cxone/projects.js';
import { mapWithConcurrency } from '../cxone/client.js';
import { branchName, branchOf } from '../cxone/branches.js';
import { projectBranches } from '../fusion-credits.js';
import { isProtected, rankIn, readProtected, sortByOrder } from '../protected-branches.js';
import { logSafe } from './shared.js';

const MAX_PROJECTS = 5000;
const SAFE_ID = /^[\w-]{1,80}$/;
const SAFE_BRANCH = /^[\w./+@-]{1,200}$/;
const MAX_WRITES = 500;

/** A project's scans in Checkmarx One, newest first: each branch once, with its latest completed scan. */
async function scannedBranches(client, projectId) {
  const body = await client.request('/api/scans', { query: { 'project-id': projectId, statuses: 'Completed', sort: '-created_at', limit: 200, offset: 0 }, retries: 1 }).catch(() => null);
  const out = new Map();
  for (const scan of Array.isArray(body?.scans) ? body.scans : []) {
    const name = branchOf(scan);
    if (name && !out.has(name)) out.set(name, { at: scan.createdAt ?? scan.updatedAt ?? '', scanId: String(scan.id ?? '') });
  }
  return out;
}

export function registerBranchRoutes(app, d) {
  const { tenancy, branchSettings, audit, asyncRoute, requirePermission, adminActor, githubConfig, githubClient, scmHosts, settingsStore } = d;
  const isAdmin = (req) => req.user?.role === 'admin';
  const jobOf = () => (tenancy.current().state.branchRead ??= { state: 'none' });
  const noClient = (res) => res.status(409).json({ error: 'Connect to Checkmarx One first (Settings → Checkmarx One).' });

  /** The git hosts as Settings has them now (tokens stay on the server). */
  function hosts() {
    const settings = settingsStore.get();
    const { configs, clients } = scmHosts(settings);
    const gh = githubConfig(settings);
    return { github: githubClient(settings), githubApiUrl: gh.apiUrl, configs, clients };
  }

  /** One project's branches: in Checkmarx One, and what its git host protects. */
  async function readOne(client, project, h) {
    const [branches, guard] = await Promise.all([projectBranches(client, project.id).catch(() => []), project.repoUrl ? readProtected(project.repoUrl, h) : Promise.resolve({ provider: '', label: '', repo: '', names: [], error: '' })]);
    return { id: project.id, name: project.name, repoUrl: project.repoUrl ?? '', repo: guard.repo, provider: guard.provider, label: guard.label, mainBranch: branchName(project.mainBranch), protectedNames: guard.names, branches, error: guard.error };
  }

  async function readAll(client, by) {
    const job = jobOf();
    Object.assign(job, { state: 'running', done: 0, total: 0, startedAt: Date.now(), finishedAt: null, error: '' });
    try {
      const projects = await listProjects(client, { maxItems: MAX_PROJECTS });
      job.total = projects.length;
      const h = hosts();
      const read = await mapWithConcurrency(projects, 4, async (p) => {
        const row = await readOne(client, p, h);
        job.done += 1;
        return row;
      });
      branchSettings.setRead({ at: new Date().toISOString(), by, projects: read.sort((a, b) => a.name.localeCompare(b.name)) });
      branchSettings.save();
      Object.assign(job, { state: 'done', finishedAt: Date.now() });
    } catch (error) {
      Object.assign(job, { state: 'failed', finishedAt: Date.now(), error: String(error?.message ?? error).slice(0, 300) });
      if (!(error?.status >= 400 && error.status < 600)) console.warn(`! [branches] read: ${logSafe(error?.stack ?? error?.message)}`);
    }
  }

  /** What the page shows: the order, and each project with its suggestion and whether Checkmarx One agrees. */
  function view(req) {
    const order = branchSettings.order;
    const read = branchSettings.read;
    const found = new Map();
    const projects = (read?.projects ?? []).map((p) => {
      const suggestion = branchSettings.suggestionFor(p, order);
      for (const name of p.protectedNames) found.set(name, (found.get(name) ?? 0) + 1);
      const primaryProtected = p.mainBranch ? isProtected(p.mainBranch, p.protectedNames) : false;
      // Checkmarx One names a primary branch, but a protected branch comes earlier in the order.
      const better = p.mainBranch && suggestion.why === 'protected' && suggestion.branch !== p.mainBranch && rankIn(suggestion.branch, order) < rankIn(p.mainBranch, order) ? suggestion.branch : '';
      return {
        ...p,
        options: sortByOrder([p.mainBranch, ...p.branches, ...p.protectedNames.filter((n) => !n.includes('*'))], order).map((name) => ({ name, protected: isProtected(name, p.protectedNames), scanned: p.branches.includes(name) })),
        suggestion,
        primaryProtected,
        better,
        state: p.mainBranch ? (better ? 'differs' : 'set') : suggestion.branch ? 'suggested' : 'none',
      };
    });
    const protectedCounts = [...found.entries()].sort((a, b) => rankIn(a[0], order) - rankIn(b[0], order) || b[1] - a[1]).slice(0, 30).map(([name, count]) => ({ name, count }));
    return { ...branchSettings.orderInfo, read: read ? { at: read.at, by: read.by } : null, projects, protectedCounts, job: jobOf(), admin: isAdmin(req) };
  }

  app.get('/api/branches', requirePermission('findings.fetch'), (req, res) => res.json(view(req)));

  app.post('/api/branches/read', requirePermission('integration.cxone'), asyncRoute(async (req, res) => {
    const client = req.session?.client;
    if (!client) return noClient(res);
    if (jobOf().state === 'running') return res.status(202).json({ started: false, job: jobOf() });
    const actor = await adminActor(req);
    tenancy.run(tenancy.current().id, () => readAll(client, actor.user || req.user?.email || ''));
    res.status(202).json({ started: true });
  }));

  app.put('/api/branches/order', requirePermission('findings.fetch'), asyncRoute(async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an Admin changes the order primary branches are suggested in.' });
    const before = branchSettings.order;
    const reset = req.body?.reset === true;
    if (!reset && !Array.isArray(req.body?.order)) return res.status(400).json({ error: 'Give the order as a list of branch names or patterns.' });
    const actor = await adminActor(req);
    branchSettings.setOrder(reset ? null : req.body.order, { by: actor.user || '' });
    branchSettings.save();
    audit.record({ type: 'settings', outcome: 'changed', actor, reason: `The order primary branches are suggested in ${reset ? 'was put back to the usual one' : 'changed'}: ${before.join(' › ')} → ${branchSettings.order.join(' › ')}.` });
    res.json(view(req));
  }));

  /** Write primary branches to Checkmarx One: each project as it is, with its new primary branch. */
  app.post('/api/branches/primary', requirePermission('findings.fetch'), asyncRoute(async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only an Admin sets a primary branch in Checkmarx One.' });
    const client = req.session?.client;
    if (!client) return noClient(res);
    const list = (Array.isArray(req.body?.projects) ? req.body.projects : []).slice(0, MAX_WRITES).map((p) => ({ id: String(p?.id ?? '').slice(0, 80), branch: branchName(String(p?.branch ?? '').slice(0, 200)) }));
    // Plain branch names and project ids only (no pattern, no control characters): nothing else reaches Checkmarx One or a log line.
    if (!list.length || list.some((p) => !SAFE_ID.test(p.id) || !SAFE_BRANCH.test(p.branch))) return res.status(400).json({ error: 'Choose the projects, and a branch name (not a pattern) for each.' });
    const actor = await adminActor(req);
    const results = await mapWithConcurrency(list, 4, async ({ id, branch }) => {
      try {
        const project = await client.request(`/api/projects/${encodeURIComponent(id)}`, { retries: 1 });
        const before = branchName(project?.mainBranch);
        if (before === branch) return { id, name: project?.name ?? id, ok: true, unchanged: true };
        const body = {
          name: project?.name,
          groups: Array.isArray(project?.groups) ? project.groups : [],
          repoUrl: project?.repoUrl ?? '',
          mainBranch: branch,
          origin: project?.origin ?? '',
          tags: project?.tags && typeof project.tags === 'object' ? project.tags : {},
          criticality: project?.criticality ?? 3,
        };
        await client.request(`/api/projects/${encodeURIComponent(id)}`, { method: 'PUT', body, retries: 0 });
        branchSettings.noteMainBranch(id, branch);
        audit.record({ type: 'settings', outcome: 'changed', actor, project: { id, name: project?.name ?? id }, reason: `Primary branch set in Checkmarx One: ${before || 'none'} → ${branch}.` });
        return { id, name: project?.name ?? id, ok: true, before, branch };
      } catch (error) {
        const why = String(error?.message ?? error).slice(0, 200);
        audit.record({ type: 'settings', outcome: 'failed', actor, project: { id, name: id }, reason: `The primary branch could not be set to ${branch} in Checkmarx One: ${why}` });
        return { id, ok: false, error: why };
      }
    });
    branchSettings.save();
    res.json({ ...view(req), results });
  }));

  /** The branches the Workbench offers for one project: protected first (in the order), then the others scanned. */
  app.get('/api/branches/project', requirePermission('findings.fetch'), asyncRoute(async (req, res) => {
    const client = req.session?.client;
    if (!client) return noClient(res);
    const id = String(req.query.id ?? '').slice(0, 80);
    if (!SAFE_ID.test(id)) return res.status(400).json({ error: 'Which project?' });
    const order = branchSettings.order;
    let known = branchSettings.project(id);
    const scanned = await scannedBranches(client, id);
    // Not in the last read (or never read): its git host is asked now, for this project only.
    if (!known) {
      const project = await client.request(`/api/projects/${encodeURIComponent(id)}`, { retries: 1 }).catch(() => null);
      if (project) {
        const guard = project.repoUrl ? await readProtected(project.repoUrl, hosts()) : { provider: '', label: '', repo: '', names: [], error: '' };
        known = { id, name: project.name ?? id, mainBranch: branchName(project.mainBranch), protectedNames: guard.names, provider: guard.provider, label: guard.label, repo: guard.repo, branches: [], error: guard.error };
      }
    }
    const protectedNames = known?.protectedNames ?? [];
    const names = sortByOrder([...scanned.keys(), ...(known?.branches ?? []), ...protectedNames.filter((n) => !n.includes('*')), known?.mainBranch ?? ''], order);
    const branches = names.map((name) => ({ name, protected: isProtected(name, protectedNames), primary: name === known?.mainBranch, lastScanAt: scanned.get(name)?.at ?? '', scanned: scanned.has(name) }));
    res.json({
      id,
      primary: known?.mainBranch ?? '',
      host: known?.provider ? { label: known.label, repo: known.repo } : null,
      error: known?.error ?? '',
      suggestion: known ? branchSettings.suggestionFor({ ...known, branches: names }, order) : { branch: '', why: '' },
      protected: branches.filter((b) => b.protected),
      others: branches.filter((b) => !b.protected),
    });
  }));

  return { suggestions: () => branchSettings.suggestions() };
}
