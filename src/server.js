import { fileURLToPath } from 'node:url';
import path from 'node:path';

import express from 'express';

import { config, configProblems } from './config.js';
import { filterProjectsByActivity, listProjects } from './cxone/projects.js';
import { AGE_BUCKETS, collectProjectRisks, createRiskSource, normalizeRisk, selectRisks, summariseProject } from './cxone/risks.js';
import { discover } from './cxone/discovery.js';
import { collectInitiators, groupRisksByInitiator, groupRisksByProject } from './cxone/initiators.js';
import { resolveAiIds, resultRowsFor } from './cxone/ai-assist.js';
import { mapWithConcurrency } from './cxone/client.js';
import { ReportGrants } from './report-grants.js';
import { CREDIT_COST, CreditLedger, monthOf } from './credits.js';
import { CreditAllocations, toRemediateCount, toTriageCount } from './credit-allocations.js';
import { knownAddresses } from './known-addresses.js';
import { TtlCache } from './ttl-cache.js';
import { GitHubClient } from './github/client.js';
import { METHODS as GITHUB_METHODS, ensureClone, evaluate as evaluateGithub, loginFromNoreply, resolveLogins, usableEmail, validLogin } from './github/identity.js';
import { blameFindings, codeVersion, locationOf, parseRepoUrl } from './github/blame.js';
import { TrackedReports, computeProgress, matchesFilters, reportSummary } from './tracked-reports.js';
import { BULK_SEVERITIES, REPORT_TOP_N, generateHtmlReport, selectTopFindings } from './html-report.js';
import { buildReminder, buildReportData, buildReportEmail } from './reminder.js';
import { exampleLinks, projectUrl, riskUrl } from './links.js';
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
knownAddresses.configure(path.join(dataDir, 'known-initiators.json'));
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
    toRemediate: toRemediateCount(summary.risks ?? [], allocations.severitiesOf(summary.projectId), creditLedger.remediatedIds(summary.projectId)),
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
  res.set('Access-Control-Expose-Headers', 'Retry-After');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/**
 * Admission control: past this many relay requests in flight, answer "busy,
 * retry in a few seconds" at once instead of queueing without limit. Reports
 * back off and retry, so a surge degrades into slower updates, not timeouts.
 */
const RELAY_MAX_IN_FLIGHT = Math.max(10, Number(process.env.RELAY_MAX_IN_FLIGHT) || 300);
const relayStats = { inFlight: 0, peak: 0, served: 0, shed: 0 };
app.use('/api/relay', (req, res, next) => {
  if (relayStats.inFlight >= RELAY_MAX_IN_FLIGHT) {
    relayStats.shed += 1;
    const retryAfter = 2 + Math.floor(Math.random() * 4);
    res.set('Retry-After', String(retryAfter));
    return res.status(503).json({ error: 'The reminder server is busy; retrying in a moment.', busy: true, retryAfter });
  }
  relayStats.inFlight += 1;
  relayStats.peak = Math.max(relayStats.peak, relayStats.inFlight);
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    relayStats.inFlight -= 1;
    relayStats.served += 1;
  };
  res.on('finish', done);
  res.on('close', done);
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
    // Shown in the header before anyone connects.
    app: {
      name: settingsStore.get().branding.appName || 'Mission Zero',
      logoUrl: settingsStore.get().branding.logoUrl || '',
    },
  });
});

