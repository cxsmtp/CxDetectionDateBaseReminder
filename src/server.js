import { fileURLToPath } from 'node:url';
import path from 'node:path';

import http from 'node:http';
import express from 'express';
import compression from 'compression';

import { config, configProblems } from './config.js';
import { APP_VERSION, PACKAGE_VERSION } from './version.js';
import { DEFAULT_IMAGE } from './updates/registry.js';
import { UpdateService } from './updates/service.js';
import { VersionStore } from './updates/store.js';
import { SendGuard } from './send-guard.js';
import { Diagnostics } from './diagnostics.js';
import { filterProjectsByActivity, getLastScans, lastScanDate, listProjects } from './cxone/projects.js';
import { AGE_BUCKETS, collectProjectRisks, createRiskSource, normalizeRisk, projectReads, selectRisks, summariseProject } from './cxone/risks.js';
import { discover } from './cxone/discovery.js';
import { collectInitiators, groupRisksByInitiator, groupRisksByProject, projectsInScope, scanInitiator, scanInitiatorEmail } from './cxone/initiators.js';
import { AI_SCANNERS, resolveAiIds, resultRowsFor } from './cxone/ai-assist.js';
import { mapWithConcurrency } from './cxone/client.js';
import { ReportGrants } from './report-grants.js';
import { gitPatch, patchLinks } from './remediation-patch.js';
import { CREDIT_COST, CreditLedger, monthOf } from './credits.js';
import { CreditAllocations, creditFigures, REMEDIABLE_STATE, alreadySent, billingUnit, remediable, remediationCandidates, triageRows } from './credit-allocations.js';
import { poolSummary, resolveRange, usageSeries } from './credit-usage.js';
import { knownAddresses } from './known-addresses.js';
import { TtlCache } from './ttl-cache.js';
import { AuditLog } from './audit-log.js';
import { IamStore, PERMISSIONS, PROFILE_LANGUAGES, PROGRAMMING_LANGUAGES, generatePassword, publicUser } from './iam.js';
import { insideProject, migrateLegacyData, prepareDataDir, resolveDataDir } from './data-dir.js';
import { PENDING_RESTORE, applyPendingRestore, collectStateFiles, createBackup, describeBackup, isSealed, listBackups, readBackup, writeBackupTo } from './backup.js';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { GitHubClient } from './github/client.js';
import { METHODS as GITHUB_METHODS, ensureClone, evaluate as evaluateGithub, gitHostOf, loginFromNoreply, resolveLogins, setCloneHostCheck, usableEmail, validLogin } from './github/identity.js';
import { blameFindings, codeVersion, locationOf, onGitHub, parseRepoUrl } from './github/blame.js';
import { SCM_LABELS, SCM_PROVIDERS, checkConnections as checkScmConnections, cloneAuthFor, methodsFor, providerOf, scmClients, scmConfigs } from './scm/providers.js';
import { addressesAsThemselves, evaluateMethods, resolveWith, validUsername } from './scm/identity.js';
import { addOwnership } from './scm/ownership.js';
import { acknowledgeStart, companionState, requestFullUpdate } from './updates/companion.js';
import { githubIssues, gitlabIssues, openSlaIssues } from './sla-issues.js';
import { TrackedReports, computeProgress, matchesFilters, outcomeOf, reportSummary } from './tracked-reports.js';
import { FindingJournal } from './finding-journal.js';
import { computeImpact } from './impact.js';
import { impactSummary } from './impact-summary.js';
import { TERMINAL, closure, newerThan, rescanRequest, verificationResult } from './verification.js';
import { ScanAttribution } from './scan-attribution.js';
import { ReportFiles } from './report-files.js';
import { BULK_SEVERITIES, REPORT_TOP_N, generateHtmlReport, selectTopFindings } from './html-report.js';
import { buildReminder, buildReportData, buildReportEmail } from './reminder.js';
import { exampleLinks, projectUrl, riskUrl } from './links.js';
import { AutomationState, Scheduler } from './automation.js';
import { deriveConnection, publicConnection } from './cxone/endpoints.js';
import { onMailFailure, sendReminderMail, sendTestEmail, testConnection } from './mailer.js';
import { checkCxKey, checkEnvFile, explainCxone, explainGit, explainSmtp, refusedByCheck } from './troubleshoot.js';
import { SettingsStore, applyEnvironmentSmtp, cleanPersonalBranding, hasEnvironmentSmtp, hostOfUrl, isVerified, overlayBranding, parseAddressList, publicSettings, smtpFingerprint, supportChannel } from './settings.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import v8 from 'node:v8';
import { Watchdog, rollbackTarget, shouldNotify, shouldRaiseCase } from './watchdog.js';
import { COMMANDS, isPaused, parseCommand, statusDue, systemEmail } from './hands-off.js';
import { findReferences, peekTenant, readAction, replyReference, signAction } from './action-links.js';
import { BACKUP_SUBJECT, findBackupInMailbox, readReplies } from './mail-inbox.js';
import { ConnectionGuard, describeCxone, describeSmtp } from './connection-guard.js';
import { ENV_SETTINGS, isSecretVariable, parseEnvText, settingsFromEnv } from './env-import.js';
import { addSla, slaSummary } from './sla.js';
import { INSTANCE_VARS, extraInstanceNumbers, instanceSource, numberedVariable, providersIn, setForRepo } from './scm/instances.js';
import { SessionPersistence, sessionKey } from './handover.js';
import { InstanceLock } from './instance-lock.js';
import { inlineScriptHashes, pruneAttempts, sameOriginGuard, securityHeaders, trustProxySetting, viaTrustedProxy } from './security.js';
import { describeCertificate } from './tls.js';
import { HSTS_AGES, HttpsManager } from './https-manager.js';
import { AcmeService, CHALLENGE_PREFIX, RENEW_DAYS, cleanNames, validName } from './acme.js';
import { ActivationStore, ISSUER_KEYS, checkCode } from './activation.js';
import { GATED_LANGUAGES, LanguageAccess } from './languages.js';
import { DEFAULT_TENANT, Tenancy, scoped, scopedState } from './tenancy.js';
import { KnownAddresses, scopeKnownAddresses } from './known-addresses.js';
import { SUPPORTING_NOTICE, Terms } from './terms.js';
import { DEFAULT_TEMPLATE, TEMPLATE_VARIABLES } from './template.js';
import { featureById, featureList, isFinal, mayUse } from './features.js';
import { journeyOf } from './journey.js';
import { KINDS as SUPPORT_KINDS, STATUSES as SUPPORT_STATUSES, SupportDesk, supportEmail } from './support.js';
import { HOUR_MS, currentWindow, graceHoursOf, newWindow, rescanGrants, windowAction, windowState } from './rescan-window.js';
import { WINDOW_PRESETS, describeWindow, resolveWindow } from './window.js';
import {
  SessionStore,
  clearSessionCookie,
  describeSession,
  readSessionCookie,
  setSessionCookie,
} from './session.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
/** Whose own branding (Settings → Your branding) the current request is made with: see presenting(). */
const presenter = new AsyncLocalStorage();
/** Set when this server asked the launcher to stop it (an update, a switch, a restart): such a stop is planned. */
let plannedStop = false;

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
/**
 * The backup mailbox (BACKUP_EMAIL): every encrypted backup is emailed there, and a new
 * server (an empty state folder) with the mailbox's password and the same passphrase
 * brings the newest one back by itself, before anything loads. Only an encrypted backup
 * that opens with BACKUP_PASSPHRASE is taken, so nobody else can plant one.
 */
