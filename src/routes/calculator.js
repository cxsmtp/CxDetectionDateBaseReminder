/**
 * The Cx Credits Calculator (src/projections.js, public/calculator/): customers, each with a triage and
 * remediation projection and a Fusion projection, and the reports made from them. Needs the calculator's
 * activation code and the projections.use permission.
 *
 * The routes under /api/projections: the saved customers, the standalone calculator and the report runtime as
 * files, the reports (kept, emailed, deleted), the read of a tenant's own figures from Checkmarx One and its
 * series, counting code in git repositories (src/fusion-git.js), and the Fusion read; and
 * PUT /api/organisation-name. Its larger body limit is middleware, in src/server.js.
 */
import { PACKAGE_VERSION } from '../version.js';
import { branchScopeOf } from '../cxone/branches.js';
import { DEFAULT_ENGINES, cleanEngines } from '../engines.js';
import { randomUUID } from 'node:crypto';
import { SCM_LABELS, SCM_PROVIDERS } from '../scm/providers.js';
import { readFusionOffer, readJobView, readProgressOf, readTenant, seriesFor } from '../projections.js';
import { buildCalculatorLauncher, buildStandaloneCalculator, projectionFileProblem, reportRuntime } from '../standalone-calculator.js';
import { CLOC_FUSION, GIT_COUNT_LIMITS, clocFusionPage, connectionSource, createGitCounter, gitSource, listOrganizations, listRepositories, sweepLeftovers } from '../fusion-git.js';
import { sendReminderMail } from '../mailer.js';
import { isVerified } from '../settings.js';
import { cleanName } from '../terms.js';
import { MAX_PROJECTS, cleanOrigins, readLimit } from '../../public/calculator/model.js';
import { reportFileName as projectionFileName } from '../../public/calculator/report.js';
import { clientIp, escapeHtml } from './shared.js';

