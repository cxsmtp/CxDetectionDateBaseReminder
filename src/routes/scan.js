/**
 * The Workbench fetch: reading projects, their last scans and their findings from Checkmarx One for the person
 * signed in.
 *
 * GET /api/scope/options (what the fetch can be narrowed to), GET /api/scan (the fetch, streamed line by line),
 * GET /api/scan/last (what the session fetched last) and POST /api/scan/stop. runScan is the fetch itself; one
 * runs at a time for a session (afterFetch makes the routes that change fetched data wait for it). A verification
 * rescan this server started is credited to the developer whose work it verifies (creditFor, credited).
 */
import { config } from '../config.js';
import { filterProjectsByActivity, getLastScans, lastScanDate, listApplications, listProjects } from '../cxone/projects.js';
import { BRANCH_HOW, branchScopeOf, linesOfCode, onBranch, primaryScans } from '../cxone/branches.js';
import { collectProjectRisks, readGate } from '../cxone/risks.js';
import { engineScope, inEngines } from '../engines.js';
import { collectInitiators, projectsInScope, scanInitiator, scanInitiatorEmail } from '../cxone/initiators.js';
import { matchesVulnerability, topNames, vulnerabilityQuery } from '../vuln-search.js';
import { knownAddresses } from '../known-addresses.js';
import { createHash, randomUUID } from 'node:crypto';
import { projectUrl } from '../links.js';
import { addSla, slaSummary } from '../sla.js';
import { scoped } from '../tenancy.js';
import { scanLanguages, scanTypes } from '../fusion-usage.js';
import { describeWindow, resolveWindow, withinWindow } from '../window.js';
import { attachScanFacts } from '../status-board.js';
import { logSafe } from './shared.js';

