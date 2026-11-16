/**
 * A person's own account: who they are here (GET /api/me), the pages they visit and the activity log
 * (/api/activity), the terms of use and accepting them (/api/terms), their password, profile, picture and their
 * own branding (/api/me/...), and other people's pictures (GET /api/users/:id/avatar).
 */
import { PROFILE_LANGUAGES, PROGRAMMING_LANGUAGES } from '../iam.js';
import fs from 'node:fs';
import { cleanPersonalBranding } from '../settings.js';
import { cleanName } from '../terms.js';
import { clientIp } from './shared.js';

/**
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerAccountRoutes(app, d) {
  const {
    settingsStore, activity, audit, terms, iam, firstAdminFile, languageAccess, allowedLanguages, asyncRoute,
    currentSession, requireSession, can, requirePermission, adminActor, describeMe, withinReach, endSessionsOf,
  } = d;

  app.get('/api/me', requireSession, (req, res) => res.json(describeMe(req.session, req.user)));

  /** A page or tab someone opened, or an action done in the page alone (the PDF summary): User activity. */
  app.post('/api/activity', requireSession, (req, res) => {
    const kind = req.body?.kind === 'event' ? 'event' : 'page';
    const name = String(req.body?.name ?? '').trim();
    if (!/^[\w .,:/#&()'’›→-]{1,80}$/u.test(name)) return res.status(400).json({ error: 'Not a page or action name.' });
    activity.record({ user: req.user.email, name: req.user.name ?? '', role: iam.role(req.user.role)?.name ?? req.user.role, ip: clientIp(req), kind, action: kind === 'page' ? `Opened ${name}` : name, route: '/api/activity', method: 'POST', status: 204 });
    res.status(204).end();
  });

  /** What people did here, newest first: for those who may see the audit log. */
  app.get('/api/activity', requirePermission('audit.view'), (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(activity.list({ limit: req.query.limit, offset: req.query.offset, user: String(req.query.user ?? ''), q: String(req.query.q ?? ''), kind: String(req.query.kind ?? ''), from: String(req.query.from ?? ''), to: String(req.query.to ?? '') }));
  });

  app.get('/api/activity/export', requirePermission('audit.view'), (req, res) => {
    res.set('Content-Disposition', `attachment; filename="user-activity-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.type('text/csv').send(activity.csv());
  });

  /** The terms of use: readable by anyone (also before signing in), with where this person stands. */
  app.get('/api/terms', (req, res) => {
    const session = currentSession(req);
    const user = session ? iam.user(session.userId) : null;
    const organisation = terms.organisation();
    const mine = user ? terms.userAcceptance(user.id) : null;
    res.set('Cache-Control', 'no-store');
    res.json({
      version: terms.version,
      text: terms.text,
      organisation: organisation ? { at: organisation.at, by: organisation.by, via: organisation.via } : null,
      ...(user ? { you: { accepted: Boolean(organisation) && terms.acceptedBy(user.id), at: mine?.at ?? (organisation?.everyone ? organisation.at : null), canAcceptForOrganisation: user.role === 'admin' } } : {}),
    });
  });

  /** Accept the terms: an Admin for the organisation (first), then each person for themselves. */
  app.post('/api/terms/accept', requireSession, asyncRoute(async (req, res) => {
    if (String(req.body?.version ?? '') !== terms.version) return res.status(409).json({ error: 'The terms changed while you were reading them: read the current version, then accept.' });
    const actor = { kind: 'user', user: req.user.email, ip: clientIp(req), userAgent: String(req.get('user-agent') ?? '').slice(0, 200) };
    if (!terms.organisation()) {
      if (req.user.role !== 'admin' || !req.body?.forOrganisation) return res.status(403).json({ error: 'An administrator must accept the terms of use for the organisation first.' });
      const name = cleanName(req.body?.organisationName);
      if (!name && !terms.organisationName()) return res.status(400).json({ error: 'Write your organisation’s name: it goes on the projection reports and other documents CxMissionZero makes.' });
      terms.acceptForOrganisation({ by: req.user.email, ip: clientIp(req), name });
      audit.record({ type: 'access', outcome: 'changed', reason: `Terms of use v${terms.version} accepted for the organisation by ${req.user.email}${name ? ` (organisation name: ${name})` : ''}.`, actor, details: { terms: { version: terms.version, hash: terms.hash, scope: 'organisation' } } });
    }
    if (!terms.acceptedBy(req.user.id)) {
      terms.acceptForUser({ userId: req.user.id, email: req.user.email, ip: clientIp(req) });
      audit.record({ type: 'access', outcome: 'changed', reason: `Terms of use v${terms.version} accepted by ${req.user.email}.`, actor, details: { terms: { version: terms.version, hash: terms.hash, scope: 'user' } } });
    }
    res.json(describeMe(req.session, req.user));
  }));

  /** Change one's own password (required after an administrator reset). */
  app.post(
    '/api/me/password',
    requireSession,
    asyncRoute(async (req, res) => {
      const user = req.user;
      // Signed in by single sign-on, with no password here: they cannot give themselves one (it would outlast
      // their account at the identity provider). An Admin sets one for them under People & roles.
      if (!user.passwordHash && req.session.via === 'sso') {
        return res.status(403).json({ error: 'You signed in with single sign-on and have no password here, so you cannot set one yourself. An administrator can give you one under People & roles.' });
      }
      if (user.passwordHash) {
        try {
          await iam.signIn(user.email, String(req.body?.current ?? ''));
        } catch (error) {
          return res.status(error.status === 423 ? 423 : 400).json({ error: error.status === 423 ? error.message : 'Your current password is wrong.' });
        }
      }
      if (String(req.body?.next ?? '') === String(req.body?.current ?? '')) return res.status(400).json({ error: 'Choose a password different from the current one.' });
      await iam.setPassword(user.id, String(req.body?.next ?? ''), { mustChange: false });
      // Anyone else signed in with the old password is signed out; this browser stays signed in.
      endSessionsOf(user.id, req.session.id);
      fs.rmSync(firstAdminFile, { force: true });
      audit.record({ type: 'iam', outcome: 'changed', reason: `${user.email} changed their password.`, actor: await adminActor(req) });
      res.json(describeMe(req.session, iam.user(user.id)));
    }),
  );

  /**
   * One's own profile: name, language, time zone, programming languages and Impact figures. A time zone picked up
   * from the computer by itself (quiet) is stored without an audit entry; everything else is audited.
   */
  app.put(
    '/api/me/profile',
    requireSession,
    asyncRoute(async (req, res) => {
      const patch = {};
      for (const key of ['name', 'language', 'timeZone', 'timeZoneAuto', 'programmingLanguages', 'impact', 'look', 'theme', 'accent', 'scanColours']) if (key in (req.body ?? {})) patch[key] = req.body[key];
      if (patch.language && !languageAccess.isAvailable(String(patch.language), allowedLanguages(req.user.id))) return res.status(400).json({ error: 'That language is not available.' });
      const { before, after } = iam.updateProfile(req.user.id, patch);
      const changed = [
        ...(before.name !== after.name ? ['name'] : []),
        ...Object.keys(after.profile).filter((k) => JSON.stringify(before.profile[k]) !== JSON.stringify(after.profile[k])),
      ];
      // How the app looks to them (look, light or dark, accent, Fusion and LAST colours) is theirs alone: never an audit entry.
      const appearance = ['look', 'theme', 'accent', 'scanColours'];
      const quiet = changed.every((k) => appearance.includes(k)) || (req.body?.quiet === true && changed.every((k) => k === 'timeZone' || k === 'language'));
      if (changed.length && !quiet) {
        audit.record({ type: 'iam', outcome: 'changed', reason: `${after.email} updated their profile: ${changed.join(', ')}.`, actor: await adminActor(req), details: { before: { name: before.name, ...before.profile }, after: { name: after.name, ...after.profile } } });
      }
      res.json(describeMe(req.session, iam.user(req.user.id)));
    }),
  );

  /** One's own picture: a PNG, JPEG or WebP data: URL (the page makes it small first), or none. */
  app.put(
    '/api/me/avatar',
    requireSession,
    asyncRoute(async (req, res) => {
      const after = iam.setAvatar(req.user.id, String(req.body?.image ?? ''));
      audit.record({ type: 'iam', outcome: 'changed', reason: `${after.email} ${after.avatarAt ? 'changed' : 'removed'} their picture.`, actor: await adminActor(req) });
      res.json(describeMe(req.session, iam.user(req.user.id)));
    }),
  );

  /** A person's picture: for themselves, and for anyone who may see people and roles. */
  app.get('/api/users/:id/avatar', requireSession, (req, res) => {
    if (req.params.id !== req.user.id && !can(req, 'iam.view')) return res.status(403).json({ error: 'Your role does not allow this.' });
    const owner = iam.user(req.params.id);
    if (owner && !withinReach(req, owner)) return res.status(404).json({ error: 'No picture.' });
    const avatar = iam.avatar(req.params.id);
    if (!avatar) return res.status(404).json({ error: 'No picture.' });
    res.set({ 'Content-Type': avatar.type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    res.send(avatar.bytes);
  });

  /** Settings → Your branding: one's own, and the organisation's it falls back to field by field. */
  function personalBrandingView(user) {
    const { appName, companyName, logoUrl, logoHeight, accentColor, callToAction } = settingsStore.get().branding;
    return { branding: cleanPersonalBranding(user.branding ?? {}), organisation: { appName, companyName, logoUrl, logoHeight, accentColor, callToAction } };
  }

  app.get('/api/me/branding', requirePermission('branding.personal'), (req, res) => res.json(personalBrandingView(req.user)));

  app.put(
    '/api/me/branding',
    requirePermission('branding.personal'),
    asyncRoute(async (req, res) => {
      const next = cleanPersonalBranding(req.user.branding ?? {}, req.body ?? {});
      const { before } = iam.setBranding(req.user.id, next);
      const prior = cleanPersonalBranding(before ?? {});
      const changed = Object.keys(next).filter((k) => prior[k] !== next[k]);
      if (changed.length) {
        const what = changed.length === 1 && changed[0] === 'on' ? (next.on ? 'turned their own branding on' : 'went back to the organisation’s branding') : `changed their own branding: ${changed.join(', ')}`;
        // The logo itself can be large; the log says only whether there is one.
        const summary = (b) => b && { ...b, logoUrl: b.logoUrl ? (b.logoUrl.startsWith('data:') ? '(uploaded image)' : b.logoUrl) : '' };
        audit.record({ type: 'iam', outcome: 'changed', reason: `${req.user.email} ${what}.`, actor: await adminActor(req), details: { before: summary(prior), after: summary(next) } });
      }
      res.json({ ...personalBrandingView(iam.user(req.user.id)), me: describeMe(req.session, iam.user(req.user.id)) });
    }),
  );

  app.get('/api/me/profile/options', requireSession, (req, res) => res.json({ languages: PROFILE_LANGUAGES.filter((code) => languageAccess.isAvailable(code, allowedLanguages(req.user.id))), programmingLanguages: PROGRAMMING_LANGUAGES }));
}
