/**
 * Is the server up, and how is it doing: GET /api/health (open to everyone: the container's health check and
 * the sign-in page), GET /app-icon (the organisation's icon, or the built-in one), the troubleshooting download
 * and a page's own script errors (/api/diagnostics, src/diagnostics.js), and GET /api/metrics.
 */
import path from 'node:path';
import { config, configProblems } from '../config.js';
import { APP_VERSION } from '../version.js';
import { AGE_BUCKETS, projectReads } from '../cxone/risks.js';
import { createHash } from 'node:crypto';
import { DEFAULT_TEMPLATE, TEMPLATE_VARIABLES } from '../template.js';
import { AGE_PRESETS, WINDOW_PRESETS } from '../window.js';
import { readSessionCookie } from '../session.js';

/**
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerDiagnosticsRoutes(app, d) {
  const {
    publicDir, dataDirSource, sessions, settingsStore, trackedReports, relayCache, audit, diagnostics, iam,
    integrationSession, resolveAutomationSession, languageAccess, allowedLanguages, RELAY_MAX_IN_FLIGHT, relayStats,
    asyncRoute, requireSession, requirePermission, adminActor,
  } = d;

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  app.get('/api/health', (req, res) => {
    res.json({
      version: APP_VERSION,
      problems: configProblems(config),
      riskSource: config.risks.source,
      buckets: AGE_BUCKETS.map(({ id, label }) => ({ id, label })),
      windowPresets: WINDOW_PRESETS.map(({ id, label }) => ({ id, label })),
      // The Workbench's "Findings open for": by age, beside new in the last week or month.
      agePresets: AGE_PRESETS.map(({ id, label }) => ({ id, label })),
      templateVariables: TEMPLATE_VARIABLES,
      defaultTemplate: DEFAULT_TEMPLATE,
      // The page's languages available here (Hebrew only once activated, and only for the people chosen).
      languages: languageAccess.available(allowedLanguages(sessions.peek(readSessionCookie(req))?.userId)),
      // Shown in the header before anyone connects.
      app: {
        name: settingsStore.get().branding.appName || 'CxMissionZero',
        logoUrl: settingsStore.get().branding.logoUrl || '',
        // Changes when the browser icon does, so the page can reload it.
        iconVersion: iconVersion(),
        // The organisation's look, whether people may pick their own, and where the menu sits.
        // nextGen: false only when everyone has the classic look (as before there were looks to choose).
        look: settingsStore.get().branding.look,
        lookChoice: settingsStore.get().branding.lookChoice !== false,
        nextGen: settingsStore.get().branding.nextGen !== false,
        navPosition: settingsStore.get().branding.navPosition === 'top' ? 'top' : 'left',
      },
    });
  });

  /** A short fingerprint of the browser icon setting ('' for the built-in one). */
  const iconVersion = (url = settingsStore.get().branding?.iconUrl || '') => (url ? createHash('sha256').update(url).digest('hex').slice(0, 10) : '');

  /**
   * The browser tab's icon, for every page (signed in or not): the one set under
   * Settings → Branding, else CxMissionZero's own (public/mz-icon-64.png). An uploaded image is served
   * from here, locked down (an SVG's scripts never run); an https address is redirected to.
   */
  app.get('/app-icon', (req, res) => {
    const url = settingsStore.get().branding?.iconUrl || '';
    res.set({ 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
    const data = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(url);
    if (data) {
      res.set('ETag', `"${iconVersion(url)}"`);
      if (req.get('if-none-match') === `"${iconVersion(url)}"`) return res.status(304).end();
      return res.type(data[1]).send(Buffer.from(data[2], 'base64'));
    }
    if (/^https:\/\//i.test(url)) return res.redirect(302, url);
    res.type('image/png').sendFile(path.join(publicDir, 'mz-icon-64.png'));
  });

  /** Load and cache figures, for whoever operates this server. */
  /**
   * The troubleshooting log, for whoever maintains this server: which features
   * are used, where errors and discrepancies happen, and recommended fixes.
   * Holds no personal data, keys, findings or code (see src/diagnostics.js).
   */
  app.get('/api/diagnostics/download', requirePermission('diagnostics.export'), asyncRoute(async (req, res) => {
    const actor = await adminActor(req);
    const report = diagnostics.report({
      extra: {
        configuration: {
          riskSource: config.risks.source,
          fetchConcurrency: config.concurrency,
          dataDirFrom: dataDirSource,
          cxoneConnected: Boolean(integrationSession()),
          smtpVerified: Boolean(settingsStore.get().verifiedFingerprint),
          users: iam.users().length,
          trackedReports: trackedReports.list?.().length ?? null,
        },
      },
    });
    audit.record({ type: 'audit', outcome: 'changed', reason: 'Troubleshooting log downloaded (no personal data, keys or findings).', actor });
    const name = `mission-zero-troubleshooting-${APP_VERSION}-${new Date().toISOString().slice(0, 10)}.json`;
    res.set('Content-Disposition', `attachment; filename="${name}"`).type('application/json').send(JSON.stringify(report, null, 2));
  }));

  /** Script errors in the page, so bugs in the browser show up in the troubleshooting log too. */
  app.post('/api/diagnostics/client-error', requireSession, (req, res) => {
    const b = req.body ?? {};
    const page = String(b.page ?? '').replace(/[^#/a-z-]/gi, '').slice(0, 40);
    diagnostics.record('client-error', 'page-script-error', {
      message: String(b.message ?? '').slice(0, 500),
      source: String(b.source ?? '').slice(0, 2000).split('/').pop(),
      line: Number(b.line) || 0,
      column: Number(b.column) || 0,
      page,
      detail: String(b.stack ?? '').slice(0, 2000),
    });
    res.status(204).end();
  });

  app.get('/api/metrics', requirePermission('system.metrics'), asyncRoute(async (req, res) => {
    const session = await resolveAutomationSession();
    const memory = process.memoryUsage();
    res.json({
      uptimeSeconds: Math.round(process.uptime()),
      memoryMb: { rss: Math.round(memory.rss / 1e6), heapUsed: Math.round(memory.heapUsed / 1e6) },
      relay: { ...relayStats, maxInFlight: RELAY_MAX_IN_FLIGHT },
      cache: { entries: relayCache.size, hits: relayCache.hits, misses: relayCache.misses },
      projectReads: projectReads.stats,
      checkmarxOne: session?.client?.load ?? null,
    });
  }));
}
