import { fileURLToPath } from 'node:url';
import path from 'node:path';

import express from 'express';
import compression from 'compression';

import { config, configProblems } from './config.js';
import { APP_VERSION } from './version.js';
import { SendGuard } from './send-guard.js';
import { Diagnostics } from './diagnostics.js';
import { filterProjectsByActivity, getLastScans, lastScanDate, listProjects } from './cxone/projects.js';
import { AGE_BUCKETS, collectProjectRisks, createRiskSource, normalizeRisk, projectReads, selectRisks, summariseProject } from './cxone/risks.js';
import { discover } from './cxone/discovery.js';
import { collectInitiators, groupRisksByInitiator, groupRisksByProject, projectsInScope, scanInitiator, scanInitiatorEmail } from './cxone/initiators.js';
import { AI_SCANNERS, resolveAiIds, resultRowsFor } from './cxone/ai-assist.js';
import { mapWithConcurrency } from './cxone/client.js';
import { ReportGrants } from './report-grants.js';
import { CREDIT_COST, CreditLedger, monthOf } from './credits.js';
import { CreditAllocations, REMEDIABLE_STATE, alreadySent, billingUnit, remediable, remediationCandidates, toTriageCount, triageRows } from './credit-allocations.js';
import { poolSummary, resolveRange, usageSeries } from './credit-usage.js';
import { knownAddresses } from './known-addresses.js';
import { TtlCache } from './ttl-cache.js';
import { AuditLog } from './audit-log.js';
import { IamStore, PERMISSIONS, generatePassword, publicUser } from './iam.js';
import { insideProject, migrateLegacyData, prepareDataDir, resolveDataDir } from './data-dir.js';
import { PENDING_RESTORE, applyPendingRestore, collectStateFiles, createBackup, describeBackup, listBackups, readBackup, writeBackupTo } from './backup.js';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { GitHubClient } from './github/client.js';
import { METHODS as GITHUB_METHODS, ensureClone, evaluate as evaluateGithub, loginFromNoreply, resolveLogins, usableEmail, validLogin } from './github/identity.js';
import { blameFindings, codeVersion, locationOf, parseRepoUrl } from './github/blame.js';
import { TrackedReports, computeProgress, matchesFilters, reportSummary } from './tracked-reports.js';
import { ReportFiles } from './report-files.js';
import { BULK_SEVERITIES, REPORT_TOP_N, generateHtmlReport, selectTopFindings } from './html-report.js';
import { buildReminder, buildReportData, buildReportEmail } from './reminder.js';
import { exampleLinks, projectUrl, riskUrl } from './links.js';
import { AutomationState, Scheduler } from './automation.js';
import { publicConnection } from './cxone/endpoints.js';
import { onMailFailure, sendReminderMail, sendTestEmail, testConnection } from './mailer.js';
import { SettingsStore, applyEnvironmentSmtp, hasEnvironmentSmtp, isVerified, parseAddressList, publicSettings, smtpFingerprint } from './settings.js';
import { ConnectionGuard, describeCxone, describeSmtp } from './connection-guard.js';
import { ENV_SETTINGS, SECRET_VARIABLES, parseEnvText, settingsFromEnv } from './env-import.js';
import { SessionPersistence, sessionKey } from './handover.js';
import { InstanceLock } from './instance-lock.js';
import { inlineScriptHashes, sameOriginGuard, securityHeaders } from './security.js';
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

const projectDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * All state lives in one folder outside the project (DATA_DIR, default
 * ~/.mission-zero), so a redeploy never touches it and one backup of it
 * rebuilds the server from scratch. See src/data-dir.js.
 */
const { dir: dataDir, source: dataDirSource } = resolveDataDir(process.env, { cwd: process.cwd() });
prepareDataDir(dataDir);
// One server per data folder: wait for the previous one (an update) to finish, or refuse.
const instanceLock = new InstanceLock(dataDir, { staleMs: Math.max(3, Number(process.env.INSTANCE_LOCK_STALE_SECONDS ?? 30)) * 1000 });
try {
  await instanceLock.acquire({ waitMs: Math.max(0, Number(process.env.INSTANCE_LOCK_WAIT_SECONDS ?? 45)) * 1000, onWait: (held) => console.log(`[data] Waiting for the previous server (host ${held.host}) to finish with ${dataDir}…`) });
} catch (error) {
  console.error(`! ${error.message}`);
  process.exit(1);
}
const migrated = migrateLegacyData(dataDir, { legacyDir: path.join(projectDir, 'data') });
if (migrated.length) {
  console.log(`[data] Copied ${migrated.length} file(s) from ${path.join(projectDir, 'data')} to ${dataDir}: ${migrated.join(', ')}`);
  console.log('[data] The old copies are left in place; delete them once this server runs well from the new folder.');
}
// A restore uploaded from the Audit page is applied here, before anything loads.
let restoredAtStart = null;
try {
  restoredAtStart = applyPendingRestore({ dataDir, settingsFile: config.settingsFile });
  if (restoredAtStart) {
    console.log(`[data] Restored ${restoredAtStart.restored.length} file(s) from the backup of ${restoredAtStart.createdAt}.`);
    if (restoredAtStart.replacedDir) console.log(`[data] The files it replaced are in ${restoredAtStart.replacedDir}.`);
  }
} catch (error) {
  console.error(`! [data] The staged restore could not be applied, and nothing was changed: ${error.message}`);
}
console.log(`[data] State folder: ${dataDir} (${dataDirSource})`);
if (insideProject(dataDir, projectDir)) {
  console.warn(`! The state folder ${dataDir} is inside the project folder: a redeploy could delete it. Set DATA_DIR to a folder outside it.`);
}

const sessions = new SessionStore({ idleMs: config.session.idleMs });
// Sign-ins outlive the process (updates, restarts, crashes): see src/handover.js.
const sessionPersistence = new SessionPersistence(dataDir);
let indexTimer = null;
/** Write who is signed in, soon (coalesced). */
function saveSignInsSoon() {
  if (indexTimer) return;
  indexTimer = setTimeout(() => {
    indexTimer = null;
    try {
      sessionPersistence.saveIndex(sessions.index());
    } catch (error) {
      console.warn(`! [sessions] Could not save sign-ins: ${error.message}`);
    }
  }, 200);
  indexTimer.unref?.();
}
sessions.onEnd = (key) => {
  sessionPersistence.forget(key);
  saveSignInsSoon();
};
/** Keep a session's fetched data across restarts (password sign-ins only). */
function saveFetchedData(session) {
  if (session?.linked && session.userId && !session.pinned && session.lastScan) sessionPersistence.saveScan(sessionKey(session.id), session.lastScan);
}
// Every minute: last-used times, and the data of sessions used since (verify, triage and refresh change it).
let savedAt = Date.now();
const persistTimer = setInterval(() => {
  const since = savedAt;
  savedAt = Date.now();
  saveSignInsSoon();
  for (const { session } of sessions.persistable()) if (session.lastUsedAt > since) saveFetchedData(session);
}, 60_000);
persistTimer.unref?.();
const settingsFile = config.settingsFile || path.join(dataDir, 'settings.json');
const settingsStore = new SettingsStore({ file: settingsFile });
settingsStore.applyEnvironment();
const settings = settingsStore.get();
if (process.env.SMTP_HOST) {
  console.log(`[SMTP] Loaded from environment: ${settings.smtp.host}:${settings.smtp.port}`);
}
let bootstrapSessionId = null;

knownAddresses.configure(path.join(dataDir, 'known-initiators.json'));
const creditLedger = new CreditLedger({ file: path.join(dataDir, 'triage-credits.json') });
/** Record triage or remediation sent for a project; its findings are about to change, so recent reads of it are dropped. */
function recordCreditUse(entry) {
  projectReads.forget(entry.projectId);
  return creditLedger.record(entry);
}
const allocations = new CreditAllocations({ file: path.join(dataDir, 'credit-allocations.json'), ledger: creditLedger });

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const trackedReports = new TrackedReports({ file: path.join(dataDir, 'tracked-reports.json') });
const reportFiles = new ReportFiles({ dir: path.join(dataDir, 'report-files'), ttlDays: 30 });
const guard = new ConnectionGuard({ file: path.join(dataDir, 'connection-guard.json') });
const audit = new AuditLog({ dir: path.join(dataDir, 'audit'), keyFile: path.join(dataDir, 'audit.key') });
if (restoredAtStart) {
  audit.record({
    type: 'backup',
    outcome: 'changed',
    reason: `State restored from the backup of ${restoredAtStart.createdAt} (host ${restoredAtStart.host}).`,
    actor: { kind: 'system', user: 'reminder server' },
    details: { restore: { createdAt: restoredAtStart.createdAt, files: restoredAtStart.files, sha256: restoredAtStart.sha256, replacedDir: restoredAtStart.replacedDir } },
  });
}

/** One line of untrusted text for the server log: no line breaks or control characters (log forging). */
const logSafe = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').slice(0, 500);

/** At most `max` distinct ids from a request field that should be an array of ids. */
const idList = (value, max = 5000) => (Array.isArray(value) ? [...new Set(value.map(String))].slice(0, max) : []);

// ---------------------------------------------------------------------------
// Users, roles and permissions (src/iam.js)
// ---------------------------------------------------------------------------

/** One request at a time per vulnerability, across every path that sends AI Triage or Remediation. */
const sendGuard = new SendGuard();
/** Usage, errors and discrepancies, privacy-safe, for the Logs page's troubleshooting download. */
const diagnostics = new Diagnostics({ file: path.join(dataDir, 'diagnostics.jsonl'), version: APP_VERSION });
onMailFailure((error) => diagnostics.error('mail-failed', error));
process.on('exit', () => diagnostics.flush());
const BUSY_REASON = 'Already being sent by another request (another report, user or tab); not sent twice.';
const noteBusy = (kind, busy) => busy.length && diagnostics.discrepancy('send-busy', { kind, count: busy.length });

const iam = new IamStore({ file: path.join(dataDir, 'iam.json') });
let setupCode = '';
const DEFAULT_ADMIN_EMAIL = 'admin@mission-zero.local';
/** The generated first administrator's one-time password, until they choose their own. */
const firstAdminFile = path.join(dataDir, 'first-admin-password.txt');

async function prepareAccess() {
  if (iam.hasUsers()) return;
  const email = process.env.ADMIN_EMAIL?.trim();
  const password = process.env.ADMIN_PASSWORD ?? '';
  if (email && password) {
    try {
      const admin = await iam.createUser({ email, name: 'Administrator', role: 'admin', password, mustChangePassword: true });
      audit.record({ type: 'iam', outcome: 'changed', reason: `First administrator ${admin.email} created from ADMIN_EMAIL.`, actor: SYSTEM_ACTOR, details: { user: admin } });
      console.log('[access] First administrator created from ADMIN_EMAIL; they choose a new password at first sign-in.');
      return;
    } catch (error) {
      console.warn(`! [access] ADMIN_EMAIL / ADMIN_PASSWORD could not be used: ${error.message}`);
    }
  }
  if (String(process.env.FIRST_ADMIN ?? '').trim() === 'setup-code') {
    // Nobody can use the utility until someone proves they can read this server's log.
    setupCode = randomBytes(9).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, 'X').match(/.{1,4}/g).join('-');
    console.log('');
    console.log('  No users yet. Open the utility and create the first administrator with this setup code:');
    console.log(`      ${setupCode}`);
    console.log('');
    return;
  }
  // Default (and in containers): generate the first administrator and print the
  // sign-in once, in this log. It is also kept in a file only this server's user
  // can read, until they choose their own password at first sign-in.
  const adminEmail = email || DEFAULT_ADMIN_EMAIL;
  const generated = generatePassword();
  const admin = await iam.createUser({ email: adminEmail, name: 'Administrator', role: 'admin', password: generated, mustChangePassword: true });
  fs.writeFileSync(firstAdminFile, `${generated}\n`, { mode: 0o600 });
  audit.record({ type: 'iam', outcome: 'changed', reason: `First administrator ${admin.email} created with a generated password (printed in the server log once).`, actor: SYSTEM_ACTOR, details: { user: admin } });
  const line = '='.repeat(64);
  console.log(`\n${line}`);
  console.log('  First start: an administrator was created. Sign in with:');
  console.log(`      Email:    ${admin.email}`);
  console.log(`      Password: ${generated}`);
  console.log('  You choose your own password at first sign-in. This is shown only once;');
  console.log(`  until then it is also in ${firstAdminFile}.`);
  console.log('  Lost it? Run: node scripts/reset-admin.mjs  (in a container: docker exec <name> node scripts/reset-admin.mjs)');
  console.log(`${line}\n`);
}

/** Projects someone just triaged or remediated in, so reports covering them refresh soon. */
const touchedProjects = new Map();
const touchProject = (projectId) => touchedProjects.set(projectId, Date.now());

/**
 * Per-project credits for the dashboard: what is allocated and used, and what
 * the findings need (never allocated until someone confirms it).
 */
function creditView(summary) {
  const { toRemediate, need, shortfall } = allocations.need(summary.projectId, summary.risks ?? []);
  return {
    ...allocations.balance(summary.projectId),
    toTriage: Object.fromEntries(SEVERITIES.map((s) => [s, toTriageCount(summary.risks ?? [], [s], Date.now(), creditLedger.triagedAt(summary.projectId))])),
    // The rows behind those results: rows sharing one Checkmarx One result are triaged, and charged, once.
    toTriageRows: Object.fromEntries(SEVERITIES.map((s) => [s, triageRows(summary.risks ?? [], [s], Date.now(), creditLedger.triagedAt(summary.projectId)).length])),
    // Confirmed findings to remediate, by severity, so any choice of severities can be costed.
    toRemediateBySeverity: Object.fromEntries(SEVERITIES.map((s) => [s, remediationCandidates(summary.risks ?? [], [s], creditLedger.remediatedIds(summary.projectId)).length])),
    toRemediate,
    need,
    shortfall,
    sharedResults: sharedResults(summary),
  };
}

/**
 * Findings still to triage that are one Checkmarx One result (several code
 * paths, or data flows, into the same vulnerable code): triaged, charged and
 * fixed together. Named so people can see which ones, and why.
 */
function sharedResults(summary) {
  const rows = triageRows(summary.risks ?? [], SEVERITIES, Date.now(), creditLedger.triagedAt(summary.projectId));
  const groups = new Map();
  for (const r of rows) {
    const unit = billingUnit(r);
    if (!groups.has(unit)) groups.set(unit, []);
    groups.get(unit).push(r);
  }
  const place = (location) => String(location ?? '').replace(/^.*[\\/]/, '');
  return [...groups.entries()]
    .filter(([, list]) => list.length > 1)
    .slice(0, 30)
    .map(([unit, list]) => ({
      severity: list[0].severity,
      title: list[0].title,
      findings: list.length,
      places: [...new Set(list.map((r) => place(r.location)).filter(Boolean))].slice(0, 4),
      // How Checkmarx One ties them: one result id (listed once per code path), or one similarity group (the same vulnerable code).
      tie: unit.startsWith('a:') ? 'result' : 'group',
      id: unit.slice(2, 10),
    }));
}

const reportGrants = new ReportGrants({
  secret: process.env.REPORT_SIGNING_KEY?.trim() || undefined,
  file: path.join(dataDir, 'report-signing.key'),
});

const automationState = new AutomationState({
  file: config.settingsFile
    ? config.settingsFile.replace(/\.json$/, '') + '-automation.json'
    : path.join(dataDir, 'automation-state.json'),
});

/**
 * The session unattended runs use. Automation has no browser to paste a key,
 * so it needs a credential that outlives a session: either CX_API_KEY, or one
 * the administrator explicitly armed from the Settings page.
 */
let automationSessionId = null;

/** Where the stored integration key connects: what the administrator entered, else the deployment's overrides. */
function integrationOverrides(settings = settingsStore.get()) {
  const stored = settings.integrationOverrides ?? {};
  return {
    baseUrl: stored.baseUrl || config.overrides.baseUrl,
    iamUrl: stored.iamUrl || config.overrides.iamUrl,
    tenant: stored.tenant || config.overrides.tenant,
  };
}

/**
 * The server's own Checkmarx One connection (the "integration"): used by
 * report triage, automation, and everyone who signed in with a password.
 */
function integrationSession() {
  return sessions.get(automationSessionId) ?? sessions.get(bootstrapSessionId);
}

/** Which key and endpoints a connection was made from (to tell a changed configuration from the running one). */
const cxoneFingerprint = (key, overrides = {}) =>
  createHash('sha256').update(JSON.stringify([key ?? '', overrides.baseUrl ?? '', overrides.iamUrl ?? '', overrides.tenant ?? ''])).digest('hex');
/** The fingerprint of the configuration the running integration session was made from. */
let integrationFingerprint = null;

/**
 * Make `session` the integration: it replaces the previous one, and the key and
 * endpoints it was made from become the last known good Checkmarx One configuration.
 */
function activateIntegration(session, key, overrides = {}) {
  session.pinned = true;
  const previous = automationSessionId;
  automationSessionId = session.id;
  integrationFingerprint = cxoneFingerprint(key, overrides);
  if (previous && previous !== session.id && previous !== bootstrapSessionId) sessions.destroy(previous);
  const { tenant, baseUrl, iamUrl } = session.connection;
  guard.recordGood('cxone', { apiKey: key, overrides: { baseUrl: overrides.baseUrl ?? '', iamUrl: overrides.iamUrl ?? '', tenant: overrides.tenant ?? '' }, connection: { tenant, baseUrl, iamUrl } });
  scheduler.sync();
}

async function resolveAutomationSession() {
  const existing = integrationSession();
  if (existing) return existing;

  const settings = settingsStore.get();
  const storedKey = settings.automationApiKey;
  if (!storedKey) return null;

  try {
    const session = await sessions.create(storedKey, integrationOverrides(settings));
    activateIntegration(session, storedKey, settings.integrationOverrides ?? {});
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
  // Runs send through the last known good mail server while a change waits to be checked.
  settingsStore: { get: () => sendingSettings() },
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
// Security headers on every response, including the static pages (src/security.js).
app.disable('x-powered-by');
app.use(securityHeaders({ scriptHashes: inlineScriptHashes(path.join(publicDir, 'index.html')) }));
// Big replies (the page's script, the fetch stream, full results, downloads) shrink
// 5-10x for a remote office or VPN: brotli or gzip at a quick level, the fetch stream
// flushed line by line. Small, frequent ones (report polls) are left alone: compressing
// hundreds a second costs a 2-CPU server more than it saves (docs/performance.md).
// HTTP_COMPRESSION=off leaves it all to a reverse proxy; HTTP_COMPRESSION_MIN_KB sets the size.
const COMPRESSION = String(process.env.HTTP_COMPRESSION ?? 'on').toLowerCase() !== 'off';
const COMPRESSION_MIN_BYTES = Math.max(0, Number(process.env.HTTP_COMPRESSION_MIN_KB ?? 32) || 0) * 1024;
if (COMPRESSION) {
  app.use(
    compression({
      threshold: COMPRESSION_MIN_BYTES,
      level: 4,
      brotli: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } },
      // The fetch stream has no length up front, so it is compressed whatever its size.
      filter: (req, res) => /ndjson/i.test(String(res.getHeader('Content-Type') ?? '')) || compression.filter(req, res),
    }),
  );
}
// Stopping for an update: requests in progress finish; new ones are told to retry in a moment
// (reports and the page do), so nothing is lost and nobody sees an error.
let draining = false;
let inFlight = 0;
app.use((req, res, next) => {
  if (draining) {
    res.set({ 'Retry-After': '3', Connection: 'close' });
    return res.status(503).json({ error: 'Mission Zero is restarting for an update. Trying again in a moment.', restarting: true, busy: true, retryAfter: 3 });
  }
  inFlight += 1;
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    inFlight -= 1;
  };
  res.on('finish', end);
  res.on('close', end);
  next();
});
app.use(express.json({ limit: '4mb' }));
// A browser request that changes state must come from this server's own pages.
app.use('/api', sameOriginGuard({ exempt: ['/relay'] }));
app.use('/api', (req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const route = req.route ? `${req.baseUrl}${req.route.path}` : '(unmatched)';
    if (route === '/api/health' || route === '/api/diagnostics/client-error') return;
    diagnostics.usage(`${req.method} ${route}`, { status: res.statusCode, ms: Date.now() - started });
  });
  next();
});
app.use(express.static(publicDir));

/**
 * The emailed report is opened from disk (origin "null"), so its calls to the
 * relay are cross-origin. No cookies are involved: every relay action is
 * authorised by the signed grants the report carries.
 */