const backupMailbox = {
  email: process.env.BACKUP_EMAIL?.trim().toLowerCase() || '',
  password: process.env.BACKUP_EMAIL_PASSWORD || '',
  host: process.env.BACKUP_EMAIL_IMAP_HOST?.trim() || process.env.SMTP_HOST?.trim() || '',
  port: Number(process.env.BACKUP_EMAIL_IMAP_PORT) || 993,
  user: process.env.BACKUP_EMAIL_USER?.trim() || process.env.BACKUP_EMAIL?.trim() || '',
};
let restoredFromMailbox = null;
{
  const passphrase = process.env.BACKUP_PASSPHRASE || '';
  const fresh = !fs.existsSync(path.join(dataDir, 'iam.json')) && !fs.existsSync(path.join(dataDir, PENDING_RESTORE));
  if (fresh && backupMailbox.email && backupMailbox.password && backupMailbox.host && passphrase) {
    console.log(`[data] A new state folder: looking for a backup in ${backupMailbox.email}…`);
    let bundle = null;
    const opens = (buffer) => {
      if (!isSealed(buffer)) return false;
      try {
        bundle = readBackup(buffer, { passphrase });
        return true;
      } catch {
        return false;
      }
    };
    try {
      const found = await Promise.race([
        findBackupInMailbox({ host: backupMailbox.host, port: backupMailbox.port, secure: backupMailbox.port === 993, user: backupMailbox.user, password: backupMailbox.password }, opens),
        new Promise((_, reject) => setTimeout(() => reject(new Error('the mailbox did not answer within 90 seconds')), 90_000).unref()),
      ]);
      if (found && bundle) {
        const pending = path.join(dataDir, PENDING_RESTORE);
        fs.writeFileSync(`${pending}.partial`, zlib.gzipSync(Buffer.from(JSON.stringify(bundle))), { mode: 0o600 });
        fs.renameSync(`${pending}.partial`, pending);
        restoredFromMailbox = { name: found.name, date: found.date };
        console.log(`[data] Found ${found.name} in ${backupMailbox.email}: restoring it.`);
      } else {
        console.log(`[data] No backup that opens with BACKUP_PASSPHRASE in ${backupMailbox.email}: starting fresh.`);
      }
    } catch (error) {
      console.warn(`! [data] Could not read the backup mailbox ${backupMailbox.email} (${error.message}): starting fresh.`);
    }
  }
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

// ---------------------------------------------------------------------------
// Tenants (src/tenancy.js). Each Checkmarx One tenant has its own settings, credits, tracked
// reports, audit log, automation and caches, made here. The first tenant ("default") keeps the
// state folder's existing files, so one tenant works exactly as before. The names below
// (settingsStore, audit, scheduler…) always mean the running tenant's: a request or a
// background job runs inside one tenant's context.
// ---------------------------------------------------------------------------
const tenancy = new Tenancy({ dataDir, build: buildTenant });
function buildTenant({ id, dir }) {
  const first = id === DEFAULT_TENANT;
  const settingsStore = new SettingsStore({ file: first ? settingsFile : path.join(dir, 'settings.json') });
  if (first) settingsStore.applyEnvironment();
  const creditLedger = new CreditLedger({ file: path.join(dir, 'triage-credits.json') });
  const automationState = new AutomationState({
    file: first && config.settingsFile ? config.settingsFile.replace(/\.json$/, '') + '-automation.json' : path.join(dir, 'automation-state.json'),
  });
  return {
    settingsStore,
    creditLedger,
    allocations: new CreditAllocations({ file: path.join(dir, 'credit-allocations.json'), ledger: creditLedger }),
    trackedReports: new TrackedReports({ file: path.join(dir, 'tracked-reports.json') }),
    reportFiles: new ReportFiles({ dir: path.join(dir, 'report-files'), ttlDays: 30 }),
    guard: new ConnectionGuard({ file: path.join(dir, 'connection-guard.json') }),
    audit: new AuditLog({ dir: path.join(dir, 'audit'), keyFile: path.join(dir, 'audit.key') }),
    automationState,
    scheduler: new Scheduler({
      // The scheduler is synchronous about session lookup, so a key armed while
      // the process is running is picked up by the refresh below rather than here.
      // Nothing runs on its own until an Admin has accepted the terms of use.
      resolveSession: () => (terms.organisation() ? sessions.get(tstate.automationSessionId) ?? sessions.get(tstate.bootstrapSessionId) : null),
      state: automationState,
      // Runs send through the last known good mail server while a change waits to be checked.
      // Always the organisation's branding, even for a run started by someone presenting their own.
      settingsStore: { get: () => presenter.exit(() => sendingSettings()) },
      config: () => activeConfig(),
      isVerified,
      // Scheduled reminders can also email the code authors, once that feature is final.
      notifyAuthors: (crossed, context) => notifyCodeAuthors(crossed, context),
      // SLAs (Beta): findings past their SLA, as an issue in their repository (when switched on).
      openIssues: (items, context) => openSlaIssuesFor(items, context),
    }),
    knownAddresses: new KnownAddresses({ file: path.join(dir, 'known-initiators.json') }),
    // When each finding was first seen open and when it closed: the Impact page (src/impact.js).
    findingJournal: new FindingJournal({ file: path.join(dir, 'finding-journal.json') }),
    scanAttribution: new ScanAttribution({ dataDir: dir }),
    touchedProjects: new Map(),
    relayCache: new TtlCache({ max: 100_000 }),
    recentActions: new TtlCache({ max: 100_000 }),
    refreshing: new Map(),
    scanLocations: new TtlCache({ max: 40 }),
    gitChecks: new Map(),
    // The tenant's own Checkmarx One integration session and how it was made (see resolveAutomationSession).
    state: { automationSessionId: null, bootstrapSessionId: null, integrationFingerprint: null, integrationAttempt: null, integrationFailure: { fingerprint: null, until: 0 }, lastDashboardOrigin: '', connectionHelp: {} },
  };
}
/** The running tenant's own variables (its integration session and the like). */
const tstate = scopedState(tenancy);
const settingsStore = scoped(tenancy, 'settingsStore');
const settings = settingsStore.get();
if (process.env.SMTP_HOST) {
  console.log(`[SMTP] Loaded from environment: ${settings.smtp.host}:${settings.smtp.port}`);
}

scopeKnownAddresses(() => tenancy.current().knownAddresses);
const creditLedger = scoped(tenancy, 'creditLedger');
/** Record triage or remediation sent for a project; its findings are about to change, so recent reads of it are dropped. */
function recordCreditUse(entry) {
  projectReads.forget(entry.projectId);
  return creditLedger.record(entry);
}
const allocations = scoped(tenancy, 'allocations');

const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const trackedReports = scoped(tenancy, 'trackedReports');
const findingJournal = scoped(tenancy, 'findingJournal');
const reportFiles = scoped(tenancy, 'reportFiles');
const guard = scoped(tenancy, 'guard');
/**
 * The audit log. Server-wide events (people and sign-ins, backups, updates, HTTPS, activation
 * codes, tenants) go to the first tenant's log; everything else to the running tenant's.
 */
const SERVER_WIDE_AUDIT = new Set(['iam', 'access', 'backup', 'system']);
const serverWide = (entry) => SERVER_WIDE_AUDIT.has(entry?.type) || Boolean(entry?.details?.https || entry?.details?.activation || entry?.details?.tenants);
const tenantAudit = scoped(tenancy, 'audit');
const audit = new Proxy(tenantAudit, {
  get(target, prop) {
    if (prop === 'record') return (entry, ...rest) => (serverWide(entry) ? tenancy.context(DEFAULT_TENANT).audit : tenancy.current().audit).record(entry, ...rest);
    return target[prop];
  },
});

// The terms of use (TERMS.md): an Admin accepts them for the organisation before anyone can use
// the utility (reports and automation included), then each person before they first use it.
const terms = new Terms({ file: path.join(dataDir, 'terms.json'), textFile: path.join(projectDir, 'TERMS.md') });
try {
  if (terms.acceptFromEnvironment(process.env.ACCEPT_TERMS)) {
    audit.record({ type: 'access', outcome: 'changed', reason: `Terms of use v${terms.version} accepted for the organisation and everyone using this installation by ${terms.organisation().by} (ACCEPT_TERMS).`, actor: { kind: 'system', user: terms.organisation().by }, details: { terms: { version: terms.version, hash: terms.hash, via: 'ACCEPT_TERMS' } } });
    console.log(`[terms] Terms of use v${terms.version} accepted for the organisation by ${terms.organisation().by} (ACCEPT_TERMS).`);
  }
} catch (error) {
  console.error(`! ${error.message}`);
  process.exit(1);
}
if (restoredAtStart) {
  audit.record({
    type: 'backup',
    outcome: 'changed',
    reason: `State restored from the backup of ${restoredAtStart.createdAt} (host ${restoredAtStart.host})${restoredFromMailbox ? `, found by itself in the backup mailbox ${backupMailbox.email} (${restoredFromMailbox.name})` : ''}.`,
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
/** Get help: support cases and enhancement requests, for the whole server (src/support.js). */
const supportDesk = new SupportDesk({ file: path.join(dataDir, 'support.json') });
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
const touchedProjects = scoped(tenancy, 'touchedProjects');
const touchProject = (projectId) => touchedProjects.set(projectId, Date.now());

/**
 * Per-project credits for the dashboard: what is allocated and used, and what
 * the findings need (never allocated until someone confirms it).
 */
function creditView(summary) {
  const risks = summary.risks ?? [];
  const figures = creditFigures(risks, { triaged: creditLedger.triagedAt(summary.projectId), remediated: creditLedger.remediatedIds(summary.projectId) });
  const { toRemediate, need, shortfall } = allocations.need(summary.projectId, risks, figures);
  return {
    ...allocations.balance(summary.projectId),
    toTriage: Object.fromEntries(SEVERITIES.map((s) => [s, figures.toTriage([s])])),
    // The rows behind those results: rows sharing one Checkmarx One result are triaged, and charged, once.
    toTriageRows: Object.fromEntries(SEVERITIES.map((s) => [s, figures.triageRows([s]).length])),
    // Confirmed findings to remediate, by severity, so any choice of severities can be costed.
    toRemediateBySeverity: Object.fromEntries(SEVERITIES.map((s) => [s, figures.toRemediate([s])])),
    toRemediate,
    need,
    shortfall,
    sharedResults: sharedResults(figures.triageRows(SEVERITIES)),
    // Where its findings stand on the way to Mission Zero (src/journey.js).
    journey: journeyOf(risks, creditLedger.remediatedIds(summary.projectId)),
  };
}

/**
 * Findings still to triage that are one Checkmarx One result (several code
 * paths, or data flows, into the same vulnerable code): triaged, charged and
 * fixed together. Named so people can see which ones, and why.
 */
function sharedResults(rows) {
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
  // Every grant, link and token is bound to the tenant it was made in (src/report-grants.js).
  tenantOf: () => tenancy.current().id,
});
/** "t=<tenant>" for a link outside the first tenant (prefixed by `sep`), else nothing. */
const tenantQuery = (sep = '?') => {
  const id = tenancy.current().id;
  return id === DEFAULT_TENANT ? '' : `${sep}t=${encodeURIComponent(id)}`;
};
/** Signed links to one finding's fix as a patch, for `git apply` (see /api/relay/patch). */
const patchTokens = patchLinks((text) => reportGrants.macText(text));

const automationState = scoped(tenancy, 'automationState');

/**
 * The session unattended runs use. Automation has no browser to paste a key,
 * so it needs a credential that outlives a session: either CX_API_KEY, or one
 * the administrator explicitly armed from the Settings page.
 */

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
  return sessions.get(tstate.automationSessionId) ?? sessions.get(tstate.bootstrapSessionId);
}

/**
 * The IAM and API hosts the stored key would be sent to with these endpoints (the key's
 * own issuer where none is set), so a change of host can be told from a change of tenant.
 */
function cxoneHosts(key, overrides = {}) {
  const effective = {
    baseUrl: overrides.baseUrl || config.overrides.baseUrl,
    iamUrl: overrides.iamUrl || config.overrides.iamUrl,
    tenant: overrides.tenant || config.overrides.tenant,
  };
  let { iamUrl, baseUrl } = effective;
  try {
    ({ iamUrl, baseUrl } = deriveConnection(key, effective));
  } catch {
    /* not a key we can read: compare the addresses as given */
  }
  return `${hostOfUrl(iamUrl)} ${hostOfUrl(baseUrl)}`;
}

/** The stored key, unless the endpoints now point at another host and no new key came with them. */
function keyForEndpoints(current, overrides, newKey) {
  if (newKey) return newKey;
  const key = current.automationApiKey;
  if (!key) return key;
  return cxoneHosts(key, current.integrationOverrides ?? {}) === cxoneHosts(key, overrides) ? key : '';
}

/** Which key and endpoints a connection was made from (to tell a changed configuration from the running one). */
const cxoneFingerprint = (key, overrides = {}) =>
  createHash('sha256').update(JSON.stringify([key ?? '', overrides.baseUrl ?? '', overrides.iamUrl ?? '', overrides.tenant ?? ''])).digest('hex');
/** The fingerprint of the configuration the running integration session was made from. */

/**
 * Make `session` the integration: it replaces the previous one, and the key and
 * endpoints it was made from become the last known good Checkmarx One configuration.
 */
function activateIntegration(session, key, overrides = {}) {
  session.pinned = true;
  const previous = tstate.automationSessionId;
  tstate.automationSessionId = session.id;
  tstate.integrationFingerprint = cxoneFingerprint(key, overrides);
  tstate.integrationFailure = { fingerprint: null, until: 0 };
  if (previous && previous !== session.id && previous !== tstate.bootstrapSessionId) sessions.destroy(previous);
  const { tenant, baseUrl, iamUrl } = session.connection;
  guard.recordGood('cxone', { apiKey: key, overrides: { baseUrl: overrides.baseUrl ?? '', iamUrl: overrides.iamUrl ?? '', tenant: overrides.tenant ?? '' }, connection: { tenant, baseUrl, iamUrl } });
  scheduler.sync();
}

/**
 * Signing in with the stored key: one attempt at a time however many requests are waiting
 * for it, and after a failure none for a while (30-60 s), so a wrong key or an unreachable
 * IAM is not asked again on every request. A changed key or endpoints are tried at once.
 */

async function resolveAutomationSession() {
  const existing = integrationSession();
  if (existing) return existing;

  const settings = settingsStore.get();
  const storedKey = settings.automationApiKey;
  if (!storedKey) return null;

  const fingerprint = cxoneFingerprint(storedKey, settings.integrationOverrides ?? {});
  if (tstate.integrationFailure.fingerprint === fingerprint && Date.now() < tstate.integrationFailure.until) return null;
  if (tstate.integrationAttempt?.fingerprint === fingerprint) return tstate.integrationAttempt.promise;

  const promise = (async () => {
    try {
      const session = await sessions.create(storedKey, integrationOverrides(settings));
      activateIntegration(session, storedKey, settings.integrationOverrides ?? {});
      tstate.integrationFailure = { fingerprint: null, until: 0 };
      return session;
    } catch (error) {
      console.warn(`! Stored automation key could not be used: ${error.message}`);
      tstate.integrationFailure = { fingerprint, until: Date.now() + 30_000 + Math.floor(Math.random() * 30_000) };
      return null;
    } finally {
      if (tstate.integrationAttempt?.promise === promise) tstate.integrationAttempt = null;
    }
  })();
  tstate.integrationAttempt = { fingerprint, promise };
  return promise;
}

const scheduler = scoped(tenancy, 'scheduler');

/**
 * Open an issue in each project's repository for its findings that went past their SLA:
 * the repository comes from the project's latest scan (or the project), the token from the
 * git connection that fits it. GitHub and GitLab, private repositories only (src/sla-issues.js).
 */
async function openSlaIssuesFor(items, { client, connection, projects = [], initiators = {}, dryRun }) {
  const settings = sendingSettings();
  const byId = new Map(projects.map((p) => [p.id, p]));
  const sets = gitSets(settings);
  return openSlaIssues(items, {
    appName: settings.branding?.appName || 'CxMissionZero',
    dryRun,
    urlOf: (risk) => riskUrl(risk, connection, settings.links, initiators[risk.projectId]?.scanId ?? ''),
    repoOf: async (projectId) => {
      const scanId = initiators[projectId]?.scanId;
      let scan = null;
      if (scanId) {
        try {
          scan = await client.request(`/api/scans/${encodeURIComponent(scanId)}`, { retries: 1 });
        } catch {
          scan = null;
        }
      }
      const repo = parseRepoUrl(codeVersion(scan, byId.get(projectId) ?? {}).repoUrl);
      if (!repo) return { problem: 'No repository is linked to this project in Checkmarx One.' };
      const set = setForRepo(sets, repo);
      const provider = providerOf(repo, set.scm, set.github.apiUrl);
      if (provider === 'github') {
        if (!set.github.token || !onGitHub(repo, set.github.apiUrl)) return { problem: 'No GitHub token is connected for this repository.' };
        return { repo, host: githubIssues(new GitHubClient({ token: set.github.token, apiUrl: set.github.apiUrl }), repo) };
      }
      if (provider === 'gitlab') {
        if (!set.scm.gitlab.token || repo.host !== set.scm.gitlab.host) return { problem: 'No GitLab token is connected for this repository.' };
        return { repo, host: gitlabIssues(scmClients(set.scm).gitlab, repo) };
      }
      return { problem: `Issues are opened on GitHub and GitLab only${provider ? ` (this repository is on ${SCM_LABELS[provider]})` : ''}.` };
    },
  });
}

const escapeHtml = (text) => String(text ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const app = express();

// HTTPS served here (src/https-manager.js: http and https on one port, run from Settings →
// HTTPS), unless a reverse proxy in front does it. A wrong certificate stops the start,
// rather than quietly serving plain http.
let httpsManager;
try {
  httpsManager = new HttpsManager({ dataDir });
  if (httpsManager.mode !== 'http') httpsManager.check();
} catch (error) {
  console.error(`! HTTPS is not set up correctly: ${error.message}`);
  process.exit(1);
}

// Free certificates from Let's Encrypt, got and renewed by this server (src/acme.js).
// ACME_DIRECTORY_URL: another ACME certificate authority (or a test one) instead of Let's Encrypt.
const ACME_DIRECTORY = String(process.env.ACME_DIRECTORY_URL ?? '').trim();
const acme = new AcmeService({ dataDir, https: httpsManager, log: console, ...(ACME_DIRECTORY ? { directories: { production: ACME_DIRECTORY, staging: ACME_DIRECTORY } } : {}) });
const LETSENCRYPT_DOMAIN = String(process.env.LETSENCRYPT_DOMAIN ?? '').trim();
// Add-ons unlocked by an activation code from the maintainer (src/activation.js): Hebrew, several tenants.
const activations = new ActivationStore({ file: path.join(dataDir, 'activation.json') });
const languageAccess = new LanguageAccess({ file: path.join(dataDir, 'languages.json') });
/**
 * Hebrew switched on by an older version with nobody chosen, not even the Admin who applied the
 * code: give it to that Admin, so it is never on with nobody able to see it. Run at start, once
 * the people are known.
 */
function adoptStuckLanguages() {
  for (const code of Object.keys(GATED_LANGUAGES)) {
    const applier = activations.history().find((h) => h.scope === GATED_LANGUAGES[code] && h.action === 'activate')?.by;
    const user = applier ? iam.findByEmail(applier) : null;
    if (user && languageAccess.adopt(code, user.id)) console.log(`[languages] ${code} was on for nobody: now open to ${user.email}, who applied its code.`);
  }
}

/** Let's Encrypt's check (HTTP-01): answered over plain http in every HTTPS mode, before anything else. */
function acmeChallengeAnswer(req, res) {
  let token = '';
  try {
    token = decodeURIComponent(String(req.url ?? '').slice(CHALLENGE_PREFIX.length).split('?')[0]);
  } catch {}
  const value = acme.challenge(token);
  res.writeHead(value ? 200 : 404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  return res.end(value ?? 'Not found');
}

// Whose X-Forwarded-* headers to believe: TRUST_PROXY (src/security.js, trustProxySetting).
app.set('trust proxy', trustProxySetting(process.env.TRUST_PROXY, httpsManager.mode !== 'http'));
httpsManager.onChange((mode) => app.set('trust proxy', trustProxySetting(process.env.TRUST_PROXY, mode !== 'http')));
// Security headers on every response, including the static pages (src/security.js).
app.disable('x-powered-by');
app.use(securityHeaders({ scriptHashes: inlineScriptHashes(path.join(publicDir, 'index.html')), hsts: () => httpsManager.hstsHeader() }));
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
app.use((req, res, next) => (req.method === 'GET' && req.path.startsWith(CHALLENGE_PREFIX) ? acmeChallengeAnswer(req, res) : next()));
// Stopping for an update: requests in progress finish; new ones are told to retry in a moment
// (reports and the page do), so nothing is lost and nobody sees an error.
let draining = false;
let inFlight = 0;
app.use((req, res, next) => {
  if (draining) {
    res.set({ 'Retry-After': '3', Connection: 'close' });
    return res.status(503).json({ error: 'CxMissionZero is restarting for an update. Trying again in a moment.', restarting: true, busy: true, retryAfter: 3 });
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
// A page's script error is a few lines of text: no reason to accept megabytes of it.
app.use('/api/diagnostics/client-error', express.json({ limit: '16kb' }));
app.use(express.json({ limit: '4mb' }));

/**
 * Which tenant a request is for, and run it there (src/tenancy.js): a signed-in person's chosen
 * tenant, or, for an emailed report and the links in it, the one it names. Grants are bound to
 * their tenant, so naming another makes them fail. Everything else is the first tenant.
 */
const LINK_PATHS = /^\/(api\/relay\/|r\/|rescan$)/;
app.use((req, res, next) => {
  let id = DEFAULT_TENANT;
  if (LINK_PATHS.test(req.path)) id = String(req.body?.tenantId ?? req.query?.t ?? DEFAULT_TENANT);
  else if (req.path.startsWith('/api/')) {
    const session = sessions.peek(readSessionCookie(req));
    if (session?.tenantId && tenancy.has(session.tenantId)) id = session.tenantId;
  }
  if (!tenancy.has(id)) {
    if (req.path.startsWith('/api/relay/')) relayCors(req, res);
    return res.status(404).json({ error: 'This is for a Checkmarx One tenant that is no longer on this server.' });
  }
  req.tenantId = id;
  tenancy.run(id, next);
});
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
// The page's files; API calls never touch the disk looking for one (a stat per request, under load).
// A language behind an activation code (Hebrew) is not served until it is activated here.
app.use('/i18n', (req, res, next) => {
  const code = req.path.match(/^\/([\w-]+)\.json$/)?.[1];
  // Only to the people it is open to (their sign-in), so nobody else ever receives it.
  if (code && code in GATED_LANGUAGES && !languageAccess.isAvailable(code, sessions.peek(readSessionCookie(req))?.userId)) return res.status(404).json({ error: 'That language is not available.' });
  next();
});
const staticFiles = express.static(publicDir);
app.use((req, res, next) => (req.path.startsWith('/api/') ? next() : staticFiles(req, res, next)));

/**
 * The emailed report is opened from disk (origin "null"), so its calls to the
 * relay are cross-origin. No cookies are involved: every relay action is
 * authorised by the signed grants the report carries.
 */
function relayCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
  // A report opened from disk calling a server on the company network: browsers
  // that enforce Private Network Access ask first, and this is the yes.
  if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
}
app.use('/api/relay', (req, res, next) => {
  relayCors(req, res);
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
  if (!terms.organisation() && req.path !== '/ping') {
    return res.status(403).json({ error: 'This reminder server is not in use yet: an administrator must first accept its terms of use.' });
  }
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

// Each handler runs in its request's tenant, even after a body parser's callback lost the context.
const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve(req.tenantId ? tenancy.run(req.tenantId, () => handler(req, res)) : handler(req, res)).catch(next);

/**
 * The tenants a person works in: every tenant for a Super Admin (tenants.manage); otherwise
 * the ones they were added to, or the first tenant when they were added to none. Empty when
 * every tenant they were added to has been removed.
 */
/** Permissions that act on the whole server, not one tenant: only for people who work in the first tenant. */
const SERVER_PERMISSIONS = new Set(['security.https', 'backup.view', 'backup.run', 'backup.manage', 'system.update', 'system.metrics', 'diagnostics.export', 'activation.manage', 'tenants.manage']);

/** What a person may do: their role's permissions, without the server-wide ones when they work only in other tenants. */
function permissionsFor(user) {
  const all = iam.permissionsOf(user);
  if (!user?.tenants?.length || user.tenants.includes(DEFAULT_TENANT)) return all;
  return new Set([...all].filter((p) => !SERVER_PERMISSIONS.has(p)));
}

/** Several tenants are unlocked by an activation code in date (src/activation.js). */
const tenantsUnlocked = () => Boolean(activations.tenants()?.valid);
/** A Super Admin: may manage tenants and work in every one (needs the activation code in date). */
const isSuperAdmin = (permissions) => permissions.has('tenants.manage') && tenantsUnlocked();

function tenantsOf(user, permissions = permissionsFor(user)) {
  if (!user) return [];
  if (isSuperAdmin(permissions)) return tenancy.ids();
  if (!user.tenants?.length) return [DEFAULT_TENANT];
  return user.tenants.filter((id) => tenancy.has(id));
}

/** The caller's signed-in session (every person signs in; there is no shared fallback). */
const currentSession = (req) => {
  const session = sessions.get(readSessionCookie(req));
  return session?.userId ? session : null;
};

/** Routes someone who must change their password may still use. */
const PASSWORD_CHANGE_ROUTES = new Set(['/api/me/password', '/api/session', '/api/me']);
/** Routes usable before the terms of use are accepted: reading and accepting them, and signing in and out. */
const TERMS_ROUTES = new Set(['/api/me/password', '/api/session', '/api/me', '/api/terms', '/api/terms/accept']);

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
  if (!TERMS_ROUTES.has(req.path) && (!terms.organisation() || !terms.acceptedBy(user.id))) {
    return res.status(403).json({
      error: terms.organisation() ? 'Accept the terms of use to continue.' : user.role === 'admin' ? 'Accept the terms of use for your organisation to continue.' : 'An administrator must accept the terms of use before CxMissionZero can be used.',
      termsRequired: true,
    });
  }
  req.session = session;
  req.user = user;
  req.permissions = permissionsFor(user);
  // The tenant this person works in now (their choice, if they still may).
  const allowed = tenantsOf(user, req.permissions);
  if (!allowed.length) return res.status(403).json({ error: 'You are not in any Checkmarx One tenant on this server any more. Ask a Super Admin to add you to one.' });
  if (!allowed.includes(session.tenantId)) {
    if (session.tenantId) session.lastScan = null; // fetched in another tenant
    session.tenantId = allowed[0];
  }
  req.tenantId = session.tenantId;
  const run = () =>
    tenancy.run(req.tenantId, () => {
      // Password sessions use the integration; make sure it is up (it is re-created from the stored key if needed).
      if (session.linked && !integrationSession()) {
        resolveAutomationSession().then(() => next(), next);
        return;
      }
      next();
    });
  // Someone presenting their own branding: what this request makes carries it, and nothing after it does.
  const own = ownBranding(user, req.permissions);
  if (!own) return run();
  const context = { own, done: false };
  const end = () => (context.done = true);
  res.on('finish', end);
  res.on('close', end);
  presenter.run(context, run);
}

/**
 * Settings → Your branding: a person's own names, logo and colours, for their
 * demonstrations. In use while they hold branding.personal and have it on; empty
 * fields keep the organisation's. It applies only to what their own requests make
 * (reports, reminder emails), never to scheduled runs or anyone else's.
 */
function ownBranding(user, permissions = permissionsFor(user)) {
  const own = user?.branding;
  return own?.on && permissions.has('branding.personal') ? own : null;
}
/** The branding of whoever this request is for, while the request lasts; null for the organisation's. */
function presenting() {
  const context = presenter.getStore();
  return context && !context.done ? context.own : null;
}
const brandingNow = (branding) => overlayBranding(branding, presenting());

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

/**
 * A Beta feature: for people with Beta access, and, once an Admin made it final,
 * for everyone holding the feature's own permission too (src/features.js).
 */
function requireFeature(id) {
  return (req, res, next) =>
    requireSession(req, res, (error) => {
      if (error) return next(error);
      if (mayUse(settingsStore.get(), id, req.permissions)) return next();
      const feature = featureById(id);
      res.status(403).json({ error: `“${feature?.name ?? id}” is a Beta feature: your role needs “Beta features”${isFinal(settingsStore.get(), id) ? '' : ' until an Admin makes it final'}.`, permission: 'beta.use' });
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
    // The page's languages available here (Hebrew only once activated, and only for the people chosen).
    languages: languageAccess.available(sessions.peek(readSessionCookie(req))?.userId),
    // Shown in the header before anyone connects.
    app: {
      name: settingsStore.get().branding.appName || 'CxMissionZero',
      logoUrl: settingsStore.get().branding.logoUrl || '',
      // Changes when the browser icon does, so the page can reload it.
      iconVersion: iconVersion(),
    },
  });
});

/** A short fingerprint of the browser icon setting ('' for the built-in one). */
const iconVersion = (url = settingsStore.get().branding?.iconUrl || '') => (url ? createHash('sha256').update(url).digest('hex').slice(0, 10) : '');

/**
 * The browser tab's icon, for every page (signed in or not): the one set under
 * Settings → Branding, else CxMissionZero's own MZ0. An uploaded image is served
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
  res.type('image/svg+xml').sendFile(path.join(publicDir, 'favicon.svg'));
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
    message: String(b.message ?? '').slice(0, 500),
    source: String(b.source ?? '').slice(0, 2000).split('/').pop(),
    line: Number(b.line) || 0,
    column: Number(b.column) || 0,
    page,
    detail: String(b.stack ?? '').slice(0, 2000),
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
  const held = permissionsFor(user);
  const settings = settingsStore.get();
  // "feature.<id>": what the page shows for each Beta feature this person may use (never checked by the server).
  const permissions = [...held, ...featureList(settings).filter((f) => mayUse(settings, f.id, held)).map((f) => `feature.${f.id}`)];
  const integration = integrationSession();
  let tenant = '';
  try {
    tenant = integration?.connection?.tenant ?? '';
  } catch {}
  const organisation = terms.organisation();
  return {
    terms: {
      version: terms.version,
      organisationAccepted: Boolean(organisation),
      accepted: Boolean(organisation) && terms.acceptedBy(user.id),
      canAcceptForOrganisation: user.role === 'admin',
    },
    ...describeSession(session),
    user: publicUser(user),
    role: { id: user.role, name: iam.role(user.role)?.name ?? user.role },
    permissions,
    features: Object.fromEntries(featureList(settings).map((f) => [f.id, f.stage])),
    via: session.via,
    integration: { connected: Boolean(integration), tenant },
    // Connection settings put back because new ones did not work: shown once to each administrator.
    configNotices: held.has('integration.cxone') || held.has('integration.smtp') ? guard.unseen(user.id) : [],
    // The page's languages this person may use (Hebrew only for the people chosen).
    languages: languageAccess.available(user.id),
    // Add-ons a code has unlocked (in date or not): until then the page does not show them.
    unlocked: { tenants: Boolean(activations.tenants()) || tenancy.enabled },
    // Get help: the support portal here, or email to an address (installations whose mail cannot leave).
    support: (({ mode, email }) => ({ mode, email }))(supportChannel(settingsStore.get())),
    // The name and logo the page shows this person: theirs while they present their own branding.
    branding: (({ appName, logoUrl }) => ({ appName: appName || 'CxMissionZero', logoUrl: logoUrl || '', own: Boolean(ownBranding(user, held)) }))(overlayBranding(settings.branding, ownBranding(user, held))),
    // Several Checkmarx One tenants: the one this person works in now, and the ones they may switch to.
    tenancy: tenancy.enabled
      ? {
          current: { id: tenancy.current().id, name: tenantName(tenancy.current().id) },
          tenants: tenantsOf(user, held).map((id) => ({ id, name: tenantName(id) })),
          superAdmin: isSuperAdmin(held),
        }
      : null,
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
const SIGN_IN_WINDOW_MS = 10 * 60 * 1000;
const signInAttempts = new Map();
function throttleSignIn(req, res) {
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (signInAttempts.get(ip) ?? []).filter((t) => now - t < SIGN_IN_WINDOW_MS);
  recent.push(now);
  // Re-inserted, so the map stays in order of last attempt (oldest first).
  signInAttempts.delete(ip);
  signInAttempts.set(ip, recent);
  // Many addresses: forget the ones whose attempts have all expired, never the whole map
  // (that would hand a guesser a fresh start just by sending from enough addresses).
  pruneAttempts(signInAttempts, now, { windowMs: SIGN_IN_WINDOW_MS, max: 10_000 });
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
  if (id && id !== tstate.automationSessionId && id !== tstate.bootstrapSessionId) sessions.destroy(id);
  clearSessionCookie(res);
  res.json({ connected: false, signedIn: false });
});

app.get('/api/me', requireSession, (req, res) => res.json(describeMe(req.session, req.user)));

/** The terms of use: readable by anyone (also before signing in), with where this person stands. */
app.get('/api/terms', (req, res) => {
  const session = currentSession(req);
  const user = session ? iam.user(session.userId) : null;
  const organisation = terms.organisation();
  const mine = user ? terms.userAcceptance(user.id) : null;
  res.set('Cache-Control', 'no-store');
  res.json({
    version: terms.version,
    text: terms.text,
    organisation: organisation ? { at: organisation.at, by: organisation.by, via: organisation.via } : null,
    ...(user ? { you: { accepted: Boolean(organisation) && terms.acceptedBy(user.id), at: mine?.at ?? (organisation?.everyone ? organisation.at : null), canAcceptForOrganisation: user.role === 'admin' } } : {}),
  });
});

/** Accept the terms: an Admin for the organisation (first), then each person for themselves. */
app.post('/api/terms/accept', requireSession, asyncRoute(async (req, res) => {
  if (String(req.body?.version ?? '') !== terms.version) return res.status(409).json({ error: 'The terms changed while you were reading them: read the current version, then accept.' });
  const actor = { kind: 'user', user: req.user.email, ip: clientIp(req), userAgent: String(req.get('user-agent') ?? '').slice(0, 200) };
  if (!terms.organisation()) {
    if (req.user.role !== 'admin' || !req.body?.forOrganisation) return res.status(403).json({ error: 'An administrator must accept the terms of use for the organisation first.' });
    terms.acceptForOrganisation({ by: req.user.email, ip: clientIp(req) });
    audit.record({ type: 'access', outcome: 'changed', reason: `Terms of use v${terms.version} accepted for the organisation by ${req.user.email}.`, actor, details: { terms: { version: terms.version, hash: terms.hash, scope: 'organisation' } } });
  }
  if (!terms.acceptedBy(req.user.id)) {
    terms.acceptForUser({ userId: req.user.id, email: req.user.email, ip: clientIp(req) });
    audit.record({ type: 'access', outcome: 'changed', reason: `Terms of use v${terms.version} accepted by ${req.user.email}.`, actor, details: { terms: { version: terms.version, hash: terms.hash, scope: 'user' } } });
  }
  res.json(describeMe(req.session, req.user));
}));

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
    // Anyone else signed in with the old password is signed out; this browser stays signed in.
    endSessionsOf(user.id, req.session.id);
    fs.rmSync(firstAdminFile, { force: true });
    audit.record({ type: 'iam', outcome: 'changed', reason: `${user.email} changed their password.`, actor: await adminActor(req) });
    res.json(describeMe(req.session, iam.user(user.id)));
  }),
);

/**
 * One's own profile: name, language, time zone and programming languages. A time zone picked up
 * from the computer by itself (quiet) is stored without an audit entry; everything else is audited.
 */
app.put(
  '/api/me/profile',
  requireSession,
  asyncRoute(async (req, res) => {
    const patch = {};
    for (const key of ['name', 'language', 'timeZone', 'timeZoneAuto', 'programmingLanguages']) if (key in (req.body ?? {})) patch[key] = req.body[key];
    if (patch.language && !languageAccess.isAvailable(String(patch.language), req.user.id)) return res.status(400).json({ error: 'That language is not available.' });
    const { before, after } = iam.updateProfile(req.user.id, patch);
    const changed = [
      ...(before.name !== after.name ? ['name'] : []),
      ...Object.keys(after.profile).filter((k) => JSON.stringify(before.profile[k]) !== JSON.stringify(after.profile[k])),
    ];
    const quiet = req.body?.quiet === true && changed.every((k) => k === 'timeZone' || k === 'language');
    if (changed.length && !quiet) {
      audit.record({ type: 'iam', outcome: 'changed', reason: `${after.email} updated their profile: ${changed.join(', ')}.`, actor: await adminActor(req), details: { before: { name: before.name, ...before.profile }, after: { name: after.name, ...after.profile } } });
    }
    res.json(describeMe(req.session, iam.user(req.user.id)));
  }),
);

/** One's own picture: a PNG, JPEG or WebP data: URL (the page makes it small first), or none. */
app.put(
  '/api/me/avatar',
  requireSession,
  asyncRoute(async (req, res) => {
    const after = iam.setAvatar(req.user.id, String(req.body?.image ?? ''));
    audit.record({ type: 'iam', outcome: 'changed', reason: `${after.email} ${after.avatarAt ? 'changed' : 'removed'} their picture.`, actor: await adminActor(req) });
    res.json(describeMe(req.session, iam.user(req.user.id)));
  }),
);

/** A person's picture: for themselves, and for anyone who may see people and roles. */
app.get('/api/users/:id/avatar', requireSession, (req, res) => {
  if (req.params.id !== req.user.id && !can(req, 'iam.view')) return res.status(403).json({ error: 'Your role does not allow this.' });
  const owner = iam.user(req.params.id);
  if (owner && !withinReach(req, owner)) return res.status(404).json({ error: 'No picture.' });
  const avatar = iam.avatar(req.params.id);
  if (!avatar) return res.status(404).json({ error: 'No picture.' });
  res.set({ 'Content-Type': avatar.type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
  res.send(avatar.bytes);
});

/** Settings → Your branding: one's own, and the organisation's it falls back to field by field. */
function personalBrandingView(user) {
  const { appName, companyName, logoUrl, logoHeight, accentColor, callToAction } = settingsStore.get().branding;
  return { branding: cleanPersonalBranding(user.branding ?? {}), organisation: { appName, companyName, logoUrl, logoHeight, accentColor, callToAction } };
}

app.get('/api/me/branding', requirePermission('branding.personal'), (req, res) => res.json(personalBrandingView(req.user)));

app.put(
  '/api/me/branding',
  requirePermission('branding.personal'),
  asyncRoute(async (req, res) => {
    const next = cleanPersonalBranding(req.user.branding ?? {}, req.body ?? {});
    const { before } = iam.setBranding(req.user.id, next);
    const prior = cleanPersonalBranding(before ?? {});
    const changed = Object.keys(next).filter((k) => prior[k] !== next[k]);
    if (changed.length) {
      const what = changed.length === 1 && changed[0] === 'on' ? (next.on ? 'turned their own branding on' : 'went back to the organisation’s branding') : `changed their own branding: ${changed.join(', ')}`;
      // The logo itself can be large; the log says only whether there is one.
      const summary = (b) => b && { ...b, logoUrl: b.logoUrl ? (b.logoUrl.startsWith('data:') ? '(uploaded image)' : b.logoUrl) : '' };
      audit.record({ type: 'iam', outcome: 'changed', reason: `${req.user.email} ${what}.`, actor: await adminActor(req), details: { before: summary(prior), after: summary(next) } });
    }
    res.json({ ...personalBrandingView(iam.user(req.user.id)), me: describeMe(req.session, iam.user(req.user.id)) });
  }),
);

app.get('/api/me/profile/options', requireSession, (req, res) => res.json({ languages: PROFILE_LANGUAGES.filter((code) => languageAccess.isAvailable(code, req.user.id)), programmingLanguages: PROGRAMMING_LANGUAGES }));

// ---------------------------------------------------------------------------
// Access: users and roles
// ---------------------------------------------------------------------------

const actorOf = (req) => ({ actorPerms: req.permissions, actorId: req.user.id });

/** Can this person see (and manage) that user: someone in the tenant they work in now, or anyone for a Super Admin. */
function sharesTenant(req, user) {
  if (!tenancy.enabled || isSuperAdmin(req.permissions)) return true;
  return tenantsOf(iam.user(user.id) ?? user).includes(req.tenantId);
}

/** Roles are shared by every tenant: only people who work in the first tenant change them. */
function mayChangeRoles(req) {
  return !tenancy.enabled || isSuperAdmin(req.permissions) || tenantsOf(req.user, req.permissions).includes(DEFAULT_TENANT);
}

/**
 * Whether this person may know `user` exists: their role holds nothing beyond this
 * person's own permissions. A Security Analyst sees analysts and below, never who
 * the Admins are; an Admin sees everyone. Themselves always.
 */
const withinReach = (req, user) => user.id === req.user.id || iam.canGrant(req.permissions, permissionsFor({ ...user, disabled: false }));

function iamView(req) {
  return {
    users: iam.users().filter((u) => sharesTenant(req, u) && withinReach(req, u)).map((u) => ({ ...u, canManage: can(req, 'iam.manage') && iam.canGrant(req.permissions, iam.permissionsOf({ ...iam.user(u.id), disabled: false })) && u.id !== req.user.id })),
    roles: iam.roles().filter((r) => r.id === req.user.role || iam.canGrant(req.permissions, r.permissions)).map((r) => ({ ...r, canManage: can(req, 'iam.manage') && mayChangeRoles(req) && !r.locked && iam.canGrant(req.permissions, r.permissions), canAssign: can(req, 'iam.manage') && iam.canGrant(req.permissions, r.permissions) })),
    permissions: PERMISSIONS,
    me: { id: req.user.id, permissions: [...req.permissions] },
    tenants: tenancy.enabled && isSuperAdmin(req.permissions) ? tenancy.list().map((t) => ({ id: t.id, name: tenantName(t.id) })) : null,
  };
}

/** A user this person may change: 404 for someone outside the tenants they work in. */
function visibleUser(req, id) {
  const user = iam.user(id);
  if (!user || !sharesTenant(req, user) || !withinReach(req, user)) throw Object.assign(new Error('No such user.'), { status: 404 });
  return user;
}

async function auditIam(req, reason, details) {
  audit.record({ type: 'iam', outcome: 'changed', reason, actor: await adminActor(req), details });
}

/** Sign out every session of a user whose access was removed (all but `keep`, when given). */
function endSessionsOf(userId, keep = null) {
  // Saved sign-ins nobody has come back for since a restart end too.
  const keepKey = keep ? sessionKey(keep) : null;
  sessions.endWhere((s) => s.userId === userId && !(keep && (s.id === keep || s.key === keepKey)));
}

app.get('/api/iam', requirePermission('iam.view'), (req, res) => res.json(iamView(req)));

app.post(
  '/api/iam/users',
  requirePermission('iam.manage'),
  asyncRoute(async (req, res) => {
    const { email, name, role, password, cxoneIdentities } = req.body ?? {};
    const user = await iam.createUser({ email, name, role, password: password ? String(password) : '', cxoneIdentities, mustChangePassword: true }, actorOf(req));
    // Someone added while working in another tenant works in that tenant.
    if (req.tenantId && req.tenantId !== DEFAULT_TENANT) iam.setTenants(user.id, [req.tenantId]);
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
    visibleUser(req, req.params.id);
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
    visibleUser(req, req.params.id);
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
    visibleUser(req, req.params.id);
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
    if (!mayChangeRoles(req)) return res.status(403).json({ error: 'Roles are shared by every tenant, so only people who work in the first tenant change them.' });
    const { after } = iam.saveRole(null, req.body ?? {}, actorOf(req));
    await auditIam(req, `Created role "${after.name}" (${after.permissions.length} permissions).`, { role: after });
    res.status(201).json(iamView(req));
  }),
);

app.put(
  '/api/iam/roles/:id',
  requirePermission('iam.manage'),
  asyncRoute(async (req, res) => {
    if (!mayChangeRoles(req)) return res.status(403).json({ error: 'Roles are shared by every tenant, so only people who work in the first tenant change them.' });
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
    if (!mayChangeRoles(req)) return res.status(403).json({ error: 'Roles are shared by every tenant, so only people who work in the first tenant change them.' });
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
    source: session ? (session.id === tstate.automationSessionId ? 'stored' : 'environment') : settings.automationApiKey ? 'stored (not reachable)' : 'none',
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
    if (!key) return res.status(400).json({ error: 'Paste a Checkmarx One API key.', help: explainCxone(new Error('no key'), { apiKey: '' }) });
    // A key that cannot work (its ID, cut short, quoted, expired) is said so before it is tried.
    const malformed = checkCxKey(key);
    if (malformed && malformed !== 'cx.key-no-issuer') {
      const help = explainCxone(new Error('malformed'), { apiKey: key });
      return res.status(400).json({ error: help.problem, help });
    }
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
    noteConnectionHelp('cxone', { ok: true });
    audit.record({ type: 'settings', outcome: 'changed', reason: `Checkmarx One integration connected to tenant ${session.connection.tenant}.`, actor: await adminActor(req), details: { tenant: session.connection.tenant, baseUrl: session.connection.baseUrl } });
    res.json(integrationStatus());
  }),
);

app.delete(
  '/api/integration/cxone',
  requirePermission('integration.cxone'),
  asyncRoute(async (req, res) => {
    settingsStore.save({ automationApiKey: '' });
    if (tstate.automationSessionId) sessions.destroy(tstate.automationSessionId);
    tstate.automationSessionId = null;
    tstate.integrationFingerprint = null;
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
  return Boolean(settings.automationApiKey) && cxoneFingerprint(settings.automationApiKey, settings.integrationOverrides ?? {}) !== tstate.integrationFingerprint;
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
  const own = presenting();
  if (own) settings = { ...settings, branding: overlayBranding(settings.branding, own) };
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

/** Remember why a connection last failed (cleared when it works), for the header's connection chips. */
function noteConnectionHelp(part, outcome) {
  if (!outcome || outcome.superseded) return;
  tstate.connectionHelp ??= {};
  if (outcome.ok) delete tstate.connectionHelp[part];
  else if (outcome.help) tstate.connectionHelp[part] = outcome.help;
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
      result.cxone = { ok: false, error: error.message, timedOut: Boolean(error.timedOut), help: explainCxone(error, { apiKey: key, ...overrides }) };
      const good = guard.lastGood('cxone');
      const current = settingsStore.get();
      const unchanged = cxoneFingerprint(current.automationApiKey, current.integrationOverrides ?? {}) === tried;
      if (rollback && good && unchanged && cxoneFingerprint(good.apiKey, good.overrides) !== tried) {
        settingsStore.save({ automationApiKey: good.apiKey, integrationOverrides: good.overrides });
        if (!good.apiKey) {
          // The last working connection was the environment's CX_API_KEY.
          if (tstate.automationSessionId && tstate.automationSessionId !== tstate.bootstrapSessionId) sessions.destroy(tstate.automationSessionId);
          tstate.automationSessionId = null;
          tstate.integrationFingerprint = null;
        } else if (cxoneFingerprint(good.apiKey, good.overrides) !== tstate.integrationFingerprint || !integrationSession()) {
          tstate.automationSessionId = null;
          await resolveAutomationSession();
        }
        result.cxone.rolledBack = true;
        parts.push({ part: 'cxone', error: error.message, timedOut: Boolean(error.timedOut), help: result.cxone.help, attempted: describeCxone({ overrides }), restored: describeCxone(good), restoredAt: good.at });
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
      result.smtp = { ok: false, error: error.message, timedOut: Boolean(error.timedOut) || /timed? ?out|ETIMEDOUT/i.test(error.message), help: error.help ?? explainSmtp(error, settings.smtp) };
      const unchanged = smtpFingerprint(settingsStore.get().smtp) === tried;
      if (rollback && good && unchanged && smtpFingerprint(good) !== tried) {
        settingsStore.restoreSmtp(good);
        result.smtp.rolledBack = true;
        parts.push({ part: 'smtp', error: error.message, timedOut: result.smtp.timedOut, help: result.smtp.help, attempted, restored: describeSmtp(good), restoredAt: good.at });
      }
    }
  }

  // What the header shows while a connection does not work: why, and how to fix it.
  for (const part of ['cxone', 'smtp']) noteConnectionHelp(part, result[part]);
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
  tenancy.each(() => {
    const changedAt = guard.changedAt;
    if (!changedAt || Date.now() - Date.parse(changedAt) < ROLLBACK_IDLE_MS) return;
    if (!cxonePending() && !smtpPending()) return guard.settle();
    checkConnections({ rollback: true, trigger: 'no change for a while' }).catch((error) => console.warn(`! [settings] Connection check failed: ${error.message}`));
  });
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
    // The stored key is never sent to another host: new IAM or API hosts need the key pasted again.
    settingsStore.save({ automationApiKey: keyForEndpoints(current, overrides, key), integrationOverrides: overrides });
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
    const all = parseEnvText(req.body?.text);
    // Checked before anything is applied: a value that cannot work is not applied, so the working one stays.
    const findings = checkEnvFile(req.body?.text, all, { known: Object.keys(ENV_SETTINGS), isKnown: (name) => Boolean(numberedVariable(name)) });
    const skipped = refusedByCheck(findings);
    const vars = Object.fromEntries(Object.entries(all).filter(([name]) => !skipped.has(name)));
    const { changes, applied, refused, ignored } = settingsFromEnv(vars, (permission) => can(req, permission));
    if (!applied.length) {
      if (refused.length) return res.status(403).json({ error: `Your role cannot set ${refused.join(', ')}.`, applied, refused, ignored, findings });
      if (skipped.size) return res.status(400).json({ error: 'Nothing was applied: the file has mistakes that would break the connections. Each one is listed below with how to fix it.', applied, refused, ignored, findings });
      const blank = Object.keys(vars).some((name) => Object.hasOwn(ENV_SETTINGS, name) || numberedVariable(name));
      return res.status(400).json({
        error: blank
          ? 'Every setting in that file is blank, so nothing changed. Fill in the values you want to set (blank ones keep what is set now) and upload it again.'
          : 'No setting this page understands was found in that file.',
        applied, refused, ignored, findings,
      });
    }
    if (changes.cxone) {
      const current = settingsStore.get();
      const { apiKey, ...endpoints } = changes.cxone;
      // Endpoints the file leaves out are derived from the key, as at start-up.
      const overrides = { baseUrl: '', iamUrl: '', tenant: '', ...(apiKey ? {} : current.integrationOverrides ?? {}), ...endpoints };
      // The stored key is never sent to another host: new IAM or API hosts need the key in the file too.
      settingsStore.save({ automationApiKey: keyForEndpoints(current, overrides, apiKey), integrationOverrides: overrides });
    }
    if (changes.smtp) settingsStore.save({ smtp: changes.smtp });
    if (changes.links) settingsStore.save({ links: changes.links });
    if (changes.github) settingsStore.save({ beta: { github: changes.github } });
    for (const host of ['gitlab', 'azure', 'bitbucket']) if (changes[host]) settingsStore.save({ beta: { [host]: changes[host] } });
    if (changes.instances) settingsStore.save({ beta: { instances: changes.instances } });
    guard.touch();
    const actor = await adminActor(req);
    audit.record({ type: 'settings', outcome: 'changed', reason: `Settings imported from a .env file: ${applied.join(', ')}.`, actor, details: { applied, refused, ignored, notApplied: [...skipped], secrets: applied.filter(isSecretVariable) } });
    const check = await checkConnections({ rollback: false, trigger: 'import', actor });
    res.json({ applied, refused, ignored, findings, check, settings: settingsFor(req, settingsStore.get()), integration: integrationStatus() });
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
  // Who gets reminders (each developer, the fixed list, or both): one choice for every place that sends them.
  reminders: 'settings.recipients',
  initiators: 'settings.initiators',
  template: 'settings.template',
  branding: 'settings.branding',
  links: 'settings.links',
  automation: 'settings.automation',
  // SLAs (Beta): who may change automation, and may use SLAs (see permittedSettings).
  sla: 'settings.automation',
  endpoints: 'integration.cxone',
  beta: 'beta.use',
  // The Impact page's minutes, rates and monthly summary: whoever sets the AI rules.
  impact: 'settings.ai',
  // How people ask for help (the portal, or email to an address): the support team's.
  support: 'support.manage',
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
    } else if (key === 'sla' && !mayUse(settingsStore.get(), 'sla', req.permissions)) {
      ignored.push(key);
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
  // The Branding page is for those allowed to see it (the header still shows the name and logo).
  if (!can(req, 'branding.view') && !can(req, 'settings.branding')) delete view.branding;
  if (!can(req, 'beta.use')) delete view.beta;
  else {
    // Whether a token is in use, as the server would use it: an environment token
    // counts only for the host its environment address names.
    const scm = scmConfigs(settings);
    const sources = { github: githubConfig(settings).tokenSource, gitlab: scm.gitlab.tokenSource, azure: scm.azure.tokenSource, bitbucket: scm.bitbucket.tokenSource };
    for (const [id, source] of Object.entries(sources)) {
      if (!view.beta[id]) continue;
      view.beta[id].tokenSet = source !== 'none';
      view.beta[id].tokenFromEnvironment = source === 'environment';
    }
  }
  return view;
}

/** The Checkmarx One connection, or null while none is set up: settings and previews work without it. */
const connectionOrNull = (session) => {
  try {
    return session?.connection ?? null;
  } catch {
    return null;
  }
};

app.get('/api/settings', requireSession, (req, res) => {
  const settings = settingsStore.get();
  res.json({
    ...settingsFor(req, settings),
    // Rendered from the current templates so a wrong UI route is visible
    // without having to send a mail to find out.
    linkExamples: exampleLinks(connectionOrNull(req.session), settings.links),
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
      linkExamples: exampleLinks(connectionOrNull(req.session), saved.links),
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
    const result = await testConnection(settings.smtp).catch((error) => {
      noteConnectionHelp('smtp', { ok: false, help: error.help });
      throw error;
    });
    noteConnectionHelp('smtp', { ok: true });
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
    // Only someone who may edit the template previews unsaved markup; anyone else sees the saved one.
    const editing = can(req, 'settings.template');
    const template = {
      subject: (editing ? req.body?.subject : undefined) ?? settings.template.subject,
      html: (editing ? req.body?.html : undefined) ?? settings.template.html,
    };
    const connection = connectionOrNull(req.session);

    const risks = req.session.lastScan
      ? selectRisks(req.session.lastScan.projects, { buckets: [] }).slice(0, 12)
      : SAMPLE_RISKS;

    const reminder = buildReminder(risks.length ? risks : SAMPLE_RISKS, template, {
      buckets: ['60+'],
      tenant: connection?.tenant ?? '',
      links: settings.links,
      connection,
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
    if (initiator.length > 200) return res.status(400).json({ error: 'That initiator name is too long (200 characters at most).' });
    if (!email) return res.status(400).json({ error: `"${String(req.body?.email ?? '').slice(0, 200)}" is not a valid email address.` });

    const current = settingsStore.get().initiators.overrides;
    // Tagging fills in a missing address; changing one already set is for whoever manages initiator addresses.
    if (Object.hasOwn(current, initiator) && current[initiator] !== email && !can(req, 'settings.initiators')) {
      return res.status(409).json({ error: `${initiator} already has an address (${current[initiator]}). Ask someone who manages initiator addresses in Settings to change it.` });
    }
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
    canRun: Boolean(sessions.get(tstate.automationSessionId) ?? sessions.get(tstate.bootstrapSessionId)),
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
  if (tstate.automationSessionId && tstate.automationSessionId !== tstate.bootstrapSessionId) sessions.destroy(tstate.automationSessionId);
  tstate.automationSessionId = null;
  tstate.integrationFingerprint = null;
  res.json({ ...scheduler.status, keyStored: false, canRun: Boolean(sessions.get(tstate.bootstrapSessionId)) });
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
    // Automation is the organisation's: its emails never carry the branding of whoever pressed Run now.
    const run = await presenter.exit(() => scheduler.tick({ force: true }));
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
  const [initiators, result] = await Promise.all([
    collectInitiators(client, req.session.connection, projects, {
      rules: settings.initiators,
      useDirectory: settings.initiators.useDirectory,
      concurrency: config.concurrency,
      lastScans: Object.keys(lastScans ?? {}).length ? lastScans : undefined,
      memory: knownAddresses,
      attributed: creditFor,
    }),
    collectProjectRisks(client, active, projects, {
      detectionWindow,
      onProject: onProject ? (summary) => onProject(earlyRow(summary)) : null,
      shared: { identity: readerIdentity(req.session), lastScans, fresh: req.query.fresh === '1' },
      shouldStop,
    }),
  ]);
  // Stopped part-way: what was read is the data, and only its projects keep their initiators.
  if (result.notRead) {
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
    summary.url = projectUrl(summary, req.session.connection, settings.links);
  }
  result.initiators = initiators.byProject;
  result.detectionWindow = detectionWindow;
  for (const summary of result.projects) {
    if (summary.error) diagnostics.discrepancy('project-read-failed', { project: summary.projectId, message: summary.error });
  }
  diagnostics.usage(result.notRead ? 'fetch-stopped' : 'fetch-complete', { projects: result.projects.length, notRead: result.notRead ?? 0, reused: result.reused ?? 0, findings: result.projects.reduce((n, p) => n + p.totalRisks, 0), ms: Date.now() - started });
  // Fetching shows what the findings need; it never allocates anything.
  for (const summary of result.projects) summary.credits ??= creditView(summary);
  for (const summary of result.projects) summary.sla ??= slaSummary(summary.risks, settings.sla);
  // What was open, for the Impact page; a project read with no date window, without error, is complete.
  for (const summary of result.projects) findingJournal.observe(summary, summary.risks, { complete: !detectionWindow && !summary.error });
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
    // Stop pressed: how many of the projects in scope were read before it, and how many were not.
    stopped: result.notRead > 0,
    projectsPlanned: projects.length,
    projectsNotRead: result.notRead ?? 0,
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
        shouldStop,
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
      return res.status(409).json({ error: 'Load findings on the Dashboard first, then send a reminder.' });
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

function requestOrigin(req) {
  const forwardedHost = viaTrustedProxy(req) ? String(req.get('x-forwarded-host') ?? '').split(',')[0].trim() : '';
  return `${req.protocol}://${forwardedHost || req.get('host')}`;
}

/**
 * Remember the address the dashboard is open on, for reports sent with nobody there.
 * Only from someone signed in who may set the links (an Admin, as a rule), and only the
 * plain Host they used, never X-Forwarded-Host: a report reader, or anyone able to send a
 * request, cannot point every automatic report at an address of their choosing.
 */
function noteDashboardOrigin(req) {
  if (!req.user || !can(req, 'settings.links')) return;
  const host = requestHost(req);
  if (!host) return;
  try {
    const origin = `${req.protocol}://${host}`;
    if (!LOOPBACK.test(new URL(origin).hostname)) tstate.lastDashboardOrigin = origin;
  } catch {}
}

function resolveReportServer(req = null, settings = settingsStore.get()) {
  if (req) noteDashboardOrigin(req);
  if (settings.links.reportServerUrl) return { url: settings.links.reportServerUrl, source: 'settings' };
  if (config.reportServerUrl) return { url: config.reportServerUrl, source: 'environment' };
  if (req) return { url: requestOrigin(req), source: 'this page' };
  if (tstate.lastDashboardOrigin) return { url: tstate.lastDashboardOrigin, source: 'last dashboard address' };
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
    if (parsed.protocol === 'http:' && !LOOPBACK.test(parsed.hostname)) warnings.push('Plain http: triage requests cross the network unencrypted. Turn on HTTPS under Settings → HTTPS.');
    if (parsed.protocol === 'https:' && httpsManager.mode !== 'http' && httpsManager.selfSigned && !LOOPBACK.test(parsed.hostname)) warnings.push('This server uses a self-signed certificate: reports reach it only from machines that trust it. Upload your company certificate under Settings → HTTPS.');
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

// The client's address: X-Forwarded-For only from a trusted proxy (see TRUST_PROXY), so it cannot be faked.
const clientIp = (req) => req.ip || req.socket?.remoteAddress || '';

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

// ---------------------------------------------------------------------------
// HTTPS (Settings → HTTPS, Admin only): see src/https-manager.js
// ---------------------------------------------------------------------------

/** Reports opened over http and over https, by hour, for the last day: shows when http can go. */
const reportOpens = {
  hours: new Map(),
  record(secure) {
    const hour = Math.floor(Date.now() / 3_600_000);
    const bucket = this.hours.get(hour) ?? { http: 0, https: 0 };
    bucket[secure ? 'https' : 'http'] += 1;
    this.hours.set(hour, bucket);
    for (const key of this.hours.keys()) if (key < hour - 24) this.hours.delete(key);
  },
  lastDay() {
    const since = Math.floor(Date.now() / 3_600_000) - 23;
    const total = { http: 0, https: 0 };
    for (const [hour, bucket] of this.hours) {
      if (hour < since) continue;
      total.http += bucket.http;
      total.https += bucket.https;
    }
    return total;
  },
};

/** The host[:port] this request was sent to, when it is a plain name or address (else ''). */
function requestHost(req) {
  const header = String(req.headers.host ?? '');
  return /^([\w.-]+|\[[0-9a-f:.]+\])(:\d{1,5})?$/i.test(header) ? header : '';
}

/** The names people use to reach this server: this page's, the reminder server address's, and any given. */
function httpsHosts(req, extra = []) {
  const hosts = new Set();
  const add = (value) => {
    const host = String(value ?? '').trim().toLowerCase().replace(/^\[(.*)\](:\d+)?$/, '$1').replace(/^([^:]+):\d+$/, '$1');
    if (host && host.length < 254 && /^[a-z0-9.:*-]+$/.test(host)) hosts.add(host);
  };
  add(requestHost(req));
  try {
    add(new URL(resolveReportServer(null, settingsStore.get()).url).hostname);
  } catch {}
  for (const host of Array.isArray(extra) ? extra.slice(0, 10) : []) add(host);
  return [...hosts];
}

/** Errors from the HTTPS settings carry what the page needs to ask next (confirm, a password, open https). */
const httpsRoute = (handler) => asyncRoute(async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    if (!error.status) throw error;
    const { status, report, needsConfirm, needsHttps, needsPassphrase } = error;
    res.status(status).json({ error: error.message, ...(report ? { report } : {}), ...(needsConfirm ? { needsConfirm } : {}), ...(needsHttps ? { needsHttps } : {}), ...(needsPassphrase ? { needsPassphrase } : {}) });
  }
});

function auditHttps(req, actor, reason, details) {
  audit.record({ type: 'settings', outcome: 'changed', reason, actor, ...(details ? { details: { https: details } } : {}) });
}

async function httpsStatus(req) {
  const host = requestHost(req) || `localhost:${config.port}`;
  return {
    ...(await httpsManager.status(httpsHosts(req))),
    viewing: { secure: Boolean(req.secure), host, httpUrl: `http://${host}`, httpsUrl: `https://${host}` },
    reminderServer: resolveReportServer(req),
    reportOpens: reportOpens.lastDay(),
    hstsAges: HSTS_AGES,
    behindProxy: Boolean(req.get('x-forwarded-proto')) && viaTrustedProxy(req),
    acme: acmeView(req),
  };
}

app.get('/api/https', requirePermission('security.https'), httpsRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await httpsStatus(req));
}));

app.post('/api/https/inspect', requirePermission('security.https'), httpsRoute(async (req, res) => {
  const { files, passphrase, hosts } = req.body ?? {};
  res.json(await httpsManager.inspect({ files, passphrase: String(passphrase ?? ''), hosts: httpsHosts(req, hosts) }));
}));

app.post('/api/https/certificate', requirePermission('security.https'), httpsRoute(async (req, res) => {
  const { files, passphrase, hosts, confirm } = req.body ?? {};
  const actor = await adminActor(req);
  const report = await httpsManager.install({ files, passphrase: String(passphrase ?? ''), hosts: httpsHosts(req, hosts), confirm: Boolean(confirm), by: actor.user });
  auditHttps(req, actor, `HTTPS certificate for ${report.summary.subject} put to use (valid until ${report.summary.validTo.slice(0, 10)}).`, { subject: report.summary.subject, names: report.summary.names, issuer: report.summary.issuer, validTo: report.summary.validTo, fingerprint: report.summary.fingerprint });
  console.log(`[https] Certificate for ${logSafe(report.summary.subject)} put to use by ${logSafe(actor.user)}.`);
  res.json({ report, status: await httpsStatus(req) });
}));

app.post('/api/https/certificate/previous', requirePermission('security.https'), httpsRoute(async (req, res) => {
  const actor = await adminActor(req);
  httpsManager.restorePrevious({ by: actor.user });
  auditHttps(req, actor, 'Previous HTTPS certificate put back.');
  res.json(await httpsStatus(req));
}));

app.delete('/api/https/certificate', requirePermission('security.https'), httpsRoute(async (req, res) => {
  const actor = await adminActor(req);
  const fallback = httpsManager.removeUploaded({ confirm: req.query.confirm === '1', by: actor.user });
  auditHttps(req, actor, `Uploaded HTTPS certificate no longer used (now ${fallback === 'environment' ? "the container's certificate" : 'a self-signed one'}).`);
  res.json(await httpsStatus(req));
}));

app.post('/api/https/self-signed', requirePermission('security.https'), httpsRoute(async (req, res) => {
  const actor = await adminActor(req);
  const names = httpsHosts(req, req.body?.names);
  httpsManager.selfSign({ names, by: actor.user });
  auditHttps(req, actor, `Self-signed certificate made for ${names.join(', ')}.`);
  res.json(await httpsStatus(req));
}));

app.post('/api/https/request', requirePermission('security.https'), httpsRoute(async (req, res) => {
  const actor = await adminActor(req);
  const names = Array.isArray(req.body?.names) ? req.body.names.slice(0, 20) : [];
  const csr = httpsManager.createRequest({ names, organization: req.body?.organization ?? '', by: actor.user });
  auditHttps(req, actor, `Certificate request created for ${names.join(', ')}.`);
  res.json({ csr, status: await httpsStatus(req) });
}));

app.get('/api/https/request.csr', requirePermission('security.https'), (req, res) => {
  const csr = httpsManager.requestCsr();
  if (!csr) return res.status(404).json({ error: 'No certificate request was made here.' });
  res.set('Content-Type', 'application/pkcs10');
  res.set('Content-Disposition', 'attachment; filename="cxmissionzero.csr"');
  res.send(csr);
});

app.post('/api/https/mode', requirePermission('security.https'), httpsRoute(async (req, res) => {
  const actor = await adminActor(req);
  const mode = String(req.body?.mode ?? '');
  const from = httpsManager.mode;
  httpsManager.setMode(mode, { secure: Boolean(req.secure), confirm: Boolean(req.body?.confirm), by: actor.user });
  // Emailed reports carry the reminder server address: the https one from now on.
  let addressChanged = '';
  if (mode === 'https' && req.body?.updateAddress) {
    const current = settingsStore.get().links.reportServerUrl;
    const host = requestHost(req);
    if (host && !/^https:/i.test(current || '')) {
      addressChanged = `https://${host}`;
      settingsStore.save({ links: { reportServerUrl: addressChanged } });
    }
  }
  const names = { http: 'HTTP only', both: 'HTTP and HTTPS side by side', https: 'HTTPS only (http redirects to https)' };
  auditHttps(req, actor, `Server switched from ${names[from]} to ${names[mode]}.${addressChanged ? ` Reminder server address set to ${addressChanged}.` : ''}`, { from, to: mode });
  console.log(`[https] ${names[mode]}, switched by ${logSafe(actor.user)}.`);
  res.json({ ...(await httpsStatus(req)), addressChanged });
}));

app.post('/api/https/hardening', requirePermission('security.https'), httpsRoute(async (req, res) => {
  const actor = await adminActor(req);
  const { hsts, minVersion } = req.body ?? {};
  httpsManager.setHardening({ ...(hsts ? { hsts } : {}), ...(minVersion ? { minVersion } : {}) }, { by: actor.user });
  const status = await httpsStatus(req);
  auditHttps(req, actor, `HTTPS hardening: HSTS ${status.hsts.enabled ? `on (${status.hsts.maxAge} s${status.hsts.includeSubDomains ? ', subdomains' : ''})` : 'off'}, lowest TLS version ${status.minVersion}.`, { hsts: status.hsts, minVersion: status.minVersion });
  res.json(status);
}));

app.post('/api/https/browser-check', requirePermission('security.https'), httpsRoute(async (req, res) => {
  const actor = await adminActor(req);
  httpsManager.recordBrowserCheck({ ok: req.body?.ok, url: req.body?.url, by: actor.user });
  res.json({ ok: true });
}));

// ---- Free certificate from Let's Encrypt (src/acme.js) ----

/** The Let's Encrypt part of Settings → HTTPS: its state, and the names this page is reached by. */
function acmeView(req) {
  return { ...acme.status(), suggested: httpsHosts(req).filter(validName), fromEnvironment: LETSENCRYPT_DOMAIN };
}

acme.onEvent((event) => {
  const names = event.names.join(', ');
  const staging = event.staging ? ' (staging: not trusted by browsers)' : '';
  if (event.kind === 'issued') {
    audit.record({ type: 'settings', outcome: 'changed', reason: `Let's Encrypt certificate for ${names} put to use${staging}, valid until ${event.validTo.slice(0, 10)}.`, actor: { kind: 'system', user: event.by || "Let's Encrypt" }, details: { https: { letsEncrypt: { names: event.names, staging: event.staging, validTo: event.validTo } } } });
    try {
      // A trusted certificate is in: deployed with LETSENCRYPT_DOMAIN, the server goes HTTPS only by itself;
      // from the Settings page, http and https side by side (switch to HTTPS only there).
      if (event.by === 'LETSENCRYPT_DOMAIN' && !event.staging) httpsManager.setMode('https', { system: true, by: "Let's Encrypt" });
      else if (httpsManager.mode === 'http') httpsManager.setMode('both', { by: "Let's Encrypt" });
    } catch (error) {
      console.warn(`! [https] ${error.message}`);
    }
  } else {
    audit.record({ type: 'settings', outcome: 'failed', reason: `Let's Encrypt certificate for ${names} not obtained${staging}: ${event.error}`, actor: { kind: 'system', user: event.by || "Let's Encrypt" }, details: { https: { letsEncrypt: { names: event.names, staging: event.staging, error: event.error } } } });
  }
});

app.get('/api/https/acme', requirePermission('security.https'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(acmeView(req));
});

app.post('/api/https/acme', requirePermission('security.https'), httpsRoute(async (req, res) => {
  const { names, email, staging, agree, skipPrecheck } = req.body ?? {};
  const actor = await adminActor(req);
  acme.start({ names, email, staging: staging === true, agree: agree === true, skipPrecheck: skipPrecheck === true, by: actor.user });
  auditHttps(req, actor, `Free certificate requested from Let's Encrypt${staging === true ? ' (staging)' : ''} for ${acme.status().last?.names?.join(', ')}.`);
  res.status(202).json(acmeView(req));
}));

app.post('/api/https/acme/renew', requirePermission('security.https'), httpsRoute(async (req, res) => {
  const actor = await adminActor(req);
  acme.renew({ by: actor.user });
  auditHttps(req, actor, 'Let\'s Encrypt certificate renewal started by hand.');
  res.status(202).json(acmeView(req));
}));

app.delete('/api/https/acme', requirePermission('security.https'), httpsRoute(async (req, res) => {
  const actor = await adminActor(req);
  acme.disable();
  auditHttps(req, actor, 'Automatic renewal of the Let\'s Encrypt certificate turned off (the certificate in use stays until it expires or is replaced).');
  res.json(acmeView(req));
}));

// ---- Activation codes (Settings → Activation codes): add-ons unlocked by the maintainer ----

function activationView(req) {
  return {
    // Seeing the page (activation.view) is not changing it.
    canManage: can(req, 'activation.manage'),
    keyConfigured: ISSUER_KEYS.length > 0,
    // Only the add-ons a code has unlocked (expired ones too, to renew): nothing else is named.
    languages: Object.fromEntries(Object.keys(GATED_LANGUAGES).map((code) => [code, languageAccess.status(code)]).filter(([, s]) => s.on || s.expired)),
    // Everyone who can sign in, to choose who may use a gated language (as far as this person may see people).
    people: iam.users().filter((u) => !u.disabled && withinReach(req, u)).map((u) => ({ id: u.id, name: u.name, email: u.email })),
    tenants: activations.tenants(),
    history: activations.history().slice(0, 10),
  };
}

app.get('/api/activation', requirePermission('activation.manage', 'activation.view'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(activationView(req));
});

app.post('/api/activation', requirePermission('activation.manage'), asyncRoute(async (req, res) => {
  const code = String(req.body?.code ?? '').trim().slice(0, 4000);
  const result = checkCode(code);
  const actor = await adminActor(req);
  // A deactivation code is honoured even when it is itself past its date.
  const usable = result.valid || (result.expired && result.action === 'deactivate');
  if (!usable) {
    audit.record({ type: 'settings', outcome: 'refused', reason: `Activation code refused: ${result.reason}`, actor });
    return res.status(400).json({ error: result.reason || 'This activation code is not valid.' });
  }
  let what;
  if (result.scope.startsWith('lang:')) {
    const first = !Array.isArray(languageAccess.status(result.scope.slice('lang:'.length)).users);
    const applied = languageAccess.apply(result, { by: req.user.id });
    const users = languageAccess.status(applied.code).users ?? [];
    what = `${applied.code === 'he' ? 'Hebrew' : applied.code} ${applied.on ? `turned on until ${result.expires.slice(0, 10)}${first && users.length === 1 && users[0] === req.user.id ? `, open to ${req.user.email}` : ''}` : 'turned off'}`;
  } else {
    what = `several Checkmarx One tenants unlocked for ${result.org}: up to ${result.maxTenants}, until ${result.expires.slice(0, 10)}`;
  }
  activations.record(result, actor.user);
  audit.record({ type: 'settings', outcome: 'changed', reason: `Activation code applied: ${what}.`, actor, details: { activation: { id: result.id, org: result.org, scope: result.scope, action: result.action || 'activate', expires: result.expires } } });
  res.json({ applied: what, ...activationView(req) });
}));

// ---------------------------------------------------------------------------
// Several Checkmarx One tenants (src/tenancy.js, docs/multi-tenant.md). Adding, renaming and
// removing tenants, working in any of them, and choosing who works in which are the Super Admin
// tasks: they need the tenants activation code in date. Everything else works without it.
// ---------------------------------------------------------------------------

/** A tenant's name: the one given when it was added; for the first, its Checkmarx One tenant's. */
function tenantName(id) {
  const tenant = tenancy.get(id);
  if (tenant?.name) return tenant.name;
  try {
    return tenancy.run(id, () => integrationSession()?.connection?.tenant) || 'Main tenant';
  } catch {
    return 'Main tenant';
  }
}

function tenantsView(req) {
  const superAdmin = isSuperAdmin(req.permissions);
  const ids = superAdmin ? tenancy.ids() : tenantsOf(req.user, req.permissions);
  // Who was added to each tenant (Super Admins, who reach every tenant, count only where they were added).
  const people = iam.users().map((u) => (u.tenants?.length ? u.tenants : [DEFAULT_TENANT]));
  return {
    enabled: tenancy.enabled,
    unlocked: tenantsUnlocked(),
    activation: activations.tenants(),
    current: req.tenantId,
    superAdmin,
    canManage: can(req, 'tenants.manage'),
    tenants: ids.map((id) => ({ id, name: tenantName(id), first: id === DEFAULT_TENANT, createdAt: tenancy.get(id)?.createdAt ?? '', people: people.filter((list) => list.includes(id)).length })),
  };
}

/** A Super Admin task: the permission, held by someone in the first tenant, with the activation code in date. */
function requireSuperAdmin(req, res, next) {
  requirePermission('tenants.manage')(req, res, (error) => {
    if (error) return next(error);
    if (!tenantsUnlocked()) return res.status(403).json({ error: 'Several tenants need a tenants activation code that is in date (Settings → Activation codes).' });
    next();
  });
}

/** Record in one tenant's own audit log (a Super Admin acting on it), whatever tenant the request runs in. */
const auditIn = (id, entry) => tenancy.context(id).audit.record(entry);

app.get('/api/tenants', requireSession, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(tenantsView(req));
});

app.post('/api/tenants/enabled', requireSuperAdmin, asyncRoute(async (req, res) => {
  const on = req.body?.on === true;
  const actor = await adminActor(req);
  if (on && !tenancy.enabled) tenancy.enable({ by: req.user.email });
  else if (!on && tenancy.enabled) tenancy.disable();
  audit.record({ type: 'settings', outcome: 'changed', reason: `Several Checkmarx One tenants turned ${on ? 'on' : 'off'}.`, actor, details: { tenants: { enabled: on } } });
  res.json(tenantsView(req));
}));

app.post('/api/tenants', requireSuperAdmin, asyncRoute(async (req, res) => {
  const limit = activations.tenants()?.maxTenants ?? 0;
  if (tenancy.ids().length >= limit) return res.status(409).json({ error: `The activation code allows up to ${limit} tenants, and all are in use.` });
  const tenant = tenancy.add({ name: req.body?.name, by: req.user.email });
  const actor = await adminActor(req);
  audit.record({ type: 'settings', outcome: 'changed', reason: `Tenant "${tenant.name}" added.`, actor, details: { tenants: { added: tenant } } });
  auditIn(tenant.id, { type: 'settings', outcome: 'changed', reason: `This tenant was added by Super Admin ${req.user.email}.`, actor, details: { tenant: { id: tenant.id, name: tenant.name } } });
  res.status(201).json({ added: tenant, ...tenantsView(req) });
}));

app.patch('/api/tenants/:id', requireSuperAdmin, asyncRoute(async (req, res) => {
  const before = tenantName(req.params.id);
  const tenant = tenancy.rename(req.params.id, req.body?.name);
  const actor = await adminActor(req);
  audit.record({ type: 'settings', outcome: 'changed', reason: `Tenant "${before}" renamed "${tenant.name}".`, actor, details: { tenants: { renamed: { id: tenant.id, from: before, to: tenant.name } } } });
  auditIn(tenant.id, { type: 'settings', outcome: 'changed', reason: `Super Admin ${req.user.email} renamed this tenant "${tenant.name}".`, actor });
  res.json(tenantsView(req));
}));

app.delete('/api/tenants/:id', requireSuperAdmin, asyncRoute(async (req, res) => {
  const id = req.params.id;
  if (!tenancy.has(id)) return res.status(404).json({ error: 'No such tenant.' });
  if (id === DEFAULT_TENANT) return res.status(400).json({ error: 'The first tenant cannot be removed.' });
  if (req.body?.confirm !== tenantName(id)) return res.status(400).json({ error: 'Type the tenant\'s name to confirm.' });
  const name = tenantName(id);
  // Stop its automation and write everything it holds before its folder is set aside.
  const loaded = tenancy.loaded().find((t) => t.id === id);
  if (loaded) {
    loaded.scheduler.stop();
    loaded.knownAddresses.flush();
    loaded.creditLedger.flush();
    loaded.findingJournal.flush();
    loaded.audit.flushSync();
  }
  tenancy.remove(id);
  audit.record({ type: 'settings', outcome: 'changed', reason: `Tenant "${name}" removed; its files are kept in the state folder.`, actor: await adminActor(req), details: { tenants: { removed: { id, name } } } });
  res.json(tenantsView(req));
}));

/** Work in another tenant (one of yours; any, for a Super Admin). */
app.post('/api/me/tenant', requireSession, asyncRoute(async (req, res) => {
  const id = String(req.body?.id ?? '');
  if (!tenantsOf(req.user, req.permissions).includes(id)) return res.status(404).json({ error: 'That tenant is not one you work in.' });
  if (req.session.tenantId !== id) {
    req.session.tenantId = id;
    req.session.lastScan = null; // fetched in the other tenant
    saveSignInsSoon();
    // A Super Admin opening a tenant they were not added to is in that tenant's own log.
    const own = req.user.tenants?.length ? req.user.tenants.includes(id) : id === DEFAULT_TENANT;
    if (!own) auditIn(id, { type: 'access', outcome: 'info', reason: `Super Admin ${req.user.email} opened this tenant.`, actor: await adminActor(req) });
  }
  res.json({ current: { id, name: tenantName(id) } });
}));

/** Which tenants a person works in (a Super Admin task). */
app.put('/api/iam/users/:id/tenants', requireSuperAdmin, asyncRoute(async (req, res) => {
  const wanted = Array.isArray(req.body?.tenants) ? req.body.tenants.map(String) : [];
  const unknown = wanted.filter((id) => !tenancy.has(id));
  if (unknown.length) return res.status(400).json({ error: 'No such tenant.' });
  if (!wanted.length) return res.status(400).json({ error: 'Choose at least one tenant.' });
  const { before, after } = iam.setTenants(req.params.id, wanted.length === 1 && wanted[0] === DEFAULT_TENANT ? [] : wanted);
  await auditIam(req, `${after.email} now works in: ${wanted.map(tenantName).join(', ')}.`, { before: { tenants: before.tenants }, after: { tenants: after.tenants } });
  for (const session of sessions.filter((s) => s.userId === after.id)) {
    if (wanted.includes(session.tenantId ?? DEFAULT_TENANT)) continue;
    session.tenantId = undefined; // back to one of their tenants on their next request
    session.lastScan = null;
  }
  res.json(iamView(req));
}));

/** Who may use a gated language (Hebrew): chosen by an Admin, with its activation code in force. */
app.put('/api/activation/languages/:code/users', requirePermission('activation.manage'), asyncRoute(async (req, res) => {
  const code = req.params.code;
  const ids = Array.isArray(req.body?.users) ? req.body.users.map(String) : [];
  const unknown = ids.filter((id) => !iam.user(id));
  if (unknown.length) return res.status(400).json({ error: 'No such user.' });
  const before = languageAccess.status(code).users;
  const status = languageAccess.setUsers(code, ids);
  const name = code === 'he' ? 'Hebrew' : code;
  const emails = (list) => (list ?? []).map((id) => iam.user(id)?.email ?? id);
  audit.record({ type: 'settings', outcome: 'changed', reason: ids.length ? `${name} is open to ${ids.length === 1 ? '1 person' : `${ids.length} people`}: ${emails(ids).join(', ')}.` : `${name} is open to nobody until people are chosen.`, actor: await adminActor(req), details: { activation: { language: code, before: before === null ? 'everyone' : emails(before), after: emails(ids) } } });
  res.json(activationView(req));
}));

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
    reportOpens.record(req.secure);
    // HTTP and HTTPS side by side: the report tries HTTPS, and keeps to it when it works from the reader's machine.
    if (!req.secure && httpsManager.mode === 'both') answer.httpsUrl = httpsOrigin(req);
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
const relayCache = scoped(tenancy, 'relayCache');
const stateCache = { delete: (projectId) => relayCache.delete(`risks|${projectId}`) };
// Findings sent for triage or remediation recently: their answers change soon, so look again sooner.
const recentActions = scoped(tenancy, 'recentActions');
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
      // States read in the last 30 s, or (while they are read again in the background) the last
      // ones known: a report polling every few seconds never waits on Checkmarx One for them.
      const known = relayCache.peek(`risks|${projectId}`, () => loadRiskInfo(session, projectId), STATE_CACHE_MS);
      statesByProject.set(projectId, known ? known.value.states : await projectStates(session, projectId));
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

/**
 * "Apply with git": a signed link to one finding's AI Remediation fix as a
 * patch, for `curl … -o mz-fix.patch && git apply mz-fix.patch` in the
 * reader's checkout. The report's grant is the permission, as for every
 * relay action; the link only ever reads that one finding's fix.
 */
app.post(
  '/api/relay/patch-link',
  asyncRoute(async (req, res) => {
    const findings = grantedFindings(req, res);
    if (!findings) return;
    if (findings.length !== 1) return res.status(400).json({ error: 'Ask about one finding at a time.' });
    const [finding] = findings;
    if (!finding.scanId || !finding.alternateId) return res.status(400).json({ error: 'This finding has no AI Remediation result.' });
    const base = reportServerUrl(req, settingsStore.get()).replace(/\/+$/, '') || requestOrigin(req);
    res.json({ url: `${base}/api/relay/patch/${patchTokens.issue(finding)}${tenantQuery('?')}` });
  }),
);

app.get(
  '/api/relay/patch/:token',
  asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    const target = patchTokens.verify(req.params.token);
    if (!target) return res.status(404).type('text').send('This fix link is incomplete or was changed. Copy the command from the report again.\n');
    if (target.expired) return res.status(410).type('text').send('This fix link has expired (they last 7 days). Copy the command from the report again.\n');
    const session = await relaySession(res);
    if (!session) return;
    let body;
    try {
      body = await remediationDetails(session, target);
    } catch (error) {
      console.warn(`[relay] could not read an AI Remediation result for a patch: ${logSafe(error.message)}`);
      return res.status(502).type('text').send(`Could not read the fix: ${relayError(error)}\n`);
    }
    const patch = gitPatch(body);
    if (!patch) return res.status(404).type('text').send('Checkmarx One has no code changes for this finding yet.\n');
    audit.record({
      type: 'report',
      outcome: 'info',
      reason: 'AI Remediation fix downloaded as a patch for git apply.',
      actor: { kind: 'report', ip: clientIp(req), userAgent: String(req.get('user-agent') ?? '').slice(0, 200) },
      details: { scanId: target.scanId, alternateId: target.alternateId },
    });
    res.set('Content-Disposition', 'attachment; filename="mz-fix.patch"');
    res.type('text/x-diff').send(patch);
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
    ? ['Open your CxMissionZero report for these projects and click Refresh to fetch the suggested fixes.', 'Review and approve the pull requests AI Remediation opens in your repository (or apply the fix shown in Checkmarx One).']
    : ['Open your CxMissionZero report for these projects and click Refresh to see the verdicts.', 'Confirmed findings can then be remediated from the report; proposed not exploitable ones drop out of it.'];
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
    if (!req.session.lastScan) return res.status(409).json({ error: 'Load findings on the Dashboard first.' });
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
  if (!req.session.lastScan) return res.status(409).json({ error: 'Load findings on the Dashboard first.' });
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
    if (!req.session.lastScan) return res.status(409).json({ error: 'Load findings on the Dashboard first.' });
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
    if (!req.session.lastScan) return res.status(409).json({ error: 'Load findings on the Dashboard first.' });
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
    if (!req.session.lastScan) return res.status(409).json({ error: 'Load findings on the Dashboard first.' });
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

/** Rescans this server started are credited to the developer they verify (see src/scan-attribution.js). */
const scanAttribution = scoped(tenancy, 'scanAttribution');
const creditFor = (scanId) => scanAttribution.get(scanId);
/** A last-scan record, with a verification rescan credited to whose work it verifies. */
const credited = (scan) => {
  const credit = scan && creditFor(scan.id ?? scan.scanId);
  return credit ? { ...scan, initiator: credit.initiator, initiatorEmail: credit.email || undefined, startedBy: scanInitiator(scan) } : scan;
};

const TRACK_REFRESH_MS = 60 * 60 * 1000;
const TRACK_TOUCHED_WINDOW_MS = 30 * 60 * 1000;
const TRACK_TOUCHED_EVERY_MS = 3 * 60 * 1000;
const refreshing = scoped(tenancy, 'refreshing');


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
    // Every current finding of the project: those no longer among them are gone (the Impact page).
    findingJournal.observe({ projectId, projectName }, byProject.get(projectId), { complete: true });
  });
  return byProject;
}

function progressFor(report, byProject) {
  let detection = null;
  try {
    detection = resolveWindow(report.filters.detection, 'First detection');
  } catch {}
  const progress = computeProgress(report, byProject, detection, (ids, since) => creditLedger.usedSince(ids, since), new Date(), remediatedOf);
  // Whether the round's scope is closed (every finding dealt with): ready for a verification rescan.
  progress.closure = closure(report, byProject, remediatedOf);
  return progress;
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
  tenancy.each(() => {
    backgroundRefresh().catch(() => {});
    monthlyImpact().catch((error) => console.warn(`[impact] ${error.message}`));
    resolveAutomationSession()
      .then((session) => session && runVerifications(session).then(() => session))
      .then((session) => session && runDueTrackedReminders(session))
      .catch((error) => console.warn(`[tracked reminders] ${error.message}`));
  });
}, 60 * 1000).unref?.();

// ---- Follow-up reminders, schedules and triage for a tracked report -------

const DAY_MS = 86_400_000;
// ---- Verification: rescan to prove a round's fixes, then the next round ----

/** Projects whose rescan could not start wait this long for a scan from elsewhere (a pipeline). */
const VERIFY_WAIT_MS = 30 * DAY_MS;
const remediatedOf = (projectId) => creditLedger.remediatedIds(projectId);
const cxErrorText = (error) => `${error?.status ? `HTTP ${error.status}: ` : ''}${String(error?.body?.message ?? error?.message ?? error).slice(0, 200)}`;
const scanIdOfSummary = (scan) => String(scan?.id ?? scan?.scanId ?? '');

/** Ask Checkmarx One to scan each of the report's projects again, like its last scan. */
async function startVerification(report, session, { by = '', automatic = false, reason = '' } = {}) {
  if (report.verification && !report.verification.finishedAt) {
    throw Object.assign(new Error('A verification is already running for this report.'), { status: 409 });
  }
  const last = await getLastScans(session.client, report.projects.map((p) => p.projectId));
  const known = new Map((session.lastScan?.projects ?? []).map((p) => [p.projectId, p]));
  const requestedAt = new Date().toISOString();
  const projects = report.projects.map((p) => ({ projectId: p.projectId, projectName: p.projectName, status: 'Queued', scanId: '', lastScanId: '', error: '' }));
  await mapWithConcurrency(projects, 3, async (entry) => {
    entry.lastScanId = scanIdOfSummary(last[entry.projectId]);
    if (!entry.lastScanId) {
      entry.status = 'waiting';
      entry.error = 'No completed scan yet: the first one verifies it.';
      return;
    }
    try {
      const scan = await session.client.request(`/api/scans/${encodeURIComponent(entry.lastScanId)}`, { retries: 1 });
      // Whose work this verifies: the last scan's initiator (or, after an earlier rescan, the developer it was credited to).
      const summary = last[entry.projectId];
      const earlier = creditFor(entry.lastScanId);
      const resolved = session.lastScan?.initiators?.[entry.projectId];
      const owner = earlier ?? {
        initiator: scanInitiator(summary) || scanInitiator(scan),
        email: scanInitiatorEmail(summary) || (resolved?.scanId === entry.lastScanId ? resolved.email : '') || '',
      };
      entry.creditedTo = owner.initiator;
      const request = rescanRequest(entry.projectId, scan, known.get(entry.projectId) ?? {}, { initiator: owner.email || owner.initiator, requestedBy: by || 'automatic verification' });
      if (request.waiting) {
        entry.status = 'waiting';
        entry.error = request.reason;
        return;
      }
      const created = await session.client.request('/api/scans', { method: 'POST', body: request.body, retries: 1 });
      entry.scanId = String(created?.id ?? '');
      entry.status = String(created?.status || 'Queued');
      scanAttribution.record(entry.scanId, { projectId: entry.projectId, initiator: owner.initiator, email: owner.email, requestedBy: by || 'automatic verification', reason: `verification of "${report.name}"` });
      entry.branch = request.branch;
      entry.engines = request.engines;
      if (!entry.scanId) throw new Error('Checkmarx One did not return a scan id.');
    } catch (error) {
      entry.status = 'waiting';
      entry.error = `Checkmarx One did not start a scan (${cxErrorText(error)}): the next scan of this project, from your pipeline or Checkmarx One, verifies it.`;
    }
  });
  const round = report.round ?? 1;
  report.verification = { round, requestedAt, by, automatic, projects, finishedAt: null, result: null };
  audit.record({
    type: 'verification',
    outcome: 'info',
    reason: `Verification rescan of "${report.name}" (round ${round}) ${reason || (automatic ? 'started automatically: every finding in scope was dealt with' : 'started')}.`,
    actor: automatic ? SYSTEM_ACTOR : { kind: 'user', user: by },
    details: { reportId: report.id, round, scans: projects.map(({ projectName, status, scanId, error }) => ({ projectName, status, scanId, error })) },
  });
  trackedReports.save();
  return report.verification;
}

/** Follow a running verification: scan statuses, scans from elsewhere, and the result once scans are done. */
async function advanceVerification(report, session) {
  const v = report.verification;
  if (!v || v.finishedAt) return;
  const now = new Date().toISOString();
  let changed = false;
  const waiting = v.projects.filter((e) => e.status === 'waiting');
  if (waiting.length) {
    const last = await getLastScans(session.client, waiting.map((e) => e.projectId)).catch(() => ({}));
    for (const entry of waiting) {
      const scan = last[entry.projectId];
      if (scan && scanIdOfSummary(scan) !== entry.lastScanId && newerThan(scan, v.requestedAt)) {
        Object.assign(entry, { scanId: scanIdOfSummary(scan), status: 'Completed', completedAt: now, error: '', fromElsewhere: true });
        changed = true;
      }
    }
  }
  for (const entry of v.projects) {
    if (entry.status === 'waiting' || TERMINAL.has(entry.status) || !entry.scanId) continue;
    try {
      const scan = await session.client.request(`/api/scans/${encodeURIComponent(entry.scanId)}`, { retries: 1, background: true });
      const status = String(scan?.status ?? '');
      if (status && status !== entry.status) {
        entry.status = status;
        if (TERMINAL.has(status)) entry.completedAt = now;
        changed = true;
      }
    } catch (error) {
      entry.error = `Could not read the scan's status (${cxErrorText(error)}).`;
    }
  }
  const scanning = v.projects.some((e) => e.status !== 'waiting' && !TERMINAL.has(e.status));
  const verified = v.projects.filter((e) => e.status === 'Completed' || e.status === 'Partial');
  const stillWaiting = v.projects.some((e) => e.status === 'waiting');
  if (changed && !scanning && verified.length) {
    const byProject = await currentFindings(session, report.projects);
    trackedReports.record(report, progressFor(report, byProject));
    v.result = verificationResult(report, byProject, {
      verifiedProjects: new Set(verified.map((e) => e.projectId)),
      remediated: remediatedOf,
      newInScope: report.latest?.newFindings ?? 0,
    });
    v.checkedAt = now;
    const r = v.result;
    audit.record({
      type: 'verification',
      outcome: r.zero ? 'success' : 'info',
      reason: `Verification of "${report.name}" (round ${v.round}): ${r.fixed} fixed, ${r.stillFound.length} still found${r.ineffective ? ` (${r.ineffective} after AI Remediation)` : ''}, ${r.newInScope} new in scope${r.zero ? ' — the scope is at zero' : ''}.`,
      actor: SYSTEM_ACTOR,
      details: { reportId: report.id, round: v.round, fixed: r.fixed, stillFound: r.stillFound.length, ineffective: r.ineffective, accepted: r.accepted, newInScope: r.newInScope, notChecked: r.notChecked },
    });
    trackedReports.save();
    await developerResult(report, session).catch((error) => console.warn(`[verification] ${logSafe(report.name)}: ${logSafe(error.message)}`));
  }
  const expired = Date.now() - Date.parse(v.requestedAt) > VERIFY_WAIT_MS;
  if (!scanning && (!stillWaiting || expired)) {
    v.finishedAt = now;
    changed = true;
  }
  if (changed) trackedReports.save();
}

/**
 * Follow a report's verification. When its scope is closed, the developers get their turn to
 * rescan first (src/rescan-window.js); when that window ends with nobody rescanning, and
 * automatic verification is on, the rescan starts on their behalf.
 */
async function verificationStep(report, session) {
  await advanceVerification(report, session);
  const action = windowAction(report);
  if (action === 'open') await openRescanWindow(report, session);
  else if (action === 'cancel') {
    report.verifyWindow = null;
    trackedReports.save();
  } else if (action === 'start') await rescanOnBehalf(report, session);
}

// ---- The developer's turn to rescan ----------------------------------------------------

const rescanTokens = rescanGrants((text) => reportGrants.macText(text));
/** The rescan button in a developer's report works for as long as the report's own grants (30 days). */
const RESCAN_REPORT_GRANT_MS = 30 * DAY_MS;
/** A developer's rescan link stays usable this long after their window ends (it then shows the result). */
const RESCAN_LINK_EXTRA_MS = 14 * DAY_MS;

/** Who fixed what: each project's latest scan initiator (as credited), with an address. */
async function reportDevelopers(session, report) {
  const scan = await openScanFor(session, report);
  const byEmail = new Map();
  for (const p of report.projects) {
    const info = scan.initiators?.[p.projectId];
    const email = String(info?.email || '').trim().toLowerCase();
    if (!email) continue;
    if (!byEmail.has(email)) byEmail.set(email, { email, name: info.initiator || email, projects: [] });
    byEmail.get(email).projects.push(p.projectName);
  }
  return [...byEmail.values()];
}

/** The signed link a developer rescans this report's round with. */
function rescanLink(report, email, window = currentWindow(report)) {
  const server = resolveReportServer(null, settingsStore.get());
  if (!server.url || !window) return '';
  const grant = rescanTokens.issue({ reportId: report.id, round: window.round, email, exp: Date.parse(window.dueAt) + RESCAN_LINK_EXTRA_MS });
  return `${server.url.replace(/\/+$/, '')}/rescan?g=${encodeURIComponent(grant)}${tenantQuery('&')}`;
}

/** The scope is closed: the developers' turn to rescan begins, and they are told. */
async function openRescanWindow(report, session) {
  const developers = await reportDevelopers(session, report).catch(() => []);
  report.verifyWindow = newWindow(report, developers);
  trackedReports.save();
  audit.record({
    type: 'verification',
    outcome: 'info',
    reason: `Every finding in "${report.name}" (round ${report.verifyWindow.round}) was dealt with: its developers have until ${report.verifyWindow.dueAt} to rescan${report.verify?.auto ? ', then it is rescanned on their behalf' : ''}.`,
    actor: SYSTEM_ACTOR,
    details: { reportId: report.id, round: report.verifyWindow.round, dueAt: report.verifyWindow.dueAt, developers: developers.map((d) => d.email) },
  });
  await mailDevelopers(report, 'ready').catch((error) => console.warn(`[verification] ${logSafe(report.name)}: ${logSafe(error.message)}`));
}

/** Nobody rescanned in time: rescan on the developers' behalf, and tell them. */
async function rescanOnBehalf(report, session) {
  const window = currentWindow(report);
  await startVerification(report, session, { automatic: true, reason: `started on its developers' behalf: nobody rescanned within ${window.graceHours} hours` });
  window.startedAt = new Date().toISOString();
  window.startedBy = '';
  trackedReports.save();
  await mailDevelopers(report, 'onBehalf').catch((error) => console.warn(`[verification] ${logSafe(report.name)}: ${logSafe(error.message)}`));
}

/** A developer starts the rescan of their own fixes (from their report, or the emailed link). */
async function rescanByDeveloper(report, email) {
  const window = currentWindow(report);
  if (!window) return { status: 409, error: report.latest?.closure?.closed ? 'The rescan opens in a moment: try again shortly.' : 'Not every finding in this report is dealt with yet: triage or fix the rest first.' };
  if (window.startedAt || report.verification?.round === window.round) return { status: 409, error: 'This round is already being rescanned.' };
  const session = await resolveAutomationSession();
  if (!session) return { status: 503, error: 'The reminder server has no Checkmarx One connection right now.' };
  await startVerification(report, session, { by: email, reason: `started by ${email}, who fixed the findings` });
  window.startedAt = new Date().toISOString();
  window.startedBy = email;
  trackedReports.save();
  return { status: 200 };
}

/** One email to each developer of the report: their turn to rescan, a rescan on their behalf, or the result. */
async function mailDevelopers(report, kind) {
  const settings = sendingSettings();
  const window = currentWindow(report);
  if (!window?.developers?.length || !isVerified(settings)) return 0;
  const brand = settings.branding?.companyName || settings.branding?.appName || 'Application security';
  const accent = /^#[0-9a-f]{6}$/i.test(settings.branding?.accentColor ?? '') ? settings.branding.accentColor : '#4f46e5';
  const result = report.verification?.result;
  const due = new Date(window.dueAt).toUTCString().replace(/:\d\d GMT$/, ' UTC');
  let sent = 0;
  for (const dev of window.developers) {
    const link = rescanLink(report, dev.email, window);
    const button = link ? `<p style="margin:20px 0"><a href="${escapeHtmlText(link)}" style="background:${accent};color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Rescan now</a></p>` : '';
    const projects = escapeHtmlText(dev.projects.join(', '));
    const text = {
      ready: {
        subject: `${report.name}: your fixes are in, rescan to prove them`,
        lines: [
          `Every finding in scope for ${projects} has been dealt with. Thank you.`,
          `You get the first chance to prove the fixes: rescan now, before ${due}.`,
          report.verify?.auto ? 'If nobody rescans by then, CxMissionZero rescans on your behalf.' : 'After that, your security team rescans it.',
        ],
        button,
      },
      onBehalf: {
        subject: `${report.name}: rescanned on your behalf`,
        lines: [
          `No rescan was started within ${window.graceHours} hours, so CxMissionZero has started one for ${projects} on your behalf, to check that the fixes work.`,
          'You will get the updated report when it finishes.',
        ],
        button: '',
      },
      result: {
        subject: result?.zero ? `${report.name}: verified at zero` : `${report.name}: rescan result, ${result?.fixed ?? 0} fixed, ${result?.stillFound?.length ?? 0} still found`,
        lines: result?.zero
          ? [`The rescan of ${projects} found nothing left in scope: every fix worked. Mission Zero for this scope.`]
          : [
              `The rescan of ${projects} is done: ${result?.fixed ?? 0} fixed, ${result?.stillFound?.length ?? 0} still found${result?.ineffective ? ` (${result.ineffective} of them after an AI fix that did not work)` : ''}${result?.newInScope ? `, ${result.newInScope} new` : ''}.`,
              'The updated report with what is left follows in a separate email.',
            ],
        button: '',
      },
    }[kind];
    const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827;max-width:640px">
      <p style="font-size:13px;color:#6b7280;margin:0 0 4px">${escapeHtmlText(brand)}</p>
      <h2 style="margin:0 0 12px;font-size:18px">${escapeHtmlText(text.subject)}</h2>
      <p>Hi ${escapeHtmlText(dev.name || dev.email)},</p>
      ${text.lines.map((line) => `<p>${line}</p>`).join('')}
      ${text.button}
    </div>`;
    try {
      await sendReminderMail(settings, { subject: text.subject, html, text: `Hi ${dev.name || dev.email},\n\n${text.lines.join('\n\n').replace(/<[^>]+>/g, '')}${link && kind === 'ready' ? `\n\nRescan now: ${link}` : ''}\n` }, { exact: true, to: [dev.email] });
      sent += 1;
    } catch (error) {
      console.warn(`[verification] could not email ${logSafe(dev.email)}: ${logSafe(error.message)}`);
    }
  }
  window.notified = { ...(window.notified ?? {}), [kind]: new Date().toISOString() };
  trackedReports.save();
  return sent;
}

/** The result is in: tell the developers, and send the updated report of what is left. */
async function developerResult(report, session) {
  if (!currentWindow(report)) return;
  await mailDevelopers(report, 'result');
  if (!report.verification?.result?.zero && isVerified(sendingSettings())) {
    const server = resolveReportServer(null, settingsStore.get());
    await remindTrackedReport(session, report, { sendTo: audienceSetting(), attachHtml: true }, server.url, { automatic: true });
  }
}

/** Every minute, for every report (and on each Refresh, for that one). */
async function runVerifications(session) {
  for (const report of trackedReports.list()) {
    await verificationStep(report, session).catch((error) => console.warn(`[verification] ${logSafe(report.name)}: ${logSafe(error.message)}`));
  }
}

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
    { rules: settings.initiators, useDirectory: settings.initiators.useDirectory, concurrency: config.concurrency, memory: knownAddresses, attributed: creditFor },
  );
  return { projects, initiators: initiators.byProject, byProject };
}

/** Settings → Who gets reminders: 'initiator', 'list' or 'both'. */
const audienceSetting = (settings = settingsStore.get()) => (['initiator', 'list', 'both'].includes(settings.reminders?.audience) ? settings.reminders.audience : 'initiator');

const countSent = (body) => (Array.isArray(body?.sent) ? body.sent.length : body?.messageId ? 1 : 0);

/** Send (or preview) a follow-up reminder for a report's open findings. */
async function remindTrackedReport(session, report, options, relayUrl, { automatic = false } = {}) {
  // A report follows Settings → Who gets reminders, unless it was given its own choice ('developers', 'list' or
  // 'both'). 'initiator' was the old default every report was saved with, so it follows the setting too.
  const own = { developers: 'initiator', list: 'list', both: 'both' }[options.sendTo];
  const sendTo = own ?? audienceSetting();
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
          tracked: report,
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
    tracked: report,
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
  // Hands-off mode, paused from an email: scheduled follow-ups wait too (they run when it resumes).
  if (isPaused(settings.handsOff, now)) return;
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
      auto.lastError = 'Email is not set up yet (Settings → Email server), so nothing was sent.';
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
    // 'settings' (or nothing): follow Settings → Who gets reminders; a report keeps its own choice only when given one.
    sendTo: ['developers', 'list', 'both'].includes(input.sendTo) ? input.sendTo : 'settings',
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
/**
 * Give `projects` what the `wanted` severities of their findings still need
 * (confirmed by two agreeing reads of Checkmarx One, never an estimate), plus
 * extra credits each, out of the credit pool. The severities join each
 * project's rule. Returns the refusal ({ error }) or null once given.
 */
async function allocateNeeded(req, projects, byProject, { wanted, extraTriage, extraRemediation, where, details }) {
  const actor = await adminActor(req);
  const before = new Map(projects.map((p) => [p.projectId, allocationSnapshot(p.projectId)]));
  for (const { projectId, projectName } of projects) {
    if (wanted.length) allocations.setSeverities(projectId, projectName, SEVERITIES.filter((s) => wanted.includes(s) || allocations.severitiesOf(projectId).includes(s)));
  }
  const verifiedRisks = new Map();
  if (wanted.length) {
    const lastScans = await getLastScans(req.session.client, projects.map((p) => p.projectId)).catch(() => ({}));
    const scanIdOf = (id) => String(lastScans?.[id]?.id ?? lastScans?.[id]?.scanId ?? '');
    const refused = [];
    await mapWithConcurrency(projects, 3, async (p) => {
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
      const reason = `Not allocated: what the projects need could not be confirmed twice with Checkmarx One. ${refused[0]}`;
      audit.record({ type: 'allocation', outcome: 'refused', reason, actor, credits: { kind: 'allocation', requested: 0, charged: 0 }, details });
      return { error: reason };
    }
  }
  const plan = projects.map(({ projectId, projectName }) => {
    const { shortfall } = allocations.need(projectId, verifiedRisks.get(projectId) ?? byProject.get(projectId) ?? []);
    return { projectId, projectName, triage: wanted.length ? shortfall.triage : 0, remediation: wanted.length ? shortfall.remediation : 0 };
  });
  const given = plan.reduce((n, x) => n + x.triage + x.remediation + extraTriage + extraRemediation, 0);
  const pool = creditPool();
  if (pool.limited && given > pool.unallocated) {
    allocations.save();
    const reason = `Only ${pool.unallocated} credit${pool.unallocated === 1 ? '' : 's'} left in the credit pool to give; ${given} needed for ${where}.`;
    audit.record({ type: 'allocation', outcome: 'refused', reason, actor, credits: { kind: 'allocation', requested: given, charged: 0 }, details: { ...details, pool } });
    return { error: `${reason} Raise the pool under Settings → AI & credits.`, pool };
  }
  for (const { projectId, projectName, triage, remediation } of plan) {
    if (triage) allocations.grant(projectId, projectName, 'triage', triage);
    if (remediation) allocations.grant(projectId, projectName, 'remediation', remediation);
    if (extraTriage) allocations.add(projectId, projectName, 'triage', extraTriage);
    if (extraRemediation) allocations.add(projectId, projectName, 'remediation', extraRemediation);
  }
  allocations.save();
  for (const { projectId, projectName } of projects) {
    auditAllocation({
      actor, projectId, projectName, before: before.get(projectId),
      change: { severities: wanted, addTriage: extraTriage || undefined, addRemediation: extraRemediation || undefined },
      reason: `Changed from ${where}.`,
    });
  }
  return null;
}

/**
 * Credit Control: give the ticked projects (none ticked: every project holding
 * credits) what the chosen severities need, plus any extra.
 */
app.post('/api/credits/allocate-needed', requirePermission('credits.allocate'), afterFetch, asyncRoute(async (req, res) => {
  const wanted = cleanSeverities(req.body?.severities);
  const extraTriage = Math.max(0, Math.floor(Number(req.body?.triageAdd) || 0));
  const extraRemediation = Math.max(0, Math.floor(Number(req.body?.remediationAdd) || 0));
  if (!wanted.length && !extraTriage && !extraRemediation) return res.status(400).json({ error: 'Pick severities, or enter credits to add.' });
  if (!req.session.client) return res.status(409).json({ error: 'Connect to Checkmarx One first.' });
  const chosen = new Set(idList(req.body?.projectIds));
  const projects = allocations.list().filter((p) => !chosen.size || chosen.has(p.projectId)).map((p) => ({ projectId: p.projectId, projectName: p.projectName || p.projectId }));
  if (!projects.length) return res.status(400).json({ error: 'Give credits to a project first.' });
  const byProject = await currentFindings(req.session, projects);
  const refused = await allocateNeeded(req, projects, byProject, {
    wanted, extraTriage, extraRemediation, where: 'Credit Control', details: { projectIds: projects.map((p) => p.projectId) },
  });
  if (refused) return res.status(409).json(refused);
  for (const p of req.session.lastScan?.projects ?? []) if (allocations.get(p.projectId)) p.credits = creditView(p);
  res.json({ pool: creditPool(), allocations: allocations.list() });
}));

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
    const refused = await allocateNeeded(req, report.projects, byProject, {
      wanted, extraTriage, extraRemediation, where: `tracked report "${report.name}"`, details: { report: report.id },
    });
    if (refused) return res.status(409).json(refused);
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

/**
 * AI Remediation for a tracked report's confirmed findings (and only those) of
 * the chosen severities, read fresh: 3 credits each, from remediation credits
 * already given to its projects.
 */
app.post(
  '/api/tracked-reports/:id/remediate',
  requirePermission('triage.run'),
  afterFetch,
  asyncRoute(async (req, res) => {
    const report = trackedReports.get(req.params.id);
    if (!report) return res.status(404).json({ error: 'No such report.' });
    const wanted = cleanSeverities(req.body?.severities);
    if (!wanted.length) return res.status(400).json({ error: 'Pick at least one severity to remediate.' });
    const scan = await openScanFor(req.session, report);
    const summary = await remediateConfirmed(req, scan, wanted, `Tracked report "${report.name}": remediate the confirmed findings`);
    // What is left to remediate, now that these are sent (the button stops glowing when nothing is).
    if (summary.started && report.latest) {
      report.latest = { ...report.latest, toRemediate: progressFor(report, scan.byProject).toRemediate };
      trackedReports.save();
    }
    res.json({ ...summary, report: trackedView(report) });
  }),
);

/** Remediate the confirmed findings of these severities in a freshly read scan; tell the developers unless asked not to. */
async function remediateConfirmed(req, scan, wanted, origin) {
  const { allowReremediation = false } = settingsStore.get().aiTriage ?? {};
  const findings = scan.projects.flatMap((p) => {
    const remediated = allowReremediation ? new Set() : creditLedger.remediatedIds(p.projectId);
    return p.risks.filter((r) => remediable(r) && !remediated.has(r.riskId)).map((r) => ({ ...r, projectId: p.projectId, projectName: p.projectName }));
  });
  const unique = remediationCandidates(findings, wanted);
  if (!unique.length) return { requested: 0, started: 0, failed: 0, skipped: 0, errors: [] };
  const actor = await adminActor(req);
  const { startedFindings, ...summary } = await adminRemediate(req.session, unique, scan.initiators, { actor, origin });
  const notified = req.body?.notifyInitiators === false ? null : await notifyOnBehalf(req.session, 'remediation', startedFindings, scan.initiators, actor);
  return { ...summary, notified };
}

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
    autoRefresh: Boolean(sessions.get(tstate.automationSessionId) ?? sessions.get(tstate.bootstrapSessionId) ?? settingsStore.get().automationApiKey),
  });
});

app.post('/api/tracked-reports', requirePermission('reports.manage'), (req, res) => {
  const { lastScan } = req.session;
  if (!lastScan) return res.status(409).json({ error: 'Load findings on the Dashboard first.' });
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
    await verificationStep(report, req.session).catch((error) => {
      report.lastError = `Verification: ${error.message}`;
    });
    res.json(trackedView(report));
  }),
);

/** Rescan the report's projects in Checkmarx One to verify the round's fixes. */
app.post(
  '/api/tracked-reports/:id/verify',
  requirePermission('reports.manage'),
  asyncRoute(async (req, res) => {
    const report = trackedReports.get(req.params.id);
    if (!report) return res.status(404).json({ error: 'No such report.' });
    const session = req.session?.client ? req.session : await resolveAutomationSession();
    if (!session) return res.status(409).json({ error: 'Connect to Checkmarx One first.' });
    await startVerification(report, session, { by: req.user?.email ?? '' });
    res.json(trackedView(report));
  }),
);

/**
 * How a round is verified: the developers' window to rescan themselves (24 hours to 14 days,
 * 48 by default), and whether it is rescanned on their behalf when nobody did.
 */
app.put('/api/tracked-reports/:id/verify-settings', requirePermission('reports.manage'), (req, res) => {
  const report = trackedReports.get(req.params.id);
  if (!report) return res.status(404).json({ error: 'No such report.' });
  const auto = 'auto' in (req.body ?? {}) ? req.body.auto === true : Boolean(report.verify?.auto);
  const graceHours = 'graceHours' in (req.body ?? {}) ? graceHoursOf({ verify: { graceHours: req.body.graceHours } }) : graceHoursOf(report);
  report.verify = { ...(report.verify ?? {}), auto, graceHours };
  // An open window keeps its developers; its end moves with the new length.
  const window = currentWindow(report);
  if (window && !window.startedAt) {
    window.graceHours = graceHours;
    window.dueAt = new Date(Date.parse(window.openedAt) + graceHours * HOUR_MS).toISOString();
  }
  trackedReports.save();
  audit.record({ type: 'verification', outcome: 'changed', reason: `Verification of "${report.name}": developers have ${graceHours} hours to rescan, then ${auto ? 'it is rescanned on their behalf' : 'it waits for a rescan by hand'}.`, actor: { kind: 'user', user: req.user?.email ?? '' }, details: { reportId: report.id, auto, graceHours } });
  res.json(trackedView(report));
});

// ---- A developer rescans their own fixes: from their report, or the emailed link ----

/** Each developer's own rescan link, to send by hand (when email is not set up, for example). */
app.get('/api/tracked-reports/:id/rescan-links', requirePermission('reports.manage'), (req, res) => {
  const report = trackedReports.get(req.params.id);
  if (!report) return res.status(404).json({ error: 'No such report.' });
  const window = currentWindow(report);
  if (!window) return res.status(409).json({ error: 'Not every finding in scope is dealt with yet: the developers\' rescan opens then.' });
  const links = (window.developers ?? []).map((d) => ({ email: d.email, name: d.name, projects: d.projects, link: rescanLink(report, d.email, window) }));
  if (links.some((l) => !l.link)) return res.status(409).json({ error: 'Set the reminder server address (Settings → Server address) so the links can reach this server.' });
  res.json({ dueAt: window.dueAt, links });
});

/** {report, grant} for a valid rescan grant, or an error to show. */
function rescanFromGrant(token) {
  const grant = rescanTokens.verify(token);
  if (!grant) return { error: 'This rescan link is not valid any more. Ask your security team for a new report.' };
  const report = trackedReports.get(grant.reportId);
  if (!report) return { error: 'This report is no longer tracked.' };
  return { report, grant };
}

/** Where the developer's rescan stands (the emailed report asks this). */
app.post('/api/relay/rescan-state', (req, res) => {
  const { report, grant, error } = rescanFromGrant(req.body?.grant);
  if (error) return res.status(403).json({ error });
  res.json({ name: report.name, round: report.round ?? 1, sameRound: grant.round === (report.round ?? 1), ...windowState(report) });
});

/** Start the rescan, as the developer (the emailed report's button). */
app.post(
  '/api/relay/rescan',
  asyncRoute(async (req, res) => {
    const { report, grant, error } = rescanFromGrant(req.body?.grant);
    if (error) return res.status(403).json({ error });
    if (grant.round !== (report.round ?? 1)) return res.status(409).json({ error: 'That round is over: a newer report is on its way.' });
    const started = await rescanByDeveloper(report, grant.email);
    if (started.status !== 200) return res.status(started.status).json({ error: started.error, ...windowState(report) });
    res.json({ name: report.name, ...windowState(report) });
  }),
);

/** The emailed link: one page, no script, one button. */
const rescanPage = (title, body, { grant = '', button = false } = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="/app-icon"><title>${escapeHtmlText(title)}</title>
<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f5f6fa;color:#111827;display:grid;place-items:center;min-height:100vh}main{max-width:520px;margin:16px;background:#fff;border:1px solid #e3e6ee;border-radius:14px;padding:28px}h1{font-size:20px;margin:0 0 12px}p{line-height:1.5;color:#374151}button{margin-top:12px;background:#4f46e5;color:#fff;border:0;border-radius:9px;padding:12px 20px;font:inherit;font-weight:600;cursor:pointer}small{color:#6b7280}@media(prefers-color-scheme:dark){body{background:#0f1117;color:#e5e7eb}main{background:#171a23;border-color:#2a2f3c}p{color:#cbd5e1}}</style></head>
<body><main><h1>${escapeHtmlText(title)}</h1>${body}${button ? `<form method="post" action="/rescan${escapeHtmlText(tenantQuery('?'))}"><input type="hidden" name="g" value="${escapeHtmlText(grant)}"><button type="submit">Rescan now</button></form>` : ''}<p><small>CxMissionZero</small></p></main></body></html>`;

function rescanPageFor(report, grant, token, note = '') {
  const s = windowState(report);
  const intro = note ? `<p>${escapeHtmlText(note)}</p>` : '';
  if (grant.round !== (report.round ?? 1)) return rescanPage(report.name, `${intro}<p>That round is over. A newer report is on its way.</p>`);
  if (s.state === 'ready') {
    return rescanPage(`${report.name}: rescan your fixes`, `${intro}<p>Every finding in scope has been dealt with. Rescan now to prove the fixes work: Checkmarx One scans the same repository, branch and engines again, and you get the result.</p><p>You have until <strong>${escapeHtmlText(new Date(s.dueAt).toUTCString())}</strong> (${s.hoursLeft} hour${s.hoursLeft === 1 ? '' : 's'} left)${s.onBehalf ? '. After that it is rescanned on your behalf' : ''}.</p>`, { grant: token, button: true });
  }
  if (s.state === 'scanning') return rescanPage(`${report.name}: rescanning`, `${intro}<p>The rescan is running${s.startedBy ? `, started by ${escapeHtmlText(s.startedBy)}` : s.automatic ? ', started on your behalf' : ''}. You will get the result by email.</p>`);
  if (s.state === 'zero') return rescanPage(`${report.name}: verified at zero`, `${intro}<p>The rescan found nothing left in scope. Every fix worked.</p>`);
  if (s.state === 'verified') return rescanPage(`${report.name}: rescanned`, `${intro}<p>${s.result.fixed} fixed, ${s.result.stillFound} still found. The updated report has been sent to you.</p>`);
  return rescanPage(report.name, `${intro}<p>Not every finding in scope is dealt with yet${s.open ? ` (${s.open} left)` : ''}: triage or fix the rest from your report first.</p>`);
}

app.get('/rescan', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const token = String(req.query.g ?? '');
  const { report, grant, error } = rescanFromGrant(token);
  if (error) return res.status(403).type('html').send(rescanPage('Rescan', `<p>${escapeHtmlText(error)}</p>`));
  res.type('html').send(rescanPageFor(report, grant, token));
});

app.post(
  '/rescan',
  express.urlencoded({ extended: false, limit: '4kb' }),
  asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const token = String(req.body?.g ?? '');
    const { report, grant, error } = rescanFromGrant(token);
    if (error) return res.status(403).type('html').send(rescanPage('Rescan', `<p>${escapeHtmlText(error)}</p>`));
    const started = grant.round === (report.round ?? 1) ? await rescanByDeveloper(report, grant.email) : { status: 409 };
    res.status(started.status === 200 ? 200 : started.status).type('html').send(rescanPageFor(report, grant, token, started.status === 200 ? 'Rescan started. Thank you.' : started.error ?? ''));
  }),
);

/**
 * The next round: the round so far is kept in the report's history, and a new
 * baseline is taken from the findings Checkmarx One reports now (after the
 * rescan), with a new scope, e.g. medium and low once critical and high are at zero.
 */
app.post(
  '/api/tracked-reports/:id/next-round',
  requirePermission('reports.manage'),
  asyncRoute(async (req, res) => {
    const report = trackedReports.get(req.params.id);
    if (!report) return res.status(404).json({ error: 'No such report.' });
    if (report.verification && !report.verification.finishedAt && report.verification.projects.some((e) => e.status !== 'waiting' && !TERMINAL.has(e.status))) {
      return res.status(409).json({ error: 'Wait for the verification scans to finish first.' });
    }
    const severities = (Array.isArray(req.body?.severities) ? req.body.severities : []).map((x) => String(x).toUpperCase()).filter((x) => SEVERITIES.includes(x));
    const buckets = (Array.isArray(req.body?.buckets) ? req.body.buckets : []).map(String).filter((b) => AGE_BUCKETS.some((a) => a.id === b));
    if (!severities.length) return res.status(400).json({ error: 'Choose the severities for the next round.' });
    const session = req.session?.client ? req.session : await resolveAutomationSession();
    if (!session) return res.status(409).json({ error: 'Connect to Checkmarx One first.' });
    const byProject = await currentFindings(session, report.projects);
    const filters = { ...report.filters, severities, buckets };
    let detection = null;
    try {
      detection = resolveWindow(filters.detection, 'First detection');
    } catch {}
    const findings = [];
    for (const [, risks] of byProject) {
      for (const r of risks) if (matchesFilters(r, filters, detection) && outcomeOf(r) !== 'notExploitable') findings.push(r);
    }
    const round = report.round ?? 1;
    const latest = report.latest ?? {};
    report.rounds = [
      ...(report.rounds ?? []),
      {
        round,
        severities: report.filters.severities,
        buckets: report.filters.buckets,
        startedAt: report.roundStartedAt ?? report.createdAt,
        endedAt: new Date().toISOString(),
        baseline: report.baseline.findings.length,
        outcomes: latest.outcomes ?? null,
        verification: report.verification
          ? { requestedAt: report.verification.requestedAt, automatic: report.verification.automatic, result: report.verification.result ? { ...report.verification.result, stillFound: report.verification.result.stillFound.slice(0, 50) } : null }
          : null,
      },
    ].slice(-50);
    report.round = round + 1;
    report.roundStartedAt = new Date().toISOString();
    report.filters = filters;
    report.baseline = {
      at: report.roundStartedAt,
      findings: findings.map((r) => ({ projectId: r.projectId, riskId: r.riskId, severity: r.severity, state: r.state, title: r.title, scanner: r.scanner })),
    };
    report.verification = null;
    trackedReports.record(report, progressFor(report, byProject));
    audit.record({
      type: 'verification',
      outcome: 'changed',
      reason: `"${report.name}" moved to round ${report.round}: ${severities.join(', ').toLowerCase()} (${findings.length} findings in scope).`,
      actor: { kind: 'user', user: req.user?.email ?? '' },
      details: { reportId: report.id, round: report.round, severities, buckets, baseline: findings.length },
    });
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
  const list = allocations.list();
  res.json({
    ...creditLedger.summary(month),
    months: [...new Set([monthOf(), ...creditLedger.months()])],
    enabled: Boolean(aiTriage?.enabled),
    remediationEnabled: Boolean(aiTriage?.remediationEnabled),
    monthlyCreditLimit: aiTriage?.monthlyCreditLimit ?? 0,
    remaining: month === monthOf() ? creditsRemaining() : null,
    pool: creditPool(undefined, list),
    allocations: list,
    relayConnected: Boolean(sessions.get(tstate.automationSessionId) ?? sessions.get(tstate.bootstrapSessionId) ?? settingsStore.get().automationApiKey),
  });
});

/**
 * Take credits back, from the Credit Control page: what the projects were given
 * and have not used (nor have in flight) goes back to the credit pool. Works on
 * every project with an allocation, without loading findings first: `all: true`
 * is the clean slate, `projectIds` a few projects. Used credits stay counted.
 */
app.post('/api/credits/reclaim', requirePermission('credits.allocate'), asyncRoute(async (req, res) => {
  const known = allocations.list();
  const wanted = req.body?.all === true ? null : new Set((Array.isArray(req.body?.projectIds) ? req.body.projectIds : []).map(String));
  if (wanted && !wanted.size) return res.status(400).json({ error: 'Choose the projects, or take back from all of them.' });
  const projects = known.filter((p) => !wanted || wanted.has(p.projectId));
  const actor = await adminActor(req);
  const total = { triage: 0, remediation: 0, projects: 0 };
  for (const p of projects) {
    const before = allocationSnapshot(p.projectId);
    const back = allocations.reclaimUnused(p.projectId);
    const n = back.triage + back.remediation;
    if (!n) continue;
    total.triage += back.triage;
    total.remediation += back.remediation;
    total.projects += 1;
    auditAllocation({ actor, projectId: p.projectId, projectName: p.projectName, before, change: { reclaimed: back }, reason: `Took back ${n} unused credit${n === 1 ? '' : 's'} (${[back.triage && `${back.triage} triage`, back.remediation && `${back.remediation} remediation`].filter(Boolean).join(', ')}) to the credit pool${wanted ? '' : ' (clean slate: every project)'}.` });
  }
  allocations.save();
  // Projects loaded on this person's Dashboard show the new balances.
  for (const p of req.session.lastScan?.projects ?? []) if (allocations.get(p.projectId)) p.credits = creditView(p);
  res.json({ reclaimed: total.triage + total.remediation, ...total, pool: creditPool(), allocations: allocations.list() });
}));

/**
 * The projects credits can be given to from the Credit Control page: every
 * Checkmarx One project, with those that already hold an allocation. Kept for
 * five minutes per session; no findings are read.
 */
async function givableProjects(req, { refresh = false } = {}) {
  const cached = req.session.givableProjects;
  if (cached && !refresh && Date.now() - cached.at < 5 * 60_000) return cached;
  const byId = new Map(allocations.list().map((p) => [p.projectId, { projectId: p.projectId, projectName: p.projectName || p.projectId, allocated: true }]));
  let warning = null;
  if (req.session.client) {
    try {
      for (const p of await listProjects(req.session.client)) {
        const known = byId.get(p.id);
        byId.set(p.id, { projectId: p.id, projectName: p.name || known?.projectName || p.id, allocated: Boolean(known) });
      }
    } catch (error) {
      warning = `The Checkmarx One project list could not be read (${error.message}): only projects that already hold credits are listed.`;
    }
  } else {
    warning = 'Not connected to Checkmarx One: only projects that already hold credits are listed.';
  }
  const result = { at: Date.now(), projects: [...byId.values()].sort((a, b) => a.projectName.localeCompare(b.projectName)), warning };
  if (!warning) req.session.givableProjects = result;
  return result;
}

app.get('/api/credits/projects', requirePermission('credits.allocate'), asyncRoute(async (req, res) => {
  const { projects, warning } = await givableProjects(req, { refresh: req.query.refresh === '1' });
  res.json({ projects, warning });
}));

const GIVE_MAX = 100_000;

/**
 * Give credits from the Credit Control page: extra AI Triage and AI Remediation
 * credits for one project, out of the credit pool, without loading findings
 * first (giving exactly what the findings need stays on the Dashboard, which
 * confirms it with Checkmarx One). Recorded in the audit log like any allocation.
 */
app.post('/api/credits/give', requirePermission('credits.allocate'), asyncRoute(async (req, res) => {
  const projectId = String(req.body?.projectId ?? '').trim().slice(0, 200);
  if (!projectId) return res.status(400).json({ error: 'Choose a project.' });
  const amount = (kind) => {
    const value = Number(req.body?.[kind] ?? 0);
    return Number.isInteger(value) && value >= 0 && value <= GIVE_MAX ? value : NaN;
  };
  const triage = amount('triage');
  const remediation = amount('remediation');
  if (Number.isNaN(triage) || Number.isNaN(remediation)) return res.status(400).json({ error: `Credits must be whole numbers, not negative, and no more than ${GIVE_MAX} at a time.` });
  if (!triage && !remediation) return res.status(400).json({ error: 'Give at least one AI Triage or AI Remediation credit.' });

  // The project must be one Checkmarx One knows, or one that already holds credits.
  const loaded = req.session.lastScan?.projects?.find((p) => p.projectId === projectId && !p.error);
  let projectName = allocations.get(projectId)?.projectName || loaded?.projectName || '';
  if (!projectName && !allocations.get(projectId)) {
    const { projects } = await givableProjects(req);
    projectName = projects.find((p) => p.projectId === projectId)?.projectName ?? '';
    if (!projectName) return res.status(404).json({ error: 'No such project in Checkmarx One.' });
  }

  const actor = await adminActor(req);
  const pool = creditPool();
  const given = triage + remediation;
  if (pool.limited && given > pool.unallocated) {
    const reason = `Only ${pool.unallocated} credit${pool.unallocated === 1 ? '' : 's'} left in the credit pool to give (pool ${pool.size}${pool.period === 'month' ? ' this month' : ''}, ${pool.used.total} used, ${pool.outstanding.total} given to projects and not used yet); ${given} asked for.`;
    audit.record({ type: 'allocation', outcome: 'refused', reason, actor, project: { id: projectId, name: projectName }, credits: { kind: 'allocation', requested: given, charged: 0 }, details: { pool, from: 'credit-control' } });
    return res.status(409).json({ error: `${reason} Raise the pool under Settings → AI & credits.`, pool });
  }

  const before = allocationSnapshot(projectId);
  if (triage) allocations.add(projectId, projectName, 'triage', triage);
  if (remediation) allocations.add(projectId, projectName, 'remediation', remediation);
  allocations.save();
  const parts = [triage && `${triage} AI Triage`, remediation && `${remediation} AI Remediation`].filter(Boolean).join(' and ');
  auditAllocation({ actor, projectId, projectName, before, change: { addTriage: triage, addRemediation: remediation }, reason: `Gave ${parts} credit${given === 1 ? '' : 's'} on the Credit Control page.` });
  if (loaded) loaded.credits = creditView(loaded);
  if (req.session.givableProjects) {
    const listed = req.session.givableProjects.projects.find((p) => p.projectId === projectId);
    if (listed) listed.allocated = true;
  }
  res.json({ given, triage, remediation, projectId, projectName, credits: loaded?.credits ?? null, pool: creditPool(), allocations: allocations.list() });
}));

/**
 * Spend the credits from the Credit Control page: AI Triage (or AI Remediation
 * of confirmed findings) for the chosen severities of projects that hold
 * credits, read fresh from Checkmarx One. No Dashboard fetch needed.
 */
app.post('/api/credits/run', requirePermission('triage.run'), afterFetch, asyncRoute(async (req, res) => {
  const kind = req.body?.kind === 'remediation' ? 'remediation' : req.body?.kind === 'triage' ? 'triage' : '';
  if (!kind) return res.status(400).json({ error: 'Choose triage or remediation.' });
  const wanted = cleanSeverities(req.body?.severities);
  if (!wanted.length) return res.status(400).json({ error: `Pick at least one severity to ${kind === 'triage' ? 'triage' : 'remediate'}.` });
  if (!req.session.client) return res.status(409).json({ error: 'Connect to Checkmarx One first.' });
  const chosen = new Set(idList(req.body?.projectIds));
  const projects = allocations.list().filter((p) => !chosen.size || chosen.has(p.projectId)).map((p) => ({ projectId: p.projectId, projectName: p.projectName || p.projectId }));
  if (!projects.length) return res.status(400).json({ error: 'Give credits to a project first.' });

  const settings = settingsStore.get();
  const byProject = await currentFindings(req.session, projects);
  const initiators = await collectInitiators(
    req.session.client,
    req.session.connection,
    projects.map((p) => ({ id: p.projectId, name: p.projectName })),
    { rules: settings.initiators, useDirectory: settings.initiators.useDirectory, concurrency: config.concurrency, memory: knownAddresses, attributed: creditFor },
  );
  const scan = { projects: projects.map((p) => ({ ...p, risks: byProject.get(p.projectId) ?? [] })), initiators: initiators.byProject };
  const where = `Credit Control: ${kind === 'triage' ? 'triage' : 'remediate confirmed'} ${wanted.map((s) => s.toLowerCase()).join(', ')}`;
  let summary;
  if (kind === 'remediation') {
    summary = await remediateConfirmed(req, scan, wanted, where);
  } else {
    const findings = scan.projects.flatMap((p) => triageRows(p.risks, wanted).map((r) => ({ ...r, projectId: p.projectId, projectName: p.projectName })));
    if (!findings.length) {
      summary = { requested: 0, started: 0, failed: 0, skipped: 0, errors: [] };
    } else {
      const actor = await adminActor(req);
      const { startedFindings, ...outcome } = await adminTriage(req.session, findings, scan.initiators, { actor, origin: where });
      const notified = req.body?.notifyInitiators === false ? null : await notifyOnBehalf(req.session, 'triage', startedFindings, scan.initiators, actor);
      summary = { ...outcome, notified };
    }
  }
  // Projects loaded on this person's Dashboard show the new balances.
  for (const p of req.session.lastScan?.projects ?? []) if (allocations.get(p.projectId)) p.credits = creditView(p);
  res.json({ ...summary, pool: creditPool(), allocations: allocations.list() });
}));

/**
 * The credits of the projects loaded on this person's Dashboard, worked out
 * again: after credits are given or taken back on another page.
 */
app.get('/api/credits/views', requirePermission('credits.view'), (req, res) => {
  const projects = (req.session.lastScan?.projects ?? []).filter((p) => !p.error);
  for (const p of projects) p.credits = creditView(p);
  res.json({ projects: Object.fromEntries(projects.map((p) => [p.projectId, p.credits])) });
});

// ---------------------------------------------------------------------------
// Impact: what AI Triage and AI Remediation did for the backlog (src/impact.js)
// ---------------------------------------------------------------------------

const IMPACT_DAYS = ['30', '90', '365', 'all'];

/** The Impact figures for the last `days` days ('all': since the first reading), or for [from, to). */
function impactFor({ days = '90', from = null, to = null } = {}, now = new Date()) {
  const start = from ?? (days === 'all' ? '0000-01-01T00:00:00.000Z' : new Date(now.getTime() - Number(days) * 86_400_000).toISOString());
  return computeImpact({
    journal: findingJournal.entries(),
    ledger: creditLedger.entriesBetween('0000', '9999'),
    settings: settingsStore.get().impact,
    from: start,
    to,
    now,
  });
}

const impactPeriodLabel = (days) => (days === 'all' ? 'since the first reading' : `last ${days} days`);

app.get('/api/impact', requirePermission('reports.view'), (req, res) => {
  const days = IMPACT_DAYS.includes(String(req.query.days)) ? String(req.query.days) : '90';
  const { monthlyTo } = settingsStore.get().impact;
  res.json({ ...impactFor({ days }), days, monthlyTo: can(req, 'settings.ai') ? monthlyTo : undefined, monthlyOn: monthlyTo.length > 0, lastSent: automationState.impactSent || null });
});

/** One page for leadership: download it, then print or save it as PDF from the browser. */
app.get('/api/impact/summary.html', requirePermission('reports.view'), (req, res) => {
  const days = IMPACT_DAYS.includes(String(req.query.days)) ? String(req.query.days) : '90';
  const settings = settingsStore.get();
  const { html } = impactSummary(impactFor({ days }), { appName: brandingNow(settings.branding)?.appName || 'CxMissionZero', periodLabel: impactPeriodLabel(days) });
  res.set('Content-Disposition', `attachment; filename="impact-${new Date().toISOString().slice(0, 10)}.html"`);
  res.type('html').send(html);
});

/** The previous calendar month (UTC): its first day and the first day of this month. */
function lastMonth(now = new Date()) {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { month: from.toISOString().slice(0, 7), from: from.toISOString(), to: to.toISOString() };
}

/** Email last month's summary to Settings → Impact's list (or `to`). Returns who it went to. */
async function sendImpactSummary({ to = null, actor = { kind: 'system' } } = {}) {
  const settings = sendingSettings();
  const recipients = to ?? settings.impact.monthlyTo;
  if (!recipients.length) throw Object.assign(new Error('Add who gets the monthly summary first.'), { status: 400 });
  const period = lastMonth();
  const url = resolveReportServer(null, settings).url;
  const message = impactSummary(impactFor({ from: period.from, to: period.to }), {
    appName: settings.branding?.appName || 'CxMissionZero',
    periodLabel: period.month,
    email: true,
    pageUrl: url ? `${url.replace(/\/$/, '')}/#/impact` : '',
  });
  await sendReminderMail(settings, message, { to: recipients, cc: [], bcc: [], exact: true });
  audit.record({ type: 'settings', outcome: 'changed', reason: `Impact summary for ${period.month} emailed to ${recipients.length} address${recipients.length === 1 ? '' : 'es'}.`, actor, details: { impact: { month: period.month, to: recipients.length } } });
  return { month: period.month, to: recipients };
}

app.post('/api/impact/email', requirePermission('settings.ai'), asyncRoute(async (req, res) => {
  const result = await sendImpactSummary({ actor: await adminActor(req) });
  res.json({ sent: true, ...result });
}));

// ---------------------------------------------------------------------------
// Get help: support cases and enhancements (src/support.js)
// ---------------------------------------------------------------------------

/** The team that answers requests raised in a tenant: active people with support.manage who work in it (a Super Admin works in every one). */
function supportTeamOf(tenant) {
  return iam.users()
    .map((u) => iam.user(u.id))
    .filter((u) => u && !u.disabled && u.email && permissionsFor(u).has('support.manage') && tenantsOf(u).includes(tenant));
}

/** May this person see the request: the one who raised it, or the team of its tenant. */
const seesRequest = (req, ticket) => ticket.requester.id === req.user.id || (can(req, 'support.manage') && tenantsOf(req.user, req.permissions).includes(ticket.tenant));

function requestView(req, ticket, { full = false } = {}) {
  const view = {
    id: ticket.id,
    kind: ticket.kind,
    subject: ticket.subject,
    status: ticket.status,
    priority: ticket.priority,
    requester: { name: ticket.requester.name, email: ticket.requester.email },
    mine: ticket.requester.id === req.user.id,
    tenant: tenancy.enabled ? tenantName(ticket.tenant) : '',
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    messages: ticket.messages.length,
  };
  if (!full) return view;
  return {
    ...view,
    conversation: ticket.messages.map((m) => ({ at: m.at, name: m.by.name || m.by.email, team: m.team, mine: m.by.id === req.user.id, text: m.text })),
    history: ticket.history.map((h) => ({ at: h.at, name: h.by.name || h.by.email, status: h.status })),
  };
}

/**
 * Email about a request, through the mail server of the tenant it was raised in.
 * The person who raised it hears of every answer and status change; the team, of
 * every new request and every answer from that person. Never fails the request:
 * the reply says what could not be sent.
 */
async function mailSupport(req, ticket, event, { fromTeam = false, message = null } = {}) {
  const tenant = tenancy.has(ticket.tenant) ? ticket.tenant : DEFAULT_TENANT;
  return tenancy.run(tenant, async () => {
    const settings = sendingSettings();
    const url = resolveReportServer(req, settings).url;
    // Support is between this person and the team: the organisation's name, never a demonstration's.
    const appName = settingsStore.get().branding?.appName || 'CxMissionZero';
    const self = String(req.user.email ?? '').toLowerCase();
    const jobs = [];
    if (event !== 'message' || fromTeam) {
      if (ticket.requester.email && (event === 'created' || ticket.requester.email.toLowerCase() !== self)) jobs.push(['requester', [ticket.requester.email]]);
    }
    if (!fromTeam && event !== 'status') {
      const team = [...new Set(supportTeamOf(ticket.tenant).map((u) => u.email).filter((e) => e.toLowerCase() !== self))];
      if (team.length) jobs.push(['team', team]);
    }
    const result = { sent: 0, error: '' };
    for (const [to, addresses] of jobs) {
      try {
        await sendReminderMail(settings, supportEmail(ticket, { event, to, appName, url, message }), { to: addresses, cc: [], bcc: [], exact: true });
        result.sent += addresses.length;
      } catch (error) {
        result.error = error.message;
      }
    }
    return result;
  });
}

app.get('/api/support', requireSession, (req, res) => {
  const team = can(req, 'support.manage');
  const visible = supportDesk.list().filter((t) => seesRequest(req, t));
  res.json({ team, statuses: SUPPORT_STATUSES, requests: visible.map((t) => requestView(req, t)) });
});

app.get('/api/support/:id', requireSession, (req, res) => {
  const ticket = supportDesk.get(req.params.id);
  if (!ticket || !seesRequest(req, ticket)) return res.status(404).json({ error: 'No such request, or it is not yours to see.' });
  res.json({ team: can(req, 'support.manage'), request: requestView(req, ticket, { full: true }) });
});

app.post('/api/support', requireSession, asyncRoute(async (req, res) => {
  const kind = req.body?.kind;
  if (!SUPPORT_KINDS[kind]) return res.status(400).json({ error: 'Choose a support case or an enhancement.' });
  const channel = supportChannel(settingsStore.get());
  if (channel.mode === 'email') return res.status(409).json({ error: `Requests go by email here: write to ${channel.email}.`, email: channel.email });
  if (supportDesk.raisedSince(req.user.id, new Date(Date.now() - 3_600_000).toISOString()) >= 20) {
    return res.status(429).json({ error: 'You raised 20 requests in the last hour. Add to one of them instead, or try again later.' });
  }
  const ticket = supportDesk.create({
    kind,
    tenant: req.tenantId ?? DEFAULT_TENANT,
    subject: req.body?.subject,
    text: req.body?.text,
    priority: req.body?.priority,
    requester: { id: req.user.id, name: req.user.name, email: req.user.email },
  });
  const emailed = await mailSupport(req, ticket, 'created');
  res.status(201).json({ request: requestView(req, ticket, { full: true }), emailed });
}));

app.post('/api/support/:id/messages', requireSession, asyncRoute(async (req, res) => {
  const ticket = supportDesk.get(req.params.id);
  if (!ticket || !seesRequest(req, ticket)) return res.status(404).json({ error: 'No such request, or it is not yours to see.' });
  // Someone who both raised it and is on the team answers as the person who raised it.
  const fromTeam = ticket.requester.id !== req.user.id;
  supportDesk.reply(ticket.id, { by: { id: req.user.id, name: req.user.name, email: req.user.email }, team: fromTeam, text: req.body?.text });
  const emailed = await mailSupport(req, ticket, 'message', { fromTeam, message: ticket.messages.at(-1).text });
  res.json({ request: requestView(req, ticket, { full: true }), emailed });
}));

app.post('/api/support/:id/status', requirePermission('support.manage'), asyncRoute(async (req, res) => {
  const ticket = supportDesk.get(req.params.id);
  if (!ticket || !seesRequest(req, ticket)) return res.status(404).json({ error: 'No such request, or it is not yours to see.' });
  const before = ticket.status;
  supportDesk.setStatus(ticket.id, String(req.body?.status ?? ''), { by: { id: req.user.id, name: req.user.name, email: req.user.email } });
  const emailed = ticket.status === before ? { sent: 0, error: '' } : await mailSupport(req, ticket, 'status', { fromTeam: true });
  res.json({ request: requestView(req, ticket, { full: true }), emailed });
}));

// ---------------------------------------------------------------------------
// Hands-off mode and self-healing (src/hands-off.js, src/watchdog.js): set up
// once with the wizard, then MissionZero runs, reports, takes requests by email
// and looks after itself, so nobody has to sign in.
// ---------------------------------------------------------------------------

/** Who a case MissionZero raises by itself goes to: the administrators forward it there. */
const MAINTAINER_EMAIL = process.env.MAINTAINER_EMAIL?.trim() || 'bhawani.singh@checkmarx.com';
const WATCHDOG_MS = Math.max(5, Number(process.env.WATCHDOG_EVERY_SECONDS) || 300) * 1000;
const INBOX_MS = Math.max(5, Number(process.env.INBOX_EVERY_SECONDS) || 120) * 1000;
const ERRORS_PER_15_MIN = 30;
const watchdog = new Watchdog({ file: path.join(dataDir, 'watchdog.json') });

/** The administrators of a tenant: who hears about problems, and may close the cases MissionZero raises. */
function administratorsOf(tenant) {
  return iam.users().filter((u) => {
    if (u.disabled) return false;
    const held = permissionsFor(iam.user(u.id));
    return (held.has('system.update') || held.has('integration.cxone') || held.has('integration.smtp')) && tenantsOf(iam.user(u.id), held).includes(tenant);
  }).map((u) => u.email.toLowerCase());
}

/** Who may steer hands-off mode from an email: the status list and the administrators. */
const ownersOf = (tenant, settings = settingsStore.get()) => [...new Set([...(settings.handsOff?.statusTo ?? []), ...administratorsOf(tenant)])];

const appNameNow = () => settingsStore.get().branding?.appName || 'CxMissionZero';
const serverUrl = () => resolveReportServer(null, settingsStore.get()).url?.replace(/\/$/, '') || '';
/** A one-click link (in the current tenant), or '' when the server's address is not known. */
function actionUrl(a, email, r = '') {
  const base = serverUrl();
  return base ? `${base}/a/${signAction((text) => reportGrants.macText(text), { a, e: email, t: tenancy.current().id, r })}` : '';
}
const button = (label, a, email, r = '') => {
  const url = actionUrl(a, email, r);
  return url ? [{ label, url }] : [];
};

/** Send one of MissionZero's own emails, in the current tenant; never throws. */
async function sendSystemMail(to, message, { attachments = [] } = {}) {
  const addresses = [...new Set(to.filter(Boolean))];
  if (!addresses.length) return { sent: 0, error: 'Nobody to send it to.' };
  try {
    await sendReminderMail(sendingSettings(), message, { to: addresses, cc: [], bcc: [], exact: true, ...(attachments.length ? { attachments } : {}) });
    return { sent: addresses.length, error: '' };
  } catch (error) {
    diagnostics.error('system-mail', error);
    return { sent: 0, error: error.message };
  }
}

/** One person's copy of a system email: their own links, and their own reply reference. */
const personal = (email, build) => build(email, replyReference((text) => reportGrants.macText(text), email));

/** What the weekly status says: the last 7 days, and how MissionZero is doing. */
function statusFacts() {
  const settings = settingsStore.get();
  const week = impactFor({ days: '7' });
  const since = Date.now() - 7 * 86_400_000;
  const runs = (scheduler.status.runs ?? []).filter((r) => Date.parse(r.at) >= since && !r.skipped);
  const sent = runs.reduce((n, r) => n + (r.sent ?? 0), 0);
  const failedRuns = runs.filter((r) => !r.ok).length;
  const open = watchdog.problems().filter((p) => !p.tenant || p.tenant === tenancy.current().id);
  return [
    ['Reminders sent', `${sent} in ${runs.length} run${runs.length === 1 ? '' : 's'}${failedRuns ? ` (${failedRuns} with errors)` : ''}`],
    ['Fixed this week', `${week.aiFixed + week.manualFixed} (${week.aiFixed} with AI)`],
    ['Shown not exploitable by AI', String(week.noiseRemoved)],
    ['Security debt', `${week.debt.now}${week.debt.change !== null ? ` (${week.debt.change > 0 ? '+' : ''}${week.debt.change}% this week)` : ''}${week.debt.zeroBy ? `, zero by ${week.debt.zeroBy.slice(0, 10)} at this pace` : ''}`],
    ['Next reminder run', settings.automation.enabled ? (isPaused(settings.handsOff) ? `paused until ${settings.handsOff.pausedUntil.slice(0, 16).replace('T', ' ')} UTC` : (scheduler.status.nextRunAt ?? '').slice(0, 16).replace('T', ' ') + ' UTC') : 'automatic reminders are off'],
    ['Health', open.length ? open.map((p) => p.title).join('; ') : 'all checks pass'],
  ];
}

/** Email the weekly status to `to` (each gets their own links). Returns how many went out. */
async function sendStatus(to) {
  const settings = settingsStore.get();
  const facts = statusFacts();
  const paused = isPaused(settings.handsOff);
  let sent = 0;
  for (const email of to) {
    const message = personal(email, (e, reference) => systemEmail({
      appName: appNameNow(),
      subject: `${appNameNow()} this week`,
      lines: [paused ? 'MissionZero is paused: no reminders go out until it is resumed.' : 'MissionZero ran on its own this week. Here is where things stand.'],
      facts,
      buttons: [
        ...button('Send the reminders now', 'run', e),
        ...(paused ? button('Resume', 'resume', e) : button('Pause for 7 days', 'pause', e)),
        ...button('Stop sending me this', 'stop', e),
      ],
      reference,
    }));
    sent += (await sendSystemMail([email], message)).sent;
  }
  return sent;
}

/** The weekly status of every tenant whose day and hour have come. */
async function statusTick(now = new Date()) {
  for (const id of tenancy.ids()) {
    await tenancy.run(id, async () => {
      const handsOff = settingsStore.get().handsOff;
      if (!statusDue(handsOff, now) || !isVerified(sendingSettings())) return;
      settingsStore.save({ handsOff: { lastStatusAt: now.toISOString() } });
      await sendStatus(handsOff.statusTo);
    });
  }
}

/**
 * Do what a link or a reply asks, for `email`, in the current tenant. Returns the
 * sentence that says what happened (shown on the page, or emailed back).
 */
async function performHandsOff({ command, days = 7, ref = '' }, email) {
  const tenant = tenancy.current().id;
  const settings = settingsStore.get();
  const owners = ownersOf(tenant, settings);
  const allowed = command === 'stop' ? settings.handsOff.statusTo.includes(email) || owners.includes(email) : command === 'solved' ? administratorsOf(tenant).includes(email) : owners.includes(email);
  if (!allowed) throw Object.assign(new Error(command === 'solved' ? 'Only an administrator can close this case.' : 'This address may no longer steer MissionZero. Ask an administrator.'), { status: 403 });
  const actor = { kind: 'user', user: email, via: 'email' };
  let said;
  if (command === 'pause') {
    const until = new Date(Date.now() + days * 86_400_000).toISOString();
    settingsStore.save({ handsOff: { pausedUntil: until } });
    said = `Paused: no reminders and no status until ${until.slice(0, 10)}. Resume at any time.`;
  } else if (command === 'resume') {
    settingsStore.save({ handsOff: { pausedUntil: '' } });
    said = 'Resumed: reminders go out on their schedule again.';
  } else if (command === 'run') {
    presenter.exit(() => scheduler.tick({ force: true })).catch((error) => diagnostics.error('hands-off-run', error));
    said = 'The reminders that are due are on their way.';
  } else if (command === 'status') {
    await sendStatus([email]);
    said = 'The status is on its way to you.';
  } else if (command === 'stop') {
    settingsStore.save({ handsOff: { statusTo: settings.handsOff.statusTo.filter((a) => a !== email) } });
    said = 'You will not get the weekly status any more.';
  } else if (command === 'solved') {
    const ticket = supportDesk.get(ref);
    if (!ticket || ticket.tenant !== tenant) throw Object.assign(new Error('No such case.'), { status: 404 });
    if (!['completed', 'declined'].includes(ticket.status)) supportDesk.setStatus(ticket.id, 'completed', { by: { id: '', name: email, email } });
    watchdog.forgetCase(ticket.id);
    said = `${ticket.id} is closed. Thank you.`;
  } else {
    throw Object.assign(new Error('MissionZero does not know that request.'), { status: 400 });
  }
  audit.record({ type: 'settings', outcome: 'changed', reason: `Hands-off: ${email} asked by email to ${command}${command === 'pause' ? ` for ${days} days` : ''}${ref ? ` (${ref})` : ''}. ${said}`, actor });
  return said;
}

const ACTION_TITLES = {
  pause: 'Pause MissionZero for 7 days?',
  resume: 'Resume MissionZero?',
  run: 'Send the reminders that are due now?',
  status: 'Email me the status now?',
  stop: 'Stop sending me the weekly status?',
  solved: 'Mark this case as solved?',
};

/** The page a link opens: one button, so a mail scanner that opens links never acts. */
function actionPage(title, message, { confirm = '' } = {}) {
  const page = linkPage(title, message);
  return confirm ? page.replace('</main>', `<form method="post" style="margin-top:18px"><button type="submit" style="font:inherit;padding:10px 18px;border:0;border-radius:10px;background:#4f46e5;color:#fff;font-weight:600;cursor:pointer">${escapeHtml(confirm)}</button></form></main>`) : page;
}

/** A link's token, checked in its own tenant: { tenant, payload } or null. */
function linkAction(token) {
  const tenant = peekTenant(token) || DEFAULT_TENANT;
  if (!tenancy.has(tenant)) return null;
  const payload = tenancy.run(tenant, () => readAction((text) => reportGrants.macText(text), token));
  return payload ? { tenant, payload } : null;
}

app.get('/a/:token', (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  const found = linkAction(req.params.token);
  if (!found) return res.status(404).send(actionPage('This link has expired', 'Links in MissionZero emails work for 30 days. The next email has fresh ones.'));
  const { a, e, r } = found.payload;
  res.send(tenancy.run(found.tenant, () => actionPage(ACTION_TITLES[a], `${r ? `${r}. ` : ''}For ${e}.`, { confirm: 'Yes, do it' })));
});

app.post('/a/:token', asyncRoute(async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  const found = linkAction(req.params.token);
  if (!found) return res.status(404).send(actionPage('This link has expired', 'Links in MissionZero emails work for 30 days. The next email has fresh ones.'));
  const { a, e, r } = found.payload;
  try {
    const said = await tenancy.run(found.tenant, () => performHandsOff({ command: a, ref: r }, e));
    res.send(tenancy.run(found.tenant, () => actionPage('Done', said)));
  } catch (error) {
    res.status(error.status ?? 500).send(actionPage('Not done', error.message));
  }
}));

/** Tenants whose mailbox could not be read, and how many times in a row (the self-check reports 3). */
const inboxFailures = new Map();

/** Replies to MissionZero's emails: one word each, from the address the email went to. */
async function inboxTick() {
  for (const id of tenancy.ids()) {
    await tenancy.run(id, async () => {
      const settings = sendingSettings();
      const { handsOff, smtp } = settings;
      if (!handsOff.on || !handsOff.replies || !isVerified(settings) || !smtp.user) return;
      let messages;
      try {
        messages = await readReplies({ host: handsOff.imapHost || smtp.host, port: handsOff.imapPort, secure: handsOff.imapPort === 993, user: smtp.user, password: smtp.password, rejectUnauthorized: smtp.rejectUnauthorized });
        inboxFailures.delete(id);
      } catch (error) {
        diagnostics.error('inbox', error);
        const failed = inboxFailures.get(id) ?? { count: 0 };
        inboxFailures.set(id, { count: failed.count + 1, error: error.message });
        return;
      }
      for (const message of messages) await handleReply(message).catch((error) => diagnostics.error('inbox-reply', error));
    });
  }
}

/** One reply, in its tenant: act on it only when it answers an email sent to that very address. */
async function handleReply({ from, subject, text }) {
  const settings = settingsStore.get();
  const own = String(settings.smtp.fromAddress ?? '').toLowerCase();
  // Never answer ourselves, an auto-reply or a bounce: that is how mail loops start.
  if (!from || from === own || /auto(matic)?[ -]?(reply|response)|out of (the )?office|undeliverable|delivery status|mailer-daemon/i.test(`${subject} ${from}`)) return;
  const expected = replyReference((t) => reportGrants.macText(t), from);
  if (!findReferences(`${subject}\n${text}`).includes(expected)) return;
  const asked = parseCommand(text);
  if (!asked) return;
  const ref = /\b(SUP-\d{4,})\b/.exec(subject)?.[1] ?? '';
  let said;
  try {
    said = await performHandsOff({ ...asked, ref }, from);
  } catch (error) {
    said = `Not done: ${error.message}`;
  }
  const reply = systemEmail({ appName: appNameNow(), subject: `Re: ${String(subject).replace(/^(re:\s*)+/i, '').slice(0, 150)}`, lines: [said], reference: '', replyHelp: false });
  await sendSystemMail([from], reply);
}

// ---- Self-check: look, repair, tell -------------------------------------------------------

/** What is wrong in the current tenant now: [{ key, title, detail, tenant }]. */
async function tenantProblems() {
  const id = tenancy.current().id;
  const settings = settingsStore.get();
  const found = [];
  if (settings.automationApiKey || (id === DEFAULT_TENANT && config.bootstrapApiKey)) {
    const session = integrationSession() ?? (await resolveAutomationSession().catch(() => null));
    if (!session) found.push({ key: `cxone:${id}`, title: 'Checkmarx One connection', detail: 'The server cannot sign in to Checkmarx One with its key.', tenant: id });
    else {
      // One small question to Checkmarx One: a session that exists is not one that works.
      try {
        await withTimeout(session.client.request('/api/projects', { query: { limit: 1 }, retries: 1, background: true }), 'Checkmarx One');
      } catch (error) {
        found.push({ key: `cxone:${id}`, title: 'Checkmarx One connection', detail: error.message, tenant: id });
      }
    }
  }
  if (settings.smtp.host && isVerified(sendingSettings())) {
    try {
      await withTimeout(testConnection(sendingSettings().smtp), 'The mail server');
    } catch (error) {
      found.push({ key: `smtp:${id}`, title: 'Email server', detail: error.message, tenant: id });
    }
  }
  const inbox = inboxFailures.get(id);
  if (settings.handsOff.on && settings.handsOff.replies && inbox?.count >= 3) found.push({ key: `inbox:${id}`, title: 'Reading replies', detail: inbox.error, tenant: id });
  if (settings.automation.enabled) {
    const runs = (scheduler.status.runs ?? []).filter((r) => !r.skipped).slice(0, 2);
    if (runs.length === 2 && runs.every((r) => !r.ok)) found.push({ key: `automation:${id}`, title: 'Automatic reminders', detail: runs[0].error || runs[0].failures?.[0]?.error || 'The last two runs failed.', tenant: id });
  }
  return found;
}

/** What is wrong with the server itself. */
function serverProblems() {
  const found = [];
  const errors = diagnostics.recentErrors(15 * 60_000);
  if (errors > ERRORS_PER_15_MIN) found.push({ key: 'errors', title: 'Errors on the server', detail: `${errors} errors in the last 15 minutes.`, tenant: '' });
  // Close to its memory limit, a server is about to die: worth a backup while it still can.
  const heap = v8.getHeapStatistics();
  if (heap.used_heap_size > 0.9 * heap.heap_size_limit) found.push({ key: 'memory', title: 'Memory', detail: `${Math.round(heap.used_heap_size / 1048576)} of ${Math.round(heap.heap_size_limit / 1048576)} MB in use.`, tenant: '' });
  return found;
}

/** Try to put one problem right (each repair once while it lasts). True when it is fixed. */
async function repair(problem) {
  if (problem.key === 'memory' && !watchdog.hasTried('memory', 'Backed up the data in case it stops')) {
    const backup = await backupToFolder(SYSTEM_ACTOR, 'Low memory').catch(() => null);
    watchdog.tried('memory', 'Backed up the data in case it stops', backup?.ok ? 'done' : 'failed');
    return false;
  }
  const [kind, ...rest] = problem.key.split(':');
  const tenant = rest.join(':');
  if (!tenant || !tenancy.has(tenant)) return false;
  return tenancy.run(tenant, async () => {
    const recheck = async () => !(await tenantProblems()).some((p) => p.key === problem.key);
    const attempt = async (name, fn) => {
      if (watchdog.hasTried(problem.key, name)) return false;
      try {
        await fn();
      } catch {}
      const fixed = await recheck();
      watchdog.tried(problem.key, name, fixed ? 'fixed' : 'did not help');
      return fixed;
    };
    if (kind === 'cxone' || kind === 'smtp') {
      // A changed connection that does not work: back to the last one that did.
      if ((kind === 'cxone' ? cxonePending() : smtpPending()) && (await attempt('Put back the last working connection', () => checkConnections({ rollback: true, trigger: 'self-check' })))) return true;
    }
    if (kind === 'cxone' || kind === 'automation') {
      return attempt('Signed in to Checkmarx One again', async () => {
        if (tstate.automationSessionId && tstate.automationSessionId !== tstate.bootstrapSessionId) sessions.destroy(tstate.automationSessionId);
        tstate.automationSessionId = null;
        tstate.integrationFailure = { fingerprint: null, until: 0 };
        if (!(await resolveAutomationSession()) && tenant === DEFAULT_TENANT && config.bootstrapApiKey) await bootstrap();
      });
    }
    if (kind === 'smtp') return attempt('Tried the mail server again after a pause', () => new Promise((r) => setTimeout(r, 10_000)));
    return false;
  });
}

/** Email the administrators of a problem's tenant (the first tenant's for the server's own). */
async function tellAdministrators(problem, build, options) {
  const tenant = problem.tenant && tenancy.has(problem.tenant) ? problem.tenant : DEFAULT_TENANT;
  return tenancy.run(tenant, async () => {
    let sent = 0;
    for (const email of administratorsOf(tenant)) sent += (await sendSystemMail([email], personal(email, build), options)).sent;
    return sent;
  });
}

const problemFacts = (p) => [
  ['Problem', `${p.title}: ${p.detail}`],
  ['Since', `${p.since.slice(0, 16).replace('T', ' ')} UTC`],
  ['Tried', p.tried?.length ? p.tried.join('; ') : 'nothing could be tried yet'],
  ...(p.tenant && tenancy.enabled ? [['Tenant', tenantName(p.tenant)]] : []),
  ['Version', `MZ-${PACKAGE_VERSION}`],
];

/** Raise a support case for a problem MissionZero could not fix, and ask an administrator to forward it. */
async function raiseCase(problem) {
  const tenant = problem.tenant && tenancy.has(problem.tenant) ? problem.tenant : DEFAULT_TENANT;
  const report = diagnostics.report({ extra: { selfCheck: { problem: { title: problem.title, detail: problem.detail, since: problem.since, tried: problem.tried }, events: watchdog.events(30) } } });
  const ticket = supportDesk.create({
    kind: 'case',
    tenant,
    subject: `[Automatic] ${problem.title}`,
    text: [`MissionZero raised this case by itself: it could not fix the problem on its own.`, '', ...problemFacts(problem).map(([k, v]) => `${k}: ${v}`), '', `Forward the email about it to ${MAINTAINER_EMAIL}.`].join('\n'),
    priority: 'high',
    requester: { id: 'system', name: 'MissionZero (automatic)', email: '' },
  });
  watchdog.markCase(problem.key, ticket.id);
  watchdog.event('case', `${ticket.id} raised for ${problem.title}.`, { key: problem.key, tenant });
  audit.record({ type: 'system', outcome: 'changed', reason: `Self-check raised ${ticket.id}: ${problem.title} (${problem.detail}).`, actor: SYSTEM_ACTOR });
  const base = serverUrl();
  await tellAdministrators(problem, (email, reference) => systemEmail({
    appName: appNameNow(),
    subject: `[${ticket.id}] MissionZero needs the maintainer: ${problem.title}`,
    lines: [
      `MissionZero could not fix this on its own, so it raised support case ${ticket.id}.`,
      `Please forward this email, with its attachment, to ${MAINTAINER_EMAIL}. MissionZero never sends anything outside your network by itself.`,
      'The attachment is the troubleshooting log: no personal data, keys or findings.',
    ],
    facts: problemFacts(problem),
    buttons: [...button('Mark as solved', 'solved', email, ticket.id), ...(base ? [{ label: `Open ${ticket.id}`, url: `${base}/#/help/${ticket.id}` }] : [])],
    reference,
    replyHelp: false,
    footer: `When it is solved, reply SOLVED to this email, or use the button. ${ticket.id} then closes.`,
  }), { attachments: [{ filename: `mission-zero-${ticket.id}-troubleshooting.json`, content: JSON.stringify(report, null, 2), contentType: 'application/json' }] });
  return ticket;
}

let selfChecking = false;
/** One self-check: look at everything, repair what can be repaired, tell who needs to know. */
async function selfCheck() {
  if (selfChecking) return { skipped: true };
  selfChecking = true;
  try {
    const found = [];
    for (const id of tenancy.ids()) found.push(...(await tenancy.run(id, () => tenantProblems().catch((error) => [{ key: `check:${id}`, title: 'Self-check', detail: error.message, tenant: id }]))));
    found.push(...serverProblems());
    const { recovered } = watchdog.record(found, { version: PACKAGE_VERSION });

    for (const p of watchdog.problems()) {
      if (await repair(p).catch(() => false)) {
        watchdog.resolve(p.key);
        audit.record({ type: 'system', outcome: 'changed', reason: `Self-check fixed it: ${p.title} (${p.detail}).`, actor: SYSTEM_ACTOR });
        if (p.notifiedAt) await tellAdministrators(p, (email, reference) => systemEmail({ appName: appNameNow(), subject: `MissionZero fixed itself: ${p.title}`, lines: ['MissionZero found a problem and put it right on its own. Nothing is needed from you.'], facts: problemFacts(p), reference, replyHelp: false }));
      }
    }

    const update = updates.settings();
    const lastCheck = updates.lastCheck;
    const online = Boolean(lastCheck && !lastCheck.error && Date.now() - Date.parse(lastCheck.at) < 2 * 86_400_000);
    for (const p of watchdog.problems()) {
      if (shouldNotify(p)) {
        watchdog.markNotified(p.key);
        await tellAdministrators(p, (email, reference) => systemEmail({
          appName: appNameNow(),
          subject: `MissionZero needs attention: ${p.title}`,
          lines: ['MissionZero found a problem it could not fix on its own yet. It keeps checking every few minutes and will tell you when it works again.', ...(update.auto && online ? ['If it lasts, MissionZero raises a support case by itself and asks you to forward it.'] : [])],
          facts: problemFacts(p),
          reference,
          replyHelp: false,
        }));
      }
      if (shouldRaiseCase(p, { autoUpdate: update.auto, online })) await raiseCase(p);
    }

    for (const p of recovered) {
      if (p.caseId) supportDesk.reply(p.caseId, { by: { id: 'system', name: 'MissionZero (automatic)', email: '' }, team: true, text: `Working again since ${p.recoveredAt.slice(0, 16).replace('T', ' ')} UTC. Close the case once you are happy.` });
      if (p.notifiedAt) await tellAdministrators(p, (email, reference) => systemEmail({ appName: appNameNow(), subject: `MissionZero is working again: ${p.title}`, lines: ['The problem MissionZero told you about has cleared.'], facts: problemFacts(p), buttons: p.caseId ? button('Mark as solved', 'solved', email, p.caseId) : [], reference, replyHelp: false }));
    }

    // A version that came in less than a day ago and broke what worked: back to the one before it.
    const events = updateStore.events(50);
    // The launcher's record of this version coming in: a switch to it, and its first start.
    const switched = events.find((e) => e.type !== 'rollback' && e.type !== 'restart' && e.from && e.from !== PACKAGE_VERSION && (e.to === PACKAGE_VERSION || (e.type === 'started' && e.version === PACKAGE_VERSION)));
    const target = rollbackTarget({
      problems: watchdog.problems(),
      running: PACKAGE_VERSION,
      previous: switched?.from ?? '',
      switchedAt: switched?.at ?? '',
      wasHealthy: (v) => watchdog.wasHealthy(v),
      hasRolledBack: (v) => watchdog.hasRolledBack(v),
    });
    if (target && updates.supervised) {
      watchdog.markRolledBack(PACKAGE_VERSION);
      watchdog.event('rollback', `MZ-${PACKAGE_VERSION} put back to MZ-${target}: it broke what worked before.`);
      audit.record({ type: 'system', outcome: 'changed', reason: `Self-check: MZ-${PACKAGE_VERSION} broke what worked before; going back to MZ-${target}.`, actor: SYSTEM_ACTOR });
      await tellAdministrators({ tenant: DEFAULT_TENANT }, (email, reference) => systemEmail({ appName: appNameNow(), subject: `MissionZero went back to MZ-${target}`, lines: [`MZ-${PACKAGE_VERSION} came in less than a day ago and broke what worked before, so MissionZero is going back to MZ-${target}. It will not install MZ-${PACKAGE_VERSION} again by itself.`], facts: watchdog.problems().map((p) => ['Problem', `${p.title}: ${p.detail}`]), reference, replyHelp: false }));
      await updates.switch(target, { by: 'self-check' }).catch((error) => watchdog.event('tried', `Going back to MZ-${target} failed: ${error.message}`));
    }
    return { problems: watchdog.problems() };
  } finally {
    selfChecking = false;
  }
}

/** The self-check as the Hands-off page shows it. */
const healthView = () => ({ lastCheckAt: watchdog.state.lastCheckAt, everyMinutes: Math.round(WATCHDOG_MS / 60_000), problems: watchdog.problems(), events: watchdog.events(20), maintainer: MAINTAINER_EMAIL });

{
  const loop = (fn, every, first) => {
    const run = () => fn().catch((error) => diagnostics.error('background', error));
    setTimeout(() => {
      run();
      setInterval(run, every).unref();
    }, first).unref();
  };
  loop(selfCheck, WATCHDOG_MS, Math.min(60_000, WATCHDOG_MS));
  loop(statusTick, 5 * 60_000, 30_000);
  loop(inboxTick, INBOX_MS, Math.min(30_000, INBOX_MS));
}

// Never die quietly: record what escaped, and keep serving (under the launcher, start afresh).
process.on('unhandledRejection', (error) => {
  diagnostics.error('unhandled-rejection', error);
  console.warn(`! Unhandled rejection: ${logSafe(error?.message ?? String(error))}`);
});
process.on('uncaughtException', (error) => {
  diagnostics.error('uncaught-exception', error);
  diagnostics.flush();
  console.error(`! Uncaught exception: ${logSafe(error?.stack ?? error?.message ?? String(error))}`);
  // Under the launcher a crash restarts the server: back up and tell the administrators first.
  if (updates.supervised) lastWords(`it crashed: ${String(error?.message ?? error).slice(0, 200)}`, Date.now() + 8000).finally(() => process.exit(1));
});

app.get('/api/hands-off', requirePermission('settings.view', 'settings.automation'), (req, res) => {
  const settings = settingsStore.get();
  res.json({
    handsOff: settings.handsOff,
    automation: settings.automation,
    audience: audienceSetting(settings),
    monthlyTo: can(req, 'settings.ai') ? settings.impact.monthlyTo : undefined,
    canSave: can(req, 'settings.automation'),
    ready: { cxone: Boolean(integrationSession()), smtp: isVerified(sendingSettings()), serverUrl: Boolean(serverUrl()) },
    paused: isPaused(settings.handsOff),
    commands: COMMANDS,
    health: healthView(),
  });
});

/** The wizard's answers, saved in one go: what to do, which findings, who, when, and replies. */
app.put('/api/hands-off', requirePermission('settings.automation'), asyncRoute(async (req, res) => {
  const body = req.body ?? {};
  const before = settingsStore.get();
  const incoming = { handsOff: { ...(body.handsOff ?? {}), on: body.handsOff?.on !== false } };
  if (body.automation) incoming.automation = body.automation;
  if (['initiator', 'list', 'both'].includes(body.audience)) incoming.reminders = { audience: body.audience };
  if ('monthlyTo' in body && can(req, 'settings.ai')) incoming.impact = { monthlyTo: body.monthlyTo };
  settingsStore.save(incoming);
  await resolveAutomationSession();
  scheduler.sync();
  const after = settingsStore.get();
  audit.record({ type: 'settings', outcome: 'changed', reason: `Hands-off mode ${after.handsOff.on ? (before.handsOff.on ? 'changed' : 'turned on') : 'turned off'}: reminders ${after.automation.enabled ? 'on' : 'off'}, status to ${after.handsOff.statusTo.length} people, replies ${after.handsOff.replies ? 'read' : 'not read'}.`, actor: await adminActor(req), details: { handsOff: after.handsOff, automation: after.automation } });
  res.json({ handsOff: after.handsOff, automation: after.automation, audience: audienceSetting(after), health: healthView() });
}));

app.post('/api/hands-off/status', requirePermission('settings.automation'), asyncRoute(async (req, res) => {
  const to = settingsStore.get().handsOff.statusTo;
  if (!to.length) return res.status(400).json({ error: 'Add who gets the weekly status first.' });
  if (!isVerified(sendingSettings())) return res.status(409).json({ error: 'Set up and test the email server first (Settings → Email server).' });
  res.json({ sent: await sendStatus(to) });
}));

app.post('/api/hands-off/check', requirePermission('settings.automation', 'system.update'), asyncRoute(async (req, res) => {
  await selfCheck();
  res.json({ health: healthView() });
}));

/** Once a month, after the 1st's early hours (UTC): last month's summary, when someone is on the list. */
async function monthlyImpact(now = new Date()) {
  const settings = settingsStore.get();
  if (!settings.impact.monthlyTo.length || !terms.organisation()) return;
  const { month } = lastMonth(now);
  if (automationState.impactSent >= month || now.getUTCHours() < 6) return;
  automationState.impactSent = month; // once, even if the mail server refuses (the audit log says so)
  await sendImpactSummary().catch((error) => {
    console.warn(`[impact] Monthly summary for ${month} not sent: ${error.message}`);
    audit.record({ type: 'settings', outcome: 'failed', reason: `Impact summary for ${month} could not be emailed: ${error.message}`, actor: { kind: 'system' }, details: { impact: { month } } });
  });
}

/** The credit pool now: size, used (triage / remediation), left, given to projects, free to give. */
function creditPool(settings = settingsStore.get(), list = allocations.list()) {
  const period = poolPeriod(settings);
  return poolSummary({
    size: settings.aiTriage?.monthlyCreditLimit ?? 0,
    period,
    used: creditLedger.usedInPeriod(period),
    reserved: creditLedger.reserved,
    allocations: list,
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
    pool: creditPool(undefined, list),
    allocations: projectId ? list.filter((p) => p.projectId === projectId) : list,
    projects: list.map((p) => ({ projectId: p.projectId, projectName: p.projectName })),
  });
});

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
  return {
    buckets: list(scope.buckets, (b) => AGE_BUCKETS.some((a) => a.id === b) || b === 'unknown'),
    severities: list((scope.severities ?? []).map?.((v) => String(v).toUpperCase()) ?? [], (v) => PROJECT_REPORT_SEVERITIES.has(v)),
    detection: { from: iso(detection.from), to: iso(detection.to) },
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
    const lastScans = await getLastScans(session.client, [projectId]).catch(() => ({}));
    const detectionWindow = scope.detection.from || scope.detection.to
      ? { from: scope.detection.from ? new Date(scope.detection.from) : null, to: scope.detection.to ? new Date(scope.detection.to) : null }
      : null;
    const [read, initiators] = await Promise.all([
      collectProjectRisks(session.client, activeConfig(), [project], {
        detectionWindow,
        shared: { identity: readerIdentity(session), lastScans },
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
    if (summary?.error) return res.status(502).json({ error: `Could not read ${projectName || 'the project'} from Checkmarx One: ${summary.error}` });
    if (summary) summary.url = projectUrl(summary, session.connection, settings.links);
    const risks = selectRisks(read.projects, { buckets: scope.buckets, severities: scope.severities.length ? scope.severities : null });
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
  const scanIdOf = (finding) => initiatorsByProject[finding.projectId]?.scanId ?? '';
  // Each scan's results are read once, for the AI ids and for the code locations.
  const resultsCache = new Map();
  await resolveAiIds(session.client, [...findings, ...bulkFindings], scanIdOf, resultsCache);
  // Where each shown finding is in its repository: the report's "Open in IDE" and "Apply fix in my workspace".
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
  const html = generateHtmlReport(reportData, {
    findings,
    bulkFindings,
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
    allowRetriage: Boolean(settings.aiTriage?.allowRetriage),
    allowReremediation: Boolean(settings.aiTriage?.allowReremediation),
    adminContact: adminContact(settings),
    repositories,
    // "One project's report" buttons: this server builds it, within the same scope.
    projectReportScope: projectReportScope(scope ?? { buckets }),
    signProjectReport: (projectId) => {
      const name = reportData.projects.find((p) => String(p.projectId) === projectId)?.projectName ?? '';
      const exp = Date.now() + PROJECT_REPORT_TTL_MS;
      return { exp, sig: projectReportSignature(projectId, name, exp, projectReportScope(scope ?? { buckets })) };
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
      return res.status(409).json({ error: 'Load findings on the Dashboard first.' });
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
      scope: { buckets, severities, detection: lastScan.detectionWindow },
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
      scope: { buckets, severities, detection: scan.detectionWindow },
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
    if (!req.session.lastScan) return res.status(409).json({ error: 'Load findings on the Dashboard first.' });
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
    return res.send([JSON.stringify({ notice: SUPPORTING_NOTICE }), ...entries.map((e) => JSON.stringify(e))].join('\n') + '\n');
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.send([csvCell(`Notice: ${SUPPORTING_NOTICE}`), CSV_COLUMNS.map(([name]) => name).join(','), ...entries.map((e) => CSV_COLUMNS.map(([, get]) => csvCell(get(e))).join(','))].join('\n') + '\n');
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
/** The largest backup that is attached to an email (most mail servers refuse much more). */
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

/** Everything written to disk first, so the backup is a consistent picture. */
async function settleState() {
  knownAddresses.flush();
  creditLedger.flush();
  findingJournal.flush();
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
    mailBackupCopy(file, summary, trigger).catch(() => {});
  } catch (error) {
    lastBackup = { at: new Date().toISOString(), ok: false, error: error.message, trigger };
    audit.record({ type: 'backup', outcome: 'failed', reason: `${trigger} backup to ${backupConfig.dir} failed: ${error.message}`, actor });
    console.error(`! [backup] ${error.message}`);
  }
  return lastBackup;
}

/**
 * A copy of a backup to the backup mailbox (BACKUP_EMAIL), so a new server can bring it back
 * by itself. Encrypted backups only (BACKUP_PASSPHRASE): never one that holds the passwords
 * and keys in the clear. Returns whether it went.
 */
async function mailBackupCopy(file, summary, trigger) {
  if (!backupMailbox.email) return false;
  if (!summary.encrypted) {
    console.warn('! [backup] BACKUP_EMAIL is set, but backups are not encrypted: set BACKUP_PASSPHRASE to email them.');
    return false;
  }
  if (summary.size > MAX_ATTACHMENT_BYTES) {
    audit.record({ type: 'backup', outcome: 'failed', reason: `${trigger} backup not emailed to ${backupMailbox.email}: ${Math.round(summary.size / 1048576)} MB is too large to attach.`, actor: SYSTEM_ACTOR });
    return false;
  }
  return tenancy.run(DEFAULT_TENANT, async () => {
    if (!isVerified(sendingSettings())) return false;
    const name = path.basename(file);
    const result = await sendSystemMail([backupMailbox.email], {
      ...systemEmail({
        appName: appNameNow(),
        subject: `${BACKUP_SUBJECT} ${summary.createdAt.slice(0, 16).replace('T', ' ')} UTC`,
        lines: [
          `${trigger} backup of MissionZero, encrypted with BACKUP_PASSPHRASE: ${name}.`,
          'Keep this email. A new MissionZero started with BACKUP_EMAIL, BACKUP_EMAIL_PASSWORD and the same BACKUP_PASSPHRASE finds the newest backup here and restores it by itself.',
        ],
        facts: [['Files', String(summary.files)], ['Size', `${Math.max(1, Math.round(summary.size / 1024))} KB`], ['Version', `MZ-${PACKAGE_VERSION}`]],
        replyHelp: false,
      }),
      subject: `${BACKUP_SUBJECT} ${summary.createdAt.slice(0, 16).replace('T', ' ')} UTC`,
    }, { attachments: [{ filename: name, content: fs.readFileSync(file), contentType: 'application/octet-stream' }] });
    if (result.sent) audit.record({ type: 'backup', outcome: 'info', reason: `${trigger} backup emailed to ${backupMailbox.email} (${name}).`, actor: SYSTEM_ACTOR });
    return result.sent > 0;
  });
}

if (backupConfig.intervalHours > 0) {
  const every = backupConfig.intervalHours * 3600_000;
  // First one soon after start (a fresh baseline), then on the interval.
  setTimeout(() => {
    backupToFolder(SYSTEM_ACTOR, 'Scheduled');
    setInterval(() => backupToFolder(SYSTEM_ACTOR, 'Scheduled'), every).unref();
  }, 60_000).unref();
}

// ---------------------------------------------------------------------------
// Settings → Update & recovery (Admin): new versions, rollback, restart, troubleshooting
// ---------------------------------------------------------------------------

const updateStore = new VersionStore({
  dataDir,
  builtInDir: process.env.MZ_BUILTIN_DIR || projectDir,
  builtInVersion: process.env.MZ_BUILTIN_VERSION || PACKAGE_VERSION,
});
const updates = new UpdateService({
  store: updateStore,
  runningVersion: PACKAGE_VERSION,
  image: process.env.UPDATE_IMAGE?.trim() || DEFAULT_IMAGE,
  token: process.env.UPDATE_REGISTRY_TOKEN?.trim() || '',
  supervised: process.env.MZ_SUPERVISOR === '1' && typeof process.send === 'function',
  record: ({ outcome, reason, by, details }) =>
    audit.record({ type: 'system', outcome, reason, actor: by && by !== 'auto-update' ? { kind: 'user', user: by } : SYSTEM_ACTOR, details }),
  beforeSwitch: (version) => backupToFolder(SYSTEM_ACTOR, `Before switching to ${version === 'built-in' ? 'the image’s own version' : `MZ-${version}`}`),
  // A stop this server asked for (an update, a version switch, a restart): planned, so no "it stopped" email.
  switchTo: (message) => {
    plannedStop = true;
    process.send?.(message);
  },
});
// Auto-update (off until an Admin turns it on): a first look a minute after start (an update
// restarts the server, and a restart must not push the next look 15 minutes away), then every
// 15 minutes; it installs in its hour. AUTO_UPDATE_EVERY_SECONDS changes the pace (tests).
{
  const autoUpdate = () => updates.autoUpdate().catch((error) => console.warn(`[update] auto-update: ${logSafe(error.message)}`));
  const every = Math.max(5, Number(process.env.AUTO_UPDATE_EVERY_SECONDS) || 900) * 1000;
  setTimeout(() => {
    autoUpdate();
    setInterval(autoUpdate, every).unref();
  }, Math.min(60_000, every)).unref();
}

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

// ---------------------------------------------------------------------------
// Beta features, and making them final (src/features.js)
// ---------------------------------------------------------------------------

/** Every Beta feature, its stage, and whether this person may use it and change it. */
app.get('/api/features', requireSession, (req, res) => {
  const settings = settingsStore.get();
  res.json({
    features: featureList(settings).map((f) => ({ ...f, canUse: mayUse(settings, f.id, req.permissions) })),
    canManage: can(req, 'features.manage'),
  });
});

/** The Admin's switch: a feature becomes final for everyone (or goes back to Beta). Audited. */
app.put('/api/features/:id', requirePermission('features.manage'), (req, res) => {
  const feature = featureById(req.params.id);
  if (!feature) return res.status(404).json({ error: 'No such feature.' });
  const stage = req.body?.stage === 'final' ? 'final' : req.body?.stage === 'beta' ? 'beta' : '';
  if (!stage) return res.status(400).json({ error: 'The stage must be "beta" or "final".' });
  const before = isFinal(settingsStore.get(), feature.id) ? 'final' : 'beta';
  if (before !== stage) {
    settingsStore.save({ features: { [feature.id]: { stage, at: new Date().toISOString(), by: req.user?.email ?? '' } } });
    audit.record({
      type: 'system',
      outcome: 'changed',
      reason: stage === 'final' ? `“${feature.name}” made final: no longer Beta, for everyone holding its permission.` : `“${feature.name}” put back in Beta.`,
      actor: { kind: 'user', user: req.user?.email ?? '' },
      details: { feature: feature.id, from: before, to: stage },
    });
    scheduler.sync();
  }
  const settings = settingsStore.get();
  res.json({ features: featureList(settings).map((f) => ({ ...f, canUse: mayUse(settings, f.id, req.permissions) })), canManage: true });
});

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
    lastBackup,
    relay: { ...relayStats },
    timeZone: serverTimeZone(),
  };
  audit.record({ type: 'system', outcome: 'info', reason: 'Troubleshooting report downloaded.', actor: { kind: 'user', user: req.user?.email ?? '' } });
  res.set('Content-Disposition', `attachment; filename="cxmissionzero-report-${report.generatedAt.slice(0, 10)}.json"`);
  res.json(report);
});

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
  express.raw({ type: () => true, limit: '200mb' }),
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
function githubConfig(settings = settingsStore.get(), source = process.env) {
  const github = settings.beta?.github ?? {};
  const env = (name) => String(source[name] ?? '').trim();
  const defaultApi = !github.apiUrl || github.apiUrl === 'https://api.github.com';
  const apiUrl = defaultApi && env('GITHUB_API_URL') ? env('GITHUB_API_URL').replace(/\/+$/, '') : github.apiUrl || 'https://api.github.com';
  // GITHUB_TOKEN goes only to the host GITHUB_API_URL names (else api.github.com):
  // pointing the API address elsewhere on the Beta page never sends it there.
  const envToken = env('GITHUB_TOKEN') && hostOfUrl(apiUrl) === (hostOfUrl(env('GITHUB_API_URL')) || 'api.github.com') ? env('GITHUB_TOKEN') : '';
  return {
    ...github,
    token: github.token || envToken,
    tokenSource: github.token ? 'settings' : envToken ? 'environment' : 'none',
    apiUrl,
    org: github.org || env('GITHUB_ORG'),
  };
}

/**
 * The hosts repositories are cloned from: the public GitHub, GitLab, Bitbucket and Azure DevOps,
 * the hosts connected on the Beta page or in the environment, and SCM_ALLOWED_HOSTS. A
 * repository address from a project or a setting never makes the server call anything else.
 */
const PUBLIC_SCM_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org', 'dev.azure.com'];
function cloneHostAllowed(host) {
  const name = String(host ?? '').toLowerCase();
  if (PUBLIC_SCM_HOSTS.includes(name) || name.endsWith('.visualstudio.com')) return true;
  const settings = settingsStore.get();
  const scm = scmConfigs(settings);
  const hostname = (value) => String(value ?? '').toLowerCase().replace(/:\d+$/, '');
  const known = [gitHostOf(githubConfig(settings).apiUrl), scm.gitlab.host, scm.azure.host, scm.bitbucket.host, ...gitSets(settings).slice(1).flatMap((set) => set.hosts.map((h) => h.host))].map(hostname);
  const extra = String(process.env.SCM_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return known.includes(name) || extra.includes(name);
}
setCloneHostCheck(cloneHostAllowed);

/** GitLab, Azure DevOps and Bitbucket: their connections and API clients (built per use: settings may change). */
function scmHosts(settings = settingsStore.get()) {
  const configs = scmConfigs(settings);
  return { configs, clients: scmClients(configs) };
}

function githubClient(settings = settingsStore.get()) {
  const github = githubConfig(settings);
  return new GitHubClient({ token: github.token, apiUrl: github.apiUrl });
}

const urlPath = (url) => {
  try {
    return new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return [];
  }
};

/**
 * Every set of git connections: the first (Beta page, plain variables), then
 * the numbered ones (GITHUB_TOKEN_2 …, src/scm/instances.js). Each set: its
 * GitHub and other hosts' connections, and the hosts it holds a token for.
 */
function gitSets(settings = settingsStore.get()) {
  const describe = (n, github, scm, named) => {
    const owner = (value) => String(value ?? '').toLowerCase();
    const hosts = [];
    if (github.token) hosts.push({ provider: 'github', host: gitHostOf(github.apiUrl), owner: owner(github.org) });
    if (scm.gitlab.token) hosts.push({ provider: 'gitlab', host: scm.gitlab.host, owner: owner(scm.gitlab.group).split('/')[0] });
    if (scm.azure.token && scm.azure.host) hosts.push({ provider: 'azure', host: scm.azure.host, owner: owner(urlPath(scm.azure.orgUrl)[0]) });
    if (scm.bitbucket.token) hosts.push({ provider: 'bitbucket', host: scm.bitbucket.host, owner: owner(scm.bitbucket.workspace) });
    return { n, github, scm, hosts, named };
  };
  const sets = [describe(1, githubConfig(settings), scmConfigs(settings), null)];
  for (const n of extraInstanceNumbers(settings)) {
    const source = instanceSource(settings, n);
    sets.push(describe(n, githubConfig({}, source), scmConfigs({}, source), new Set(providersIn(source))));
  }
  return sets;
}

/**
 * The connections the header shows, green or red, with a few details:
 * Checkmarx One (the server's integration), the mail server (passed its test
 * with the current settings), and every git host (each token answers).
 */
async function connectionsStatus() {
  const settings = settingsStore.get();
  const cx = integrationStatus();
  const smtp = settings.smtp ?? {};
  const verified = isVerified(settings);
  const git = await gitConnections(settings);
  const gh = git.instances.find((i) => i.provider === 'github' && i.n === 1);
  return {
    cxone: {
      ok: cx.connected,
      tenant: cx.connection?.tenant ?? '',
      apiUrl: cx.connection?.baseUrl ?? '',
      iamUrl: cx.connection?.iamUrl ?? '',
      source: cx.source,
      pending: cx.pending,
      reason: cx.connected ? (cx.pending ? 'A changed connection is being checked; the last known good one is in use.' : '') : 'Not connected: an Admin connects it under Settings → Checkmarx One integration, or with CX_API_KEY.',
      help: (!cx.connected || cx.pending) ? tstate.connectionHelp?.cxone : undefined,
    },
    smtp: {
      ok: Boolean(smtp.host) && verified,
      host: smtp.host ?? '',
      port: smtp.port ?? null,
      tls: smtp.secure ? 'implicit TLS' : 'STARTTLS',
      from: smtp.fromAddress || smtp.user || '',
      verifiedAt: verified ? settings.verifiedAt ?? null : null,
      reason: !smtp.host ? 'No mail server: set it under Settings → Email server, or with SMTP_HOST in the .env file.' : verified ? '' : 'Not tested with these settings: Settings → Email server → Test connection.',
      help: verified ? undefined : tstate.connectionHelp?.smtp,
    },
    // Every git host and instance, for the header's Git chip (one logo each).
    git,
    // The first GitHub connection, as before (kept for callers of this shape).
    github: gh
      ? { ok: gh.ok, login: gh.who, apiUrl: gh.url, org: gh.owner, source: gh.source, checkedAt: gh.checkedAt, reason: gh.reason }
      : { ok: false, login: '', apiUrl: githubConfig(settings).apiUrl, org: '', source: 'none', checkedAt: null, reason: 'No GitHub token: add GITHUB_TOKEN to the .env file, or set it on the Beta page.' },
  };
}

/** Results of checking each git connection: at most every 5 minutes, and again when its settings change. */
const gitChecks = scoped(tenancy, 'gitChecks');
const GIT_CHECK_MS = 5 * 60_000;

/** Ask one host who its token belongs to. */
async function checkGitInstance(provider, set) {
  if (provider === 'github') {
    const user = await new GitHubClient({ token: set.github.token, apiUrl: set.github.apiUrl }).rest('/user');
    return user?.login ?? '';
  }
  const result = (await checkScmConnections(scmClients(set.scm), set.scm, [provider]))[provider];
  if (!result) throw new Error(provider === 'azure' ? 'set the organisation address (AZURE_DEVOPS_ORG_URL) too' : 'no answer');
  if (!result.ok) throw Object.assign(new Error(result.reason.replace(/^[^:]*refused: /, '')), { help: result.help });
  return result.who ?? '';
}

/**
 * Every git connection: GitHub, GitLab, Azure DevOps and Bitbucket, the first of
 * each and the numbered ones (GITHUB_TOKEN_2 …), each checked with its host.
 * Hosts with no connection are listed too, with what to add.
 */
async function gitConnections(settings = settingsStore.get()) {
  const instances = [];
  const checks = [];
  for (const set of gitSets(settings)) {
    for (const provider of SCM_PROVIDERS) {
      const cfg = provider === 'github' ? set.github : set.scm[provider];
      const token = cfg.token;
      // The first set lists a host once it has a token; a numbered set, once its variables name the host.
      if (!token && !(set.named?.has(provider))) continue;
      const url = provider === 'github' ? cfg.apiUrl : provider === 'azure' ? cfg.orgUrl : cfg.apiUrl;
      const owner = provider === 'github' ? cfg.org : provider === 'gitlab' ? cfg.group : provider === 'azure' ? urlPath(cfg.orgUrl)[0] ?? '' : cfg.workspace;
      const vars = INSTANCE_VARS[provider];
      const suffix = set.n === 1 ? '' : `_${set.n}`;
      const entry = { provider, n: set.n, label: SCM_LABELS[provider], url: url ?? '', host: url ? hostOfUrl(url) : '', owner: owner ?? '', source: set.n === 1 ? cfg.tokenSource : 'environment', variables: `${vars.token}${suffix}`, ok: false, who: '', checkedAt: null, reason: '' };
      instances.push(entry);
      if (!token) {
        entry.reason = `No token: add ${vars.token}${suffix} to the .env file.`;
        continue;
      }
      const key = createHash('sha256').update(`${provider}|${url}|${token}`).digest('hex');
      const cached = gitChecks.get(key);
      if (cached && Date.now() - cached.at < GIT_CHECK_MS) {
        Object.assign(entry, cached.result, { checkedAt: new Date(cached.at).toISOString() });
        continue;
      }
      checks.push(
        checkGitInstance(provider, set)
          .then((who) => ({ ok: true, who: String(who ?? ''), reason: '' }))
          .catch((error) => ({ ok: false, who: '', reason: `${SCM_LABELS[provider]} refused the token: ${error.message}`, help: error.help ?? explainGit(provider, error, { url, variable: entry.variables }) }))
          .then((result) => {
            const at = Date.now();
            gitChecks.set(key, { at, result });
            Object.assign(entry, result, { checkedAt: new Date(at).toISOString() });
          }),
      );
    }
  }
  await Promise.all(checks);
  // Grouped by host, so two GitHub connections sit side by side.
  instances.sort((a, b) => SCM_PROVIDERS.indexOf(a.provider) - SCM_PROVIDERS.indexOf(b.provider) || a.n - b.n);
  if (gitChecks.size > 64) for (const [key, value] of gitChecks) if (Date.now() - value.at > GIT_CHECK_MS) gitChecks.delete(key);
  const missing = SCM_PROVIDERS.filter((p) => !instances.some((i) => i.provider === p)).map((p) => ({ provider: p, label: SCM_LABELS[p], variables: INSTANCE_VARS[p].token }));
  const connected = instances.filter((i) => i.ok).length;
  return {
    ok: instances.length > 0 && connected === instances.length,
    connected,
    total: instances.length,
    instances,
    missing,
    reason: instances.length ? (connected === instances.length ? '' : `${instances.length - connected} of ${instances.length} git connection(s) not working.`) : 'No git host connected: add GITHUB_TOKEN, GITLAB_TOKEN, AZURE_DEVOPS_TOKEN or BITBUCKET_TOKEN to the .env file.',
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

app.get('/api/beta/github/logins', requireFeature('identityMatching'), (req, res) => {
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
  requireFeature('identityMatching'),
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
app.post('/api/beta/github/apply', requireFeature('identityMatching'), (req, res) => {
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

/**
 * Usernames → addresses on any host. GitHub keeps its own four methods (above); GitLab,
 * Azure DevOps and Bitbucket have theirs (src/scm). Scan initiators are offered for the
 * host their project's repository is on (all of them when that is not known).
 */
app.get('/api/beta/scm/logins', requireFeature('identityMatching'), (req, res) => {
  const provider = SCM_PROVIDERS.includes(req.query.provider) ? req.query.provider : 'github';
  const lastScan = req.session.lastScan;
  const settings = settingsStore.get();
  const configs = scmConfigs(settings);
  const projects = new Map((lastScan?.projects ?? []).map((p) => [p.projectId, p]));
  const out = new Map();
  for (const [projectId, info] of Object.entries(lastScan?.initiators ?? {})) {
    const name = String(info?.initiator ?? '').trim();
    if (!name || name.includes('@') || !validUsername(provider, name)) continue;
    const on = providerOf(parseRepoUrl(projects.get(projectId)?.repoUrl ?? ''), configs, githubConfig(settings).apiUrl);
    if (on && on !== provider) continue;
    const entry = out.get(name) ?? { login: name, unresolved: false, onHost: false };
    entry.unresolved ||= !info.email;
    entry.onHost ||= on === provider;
    out.set(name, entry);
  }
  res.json({ logins: [...out.values()] });
});

app.post(
  '/api/beta/scm/evaluate',
  requireFeature('identityMatching'),
  asyncRoute(async (req, res) => {
    const provider = String(req.body?.provider ?? '');
    if (!SCM_PROVIDERS.includes(provider) || provider === 'github') return res.status(400).json({ error: 'Choose GitLab, Azure DevOps or Bitbucket (GitHub has its own comparison).' });
    const settings = settingsStore.get();
    const logins = [...new Set((Array.isArray(req.body?.logins) ? req.body.logins : []).map((l) => String(l).trim()).filter((l) => validUsername(provider, l) || usableEmail(l)))].slice(0, 500);
    if (!logins.length) return res.status(400).json({ error: `No ${SCM_LABELS[provider]} usernames to match. Load the scan initiators, or type them in.` });
    const { configs, clients } = scmHosts(settings);
    const methods = methodsFor(provider, clients, configs, { localSources: settingsStore.get().beta?.github?.localRepos ?? [], cacheDir: gitCacheDir });
    const chosen = Array.isArray(req.body?.methods) && req.body.methods.length ? req.body.methods.map(String) : null;
    const report = await evaluateMethods({ methods, logins, client: clients[provider], chosen });
    // Usernames that are already addresses need no method.
    for (const [login, hit] of Object.entries(addressesAsThemselves(logins))) report.combined[login] ??= { ...hit, method: 'address' };
    report.resolved = Object.keys(report.combined).length;
    report.provider = provider;
    res.json(report);
  }),
);

app.post('/api/beta/scm/apply', requireFeature('identityMatching'), (req, res) => {
  const provider = SCM_PROVIDERS.includes(req.body?.provider) ? req.body.provider : 'github';
  const mappings = (Array.isArray(req.body?.mappings) ? req.body.mappings : [])
    .map((m) => ({ login: String(m?.login ?? '').trim(), email: String(m?.email ?? '').trim().toLowerCase() }))
    .filter((m) => validUsername(provider, m.login) && usableEmail(m.email));
  if (!mappings.length) return res.status(400).json({ error: 'Pick at least one match to use.' });
  const current = settingsStore.get().initiators;
  const overrides = { ...(current.overrides ?? {}) };
  for (const { login, email } of mappings) overrides[login] = email;
  const saved = settingsStore.save({ initiators: { ...current, overrides } });
  res.json({ applied: mappings.length, overrides: Object.keys(saved.initiators.overrides ?? {}).length });
});

/** Are the GitLab, Azure DevOps and Bitbucket tokens accepted? */
app.post(
  '/api/beta/scm/check',
  requirePermission('beta.use'),
  asyncRoute(async (req, res) => {
    const { configs, clients } = scmHosts();
    const only = SCM_PROVIDERS.includes(req.body?.provider) ? [req.body.provider] : SCM_PROVIDERS;
    const results = await checkScmConnections(clients, configs, only);
    for (const id of only) if (id !== 'github' && !results[id]) results[id] = { ok: false, reason: `No ${SCM_LABELS[id]} token set.` };
    res.json(results);
  }),
);

const AUTHOR_LIMIT_MAX = 300;

/**
 * Find who wrote the vulnerable code of the fetched findings: exact file and
 * line from the scan results, blame at the scanned commit, and the author's
 * real address (noreply addresses resolved through the identity methods).
 */
app.post(
  '/api/beta/authors/find',
  requireFeature('codeAuthors'),
  asyncRoute(async (req, res) => {
    const { lastScan, client, connection } = req.session;
    if (!lastScan) return res.status(409).json({ error: 'Load findings on the Dashboard first.' });
    const settings = settingsStore.get();
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

    const { items: result, summary } = await findCodeAuthors(risks, { client, connection, settings, projects: lastScan.projects, initiators: lastScan.initiators });
    req.session.lastAuthors = result;
    res.json({ items: result, summary });
  }),
);

/**
 * Who last changed the line of each finding (SAST and KICS), at the scanned commit, and
 * their real address: [{key, finding fields, location, commit, author: {name, login, email}}]
 * with a summary. Used by the Code authors page and by scheduled reminders.
 */
async function findCodeAuthors(risks, { client, connection, settings, projects: projectList, initiators = {} }) {
  const github = settings.beta?.github ?? {};
  const projects = new Map(projectList.map((p) => [p.projectId, p]));
  const scanIdOf = (f) => f.scanId || initiators?.[f.projectId]?.scanId || '';
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
  const hosts = scmHosts(settings);
  // Each repository is blamed with the connection that fits it: the first set, or a numbered one (GITHUB_TOKEN_2 …).
  const sets = gitSets(settings);
  const bySet = new Map(sets.map((set) => [set, []]));
  for (const item of items) bySet.get(setForRepo(sets, item.repo)).push(item);
  for (const [set, group] of bySet) {
    if (!group.length) continue;
    const first = set.n === 1;
    const setGh = first ? gh : new GitHubClient({ token: set.github.token, apiUrl: set.github.apiUrl });
    const setScm = first ? hosts : { configs: set.scm, clients: scmClients(set.scm) };
    await blameFindings(group, {
      gh: setGh,
      apiUrl: set.github.apiUrl,
      cacheDir: gitCacheDir,
      token: set.github.token,
      useGithub: settings.beta?.authors?.useGithubBlame !== false,
      useLocal: settings.beta?.authors?.useLocalBlame !== false,
      scm: setScm,
    });
    // Read-only extras: the file's code owners (CODEOWNERS), and the pull or merge request the
    // blamed commit came in through, with who approved it. Missing ones are simply left out.
    await addOwnership(group.filter((i) => i.blame), {
      github: (repo) => (setGh.hasToken && onGitHub(repo, set.github.apiUrl) ? setGh : null),
      gitlab: (repo) => (setScm.configs.gitlab?.token && repo.host === setScm.configs.gitlab.host ? setScm.clients.gitlab : null),
      // Only a clone git blame already made is read: never a new clone just for this.
      clone: (item) =>
        item.blame?.via === 'git blame' && item.repo?.cloneUrl
          ? ensureClone(item.repo.cloneUrl, {
              cacheDir: gitCacheDir,
              blobs: true,
              token: onGitHub(item.repo, set.github.apiUrl) ? set.github.token : '',
              authHeader: item.provider && item.provider !== 'github' ? cloneAuthFor(item.repo.cloneUrl, setScm.configs) : '',
            })
          : null,
    }).catch(() => {});
  }

  // Authors who hid their address behind GitHub's noreply one: resolve the
  // login, starting with the history of the repositories just cloned.
  const logins = new Set();
  for (const item of items) {
    if (!item.blame || (item.provider && item.provider !== 'github')) continue;
    const login = item.blame.login || loginFromNoreply(item.blame.authorEmail);
    if (login && !usableEmail(item.blame.authorEmail)) logins.add(login);
  }
  // On GitLab, Azure DevOps or Bitbucket: that host's own methods, cheapest first.
  const elsewhere = new Map(); // provider -> Set of usernames
  for (const item of items) {
    if (!item.blame || !item.provider || item.provider === 'github' || usableEmail(item.blame.authorEmail)) continue;
    const login = item.blame.login || loginFromNoreply(item.blame.authorEmail) || item.blame.authorName;
    if (!login) continue;
    if (!elsewhere.has(item.provider)) elsewhere.set(item.provider, new Set());
    elsewhere.get(item.provider).add(login);
  }
  const resolvedElsewhere = {};
  for (const [provider, names] of elsewhere) {
    const clones = [...new Set(items.filter((i) => i.provider === provider && i.repo).map((i) => i.repo.cloneUrl))];
    const methods = methodsFor(provider, hosts.clients, hosts.configs, { localSources: [...clones, ...(github.localRepos ?? [])], cacheDir: gitCacheDir });
    const found = await resolveWith(methods, [...names]);
    for (const [login, hit] of Object.entries(found)) resolvedElsewhere[`${provider}|${login}`] = hit;
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
      const onGithub = !item.provider || item.provider === 'github';
      const login = item.blame.login || loginFromNoreply(item.blame.authorEmail);
      const found = onGithub ? resolved[login] : resolvedElsewhere[`${item.provider}|${login || item.blame.authorName}`];
      const email = usableEmail(item.blame.authorEmail) ? item.blame.authorEmail : found?.email ?? '';
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
          emailVia: usableEmail(item.blame.authorEmail) ? 'commit' : found ? `${onGithub ? '' : `${SCM_LABELS[item.provider]}: `}${found.method}` : '',
        },
        host: SCM_LABELS[item.provider] ?? item.repo?.host ?? '',
        // How sure the answer is (src/github/blame.js, confidenceOf): only 'high' is emailed without someone choosing it.
        confidence: item.confidence?.level ?? 'low',
        confidenceReason: item.confidence?.reason ?? '',
        skippedBots: item.blame.skippedBots?.length ?? 0,
        owners: item.owners ?? null,
        change: item.change ?? null,
      });
      if (!email) out.problem = `Author ${item.blame.authorName || login} hides their email address and it could not be resolved.`;
    }
    return out;
  });

  const withEmail = result.filter((r) => r.author?.email);
  return {
    items: result,
    summary: {
      findings: result.length,
      blamed: result.filter((r) => r.commit).length,
      sure: result.filter((r) => r.commit && r.confidence === 'high').length,
      unsure: result.filter((r) => r.commit && r.confidence !== 'high').length,
      withEmail: withEmail.length,
      authors: new Set(withEmail.map((r) => r.author.email)).size,
      githubRequests: gh.totalRequests,
      hostRequests: Object.fromEntries(Object.entries(hosts.clients).filter(([, c]) => c?.totalRequests).map(([id, c]) => [id, c.totalRequests])),
    },
  };
}

const AUTOMATION_AUTHOR_LIMIT = 200;

/**
 * Scheduled reminders, the code authors' part: the developer who last changed the line of
 * each finding that just crossed a threshold gets one email with theirs. Only once "Code
 * authors" is final; the most severe first, up to 200 findings a run.
 */
async function notifyCodeAuthors(crossed, { client, connection, projects, initiators, dryRun }) {
  const settings = sendingSettings();
  if (!isFinal(settings, 'codeAuthors')) return { skipped: 'Code authors is still a Beta feature.' };
  const rank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const risks = crossed
    .filter((r) => LOCATABLE_SCANNERS.has(r.scanner))
    .sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || (b.ageDays ?? 0) - (a.ageDays ?? 0))
    .slice(0, AUTOMATION_AUTHOR_LIMIT);
  if (!risks.length) return { findings: 0, authors: 0, emailed: 0 };
  const { items } = await findCodeAuthors(risks, { client, connection, settings, projects, initiators });
  // Unattended: only answers git blame is sure of. An unsure one waits for someone to look at it.
  const byAuthor = new Map();
  for (const item of items) {
    if (!item.author?.email || item.confidence !== 'high') continue;
    if (!byAuthor.has(item.author.email)) byAuthor.set(item.author.email, { author: item.author, items: [] });
    byAuthor.get(item.author.email).items.push(item);
  }
  const failures = [];
  let emailed = 0;
  for (const { author, items: list } of byAuthor.values()) {
    if (dryRun) {
      emailed += 1;
      continue;
    }
    try {
      await sendReminderMail(settings, authorMessage(author, list, settings), { exact: true, to: [author.email] });
      emailed += 1;
    } catch (error) {
      failures.push({ to: author.email, error: error.message });
    }
  }
  return { findings: risks.length, blamed: items.filter((i) => i.commit).length, unsure: items.filter((i) => i.commit && i.confidence !== 'high').length, authors: byAuthor.size, emailed, failures };
}

/** Email each code author the vulnerable code they wrote (or preview it). */
app.post(
  '/api/beta/authors/notify',
  requireFeature('codeAuthors'),
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
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;font-family:monospace;font-size:12px">${escapeHtmlText(where)}${i.owners?.list?.length ? `<br><span style="color:#6b7280;font-family:system-ui,sans-serif">Code owners: ${escapeHtmlText(i.owners.list.join(', '))}</span>` : ''}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;font-family:monospace;font-size:12px">${i.commitUrl ? `<a href="${escapeHtmlText(i.commitUrl)}" style="color:${accent}">${escapeHtmlText(commit)}</a>` : escapeHtmlText(commit)}<br><span style="color:#6b7280">${escapeHtmlText((i.committedAt || '').slice(0, 10))}</span>${i.change?.number ? `<br><span style="font-family:system-ui,sans-serif">${i.change.url ? `<a href="${escapeHtmlText(i.change.url)}" style="color:${accent}">${i.change.kind === 'merge request' ? '!' : '#'}${escapeHtmlText(i.change.number)}</a>` : `${i.change.kind === 'merge request' ? '!' : '#'}${escapeHtmlText(i.change.number)}`}</span>` : ''}</td>
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
/**
 * A Checkmarx One connection that failed while connecting, signing in or changing
 * settings: what went wrong and how to fix it (src/troubleshoot.js).
 */
function connectionHelp(req, error) {
  if (!/^\/api\/(integration|settings|session|automation\/arm)/.test(req.path)) return null;
  if (!['AuthError', 'ConnectionError', 'CxApiError'].includes(error?.name) && !error?.timedOut) return null;
  const body = req.body ?? {};
  return explainCxone(error, { apiKey: typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey : undefined, baseUrl: body.baseUrl, iamUrl: body.iamUrl, tenant: body.tenant });
}

app.use((error, req, res, next) => {
  // A body over its route's size limit: said plainly, not as a parser message.
  if (error.type === 'entity.too.large') {
    return res.status(413).json({
      error: req.path === '/api/backup/restore'
        ? 'That backup is too large to upload here (200 MB at most). Restore it on the server itself with npm run restore (see docs/audit-and-backup.md).'
        : 'That request is too large.',
    });
  }
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
  res.status(error.status).json({ error: error.message ?? 'Unexpected error.', detail: error.body ?? undefined, help: error.help ?? connectionHelp(req, error) ?? undefined });
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
    tstate.bootstrapSessionId = result.id;
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
  const bootstrap = sessions.get(tstate.bootstrapSessionId);
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

/**
 * The https:// address for a request that came over plain http: the reminder server address
 * when it is an https one, else the same host (and port) on https. `port`: the https port
 * people use, when the request came to another port (HTTP_REDIRECT_PORT).
 */
function httpsOrigin(req, { port } = {}) {
  try {
    const configured = new URL(settingsStore.get().links.reportServerUrl || config.reportServerUrl || '');
    if (configured.protocol === 'https:') return configured.origin;
  } catch {}
  // With a real certificate, only to a name it covers (or this machine itself): a
  // request's Host header never chooses another site for the redirect.
  const header = requestHost(req);
  const hostname = header.replace(/^\[(.*)\](:\d+)?$/, '$1').replace(/^([^:]+):\d+$/, '$1').toLowerCase();
  const served = httpsManager.servedNames();
  const covered = (name) => served.some((n) => n === name || (n.startsWith('*.') && name.endsWith(n.slice(1)) && !name.slice(0, -n.length + 1).includes('.')));
  const local = ['localhost', '127.0.0.1', '::1'].includes(hostname);
  const fallback = served.find((n) => !n.startsWith('*.')) || 'localhost';
  // A self-signed certificate warns at every name anyway: people reach it by any address.
  const host = header && (local || httpsManager.selfSigned || covered(hostname)) ? header : fallback;
  if (port === undefined) return `https://${host}`;
  return `https://${host.replace(/:\d+$/, '')}${port === 443 ? '' : `:${port}`}`;
}

/**
 * Plain http while the server is HTTPS only: pages are redirected (308 keeps the method), and
 * API calls are told the new address (`movedTo`): the Dashboard opens it, and reports switch
 * to it by themselves (older reports show the message, with the address to enter).
 */
function httpsOnlyAnswer(req, res, { port } = {}) {
  if (req.method === 'GET' && req.url?.startsWith(CHALLENGE_PREFIX)) return acmeChallengeAnswer(req, res);
  const origin = httpsOrigin(req, { port });
  const url = req.url?.startsWith('/') ? req.url : '/';
  res.setHeader('Cache-Control', 'no-store');
  if (url.startsWith('/api/')) {
    if (url.startsWith('/api/relay')) {
      relayCors(req, res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
    }
    res.writeHead(426, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: `This reminder server now uses HTTPS only. Its address is ${origin}`, movedTo: origin }));
  }
  res.writeHead(308, { Location: `${origin}${url}` });
  return res.end();
}

const server = httpsManager.listen({ app, httpsOnly: httpsOnlyAnswer, port: config.port, host: config.host }, async () => {
  const mode = httpsManager.mode;
  const where = `${config.host}:${config.port}`;
  console.log(`CxMissionZero ${APP_VERSION} running on ${mode === 'http' ? `http://${where}` : mode === 'https' ? `https://${where}` : `http://${where} and https://${where}`}`);
  // For the update companion (full image updates): this version is up.
  acknowledgeStart(dataDir, { version: PACKAGE_VERSION, builtIn: process.env.MZ_BUILTIN_VERSION || PACKAGE_VERSION });
  if (mode === 'https') console.log('[https] HTTPS only: plain http on the same port is redirected to https.');
  if (mode === 'both') console.log('[https] HTTP and HTTPS side by side on the same port. Switch to HTTPS only under Settings → HTTPS once it works.');
  const options = mode === 'http' ? null : httpsManager.contextOptions();
  if (options) {
    const { source, selfSigned } = httpsManager.describe();
    console.log(`[https] ${selfSigned ? 'Self-signed certificate (browsers warn until it is trusted)' : `Certificate (${source === 'uploaded' ? 'uploaded under Settings → HTTPS' : 'from the container options'})`}: ${describeCertificate(options)}`);
    if (selfSigned) {
      console.warn('! [https] Self-signed: traffic is encrypted, but browsers warn, and emailed reports reach this server only from machines that trust the certificate. For production upload your certificate under Settings → HTTPS (or give TLS_CERT_FILE and TLS_KEY_FILE); for plain http on a laptop, HTTPS=off. See docs/https-and-hosting.md.');
    }
  }
  httpsManager.watch();
  console.log(`Settings file: ${settingsStore.file}`);
  for (const problem of configProblems(config)) console.warn(`! ${problem}`);
  // The deployment's own connections (CX_API_KEY, SMTP_*) belong to the first tenant.
  await tenancy.run(DEFAULT_TENANT, async () => {
    await prepareAccess();
    adoptStuckLanguages();
    await bootstrap();
    await verifyEnvironmentSmtp();
  });
  for (const id of tenancy.ids()) await tenancy.run(id, () => resolveAutomationSession());
  tenancy.run(DEFAULT_TENANT, () => seedLastKnownGood());
  // LETSENCRYPT_DOMAIN: get the certificate now (unless a current one for those names is in use), then keep it renewed.
  if (LETSENCRYPT_DOMAIN) {
    try {
      const names = cleanNames(LETSENCRYPT_DOMAIN);
      const s = acme.status();
      const current = s.issued && !s.issued.staging && names.every((n) => s.issued.names.includes(n)) && s.daysLeft > RENEW_DAYS;
      if (current) console.log(`[https] Let's Encrypt certificate for ${names.join(', ')} in use until ${s.issued.validTo.slice(0, 10)}; renewed by itself.`);
      else {
        console.log(`[https] Getting a Let's Encrypt certificate for ${names.join(', ')} (LETSENCRYPT_DOMAIN)…`);
        acme.start({ names, email: process.env.LETSENCRYPT_EMAIL ?? '', staging: /^(1|true|yes|on)$/i.test(process.env.LETSENCRYPT_STAGING ?? ''), skipPrecheck: /^(1|true|yes|on)$/i.test(process.env.LETSENCRYPT_SKIP_CHECK ?? ''), agree: true, by: 'LETSENCRYPT_DOMAIN' });
      }
    } catch (error) {
      console.warn(`! [https] LETSENCRYPT_DOMAIN: ${error.message}`);
    }
  }
  acme.startRenewal();
  tenancy.each(() => scheduler.sync());
  // Under the launcher (src/launch.js): this version is up, so an update to it has worked.
  if (process.env.MZ_SUPERVISOR === '1') process.send?.({ type: 'ready', version: APP_VERSION });
  // Settings changed and left unchecked before a restart (or a timeout): check them now, rolling back what fails.
  tenancy.each(() => {
    if (cxonePending() || smtpPending()) {
      checkConnections({ rollback: true, trigger: 'server start' }).catch((error) => console.warn(`! [settings] Connection check failed: ${error.message}`));
    }
  });
  const automation = settingsStore.get().automation;
  if (automation.enabled) {
    console.log(
      `Automation on: every ${automation.intervalMinutes}m, thresholds ${automation.thresholds.join('/')} days` +
        (automation.dryRun ? ' (dry run)' : ''),
    );
  }
});

/**
 * Plain http on HTTP_REDIRECT_PORT too (e.g. -p 80:8080): while HTTPS only, every request is
 * sent to the https address (HTTPS_PUBLIC_PORT, 443 by default, so it is left out of the
 * address); otherwise it serves the site like the main port.
 */
const REDIRECT_PORT = Number(process.env.HTTP_REDIRECT_PORT) || 0;
const PUBLIC_HTTPS_PORT = Number(process.env.HTTPS_PUBLIC_PORT) || 443;
const redirectServer = REDIRECT_PORT
  ? http
      .createServer((req, res) => (httpsManager.mode === 'https' ? httpsOnlyAnswer(req, res, { port: PUBLIC_HTTPS_PORT }) : app(req, res)))
      .listen(REDIRECT_PORT, config.host, () => console.log(`[https] http on port ${REDIRECT_PORT} too (redirected to https while HTTPS only).`))
  : null;

/**
 * Stop cleanly (a container update or restart sends SIGTERM): stop taking new
 * work, let requests in progress finish (up to SHUTDOWN_DRAIN_SECONDS, 8 by
 * default), hand sign-ins and their fetched data to the next server, write
 * everything still buffered, and let go of the data folder.
 */
const DRAIN_MS = Math.max(0, Number(process.env.SHUTDOWN_DRAIN_SECONDS ?? 8)) * 1000; // inside the 10 s Podman and Docker allow by default
/** The whole stop must fit in the 10 s Podman and Docker give before they kill the process. */
const STOP_BUDGET_MS = Math.max(2, Number(process.env.SHUTDOWN_BUDGET_SECONDS ?? 9.5)) * 1000;
const LAST_WORDS_FILE = path.join(dataDir, 'last-words.json');
/** At most one "MissionZero stopped" email in this long (a restart loop must not flood anyone). */
const LAST_WORDS_EVERY_MS = Math.max(0, Number(process.env.LAST_WORDS_EVERY_HOURS ?? 6)) * 3600_000;

/**
 * Before stopping for a reason nobody here asked for (the service stopped or killed,
 * a crash): a backup in the backup folder, and an email to the administrators with
 * how to bring it back. The copy is attached only when it is encrypted
 * (BACKUP_PASSPHRASE): an unencrypted backup holds the passwords and keys, so then
 * the email says where it is instead. Never throws, and never waits past `deadline`.
 */
async function lastWords(reason, deadline) {
  let backup = null;
  try {
    backup = writeBackupTo(backupConfig.dir, { dataDir, settingsFile: config.settingsFile, passphrase: backupConfig.passphrase, keep: backupConfig.keep });
    lastBackup = { at: backup.summary.createdAt, ok: true, file: backup.file, size: backup.summary.size, files: backup.summary.files, trigger: 'Before stopping' };
    audit.record({ type: 'backup', outcome: 'info', reason: `Before stopping (${reason}): backup written to ${backup.file} (${backup.summary.files} files${backup.summary.encrypted ? ', encrypted' : ''}).`, actor: SYSTEM_ACTOR, details: { backup: { file: backup.file, ...backup.summary } } });
    console.log(`[backup] Before stopping: ${backup.file}`);
  } catch (error) {
    console.error(`! [backup] Before stopping: ${error.message}`);
  }
  // The backup mailbox gets every backup, planned stop or not.
  const copy = backup ? mailBackupCopy(backup.file, backup.summary, 'Before stopping').catch(() => false) : Promise.resolve(false);
  if (plannedStop) {
    await Promise.race([copy, new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())))]);
    return backup;
  }
  let previous = {};
  try {
    previous = JSON.parse(fs.readFileSync(LAST_WORDS_FILE, 'utf8'));
  } catch {}
  if (previous.at && Date.now() - Date.parse(previous.at) < LAST_WORDS_EVERY_MS) return backup;
  try {
    fs.writeFileSync(LAST_WORDS_FILE, JSON.stringify({ at: new Date().toISOString(), reason }), { mode: 0o600 });
  } catch {}
  const attach = Boolean(backup?.summary.encrypted && backup.summary.size <= MAX_ATTACHMENT_BYTES);
  const name = backup ? path.basename(backup.file) : '';
  const send = tenancy.run(DEFAULT_TENANT, async () => {
    if (!isVerified(sendingSettings())) return;
    const attachments = attach ? [{ filename: name, content: fs.readFileSync(backup.file), contentType: 'application/octet-stream' }] : [];
    for (const email of administratorsOf(DEFAULT_TENANT)) {
      await sendSystemMail([email], systemEmail({
        appName: appNameNow(),
        subject: `MissionZero stopped: ${backup ? 'a copy of its data is safe' : 'it could not back up its data'}`,
        lines: [
          `MissionZero stopped (${reason}) at ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. Nobody asked it to from the Update page.`,
          backup
            ? attach
              ? `Its data was backed up just before, and the backup is attached (${name}, encrypted with BACKUP_PASSPHRASE).`
              : backup.summary.encrypted
                ? `Its data was backed up just before, to ${backup.file} on the server. It is too large to attach.`
                : `Its data was backed up just before, to ${backup.file} on the server. It is not attached because it is not encrypted: it holds the passwords and keys. Set BACKUP_PASSPHRASE to get an encrypted copy by email next time.`
            : 'It could not write a backup before stopping. Its data folder is still there.',
          'To bring it back: start MissionZero again with the same command and data folder. Nothing needs restoring while the data folder is there.',
          'If the data folder is lost: start a new MissionZero with the same BACKUP_PASSPHRASE, sign in as an Admin, open Audit → State folder & backups → Restore from backup…, and choose this backup. It is restored when the server next starts, with every setting, person, credit, tracked report and the audit log. On the server itself, `npm run restore -- <file> --yes` does the same.',
        ],
        facts: backup ? [['Backup', name], ['Files', String(backup.summary.files)], ['Encrypted', backup.summary.encrypted ? 'yes' : 'no'], ['Version', `MZ-${PACKAGE_VERSION}`]] : [['Version', `MZ-${PACKAGE_VERSION}`]],
        replyHelp: false,
      }), { attachments });
    }
  }).catch(() => {});
  await Promise.race([Promise.all([send, copy]), new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())))]);
  return backup;
}

let stopping = false;
const shutdown = async (signal) => {
  if (stopping) return;
  stopping = true;
  const deadline = Date.now() + STOP_BUDGET_MS;
  draining = true;
  for (const tenant of tenancy.loaded()) tenant.scheduler.stop();
  server.close();
  server.closeIdleConnections();
  httpsManager.stop();
  acme.stop();
  redirectServer?.close();
  console.log(`[update] ${signal}: finishing ${inFlight} request(s) in progress…`);
  const until = Math.min(Date.now() + DRAIN_MS, deadline - 3000);
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
  for (const tenant of tenancy.loaded()) {
    tenant.knownAddresses.flush();
    tenant.creditLedger.flush();
    tenant.findingJournal.flush();
    tenant.audit.flushSync();
  }
  // Everything is on disk: back it up, and tell the administrators unless this stop was planned.
  await lastWords(signal === 'SIGTERM' ? 'the service was stopped' : `${signal}`, deadline);
  for (const tenant of tenancy.loaded()) tenant.audit.flushSync();
  diagnostics.flush();
  instanceLock.release();
  console.log('[update] Stopped cleanly.');
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, sessions, settingsStore };
