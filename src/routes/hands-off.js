/**
 * Hands-off mode and self-healing (src/hands-off.js, src/watchdog.js): set up once with the wizard, then
 * MissionZero runs, reports, takes requests by email and looks after itself, so nobody has to sign in.
 *
 * registerHandsOff makes all of it: MissionZero's own emails (the weekly status, the one-click links /a/:token,
 * the replies it reads from the mailbox), the self-check that looks, repairs and tells the administrators, and
 * the three background loops. registerHandsOffPageRoutes registers the Hands-off page's own routes
 * (/api/hands-off). They are two steps because src/server.js swaps the handlers for errors nobody caught
 * between them, where it always did.
 */
import path from 'node:path';
import { config } from '../config.js';
import { PACKAGE_VERSION } from '../version.js';
import { sendReminderMail, testConnection } from '../mailer.js';
import { isVerified } from '../settings.js';
import v8 from 'node:v8';
import { Watchdog, outsideFault, rollbackTarget, shouldNotify, shouldRaiseCase } from '../watchdog.js';
import { isPaused, parseCommand, statusDue, systemEmail, COMMANDS } from '../hands-off.js';
import { findReferences, peekTenant, readAction, replyReference, signAction } from '../action-links.js';
import { readReplies } from '../mail-inbox.js';
import { DEFAULT_TENANT } from '../tenancy.js';
import { SYSTEM_ACTOR, escapeHtml, logSafe } from './shared.js';