app.use('/api/relay', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Max-Age', '600');
  res.set('Access-Control-Expose-Headers', 'Retry-After');
  // A report opened from disk calling a server on the company network: browsers
  // that enforce Private Network Access ask first, and this is the yes.
  if (req.get('access-control-request-private-network')) res.set('Access-Control-Allow-Private-Network', 'true');
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

/** The caller's signed-in session (every person signs in; there is no shared fallback). */
const currentSession = (req) => {
  const session = sessions.get(readSessionCookie(req));
  return session?.userId ? session : null;
};

/** Routes someone who must change their password may still use. */
const PASSWORD_CHANGE_ROUTES = new Set(['/api/me/password', '/api/session', '/api/me']);

/** Gate for every signed-in route: a live session of an active user. */
function requireSession(req, res, next) {
  const session = currentSession(req);
  const user = session ? iam.user(session.userId) : null;
  if (!session || !user || user.disabled) {
    if (session) sessions.destroy(session.id);
    return res.status(401).json({ error: 'Please sign in.', signIn: true });
  }
  if (user.mustChangePassword && session.via === 'password' && !PASSWORD_CHANGE_ROUTES.has(req.path)) {
    return res.status(403).json({ error: 'Choose a new password before continuing.', mustChangePassword: true });
  }
  req.session = session;
  req.user = user;
  req.permissions = iam.permissionsOf(user);
  // Password sessions use the integration; make sure it is up (it is re-created from the stored key if needed).
  if (session.linked && !integrationSession()) {
    resolveAutomationSession().then(() => next(), next);
    return;
  }
  next();
}

const can = (req, permission) => Boolean(req.permissions?.has(permission));

/** Signed in, and holding at least one of `permissions`. */
function requirePermission(...permissions) {
  return (req, res, next) =>
    requireSession(req, res, (error) => {
      if (error) return next(error);
      if (permissions.some((p) => req.permissions.has(p))) return next();
      const labels = permissions.map((p) => PERMISSIONS.find((x) => x.id === p)?.label ?? p);
      res.status(403).json({ error: `Your role does not allow this (needs “${labels.join('” or “')}”).`, permission: permissions[0] });
    });
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
    version: APP_VERSION,
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
/**
 * The troubleshooting log, for whoever maintains this server: which features
 * are used, where errors and discrepancies happen, and recommended fixes.
 * Holds no personal data, keys, findings or code (see src/diagnostics.js).
 */
app.get('/api/diagnostics/download', requirePermission('diagnostics.export'), async (req, res) => {
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
});

/** Script errors in the page, so bugs in the browser show up in the troubleshooting log too. */
app.post('/api/diagnostics/client-error', requireSession, (req, res) => {
  const b = req.body ?? {};
  const page = String(b.page ?? '').replace(/[^#/a-z-]/gi, '').slice(0, 40);
  diagnostics.record('client-error', 'page-script-error', {
    message: b.message, source: String(b.source ?? '').split('/').pop(), line: Number(b.line) || 0, column: Number(b.column) || 0, page, detail: b.stack,
  });
  res.status(204).end();
});

app.get('/api/metrics', requirePermission('system.metrics'), async (req, res) => {
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
});

/** What this browser may see about itself: who is signed in, what they may do, and the connection. */
function describeMe(session, user) {
  const permissions = [...iam.permissionsOf(user)];
  const integration = integrationSession();
  let tenant = '';
  try {
    tenant = integration?.connection?.tenant ?? '';
  } catch {}
  return {
    ...describeSession(session),
    user: publicUser(user),
    role: { id: user.role, name: iam.role(user.role)?.name ?? user.role },
    permissions,
    via: session.via,
    integration: { connected: Boolean(integration), tenant },
    // Connection settings put back because new ones did not work: shown once to each administrator.
    configNotices: iam.permissionsOf(user).has('integration.cxone') || iam.permissionsOf(user).has('integration.smtp') ? guard.unseen(user.id) : [],
  };
}

app.get('/api/session', (req, res) => {
  const session = currentSession(req);
  const user = session ? iam.user(session.userId) : null;
  if (!session || !user || user.disabled) {
    // First start: nobody has signed in yet, so point at the log with the generated sign-in.
    const users = iam.users();
    const firstStart = users.length > 0 && users.every((u) => !u.lastLoginAt);
    return res.json({ connected: false, signedIn: false, setup: !iam.hasUsers() && Boolean(setupCode), firstStart });
  }
  res.json(describeMe(session, user));
});

/** Sign-in attempts per address, to slow down guessing across many accounts. */
const signInAttempts = new Map();
function throttleSignIn(req, res) {
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (signInAttempts.get(ip) ?? []).filter((t) => now - t < 10 * 60 * 1000);
  recent.push(now);
  signInAttempts.set(ip, recent);
  if (signInAttempts.size > 10_000) signInAttempts.clear();
  if (recent.length > 30) {
    res.status(429).json({ error: 'Too many sign-in attempts from this address. Wait a few minutes.' });
    return true;
  }
  return false;
}

function auditAccess(req, outcome, reason, user = null, details) {
  audit.record({
    type: 'access',
    outcome,
    reason,
    actor: { kind: 'user', user: user?.email ?? '', ip: clientIp(req), userAgent: String(req.get('user-agent') ?? '').slice(0, 200) },
    ...(details ? { details } : {}),
  });
}

/** Sign in with an email and password; Checkmarx One is reached through the server's integration. */
app.post(
  '/api/session/password',
  asyncRoute(async (req, res) => {
    if (throttleSignIn(req, res)) return;
    const email = String(req.body?.email ?? '').trim();
    let user;
    try {
      user = await iam.signIn(email, String(req.body?.password ?? ''));
    } catch (error) {
      const known = error.userId ? iam.user(error.userId) : null;
      auditAccess(req, 'refused', `Sign-in refused for ${email || '(no email)'}: ${error.message}${error.locked ? ' Account locked.' : ''}`, known);
      throw error;
    }
    const session = sessions.createLinked(integrationSession);
    Object.assign(session, { userId: user.id, via: 'password' });
    saveSignInsSoon();
    setSessionCookie(req, res, session.id);
    auditAccess(req, 'info', `${user.email} signed in with a password.`, user);
    res.status(201).json(describeMe(session, user));
  }),
);

/**
 * Sign in with a Checkmarx One API key. The key's identity (email, username or
 * client id) must belong to a user here; the session then calls Checkmarx One
 * with that person's own key.
 */
app.post(
  '/api/session',
  asyncRoute(async (req, res) => {
    if (throttleSignIn(req, res)) return;
    if (!iam.hasUsers()) return res.status(403).json({ error: 'Create the first administrator before anyone signs in.', setup: true });
    // Identity comes from the token Checkmarx One issues for the key, so the key
    // may only ever be exchanged at this server's own, trusted Checkmarx One —
    // never at an address taken from the key or the browser, where anyone could
    // run a look-alike that vouches for any email.
    const trusted = trustedCheckmarxOne();
    if (!trusted) {
      return res.status(403).json({ error: 'Signing in with a Checkmarx One key works once an Admin has connected this server to Checkmarx One. Sign in with your email and password.' });
    }
    const session = await sessions.create(req.body?.apiKey, trusted);
    const identity = await session.client.identity();
    const seen = identity.email || identity.user || identity.clientId || 'unknown';
    const refuse = (message) => {
      sessions.destroy(session.id);
      auditAccess(req, 'refused', message, null, { identity: { ...identity }, tenant: session.connection.tenant });
      return res.status(403).json({ error: message });
    };
    const user = iam.findByCxIdentity(identity);
    if (!user) return refuse(`The Checkmarx One identity "${seen}" has no access to this utility. Ask an administrator to add it.`);
    if (user.disabled) return refuse(`${user.email} is disabled. Ask an administrator.`);
    Object.assign(session, { userId: user.id, via: 'cxone', cxUser: seen });
    iam.recordSignIn(user);
    setSessionCookie(req, res, session.id);
    auditAccess(req, 'info', `${user.email} signed in with a Checkmarx One API key (${seen}).`, user);
    res.status(201).json(describeMe(session, user));
  }),
);

/**
 * The Checkmarx One that key sign-ins are checked against: the integration's
 * endpoints, or the deployment's pinned CX_IAM_URL + CX_TENANT. null when neither.
 */
function trustedCheckmarxOne() {
  try {
    const connection = integrationSession()?.connection;
    if (connection) return { iamUrl: connection.iamUrl, baseUrl: connection.baseUrl, tenant: connection.tenant };
  } catch {}
  if (config.overrides.iamUrl && config.overrides.tenant) {
    return { iamUrl: config.overrides.iamUrl, baseUrl: config.overrides.baseUrl, tenant: config.overrides.tenant };
  }
  return null;
}

/** First start: whoever holds the setup code from the server log creates the first administrator. */
app.post(
  '/api/setup',
  asyncRoute(async (req, res) => {
    if (iam.hasUsers()) return res.status(409).json({ error: 'This utility already has an administrator.' });
    if (throttleSignIn(req, res)) return;
    const given = Buffer.from(String(req.body?.code ?? '').trim().toUpperCase());
    const expected = Buffer.from(setupCode);
    if (!setupCode || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      auditAccess(req, 'refused', 'First-administrator setup refused: wrong setup code.');
      return res.status(403).json({ error: 'Wrong setup code. It is printed in the server log at start-up.' });
    }
    // Claim the code before any await, so two requests cannot both create an administrator.
    const claimed = setupCode;
    setupCode = '';
    let admin;
    try {
      admin = await iam.createUser({
        email: req.body?.email,
        name: req.body?.name,
        role: 'admin',
        password: String(req.body?.password ?? ''),
        cxoneIdentities: req.body?.cxoneIdentities ?? [],
        mustChangePassword: false,
      });
    } catch (error) {
      setupCode = claimed; // e.g. a weak password: let them try again
      throw error;
    }
    const user = iam.user(admin.id);
    iam.recordSignIn(user);
    const session = sessions.createLinked(integrationSession);
    Object.assign(session, { userId: user.id, via: 'password' });
    saveSignInsSoon();
    setSessionCookie(req, res, session.id);
    audit.record({ type: 'iam', outcome: 'changed', reason: `First administrator ${admin.email} created with the setup code.`, actor: { kind: 'user', user: admin.email, ip: clientIp(req) }, details: { user: admin } });
    res.status(201).json(describeMe(session, user));
  }),
);

app.delete('/api/session', (req, res) => {
  const id = readSessionCookie(req);
  const session = id ? sessions.get(id) : null;
  if (session?.userId) auditAccess(req, 'info', `${iam.user(session.userId)?.email ?? 'Someone'} signed out.`, iam.user(session.userId));
  // Never the integration: signing out ends only this person's session.
  if (id && id !== automationSessionId && id !== bootstrapSessionId) sessions.destroy(id);
  clearSessionCookie(res);
  res.json({ connected: false, signedIn: false });
});

app.get('/api/me', requireSession, (req, res) => res.json(describeMe(req.session, req.user)));

/** Change one's own password (required after an administrator reset). */
app.post(
  '/api/me/password',
  requireSession,
  asyncRoute(async (req, res) => {
    const user = req.user;
    if (user.passwordHash) {
      try {
        await iam.signIn(user.email, String(req.body?.current ?? ''));
      } catch (error) {
        return res.status(error.status === 423 ? 423 : 400).json({ error: error.status === 423 ? error.message : 'Your current password is wrong.' });
      }
    }
    if (String(req.body?.next ?? '') === String(req.body?.current ?? '')) return res.status(400).json({ error: 'Choose a password different from the current one.' });
    await iam.setPassword(user.id, String(req.body?.next ?? ''), { mustChange: false });
    fs.rmSync(firstAdminFile, { force: true });
    audit.record({ type: 'iam', outcome: 'changed', reason: `${user.email} changed their password.`, actor: await adminActor(req) });
    res.json(describeMe(req.session, iam.user(user.id)));
  }),
);

// ---------------------------------------------------------------------------
// Access: users and roles
// ---------------------------------------------------------------------------

const actorOf = (req) => ({ actorPerms: req.permissions, actorId: req.user.id });

function iamView(req) {
  return {
    users: iam.users().map((u) => ({ ...u, canManage: can(req, 'iam.manage') && iam.canGrant(req.permissions, iam.permissionsOf({ ...iam.user(u.id), disabled: false })) && u.id !== req.user.id })),
    roles: iam.roles().map((r) => ({ ...r, canManage: can(req, 'iam.manage') && !r.locked && iam.canGrant(req.permissions, r.permissions), canAssign: can(req, 'iam.manage') && iam.canGrant(req.permissions, r.permissions) })),
    permissions: PERMISSIONS,
    me: { id: req.user.id, permissions: [...req.permissions] },
  };
}

async function auditIam(req, reason, details) {
  audit.record({ type: 'iam', outcome: 'changed', reason, actor: await adminActor(req), details });
}

/** Sign out every session of a user whose access was removed. */
function endSessionsOf(userId) {
  // Saved sign-ins nobody has come back for since a restart end too.
  sessions.endWhere((s) => s.userId === userId);
}

app.get('/api/iam', requirePermission('iam.view'), (req, res) => res.json(iamView(req)));

app.post(
  '/api/iam/users',
  requirePermission('iam.manage'),
  asyncRoute(async (req, res) => {
    const { email, name, role, password, cxoneIdentities } = req.body ?? {};
    const user = await iam.createUser({ email, name, role, password: password ? String(password) : '', cxoneIdentities, mustChangePassword: true }, actorOf(req));
    await auditIam(req, `Added ${user.email} as ${iam.role(user.role)?.name}.`, { user });
    res.status(201).json(iamView(req));
  }),
);

app.patch(
  '/api/iam/users/:id',
  requirePermission('iam.manage'),
  asyncRoute(async (req, res) => {
    const patch = {};
    for (const key of ['name', 'role', 'cxoneIdentities', 'disabled']) if (key in (req.body ?? {})) patch[key] = req.body[key];
    const { before, after } = iam.updateUser(req.params.id, patch, actorOf(req));
    const changes = Object.keys(patch).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    if (changes.length) {
      const what = changes.map((k) => (k === 'role' ? `role ${iam.role(before.role)?.name ?? before.role} → ${iam.role(after.role)?.name ?? after.role}` : k === 'disabled' ? (after.disabled ? 'disabled' : 'enabled') : k)).join(', ');
      await auditIam(req, `Changed ${after.email}: ${what}.`, { before, after });
    }
    if (after.disabled) endSessionsOf(after.id);
    res.json(iamView(req));
  }),
);

app.delete(
  '/api/iam/users/:id',
  requirePermission('iam.manage'),
  asyncRoute(async (req, res) => {
    const removed = iam.deleteUser(req.params.id, actorOf(req));
    endSessionsOf(removed.id);
    await auditIam(req, `Removed ${removed.email} (${iam.role(removed.role)?.name ?? removed.role}).`, { user: removed });
    res.json(iamView(req));
  }),
);

/** Set a temporary password; the user must choose their own at next sign-in. */
app.post(
  '/api/iam/users/:id/password',
  requirePermission('iam.manage'),
  asyncRoute(async (req, res) => {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Change your own password from your account menu.' });
    const user = await iam.setPassword(req.params.id, String(req.body?.password ?? ''), { mustChange: true, actorPerms: req.permissions });
    endSessionsOf(user.id);
    await auditIam(req, `Set a temporary password for ${user.email}.`);
    res.json(iamView(req));
  }),
);

app.post(
  '/api/iam/roles',
  requirePermission('iam.manage'),
  asyncRoute(async (req, res) => {
    const { after } = iam.saveRole(null, req.body ?? {}, actorOf(req));
    await auditIam(req, `Created role "${after.name}" (${after.permissions.length} permissions).`, { role: after });
    res.status(201).json(iamView(req));
  }),
);

app.put(
  '/api/iam/roles/:id',
  requirePermission('iam.manage'),
  asyncRoute(async (req, res) => {
    const { before, after } = iam.saveRole(req.params.id, req.body ?? {}, actorOf(req));
    const added = after.permissions.filter((p) => !before.permissions.includes(p));
    const removed = before.permissions.filter((p) => !after.permissions.includes(p));
    if (added.length || removed.length || before.description !== after.description || before.name !== after.name) {
      await auditIam(req, `Changed role "${after.name}"${added.length ? `: added ${added.join(', ')}` : ''}${removed.length ? `${added.length ? ';' : ':'} removed ${removed.join(', ')}` : ''}.`, { before, after });
    }
    res.json(iamView(req));
  }),
);

app.delete(
  '/api/iam/roles/:id',
  requirePermission('iam.manage'),
  asyncRoute(async (req, res) => {
    const removed = iam.deleteRole(req.params.id, actorOf(req));
    await auditIam(req, `Removed role "${removed.name}".`, { role: removed });
    res.json(iamView(req));
  }),
);

// ---------------------------------------------------------------------------
// Checkmarx One integration: the server's own connection (Admin)
// ---------------------------------------------------------------------------

function integrationStatus() {
  const session = integrationSession();
  const settings = settingsStore.get();
  let connection = null;
  try {
    connection = session ? publicConnection(session.connection) : null;
  } catch {}
  return {
    connected: Boolean(session),
    source: session ? (session.id === automationSessionId ? 'stored' : 'environment') : settings.automationApiKey ? 'stored (not reachable)' : 'none',
    keyStored: Boolean(settings.automationApiKey),
    environmentKey: Boolean(config.bootstrapApiKey),
    overrides: settings.integrationOverrides ?? { baseUrl: '', iamUrl: '', tenant: '' },
    connection,
    // Saved but not working yet: the running connection stays the last known good one.
    pending: cxonePending(settings),
    lastGood: lastGoodView('cxone'),
  };
}

app.get('/api/integration', requirePermission('settings.view', 'integration.cxone'), (req, res) => res.json(integrationStatus()));

/** Connect the server to Checkmarx One with an API key, verified first, then stored. */
app.post(
  '/api/integration/cxone',
  requirePermission('integration.cxone'),
  asyncRoute(async (req, res) => {
    const { apiKey, baseUrl = '', iamUrl = '', tenant = '' } = req.body ?? {};
    // Use this session's own key when none is pasted (signed in with a Checkmarx One key).
    const key = String(apiKey ?? '').trim() || (req.session.via === 'cxone' ? req.session.connection.apiKey : '');
    if (!key) return res.status(400).json({ error: 'Paste a Checkmarx One API key.' });
    const overrides = { baseUrl: String(baseUrl).trim().replace(/\/+$/, ''), iamUrl: String(iamUrl).trim().replace(/\/+$/, ''), tenant: String(tenant).trim() };
    const session = await withTimeout(
      sessions.create(key, {
        baseUrl: overrides.baseUrl || config.overrides.baseUrl,
        iamUrl: overrides.iamUrl || config.overrides.iamUrl,
        tenant: overrides.tenant || config.overrides.tenant,
      }),
      'Checkmarx One',
    );
    settingsStore.save({ automationApiKey: key, integrationOverrides: overrides });
    activateIntegration(session, key, overrides);
    audit.record({ type: 'settings', outcome: 'changed', reason: `Checkmarx One integration connected to tenant ${session.connection.tenant}.`, actor: await adminActor(req), details: { tenant: session.connection.tenant, baseUrl: session.connection.baseUrl } });
    res.json(integrationStatus());
  }),
);

app.delete(
  '/api/integration/cxone',
  requirePermission('integration.cxone'),
  asyncRoute(async (req, res) => {
    settingsStore.save({ automationApiKey: '' });
    if (automationSessionId) sessions.destroy(automationSessionId);
    automationSessionId = null;
    integrationFingerprint = null;
    audit.record({ type: 'settings', outcome: 'changed', reason: 'Stored Checkmarx One integration key removed.', actor: await adminActor(req) });
    res.json(integrationStatus());
  }),
);

// ---------------------------------------------------------------------------
// Last known good connections: settings save as typed; a change that does not
// work is rolled back (src/connection-guard.js)
// ---------------------------------------------------------------------------

const CONNECTION_CHECK_TIMEOUT_MS = Math.max(1000, Number(process.env.CONNECTION_CHECK_TIMEOUT_MS) || 25_000);
const ROLLBACK_IDLE_MS = Math.max(1, Number(process.env.CONFIG_ROLLBACK_IDLE_MINUTES) || 10) * 60_000;

/** Reject when `promise` takes longer than the connection check allows. */
function withTimeout(promise, label, ms = CONNECTION_CHECK_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error(`${label} did not answer within ${Math.round(ms / 1000)} seconds (connection timed out).`), { status: 504, timedOut: true })),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A stored integration key or endpoints that differ from the running connection. */
function cxonePending(settings = settingsStore.get()) {
  return Boolean(settings.automationApiKey) && cxoneFingerprint(settings.automationApiKey, settings.integrationOverrides ?? {}) !== integrationFingerprint;
}

/** Mail server settings that have not passed a connection test. */
function smtpPending(settings = settingsStore.get()) {
  return !isVerified(settings) && (Boolean(settings.smtp.host) || Boolean(guard.lastGood('smtp')));
}

/**
 * The settings mail is sent with: the current ones, except that while a
 * changed mail server waits to be checked, the last known good one keeps
 * sending — so editing Settings never stops reminders.
 */
function sendingSettings(settings = settingsStore.get()) {
  if (!smtpPending(settings)) return settings;
  const good = guard.lastGood('smtp');
  if (!good) return settings;
  const { at, ...smtp } = good;
  return { ...settings, smtp, verifiedAt: at, verifiedFingerprint: smtpFingerprint(smtp) };
}

/** What the last known good configuration of a part was (no secrets). */
function lastGoodView(part) {
  const good = guard.lastGood(part);
  if (!good) return null;
  return { ...(part === 'cxone' ? describeCxone(good) : describeSmtp(good)), at: good.at, ...(part === 'cxone' && !good.apiKey ? { source: 'environment' } : {}) };
}

function connectionStatus(settings = settingsStore.get()) {
  return {
    pending: { cxone: cxonePending(settings), smtp: smtpPending(settings) },
    lastGood: { cxone: lastGoodView('cxone'), smtp: lastGoodView('smtp') },
    changedAt: guard.changedAt,
    rollbackAfterMinutes: ROLLBACK_IDLE_MS / 60_000,
  };
}

/** Checks run one at a time: a second caller waits for the first and then checks again. */
let checkQueue = Promise.resolve();
function checkConnections(options) {
  const run = checkQueue.then(() => runConnectionCheck(options));
  checkQueue = run.catch(() => {});
  return run;
}

/**
 * Try every changed connection setting. One that works becomes the last known
 * good one. One that fails stays saved (so it can be corrected) unless
 * `rollback`: then the last known good configuration is put back, and a notice
 * tells every administrator what happened. A configuration identical to the
 * last known good one is never "rolled back" — that failure is an outage.
 */
async function runConnectionCheck({ rollback = false, trigger = 'check', actor = null } = {}) {
  const result = { cxone: null, smtp: null, notice: null };
  const parts = [];
  const who = actor?.user || actor?.kind || '';

  let settings = settingsStore.get();
  if (cxonePending(settings)) {
    const key = settings.automationApiKey;
    const overrides = { baseUrl: '', iamUrl: '', tenant: '', ...(settings.integrationOverrides ?? {}) };
    const tried = cxoneFingerprint(key, overrides);
    try {
      const session = await withTimeout(sessions.create(key, integrationOverrides(settings)), 'Checkmarx One');
      if (cxoneFingerprint(settingsStore.get().automationApiKey, settingsStore.get().integrationOverrides ?? {}) !== tried) {
        sessions.destroy(session.id);
        result.cxone = { ok: false, superseded: true };
      } else {
        activateIntegration(session, key, overrides);
        result.cxone = { ok: true, tenant: session.connection.tenant };
        audit.record({ type: 'settings', outcome: 'changed', reason: `Checkmarx One integration checked and in use (tenant ${session.connection.tenant}).`, actor: actor ?? SYSTEM_ACTOR, details: { tenant: session.connection.tenant, baseUrl: session.connection.baseUrl, trigger } });
      }
    } catch (error) {
      result.cxone = { ok: false, error: error.message, timedOut: Boolean(error.timedOut) };
      const good = guard.lastGood('cxone');
      const current = settingsStore.get();
      const unchanged = cxoneFingerprint(current.automationApiKey, current.integrationOverrides ?? {}) === tried;
      if (rollback && good && unchanged && cxoneFingerprint(good.apiKey, good.overrides) !== tried) {
        settingsStore.save({ automationApiKey: good.apiKey, integrationOverrides: good.overrides });
        if (!good.apiKey) {
          // The last working connection was the environment's CX_API_KEY.
          if (automationSessionId && automationSessionId !== bootstrapSessionId) sessions.destroy(automationSessionId);
          automationSessionId = null;
          integrationFingerprint = null;
        } else if (cxoneFingerprint(good.apiKey, good.overrides) !== integrationFingerprint || !integrationSession()) {
          automationSessionId = null;
          await resolveAutomationSession();
        }
        result.cxone.rolledBack = true;
        parts.push({ part: 'cxone', error: error.message, timedOut: Boolean(error.timedOut), attempted: describeCxone({ overrides }), restored: describeCxone(good), restoredAt: good.at });
      }
    }
  }

  settings = settingsStore.get();
  if (smtpPending(settings)) {
    const good = guard.lastGood('smtp');
    const tried = smtpFingerprint(settings.smtp);
    const attempted = describeSmtp(settings.smtp);
    try {
      const outcome = await withTimeout(testConnection(settings.smtp), 'The mail server');
      if (smtpFingerprint(settingsStore.get().smtp) !== tried) {
        result.smtp = { ok: false, superseded: true };
      } else {
        settingsStore.markVerified();
        guard.recordGood('smtp', settingsStore.get().smtp);
        result.smtp = { ok: true, host: settings.smtp.host, message: outcome?.message ?? '' };
      }
    } catch (error) {
      result.smtp = { ok: false, error: error.message, timedOut: Boolean(error.timedOut) || /timed? ?out|ETIMEDOUT/i.test(error.message) };
      const unchanged = smtpFingerprint(settingsStore.get().smtp) === tried;
      if (rollback && good && unchanged && smtpFingerprint(good) !== tried) {
        settingsStore.restoreSmtp(good);
        result.smtp.rolledBack = true;
        parts.push({ part: 'smtp', error: error.message, timedOut: result.smtp.timedOut, attempted, restored: describeSmtp(good), restoredAt: good.at });
      }
    }
  }

  if (parts.length) {
    result.notice = guard.addNotice({ trigger, actor: who, parts });
    audit.record({
      type: 'settings',
      outcome: 'changed',
      reason: `Rolled back to the last known good ${parts.map((p) => (p.part === 'cxone' ? 'Checkmarx One integration' : 'mail server settings')).join(' and ')}: the new ${parts.length > 1 ? 'ones' : 'one'} did not work (${trigger}).`,
      actor: actor ?? SYSTEM_ACTOR,
      details: { rollback: parts },
    });
    console.warn(`! [settings] ${parts.map((p) => `${p.part} rolled back: ${p.error}`).join('; ')}`);
  }
  if (rollback) guard.settle();
  return { ...result, status: connectionStatus() };
}

/** Changes nobody is checking (the browser closed mid-edit) are checked once they have been left alone a while. */
const idleCheck = setInterval(() => {
  const changedAt = guard.changedAt;
  if (!changedAt || Date.now() - Date.parse(changedAt) < ROLLBACK_IDLE_MS) return;
  if (!cxonePending() && !smtpPending()) return guard.settle();
  checkConnections({ rollback: true, trigger: 'no change for a while' }).catch((error) => console.warn(`! [settings] Connection check failed: ${error.message}`));
}, Math.min(60_000, ROLLBACK_IDLE_MS));
idleCheck.unref?.();

const mayChangeConnections = (req) => can(req, 'integration.cxone') || can(req, 'integration.smtp');

app.get('/api/settings/connections', requirePermission('settings.view', 'integration.cxone', 'integration.smtp'), (req, res) => {
  res.json(connectionStatus());
});

/** Check changed connection settings now; `rollback` puts back the last known good ones that fail (on leaving Settings). */
app.post(
  '/api/settings/connections/check',
  requirePermission('integration.cxone', 'integration.smtp'),
  asyncRoute(async (req, res) => {
    const rollback = req.body?.rollback === true;
    const trigger = rollback ? 'left the Settings page' : 'check';
    const result = await checkConnections({ rollback, trigger, actor: await adminActor(req) });
    // The person who was there has seen it: they are not shown it again at sign-in.
    if (result.notice && req.body?.present !== false) guard.acknowledge(req.user.id, [result.notice.id]);
    res.json(result);
  }),
);

/** Save the integration key and endpoints as typed, without connecting yet (the check decides). */
app.put(
  '/api/integration/cxone/draft',
  requirePermission('integration.cxone'),
  asyncRoute(async (req, res) => {
    const body = req.body ?? {};
    const current = settingsStore.get();
    const clean = (v) => String(v ?? '').trim().replace(/\/+$/, '');
    const overrides = { ...(current.integrationOverrides ?? { baseUrl: '', iamUrl: '', tenant: '' }) };
    for (const field of ['baseUrl', 'iamUrl', 'tenant']) if (field in body) overrides[field] = clean(body[field]);
    const key = String(body.apiKey ?? '').trim();
    const before = cxoneFingerprint(current.automationApiKey, current.integrationOverrides ?? {});
    settingsStore.save({ ...(key ? { automationApiKey: key } : {}), integrationOverrides: overrides });
    const after = settingsStore.get();
    if (cxoneFingerprint(after.automationApiKey, after.integrationOverrides ?? {}) !== before) guard.touch();
    res.json(integrationStatus());
  }),
);

/** Configure from an uploaded .env file: the variables this person may set are saved, then checked. */
app.post(
  '/api/settings/import-env',
  requirePermission('integration.cxone', 'integration.smtp', 'settings.links', 'beta.use'),
  asyncRoute(async (req, res) => {
    const vars = parseEnvText(req.body?.text);
    const { changes, applied, refused, ignored } = settingsFromEnv(vars, (permission) => can(req, permission));
    if (!applied.length) {
      if (refused.length) return res.status(403).json({ error: `Your role cannot set ${refused.join(', ')}.`, applied, refused, ignored });
      const blank = Object.keys(vars).some((name) => ENV_SETTINGS[name]);
      return res.status(400).json({
        error: blank
          ? 'Every setting in that file is blank, so nothing changed. Fill in the values you want to set (blank ones keep what is set now) and upload it again.'
          : 'No setting this page understands was found in that file.',
        applied, refused, ignored,
      });
    }
    if (changes.cxone) {
      const current = settingsStore.get();
      const { apiKey, ...endpoints } = changes.cxone;
      // Endpoints the file leaves out are derived from the key, as at start-up.
      settingsStore.save({ ...(apiKey ? { automationApiKey: apiKey } : {}), integrationOverrides: { baseUrl: '', iamUrl: '', tenant: '', ...(apiKey ? {} : current.integrationOverrides ?? {}), ...endpoints } });
    }
    if (changes.smtp) settingsStore.save({ smtp: changes.smtp });
    if (changes.links) settingsStore.save({ links: changes.links });
    if (changes.github) settingsStore.save({ beta: { github: changes.github } });
    guard.touch();
    const actor = await adminActor(req);
    audit.record({ type: 'settings', outcome: 'changed', reason: `Settings imported from a .env file: ${applied.join(', ')}.`, actor, details: { applied, refused, ignored, secrets: applied.filter((n) => SECRET_VARIABLES.has(n)) } });
    const check = await checkConnections({ rollback: false, trigger: 'import', actor });
    res.json({ applied, refused, ignored, check, settings: settingsFor(req, settingsStore.get()), integration: integrationStatus() });
  }),
);

/** Rollback notices this person has seen. */
app.post('/api/settings/notices/ack', requireSession, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  res.json({ acknowledged: guard.acknowledge(req.user.id, ids) });
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Which permission each part of the settings needs to be changed. */
const SETTINGS_SECTIONS = {
  smtp: 'integration.smtp',
  recipients: 'settings.recipients',
  initiators: 'settings.initiators',
  template: 'settings.template',
  branding: 'settings.branding',
  links: 'settings.links',
  automation: 'settings.automation',
  endpoints: 'integration.cxone',
  beta: 'beta.use',
};

/**
 * Keep only what this person may change. Sections they may not change are
 * dropped (and reported), so a form posted whole cannot slip them through.
 */
function permittedSettings(req, body = {}) {
  const allowed = {};
  const ignored = [];
  for (const [key, value] of Object.entries(body ?? {})) {
    if (key === 'aiTriage' && value && typeof value === 'object') {
      // The credit pool (size and period) is the Admin's; the rest is the AI settings permission's.
      const { monthlyCreditLimit, poolPeriod, ...rules } = value;
      const ai = {};
      if (Object.keys(rules).length) {
        if (can(req, 'settings.ai')) Object.assign(ai, rules);
        else ignored.push('aiTriage');
      }
      for (const [field, given] of [['monthlyCreditLimit', monthlyCreditLimit], ['poolPeriod', poolPeriod]]) {
        if (given === undefined) continue;
        if (can(req, 'credits.limit')) ai[field] = given;
        else ignored.push(`aiTriage.${field}`);
      }
      if (Object.keys(ai).length) allowed.aiTriage = ai;
    } else if (SETTINGS_SECTIONS[key] && can(req, SETTINGS_SECTIONS[key])) {
      allowed[key] = value;
    } else {
      ignored.push(key);
    }
  }
  return { allowed, ignored };
}

/** Settings as this person may see them (secrets are never sent to anyone). */
function settingsFor(req, settings) {
  const view = publicSettings(settings);
  if (!can(req, 'settings.view') && !can(req, 'integration.smtp')) view.smtp = { passwordSet: view.smtp.passwordSet };
  if (!can(req, 'beta.use')) delete view.beta;
  return view;
}

app.get('/api/settings', requireSession, (req, res) => {
  const settings = settingsStore.get();
  res.json({
    ...settingsFor(req, settings),
    // Rendered from the current templates so a wrong UI route is visible
    // without having to send a mail to find out.
    linkExamples: exampleLinks(req.session.connection, settings.links),
  });
});

app.put(
  '/api/settings',
  requireSession,
  asyncRoute(async (req, res) => {
    const { allowed, ignored } = permittedSettings(req, req.body ?? {});
    if (!Object.keys(allowed).length) {
      return res.status(403).json({ error: 'Your role cannot change these settings.', ignored });
    }
    const before = creditSettingsOf(settingsStore.get());
    const smtpBefore = smtpFingerprint(settingsStore.get().smtp);
    const saved = settingsStore.save(allowed);
    // A changed mail server is checked (and rolled back if it fails) when the editor leaves Settings, or after a while.
    if (smtpFingerprint(saved.smtp) !== smtpBefore) guard.touch();
    auditSettings(await adminActor(req), before, creditSettingsOf(saved));
    res.json({
      ...settingsFor(req, saved),
      ignored,
      linkExamples: exampleLinks(req.session.connection, saved.links),
    });
  }),
);

/** Run the SMTP handshake; success is what unlocks sending. */
app.post(
  '/api/settings/smtp/test',
  requirePermission('integration.smtp'),
  asyncRoute(async (req, res) => {
    // Persist the whole form first, so testing never discards edits the
    // administrator has made to other fields, and so the test always reflects
    // what is on screen rather than what was last saved.
    // Only the mail server part of the form is saved here: this route is the SMTP permission's.
    const settings = req.body?.smtp ? settingsStore.save({ smtp: req.body.smtp }) : settingsStore.get();
    const result = await testConnection(settings.smtp);
    const saved = settingsStore.markVerified();
    guard.recordGood('smtp', saved.smtp);
    res.json({ ...result, settings: settingsFor(req, saved) });
  }),
);

app.post(
  '/api/settings/smtp/send-test',
  requirePermission('integration.smtp'),
  asyncRoute(async (req, res) => {
    const [to] = parseAddressList(req.body?.to ?? '');
    const result = await sendTestEmail(settingsStore.get().smtp, to);
    res.json(result);
  }),
);

/** Render the stored template against sample data, for the editor preview. */
app.post(
  '/api/settings/template/preview',
  requirePermission('settings.template', 'reminders.send', 'settings.view'),
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
  requirePermission('integration.cxone'),
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
  requirePermission('initiators.tag'),
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

    res.json({ initiator, email, projectsUpdated, settings: settingsFor(req, saved) });
  }),
);

// ---------------------------------------------------------------------------
// Automation
// ---------------------------------------------------------------------------

app.get('/api/automation', requirePermission('settings.view', 'settings.automation'), (req, res) => {
  const settings = settingsStore.get();
  res.json({
    ...scheduler.status,
    config: settings.automation,
    keyStored: Boolean(settings.automationApiKey),
    bootstrapKey: Boolean(config.bootstrapApiKey),
    canRun: Boolean(sessions.get(automationSessionId) ?? sessions.get(bootstrapSessionId)),
    smtpVerified: isVerified(settings),
    smtpConfigured: Boolean(settings.smtp.host),
    // The panel says what runs will use: the integration, as the Checkmarx One section shows it.
    integration: integrationStatus(),
    connections: connectionStatus(settings),
  });
});

app.put(
  '/api/automation',
  requirePermission('settings.automation'),
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
  requirePermission('integration.cxone'),
  asyncRoute(async (req, res) => {
    if (req.session.via !== 'cxone') {
      return res.status(400).json({ error: 'Signed in with a password: connect the server under Settings → Connection with an API key instead.' });
    }
    // A session of its own for the integration: never this person's (which carries their access).
    const { apiKey, iamUrl, baseUrl, tenant } = req.session.connection;
    const integration = await sessions.create(apiKey, { iamUrl, baseUrl, tenant });
    settingsStore.save({ automationApiKey: apiKey, integrationOverrides: { iamUrl, baseUrl, tenant } });
    activateIntegration(integration, apiKey, { iamUrl, baseUrl, tenant });
    audit.record({ type: 'settings', outcome: 'changed', reason: `Checkmarx One integration armed with ${req.user.email}'s key (tenant ${tenant}).`, actor: await adminActor(req) });
    scheduler.sync();
    res.json({ ...scheduler.status, keyStored: true, canRun: true });
  }),
);

app.delete('/api/automation/arm', requirePermission('integration.cxone'), (req, res) => {
  settingsStore.save({ automationApiKey: '' });
  if (automationSessionId && automationSessionId !== bootstrapSessionId) sessions.destroy(automationSessionId);
  automationSessionId = null;
  integrationFingerprint = null;
  res.json({ ...scheduler.status, keyStored: false, canRun: Boolean(sessions.get(bootstrapSessionId)) });
});

/** Run a pass now, without waiting for the timer. */
app.post(
  '/api/automation/run',
  requirePermission('settings.automation'),
  asyncRoute(async (req, res) => {
    // Runs on the server's integration, like the scheduled runs it rehearses.
    if (!(await resolveAutomationSession())) {
      return res.status(409).json({ error: 'Connect the server to Checkmarx One first (Settings → Checkmarx One).' });
    }
    const run = await scheduler.tick({ force: true });
    res.json({ run, status: scheduler.status });
  }),
);

/** Forget every reported pair, so the next run reports from scratch. */
app.post('/api/automation/reset', requirePermission('settings.automation'), (req, res) => {
  automationState.reset();
  res.json(scheduler.status);
});

// ---------------------------------------------------------------------------
// Dashboard data
// ---------------------------------------------------------------------------

/** Projects (by id) and people the dashboard named to fetch, from repeated query parameters. */
function fetchScope(query) {
  const list = (value, max) =>
    [...new Set([].concat(value ?? []).map((v) => String(v).trim()).filter(Boolean))].slice(0, max).map((v) => v.slice(0, 200));
  return { projectIds: list(query.project, 500), initiators: list(query.initiator, 100) };
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
    const projects = await listProjects(client);
    let scans = {};
    let warning = null;
    try {
      scans = await getLastScans(client, projects.map((p) => p.id));
    } catch (error) {
      warning = `Who ran each project's latest scan could not be read: ${error.message}`;
    }
    const settings = settingsStore.get();
    const people = new Map();
    for (const project of projects) {
      const scan = scans[project.id];
      const initiator = scanInitiator(scan);
      if (!initiator) continue;
      const entry = people.get(initiator.toLowerCase()) ?? { initiator, email: scanInitiatorEmail(scan) || initiatorEmailOf(initiator, settings), projects: 0 };
      entry.projects += 1;
      people.set(initiator.toLowerCase(), entry);
    }
    const data = {
      projects: projects.map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name)),
      initiators: [...people.values()].sort((a, b) => b.projects - a.projects || a.initiator.localeCompare(b.initiator)),
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

async function runScan(req, { onStart, onProject } = {}) {
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
  // Named projects or people: fetched whatever their last scan date (they were
  // asked for by hand); otherwise the activity window decides.
  const scope = fetchScope(req.query);
  let projects, skipped, warning, lastScans;
  if (scope.projectIds.length || scope.initiators.length) {
    lastScans = scope.initiators.length ? await getLastScans(client, allProjects.map((p) => p.id)) : {};
    projects = projectsInScope(allProjects, scope, lastScans, (username) => initiatorEmailOf(username, settings));
    skipped = allProjects.length - projects.length;
    warning = projects.length ? null : 'No project matches the projects or people named in the scope.';
  } else {
    ({ projects, skipped, warning, lastScans } = await filterProjectsByActivity(client, allProjects, activityWindow));
  }
  // Each project's latest scan: whose it is (for reminders), and whether a
  // recent read of it by someone else is still current (see projectReads).
  if (!Object.keys(lastScans ?? {}).length && projects.length) {
    lastScans = await getLastScans(client, projects.map((p) => p.id)).catch(() => ({}));
  }
  onStart?.({ total: projects.length, projectsTotal: allProjects.length, projectsSkipped: skipped });

  // Rows shown while the rest is still being read: the initiator comes from the
  // latest scan already in hand; addresses and confidence follow with the result.
  const earlyRow = (summary) => {
    const scan = lastScans?.[summary.projectId];
    return projectRow({
      ...summary,
      initiator: scan ? scanInitiator(scan) ?? '' : '',
      initiatorEmail: scan ? scanInitiatorEmail(scan) ?? '' : '',
      initiatorVia: 'none',
      initiatorSuggestion: '',
      initiatorConfidence: 'none',
      lastScanDate: scan ? lastScanDate(scan) : null,
      url: projectUrl(summary, req.session.connection, settings.links),
      credits: creditView(summary),
    });
  };

  // Who ran each project's *latest* scan (so a rescan moves the reminder to
  // whoever ran it most recently), and the findings: independent, so both at once.
  const [initiators, result] = await Promise.all([
    collectInitiators(client, req.session.connection, projects, {
      rules: settings.initiators,
      useDirectory: settings.initiators.useDirectory,
      concurrency: config.concurrency,
      lastScans: Object.keys(lastScans ?? {}).length ? lastScans : undefined,
      memory: knownAddresses,
    }),
    collectProjectRisks(client, active, projects, {
      detectionWindow,
      onProject: onProject ? (summary) => onProject(earlyRow(summary)) : null,
      shared: { identity: readerIdentity(req.session), lastScans, fresh: req.query.fresh === '1' },
    }),
  ]);
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
  result.detectionWindow = detectionWindow;
  for (const summary of result.projects) {
    if (summary.error) diagnostics.discrepancy('project-read-failed', { project: summary.projectId, message: summary.error });
  }
  diagnostics.usage('fetch-complete', { projects: result.projects.length, reused: result.reused ?? 0, findings: result.projects.reduce((n, p) => n + p.totalRisks, 0), ms: Date.now() - started });
  // Fetching shows what the findings need; it never allocates anything.
  for (const summary of result.projects) summary.credits = creditView(summary);
  req.session.lastScan = result;

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
    scope: { projects: scope.projectIds.length, initiators: scope.initiators },
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
      projects: scope.projectIds,
      initiators: scope.initiators,
    },
  };
  saveFetchedData(req.session);
  return response;
}

