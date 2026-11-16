/**
 * Settings → Update & recovery (Admin): the routes for software integrity (/api/integrity), for new versions,
 * rollback and restart (/api/system/update), and for the troubleshooting report (/api/system/report).
 *
 * The services themselves (src/integrity/service.js, src/updates/service.js) are made in src/server.js, with the
 * start-up they are part of; the routes are registered in three steps because other areas' routes were always
 * registered in between, and the order is kept (test/fixtures/routes.txt).
 */
import { APP_VERSION } from '../version.js';
import fs from 'node:fs';
import { companionState, requestFullUpdate } from '../updates/companion.js';
import { SYSTEM_ACTOR } from './shared.js';

/**
 * /api/integrity: the running files against the signed file list, and who built it.
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerIntegrityRoutes(app, d) {
  const { asyncRoute, requirePermission, integrity } = d;

  app.get('/api/integrity', requirePermission('system.update'), (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ...(integrity.last ?? { state: 'checking', summary: 'The first check runs a few seconds after start.' }), repository: integrity.repository });
  });

  app.post(
    '/api/integrity/check',
    requirePermission('system.update'),
    asyncRoute(async (req, res) => {
      // At most one fresh check a minute: each asks GitHub once.
      const recent = integrity.last && Date.now() - Date.parse(integrity.last.at) < 60_000;
      const result = recent ? integrity.last : await integrity.check({ reason: `asked by ${req.user?.email ?? 'someone'}` });
      res.json({ ...result, repository: integrity.repository });
    }),
  );
}

/**
 * /api/system/update: new versions, a switch to another one, a restart, the full image update, auto-update.
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerUpdateRoutes(app, d) {
  const { dataDir, audit, asyncRoute, requirePermission, backupToFolder, updates } = d;

  const updateError = (res, error) => res.status(error.status ?? 500).json({ error: error.message });

  const updateStatus = () => ({ ...updates.status(), companion: companionState(dataDir) });

  app.get('/api/system/update', requirePermission('system.update'), (req, res) => res.json(updateStatus()));

  /**
   * Full image update (Beta): ask the update companion to replace this container with the same
   * container on another image tag. A backup is taken first; the companion does the rest
   * (src/companion/main.js) and this server is stopped by it, as for any update.
   */
  app.post(
    '/api/system/update/full',
    requirePermission('system.update'),
    asyncRoute(async (req, res) => {
      const tag = String(req.body?.tag ?? '').trim();
      const by = req.user?.email ?? '';
      try {
        const state = companionState(dataDir);
        if (!state.connected) throw Object.assign(new Error('The update companion is not running: start it (the command is on this page), or update with podman pull.'), { status: 409 });
        if (state.busy) throw Object.assign(new Error('A full image update is already under way.'), { status: 409 });
        await backupToFolder(SYSTEM_ACTOR, `Before replacing the image with ${tag}`);
        const request = requestFullUpdate(dataDir, { tag, by });
        audit.record({ type: 'system', outcome: 'changed', reason: `Full image update to ${tag} asked of the update companion.`, actor: { kind: 'user', user: by }, details: { tag, id: request.id } });
        res.status(202).json(updateStatus());
      } catch (error) {
        updateError(res, error);
      }
    }),
  );

  app.post(
    '/api/system/update/check',
    requirePermission('system.update'),
    asyncRoute(async (req, res) => {
      await updates.check();
      res.json(updateStatus());
    }),
  );

  app.post('/api/system/update/install', requirePermission('system.update'), (req, res) => {
    const ref = String(req.body?.ref ?? '').trim();
    if (!ref) return res.status(400).json({ error: 'Choose a version.' });
    try {
      updates.install(ref, { by: req.user?.email ?? '' });
      res.status(202).json(updateStatus());
    } catch (error) {
      updateError(res, error);
    }
  });

  app.post(
    '/api/system/update/switch',
    requirePermission('system.update'),
    asyncRoute(async (req, res) => {
      try {
        await updates.switch(String(req.body?.version ?? ''), { by: req.user?.email ?? '' });
        res.json(updateStatus());
      } catch (error) {
        updateError(res, error);
      }
    }),
  );

  app.post('/api/system/update/restart', requirePermission('system.update'), (req, res) => {
    try {
      res.json(updates.restart(req.user?.email ?? ''));
    } catch (error) {
      updateError(res, error);
    }
  });

  app.put('/api/system/update/settings', requirePermission('system.update'), (req, res) => {
    const auto = req.body?.auto === true;
    const hour = req.body?.windowHour;
    const windowHour = hour === null || hour === '' || hour === undefined ? null : Number(hour);
    if (windowHour !== null && !(Number.isInteger(windowHour) && windowHour >= 0 && windowHour <= 23)) return res.status(400).json({ error: 'The hour is 0 to 23, or any time.' });
    updates.saveSettings({ auto, windowHour });
    audit.record({ type: 'system', outcome: 'changed', reason: `Auto-update ${auto ? `on${windowHour === null ? '' : `, at ${String(windowHour).padStart(2, '0')}:00`}` : 'off'}.`, actor: { kind: 'user', user: req.user?.email ?? '' }, details: { auto, windowHour } });
    res.json(updateStatus());
  });
}

/**
 * GET /api/system/report.
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerSystemReportRoute(app, d) {
  const {
    dataDir, sessions, tstate, audit, httpsManager, relayStats, requirePermission, cxonePending, smtpPending,
    serverTimeZone, lastBackup, updates,
  } = d;

  /** Everything worth knowing when something is wrong, without secrets: for the Admin, or to send to whoever helps. */
  app.get('/api/system/report', requirePermission('system.update'), (req, res) => {
    const memory = process.memoryUsage();
    const status = updates.status();
    let disk = null;
    try {
      const s = fs.statfsSync(dataDir);
      disk = { freeMB: Math.round((s.bavail * s.bsize) / 1048576), totalMB: Math.round((s.blocks * s.bsize) / 1048576) };
    } catch {}
    const report = {
      generatedAt: new Date().toISOString(),
      version: APP_VERSION,
      image: status.image,
      running: status.running,
      builtIn: status.builtIn,
      supervised: status.supervised,
      installed: status.installed.map(({ version, tag, installedAt }) => ({ version, tag, installedAt })),
      events: status.events,
      node: process.versions.node,
      platform: `${process.platform}/${process.arch}`,
      uptimeSeconds: Math.round(process.uptime()),
      memoryMB: { rss: Math.round(memory.rss / 1048576), heapUsed: Math.round(memory.heapUsed / 1048576) },
      disk,
      https: { mode: httpsManager.mode, selfSigned: httpsManager.selfSigned },
      checkmarxOne: { connected: Boolean(sessions.get(tstate.automationSessionId) ?? sessions.get(tstate.bootstrapSessionId)), pending: cxonePending() },
      smtp: { pending: smtpPending() },
      lastBackup: lastBackup(),
      relay: { ...relayStats },
      timeZone: serverTimeZone(),
    };
    audit.record({ type: 'system', outcome: 'info', reason: 'Troubleshooting report downloaded.', actor: { kind: 'user', user: req.user?.email ?? '' } });
    res.set('Content-Disposition', `attachment; filename="cxmissionzero-report-${report.generatedAt.slice(0, 10)}.json"`);
    res.json(report);
  });
}
