/**
 * Signing in and out, and everything on the way (src/session.js, src/iam.js, src/mfa.js, src/oidc.js,
 * src/password-reset.js).
 *
 * - The first administrator: made at the first start (prepareAccess), or by whoever has the setup code from the
 *   server's log (POST /api/setup); RESET_TWO_STEP, the way back in from the server's environment.
 * - GET /api/session: who is signed in and what they may do (describeMe), or what the sign-in page needs.
 * - Sign-in with a password (limited per address), the second step (an authenticator app, recovery codes) and
 *   setting it up, single sign-on through an identity provider (OIDC), with a Checkmarx One API key, and sign-out.
 * - A forgotten password: the emailed link, its check and the new password.
 * - The sign-in policy an Admin sets on People & roles (/api/iam/policy, /api/iam/sign-in) and resetting a
 *   person's two-step sign-in or single sign-on link.
 */
import path from 'node:path';
import { config } from '../config.js';
import { generatePassword, passwordProblem, publicUser } from '../iam.js';
import fs from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { sendReminderMail } from '../mailer.js';
import { calculatorBuiltIn, isVerified, mergeSettings, overlayBranding, supportChannel } from '../settings.js';
import { systemEmail } from '../hands-off.js';
import { pruneAttempts } from '../security.js';
import { DEFAULT_TENANT } from '../tenancy.js';
import { featureList, inLabs, mayUse } from '../features.js';
import { PasswordResets, RESET_TTL_MS, maskEmail, resetAllowed } from '../password-reset.js';
import { PendingSetups, SignInTickets, TICKET_TTL_MS, groupedKey, matchTotp, newRecoveryCodes, newSecret, otpauthUri, recoveryHash } from '../mfa.js';
import { OidcClient, SSO_CALLBACK_PATH, SSO_COOKIE, SSO_FLOW_TTL_MS, SsoError, SsoFlows, identityProblem, mergeSso, publicSso, ssoChanges } from '../oidc.js';
import { clearSessionCookie, cookieShouldBeSecure, describeSession, readSessionCookie, setSessionCookie } from '../session.js';
import { SYSTEM_ACTOR, clientIp, logSafe } from './shared.js';

