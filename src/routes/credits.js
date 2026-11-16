/**
 * Credits on the dashboard: what the Workbench and the Credits pages do with AI Triage and AI Remediation credits
 * (src/credits.js, src/credit-allocations.js). The rules every spend follows, and the audit entry of each
 * decision, are in src/routes/credit-rules.js.
 *
 * Registered in three steps, because tracked reports' and other areas' routes were always registered in between
 * and the order is kept (test/fixtures/routes.txt):
 * - registerCreditRunRoutes: verifying what findings need, allocating, and the triage and remediation runs;
 * - registerCreditRoutes: the Credits page (the pool, taking credits back, giving them, a run across projects);
 * - registerCreditUsageRoute: GET /api/credits/usage, the usage chart.
 */
import { resolveRange, usageSeries } from '../credit-usage.js';

/**
 * GET /api/credits/usage.
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerCreditUsageRoute(app, d) {
  const { creditLedger, allocations, requirePermission, creditPool } = d;

  /** Credits used over a period, for the Credits page: by day / week / month, by kind and by project. */
  app.get('/api/credits/usage', requirePermission('credits.view'), (req, res) => {
    const range = resolveRange({ from: req.query.from, to: req.query.to, bucket: req.query.bucket });
    const projectId = String(req.query.projectId ?? '').slice(0, 200);
    const end = new Date(Date.parse(`${range.to}T00:00:00.000Z`) + 24 * 60 * 60 * 1000).toISOString();
    const usage = usageSeries(creditLedger.entriesBetween(`${range.from}T00:00:00.000Z`, end), { ...range, projectId });
    const list = allocations.list();
    res.json({
      ...usage,
      days: range.days,
      projectId,
      pool: creditPool(undefined, list),
      allocations: projectId ? list.filter((p) => p.projectId === projectId) : list,
      projects: list.map((p) => ({ projectId: p.projectId, projectName: p.projectName })),
    });
  });
}
