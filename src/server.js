import { fileURLToPath } from 'node:url';
import path from 'node:path';

import express from 'express';

import { config, configProblems } from './config.js';
import { filterProjectsByActivity, listProjects } from './cxone/projects.js';
import { AGE_BUCKETS, collectProjectRisks, selectRisks } from './cxone/risks.js';
import { discover } from './cxone/discovery.js';
import { collectInitiators, groupRisksByInitiator } from './cxone/initiators.js';
import { buildReminder } from './reminder.js';
import { sendReminderMail, sendTestEmail, testConnection } from './mailer.js';
import { SettingsStore, isVerified, parseAddressList, publicSettings } from './settings.js';
import { DEFAULT_TEMPLATE, TEMPLATE_VARIABLES } from './template.js';
import { WINDOW_PRESETS, describeWindow, resolveWindow } from './window.js';
import {
  SessionStore,
  clearSessionCookie,
  describeSession,
  readSessionCookie,
  setSessionCookie,
} from './session.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const sessions = new SessionStore({ idleMs: config.session.idleMs });
const settingsStore = new SettingsStore(
  config.settingsFile ? { file: config.settingsFile } : undefined,
);
let bootstrapSessionId = null;

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(publicDir));

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

/** Resolve the caller's session, falling back to the optional bootstrap one. */
const currentSession = (req) =>
  sessions.get(readSessionCookie(req)) ?? sessions.get(bootstrapSessionId);

/** Gate for every route that talks to Checkmarx One. */
function requireSession(req, res, next) {
  const session = currentSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Not connected. Enter your Checkmarx One API key to continue.' });
  }
  req.session = session;
  next();
}

/** Deployment config with the administrator's pinned risks path layered on. */
function activeConfig() {
  const pinned = settingsStore.get().endpoints.risksPath;
  return pinned ? { ...config, risks: { ...config.risks, path: pinned } } : config;
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({
    problems: configProblems(config),
    riskSource: config.risks.source,
    buckets: AGE_BUCKETS.map(({ id, label }) => ({ id, label })),
    windowPresets: WINDOW_PRESETS.map(({ id, label }) => ({ id, label })),
    templateVariables: TEMPLATE_VARIABLES,
    defaultTemplate: DEFAULT_TEMPLATE,
  });
});

app.get('/api/session', (req, res) => {
  const session = currentSession(req);
  res.json(session ? describeSession(session) : { connected: false });
});

/** Verify a pasted API key and open a session for it. */
app.post(
  '/api/session',
  asyncRoute(async (req, res) => {
    const { apiKey, baseUrl, iamUrl, tenant } = req.body ?? {};
    const session = await sessions.create(apiKey, {
      baseUrl: baseUrl || config.overrides.baseUrl,
      iamUrl: iamUrl || config.overrides.iamUrl,
      tenant: tenant || config.overrides.tenant,
    });
    setSessionCookie(req, res, session.id);
    res.status(201).json(describeSession(session));
  }),
);

