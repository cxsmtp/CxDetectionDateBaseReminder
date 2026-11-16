/**
 * FAE Flush (Labs, then Act): Findings Analysis on the backlog, for the whole tenant at once (src/fae-flush.js).
 *
 * The routes under /api/fae-flush (feature:faeFlush; changing anything needs integration.cxone too), each tenant's
 * runner, made the first time it is used, and the tick that moves every tenant's run on.
 */
import { getLastScans, listProjects } from '../cxone/projects.js';
import { featureById } from '../features.js';
import { FaeFlushRunner, NE, cleanOptions, markState, previewTenant, summaryOf, testProject, valueOf } from '../fae-flush.js';
import { SYSTEM_ACTOR } from './shared.js';

/**
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerFaeFlushRoutes(app, d) {
  const {
    tenancy, settingsStore, audit, integrationSession, productActive, asyncRoute, requirePermission, featureLocked,
    requireFeature, cxErrorText,
  } = d;

  // ---- FAE Flush (Labs, then Act): Findings Analysis on the backlog, for the whole tenant at once ----------
  // Runs on the server with its own Checkmarx One connection (the integration key), a few scans at a time; the run
  // is kept on disk and carries on after a restart. Who may: Labs and Labs: FAE Flush on their role (later everyone with the feature's
  // permission), and the Checkmarx One integration permission, since it creates, scans and deletes projects.
  const faeRunners = new WeakMap();
  /** The running tenant's FAE Flush runner. */
  function faeRunner() {
    const tenant = tenancy.current();
    let runner = faeRunners.get(tenant);
    if (!runner) {
      runner = new FaeFlushRunner({
        store: tenant.faeFlush,
        history: tenant.faeHistory,
        clientOf: () => integrationSession()?.client ?? null,
        record: (event, details = {}) => faeAudit(event, details),
      });
      faeRunners.set(tenant, runner);
    }
    return runner;
  }
  const FAE_EVENTS = {
    started: (d) => `FAE Flush started for ${d.projects} project${d.projects === 1 ? '' : 's'}, ${d.concurrency} scan${d.concurrency === 1 ? '' : 's'} at a time${d.mode === 'report' ? ', reporting only (nothing marked)' : ''}; marks them ${d.markAs === 'ne' ? 'Not exploitable' : 'Proposed not exploitable'}; code: ${d.source}; stops to ask: ${d.sensitivity}; the _FAE projects are ${d.deleteFae ? 'deleted' : 'kept'} once checked.`,
    'scan-started': (d) => `FAE Flush: ${d.project}'s code scanned again with Findings Analysis on ${d.faeProject} (scan ${d.scanId}; code from ${d.code}).`,
    'mark-now': (d) => `FAE Flush: ${d.by} marked the report-only run now: ${d.results} results in ${d.projects} project(s).`,
    'debug': (d) => `FAE Flush debug log turned ${d.on ? 'on' : 'off'} by ${d.by}.`,
    'needs-ok': (d) => `FAE Flush stopped at ${d.project} to ask: ${d.reason}`,
    'brought-back': (d) => `FAE Flush: ${d.by || 'someone'} brought back ${d.projects} skipped project${d.projects === 1 ? '' : 's'} (${(d.names ?? []).join(', ')}).`,
    decided: (d) => `FAE Flush: ${d.by || 'someone'} chose "${d.decision}" for ${d.project}${d.reason ? ` (${d.reason})` : ''}.`,
    marked: (d) => `FAE Flush marked ${d.marked} of ${d.project}'s ${d.toVerify} results To verify ${d.state ?? 'Proposed not exploitable'}${d.findings !== undefined && d.findings !== d.marked ? ` (${d.findings} findings: Checkmarx One marks every result sharing one)` : ''}: not reported by the FAE scan ${d.faeScanId}.`,
    'fae-deleted': (d) => `FAE Flush deleted ${d.project}_FAE.`,
    'fae-deleted-all': (d) => `FAE Flush: ${d.deleted} _FAE project${d.deleted === 1 ? '' : 's'} deleted${d.failed ? `, ${d.failed} could not be` : ''}.`,
    finished: (d) => `FAE Flush finished: ${d.marked} of ${d.toVerify} results To verify marked ${d.state ?? 'Proposed not exploitable'} across ${d.projects} projects, ${d.revalidated} revalidated.`,
    undone: (d) => `FAE Flush undone by ${d.by}${d.projects ? ` for ${d.projects} project${d.projects === 1 ? '' : 's'}` : ''}: ${d.restored} results back to To verify${d.changedSince ? ` (${d.changedSince} changed since and left as they are)` : ''}.`,
  };
  function faeAudit(event, details) {
    const actor = details.actor ?? { kind: 'system', user: faeRunner().job?.startedBy || SYSTEM_ACTOR.user };
    const { actor: _drop, ...rest } = details;
    audit.record({ type: 'system', outcome: ['marked', 'undone', 'fae-deleted', 'fae-deleted-all', 'started'].includes(event) ? 'changed' : 'info', reason: FAE_EVENTS[event]?.(rest) ?? `FAE Flush: ${event}.`, actor, details: { faeFlush: { event, job: faeRunner().job?.id ?? '', ...rest } } });
  }
  /** What the page shows: the run (without each result's id) and its figures, and the last preview. */
  function faeView() {
    const runner = faeRunner();
    const store = runner.store;
    const job = runner.job;
    return {
      connected: Boolean(integrationSession()),
      preview: store.preview,
      previewing: Boolean(store.previewing),
      previewError: store.previewError ?? '',
      job: job ? { ...job, projects: job.projects.map(({ marked, pending, ...p }) => ({ ...p, markedCount: p.counts?.marked ?? marked?.length ?? 0 })) } : null,
      summary: job ? summaryOf(job) : null,
      debug: { on: runner.debug.on, entries: runner.debug.log.length },
    };
  }
  const faeGuard = [requireFeature('faeFlush'), requirePermission('integration.cxone')];

  app.get('/api/fae-flush', requireFeature('faeFlush'), (req, res) => res.json(faeView()));

  // Every project as FAE Flush would take it (read only): read in the background, the page asks again.
  app.post('/api/fae-flush/preview', ...faeGuard, (req, res) => {
    const store = faeRunner().store;
    const client = integrationSession()?.client;
    if (!client) return res.status(409).json({ error: 'Connect the server to Checkmarx One first (Settings → Checkmarx One).' });
    if (!store.previewing) {
      store.previewError = '';
      store.previewing = previewTenant(client, { listProjects, getLastScans })
        .then((preview) => (store.preview = preview))
        .catch((error) => (store.previewError = cxErrorText(error)))
        .finally(() => (store.previewing = null));
    }
    res.status(202).json(faeView());
  });

  app.post('/api/fae-flush/start', ...faeGuard, asyncRoute(async (req, res) => {
    const runner = faeRunner();
    if (!integrationSession()) return res.status(409).json({ error: 'Connect the server to Checkmarx One first (Settings → Checkmarx One).' });
    const ids = Array.isArray(req.body?.projectIds) ? new Set(req.body.projectIds.map(String)) : null;
    const preview = runner.store.preview && { ...runner.store.preview, projects: runner.store.preview.projects.filter((p) => !ids || ids.has(p.id)) };
    const options = cleanOptions(req.body ?? {});
    if (options.markAs === 'ne' && !req.permissions.has('faeFlush.notExploitable')) return res.status(403).json({ error: 'Only an Admin can mark them Not exploitable: choose Proposed not exploitable.', permission: 'faeFlush.notExploitable' });
    try {
      runner.start({ by: req.user?.email ?? '', concurrency: req.body?.concurrency, deleteFae: req.body?.deleteFae, preview, options });
    } catch (error) {
      return res.status(error.status ?? 400).json({ error: error.message });
    }
    faeTick();
    res.json(faeView());
  }));

  app.post('/api/fae-flush/pause', ...faeGuard, (req, res) => {
    faeRunner().setState('paused');
    res.json(faeView());
  });
  app.post('/api/fae-flush/resume', ...faeGuard, (req, res) => {
    faeRunner().setState('running');
    faeTick();
    res.json(faeView());
  });

  /** A run that marks Not exploitable is marked on (Mark anyway, Mark now) by Admins alone. */
  const faeMarkRefused = (req) => (markState(faeRunner().job) === NE && !req.permissions.has('faeFlush.notExploitable') ? 'This run marks them Not exploitable: only an Admin can mark them.' : '');
  app.post('/api/fae-flush/decide', ...faeGuard, (req, res) => {
    if (String(req.body?.decision) === 'mark' && faeMarkRefused(req)) return res.status(403).json({ error: faeMarkRefused(req), permission: 'faeFlush.notExploitable' });
    try {
      faeRunner().decide(String(req.body?.projectId ?? ''), String(req.body?.decision ?? ''), req.user?.email ?? '');
    } catch (error) {
      return res.status(error.status ?? 400).json({ error: error.message });
    }
    faeTick();
    res.json(faeView());
  });

  // Several projects that stopped to ask, the same answer: mark anyway, carry on without the settings, retry or skip.
  // Those the answer does not fit are left as they are, and the reply says why.
  app.post('/api/fae-flush/decide-many', ...faeGuard, (req, res) => {
    const decision = String(req.body?.decision ?? '');
    if (!['mark', 'continue', 'retry', 'skip'].includes(decision)) return res.status(400).json({ error: 'Mark, continue, skip or retry.' });
    if (decision === 'mark' && faeMarkRefused(req)) return res.status(403).json({ error: faeMarkRefused(req), permission: 'faeFlush.notExploitable' });
    let result;
    try {
      result = faeRunner().decideMany(Array.isArray(req.body?.projectIds) ? req.body.projectIds : [], decision, req.user?.email ?? '');
    } catch (error) {
      return res.status(error.status ?? 400).json({ error: error.message });
    }
    faeTick();
    res.json({ ...result, ...faeView() });
  });

  // Skipped projects back in the run (all of them, or those named).
  app.post('/api/fae-flush/bring-back', ...faeGuard, (req, res) => {
    try {
      faeRunner().bringBack(Array.isArray(req.body?.projectIds) ? req.body.projectIds : null, req.user?.email ?? '');
    } catch (error) {
      return res.status(error.status ?? 400).json({ error: error.message });
    }
    faeTick();
    res.json(faeView());
  });

  // A report-only run: mark what it reported, now.
  app.post('/api/fae-flush/mark-now', ...faeGuard, (req, res) => {
    if (faeMarkRefused(req)) return res.status(403).json({ error: faeMarkRefused(req), permission: 'faeFlush.notExploitable' });
    try {
      faeRunner().markReported(req.user?.email ?? '', Array.isArray(req.body?.projectIds) ? req.body.projectIds : null);
    } catch (error) {
      return res.status(error.status ?? 400).json({ error: error.message });
    }
    faeTick();
    res.json(faeView());
  });

  // Troubleshoot: one project, every step read-only (nothing made or changed).
  app.post('/api/fae-flush/test', ...faeGuard, asyncRoute(async (req, res) => {
    const client = integrationSession()?.client;
    if (!client) return res.status(409).json({ error: 'Connect the server to Checkmarx One first (Settings → Checkmarx One).' });
    const projectId = String(req.body?.projectId ?? '').slice(0, 80);
    if (!projectId) return res.status(400).json({ error: 'Choose a project.' });
    res.json(await testProject(faeRunner().via(client, { name: `test: ${projectId}`, step: 'test' }), projectId, { getLastScans }));
  }));

  // Troubleshoot: the debug log (every FAE Flush call to Checkmarx One, signatures and the access token hidden).
  app.get('/api/fae-flush/debug', ...faeGuard, (req, res) => {
    const { on, log } = faeRunner().debug;
    res.set('Cache-Control', 'no-store');
    res.json({ on, log });
  });
  app.put('/api/fae-flush/debug', ...faeGuard, (req, res) => {
    const on = req.body?.on === true;
    faeRunner().setDebug(on);
    faeAudit('debug', { on, by: req.user?.email ?? '' });
    res.json({ on, entries: faeRunner().debug.log.length });
  });
  app.delete('/api/fae-flush/debug', ...faeGuard, (req, res) => {
    faeRunner().clearDebug();
    res.json({ on: faeRunner().debug.on, entries: 0 });
  });

  // Value: every false positive FAE Flush marked, kept after its runs, and what that saved (the Impact page's figures).
  app.get('/api/fae-flush/value', requireFeature('faeFlush'), (req, res) => {
    res.json(valueOf(tenancy.current().faeHistory, settingsStore.get().impact ?? {}));
  });

  app.post('/api/fae-flush/undo', ...faeGuard, asyncRoute(async (req, res) => {
    if (!faeRunner().job) return res.status(409).json({ error: 'There is no FAE Flush to undo.' });
    const result = await faeRunner().undo(req.user?.email ?? '', Array.isArray(req.body?.projectIds) ? req.body.projectIds : null);
    res.json({ ...result, ...faeView() });
  }));

  // One click, any day after: every _FAE project of the run still in Checkmarx One.
  app.post('/api/fae-flush/delete-fae', ...faeGuard, asyncRoute(async (req, res) => {
    if (!faeRunner().job) return res.status(409).json({ error: 'There is no FAE Flush with _FAE projects.' });
    const result = await faeRunner().deleteAll(Array.isArray(req.body?.projectIds) ? req.body.projectIds : null, { earlierOnly: req.body?.earlier === true });
    res.json({ ...result, ...faeView() });
  }));

  const FAE_TICK_MS = Number(process.env.FAE_FLUSH_TICK_MS) || 15_000;
  const faeTicking = new WeakSet();
  /** One turn of every tenant's run (or the running tenant's only, from a request). */
  function faeTick(all = false) {
    const turn = () => {
      // Without its activation code (expired or turned off) nothing more is started; it carries on once unlocked again.
      if (featureLocked(featureById('faeFlush'))) return;
      const runner = faeRunner();
      // A finished run too: one with a project put back to work carries on (the runner checks).
      if (!runner.job || !['running', 'done'].includes(runner.job.state) || faeTicking.has(runner)) return;
      faeTicking.add(runner);
      runner.tick().catch((error) => console.warn(`! [fae-flush] ${error.message}`)).finally(() => faeTicking.delete(runner));
    };
    if (all) tenancy.each(turn);
    else turn();
  }
  setInterval(() => productActive() && faeTick(true), FAE_TICK_MS).unref?.();
}
