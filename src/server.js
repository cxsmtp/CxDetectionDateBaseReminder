import { fileURLToPath } from 'node:url';
import path from 'node:path';

import express from 'express';

import { config, configProblems } from './config.js';
import { listProjects } from './cxone/projects.js';
import { AGE_BUCKETS, collectProjectRisks, selectRisks } from './cxone/risks.js';
import { getFeedbackApp, listFeedbackApps } from './cxone/feedbackApps.js';
import { buildReminder, sendReminder } from './reminder.js';
import {
  SessionStore,
  clearSessionCookie,
  describeSession,
  readSessionCookie,
  setSessionCookie,
} from './session.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const sessions = new SessionStore({ idleMs: config.session.idleMs });
let bootstrapSessionId = null;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(publicDir));

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

/** Resolve the caller's session, falling back to the optional bootstrap one. */
function currentSession(req) {
  return sessions.get(readSessionCookie(req)) ?? sessions.get(bootstrapSessionId);
}

/** Gate for every route that talks to Checkmarx One. */
function requireSession(req, res, next) {
  const session = currentSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Not connected. Enter your Checkmarx One API key to continue.' });
  }
  req.session = session;
  next();
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({
    problems: configProblems(config),
    riskSource: config.risks.source,
    deliveryMode: config.delivery.mode,
    smtpConfigured: Boolean(config.delivery.smtp.host),
    buckets: AGE_BUCKETS.map(({ id, label }) => ({ id, label })),
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
    const overrides = {
      baseUrl: baseUrl || config.overrides.baseUrl,
      iamUrl: iamUrl || config.overrides.iamUrl,
      tenant: tenant || config.overrides.tenant,
    };

    const session = await sessions.create(apiKey, overrides);
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
// Data
// ---------------------------------------------------------------------------

/** Fetch projects + their risks, bucketed by first-detection age. */
app.get(
  '/api/scan',
  requireSession,
  asyncRoute(async (req, res) => {
    const { client } = req.session;
    const projects = await listProjects(client);
    const result = await collectProjectRisks(client, config, projects);
    req.session.lastScan = result;

    res.json({
      ...result,
      totals: result.projects.reduce(
        (acc, summary) => {
          acc.projects += 1;
          acc.risks += summary.totalRisks;
          for (const [bucket, count] of Object.entries(summary.counts)) {
            acc.counts[bucket] = (acc.counts[bucket] ?? 0) + count;
          }
          return acc;
        },
        { projects: 0, risks: 0, counts: {} },
      ),
    });
  }),
);

app.get(
  '/api/feedback-apps',
  requireSession,
  asyncRoute(async (req, res) => {
    const { path: resolvedPath, apps } = await listFeedbackApps(req.session.client, config);
    res.json({ path: resolvedPath, apps: apps.map(({ raw, ...app }) => app) });
  }),
);

/** Preview or send a reminder for the selected projects and age buckets. */
app.post(
  '/api/reminders',
  requireSession,
  asyncRoute(async (req, res) => {
    const { feedbackAppId, projectIds = null, buckets = [], severities = null, dryRun = false } = req.body ?? {};
    const { client, lastScan } = req.session;

    if (!lastScan) {
      return res.status(409).json({ error: 'Fetch the project list first, then send a reminder.' });
    }
    if (!Array.isArray(buckets) || buckets.length === 0) {
      return res.status(400).json({ error: 'Select at least one age bucket (30 / 60 / 60+ days).' });
    }
    if (!dryRun && !feedbackAppId) {
      return res.status(400).json({ error: 'Select the feedback app that holds the recipient list.' });
    }

    const risks = selectRisks(lastScan.projects, { projectIds, buckets, severities });
    if (risks.length === 0) {
      return res.status(400).json({ error: 'No vulnerabilities match that selection.' });
    }

    const reminder = buildReminder(risks, { buckets });

    if (dryRun) {
      return res.json({
        dryRun: true,
        subject: reminder.subject,
        html: reminder.html,
        text: reminder.text,
        totalRisks: reminder.totalRisks,
        projects: reminder.groups.length,
        recipients: feedbackAppId ? (await getFeedbackApp(client, config, feedbackAppId)).recipients : [],
      });
    }

    const feedbackApp = await getFeedbackApp(client, config, feedbackAppId);
    const result = await sendReminder({ client, config, app: feedbackApp, reminder, buckets });

    res.json({ ...result, totalRisks: reminder.totalRisks, projects: reminder.groups.length });
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
    console.log(`Bootstrapped from CX_API_KEY: tenant ${session.connection.tenant} (${session.connection.regionLabel})`);
  } catch (error) {
    console.warn(`! CX_API_KEY was set but could not be used: ${error.message}`);
  }
}

const server = app.listen(config.port, config.host, async () => {
  console.log(`Checkmarx detection-date reminder running on http://${config.host}:${config.port}`);
  console.log('Open it in a browser and paste your Checkmarx One API key to connect.');
  for (const problem of configProblems(config)) console.warn(`! ${problem}`);
  await bootstrap();
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { app, sessions };