app.delete('/api/session', (req, res) => {
  const id = readSessionCookie(req);
  if (id) sessions.destroy(id);
  if (id && id === bootstrapSessionId) bootstrapSessionId = null;
  clearSessionCookie(res);
  res.json({ connected: false });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

app.get('/api/settings', requireSession, (req, res) => {
  res.json(publicSettings(settingsStore.get()));
});

app.put(
  '/api/settings',
  requireSession,
  asyncRoute(async (req, res) => {
    res.json(publicSettings(settingsStore.save(req.body ?? {})));
  }),
);

/** Run the SMTP handshake; success is what unlocks sending. */
app.post(
  '/api/settings/smtp/test',
  requireSession,
  asyncRoute(async (req, res) => {
    // Persist the whole form first, so testing never discards edits the
    // administrator has made to other fields, and so the test always reflects
    // what is on screen rather than what was last saved.
    const settings = req.body && Object.keys(req.body).length ? settingsStore.save(req.body) : settingsStore.get();
    const result = await testConnection(settings.smtp);
    const saved = settingsStore.markVerified();
    res.json({ ...result, settings: publicSettings(saved) });
  }),
);

app.post(
  '/api/settings/smtp/send-test',
  requireSession,
  asyncRoute(async (req, res) => {
    const [to] = parseAddressList(req.body?.to ?? '');
    const result = await sendTestEmail(settingsStore.get().smtp, to);
    res.json(result);
  }),
);

/** Render the stored template against sample data, for the editor preview. */
app.post(
  '/api/settings/template/preview',
  requireSession,
  asyncRoute(async (req, res) => {
    const settings = settingsStore.get();
    const template = {
      subject: req.body?.subject ?? settings.template.subject,
      html: req.body?.html ?? settings.template.html,
    };

    const risks = req.session.lastScan
      ? selectRisks(req.session.lastScan.projects, { buckets: [] }).slice(0, 12)
      : SAMPLE_RISKS;

    const reminder = buildReminder(risks.length ? risks : SAMPLE_RISKS, template, {
      buckets: ['60+'],
      tenant: req.session.connection.tenant,
    });
    res.json({ subject: reminder.subject, html: reminder.html, text: reminder.text });
  }),
);

/** Stand-in findings so the template editor works before the first fetch. */
const SAMPLE_RISKS = [
  {
    projectId: 'sample-1',
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
    projectId: 'sample-1',
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
    projectId: 'sample-2',
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
  requireSession,
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

// ---------------------------------------------------------------------------
// Dashboard data
// ---------------------------------------------------------------------------

app.get(
  '/api/scan',
  requireSession,
  asyncRoute(async (req, res) => {
    const { client } = req.session;
    const active = activeConfig();

    const activityWindow = resolveWindow(
      { preset: req.query.activityPreset, from: req.query.activityFrom, to: req.query.activityTo },
      'Project activity',
    );
    const detectionWindow = resolveWindow(
      { preset: req.query.detectionPreset, from: req.query.detectionFrom, to: req.query.detectionTo },
      'First detection',
    );

    const started = Date.now();
    const settings = settingsStore.get();
    const allProjects = await listProjects(client);
    const { projects, skipped, warning, lastScans } = await filterProjectsByActivity(
      client,
      allProjects,
      activityWindow,
    );

    // Who ran each project's *latest* scan, so a rescan moves the reminder to
    // whoever ran it most recently.
    const initiators = await collectInitiators(client, req.session.connection, projects, {
      rules: settings.initiators,
      useDirectory: settings.initiators.useDirectory,
      concurrency: config.concurrency,
      lastScans: Object.keys(lastScans ?? {}).length ? lastScans : undefined,
    });

    const result = await collectProjectRisks(client, active, projects, { detectionWindow });
    for (const summary of result.projects) {
      const info = initiators.byProject[summary.projectId] ?? {};
      summary.initiator = info.initiator ?? '';
      summary.initiatorEmail = info.email ?? '';
      summary.initiatorVia = info.via ?? 'none';
      summary.lastScanDate = info.scanDate ?? null;
    }
    result.initiators = initiators.byProject;
    req.session.lastScan = result;

    res.json({
      ...result,
      windows: {
        activity: describeWindow(activityWindow),
        detection: describeWindow(detectionWindow),
      },
      projectsTotal: allProjects.length,
      projectsSkipped: skipped,
      warning,
      initiatorNotes: initiators.notes,
      unresolvedInitiators: initiators.unresolved,
      elapsedMs: Date.now() - started,
      totals: result.projects.reduce(
        (acc, summary) => {
          acc.projects += 1;
          acc.risks += summary.totalRisks;
          for (const [bucket, count] of Object.entries(summary.counts)) {
            acc.counts[bucket] = (acc.counts[bucket] ?? 0) + count;
          }
          for (const [severity, count] of Object.entries(summary.bySeverity)) {
            acc.severities[severity] = (acc.severities[severity] ?? 0) + count;
          }
          return acc;
        },
        { projects: 0, risks: 0, counts: {}, severities: {} },
      ),
    });
  }),
);

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

app.post(
  '/api/reminders',
  requireSession,
  asyncRoute(async (req, res) => {
    const {
      projectIds = null,
      buckets = [],
      severities = null,
      initiators: wantedInitiators = null,
      groupBy = 'none',
      dryRun = false,
      recipients,
    } = req.body ?? {};

    const { lastScan, connection } = req.session;
    const settings = settingsStore.get();

    if (!lastScan) {
      return res.status(409).json({ error: 'Fetch the project list first, then send a reminder.' });
    }
    if (!Array.isArray(buckets) || buckets.length === 0) {
      return res.status(400).json({ error: 'Select at least one age bucket (30 / 60 / 60+ days).' });
    }

    const initiatorsByProject = lastScan.initiators ?? {};

    // Narrowing by initiator is a project-level filter: a finding belongs to
    // whoever ran that project's latest scan.
    let scopedProjectIds = projectIds;
    if (Array.isArray(wantedInitiators) && wantedInitiators.length > 0) {
      const wanted = new Set(wantedInitiators);
      const matching = Object.entries(initiatorsByProject)
        .filter(([, info]) => wanted.has(info.email) || wanted.has(info.initiator))
        .map(([projectId]) => projectId);
      scopedProjectIds = projectIds ? matching.filter((id) => projectIds.includes(id)) : matching;
    }

    const risks = selectRisks(lastScan.projects, {
      projectIds: scopedProjectIds,
      buckets,
      severities,
    });
    if (risks.length === 0) {
      return res.status(400).json({ error: 'No vulnerabilities match that selection.' });
    }

    const common = { buckets, tenant: connection.tenant, initiatorsByProject };

    // ---- One email per scan initiator -------------------------------------
    if (groupBy === 'initiator') {
      const groups = groupRisksByInitiator(risks, initiatorsByProject);
      const sendable = groups.filter((group) => group.email);
      const skipped = groups
        .filter((group) => !group.email)
        .map((group) => ({
          initiator: group.initiator || '(unknown)',
          riskCount: group.risks.length,
          projectCount: group.projectCount,
          reason: group.initiator
            ? 'No email address could be resolved for this user.'
            : 'No initiator recorded on the latest scan.',
        }));

      const prepared = sendable.map((group) => ({
        group,
        reminder: buildReminder(risks.filter((r) => group.projectIds.includes(r.projectId)), settings.template, {
          ...common,
          initiator: group,
        }),
      }));

      if (dryRun) {
        return res.json({
          dryRun: true,
          groupBy: 'initiator',
          canSend: isVerified(settings),
          skipped,
          messages: prepared.map(({ group, reminder }) => ({
            initiator: group.initiator,
            email: group.email,
            via: group.via,
            projectCount: group.projectCount,
            riskCount: group.risks.length,
            subject: reminder.subject,
            html: reminder.html,
          })),
        });
      }

      if (prepared.length === 0) {
        return res.status(400).json({
          error: 'No scan initiator in this selection has a resolvable email address.',
          skipped,
        });
      }

      // Sent one at a time so a single bad address cannot lose the rest.
      const sent = [];
      const failed = [];
      for (const { group, reminder } of prepared) {
        try {
          const result = await sendReminderMail(settings, reminder, {
            to: [group.email],
            cc: settings.initiators.copyConfiguredRecipients ? settings.recipients.cc : [],
            bcc: settings.initiators.copyConfiguredRecipients ? settings.recipients.bcc : [],
          });
          sent.push({
            initiator: group.initiator,
            email: group.email,
            riskCount: group.risks.length,
            projectCount: group.projectCount,
            messageId: result.messageId,
          });
        } catch (error) {
          failed.push({ initiator: group.initiator, email: group.email, error: error.message });
        }
      }

      return res.json({
        groupBy: 'initiator',
        delivered: sent.length > 0,
        sent,
        failed,
        skipped,
        totalRisks: risks.length,
      });
    }

    // ---- One email to the configured recipient list ------------------------
    const reminder = buildReminder(risks, settings.template, common);

    if (dryRun) {
      return res.json({
        dryRun: true,
        groupBy: 'none',
        subject: reminder.subject,
        html: reminder.html,
        text: reminder.text,
        totalRisks: risks.length,
        projects: reminder.projects.length,
        recipients: settings.recipients,
        canSend: isVerified(settings),
      });
    }

    const overrides = recipients
      ? {
          to: parseAddressList(recipients.to ?? []),
          cc: parseAddressList(recipients.cc ?? []),
          bcc: parseAddressList(recipients.bcc ?? []),
        }
      : {};

    const result = await sendReminderMail(settings, reminder, overrides);
    res.json({ ...result, groupBy: 'none', totalRisks: risks.length, projects: reminder.projects.length });
  }),
);

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
app.use((error, req, res, next) => {
  const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 500;
  console.error(`${req.method} ${req.path} ->`, error.message);
  res.status(status).json({ error: error.message ?? 'Unexpected error.', detail: error.body ?? undefined });
});

async function bootstrap() {
  if (!config.bootstrapApiKey) return;
  try {
    const session = await sessions.create(config.bootstrapApiKey, config.overrides);
    bootstrapSessionId = session.id;
    console.log(`Bootstrapped from CX_API_KEY: tenant ${session.connection.tenant}`);
  } catch (error) {
    console.warn(`! CX_API_KEY was set but could not be used: ${error.message}`);
  }
}

const server = app.listen(config.port, config.host, async () => {
  console.log(`Checkmarx detection-date reminder running on http://${config.host}:${config.port}`);
  console.log(`Settings file: ${settingsStore.file}`);
  for (const problem of configProblems(config)) console.warn(`! ${problem}`);
  await bootstrap();
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { app, sessions, settingsStore };