/**
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerCalculatorRoutes(app, d) {
  const {
    MAINTAINER_EMAIL, tenancy, settingsStore, projections, projectionReports, projectionReads, audit, terms,
    integrationSession, asyncRoute, requirePermission, adminActor, cloneHostAllowed, gitSets, sendingSettings,
  } = d;

  // ---------------------------------------------------------------------------
  // Cx Credits Calculator (src/projections.js, public/calculator/): customers, each with a triage &
  // remediation projection and a Fusion projection, and the reports made from them. Needs the
  // Cx Credits Calculator permission (Admins have it; an Admin ticks it for other roles).
  // ---------------------------------------------------------------------------

  const projectionError = (res, error) => res.status(error.status ?? 500).json({ error: error.status ? error.message : 'The projection could not be saved.' });
  /** The calculator: its permission. */
  const requireCalculator = requirePermission('projections.use');
  const calculatorRoute = (fn) => (req, res) => {
    try {
      fn(req, res);
    } catch (error) {
      projectionError(res, error);
    }
  };

  app.get('/api/projections', requireCalculator, (req, res) => {
    // A new customer's impact starts from the organisation's own Settings → Impact (minutes, rate, price, currency).
    const { triageMinutes, fixMinutes, hourlyRate, creditPrice, currency } = settingsStore.get().impact ?? {};
    res.json({ customers: projections.list(), organisationName: terms.organisationName(), impactDefaults: { triageMinutes, fixMinutes, hourlyRate, creditPrice, currency } });
  });
  app.post('/api/projections', requireCalculator, calculatorRoute((req, res) => {
    const customer = projections.create({ name: req.body?.name, by: req.user.email, impact: settingsStore.get().impact ?? {} });
    audit.record({ type: 'settings', outcome: 'changed', reason: `Cx Credits Calculator: customer "${customer.name}" added.`, actor: { kind: 'user', user: req.user.email, ip: clientIp(req) } });
    res.status(201).json({ customer });
  }));
  /**
   * The calculator on its own: one HTML file, blank, that runs in any browser with no server and works from
   * the two Checkmarx One exports (src/standalone-calculator.js). Its projection and reports are this page's.
   */
  app.get('/api/projections/standalone', requireCalculator, (req, res) => {
    // ?kind=launcher: the same calculator with its launcher (cx-credits-calculator.mjs, run with Node.js), which reads
    // Checkmarx One with an API key typed into it, on its own, as this page does (src/calculator-launcher.js).
    const launcher = req.query.kind === 'launcher';
    res.set('Content-Type', launcher ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="cx-credits-calculator.${launcher ? 'mjs' : 'html'}"`);
    res.set('Cache-Control', 'no-store');
    res.send(launcher ? buildCalculatorLauncher({ version: PACKAGE_VERSION }) : buildStandaloneCalculator({ version: PACKAGE_VERSION }));
  });
  /** The script a report carries for its levers (public/calculator/report-live.js, bundled), its CSP hash and the report's phrases. */
  app.get('/api/projections/report-runtime', requireCalculator, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(reportRuntime());
  });
  /** Reports made from the calculator, newest first (one customer's with ?customer=). */
  app.get('/api/projections/reports', requireCalculator, (req, res) => {
    res.json({ reports: projectionReports.list(String(req.query.customer ?? '')) });
  });
  app.post('/api/projections/reports', requireCalculator, calculatorRoute((req, res) => {
    const customer = projections.get(String(req.body?.customerId ?? ''));
    const report = projectionReports.add({ customerId: customer.id, customer: customer.name, by: req.user.email, data: req.body?.data });
    audit.record({ type: 'settings', outcome: 'changed', reason: `Cx Credits Calculator: projection report made for "${customer.name}" (${Math.round(report.totalCredits).toLocaleString('en')} credits).`, actor: { kind: 'user', user: req.user.email, ip: clientIp(req) } });
    res.status(201).json({ report });
  }));
  app.get('/api/projections/reports/:id', requireCalculator, calculatorRoute((req, res) => {
    res.json({ report: projectionReports.get(String(req.params.id)) });
  }));
  /**
   * Email a projection report: the file the page made (in its language) goes as an attachment, to
   * up to 10 addresses typed in. Only a whole report file, with no script in it, is sent; the
   * maintainer's address never is (the server writes to nobody outside on its own).
   */
  const MAIL_RE = /^(?=[^]{3,254}$)[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
  app.post('/api/projections/reports/:id/email', requireCalculator, asyncRoute(async (req, res) => {
    let report;
    try {
      report = projectionReports.get(String(req.params.id));
    } catch (error) {
      return projectionError(res, error);
    }
    const typed = Array.isArray(req.body?.to) ? req.body.to : String(req.body?.to ?? '').split(/[\s,;]+/);
    const to = [...new Set(typed.map((a) => String(a ?? '').trim().toLowerCase()).filter(Boolean))];
    if (!to.length) return res.status(400).json({ error: 'Type at least one email address.' });
    if (to.length > 10) return res.status(400).json({ error: 'At most 10 addresses at a time.' });
    const bad = to.filter((a) => !MAIL_RE.test(a));
    if (bad.length) return res.status(400).json({ error: `Not an email address: ${bad.slice(0, 3).join(', ')}.` });
    if (to.includes(MAINTAINER_EMAIL.toLowerCase())) return res.status(400).json({ error: 'That address cannot be sent to from here.' });
    const html = String(req.body?.html ?? '');
    if (!/^<!doctype html>/i.test(html) || Buffer.byteLength(html) > 3.5 * 1024 * 1024 || projectionFileProblem(html)) {
      return res.status(400).json({ error: 'That is not a projection report file.' });
    }
    const settings = sendingSettings();
    if (!isVerified(settings)) return res.status(409).json({ error: 'The email server is not set up and tested yet (Settings → Email server).' });
    const plain = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
    const subject = plain(req.body?.subject, 200) || `${report.customer}: Checkmarx credits projection`;
    const lines = (Array.isArray(req.body?.lines) ? req.body.lines : []).slice(0, 8).map((l) => plain(l, 300)).filter(Boolean);
    const text = [...lines, '', `${report.createdBy} · ${new Date(report.createdAt).toUTCString()}`].join('\n');
    const htmlBody = `<div style="font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#14171c">${lines.map((l) => `<p style="margin:0 0 8px">${escapeHtml(l)}</p>`).join('')}<p style="margin:16px 0 0;color:#5c636e;font-size:12px">${escapeHtml(report.createdBy)} · ${escapeHtml(new Date(report.createdAt).toUTCString())}</p></div>`;
    try {
      await sendReminderMail(settings, { subject, html: htmlBody, text }, { exact: true, to, cc: [], bcc: [], attachments: [{ filename: projectionFileName(report.customer, report.createdAt), content: html, contentType: 'text/html' }] });
    } catch (error) {
      return res.status(502).json({ error: `The email could not be sent: ${error.message}` });
    }
    audit.record({ type: 'settings', outcome: 'changed', reason: `Cx Credits Calculator: projection report for "${report.customer}" emailed to ${to.length} address(es).`, actor: { kind: 'user', user: req.user.email, ip: clientIp(req) }, details: { recipients: to } });
    res.json({ sent: to.length });
  }));
  app.delete('/api/projections/reports/:id', requirePermission('reports.delete'), calculatorRoute((req, res) => {
    projectionReports.remove(String(req.params.id));
    res.json({ ok: true });
  }));
  /**
   * Reading the tenant for the calculator (both tabs: each project's lines of code, criticality and
   * scans for Fusion; the backlog and fixes week by week for triage & remediation) takes a while on
   * a big tenant, so it runs in the background, one per tenant, and the page follows it.
   */
  const calculatorReads = new Map();
  /** The tenants POST /api/projections/fusion/read is reading now. */
  const fusionReads = new Set();
  const readView = (job, since = null) => readJobView(job, { since });
  app.post(
    '/api/projections/read',
    requireCalculator,
    (req, res) => {
      const client = req.session.client ?? integrationSession()?.client;
      if (!client) return res.status(409).json({ error: 'Connect to Checkmarx One first (Settings → Checkmarx One).' });
      const key = tenancy.current().id;
      const running = calculatorReads.get(key);
      if (running?.state === 'running') return res.status(202).json(readView(running));
      const job = { id: randomUUID(), state: 'running', step: 'projects', done: 0, total: 0, read: 0, found: 0, startedAt: new Date().toISOString(), by: req.user.email, live: {} };
      calculatorReads.set(key, job);
      // Each project's weeks stay on the server, for any scope picked later; the page gets the rest.
      const reads = tenancy.current().projectionReads;
      Promise.all([
        // One branch per project (its primary branch) unless every branch is asked for.
        readTenant(client, { branches: branchScopeOf(req.body?.branches), maxProjects: readLimit(req.body?.maxProjects), onProgress: readProgressOf(job), live: job.live }),
        readFusionOffer(client).catch(() => ({ models: [], remainingCredits: null })).then((offer) => Object.assign(job.live ?? {}, { offer }) && offer),
      ])
        .then(([{ perProject, ...tenant }, offer]) => {
          reads.save(perProject);
          Object.assign(job, { state: 'done', result: { ...tenant, ...offer }, finishedAt: new Date().toISOString(), live: null });
        })
        .catch((error) => {
          console.error(`[calculator] Reading Checkmarx One failed: ${error.message}`);
          Object.assign(job, { state: 'failed', error: error.status === 401 || error.status === 403 ? 'Checkmarx One refused the read: check the connection under Settings → Checkmarx One.' : `Checkmarx One could not be read: ${error.message}`, finishedAt: new Date().toISOString(), live: null });
        });
      res.status(202).json(readView(job));
    },
  );
  app.get('/api/projections/read', requireCalculator, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(readView(calculatorReads.get(tenancy.current().id), req.query.since));
  });
  /** The backlog and fixes, week by week, of the projects in a customer's scope, the engines and scan origins chosen, from the last read. */
  app.post('/api/projections/series', requireCalculator, (req, res) => {
    const read = projectionReads.get();
    if (!read?.weeks?.length) return res.status(409).json({ error: 'Read Checkmarx One first: the scope is worked out from the last read.' });
    const ids = Array.isArray(req.body?.projectIds) ? req.body.projectIds.slice(0, MAX_PROJECTS).map((id) => String(id).slice(0, 100)) : [];
    // The engines whose findings count (SAST and SCA unless more are ticked), and the scan origins whose scans do (null: every one).
    res.json(seriesFor(read, ids, cleanEngines(req.body?.engines).length ? cleanEngines(req.body.engines) : DEFAULT_ENGINES, cleanOrigins(req.body?.origins)));
  });

  /**
   * Fusion — new customer, Count from git (src/fusion-git.js, with cloc-fusion's engine): a customer's repositories
   * discovered across the Admin's git connections (by id: their tokens stay here) and a token typed for one run (used
   * for those requests and the run they start, never kept, logged or sent back), then measured on this server: code
   * lines, commits on the default branch, change frequency and developers. Only the hosts repositories may be cloned
   * from (cloneHostAllowed: the public hosts, the connected ones, SCM_ALLOWED_HOSTS), and the platforms' API hosts.
   */
  const gitCounter = createGitCounter({ allowHost: (host) => cloneHostAllowed(host), log: (line) => console.error(line) });
  sweepLeftovers();
  /** The Admin's git connections a run may use: each set's hosts with a token (src/scm/instances.js). */
  function countConnections(settings = settingsStore.get()) {
    const out = [];
    for (const set of gitSets(settings)) {
      for (const provider of SCM_PROVIDERS) {
        const cfg = provider === 'github' ? set.github : set.scm[provider];
        if (!cfg?.token) continue;
        const id = `${provider}-${set.n}`;
        let source;
        try {
          source = connectionSource(provider, cfg, id);
        } catch {
          continue; // an address the run may not call (http, link-local…): not offered
        }
        const owner = provider === 'github' ? cfg.org : provider === 'gitlab' ? cfg.group : provider === 'azure' ? source.engine.defaultOrg : cfg.workspace;
        out.push({ id, provider, label: SCM_LABELS[provider], host: source.gitHost, owner: String(owner ?? ''), source });
      }
    }
    return out;
  }
  const countFail = (message, status = 400) => Object.assign(new Error(message), { status });
  /** The token typed for this run, as a source: on a host connected or allowed by the Admin only. */
  function typedCountSource(body) {
    const typed = body?.token && typeof body.token === 'object' ? body.token : null;
    if (!typed) return null;
    const source = gitSource({ provider: String(typed.provider ?? ''), address: String(typed.address ?? ''), token: String(typed.token ?? ''), key: 'token' });
    if (!cloneHostAllowed(source.gitHost.replace(/:\d+$/, ''))) throw countFail(`Repositories on ${source.gitHost} are not counted: connect that host on the Beta page, or add it to SCM_ALLOWED_HOSTS.`);
    return source;
  }
  /**
   * Where the code is, from what the page sent: the Admin's connections by id (`connections`: ids, or {id, orgs,
   * everything}; `connection`: one id, as before) and the token typed (`token`: {provider, address, token, orgs,
   * everything}). Each source with what to list of it; at least one.
   */
  function countSources(body) {
    const known = countConnections();
    const asked = [...(Array.isArray(body?.connections) ? body.connections : []), ...(body?.connection ? [{ id: body.connection, orgs: body.owner !== undefined ? [body.owner] : undefined }] : [])].slice(0, 50);
    const out = [];
    for (const item of asked) {
      const id = String((typeof item === 'object' && item ? item.id : item) ?? '');
      const found = known.find((x) => x.id === id);
      if (!found) throw countFail('That git connection is no longer set up: choose another, or give a token.', 404);
      if (!out.some((s) => s.source.key === id)) out.push({ source: found.source, owner: found.owner, orgs: item?.orgs, everything: item?.everything === true });
    }
    const typed = typedCountSource(body);
    if (typed) out.push({ source: typed, owner: '', orgs: body.token.orgs ?? (body.owner !== undefined ? [body.owner] : undefined), everything: body.token.everything === true });
    if (!out.length) throw countFail('Choose where the code is: one of the git connections, or a token.');
    return out;
  }
  const gitAnswer = (res, error, otherwise) => res.status(error.status ?? 500).json({ error: error.status ? error.message : otherwise });
  app.get('/api/projections/git/connections', requireCalculator, (req, res) => {
    // Names, hosts and kinds only: never a token, nor the address a token is kept for beyond its host.
    res.json({
      connections: countConnections().map(({ id, provider, label, host, owner }) => ({ id, provider, label, host, owner })),
      limits: { repositories: GIT_COUNT_LIMITS.repositories, windowDays: GIT_COUNT_LIMITS.windowDays },
      clocFusion: { version: CLOC_FUSION.version, sha256: CLOC_FUSION.sha256 },
    });
  });
  /** Step 2: each source's organizations (who its token signed in as, and what it can list). */
  app.post('/api/projections/git/organizations', requireCalculator, asyncRoute(async (req, res) => {
    try {
      const sources = countSources(req.body);
      const found = await Promise.all(sources.map(({ source, owner }) => listOrganizations(source, { allowHost: cloneHostAllowed, defaultOrg: owner }).catch((error) => ({ source: source.key, label: source.label, host: source.gitHost, who: '', organizations: owner ? [{ id: owner, label: owner }] : [], problem: error.status ? error.message : 'The organizations could not be listed.' }))));
      res.json({ sources: found });
    } catch (error) {
      gitAnswer(res, error, 'The organizations could not be listed.');
    }
  }));
  /** Step 2: the repositories of the organizations picked (or of everything a token can see), each once. */
  app.post('/api/projections/git/repositories', requireCalculator, asyncRoute(async (req, res) => {
    try {
      const sources = countSources(req.body);
      const lists = await Promise.all(sources.map(({ source, owner, orgs, everything }) => {
        const picked = Array.isArray(orgs) ? orgs : orgs ? [orgs] : owner ? [owner] : [];
        return listRepositories(source, { orgs: picked.map(String).filter(Boolean), everything }, { allowHost: cloneHostAllowed }).catch((error) => {
          if (sources.length === 1) throw error;
          return { repositories: [], more: false, problems: [{ source: source.key, org: '', error: error.status ? error.message : 'The repositories could not be listed.' }] };
        });
      }));
      const seen = new Set();
      const repositories = lists.flatMap((l) => l.repositories).filter((r) => !seen.has(r.url.toLowerCase()) && seen.add(r.url.toLowerCase()));
      res.json({ repositories: repositories.slice(0, GIT_COUNT_LIMITS.listed), more: lists.some((l) => l.more) || repositories.length > GIT_COUNT_LIMITS.listed, problems: lists.flatMap((l) => l.problems) });
    } catch (error) {
      gitAnswer(res, error, 'The repositories could not be listed.');
    }
  }));
  /** Step 3: measure the repositories ticked and pasted, in the background; followed with GET. */
  app.post('/api/projections/git/count', requireCalculator, asyncRoute(async (req, res) => {
    try {
      const sources = countSources(req.body);
      const job = await gitCounter.start(req.user.email, { sources: new Map(sources.map(({ source }) => [source.key, source])), repositories: req.body?.repositories, engine: String(req.body?.engine ?? 'auto') });
      const hosts = [...new Set(sources.map(({ source }) => source.gitHost))].join(', ');
      const admins = [...new Set(sources.filter(({ source }) => source.key !== 'token').map(({ source }) => source.label))];
      const how = [...(admins.length ? [`the Admin's ${admins.join(', ')} connection(s)`] : []), ...(sources.some(({ source }) => source.key === 'token') ? ['a token typed for this run'] : [])].join(' and ');
      audit.record({ type: 'settings', outcome: 'changed', reason: `Cx Credits Calculator: ${job.repositories.length} repositor${job.repositories.length === 1 ? 'y' : 'ies'} measured from git (cloc-fusion ${CLOC_FUSION.version}, ${job.engine} engine) on ${hosts} (${how}).`, actor: { kind: 'user', user: req.user.email, ip: clientIp(req) } });
      res.status(202).json(job);
    } catch (error) {
      gitAnswer(res, error, 'The count could not be started.');
    }
  }));
  app.get('/api/projections/git/count', requireCalculator, (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      res.json(gitCounter.view(req.user.email, req.query.id, { after: req.query.after }));
    } catch (error) {
      gitAnswer(res, error, 'The count could not be read.');
    }
  });
  /** cloc-fusion's one-file page (src/cloc-fusion/cloc-fusion.html), checked against its SHA-256: the tab saves it. */
  app.get('/api/projections/git/cloc-fusion', requireCalculator, (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      res.json(clocFusionPage());
    } catch (error) {
      gitAnswer(res, error, 'cloc-fusion could not be read.');
    }
  });
  app.get('/api/projections/:id', requireCalculator, calculatorRoute((req, res) => {
    res.json({ customer: projections.get(String(req.params.id)) });
  }));
  app.put('/api/projections/:id', requireCalculator, calculatorRoute((req, res) => {
    const body = req.body ?? {};
    const patch = {};
    for (const key of ['name', 'tr', 'fusion', 'fusionNew', 'totals', 'scope', 'impact']) if (body[key] !== undefined) patch[key] = body[key];
    res.json({ customer: projections.update(String(req.params.id), patch, req.user.email) });
  }));
  app.delete('/api/projections/:id', requireCalculator, calculatorRoute((req, res) => {
    const { name } = projections.get(String(req.params.id));
    projections.remove(String(req.params.id));
    audit.record({ type: 'settings', outcome: 'changed', reason: `Cx Credits Calculator: customer "${name}" deleted.`, actor: { kind: 'user', user: req.user.email, ip: clientIp(req) } });
    res.json({ ok: true });
  }));
  /**
   * Fusion: every project in the tenant (lines of code from its last scan, criticality, how often it
   * is scanned), and the Fusion models and remaining credits when the tenant says them.
   */
  app.post(
    '/api/projections/fusion/read',
    requireCalculator,
    asyncRoute(async (req, res) => {
      const client = req.session.client ?? integrationSession()?.client;
      if (!client) return res.status(409).json({ error: 'Connect to Checkmarx One first (Settings → Checkmarx One), or add each project by hand.' });
      // One read of a tenant at a time, as POST /api/projections/read: each holds every project it has read so far.
      const key = tenancy.current().id;
      if (fusionReads.has(key) || calculatorReads.get(key)?.state === 'running') return res.status(409).json({ error: 'Checkmarx One is already being read for the calculator. Try again when that read has finished.' });
      fusionReads.add(key);
      try {
        const [{ perProject, ...tenant }, offer] = await Promise.all([readTenant(client, { branches: branchScopeOf(req.body?.branches), maxProjects: readLimit(req.body?.maxProjects) }), readFusionOffer(client).catch(() => ({ models: [], remainingCredits: null }))]);
        projectionReads.save(perProject);
        res.json({ ...tenant, ...offer });
      } finally {
        fusionReads.delete(key);
      }
    }),
  );
  /** The organisation's name on what the calculator makes (also given with the terms of use). */
  app.put('/api/organisation-name', requirePermission('settings.branding'), asyncRoute(async (req, res) => {
    const name = cleanName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Write your organisation’s name.' });
    const before = terms.organisationName();
    terms.setOrganisationName(name);
    audit.record({ type: 'settings', outcome: 'changed', reason: `Organisation name ${before ? `changed from "${before}" to` : 'set to'} "${name}".`, actor: await adminActor(req) });
    res.json({ organisationName: name });
  }));
}
