/**
 * The interactive HTML report (src/html-report.js): building it for a person, with the grants its reader acts
 * with, and the ways it leaves the server.
 *
 * - POST /api/relay/project-report: one project's own report, asked for from a report with several projects.
 * - GET /r/:id: the link in an email to a report too large to attach.
 * - POST /api/reports/html: a report downloaded from the Workbench.
 * - POST /api/reminders/send-html-by-initiator: the report emailed to each person, with their own findings.
 *
 * buildInteractiveReport and runHtmlReminder are handed back to src/server.js: automation and tracked reports
 * send the same report.
 */
import { config } from '../config.js';
import { getLastScans } from '../cxone/projects.js';
import { onBranch } from '../cxone/branches.js';
import { AGE_BUCKETS, collectProjectRisks, selectRisks } from '../cxone/risks.js';
import { engineScope } from '../engines.js';
import { collectInitiators } from '../cxone/initiators.js';
import { resolveAiIds, resultRowsFor } from '../cxone/ai-assist.js';
import { knownAddresses } from '../known-addresses.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { locationOf } from '../github/blame.js';
import { BULK_SEVERITIES, REPORT_SEARCHABLE, REPORT_TOP_N, generateHtmlReport, selectTopFindings } from '../html-report.js';
import { reportI18n } from '../report-i18n.js';
import { buildReportData, buildReportEmail } from '../reminder.js';
import { projectUrl } from '../links.js';
import { sendReminderMail } from '../mailer.js';
import { isVerified } from '../settings.js';
import { DEFAULT_TENANT, scoped } from '../tenancy.js';
import { SYSTEM_ACTOR, clientIp, escapeHtml, idList, logSafe } from './shared.js';