/**
 * MissionZero's own emails and one-click links, the mailbox it reads, the self-check, and their background loops.
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerHandsOff(app, d) {
  const {
    presenter, MAINTAINER_EMAIL, dataDir, sessions, tenancy, tstate, settingsStore, audit, diagnostics, iam,
    supportDesk, reportGrants, integrationSession, resolveAutomationSession, scheduler, productActive, asyncRoute,
    permissionsFor, tenantsOf, withTimeout, cxonePending, smtpPending, sendingSettings, checkConnections,
    resolveReportServer, tenantName, impactFor, linkPage, backupToFolder, updateStore, updates, bootstrap,
  } = d;

  // ---------------------------------------------------------------------------
  // Hands-off mode and self-healing (src/hands-off.js, src/watchdog.js): set up
  // once with the wizard, then MissionZero runs, reports, takes requests by email
  // and looks after itself, so nobody has to sign in.
  // ---------------------------------------------------------------------------

  const WATCHDOG_MS = Math.max(5, Number(process.env.WATCHDOG_EVERY_SECONDS) || 300) * 1000;
  const INBOX_MS = Math.max(5, Number(process.env.INBOX_EVERY_SECONDS) || 120) * 1000;
  const ERRORS_PER_15_MIN = 30;
  const watchdog = new Watchdog({ file: path.join(dataDir, 'watchdog.json') });

  /** The administrators of a tenant: who hears about problems, and may close the cases MissionZero raises. */
  function administratorsOf(tenant) {
    return iam.users().filter((u) => {
      if (u.disabled) return false;
      const held = permissionsFor(iam.user(u.id));
      return (held.has('system.update') || held.has('integration.cxone') || held.has('integration.smtp')) && tenantsOf(iam.user(u.id), held).includes(tenant);
    }).map((u) => u.email.toLowerCase());
  }

  /** Who may steer hands-off mode from an email: the status list and the administrators. */
  const ownersOf = (tenant, settings = settingsStore.get()) => [...new Set([...(settings.handsOff?.statusTo ?? []), ...administratorsOf(tenant)])];

  const appNameNow = () => settingsStore.get().branding?.appName || 'CxMissionZero';
  const serverUrl = () => resolveReportServer(null, settingsStore.get()).url?.replace(/\/$/, '') || '';
  /** A one-click link (in the current tenant), or '' when the server's address is not known. */
  function actionUrl(a, email, r = '') {
    const base = serverUrl();
    return base ? `${base}/a/${signAction((text) => reportGrants.macText(text), { a, e: email, t: tenancy.current().id, r })}` : '';
  }
  const button = (label, a, email, r = '') => {
    const url = actionUrl(a, email, r);
    return url ? [{ label, url }] : [];
  };

  /** Send one of MissionZero's own emails, in the current tenant; never throws. */
  async function sendSystemMail(to, message, { attachments = [] } = {}) {
    const addresses = [...new Set(to.filter(Boolean))];
    if (!addresses.length) return { sent: 0, error: 'Nobody to send it to.' };
    try {
      await sendReminderMail(sendingSettings(), message, { to: addresses, cc: [], bcc: [], exact: true, ...(attachments.length ? { attachments } : {}) });
      return { sent: addresses.length, error: '' };
    } catch (error) {
      diagnostics.error('system-mail', error);
      return { sent: 0, error: error.message };
    }
  }

  /** One person's copy of a system email: their own links, and their own reply reference. */
  const personal = (email, build) => build(email, replyReference((text) => reportGrants.macText(text), email));

  /** What the weekly status says: the last 7 days, and how MissionZero is doing. */
  function statusFacts() {
    const settings = settingsStore.get();
    const week = impactFor({ days: '7' });
    const since = Date.now() - 7 * 86_400_000;
    const runs = (scheduler.status.runs ?? []).filter((r) => Date.parse(r.at) >= since && !r.skipped);
    const sent = runs.reduce((n, r) => n + (r.sent ?? 0), 0);
    const failedRuns = runs.filter((r) => !r.ok).length;
    const open = watchdog.problems().filter((p) => !p.tenant || p.tenant === tenancy.current().id);
    return [
      ['Reminders sent', `${sent} in ${runs.length} run${runs.length === 1 ? '' : 's'}${failedRuns ? ` (${failedRuns} with errors)` : ''}`],
      ['Fixed this week', `${week.aiFixed + week.manualFixed} (${week.aiFixed} with AI)`],
      ['Shown not exploitable by AI', String(week.noiseRemoved)],
      ['Security debt', `${week.debt.now}${week.debt.change !== null ? ` (${week.debt.change > 0 ? '+' : ''}${week.debt.change}% this week)` : ''}${week.debt.zeroBy ? `, zero by ${week.debt.zeroBy.slice(0, 10)} at this pace` : ''}`],
      ['Next reminder run', settings.automation.enabled ? (isPaused(settings.handsOff) ? `paused until ${settings.handsOff.pausedUntil.slice(0, 16).replace('T', ' ')} UTC` : (scheduler.status.nextRunAt ?? '').slice(0, 16).replace('T', ' ') + ' UTC') : 'automatic reminders are off'],
      ['Health', open.length ? open.map((p) => p.title).join('; ') : 'all checks pass'],
    ];
  }

  /** Email the weekly status to `to` (each gets their own links). Returns how many went out. */
  async function sendStatus(to) {
    const settings = settingsStore.get();
    const facts = statusFacts();
    const paused = isPaused(settings.handsOff);
    let sent = 0;
    for (const email of to) {
      const message = personal(email, (e, reference) => systemEmail({
        appName: appNameNow(),
        subject: `${appNameNow()} this week`,
        lines: [paused ? 'MissionZero is paused: no reminders go out until it is resumed.' : 'MissionZero ran on its own this week. Here is where things stand.'],
        facts,
        buttons: [
          ...button('Send the reminders now', 'run', e),
          ...(paused ? button('Resume', 'resume', e) : button('Pause for 7 days', 'pause', e)),
          ...button('Stop sending me this', 'stop', e),
        ],
        reference,
      }));
      sent += (await sendSystemMail([email], message)).sent;
    }
    return sent;
  }

  /** The weekly status of every tenant whose day and hour have come. */
  async function statusTick(now = new Date()) {
    for (const id of tenancy.ids()) {
      await tenancy.run(id, async () => {
        const handsOff = settingsStore.get().handsOff;
        if (!statusDue(handsOff, now) || !isVerified(sendingSettings())) return;
        settingsStore.save({ handsOff: { lastStatusAt: now.toISOString() } });
        await sendStatus(handsOff.statusTo);
      });
    }
  }

  /**
   * Do what a link or a reply asks, for `email`, in the current tenant. Returns the
   * sentence that says what happened (shown on the page, or emailed back).
   */
  async function performHandsOff({ command, days = 7, ref = '' }, email) {
    const tenant = tenancy.current().id;
    const settings = settingsStore.get();
    const owners = ownersOf(tenant, settings);
    const allowed = command === 'stop' ? settings.handsOff.statusTo.includes(email) || owners.includes(email) : command === 'solved' ? administratorsOf(tenant).includes(email) : owners.includes(email);
    if (!allowed) throw Object.assign(new Error(command === 'solved' ? 'Only an administrator can close this case.' : 'This address may no longer steer MissionZero. Ask an administrator.'), { status: 403 });
    const actor = { kind: 'user', user: email, via: 'email' };
    let said;
    if (command === 'pause') {
      const until = new Date(Date.now() + days * 86_400_000).toISOString();
      settingsStore.save({ handsOff: { pausedUntil: until } });
      said = `Paused: no reminders and no status until ${until.slice(0, 10)}. Resume at any time.`;
    } else if (command === 'resume') {
      settingsStore.save({ handsOff: { pausedUntil: '' } });
      said = 'Resumed: reminders go out on their schedule again.';
    } else if (command === 'run') {
      presenter.exit(() => scheduler.tick({ force: true })).catch((error) => diagnostics.error('hands-off-run', error));
      said = 'The reminders that are due are on their way.';
    } else if (command === 'status') {
      await sendStatus([email]);
      said = 'The status is on its way to you.';
    } else if (command === 'stop') {
      settingsStore.save({ handsOff: { statusTo: settings.handsOff.statusTo.filter((a) => a !== email) } });
      said = 'You will not get the weekly status any more.';
    } else if (command === 'solved') {
      const ticket = supportDesk.get(ref);
      if (!ticket || ticket.tenant !== tenant) throw Object.assign(new Error('No such case.'), { status: 404 });
      if (!['completed', 'declined'].includes(ticket.status)) supportDesk.setStatus(ticket.id, 'completed', { by: { id: '', name: email, email } });
      watchdog.forgetCase(ticket.id);
      said = `${ticket.id} is closed. Thank you.`;
    } else {
      throw Object.assign(new Error('MissionZero does not know that request.'), { status: 400 });
    }
    audit.record({ type: 'settings', outcome: 'changed', reason: `Hands-off: ${email} asked by email to ${command}${command === 'pause' ? ` for ${days} days` : ''}${ref ? ` (${ref})` : ''}. ${said}`, actor });
    return said;
  }

  const ACTION_TITLES = {
    pause: 'Pause MissionZero for 7 days?',
    resume: 'Resume MissionZero?',
    run: 'Send the reminders that are due now?',
    status: 'Email me the status now?',
    stop: 'Stop sending me the weekly status?',
    solved: 'Mark this case as solved?',
  };

  /** The page a link opens: one button, so a mail scanner that opens links never acts. */
  function actionPage(title, message, { confirm = '' } = {}) {
    const page = linkPage(title, message);
    return confirm ? page.replace('</main>', `<form method="post" style="margin-top:18px"><button type="submit" style="font:inherit;padding:10px 18px;border:0;border-radius:6px;background:#14171c;color:#fff;font-weight:600;cursor:pointer">${escapeHtml(confirm)}</button></form></main>`) : page;
  }

  /** A link's token, checked in its own tenant: { tenant, payload } or null. */
  function linkAction(token) {
    const tenant = peekTenant(token) || DEFAULT_TENANT;
    if (!tenancy.has(tenant)) return null;
    const payload = tenancy.run(tenant, () => readAction((text) => reportGrants.macText(text), token));
    return payload ? { tenant, payload } : null;
  }

  app.get('/a/:token', (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const found = linkAction(req.params.token);
    if (!found) return res.status(404).send(actionPage('This link has expired', 'Links in MissionZero emails work for 30 days. The next email has fresh ones.'));
    const { a, e, r } = found.payload;
    res.send(tenancy.run(found.tenant, () => actionPage(ACTION_TITLES[a], `${r ? `${r}. ` : ''}For ${e}.`, { confirm: 'Yes, do it' })));
  });

  app.post('/a/:token', asyncRoute(async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const found = linkAction(req.params.token);
    if (!found) return res.status(404).send(actionPage('This link has expired', 'Links in MissionZero emails work for 30 days. The next email has fresh ones.'));
    const { a, e, r } = found.payload;
    try {
      const said = await tenancy.run(found.tenant, () => performHandsOff({ command: a, ref: r }, e));
      res.send(tenancy.run(found.tenant, () => actionPage('Done', said)));
    } catch (error) {
      // A refusal raised on purpose carries its status and its words for the reader; anything else stays in the log.
      if (!error.status) {
        console.error(`POST /a/:token -> ${logSafe(error.stack ?? error.message)}`);
        diagnostics.error('hands-off-link', error);
      }
      res.status(error.status ?? 500).send(actionPage('Not done', error.status ? error.message : 'Something went wrong on the server. The details are in its log.'));
    }
  }));

  /** Tenants whose mailbox could not be read, and how many times in a row (the self-check reports 3). */
  const inboxFailures = new Map();

  /** Replies to MissionZero's emails: one word each, from the address the email went to. */
  async function inboxTick() {
    for (const id of tenancy.ids()) {
      await tenancy.run(id, async () => {
        const settings = sendingSettings();
        const { handsOff, smtp } = settings;
        if (!handsOff.on || !handsOff.replies || !isVerified(settings) || !smtp.user) return;
        let messages;
        try {
          // Turning the certificate check off for the mail server covers that server only, not a separate IMAP host.
          const sameHost = !handsOff.imapHost || handsOff.imapHost === smtp.host;
          messages = await readReplies({ host: handsOff.imapHost || smtp.host, port: handsOff.imapPort, secure: handsOff.imapPort === 993, user: smtp.user, password: smtp.password, rejectUnauthorized: sameHost ? smtp.rejectUnauthorized : true });
          inboxFailures.delete(id);
        } catch (error) {
          diagnostics.error('inbox', error);
          const failed = inboxFailures.get(id) ?? { count: 0 };
          inboxFailures.set(id, { count: failed.count + 1, error: error.message });
          return;
        }
        for (const message of messages) await handleReply(message).catch((error) => diagnostics.error('inbox-reply', error));
      });
    }
  }

  /** One reply, in its tenant: act on it only when it answers an email sent to that very address. */
  async function handleReply({ from, subject, text }) {
    const settings = settingsStore.get();
    const own = String(settings.smtp.fromAddress ?? '').toLowerCase();
    // Never answer ourselves, an auto-reply or a bounce: that is how mail loops start.
    if (!from || from === own || /auto(matic)?[ -]?(reply|response)|out of (the )?office|undeliverable|delivery status|mailer-daemon/i.test(`${subject} ${from}`)) return;
    const expected = replyReference((t) => reportGrants.macText(t), from);
    if (!findReferences(`${subject}\n${text}`).includes(expected)) return;
    const asked = parseCommand(text);
    if (!asked) return;
    const ref = /\b(SUP-\d{4,})\b/.exec(subject)?.[1] ?? '';
    let said;
    try {
      said = await performHandsOff({ ...asked, ref }, from);
    } catch (error) {
      // As for the link above: only a refusal's own words go back by email.
      if (!error.status) diagnostics.error('hands-off-reply', error);
      said = `Not done: ${error.status ? error.message : 'something went wrong on the server.'}`;
    }
    const reply = systemEmail({ appName: appNameNow(), subject: `Re: ${String(subject).replace(/^(re:\s*)+/i, '').slice(0, 150)}`, lines: [said], reference: '', replyHelp: false });
    await sendSystemMail([from], reply);
  }

  // ---- Self-check: look, repair, tell -------------------------------------------------------

  /** What is wrong in the current tenant now: [{ key, title, detail, tenant }]. */
  async function tenantProblems() {
    const id = tenancy.current().id;
    const settings = settingsStore.get();
    const found = [];
    if (settings.automationApiKey || (id === DEFAULT_TENANT && config.bootstrapApiKey)) {
      const session = integrationSession() ?? (await resolveAutomationSession().catch(() => null));
      if (!session) {
        const failure = tstate.integrationFailure?.error;
        const outside = outsideFault(failure);
        found.push({ key: `cxone:${id}`, title: 'Checkmarx One connection', detail: outside ? `The server cannot sign in to Checkmarx One: Checkmarx One is not answering (${failure.httpStatus || failure.status || failure.code || 'timed out'}). This is on Checkmarx One's side; MissionZero keeps trying.` : 'The server cannot sign in to Checkmarx One with its key.', tenant: id, outside });
      } else {
        // One small question to Checkmarx One: a session that exists is not one that works.
        try {
          await withTimeout(session.client.request('/api/projects', { query: { limit: 1 }, retries: 1, background: true }), 'Checkmarx One');
        } catch (error) {
          const outside = outsideFault(error);
          found.push({ key: `cxone:${id}`, title: 'Checkmarx One connection', detail: outside ? `${error.message}. This is on Checkmarx One's side; MissionZero keeps trying.` : error.message, tenant: id, outside });
        }
      }
    }
    if (settings.smtp.host && isVerified(sendingSettings())) {
      try {
        await withTimeout(testConnection(sendingSettings().smtp), 'The mail server');
      } catch (error) {
        found.push({ key: `smtp:${id}`, title: 'Email server', detail: error.message, tenant: id, outside: outsideFault(error) });
      }
    }
    const inbox = inboxFailures.get(id);
    if (settings.handsOff.on && settings.handsOff.replies && inbox?.count >= 3) found.push({ key: `inbox:${id}`, title: 'Reading replies', detail: inbox.error, tenant: id });
    if (settings.automation.enabled) {
      const runs = (scheduler.status.runs ?? []).filter((r) => !r.skipped).slice(0, 2);
      if (runs.length === 2 && runs.every((r) => !r.ok)) found.push({ key: `automation:${id}`, title: 'Automatic reminders', detail: runs[0].error || runs[0].failures?.[0]?.error || 'The last two runs failed.', tenant: id });
    }
    return found;
  }

  /** What is wrong with the server itself. */
  function serverProblems() {
    const found = [];
    const errors = diagnostics.recentErrors(15 * 60_000);
    if (errors > ERRORS_PER_15_MIN) found.push({ key: 'errors', title: 'Errors on the server', detail: `${errors} errors in the last 15 minutes.`, tenant: '' });
    // Close to its memory limit, a server is about to die: worth a backup while it still can.
    const heap = v8.getHeapStatistics();
    if (heap.used_heap_size > 0.9 * heap.heap_size_limit) found.push({ key: 'memory', title: 'Memory', detail: `${Math.round(heap.used_heap_size / 1048576)} of ${Math.round(heap.heap_size_limit / 1048576)} MB in use.`, tenant: '' });
    return found;
  }

  /** Try to put one problem right (each repair once while it lasts). True when it is fixed. */
  async function repair(problem) {
    if (problem.key === 'memory' && !watchdog.hasTried('memory', 'Backed up the data in case it stops')) {
      const backup = await backupToFolder(SYSTEM_ACTOR, 'Low memory').catch(() => null);
      watchdog.tried('memory', 'Backed up the data in case it stops', backup?.ok ? 'done' : 'failed');
      return false;
    }
    const [kind, ...rest] = problem.key.split(':');
    const tenant = rest.join(':');
    if (!tenant || !tenancy.has(tenant)) return false;
    return tenancy.run(tenant, async () => {
      const recheck = async () => !(await tenantProblems()).some((p) => p.key === problem.key);
      const attempt = async (name, fn) => {
        if (watchdog.hasTried(problem.key, name)) return false;
        try {
          await fn();
        } catch {}
        const fixed = await recheck();
        watchdog.tried(problem.key, name, fixed ? 'fixed' : 'did not help');
        return fixed;
      };
      if (kind === 'cxone' || kind === 'smtp') {
        // A changed connection that does not work: back to the last one that did.
        if ((kind === 'cxone' ? cxonePending() : smtpPending()) && (await attempt('Put back the last working connection', () => checkConnections({ rollback: true, trigger: 'self-check' })))) return true;
      }
      if (kind === 'cxone' || kind === 'automation') {
        return attempt('Signed in to Checkmarx One again', async () => {
          if (tstate.automationSessionId && tstate.automationSessionId !== tstate.bootstrapSessionId) sessions.destroy(tstate.automationSessionId);
          tstate.automationSessionId = null;
          tstate.integrationFailure = { fingerprint: null, until: 0 };
          if (!(await resolveAutomationSession()) && tenant === DEFAULT_TENANT && config.bootstrapApiKey) await bootstrap();
        });
      }
      if (kind === 'smtp') return attempt('Tried the mail server again after a pause', () => new Promise((r) => setTimeout(r, 10_000)));
      return false;
    });
  }

  /** Email the administrators of a problem's tenant (the first tenant's for the server's own). */
  async function tellAdministrators(problem, build, options) {
    const tenant = problem.tenant && tenancy.has(problem.tenant) ? problem.tenant : DEFAULT_TENANT;
    return tenancy.run(tenant, async () => {
      let sent = 0;
      for (const email of administratorsOf(tenant)) sent += (await sendSystemMail([email], personal(email, build), options)).sent;
      return sent;
    });
  }

  const problemFacts = (p) => [
    ['Problem', `${p.title}: ${p.detail}`],
    ['Since', `${p.since.slice(0, 16).replace('T', ' ')} UTC`],
    ['Tried', p.tried?.length ? p.tried.join('; ') : 'nothing could be tried yet'],
    ...(p.tenant && tenancy.enabled ? [['Tenant', tenantName(p.tenant)]] : []),
    ['Version', `MZ-${PACKAGE_VERSION}`],
  ];

  /** Raise a support case for a problem MissionZero could not fix, and ask an administrator to forward it. */
  async function raiseCase(problem) {
    const tenant = problem.tenant && tenancy.has(problem.tenant) ? problem.tenant : DEFAULT_TENANT;
    const report = diagnostics.report({ extra: { selfCheck: { problem: { title: problem.title, detail: problem.detail, since: problem.since, tried: problem.tried }, events: watchdog.events(30) } } });
    const ticket = supportDesk.create({
      kind: 'case',
      tenant,
      subject: `[Automatic] ${problem.title}`,
      text: [`MissionZero raised this case by itself: it could not fix the problem on its own.`, '', ...problemFacts(problem).map(([k, v]) => `${k}: ${v}`), '', `Forward the email about it to ${MAINTAINER_EMAIL}.`].join('\n'),
      priority: 'high',
      requester: { id: 'system', name: 'MissionZero (automatic)', email: '' },
    });
    watchdog.markCase(problem.key, ticket.id);
    watchdog.event('case', `${ticket.id} raised for ${problem.title}.`, { key: problem.key, tenant });
    audit.record({ type: 'system', outcome: 'changed', reason: `Self-check raised ${ticket.id}: ${problem.title} (${problem.detail}).`, actor: SYSTEM_ACTOR });
    const base = serverUrl();
    await tellAdministrators(problem, (email, reference) => systemEmail({
      appName: appNameNow(),
      subject: `[${ticket.id}] MissionZero needs the maintainer: ${problem.title}`,
      lines: [
        `MissionZero could not fix this on its own, so it raised support case ${ticket.id}.`,
        `Please forward this email, with its attachment, to ${MAINTAINER_EMAIL}. MissionZero never sends anything outside your network by itself.`,
        'The attachment is the troubleshooting log: no personal data, keys or findings.',
      ],
      facts: problemFacts(problem),
      buttons: [...button('Mark as solved', 'solved', email, ticket.id), ...(base ? [{ label: `Open ${ticket.id}`, url: `${base}/#/help/${ticket.id}` }] : [])],
      reference,
      replyHelp: false,
      footer: `When it is solved, reply SOLVED to this email, or use the button. ${ticket.id} then closes.`,
    }), { attachments: [{ filename: `mission-zero-${ticket.id}-troubleshooting.json`, content: JSON.stringify(report, null, 2), contentType: 'application/json' }] });
    return ticket;
  }

  let selfChecking = false;
  /** One self-check: look at everything, repair what can be repaired, tell who needs to know. */
  async function selfCheck() {
    if (selfChecking) return { skipped: true };
    selfChecking = true;
    try {
      const found = [];
      for (const id of tenancy.ids()) found.push(...(await tenancy.run(id, () => tenantProblems().catch((error) => [{ key: `check:${id}`, title: 'Self-check', detail: error.message, tenant: id }]))));
      found.push(...serverProblems());
      const { recovered } = watchdog.record(found, { version: PACKAGE_VERSION });

      for (const p of watchdog.problems()) {
        if (await repair(p).catch(() => false)) {
          watchdog.resolve(p.key);
          audit.record({ type: 'system', outcome: 'changed', reason: `Self-check fixed it: ${p.title} (${p.detail}).`, actor: SYSTEM_ACTOR });
          if (p.notifiedAt) await tellAdministrators(p, (email, reference) => systemEmail({ appName: appNameNow(), subject: `MissionZero fixed itself: ${p.title}`, lines: ['MissionZero found a problem and put it right on its own. Nothing is needed from you.'], facts: problemFacts(p), reference, replyHelp: false }));
        }
      }

      const update = updates.settings();
      const lastCheck = updates.lastCheck;
      const online = Boolean(lastCheck && !lastCheck.error && Date.now() - Date.parse(lastCheck.at) < 2 * 86_400_000);
      for (const p of watchdog.problems()) {
        if (shouldNotify(p)) {
          watchdog.markNotified(p.key);
          await tellAdministrators(p, (email, reference) => systemEmail({
            appName: appNameNow(),
            subject: `MissionZero needs attention: ${p.title}`,
            lines: ['MissionZero found a problem it could not fix on its own yet. It keeps checking every few minutes and will tell you when it works again.', ...(update.auto && online ? ['If it lasts, MissionZero raises a support case by itself and asks you to forward it.'] : [])],
            facts: problemFacts(p),
            reference,
            replyHelp: false,
          }));
        }
        if (shouldRaiseCase(p, { autoUpdate: update.auto, online })) await raiseCase(p);
      }

      for (const p of recovered) {
        if (p.caseId) supportDesk.reply(p.caseId, { by: { id: 'system', name: 'MissionZero (automatic)', email: '' }, team: true, text: `Working again since ${p.recoveredAt.slice(0, 16).replace('T', ' ')} UTC. Close the case once you are happy.` });
        if (p.notifiedAt) await tellAdministrators(p, (email, reference) => systemEmail({ appName: appNameNow(), subject: `MissionZero is working again: ${p.title}`, lines: ['The problem MissionZero told you about has cleared.'], facts: problemFacts(p), buttons: p.caseId ? button('Mark as solved', 'solved', email, p.caseId) : [], reference, replyHelp: false }));
      }

      // A version that came in less than a day ago and broke what worked: back to the one before it.
      const events = updateStore.events(50);
      // The launcher's record of this version coming in: a switch to it, and its first start.
      const switched = events.find((e) => e.type !== 'rollback' && e.type !== 'restart' && e.from && e.from !== PACKAGE_VERSION && (e.to === PACKAGE_VERSION || (e.type === 'started' && e.version === PACKAGE_VERSION)));
      const target = rollbackTarget({
        problems: watchdog.problems(),
        running: PACKAGE_VERSION,
        previous: switched?.from ?? '',
        switchedAt: switched?.at ?? '',
        wasHealthy: (v) => watchdog.wasHealthy(v),
        hasRolledBack: (v) => watchdog.hasRolledBack(v),
      });
      if (target && updates.supervised) {
        watchdog.markRolledBack(PACKAGE_VERSION);
        watchdog.event('rollback', `MZ-${PACKAGE_VERSION} put back to MZ-${target}: it broke what worked before.`);
        audit.record({ type: 'system', outcome: 'changed', reason: `Self-check: MZ-${PACKAGE_VERSION} broke what worked before; going back to MZ-${target}.`, actor: SYSTEM_ACTOR });
        await tellAdministrators({ tenant: DEFAULT_TENANT }, (email, reference) => systemEmail({ appName: appNameNow(), subject: `MissionZero went back to MZ-${target}`, lines: [`MZ-${PACKAGE_VERSION} came in less than a day ago and broke what worked before, so MissionZero is going back to MZ-${target}. It will not install MZ-${PACKAGE_VERSION} again by itself.`], facts: watchdog.problems().map((p) => ['Problem', `${p.title}: ${p.detail}`]), reference, replyHelp: false }));
        await updates.switch(target, { by: 'self-check' }).catch((error) => watchdog.event('tried', `Going back to MZ-${target} failed: ${error.message}`));
      }
      return { problems: watchdog.problems() };
    } finally {
      selfChecking = false;
    }
  }

  /** The self-check as the Hands-off page shows it. */
  const healthView = () => ({ lastCheckAt: watchdog.state.lastCheckAt, everyMinutes: Math.round(WATCHDOG_MS / 60_000), problems: watchdog.problems(), events: watchdog.events(20), maintainer: MAINTAINER_EMAIL });

  {
    const loop = (fn, every, first) => {
      const run = () => (productActive() ? fn() : Promise.resolve()).catch((error) => diagnostics.error('background', error));
      setTimeout(() => {
        run();
        setInterval(run, every).unref();
      }, first).unref();
    };
    loop(selfCheck, WATCHDOG_MS, Math.min(60_000, WATCHDOG_MS));
    loop(statusTick, 5 * 60_000, 30_000);
    loop(inboxTick, INBOX_MS, Math.min(30_000, INBOX_MS));
  }

  return { administratorsOf, appNameNow, serverUrl, sendSystemMail, sendStatus, selfCheck, healthView };
}