/**
 * The data this person fetched last, as the fetch returned it, with credits as
 * they are now: after a page reload or a server restart the Dashboard shows it
 * again without reading Checkmarx One. 204 when nothing was fetched yet.
 */
app.get('/api/scan/last', requirePermission('findings.fetch'), (req, res) => {
  const scan = req.session.lastScan;
  if (!scan?.view || fetchInProgress(req.session)) return res.status(204).end();
  for (const p of scan.projects) p.credits = creditView(p);
  res.json({ ...scan.view, initiators: scan.initiators, projects: scan.projects.map(projectRow), restored: true });
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
    req.session.fetching = { id, startedAt: Date.now() };
    const release = () => {
      if (req.session.fetching?.id === id) delete req.session.fetching;
    };
    if (req.query.stream !== '1') {
      try {
        return res.json(await runScan(req));
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
      });
      release();
      send({ type: 'done', ...result });
    } catch (error) {
      release();
      const expected = Number.isInteger(error.status) && error.status >= 400 && error.status < 600;
      console.error(`GET /api/scan (stream) -> ${logSafe(expected ? error.message : error.stack ?? error.message)}`);
      diagnostics.error('fetch-failed', error, { status: expected ? error.status : 500 });
      send({ type: 'error', status: expected ? error.status : 500, error: expected ? error.message : 'Something went wrong on the server. The details are in its log.' });
    } finally {
      release();
      res.end();
    }
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
      console.warn(`[reminders] could not read live states for ${logSafe(projectId)}: ${logSafe(error.message)}`);
    }
  });
  const current = risks
    .map((r) => {
      const state = live.get(r.projectId)?.get(r.riskId);
      return state && state !== r.state ? { ...r, state } : r;
    })
    .filter((r) => !NOT_EXPLOITABLE_STATES.has(r.state));
  // AI Triage can propose "not exploitable" while the finding still reads To verify:
  // look at the verdict of everything this utility sent for triage, and leave those out too.
  const sent = new Map();
  const askAi = current.filter((r) => {
    if (r.state && r.state !== 'TO_VERIFY') return false;
    if (!sent.has(r.projectId)) sent.set(r.projectId, creditLedger.triagedAt(r.projectId));
    return r.groupId && alreadySent(r, sent.get(r.projectId));
  });
  const verdictNotExploitable = new Set();
  await mapWithConcurrency(askAi, 6, async (r) => {
    const { key, load, ttl } = triageLookup(session, r);
    try {
      const answer = await relayCache.wrap(key, load, ttl);
      if (NOT_EXPLOITABLE_STATES.has(String(answer?.body?.triageStatus ?? '').toUpperCase())) verdictNotExploitable.add(r);
    } catch {}
  });
  return verdictNotExploitable.size ? current.filter((r) => !verdictNotExploitable.has(r)) : current;
}