/**
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerReportRoutes(app, d) {
  const {
    tenancy, settingsStore, reportFiles, audit, iam, reportGrants, tenantQuery, languageAccess, allowedLanguages,
    asyncRoute, brandingNow, requirePermission, activeConfig, sendingSettings, readerIdentity, withoutNotExploitable,
    reminderScope, initiatorGroups, reportServerUrl, relaySession, adminContact, reportActor, adminActor, creditFor,
    branchChoiceFor, rescanTokens, RESCAN_REPORT_GRANT_MS,
  } = d;

  // ---------------------------------------------------------------------------
  // One project's own report, asked for from a report with several projects
  // ---------------------------------------------------------------------------

  const PROJECT_REPORT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // as long as the report's grants
  const PROJECT_REPORT_SEVERITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO', 'UNKNOWN']);

  /** The scope a project report keeps, in one canonical shape (it is signed). */
  function projectReportScope(scope = {}) {
    const list = (value, allowed) =>
      [...new Set((Array.isArray(value) ? value : []).map((v) => String(v)).filter((v) => allowed(v)))].sort().slice(0, 10);
    const iso = (value) => {
      const time = Date.parse(value ?? '');
      return Number.isFinite(time) ? new Date(time).toISOString() : '';
    };
    const detection = scope.detection ?? {};
    const engines = engineScope(scope.engines);
    return {
      buckets: list(scope.buckets, (b) => AGE_BUCKETS.some((a) => a.id === b) || b === 'unknown'),
      severities: list((scope.severities ?? []).map?.((v) => String(v).toUpperCase()) ?? [], (v) => PROJECT_REPORT_SEVERITIES.has(v)),
      detection: { from: iso(detection.from), to: iso(detection.to) },
      // Only when engines were chosen: reports made before keep their signed scope (every engine).
      ...(engines ? { engines } : {}),
      // Only for one branch per project: reports made before keep theirs (every branch).
      ...(scope.branches === 'primary' ? { branches: 'primary' } : {}),
    };
  }

  function projectReportSignature(projectId, projectName, exp, scope) {
    return reportGrants.macText(['project-report', projectId, projectName, String(exp), JSON.stringify(projectReportScope(scope))].join('\n'));
  }

  /**
   * A report covering several projects asks for one project's own report: the
   * same interactive report, for that project alone, read fresh from Checkmarx
   * One with this server's connection. Only for a project and scope the report
   * was signed with; the reader never needs (or is sent to) Checkmarx One.
   */
  app.post(
    '/api/relay/project-report',
    asyncRoute(async (req, res) => {
      const projectId = String(req.body?.projectId ?? '').slice(0, 200);
      const projectName = String(req.body?.projectName ?? '').slice(0, 300);
      const exp = Number(req.body?.exp);
      const scope = projectReportScope(req.body?.scope ?? {});
      const given = Buffer.from(String(req.body?.sig ?? ''));
      const expected = Buffer.from(projectReportSignature(projectId, projectName, exp, scope));
      if (!projectId || !Number.isFinite(exp) || given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return res.status(403).json({ error: 'This report is not authorised to open that project.' });
      }
      if (exp <= Date.now()) return res.status(403).json({ error: 'This report has expired. Ask for a new one.' });
      const session = await relaySession(res);
      if (!session) return;

      const settings = settingsStore.get();
      const project = { id: projectId, name: projectName };
      // The branch that counts for the project (a report made before branches were told apart: every branch).
      const branchChoice = await branchChoiceFor(session, [{ projectId, projectName }], scope.branches ?? 'all');
      const lastScans = branchChoice?.scans ?? (await getLastScans(session.client, [projectId]).catch(() => ({})));
      const detectionWindow = scope.detection.from || scope.detection.to
        ? { from: scope.detection.from ? new Date(scope.detection.from) : null, to: scope.detection.to ? new Date(scope.detection.to) : null }
        : null;
      const [read, initiators] = await Promise.all([
        collectProjectRisks(session.client, activeConfig(), [project], {
          detectionWindow,
          shared: { identity: readerIdentity(session), lastScans },
          scans: branchChoice ? lastScans : null,
          refine: branchChoice ? (p, risks) => onBranch(session.client, branchChoice, p.id, risks, { identity: readerIdentity(session) }) : null,
        }),
        collectInitiators(session.client, session.connection, [project], {
          rules: settings.initiators,
          useDirectory: settings.initiators.useDirectory,
          concurrency: config.concurrency,
          lastScans,
          memory: knownAddresses,
          attributed: creditFor,
        }),
      ]);
      const summary = read.projects[0];
      if (summary?.error) {
        // The reader holds an emailed report and is not signed in: the kind of failure, with Checkmarx One's own words kept in the log.
        console.warn(`[relay] could not read ${logSafe(projectName || projectId)} for a project report: ${logSafe(summary.error)}`);
        return res.status(502).json({ error: `Could not read ${projectName || 'the project'} from Checkmarx One. Try again later, or ask your security team to check the CxMissionZero server.` });
      }
      if (summary) summary.url = projectUrl(summary, session.connection, settings.links);
      const risks = selectRisks(read.projects, { buckets: scope.buckets, severities: scope.severities.length ? scope.severities : null, engines: scope.engines ?? null });
      const actor = reportActor(req);
      const { html, findings } = await buildInteractiveReport(session, risks, {
        buckets: scope.buckets,
        settings,
        relayUrl: reportServerUrl(req, settings),
        initiatorsByProject: initiators.byProject,
        scope,
        projects: read.projects,
        audience: { actor, recipient: actor.recipient, purpose: `opened for ${projectName || projectId} from a report` },
      });
      const filename = `${(projectName || projectId).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'project'}-report.html`;
      res.json({ html, filename, findings: findings.length, total: risks.length });
    }),
  );

  /**
   * Build the interactive HTML report for a set of findings. The top findings
   * get the identifiers Checkmarx One AI Triage / Remediation need resolved
   * here, with this session's credentials, so the report itself only ever
   * needs the reader's own API key.
   */
  async function buildInteractiveReport(session, risks, { buckets = [], settings, initiator = null, relayUrl = '', initiatorsByProject, audience = {}, publish = '', scope = null, projects = null, tracked = null } = {}) {
    const { connection, lastScan } = session;
    initiatorsByProject ??= lastScan?.initiators ?? {};
    // The scope its per-project reports keep: the one given, else the Workbench's (its engines and branches).
    const signedScope = scope ?? { buckets, engines: lastScan?.engines ?? null, branches: lastScan?.branchScope };
    // Whatever built the list, findings triaged as not exploitable stay out.
    risks = await withoutNotExploitable(session, risks);
    const reportData = buildReportData(risks, {
      buckets,
      tenant: connection.tenant,
      links: settings.links,
      connection,
      branding: brandingNow(settings.branding),
      initiatorsByProject,
      initiator,
    });
    // The table shows the top findings; the "triage all critical / high"
    // actions cover every critical and high finding, so those get ids too.
    const ranked = selectTopFindings(reportData, Infinity);
    const findings = ranked.slice(0, REPORT_TOP_N);
    const bulkFindings = ranked.slice(REPORT_TOP_N).filter((f) => BULK_SEVERITIES.includes(f.severity));
    // The rest the report can search and filter (drawn when reached), up to what it holds: they get AI ids too,
    // so Triage works on them; one scan's results are read once whatever the number of findings.
    const moreFindings = ranked
      .slice(REPORT_TOP_N)
      .filter((f) => !BULK_SEVERITIES.includes(f.severity))
      .slice(0, Math.max(0, REPORT_SEARCHABLE - findings.length - bulkFindings.length));
    const scanIdOf = (finding) => initiatorsByProject[finding.projectId]?.scanId ?? '';
    // The AI ids from each scan's result ids, kept and shared for 30 minutes (a scan's ids never change):
    // a report built again, or after a credit check, reads no scan again.
    await resolveAiIds(session.client, [...findings, ...bulkFindings, ...moreFindings], scanIdOf);
    // Where each shown finding is in its repository: the report's "Open in IDE" and "Apply fix in my workspace".
    // Code paths are read only for the scans of the findings shown, and remembered.
    const resultsCache = new Map();
    const locatable = findings.filter((f) => LOCATABLE_SCANNERS.has(f.scanner));
    for (const scanId of new Set(locatable.map((f) => f.scanId || scanIdOf(f)))) {
      const known = scanLocations.get(scanId);
      if (known && !resultsCache.has(scanId)) resultsCache.set(scanId, Promise.resolve(known));
    }
    const rows = locatable.length ? await resultRowsFor(session.client, locatable, scanIdOf, resultsCache) : new Map();
    await rememberScanLocations(resultsCache);
    for (const [finding, row] of rows) {
      const at = locationOf(row);
      if (at?.path) finding.codeLocation = { path: at.path, line: at.line, column: at.column };
    }
    const repositories = reportRepositories(projects ?? lastScan?.projects ?? [], reportData.projects);
    // Who this report is for, signed: every action taken from it is attributed to them.
    const reportToken = reportGrants.signReport({ id: randomUUID(), recipient: audience.recipient ?? '' });
    const actionable = [...findings, ...bulkFindings].filter((f) => !f.aiUnavailable).length;
    audit.record({
      type: 'report',
      outcome: 'info',
      reason: `Interactive report ${audience.purpose ?? 'generated'}${audience.recipient ? ` for ${audience.recipient}` : ''}.`,
      actor: audience.actor ?? SYSTEM_ACTOR,
      credits: { kind: 'report', requested: 0, charged: 0 },
      details: {
        reportId: reportToken.id,
        recipient: audience.recipient ?? '',
        purpose: audience.purpose ?? '',
        projects: [...new Set(findings.map((f) => f.projectName))].slice(0, 50),
        findingsShown: findings.length,
        actionableFindings: actionable,
        triageEnabled: Boolean(settings.aiTriage?.enabled),
        remediationEnabled: Boolean(settings.aiTriage?.remediationEnabled),
      },
    });
    // In the reader's language: the recipient's profile (or, opened by someone, theirs). A gated
    // language travels only in a report for someone it is on for.
    // A language is never a reason for a report to fail: without one, it is in English.
    let i18n = null;
    let reader = null;
    try {
      const readerEmail = /^[^\s,@]+@[^\s,@]+$/.test(audience.recipient ?? '') ? audience.recipient : String(audience.actor?.user ?? '');
      reader = readerEmail ? iam.findByEmail(readerEmail) : null;
      i18n = reportI18n({ codes: languageAccess.available(allowedLanguages(reader?.id ?? null)), preferred: reader?.profile?.language ?? '' });
    } catch (error) {
      console.error(`[report languages] This report is in English only: ${error.message}`);
    }
    const html = generateHtmlReport(reportData, {
      findings,
      bulkFindings,
      moreFindings,
      i18n,
      relayUrl,
      remediationViaRelay: true,
      portalUrl: settings.links.baseUrl,
      sign: (finding) => reportGrants.issue(finding),
      reportToken,
      tenantId: tenancy.current().id === DEFAULT_TENANT ? '' : tenancy.current().id,
      // From a tracked report, to one developer: they may rescan their own fixes once the round is closed.
      rescanGrant: tracked && audience.recipient && !audience.recipient.includes(',')
        ? rescanTokens.issue({ reportId: tracked.id, round: tracked.round ?? 1, email: audience.recipient, exp: Date.now() + RESCAN_REPORT_GRANT_MS })
        : '',
      connection: { tenant: connection.tenant, iamUrl: connection.iamUrl, baseUrl: connection.baseUrl },
      branding: brandingNow(settings.branding),
      // In the reader's look, like their language: next-gen unless they chose classic or the organisation turned it off.
      look: readerLook(reader, settings),
      allowRetriage: Boolean(settings.aiTriage?.allowRetriage),
      allowReremediation: Boolean(settings.aiTriage?.allowReremediation),
      adminContact: adminContact(settings),
      repositories,
      // The engines the report covers, said at its top (undefined: not said, for a report with no scan behind it).
      engines: signedScope.engines ?? null,
      branches: scope ? scope.branches ?? 'all' : lastScan?.branchScope,
      // "One project's report" buttons: this server builds it, within the same scope.
      projectReportScope: projectReportScope(signedScope),
      signProjectReport: (projectId) => {
        const name = reportData.projects.find((p) => String(p.projectId) === projectId)?.projectName ?? '';
        const exp = Date.now() + PROJECT_REPORT_TTL_MS;
        return { exp, sig: projectReportSignature(projectId, name, exp, projectReportScope(signedScope)) };
      },
    });
    // For email: keep the file, so the email's button can download exactly this report.
    let downloadUrl = '';
    if (publish && relayUrl) {
      await reportFiles.save(reportToken.id, html, { filename: publish });
      downloadUrl = reportDownloadUrl(relayUrl, reportToken.id);
    }
    return { reportData, findings, html, downloadUrl, reportId: reportToken.id };
  }

  /** Engines whose findings sit at a file and line. */
  const LOCATABLE_SCANNERS = new Set(['SAST', 'KICS', 'IAC']);

  /**
   * Where a completed scan's results are never changes, so report builds share
   * it: per scan, only what finding a row and its location need (no states),
   * for the 40 scans used last, for 30 minutes.
   */
  const scanLocations = scoped(tenancy, 'scanLocations');
  const SCAN_LOCATIONS_TTL_MS = 30 * 60_000;
  const slimRow = (row) => {
    const nodes = Array.isArray(row?.data?.nodes) ? row.data.nodes : [];
    const node = (n) => ({ fileName: n?.fileName ?? n?.fullName ?? '', line: n?.line, column: n?.column });
    return {
      type: row?.type,
      alternateId: row?.alternateId,
      similarityId: row?.similarityId,
      data: {
        ...(nodes.length ? { nodes: nodes.length > 1 ? [node(nodes[0]), node(nodes.at(-1))] : [node(nodes[0])] } : {}),
        ...(row?.data?.filename || row?.data?.fileName ? { filename: row.data.filename ?? row.data.fileName, line: row.data.line } : {}),
      },
    };
  };
  async function rememberScanLocations(resultsCache) {
    for (const [scanId, pending] of resultsCache) {
      if (scanLocations.get(scanId)) continue;
      try {
        const rows = await pending;
        if (Array.isArray(rows)) scanLocations.set(scanId, rows.map(slimRow), SCAN_LOCATIONS_TTL_MS);
      } catch {}
    }
  }

  /** A repository address safe to put in a report: http(s), ssh or git@host:path, never with credentials. */
  function publicRepoUrl(url) {
    const text = String(url ?? '').trim();
    if (/^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(text)) return text;
    try {
      const parsed = new URL(text);
      if (!['https:', 'http:', 'ssh:'].includes(parsed.protocol)) return '';
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString().replace(/\/+$/, '');
    } catch {
      return '';
    }
  }

  /** projectId → {url, branch} for the projects in a report that name their repository. */
  function reportRepositories(known, inReport) {
    const byId = new Map(known.map((p) => [String(p.projectId), p]));
    const repositories = {};
    for (const { projectId } of inReport) {
      const project = byId.get(String(projectId));
      const url = publicRepoUrl(project?.repoUrl);
      if (url) repositories[String(projectId)] = { url, branch: String(project.mainBranch ?? '').slice(0, 200) };
    }
    return repositories;
  }

  /** How a report looks for its reader: their look (the organisation's unless they may and did pick their own), theme and accent. */
  function readerLook(reader, settings) {
    const profile = reader?.profile ?? {};
    const own = settings.branding?.lookChoice !== false && profile.look ? profile.look : settings.branding?.look;
    const nextGen = settings.branding?.nextGen !== false && own !== 'classic';
    return { look: nextGen ? own || 'nextgen' : 'classic', ui: nextGen ? 'nextgen' : 'classic', theme: profile.theme ?? 'auto', accent: profile.accent ?? 'indigo' };
  }

  /** A link only this server could have made: the report id plus its signature. */
  const downloadSignature = (id) => reportGrants.macText(`download\n${id}`);
  function reportDownloadUrl(relayUrl, id) {
    return `${String(relayUrl).replace(/\/+$/, '')}/r/${id}?s=${encodeURIComponent(downloadSignature(id))}${tenantQuery('&')}`;
  }

  function linkPage(title, message) {
    const name = escapeHtml(settingsStore.get().branding.appName || 'CxMissionZero');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="/app-icon"><title>${escapeHtml(title)} · ${name}</title><style>body{font:15px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f7fb;color:#1f2330}
main{max-width:520px;margin:24px;padding:28px;border-radius:14px;background:#fff;border:1px solid #e6e8ef}h1{font-size:20px;margin:0 0 8px}p{color:#475467;margin:0}
@media (prefers-color-scheme:dark){body{background:#0f131a;color:#e6e8ef}main{background:#161b24;border-color:#2a3140}p{color:#98a2b3}}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
  }

  /** Text for inside an HTML comment: letters, digits and a few separators only, so it can never close the comment. */
  const commentSafe = (text) => String(text).replace(/[^\w ,.+-]/g, '').replace(/-{2,}/g, '-').slice(0, 200);

  /**
   * The email's "Let's start fixing the vulnerabilities" button: downloads the
   * interactive report that was attached to that email. The signed link is the
   * permission — like the attachment itself, whoever has the email has it.
   */
  app.get('/r/:id', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    const id = String(req.params.id);
    const given = Buffer.from(String(req.query.s ?? ''));
    const expected = Buffer.from(/^[0-9a-f-]{36}$/i.test(id) ? downloadSignature(id) : '');
    if (!expected.length || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return res.status(404).type('html').send(linkPage('Link not recognised', 'This download link is incomplete or was changed. Use the button in the email again, or open the report attached to it.'));
    }
    const file = reportFiles.get(id);
    if (!file) {
      return res.status(410).type('html').send(linkPage('This report has expired', 'Reports can be downloaded for 30 days. Open the report attached to the email, or ask for a new reminder.'));
    }
    audit.record({
      type: 'report',
      outcome: 'info',
      reason: 'Report downloaded from the email’s button.',
      actor: { kind: 'report', reportId: id, ip: clientIp(req), userAgent: String(req.get('user-agent') ?? '').slice(0, 200) },
      details: { reportId: id },
    });
    const filename = (file.filename || `vulnerability-report-${file.savedAt.slice(0, 10)}.html`).replace(/[^\w.-]+/g, '-');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    // Downloaded, never rendered on this origin.
    res.set('Content-Security-Policy', "sandbox; default-src 'none'");
    res.type('html').send(file.html);
  });

  app.post(
    '/api/reports/html',
    requirePermission('reminders.send'),
    asyncRoute(async (req, res) => {
      const given = req.body ?? {};
      for (const field of ['buckets', 'severities']) {
        if (given[field] !== undefined && given[field] !== null && !Array.isArray(given[field])) {
          return res.status(400).json({ error: `${field} must be a list.` });
        }
      }
      // Only known age buckets and severities, as for tracked reports.
      const buckets = (given.buckets ?? []).map(String).filter((b) => AGE_BUCKETS.some((a) => a.id === b));
      const wantedSeverities = (given.severities ?? []).map((v) => String(v).toUpperCase()).filter((v) => PROJECT_REPORT_SEVERITIES.has(v));
      const severities = wantedSeverities.length ? wantedSeverities : null;
      const projectIds = idList(req.body?.projectIds);
      const { lastScan } = req.session;
      const settings = settingsStore.get();

      if (!lastScan) {
        return res.status(409).json({ error: 'Load findings on the Workbench first.' });
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
        <!-- Buckets filter: ${buckets.length > 0 ? commentSafe(buckets.join(', ')) : 'none (include all)'} -->
        <!-- Severities filter: ${severities?.length > 0 ? commentSafe(severities.join(', ')) : 'none (include all)'} -->
        `
        : '';

      const actor = await adminActor(req);
      const { html } = await buildInteractiveReport(req.session, risks, {
        buckets,
        scope: { buckets, severities, detection: lastScan.detectionWindow, engines: lastScan.engines, branches: lastScan.branchScope },
        settings,
        relayUrl: reportServerUrl(req, settings),
        audience: { actor, recipient: `downloaded by ${actor.user || 'administrator'}`, purpose: 'downloaded from the Workbench' },
      });
      const htmlReport = html + diagnostics;

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(htmlReport);
    }),
  );

  /** Send each scan initiator an email with the interactive HTML report attached. */
  async function runHtmlReminder(session, scan, input, relayUrl) {
    const reply = (status, payload) => ({ status, body: payload });
    const { projectIds = null, buckets = [], severities = null, initiators = null, alsoConsolidated = false, tracked = null } = input;
    const groupBy = ['initiator', 'project', 'none'].includes(input.groupBy) ? input.groupBy : 'initiator';
    const settings = sendingSettings();

    if (!isVerified(settings)) {
      return reply(400, {
        error:
          'Test the SMTP connection on the Settings page before sending. ' +
          'Changing any connection detail clears a previous successful test.',
      });
    }

    const { risks, initiatorsByProject } = await reminderScope(session, scan, { projectIds, buckets, severities, initiators });
    if (risks.length === 0) {
      return reply(400, { error: 'No vulnerabilities match that selection.' });
    }

    const attachmentName = `vulnerability-report-${new Date().toISOString().split('T')[0]}.html`;
    /** One email with its own interactive report of exactly `findings`. */
    const sendReport = async (findings, { to, cc = [], bcc = [], greeting, initiator = null, purpose }) => {
      const { reportData, findings: shown, html, downloadUrl } = await buildInteractiveReport(session, findings, {
        buckets,
        scope: { buckets, severities, detection: scan.detectionWindow, engines: scan.engines, branches: scan.branchScope ?? 'all' },
        settings,
        relayUrl,
        initiatorsByProject,
        initiator,
        audience: { recipient: to.join(', '), purpose },
        publish: attachmentName,
        tracked,
      });
      const body = buildReportEmail(reportData, { greeting, topCount: shown.length, downloadUrl });
      const projects = [...new Set(findings.map((r) => r.projectName))].sort();
      const message = {
        subject: `${findings.length} open vulnerabilities to triage${projects.length === 1 ? ` in ${projects[0]}` : ''}`,
        html: body.html,
        text: body.text,
      };
      const result = await sendReminderMail(settings, message, {
        exact: true,
        to,
        cc,
        bcc,
        attachments: [{ filename: attachmentName, content: html, contentType: 'text/html' }],
      });
      return { messageId: result.messageId, projects };
    };

    const sent = [];
    const errors = [];
    let skipped = [];
    if (groupBy === 'initiator' || groupBy === 'project') {
      const groups = initiatorGroups(risks, initiatorsByProject, groupBy);
      skipped = groups
        .filter((group) => !group.email)
        .map((group) => ({ initiator: group.initiator || '(unknown)', riskCount: group.risks.length, projects: group.projectNames }));
      for (const group of groups.filter((g) => g.email)) {
        try {
          const result = await sendReport(group.risks, {
            to: [group.email],
            cc: settings.initiators.copyConfiguredRecipients ? settings.recipients.cc : [],
            bcc: settings.initiators.copyConfiguredRecipients ? settings.recipients.bcc : [],
            greeting: `Hi ${group.initiator || 'there'}`,
            initiator: group,
            purpose: `emailed to the scan initiator (${group.projectNames.join(', ')})`,
          });
          sent.push({ initiator: group.initiator, email: group.email, riskCount: group.risks.length, projectCount: group.projectCount, ...result });
        } catch (error) {
          errors.push({ initiator: group.initiator, email: group.email, error: error.message });
        }
      }
    }
    // The recipient list: everything selected, in one report (a lead's overview).
    if (groupBy === 'none' || alsoConsolidated) {
      const { to, cc, bcc } = settings.recipients;
      if (!to.length && !cc.length && !bcc.length) {
        errors.push({ initiator: 'recipient list', email: '', error: 'The recipient list is empty: add addresses under Send reminder → Recipient list.' });
      } else {
        try {
          const result = await sendReport(risks, { to, cc, bcc, greeting: 'Hi', purpose: 'emailed to the recipient list' });
          sent.push({ initiator: 'recipient list', email: [...to, ...cc, ...bcc].join(', '), riskCount: risks.length, projectCount: result.projects.length, consolidated: true, ...result });
        } catch (error) {
          errors.push({ initiator: 'recipient list', email: to.join(', '), error: error.message });
        }
      }
    }

    const people = sent.filter((entry) => !entry.consolidated).length;
    return reply(sent.length || !errors.length ? 200 : 502, {
      delivered: sent.length > 0,
      groupBy,
      sent,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
      error: !sent.length && errors.length ? errors[0].error : undefined,
      summary: groupBy === 'none'
        ? `Sent the HTML report to the recipient list${errors.length ? ' — failed' : ''}.`
        : `Sent HTML reports to ${people} person(s)${sent.some((e) => e.consolidated) ? ', plus the full report to the recipient list' : ''}, skipped ${skipped.length}.`,
    });
  }

  app.post(
    '/api/reminders/send-html-by-initiator',
    requirePermission('reminders.send'),
    asyncRoute(async (req, res) => {
      if (!req.session.lastScan) return res.status(409).json({ error: 'Load findings on the Workbench first.' });
      const settings = settingsStore.get();
      const { status, body } = await runHtmlReminder(req.session, req.session.lastScan, req.body ?? {}, reportServerUrl(req, settings));
      res.status(status).json(body);
    }),
  );

  return { buildInteractiveReport, LOCATABLE_SCANNERS, readerLook, linkPage, runHtmlReminder };
}
