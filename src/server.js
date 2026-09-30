import { fileURLToPath } from 'node:url';
import path from 'node:path';

import express from 'express';

import { config, configProblems } from './config.js';
import { filterProjectsByActivity, listProjects } from './cxone/projects.js';
import { AGE_BUCKETS, collectProjectRisks, createRiskSource, normalizeRisk, selectRisks } from './cxone/risks.js';
import { discover } from './cxone/discovery.js';
import { collectInitiators, groupRisksByInitiator, groupRisksByProject } from './cxone/initiators.js';
import { resolveAiIds } from './cxone/ai-assist.js';
import { mapWithConcurrency } from './cxone/client.js';
import { ReportGrants } from './report-grants.js';
import { CreditLedger, monthOf } from './credits.js';
import { CreditAllocations, toTriageCount } from './credit-allocations.js';
import { TrackedReports, computeProgress, reportSummary } from './tracked-reports.js';
import { BULK_SEVERITIES, REPORT_TOP_N, generateHtmlReport, selectTopFindings } from './html-report.js';
import { buildReminder, buildReportData, buildReportEmail } from './reminder.js';
import { exampleLinks, projectUrl } from './links.js';
import { AutomationState, Scheduler } from './automation.js';
import { sendReminderMail, sendTestEmail, testConnection } from './mailer.js';
import { SettingsStore, applyEnvironmentSmtp, hasEnvironmentSmtp, isVerified, parseAddressList, publicSettings } from './settings.js';
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
settingsStore.applyEnvironment();
const settings = settingsStore.get();
if (process.env.SMTP_HOST) {
  console.log(`[SMTP] Loaded from environment: ${settings.smtp.host}:${settings.smtp.port}`);
}
let bootstrapSessionId = null;

const dataDir = path.dirname(config.settingsFile || path.join(process.cwd(), 'data', 'settings.json'));
const creditLedger = new CreditLedger({ file: path.join(dataDir, 'triage-credits.json') });
const allocations = new CreditAllocations({ file: path.join(dataDir, 'credit-allocations.json'), ledger: creditLedger });

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const trackedReports = new TrackedReports({ file: path.join(dataDir, 'tracked-reports.json') });

/** Projects someone just triaged or remediated in, so reports covering them refresh soon. */
const touchedProjects = new Map();
const touchProject = (projectId) => touchedProjects.set(projectId, Date.now());

/** Per-project credit balances and what is still to triage, for the dashboard. */
function creditView(summary) {
  return {
    ...allocations.balance(summary.projectId),
    toTriage: Object.fromEntries(SEVERITIES.map((s) => [s, toTriageCount(summary.risks ?? [], [s])])),
  };
}

const reportGrants = new ReportGrants({
  secret: process.env.REPORT_SIGNING_KEY?.trim() || undefined,
  file: path.join(path.dirname(config.settingsFile || path.join(process.cwd(), 'data', 'settings.json')), 'report-signing.key'),
});

const automationState = new AutomationState(
  config.settingsFile
    ? { file: config.settingsFile.replace(/\.json$/, '') + '-automation.json' }
    : undefined,
);

/**
 * The session unattended runs use. Automation has no browser to paste a key,
 * so it needs a credential that outlives a session: either CX_API_KEY, or one
 * the administrator explicitly armed from the Settings page.
 */
let automationSessionId = null;

async function resolveAutomationSession() {
  const existing = sessions.get(automationSessionId) ?? sessions.get(bootstrapSessionId);
  if (existing) return existing;

  const storedKey = settingsStore.get().automationApiKey;
  if (!storedKey) return null;

  try {
    const session = await sessions.create(storedKey, config.overrides);
    automationSessionId = session.id;
    return session;
  } catch (error) {
    console.warn(`! Stored automation key could not be used: ${error.message}`);
    return null;
  }
}

const scheduler = new Scheduler({
  // The scheduler is synchronous about session lookup, so a key armed while
  // the process is running is picked up by the refresh below rather than here.
  resolveSession: () => sessions.get(automationSessionId) ?? sessions.get(bootstrapSessionId),
  state: automationState,
  settingsStore,
  config: () => activeConfig(),
  isVerified,
});

const escapeHtml = (text) => String(text ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(publicDir));

/**
 * The emailed report is opened from disk (origin "null"), so its calls to the
 * relay are cross-origin. No cookies are involved: every relay action is
 * authorised by the signed grants the report carries.
 */
app.use('/api/relay', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Max-Age', '600');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

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
  const settings = settingsStore.get();
  res.json({
    ...publicSettings(settings),
    // Rendered from the current templates so a wrong UI route is visible
    // without having to send a mail to find out.
    linkExamples: exampleLinks(req.session.connection, settings.links),
  });
});