/**
 * The findings a reminder covers: the selected projects (all when none),
 * narrowed to the projects whose latest scan the picked initiators ran,
 * without anything not exploitable.
 */
async function reminderScope(session, scan, { projectIds = null, buckets = [], severities = null, initiators = null } = {}) {
  const initiatorsByProject = scan.initiators ?? {};
  let scoped = idList(projectIds);
  scoped = scoped.length ? scoped : null;
  // Narrowing by initiator is a project-level filter: a finding belongs to
  // whoever ran that project's latest scan.
  if (idList(initiators, 1000).length > 0) {
    const wanted = new Set(idList(initiators, 1000));
    const matching = Object.entries(initiatorsByProject)
      .filter(([, info]) => wanted.has(info.email) || wanted.has(info.initiator))
      .map(([projectId]) => projectId);
    scoped = scoped ? matching.filter((id) => scoped.includes(id)) : matching;
  }
  const risks = await withoutNotExploitable(session, selectRisks(scan.projects, {
    projectIds: scoped,
    buckets: Array.isArray(buckets) ? buckets : [],
    severities,
  }));
  return { risks, initiatorsByProject };
}

/** Who ran a project's latest scan, as reminders are addressed: their email, else their username. */
const initiatorKey = (info = {}) => info.email || info.initiator || '';

/**
 * One group per scan initiator ('initiator') or per project ('project'). A
 * person is only ever sent projects whose latest scan they ran: checked here
 * for every group, so no format or caller can mail anyone a project that is
 * not theirs.
 */
function initiatorGroups(risks, initiatorsByProject, groupBy) {
  const groups = groupBy === 'project' ? groupRisksByProject(risks, initiatorsByProject) : groupRisksByInitiator(risks, initiatorsByProject);
  for (const group of groups) {
    const key = group.email || group.initiator || '';
    const stray = group.risks.find((r) => !group.projectIds.includes(r.projectId) || initiatorKey(initiatorsByProject[r.projectId]) !== key);
    if (stray) {
      throw Object.assign(new Error(`Refused to send: ${stray.projectName} is not a project ${key || 'this person'} scanned.`), { status: 500 });
    }
    group.projectNames = [...new Set(group.risks.map((r) => r.projectName))].sort();
  }
  return groups;
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
    const settings = sendingSettings();

    // An empty bucket list means "no age filter", so a selection of projects or
    // initiators is enough on its own to send.
    const ageBuckets = Array.isArray(buckets) ? buckets : [];
    const { risks, initiatorsByProject } = await reminderScope(session, scan, { projectIds, buckets: ageBuckets, severities, initiators: wantedInitiators });
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
      const groups = initiatorGroups(risks, initiatorsByProject, groupBy);
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
        reminder: buildReminder(group.risks, settings.template, {
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
            projects: group.projectNames,
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
          // Exactly these addresses: without `exact`, an empty Cc/Bcc would fall
          // back to the configured list and copy everyone on this person's projects.
          const result = await sendReminderMail(settings, reminder, {
            exact: true,
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
            projects: group.projectNames,
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
            projects: [...new Set(risks.map((risk) => risk.projectName))].sort(),
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
  requirePermission('reminders.send'),
  asyncRoute(async (req, res) => {
    if (!req.session.lastScan) {
      return res.status(409).json({ error: 'Fetch the project list first, then send a reminder.' });
    }
    const { status, body } = await runReminder(req.session, req.session.lastScan, req.body ?? {});
    res.status(status).json(body);
  }),
);

/** Where emailed reports reach this server: the configured address, else the one the dashboard is using. */
/**
 * The reminder server address put into every report, so anyone opening it can
 * connect: the Settings page, else REPORT_SERVER_URL / PUBLIC_URL, else the
 * address the dashboard is open on. Reports sent with nobody at the dashboard
 * (automatic reminders) use the last address an administrator reached it on.
 */
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)$/i;
let lastDashboardOrigin = '';

function requestOrigin(req) {
  const origin = `${req.protocol}://${req.get('host')}`;
  try {
    if (!LOOPBACK.test(new URL(origin).hostname)) lastDashboardOrigin = origin;
  } catch {}
  return origin;
}

function resolveReportServer(req = null, settings = settingsStore.get()) {
  if (settings.links.reportServerUrl) return { url: settings.links.reportServerUrl, source: 'settings' };
  if (config.reportServerUrl) return { url: config.reportServerUrl, source: 'environment' };
  if (req) return { url: requestOrigin(req), source: 'this page' };
  if (lastDashboardOrigin) return { url: lastDashboardOrigin, source: 'last dashboard address' };
  return { url: '', source: 'none' };
}

function reportServerUrl(req, settings) {
  return resolveReportServer(req, settings).url;
}

/** Why readers might not be able to use an address. */
function reportServerWarnings(url) {
  if (!url) return ['No address: reports go out without one, and readers must type it in before they can triage.'];
  const warnings = [];
  try {
    const parsed = new URL(url);
    if (LOOPBACK.test(parsed.hostname)) warnings.push(`${parsed.hostname} only works on the computer running this server. Set the address others use to reach it.`);
    if (parsed.protocol === 'http:' && !LOOPBACK.test(parsed.hostname)) warnings.push('Plain http: triage requests cross the network unencrypted. Prefer https behind a reverse proxy.');
  } catch {
    warnings.push('Not a valid address.');
  }
  return warnings;
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

/**
 * What someone acting from a report is told when Checkmarx One fails: the kind
 * of failure, not the raw upstream text. That text (hosts, paths, response
 * bodies) is for administrators, and stays in the audit log and server log.
 */
function relayError(error) {
  const status = Number(error?.status) || 0;
  if (status === 401 || status === 403) return 'Checkmarx One refused the request. Ask your security team to check the reminder server.';
  if (status === 402) return 'Checkmarx One has no AI credits left for this.';
  if (status === 404) return 'Checkmarx One could not find this finding.';
  if (status === 429) return 'Checkmarx One is busy. Try again in a minute.';
  if (status >= 400 && status < 500) return `Checkmarx One did not accept the request (${status}).`;
  return 'Checkmarx One could not be reached. Try again later.';
}

function grantedFindings(req, res, { type = '', actor = null, list: given = req.body?.findings } = {}) {
  const list = Array.isArray(given) ? given : [];
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
    if (problem && type) {
      audit.record({
        type,
        outcome: 'refused',
        reason: problem === 'expired' ? 'Report expired.' : 'Report permission did not verify (altered or forged request).',
        actor,
        project: { id: finding.projectId, name: finding.projectName },
        findings: [{ riskId: finding.riskId, alternateId: finding.alternateId, scanId: finding.scanId, scanner: finding.scanner }],
        credits: { kind: type, requested: 0, charged: 0 },
      });
    }
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

/** The credit pool's period: 'month' (refills monthly) or 'all' (one pool). */
const poolPeriod = (settings = settingsStore.get()) => (settings.aiTriage?.poolPeriod === 'all' ? 'all' : 'month');
const creditsRemaining = () => creditLedger.remaining(settingsStore.get().aiTriage?.monthlyCreditLimit ?? 0, new Date(), poolPeriod());
/** "this month's credit pool of 500" / "the credit pool of 500", for messages. */
const poolName = (limit) => `${poolPeriod() === 'all' ? 'the credit pool' : "this month's credit pool"} of ${limit}`;

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

// ---------------------------------------------------------------------------
// Audit: every credit decision, attributed and traceable
// ---------------------------------------------------------------------------

const clientIp = (req) => String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket?.remoteAddress || '';

/** Who acts through an emailed report: the signed recipient, where from. */
function reportActor(req) {
  const token = req.body?.report;
  const report = reportGrants.verifyReport(token);
  return {
    kind: 'report',
    recipient: report?.recipient || '',
    reportId: report?.id || '',
    reportVerified: Boolean(report),
    // Reports sent before auditing carry no identity; an altered one is refused.
    reportToken: report ? 'valid' : token ? 'invalid' : 'missing',
    ip: clientIp(req),
    userAgent: String(req.get('user-agent') ?? '').slice(0, 200),
  };
}

/** Who acts from the dashboard: the Checkmarx One user behind the session's API key. */
async function adminActor(req) {
  const session = req.session;
  const user = req.user ?? (session?.userId ? iam.user(session.userId) : null);
  let tenant = '';
  try {
    tenant = session?.connection?.tenant ?? '';
  } catch {}
  return {
    kind: 'user',
    user: user?.email ?? '',
    name: user?.name ?? '',
    email: user?.email ?? '',
    role: user ? (iam.role(user.role)?.name ?? user.role) : '',
    via: session?.via === 'cxone' ? `Checkmarx One key${session.cxUser ? ` (${session.cxUser})` : ''}` : 'password',
    tenant,
    ip: clientIp(req),
    userAgent: String(req.get('user-agent') ?? '').slice(0, 200),
  };
}

const balanceOf = (projectId, kind) => {
  const { allocated, used, remaining } = allocations.balance(projectId)[kind];
  return { allocated, used, remaining };
};

/** One audit entry for a credit decision about `findings` (all in one project). */
function auditCredit({ id, type, outcome, reason = '', actor, findings = [], kind, requested = 0, charged = 0, before, upstream, details }) {
  const first = findings[0];
  const project = first ? { id: first.projectId, name: first.projectName } : undefined;
  const settings = settingsStore.get().aiTriage ?? {};
  const what = kind === 'remediation' ? 'AI Remediation' : 'AI Triage';
  const defaultReason =
    outcome === 'charged'
      ? `${what} started for ${findings.length} finding(s): ${charged} credit(s) charged${actor?.kind === 'report' && actor.reportToken === 'missing' ? ' (report without identity, sent before auditing)' : ''}.`
      : outcome === 'not-charged'
        ? `${what} accepted; Checkmarx One started no new job, so nothing was charged.`
        : '';
  return audit.record({
    ...(id ? { id } : {}),
    type,
    outcome,
    reason: reason || defaultReason,
    actor,
    project,
    findings: findings.map((f) => ({ riskId: f.riskId, alternateId: f.alternateId, scanId: f.scanId, scanner: f.scanner, ...(f.severity ? { severity: f.severity } : {}) })),
    credits: { kind, requested, charged },
    balance: project ? { before: before ?? balanceOf(project.id, kind), after: balanceOf(project.id, kind) } : undefined,
    month: { limit: settings.monthlyCreditLimit ?? 0, period: settings.poolPeriod === 'all' ? 'all' : 'month', remaining: creditsRemaining() },
    upstream,
    details,
  });
}

/** The settings that govern credit spending (secrets as a changed/unchanged fingerprint only). */
function creditSettingsOf(settings) {
  const ai = settings.aiTriage ?? {};
  const token = settings.beta?.github?.token ?? '';
  return {
    aiTriageEnabled: Boolean(ai.enabled),
    remediationEnabled: Boolean(ai.remediationEnabled),
    monthlyCreditLimit: ai.monthlyCreditLimit ?? 0,
    poolPeriod: ai.poolPeriod === 'all' ? 'all' : 'month',
    allowRetriage: Boolean(ai.allowRetriage),
    allowReremediation: Boolean(ai.allowReremediation),
    skipNotExploitable: ai.skipNotExploitable !== false,
    adminContact: ai.adminContact ?? '',
    githubToken: token ? `set (${createHash('sha256').update(token).digest('hex').slice(0, 8)})` : 'not set',
  };
}

function auditSettings(actor, before, after) {
  const changes = {};
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) changes[key] = { from: before[key], to: after[key] };
  }
  if (!Object.keys(changes).length) return null;
  return audit.record({
    type: 'settings',
    outcome: 'changed',
    reason: `Changed: ${Object.keys(changes).join(', ')}`,
    actor,
    credits: { kind: 'settings', requested: 0, charged: 0 },
    details: { changes },
  });
}

/** A project's allocation as the audit log records it. */
function allocationSnapshot(projectId) {
  const b = allocations.balance(projectId);
  return {
    severities: b.severities,
    extraTriage: b.extraTriage,
    extraRemediation: b.extraRemediation,
    triage: { allocated: b.triage.allocated, used: b.triage.used, remaining: b.triage.remaining },
    remediation: { allocated: b.remediation.allocated, used: b.remediation.used, remaining: b.remediation.remaining },
  };
}

/** Record an allocation change for a project when something actually changed. */
function auditAllocation({ actor, projectId, projectName, before, change, reason, outcome = 'changed' }) {
  const after = allocationSnapshot(projectId);
  if (JSON.stringify(before) === JSON.stringify(after)) return null;
  return audit.record({
    type: 'allocation',
    outcome,
    reason,
    actor,
    project: { id: projectId, name: projectName },
    credits: {
      kind: 'allocation',
      requested: 0,
      charged: 0,
      triageDelta: after.triage.allocated - before.triage.allocated,
      remediationDelta: after.remediation.allocated - before.remediation.allocated,
    },
    details: { change, before, after },
  });
}

const SYSTEM_ACTOR = { kind: 'system', user: 'reminder server' };

// Earlier releases allocated on their own: those allocations were dropped at start-up (src/credit-allocations.js).
if (allocations.migrated?.length) {
  for (const m of allocations.migrated) {
    audit.record({
      type: 'allocation',
      outcome: 'changed',
      reason: `Allocations made automatically by an earlier release removed: credits are now allocated only when someone confirms it. Kept what was used and extra credits not used yet.`,
      actor: SYSTEM_ACTOR,
      project: { id: m.projectId, name: m.projectName },
      credits: { kind: 'allocation', requested: 0, charged: 0, triageDelta: m.after.triage - m.before.triage, remediationDelta: m.after.remediation - m.before.remediation },
      details: { before: m.before, after: m.after },
    });
  }
  console.log(`[credits] ${allocations.migrated.length} project allocation(s) made automatically by an earlier release were removed; allocate on the Dashboard.`);
}

/** A whole request turned away before anything was sent: one entry per project. */
function auditRefusedRequest(type, actor, findings, reason, outcome = 'refused') {
  const kind = type === 'remediation' ? 'remediation' : 'triage';
  const perFinding = kind === 'remediation' ? CREDIT_COST.remediation : 1;
  const byProject = new Map();
  for (const f of findings) {
    if (!byProject.has(f.projectId)) byProject.set(f.projectId, []);
    byProject.get(f.projectId).push(f);
  }
  for (const group of byProject.values()) {
    auditCredit({ type, outcome, reason, actor, findings: group, kind, requested: new Set(group.map((f) => f.alternateId)).size * perFinding });
  }
}

/**
 * A report's identity (who it was sent to) must be intact: an altered one
 * would spend credits under someone else's name. Reports without one (sent
 * before auditing) are still honoured and logged as unattributed.
 */
function attributedReport(res, type, actor, findings) {
  if (actor.reportToken !== 'invalid') return true;
  auditRefusedRequest(type, actor, findings, 'Report identity did not verify (altered recipient or report id).');
  res.status(403).json({ error: 'This report could not be verified. Open the report from its original email.' });
  return false;
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
    diagnostics.discrepancy('credit-refused', { kind, credits, project: projectId, reason: left === 0 ? 'none allocated' : 'too few allocated' });
    return left === 0
      ? `${project} has no ${KIND_NAMES[kind]} credits left (${credits} needed). Ask your administrator to allocate more.`
      : `${project} has ${left} ${KIND_NAMES[kind]} credit${left === 1 ? '' : 's'} left, ${credits} needed. Ask your administrator to allocate more.`;
  }
  const monthLeft = creditLedger.remaining(limit, new Date(), poolPeriod());
  if (monthLeft !== null && credits > monthLeft) {
    const name = poolName(limit);
    return `${name[0].toUpperCase()}${name.slice(1)} is used up — the credit limit for actions from reports (${monthLeft} left, ${credits} needed). Ask your administrator to raise it.`;
  }
  return '';
}

/** Lets a report (or the Settings page) check an address really is this server. Never needs a connection. */
app.get('/api/relay/ping', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ service: 'mission-zero-relay', ok: true });
});

app.get('/api/report-server', requireSession, (req, res) => {
  const settings = settingsStore.get();
  const effective = resolveReportServer(req, settings);
  res.json({
    ...effective,
    configured: settings.links.reportServerUrl,
    environment: config.reportServerUrl,
    automatic: resolveReportServer(null, settings),
    warnings: reportServerWarnings(effective.url),
  });
});

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
    if (session) res.json(relayStatus(session, aiTriage));
  }),
);

function relayStatus(session, aiTriage) {
  return {
    connected: true,
    tenant: session.connection.tenant,
    triage: Boolean(aiTriage.enabled),
    remediation: Boolean(aiTriage.remediationEnabled),
    retriage: Boolean(aiTriage.allowRetriage),
    reremediation: Boolean(aiTriage.allowReremediation),
    adminContact: adminContact(),
    creditsRemaining: creditsRemaining(),
  };
}

/**
 * Everything a report needs when it opens, in one round trip: the status
 * (as /status), its projects' credits (as /credits, from `credits`: one
 * signed finding per project), and where AI Triage and AI Remediation stand
 * (as /triage-results for `findings`, /remediation-status for `remediation`).
 * Each list is optional. Reports from before this call use the separate ones.
 */