/**
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerScanRoutes(app, d) {
  const {
    saveFetchedData, tenancy, settingsStore, findingJournal, diagnostics, creditView, asyncRoute, requirePermission,
    activeConfig, labs,
  } = d;

  // ---------------------------------------------------------------------------
  // Workbench data
  // ---------------------------------------------------------------------------

  /** Projects (by id) and people the dashboard named to fetch, from repeated query parameters. */
  function fetchScope(query) {
    const list = (value, max) =>
      [...new Set([].concat(value ?? []).map((v) => String(v).trim()).filter(Boolean))].slice(0, max).map((v) => v.slice(0, 200));
    return { projectIds: list(query.project, 500), initiators: list(query.initiator, 100), applications: list(query.application, 100) };
  }

  /** A scan initiator's known address: an administrator's override, else one remembered from earlier fetches. */
  function initiatorEmailOf(username, settings = settingsStore.get()) {
    const overrides = settings.initiators?.overrides ?? {};
    return (Object.hasOwn(overrides, username) ? overrides[username] : '') || knownAddresses.get(username) || '';
  }

  /**
   * What the Scope panel can name before anything is fetched: every project's
   * name, and who ran each project's latest scan. Kept for five minutes per session.
   */
  app.get(
    '/api/scope/options',
    requirePermission('findings.fetch'),
    asyncRoute(async (req, res) => {
      const cached = req.session.scopeOptions;
      if (cached && req.query.refresh !== '1' && Date.now() - cached.at < 5 * 60_000) return res.json(cached.data);
      const { client } = req.session;
      const [projects, applications] = await Promise.all([listProjects(client), listApplications(client).catch(() => [])]);
      let scans = {};
      let warning = null;
      try {
        scans = await getLastScans(client, projects.map((p) => p.id));
      } catch (error) {
        warning = `Who ran each project's latest scan could not be read: ${error.message}`;
      }
      const known = new Set(projects.map((p) => p.id));
      const settings = settingsStore.get();
      const people = new Map();
      for (const project of projects) {
        const scan = credited(scans[project.id]);
        const initiator = scanInitiator(scan);
        if (!initiator) continue;
        const entry = people.get(initiator.toLowerCase()) ?? { initiator, email: scanInitiatorEmail(scan) || initiatorEmailOf(initiator, settings), projects: 0 };
        entry.projects += 1;
        people.set(initiator.toLowerCase(), entry);
      }
      const data = {
        projects: projects.map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name)),
        initiators: [...people.values()].sort((a, b) => b.projects - a.projects || a.initiator.localeCompare(b.initiator)),
        // Checkmarx One applications, with how many of their projects this key can see.
        applications: applications
          .map((a) => ({ id: a.id, name: a.name, projects: a.projectIds.filter((id) => known.has(id)).length }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        warning,
      };
      req.session.scopeOptions = { at: Date.now(), data };
      res.json(data);
    }),
  );

  /** A fetch older than this is treated as abandoned, so a lost one never locks the session for good. */
  const FETCH_LOCK_MS = 30 * 60 * 1000;
  const fetchInProgress = (session) => Boolean(session?.fetching && Date.now() - session.fetching.startedAt < FETCH_LOCK_MS);

  /** Triage, remediation and credit allocation wait until the data being fetched is complete. */
  function afterFetch(req, res, next) {
    if (!fetchInProgress(req.session)) return next();
    res.status(409).json({
      error: 'Data is still being fetched. Triage, remediation and credit allocation unlock when the fetch is complete.',
      fetching: true,
    });
  }

  /** The project row the page shows: the summary without its findings (they stay in the session). */
  const projectRow = ({ risks, ...summary }) => summary;

  /**
   * Fetch projects and findings. `onStart` hears how many projects will be read;
   * `onProject` gets each project's row as soon as it is read.
   */
  /**
   * Who a session reads Checkmarx One as: the same key on the same tenant sees
   * the same projects, so it may share recent reads (never across keys).
   */
  function readerIdentity(session) {
    const { apiKey = '', baseUrl = '', tenant = '' } = session?.connection ?? {};
    return apiKey ? createHash('sha256').update(`${baseUrl}\u0000${tenant}\u0000${apiKey}`).digest('base64url').slice(0, 22) : '';
  }

  async function runScan(req, { onStart, onProject, shouldStop = () => false } = {}) {
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
    // A vulnerability search ("SQL injection", "SSRF"): only the findings it names are kept.
    const vulnerability = vulnerabilityQuery(req.query.vulnerability);
    // The engines chosen (the Workbench sends SAST and SCA unless more are ticked); none given means every engine.
    const engines = engineScope(String(req.query.engines ?? '').split(','));
    const names = new Map();
    const allProjects = await listProjects(client);
    // Named projects or people: fetched whatever their last scan date (they were
    // asked for by hand); otherwise the activity window decides.
    const scope = fetchScope(req.query);
    // Named applications: their projects are named projects.
    if (scope.applications.length) {
      const wanted = new Set(scope.applications);
      const applications = await listApplications(client).catch(() => []);
      const named = applications.filter((a) => wanted.has(a.id));
      scope.projectIds = [...new Set([...scope.projectIds, ...named.flatMap((a) => a.projectIds)])].slice(0, 5000);
      scope.applicationNames = named.map((a) => a.name);
    }
    // One branch per project (its primary branch, else main, else master: src/cxone/branches.js), unless every branch is asked for.
    const branchScope = branchScopeOf(req.query.branches);
    // Projects whose scan counted no lines of code are left out unless kept; those with no finding, when asked.
    const leaveOutNoCode = req.query.zeroLoc !== 'keep';
    const leaveOutNoFindings = req.query.noFindings === 'leave-out';
    const identity = readerIdentity(req.session);
    const gate = readGate(client);
    const pickScans = (list) => primaryScans(client, list, { all: branchScope === 'all', identity, gate, concurrency: config.concurrency });
    let projects, skipped, warning, choice;
    if (scope.projectIds.length || scope.initiators.length || scope.applications.length) {
      if (scope.initiators.length) choice = await pickScans(allProjects);
      projects = projectsInScope(allProjects, scope, choice?.anyBranch ?? {}, (username) => initiatorEmailOf(username, settings));
      skipped = allProjects.length - projects.length;
      warning = projects.length ? null : 'No project matches the applications, projects or people named in the scope.';
    } else {
      // A project whose latest scan of any branch is outside the window has none inside it on its primary branch either:
      // only those inside are looked at more closely.
      let candidates = allProjects;
      if (activityWindow) {
        const anyBranch = await getLastScans(client, allProjects.map((p) => p.id)).catch(() => null);
        if (anyBranch) {
          candidates = allProjects.filter((p) => withinWindow(activityWindow, lastScanDate(anyBranch[p.id])));
          choice = await primaryScans(client, candidates, { all: branchScope === 'all', identity, gate, concurrency: config.concurrency, lastScans: anyBranch }).catch(() => null);
        }
      }
      ({ projects, warning } = await filterProjectsByActivity(client, candidates, activityWindow, { lastScans: choice?.scans ?? null }));
      skipped = allProjects.length - projects.length;
    }
    // Each project's latest scan on the branch that counts: whose it is (for reminders), and whether a
    // recent read of it by someone else is still current (see projectReads).
    if (!choice && projects.length) choice = await pickScans(projects).catch(() => null);
    choice ??= { scans: {}, branches: {}, counts: {}, all: branchScope === 'all' };
    const lastScans = choice.scans;
    // Left out before anything is read: a primary branch never scanned, a scan that counted no lines of code.
    const leftOut = { noPrimaryScan: 0, noCode: 0, noFindings: 0 };
    projects = projects.filter((p) => (choice.branches[p.id]?.how === BRANCH_HOW.none ? ((leftOut.noPrimaryScan += 1), false) : true));
    // No lines of code: asked of each project while its findings are read (collectProjectRisks' admit).
    const hasCode = leaveOutNoCode ? async (project) => (lastScans[project.id] ? (await linesOfCode(client, lastScans[project.id], { identity, gate })) !== 0 : true) : null;
    const branchFilter = Object.values(choice.branches).some((b) => b.how !== BRANCH_HOW.any && b.how !== BRANCH_HOW.unknown)
      ? (project, risks) => onBranch(client, choice, project.id, risks, { identity, gate })
      : null;
    onStart?.({ total: projects.length, projectsTotal: allProjects.length, projectsSkipped: skipped });

    // The branch each project's findings are from, and how it was chosen (src/cxone/branches.js).
    const branched = (summary) => Object.assign(summary, { branch: choice.branches[summary.projectId]?.branch ?? '', branchHow: choice.branches[summary.projectId]?.how ?? '' });
    // Rows shown while the rest is still being read: the initiator comes from the
    // latest scan already in hand; addresses and confidence follow with the result.
    const earlyRow = (summary) => {
      const scan = credited(lastScans?.[summary.projectId]);
      return projectRow({
        ...summary,
        initiator: scan ? scanInitiator(scan) ?? '' : '',
        initiatorEmail: scan ? scanInitiatorEmail(scan) ?? '' : '',
        initiatorVia: 'none',
        initiatorSuggestion: '',
        initiatorConfidence: 'none',
        lastScanDate: scan ? lastScanDate(scan) : null,
        url: projectUrl(summary, req.session.connection, settings.links),
        // Worked out once: the finished fetch below reuses it.
        credits: (summary.credits = creditView(summary)),
        // Overdue and due soon by its SLAs (src/sla.js; shown while SLAs are Beta to those who may use them).
        sla: (summary.sla = slaSummary(summary.risks, settings.sla)),
      });
    };

    // Who ran each project's *latest* scan (so a rescan moves the reminder to
    // whoever ran it most recently), and the findings: independent, so both at once.
    const scanEngines = {};
    const [initiators, result, types, languages, boardFacts] = await Promise.all([
      collectInitiators(client, req.session.connection, projects, {
        rules: settings.initiators,
        useDirectory: settings.initiators.useDirectory,
        concurrency: config.concurrency,
        lastScans: Object.keys(lastScans).length ? lastScans : undefined,
        memory: knownAddresses,
        attributed: creditFor,
      }),
      collectProjectRisks(client, active, projects, {
        detectionWindow,
        keep: vulnerability || engines ? (risk) => inEngines(risk, engines) && (!vulnerability || matchesVulnerability(vulnerability, risk)) : null,
        names,
        // Its many projects at once never queue more calls than the connection runs at once (readGate).
        gate,
        onProject: onProject ? (summary) => onProject(earlyRow(branched(summary))) : null,
        shared: { identity, lastScans, fresh: req.query.fresh === '1' },
        scans: Object.keys(lastScans).length ? lastScans : null,
        refine: branchFilter,
        admit: hasCode,
        shouldStop,
      }),
      // Whether each project's latest scan was a Fusion scan, a LAST scan or neither: the Workbench colours its row.
      // Part of the fetch being waited for (a call per 100 projects), so not queued behind background work.
      scanTypes(client, Object.fromEntries(projects.map((p) => [p.id, lastScans?.[p.id]]).filter(([, scan]) => scan)), { concurrency: 2, background: false, engines: scanEngines }).catch(() => ({})),
      // The languages each latest scan has results in, for the line under its name (a call per 50 projects).
      scanLanguages(client, Object.fromEntries(projects.map((p) => [p.id, lastScans?.[p.id]]).filter(([, scan]) => scan)), { concurrency: 2, background: false }).catch(() => ({})),
      // Labs → Status board: applications and failed scans, tenant-wide and cached (only while it is unlocked).
      labs.readFacts(client, identity),
    ]);
    // Stopped part-way, or projects left out: what was read is the data, and only its projects keep their initiators.
    if (result.notRead || result.leftOut) {
      const read = new Set(result.projects.map((p) => p.projectId));
      for (const id of Object.keys(initiators.byProject)) if (!read.has(id)) delete initiators.byProject[id];
    }
    for (const summary of result.projects) {
      const info = initiators.byProject[summary.projectId] ?? {};
      summary.initiator = info.initiator ?? '';
      summary.initiatorEmail = info.email ?? '';
      summary.initiatorVia = info.via ?? 'none';
      summary.initiatorSuggestion = info.suggestedEmail ?? '';
      summary.initiatorConfidence = info.confidence ?? 'none';
      summary.lastScanDate = info.scanDate ?? null;
      summary.scanType = types[summary.projectId] ?? '';
      summary.languages = languages[summary.projectId] ?? [];
      summary.url = projectUrl(summary, req.session.connection, settings.links);
    }
    result.initiators = initiators.byProject;
    // Labs → Status board: each project's scan time, engines, applications, groups and failed scans.
    attachScanFacts(result.projects, { scans: lastScans, engines: scanEngines, applications: boardFacts.applications, failed: boardFacts.failed, groups: Object.fromEntries(allProjects.map((p) => [p.id, p.groups])) });
    result.detectionWindow = detectionWindow;
    result.engines = engines;
    leftOut.noCode = result.leftOut ?? 0;
    for (const summary of result.projects) branched(summary);
    // Asked to: projects with no finding left (in this scope) are not part of the result.
    if (leaveOutNoFindings) result.projects = result.projects.filter((p) => (p.totalRisks > 0 || p.error ? true : ((leftOut.noFindings += 1), false)));
    result.branchScope = branchScope;
    result.leaveOut = { noCode: leaveOutNoCode, noFindings: leaveOutNoFindings };
    result.leftOut = leftOut;
    // Searched: the projects with no finding of that vulnerability are not part of the result.
    result.vulnerability = vulnerability?.text ?? '';
    if (vulnerability) result.projects = result.projects.filter((p) => p.totalRisks > 0 || p.error);
    for (const summary of result.projects) {
      if (summary.error) diagnostics.discrepancy('project-read-failed', { project: summary.projectId, message: summary.error });
    }
    diagnostics.usage(result.notRead ? 'fetch-stopped' : 'fetch-complete', { projects: result.projects.length, notRead: result.notRead ?? 0, reused: result.reused ?? 0, findings: result.projects.reduce((n, p) => n + p.totalRisks, 0), ms: Date.now() - started });
    // Fetching shows what the findings need; it never allocates anything.
    for (const summary of result.projects) summary.credits ??= creditView(summary);
    for (const summary of result.projects) summary.sla ??= slaSummary(summary.risks, settings.sla);
    // What was open, for the Impact page. A project read whole (no date window, no search, no error) is
    // complete for the engines read: what it no longer lists of theirs was fixed. A narrowed read only adds
    // what it saw. Only the branch that counts is recorded: a read of every branch would mix in others' findings.
    const whole = !detectionWindow && !vulnerability;
    if (branchScope === 'primary') for (const summary of result.projects) findingJournal.observe(summary, summary.risks, { complete: whole && !summary.error, engines });
    req.session.lastScan = result;
    labs.noteFetch(req, result, allProjects.length);

    const response = {
      ...result,
      // The findings themselves stay here, in the session: the page shows the
      // summaries, and sending every finding made the reply many megabytes.
      projects: result.projects.map(projectRow),
      windows: {
        activity: describeWindow(activityWindow),
        detection: describeWindow(detectionWindow),
      },
      projectsTotal: allProjects.length,
      projectsSkipped: skipped,
      // The search, and the names of every finding read (most frequent first), to suggest as people type.
      vulnerability: result.vulnerability,
      // The engines read (null: every engine).
      engines,
      // One branch per project ("primary") or every branch ("all"), and how each project's branch was chosen.
      branches: { scope: branchScope, counts: choice.counts ?? {} },
      vulnerabilityNames: topNames(names),
      // Stop pressed: how many of the projects in scope were read before it, and how many were not.
      stopped: result.notRead > 0,
      projectsPlanned: projects.length,
      projectsNotRead: result.notRead ?? 0,
      scope: { projects: scope.projectIds.length, initiators: scope.initiators, applications: scope.applicationNames ?? [] },
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
    };
    response.totals.sla = addSla(result.projects.map((p) => p.sla));
    // What the page showed, and the scope that produced it: a reload (or a restart) shows it again.
    const q = (name) => String(req.query[name] ?? '').slice(0, 40);
    result.view = {
      ...response,
      projects: undefined,
      initiators: undefined,
      fetchedAt: new Date().toISOString(),
      request: {
        activityPreset: q('activityPreset'), activityFrom: q('activityFrom'), activityTo: q('activityTo'),
        detectionPreset: q('detectionPreset'), detectionFrom: q('detectionFrom'), detectionTo: q('detectionTo'),
        projects: fetchScope(req.query).projectIds,
        initiators: scope.initiators,
        applications: scope.applications,
        applicationNames: scope.applicationNames ?? [],
        vulnerability: result.vulnerability,
        engines: engines ?? [],
        branches: branchScope,
        zeroLoc: leaveOutNoCode ? '' : 'keep',
        noFindings: leaveOutNoFindings ? 'leave-out' : '',
      },
    };
    saveFetchedData(req.session);
    return response;
  }

  /**
   * The data this person fetched last, as the fetch returned it, with credits as
   * they are now: after a page reload or a server restart the Workbench shows it
   * again without reading Checkmarx One. 204 when nothing was fetched yet.
   */
  app.get('/api/scan/last', requirePermission('findings.fetch'), (req, res) => {
    const scan = req.session.lastScan;
    if (!scan?.view || fetchInProgress(req.session)) return res.status(204).end();
    // Credits and SLAs as they are now (a day later, more can be overdue; the SLAs may have changed).
    const sla = settingsStore.get().sla;
    for (const p of scan.projects) {
      p.credits = creditView(p);
      p.sla = slaSummary(p.risks, sla);
    }
    const view = { ...scan.view, totals: { ...scan.view.totals, sla: addSla(scan.projects.map((p) => p.sla)) } };
    res.json({ ...view, initiators: scan.initiators, projects: scan.projects.map(projectRow), restored: true });
  });

  /**
   * Fetch the data. With ?stream=1 the reply is NDJSON, one line per event:
   * {type:"start", total}, then {type:"project", project} as each project is
   * read, then {type:"done", ...the full result} (or {type:"error", error}).
   * While a fetch runs, triage, remediation and credit allocation wait (afterFetch).
   */
  app.get(
    '/api/scan',
    requirePermission('findings.fetch'),
    asyncRoute(async (req, res) => {
      const id = randomUUID();
      req.session.fetching = { id, startedAt: Date.now(), stop: false };
      const release = () => {
        if (req.session.fetching?.id === id) delete req.session.fetching;
      };
      // Stop (POST /api/scan/stop), or the page went away: no more projects are read; what was read is kept.
      const shouldStop = () => req.session.fetching?.id === id && req.session.fetching.stop === true;
      res.on('close', () => {
        if (!res.writableFinished && req.session.fetching?.id === id) req.session.fetching.stop = true;
      });
      if (req.query.stream !== '1') {
        try {
          return res.json(
            await runScan(req).catch((error) => {
              labs.noteFetchFailed(error);
              throw error;
            }),
          );
        } finally {
          release();
        }
      }

      res.status(200).set({
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      const send = (event) => {
        if (res.writableEnded) return;
        res.write(`${JSON.stringify(event)}\n`);
        res.flush?.(); // through compression: each line leaves now, not when a buffer fills
      };
      try {
        const result = await runScan(req, {
          onStart: (info) => send({ type: 'start', ...info }),
          onProject: (project) => send({ type: 'project', project }),
          shouldStop,
        });
        release();
        send({ type: 'done', ...result });
      } catch (error) {
        release();
        const expected = Number.isInteger(error.status) && error.status >= 400 && error.status < 600;
        console.error(`GET /api/scan (stream) -> ${logSafe(expected ? error.message : error.stack ?? error.message)}`);
        diagnostics.error('fetch-failed', error, { status: expected ? error.status : 500 });
        labs.noteFetchFailed(error);
        send({ type: 'error', status: expected ? error.status : 500, error: expected ? error.message : 'Something went wrong on the server. The details are in its log.' });
      } finally {
        release();
        res.end();
      }
    }),
  );

  /**
   * Stop the fetch running for this person: projects already being read finish,
   * the rest are not read, and the fetch ends with what it has (stopped: true).
   * That data is kept like a finished fetch, so every action works on it.
   */
  app.post('/api/scan/stop', requirePermission('findings.fetch'), (req, res) => {
    if (!fetchInProgress(req.session)) return res.json({ stopping: false });
    req.session.fetching.stop = true;
    res.json({ stopping: true });
  });

  /** Rescans this server started are credited to the developer they verify (see src/scan-attribution.js). */
  const scanAttribution = scoped(tenancy, 'scanAttribution');
  const creditFor = (scanId) => scanAttribution.get(scanId);
  /** A last-scan record, with a verification rescan credited to whose work it verifies. */
  const credited = (scan) => {
    const credit = scan && creditFor(scan.id ?? scan.scanId);
    return credit ? { ...scan, initiator: credit.initiator, initiatorEmail: credit.email || undefined, startedBy: scanInitiator(scan) } : scan;
  };

  return { fetchInProgress, afterFetch, projectRow, readerIdentity, scanAttribution, creditFor };
}
