/**
 * People & roles (src/iam.js): who has access, with which role, and what a role may do.
 *
 * The routes under /api/iam: the page's view, adding, changing and removing a person, a person's profile and
 * picture as an Admin sets them, a new password for someone, and roles (new, changed, removed). Whom a person may
 * see and manage is bounded by the tenants they share (sharesTenant, withinReach, visibleUser). The sign-in
 * policy on the same page (/api/iam/policy, /api/iam/sign-in) is in src/routes/session.js, with sign-in.
 */
import { PERMISSIONS, cleanProfile, publicUser } from '../iam.js';
import { sendReminderMail } from '../mailer.js';
import { isVerified } from '../settings.js';
import { systemEmail } from '../hands-off.js';
import { sessionKey } from '../handover.js';
import { DEFAULT_TENANT } from '../tenancy.js';
import { featureById } from '../features.js';

/**
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerPeopleRoutes(app, d) {
  const {
    MAINTAINER_EMAIL, sessions, tenancy, settingsStore, audit, iam, languageAccess, allowedLanguages,
    dormantPermissions, asyncRoute, permissionsFor, isSuperAdmin, tenantsOf, can, requirePermission, featureLocked,
    adminActor, signInTickets, passwordResets, passwordResetReady, utc, maySetSignInSecurity, signInSecurityView,
    tenantName, appNameNow,
  } = d;

  // ---------------------------------------------------------------------------
  // Access: users and roles
  // ---------------------------------------------------------------------------

  const actorOf = (req) => ({ actorPerms: req.permissions, actorId: req.user.id });

  /** Can this person see (and manage) that user: someone in the tenant they work in now, or anyone for a Super Admin. */
  function sharesTenant(req, user) {
    if (!tenancy.enabled || isSuperAdmin(req.permissions)) return true;
    return tenantsOf(iam.user(user.id) ?? user).includes(req.tenantId);
  }

  /** Roles are shared by every tenant: only people who work in the first tenant change them. */
  function mayChangeRoles(req) {
    return !tenancy.enabled || isSuperAdmin(req.permissions) || tenantsOf(req.user, req.permissions).includes(DEFAULT_TENANT);
  }

  /**
   * Whether this person may know `user` exists: their role holds nothing beyond this
   * person's own permissions. A Security Analyst sees analysts and below, never who
   * the Admins are; an Admin sees everyone. Themselves always.
   */
  const withinReach = (req, user) => user.id === req.user.id || iam.canGrant(req.permissions, permissionsFor({ ...user, disabled: false }));

  function iamView(req) {
    return {
      users: iam.users().filter((u) => sharesTenant(req, u) && withinReach(req, u)).map((u) => ({ ...u, canManage: can(req, 'iam.manage') && iam.canGrant(req.permissions, iam.permissionsOf({ ...iam.user(u.id), disabled: false })) && u.id !== req.user.id })),
      roles: iam.roles().filter((r) => r.id === req.user.role || iam.canGrant(req.permissions, r.permissions)).map((r) => ({ ...r, canManage: can(req, 'iam.manage') && mayChangeRoles(req) && !r.locked && iam.canGrant(req.permissions, r.permissions), canAssign: can(req, 'iam.manage') && iam.canGrant(req.permissions, r.permissions) })),
      permissions: PERMISSIONS.filter((p) => !dormantPermissions().includes(p.id)),
      // Whether this person may add roles (New role, Duplicate): the matrix shows the buttons only then.
      rolesChangeable: can(req, 'iam.manage') && mayChangeRoles(req),
      me: { id: req.user.id, permissions: [...req.permissions] },
      tenants: tenancy.enabled && isSuperAdmin(req.permissions) ? tenancy.list().map((t) => ({ id: t.id, name: tenantName(t.id) })) : null,
      signIn: can(req, 'iam.manage') ? { ...passwordResetReady(), canChange: !tenancy.enabled || isSuperAdmin(req.permissions), security: maySetSignInSecurity(req) ? signInSecurityView() : null } : null,
      // Labs → Consolidated view: an Admin ticks who may see it, once its activation code is in force.
      consolidatedGrant: !featureLocked(featureById('consolidated')) && can(req, 'iam.manage') && req.user.role === 'admin',
    };
  }

  /** A user this person may change: 404 for someone outside the tenants they work in. */
  function visibleUser(req, id) {
    const user = iam.user(id);
    if (!user || !sharesTenant(req, user) || !withinReach(req, user)) throw Object.assign(new Error('No such user.'), { status: 404 });
    return user;
  }

  async function auditIam(req, reason, details) {
    audit.record({ type: 'iam', outcome: 'changed', reason, actor: await adminActor(req), details });
  }

  /** Sign out every session of a user whose access was removed (all but `keep`, when given). */
  function endSessionsOf(userId, keep = null) {
    // A sign-in waiting for its two-step code ends too.
    signInTickets.revokeUser(userId);
    // Saved sign-ins nobody has come back for since a restart end too.
    const keepKey = keep ? sessionKey(keep) : null;
    sessions.endWhere((s) => s.userId === userId && !(keep && (s.id === keep || s.key === keepKey)));
  }

  app.get('/api/iam', requirePermission('iam.view'), (req, res) => res.json(iamView(req)));

  app.post(
    '/api/iam/users',
    requirePermission('iam.manage'),
    asyncRoute(async (req, res) => {
      const { email, name, role, password, cxoneIdentities } = req.body ?? {};
      const user = await iam.createUser({ email, name, role, password: password ? String(password) : '', cxoneIdentities, mustChangePassword: true }, actorOf(req));
      // Someone added while working in another tenant works in that tenant.
      if (req.tenantId && req.tenantId !== DEFAULT_TENANT) iam.setTenants(user.id, [req.tenantId]);
      await auditIam(req, `Added ${user.email} as ${iam.role(user.role)?.name}.`, { user });
      res.status(201).json(iamView(req));
    }),
  );

  app.patch(
    '/api/iam/users/:id',
    requirePermission('iam.manage'),
    asyncRoute(async (req, res) => {
      const patch = {};
      for (const key of ['name', 'role', 'cxoneIdentities', 'disabled']) if (key in (req.body ?? {})) patch[key] = req.body[key];
      visibleUser(req, req.params.id);
      const { before, after } = iam.updateUser(req.params.id, patch, actorOf(req));
      const changes = Object.keys(patch).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      if (changes.length) {
        const what = changes.map((k) => (k === 'role' ? `role ${iam.role(before.role)?.name ?? before.role} → ${iam.role(after.role)?.name ?? after.role}` : k === 'disabled' ? (after.disabled ? 'disabled' : 'enabled') : k)).join(', ');
        await auditIam(req, `Changed ${after.email}: ${what}.`, { before, after });
      }
      if (after.disabled) endSessionsOf(after.id);
      res.json(iamView(req));
    }),
  );

  app.delete(
    '/api/iam/users/:id',
    requirePermission('iam.manage'),
    asyncRoute(async (req, res) => {
      visibleUser(req, req.params.id);
      const removed = iam.deleteUser(req.params.id, actorOf(req));
      endSessionsOf(removed.id);
      await auditIam(req, `Removed ${removed.email} (${iam.role(removed.role)?.name ?? removed.role}).`, { user: removed });
      res.json(iamView(req));
    }),
  );

  /**
   * An Admin edits someone's profile: their sign-in email, name, language, time zone, programming
   * languages, Impact figures and look. Only people whose permissions the Admin holds all of (the
   * same rule as changing their role), never themselves (that is Your profile). A new email ends any
   * reset link sent to the old one, and both addresses are told.
   */
  const ADMIN_PROFILE_FIELDS = ['name', 'language', 'timeZone', 'timeZoneAuto', 'programmingLanguages', 'impact', 'look', 'theme', 'accent', 'scanColours'];
  function managedUser(req) {
    const user = visibleUser(req, req.params.id);
    if (user.id === req.user.id) throw Object.assign(new Error('Change your own profile under Settings → Your profile.'), { status: 400 });
    if (!iam.canGrant(req.permissions, iam.permissionsOf({ ...user, disabled: false }))) {
      throw Object.assign(new Error('You cannot change this person: their role holds permissions you do not have.'), { status: 403 });
    }
    return user;
  }
  const managedView = (req, id) => {
    const user = iam.users().find((u) => u.id === id);
    return { user: { ...user, canManage: true, roleName: iam.role(user.role)?.name ?? user.role } };
  };

  app.get('/api/iam/users/:id/profile', requirePermission('iam.manage'), (req, res) => {
    const user = managedUser(req);
    res.json({ ...managedView(req, user.id), languages: languageAccess.available(allowedLanguages(user.id)) });
  });

  app.put(
    '/api/iam/users/:id/profile',
    requirePermission('iam.manage'),
    asyncRoute(async (req, res) => {
      const target = managedUser(req);
      const body = req.body ?? {};
      const patch = {};
      for (const key of ADMIN_PROFILE_FIELDS) if (key in body) patch[key] = body[key];
      if (patch.language && !languageAccess.isAvailable(String(patch.language), allowedLanguages(target.id))) return res.status(400).json({ error: 'That language is not available to this person.' });
      // Checked whole before anything is saved, so a bad field never leaves half a change behind.
      cleanProfile(patch);
      let email = null;
      if ('email' in body) email = iam.changeEmail(target.id, String(body.email ?? ''), actorOf(req));
      const { before, after } = Object.keys(patch).length ? iam.updateProfile(target.id, patch) : { before: publicUser(iam.user(target.id)), after: publicUser(iam.user(target.id)) };
      const changed = Object.keys(patch).filter((k) => JSON.stringify(k === 'name' ? before.name : before.profile[k]) !== JSON.stringify(k === 'name' ? after.name : after.profile[k]));
      const emailChanged = email && email.before !== email.after;
      if (emailChanged || changed.length) {
        const what = [emailChanged ? `email ${email.before} → ${email.after}` : '', ...changed].filter(Boolean).join(', ');
        await auditIam(req, `Changed ${emailChanged ? email.before : after.email}'s profile: ${what}.`, { before, after: publicUser(iam.user(target.id)) });
      }
      if (emailChanged) {
        // A reset link sent to the old address must not reset the account now that it is someone else's.
        passwordResets.revokeUser(target.id);
        tellEmailChanged(email.before, email.after, req.user.email);
      }
      res.json(managedView(req, target.id));
    }),
  );

  app.put(
    '/api/iam/users/:id/avatar',
    requirePermission('iam.manage'),
    asyncRoute(async (req, res) => {
      const target = managedUser(req);
      const after = iam.setAvatar(target.id, String(req.body?.image ?? ''));
      await auditIam(req, `${after.avatarAt ? 'Changed' : 'Removed'} ${after.email}'s picture.`);
      res.json(managedView(req, target.id));
    }),
  );

  /** Both addresses hear about a changed sign-in email (best effort: only when email is set up). */
  function tellEmailChanged(before, after, by) {
    const settings = tenancy.run(DEFAULT_TENANT, () => settingsStore.get());
    if (!isVerified(settings)) return;
    const appName = appNameNow();
    const notes = [
      [before, `The sign-in email of your ${appName} account was changed from ${before} to ${after} by ${by}. From now on you sign in with ${after}, and links and reminders go there.`],
      [after, `This address now signs in to ${appName}: ${by} changed the account's email from ${before} to ${after}.`],
    ];
    for (const [to, line] of notes) {
      if (to.toLowerCase() === MAINTAINER_EMAIL.toLowerCase()) continue;
      sendReminderMail(
        settings,
        systemEmail({ appName, subject: `Your ${appName} sign-in email was changed`, lines: [line], facts: [['Changed at', utc(Date.now())]], footer: 'Not expected? Tell an administrator at once.', replyHelp: false }),
        { exact: true, to: [to] },
      ).catch((error) => console.error(`[profile] Could not tell ${to} about the new email: ${error.message}`));
    }
  }

  /** Set a temporary password; the user must choose their own at next sign-in. */
  app.post(
    '/api/iam/users/:id/password',
    requirePermission('iam.manage'),
    asyncRoute(async (req, res) => {
      if (req.params.id === req.user.id) return res.status(400).json({ error: 'Change your own password from your account menu.' });
      visibleUser(req, req.params.id);
      const user = await iam.setPassword(req.params.id, String(req.body?.password ?? ''), { mustChange: true, actorPerms: req.permissions });
      endSessionsOf(user.id);
      await auditIam(req, `Set a temporary password for ${user.email}.`);
      res.json(iamView(req));
    }),
  );

  app.post(
    '/api/iam/roles',
    requirePermission('iam.manage'),
    asyncRoute(async (req, res) => {
      if (!mayChangeRoles(req)) return res.status(403).json({ error: 'Roles are shared by every tenant, so only people who work in the first tenant change them.' });
      const { after } = iam.saveRole(null, req.body ?? {}, actorOf(req));
      await auditIam(req, `Created role "${after.name}" (${after.permissions.length} permissions).`, { role: after });
      res.status(201).json(iamView(req));
    }),
  );

  app.put(
    '/api/iam/roles/:id',
    requirePermission('iam.manage'),
    asyncRoute(async (req, res) => {
      if (!mayChangeRoles(req)) return res.status(403).json({ error: 'Roles are shared by every tenant, so only people who work in the first tenant change them.' });
      // A permission not listed right now (Hebrew while its code is not in force) keeps what the role had.
      const dormant = dormantPermissions();
      const held = iam.role(req.params.id)?.permissions ?? [];
      const asked = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
      const body = { ...(req.body ?? {}), permissions: [...asked.filter((p) => !dormant.includes(p)), ...held.filter((p) => dormant.includes(p))] };
      const { before, after } = iam.saveRole(req.params.id, body, actorOf(req));
      const added = after.permissions.filter((p) => !before.permissions.includes(p));
      const removed = before.permissions.filter((p) => !after.permissions.includes(p));
      if (before.name !== after.name) await auditIam(req, `Renamed role "${before.name}" to "${after.name}".`, { before: { id: after.id, name: before.name }, after: { id: after.id, name: after.name } });
      if (added.length || removed.length || before.description !== after.description) {
        await auditIam(req, `Changed role "${after.name}"${added.length ? `: added ${added.join(', ')}` : ''}${removed.length ? `${added.length ? ';' : ':'} removed ${removed.join(', ')}` : ''}.`, { before, after });
      }
      res.json(iamView(req));
    }),
  );

  app.delete(
    '/api/iam/roles/:id',
    requirePermission('iam.manage'),
    asyncRoute(async (req, res) => {
      if (!mayChangeRoles(req)) return res.status(403).json({ error: 'Roles are shared by every tenant, so only people who work in the first tenant change them.' });
      const removed = iam.deleteRole(req.params.id, actorOf(req));
      await auditIam(req, `Removed role "${removed.name}".`, { role: removed });
      res.json(iamView(req));
    }),
  );

  return { mayChangeRoles, withinReach, iamView, visibleUser, auditIam, endSessionsOf };
}
