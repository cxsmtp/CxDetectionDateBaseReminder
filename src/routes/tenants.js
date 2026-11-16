/**
 * Several Checkmarx One tenants on one server (src/tenancy.js), unlocked by an activation code: the Super Admin's
 * routes under /api/tenants (the list, turning tenants on, adding, renaming and removing one), the tenant a
 * person works in now (POST /api/me/tenant), and the tenants a person is added to
 * (PUT /api/iam/users/:id/tenants).
 */
import { DEFAULT_TENANT } from '../tenancy.js';

/**
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerTenantRoutes(app, d) {
  const {
    sessions, saveSignInsSoon, tenancy, audit, iam, integrationSession, activations, asyncRoute, tenantsUnlocked,
    isSuperAdmin, tenantsOf, requireSession, can, requirePermission, iamView, auditIam, adminActor,
  } = d;

  // ---------------------------------------------------------------------------
  // Several Checkmarx One tenants (src/tenancy.js, docs/multi-tenant.md). Adding, renaming and
  // removing tenants, working in any of them, and choosing who works in which are the Super Admin
  // tasks: they need the tenants activation code in date. Everything else works without it.
  // ---------------------------------------------------------------------------

  /** A tenant's name: the one given when it was added; for the first, its Checkmarx One tenant's. */
  function tenantName(id) {
    const tenant = tenancy.get(id);
    if (tenant?.name) return tenant.name;
    try {
      return tenancy.run(id, () => integrationSession()?.connection?.tenant) || 'Main tenant';
    } catch {
      return 'Main tenant';
    }
  }

  function tenantsView(req) {
    const superAdmin = isSuperAdmin(req.permissions);
    const ids = superAdmin ? tenancy.ids() : tenantsOf(req.user, req.permissions);
    // Who was added to each tenant (Super Admins, who reach every tenant, count only where they were added).
    const people = iam.users().map((u) => (u.tenants?.length ? u.tenants : [DEFAULT_TENANT]));
    return {
      enabled: tenancy.enabled,
      unlocked: tenantsUnlocked(),
      activation: activations.tenants(),
      current: req.tenantId,
      superAdmin,
      canManage: can(req, 'tenants.manage'),
      tenants: ids.map((id) => ({ id, name: tenantName(id), first: id === DEFAULT_TENANT, createdAt: tenancy.get(id)?.createdAt ?? '', people: people.filter((list) => list.includes(id)).length })),
    };
  }

  /** A Super Admin task: the permission, held by someone in the first tenant, with the activation code in date. */
  function requireSuperAdmin(req, res, next) {
    requirePermission('tenants.manage')(req, res, (error) => {
      if (error) return next(error);
      if (!tenantsUnlocked()) return res.status(403).json({ error: 'Several tenants need a tenants activation code that is in date (Settings → Activation codes).' });
      next();
    });
  }

  /** Record in one tenant's own audit log (a Super Admin acting on it), whatever tenant the request runs in. */
  const auditIn = (id, entry) => tenancy.context(id).audit.record(entry);

  app.get('/api/tenants', requireSession, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(tenantsView(req));
  });

  app.post('/api/tenants/enabled', requireSuperAdmin, asyncRoute(async (req, res) => {
    const on = req.body?.on === true;
    const actor = await adminActor(req);
    if (on && !tenancy.enabled) tenancy.enable({ by: req.user.email });
    else if (!on && tenancy.enabled) tenancy.disable();
    audit.record({ type: 'settings', outcome: 'changed', reason: `Several Checkmarx One tenants turned ${on ? 'on' : 'off'}.`, actor, details: { tenants: { enabled: on } } });
    res.json(tenantsView(req));
  }));

  app.post('/api/tenants', requireSuperAdmin, asyncRoute(async (req, res) => {
    const limit = activations.tenants()?.maxTenants ?? 0;
    if (tenancy.ids().length >= limit) return res.status(409).json({ error: `The activation code allows up to ${limit} tenants, and all are in use.` });
    const tenant = tenancy.add({ name: req.body?.name, by: req.user.email });
    const actor = await adminActor(req);
    audit.record({ type: 'settings', outcome: 'changed', reason: `Tenant "${tenant.name}" added.`, actor, details: { tenants: { added: tenant } } });
    auditIn(tenant.id, { type: 'settings', outcome: 'changed', reason: `This tenant was added by Super Admin ${req.user.email}.`, actor, details: { tenant: { id: tenant.id, name: tenant.name } } });
    res.status(201).json({ added: tenant, ...tenantsView(req) });
  }));

  app.patch('/api/tenants/:id', requireSuperAdmin, asyncRoute(async (req, res) => {
    const before = tenantName(req.params.id);
    const tenant = tenancy.rename(req.params.id, req.body?.name);
    const actor = await adminActor(req);
    audit.record({ type: 'settings', outcome: 'changed', reason: `Tenant "${before}" renamed "${tenant.name}".`, actor, details: { tenants: { renamed: { id: tenant.id, from: before, to: tenant.name } } } });
    auditIn(tenant.id, { type: 'settings', outcome: 'changed', reason: `Super Admin ${req.user.email} renamed this tenant "${tenant.name}".`, actor });
    res.json(tenantsView(req));
  }));

  app.delete('/api/tenants/:id', requireSuperAdmin, asyncRoute(async (req, res) => {
    const id = req.params.id;
    if (!tenancy.has(id)) return res.status(404).json({ error: 'No such tenant.' });
    if (id === DEFAULT_TENANT) return res.status(400).json({ error: 'The first tenant cannot be removed.' });
    if (req.body?.confirm !== tenantName(id)) return res.status(400).json({ error: 'Type the tenant\'s name to confirm.' });
    const name = tenantName(id);
    // Stop its automation and write everything it holds before its folder is set aside.
    const loaded = tenancy.loaded().find((t) => t.id === id);
    if (loaded) {
      loaded.scheduler.stop();
      loaded.knownAddresses.flush();
      loaded.creditLedger.flush();
      loaded.findingJournal.flush();
      loaded.audit.flushSync();
    }
    tenancy.remove(id);
    audit.record({ type: 'settings', outcome: 'changed', reason: `Tenant "${name}" removed; its files are kept in the state folder.`, actor: await adminActor(req), details: { tenants: { removed: { id, name } } } });
    res.json(tenantsView(req));
  }));

  /** Work in another tenant (one of yours; any, for a Super Admin). */
  app.post('/api/me/tenant', requireSession, asyncRoute(async (req, res) => {
    const id = String(req.body?.id ?? '');
    if (!tenantsOf(req.user, req.permissions).includes(id)) return res.status(404).json({ error: 'That tenant is not one you work in.' });
    if (req.session.tenantId !== id) {
      req.session.tenantId = id;
      req.session.lastScan = null; // fetched in the other tenant
      saveSignInsSoon();
      // A Super Admin opening a tenant they were not added to is in that tenant's own log.
      const own = req.user.tenants?.length ? req.user.tenants.includes(id) : id === DEFAULT_TENANT;
      if (!own) auditIn(id, { type: 'access', outcome: 'info', reason: `Super Admin ${req.user.email} opened this tenant.`, actor: await adminActor(req) });
    }
    res.json({ current: { id, name: tenantName(id) } });
  }));

  /** Which tenants a person works in (a Super Admin task). */
  app.put('/api/iam/users/:id/tenants', requireSuperAdmin, asyncRoute(async (req, res) => {
    const wanted = Array.isArray(req.body?.tenants) ? req.body.tenants.map(String) : [];
    const unknown = wanted.filter((id) => !tenancy.has(id));
    if (unknown.length) return res.status(400).json({ error: 'No such tenant.' });
    if (!wanted.length) return res.status(400).json({ error: 'Choose at least one tenant.' });
    const { before, after } = iam.setTenants(req.params.id, wanted.length === 1 && wanted[0] === DEFAULT_TENANT ? [] : wanted);
    await auditIam(req, `${after.email} now works in: ${wanted.map(tenantName).join(', ')}.`, { before: { tenants: before.tenants }, after: { tenants: after.tenants } });
    for (const session of sessions.filter((s) => s.userId === after.id)) {
      if (wanted.includes(session.tenantId ?? DEFAULT_TENANT)) continue;
      session.tenantId = undefined; // back to one of their tenants on their next request
      session.lastScan = null;
    }
    res.json(iamView(req));
  }));

  return { tenantName };
}
