/**
 * Act → Automation (src/automation.js): reminders that run by themselves on a schedule.
 *
 * The routes under /api/automation: the settings, arming and disarming the stored Checkmarx One key the runs use,
 * a run now, the preview of what a run would send (and that preview by email), the reminder email's own text
 * with its preview and test, and which projects a focus matches. The scheduler itself is made for each tenant in
 * src/server.js; automationReport builds each person's attached report for it.
 */
import { config } from '../config.js';
import { listApplications, listProjects } from '../cxone/projects.js';
import { buildTemplateData } from '../reminder.js';
import { buildBrandedReminder, effectiveBranding, personName, REMINDER_PLACEHOLDERS } from '../reminder-email.js';
import { focusProjects, nextRunAfter } from '../automation-config.js';
import { sendReminderMail } from '../mailer.js';
import { isVerified, mergeSettings } from '../settings.js';
import { escapeHtmlText } from './shared.js';

/**
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerAutomationRoutes(app, d) {
  const {
    presenter, sessions, tstate, settingsStore, audit, automationState, activateIntegration,
    resolveAutomationSession, scheduler, asyncRoute, requirePermission, adminActor, resolveReportServer,
    integrationStatus, sendingSettings, connectionStatus, sendSystemMail, buildInteractiveReport,
  } = d;

  // ---------------------------------------------------------------------------
  // Automation
  // ---------------------------------------------------------------------------

  app.get('/api/automation', requirePermission('settings.view', 'settings.automation'), (req, res) => {
    const settings = settingsStore.get();
    const brand = effectiveBranding({ ...settings.reminderEmail, senderName: '', replyTo: '', logo: 'portal', color: '', footer: '' }, settings);
    res.json({
      ...scheduler.status,
      config: settings.automation,
      // Act → Automation → Email: the email's own fields, and what "Same as the portal" stands for.
      reminderEmail: settings.reminderEmail,
      portal: { senderName: brand.senderName, fromAddress: settings.smtp.fromAddress || '', logoUrl: brand.logoUrl, colours: brand.colours, footer: brand.footer },
      placeholders: REMINDER_PLACEHOLDERS,
      serverTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      // When the next run would go out on these settings, on or off (the Schedule tab says so).
      wouldRunAt: nextRunAfter(settings.automation, new Date())?.toISOString() ?? null,
      lastPreview: tstate.automationPreview ? previewSummary(tstate.automationPreview) : null,
      keyStored: Boolean(settings.automationApiKey),
      bootstrapKey: Boolean(config.bootstrapApiKey),
      canRun: Boolean(sessions.get(tstate.automationSessionId) ?? sessions.get(tstate.bootstrapSessionId)),
      smtpVerified: isVerified(settings),
      smtpConfigured: Boolean(settings.smtp.host),
      // The panel says what runs will use: the integration, as the Checkmarx One section shows it.
      integration: integrationStatus(),
      connections: connectionStatus(settings),
    });
  });

  app.put(
    '/api/automation',
    requirePermission('settings.automation'),
    asyncRoute(async (req, res) => {
      settingsStore.save({ automation: req.body ?? {} });
      await resolveAutomationSession();
      scheduler.sync();
      const saved = settingsStore.get().automation;
      res.json({ ...scheduler.status, config: saved, wouldRunAt: nextRunAfter(saved, new Date())?.toISOString() ?? null });
    }),
  );

  /** Store the current session's key so unattended runs can authenticate. */
  app.post(
    '/api/automation/arm',
    requirePermission('integration.cxone'),
    asyncRoute(async (req, res) => {
      if (req.session.via !== 'cxone') {
        return res.status(400).json({ error: 'Signed in with a password: connect the server under Settings → Connection with an API key instead.' });
      }
      // A session of its own for the integration: never this person's (which carries their access).
      const { apiKey, iamUrl, baseUrl, tenant } = req.session.connection;
      const integration = await sessions.create(apiKey, { iamUrl, baseUrl, tenant });
      settingsStore.save({ automationApiKey: apiKey, integrationOverrides: { iamUrl, baseUrl, tenant } });
      activateIntegration(integration, apiKey, { iamUrl, baseUrl, tenant });
      audit.record({ type: 'settings', outcome: 'changed', reason: `Checkmarx One integration armed with ${req.user.email}'s key (tenant ${tenant}).`, actor: await adminActor(req) });
      scheduler.sync();
      res.json({ ...scheduler.status, keyStored: true, canRun: true });
    }),
  );

  app.delete('/api/automation/arm', requirePermission('integration.cxone'), (req, res) => {
    settingsStore.save({ automationApiKey: '' });
    if (tstate.automationSessionId && tstate.automationSessionId !== tstate.bootstrapSessionId) sessions.destroy(tstate.automationSessionId);
    tstate.automationSessionId = null;
    tstate.integrationFingerprint = null;
    res.json({ ...scheduler.status, keyStored: false, canRun: Boolean(sessions.get(tstate.bootstrapSessionId)) });
  });

  /** Run a pass now, without waiting for the timer. */
  app.post(
    '/api/automation/run',
    requirePermission('settings.automation'),
    asyncRoute(async (req, res) => {
      // Runs on the server's integration, like the scheduled runs it rehearses.
      if (!(await resolveAutomationSession())) {
        return res.status(409).json({ error: 'Connect the server to Checkmarx One first (Settings → Checkmarx One).' });
      }
      // Automation is the organisation's: its emails never carry the branding of whoever pressed Run now.
      const run = await presenter.exit(() => scheduler.tick({ force: true }));
      res.json({ run, status: scheduler.status });
    }),
  );

  /** Forget every reported pair, so the next run reports from scratch. */
  app.post('/api/automation/reset', requirePermission('settings.automation'), (req, res) => {
    automationState.reset();
    res.json(scheduler.status);
  });

  /** Each person's interactive report, attached to their reminder (Act → Automation → Email). */
  async function automationReport(session, risks, { initiator = null, to = [] } = {}) {
    const settings = sendingSettings();
    const filename = `vulnerability-report-${new Date().toISOString().slice(0, 10)}.html`;
    const { html } = await buildInteractiveReport(session, risks, {
      settings,
      relayUrl: resolveReportServer(null, settingsStore.get()).url,
      initiatorsByProject: {},
      initiator,
      audience: { recipient: [].concat(to).join(', '), purpose: 'attached to a scheduled reminder' },
      publish: filename,
    });
    return { filename, content: html, contentType: 'text/html' };
  }

  const SEVERITY_SHORT = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low', INFO: 'Info' };

  /** What Preview shows of a pass: the tiles, one row per email, and those with no address yet. */
  function previewSummary(preview) {
    const { decided, at } = preview;
    const count = (risks, severity) => risks.filter((r) => r.severity === severity).length;
    const limitsText = (risks) => {
      const highest = new Map();
      for (const r of risks) highest.set(r.severity, Math.max(highest.get(r.severity) ?? 0, r.threshold ?? 0));
      return ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].filter((s) => highest.has(s)).map((s) => `${SEVERITY_SHORT[s]} ${highest.get(s)} d`).join(' · ');
    };
    const projectsOf = (risks) => [...new Set(risks.map((r) => r.projectName))].sort();
    const rows = decided.messages.map((m, index) => ({
      index,
      to: m.to.join(', '),
      label: m.label,
      projects: projectsOf(m.risks),
      critical: count(m.risks, 'CRITICAL'),
      high: count(m.risks, 'HIGH'),
      medium: count(m.risks, 'MEDIUM'),
      limits: limitsText(m.risks),
    }));
    const missing = decided.failures.filter((f) => f.noAddress);
    const missingRisks = missing.flatMap((f) => f.risks ?? []);
    const crossed = decided.crossed;
    const bySeverity = Object.fromEntries(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((s) => [s, count(crossed, s)]));
    return {
      at,
      people: rows.length + missing.length,
      projects: new Set(crossed.map((r) => r.projectId)).size,
      findings: crossed.length,
      critical: bySeverity.CRITICAL,
      bySeverity,
      total: decided.total,
      inFocus: decided.inFocus,
      open: decided.open.length,
      rows,
      noAddress: missing.length
        ? { people: missing.map((f) => f.to), projects: projectsOf(missingRisks), critical: count(missingRisks, 'CRITICAL'), high: count(missingRisks, 'HIGH'), medium: count(missingRisks, 'MEDIUM'), limits: limitsText(missingRisks) }
        : null,
      problems: decided.failures.filter((f) => !f.noAddress).map((f) => ({ to: f.to, error: f.error })),
    };
  }

  /** Who a pass would email now, and what, on the saved settings: nothing is sent or remembered. */
  app.post(
    '/api/automation/preview',
    requirePermission('settings.automation'),
    asyncRoute(async (req, res) => {
      if (!(await resolveAutomationSession())) {
        return res.status(409).json({ error: 'Connect the server to Checkmarx One first (Settings → Checkmarx One).' });
      }
      const decided = await presenter.exit(() => scheduler.preview());
      if (!decided) return res.status(409).json({ error: 'Connect the server to Checkmarx One first (Settings → Checkmarx One).' });
      tstate.automationPreview = { at: new Date().toISOString(), decided };
      res.json(previewSummary(tstate.automationPreview));
    }),
  );

  /** One email of the last preview, as its person would get it. */
  app.get('/api/automation/preview/:index', requirePermission('settings.automation'), (req, res) => {
    const message = tstate.automationPreview?.decided.messages[Number.parseInt(req.params.index, 10)];
    if (!message) return res.status(404).json({ error: 'Preview again: that email is no longer in the preview.' });
    res.json({ to: message.to.join(', '), subject: message.reminder.subject, html: message.reminder.html });
  });

  /** The last preview, emailed to whoever asks: the list of who would get what, not anyone's email. */
  app.post(
    '/api/automation/preview/email-me',
    requirePermission('settings.automation'),
    asyncRoute(async (req, res) => {
      const preview = tstate.automationPreview;
      if (!preview) return res.status(409).json({ error: 'Preview first, then email it to yourself.' });
      const s = previewSummary(preview);
      const cell = 'padding:6px 8px;border-bottom:1px solid #e6e2d8';
      const rows = s.rows.map((r) => `<tr><td style="${cell}">${escapeHtmlText(r.to)}</td><td style="${cell}">${escapeHtmlText(r.projects.join(', '))}</td><td style="${cell}" align="right">${r.critical}</td><td style="${cell}" align="right">${r.high}</td><td style="${cell}" align="right">${r.medium}</td><td style="${cell}">${escapeHtmlText(r.limits)}</td></tr>`);
      if (s.noAddress) rows.push(`<tr><td style="${cell}">No address yet (${s.noAddress.people.length})</td><td style="${cell}">${escapeHtmlText(s.noAddress.projects.join(', '))}</td><td style="${cell}" align="right">${s.noAddress.critical}</td><td style="${cell}" align="right">${s.noAddress.high}</td><td style="${cell}" align="right">${s.noAddress.medium}</td><td style="${cell}">${escapeHtmlText(s.noAddress.limits)}</td></tr>`);
      const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;color:#1f2330"><p>Who the next reminder run would email, previewed ${escapeHtmlText(s.at.slice(0, 16).replace('T', ' '))} UTC: ${s.people} people, ${s.projects} projects, ${s.findings} findings past a limit (${s.critical} critical). Nothing was sent to them.</p><table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px"><tr><th align="left" style="${cell}">Person</th><th align="left" style="${cell}">Projects</th><th style="${cell}">Critical</th><th style="${cell}">High</th><th style="${cell}">Medium</th><th align="left" style="${cell}">Limits crossed</th></tr>${rows.join('')}</table></div>`;
      const text = [`Who the next reminder run would email: ${s.people} people, ${s.projects} projects, ${s.findings} findings past a limit (${s.critical} critical). Nothing was sent to them.`, '', ...s.rows.map((r) => `${r.to}: ${r.projects.join(', ')} — ${r.critical} critical, ${r.high} high, ${r.medium} medium (${r.limits})`)].join('\n');
      const result = await sendSystemMail([req.user.email], { subject: `Reminder preview: ${s.people} people, ${s.findings} findings past a limit`, html, text });
      if (!result.sent) return res.status(502).json({ error: result.error || 'The preview could not be emailed.' });
      res.json({ sent: true, to: req.user.email });
    }),
  );

  /** A sample of the reminder email on the fields as typed (not saved yet), for the Email tab's preview. */
  function sampleReminder(fields, req) {
    const settings = settingsStore.get();
    const email = mergeSettings(settings, { reminderEmail: fields ?? {} }).reminderEmail;
    // The first person of the last preview, else a made-up one: the email as they would get it.
    const real = tstate.automationPreview?.decided.messages.find((m) => m.group);
    const risks = real?.risks ?? [
      { projectId: 'p1', projectName: 'payments-api', severity: 'CRITICAL', ageDays: 41, threshold: 30 },
      { projectId: 'p1', projectName: 'payments-api', severity: 'CRITICAL', ageDays: 33, threshold: 30 },
      { projectId: 'p1', projectName: 'payments-api', severity: 'HIGH', ageDays: 38, threshold: 30 },
      { projectId: 'p2', projectName: 'payments-web', severity: 'CRITICAL', ageDays: 33, threshold: 30 },
      { projectId: 'p2', projectName: 'payments-web', severity: 'HIGH', ageDays: 31, threshold: 30 },
    ];
    const person = real?.group ?? { initiator: 'ana.lopez', email: 'ana.lopez@example.com' };
    const data = buildTemplateData(risks, { tenant: '', links: null, branding: settings.branding, initiator: person });
    const per = new Map();
    for (const r of risks) {
      const p = per.get(r.projectId) ?? { critical: 0, high: 0, oldestDays: 0 };
      if (r.severity === 'CRITICAL') p.critical += 1;
      if (r.severity === 'HIGH') p.high += 1;
      p.oldestDays = Math.max(p.oldestDays, r.ageDays ?? 0);
      per.set(r.projectId, p);
    }
    data.projects = data.projects.map((p) => ({ ...p, ...per.get(p.projectId), url: real ? p.url : '' }));
    data.crossedLimits = risks.map((r) => ({ days: r.threshold }));
    const built = buildBrandedReminder(data, email, settings, { initiator: person.initiator, to: person.email, buttonUrl: 'https://checkmarx.example/projects', why: 'You get this because you last scanned these projects.' });
    return { ...built, as: personName(person.initiator, person.email) || person.email, sample: !real, email };
  }

  // The preview may show a real person's projects (from the last Preview), so it is for those who manage automation.
  app.post('/api/automation/email/preview', requirePermission('settings.automation'), (req, res) => {
    const { subject, html, as, sample } = sampleReminder(req.body ?? {}, req);
    res.json({ subject, html, as, sample });
  });

  /** The sample, sent to whoever asks (and only them), with the sender name and reply-to it would carry. */
  app.post(
    '/api/automation/email/test',
    requirePermission('settings.automation'),
    asyncRoute(async (req, res) => {
      const settings = sendingSettings();
      if (!isVerified(settings)) return res.status(409).json({ error: 'Test the Email server first (Settings → Email server).' });
      const built = sampleReminder(req.body ?? {}, req);
      await sendReminderMail(settings, { subject: `[Test] ${built.subject}`, html: built.html, text: built.text }, { exact: true, to: [req.user.email], cc: [], bcc: [], ...(built.from.name ? { fromName: built.from.name } : {}), ...(built.from.replyTo ? { replyTo: built.from.replyTo } : {}) });
      res.json({ sent: true, to: req.user.email });
    }),
  );

  /** Save the reminder email (Act → Automation → Email); `restore: true` puts back the default. */
  app.put(
    '/api/automation/email',
    requirePermission('settings.automation'),
    asyncRoute(async (req, res) => {
      const saved = settingsStore.save({ reminderEmail: req.body ?? {} });
      res.json({ reminderEmail: saved.reminderEmail });
    }),
  );

  /** How many projects a focus covers (Act → Automation → Focus), on the server's connection; listed for five minutes. */
  app.post(
    '/api/automation/focus/match',
    requirePermission('settings.automation'),
    asyncRoute(async (req, res) => {
      const session = await resolveAutomationSession();
      if (!session) return res.status(409).json({ error: 'Connect the server to Checkmarx One first (Settings → Checkmarx One).' });
      const cached = tstate.focusLists;
      const lists = cached && Date.now() - cached.at < 5 * 60_000
        ? cached
        : { at: Date.now(), projects: await listProjects(session.client), applications: await listApplications(session.client).catch(() => []) };
      tstate.focusLists = lists;
      const focus = mergeSettings(settingsStore.get(), { automation: { focus: req.body ?? {} } }).automation.focus;
      const matched = focusProjects(lists.projects, focus, lists.applications);
      const known = new Set(lists.applications.map((a) => a.name.toLowerCase()));
      res.json({
        total: lists.projects.length,
        matched: matched.length,
        names: matched.slice(0, 12).map((p) => p.name),
        unknownApplications: focus.applications.filter((name) => !known.has(name.toLowerCase())),
        applications: lists.applications.map((a) => a.name).sort((a, b) => a.localeCompare(b)).slice(0, 500),
      });
    }),
  );

  return { automationReport };
}