/** Load and cache figures, for whoever operates this server. */
app.get('/api/metrics', requireSession, async (req, res) => {
  const session = await resolveAutomationSession();
  const memory = process.memoryUsage();
  res.json({
    uptimeSeconds: Math.round(process.uptime()),
    memoryMb: { rss: Math.round(memory.rss / 1e6), heapUsed: Math.round(memory.heapUsed / 1e6) },
    relay: { ...relayStats, maxInFlight: RELAY_MAX_IN_FLIGHT },
    cache: { entries: relayCache.size, hits: relayCache.hits, misses: relayCache.misses },
    checkmarxOne: session?.client?.load ?? null,
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
      memory: knownAddresses,
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

const NOT_EXPLOITABLE_STATES = new Set(['NOT_EXPLOITABLE', 'PROPOSED_NOT_EXPLOITABLE']);

/**
 * Leave out findings triaged as not exploitable (proposed or confirmed), by
 * their live Checkmarx One state — so triage the administrator ran after the
 * last fetch counts too. Only confirmed findings and those still to verify
 * stay in reminders and reports. Can be switched off in Settings.
 */
async function withoutNotExploitable(session, risks) {
  if (settingsStore.get().aiTriage?.skipNotExploitable === false) return risks;
  const live = new Map();
  await mapWithConcurrency([...new Set(risks.map((r) => r.projectId))], 3, async (projectId) => {
    try {
      live.set(projectId, await projectStates(session, projectId));
    } catch (error) {
      console.warn(`[reminders] could not read live states for ${projectId}: ${error.message}`);
    }
  });
  return risks
    .map((r) => {
      const state = live.get(r.projectId)?.get(r.riskId);
      return state && state !== r.state ? { ...r, state } : r;
    })
    .filter((r) => !NOT_EXPLOITABLE_STATES.has(r.state));
}

/**
 * Build and send (or preview, with dryRun) reminders for findings of `scan`
 * — the dashboard's last fetch, or a tracked report's open findings.
 * Resolves {status, body} for the caller to send.
 */
async function runReminder(session, scan, input) {
  const reply = (status, payload) => ({ status, body: payload });
    const {
      projectIds = null,
      buckets = [],
      severities = null,
      initiators: wantedInitiators = null,
      groupBy = 'none',
      alsoConsolidated = false,
      dryRun = false,
      recipients,
    } = input;

    const { connection } = session;
    const lastScan = scan;
    const settings = settingsStore.get();

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

    const risks = await withoutNotExploitable(session, selectRisks(lastScan.projects, {
      projectIds: scopedProjectIds,
      buckets: ageBuckets,
      severities,
    }));
    if (risks.length === 0) {
      return reply(400, { error: 'No vulnerabilities match that selection.' });
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
        return reply(200, {
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
        return reply(400, {
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

      return reply(200, {
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
      return reply(200, {
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
          exact: recipients.exact === true,
          to: parseAddressList(recipients.to ?? []),
          cc: parseAddressList(recipients.cc ?? []),
          bcc: parseAddressList(recipients.bcc ?? []),
        }
      : {};

    const result = await sendReminderMail(settings, reminder, overrides);
    return reply(200, { ...result, groupBy: 'none', totalRisks: risks.length, projects: reminder.projects.length });
  }

app.post(
  '/api/reminders',
  requireSession,
  asyncRoute(async (req, res) => {
    if (!req.session.lastScan) {
      return res.status(409).json({ error: 'Fetch the project list first, then send a reminder.' });
    }
    const { status, body } = await runReminder(req.session, req.session.lastScan, req.body ?? {});
    res.status(status).json(body);
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

/** Where report readers ask for more credits: the configured contact, else the sender address. */
function adminContact(settings = settingsStore.get()) {
  return settings.aiTriage?.adminContact || settings.smtp?.fromAddress || '';
}

const KIND_NAMES = { triage: 'AI Triage', remediation: 'AI Remediation' };

/** Each project's credits, as a report shows them. */
function projectCredits(projectIds) {
  const out = {};
  for (const projectId of new Set(projectIds)) {
    const b = allocations.balance(projectId);
    out[projectId] = { triage: b.triage, remediation: b.remediation };
  }
  return out;
}

/** What a refused request needed, for the report's "ask your administrator" message. */
function creditNeed(projectId, projectName, kind, needed) {
  return { projectId, projectName, kind, needed, left: allocations.balance(projectId)[kind].remaining, adminContact: adminContact() };
}

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
        retriage: Boolean(aiTriage.allowRetriage),
        reremediation: Boolean(aiTriage.allowReremediation),
        adminContact: adminContact(),
        creditsRemaining: creditsRemaining(),
      });
    }
  }),
);

/** Credits available to the projects of a report (one signed finding per project). */
app.post(
  '/api/relay/credits',
  asyncRoute(async (req, res) => {
    const findings = grantedFindings(req, res);
    if (!findings) return;
    res.json({ projects: projectCredits(findings.map((f) => f.projectId)), creditsRemaining: creditsRemaining() });
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

    const { monthlyCreditLimit: limit = 0, allowRetriage = false } = settingsStore.get().aiTriage ?? {};
    const results = [];

    // Findings that already have a verdict are only triaged again when the
    // administrator allows it: every run spends credits.
    if (!allowRetriage) {
      const statesByProject = new Map();
      await mapWithConcurrency([...new Set(findings.map((f) => f.projectId))], 3, async (projectId) => {
        try {
          statesByProject.set(projectId, await projectStates(session, projectId));
        } catch (error) {
          console.warn(`[relay] could not read risk states for project ${projectId}: ${error.message}`);
        }
      });
      for (const [key, group] of buckets) {
        const triaged = group.filter((f) => {
          const states = statesByProject.get(f.projectId);
          const state = states?.get(f.riskId) ?? states?.get(f.alternateId) ?? '';
          return state && state !== 'TO_VERIFY';
        });
        if (!triaged.length) continue;
        results.push({
          alternateIds: [...new Set(triaged.map((f) => f.alternateId))],
          ok: false,
          status: 409,
          retriage: true,
          error: `${triaged.length === 1 ? 'This finding is' : `${triaged.length} findings are`} already triaged. Triaging again is switched off by your administrator.`,
        });
        const rest = group.filter((f) => !triaged.includes(f));
        if (rest.length) buckets.set(key, rest);
        else buckets.delete(key);
      }
    }

    for (const group of buckets.values()) {
      const { scanId, scanner, projectId, projectName } = group[0];
      const alternateIds = [...new Set(group.map((f) => f.alternateId))];

      const refusal = creditRefusal(projectId, projectName, 'triage', alternateIds.length, limit);
      if (refusal) {
        results.push({ alternateIds, ok: false, status: 402, error: refusal, credits: creditNeed(projectId, projectName, 'triage', alternateIds.length) });
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
        if (published) {
          const riskIds = [...new Set(group.map((f) => f.riskId))];
          const covered = await coveredCount(session, projectId, 'triage', riskIds);
          creditLedger.record({ projectId, projectName, credits: alternateIds.length, scanId, kind: 'triage', riskIds, covered: Math.min(covered, alternateIds.length) });
        }
        actedOn('triage', group);
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
    res.json({ results, creditsRemaining: creditsRemaining(), projects: projectCredits(findings.map((f) => f.projectId)) });
  }),
);

/**
 * Current Checkmarx One state (To verify, Confirmed, Proposed not
 * exploitable, ...) of every risk in a project, by risk id — the same state
 * Risk Hub shows. AI Triage's own record can lag it (still "To verify" after
 * the risk has settled) or be missing for a finding it changed, so the
 * report shows this. Cached briefly because every report poll asks.
 */
const STATE_CACHE_MS = 30_000;
/**
 * Answers from Checkmarx One shared by every report: risk states per project,
 * AI Triage records and AI Remediation details per finding. Concurrent asks
 * for the same thing share one upstream call.
 */
const relayCache = new TtlCache({ max: 100_000 });
const stateCache = { delete: (projectId) => relayCache.delete(`risks|${projectId}`) };
// Findings sent for triage or remediation recently: their answers change soon, so look again sooner.
const recentActions = new TtlCache({ max: 100_000 });
const ACTION_WATCH_MS = 45 * 60 * 1000;

async function projectRiskInfo(session, projectId) {
  return relayCache.wrap(`risks|${projectId}`, () => loadRiskInfo(session, projectId), STATE_CACHE_MS);
}

async function loadRiskInfo(session, projectId) {
  const cfg = activeConfig();
  const project = { id: projectId, name: '' };
  const source = createRiskSource(session.client, cfg);
  if (source.prime) await source.prime([project]);
  const states = new Map();
  const info = new Map();
  const risks = [];
  for (const raw of await source.fetchForProject(project)) {
    const risk = normalizeRisk(raw, project);
    risks.push(risk);
    info.set(risk.riskId, { severity: risk.severity, state: risk.state });
    if (risk.state) {
      states.set(risk.riskId, risk.state);
      if (risk.alternateId) states.set(risk.alternateId, risk.state);
    }
  }
  return { at: Date.now(), states, info, risks };
}

const SETTLED_TTL = 10 * 60_000;
const WATCHED_TTL = 8_000;
const QUIET_TTL = 5 * 60_000;

/** How to load a finding's AI Triage record ({found, body}) and how long to keep it. */
function triageLookup(session, finding, { background = false } = {}) {
  const key = `triage|${finding.projectId}|${finding.groupId}`;
  const load = async () => {
    try {
      const body = await session.client.request(
        `/api/ai-triage/triage/${encodeURIComponent(finding.projectId)}/${encodeURIComponent(finding.groupId)}`,
        { retries: 1, background },
      );
      return { found: true, body };
    } catch (error) {
      if (error.status === 404) return { found: false };
      throw error;
    }
  };
  // Settled verdicts rarely change; ones being worked on are looked at again soon.
  const ttl = (answer) => {
    const status = answer.body?.triageStatus || answer.body?.jobStatus || '';
    if (answer.found && status && !['IN_PROGRESS', 'TO_VERIFY', 'PENDING', 'QUEUED', 'RUNNING'].includes(status)) return SETTLED_TTL;
    return recentActions.get(key) !== undefined || answer.found ? WATCHED_TTL : QUIET_TTL;
  };
  return { key, load, ttl };
}

/** How to load a finding's AI Remediation details (or null) and how long to keep them. */
function remediationLookup(session, finding, { background = false } = {}) {
  const key = `remed|${finding.scanId}|${finding.alternateId}`;
  const load = async () => {
    try {
      return await session.client.request(
        `/api/remediation/remediation-details/${encodeURIComponent(finding.scanId)}/${encodeURIComponent(finding.alternateId)}`,
        { retries: 1, background },
      );
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  };
  const ttl = (body) => {
    const r = body?.results?.[0];
    if (r && (r.finishedAt || r.data?.summary || String(r.jobStatus || '').toUpperCase() === 'FAILED')) return SETTLED_TTL;
    return recentActions.get(key) !== undefined || r ? WATCHED_TTL : QUIET_TTL;
  };
  return { key, load, ttl };
}

/**
 * Background lookups queue behind interactive ones; past this many waiting,
 * new ones are skipped (the report asks again and they are picked up then).
 */
const BACKGROUND_QUEUE_MAX = Math.max(100, Number(process.env.RELAY_BACKGROUND_QUEUE) || 2000);
const backgroundRoom = (session) => (session.client.load?.waitingBackground ?? 0) < BACKGROUND_QUEUE_MAX;

function remediationDetails(session, finding) {
  const { key, load, ttl } = remediationLookup(session, finding);
  return relayCache.wrap(key, load, ttl);
}

/** Forget cached answers for findings just acted on, and watch them closely for a while. */
function actedOn(kind, findings) {
  for (const f of findings) {
    const key = kind === 'triage' ? `triage|${f.projectId}|${f.groupId}` : `remed|${f.scanId}|${f.alternateId}`;
    relayCache.delete(key);
    recentActions.set(key, true, ACTION_WATCH_MS);
    stateCache.delete(f.projectId);
  }
}

/** Current Checkmarx One state of every risk in a project, by risk id (and alternate id). */
async function projectStates(session, projectId) {
  return (await projectRiskInfo(session, projectId)).states;
}

/** How many of these findings the project's rule covered, read from their live severity and state. */
async function coveredCount(session, projectId, kind, riskIds) {
  try {
    const { info } = await projectRiskInfo(session, projectId);
    return allocations.covered(projectId, kind, riskIds, info);
  } catch {
    return riskIds.length;
  }
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

    // Answer from what is known now; anything not known yet is fetched in the
    // background and marked pending, so the report asks again shortly. No
    // request ever waits on thousands of upstream lookups.
    const results = findings.map((finding) => {
      const states = statesByProject.get(finding.projectId);
      const state = states?.get(finding.riskId) ?? states?.get(finding.alternateId) ?? '';
      const { key, load, ttl } = triageLookup(session, finding, { background: true });
      const known = relayCache.peek(key, backgroundRoom(session) ? load : null, ttl);
      if (!known) return { found: false, state, pending: true };
      return { ...known.value, state, ...(known.fresh ? {} : { stale: true }) };
    });
    res.json({ results });
  }),
);

/**
 * Where AI Remediation stands for a finding in Checkmarx One:
 * 'none', 'running', 'done' or 'failed' (with the details, when there are any).
 * A finding remediated through this utility counts as done even when
 * Checkmarx One no longer returns its details.
 */
async function remediationState(session, finding) {
  // Asked right before spending credits: look now, at interactive priority,
  // rather than wait on a background refresh that may be queued for it.
  const { key, load, ttl } = remediationLookup(session, finding);
  const body = await load();
  relayCache.set(key, body, ttl(body));
  return remediationStatusOf(finding, body);
}

/** 'none', 'running', 'done' or 'failed', from remediation details (or null). */
function remediationStatusOf(finding, body) {
  const r = body?.results?.[0];
  if (r) {
    const job = String(r.jobStatus || r.status || '').toUpperCase();
    if (job === 'FAILED' || r.data?.error) return { status: 'failed', body };
    if (r.finishedAt || r.data?.summary || r.data?.file_changes?.length) return { status: 'done', body };
    return { status: 'running', body };
  }
  return { status: creditLedger.remediatedIds(finding.projectId).has(finding.riskId) ? 'done' : 'none', body: null };
}

/** Which of these findings are already remediated (or being remediated), for the report. */
app.post(
  '/api/relay/remediation-status',
  asyncRoute(async (req, res) => {
    const findings = grantedFindings(req, res);
    if (!findings) return;
    const session = await relaySession(res);
    if (!session) return;
    // As with triage results: answer from what is known, fill the rest in the background.
    const results = findings.map((finding) => {
      const { key, load, ttl } = remediationLookup(session, finding, { background: true });
      const known = relayCache.peek(key, backgroundRoom(session) ? load : null, ttl);
      if (!known) {
        return creditLedger.remediatedIds(finding.projectId).has(finding.riskId)
          ? { status: 'done', body: null }
          : { status: 'unknown', pending: true };
      }
      return { ...remediationStatusOf(finding, known.value), ...(known.fresh ? {} : { stale: true }) };
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
    const { monthlyCreditLimit: limit = 0, allowReremediation = false } = settingsStore.get().aiTriage ?? {};
    const cost = CREDIT_COST.remediation;

    // A finding already remediated is only remediated again when the
    // administrator allows it: every run spends credits and may open another pull request.
    let current = { status: 'none', body: null };
    try {
      current = await remediationState(session, finding);
    } catch (error) {
      console.warn(`[relay] could not read the remediation state of ${finding.riskId}: ${error.message}`);
    }
    if (current.status === 'running') {
      return res.status(409).json({ running: true, body: current.body, error: 'AI Remediation is already running for this finding.' });
    }
    if (current.status === 'done' && !allowReremediation) {
      return res.status(409).json({
        remediated: true,
        body: current.body,
        error: 'This finding is already remediated. Remediating again is switched off by your administrator.',
      });
    }
    const refusal = creditRefusal(finding.projectId, finding.projectName, 'remediation', cost, limit);
    if (refusal) {
      return res.status(402).json({
        error: refusal,
        credits: creditNeed(finding.projectId, finding.projectName, 'remediation', cost),
        creditsRemaining: creditsRemaining(),
        projects: projectCredits([finding.projectId]),
      });
    }
    const reservation = creditLedger.reserve(cost, limit, new Date(), {
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
        const covered = (await coveredCount(session, finding.projectId, 'remediation', [finding.riskId])) ? cost : 0;
        creditLedger.record({
          projectId: finding.projectId,
          projectName: finding.projectName,
          credits: cost,
          scanId: finding.scanId,
          kind: 'remediation',
          riskIds: [finding.riskId],
          covered,
        });
      }
      actedOn('remediation', [finding]);
      touchProject(finding.projectId);
      reservation.release();
      res.json({
        ok: true,
        published,
        existingState: body?.existingState ?? null,
        creditsRemaining: creditsRemaining(),
        projects: projectCredits([finding.projectId]),
      });
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
      const body = await remediationDetails(session, finding);
      res.json(body ? { found: true, body } : { found: false });
    } catch (error) {
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
  const { projectIds, ruleChanges, triageAdd = 0, remediationAdd = 0, clearExtras = false, setExtra = null } = req.body ?? {};
  // Each change adds or removes one severity from every project's own rule,
  // so severities the administrator did not touch stay as each project had them.
  const changes = (Array.isArray(ruleChanges) ? ruleChanges : [])
    .map((c) => ({ severity: String(c?.severity ?? '').toUpperCase(), include: c?.include === true }))
    .filter((c) => SEVERITIES.includes(c.severity));
  const extraTriage = Math.max(0, Math.floor(Number(triageAdd) || 0));
  const extraRemediation = Math.max(0, Math.floor(Number(remediationAdd) || 0));
  // Exact extras for one project at a time (the per-project editor).
  const exact = setExtra && typeof setExtra === 'object' ? setExtra : null;
  if (!changes.length && !extraTriage && !extraRemediation && clearExtras !== true && !exact) {
    return res.status(400).json({ error: 'Choose severities, or enter credits to add.' });
  }
  if (exact && (!Array.isArray(projectIds) || projectIds.length !== 1)) {
    return res.status(400).json({ error: 'Set exact extra credits for one project at a time.' });
  }

  const projects = scanProjects(req, projectIds);
  for (const p of exact ? projects : []) {
    for (const kind of ['triage', 'remediation']) {
      if (kind in exact) allocations.setExtra(p.projectId, p.projectName, kind, exact[kind]);
    }
  }
  for (const p of projects) {
    if (clearExtras === true) allocations.clearExtras(p.projectId);
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
 * Run AI Triage for `findings` on the administrator's behalf: one request per
 * scan and scanner. Credits count against each project's allocation, which
 * is raised to cover the request, since the administrator is the one allocating.
 */
async function adminTriage(session, findings, initiatorsByProject = {}) {
  await resolveAiIds(session.client, findings, (f) => initiatorsByProject[f.projectId]?.scanId ?? '');
  const eligible = findings.filter((f) => !f.aiUnavailable);

  const buckets = new Map();
  for (const f of eligible) {
    const key = `${f.scanId}|${f.scanner}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(f);
  }

  const limit = settingsStore.get().aiTriage?.monthlyCreditLimit ?? 0;
  let failed = 0;
  const errors = [];
  const startedFindings = [];
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
      const body = await session.client.request('/api/ai-triage/triage', {
        method: 'POST',
        body: { scanID: scanId, buckets: [{ scannerType: scanner.toLowerCase(), resultIDs: alternateIds }] },
        retries: 1,
      });
      if (body?.published !== false) {
        const balance = allocations.balance(projectId).triage;
        if (balance.remaining < alternateIds.length) allocations.raise(projectId, alternateIds.length - balance.remaining);
        // The administrator's own triage never uses up the developers' extras.
        creditLedger.record({ projectId, projectName, credits: alternateIds.length, scanId, kind: 'triage', covered: alternateIds.length });
      }
      actedOn('triage', group);
      touchProject(projectId);
      startedFindings.push(...group);
    } catch (error) {
      failed += group.length;
      errors.push(`${projectName}: ${error.message}`);
      if (error.status === 402 || error.status === 403) break;
    } finally {
      reservation.release();
    }
  }
  allocations.save();
  return {
    requested: findings.length,
    started: startedFindings.length,
    failed,
    skipped: findings.length - eligible.length,
    errors,
    startedFindings,
  };
}

/**
 * Re-read the live state of the fetched projects' findings (verdicts arrive
 * minutes after a triage run) and recalculate their allocations, so the
 * dashboard's credit columns follow without another full fetch.
 */
app.post(
  '/api/credits/refresh',
  requireSession,
  asyncRoute(async (req, res) => {
    if (!req.session.lastScan) return res.status(409).json({ error: 'Fetch the project list first.' });
    const projects = scanProjects(req, req.body?.projectIds);
    let changed = false;
    await mapWithConcurrency(projects, 3, async (p) => {
      stateCache.delete(p.projectId);
      let live;
      try {
        live = await projectRiskInfo(req.session, p.projectId);
      } catch (error) {
        console.warn(`[credits] could not re-read ${p.projectName}: ${error.message}`);
        return;
      }
      for (const r of p.risks ?? []) {
        const now = live.info.get(r.riskId);
        if (now?.state && now.state !== r.state) r.state = now.state;
      }
      changed = allocations.applyRule(p.projectId, p.projectName, p.risks ?? []) || changed;
    });
    if (changed) allocations.save();
    for (const p of projects) p.credits = creditView(p);
    res.json({ projects: Object.fromEntries(projects.map((p) => [p.projectId, p.credits])) });
  }),
);

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

    const outcome = await adminTriage(req.session, findings, req.session.lastScan.initiators ?? {});
    for (const f of outcome.startedFindings) originals.get(f).triageRequestedAt = Date.now();
    for (const p of projects) p.credits = creditView(p);
    const { startedFindings, ...summary } = outcome;
    res.json({ ...summary, projects: Object.fromEntries(projects.map((p) => [p.projectId, p.credits])) });
  }),
);

// ---------------------------------------------------------------------------
// Tracked reports: saved scopes whose progress is followed over time
// ---------------------------------------------------------------------------

const TRACK_REFRESH_MS = 60 * 60 * 1000;
const TRACK_TOUCHED_WINDOW_MS = 30 * 60 * 1000;
const TRACK_TOUCHED_EVERY_MS = 3 * 60 * 1000;
const refreshing = new Map();

/** Recalculate projects' credit allocations from findings just read. */
function reallocate(projects, byProject) {
  let changed = false;
  for (const { projectId, projectName } of projects) {
    if (byProject.has(projectId)) changed = allocations.applyRule(projectId, projectName, byProject.get(projectId)) || changed;
  }
  if (changed) allocations.save();
}

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
          reallocate(report.projects, byProject);
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
setInterval(() => {
  backgroundRefresh().catch(() => {});
  resolveAutomationSession()
    .then((session) => session && runDueTrackedReminders(session))
    .catch((error) => console.warn(`[tracked reminders] ${error.message}`));
}, 60 * 1000).unref?.();

// ---- Follow-up reminders, schedules and triage for a tracked report -------

const DAY_MS = 86_400_000;
const MAX_REMINDERS_KEPT = 50;

/**
 * A tracked report's open findings, fetched fresh: baseline findings not yet
 * resolved or triaged as not exploitable, plus new findings its filters match.
 * Shaped like a dashboard fetch so the reminder senders can use it directly.
 */
async function openScanFor(session, report) {
  const byProject = await currentFindings(session, report.projects);
  trackedReports.record(report, progressFor(report, byProject));
  reallocate(report.projects, byProject);
  let detection = null;
  try {
    detection = resolveWindow(report.filters.detection, 'First detection');
  } catch {}
  const baselineKeys = new Set(report.baseline.findings.map((f) => `${f.projectId}|${f.riskId}`));
  const settings = settingsStore.get();
  const projects = report.projects.map(({ projectId, projectName }) => {
    const risks = (byProject.get(projectId) ?? []).filter(
      (r) =>
        !NOT_EXPLOITABLE_STATES.has(r.state) &&
        (baselineKeys.has(`${projectId}|${r.riskId}`) || matchesFilters(r, report.filters, detection)),
    );
    const summary = summariseProject({ id: projectId, name: projectName }, risks);
    summary.url = projectUrl(summary, session.connection, settings.links);
    return summary;
  });
  // Looked up fresh: a rescan moves a reminder to whoever ran it.
  const initiators = await collectInitiators(
    session.client,
    session.connection,
    report.projects.map((p) => ({ id: p.projectId, name: p.projectName })),
    { rules: settings.initiators, useDirectory: settings.initiators.useDirectory, concurrency: config.concurrency, memory: knownAddresses },
  );
  return { projects, initiators: initiators.byProject };
}

const countSent = (body) => (Array.isArray(body?.sent) ? body.sent.length : body?.messageId ? 1 : 0);

/** Send (or preview) a follow-up reminder for a report's open findings. */
async function remindTrackedReport(session, report, options, relayUrl, { automatic = false } = {}) {
  const sendTo = ['initiator', 'list', 'both'].includes(options.sendTo) ? options.sendTo : 'initiator';
  const emailContent = options.emailContent === 'per-project' ? 'per-project' : 'summary';
  const attachHtml = options.attachHtml === true;
  const dryRun = options.dryRun === true;
  // "Send only to": these addresses and nobody else, one summary email.
  const onlyTo = parseAddressList(options.onlyTo ?? []);

  const scan = await openScanFor(session, report);
  const open = scan.projects.reduce((n, p) => n + p.risks.length, 0);
  if (!open) return { status: 400, body: { error: 'Nothing is left open in this report, so no reminder is needed.' } };

  const result = onlyTo.length
    ? await sendReportOnlyTo(session, report, scan, onlyTo, { attachHtml, dryRun, relayUrl })
    : attachHtml && !dryRun
      ? await runHtmlReminder(session, scan, {}, relayUrl)
      : await runReminder(session, scan, {
          groupBy: sendTo === 'list' ? 'none' : emailContent === 'per-project' ? 'project' : 'initiator',
          alsoConsolidated: sendTo === 'both',
          dryRun,
        });

  if (!dryRun) {
    report.reminders = [
      {
        at: new Date().toISOString(),
        automatic,
        sendTo: onlyTo.length ? 'only' : sendTo,
        onlyTo,
        emailContent,
        attachHtml,
        openFindings: open,
        sent: result.status === 200 ? countSent(result.body) : 0,
        error: result.status === 200 ? '' : result.body?.error || 'Failed',
      },
      ...(report.reminders ?? []),
    ].slice(0, MAX_REMINDERS_KEPT);
    trackedReports.save();
  }
  return result;
}

/** Every open finding of a tracked report, as one list. */
const openRisksOf = (scan) => selectRisks(scan.projects, { projectIds: null, buckets: [], severities: null });

/** The interactive HTML report of a tracked report's open findings. */
async function trackedReportHtml(session, report, scan, relayUrl) {
  return buildInteractiveReport(session, openRisksOf(scan), {
    settings: settingsStore.get(),
    relayUrl,
    initiatorsByProject: scan.initiators,
  });
}

/** One summary email of a tracked report's open findings to exactly these addresses. */
async function sendReportOnlyTo(session, report, scan, addresses, { attachHtml, dryRun, relayUrl }) {
  const settings = settingsStore.get();
  if (!attachHtml) {
    const result = await runReminder(session, scan, { groupBy: 'none', dryRun, recipients: { to: addresses, exact: true } });
    if (dryRun && result.status === 200) result.body.recipients = { to: addresses, cc: [], bcc: [] };
    return result;
  }
  const { reportData, findings, html } = await trackedReportHtml(session, report, scan, relayUrl);
  const body = buildReportEmail(reportData, { greeting: 'Hi', topCount: findings.length });
  const total = reportData.totalRisks ?? openRisksOf(scan).length;
  const message = { subject: `${report.name}: ${total} open vulnerabilities to triage`, html: body.html, text: body.text };
  if (dryRun) {
    return { status: 200, body: { dryRun: true, groupBy: 'none', subject: message.subject, html: message.html, recipients: { to: addresses, cc: [], bcc: [] }, canSend: isVerified(settings) } };
  }
  const result = await sendReminderMail(settings, message, {
    exact: true,
    to: addresses,
    attachments: [{ filename: reportFileName(report), content: html, contentType: 'text/html' }],
  });
  return { status: 200, body: { ...result, groupBy: 'none', sent: [{ email: addresses.join(', '), messageId: result.messageId }] } };
}

const reportFileName = (report) =>
  `${String(report.name).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'report'}-${new Date().toISOString().slice(0, 10)}.html`;

/** The next time at `hour`, in this machine's time zone, that is at least `from`. */
function nextRunAt(hour, from = new Date()) {
  const next = new Date(from);
  next.setHours(hour, 0, 0, 0);
  if (next < from) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

/** This machine's time zone, which schedules run in. */
function serverTimeZone() {
  const name = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  const offset = -new Date().getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const mm = String(Math.abs(offset) % 60).padStart(2, '0');
  return { name, offset: `UTC${sign}${hh}:${mm}` };
}

async function runDueTrackedReminders(session) {
  const settings = settingsStore.get();
  const now = Date.now();
  for (const report of trackedReports.list()) {
    const auto = report.automation;
    if (!auto?.enabled || !auto.nextRunAt || Date.parse(auto.nextRunAt) > now) continue;
    // Move the schedule on first, so a failing send is not retried every minute.
    const next = new Date(auto.nextRunAt);
    while (next.getTime() <= now) next.setDate(next.getDate() + auto.everyDays);
    if (Number.isInteger(auto.hour)) next.setHours(auto.hour, 0, 0, 0);
    auto.nextRunAt = next.toISOString();
    trackedReports.save();
    if (!isVerified(settings)) {
      auto.lastError = 'SMTP has not passed a connection test, so nothing was sent.';
      trackedReports.save();
      continue;
    }
    try {
      const result = await remindTrackedReport(session, report, auto, settings.links.reportServerUrl, { automatic: true });
      auto.lastError = result.status === 200 ? '' : result.body?.error || 'Failed';
    } catch (error) {
      auto.lastError = error.message;
    }
    auto.lastRunAt = new Date().toISOString();
    trackedReports.save();
  }
}

app.post(
  '/api/tracked-reports/:id/remind',
  requireSession,
  asyncRoute(async (req, res) => {
    const report = trackedReports.get(req.params.id);
    if (!report) return res.status(404).json({ error: 'No such report.' });
    const settings = settingsStore.get();
    if (req.body?.dryRun !== true && !isVerified(settings)) {
      return res.status(400).json({ error: 'Test the SMTP connection on the Settings page before sending.' });
    }
    const { status, body } = await remindTrackedReport(req.session, report, req.body ?? {}, reportServerUrl(req, settings));
    res.status(status).json({ ...body, report: trackedView(report) });
  }),
);

app.put('/api/tracked-reports/:id/automation', requireSession, (req, res) => {
  const report = trackedReports.get(req.params.id);
  if (!report) return res.status(404).json({ error: 'No such report.' });
  const input = req.body ?? {};
  const everyDays = Math.min(90, Math.max(1, Math.floor(Number(input.everyDays) || 7)));
  const hour = Math.min(23, Math.max(0, Math.floor(Number(input.hour) || 0)));
  const enabled = input.enabled === true;
  report.automation = {
    enabled,
    everyDays,
    hour,
    sendTo: ['initiator', 'list', 'both'].includes(input.sendTo) ? input.sendTo : 'initiator',
    emailContent: input.emailContent === 'per-project' ? 'per-project' : 'summary',
    attachHtml: input.attachHtml === true,
    onlyTo: parseAddressList(input.onlyTo ?? []),
    nextRunAt: enabled ? nextRunAt(hour) : null,
    lastRunAt: report.automation?.lastRunAt ?? null,
    lastError: '',
  };
  trackedReports.save();
  res.json(trackedView(report));
});

/** Download the interactive HTML report a follow-up reminder would attach. */
app.get(
  '/api/tracked-reports/:id/html',
  requireSession,
  asyncRoute(async (req, res) => {
    const report = trackedReports.get(req.params.id);
    if (!report) return res.status(404).json({ error: 'No such report.' });
    const scan = await openScanFor(req.session, report);
    if (!openRisksOf(scan).length) return res.status(400).json({ error: 'Nothing is left open in this report.' });
    const { html } = await trackedReportHtml(req.session, report, scan, reportServerUrl(req, settingsStore.get()));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${reportFileName(report)}"`);
    res.send(html);
  }),
);

/**
 * Allocate credits to a tracked report's projects, so their developers can
 * triage from their own reports: the severities join each project's triage
 * rule, and any extra credits are added on top.
 */
app.post(
  '/api/tracked-reports/:id/allocate',
  requireSession,
  asyncRoute(async (req, res) => {
    const report = trackedReports.get(req.params.id);
    if (!report) return res.status(404).json({ error: 'No such report.' });
    const wanted = cleanSeverities(req.body?.severities);
    const extraTriage = Math.max(0, Math.floor(Number(req.body?.triageAdd) || 0));
    const extraRemediation = Math.max(0, Math.floor(Number(req.body?.remediationAdd) || 0));
    if (!wanted.length && !extraTriage && !extraRemediation) {
      return res.status(400).json({ error: 'Pick severities, or enter credits to add.' });
    }
    const byProject = await currentFindings(req.session, report.projects);
    trackedReports.record(report, progressFor(report, byProject));
    for (const { projectId, projectName } of report.projects) {
      if (extraTriage) allocations.add(projectId, projectName, 'triage', extraTriage);
      if (extraRemediation) allocations.add(projectId, projectName, 'remediation', extraRemediation);
      const rule = wanted.length ? SEVERITIES.filter((s) => wanted.includes(s) || allocations.severitiesOf(projectId).includes(s)) : undefined;
      allocations.applyRule(projectId, projectName, byProject.get(projectId) ?? [], rule);
    }
    allocations.save();
    res.json({ report: trackedView(report) });
  }),
);

app.post(
  '/api/tracked-reports/:id/triage',
  requireSession,
  asyncRoute(async (req, res) => {
    const report = trackedReports.get(req.params.id);
    if (!report) return res.status(404).json({ error: 'No such report.' });
    const wanted = cleanSeverities(req.body?.severities);
    if (!wanted.length) return res.status(400).json({ error: 'Pick at least one severity to triage.' });
    const scan = await openScanFor(req.session, report);
    const findings = scan.projects.flatMap((p) =>
      p.risks
        .filter((r) => wanted.includes(r.severity) && (!r.state || r.state === 'TO_VERIFY'))
        .map((r) => ({ ...r, projectId: p.projectId, projectName: p.projectName })),
    );
    if (!findings.length) return res.json({ requested: 0, started: 0, failed: 0, skipped: 0, errors: [], report: trackedView(report) });
    const { startedFindings, ...summary } = await adminTriage(req.session, findings, scan.initiators);
    res.json({ ...summary, report: trackedView(report) });
  }),
);

/** A report for listing, with its projects' credit balance summed. */
function trackedView(report) {
  const credits = { triage: { allocated: 0, used: 0, remaining: 0 }, remediation: { allocated: 0, used: 0, remaining: 0 } };
  for (const { projectId } of report.projects) {
    const balance = allocations.balance(projectId);
    for (const kind of ['triage', 'remediation']) {
      for (const key of ['allocated', 'used', 'remaining']) credits[kind][key] += balance[kind][key];
    }
  }
  return { ...reportSummary(report), credits };
}

app.get('/api/tracked-reports', requireSession, async (req, res) => {
  res.json({
    timeZone: serverTimeZone(),
    reports: trackedReports.list().map(trackedView),
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
  res.status(201).json(trackedView(report));
});

app.post(
  '/api/tracked-reports/:id/refresh',
  requireSession,
  asyncRoute(async (req, res) => {
    const report = trackedReports.get(req.params.id);
    if (!report) return res.status(404).json({ error: 'No such report.' });
    await refreshTrackedReport(report, req.session);
    res.json(trackedView(report));
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
    allocations: allocations.list(),
    relayConnected: Boolean(sessions.get(automationSessionId) ?? sessions.get(bootstrapSessionId) ?? settingsStore.get().automationApiKey),
  });
});

/**
 * Build the interactive HTML report for a set of findings. The top findings
 * get the identifiers Checkmarx One AI Triage / Remediation need resolved
 * here, with this session's credentials, so the report itself only ever
 * needs the reader's own API key.
 */
async function buildInteractiveReport(session, risks, { buckets = [], settings, initiator = null, relayUrl = '', initiatorsByProject } = {}) {
  const { connection, lastScan } = session;
  initiatorsByProject ??= lastScan?.initiators ?? {};
  // Whatever built the list, findings triaged as not exploitable stay out.
  risks = await withoutNotExploitable(session, risks);
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
    allowRetriage: Boolean(settings.aiTriage?.allowRetriage),
    allowReremediation: Boolean(settings.aiTriage?.allowReremediation),
    adminContact: adminContact(settings),
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

/** Send each scan initiator an email with the interactive HTML report attached. */
async function runHtmlReminder(session, scan, input, relayUrl) {
  const reply = (status, payload) => ({ status, body: payload });
    const { projectIds = null, buckets = [], severities = null } = input;
    const lastScan = scan;
    const settings = settingsStore.get();


    if (!isVerified(settings)) {
      return reply(400, {
        error:
          'Test the SMTP connection on the Settings page before sending. ' +
          'Changing any connection detail clears a previous successful test.',
      });
    }

    const risks = await withoutNotExploitable(session, selectRisks(lastScan.projects, {
      projectIds: projectIds?.length ? projectIds : null,
      buckets,
      severities,
    }));

    if (risks.length === 0) {
      return reply(400, { error: 'No vulnerabilities match that selection.' });
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
        const { reportData, findings, html: htmlReport } = await buildInteractiveReport(session, group.risks, {
          buckets,
          settings,
          relayUrl,
          initiatorsByProject,
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

    return reply(200, {
      delivered: sent.length > 0,
      sent,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
      summary: `Sent HTML reports to ${sent.length} person(s), skipped ${skipped.length}`,
    });
  }

app.post(
  '/api/reminders/send-html-by-initiator',
  requireSession,
  asyncRoute(async (req, res) => {
    if (!req.session.lastScan) return res.status(409).json({ error: 'Fetch the project list first.' });
    const settings = settingsStore.get();
    const { status, body } = await runHtmlReminder(req.session, req.session.lastScan, req.body ?? {}, reportServerUrl(req, settings));
    res.status(status).json(body);
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

// ---------------------------------------------------------------------------
// Beta: GitHub identity matching, and emailing the authors of vulnerable code
// ---------------------------------------------------------------------------

const gitCacheDir = path.join(dataDir, 'git-cache');

function githubClient(settings = settingsStore.get()) {
  const github = settings.beta?.github ?? {};
  return new GitHubClient({ token: github.token, apiUrl: github.apiUrl });
}

/** Usernames worth matching: scan initiators that are not already addresses. */
function initiatorLogins(lastScan) {
  const logins = new Set();
  for (const info of Object.values(lastScan?.initiators ?? {})) {
    const name = String(info?.initiator ?? '').trim();
    if (name && !name.includes('@') && validLogin(name)) logins.add(name);
  }
  return [...logins];
}

app.get('/api/beta/github/logins', requireSession, (req, res) => {
  const lastScan = req.session.lastScan;
  const unresolved = new Set(
    Object.values(lastScan?.initiators ?? {})
      .filter((info) => info?.initiator && !info.email)
      .map((info) => info.initiator),
  );
  res.json({ logins: initiatorLogins(lastScan).map((login) => ({ login, unresolved: unresolved.has(login) })) });
});

/** Run the identity methods side by side on real logins and compare them. */
app.post(
  '/api/beta/github/evaluate',
  requireSession,
  asyncRoute(async (req, res) => {
    const settings = settingsStore.get();
    const github = settings.beta?.github ?? {};
    const body = req.body ?? {};
    const logins = (Array.isArray(body.logins) && body.logins.length ? body.logins : initiatorLogins(req.session.lastScan))
      .map((l) => String(l).trim())
      .filter(validLogin)
      .slice(0, 500);
    if (!logins.length) return res.status(400).json({ error: 'No GitHub usernames to match. Fetch projects first, or enter usernames.' });
    const methods = (Array.isArray(body.methods) ? body.methods : GITHUB_METHODS).filter((m) => GITHUB_METHODS.includes(m));
    const report = await evaluateGithub(githubClient(settings), logins, {
      methods,
      org: github.org,
      repos: github.repos ?? [],
      localSources: github.localRepos ?? [],
      cacheDir: gitCacheDir,
    });
    res.json(report);
  }),
);

/** Save chosen matches as initiator overrides (username = email), used from the next fetch. */
app.post('/api/beta/github/apply', requireSession, (req, res) => {
  const mappings = (Array.isArray(req.body?.mappings) ? req.body.mappings : [])
    .map((m) => ({ login: String(m?.login ?? '').trim(), email: String(m?.email ?? '').trim().toLowerCase() }))
    .filter((m) => validLogin(m.login) && usableEmail(m.email));
  if (!mappings.length) return res.status(400).json({ error: 'Pick at least one match to use.' });
  const current = settingsStore.get().initiators;
  const overrides = { ...(current.overrides ?? {}) };
  for (const { login, email } of mappings) overrides[login] = email;
  const saved = settingsStore.save({ initiators: { ...current, overrides } });
  res.json({ applied: mappings.length, overrides: Object.keys(saved.initiators.overrides ?? {}).length });
});

const AUTHOR_LIMIT_MAX = 300;

/**
 * Find who wrote the vulnerable code of the fetched findings: exact file and
 * line from the scan results, blame at the scanned commit, and the author's
 * real address (noreply addresses resolved through the identity methods).
 */
app.post(
  '/api/beta/authors/find',
  requireSession,
  asyncRoute(async (req, res) => {
    const { lastScan, client, connection } = req.session;
    if (!lastScan) return res.status(409).json({ error: 'Fetch the project list first.' });
    const settings = settingsStore.get();
    const github = settings.beta?.github ?? {};
    const { projectIds = null, severities = null } = req.body ?? {};
    const limit = Math.min(AUTHOR_LIMIT_MAX, Math.max(1, Number(req.body?.limit) || 50));

    const rank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    const risks = selectRisks(lastScan.projects, {
      projectIds: projectIds?.length ? projectIds : null,
      buckets: [],
      severities: severities?.length ? severities : null,
    })
      .filter((r) => !NOT_EXPLOITABLE_STATES.has(r.state))
      .sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || (b.ageDays ?? 0) - (a.ageDays ?? 0))
      .slice(0, limit)
      .map((r) => ({ ...r }));
    if (!risks.length) return res.status(400).json({ error: 'No findings match that selection.' });

    const projects = new Map(lastScan.projects.map((p) => [p.projectId, p]));
    const scanIdOf = (f) => f.scanId || lastScan.initiators?.[f.projectId]?.scanId || '';
    const locatable = risks.filter((r) => r.scanner === 'SAST' || r.scanner === 'KICS' || r.scanner === 'IAC');
    const rows = await resultRowsFor(client, locatable, scanIdOf);

    const scans = new Map();
    await mapWithConcurrency([...new Set(locatable.map(scanIdOf).filter(Boolean))], 4, async (scanId) => {
      try {
        scans.set(scanId, await client.request(`/api/scans/${encodeURIComponent(scanId)}`, { retries: 1 }));
      } catch {
        scans.set(scanId, null);
      }
    });

    const items = risks.map((finding) => {
      const project = projects.get(finding.projectId) ?? {};
      const item = {
        finding,
        url: riskUrl(finding, connection, settings.links, scanIdOf(finding)),
      };
      if (!locatable.includes(finding)) {
        item.problem = finding.scanner === 'SCA' ? 'Open-source package: no line of your code to blame.' : `${finding.scanner} findings have no code line.`;
        return item;
      }
      const row = rows.get(finding);
      item.location = row ? locationOf(row) : null;
      if (!item.location?.path || !item.location.line) {
        item.problem = 'Checkmarx One gave no file and line for this finding.';
        return item;
      }
      item.version = codeVersion(scans.get(scanIdOf(finding)), project);
      item.repo = parseRepoUrl(item.version.repoUrl);
      if (!item.repo) item.problem = 'No repository is linked to this project in Checkmarx One (scan uploaded without a repository URL).';
      return item;
    });

    const gh = githubClient(settings);
    await blameFindings(items, {
      gh,
      apiUrl: github.apiUrl,
      cacheDir: gitCacheDir,
      token: github.token,
      useGithub: settings.beta?.authors?.useGithubBlame !== false,
      useLocal: settings.beta?.authors?.useLocalBlame !== false,
    });

    // Authors who hid their address behind GitHub's noreply one: resolve the
    // login, starting with the history of the repositories just cloned.
    const logins = new Set();
    for (const item of items) {
      if (!item.blame) continue;
      const login = item.blame.login || loginFromNoreply(item.blame.authorEmail);
      if (login && !usableEmail(item.blame.authorEmail)) logins.add(login);
    }
    let resolved = {};
    if (logins.size) {
      const clones = [];
      for (const url of new Set(items.filter((i) => i.repo).map((i) => i.repo.cloneUrl))) {
        try {
          clones.push((await ensureClone(url, { cacheDir: gitCacheDir, blobs: true })).dir);
        } catch {}
      }
      resolved = await resolveLogins(gh, [...logins], {
        org: github.org,
        repos: github.repos ?? [],
        localSources: [...clones, ...(github.localRepos ?? [])],
        cacheDir: gitCacheDir,
      });
    }

    const result = items.map((item) => {
      const f = item.finding;
      const out = {
        key: `${f.projectId}|${f.riskId}`,
        projectId: f.projectId,
        projectName: f.projectName,
        title: f.title,
        severity: f.severity,
        scanner: f.scanner,
        ageDays: f.ageDays,
        url: item.url,
        location: item.location ?? null,
        problem: item.problem ?? '',
      };
      if (item.blame) {
        const login = item.blame.login || loginFromNoreply(item.blame.authorEmail);
        const email = usableEmail(item.blame.authorEmail) ? item.blame.authorEmail : resolved[login]?.email ?? '';
        Object.assign(out, {
          commit: item.blame.commit,
          commitUrl: item.blame.url || (item.repo?.host === 'github.com' ? `https://github.com/${item.repo.owner}/${item.repo.repo}/commit/${item.blame.commit}` : ''),
          committedAt: item.blame.date,
          via: item.blame.via,
          ref: item.blame.ref,
          author: {
            name: item.blame.authorName,
            login,
            email,
            emailVia: usableEmail(item.blame.authorEmail) ? 'commit' : resolved[login] ? resolved[login].method : '',
          },
        });
        if (!email) out.problem = `Author ${item.blame.authorName || login} hides their email address and it could not be resolved.`;
      }
      return out;
    });

    req.session.lastAuthors = result;
    const withEmail = result.filter((r) => r.author?.email);
    res.json({
      items: result,
      summary: {
        findings: result.length,
        blamed: result.filter((r) => r.commit).length,
        withEmail: withEmail.length,
        authors: new Set(withEmail.map((r) => r.author.email)).size,
        githubRequests: gh.totalRequests,
      },
    });
  }),
);

/** Email each code author the vulnerable code they wrote (or preview it). */
app.post(
  '/api/beta/authors/notify',
  requireSession,
  asyncRoute(async (req, res) => {
    const items = req.session.lastAuthors;
    if (!items?.length) return res.status(409).json({ error: 'Find the code authors first.' });
    const settings = settingsStore.get();
    const dryRun = req.body?.dryRun === true;
    if (!dryRun && !isVerified(settings)) return res.status(400).json({ error: 'Test the SMTP connection on the Settings page before sending.' });
    const chosen = Array.isArray(req.body?.keys) && req.body.keys.length ? new Set(req.body.keys) : null;

    const byAuthor = new Map();
    for (const item of items) {
      if (!item.author?.email || (chosen && !chosen.has(item.key))) continue;
      if (!byAuthor.has(item.author.email)) byAuthor.set(item.author.email, { author: item.author, items: [] });
      byAuthor.get(item.author.email).items.push(item);
    }
    if (!byAuthor.size) return res.status(400).json({ error: 'None of the chosen findings has an author with an email address.' });

    const messages = [...byAuthor.values()].map(({ author, items: list }) => authorMessage(author, list, settings));
    if (dryRun) {
      return res.json({ dryRun: true, recipients: messages.map((m) => ({ to: m.to, findings: m.count })), subject: messages[0].subject, html: messages[0].html });
    }
    const sent = [];
    const failed = [];
    for (const message of messages) {
      try {
        const result = await sendReminderMail(settings, message, { exact: true, to: [message.to] });
        sent.push({ to: message.to, findings: message.count, messageId: result.messageId });
      } catch (error) {
        failed.push({ to: message.to, error: error.message });
      }
    }
    res.json({ sent, failed });
  }),
);

const escapeHtmlText = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** One author's email: the vulnerable code they wrote, with links to the finding and the commit. */
function authorMessage(author, items, settings) {
  const brand = settings.branding?.companyName || settings.branding?.appName || 'Application security';
  const accent = /^#[0-9a-f]{6}$/i.test(settings.branding?.accentColor ?? '') ? settings.branding.accentColor : '#4f46e5';
  const rows = items
    .map((i) => {
      const where = i.location ? `${i.location.path}:${i.location.line}` : '';
      const commit = i.commit ? i.commit.slice(0, 8) : '';
      return `<tr>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb"><strong>${escapeHtmlText(i.severity)}</strong></td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb">${i.url ? `<a href="${escapeHtmlText(i.url)}" style="color:${accent}">${escapeHtmlText(i.title)}</a>` : escapeHtmlText(i.title)}<br><span style="color:#6b7280;font-size:12px">${escapeHtmlText(i.projectName)}</span></td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;font-family:monospace;font-size:12px">${escapeHtmlText(where)}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;font-family:monospace;font-size:12px">${i.commitUrl ? `<a href="${escapeHtmlText(i.commitUrl)}" style="color:${accent}">${escapeHtmlText(commit)}</a>` : escapeHtmlText(commit)}<br><span style="color:#6b7280">${escapeHtmlText((i.committedAt || '').slice(0, 10))}</span></td>
      </tr>`;
    })
    .join('');
  const name = author.name || author.login || 'there';
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827;max-width:760px">
    <p style="font-size:13px;color:#6b7280;margin:0 0 4px">${escapeHtmlText(brand)}</p>
    <h2 style="margin:0 0 12px;font-size:18px">Code you wrote has ${items.length} open vulnerabilit${items.length === 1 ? 'y' : 'ies'}</h2>
    <p>Hi ${escapeHtmlText(name)},</p>
    <p>Checkmarx One found the issues below on lines you last changed. You know this code best — please take a look, fix what is real, and mark what is not exploitable in Checkmarx One.</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      <thead><tr style="text-align:left;color:#6b7280;font-size:12px"><th style="padding:8px">Severity</th><th style="padding:8px">Finding</th><th style="padding:8px">Where</th><th style="padding:8px">Your commit</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#6b7280;font-size:12px;margin-top:16px">You received this because git history shows you last changed these lines. If that is wrong, reply and let us know.</p>
  </div>`;
  const text = `Hi ${name},\n\nCheckmarx One found ${items.length} issue(s) on lines you last changed:\n\n${items
    .map((i) => `- [${i.severity}] ${i.title} — ${i.location ? `${i.location.path}:${i.location.line}` : ''} (commit ${String(i.commit || '').slice(0, 8)})${i.url ? `\n  ${i.url}` : ''}`)
    .join('\n')}\n`;
  return { to: author.email, count: items.length, subject: `${items.length} vulnerabilit${items.length === 1 ? 'y' : 'ies'} in code you wrote`, html, text };
}

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
  console.log(`Mission Zero running on http://${config.host}:${config.port}`);
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
  knownAddresses.flush();
  creditLedger.flush();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { app, sessions, settingsStore };