app.put(
  '/api/settings',
  requireSession,
  asyncRoute(async (req, res) => {
    const saved = settingsStore.save(req.body ?? {});
    res.json({
      ...publicSettings(saved),
      linkExamples: exampleLinks(req.session.connection, saved.links),
    });
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
      links: settings.links,
      connection: req.session.connection,
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

/**
 * Attach an email address to a scan initiator whose address could not be
 * resolved. The address is merged into the stored overrides (so it is
 * remembered for future fetches) and patched into the current scan, so the
 * operator can tag someone and send immediately without re-fetching.
 */
app.post(
  '/api/initiators/tag',
  requireSession,
  asyncRoute(async (req, res) => {
    const initiator = String(req.body?.initiator ?? '').trim();
    const [email] = parseAddressList(req.body?.email ?? '');

    if (!initiator) return res.status(400).json({ error: 'Which initiator is this address for?' });
    if (!email) return res.status(400).json({ error: `"${req.body?.email ?? ''}" is not a valid email address.` });

    const current = settingsStore.get().initiators.overrides;
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

    res.json({ initiator, email, projectsUpdated, settings: publicSettings(saved) });
  }),
);

// ---------------------------------------------------------------------------
// Automation
// ---------------------------------------------------------------------------

app.get('/api/automation', requireSession, (req, res) => {
  const settings = settingsStore.get();
  res.json({
    ...scheduler.status,
    config: settings.automation,
    keyStored: Boolean(settings.automationApiKey),
    bootstrapKey: Boolean(config.bootstrapApiKey),
    canRun: Boolean(sessions.get(automationSessionId) ?? sessions.get(bootstrapSessionId)),
    smtpVerified: isVerified(settings),
  });
});

app.put(
  '/api/automation',
  requireSession,
  asyncRoute(async (req, res) => {
    settingsStore.save({ automation: req.body ?? {} });
    await resolveAutomationSession();
    scheduler.sync();
    res.json({ ...scheduler.status, config: settingsStore.get().automation });
  }),
);

/** Store the current session's key so unattended runs can authenticate. */
app.post(
  '/api/automation/arm',
  requireSession,
  asyncRoute(async (req, res) => {
    settingsStore.save({ automationApiKey: req.session.connection.apiKey });
    automationSessionId = req.session.id;
    scheduler.sync();
    res.json({ ...scheduler.status, keyStored: true, canRun: true });
  }),
);

app.delete('/api/automation/arm', requireSession, (req, res) => {
  settingsStore.save({ automationApiKey: '' });
  automationSessionId = null;
  res.json({ ...scheduler.status, keyStored: false, canRun: Boolean(sessions.get(bootstrapSessionId)) });
});

/** Run a pass now, without waiting for the timer. */
app.post(
  '/api/automation/run',
  requireSession,
  asyncRoute(async (req, res) => {
    // A manual run uses the caller's own session when nothing is armed, so
    // automation can be rehearsed before a credential is stored.
    if (!(sessions.get(automationSessionId) ?? sessions.get(bootstrapSessionId))) {
      automationSessionId = req.session.id;
    }
    const run = await scheduler.tick({ force: true });
    res.json({ run, status: scheduler.status });
  }),
);

/** Forget every reported pair, so the next run reports from scratch. */
app.post('/api/automation/reset', requireSession, (req, res) => {
  automationState.reset();
  res.json(scheduler.status);
});

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
      summary.initiatorSuggestion = info.suggestedEmail ?? '';
      summary.initiatorConfidence = info.confidence ?? 'none';
      summary.lastScanDate = info.scanDate ?? null;
      summary.url = projectUrl(summary, req.session.connection, settings.links);
    }
    result.initiators = initiators.byProject;
    let allocationsChanged = false;
    for (const summary of result.projects) {
      if (summary.error) continue;
      allocationsChanged = allocations.applyRule(summary.projectId, summary.projectName, summary.risks) || allocationsChanged;
    }
    if (allocationsChanged) allocations.save();
    for (const summary of result.projects) summary.credits = creditView(summary);
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
      suggestedInitiators: initiators.suggested,
      initiatorDomain: initiators.domain,
      directorySize: initiators.directorySize,
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
      alsoConsolidated = false,
      dryRun = false,
      recipients,
    } = req.body ?? {};

    const { lastScan, connection } = req.session;
    const settings = settingsStore.get();

    if (!lastScan) {
      return res.status(409).json({ error: 'Fetch the project list first, then send a reminder.' });
    }
    // An empty bucket list means "no age filter", so a selection of projects or
    // initiators is enough on its own to send.
    const ageBuckets = Array.isArray(buckets) ? buckets : [];

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
      buckets: ageBuckets,
      severities,
    });
    if (risks.length === 0) {
      return res.status(400).json({ error: 'No vulnerabilities match that selection.' });
    }

    const common = {
      buckets: ageBuckets,
      tenant: connection.tenant,
      initiatorsByProject,
      links: settings.links,
      connection,
      branding: settings.branding,
    };

    // ---- One email per scan initiator -------------------------------------
    if (groupBy === 'initiator' || groupBy === 'project') {
      const groups =
        groupBy === 'project'
          ? groupRisksByProject(risks, initiatorsByProject)
          : groupRisksByInitiator(risks, initiatorsByProject);
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

      // One extra message to the configured list, summarising everything the
      // individual messages covered, so a lead sees the whole picture.
      const consolidated =
        alsoConsolidated && settings.recipients.to.length > 0
          ? buildReminder(risks, settings.template, common)
          : null;

      if (dryRun) {
        return res.json({
          dryRun: true,
          groupBy,
          consolidated: consolidated
            ? { subject: consolidated.subject, html: consolidated.html, to: settings.recipients.to }
            : null,
          canSend: isVerified(settings),
          skipped,
          messages: prepared.map(({ group, reminder }) => ({
            initiator: group.initiator,
            projectName: group.projectName ?? '',
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
            projectName: group.projectName ?? '',
            email: group.email,
            riskCount: group.risks.length,
            projectCount: group.projectCount,
            messageId: result.messageId,
          });
        } catch (error) {
          failed.push({ initiator: group.initiator, email: group.email, error: error.message });
        }
      }

      if (consolidated) {
        try {
          const result = await sendReminderMail(settings, consolidated);
          sent.push({
            initiator: 'consolidated',
            email: result.recipients.to.join(', '),
            riskCount: risks.length,
            projectCount: new Set(risks.map((risk) => risk.projectId)).size,
            messageId: result.messageId,
          });
        } catch (error) {
          failed.push({ initiator: 'consolidated', email: 'list', error: error.message });
        }
      }

      return res.json({
        groupBy,
        delivered: sent.length > 0,
        sent,
        failed,
        skipped,
        consolidated: Boolean(consolidated),
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

/** Where emailed reports reach this server: the configured address, else the one the dashboard is using. */
function reportServerUrl(req, settings) {
  return settings.links.reportServerUrl || `${req.protocol}://${req.get('host')}`;
}

// ---------------------------------------------------------------------------
// Relay for the emailed report
//
// Checkmarx One does not accept API calls from a page opened as a local file,
// so the report's AI Triage actions come here and run on this server's own
// stored connection (CX_API_KEY, or the key armed for automation). Only
// findings carrying a valid grant from the report are ever acted on.
// ---------------------------------------------------------------------------

const RELAY_MAX_FINDINGS = 500;

function grantedFindings(req, res) {
  const list = Array.isArray(req.body?.findings) ? req.body.findings : [];
  if (list.length === 0 || list.length > RELAY_MAX_FINDINGS) {
    res.status(400).json({ error: `Send between 1 and ${RELAY_MAX_FINDINGS} findings.` });
    return null;
  }
  const findings = [];
  for (const raw of list) {
    const finding = {
      projectId: String(raw?.projectId ?? ''),
      projectName: String(raw?.projectName ?? ''),
      riskId: String(raw?.riskId ?? ''),
      scanId: String(raw?.scanId ?? ''),
      scanner: String(raw?.scanner ?? '').toUpperCase(),
      alternateId: String(raw?.alternateId ?? ''),
      groupId: String(raw?.groupId ?? ''),
      exp: raw?.exp,
      grant: raw?.grant,
    };
    const problem = reportGrants.verify(finding);
    if (problem) {
      res.status(403).json({
        error: problem === 'expired'
          ? 'This report has expired. Ask for a new one to triage from it.'
          : 'This report is not authorised for that action.',
      });
      return null;
    }
    findings.push(finding);
  }
  return findings;
}

async function relaySession(res) {
  const session = await resolveAutomationSession();
  if (!session) {
    res.status(503).json({
      error:
        'The reminder server has no stored Checkmarx One connection. ' +
        'Set CX_API_KEY, or arm automation on its Settings page.',
    });
  }
  return session;
}

/** The administrator's switch: AI Triage from reports spends this server's credits. */
const ACTION_NAMES = { enabled: 'AI Triage', remediationEnabled: 'AI Remediation' };

/** The administrator's switches: actions from reports spend this server's credits. */
function actionAllowed(res, flag = 'enabled') {
  if (settingsStore.get().aiTriage?.[flag]) return true;
  res.status(403).json({
    error: `${ACTION_NAMES[flag]} from reports is switched off. Ask your Checkmarx One reminder administrator to allow it.`,
  });
  return false;
}
const triageAllowed = (res) => actionAllowed(res, 'enabled');

const creditsRemaining = () => creditLedger.remaining(settingsStore.get().aiTriage?.monthlyCreditLimit ?? 0);

const KIND_NAMES = { triage: 'AI Triage', remediation: 'AI Remediation' };

/** Why `credits` of `kind` cannot be spent on this project now, or '' when they can. */
function creditRefusal(projectId, projectName, kind, credits, limit) {
  const project = projectName || projectId;
  const left = allocations.balance(projectId)[kind].remaining;
  if (credits > left) {
    return left === 0
      ? `${project} has no ${KIND_NAMES[kind]} credits left (${credits} needed). Ask your administrator to allocate more.`
      : `${project} has ${left} ${KIND_NAMES[kind]} credit${left === 1 ? '' : 's'} left, ${credits} needed. Ask your administrator to allocate more.`;
  }
  const monthLeft = creditLedger.remaining(limit);
  if (monthLeft !== null && credits > monthLeft) {
    return `This month's credit limit for actions from reports is reached (${monthLeft} of ${limit} left, ${credits} needed). Ask your administrator to raise it.`;
  }
  return '';
}

app.post(
  '/api/relay/status',
  asyncRoute(async (req, res) => {
    const { aiTriage } = settingsStore.get();
    if (!aiTriage?.enabled && !aiTriage?.remediationEnabled) {
      return res.status(403).json({
        error: 'AI Triage and Remediation from reports are switched off. Ask your Checkmarx One reminder administrator to allow them.',
      });
    }
    const session = await relaySession(res);
    if (session) {
      res.json({
        connected: true,
        tenant: session.connection.tenant,
        triage: Boolean(aiTriage.enabled),
        remediation: Boolean(aiTriage.remediationEnabled),
        creditsRemaining: creditsRemaining(),
      });
    }
  }),
);

app.post(
  '/api/relay/triage',
  asyncRoute(async (req, res) => {
    const findings = grantedFindings(req, res);
    if (!findings) return;
    if (!triageAllowed(res)) return;
    const session = await relaySession(res);
    if (!session) return;

    // One AI Triage request per scan and scanner, however many projects.
    const buckets = new Map();
    for (const finding of findings) {
      const key = `${finding.scanId}|${finding.scanner}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(finding);
    }

    const limit = settingsStore.get().aiTriage?.monthlyCreditLimit ?? 0;
    const results = [];
    for (const group of buckets.values()) {
      const { scanId, scanner, projectId, projectName } = group[0];
      const alternateIds = [...new Set(group.map((f) => f.alternateId))];

      const refusal = creditRefusal(projectId, projectName, 'triage', alternateIds.length, limit);
      if (refusal) {
        results.push({ alternateIds, ok: false, status: 402, error: refusal });
        continue;
      }
      const reservation = creditLedger.reserve(alternateIds.length, limit, new Date(), {
        projectId,
        kind: 'triage',
        allowance: allocations.balance(projectId).triage.allocated,
      });
      if (!reservation) {
        results.push({ alternateIds, ok: false, status: 402, error: 'Credits are busy with another request; try again in a moment.' });
        continue;
      }
      try {
        const body = await session.client.request('/api/ai-triage/triage', {
          method: 'POST',
          body: { scanID: scanId, buckets: [{ scannerType: scanner.toLowerCase(), resultIDs: alternateIds }] },
          retries: 1,
        });
        const published = body?.published !== false;
        // Checkmarx One only starts (and charges for) a new job when published.
        if (published) creditLedger.record({ projectId, projectName, credits: alternateIds.length, scanId, kind: 'triage' });
        stateCache.delete(projectId);
        touchProject(projectId);
        results.push({ alternateIds, ok: true, published });
      } catch (error) {
        results.push({ alternateIds, ok: false, status: error.status ?? 0, error: error.message });
        // No credits or no permission: every further request would fail the same way.
        if (error.status === 402 || error.status === 403) break;
      } finally {
        reservation.release();
      }
    }
    res.json({ results, creditsRemaining: creditsRemaining() });
  }),
);

/**
 * Current Checkmarx One state (To verify, Confirmed, Proposed not
 * exploitable, ...) of every risk in a project, by risk id — the same state
 * Risk Hub shows. AI Triage's own record can lag it (still "To verify" after
 * the risk has settled) or be missing for a finding it changed, so the
 * report shows this. Cached briefly because every report poll asks.
 */
const STATE_CACHE_MS = 20_000;
const stateCache = new Map();

async function projectStates(session, projectId) {
  const cached = stateCache.get(projectId);
  if (cached && Date.now() - cached.at < STATE_CACHE_MS) return cached.states;
  const cfg = activeConfig();
  const project = { id: projectId, name: '' };
  const source = createRiskSource(session.client, cfg);
  if (source.prime) await source.prime([project]);
  const states = new Map();
  for (const raw of await source.fetchForProject(project)) {
    const risk = normalizeRisk(raw, project);
    if (risk.state) {
      states.set(risk.riskId, risk.state);
      if (risk.alternateId) states.set(risk.alternateId, risk.state);
    }
  }
  stateCache.set(projectId, { at: Date.now(), states });
  if (stateCache.size > 500) stateCache.delete(stateCache.keys().next().value);
  return states;
}

app.post(
  '/api/relay/triage-results',
  asyncRoute(async (req, res) => {
    const findings = grantedFindings(req, res);
    if (!findings) return;
    const session = await relaySession(res);
    if (!session) return;

    const statesByProject = new Map();
    await mapWithConcurrency([...new Set(findings.map((f) => f.projectId))], 3, async (projectId) => {
      try {
        statesByProject.set(projectId, await projectStates(session, projectId));
      } catch (error) {
        console.warn(`[relay] could not read risk states for project ${projectId}: ${error.message}`);
      }
    });

    const results = await mapWithConcurrency(findings, 4, async (finding) => {
      const states = statesByProject.get(finding.projectId);
      const state = states?.get(finding.riskId) ?? states?.get(finding.alternateId) ?? '';
      try {
        const body = await session.client.request(
          `/api/ai-triage/triage/${encodeURIComponent(finding.projectId)}/${encodeURIComponent(finding.groupId)}`,
          { retries: 1 },
        );
        return { found: true, body, state };
      } catch (error) {
        if (error.status === 404) return { found: false, state };
        return { found: false, state, status: error.status ?? 0, error: error.message };
      }
    });
    res.json({ results });
  }),
);

/**
 * AI Remediation for one finding. Checkmarx One first triages it, then
 * suggests a fix; for repository-integrated projects it opens a pull request.
 */
app.post(
  '/api/relay/remediate',
  asyncRoute(async (req, res) => {
    const findings = grantedFindings(req, res);
    if (!findings) return;
    if (findings.length !== 1) return res.status(400).json({ error: 'Remediate one finding at a time.' });
    if (!actionAllowed(res, 'remediationEnabled')) return;
    const session = await relaySession(res);
    if (!session) return;

    const [finding] = findings;
    const limit = settingsStore.get().aiTriage?.monthlyCreditLimit ?? 0;
    const refusal = creditRefusal(finding.projectId, finding.projectName, 'remediation', 1, limit);
    if (refusal) return res.status(402).json({ error: refusal, creditsRemaining: creditsRemaining() });
    const reservation = creditLedger.reserve(1, limit, new Date(), {
      projectId: finding.projectId,
      kind: 'remediation',
      allowance: allocations.balance(finding.projectId).remediation.allocated,
    });
    if (!reservation) {
      return res.status(402).json({ error: 'Credits are busy with another request; try again in a moment.' });
    }
    try {
      const body = await session.client.request('/api/remediation/remediate', {
        method: 'POST',
        body: {
          scanID: finding.scanId,
          buckets: [{ scannerType: finding.scanner.toLowerCase(), resultIDs: [finding.alternateId] }],
        },
        retries: 1,
      });
      const published = body?.published !== false;
      if (published) {
        creditLedger.record({
          projectId: finding.projectId,
          projectName: finding.projectName,
          credits: 1,
          scanId: finding.scanId,
          kind: 'remediation',
        });
      }
      stateCache.delete(finding.projectId);
      touchProject(finding.projectId);
      reservation.release();
      res.json({ ok: true, published, existingState: body?.existingState ?? null, creditsRemaining: creditsRemaining() });
    } catch (error) {
      res.status(error.status && error.status >= 400 ? error.status : 502).json({
        error: error.status === 402
          ? 'Checkmarx One has no credits left for AI Remediation.'
          : error.status === 403
            ? "The reminder server's Checkmarx One account is not allowed to run AI Remediation."
            : `AI Remediation could not start: ${error.message}`,
      });
    } finally {
      reservation.release();
    }
  }),
);

app.post(
  '/api/relay/remediation-details',
  asyncRoute(async (req, res) => {
    const findings = grantedFindings(req, res);
    if (!findings) return;
    if (findings.length !== 1) return res.status(400).json({ error: 'Ask about one finding at a time.' });
    const session = await relaySession(res);
    if (!session) return;
    const [finding] = findings;
    try {
      const body = await session.client.request(
        `/api/remediation/remediation-details/${encodeURIComponent(finding.scanId)}/${encodeURIComponent(finding.alternateId)}`,
        { retries: 1 },
      );
      res.json({ found: true, body });
    } catch (error) {
      if (error.status === 404) return res.json({ found: false });
      res.status(502).json({ error: `Could not read the AI Remediation result: ${error.message}` });
    }
  }),
);

// ---------------------------------------------------------------------------
// Credit allocation and triage by the administrator (dashboard)
// ---------------------------------------------------------------------------

function scanProjects(req, projectIds) {
  const projects = req.session.lastScan?.projects ?? [];
  const wanted = Array.isArray(projectIds) && projectIds.length ? new Set(projectIds.map(String)) : null;
  return projects.filter((p) => !p.error && (!wanted || wanted.has(p.projectId)));
}

const cleanSeverities = (list) =>
  [...new Set((Array.isArray(list) ? list : []).map((s) => String(s).toUpperCase()))].filter((s) => SEVERITIES.includes(s));

app.post('/api/credits/allocate', requireSession, (req, res) => {
  if (!req.session.lastScan) return res.status(409).json({ error: 'Fetch the project list first.' });
  const { projectIds, ruleChanges, triageAdd = 0, remediationAdd = 0 } = req.body ?? {};
  // Each change adds or removes one severity from every project's own rule,
  // so severities the administrator did not touch stay as each project had them.
  const changes = (Array.isArray(ruleChanges) ? ruleChanges : [])
    .map((c) => ({ severity: String(c?.severity ?? '').toUpperCase(), include: c?.include === true }))
    .filter((c) => SEVERITIES.includes(c.severity));
  const extraTriage = Math.max(0, Math.floor(Number(triageAdd) || 0));
  const extraRemediation = Math.max(0, Math.floor(Number(remediationAdd) || 0));
  if (!changes.length && !extraTriage && !extraRemediation) {
    return res.status(400).json({ error: 'Choose severities, or enter credits to add.' });
  }

  const projects = scanProjects(req, projectIds);
  for (const p of projects) {
    if (extraTriage) allocations.add(p.projectId, p.projectName, 'triage', extraTriage);
    if (extraRemediation) allocations.add(p.projectId, p.projectName, 'remediation', extraRemediation);
    let rule;
    if (changes.length) {
      const next = new Set(allocations.severitiesOf(p.projectId));
      for (const { severity, include } of changes) include ? next.add(severity) : next.delete(severity);
      rule = SEVERITIES.filter((s) => next.has(s));
    }
    allocations.applyRule(p.projectId, p.projectName, p.risks ?? [], rule);
  }
  allocations.save();
  for (const p of projects) p.credits = creditView(p);
  res.json({ projects: Object.fromEntries(projects.map((p) => [p.projectId, p.credits])) });
});

/**
 * The administrator triages chosen severities of chosen projects straight
 * away (e.g. before reports go out). Uses the dashboard's own connection;
 * credits count against each project's allocation, which is raised to cover
 * the request since the administrator is the one allocating.
 */
app.post(
  '/api/triage/run',
  requireSession,
  asyncRoute(async (req, res) => {
    if (!req.session.lastScan) return res.status(409).json({ error: 'Fetch the project list first.' });
    const wanted = cleanSeverities(req.body?.severities);
    if (!wanted.length) return res.status(400).json({ error: 'Pick at least one severity to triage.' });

    const projects = scanProjects(req, req.body?.projectIds);
    const RECENT_MS = 30 * 60 * 1000;
    const originals = new Map();
    const findings = [];
    for (const p of projects) {
      let live = null;
      try {
        live = await projectStates(req.session, p.projectId);
      } catch {}
      for (const r of p.risks ?? []) {
        const state = live?.get(r.riskId) ?? r.state;
        if (!wanted.includes(r.severity) || (state && state !== 'TO_VERIFY')) continue;
        if (r.triageRequestedAt && Date.now() - r.triageRequestedAt < RECENT_MS) continue;
        const copy = { ...r, projectId: p.projectId, projectName: p.projectName };
        originals.set(copy, r);
        findings.push(copy);
      }
    }
    if (!findings.length) return res.json({ requested: 0, started: 0, failed: 0, skipped: 0, errors: [], projects: {} });

    const initiatorsByProject = req.session.lastScan.initiators ?? {};
    await resolveAiIds(req.session.client, findings, (f) => initiatorsByProject[f.projectId]?.scanId ?? '');
    const eligible = findings.filter((f) => !f.aiUnavailable);

    const buckets = new Map();
    for (const f of eligible) {
      const key = `${f.scanId}|${f.scanner}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(f);
    }

    const limit = settingsStore.get().aiTriage?.monthlyCreditLimit ?? 0;
    let started = 0;
    let failed = 0;
    const errors = [];
    for (const group of buckets.values()) {
      const { scanId, scanner, projectId, projectName } = group[0];
      const alternateIds = [...new Set(group.map((f) => f.alternateId))];
      const reservation = creditLedger.reserve(alternateIds.length, limit);
      if (!reservation) {
        failed += group.length;
        errors.push(`${projectName}: this month's credit limit (${limit}) is reached.`);
        continue;
      }
      try {
        const body = await req.session.client.request('/api/ai-triage/triage', {
          method: 'POST',
          body: { scanID: scanId, buckets: [{ scannerType: scanner.toLowerCase(), resultIDs: alternateIds }] },
          retries: 1,
        });
        if (body?.published !== false) {
          const balance = allocations.balance(projectId).triage;
          if (balance.remaining < alternateIds.length) {
            allocations.raise(projectId, alternateIds.length - balance.remaining);
          }
          creditLedger.record({ projectId, projectName, credits: alternateIds.length, scanId, kind: 'triage' });
        }
        stateCache.delete(projectId);
        touchProject(projectId);
        for (const f of group) originals.get(f).triageRequestedAt = Date.now();
        started += group.length;
      } catch (error) {
        failed += group.length;
        errors.push(`${projectName}: ${error.message}`);
        if (error.status === 402 || error.status === 403) break;
      } finally {
        reservation.release();
      }
    }
    allocations.save();
    for (const p of projects) p.credits = creditView(p);
    res.json({
      requested: findings.length,
      started,
      failed,
      skipped: findings.length - eligible.length,
      errors,
      projects: Object.fromEntries(projects.map((p) => [p.projectId, p.credits])),
    });
  }),
);

// ---------------------------------------------------------------------------
// Tracked reports: saved scopes whose progress is followed over time
// ---------------------------------------------------------------------------

const TRACK_REFRESH_MS = 60 * 60 * 1000;
const TRACK_TOUCHED_WINDOW_MS = 30 * 60 * 1000;
const TRACK_TOUCHED_EVERY_MS = 3 * 60 * 1000;
const refreshing = new Map();

/** Every current finding (no filters) for each of a report's projects. */
async function currentFindings(session, projects) {
  const cfg = activeConfig();
  const byProject = new Map();
  await mapWithConcurrency(projects, 3, async ({ projectId, projectName }) => {
    const project = { id: projectId, name: projectName };
    const source = createRiskSource(session.client, cfg);
    if (source.prime) await source.prime([project]);
    const raw = await source.fetchForProject(project);
    byProject.set(projectId, raw.map((r) => normalizeRisk(r, project)));
  });
  return byProject;
}

function progressFor(report, byProject) {
  let detection = null;
  try {
    detection = resolveWindow(report.filters.detection, 'First detection');
  } catch {}
  return computeProgress(report, byProject, detection, (ids, since) => creditLedger.usedSince(ids, since));
}

/** Refresh one report (collapsing concurrent refreshes of the same report). */
function refreshTrackedReport(report, session) {
  if (!refreshing.has(report.id)) {
    refreshing.set(
      report.id,
      currentFindings(session, report.projects)
        .then((byProject) => {
          trackedReports.record(report, progressFor(report, byProject));
          report.lastError = null;
          return report;
        })
        .catch((error) => {
          report.lastError = error.message;
          throw error;
        })
        .finally(() => refreshing.delete(report.id)),
    );
  }
  return refreshing.get(report.id);
}

async function backgroundRefresh() {
  const session = await resolveAutomationSession();
  if (!session) return;
  const now = Date.now();
  for (const [projectId, at] of touchedProjects) if (now - at > TRACK_TOUCHED_WINDOW_MS) touchedProjects.delete(projectId);
  for (const report of trackedReports.list()) {
    const last = report.latest ? Date.parse(report.latest.at) : 0;
    const touched = report.projects.some((p) => touchedProjects.has(p.projectId));
    if (now - last > TRACK_REFRESH_MS || (touched && now - last > TRACK_TOUCHED_EVERY_MS)) {
      await refreshTrackedReport(report, session).catch((error) =>
        console.warn(`[tracked reports] ${report.name}: ${error.message}`),
      );
    }
  }
}
setInterval(() => backgroundRefresh().catch(() => {}), 60 * 1000).unref?.();

app.get('/api/tracked-reports', requireSession, async (req, res) => {
  res.json({
    reports: trackedReports.list().map(reportSummary),
    autoRefresh: Boolean(sessions.get(automationSessionId) ?? sessions.get(bootstrapSessionId) ?? settingsStore.get().automationApiKey),
  });
});

app.post('/api/tracked-reports', requireSession, (req, res) => {
  const { lastScan } = req.session;
  if (!lastScan) return res.status(409).json({ error: 'Fetch the project list first.' });
  const { name, projectIds = null, severities = null, buckets = [], windows = {}, scopeLabel = '' } = req.body ?? {};
  if (!String(name ?? '').trim()) return res.status(400).json({ error: 'Give the report a name.' });

  const wantedSeverities = (Array.isArray(severities) ? severities : []).map((s) => String(s).toUpperCase()).filter((s) => SEVERITIES.includes(s));
  const wantedBuckets = (Array.isArray(buckets) ? buckets : []).map(String).filter((b) => AGE_BUCKETS.some((a) => a.id === b));
  const risks = selectRisks(lastScan.projects, {
    projectIds: projectIds?.length ? projectIds : null,
    buckets: wantedBuckets,
    severities: wantedSeverities.length ? wantedSeverities : null,
  });
  const inScope = lastScan.projects.filter((p) => !p.error && (!projectIds?.length || projectIds.includes(p.projectId)));
  const clean = (w) => ({ preset: String(w?.preset ?? 'any'), from: w?.from ? String(w.from) : undefined, to: w?.to ? String(w.to) : undefined });

  const report = trackedReports.create({
    name,
    scopeLabel: String(scopeLabel).slice(0, 300),
    filters: {
      activity: clean(windows.activity),
      detection: clean(windows.detection),
      severities: wantedSeverities,
      buckets: wantedBuckets,
    },
    projects: inScope.map((p) => ({ projectId: p.projectId, projectName: p.projectName })),
    findings: risks,
  });
  // The first reading comes straight from the data just fetched.
  trackedReports.record(report, progressFor(report, new Map(inScope.map((p) => [p.projectId, p.risks ?? []]))));
  res.status(201).json(reportSummary(report));
});

app.post(
  '/api/tracked-reports/:id/refresh',
  requireSession,
  asyncRoute(async (req, res) => {
    const report = trackedReports.get(req.params.id);
    if (!report) return res.status(404).json({ error: 'No such report.' });
    await refreshTrackedReport(report, req.session);
    res.json(reportSummary(report));
  }),
);

app.delete('/api/tracked-reports/:id', requireSession, (req, res) => {
  if (!trackedReports.delete(req.params.id)) return res.status(404).json({ error: 'No such report.' });
  res.json({ deleted: true });
});

// Administrator view of AI Triage credits used from reports.
app.get('/api/credits', requireSession, (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month ?? '')) ? String(req.query.month) : monthOf();
  const { aiTriage } = settingsStore.get();
  res.json({
    ...creditLedger.summary(month),
    months: [...new Set([monthOf(), ...creditLedger.months()])],
    enabled: Boolean(aiTriage?.enabled),
    remediationEnabled: Boolean(aiTriage?.remediationEnabled),
    monthlyCreditLimit: aiTriage?.monthlyCreditLimit ?? 0,
    remaining: month === monthOf() ? creditsRemaining() : null,
    relayConnected: Boolean(sessions.get(automationSessionId) ?? sessions.get(bootstrapSessionId) ?? settingsStore.get().automationApiKey),
  });
});

/**
 * Build the interactive HTML report for a set of findings. The top findings
 * get the identifiers Checkmarx One AI Triage / Remediation need resolved
 * here, with this session's credentials, so the report itself only ever
 * needs the reader's own API key.
 */
async function buildInteractiveReport(session, risks, { buckets = [], settings, initiator = null, relayUrl = '' } = {}) {
  const { connection, lastScan } = session;
  const initiatorsByProject = lastScan?.initiators ?? {};
  const reportData = buildReportData(risks, {
    buckets,
    tenant: connection.tenant,
    links: settings.links,
    connection,
    branding: settings.branding,
    initiatorsByProject,
    initiator,
  });
  // The table shows the top findings; the "triage all critical / high"
  // actions cover every critical and high finding, so those get ids too.
  const ranked = selectTopFindings(reportData, Infinity);
  const findings = ranked.slice(0, REPORT_TOP_N);
  const bulkFindings = ranked.slice(REPORT_TOP_N).filter((f) => BULK_SEVERITIES.includes(f.severity));
  await resolveAiIds(
    session.client,
    [...findings, ...bulkFindings],
    (finding) => initiatorsByProject[finding.projectId]?.scanId ?? '',
  );
  const html = generateHtmlReport(reportData, {
    findings,
    bulkFindings,
    relayUrl,
    remediationViaRelay: true,
    portalUrl: settings.links.baseUrl,
    sign: (finding) => reportGrants.issue(finding),
    connection: { tenant: connection.tenant, iamUrl: connection.iamUrl, baseUrl: connection.baseUrl },
    branding: settings.branding,
  });
  return { reportData, findings, html };
}

app.post(
  '/api/reports/html',
  requireSession,
  asyncRoute(async (req, res) => {
    const { projectIds = null, buckets = [], severities = null } = req.body ?? {};
    const { lastScan } = req.session;
    const settings = settingsStore.get();

    if (!lastScan) {
      return res.status(409).json({ error: 'Fetch the project list first.' });
    }

    // For HTML reports, get all risks (no bucket filtering) unless specific buckets requested
    const risks = selectRisks(lastScan.projects, {
      projectIds: projectIds?.length ? projectIds : null,
      buckets,
      severities,
    });

    // Provide diagnostic info if no risks found
    const diagnostics = risks.length === 0
      ? `
        <!-- Diagnostic Info -->
        <!-- Projects selected: ${projectIds?.length ?? 0} -->
        <!-- Total risks in session: ${lastScan.projects.reduce((sum, p) => sum + (p.totalRisks ?? 0), 0)} -->
        <!-- Buckets filter: ${buckets.length > 0 ? buckets.join(', ') : 'none (include all)'} -->
        <!-- Severities filter: ${severities?.length > 0 ? severities.join(', ') : 'none (include all)'} -->
        `
      : '';

    const { html } = await buildInteractiveReport(req.session, risks, {
      buckets,
      settings,
      relayUrl: reportServerUrl(req, settings),
    });
    const htmlReport = html + diagnostics;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(htmlReport);
  }),
);

app.post(
  '/api/reminders/send-html-by-initiator',
  requireSession,
  asyncRoute(async (req, res) => {
    const { projectIds = null, buckets = [], severities = null } = req.body ?? {};
    const { lastScan } = req.session;
    const settings = settingsStore.get();

    if (!lastScan) {
      return res.status(409).json({ error: 'Fetch the project list first.' });
    }

    if (!isVerified(settings)) {
      return res.status(400).json({
        error:
          'Test the SMTP connection on the Settings page before sending. ' +
          'Changing any connection detail clears a previous successful test.',
      });
    }

    const risks = selectRisks(lastScan.projects, {
      projectIds: projectIds?.length ? projectIds : null,
      buckets,
      severities,
    });

    if (risks.length === 0) {
      return res.status(400).json({ error: 'No vulnerabilities match that selection.' });
    }

    const initiatorsByProject = lastScan.initiators ?? {};
    const groups = groupRisksByInitiator(risks, initiatorsByProject);

    const sendable = groups.filter((group) => group.email);
    const skipped = groups
      .filter((group) => !group.email)
      .map((group) => ({
        initiator: group.initiator || '(unknown)',
        riskCount: group.risks.length,
      }));

    const sent = [];
    const errors = [];

    for (const group of sendable) {
      try {
        const { reportData, findings, html: htmlReport } = await buildInteractiveReport(req.session, group.risks, {
          buckets,
          settings,
          relayUrl: reportServerUrl(req, settings),
          initiator: group,
        });
        const body = buildReportEmail(reportData, {
          greeting: `Hi ${group.initiator || 'there'}`,
          topCount: findings.length,
        });
        const message = {
          subject: `${group.risks.length} open vulnerabilities to triage`,
          html: body.html,
          text: body.text,
        };

        const result = await sendReminderMail(settings, message, {
          to: [group.email],
          cc: [],
          bcc: [],
          attachments: [
            {
              filename: `vulnerability-report-${new Date().toISOString().split('T')[0]}.html`,
              content: htmlReport,
              contentType: 'text/html',
            },
          ],
        });

        sent.push({
          initiator: group.initiator,
          email: group.email,
          riskCount: group.risks.length,
          projectCount: group.projectIds.size,
          messageId: result.messageId,
        });
      } catch (error) {
        errors.push({
          initiator: group.initiator,
          email: group.email,
          error: error.message,
        });
      }
    }

    res.json({
      delivered: sent.length > 0,
      sent,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
      summary: `Sent HTML reports to ${sent.length} person(s), skipped ${skipped.length}`,
    });
  }),
);

app.post(
  '/api/reminders/with-attachment',
  requireSession,
  asyncRoute(async (req, res) => {
    const { htmlReport, recipients } = req.body ?? {};
    const settings = settingsStore.get();

    if (!htmlReport) {
      return res.status(400).json({ error: 'htmlReport is required.' });
    }

    if (!isVerified(settings)) {
      return res.status(400).json({
        error:
          'Test the SMTP connection on the Settings page before sending. ' +
          'Changing any connection detail clears a previous successful test.',
      });
    }

    // Use provided recipients or fall back to configured recipients
    const to = (recipients?.to?.length ? recipients.to : settings.recipients?.to) || [];
    const cc = (recipients?.cc?.length ? recipients.cc : settings.recipients?.cc) || [];
    const bcc = (recipients?.bcc?.length ? recipients.bcc : settings.recipients?.bcc) || [];

    if (to.length + cc.length + bcc.length === 0) {
      return res.status(400).json({ error: 'No recipients configured.' });
    }

    const message = {
      subject: `Vulnerability Report - Interactive Report Attached`,
      html:
        `<p>Hi,</p>` +
        `<p>Please review the attached interactive vulnerability report. You can triage and remediate findings directly from the HTML file.</p>` +
        `<p><strong>Features:</strong></p>` +
        `<ul><li>Click "Triage" or "Remediate" buttons to update finding status</li>` +
        `<li>Use bulk actions to triage all critical or high-severity findings at once</li>` +
        `<li>Status updates in real-time in the report</li></ul>` +
        `<p>Simply open the attached HTML file in your browser to get started.</p>`,
      text:
        `Hi,\n\nPlease review the attached interactive vulnerability report. ` +
        `You can triage and remediate findings directly from the HTML file.\n\n` +
        `Features:\n` +
        `- Click "Triage" or "Remediate" buttons to update finding status\n` +
        `- Use bulk actions to triage all critical or high-severity findings at once\n` +
        `- Status updates in real-time in the report\n\n` +
        `Simply open the attached HTML file in your browser to get started.`,
    };

    try {
      const result = await sendReminderMail(settings, message, {
        to,
        cc,
        bcc,
        attachments: [
          {
            filename: `vulnerability-report-${new Date().toISOString().split('T')[0]}.html`,
            content: htmlReport,
            contentType: 'text/html',
          },
        ],
      });

      res.json({
        delivered: true,
        messageId: result.messageId,
        recipients: { to, cc, bcc },
        attachment: 'vulnerability-report.html',
        status: 'Email sent with interactive HTML report attached.',
      });
    } catch (error) {
      res.status(error.status || 500).json({ error: error.message });
    }
  }),
);

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
app.use((error, req, res, next) => {
  const status = error.status && error.status >= 400 && error.status < 600 ? error.status : 500;
  console.error(`${req.method} ${req.path} ->`, error.message);
  res.status(status).json({ error: error.message ?? 'Unexpected error.', detail: error.body ?? undefined });
});

/**
 * Retry logic with exponential backoff for authentication and connection tests.
 * Attempts up to 3 times with 2s, 5s delays before marking final failure.
 */
async function retryWithBackoff(label, fn, maxAttempts = 3) {
  const delays = [0, 2000, 5000]; // No delay on first attempt, then 2s, 5s
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) {
        console.log(`[${label}] Retry attempt ${attempt}/${maxAttempts}...`);
        await new Promise((resolve) => setTimeout(resolve, delays[attempt - 1]));
      }
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        console.warn(`[${label}] Attempt ${attempt}/${maxAttempts} failed: ${error.message}`);
      }
    }
  }

  throw lastError;
}

