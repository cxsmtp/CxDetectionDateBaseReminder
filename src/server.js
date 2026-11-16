/**
 * CxMissionZero's server. This file puts it together; the routes are in src/routes/, one module for each area.
 *
 * In this order, because the order is behaviour:
 * 1. The state folder: one server at a time (the lock on it), what a crash left, a restore staged for this start,
 *    and then the stores: each tenant's settings, credits, audit log and the rest, the people, the sign-ins kept
 *    from before. A damaged state file stops the start here (stopAtStart).
 * 2. The Express app and its middleware: security headers, compression, the answer to Let's Encrypt, draining for
 *    a stop, the body parsers for each path, the licence gate, the tenant a request is for, the same-origin
 *    guard, the activity log, the page's files, and the relay's CORS answer and admission control.
 * 3. The areas: each call registers one area's routes, in the order kept in test/fixtures/routes.txt. The backup
 *    schedule and the integrity and update services are made between them, where they always were.
 * 4. The error handler, the start (listening, the first connections, the schedulers), and the shutdown.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import http from 'node:http';
import express from 'express';
import compression from 'compression';

import { config, configProblems } from './config.js';
import { APP_VERSION, PACKAGE_VERSION } from './version.js';
import { DEFAULT_IMAGE } from './updates/registry.js';
import { UpdateService } from './updates/service.js';
import { IntegrityService } from './integrity/service.js';
import { VersionStore } from './updates/store.js';
import { SendGuard } from './send-guard.js';
import { ActivityLog, describe as describeAction, fieldNames, recordsGet, targetOf } from './activity-log.js';
import { Diagnostics } from './diagnostics.js';
import { projectReads } from './cxone/risks.js';
import { ReportGrants } from './report-grants.js';
import { patchLinks } from './remediation-patch.js';
import { CreditLedger } from './credits.js';
import { CreditAllocations } from './credit-allocations.js';
import { knownAddresses } from './known-addresses.js';
import { TtlCache } from './ttl-cache.js';
import { AuditLog } from './audit-log.js';
import { IamStore, LANGUAGE_PERMISSIONS } from './iam.js';
import { insideProject, migrateLegacyData, prepareDataDir, resolveDataDir } from './data-dir.js';
import { PENDING_RESTORE, applyPendingRestore, isSealed, readBackup, writeBackupTo } from './backup.js';
import { BackupKeyStore } from './backup-key.js';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { setCloneHostCheck } from './github/identity.js';
import { acknowledgeStart } from './updates/companion.js';
import { BrandFonts } from './brand-fonts.js';
import { TrackedReports } from './tracked-reports.js';
import { FindingJournal } from './finding-journal.js';
import { ScanAttribution } from './scan-attribution.js';
import { ReportFiles } from './report-files.js';
import { ProjectionStore, ReportStore, TenantReadStore } from './projections.js';
import { AutomationState, Scheduler } from './automation.js';
import { onMailFailure, sendReminderMail, testConnection } from './mailer.js';
import { explainCxone } from './troubleshoot.js';
import { TrustStore } from './trust.js';
import { SettingsStore, hasEnvironmentSmtp, isVerified } from './settings.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { systemEmail } from './hands-off.js';
import { BACKUP_SUBJECT, findBackupInMailbox } from './mail-inbox.js';
import { ConnectionGuard } from './connection-guard.js';
import { SessionPersistence, sessionKey } from './handover.js';
import { InstanceLock } from './instance-lock.js';
import { clearHalfSaved, flushPendingNow, StateFileError } from './state-file.js';
import { inlineScriptHashes, sameOriginGuard, securityHeaders, trustProxySetting } from './security.js';
import { describeCertificate } from './tls.js';
import { HttpsManager } from './https-manager.js';
import { AcmeService, CHALLENGE_PREFIX, RENEW_DAYS, cleanNames } from './acme.js';
import { ActivationStore, DEACTIVATED_MESSAGE } from './activation.js';
import { GATED_LANGUAGES, LanguageAccess } from './languages.js';
import { DEFAULT_TENANT, Tenancy, scoped, scopedState } from './tenancy.js';
import { KnownAddresses, scopeKnownAddresses } from './known-addresses.js';
import { Terms, cleanName } from './terms.js';
import { featureById } from './features.js';
import { SupportDesk } from './support.js';
import { SSO_CALLBACK_PATH } from './oidc.js';
import { FaeFlushStore, FaeHistory } from './fae-flush.js';
// Govern (beta): credit governance, per tenant (src/govern/).
import { GovernService } from './govern/cycle.js';
import { registerGovernRoutes } from './govern/routes.js';
// Labs → Status board and Consolidated view (beta): their routes and the Workbench fetch's hooks.
import { registerLabsRoutes } from './labs-routes.js';
import { checkOutboundUrl } from './outbound-url.js';
import { SessionStore, readSessionCookie } from './session.js';
// What the route modules (src/routes/) and this file share that needs nothing of the running server.
import { SYSTEM_ACTOR, clientIp, logSafe } from './routes/shared.js';
// The server's areas (src/routes/), in the order they are put together below.
import { createCreditRules, createCreditView } from './routes/credit-rules.js';
import { createIntegrationSession } from './routes/integration-session.js';
import { createSlaIssues, registerAutomationRoutes } from './routes/automation.js';
import { createGuards } from './routes/guards.js';
import { createActors } from './routes/actors.js';
import { createReportServerAddress } from './routes/report-server.js';
import { createGitConnections, registerGitConnectionRoutes } from './routes/git-connections.js';
import { registerDiagnosticsRoutes } from './routes/diagnostics.js';
import { registerSessionRoutes } from './routes/session.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerPeopleRoutes } from './routes/people.js';
import { registerTrustRoutes } from './routes/trust.js';
import { registerNetworkRoutes } from './routes/network.js';
import { registerConnectionRoutes } from './routes/connections.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerScanRoutes } from './routes/scan.js';
import { registerReminderRoutes } from './routes/reminders.js';
import { registerRelayPingRoutes, registerRelayRoutes } from './routes/relay.js';
import { registerCalculatorRoutes } from './routes/calculator.js';
import { registerHttpsRoutes } from './routes/https.js';
import { registerLicenceRoutes } from './routes/licence.js';
import { registerTenantRoutes } from './routes/tenants.js';
import { registerCreditRunRoutes, registerCreditRoutes, registerCreditUsageRoute } from './routes/credits.js';
import { registerTrackedReportRoutes } from './routes/tracked-reports.js';
import { registerImpactRoutes } from './routes/impact.js';
import { registerSupportRoutes } from './routes/support.js';
import { registerHandsOff, registerHandsOffPageRoutes } from './routes/hands-off.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerIntegrityRoutes, registerUpdateRoutes, registerSystemReportRoute } from './routes/updates.js';
import { registerFeatureRoutes } from './routes/features.js';
import { registerBackupRoutes } from './routes/backups.js';
import { registerFusionRoutes } from './routes/fusion.js';
import { registerFaeFlushRoutes } from './routes/fae-flush.js';
import { registerCodeAuthorRoutes } from './routes/code-authors.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
/** Whose own branding (Settings → Your branding) the current request is made with: see presenting(). */
const presenter = new AsyncLocalStorage();
/** Set when this server asked the launcher to stop it (an update, a switch, a restart): such a stop is planned. */
let plannedStop = false;

const projectDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Who a case MissionZero raises by itself goes to: the administrators forward it there. */
const MAINTAINER_EMAIL = process.env.MAINTAINER_EMAIL?.trim() || 'bhawani.singh@checkmarx.com';

/**
 * The server's areas are put together below in the order their routes are registered, and some of them use
 * each other both ways. What an area needs from one put together further down is handed to it through one of
 * these two: the real thing is looked up when it is used (while a request is served, or a background job
 * runs), never while the server is still being put together.
 */
const later = (find) => (...args) => find()(...args);
/** The same for an object (a service whose routes are registered further down): each use reads the real one. */
const laterObject = (find) =>
  new Proxy(Object.create(null), {
    get(_, key) {
      const target = find();
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

/**
 * All state lives in one folder outside the project (DATA_DIR, default
 * ~/.mission-zero), so a redeploy never touches it and one backup of it
 * rebuilds the server from scratch. See src/data-dir.js.
 */
const { dir: dataDir, source: dataDirSource } = resolveDataDir(process.env, { cwd: process.cwd() });
prepareDataDir(dataDir);
/**
 * A state file that is damaged, with no last good copy, stops the start (src/state-file.js). Whoever runs the
 * server reads what to do in plain words, not a stack trace; the lock on the data folder is let go; and the exit
 * code (78) tells the launcher not to go back to the version before, which would read the damaged file as empty
 * and write over it. Only while starting: once the server runs, the handler further down takes over.
 */
const STATE_DAMAGED_EXIT = 78;
const stopAtStart = (error) => {
  if (!(error instanceof StateFileError)) {
    console.error(error);
    process.exit(1);
  }
  console.error(`\n! [data] ${error.message}\n`);
  try {
    instanceLock.release();
  } catch {}
  process.exit(STATE_DAMAGED_EXIT);
};
process.on('uncaughtException', stopAtStart);

// The certificate authorities outgoing HTTPS trusts, with the ones an Admin added: before anything connects.
const trust = new TrustStore({ dir: dataDir, log: (line) => console.log(line) });
// One server per data folder: wait for the previous one (an update) to finish, or refuse.
const instanceLock = new InstanceLock(dataDir, { staleMs: Math.max(3, Number(process.env.INSTANCE_LOCK_STALE_SECONDS ?? 30)) * 1000 });
try {
  await instanceLock.acquire({ waitMs: Math.max(0, Number(process.env.INSTANCE_LOCK_WAIT_SECONDS ?? 45)) * 1000, onWait: (held) => console.log(`[data] Waiting for the previous server (host ${held.host}) to finish with ${dataDir}…`) });
} catch (error) {
  console.error(`! ${error.message}`);
  process.exit(1);
}
// What a crash in the middle of a save left: never put in place, and holding a copy of what was being saved.
{
  const halfSaved = clearHalfSaved(dataDir);
  if (halfSaved.length) console.log(`[data] Removed ${halfSaved.length} unfinished save file(s) a crash left in ${dataDir}.`);
}
const migrated = migrateLegacyData(dataDir, { legacyDir: path.join(projectDir, 'data') });
if (migrated.length) {
  console.log(`[data] Copied ${migrated.length} file(s) from ${path.join(projectDir, 'data')} to ${dataDir}: ${migrated.join(', ')}`);
  console.log('[data] The old copies are left in place; delete them once this server runs well from the new folder.');
}
/**
 * Backups are encrypted with BACKUP_PASSPHRASE or, without one, with this server's own backup key
 * (src/backup-key.js). Whether this is a new installation (encrypted from its first backup) or an existing
 * one (left as it was until an Admin turns encryption on) is decided here, once, before anything of this
 * start is loaded, restored or written: what is in the folder now is what was there before.
 */
const backupDir = path.resolve(process.env.BACKUP_DIR?.trim() || path.join(dataDir, 'backups'));
const backupKey = new BackupKeyStore({ dataDir });
{
  const decision = backupKey.decide({ settingsFile: config.settingsFile, backupDir });
  if (decision?.decidedBy === 'new-installation') {
    console.log('[backup] A new installation: every backup is encrypted with this server\'s own backup key. An Admin saves the key somewhere else under Audit → State & backups: without it, a backup cannot be opened if this server is lost.');
  } else if (decision?.decidedBy === 'existing-installation') {
    console.log(`[backup] This installation has data from before (${decision.found}): its backups are left as they were${process.env.BACKUP_PASSPHRASE ? ', encrypted with BACKUP_PASSPHRASE' : ', not encrypted, until an Admin turns encryption on under Audit → State & backups'}.`);
  } else if (decision) {
    console.log('[backup] BACKUP_ENCRYPTION=off: backups are not encrypted.');
  }
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
        const partial = `${pending}.${randomUUID()}.partial`;
        fs.writeFileSync(partial, zlib.gzipSync(Buffer.from(JSON.stringify(bundle))), { mode: 0o600, flag: 'wx' });
        fs.renameSync(partial, pending);
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
  // Govern (beta): MZ's own spend is refused for a project or person whose Enforce budget is used up (only while Govern is unlocked).
  creditLedger.setSpendGuard((q) => (governLocked() ? '' : tenancy.context(id).govern.get().spendRefusal(q)));
  const automationState = new AutomationState({
    file: first && config.settingsFile ? config.settingsFile.replace(/\.json$/, '') + '-automation.json' : path.join(dir, 'automation-state.json'),
  });
  return {
    settingsStore,
    creditLedger,
    allocations: new CreditAllocations({ file: path.join(dir, 'credit-allocations.json'), ledger: creditLedger }),
    trackedReports: new TrackedReports({ file: path.join(dir, 'tracked-reports.json') }),
    projections: new ProjectionStore({ file: path.join(dir, 'projections.json') }),
    projectionReports: new ReportStore({ dir: path.join(dir, 'projection-reports') }),
    projectionReads: new TenantReadStore({ file: path.join(dir, 'projection-read.json') }),
    reportFiles: new ReportFiles({ dir: path.join(dir, 'report-files'), ttlDays: 30 }),
    guard: new ConnectionGuard({ file: path.join(dir, 'connection-guard.json') }),
    audit: new AuditLog({ dir: path.join(dir, 'audit'), keyFile: path.join(dir, 'audit.key') }),
    // What people do here, one line each (src/activity-log.js): Logs → User activity.
    activity: new ActivityLog({ file: path.join(dir, 'activity.jsonl') }),
    automationState,
    scheduler: new Scheduler({
      // The scheduler is synchronous about session lookup, so a key armed while
      // the process is running is picked up by the refresh below rather than here.
      // Nothing runs on its own until an Admin has accepted the terms of use.
      // Nor once the product licence has ended (src/activation.js).
      resolveSession: () => (terms.organisation() && activations.product().active ? sessions.get(tstate.automationSessionId) ?? sessions.get(tstate.bootstrapSessionId) : null),
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
      // Act → Automation → Email → "Attach the HTML report": each person's own interactive report.
      reportFor: (session, risks, options) => automationReport(session, risks, options),
    }),
    knownAddresses: new KnownAddresses({ file: path.join(dir, 'known-initiators.json') }),
    // When each finding was first seen open and when it closed: the Impact page (src/impact.js).
    findingJournal: new FindingJournal({ file: path.join(dir, 'finding-journal.json') }),
    scanAttribution: new ScanAttribution({ dataDir: dir }),
    // FAE Flush (Labs): the last run, project by project (src/fae-flush.js).
    faeFlush: new FaeFlushStore({ file: path.join(dir, 'fae-flush.json') }),
    // Every result FAE Flush marked, after its run: the value it brought (Labs → FAE Flush → Value).
    faeHistory: new FaeHistory({ file: path.join(dir, 'fae-flush-history.json') }),
    // Govern (beta): budgets, holds, alerts and usage in govern/, made the first time Govern is used (src/govern/cycle.js).
    govern: lazyGovern(id, path.join(dir, 'govern')),
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
/**
 * Govern (beta) for one tenant, made on first use: it reads and acts through the tenant's own integration session,
 * records in the tenant's audit chain and mails through MZ's verified mailer.
 */
function lazyGovern(id, dir) {
  let service = null;
  const inTenant = (fn) => tenancy.run(id, fn);
  return {
    loaded: () => Boolean(service),
    get: () =>
      (service ??= new GovernService({
        dir,
        clientOf: () => inTenant(() => integrationSession()?.client ?? null),
        connectionOf: () => inTenant(() => integrationSession()?.connection ?? null),
        audit: (entry) => tenancy.context(id).audit.record(entry),
        sendMail: (message, to) => inTenant(() => sendReminderMail(presenter.exit(() => sendingSettings()), message, { to, exact: true })),
        meta: () => ({ tenant: inTenant(() => integrationSession()?.connection?.tenant ?? ''), version: APP_VERSION, allowLoopback: Boolean(process.env.NODE_TEST_CONTEXT) }),
        pool: () =>
          inTenant(() => {
            const s = settingsStore.get();
            const period = poolPeriod(s);
            return { limit: s.aiTriage?.monthlyCreditLimit ?? 0, period, used: creditLedger.usedInPeriod(period).total };
          }),
      })),
  };
}
/** Govern is held back until its activation code is in force (features.js unlockedBy). */
const governLocked = () => featureLocked(featureById('govern'));

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
const projections = scoped(tenancy, 'projections');
const projectionReports = scoped(tenancy, 'projectionReports');
const projectionReads = scoped(tenancy, 'projectionReads');
const findingJournal = scoped(tenancy, 'findingJournal');
const reportFiles = scoped(tenancy, 'reportFiles');
const guard = scoped(tenancy, 'guard');
/**
 * Answers from Checkmarx One shared by every report: risk states per project,
 * AI Triage records and AI Remediation details per finding. Concurrent asks
 * for the same thing share one upstream call.
 */
const relayCache = scoped(tenancy, 'relayCache');
/**
 * The audit log. Server-wide events (people and sign-ins, backups, updates, HTTPS, activation
 * codes, tenants) go to the first tenant's log; everything else to the running tenant's.
 */
const SERVER_WIDE_AUDIT = new Set(['iam', 'access', 'backup', 'system']);
const serverWide = (entry) => SERVER_WIDE_AUDIT.has(entry?.type) || Boolean(entry?.details?.https || entry?.details?.activation || entry?.details?.tenants);
const tenantAudit = scoped(tenancy, 'audit');
const activity = scoped(tenancy, 'activity');
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
  // ORGANISATION_NAME: the organisation's name (else the Admin gives it when accepting the terms).
  if (cleanName(process.env.ORGANISATION_NAME) && !terms.organisationName()) terms.setOrganisationName(process.env.ORGANISATION_NAME);
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

/** Projects someone just triaged or remediated in, so reports covering them refresh soon. */
const touchedProjects = scoped(tenancy, 'touchedProjects');
const touchProject = (projectId) => touchedProjects.set(projectId, Date.now());

// ---- A project's credits as the dashboard shows them: src/routes/credit-rules.js ------------------------------------------
const { creditView } = createCreditView({ creditLedger, allocations, SEVERITIES });

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

const scheduler = scoped(tenancy, 'scheduler');

// ---- The server's own Checkmarx One connection: src/routes/integration-session.js --------------------------------------
const {
  integrationOverrides, integrationSession, keyForEndpoints, cxoneFingerprint, activateIntegration,
  resolveAutomationSession,
} = createIntegrationSession({
  sessions, tstate, settingsStore, guard, scheduler,
  // Made further down: looked up when used, never before.
  connectCheckmarxOne: later(() => connectCheckmarxOne),
});

// ---- SLAs (Beta), issues for findings past their SLA: src/routes/automation.js ------------------------------------------
const { openSlaIssuesFor } = createSlaIssues({
  // Made further down: looked up when used, never before.
  gitSets: later(() => gitSets),
  sendingSettings: later(() => sendingSettings),
});

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
/** The gated languages (Hebrew) a person's role allows: its `language.<code>` permission. */
function allowedLanguages(userId) {
  const perms = userId ? iam.permissionsOf(iam.user(userId)) : new Set();
  return Object.entries(LANGUAGE_PERMISSIONS).filter(([perm]) => perms.has(perm)).map(([, code]) => code);
}
/** Permissions that mean nothing right now (a language whose activation code is not in force): not listed on People & roles. */
const dormantPermissions = () => Object.entries(LANGUAGE_PERMISSIONS).filter(([, code]) => !languageAccess.isOn(code)).map(([perm]) => perm);

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
app.use(securityHeaders({
  scriptHashes: inlineScriptHashes(path.join(publicDir, 'index.html')),
  hsts: () => httpsManager.hstsHeader(),
  // The report server address an administrator set (its Test button checks it from the browser).
  connectSources: () => [settingsStore.get().links?.reportServerUrl, config.reportServerUrl],
}));
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
// Govern (beta): small JSON bodies, except a CSV import (at most 1 MiB of CSV, in JSON).
app.use('/api/govern/csv', express.json({ limit: '2mb' }));
app.use('/api/govern', express.json({ limit: '64kb' }));
// Where nobody has signed in yet, a request is small: an emailed report's actions, a sign-in, a licence code.
// (Up to RELAY_MAX_FINDINGS findings a request, a few hundred bytes each.)
app.use('/api/relay', express.json({ limit: '512kb' }));
app.use(['/api/session', '/api/licence'], express.json({ limit: '64kb' }));
// A calculator customer or report with tens of thousands of projects (MAX_PROFILE_BYTES, MAX_REPORT_BYTES): read
// only for someone signed in who may use the calculator. Anyone else's request falls to the limit below, and is
// refused by the route (401 or 403) without 40 MB having been read for them.
const calculatorJson = express.json({ limit: '40mb' });
app.use('/api/projections', (req, res, next) => {
  const session = currentSession(req);
  const user = session ? iam.user(session.userId) : null;
  if (user && !user.disabled && permissionsFor(user).has('projections.use')) return calculatorJson(req, res, next);
  next();
});
app.use(express.json({ limit: '4mb' }));

/**
 * The product licence (src/activation.js, docs/activation-codes.md): after the end of 31 March 2027 (UTC), or a product
 * code's date if later, CxMissionZero stops. Every page shows that it has been deactivated, with a field for the
 * activation code; every other request is refused. Only the health check (the container's), the licence itself
 * and what its page needs stay open. Nothing is deleted.
 */
const productActive = () => activations.product().active;
const LICENCE_OPEN = new Set(['/api/health', '/api/licence', '/api/licence/activate', '/deactivated.js', '/favicon.svg', '/mz-icon-64.png']);
app.use((req, res, next) => {
  if (LICENCE_OPEN.has(req.path)) return next();
  if (productActive()) return req.path === '/deactivated.html' ? res.redirect('/') : next();
  res.set('Cache-Control', 'no-store');
  if (req.path.startsWith('/api/') || !['GET', 'HEAD'].includes(req.method)) return res.status(503).json({ error: DEACTIVATED_MESSAGE, deactivated: true });
  res.status(503).sendFile(path.join(publicDir, 'deactivated.html'));
});

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
    recordActivity(req, res, route, Date.now() - started);
  });
  next();
});
/**
 * User activity: every change a signed-in person makes, every download and export, and every
 * sign-in (refused ones too), with who, when, from where and how it ended. Reading the page, and
 * the polls a page makes while open, are not recorded; pages visited are (POST /api/activity).
 */
const SIGN_IN_ROUTES = new Set(['/api/session', '/api/session/password', '/api/session/two-step', SSO_CALLBACK_PATH]);
const NOT_RECORDED = new Set(['/api/activity', '/api/credits/prepare', '/api/settings/template/preview', '/api/https/inspect', '/api/https/browser-check', '/api/projections/series', '/api/integration/cxone/draft', '/api/diagnostics/client-error', '/api/hands-off/status', '/api/settings/notices/ack']);
function recordActivity(req, res, route, ms) {
  try {
    if (route === '(unmatched)' || NOT_RECORDED.has(route) || route.startsWith('/api/relay/')) return;
    if ((req.method === 'GET' || req.method === 'HEAD') && !recordsGet(route)) return;
    const who = req.user ?? res.locals.activityUser ?? null;
    const signIn = SIGN_IN_ROUTES.has(route);
    if (!who && !signIn) return;
    // An attempt to sign in: a POST to one of them, or the way back from the identity provider (a GET).
    const attempt = signIn && (req.method === 'POST' || route === SSO_CALLBACK_PATH);
    activity.record({
      user: who?.email ?? '',
      name: who?.name ?? '',
      role: who?.role ? iam.role(who.role)?.name ?? who.role : '',
      ip: clientIp(req),
      kind: attempt ? 'sign-in' : 'action',
      action: attempt && (res.statusCode >= 400 || res.locals.signInRefused) ? 'Sign-in refused' : res.locals.activityAction ?? describeAction(req.method, route),
      target: targetOf(req.params),
      fields: req.method === 'GET' ? Object.keys(req.query ?? {}) : fieldNames(req.body),
      method: req.method,
      route,
      status: res.statusCode,
      ms,
    });
  } catch (error) {
    console.error(`[activity] ${error.message}`);
  }
}
process.on('exit', () => {
  for (const id of tenancy.ids?.() ?? []) tenancy.context(id)?.activity?.flush();
});
// However the server ends: what was written and still waits for its flush to the disk is flushed first.
process.on('exit', flushPendingNow);

// The page's files; API calls never touch the disk looking for one (a stat per request, under load).
// A language behind an activation code (Hebrew) is not served until it is activated here.
app.use('/i18n', (req, res, next) => {
  const code = req.path.match(/^\/([\w-]+)\.json$/)?.[1];
  // Only to the people it is open to (their sign-in), so nobody else ever receives it.
  if (code && code in GATED_LANGUAGES && !languageAccess.isAvailable(code, allowedLanguages(sessions.peek(readSessionCookie(req))?.userId))) return res.status(404).json({ error: 'That language is not available.' });
  next();
});
// The organisation's brand font, from its own licensed copies (src/brand-fonts.js): never part of the image.
const brandFonts = new BrandFonts({ dir: path.resolve(process.env.BRAND_FONT_DIR || path.join(dataDir, 'fonts')), family: process.env.BRAND_FONT_FAMILY || 'Founders Grotesk' });
app.get('/brand-fonts.css', (req, res) => {
  res.type('text/css').set('Cache-Control', 'no-cache').send(brandFonts.css());
});
app.get('/brand-fonts/:file', (req, res) => {
  const file = brandFonts.path(req.params.file);
  if (!file) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=86400').sendFile(file);
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

// ---------------------------------------------------------------------------
// The routes, by area (src/routes/). Each call below puts one area together and registers its routes,
// in the order they were always registered: Express runs middleware and routes in that order, so it is
// behaviour, and test/route-order.test.js keeps it (test/fixtures/routes.txt). An area is handed what it
// needs of the server; what it makes for other areas comes back from the call and is handed on.
// ---------------------------------------------------------------------------

// ---- What stands in front of a route (sign-in, permissions, the tenant): src/routes/guards.js ---------------------------
const {
  asyncRoute, permissionsFor, tenantsUnlocked, isSuperAdmin, tenantsOf, currentSession, requireSession, ownBranding,
  presenting, brandingNow, can, requirePermission, featureLocked, requireFeature,
} = createGuards({
  presenter, sessions, tenancy, settingsStore, terms, iam, integrationSession, resolveAutomationSession, activations,
});

/** Deployment config with the administrator's pinned risks path layered on. */
function activeConfig() {
  const pinned = settingsStore.get().endpoints.risksPath;
  return pinned ? { ...config, risks: { ...config.risks, path: pinned } } : config;
}

// ---- Who did it, for the audit log: src/routes/actors.js ---------------------------------------------------------------
const { reportActor, adminActor } = createActors({ iam, reportGrants });

// ---- This server's address as others reach it: src/routes/report-server.js ---------------------------------------------
const {
  LOOPBACK, requestOrigin, resolveReportServer, reportServerUrl, reportServerWarnings, requestHost,
} = createReportServerAddress({ tstate, settingsStore, httpsManager, can });

// ---- The git connections (GitHub, GitLab, Azure DevOps, Bitbucket): src/routes/git-connections.js ----------------------
// Their helpers are made here, before the areas that use them; the route is registered further down.
const {
  gitCacheDir, githubConfig, cloneHostAllowed, scmHosts, githubClient, gitSets, connectionsStatus,
} = createGitConnections({
  dataDir, tenancy, tstate, settingsStore,
  // Made further down: looked up when used, never before.
  integrationStatus: later(() => integrationStatus),
});

// ---- Health, the app icon, diagnostics and metrics: src/routes/diagnostics.js -------------------------------------------
registerDiagnosticsRoutes(app, {
  publicDir, dataDirSource, sessions, settingsStore, trackedReports, relayCache, audit, diagnostics, iam,
  integrationSession, resolveAutomationSession, languageAccess, allowedLanguages, RELAY_MAX_IN_FLIGHT, relayStats,
  asyncRoute, requireSession, requirePermission, adminActor,
});

// ---- Signing in and out, the first administrator, two-step sign-in, single sign-on: src/routes/session.js --------------
const {
  firstAdminFile, prepareAccess, resetTwoStepFromEnvironment, describeMe, signInTickets, ssoAddressProblem,
  passwordResets, passwordResetReady, utc, maySetSignInSecurity, signInSecurityView,
} = registerSessionRoutes(app, {
  MAINTAINER_EMAIL, dataDir, backupKey, sessions, saveSignInsSoon, tenancy, tstate, settingsStore, guard, audit,
  terms, iam, integrationSession, activations, languageAccess, allowedLanguages, asyncRoute, permissionsFor,
  isSuperAdmin, tenantsOf, currentSession, requireSession, ownBranding, can, requirePermission, featureLocked,
  adminActor, LOOPBACK, requestOrigin,
  // Made further down: looked up when used, never before.
  iamView: later(() => iamView),
  visibleUser: later(() => visibleUser),
  auditIam: later(() => auditIam),
  endSessionsOf: later(() => endSessionsOf),
  refusalListed: later(() => refusalListed),
  tenantName: later(() => tenantName),
  appNameNow: later(() => appNameNow),
  integrity: laterObject(() => integrity),
  labs: laterObject(() => labs),
});

// ---- A person's own account, the activity log and the terms of use: src/routes/account.js -------------------------------
registerAccountRoutes(app, {
  settingsStore, activity, audit, terms, iam, firstAdminFile, languageAccess, allowedLanguages, asyncRoute,
  currentSession, requireSession, can, requirePermission, adminActor, describeMe,
  // Made further down: looked up when used, never before.
  withinReach: later(() => withinReach),
  endSessionsOf: later(() => endSessionsOf),
});

// ---- People & roles: src/routes/people.js -------------------------------------------------------------------------------
const { mayChangeRoles, withinReach, iamView, visibleUser, auditIam, endSessionsOf } = registerPeopleRoutes(app, {
  MAINTAINER_EMAIL, sessions, tenancy, settingsStore, audit, iam, languageAccess, allowedLanguages,
  dormantPermissions, asyncRoute, permissionsFor, isSuperAdmin, tenantsOf, can, requirePermission, featureLocked,
  adminActor, signInTickets, passwordResets, passwordResetReady, utc, maySetSignInSecurity, signInSecurityView,
  // Made further down: looked up when used, never before.
  tenantName: later(() => tenantName),
  appNameNow: later(() => appNameNow),
});

// ---- Trusted certificates, and connecting to Checkmarx One: src/routes/trust.js ----------------------------------------
const { cxHosts, connectCheckmarxOne, SERVER_NAME, refuseOtherTenants, TRUST_EDIT } = registerTrustRoutes(app, {
  trust, sessions, audit, asyncRoute, requirePermission, adminActor, mayChangeRoles,
  // Made further down: looked up when used, never before.
  withTimeout: later(() => withTimeout),
});

// ---- Settings → Network: src/routes/network.js --------------------------------------------------------------------------
registerNetworkRoutes(app, {
  dataDir, backupMailbox, settingsStore, audit, iam, integrationOverrides, acme, LETSENCRYPT_DOMAIN, asyncRoute,
  requirePermission, adminActor, githubConfig, cxHosts, SERVER_NAME, refuseOtherTenants, TRUST_EDIT,
  // Made further down: looked up when used, never before.
  updates: laterObject(() => updates),
});

// ---- The server's own connections, and keeping them working: src/routes/connections.js --------------------------------
const {
  integrationStatus, withTimeout, cxonePending, smtpPending, sendingSettings, connectionStatus, noteConnectionHelp,
  checkConnections,
} = registerConnectionRoutes(app, {
  sessions, tenancy, tstate, settingsStore, guard, audit, integrationOverrides, integrationSession, keyForEndpoints,
  cxoneFingerprint, activateIntegration, resolveAutomationSession, productActive, asyncRoute, requireSession,
  presenting, can, requirePermission, adminActor, ssoAddressProblem, connectCheckmarxOne,
  // Made further down: looked up when used, never before.
  settingsFor: later(() => settingsFor),
});

// ---- The Settings page: src/routes/settings.js --------------------------------------------------------------------------
const { settingsFor } = registerSettingsRoutes(app, {
  settingsStore, guard, asyncRoute, requireSession, can, requirePermission, activeConfig, adminActor, githubConfig,
  ssoAddressProblem, noteConnectionHelp,
  // Made further down: looked up when used, never before.
  creditSettingsOf: later(() => creditSettingsOf),
  auditSettings: later(() => auditSettings),
  tenantCreditsOf: later(() => tenantCreditsOf),
});

// ---- Act → Automation: src/routes/automation.js -------------------------------------------------------------------------
const { automationReport } = registerAutomationRoutes(app, {
  presenter, sessions, tstate, settingsStore, audit, automationState, activateIntegration, resolveAutomationSession,
  scheduler, asyncRoute, requirePermission, adminActor, resolveReportServer, integrationStatus, sendingSettings,
  connectionStatus,
  // Made further down: looked up when used, never before.
  sendSystemMail: later(() => sendSystemMail),
  buildInteractiveReport: later(() => buildInteractiveReport),
});

// ---- The Workbench fetch: src/routes/scan.js ----------------------------------------------------------------------------
const { fetchInProgress, afterFetch, projectRow, readerIdentity, scanAttribution, creditFor } = registerScanRoutes(app, {
  saveFetchedData, tenancy, settingsStore, findingJournal, diagnostics, creditView, asyncRoute, requirePermission,
  activeConfig,
  // Made further down: looked up when used, never before.
  labs: laterObject(() => labs),
});

// ---- Reminder emails from the Workbench: src/routes/reminders.js -------------------------------------------------------
const {
  NOT_EXPLOITABLE_STATES, withoutNotExploitable, reminderScope, initiatorGroups, runReminder,
} = registerReminderRoutes(app, {
  settingsStore, creditLedger, relayCache, asyncRoute, requirePermission, sendingSettings,
  // Made further down: looked up when used, never before.
  triageLookup: later(() => triageLookup),
  projectStates: later(() => projectStates),
});

// ---- The rules every spend of AI credits follows, and their audit entries: src/routes/credit-rules.js ------------------
const {
  relayError, refusalListed, grantedFindings, relaySession, actionAllowed, triageAllowed, poolPeriod,
  governRequester, creditsRemaining, tenantLeft, tenantShortfall, poolName, adminContact, projectCredits, balanceOf,
  auditCredit, creditSettingsOf, auditSettings, allocationSnapshot, auditAllocation, auditRefusedRequest,
  attributedReport, creditNeed, creditRefusal, tenantCreditsOf, tenantRefusal, creditPool,
} = createCreditRules({
  settingsStore, creditLedger, allocations, audit, diagnostics, reportGrants, resolveAutomationSession,
  // Made further down: looked up when used, never before.
  labs: laterObject(() => labs),
});

// ---- The relay's two routes that need no connection: src/routes/relay.js ------------------------------------------------
registerRelayPingRoutes(app);

// ---- The Cx Credits Calculator: src/routes/calculator.js ---------------------------------------------------------------
registerCalculatorRoutes(app, {
  MAINTAINER_EMAIL, tenancy, settingsStore, projections, projectionReports, projectionReads, audit, terms,
  integrationSession, asyncRoute, requirePermission, adminActor, cloneHostAllowed, gitSets, sendingSettings,
});

// ---- Settings → HTTPS: src/routes/https.js -------------------------------------------------------------------------------
const { reportOpens } = registerHttpsRoutes(app, {
  settingsStore, audit, httpsManager, acme, LETSENCRYPT_DOMAIN, asyncRoute, requirePermission, resolveReportServer,
  requestHost, adminActor,
});

// ---- The product licence and the activation codes: src/routes/licence.js ------------------------------------------------
registerLicenceRoutes(app, { audit, activations, languageAccess, asyncRoute, can, requirePermission, refusalListed, adminActor });

// ---- Several Checkmarx One tenants: src/routes/tenants.js --------------------------------------------------------------
const { tenantName } = registerTenantRoutes(app, {
  sessions, saveSignInsSoon, tenancy, audit, iam, integrationSession, activations, asyncRoute, tenantsUnlocked,
  isSuperAdmin, tenantsOf, requireSession, can, requirePermission, iamView, auditIam, adminActor,
});

// ---- The relay for the emailed report: src/routes/relay.js ---------------------------------------------------------------
const { stateCache, projectRiskInfo, triageLookup, actedOn, projectStates } = registerRelayRoutes(app, {
  tenancy, settingsStore, creditLedger, recordCreditUse, allocations, relayCache, audit, sendGuard, BUSY_REASON,
  noteBusy, touchProject, tenantQuery, patchTokens, httpsManager, asyncRoute, requireSession, activeConfig,
  requestOrigin, resolveReportServer, reportServerUrl, reportServerWarnings, relayError, grantedFindings,
  relaySession, actionAllowed, triageAllowed, poolPeriod, governRequester, creditsRemaining, tenantLeft,
  adminContact, projectCredits, reportActor, balanceOf, auditCredit, auditRefusedRequest, attributedReport,
  creditNeed, creditRefusal, reportOpens, httpsOrigin,
});

// ---- Credits from the Workbench (verify, allocate, triage and remediation runs): src/routes/credits.js -----------------
const {
  scanProjects, cleanSeverities, notifyOnBehalf, VERIFY_AT_ONCE, doubleRead, DISAGREED, adminTriage, adminRemediate,
} = registerCreditRunRoutes(app, {
  settingsStore, creditLedger, recordCreditUse, allocations, SEVERITIES, audit, sendGuard, diagnostics, BUSY_REASON,
  noteBusy, touchProject, creditView, asyncRoute, requirePermission, activeConfig, afterFetch, projectRow,
  readerIdentity, poolPeriod, governRequester, tenantLeft, tenantShortfall, poolName, adminActor, balanceOf,
  auditCredit, allocationSnapshot, auditAllocation, auditRefusedRequest, creditRefusal, stateCache, projectRiskInfo,
  actedOn, projectStates, tenantRefusal, creditPool,
  // Made further down: looked up when used, never before.
  branchChoiceOfScan: later(() => branchChoiceOfScan),
});

// ---- Tracked reports, their verification rescans and follow-up: src/routes/tracked-reports.js ---------------------------
const {
  branchChoiceFor, branchChoiceOfScan, currentFindings, goneText, cxErrorText, rescanTokens, RESCAN_REPORT_GRANT_MS,
  audienceSetting, serverTimeZone, allocateNeeded, kindsOf, remediateConfirmed,
} = registerTrackedReportRoutes(app, {
  sessions, tenancy, tstate, settingsStore, creditLedger, allocations, SEVERITIES, trackedReports, findingJournal,
  audit, touchedProjects, creditView, reportGrants, tenantQuery, resolveAutomationSession, productActive, asyncRoute,
  requirePermission, activeConfig, sendingSettings, afterFetch, readerIdentity, NOT_EXPLOITABLE_STATES, runReminder,
  resolveReportServer, reportServerUrl, adminActor, allocationSnapshot, auditAllocation, cleanSeverities,
  notifyOnBehalf, doubleRead, DISAGREED, adminTriage, adminRemediate, scanAttribution, creditFor, tenantRefusal,
  creditPool,
  // Made further down: looked up when used, never before.
  monthlyImpact: later(() => monthlyImpact),
  buildInteractiveReport: later(() => buildInteractiveReport),
  runHtmlReminder: later(() => runHtmlReminder),
});

// ---- The Credits page: src/routes/credits.js ---------------------------------------------------------------------------
registerCreditRoutes(app, {
  sessions, tstate, settingsStore, creditLedger, allocations, audit, creditView, asyncRoute, requirePermission,
  afterFetch, creditsRemaining, adminActor, allocationSnapshot, auditAllocation, cleanSeverities, notifyOnBehalf,
  adminTriage, creditFor, currentFindings, goneText, remediateConfirmed, tenantCreditsOf, tenantRefusal, creditPool,
});

// ---- The Impact page and its monthly summary: src/routes/impact.js -----------------------------------------------------
const { impactFor, monthlyImpact } = registerImpactRoutes(app, {
  settingsStore, creditLedger, findingJournal, audit, terms, automationState, asyncRoute, brandingNow, can,
  requirePermission, sendingSettings, resolveReportServer, adminActor,
  // Made further down: looked up when used, never before.
  readerLook: later(() => readerLook),
});

// ---- Get help (support cases and requests): src/routes/support.js -----------------------------------------------------
registerSupportRoutes(app, {
  tenancy, settingsStore, iam, supportDesk, asyncRoute, permissionsFor, tenantsOf, requireSession, can,
  requirePermission, sendingSettings, resolveReportServer, tenantName,
});

// ---- Hands-off mode and self-healing: src/routes/hands-off.js ------------------------------------------------------------
const {
  administratorsOf, appNameNow, serverUrl, sendSystemMail, sendStatus, selfCheck, healthView,
} = registerHandsOff(app, {
  presenter, MAINTAINER_EMAIL, dataDir, sessions, tenancy, tstate, settingsStore, audit, diagnostics, iam,
  supportDesk, reportGrants, integrationSession, resolveAutomationSession, scheduler, productActive, asyncRoute,
  permissionsFor, tenantsOf, withTimeout, cxonePending, smtpPending, sendingSettings, checkConnections,
  resolveReportServer, tenantName, impactFor, backupToFolder, bootstrap,
  // Made further down: looked up when used, never before.
  linkPage: later(() => linkPage),
  updateStore: laterObject(() => updateStore),
  updates: laterObject(() => updates),
});

// Never die quietly: record what escaped, and keep serving (under the launcher, start afresh).
process.on('unhandledRejection', (error) => {
  diagnostics.error('unhandled-rejection', error);
  console.warn(`! Unhandled rejection: ${logSafe(error?.message ?? String(error))}`);
});
process.off('uncaughtException', stopAtStart);
process.on('uncaughtException', (error) => {
  diagnostics.error('uncaught-exception', error);
  diagnostics.flush();
  console.error(`! Uncaught exception: ${logSafe(error?.stack ?? error?.message ?? String(error))}`);
  // Under the launcher a crash restarts the server: back up and tell the administrators first.
  if (updates.supervised) lastWords(`it crashed: ${String(error?.message ?? error).slice(0, 200)}`, Date.now() + 8000).finally(() => process.exit(1));
});

// ---- The Hands-off page's own routes: src/routes/hands-off.js -----------------------------------------------------------
registerHandsOffPageRoutes(app, {
  settingsStore, audit, integrationSession, resolveAutomationSession, scheduler, asyncRoute, can, requirePermission,
  sendingSettings, adminActor, audienceSetting, serverUrl, sendStatus, selfCheck, healthView,
});

// ---- The credit usage chart: src/routes/credits.js ----------------------------------------------------------------------
registerCreditUsageRoute(app, { creditLedger, allocations, requirePermission, creditPool });

// ---- The interactive HTML report, built, downloaded and emailed: src/routes/reports.js ----------------------------------
const { buildInteractiveReport, LOCATABLE_SCANNERS, readerLook, linkPage, runHtmlReminder } = registerReportRoutes(app, {
  tenancy, settingsStore, reportFiles, audit, iam, reportGrants, tenantQuery, languageAccess, allowedLanguages,
  asyncRoute, brandingNow, requirePermission, activeConfig, sendingSettings, readerIdentity, withoutNotExploitable,
  reminderScope, initiatorGroups, reportServerUrl, relaySession, adminContact, reportActor, adminActor, creditFor,
  branchChoiceFor, rescanTokens, RESCAN_REPORT_GRANT_MS,
});

// ---- The Audit page: src/routes/audit.js ------------------------------------------------------------------------------
registerAuditRoutes(app, { creditLedger, audit, asyncRoute, requirePermission, adminActor });

// ---------------------------------------------------------------------------
// Backup and restore: one file rebuilds the whole server
// ---------------------------------------------------------------------------

const backupConfig = {
  dir: backupDir,
  explicitDir: Boolean(process.env.BACKUP_DIR?.trim()),
  intervalHours: Math.max(0, Number(process.env.BACKUP_INTERVAL_HOURS ?? 24) || 0),
  keep: Math.max(1, Number(process.env.BACKUP_KEEP) || 14),
  /** What a backup made now is sealed with: BACKUP_PASSPHRASE, else this server's backup key, else nothing (plain). */
  get passphrase() {
    return backupKey.secret();
  },
};
/** What a backup made now is encrypted with, in words for an email or the log (never the secret itself). */
const sealedWith = () => (backupKey.source === 'passphrase' ? 'BACKUP_PASSPHRASE' : 'this server\'s backup key');
/** How to give a new server what opens such a backup, for the same emails. */
const sameSecret = () => (backupKey.source === 'passphrase' ? 'the same BACKUP_PASSPHRASE' : 'BACKUP_PASSPHRASE set to this server\'s backup key (an Admin saved it from Audit → State & backups; it is never emailed)');
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
 * by itself. Encrypted backups only (BACKUP_PASSPHRASE or this server's backup key): never one
 * that holds the passwords and keys in the clear, and never the key with it. Returns whether it went.
 */
async function mailBackupCopy(file, summary, trigger) {
  if (!backupMailbox.email) return false;
  if (!summary.encrypted) {
    console.warn('! [backup] BACKUP_EMAIL is set, but backups are not encrypted: turn encryption on under Audit → State & backups (or set BACKUP_PASSPHRASE) to email them.');
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
          `${trigger} backup of MissionZero, encrypted with ${sealedWith()}: ${name}.`,
          `Keep this email. A new MissionZero started with BACKUP_EMAIL, BACKUP_EMAIL_PASSWORD and ${sameSecret()} finds the newest backup here and restores it by itself.`,
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

// Software integrity: the running files against the signed file list, and who built it (src/integrity/).
const integrity = new IntegrityService({
  appDir: projectDir,
  dataDir,
  token: process.env.GITHUB_TOKEN?.trim() || '',
  record: ({ outcome, reason, details }) => {
    audit.record({ type: 'system', outcome, reason, actor: SYSTEM_ACTOR, details });
    if (outcome === 'failure') {
      console.warn(`[integrity] ${reason}`);
      diagnostics.discrepancy('software-integrity', { state: details?.state });
    }
  },
});
integrity.start();

// ---- Software integrity's routes: src/routes/updates.js -----------------------------------------------------------------
registerIntegrityRoutes(app, { asyncRoute, requirePermission, integrity });

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
  // Only what the release workflow built and signed is installed or switched to.
  integrity,
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

// ---- New versions, rollback and restart: src/routes/updates.js ----------------------------------------------------------
registerUpdateRoutes(app, { dataDir, audit, asyncRoute, requirePermission, backupToFolder, updates });

// ---- Settings → Beta features: src/routes/features.js -----------------------------------------------------------------
registerFeatureRoutes(app, {
  settingsStore, audit, scheduler, asyncRoute, requireSession, can, requirePermission, featureLocked,
});

// ---- The troubleshooting report: src/routes/updates.js ------------------------------------------------------------------
registerSystemReportRoute(app, {
  dataDir, sessions, tstate, audit, httpsManager, relayStats, requirePermission, cxonePending, smtpPending,
  serverTimeZone, lastBackup: () => lastBackup, updates,
});

// ---- Audit → State & backups: src/routes/backups.js -------------------------------------------------------------------
registerBackupRoutes(app, {
  projectDir, dataDir, dataDirSource, backupKey, restoredAtStart, audit, asyncRoute, requirePermission, adminActor,
  backupConfig, lastBackup: () => lastBackup, settleState, backupToFolder,
});

setCloneHostCheck(cloneHostAllowed);

// ---- The header's connection chips (GET /api/connections): src/routes/git-connections.js -------------------------------
registerGitConnectionRoutes(app, { asyncRoute, requireSession, connectionsStatus });

// ---- Fusion results (Labs): src/routes/fusion.js ----------------------------------------------------------------------
const { initiatorLogins } = registerFusionRoutes(app, {
  settingsStore, creditLedger, allocations, creditView, asyncRoute, can, requirePermission, requireFeature,
  activeConfig, afterFetch, adminActor, stateCache, projectStates, scanProjects, cleanSeverities, notifyOnBehalf,
  VERIFY_AT_ONCE, adminTriage, adminRemediate, goneText, allocateNeeded, kindsOf, tenantCreditsOf, creditPool,
});

// ---- FAE Flush (Labs, then Act): src/routes/fae-flush.js -------------------------------------------------------------
registerFaeFlushRoutes(app, {
  tenancy, settingsStore, audit, integrationSession, productActive, asyncRoute, requirePermission, featureLocked,
  requireFeature, cxErrorText,
});

// ---- Govern (beta): credit governance — budgets, requests, restrictions, alerts, attribution (src/govern/) ------------
// Routes under /api/govern; each tenant's Govern runs its cycle on its own schedule (default every 15 minutes,
// jittered), only while its activation code is in force and the tenant has a Checkmarx One integration; the outbox
// of notifications is drained on the same tick, apart from the cycle.
registerGovernRoutes(app, {
  requireFeature,
  requirePermission,
  asyncRoute,
  governOf: () => tenancy.current().govern.get(),
  actorOf: (req) => adminActor(req),
  sendMail: (message, to) => sendReminderMail(presenter.exit(() => sendingSettings()), message, { to, exact: true }),
  meta: () => ({ tenant: integrationSession()?.connection?.tenant ?? '', version: APP_VERSION, allowLoopback: Boolean(process.env.NODE_TEST_CONTEXT) }),
  // Only https (plain http to this machine only under the test runner), never link-local or cloud metadata.
  checkWebhookUrl: (url) => checkOutboundUrl(url, { label: 'webhook address', allowLoopbackHttp: Boolean(process.env.NODE_TEST_CONTEXT) }),
});
const GOVERN_TICK_MS = Number(process.env.GOVERN_TICK_MS) || 15_000;
setInterval(() => {
  if (!productActive() || governLocked()) return;
  tenancy.each(() => {
    if (!integrationSession()) return;
    try {
      const govern = tenancy.current().govern.get();
      govern.tick();
      govern.notifier.drain().catch(() => {});
    } catch (error) {
      console.warn(`! [govern] ${logSafe(error.message)}`);
    }
  });
}, GOVERN_TICK_MS).unref?.();

// ---- Labs → Status board and Consolidated view (beta): src/labs-routes.js ------------------------------------------
// The board reads the session's Workbench data; the consolidated view reads each tenant's own memory (never Checkmarx
// One) and writes one line to each tenant's audit log per visit.
const labs = registerLabsRoutes(app, {
  requireFeature,
  requirePermission,
  asyncRoute,
  tenancy,
  featureLocked: (id) => featureLocked(featureById(id)),
  fetchInProgress,
  identityOf: (session) => readerIdentity(session),
  linkBase: (req) => settingsStore.get().links?.baseUrl || req.session.connection?.baseUrl || '',
  tenantsOf: (user, permissions) => tenantsOf(user, permissions),
  tenantName,
  creditPool: () => creditPool(),
  adminActor,
  auditIam,
  visibleUser,
  iamView,
  iam,
});

// ---- Identity matching and code authors (Labs): src/routes/code-authors.js ------------------------------------------
const { notifyCodeAuthors } = registerCodeAuthorRoutes(app, {
  settingsStore, asyncRoute, requirePermission, requireFeature, sendingSettings, NOT_EXPLOITABLE_STATES,
  LOCATABLE_SCANNERS, gitCacheDir, githubConfig, scmHosts, githubClient, gitSets, initiatorLogins,
});

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
      connectCheckmarxOne(config.bootstrapApiKey, config.overrides),
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
 * API calls are told the new address (`movedTo`): the Workbench opens it, and reports switch
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
    resetTwoStepFromEnvironment();
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
 * (BACKUP_PASSPHRASE, or the server's backup key): an unencrypted backup holds the
 * passwords and keys, so then the email says where it is instead. The key is never in
 * the email. Never throws, and never waits past `deadline`.
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
  // Encrypted with the server's own backup key (not a BACKUP_PASSPHRASE): the email says where that key is kept.
  const keyed = Boolean(backup?.summary.encrypted) && backupKey.source === 'key';
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
              ? `Its data was backed up just before, and the backup is attached (${name}, encrypted with ${sealedWith()}).`
              : backup.summary.encrypted
                ? `Its data was backed up just before, to ${backup.file} on the server. It is too large to attach.`
                : `Its data was backed up just before, to ${backup.file} on the server. It is not attached because it is not encrypted: it holds the passwords and keys. Turn encryption on under Audit → State & backups (or set BACKUP_PASSPHRASE) to get an encrypted copy by email next time.`
            : 'It could not write a backup before stopping. Its data folder is still there.',
          'To bring it back: start MissionZero again with the same command and data folder. Nothing needs restoring while the data folder is there.',
          // The key itself is never part of an email: only where an Admin kept it.
          keyed
            ? 'If the data folder is lost: start a new MissionZero, sign in as an Admin, open Audit → State & backups → Restore from backup…, choose this backup, and give the backup key when it asks. The key is not in this email: it is the one an Admin saved from Audit → State & backups. The backup is restored when the server next starts, with every setting, person, credit, tracked report and the audit log. On the server itself, `npm run restore -- <file> --yes` with BACKUP_PASSPHRASE set to the backup key does the same.'
            : 'If the data folder is lost: start a new MissionZero with the same BACKUP_PASSPHRASE, sign in as an Admin, open Audit → State folder & backups → Restore from backup…, and choose this backup. It is restored when the server next starts, with every setting, person, credit, tracked report and the audit log. On the server itself, `npm run restore -- <file> --yes` does the same.',
          ...(keyed && !backupKey.status().keySaved ? ['Nobody has confirmed saving the backup key yet. While the data folder is still there, start MissionZero again and save the key from Audit → State & backups: without it, this backup cannot be opened.'] : []),
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
  // What was written and is still waiting for its flush to the disk: now, before the folder is let go.
  flushPendingNow();
  instanceLock.release();
  console.log('[update] Stopped cleanly.');
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export { app, sessions, settingsStore };