/**
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerSessionRoutes(app, d) {
  const {
    MAINTAINER_EMAIL, dataDir, backupKey, sessions, saveSignInsSoon, tenancy, tstate, settingsStore, guard, audit,
    terms, iam, integrationSession, activations, languageAccess, allowedLanguages, asyncRoute, permissionsFor,
    isSuperAdmin, tenantsOf, currentSession, requireSession, ownBranding, can, requirePermission, featureLocked, inTenant,
    adminActor, LOOPBACK, requestOrigin, iamView, visibleUser, auditIam, endSessionsOf, refusalListed, tenantName,
    appNameNow, integrity, labs,
  } = d;

  let setupCode = '';
  const DEFAULT_ADMIN_EMAIL = 'admin@mission-zero.local';
  /** The generated first administrator's one-time password, until they choose their own. */
  const firstAdminFile = path.join(dataDir, 'first-admin-password.txt');

  async function prepareAccess() {
    if (iam.hasUsers()) {
      // A data volume used before: no new sign-in is printed, so say whom to sign in as and how to get back in.
      const admin = iam.users().find((u) => u.role === 'admin' && !u.disabled);
      console.log(`[access] Users already set up in ${dataDir}${admin ? `; an administrator is ${admin.email}` : ''}. Lost the password? Run: node scripts/reset-admin.mjs  (in a container: docker exec <name> node scripts/reset-admin.mjs)`);
      return;
    }
    const email = process.env.ADMIN_EMAIL?.trim();
    const password = process.env.ADMIN_PASSWORD ?? '';
    if (email && password) {
      try {
        const admin = await iam.createUser({ email, name: 'Administrator', role: 'admin', password, mustChangePassword: true });
        audit.record({ type: 'iam', outcome: 'changed', reason: `First administrator ${admin.email} created from ADMIN_EMAIL.`, actor: SYSTEM_ACTOR, details: { user: admin } });
        console.log('[access] First administrator created from ADMIN_EMAIL; they choose a new password at first sign-in.');
        return;
      } catch (error) {
        console.warn(`! [access] ADMIN_EMAIL / ADMIN_PASSWORD could not be used: ${error.message}`);
      }
    }
    if (String(process.env.FIRST_ADMIN ?? '').trim() === 'setup-code') {
      // Nobody can use the utility until someone proves they can read this server's log.
      setupCode = randomBytes(9).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, 'X').match(/.{1,4}/g).join('-');
      console.log('');
      console.log('  No users yet. Open the utility and create the first administrator with this setup code:');
      console.log(`      ${setupCode}`);
      console.log('');
      return;
    }
    // Default (and in containers): generate the first administrator and print the
    // sign-in once, in this log. It is also kept in a file only this server's user
    // can read, until they choose their own password at first sign-in.
    const adminEmail = email || DEFAULT_ADMIN_EMAIL;
    const generated = generatePassword();
    const admin = await iam.createUser({ email: adminEmail, name: 'Administrator', role: 'admin', password: generated, mustChangePassword: true });
    fs.writeFileSync(firstAdminFile, `${generated}\n`, { mode: 0o600 });
    audit.record({ type: 'iam', outcome: 'changed', reason: `First administrator ${admin.email} created with a generated password (printed in the server log once).`, actor: SYSTEM_ACTOR, details: { user: admin } });
    const line = '='.repeat(64);
    console.log(`\n${line}`);
    console.log('  First start: an administrator was created. Sign in with:');
    console.log(`      Email:    ${admin.email}`);
    console.log(`      Password: ${generated}`);
    console.log('  You choose your own password at first sign-in. This is shown only once;');
    console.log(`  until then it is also in ${firstAdminFile}.`);
    console.log('  Lost it? Run: node scripts/reset-admin.mjs  (in a container: docker exec <name> node scripts/reset-admin.mjs)');
    console.log(`${line}\n`);
  }

  /**
   * RESET_TWO_STEP=<email>: the way back in for someone whose authenticator app and recovery codes are both gone when
   * no Admin is left to reset it for them (the only Admin, say). At start-up their two-step sign-in is taken off;
   * they sign in with their password and set it up again. Whoever can set the server's environment can do this, as
   * they can run scripts/reset-admin.mjs. Recorded in the audit log. It works once for a person: left in the
   * environment it does nothing more, until the server has started without it.
   */
  function resetTwoStepFromEnvironment() {
    const email = String(process.env.RESET_TWO_STEP ?? '').trim().toLowerCase();
    if (!email) return iam.noteTwoStepResetFor('');
    if (iam.twoStepResetFor() === email) return console.warn('! [access] RESET_TWO_STEP was used for this person at an earlier start, so nothing was reset now. Take it out of the environment.');
    const user = iam.findByEmail(email);
    if (!user) return console.warn('! [access] RESET_TWO_STEP names nobody who has access here: nothing was reset. Take it out of the environment.');
    iam.noteTwoStepResetFor(email);
    if (iam.resetTwoStep(user.id)) {
      audit.record({ type: 'iam', outcome: 'changed', reason: `Two-step sign-in reset for ${user.email} from the server's environment (RESET_TWO_STEP).`, actor: SYSTEM_ACTOR });
      console.log(`[access] Two-step sign-in was reset for ${user.email} (RESET_TWO_STEP). Take RESET_TWO_STEP out of the environment now.`);
    } else {
      console.log(`[access] RESET_TWO_STEP: ${user.email} has no two-step sign-in to reset. Take RESET_TWO_STEP out of the environment.`);
    }
  }

  /** What this browser may see about itself: who is signed in, what they may do, and the connection. */
  function describeMe(session, user) {
    const held = permissionsFor(user);
    const settings = settingsStore.get();
    // "feature.<id>": what the page shows for each Beta feature this person may use (never checked by the server).
    const usable = featureList(settings).filter((f) => !featureLocked(f) && mayUse(settings, f.id, held));
    // "labs.active": Labs shows in the menu only while one of its items is turned on for this person.
    const permissions = [...held, ...usable.map((f) => `feature.${f.id}`), ...(usable.some((f) => inLabs(settings, f.id)) ? ['labs.active'] : [])];
    const integration = integrationSession();
    let tenant = '';
    try {
      tenant = integration?.connection?.tenant ?? '';
    } catch {}
    const organisation = terms.organisation();
    return {
      terms: {
        version: terms.version,
        organisationAccepted: Boolean(organisation),
        accepted: Boolean(organisation) && terms.acceptedBy(user.id),
        canAcceptForOrganisation: user.role === 'admin',
      },
      ...describeSession(session),
      user: publicUser(user),
      role: { id: user.role, name: iam.role(user.role)?.name ?? user.role },
      permissions,
      features: Object.fromEntries(featureList(settings).map((f) => [f.id, f.stage])),
      // The Cx Credits Calculator, for whoever may use it: the address an Admin gave (the menu opens it there), or
      // nothing, and the menu has no calculator. Only a server started with CALCULATOR_BUILTIN=on has the built-in one.
      calculator: !held.has('projections.use') ? null : settings.calculator?.external && settings.calculator.url ? { url: settings.calculator.url } : calculatorBuiltIn() ? { builtIn: true } : null,
      via: session.via,
      // Two-step sign-in for this person: on or not, how many recovery codes are left, and whether an Admin requires it.
      twoStep: { available: Boolean(user.passwordHash), on: Boolean(user.mfa?.secret), since: user.mfa?.secret ? user.mfa.enabledAt ?? '' : '', recoveryLeft: user.mfa?.secret ? (user.mfa.recovery ?? []).length : 0, required: iam.twoStepRequired() },
      // The organisation's Impact figures: what Your profile → Your Impact figures falls back to.
      organisationImpact: (({ currency, hourlyRate, creditPrice, triageMinutes, fixMinutes }) => ({ currency, hourlyRate, creditPrice, triageMinutes, fixMinutes }))(settings.impact),
      integration: { connected: Boolean(integration), tenant },
      // Connection settings put back because new ones did not work: shown once to each administrator.
      configNotices: held.has('integration.cxone') || held.has('integration.smtp') ? guard.unseen(user.id) : [],
      // Whether the code running is what the release workflow built: for those who look after updates.
      integrity: held.has('system.update') && integrity.last ? { state: integrity.last.state, summary: integrity.last.summary } : null,
      // The page's languages this person may use (Hebrew only for the people chosen).
      languages: languageAccess.available(allowedLanguages(user.id)),
      // Add-ons a code has unlocked (in date or not): until then the page does not show them.
      unlocked: { tenants: Boolean(activations.tenants()) || tenancy.enabled, impact: Boolean(activations.feature('impact')?.on), faeFlush: Boolean(activations.feature('faeFlush')?.on), govern: Boolean(activations.feature('govern')?.on), statusBoard: Boolean(activations.feature('statusBoard')?.on), consolidated: Boolean(activations.feature('consolidated')?.on) },
      // The product licence's end, for the Admins' banner in the last 30 days (src/activation.js).
      licence: held.has('activation.manage') ? (({ until, daysLeft, warn, activation }) => ({ until, daysLeft, warn, activation }))(activations.product()) : null,
      // Backups, for the Admins' notice: 'save-key' while nobody confirmed saving the backup key, 'not-encrypted' while they are plain.
      backupNotice: held.has('backup.manage') ? backupKey.status().notice : null,
      // The organisation's name (given with the terms of use), for what CxMissionZero makes for others.
      organisationName: terms.organisationName(),
      // Get help: the support portal here, or email to an address (installations whose mail cannot leave).
      support: (({ mode, email }) => ({ mode, email }))(supportChannel(settingsStore.get())),
      // The name and logo the page shows this person: theirs while they present their own branding.
      branding: (({ appName, logoUrl }) => ({ appName: appName || 'CxMissionZero', logoUrl: logoUrl || '', own: Boolean(ownBranding(user, held)) }))(overlayBranding(settings.branding, ownBranding(user, held))),
      // Several Checkmarx One tenants: the one this person works in now, and the ones they may switch to.
      tenancy: tenancy.enabled
        ? {
            current: { id: tenancy.current().id, name: tenantName(tenancy.current().id) },
            // With when each last fetched (tenants loaded since the start), for the switcher (Labs → Consolidated view).
            tenants: tenantsOf(user, held).map((id) => ({ id, name: tenantName(id), ...labs.fetchInfo(id) })),
            superAdmin: isSuperAdmin(held),
          }
        : null,
    };
  }

  app.get('/api/session', (req, res) => {
    const session = currentSession(req);
    const user = session ? iam.user(session.userId) : null;
    if (!session || !user || user.disabled) {
      // First start: nobody has signed in yet, so point at the log with the generated sign-in.
      const users = iam.users();
      const firstStart = users.length > 0 && users.every((u) => !u.lastLoginAt);
      // Single sign-on, when it is on and can work: the button's label, and whether passwords are for Admins only.
      const { sso, ready } = ssoState();
      return res.json({ connected: false, signedIn: false, setup: !iam.hasUsers() && Boolean(setupCode), firstStart, passwordReset: passwordResetReady().ready, sso: ready ? { label: sso.label, passwordAdminsOnly: sso.passwordAdminsOnly } : null });
    }
    // As the tenant they work in sees it: a key sign-in shows that tenant's connection, not its own key's.
    res.json(describeMe(inTenant(session, session.tenantId), user));
  });

  /** Sign-in attempts per address, to slow down guessing across many accounts. */
  const SIGN_IN_WINDOW_MS = 10 * 60 * 1000;
  const signInAttempts = new Map();
  function tooManySignIns(req) {
    const ip = clientIp(req);
    const now = Date.now();
    const recent = (signInAttempts.get(ip) ?? []).filter((t) => now - t < SIGN_IN_WINDOW_MS);
    recent.push(now);
    // Re-inserted, so the map stays in order of last attempt (oldest first).
    signInAttempts.delete(ip);
    signInAttempts.set(ip, recent);
    // Many addresses: forget the ones whose attempts have all expired, never the whole map
    // (that would hand a guesser a fresh start just by sending from enough addresses).
    pruneAttempts(signInAttempts, now, { windowMs: SIGN_IN_WINDOW_MS, max: 10_000 });
    return recent.length > 30;
  }
  function throttleSignIn(req, res) {
    if (!tooManySignIns(req)) return false;
    res.status(429).json({ error: 'Too many sign-in attempts from this address. Wait a few minutes.' });
    return true;
  }

  function auditAccess(req, outcome, reason, user = null, details) {
    audit.record({
      type: 'access',
      outcome,
      reason,
      actor: { kind: 'user', user: user?.email ?? '', ip: clientIp(req), userAgent: String(req.get('user-agent') ?? '').slice(0, 200) },
      ...(details ? { details } : {}),
    });
  }

  /** Sign in with an email and password; Checkmarx One is reached through the server's integration. */
  app.post(
    '/api/session/password',
    asyncRoute(async (req, res) => {
      if (throttleSignIn(req, res)) return;
      // (An email address is at most 254 characters: nothing longer is looked up, or written to the audit log.)
      const email = String(req.body?.email ?? '').trim().slice(0, 254);
      let user;
      try {
        // (With a second step to come, or a password that is no longer enough, this is not a sign-in yet.)
        user = await iam.signIn(email, String(req.body?.password ?? ''), Date.now(), { more: (u) => passwordNotEnough(u) || needsTwoStep(u) });
      } catch (error) {
        const known = error.userId ? iam.user(error.userId) : null;
        res.locals.activityUser = known ?? { email };
        // (Listed only so many a minute, by address and in all: nobody has signed in here, and the log is never trimmed.)
        if (refusalListed(`address ${clientIp(req)}`, Date.now(), 'signIn')) auditAccess(req, 'refused', `Sign-in refused for ${email || '(no email)'}: ${error.message}${error.locked ? ' Account locked.' : ''}`, known);
        throw error;
      }
      res.locals.activityUser = user;
      // Single sign-on is on and passwords are kept for Admins: said only to someone who typed the right password.
      if (passwordNotEnough(user)) {
        res.locals.signInRefused = true;
        if (refusalListed(`address ${clientIp(req)}`, Date.now(), 'signIn')) auditAccess(req, 'refused', `Sign-in refused for ${user.email}: only Admins may sign in with a password; everyone else uses single sign-on.`, user);
        return res.status(403).json({ error: 'Signing in with a password is turned off for this account. Use single sign-on.', sso: true });
      }
      // Two-step sign-in: no session yet, only a ticket for the code (or, when an Admin requires it and this person has none, for setting it up).
      if (needsTwoStep(user)) {
        const secret = user.mfa?.secret ? '' : newSecret();
        const ticket = signInTickets.issue(user.id, { secret });
        // (In User activity this is not a sign-in yet.)
        res.locals.activityAction = secret ? 'Typed the right password: asked to set up two-step sign-in' : 'Typed the right password: asked for the two-step code';
        res.set('Cache-Control', 'no-store');
        return res.json({ twoStep: true, ticket, minutes: Math.round(TICKET_TTL_MS / 60_000), ...(secret ? { setup: twoStepSetup(user, secret) } : {}) });
      }
      res.status(201).json(openPasswordSession(req, res, user, 'signed in with a password'));
    }),
  );

  /** The session a password sign-in gives (single sign-on gives the same one, `via` apart), with its cookie and audit entry. */
  function openPasswordSession(req, res, user, how, via = 'password') {
    const session = sessions.createLinked(integrationSession);
    Object.assign(session, { userId: user.id, via });
    saveSignInsSoon();
    setSessionCookie(req, res, session.id);
    res.locals.activityUser = user;
    auditAccess(req, 'info', `${user.email} ${how}.`, user);
    return describeMe(session, user);
  }

  // ---------------------------------------------------------------------------
  // Two-step sign-in (src/mfa.js): a code from an authenticator app after the password
  // ---------------------------------------------------------------------------

  const signInTickets = new SignInTickets();
  const pendingSetups = new PendingSetups();
  /** A second step stands between this person's correct password and a session: they have it on, or an Admin requires it. */
  const needsTwoStep = (user) => Boolean(user.mfa?.secret) || iam.twoStepRequired();
  /** What the page shows to set an authenticator app up: the key (also in groups of four) and the address its QR code carries. */
  const twoStepSetup = (user, secret) => ({ secret, key: groupedKey(secret), otpauth: otpauthUri(user.email, secret) });
  const TICKET_OVER = 'That sign-in is over: it lasts five minutes and takes a few tries. Sign in again.';
  const WRONG_CODE = 'That code is not right. Use the newest code in your authenticator app, and check that the phone\'s clock is right.';

  /** Turn two-step sign-in on for `user` with a secret their app has just proved it holds: ten new recovery codes, shown this once. */
  function turnOnTwoStep(user, secret, step) {
    const codes = newRecoveryCodes();
    iam.enableTwoStep(user.id, secret, { step, recovery: codes.map((code) => recoveryHash(user.id, code)) });
    return codes;
  }

  /** The second step: the ticket from the password step, and a code (or a recovery code). Only then is there a session. */
  app.post(
    '/api/session/two-step',
    asyncRoute(async (req, res) => {
      if (throttleSignIn(req, res)) return;
      const ticket = String(req.body?.ticket ?? '');
      const typed = String(req.body?.code ?? '').slice(0, 40);
      const entry = signInTickets.get(ticket);
      const user = entry ? iam.user(entry.userId) : null;
      const refused = (status, message, why, extra = {}) => {
        if (refusalListed(`address ${clientIp(req)}`, Date.now(), 'signIn')) auditAccess(req, 'refused', `Sign-in refused${user ? ` for ${user.email}` : ''}: ${why}`, user);
        return res.status(status).json({ error: message, ...extra });
      };
      if (!entry || !user) return refused(401, TICKET_OVER, 'the two-step sign-in was over, or was never started.', { restart: true });
      res.locals.activityUser = user;
      if (user.disabled) {
        signInTickets.consume(ticket);
        return refused(403, 'This account is disabled. Ask an administrator.', 'the account is disabled.', { restart: true });
      }
      let how = 'signed in with a password and a two-step code';
      let recoveryCodes = null;
      if (entry.secret) {
        // An Admin requires two-step sign-in and this person had none: the first right code turns it on.
        if (user.mfa?.secret) {
          signInTickets.consume(ticket);
          return refused(409, 'Two-step sign-in was turned on for this account in the meantime. Sign in again.', 'two-step sign-in was set up elsewhere in the meantime.', { restart: true });
        }
        const step = matchTotp(entry.secret, typed);
        if (!step) {
          const left = signInTickets.wrong(ticket);
          return refused(401, left ? WRONG_CODE : TICKET_OVER, 'wrong code while setting up two-step sign-in.', { restart: !left });
        }
        recoveryCodes = turnOnTwoStep(user, entry.secret, step);
        audit.record({ type: 'iam', outcome: 'changed', reason: `${user.email} turned on two-step sign-in (required at sign-in).`, actor: resetActor(req, user.email) });
        how = 'signed in with a password and set up two-step sign-in';
      } else {
        if (!user.mfa?.secret) {
          signInTickets.consume(ticket);
          return refused(409, 'Two-step sign-in was reset for this account in the meantime. Sign in again.', 'two-step sign-in was reset in the meantime.', { restart: true });
        }
        let result;
        try {
          result = iam.checkTwoStep(user.id, typed);
        } catch (error) {
          if (error.status === 423) {
            signInTickets.consume(ticket);
            return refused(423, error.message, 'the account is locked after too many wrong attempts.', { restart: true });
          }
          if (error.status !== 401) throw error;
          const left = signInTickets.wrong(ticket);
          const over = !left || Boolean(error.locked);
          if (over) signInTickets.consume(ticket);
          return refused(401, over ? TICKET_OVER : WRONG_CODE, `wrong two-step code.${error.locked ? ' Account locked.' : ''}`, { restart: over });
        }
        if (result.kind === 'recovery') {
          audit.record({ type: 'iam', outcome: 'changed', reason: `${user.email} used a recovery code to sign in: it is gone, ${result.left} left.`, actor: resetActor(req, user.email) });
          how = `signed in with a password and a recovery code (${result.left} left)`;
        }
      }
      signInTickets.consume(ticket);
      iam.recordSignIn(user);
      const me = openPasswordSession(req, res, iam.user(user.id), how);
      res.set('Cache-Control', 'no-store');
      res.status(201).json({ ...me, ...(recoveryCodes ? { recoveryCodes } : {}) });
    }),
  );

  /** Someone signed in turns two-step sign-in on: first a secret to put in their authenticator app (kept in memory until proved). */
  app.post('/api/me/two-step/setup', requireSession, (req, res) => {
    if (!req.user.passwordHash) return res.status(400).json({ error: 'Two-step sign-in is for people who sign in with a password. Set a password first.' });
    if (req.user.mfa?.secret) return res.status(400).json({ error: 'Two-step sign-in is already on.' });
    res.set('Cache-Control', 'no-store');
    res.json(twoStepSetup(req.user, pendingSetups.start(req.user.id)));
  });

  /** …then the code their app shows: only now is it on. The recovery codes are shown this once. */
  app.post(
    '/api/me/two-step/enable',
    requireSession,
    asyncRoute(async (req, res) => {
      if (req.user.mfa?.secret) return res.status(400).json({ error: 'Two-step sign-in is already on.' });
      const secret = pendingSetups.get(req.user.id);
      if (!secret) return res.status(400).json({ error: 'That key is more than ten minutes old. Start again.', restart: true });
      const step = matchTotp(secret, req.body?.code);
      if (!step) return res.status(400).json({ error: WRONG_CODE });
      const recoveryCodes = turnOnTwoStep(req.user, secret, step);
      pendingSetups.clear(req.user.id);
      audit.record({ type: 'iam', outcome: 'changed', reason: `${req.user.email} turned on two-step sign-in.`, actor: await adminActor(req) });
      res.set('Cache-Control', 'no-store');
      res.json({ recoveryCodes, me: describeMe(req.session, iam.user(req.user.id)) });
    }),
  );

  /** A current code from the app, checked for someone signed in (turning it off, new recovery codes). Wrong ones count towards the lock. */
  async function ownTwoStepCode(req, res, what) {
    try {
      iam.checkTwoStep(req.user.id, req.body?.code, { recovery: false });
      return true;
    } catch (error) {
      if (error.status !== 401 && error.status !== 423) throw error;
      audit.record({ type: 'iam', outcome: 'refused', reason: `${req.user.email} could not ${what}: ${error.status === 423 ? 'too many wrong codes' : 'wrong code'}.`, actor: await adminActor(req) });
      res.status(error.status === 423 ? 423 : 400).json({ error: error.status === 423 ? error.message : WRONG_CODE });
      return false;
    }
  }

  /** Turn one's own two-step sign-in off: only with a current code, and not while an Admin requires it. */
  app.post(
    '/api/me/two-step/disable',
    requireSession,
    asyncRoute(async (req, res) => {
      if (!req.user.mfa?.secret) return res.status(400).json({ error: 'Two-step sign-in is not on.' });
      if (iam.twoStepRequired()) return res.status(403).json({ error: 'An administrator requires two-step sign-in for everyone who signs in with a password, so it cannot be turned off.' });
      if (!(await ownTwoStepCode(req, res, 'turn off two-step sign-in'))) return;
      iam.resetTwoStep(req.user.id);
      signInTickets.revokeUser(req.user.id);
      audit.record({ type: 'iam', outcome: 'changed', reason: `${req.user.email} turned off two-step sign-in.`, actor: await adminActor(req) });
      res.json({ me: describeMe(req.session, iam.user(req.user.id)) });
    }),
  );

  /** Ten new recovery codes in place of the old ones: with a current code. */
  app.post(
    '/api/me/two-step/recovery-codes',
    requireSession,
    asyncRoute(async (req, res) => {
      if (!req.user.mfa?.secret) return res.status(400).json({ error: 'Two-step sign-in is not on.' });
      if (!(await ownTwoStepCode(req, res, 'make new recovery codes'))) return;
      const recoveryCodes = newRecoveryCodes();
      iam.setRecoveryCodes(req.user.id, recoveryCodes.map((code) => recoveryHash(req.user.id, code)));
      audit.record({ type: 'iam', outcome: 'changed', reason: `${req.user.email} made new recovery codes; the old ones no longer work.`, actor: await adminActor(req) });
      res.set('Cache-Control', 'no-store');
      res.json({ recoveryCodes, me: describeMe(req.session, iam.user(req.user.id)) });
    }),
  );

  // ---------------------------------------------------------------------------
  // Single sign-on with OpenID Connect (src/oidc.js)
  // ---------------------------------------------------------------------------

  const oidc = new OidcClient();
  const ssoFlows = new SsoFlows();

  /** Single sign-on as set, the address the identity provider sends people back to, and whether it can work now (and if not, why). */
  function ssoState() {
    const sso = iam.sso();
    // The address set under Settings, or, when that one is not an https address, the deployment's own (REPORT_SERVER_URL).
    const base = tenancy.run(DEFAULT_TENANT, () => resetLinkBase(settingsStore.get())) || resetLinkBase({ links: {} });
    const missing = [];
    if (!sso.issuer || !sso.clientId) missing.push('The identity provider\'s address and the client id are not set.');
    if (!base) missing.push('No https address for this server is set (Settings → Server address).');
    return { sso, base, redirectUri: base ? `${base}${SSO_CALLBACK_PATH}` : '', missing, ready: sso.enabled && missing.length === 0 };
  }

  /**
   * With single sign-on on and "only Admins may still sign in with a password": a correct password is not enough for
   * anyone else. Only those two switches decide, both an Admin's. Whether single sign-on can work right now (the
   * server's address, which others may change) never does: it could otherwise be used to bring passwords back.
   */
  function passwordNotEnough(user) {
    const sso = iam.sso();
    return sso.enabled && sso.passwordAdminsOnly && user.role !== 'admin';
  }

  const SSO_ADDRESS_ADMIN = 'Single sign-on is on, and the identity provider sends people back to this server\'s address, so only an Admin changes it.';
  const SSO_NEEDS_ADDRESS = 'Single sign-on is on, and people come back from the identity provider to this server\'s address, so it must stay an https address. Give an https address, or turn single sign-on off first (People & roles → Sign-in).';
  /**
   * Why the server's address may not be changed as asked ('' when it may): while single sign-on is on, only an Admin
   * changes it, and a change that would leave no https address for the way back is refused for everyone, Admins too
   * (they turn single sign-on off first). (The first tenant's address: the one sign-in uses.)
   */
  function ssoAddressProblem(req, links) {
    if (!links || !('reportServerUrl' in links) || (req.tenantId ?? DEFAULT_TENANT) !== DEFAULT_TENANT || !iam.sso().enabled) return '';
    const current = settingsStore.get();
    const next = mergeSettings(current, { links: { reportServerUrl: links.reportServerUrl } }).links.reportServerUrl;
    if (next === current.links.reportServerUrl) return '';
    // Any change moves the way back from the identity provider: that is for an Admin, who can change it there too.
    if (req.user?.role !== 'admin') return SSO_ADDRESS_ADMIN;
    return resetLinkBase({ links: { reportServerUrl: next } }) || (!next && resetLinkBase({ links: {} })) ? '' : SSO_NEEDS_ADDRESS;
  }

  /** One cookie by name, as readSessionCookie reads the session's. */
  function readCookie(req, name) {
    for (const part of String(req.headers.cookie ?? '').split(';')) {
      const [key, ...rest] = part.trim().split('=');
      if (key === name) return rest.join('=');
    }
    return '';
  }
  const SSO_COOKIE_PATH = '/api/session/oidc';
  const setSsoCookie = (req, res, value) => res.append('Set-Cookie', [`${SSO_COOKIE}=${value}`, `Path=${SSO_COOKIE_PATH}`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.round(SSO_FLOW_TTL_MS / 1000)}`, cookieShouldBeSecure(req) ? 'Secure' : ''].filter(Boolean).join('; '));
  const clearSsoCookie = (res) => res.append('Set-Cookie', `${SSO_COOKIE}=; Path=${SSO_COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=0`);

  /**
   * Back to the sign-in page with a short code, which picks the sentence the page shows (public/app.js). What went
   * wrong is written, scrubbed, in the server log and the audit log: never a token, the client secret or the
   * provider's own error text.
   */
  function ssoRefused(req, res, code, why, user = null) {
    res.locals.signInRefused = true;
    if (user) res.locals.activityUser = user;
    // (Listed only so many a minute, in the audit log and in the server log: nobody has signed in here.)
    if (refusalListed(`address ${clientIp(req)}`, Date.now(), 'signIn')) {
      console.warn(`! [single sign-on] Not signed in (${code}): ${logSafe(why)}.`);
      auditAccess(req, 'refused', `Single sign-on refused${user ? ` for ${user.email}` : ''}: ${why}.`, user);
    }
    res.redirect(`/#sso=${code}`);
  }

  /** The "single sign-on" button: off to the identity provider, with a state, a nonce and a PKCE challenge for the way back. */
  app.get(
    '/api/session/oidc/start',
    asyncRoute(async (req, res) => {
      res.set('Cache-Control', 'no-store');
      if (tooManySignIns(req)) return res.redirect('/#sso=busy');
      const { sso, redirectUri, ready, base } = ssoState();
      if (!sso.enabled) return res.redirect('/#sso=off');
      if (!ready) return res.redirect('/#sso=setup');
      // Opened at another address than the server's own (an IP address, an old name): the round trip begins where it
      // ends, or the browser would not send its cookie on the way back. Once only (`at`), so it can never go in circles.
      const here = requestOrigin(req);
      if (req.query.at === undefined && here && new URL(here).host.toLowerCase() !== new URL(base).host.toLowerCase()) return res.redirect(`${base}/api/session/oidc/start?at=server`);
      const flow = ssoFlows.start();
      let url;
      try {
        url = await oidc.authorizationUrl(sso, redirectUri, flow);
      } catch (error) {
        if (!(error instanceof SsoError)) throw error;
        console.warn(`! [single sign-on] Could not start (${error.code}): ${logSafe(error.message)}.`);
        return res.redirect(`/#sso=${error.code}`);
      }
      setSsoCookie(req, res, flow.cookie);
      res.redirect(url);
    }),
  );

  /** The way back from the identity provider: the code is exchanged, the ID token verified, and the person it names signed in. */
  app.get(
    SSO_CALLBACK_PATH,
    asyncRoute(async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const one = (value) => (typeof value === 'string' ? value : '');
      const flow = ssoFlows.take(one(req.query.state), readCookie(req, SSO_COOKIE));
      // The answer to a sign-in this browser started was counted when it started. Anything else is an attempt of its own.
      if (!flow && tooManySignIns(req)) return res.redirect('/#sso=busy');
      const { sso, redirectUri, ready, base } = ssoState();
      if (!sso.enabled) return ssoRefused(req, res, 'off', 'single sign-on is turned off');
      if (!ready) return ssoRefused(req, res, 'setup', 'single sign-on is not set up completely');
      if (!flow) return ssoRefused(req, res, 'expired', 'the answer belongs to no sign-in started from this browser in the last ten minutes (state)');
      if (req.query.error !== undefined) {
        const said = /^[a-z0-9_.-]{1,60}$/i.test(one(req.query.error)) ? one(req.query.error) : 'an error';
        return ssoRefused(req, res, 'cancelled', `the identity provider answered ${said}`);
      }
      const code = one(req.query.code);
      if (!code || code.length > 4096) return ssoRefused(req, res, 'provider', 'the identity provider sent no code');
      let identity;
      try {
        identity = await oidc.finish(sso, redirectUri, { code, ...flow });
        const problem = identityProblem(sso, identity);
        if (problem) throw problem;
      } catch (error) {
        if (!(error instanceof SsoError)) throw error;
        return ssoRefused(req, res, error.code, error.message);
      }
      // Someone who has signed in this way before is the person linked to that account at the provider, whatever
      // its email address says now. Anyone else is found by email, once, and linked from then on.
      const linked = iam.findBySso(identity.issuer, identity.sub);
      let user = linked ?? iam.findByEmail(identity.email);
      if (user && !linked) {
        if (user.sso?.sub) return ssoRefused(req, res, 'link', `${user.email} is linked to another account at the identity provider (reset the single sign-on link under People & roles if that account was made anew)`, user);
        // Whatever the "verified" switch says: people who may manage people are never linked on an address the provider does not vouch for.
        if (!identity.verified && iam.permissionsOf({ ...user, disabled: false }).has('iam.manage')) {
          return ssoRefused(req, res, 'email', `the identity provider does not mark ${identity.email} as verified, and someone who may manage people is not signed in on such an address until they are linked`, user);
        }
      }
      if (!user && sso.provision === 'create') {
        // (The same rule for someone about to be added with a role that may manage people.)
        if (!identity.verified && iam.permissionsOf({ role: sso.role, disabled: false }).has('iam.manage')) {
          return ssoRefused(req, res, 'email', `the identity provider does not mark ${identity.email} as verified, and nobody is added with a role that may manage people on such an address`);
        }
        // An Admin chose to add people the identity provider signs in, with this role (never Admin: src/oidc.js).
        const added = await iam.createUser({ email: identity.email, name: identity.name, role: sso.role, mustChangePassword: false });
        audit.record({ type: 'iam', outcome: 'changed', reason: `Added ${added.email} as ${iam.role(added.role)?.name ?? added.role} at their first single sign-on.`, actor: SYSTEM_ACTOR, details: { user: added } });
        user = iam.user(added.id);
      }
      if (!user) return ssoRefused(req, res, 'unknown', `${identity.email} is not in People & roles`);
      if (user.disabled) return ssoRefused(req, res, 'disabled', 'the account is disabled', user);
      if (!linked) {
        iam.linkSso(user.id, identity);
        audit.record({ type: 'iam', outcome: 'changed', reason: `${user.email} was linked to their account at the identity provider at their first single sign-on.`, actor: resetActor(req, user.email) });
        user = iam.user(user.id);
      }
      iam.recordSignIn(user);
      openPasswordSession(req, res, user, 'signed in with single sign-on', 'sso');
      clearSsoCookie(res);
      res.redirect(`${base}/`);
    }),
  );

  // ---------------------------------------------------------------------------
  // Forgotten password: a one-time link to the account's own email (src/password-reset.js)
  // ---------------------------------------------------------------------------

  const passwordResets = new PasswordResets();
  /** Links being used right now, so one link cannot set two passwords at once. */
  const resetsInFlight = new Set();
  const RESET_ASKED = 'If that address has an account that may reset its password here, a link to choose a new one is on its way. It works once, for 30 minutes. Nothing arrived? Check spam, or ask an administrator.';
  const RESET_DEAD = 'This link no longer works: it was used, a newer one was sent, it is more than 30 minutes old, or the password has changed since. Ask for a new one.';

  /**
   * The address reset links point at: only the one set for this server (Settings → Server address,
   * or REPORT_SERVER_URL / PUBLIC_URL), never the address a request came in on, which anyone can
   * forge to steer the link (and its secret) to their own site. https, unless it is this computer.
   */
  function resetLinkBase(settings) {
    const url = String(settings.links?.reportServerUrl || config.reportServerUrl || '');
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOOPBACK.test(parsed.hostname))) return url.replace(/\/+$/, '');
    } catch {}
    return '';
  }

  /** Whether "Forgot your password?" can work, and if not why (the main tenant's email and address). */
  function passwordResetReady() {
    return tenancy.run(DEFAULT_TENANT, () => {
      const settings = settingsStore.get();
      const policy = iam.passwordResetPolicy();
      const missing = [];
      if (policy === 'off') missing.push('Turned off.');
      if (!isVerified(settings)) missing.push('The email server is not set up and tested (Settings → Email server).');
      if (!resetLinkBase(settings)) missing.push('No https address for this server is set (Settings → Server address).');
      return { ready: missing.length === 0, policy, missing };
    });
  }

  /** Admins (who may manage people or tenants) can be kept out of resetting by email. */
  const managesPeople = (user) => {
    const held = iam.permissionsOf({ ...user, disabled: false });
    return held.has('iam.manage') || held.has('tenants.manage');
  };

  const resetActor = (req, email = '') => ({ kind: 'user', user: email, ip: clientIp(req), userAgent: String(req.get('user-agent') ?? '').slice(0, 200) });
  const utc = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

  /** Look the person up and send the link, after the answer was given (so timing says nothing). */
  async function sendResetLink(email, req) {
    const user = iam.findByEmail(email);
    const settings = settingsStore.get();
    const base = resetLinkBase(settings);
    const why = !user
      ? 'no account has that address'
      : user.disabled
        ? 'the account is disabled'
        : !user.passwordHash
          ? 'the account signs in with a Checkmarx One key only'
          : !resetAllowed(iam.passwordResetPolicy(), { isAdmin: managesPeople(user) })
            ? 'resetting by email is not allowed for this account'
            : user.email.toLowerCase() === MAINTAINER_EMAIL.toLowerCase()
              ? 'this address is never emailed by the server'
              : !base || !isVerified(settings)
                ? 'email or the server address is not set up'
                : !passwordResets.maySend(user.id)
                  ? 'too many links for this account in the last hour'
                  : '';
    if (why) {
      // What was typed is kept only when it is an account here: it may be a password typed in the wrong box.
      auditAccess(req, 'refused', `Password reset asked${user ? ` for ${user.email}` : ' for an address with no account here'}: no link sent (${why}).`, user);
      return;
    }
    const { token, exp } = passwordResets.issue(user);
    const appName = appNameNow();
    // The secret travels after #: browsers never send that part to a server, nor in a Referer.
    const link = `${base}/#reset=${token}`;
    const message = systemEmail({
      appName,
      subject: `Reset your ${appName} password`,
      lines: [
        `Someone, hopefully you, asked to reset the password of ${user.email} on ${appName}.`,
        'To choose a new password, open the link below. It works once, for 30 minutes, and only on this server.',
      ],
      facts: [['Asked from', clientIp(req) || 'unknown'], ['Asked at', utc(Date.now())], ['Link works until', utc(exp)]],
      buttons: [{ label: 'Choose a new password', url: link }],
      footer: 'Did not ask for this? Ignore this email: your password stays as it is, and the link stops working by itself. If it keeps happening, tell an administrator.',
      replyHelp: false,
    });
    try {
      await sendReminderMail(settings, message, { exact: true, to: [user.email] });
      auditAccess(req, 'info', `Password reset link sent to ${user.email} (works until ${utc(exp)}).`, user);
    } catch (error) {
      passwordResets.revokeUser(user.id);
      auditAccess(req, 'failed', `Password reset link for ${user.email} could not be sent: ${error.message}`, user);
    }
  }

  /** "Forgot your password?": always the same answer, whether or not the address has an account. */
  app.post('/api/session/password-reset', (req, res) => {
    if (passwordResets.ipBlocked(clientIp(req))) return res.status(429).json({ error: 'Too many requests from this address. Wait a quarter of an hour.' });
    passwordResets.noteIp(clientIp(req));
    const email = String(req.body?.email ?? '').trim().slice(0, 254);
    if (!email) return res.status(400).json({ error: 'Enter the email address you sign in with.' });
    res.status(202).json({ message: RESET_ASKED });
    setImmediate(() =>
      tenancy.run(DEFAULT_TENANT, () => sendResetLink(email, req)).catch((error) => console.error(`[password reset] ${error.message}`)),
    );
  });

  /** Does a link still work? Says whose account it is for (partly hidden), so the person knows. */
  app.post('/api/session/password-reset/check', (req, res) => {
    if (passwordResets.ipBlocked(clientIp(req))) return res.status(429).json({ error: 'Too many requests from this address. Wait a quarter of an hour.' });
    const user = passwordResets.check(req.body?.token, (id) => iam.user(id));
    if (!user || !resetAllowed(iam.passwordResetPolicy(), { isAdmin: managesPeople(user) })) {
      passwordResets.noteIp(clientIp(req));
      return res.status(400).json({ error: RESET_DEAD });
    }
    res.json({ email: maskEmail(user.email), minutes: Math.round(RESET_TTL_MS / 60_000) });
  });

  /** Choose the new password: the link is used up, and every session of the account ends. */
  app.post(
    '/api/session/password-reset/confirm',
    asyncRoute(async (req, res) => {
      if (passwordResets.ipBlocked(clientIp(req))) return res.status(429).json({ error: 'Too many requests from this address. Wait a quarter of an hour.' });
      const token = String(req.body?.token ?? '');
      const password = String(req.body?.password ?? '');
      const user = passwordResets.check(token, (id) => iam.user(id));
      if (!user || !resetAllowed(iam.passwordResetPolicy(), { isAdmin: managesPeople(user) })) {
        passwordResets.noteIp(clientIp(req));
        return res.status(400).json({ error: RESET_DEAD });
      }
      if (resetsInFlight.has(user.id)) return res.status(409).json({ error: 'This link is already being used. Wait a moment.' });
      resetsInFlight.add(user.id);
      try {
        const problem = passwordProblem(password);
        if (problem) return res.status(400).json({ error: problem });
        if (await iam.isCurrentPassword(user.id, password)) return res.status(400).json({ error: 'Choose a password different from the current one.' });
        passwordResets.consume(token);
        await iam.setPassword(user.id, password, { mustChange: false });
        passwordResets.revokeUser(user.id);
        // Whoever was signed in as them, maybe the person who made the reset necessary, is signed out.
        endSessionsOf(user.id);
        audit.record({ type: 'iam', outcome: 'changed', reason: `${user.email} reset their password with an emailed link.`, actor: resetActor(req, user.email) });
        const appName = appNameNow();
        const settings = tenancy.run(DEFAULT_TENANT, () => settingsStore.get());
        sendReminderMail(
          settings,
          systemEmail({
            appName,
            subject: `Your ${appName} password was changed`,
            lines: [`The password of ${user.email} on ${appName} was just changed with a reset link sent to this address, and every place it was signed in was signed out.`],
            facts: [['Changed from', clientIp(req) || 'unknown'], ['Changed at', utc(Date.now())]],
            footer: 'Was this not you? Tell an administrator at once: they can disable the account and set a new password.',
            replyHelp: false,
          }),
          { exact: true, to: [user.email] },
        ).catch((error) => console.error(`[password reset] The confirmation to ${user.email} could not be sent: ${error.message}`));
        res.json({ email: user.email });
      } finally {
        resetsInFlight.delete(user.id);
      }
    }),
  );

  /** Who may reset a forgotten password by email: for the whole server, so a Super Admin's when there are several tenants. */
  app.put('/api/iam/policy', requirePermission('iam.manage'), (req, res) => {
    if (tenancy.enabled && !isSuperAdmin(req.permissions)) return res.status(403).json({ error: 'Sign-in rules are for the whole server: a Super Admin changes them.' });
    const { before, after } = iam.setPasswordResetPolicy(String(req.body?.passwordReset ?? ''));
    if (before !== after) {
      audit.record({ type: 'iam', outcome: 'changed', reason: `Password reset by email: ${RESET_POLICY_NAMES[before]} → ${RESET_POLICY_NAMES[after]}.`, actor: { kind: 'user', user: req.user.email, ip: clientIp(req) } });
    }
    res.json(passwordResetReady());
  });
  const RESET_POLICY_NAMES = { everyone: 'everyone', 'not-admins': 'everyone but Admins', off: 'off' };

  /** Two-step sign-in for everyone and single sign-on are an Admin's to set (the Admin role), for the whole server. */
  const maySetSignInSecurity = (req) => can(req, 'iam.manage') && req.user.role === 'admin' && (!tenancy.enabled || isSuperAdmin(req.permissions));

  /** What the Admin's Sign-in page shows of them: never the client secret, only whether one is set. */
  function signInSecurityView() {
    const { sso, redirectUri, missing } = ssoState();
    return {
      twoStepRequired: iam.twoStepRequired(),
      sso: publicSso(sso),
      redirectUri,
      missing,
      // The roles people added by single sign-on may be given: every role but Admin.
      roles: iam.roles().filter((r) => r.id !== 'admin').map((r) => ({ id: r.id, name: r.name })),
    };
  }

  app.put(
    '/api/iam/sign-in',
    requirePermission('iam.manage'),
    asyncRoute(async (req, res) => {
      if (!maySetSignInSecurity(req)) return res.status(403).json({ error: tenancy.enabled && req.user.role === 'admin' ? 'Sign-in rules are for the whole server: a Super Admin changes them.' : 'Only an Admin changes two-step sign-in for everyone and single sign-on.' });
      const body = req.body ?? {};
      if ('twoStepRequired' in body) {
        const { before, after } = iam.setTwoStepRequired(body.twoStepRequired === true);
        if (before !== after) await auditIam(req, `Two-step sign-in for everyone who signs in with a password: ${before ? 'required' : 'not required'} → ${after ? 'required' : 'not required'}.`);
      }
      if (body.sso && typeof body.sso === 'object') {
        const next = mergeSso(iam.sso(), body.sso, { roles: iam.roles().filter((r) => r.id !== 'admin').map((r) => r.id) });
        const { before, after } = iam.setSso(next);
        const changed = ssoChanges(before, after);
        if (changed.length) {
          oidc.forget();
          // (The client secret is never part of the log: only that it changed, and whether one is set.)
          await auditIam(req, `Changed single sign-on: ${changed.join(', ')}.`, { before: publicSso(before), after: publicSso(after) });
        }
        // Another identity provider: the links to people's accounts at the old one mean nothing there.
        if (before.issuer.replace(/\/+$/, '') !== after.issuer.replace(/\/+$/, '')) {
          const cleared = iam.clearSsoLinks();
          if (cleared) await auditIam(req, `The identity provider changed: the single sign-on links of ${cleared} ${cleared === 1 ? 'person' : 'people'} were reset. Each is linked again at their next single sign-on.`);
        }
      }
      res.json(iamView(req));
    }),
  );

  /** The Admin's "Check" button: can the identity provider be reached as set, through this server's proxy and trusted certificates? */
  app.post(
    '/api/iam/sign-in/sso/check',
    requirePermission('iam.manage'),
    asyncRoute(async (req, res) => {
      if (!maySetSignInSecurity(req)) return res.status(403).json({ error: 'Only an Admin checks single sign-on.' });
      const { sso, missing } = ssoState();
      if (!sso.issuer) return res.json({ ok: false, message: 'Give the identity provider\'s address first, and save.' });
      const result = await oidc.check(sso);
      res.json({ ok: result.ok && !missing.length, message: [result.message, ...(result.ok ? missing : [])].join(' ') });
    }),
  );

  /**
   * Reset someone's link to their account at the identity provider (it was made anew there, so its subject changed):
   * their next single sign-on links them again, by their email address. One's own included.
   */
  app.delete(
    '/api/iam/users/:id/sso-link',
    requirePermission('iam.manage'),
    asyncRoute(async (req, res) => {
      const target = visibleUser(req, req.params.id);
      if (!iam.canGrant(req.permissions, iam.permissionsOf({ ...target, disabled: false }))) {
        return res.status(403).json({ error: 'You cannot reset this person\'s single sign-on link: their role holds permissions you do not have.' });
      }
      if (iam.unlinkSso(target.id)) await auditIam(req, `Reset the single sign-on link of ${target.email}.`);
      res.json(iamView(req));
    }),
  );

  /** An Admin takes someone's two-step sign-in off (a lost phone): they set it up again themselves, at once when it is required. */
  app.delete(
    '/api/iam/users/:id/two-step',
    requirePermission('iam.manage'),
    asyncRoute(async (req, res) => {
      if (req.params.id === req.user.id) return res.status(400).json({ error: 'Turn your own two-step sign-in off under Settings → Your profile.' });
      const target = visibleUser(req, req.params.id);
      if (!iam.canGrant(req.permissions, iam.permissionsOf({ ...target, disabled: false }))) {
        return res.status(403).json({ error: 'You cannot reset this person\'s two-step sign-in: their role holds permissions you do not have.' });
      }
      if (iam.resetTwoStep(target.id)) {
        signInTickets.revokeUser(target.id);
        pendingSetups.clear(target.id);
        await auditIam(req, `Reset two-step sign-in for ${target.email}.`);
      }
      res.json(iamView(req));
    }),
  );

  /**
   * Sign in with a Checkmarx One API key. The key's identity (email, username or
   * client id) must belong to a user here; the session then calls Checkmarx One
   * with that person's own key.
   */
  app.post(
    '/api/session',
    asyncRoute(async (req, res) => {
      if (throttleSignIn(req, res)) return;
      if (!iam.hasUsers()) return res.status(403).json({ error: 'Create the first administrator before anyone signs in.', setup: true });
      // Identity comes from the token Checkmarx One issues for the key, so the key
      // may only ever be exchanged at this server's own, trusted Checkmarx One —
      // never at an address taken from the key or the browser, where anyone could
      // run a look-alike that vouches for any email.
      const trusted = trustedCheckmarxOne();
      if (!trusted) {
        return res.status(403).json({ error: 'Signing in with a Checkmarx One key works once an Admin has connected this server to Checkmarx One. Sign in with your email and password.' });
      }
      const session = await sessions.create(req.body?.apiKey, trusted);
      const identity = await session.client.identity();
      const seen = identity.email || identity.user || identity.clientId || 'unknown';
      const refuse = (message) => {
        res.locals.activityUser = { email: seen };
        sessions.destroy(session.id);
        auditAccess(req, 'refused', message, null, { identity: { ...identity }, tenant: session.connection.tenant });
        return res.status(403).json({ error: message });
      };
      const user = iam.findByCxIdentity(identity);
      if (!user) return refuse(`The Checkmarx One identity "${seen}" has no access to this utility. Ask an administrator to add it.`);
      if (user.disabled) return refuse(`${user.email} is disabled. Ask an administrator.`);
      Object.assign(session, { userId: user.id, via: 'cxone', cxUser: seen });
      iam.recordSignIn(user);
      setSessionCookie(req, res, session.id);
      res.locals.activityUser = user;
      auditAccess(req, 'info', `${user.email} signed in with a Checkmarx One API key (${seen}).`, user);
      res.status(201).json(describeMe(session, user));
    }),
  );

  /**
   * The Checkmarx One that key sign-ins are checked against: the integration's
   * endpoints, or the deployment's pinned CX_IAM_URL + CX_TENANT. null when neither.
   */
  function trustedCheckmarxOne() {
    try {
      const connection = integrationSession()?.connection;
      if (connection) return { iamUrl: connection.iamUrl, baseUrl: connection.baseUrl, tenant: connection.tenant };
    } catch {}
    if (config.overrides.iamUrl && config.overrides.tenant) {
      return { iamUrl: config.overrides.iamUrl, baseUrl: config.overrides.baseUrl, tenant: config.overrides.tenant };
    }
    return null;
  }

  /** First start: whoever holds the setup code from the server log creates the first administrator. */
  app.post(
    '/api/setup',
    asyncRoute(async (req, res) => {
      if (iam.hasUsers()) return res.status(409).json({ error: 'This utility already has an administrator.' });
      if (throttleSignIn(req, res)) return;
      const given = Buffer.from(String(req.body?.code ?? '').trim().toUpperCase());
      const expected = Buffer.from(setupCode);
      if (!setupCode || given.length !== expected.length || !timingSafeEqual(given, expected)) {
        auditAccess(req, 'refused', 'First-administrator setup refused: wrong setup code.');
        return res.status(403).json({ error: 'Wrong setup code. It is printed in the server log at start-up.' });
      }
      // Claim the code before any await, so two requests cannot both create an administrator.
      const claimed = setupCode;
      setupCode = '';
      let admin;
      try {
        admin = await iam.createUser({
          email: req.body?.email,
          name: req.body?.name,
          role: 'admin',
          password: String(req.body?.password ?? ''),
          cxoneIdentities: req.body?.cxoneIdentities ?? [],
          mustChangePassword: false,
        });
      } catch (error) {
        setupCode = claimed; // e.g. a weak password: let them try again
        throw error;
      }
      const user = iam.user(admin.id);
      iam.recordSignIn(user);
      const session = sessions.createLinked(integrationSession);
      Object.assign(session, { userId: user.id, via: 'password' });
      saveSignInsSoon();
      setSessionCookie(req, res, session.id);
      audit.record({ type: 'iam', outcome: 'changed', reason: `First administrator ${admin.email} created with the setup code.`, actor: { kind: 'user', user: admin.email, ip: clientIp(req) }, details: { user: admin } });
      res.status(201).json(describeMe(session, user));
    }),
  );

  app.delete('/api/session', (req, res) => {
    const id = readSessionCookie(req);
    const session = id ? sessions.get(id) : null;
    if (session?.userId) auditAccess(req, 'info', `${iam.user(session.userId)?.email ?? 'Someone'} signed out.`, iam.user(session.userId));
    if (session?.userId) res.locals.activityUser = iam.user(session.userId);
    // Never the integration: signing out ends only this person's session.
    if (id && id !== tstate.automationSessionId && id !== tstate.bootstrapSessionId) sessions.destroy(id);
    clearSessionCookie(res);
    res.json({ connected: false, signedIn: false });
  });

  return {
    firstAdminFile, prepareAccess, resetTwoStepFromEnvironment, describeMe, signInTickets, ssoAddressProblem,
    passwordResets, passwordResetReady, utc, maySetSignInSecurity, signInSecurityView,
  };
}