async function bootstrap() {
  if (!config.bootstrapApiKey) return;
  try {
    const result = await retryWithBackoff('CX_API_KEY', () =>
      sessions.create(config.bootstrapApiKey, config.overrides),
    );
    bootstrapSessionId = result.id;
    console.log(`[CX_API_KEY] ✓ Successfully authenticated with Checkmarx One (tenant: ${result.connection.tenant})`);
  } catch (error) {
    console.error(`[CX_API_KEY] ✗ Authentication failed after 3 attempts: ${error.message}`);
    if (error.message.includes('fetch failed') || error.message.includes('ENOTFOUND')) {
      console.error('[CX_API_KEY] This usually means: network connectivity issue, proxy configuration, or DNS resolution failure');
      console.error('[CX_API_KEY] Check: your firewall, proxy settings, and whether the Checkmarx endpoint is reachable');
    } else if (error.message.includes('401') || error.message.includes('Unauthorized') || error.message.includes('invalid_grant')) {
      console.error('[CX_API_KEY] This usually means: the API key is invalid, expired, or has incorrect format');
      console.error('[CX_API_KEY] Verify: CX_API_KEY is correct and has not expired in your Checkmarx account');
    }
    console.warn(`! CX_API_KEY was set but could not be used after retries: ${error.message}`);
  }
}

