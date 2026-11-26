/**
 * What stands in front of a route: who is signed in, what they may do, and in which tenant the handler runs.
 *
 * - requireSession: a live session of an active person, their password changed and the terms accepted where that
 *   is asked, and the tenant they work in now; the handler then runs inside that tenant.
 * - requirePermission(...): signed in, and holding one of the permissions. requireFeature(id): a Beta or Labs
 *   feature, unlocked and open to the person's role.
 * - asyncRoute: runs an async handler in its request's tenant and hands a failure to the error handler.
 * - permissionsFor, tenantsOf, isSuperAdmin, can, currentSession: the same questions, for code that asks them
 *   outside a route. ownBranding, presenting, brandingNow: whose branding a request is made with.
 *
 * Made once in src/server.js, after the middleware and before the first route, and handed to every area.
 */
import { PERMISSIONS } from '../iam.js';
import { overlayBranding } from '../settings.js';
import { DEFAULT_TENANT } from '../tenancy.js';
import { featureById, isFinal, labsPermission, LABS_VIEW, mayUse } from '../features.js';
import { readSessionCookie } from '../session.js';

/**
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function createGuards(d) {
  const {
    presenter, sessions, tenancy, settingsStore, terms, iam, integrationSession, resolveAutomationSession,
    activations,
  } = d;

  // Each handler runs in its request's tenant, even after a body parser's callback lost the context.
  const asyncRoute = (handler) => (req, res, next) =>
    Promise.resolve(req.tenantId ? tenancy.run(req.tenantId, () => handler(req, res)) : handler(req, res)).catch(next);

  /**
   * The tenants a person works in: every tenant for a Super Admin (tenants.manage); otherwise
   * the ones they were added to, or the first tenant when they were added to none. Empty when
   * every tenant they were added to has been removed.
   */
  /** Permissions that act on the whole server, not one tenant: only for people who work in the first tenant. */
  const SERVER_PERMISSIONS = new Set(['security.https', 'backup.view', 'backup.run', 'backup.manage', 'system.update', 'system.metrics', 'diagnostics.export', 'activation.manage', 'tenants.manage']);

  /** What a person may do: their role's permissions, without the server-wide ones when they work only in other tenants. */
  function permissionsFor(user) {
    const all = iam.permissionsOf(user);
    // The consolidated view (Labs): given to one person by an Admin, never by a role (src/iam.js PERSON_GRANTS).
    if (user?.consolidated === true && !user.disabled) all.add('consolidated.view');
    if (!user?.tenants?.length || user.tenants.includes(DEFAULT_TENANT)) return all;
    return new Set([...all].filter((p) => !SERVER_PERMISSIONS.has(p)));
  }

  /** Several tenants are unlocked by an activation code in date (src/activation.js). */
  const tenantsUnlocked = () => Boolean(activations.tenants()?.valid);
  /** A Super Admin: may manage tenants and work in every one (needs the activation code in date). */
  const isSuperAdmin = (permissions) => permissions.has('tenants.manage') && tenantsUnlocked();

  function tenantsOf(user, permissions = permissionsFor(user)) {
    if (!user) return [];
    if (isSuperAdmin(permissions)) return tenancy.ids();
    if (!user.tenants?.length) return [DEFAULT_TENANT];
    return user.tenants.filter((id) => tenancy.has(id));
  }

  /**
   * A session as one tenant sees it. Someone who signed in with their own Checkmarx One API key holds a key of the
   * first tenant's Checkmarx One (a key sign-in is checked there, src/routes/session.js). In any other tenant that key
   * must never read anything: the session reads through that tenant's own connection, as a password sign-in does,
   * and with none it is "not connected". Everything else (who they are, what they loaded) is the session itself.
   * Until MZ-01.01.22 the key went with them, and another tenant's Workbench showed the first tenant's findings.
   */
  function inTenant(session, tenantId) {
    if (!session || session.linked || !tenantId || tenantId === DEFAULT_TENANT) return session;
    const integration = () => {
      const target = tenancy.run(tenantId, () => integrationSession());
      if (!target) throw Object.assign(new Error('This tenant is not connected to Checkmarx One yet: an Admin of this tenant connects it under Settings → Checkmarx One. Your own API key is for the first tenant\'s Checkmarx One and is used there only.'), { status: 503 });
      return target;
    };
    return new Proxy(session, {
      get(target, prop) {
        if (prop === 'client') return integration().client;
        if (prop === 'connection') return integration().connection;
        // Its own key is not this tenant's: nothing here may use it (connecting a tenant with "the key you signed in with").
        if (prop === 'ownKeyElsewhere') return true;
        return Reflect.get(target, prop);
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    });
  }

  /** The caller's signed-in session (every person signs in; there is no shared fallback). */
  const currentSession = (req) => {
    const session = sessions.get(readSessionCookie(req));
    return session?.userId ? session : null;
  };

  /** Routes someone who must change their password may still use. */
  const PASSWORD_CHANGE_ROUTES = new Set(['/api/me/password', '/api/session', '/api/me']);
  /** Routes usable before the terms of use are accepted: reading and accepting them, and signing in and out. */
  const TERMS_ROUTES = new Set(['/api/me/password', '/api/session', '/api/me', '/api/terms', '/api/terms/accept']);

  /** Gate for every signed-in route: a live session of an active user. */
  function requireSession(req, res, next) {
    const session = currentSession(req);
    const user = session ? iam.user(session.userId) : null;
    if (!session || !user || user.disabled) {
      if (session) sessions.destroy(session.id);
      return res.status(401).json({ error: 'Please sign in.', signIn: true });
    }
    if (user.mustChangePassword && session.via === 'password' && !PASSWORD_CHANGE_ROUTES.has(req.path)) {
      return res.status(403).json({ error: 'Choose a new password before continuing.', mustChangePassword: true });
    }
    if (!TERMS_ROUTES.has(req.path) && (!terms.organisation() || !terms.acceptedBy(user.id))) {
      return res.status(403).json({
        error: terms.organisation() ? 'Accept the terms of use to continue.' : user.role === 'admin' ? 'Accept the terms of use for your organisation to continue.' : 'An administrator must accept the terms of use before CxMissionZero can be used.',
        termsRequired: true,
      });
    }
    req.session = session;
    req.user = user;
    req.permissions = permissionsFor(user);
    // The tenant this person works in now (their choice, if they still may).
    const allowed = tenantsOf(user, req.permissions);
    if (!allowed.length) return res.status(403).json({ error: 'You are not in any Checkmarx One tenant on this server any more. Ask a Super Admin to add you to one.' });
    if (!allowed.includes(session.tenantId)) {
      if (session.tenantId) session.lastScan = null; // fetched in another tenant
      session.tenantId = allowed[0];
    }
    req.tenantId = session.tenantId;
    // A key sign-in reads through this tenant's own connection outside the first tenant (inTenant above).
    req.session = inTenant(session, req.tenantId);
    const run = () =>
      tenancy.run(req.tenantId, () => {
        // Password sessions use the integration; make sure it is up (it is re-created from the stored key if needed).
        if ((session.linked || req.session !== session) && !integrationSession()) {
          resolveAutomationSession().then(() => next(), next);
          return;
        }
        next();
      });
    // Someone presenting their own branding: what this request makes carries it, and nothing after it does.
    const own = ownBranding(user, req.permissions);
    if (!own) return run();
    const context = { own, done: false };
    const end = () => (context.done = true);
    res.on('finish', end);
    res.on('close', end);
    presenter.run(context, run);
  }

  /**
   * Settings → Your branding: a person's own names, logo and colours, for their
   * demonstrations. In use while they hold branding.personal and have it on; empty
   * fields keep the organisation's. It applies only to what their own requests make
   * (reports, reminder emails), never to scheduled runs or anyone else's.
   */
  function ownBranding(user, permissions = permissionsFor(user)) {
    const own = user?.branding;
    return own?.on && permissions.has('branding.personal') ? own : null;
  }
  /** The branding of whoever this request is for, while the request lasts; null for the organisation's. */
  function presenting() {
    const context = presenter.getStore();
    return context && !context.done ? context.own : null;
  }
  const brandingNow = (branding) => overlayBranding(branding, presenting());

  const can = (req, permission) => Boolean(req.permissions?.has(permission));

  /** Signed in, and holding at least one of `permissions`. */
  function requirePermission(...permissions) {
    return (req, res, next) =>
      requireSession(req, res, (error) => {
        if (error) return next(error);
        if (permissions.some((p) => req.permissions.has(p))) return next();
        const labels = permissions.map((p) => PERMISSIONS.find((x) => x.id === p)?.label ?? p);
        res.status(403).json({ error: `Your role does not allow this (needs “${labels.join('” or “')}”).`, permission: permissions[0] });
      });
  }

  /** A feature held back for those an activation code has unlocked it for (features.js `unlockedBy`), while it has not. */
  function featureLocked(feature) {
    return Boolean(feature?.unlockedBy) && !activations.feature(feature.unlockedBy)?.on;
  }

  /**
   * A Beta feature: in Labs, for roles holding Labs and the item's own permission; SLAs with Beta features; once an
   * Admin made it final, for everyone holding the feature's own permission too (src/features.js).
   */
  function requireFeature(id) {
    return (req, res, next) =>
      requireSession(req, res, (error) => {
        if (error) return next(error);
        if (featureLocked(featureById(id))) return res.status(403).json({ error: `“${featureById(id).name}” needs its activation code (Settings → Activation codes).`, locked: true });
        if (mayUse(settingsStore.get(), id, req.permissions)) return next();
        const feature = featureById(id);
        if (feature?.labs) {
          const needs = [LABS_VIEW, labsPermission(id)].filter((p) => !req.permissions.has(p));
          const labels = needs.map((p) => PERMISSIONS.find((x) => x.id === p)?.label ?? p);
          return res.status(403).json({ error: `“${feature.name}” is in Labs: your role needs “${labels.join('” and “') || 'its permission'}”${isFinal(settingsStore.get(), id) ? '' : ' until an Admin makes it final'}.`, permission: needs[0] ?? labsPermission(id) });
        }
        res.status(403).json({ error: `“${feature?.name ?? id}” is a Beta feature: your role needs “Beta features”${isFinal(settingsStore.get(), id) ? '' : ' until an Admin makes it final'}.`, permission: 'beta.use' });
      });
  }

  return {
    asyncRoute, permissionsFor, tenantsUnlocked, isSuperAdmin, tenantsOf, currentSession, requireSession,
    ownBranding, presenting, brandingNow, can, requirePermission, featureLocked, requireFeature, inTenant,
  };
}