/**
 * /api/hands-off: the wizard's answers, the status email now, a self-check now.
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerHandsOffPageRoutes(app, d) {
  const {
    settingsStore, audit, integrationSession, resolveAutomationSession, scheduler, asyncRoute, can,
    requirePermission, sendingSettings, adminActor, audienceSetting, serverUrl, sendStatus, selfCheck, healthView,
  } = d;

  app.get('/api/hands-off', requirePermission('settings.view', 'settings.automation'), (req, res) => {
    const settings = settingsStore.get();
    res.json({
      handsOff: settings.handsOff,
      automation: settings.automation,
      audience: audienceSetting(settings),
      monthlyTo: can(req, 'settings.ai') ? settings.impact.monthlyTo : undefined,
      canSave: can(req, 'settings.automation'),
      ready: { cxone: Boolean(integrationSession()), smtp: isVerified(sendingSettings()), serverUrl: Boolean(serverUrl()) },
      paused: isPaused(settings.handsOff),
      commands: COMMANDS,
      health: healthView(),
    });
  });

  /** The wizard's answers, saved in one go: what to do, which findings, who, when, and replies. */
  app.put('/api/hands-off', requirePermission('settings.automation'), asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const before = settingsStore.get();
    const incoming = { handsOff: { ...(body.handsOff ?? {}), on: body.handsOff?.on !== false } };
    if (body.automation) incoming.automation = body.automation;
    if (['initiator', 'list', 'both'].includes(body.audience)) incoming.reminders = { audience: body.audience };
    if ('monthlyTo' in body && can(req, 'settings.ai')) incoming.impact = { monthlyTo: body.monthlyTo };
    settingsStore.save(incoming);
    await resolveAutomationSession();
    scheduler.sync();
    const after = settingsStore.get();
    audit.record({ type: 'settings', outcome: 'changed', reason: `Hands-off mode ${after.handsOff.on ? (before.handsOff.on ? 'changed' : 'turned on') : 'turned off'}: reminders ${after.automation.enabled ? 'on' : 'off'}, status to ${after.handsOff.statusTo.length} people, replies ${after.handsOff.replies ? 'read' : 'not read'}.`, actor: await adminActor(req), details: { handsOff: after.handsOff, automation: after.automation } });
    res.json({ handsOff: after.handsOff, automation: after.automation, audience: audienceSetting(after), health: healthView() });
  }));

  app.post('/api/hands-off/status', requirePermission('settings.automation'), asyncRoute(async (req, res) => {
    const to = settingsStore.get().handsOff.statusTo;
    if (!to.length) return res.status(400).json({ error: 'Add who gets the weekly status first.' });
    if (!isVerified(sendingSettings())) return res.status(409).json({ error: 'Set up and test the email server first (Settings → Email server).' });
    res.json({ sent: await sendStatus(to) });
  }));

  app.post('/api/hands-off/check', requirePermission('settings.automation', 'system.update'), asyncRoute(async (req, res) => {
    await selfCheck();
    res.json({ health: healthView() });
  }));
}