/**
 * When the SMTP login comes from .env there is nobody to click "Test
 * connection", so run the same handshake once at startup with retries.
 * A pass unlocks sending; a failure is logged and the Settings page still shows the reason.
 */
async function verifyEnvironmentSmtp() {
  const settings = settingsStore.get();
  if (!hasEnvironmentSmtp() || isVerified(settings)) return;
  try {
    const result = await retryWithBackoff('SMTP', () => testConnection(settings.smtp));
    settingsStore.markVerified();
    console.log(`[SMTP] ${result.message} Sending is unlocked.`);
  } catch (error) {
    console.warn(`! [SMTP] Startup connection test failed after 3 attempts: ${error.message}`);
  }
}

const server = app.listen(config.port, config.host, async () => {
  console.log(`Checkmarx detection-date reminder running on http://${config.host}:${config.port}`);
  console.log(`Settings file: ${settingsStore.file}`);
  for (const problem of configProblems(config)) console.warn(`! ${problem}`);
  await bootstrap();
  await verifyEnvironmentSmtp();
  await resolveAutomationSession();
  scheduler.sync();
  const automation = settingsStore.get().automation;
  if (automation.enabled) {
    console.log(
      `Automation on: every ${automation.intervalMinutes}m, thresholds ${automation.thresholds.join('/')} days` +
        (automation.dryRun ? ' (dry run)' : ''),
    );
  }
});

const shutdown = () => {
  scheduler.stop();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { app, sessions, settingsStore };