app.post(
  '/api/relay/hello',
  asyncRoute(async (req, res) => {
    const { aiTriage } = settingsStore.get();
    if (!aiTriage?.enabled && !aiTriage?.remediationEnabled) {
      return res.status(403).json({
        error: 'AI Triage and Remediation from reports are switched off. Ask your Checkmarx One reminder administrator to allow them.',
      });
    }
    const session = await relaySession(res);
    if (!session) return;
    const given = (key) => (Array.isArray(req.body?.[key]) && req.body[key].length ? req.body[key] : null);
    const lists = {};
    for (const key of ['credits', 'findings', 'remediation']) {
      if (!given(key)) continue;
      lists[key] = grantedFindings(req, res, { list: given(key) });
      if (!lists[key]) return;
    }
    const answer = relayStatus(session, aiTriage);
    if (lists.credits) answer.projects = projectCredits(lists.credits.map((f) => f.projectId));
    if (lists.remediation) answer.remediationStatus = remediationStatusFor(session, lists.remediation);
    if (lists.findings) answer.triageResults = await triageResultsFor(session, lists.findings);
    res.json(answer);
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
    const actor = reportActor(req);
    const findings = grantedFindings(req, res, { type: 'triage', actor });
    if (!findings) return;
    if (!attributedReport(res, 'triage', actor, findings)) return;
    if (!triageAllowed(res)) {
      auditRefusedRequest('triage', actor, findings, 'AI Triage from reports is switched off.');
      return;
    }
    const session = await relaySession(res);
    if (!session) {
      auditRefusedRequest('triage', actor, findings, 'No stored Checkmarx One connection on the reminder server.', 'failed');
      return;
    }

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
          console.warn(`[relay] could not read risk states for project ${logSafe(projectId)}: ${logSafe(error.message)}`);
        }
      });
      const sentBefore = new Map([...new Set(findings.map((f) => f.projectId))].map((id) => [id, creditLedger.triagedAt(id)]));
      for (const [key, group] of buckets) {
        const triaged = group.filter((f) => {
          if (alreadySent(f, sentBefore.get(f.projectId))) return true;
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
        auditCredit({
          type: 'triage', outcome: 'refused', reason: 'Already triaged; re-triage is switched off.', actor,
          findings: triaged, kind: 'triage', requested: new Set(triaged.map((f) => f.alternateId)).size,
        });
        const rest = group.filter((f) => !triaged.includes(f));
        if (rest.length) buckets.set(key, rest);
        else buckets.delete(key);
      }
    }

    // Fail-safe: claim everything about to be sent; anything another request is
    // sending right now is answered, not sent twice.
    const claim = sendGuard.claim('triage', [...buckets.values()].flat());
    if (claim.busy.length) {
      results.push({ alternateIds: [...new Set(claim.busy.map((f) => f.alternateId))], ok: false, status: 409, busy: true, error: BUSY_REASON });
      auditRefusedRequest('triage', actor, claim.busy, BUSY_REASON);
      noteBusy('triage', claim.busy);
    }
    const sentNow = allowRetriage ? new Map() : new Map([...new Set(findings.map((f) => f.projectId))].map((id) => [id, creditLedger.triagedAt(id)]));
    for (const [key, group] of buckets) {
      const rest = group.filter((f) => claim.claimed.includes(f) && !alreadySent(f, sentNow.get(f.projectId)));
      if (rest.length) buckets.set(key, rest);
      else buckets.delete(key);
    }
    try {
      let stopped = '';
      for (const group of buckets.values()) {
        const { scanId, scanner, projectId, projectName } = group[0];
        const alternateIds = [...new Set(group.map((f) => f.alternateId))];
        const before = balanceOf(projectId, 'triage');
        const base = { type: 'triage', actor, findings: group, kind: 'triage', requested: alternateIds.length, before };

        if (stopped) {
          results.push({ alternateIds, ok: false, status: 409, error: stopped });
          auditCredit({ ...base, outcome: 'refused', reason: `Not sent: ${stopped}` });
          continue;
        }
        const refusal = creditRefusal(projectId, projectName, 'triage', alternateIds.length, limit);
        if (refusal) {
          results.push({ alternateIds, ok: false, status: 402, error: refusal, credits: creditNeed(projectId, projectName, 'triage', alternateIds.length) });
          auditCredit({ ...base, outcome: 'refused', reason: refusal });
          continue;
        }
        const reservation = creditLedger.reserve(alternateIds.length, limit, new Date(), {
          period: poolPeriod(),
          projectId,
          kind: 'triage',
          allowance: allocations.balance(projectId).triage.allocated,
        });
        if (!reservation) {
          results.push({ alternateIds, ok: false, status: 402, error: 'Credits are busy with another request; try again in a moment.' });
          auditCredit({ ...base, outcome: 'refused', reason: 'Credits reserved by concurrent requests; nothing sent.' });
          continue;
        }
        const started = Date.now();
        try {
          const body = await session.client.request('/api/ai-triage/triage', {
            method: 'POST',
            body: { scanID: scanId, buckets: [{ scannerType: scanner.toLowerCase(), resultIDs: alternateIds }] },
            retries: 1,
          });
          const published = body?.published !== false;
          const upstream = { call: 'POST /api/ai-triage/triage', status: 200, published, jobId: body?.triageID ?? body?.id ?? '', ms: Date.now() - started };
          // Checkmarx One only starts (and charges for) a new job when published.
          if (published) {
            const riskIds = [...new Set(group.map((f) => f.riskId))];
            const covered = await coveredCount(session, projectId, 'triage', riskIds);
            // Ledger first (so the balance after is right), linked to its audit entry both ways.
            const auditId = randomUUID();
            reservation.release();
            recordCreditUse({
              projectId, projectName, credits: alternateIds.length, scanId, kind: 'triage', riskIds, alternateIds,
              groupIds: [...new Set(group.map((f) => f.groupId).filter(Boolean))], covered: Math.min(covered, alternateIds.length), auditId,
            });
            auditCredit({ ...base, id: auditId, outcome: 'charged', charged: alternateIds.length, upstream, details: { covered: Math.min(covered, alternateIds.length) } });
          } else {
            auditCredit({ ...base, outcome: 'not-charged', reason: 'Checkmarx One already had this triage job; no new credits.', upstream });
          }
          actedOn('triage', group);
          touchProject(projectId);
          results.push({ alternateIds, ok: true, published });
        } catch (error) {
          results.push({ alternateIds, ok: false, status: error.status ?? 0, error: relayError(error) });
          auditCredit({
            ...base, outcome: 'failed', reason: error.message,
            upstream: { call: 'POST /api/ai-triage/triage', status: error.status ?? 0, error: String(error.body || error.message).slice(0, 500), ms: Date.now() - started },
          });
          // No credits or no permission: every further request would fail the same way.
          if (error.status === 402 || error.status === 403) stopped = `Checkmarx One refused an earlier request (${error.status}).`;
        } finally {
          reservation.release();
        }
      }
      res.json({ results, creditsRemaining: creditsRemaining(), projects: projectCredits(findings.map((f) => f.projectId)) });
    } finally {
      claim.release();
    }
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

/**
 * A finding's state in Checkmarx One now ('' when it cannot be read). A cached
 * answer other than confirmed is read again, so a verdict that just arrived counts.
 */
async function liveState(session, finding) {
  try {
    const cached = (await projectRiskInfo(session, finding.projectId)).info.get(finding.riskId)?.state ?? '';
    if (cached === REMEDIABLE_STATE) return cached;
    stateCache.delete(finding.projectId);
    return (await projectRiskInfo(session, finding.projectId)).info.get(finding.riskId)?.state ?? '';
  } catch (error) {
    console.warn(`[remediation] could not read the state of ${logSafe(finding.riskId)}: ${logSafe(error.message)}`);
    return '';
  }
}

const stateName = (state) => String(state).toLowerCase().replace(/_/g, ' ');

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
    res.json(await triageResultsFor(session, findings));
  }),
);

/** Where AI Triage stands for these findings, answered from what is known now (see /api/relay/triage-results). */
async function triageResultsFor(session, findings) {
  const statesByProject = new Map();
  const stateErrors = new Map();
  const projectIds = [...new Set(findings.map((f) => f.projectId))];
  const sentBefore = new Map(projectIds.map((id) => [id, creditLedger.triagedAt(id)]));
  await mapWithConcurrency(projectIds, 3, async (projectId) => {
    try {
      statesByProject.set(projectId, await projectStates(session, projectId));
    } catch (error) {
      stateErrors.set(projectId, relayError(error));
      console.warn(`[relay] could not read risk states for project ${logSafe(projectId)}: ${logSafe(error.message)}`);
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
    // When this utility sent it for AI Triage, so the report can say so even before Checkmarx One has a verdict.
    const sent = sentBefore.get(finding.projectId);
    const sentAt = sent?.get(finding.riskId) || sent?.get(`a:${finding.alternateId}`) || (finding.groupId && sent?.get(`g:${finding.groupId}`));
    const extra = {
      ...(sentAt ? { triagedAt: sentAt } : {}),
      ...(stateErrors.has(finding.projectId) ? { stateError: stateErrors.get(finding.projectId) } : {}),
    };
    if (!known) return { found: false, state, pending: true, ...extra };
    return { ...known.value, state, ...extra, ...(known.fresh ? {} : { stale: true }) };
  });
  return { results, checkedAt: new Date().toISOString() };
}

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
    res.json(remediationStatusFor(session, findings));
  }),
);

/** Which of these findings are already remediated, answered from what is known now. */
function remediationStatusFor(session, findings) {
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
  return { results };
}

/**
 * AI Remediation for one finding. Checkmarx One first triages it, then
 * suggests a fix; for repository-integrated projects it opens a pull request.
 */
