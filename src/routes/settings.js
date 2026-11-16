/**
 * The Settings page (src/settings.js): what each person may see and change of the settings, by section and
 * permission (SETTINGS_SECTIONS, permittedSettings, settingsFor).
 *
 * GET and PUT /api/settings, the mail server's test and test email, the reminder template's preview, the
 * discovery of the risks endpoint (POST /api/discover) and tagging who started scans (POST /api/initiators/tag).
 * The connection checks that follow a change of settings are in src/routes/connections.js.
 */
import { listProjects } from '../cxone/projects.js';
import { selectRisks } from '../cxone/risks.js';
import { discover } from '../cxone/discovery.js';
import { scmConfigs } from '../scm/providers.js';
import { buildReminder } from '../reminder.js';
import { exampleLinks } from '../links.js';
import { sendTestEmail, testConnection } from '../mailer.js';
import { parseAddressList, publicSettings, smtpFingerprint } from '../settings.js';
import { mayUse } from '../features.js';

/**
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerSettingsRoutes(app, d) {
  const {
    settingsStore, guard, asyncRoute, requireSession, can, requirePermission, activeConfig, adminActor, githubConfig,
    ssoAddressProblem, noteConnectionHelp, creditSettingsOf, auditSettings, tenantCreditsOf,
  } = d;

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  /** Which permission each part of the settings needs to be changed. */
  const SETTINGS_SECTIONS = {
    smtp: 'integration.smtp',
    recipients: 'settings.recipients',
    // Who gets reminders (each developer, the fixed list, or both): one choice for every place that sends them.
    reminders: 'settings.recipients',
    initiators: 'settings.initiators',
    template: 'settings.template',
    branding: 'settings.branding',
    links: 'settings.links',
    automation: 'settings.automation',
    // SLAs (Beta): who may change automation, and may use SLAs (see permittedSettings).
    sla: 'settings.automation',
    endpoints: 'integration.cxone',
    beta: 'beta.use',
    // The Impact page's minutes, rates and monthly summary: whoever sets the AI rules.
    impact: 'settings.ai',
    // How people ask for help (the portal, or email to an address): the support team's.
    support: 'support.manage',
  };

  /**
   * Keep only what this person may change. Sections they may not change are
   * dropped (and reported), so a form posted whole cannot slip them through.
   */
  function permittedSettings(req, body = {}) {
    const allowed = {};
    const ignored = [];
    for (const [key, value] of Object.entries(body ?? {})) {
      if (key === 'aiTriage' && value && typeof value === 'object') {
        // The credit pool (size and period) is the Admin's; the rest is the AI settings permission's.
        const { monthlyCreditLimit, poolPeriod, ...rules } = value;
        const ai = {};
        if (Object.keys(rules).length) {
          if (can(req, 'settings.ai')) Object.assign(ai, rules);
          else ignored.push('aiTriage');
        }
        for (const [field, given] of [['monthlyCreditLimit', monthlyCreditLimit], ['poolPeriod', poolPeriod]]) {
          if (given === undefined) continue;
          if (can(req, 'credits.limit')) ai[field] = given;
          else ignored.push(`aiTriage.${field}`);
        }
        if (Object.keys(ai).length) allowed.aiTriage = ai;
      } else if (key === 'sla' && !mayUse(settingsStore.get(), 'sla', req.permissions)) {
        ignored.push(key);
      } else if (SETTINGS_SECTIONS[key] && can(req, SETTINGS_SECTIONS[key])) {
        allowed[key] = value;
      } else {
        ignored.push(key);
      }
    }
    return { allowed, ignored };
  }

  /** Settings as this person may see them (secrets are never sent to anyone). */
  function settingsFor(req, settings) {
    const view = publicSettings(settings);
    if (!can(req, 'settings.view') && !can(req, 'integration.smtp')) view.smtp = { passwordSet: view.smtp.passwordSet };
    // The Branding page is for those allowed to see it (the header still shows the name and logo).
    if (!can(req, 'branding.view') && !can(req, 'settings.branding')) delete view.branding;
    if (!can(req, 'beta.use')) delete view.beta;
    else {
      // Whether a token is in use, as the server would use it: an environment token
      // counts only for the host its environment address names.
      const scm = scmConfigs(settings);
      const sources = { github: githubConfig(settings).tokenSource, gitlab: scm.gitlab.tokenSource, azure: scm.azure.tokenSource, bitbucket: scm.bitbucket.tokenSource };
      for (const [id, source] of Object.entries(sources)) {
        if (!view.beta[id]) continue;
        view.beta[id].tokenSet = source !== 'none';
        view.beta[id].tokenFromEnvironment = source === 'environment';
      }
    }
    return view;
  }

  /** The Checkmarx One connection, or null while none is set up: settings and previews work without it. */
  const connectionOrNull = (session) => {
    try {
      return session?.connection ?? null;
    } catch {
      return null;
    }
  };

  app.get('/api/settings', requireSession, (req, res) => {
    const settings = settingsStore.get();
    res.json({
      ...settingsFor(req, settings),
      // Rendered from the current templates so a wrong UI route is visible
      // without having to send a mail to find out.
      linkExamples: exampleLinks(connectionOrNull(req.session), settings.links),
    });
  });

  app.put(
    '/api/settings',
    requireSession,
    asyncRoute(async (req, res) => {
      const { allowed, ignored } = permittedSettings(req, req.body ?? {});
      if (!Object.keys(allowed).length) {
        return res.status(403).json({ error: 'Your role cannot change these settings.', ignored });
      }
      const before = creditSettingsOf(settingsStore.get());
      // The credit pool stays within what the tenant has left in Checkmarx One (read afresh): a pool set or changed
      // above it is refused. One left as it was saves with the rest; spending stops at what the tenant has left anyway.
      const size = Number(allowed.aiTriage?.monthlyCreditLimit);
      if (Number.isFinite(size) && size > 0 && size !== Number(settingsStore.get().aiTriage?.monthlyCreditLimit ?? 0)) {
        const tenant = await tenantCreditsOf(req, { fresh: true });
        if (tenant && size > tenant.available) {
          return res.status(400).json({ error: `The credit pool (${size.toLocaleString('en')}) cannot be more than the ${tenant.available.toLocaleString('en')} credits this tenant has left in Checkmarx One (${(tenant.total ?? tenant.available).toLocaleString('en')} in all, ${(tenant.used ?? 0).toLocaleString('en')} used).`, tenant });
        }
      }
      const addressProblem = ssoAddressProblem(req, allowed.links);
      if (addressProblem) return res.status(400).json({ error: addressProblem });
      const smtpBefore = smtpFingerprint(settingsStore.get().smtp);
      const saved = settingsStore.save(allowed);
      // A changed mail server is checked (and rolled back if it fails) when the editor leaves Settings, or after a while.
      if (smtpFingerprint(saved.smtp) !== smtpBefore) guard.touch();
      auditSettings(await adminActor(req), before, creditSettingsOf(saved));
      res.json({
        ...settingsFor(req, saved),
        ignored,
        linkExamples: exampleLinks(connectionOrNull(req.session), saved.links),
      });
    }),
  );

  /** Run the SMTP handshake; success is what unlocks sending. */
  app.post(
    '/api/settings/smtp/test',
    requirePermission('integration.smtp'),
    asyncRoute(async (req, res) => {
      // Persist the whole form first, so testing never discards edits the
      // administrator has made to other fields, and so the test always reflects
      // what is on screen rather than what was last saved.
      // Only the mail server part of the form is saved here: this route is the SMTP permission's.
      const settings = req.body?.smtp ? settingsStore.save({ smtp: req.body.smtp }) : settingsStore.get();
      const result = await testConnection(settings.smtp).catch((error) => {
        noteConnectionHelp('smtp', { ok: false, help: error.help });
        throw error;
      });
      noteConnectionHelp('smtp', { ok: true });
      const saved = settingsStore.markVerified();
      guard.recordGood('smtp', saved.smtp);
      res.json({ ...result, settings: settingsFor(req, saved) });
    }),
  );

  app.post(
    '/api/settings/smtp/send-test',
    requirePermission('integration.smtp'),
    asyncRoute(async (req, res) => {
      const [to] = parseAddressList(req.body?.to ?? '');
      const result = await sendTestEmail(settingsStore.get().smtp, to);
      res.json(result);
    }),
  );

  /** Render the stored template against sample data, for the editor preview. */
  app.post(
    '/api/settings/template/preview',
    requirePermission('settings.template', 'reminders.send', 'settings.view'),
    asyncRoute(async (req, res) => {
      const settings = settingsStore.get();
      // Only someone who may edit the template previews unsaved markup; anyone else sees the saved one.
      const editing = can(req, 'settings.template');
      const template = {
        subject: (editing ? req.body?.subject : undefined) ?? settings.template.subject,
        html: (editing ? req.body?.html : undefined) ?? settings.template.html,
      };
      const connection = connectionOrNull(req.session);

      const risks = req.session.lastScan
        ? selectRisks(req.session.lastScan.projects, { buckets: [] }).slice(0, 12)
        : SAMPLE_RISKS;

      const reminder = buildReminder(risks.length ? risks : SAMPLE_RISKS, template, {
        buckets: ['60+'],
        tenant: connection?.tenant ?? '',
        links: settings.links,
        connection,
        branding: settings.branding,
        initiatorsByProject: req.session.lastScan?.initiators ?? {},
      });
      res.json({ subject: reminder.subject, html: reminder.html, text: reminder.text });
    }),
  );

  /** Stand-in findings so the template editor works before the first fetch. */
  const SAMPLE_RISKS = [
    {
      projectId: '2c7007de-1c72-42bf-80db-97967a6e3e29',
      scanId: '80f5a95a-ba0e-43d9-9486-d26ac4d82a0b',
      id: 'cye0DZkmtm6xwMN4J1Td3BKw03o=',
      projectName: 'Payments API',
      title: 'SQL Injection',
      severity: 'HIGH',
      location: 'src/db/query.js',
      firstDetectedAt: '2026-02-11T00:00:00.000Z',
      ageDays: 218,
      state: 'CONFIRMED',
      scanner: 'SAST',
    },
    {
      projectId: '2c7007de-1c72-42bf-80db-97967a6e3e29',
      scanId: '80f5a95a-ba0e-43d9-9486-d26ac4d82a0b',
      id: 'P/DqljWEGo1ADcofHN6qnx7er5M=',
      projectName: 'Payments API',
      title: 'CVE-2024-21538 in cross-spawn',
      severity: 'CRITICAL',
      location: 'cross-spawn@7.0.3',
      firstDetectedAt: '2025-12-02T00:00:00.000Z',
      ageDays: 289,
      state: 'TO_VERIFY',
      scanner: 'SCA',
    },
    {
      projectId: '72e4088c-26a0-46ef-a6fc-e42a2eafd9c3',
      scanId: 'ef1c75f0-9116-42c2-851f-ba276c7616cc',
      id: 'FYlX49796MsmZ729jiZ3AXTv/1o=',
      projectName: 'Web Storefront',
      title: 'Reflected XSS',
      severity: 'MEDIUM',
      location: 'web/render.js',
      firstDetectedAt: '2026-05-04T00:00:00.000Z',
      ageDays: 136,
      state: 'CONFIRMED',
      scanner: 'SAST',
    },
  ];

  // ---------------------------------------------------------------------------
  // Endpoint discovery
  // ---------------------------------------------------------------------------

  app.post(
    '/api/discover',
    requirePermission('integration.cxone'),
    asyncRoute(async (req, res) => {
      const { client } = req.session;
      const known = req.session.lastScan?.projects?.[0]?.projectId;
      const projectId = known ?? (await listProjects(client, { maxItems: 1 }))[0]?.id ?? '';

      const report = await discover(client, {
        configuredPath: activeConfig().risks.path,
        projectId,
      });
      res.json(report);
    }),
  );

  /**
   * Attach an email address to a scan initiator whose address could not be
   * resolved. The address is merged into the stored overrides (so it is
   * remembered for future fetches) and patched into the current scan, so the
   * operator can tag someone and send immediately without re-fetching.
   */
  app.post(
    '/api/initiators/tag',
    requirePermission('initiators.tag'),
    asyncRoute(async (req, res) => {
      const initiator = String(req.body?.initiator ?? '').trim();
      const [email] = parseAddressList(req.body?.email ?? '');

      if (!initiator) return res.status(400).json({ error: 'Which initiator is this address for?' });
      if (initiator.length > 200) return res.status(400).json({ error: 'That initiator name is too long (200 characters at most).' });
      if (!email) return res.status(400).json({ error: `"${String(req.body?.email ?? '').slice(0, 200)}" is not a valid email address.` });

      const current = settingsStore.get().initiators.overrides;
      // Tagging fills in a missing address; changing one already set is for whoever manages initiator addresses.
      if (Object.hasOwn(current, initiator) && current[initiator] !== email && !can(req, 'settings.initiators')) {
        return res.status(409).json({ error: `${initiator} already has an address (${current[initiator]}). Ask someone who manages initiator addresses in Settings to change it.` });
      }
      const saved = settingsStore.save({
        // Merge, so tagging one person never clears the others.
        initiators: { overrides: { ...current, [initiator]: email } },
      });

      // Patch the in-memory scan so the new address is usable straight away.
      let projectsUpdated = 0;
      for (const info of Object.values(req.session.lastScan?.initiators ?? {})) {
        if (info.initiator === initiator) {
          info.email = email;
          info.via = 'override';
          projectsUpdated += 1;
        }
      }
      for (const summary of req.session.lastScan?.projects ?? []) {
        if (summary.initiator === initiator) {
          summary.initiatorEmail = email;
          summary.initiatorVia = 'override';
        }
      }

      res.json({ initiator, email, projectsUpdated, settings: settingsFor(req, saved) });
    }),
  );

  return { settingsFor };
}
