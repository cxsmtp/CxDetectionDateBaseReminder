import { fileURLToPath } from 'node:url';
import path from 'node:path';

import express from 'express';

import { config, configProblems } from './config.js';
import { CxClient } from './cxone/client.js';
import { listProjects } from './cxone/projects.js';
import { AGE_BUCKETS, collectProjectRisks, selectRisks } from './cxone/risks.js';
import { getFeedbackApp, listFeedbackApps } from './cxone/feedbackApps.js';
import { buildReminder, sendReminder } from './reminder.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const client = new CxClient(config);
const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.static(publicDir));

/**
 * The last scan result, kept in memory so that "send reminder" works from the
 * selection the user is looking at without re-querying Checkmarx One.
 */
let lastScan = null;

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

app.get('/api/health', (req, res) => {
  res.json({
    ok: configProblems(config).length === 0,
    problems: configProblems(config),
    tenant: config.tenant,
    baseUrl: config.baseUrl,
    riskSource: config.risks.source,
    deliveryMode: config.delivery.mode,
    smtpConfigured: Boolean(config.delivery.smtp.host),
    buckets: AGE_BUCKETS.map(({ id, label }) => ({ id, label })),
  });
});

/** Fetch projects + their risks, bucketed by first-detection age. */
app.get(
  '/api/scan',
  asyncRoute(async (req, res) => {
    const problems = configProblems(config);
    if (problems.length > 0) return res.status(400).json({ error: problems.join(' ') });

    const projects = await listProjects(client);
    const result = await collectProjectRisks(client, config, projects);
    lastScan = result;

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
  asyncRoute(async (req, res) => {
    const { path: resolvedPath, apps } = await listFeedbackApps(client, config);
    res.json({
      path: resolvedPath,
      apps: apps.map(({ raw, ...app }) => app),
    });
  }),
);

/** Preview or send a reminder for the selected projects and age buckets. */
app.post(
  '/api/reminders',
  asyncRoute(async (req, res) => {
    const { feedbackAppId, projectIds = null, buckets = [], severities = null, dryRun = false } = req.body ?? {};

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

const server = app.listen(config.port, config.host, () => {
  const problems = configProblems(config);
  console.log(`Checkmarx detection-date reminder running on http://${config.host}:${config.port}`);
  if (config.tenant) console.log(`Tenant: ${config.tenant}  API: ${config.baseUrl}`);
  for (const problem of problems) console.warn(`! ${problem}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { app };