app.post(
  '/api/relay/remediate',
  asyncRoute(async (req, res) => {
    const actor = reportActor(req);
    const findings = grantedFindings(req, res, { type: 'remediation', actor });
    if (!findings) return;
    if (!attributedReport(res, 'remediation', actor, findings)) return;
    if (findings.length !== 1) return res.status(400).json({ error: 'Remediate one finding at a time.' });
    if (!actionAllowed(res, 'remediationEnabled')) {
      auditRefusedRequest('remediation', actor, findings, 'AI Remediation from reports is switched off.');
      return;
    }
    const session = await relaySession(res);
    if (!session) {
      auditRefusedRequest('remediation', actor, findings, 'No stored Checkmarx One connection on the reminder server.', 'failed');
      return;
    }

    // Fail-safe: one request at a time per vulnerability.
    const claim = sendGuard.claim('remediation', findings);
    if (claim.busy.length) {
      auditRefusedRequest('remediation', actor, findings, BUSY_REASON);
      noteBusy('remediation', claim.busy);
      return res.status(409).json({ busy: true, error: BUSY_REASON });
    }
    try {
      const [finding] = findings;
      const { monthlyCreditLimit: limit = 0, allowReremediation = false } = settingsStore.get().aiTriage ?? {};
      const cost = CREDIT_COST.remediation;
      const before = balanceOf(finding.projectId, 'remediation');
      const base = { type: 'remediation', actor, findings: [finding], kind: 'remediation', requested: cost, before };

      // The fence: AI Remediation only for a finding triaged and confirmed — never one proposed
      // not exploitable or still to verify. Read live, whatever the report says.
      const state = await liveState(session, finding);
      if (state !== REMEDIABLE_STATE) {
        const reason = state
          ? `AI Remediation runs only on confirmed findings; this one is ${stateName(state)}.`
          : 'Could not confirm this finding is confirmed in Checkmarx One, so AI Remediation was not started.';
        auditCredit({ ...base, outcome: 'refused', reason, details: { state: state || 'unknown' } });
        return res.status(409).json({ error: reason, notConfirmed: true, state: state || null });
      }

      // A finding already remediated is only remediated again when the
      // administrator allows it: every run spends credits and may open another pull request.
      let current = { status: 'none', body: null };
      try {
        current = await remediationState(session, finding);
      } catch (error) {
        console.warn(`[relay] could not read the remediation state of ${logSafe(finding.riskId)}: ${logSafe(error.message)}`);
      }
      if (current.status === 'running') {
        auditCredit({ ...base, outcome: 'refused', reason: 'AI Remediation already running for this finding; followed it instead.' });
        return res.status(409).json({ running: true, body: current.body, error: 'AI Remediation is already running for this finding.' });
      }
      if (current.status === 'done' && !allowReremediation) {
        auditCredit({ ...base, outcome: 'refused', reason: 'Already remediated; re-remediation is switched off.' });
        return res.status(409).json({
          remediated: true,
          body: current.body,
          error: 'This finding is already remediated. Remediating again is switched off by your administrator.',
        });
      }
      const refusal = creditRefusal(finding.projectId, finding.projectName, 'remediation', cost, limit);
      if (refusal) {
        auditCredit({ ...base, outcome: 'refused', reason: refusal });
        return res.status(402).json({
          error: refusal,
          credits: creditNeed(finding.projectId, finding.projectName, 'remediation', cost),
          creditsRemaining: creditsRemaining(),
          projects: projectCredits([finding.projectId]),
        });
      }
      const reservation = creditLedger.reserve(cost, limit, new Date(), {
        period: poolPeriod(),
        projectId: finding.projectId,
        kind: 'remediation',
        allowance: allocations.balance(finding.projectId).remediation.allocated,
      });
      if (!reservation) {
        auditCredit({ ...base, outcome: 'refused', reason: 'Credits reserved by concurrent requests; nothing sent.' });
        return res.status(402).json({ error: 'Credits are busy with another request; try again in a moment.' });
      }
      const started = Date.now();
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
        const upstream = { call: 'POST /api/remediation/remediate', status: 200, published, jobId: body?.remediationJobId ?? '', ms: Date.now() - started };
        if (published) {
          const covered = (await coveredCount(session, finding.projectId, 'remediation', [finding.riskId])) ? cost : 0;
          const auditId = randomUUID();
          reservation.release();
          recordCreditUse({
            projectId: finding.projectId,
            projectName: finding.projectName,
            credits: cost,
            scanId: finding.scanId,
            kind: 'remediation',
            riskIds: [finding.riskId],
            covered,
            auditId,
          });
          auditCredit({ ...base, id: auditId, outcome: 'charged', charged: cost, upstream, details: { covered, existingState: body?.existingState ?? null } });
        } else {
          auditCredit({ ...base, outcome: 'not-charged', reason: 'Checkmarx One already had this remediation job; no new credits.', upstream });
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
        auditCredit({
          ...base, outcome: 'failed', reason: error.message,
          upstream: { call: 'POST /api/remediation/remediate', status: error.status ?? 0, error: String(error.body || error.message).slice(0, 500), ms: Date.now() - started },
        });
        res.status(error.status && error.status >= 400 ? error.status : 502).json({
          error: error.status === 402
            ? 'Checkmarx One has no credits left for AI Remediation.'
            : error.status === 403
              ? "The reminder server's Checkmarx One account is not allowed to run AI Remediation."
              : `AI Remediation could not start: ${relayError(error)}`,
        });
      } finally {
        reservation.release();
      }
    } finally {
      claim.release();
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
      console.warn(`[relay] could not read the AI Remediation result of ${logSafe(finding.riskId)}: ${logSafe(error.message)}`);
      res.status(502).json({ error: `Could not read the AI Remediation result: ${relayError(error)}` });
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

// ---------------------------------------------------------------------------
// Acting on a developer's behalf: tell them, about their own projects only
// ---------------------------------------------------------------------------

const KIND_TITLES = { triage: 'AI Triage', remediation: 'AI Remediation' };

/**
 * After the administrator ran AI Triage or Remediation from the Dashboard or a
 * tracked report, each scan initiator gets one email about their own projects:
 * what was started on their behalf, and what to do next (fetch the changes in
 * their report, review and approve the pull requests).
 */
async function notifyOnBehalf(session, kind, started, initiatorsByProject, actor) {
  const out = { emailed: 0, recipients: [], noAddress: [], failed: 0 };
  if (!started.length) return out;
  const settings = settingsStore.get();
  const byProject = new Map();
  for (const f of started) {
    const p = byProject.get(f.projectId) ?? { name: f.projectName || f.projectId, results: new Set(), severities: new Set() };
    p.results.add(f.alternateId || f.groupId || f.riskId);
    p.severities.add(String(f.severity || '').toLowerCase());
    byProject.set(f.projectId, p);
  }
  const byPerson = new Map();
  for (const [projectId, p] of byProject) {
    const email = initiatorsByProject?.[projectId]?.email || '';
    if (!email) {
      out.noAddress.push(p.name);
      continue;
    }
    if (!byPerson.has(email)) byPerson.set(email, []);
    byPerson.get(email).push(p);
  }
  const title = KIND_TITLES[kind];
  const by = actor?.user ? `${actor.user}` : 'Your security team';
  const next = kind === 'remediation'
    ? ['Open your Mission Zero report for these projects and click Refresh to fetch the suggested fixes.', 'Review and approve the pull requests AI Remediation opens in your repository (or apply the fix shown in Checkmarx One).']
    : ['Open your Mission Zero report for these projects and click Refresh to see the verdicts.', 'Confirmed findings can then be remediated from the report; proposed not exploitable ones drop out of it.'];
  for (const [email, projects] of byPerson) {
    const total = projects.reduce((n, p) => n + p.results.size, 0);
    const lines = projects.map((p) => `${p.name}: ${p.results.size} finding${p.results.size === 1 ? '' : 's'} (${[...p.severities].filter(Boolean).join(', ')})`);
    const subject = `${title} was started on your behalf: ${total} finding${total === 1 ? '' : 's'}`;
    const text = `Hello,\n\n${by} started Checkmarx One ${title} on your behalf, using the credits allocated to these projects you last scanned:\n\n${lines.map((l) => `  - ${l}`).join('\n')}\n\nWhat to do now:\n${next.map((l) => `  - ${l}`).join('\n')}\n\nNothing more is needed to start it, and no credits of yours were spent beyond these.\n`;
    const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827;max-width:640px">
      <h2 style="margin:0 0 12px;font-size:18px">${escapeHtmlText(title)} was started on your behalf</h2>
      <p>${escapeHtmlText(by)} started Checkmarx One ${escapeHtmlText(title)} on your behalf, using the credits allocated to these projects you last scanned:</p>
      <ul>${lines.map((l) => `<li>${escapeHtmlText(l)}</li>`).join('')}</ul>
      <p><strong>What to do now</strong></p>
      <ul>${next.map((l) => `<li>${escapeHtmlText(l)}</li>`).join('')}</ul>
      <p style="color:#6b7280;font-size:12px">Nothing more is needed to start it, and no credits of yours were spent beyond these.</p>
    </div>`;
    try {
      await sendReminderMail(settings, { subject, text, html }, { exact: true, to: [email] });
      out.emailed += 1;
      out.recipients.push(email);
    } catch (error) {
      out.failed += 1;
      console.warn(`[on behalf] could not email a scan initiator: ${logSafe(error.message)}`);
    }
  }
  audit.record({
    type: kind, outcome: 'changed', actor,
    reason: `Told ${out.emailed} scan initiator(s) that ${title} was started on their behalf${out.noAddress.length ? `; no address for ${out.noAddress.length} project(s)` : ''}${out.failed ? `; ${out.failed} email(s) failed` : ''}.`,
  });
  return out;
}

// ---------------------------------------------------------------------------
// Verified credit needs: confirmed with Checkmarx One twice before any demand
// ---------------------------------------------------------------------------

/** A verification is good for this long; allocating "what is needed" asks for a fresh one after that. */
const VERIFY_TTL_MS = 10 * 60 * 1000;

/**
 * One complete, independent read from Checkmarx One of what a project needs:
 * its findings and their live states (risks API), then the scan results that
 * AI Triage and AI Remediation would be sent (results API). Returns the exact
 * billed result ids, not an estimate.
 */
async function readProjectNeed(session, project, { detectionWindow = null, scanIdOf = () => '', severities = null } = {}) {
  const read = await collectProjectRisks(session.client, activeConfig(), [{ id: project.projectId, name: project.projectName }], { detectionWindow });
  const summary = read.projects[0];
  if (summary.error) throw Object.assign(new Error(`${project.projectName}: ${summary.error}`), { status: 502 });
  const rule = severities?.length ? severities : allocations.severitiesOf(project.projectId);
  const ai = summary.risks.filter((r) => rule.includes(r.severity) && AI_SCANNERS.has(r.scanner));
  await resolveAiIds(session.client, ai, () => scanIdOf(project.projectId));
  const triage = triageRows(summary.risks, rule, Date.now(), creditLedger.triagedAt(project.projectId));
  const remediate = remediationCandidates(summary.risks, rule, creditLedger.remediatedIds(project.projectId));
  const units = (rows) => [...new Set(rows.map(billingUnit))].sort();
  return {
    summary,
    rule,
    triage: { rows: triage.length, results: units(triage) },
    remediation: { rows: remediate.length, results: units(remediate) },
    // Findings the AI cannot act on (no result id in the latest scan): never billed, shown apart.
    unresolved: ai.filter((r) => r.aiUnavailable).length,
  };
}

/**
 * Verify what projects need: two independent reads from Checkmarx One that must
 * agree, result id for result id. On agreement the project's findings and
 * credit needs are replaced by what Checkmarx One said; on disagreement (the
 * data is changing, e.g. someone is triaging) nothing is trusted.
 */
/** Two independent reads of one project; `agreed` only when every billed result id matches. */
async function doubleRead(session, project, options) {
  const first = await readProjectNeed(session, project, options);
  const second = await readProjectNeed(session, project, options);
  const same = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);
  const agreed =
    same(first.triage.results, second.triage.results) &&
    same(first.remediation.results, second.remediation.results) &&
    first.rule.join() === second.rule.join();
  return { first, second, agreed };
}

const DISAGREED = 'Checkmarx One gave different results on the two reads — the findings are changing (someone may be triaging). Refresh again in a moment.';

async function verifyNeeds(session, projects, { severities = null } = {}) {
  const scan = session.lastScan;
  const options = { detectionWindow: scan?.detectionWindow ?? null, scanIdOf: (id) => scan?.initiators?.[id]?.scanId ?? '', severities };
  const out = await mapWithConcurrency(projects, 3, async (p) => {
    try {
      const { first, second, agreed } = await doubleRead(session, p, options);
      const verified = {
        at: Date.now(),
        agreed,
        severities: second.rule,
        triage: { rows: second.triage.rows, results: second.triage.results.length },
        remediation: { rows: second.remediation.rows, results: second.remediation.results.length, credits: CREDIT_COST.remediation * second.remediation.results.length },
        reads: [first.triage.results.length, second.triage.results.length],
        unresolved: second.unresolved,
      };
      if (agreed) {
        // The second read is what Checkmarx One holds now: it replaces the fetched rows.
        const { risks, counts, bySeverity, totalRisks, oldestFirstDetectedAt, maxAgeDays } = second.summary;
        Object.assign(p, { risks, counts, bySeverity, totalRisks, oldestFirstDetectedAt, maxAgeDays });
        p.credits = creditView(p);
        // The count the allocation will use must be the verified one, to the credit.
        const need = allocations.need(p.projectId, p.risks);
        const sameRule = second.rule.join() === allocations.severitiesOf(p.projectId).join();
        if (sameRule && (need.toTriage !== verified.triage.results || need.toRemediate !== verified.remediation.results)) {
          verified.agreed = false;
          verified.reason = 'The credit count did not match the verified Checkmarx One results.';
          diagnostics.discrepancy('credit-count-mismatch', { project: p.projectId, results: verified.triage.results, credits: need.toTriage });
        }
      } else {
        verified.reason = DISAGREED;
        diagnostics.discrepancy('credit-verify-disagreed', { project: p.projectId, reads: [first.triage.results.length, second.triage.results.length] });
      }
      p.verified = verified;
      return { projectId: p.projectId, ...verified };
    } catch (error) {
      p.verified = { at: Date.now(), agreed: false, reason: `Could not read Checkmarx One: ${error.message}` };
      diagnostics.error('verify-read-failed', error, { project: p.projectId });
      return { projectId: p.projectId, ...p.verified };
    }
  });
  return out;
}

const freshlyVerified = (p) =>
  p.verified?.agreed && Date.now() - p.verified.at < VERIFY_TTL_MS && p.verified.severities.join() === allocations.severitiesOf(p.projectId).join();

/**
 * Refresh & verify: re-read the chosen projects from Checkmarx One twice. Their
 * rows and credit needs are replaced by what Checkmarx One holds now, and only
 * a verified need can be allocated.
 */
app.post(
  '/api/credits/verify',
  requirePermission('credits.view'),
  afterFetch,
  asyncRoute(async (req, res) => {
    if (!req.session.lastScan) return res.status(409).json({ error: 'Fetch the project list first.' });
    const projects = scanProjects(req, req.body?.projectIds);
    for (const p of projects) stateCache.delete(p.projectId);
    const severities = cleanSeverities(req.body?.severities);
    const results = await verifyNeeds(req.session, projects, { severities: severities.length ? SEVERITIES.filter((s) => severities.includes(s)) : null });
    res.json({
      verified: results,
      projects: Object.fromEntries(projects.map((p) => [p.projectId, { ...projectRow(p), credits: p.credits, verified: p.verified }])),
    });
  }),
);

/**
 * Allocate credits to projects — only ever because someone asked here:
 *   allocate: ['triage', 'remediation']  give each project what its findings need and it does not have
 *                                        (remediation: 3 per confirmed finding, once triage has confirmed them)
 *   triageAdd / remediationAdd           extra credits on top, for every project
 *   setExtra {triage, remediation}       one project's extra credits, exactly
 *   clearExtras                          take extra credits back
 *   ruleChanges                          which severities the projects' needs cover (allocates nothing)
 * Everything given comes out of the credit pool, and never more than it has free.
 */
app.post('/api/credits/allocate', requirePermission('credits.allocate'), afterFetch, asyncRoute(async (req, res) => {
  if (!req.session.lastScan) return res.status(409).json({ error: 'Fetch the project list first.' });
  const { projectIds, ruleChanges, triageAdd = 0, remediationAdd = 0, clearExtras = false, setExtra = null } = req.body ?? {};
  // Take back what projects were given and did not use (people did not act on it).
  const reclaim = (Array.isArray(req.body?.reclaimUnused) ? req.body.reclaimUnused : []).filter((k) => k === 'triage' || k === 'remediation');
  if (reclaim.length) {
    const projects = scanProjects(req, projectIds);
    const actor = await adminActor(req);
    let total = 0;
    for (const p of projects) {
      const before = allocationSnapshot(p.projectId);
      const back = allocations.reclaimUnused(p.projectId, reclaim);
      const n = back.triage + back.remediation;
      if (!n) continue;
      total += n;
      auditAllocation({ actor, projectId: p.projectId, projectName: p.projectName, before, change: { reclaimed: back }, reason: `Took back ${n} unused credit${n === 1 ? '' : 's'} (${[back.triage && `${back.triage} triage`, back.remediation && `${back.remediation} remediation`].filter(Boolean).join(', ')}) to the credit pool.` });
    }
    allocations.save();
    for (const p of projects) p.credits = creditView(p);
    return res.json({ reclaimed: total, projects: Object.fromEntries(projects.map((p) => [p.projectId, p.credits])), pool: creditPool() });
  }
  const changes = (Array.isArray(ruleChanges) ? ruleChanges : [])
    .map((c) => ({ severity: String(c?.severity ?? '').toUpperCase(), include: c?.include === true }))
    .filter((c) => SEVERITIES.includes(c.severity));
  const needed = (Array.isArray(req.body?.allocate) ? req.body.allocate : []).filter((k) => k === 'triage' || k === 'remediation');
  const extraTriage = Math.max(0, Math.floor(Number(triageAdd) || 0));
  const extraRemediation = Math.max(0, Math.floor(Number(remediationAdd) || 0));
  // Exact extras for one project at a time (the per-project editor).
  const exact = setExtra && typeof setExtra === 'object' ? setExtra : null;
  if (!changes.length && !needed.length && !extraTriage && !extraRemediation && clearExtras !== true && !exact) {
    return res.status(400).json({ error: 'Choose what to allocate, severities, or credits to add.' });
  }
  if (exact && (!Array.isArray(projectIds) || projectIds.length !== 1)) {
    return res.status(400).json({ error: 'Set exact extra credits for one project at a time.' });
  }

  const projects = scanProjects(req, projectIds);
  const actor = await adminActor(req);
  const before = new Map(projects.map((p) => [p.projectId, allocationSnapshot(p.projectId)]));

  // Severities first: they decide what "needed" means below.
  if (changes.length) {
    for (const p of projects) {
      const next = new Set(allocations.severitiesOf(p.projectId));
      for (const { severity, include } of changes) include ? next.add(severity) : next.delete(severity);
      allocations.setSeverities(p.projectId, p.projectName, SEVERITIES.filter((s) => next.has(s)));
    }
  }

  // "What is needed" is only ever a need Checkmarx One confirmed twice, just now:
  // read again here (after any severity change), and refused if the reads disagree.
  if (needed.length) {
    await verifyNeeds(req.session, projects.filter((p) => !freshlyVerified(p)));
    const unverified = projects.filter((p) => !freshlyVerified(p));
    if (unverified.length) {
      if (changes.length) allocations.save();
      const reason = `Not allocated: what ${unverified.length === 1 ? unverified[0].projectName : `${unverified.length} projects`} need${unverified.length === 1 ? 's' : ''} could not be confirmed twice with Checkmarx One. ${unverified[0].verified?.reason ?? ''}`.trim();
      audit.record({ type: 'allocation', outcome: 'refused', reason, actor, credits: { kind: 'allocation', requested: 0, charged: 0 }, details: { projectIds: unverified.map((p) => p.projectId) } });
      return res.status(409).json({ error: reason, unverified: unverified.map((p) => ({ projectId: p.projectId, projectName: p.projectName, reason: p.verified?.reason ?? '' })) });
    }
  }

  // What would be given, before giving anything: it must fit in the pool.
  const plan = projects.map((p) => {
    const { shortfall } = allocations.need(p.projectId, p.risks ?? []);
    const extras = allocations.balance(p.projectId);
    const exactDelta = (kind) => (exact && kind in exact ? Math.max(0, Math.floor(Number(exact[kind]) || 0)) - extras[kind === 'triage' ? 'extraTriage' : 'extraRemediation'] : 0);
    return {
      p,
      triage: (needed.includes('triage') ? shortfall.triage : 0) + extraTriage,
      remediation: (needed.includes('remediation') ? shortfall.remediation : 0) + extraRemediation,
      exact: { triage: exactDelta('triage'), remediation: exactDelta('remediation') },
    };
  });
  const given = plan.reduce((n, x) => n + x.triage + x.remediation + Math.max(0, x.exact.triage) + Math.max(0, x.exact.remediation), 0);
  const pool = creditPool();
  if (pool.limited && given > pool.unallocated) {
    const reason = `Only ${pool.unallocated} credit${pool.unallocated === 1 ? '' : 's'} left in the credit pool to give (pool ${pool.size}${pool.period === 'month' ? ' this month' : ''}, ${pool.used.total} used, ${pool.outstanding.total} given to projects and not used yet); ${given} asked for.`;
    if (changes.length) allocations.save();
    audit.record({ type: 'allocation', outcome: 'refused', reason, actor, credits: { kind: 'allocation', requested: given, charged: 0 }, details: { projectIds: projects.map((p) => p.projectId), pool } });
    return res.status(409).json({ error: `${reason} Raise the pool under Settings → AI & credits.`, pool });
  }

  for (const { p, triage, remediation, exact: delta } of plan) {
    if (clearExtras === true) allocations.clearExtras(p.projectId);
    const neededTriage = triage - extraTriage;
    const neededRemediation = remediation - extraRemediation;
    if (neededTriage) allocations.grant(p.projectId, p.projectName, 'triage', neededTriage);
    if (neededRemediation) allocations.grant(p.projectId, p.projectName, 'remediation', neededRemediation);
    if (extraTriage) allocations.add(p.projectId, p.projectName, 'triage', extraTriage);
    if (extraRemediation) allocations.add(p.projectId, p.projectName, 'remediation', extraRemediation);
    for (const kind of ['triage', 'remediation']) if (delta[kind]) allocations.add(p.projectId, p.projectName, kind, delta[kind]);
  }
  allocations.save();
  const change = {
    ...(changes.length ? { ruleChanges: changes } : {}),
    ...(needed.length ? { allocateNeeded: needed } : {}),
    ...(extraTriage ? { addTriage: extraTriage } : {}),
    ...(extraRemediation ? { addRemediation: extraRemediation } : {}),
    ...(clearExtras === true ? { clearExtras: true } : {}),
    ...(exact ? { setExtra: exact } : {}),
  };
  for (const p of projects) {
    auditAllocation({ actor, projectId: p.projectId, projectName: p.projectName, before: before.get(p.projectId), change, reason: needed.length ? `Allocated what the findings need (${needed.join(' and ')}) on the Dashboard.` : 'Changed on the Dashboard.' });
    p.credits = creditView(p);
  }
  res.json({ given, projects: Object.fromEntries(projects.map((p) => [p.projectId, p.credits])), pool: creditPool() });
}));

/**
 * Run AI Triage for `findings` on the administrator's behalf: one request per
 * scan and scanner. Credits count against each project's allocation, which
 * is raised to cover the request, since the administrator is the one allocating.
 */
async function adminTriage(session, findings, initiatorsByProject = {}, { actor = { kind: 'admin' }, origin = '' } = {}) {
  await resolveAiIds(session.client, findings, (f) => initiatorsByProject[f.projectId]?.scanId ?? '');
  let eligible = findings.filter((f) => !f.aiUnavailable);
  const ineligible = findings.filter((f) => f.aiUnavailable);
  if (ineligible.length) auditRefusedRequest('triage', actor, ineligible, `Not eligible for AI Triage (${ineligible[0].aiUnavailable})`);
  // Already sent for AI Triage through this utility (a "vulnerable" verdict stays To verify):
  // not again, and not charged again, unless re-triage is allowed.
  let alreadyTriaged = 0;
  if (!settingsStore.get().aiTriage?.allowRetriage) {
    const sent = new Map();
    const before = (f) => alreadySent(f, (sent.has(f.projectId) ? sent : sent.set(f.projectId, creditLedger.triagedAt(f.projectId))).get(f.projectId));
    const again = eligible.filter(before);
    if (again.length) {
      alreadyTriaged = again.length;
      auditRefusedRequest('triage', actor, again, 'Already triaged through this utility; re-triage is switched off.');
      eligible = eligible.filter((f) => !before(f));
    }
  }

  // Fail-safe: claim before sending; then look again at what was sent, since a
  // request that just finished has recorded it.
  const claim = sendGuard.claim('triage', eligible);
  if (claim.busy.length) auditRefusedRequest('triage', actor, claim.busy, BUSY_REASON);
  noteBusy('triage', claim.busy);
  eligible = claim.claimed;
  if (!settingsStore.get().aiTriage?.allowRetriage) {
    const sentNow = eligible.filter((f) => alreadySent(f, creditLedger.triagedAt(f.projectId)));
    if (sentNow.length) {
      alreadyTriaged += sentNow.length;
      eligible = eligible.filter((f) => !sentNow.includes(f));
    }
  }
  try {
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
    let stopped = '';
    for (const group of buckets.values()) {
      const { scanId, scanner, projectId, projectName } = group[0];
      const alternateIds = [...new Set(group.map((f) => f.alternateId))];
      const base = { type: 'triage', actor, findings: group, kind: 'triage', requested: alternateIds.length, before: balanceOf(projectId, 'triage'), details: { origin } };
      if (stopped) {
        failed += group.length;
        auditCredit({ ...base, outcome: 'refused', reason: `Not sent: ${stopped}` });
        continue;
      }
      const reservation = creditLedger.reserve(alternateIds.length, limit, new Date(), { period: poolPeriod() });
      if (!reservation) {
        failed += group.length;
        errors.push(`${projectName}: ${poolName(limit)} is used up (credit limit reached).`);
        auditCredit({ ...base, outcome: 'refused', reason: `${poolName(limit)} is used up (credit limit reached).` });
        continue;
      }
      const started = Date.now();
      try {
        const body = await session.client.request('/api/ai-triage/triage', {
          method: 'POST',
          body: { scanID: scanId, buckets: [{ scannerType: scanner.toLowerCase(), resultIDs: alternateIds }] },
          retries: 1,
        });
        const upstream = { call: 'POST /api/ai-triage/triage', status: 200, published: body?.published !== false, jobId: body?.triageID ?? body?.id ?? '', ms: Date.now() - started };
        if (body?.published !== false) {
          // The person who confirmed this run allocated what it needed beyond what the project had: recorded as theirs.
          const balance = allocations.balance(projectId).triage;
          const raised = Math.max(0, alternateIds.length - balance.remaining);
          if (raised) {
            const snapshot = allocationSnapshot(projectId);
            allocations.grant(projectId, projectName, 'triage', raised);
            auditAllocation({ actor, projectId, projectName, before: snapshot, change: { allocatedForRun: raised }, reason: `Allocated ${raised} triage credit${raised === 1 ? '' : 's'} for the AI Triage run ${actor?.user || 'the administrator'} confirmed.` });
          }
          // The administrator's own triage never uses up the developers' extras.
          const auditId = randomUUID();
          reservation.release();
          recordCreditUse({
            projectId, projectName, credits: alternateIds.length, scanId, kind: 'triage', covered: alternateIds.length,
            riskIds: [...new Set(group.map((f) => f.riskId))], alternateIds, groupIds: [...new Set(group.map((f) => f.groupId).filter(Boolean))], auditId,
          });
          auditCredit({ ...base, id: auditId, outcome: 'charged', charged: alternateIds.length, upstream, details: { origin, allocationRaisedBy: raised || undefined } });
        } else {
          auditCredit({ ...base, outcome: 'not-charged', reason: 'Checkmarx One already had this triage job; no new credits.', upstream });
        }
        actedOn('triage', group);
        touchProject(projectId);
        startedFindings.push(...group);
      } catch (error) {
        failed += group.length;
        errors.push(`${projectName}: ${error.message}`);
        auditCredit({
          ...base, outcome: 'failed', reason: error.message,
          upstream: { call: 'POST /api/ai-triage/triage', status: error.status ?? 0, error: String(error.body || error.message).slice(0, 500), ms: Date.now() - started },
        });
        if (error.status === 402 || error.status === 403) stopped = `Checkmarx One refused an earlier request (${error.status}).`;
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
      alreadyTriaged,
      errors,
      startedFindings,
    };
  } finally {
    claim.release();
  }
}

/**
 * Re-read the live state of the fetched projects' findings (verdicts arrive
 * minutes after a triage run), so what each project needs — confirmed
 * findings to remediate — follows without another full fetch.
 */
app.post(
  '/api/credits/refresh',
  requirePermission('credits.view'),
  asyncRoute(async (req, res) => {
    if (!req.session.lastScan) return res.status(409).json({ error: 'Fetch the project list first.' });
    const projects = scanProjects(req, req.body?.projectIds);
    await mapWithConcurrency(projects, 3, async (p) => {
      stateCache.delete(p.projectId);
      let live;
      try {
        live = await projectRiskInfo(req.session, p.projectId);
      } catch (error) {
        console.warn(`[credits] could not re-read ${logSafe(p.projectName)}: ${logSafe(error.message)}`);
        return;
      }
      for (const r of p.risks ?? []) {
        const now = live.info.get(r.riskId);
        if (now?.state && now.state !== r.state) r.state = now.state;
      }
    });
    // New verdicts change what is needed (e.g. confirmed findings to remediate), never what is allocated.
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
  requirePermission('triage.run'),
  afterFetch,
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

    const outcome = await adminTriage(req.session, findings, req.session.lastScan.initiators ?? {}, {
      actor: await adminActor(req),
      origin: `Dashboard: triage ${wanted.map((s) => s.toLowerCase()).join(', ')} now`,
    });
    for (const f of outcome.startedFindings) originals.get(f).triageRequestedAt = Date.now();
    for (const p of projects) p.credits = creditView(p);
    const { startedFindings, ...summary } = outcome;
    const notified = req.body?.notifyInitiators === false ? null : await notifyOnBehalf(req.session, 'triage', startedFindings, req.session.lastScan.initiators ?? {}, await adminActor(req));
    res.json({ ...summary, notified, projects: Object.fromEntries(projects.map((p) => [p.projectId, p.credits])) });
  }),
);

/**
 * Run AI Remediation for confirmed findings on the administrator's behalf:
 * one request per scan and scanner, 3 credits per finding, out of each
 * project's remediation allocation (and the credit pool). Only findings
 * confirmed in Checkmarx One right now are sent — the fence also applies here.
 * The results reach developers as they do when they click Remediate in a
 * report: a pull request where the project is set up for it, otherwise the
 * remediation details in the report.
 */
async function adminRemediate(session, findings, initiatorsByProject = {}, { actor = { kind: 'admin' }, origin = '' } = {}) {
  const cost = CREDIT_COST.remediation;
  await resolveAiIds(session.client, findings, (f) => initiatorsByProject[f.projectId]?.scanId ?? '');
  let eligible = findings.filter((f) => !f.aiUnavailable);
  const ineligible = findings.filter((f) => f.aiUnavailable);
  if (ineligible.length) auditRefusedRequest('remediation', actor, ineligible, `Not eligible for AI Remediation (${ineligible[0].aiUnavailable})`);

  // Fail-safe: claim before sending; then drop what has been remediated meanwhile.
  const claim = sendGuard.claim('remediation', eligible);
  if (claim.busy.length) auditRefusedRequest('remediation', actor, claim.busy, BUSY_REASON);
  noteBusy('remediation', claim.busy);
  eligible = claim.claimed;
  if (!settingsStore.get().aiTriage?.allowReremediation) {
    eligible = eligible.filter((f) => !creditLedger.remediatedIds(f.projectId).has(f.riskId));
  }
  try {
    const buckets = new Map();
    for (const f of eligible) {
      const key = `${f.projectId}|${f.scanId}|${f.scanner}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(f);
    }
    const limit = settingsStore.get().aiTriage?.monthlyCreditLimit ?? 0;
    let failed = 0;
    let notAllocated = 0;
    const errors = [];
    const startedFindings = [];
    for (const group of buckets.values()) {
      const { scanId, scanner, projectId, projectName } = group[0];
      const alternateIds = [...new Set(group.map((f) => f.alternateId))];
      const credits = cost * alternateIds.length;
      const base = { type: 'remediation', actor, findings: group, kind: 'remediation', requested: credits, before: balanceOf(projectId, 'remediation'), details: { origin } };
      // Allocated first, on purpose: remediation spends only what was given to the project.
      const refusal = creditRefusal(projectId, projectName, 'remediation', credits, limit);
      if (refusal) {
        failed += group.length;
        if (/credits? left/.test(refusal) && !/pool/.test(refusal)) notAllocated += credits - allocations.balance(projectId).remediation.remaining;
        errors.push(refusal);
        auditCredit({ ...base, outcome: 'refused', reason: refusal });
        continue;
      }
      const reservation = creditLedger.reserve(credits, limit, new Date(), { period: poolPeriod(), projectId, kind: 'remediation', allowance: allocations.balance(projectId).remediation.allocated });
      if (!reservation) {
        failed += group.length;
        errors.push(`${projectName}: credits are busy with another request; try again in a moment.`);
        auditCredit({ ...base, outcome: 'refused', reason: 'Credits reserved by concurrent requests; nothing sent.' });
        continue;
      }
      const started = Date.now();
      try {
        const body = await session.client.request('/api/remediation/remediate', {
          method: 'POST',
          body: { scanID: scanId, buckets: [{ scannerType: scanner.toLowerCase(), resultIDs: alternateIds }] },
          retries: 1,
        });
        const published = body?.published !== false;
        const upstream = { call: 'POST /api/remediation/remediate', status: 200, published, jobId: body?.remediationJobId ?? '', ms: Date.now() - started };
        if (published) {
          const auditId = randomUUID();
          reservation.release();
          recordCreditUse({ projectId, projectName, credits, scanId, kind: 'remediation', riskIds: [...new Set(group.map((f) => f.riskId))], covered: credits, auditId });
          auditCredit({ ...base, id: auditId, outcome: 'charged', charged: credits, upstream });
        } else {
          auditCredit({ ...base, outcome: 'not-charged', reason: 'Checkmarx One already had this remediation job; no new credits.', upstream });
        }
        actedOn('remediation', group);
        touchProject(projectId);
        startedFindings.push(...group);
      } catch (error) {
        failed += group.length;
        errors.push(`${projectName}: ${error.status === 402 ? 'Checkmarx One has no credits left for AI Remediation' : error.message}`);
        auditCredit({
          ...base, outcome: 'failed', reason: error.message,
          upstream: { call: 'POST /api/remediation/remediate', status: error.status ?? 0, error: String(error.body || error.message).slice(0, 500), ms: Date.now() - started },
        });
      } finally {
        reservation.release();
      }
    }
    return { requested: findings.length, started: startedFindings.length, failed, busy: claim.busy.length, skipped: ineligible.length, notAllocated, errors: [...new Set(errors)], startedFindings };
  } finally {
    claim.release();
  }
}

/**
 * The Dashboard's "Remediate selected": AI Remediation for the confirmed
 * findings (and only those) of the chosen severities in the chosen projects,
 * read live. Spends 3 credits each, from remediation credits already
 * allocated — "Allocate for remediation" first.
 */
app.post(
  '/api/remediation/run',
  requirePermission('triage.run'),
  afterFetch,
  asyncRoute(async (req, res) => {
    if (!req.session.lastScan) return res.status(409).json({ error: 'Fetch the project list first.' });
    const wanted = cleanSeverities(req.body?.severities);
    if (!wanted.length) return res.status(400).json({ error: 'Pick at least one severity to remediate.' });
    const { allowReremediation = false } = settingsStore.get().aiTriage ?? {};
    const projects = scanProjects(req, req.body?.projectIds);
    const findings = [];
    let notConfirmed = 0;
    for (const p of projects) {
      stateCache.delete(p.projectId);
      let live = null;
      try {
        live = await projectStates(req.session, p.projectId);
      } catch {}
      const remediated = allowReremediation ? new Set() : creditLedger.remediatedIds(p.projectId);
      for (const r of p.risks ?? []) {
        const state = live?.get(r.riskId) ?? r.state;
        if (state && state !== r.state) r.state = state;
        if (!wanted.includes(r.severity)) continue;
        if (!remediable({ ...r, state })) {
          if (state && state !== REMEDIABLE_STATE) notConfirmed += 1;
          continue;
        }
        if (remediated.has(r.riskId)) continue;
        findings.push({ ...r, projectId: p.projectId, projectName: p.projectName });
      }
    }
    // One finding per result: duplicates of one result are remediated (and charged) once.
    const unique = remediationCandidates(findings, wanted);
    if (!unique.length) {
      for (const p of projects) p.credits = creditView(p);
      return res.json({ requested: 0, started: 0, failed: 0, skipped: 0, notConfirmed, errors: [], projects: Object.fromEntries(projects.map((p) => [p.projectId, p.credits])) });
    }
    const outcome = await adminRemediate(req.session, unique, req.session.lastScan.initiators ?? {}, {
      actor: await adminActor(req),
      origin: `Dashboard: remediate confirmed ${wanted.map((s) => s.toLowerCase()).join(', ')}`,
    });
    for (const p of projects) p.credits = creditView(p);
    const { startedFindings, ...summary } = outcome;
    const notified = req.body?.notifyInitiators === false ? null : await notifyOnBehalf(req.session, 'remediation', startedFindings, req.session.lastScan.initiators ?? {}, await adminActor(req));
    res.json({ ...summary, notConfirmed, notified, projects: Object.fromEntries(projects.map((p) => [p.projectId, p.credits])) });
  }),
);

// ---------------------------------------------------------------------------
// Tracked reports: saved scopes whose progress is followed over time
// ---------------------------------------------------------------------------

const TRACK_REFRESH_MS = 60 * 60 * 1000;
const TRACK_TOUCHED_WINDOW_MS = 30 * 60 * 1000;
const TRACK_TOUCHED_EVERY_MS = 3 * 60 * 1000;
const refreshing = new Map();


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
        console.warn(`[tracked reports] ${logSafe(report.name)}: ${logSafe(error.message)}`),
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
      ? await runHtmlReminder(session, scan, {
          groupBy: sendTo === 'list' ? 'none' : emailContent === 'per-project' ? 'project' : 'initiator',
          alsoConsolidated: sendTo === 'both',
        }, relayUrl)
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
async function trackedReportHtml(session, report, scan, relayUrl, audience = {}, publish = '') {
  return buildInteractiveReport(session, openRisksOf(scan), {
    settings: settingsStore.get(),
    relayUrl,
    publish,
    initiatorsByProject: scan.initiators,
    audience: { purpose: `for tracked report "${report.name}"`, ...audience },
  });
}

/** One summary email of a tracked report's open findings to exactly these addresses. */
async function sendReportOnlyTo(session, report, scan, addresses, { attachHtml, dryRun, relayUrl }) {
  const settings = sendingSettings();
  if (!attachHtml) {
    const result = await runReminder(session, scan, { groupBy: 'none', dryRun, recipients: { to: addresses, exact: true } });
    if (dryRun && result.status === 200) result.body.recipients = { to: addresses, cc: [], bcc: [] };
    return result;
  }
  const filename = reportFileName(report);
  const { reportData, findings, html, downloadUrl } = await trackedReportHtml(session, report, scan, relayUrl, {
    recipient: addresses.join(', '),
    purpose: `emailed (only to) for tracked report "${report.name}"`,
  }, filename);
  const body = buildReportEmail(reportData, { greeting: 'Hi', topCount: findings.length, downloadUrl });
  const total = reportData.totalRisks ?? openRisksOf(scan).length;
  const message = { subject: `${report.name}: ${total} open vulnerabilities to triage`, html: body.html, text: body.text };
  if (dryRun) {
    return { status: 200, body: { dryRun: true, groupBy: 'none', subject: message.subject, html: message.html, recipients: { to: addresses, cc: [], bcc: [] }, canSend: isVerified(settings) } };
  }
  const result = await sendReminderMail(settings, message, {
    exact: true,
    to: addresses,
    attachments: [{ filename, content: html, contentType: 'text/html' }],
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
  const settings = sendingSettings();
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
      const server = resolveReportServer(null, settings);
      if (!server.url) console.warn(`! [reports] "${logSafe(report.name)}": sent without a reminder server address — set it in Settings → Links or REPORT_SERVER_URL.`);
      const result = await remindTrackedReport(session, report, auto, server.url, { automatic: true });
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
  requirePermission('reports.remind'),
  asyncRoute(async (req, res) => {
    const report = trackedReports.get(req.params.id);
    if (!report) return res.status(404).json({ error: 'No such report.' });
    const settings = sendingSettings();
    if (req.body?.dryRun !== true && !isVerified(settings)) {
      return res.status(400).json({ error: 'Test the SMTP connection on the Settings page before sending.' });
    }
    const { status, body } = await remindTrackedReport(req.session, report, req.body ?? {}, reportServerUrl(req, settings));
    res.status(status).json({ ...body, report: trackedView(report) });
  }),
);

app.put('/api/tracked-reports/:id/automation', requirePermission('reports.manage'), (req, res) => {
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
  requirePermission('reports.view'),
  asyncRoute(async (req, res) => {
    const report = trackedReports.get(req.params.id);
    if (!report) return res.status(404).json({ error: 'No such report.' });
    const scan = await openScanFor(req.session, report);
    if (!openRisksOf(scan).length) return res.status(400).json({ error: 'Nothing is left open in this report.' });
    const actor = await adminActor(req);
    const { html } = await trackedReportHtml(req.session, report, scan, reportServerUrl(req, settingsStore.get()), {
      actor,
      recipient: `downloaded by ${actor.user || 'administrator'}`,
      purpose: `downloaded for tracked report "${report.name}"`,
    });
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
  requirePermission('credits.allocate'),
  afterFetch,
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
    const actor = await adminActor(req);
    const before = new Map(report.projects.map((p) => [p.projectId, allocationSnapshot(p.projectId)]));
    // The severities join each project's rule, and the person clicking Allocate gives what they now need.
    for (const { projectId, projectName } of report.projects) {
      if (wanted.length) allocations.setSeverities(projectId, projectName, SEVERITIES.filter((s) => wanted.includes(s) || allocations.severitiesOf(projectId).includes(s)));
    }
    // What is needed comes from two agreeing reads of Checkmarx One, never an estimate.
    const verifiedRisks = new Map();
    if (wanted.length) {
      const lastScans = await getLastScans(req.session.client, report.projects.map((p) => p.projectId)).catch(() => ({}));
      const scanIdOf = (id) => String(lastScans?.[id]?.id ?? lastScans?.[id]?.scanId ?? '');
      const refused = [];
      await mapWithConcurrency(report.projects, 3, async (p) => {
        try {
          const { second, agreed } = await doubleRead(req.session, p, { scanIdOf });
          if (agreed) verifiedRisks.set(p.projectId, second.summary.risks);
          else refused.push(`${p.projectName}: ${DISAGREED}`);
        } catch (error) {
          refused.push(`${p.projectName}: could not read Checkmarx One (${error.message})`);
        }
      });
      if (refused.length) {
        allocations.save();
        const reason = `Not allocated: what the report's projects need could not be confirmed twice with Checkmarx One. ${refused[0]}`;
        audit.record({ type: 'allocation', outcome: 'refused', reason, actor, credits: { kind: 'allocation', requested: 0, charged: 0 }, details: { report: report.id } });
        return res.status(409).json({ error: reason });
      }
    }
    const plan = report.projects.map(({ projectId, projectName }) => {
      const { shortfall } = allocations.need(projectId, verifiedRisks.get(projectId) ?? byProject.get(projectId) ?? []);
      return { projectId, projectName, triage: wanted.length ? shortfall.triage : 0, remediation: wanted.length ? shortfall.remediation : 0 };
    });
    const given = plan.reduce((n, x) => n + x.triage + x.remediation + extraTriage + extraRemediation, 0);
    const pool = creditPool();
    if (pool.limited && given > pool.unallocated) {
      allocations.save();
      const reason = `Only ${pool.unallocated} credit${pool.unallocated === 1 ? '' : 's'} left in the credit pool to give; ${given} needed for tracked report "${report.name}".`;
      audit.record({ type: 'allocation', outcome: 'refused', reason, actor, credits: { kind: 'allocation', requested: given, charged: 0 }, details: { report: report.id, pool } });
      return res.status(409).json({ error: `${reason} Raise the pool under Settings → AI & credits.`, pool });
    }
    for (const { projectId, projectName, triage, remediation } of plan) {
      if (triage) allocations.grant(projectId, projectName, 'triage', triage);
      if (remediation) allocations.grant(projectId, projectName, 'remediation', remediation);
      if (extraTriage) allocations.add(projectId, projectName, 'triage', extraTriage);
      if (extraRemediation) allocations.add(projectId, projectName, 'remediation', extraRemediation);
    }
    allocations.save();
    for (const { projectId, projectName } of report.projects) {
      auditAllocation({
        actor, projectId, projectName, before: before.get(projectId),
        change: { severities: wanted, addTriage: extraTriage || undefined, addRemediation: extraRemediation || undefined },
        reason: `Changed from tracked report "${report.name}".`,
      });
    }
    res.json({ report: trackedView(report) });
  }),
);

app.post(
  '/api/tracked-reports/:id/triage',
  requirePermission('triage.run'),
  afterFetch,
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
    const { startedFindings, ...summary } = await adminTriage(req.session, findings, scan.initiators, {
      actor: await adminActor(req),
      origin: `Tracked report "${report.name}": triage the open findings`,
    });
    const notified = req.body?.notifyInitiators === false ? null : await notifyOnBehalf(req.session, 'triage', startedFindings, scan.initiators, await adminActor(req));
    res.json({ ...summary, notified, report: trackedView(report) });
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

app.get('/api/tracked-reports', requirePermission('reports.view'), async (req, res) => {
  res.json({
    timeZone: serverTimeZone(),
    reports: trackedReports.list().map(trackedView),
    autoRefresh: Boolean(sessions.get(automationSessionId) ?? sessions.get(bootstrapSessionId) ?? settingsStore.get().automationApiKey),
  });
});

app.post('/api/tracked-reports', requirePermission('reports.manage'), (req, res) => {
  const { lastScan } = req.session;
  if (!lastScan) return res.status(409).json({ error: 'Fetch the project list first.' });
  const { name, severities = null, buckets = [], windows = {}, scopeLabel = '' } = req.body ?? {};
  const projectIds = idList(req.body?.projectIds);
  if (!String(name ?? '').trim()) return res.status(400).json({ error: 'Give the report a name.' });

  const wantedSeverities = (Array.isArray(severities) ? severities : []).map((s) => String(s).toUpperCase()).filter((s) => SEVERITIES.includes(s));
  const wantedBuckets = (Array.isArray(buckets) ? buckets : []).map(String).filter((b) => AGE_BUCKETS.some((a) => a.id === b));
  const risks = selectRisks(lastScan.projects, {
    projectIds: projectIds.length ? projectIds : null,
    buckets: wantedBuckets,
    severities: wantedSeverities.length ? wantedSeverities : null,
  });
  const inScope = lastScan.projects.filter((p) => !p.error && (!projectIds.length || projectIds.includes(p.projectId)));
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
  requirePermission('reports.view'),
  asyncRoute(async (req, res) => {
    const report = trackedReports.get(req.params.id);
    if (!report) return res.status(404).json({ error: 'No such report.' });
    await refreshTrackedReport(report, req.session);
    res.json(trackedView(report));
  }),
);

app.delete('/api/tracked-reports/:id', requirePermission('reports.manage'), (req, res) => {
  if (!trackedReports.delete(req.params.id)) return res.status(404).json({ error: 'No such report.' });
  res.json({ deleted: true });
});

// Administrator view of AI Triage credits used from reports.
app.get('/api/credits', requirePermission('credits.view'), (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month ?? '')) ? String(req.query.month) : monthOf();
  const { aiTriage } = settingsStore.get();
  res.json({
    ...creditLedger.summary(month),
    months: [...new Set([monthOf(), ...creditLedger.months()])],
    enabled: Boolean(aiTriage?.enabled),
    remediationEnabled: Boolean(aiTriage?.remediationEnabled),
    monthlyCreditLimit: aiTriage?.monthlyCreditLimit ?? 0,
    remaining: month === monthOf() ? creditsRemaining() : null,
    pool: creditPool(),
    allocations: allocations.list(),
    relayConnected: Boolean(sessions.get(automationSessionId) ?? sessions.get(bootstrapSessionId) ?? settingsStore.get().automationApiKey),
  });
});

/** The credit pool now: size, used (triage / remediation), left, given to projects, free to give. */
function creditPool(settings = settingsStore.get()) {
  const period = poolPeriod(settings);
  return poolSummary({
    size: settings.aiTriage?.monthlyCreditLimit ?? 0,
    period,
    used: creditLedger.usedInPeriod(period),
    reserved: creditLedger.reserved,
    allocations: allocations.list(),
  });
}

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
    pool: creditPool(),
    allocations: projectId ? list.filter((p) => p.projectId === projectId) : list,
    projects: list.map((p) => ({ projectId: p.projectId, projectName: p.projectName })),
  });
});

/**
 * Build the interactive HTML report for a set of findings. The top findings
 * get the identifiers Checkmarx One AI Triage / Remediation need resolved
 * here, with this session's credentials, so the report itself only ever
 * needs the reader's own API key.
 */
async function buildInteractiveReport(session, risks, { buckets = [], settings, initiator = null, relayUrl = '', initiatorsByProject, audience = {}, publish = '' } = {}) {
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
  const html = generateHtmlReport(reportData, {
    findings,
    bulkFindings,
    relayUrl,
    remediationViaRelay: true,
    portalUrl: settings.links.baseUrl,
    sign: (finding) => reportGrants.issue(finding),
    reportToken,
    connection: { tenant: connection.tenant, iamUrl: connection.iamUrl, baseUrl: connection.baseUrl },
    branding: settings.branding,
    allowRetriage: Boolean(settings.aiTriage?.allowRetriage),
    allowReremediation: Boolean(settings.aiTriage?.allowReremediation),
    adminContact: adminContact(settings),
  });
  // For email: keep the file, so the email's button can download exactly this report.
  let downloadUrl = '';
  if (publish && relayUrl) {
    reportFiles.save(reportToken.id, html, { filename: publish });
    downloadUrl = reportDownloadUrl(relayUrl, reportToken.id);
  }
  return { reportData, findings, html, downloadUrl, reportId: reportToken.id };
}

/** A link only this server could have made: the report id plus its signature. */
const downloadSignature = (id) => reportGrants.macText(`download\n${id}`);
function reportDownloadUrl(relayUrl, id) {
  return `${String(relayUrl).replace(/\/+$/, '')}/r/${id}?s=${encodeURIComponent(downloadSignature(id))}`;
}

function linkPage(title, message) {
  const name = escapeHtml(settingsStore.get().branding.appName || 'Mission Zero');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · ${name}</title><style>body{font:15px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f7fb;color:#1f2330}
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
    const { buckets = [], severities = null } = req.body ?? {};
    const projectIds = idList(req.body?.projectIds);
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
        <!-- Buckets filter: ${buckets.length > 0 ? commentSafe(buckets.join(', ')) : 'none (include all)'} -->
        <!-- Severities filter: ${severities?.length > 0 ? commentSafe(severities.join(', ')) : 'none (include all)'} -->
        `
      : '';

    const actor = await adminActor(req);
    const { html } = await buildInteractiveReport(req.session, risks, {
      buckets,
      settings,
      relayUrl: reportServerUrl(req, settings),
      audience: { actor, recipient: `downloaded by ${actor.user || 'administrator'}`, purpose: 'downloaded from the Dashboard' },
    });
    const htmlReport = html + diagnostics;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(htmlReport);
  }),
);

/** Send each scan initiator an email with the interactive HTML report attached. */
async function runHtmlReminder(session, scan, input, relayUrl) {
  const reply = (status, payload) => ({ status, body: payload });
  const { projectIds = null, buckets = [], severities = null, initiators = null, alsoConsolidated = false } = input;
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
      settings,
      relayUrl,
      initiatorsByProject,
      initiator,
      audience: { recipient: to.join(', '), purpose },
      publish: attachmentName,
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
    if (!req.session.lastScan) return res.status(409).json({ error: 'Fetch the project list first.' });
    const settings = settingsStore.get();
    const { status, body } = await runHtmlReminder(req.session, req.session.lastScan, req.body ?? {}, reportServerUrl(req, settings));
    res.status(status).json(body);
  }),
);

// ---------------------------------------------------------------------------
// Audit log: browse, export, verify, reconcile
// ---------------------------------------------------------------------------

function auditFilters(query) {
  const list = (v) => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const date = (v) => (/^\d{4}-\d{2}-\d{2}/.test(String(v ?? '')) ? String(v) : '');
  return {
    from: date(query.from),
    to: date(query.to),
    types: list(query.types),
    outcomes: list(query.outcomes),
    project: String(query.project ?? '').slice(0, 200),
    q: String(query.q ?? '').slice(0, 200),
    before: Number(query.before) || 0,
    limit: Math.min(1000, Math.max(1, Number(query.limit) || 100)),
  };
}

app.get('/api/audit', requirePermission('audit.view'), async (req, res) => {
  await audit.settled();
  res.json({ ...audit.query(auditFilters(req.query)), writeError: audit.writeError });
});

const CSV_COLUMNS = [
  ['seq', (e) => e.seq],
  ['time', (e) => e.at],
  ['type', (e) => e.type],
  ['outcome', (e) => e.outcome],
  ['reason', (e) => e.reason],
  ['actor', (e) => e.actor?.kind],
  ['user', (e) => e.actor?.user || e.actor?.recipient],
  ['report_id', (e) => e.actor?.reportId || e.details?.reportId],
  ['ip', (e) => e.actor?.ip],
  ['project_id', (e) => e.project?.id],
  ['project', (e) => e.project?.name],
  ['credit_kind', (e) => e.credits?.kind],
  ['credits_requested', (e) => e.credits?.requested],
  ['credits_charged', (e) => e.credits?.charged],
  ['allocated_before', (e) => e.balance?.before?.allocated],
  ['remaining_before', (e) => e.balance?.before?.remaining],
  ['allocated_after', (e) => e.balance?.after?.allocated],
  ['remaining_after', (e) => e.balance?.after?.remaining],
  ['month_remaining', (e) => e.month?.remaining],
  ['findings', (e) => (e.findings ?? []).map((f) => f.riskId).join(' ')],
  ['upstream_call', (e) => e.upstream?.call],
  ['upstream_status', (e) => e.upstream?.status],
  ['upstream_job', (e) => e.upstream?.jobId],
  ['upstream_error', (e) => e.upstream?.error],
  ['entry_id', (e) => e.id],
  ['mac', (e) => e.mac],
];
const csvCell = (v) => {
  const text = v === undefined || v === null ? '' : String(v);
  // Neutralise spreadsheet formulas, then quote.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Everything matching the filters, as CSV (for spreadsheets) or JSON Lines (complete, verifiable). */
app.get('/api/audit/export', requirePermission('audit.export'), async (req, res) => {
  await audit.settled();
  const filters = { ...auditFilters(req.query), limit: 1_000_000, before: 0 };
  const format = req.query.format === 'jsonl' ? 'jsonl' : 'csv';
  const { entries } = audit.query(filters);
  entries.reverse();
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="audit-${stamp}.${format}"`);
  if (format === 'jsonl') {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    return res.send(entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send([CSV_COLUMNS.map(([name]) => name).join(','), ...entries.map((e) => CSV_COLUMNS.map(([, get]) => csvCell(get(e))).join(','))].join('\n') + '\n');
});

/** Walk the hash chain: any edited, removed or reordered entry is found. */
app.get('/api/audit/verify', requirePermission('audit.view'), async (req, res) => {
  await audit.settled();
  const result = audit.verify();
  audit.record({
    type: 'audit',
    outcome: 'info',
    reason: result.ok ? `Audit log verified intact (${result.entries} entries).` : `Audit log verification found ${result.problems.length} problem(s).`,
    actor: await adminActor(req),
    details: { verify: { ok: result.ok, entries: result.entries, problems: result.problems.slice(0, 10) } },
  });
  res.json(result);
});

/**
 * Do the credits the audit log says were charged match the ledger the
 * balances are computed from? Per month and per project, plus ledger entries
 * with no audit entry (spent before auditing began).
 */
app.get('/api/audit/reconcile', requirePermission('audit.view'), async (req, res) => {
  await audit.settled();
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month ?? '')) ? String(req.query.month) : monthOf();
  const audited = new Map();
  const auditIds = new Set();
  for (const e of audit.entries({ from: `${month}-01`, to: `${month}-31` })) {
    if (e.corrupt || !e.at?.startsWith(month) || !e.credits?.charged) continue;
    auditIds.add(e.id);
    const key = e.project?.id ?? '';
    const row = audited.get(key) ?? { projectId: key, projectName: e.project?.name ?? '', audited: 0 };
    row.audited += e.credits.charged;
    audited.set(key, row);
  }
  const ledger = creditLedger.summary(month);
  const rows = new Map();
  for (const p of ledger.projects) rows.set(p.projectId, { projectId: p.projectId, projectName: p.projectName, ledger: p.credits, audited: 0 });
  for (const [key, a] of audited) {
    const row = rows.get(key) ?? { projectId: key, projectName: a.projectName, ledger: 0, audited: 0 };
    row.audited = a.audited;
    rows.set(key, row);
  }
  const unlinked = creditLedger.entriesInMonth(month).filter((e) => !e.auditId);
  const missing = creditLedger.entriesInMonth(month).filter((e) => e.auditId && !auditIds.has(e.auditId));
  const projects = [...rows.values()].map((r) => ({ ...r, difference: r.ledger - r.audited })).sort((a, b) => b.ledger - a.ledger);
  res.json({
    month,
    ledgerTotal: ledger.total,
    auditedTotal: projects.reduce((n, r) => n + r.audited, 0),
    matched: projects.every((r) => r.difference === 0 || unlinked.some((u) => u.projectId === r.projectId)) && !missing.length,
    projects,
    unlinked: { entries: unlinked.length, credits: unlinked.reduce((n, e) => n + e.credits, 0), note: 'Spent before the audit log existed.' },
    missing: missing.map((e) => ({ at: e.at, projectId: e.projectId, credits: e.credits, auditId: e.auditId })),
  });
});

// ---------------------------------------------------------------------------
// Backup and restore: one file rebuilds the whole server
// ---------------------------------------------------------------------------

const backupConfig = {
  dir: path.resolve(process.env.BACKUP_DIR?.trim() || path.join(dataDir, 'backups')),
  explicitDir: Boolean(process.env.BACKUP_DIR?.trim()),
  intervalHours: Math.max(0, Number(process.env.BACKUP_INTERVAL_HOURS ?? 24) || 0),
  keep: Math.max(1, Number(process.env.BACKUP_KEEP) || 14),
  passphrase: process.env.BACKUP_PASSPHRASE || '',
};
let lastBackup = null;

/** Everything written to disk first, so the backup is a consistent picture. */
async function settleState() {
  knownAddresses.flush();
  creditLedger.flush();
  await audit.settled();
}

async function backupToFolder(actor, trigger) {
  await settleState();
  try {
    const { file, summary, removed } = writeBackupTo(backupConfig.dir, {
      dataDir,
      settingsFile: config.settingsFile,
      passphrase: backupConfig.passphrase,
      keep: backupConfig.keep,
    });
    lastBackup = { at: summary.createdAt, ok: true, file, size: summary.size, files: summary.files, trigger };
    audit.record({
      type: 'backup',
      outcome: 'info',
      reason: `${trigger} backup written to ${file} (${summary.files} files${summary.encrypted ? ', encrypted' : ''}).`,
      actor,
      details: { backup: { file, ...summary, removed } },
    });
  } catch (error) {
    lastBackup = { at: new Date().toISOString(), ok: false, error: error.message, trigger };
    audit.record({ type: 'backup', outcome: 'failed', reason: `${trigger} backup to ${backupConfig.dir} failed: ${error.message}`, actor });
    console.error(`! [backup] ${error.message}`);
  }
  return lastBackup;
}

if (backupConfig.intervalHours > 0) {
  const every = backupConfig.intervalHours * 3600_000;
  // First one soon after start (a fresh baseline), then on the interval.
  setTimeout(() => {
    backupToFolder(SYSTEM_ACTOR, 'Scheduled');
    setInterval(() => backupToFolder(SYSTEM_ACTOR, 'Scheduled'), every).unref();
  }, 60_000).unref();
}

app.get('/api/backup', requirePermission('backup.view'), (req, res) => {
  const files = collectStateFiles(dataDir, config.settingsFile);
  const bytes = files.reduce((sum, f) => sum + fs.statSync(f.path).size, 0);
  res.json({
    dataDir,
    source: dataDirSource,
    insideProject: insideProject(dataDir, projectDir),
    files: files.length,
    bytes,
    backupDir: backupConfig.dir,
    backupDirExplicit: backupConfig.explicitDir,
    sameDisk: !backupConfig.explicitDir || insideProject(backupConfig.dir, dataDir),
    intervalHours: backupConfig.intervalHours,
    keep: backupConfig.keep,
    encrypted: Boolean(backupConfig.passphrase),
    last: lastBackup,
    backups: listBackups(backupConfig.dir).slice(0, 30),
    pendingRestore: fs.existsSync(path.join(dataDir, PENDING_RESTORE)),
    restoredAtStart: restoredAtStart && { createdAt: restoredAtStart.createdAt, files: restoredAtStart.files, replacedDir: restoredAtStart.replacedDir },
  });
});

/** Download a backup now (encrypted when BACKUP_PASSPHRASE is set). */
app.get('/api/backup/download', requirePermission('backup.manage'), asyncRoute(async (req, res) => {
  await settleState();
  const { buffer, summary } = createBackup({ dataDir, settingsFile: config.settingsFile, passphrase: backupConfig.passphrase });
  audit.record({
    type: 'backup',
    outcome: 'info',
    reason: `Backup downloaded (${summary.files} files${summary.encrypted ? ', encrypted' : ', not encrypted'}).`,
    actor: await adminActor(req),
    details: { backup: summary },
  });
  const stamp = summary.createdAt.replace(/[:.]/g, '-').slice(0, 19);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="mission-zero-${stamp}.mzbackup"`);
  res.send(buffer);
}));

app.post('/api/backup/now', requirePermission('backup.run'), asyncRoute(async (req, res) => {
  const result = await backupToFolder(await adminActor(req), 'Manual');
  if (!result.ok) return res.status(500).json({ error: `Backup failed: ${result.error}` });
  res.json({ ...result, backups: listBackups(backupConfig.dir).slice(0, 30) });
}));

/**
 * Upload a backup. ?check=1 only reads it and says what it holds. Otherwise
 * it is staged and applied at the next start: the running server would write
 * its in-memory state straight over restored files.
 */
app.post(
  '/api/backup/restore',
  requirePermission('backup.manage'),
  express.raw({ type: () => true, limit: '1gb' }),
  asyncRoute(async (req, res) => {
    const actor = await adminActor(req);
    let bundle;
    try {
      bundle = readBackup(req.body ?? Buffer.alloc(0), { passphrase: String(req.get('x-backup-passphrase') ?? '') || backupConfig.passphrase });
    } catch (error) {
      if (req.query.check !== '1') audit.record({ type: 'backup', outcome: 'refused', reason: `Restore refused: ${error.message}`, actor });
      return res.status(400).json({ error: error.message });
    }
    const info = describeBackup(bundle);
    if (req.query.check === '1') return res.json({ backup: info });
    // Staged decrypted: it sits in the state folder (0600) beside the same secrets.
    const pending = path.join(dataDir, PENDING_RESTORE);
    fs.writeFileSync(`${pending}.partial`, zlib.gzipSync(Buffer.from(JSON.stringify(bundle))), { mode: 0o600 });
    fs.renameSync(`${pending}.partial`, pending);
    audit.record({
      type: 'backup',
      outcome: 'changed',
      reason: `Restore staged from the backup of ${info.createdAt}: applied at the next restart.`,
      actor,
      details: { restore: { createdAt: info.createdAt, host: info.host, files: info.files, sha256: info.sha256 } },
    });
    await audit.settled();
    res.json({ backup: info, staged: true, restartRequired: true });
  }),
);

app.delete('/api/backup/restore', requirePermission('backup.manage'), asyncRoute(async (req, res) => {
  const pending = path.join(dataDir, PENDING_RESTORE);
  if (fs.existsSync(pending)) {
    fs.rmSync(pending, { force: true });
    audit.record({ type: 'backup', outcome: 'changed', reason: 'Staged restore cancelled.', actor: await adminActor(req) });
  }
  res.json({ pendingRestore: false });
}));

// ---------------------------------------------------------------------------
// Beta: GitHub identity matching, and emailing the authors of vulnerable code
// ---------------------------------------------------------------------------

const gitCacheDir = path.join(dataDir, 'git-cache');

/** The GitHub connection: what Settings stores, else GITHUB_TOKEN / GITHUB_API_URL / GITHUB_ORG from the environment. */
function githubConfig(settings = settingsStore.get()) {
  const github = settings.beta?.github ?? {};
  const env = (name) => String(process.env[name] ?? '').trim();
  const defaultApi = !github.apiUrl || github.apiUrl === 'https://api.github.com';
  return {
    ...github,
    token: github.token || env('GITHUB_TOKEN'),
    tokenSource: github.token ? 'settings' : env('GITHUB_TOKEN') ? 'environment' : 'none',
    apiUrl: defaultApi && env('GITHUB_API_URL') ? env('GITHUB_API_URL').replace(/\/+$/, '') : github.apiUrl || 'https://api.github.com',
    org: github.org || env('GITHUB_ORG'),
  };
}

function githubClient(settings = settingsStore.get()) {
  const github = githubConfig(settings);
  return new GitHubClient({ token: github.token, apiUrl: github.apiUrl });
}

/**
 * The three connections the header shows, green or red, with a few details:
 * Checkmarx One (the server's integration), the mail server (passed its test
 * with the current settings), GitHub (the token answers). GitHub is checked
 * at most every 5 minutes, and again when its settings change.
 */
let githubCheck = { key: '', at: 0, result: null };
async function connectionsStatus() {
  const settings = settingsStore.get();
  const cx = integrationStatus();
  const smtp = settings.smtp ?? {};
  const verified = isVerified(settings);
  const gh = githubConfig(settings);
  const ghKey = createHash('sha256').update(`${gh.apiUrl}|${gh.token}`).digest('hex');
  if (gh.token && (githubCheck.key !== ghKey || Date.now() - githubCheck.at > 5 * 60_000)) {
    try {
      const user = await githubClient(settings).rest('/user');
      githubCheck = { key: ghKey, at: Date.now(), result: { ok: true, login: user?.login ?? '' } };
    } catch (error) {
      githubCheck = { key: ghKey, at: Date.now(), result: { ok: false, reason: `GitHub refused the token: ${error.message}` } };
    }
  }
  const ghResult = gh.token ? githubCheck.result : { ok: false, reason: 'No GitHub token: add GITHUB_TOKEN to the .env file, or set it on the Beta page.' };
  return {
    cxone: {
      ok: cx.connected,
      tenant: cx.connection?.tenant ?? '',
      apiUrl: cx.connection?.baseUrl ?? '',
      iamUrl: cx.connection?.iamUrl ?? '',
      source: cx.source,
      pending: cx.pending,
      reason: cx.connected ? (cx.pending ? 'A changed connection is being checked; the last known good one is in use.' : '') : 'Not connected: an Admin connects it under Settings → Checkmarx One integration, or with CX_API_KEY.',
    },
    smtp: {
      ok: Boolean(smtp.host) && verified,
      host: smtp.host ?? '',
      port: smtp.port ?? null,
      tls: smtp.secure ? 'implicit TLS' : 'STARTTLS',
      from: smtp.fromAddress || smtp.user || '',
      verifiedAt: verified ? settings.verifiedAt ?? null : null,
      reason: !smtp.host ? 'No mail server: set it under Settings → Email server, or with SMTP_HOST in the .env file.' : verified ? '' : 'Not tested with these settings: Settings → Email server → Test connection.',
    },
    github: {
      ok: Boolean(ghResult?.ok),
      login: ghResult?.login ?? '',
      apiUrl: gh.apiUrl,
      org: gh.org ?? '',
      source: gh.tokenSource,
      checkedAt: gh.token ? new Date(githubCheck.at).toISOString() : null,
      reason: ghResult?.ok ? '' : ghResult?.reason ?? '',
    },
  };
}

app.get('/api/connections', requireSession, asyncRoute(async (req, res) => res.json(await connectionsStatus())));

/** Usernames worth matching: scan initiators that are not already addresses. */
function initiatorLogins(lastScan) {
  const logins = new Set();
  for (const info of Object.values(lastScan?.initiators ?? {})) {
    const name = String(info?.initiator ?? '').trim();
    if (name && !name.includes('@') && validLogin(name)) logins.add(name);
  }
  return [...logins];
}

app.get('/api/beta/github/logins', requirePermission('beta.use'), (req, res) => {
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
  requirePermission('beta.use'),
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
app.post('/api/beta/github/apply', requirePermission('beta.use'), (req, res) => {
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
  requirePermission('beta.use'),
  asyncRoute(async (req, res) => {
    const { lastScan, client, connection } = req.session;
    if (!lastScan) return res.status(409).json({ error: 'Fetch the project list first.' });
    const settings = settingsStore.get();
    const github = settings.beta?.github ?? {};
    const { severities = null } = req.body ?? {};
    const projectIds = idList(req.body?.projectIds);
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
  requirePermission('beta.use'),
  asyncRoute(async (req, res) => {
    const items = req.session.lastAuthors;
    if (!items?.length) return res.status(409).json({ error: 'Find the code authors first.' });
    const settings = sendingSettings();
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
  // An error raised on purpose carries its HTTP status and a message meant for
  // the user. Anything else is unexpected: its details (paths, internals) stay
  // in the server log, and the browser gets a plain message.
  const expected = Number.isInteger(error.status) && error.status >= 400 && error.status < 600;
  console.error(`${logSafe(req.method)} ${logSafe(req.path)} ->`, logSafe(expected ? error.message : error.stack ?? error.message));
  if (!expected) {
    diagnostics.error('unexpected-error', error, { route: req.route ? `${req.baseUrl}${req.route.path}` : '(unmatched)', method: req.method });
    return res.status(500).json({ error: 'Something went wrong on the server. The details are in its log.' });
  }
  if (error.status >= 500) diagnostics.error('upstream-error', error, { route: req.route ? `${req.baseUrl}${req.route.path}` : '(unmatched)', status: error.status });
  res.status(error.status).json({ error: error.message ?? 'Unexpected error.', detail: error.body ?? undefined });
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
    result.pinned = true;
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
/** Upgrading: connections that already work become the first last known good ones. */
function seedLastKnownGood() {
  const settings = settingsStore.get();
  const bootstrap = sessions.get(bootstrapSessionId);
  if (!guard.lastGood('cxone') && !settings.automationApiKey && bootstrap) {
    const { tenant, baseUrl, iamUrl } = bootstrap.connection;
    guard.recordGood('cxone', { apiKey: '', overrides: { baseUrl: '', iamUrl: '', tenant: '' }, connection: { tenant, baseUrl, iamUrl } });
  }
  if (!guard.lastGood('smtp') && isVerified(settings)) guard.recordGood('smtp', settings.smtp);
}

async function verifyEnvironmentSmtp() {
  const settings = settingsStore.get();
  if (!hasEnvironmentSmtp() || isVerified(settings)) return;
  try {
    const result = await retryWithBackoff('SMTP', () => testConnection(settings.smtp));
    guard.recordGood('smtp', settingsStore.markVerified().smtp);
    console.log(`[SMTP] ${result.message} Sending is unlocked.`);
  } catch (error) {
    console.warn(`! [SMTP] Startup connection test failed after 3 attempts: ${error.message}`);
  }
}

// Everyone signed in before this start (an update, a restart, a crash) stays signed in, with their fetched data.
// Not after a restore from backup, which may have changed who exists.
if (restoredAtStart) {
  sessionPersistence.clear();
} else {
  const saved = sessionPersistence.load();
  if (saved.length) {
    const kept = sessions.adopt(saved, integrationSession, (key) => sessionPersistence.readScan(key));
    saveSignInsSoon();
    console.log(`[sessions] Kept ${kept} sign-in(s) and their fetched data from before this start.`);
  }
}

const server = app.listen(config.port, config.host, async () => {
  console.log(`Mission Zero ${APP_VERSION} running on http://${config.host}:${config.port}`);
  console.log(`Settings file: ${settingsStore.file}`);
  for (const problem of configProblems(config)) console.warn(`! ${problem}`);
  await prepareAccess();
  await bootstrap();
  await verifyEnvironmentSmtp();
  await resolveAutomationSession();
  seedLastKnownGood();
  scheduler.sync();
  // Settings changed and left unchecked before a restart (or a timeout): check them now, rolling back what fails.
  if (cxonePending() || smtpPending()) {
    checkConnections({ rollback: true, trigger: 'server start' }).catch((error) => console.warn(`! [settings] Connection check failed: ${error.message}`));
  }
  const automation = settingsStore.get().automation;
  if (automation.enabled) {
    console.log(
      `Automation on: every ${automation.intervalMinutes}m, thresholds ${automation.thresholds.join('/')} days` +
        (automation.dryRun ? ' (dry run)' : ''),
    );
  }
});

/**
 * Stop cleanly (a container update or restart sends SIGTERM): stop taking new
 * work, let requests in progress finish (up to SHUTDOWN_DRAIN_SECONDS, 8 by
 * default), hand sign-ins and their fetched data to the next server, write
 * everything still buffered, and let go of the data folder.
 */
const DRAIN_MS = Math.max(0, Number(process.env.SHUTDOWN_DRAIN_SECONDS ?? 8)) * 1000; // inside the 10 s Podman and Docker allow by default
let stopping = false;
const shutdown = async (signal) => {
  if (stopping) return;
  stopping = true;
  draining = true;
  scheduler.stop();
  server.close();
  server.closeIdleConnections?.();
  console.log(`[update] ${signal}: finishing ${inFlight} request(s) in progress…`);
  const until = Date.now() + DRAIN_MS;
  while (inFlight > 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100));
  if (inFlight > 0) console.warn(`! [update] ${inFlight} request(s) still running after ${DRAIN_MS / 1000}s; stopping anyway.`);
  try {
    clearTimeout(indexTimer);
    const index = sessions.index();
    sessionPersistence.saveIndex(index);
    sessionPersistence.flushSync(sessions.persistable().map(({ key, session }) => ({ key, scan: session.lastScan })));
    if (index.length) console.log(`[update] Saved ${index.length} sign-in(s) and their fetched data for the next server.`);
  } catch (error) {
    console.warn(`! [update] Could not save sign-ins for the next server: ${error.message}`);
  }
  knownAddresses.flush();
  creditLedger.flush();
  audit.flushSync();
  diagnostics.flush();
  instanceLock.release();
  console.log('[update] Stopped cleanly.');
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, sessions, settingsStore };
