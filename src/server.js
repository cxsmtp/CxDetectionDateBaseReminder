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
import { AGE_BUCKETS, projectReads } from './cxone/risks.js';
import { ReportGrants } from './report-grants.js';
import { patchLinks } from './remediation-patch.js';
import { CreditLedger } from './credits.js';
import { CreditAllocations, creditFigures, billingUnit } from './credit-allocations.js';
import { knownAddresses } from './known-addresses.js';
import { TtlCache } from './ttl-cache.js';
import { AuditLog } from './audit-log.js';
import { IamStore, LANGUAGE_PERMISSIONS, PERMISSIONS, PROFILE_LANGUAGES, PROGRAMMING_LANGUAGES, cleanProfile, generatePassword, passwordProblem, publicUser } from './iam.js';
import { insideProject, migrateLegacyData, prepareDataDir, resolveDataDir } from './data-dir.js';
import { PENDING_RESTORE, applyPendingRestore, isSealed, readBackup, writeBackupTo } from './backup.js';
import { BackupKeyStore } from './backup-key.js';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { GitHubClient } from './github/client.js';
import { setCloneHostCheck } from './github/identity.js';
import { codeVersion, onGitHub, parseRepoUrl } from './github/blame.js';
import { SCM_LABELS, providerOf, scmClients, scmConfigs } from './scm/providers.js';
import { acknowledgeStart } from './updates/companion.js';
import { githubIssues, gitlabIssues, openSlaIssues } from './sla-issues.js';
import { BrandFonts } from './brand-fonts.js';
import { TrackedReports } from './tracked-reports.js';
import { FindingJournal } from './finding-journal.js';
import { ScanAttribution } from './scan-attribution.js';
import { ReportFiles } from './report-files.js';
import { ProjectionStore, ReportStore, TenantReadStore } from './projections.js';
import { riskUrl } from './links.js';
import { AutomationState, Scheduler } from './automation.js';
import { deriveConnection } from './cxone/endpoints.js';
import { onMailFailure, sendReminderMail, testConnection } from './mailer.js';
import { explainCxone } from './troubleshoot.js';
import { TrustStore, isUntrustedCode } from './trust.js';
import { activeProxy, checkRoute, cleanProxy, proxyWithAuth, readNetwork, requirements, requirementsText, saveNetwork } from './network.js';
import { SettingsStore, cleanPersonalBranding, hasEnvironmentSmtp, hostOfUrl, isVerified, mergeSettings, overlayBranding, supportChannel } from './settings.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { systemEmail } from './hands-off.js';
import { BACKUP_SUBJECT, findBackupInMailbox } from './mail-inbox.js';
import { ConnectionGuard } from './connection-guard.js';
import { setForRepo } from './scm/instances.js';
import { SessionPersistence, sessionKey } from './handover.js';
import { InstanceLock } from './instance-lock.js';
import { clearHalfSaved, flushPendingNow, StateFileError } from './state-file.js';
import { inlineScriptHashes, pruneAttempts, sameOriginGuard, securityHeaders, trustProxySetting } from './security.js';
import { describeCertificate } from './tls.js';
import { HttpsManager } from './https-manager.js';
import { AcmeService, CHALLENGE_PREFIX, RENEW_DAYS, cleanNames } from './acme.js';
import { ActivationStore, DEACTIVATED_MESSAGE } from './activation.js';
import { GATED_LANGUAGES, LanguageAccess } from './languages.js';
import { DEFAULT_TENANT, Tenancy, scoped, scopedState } from './tenancy.js';
import { KnownAddresses, scopeKnownAddresses } from './known-addresses.js';
import { Terms, cleanName } from './terms.js';
import { DEFAULT_TEMPLATE, TEMPLATE_VARIABLES } from './template.js';
import { featureById, featureList, inLabs, isFinal, labsPermission, LABS_VIEW, mayUse } from './features.js';
import { journeyOf } from './journey.js';
import { SupportDesk } from './support.js';
import { PasswordResets, RESET_TTL_MS, maskEmail, resetAllowed } from './password-reset.js';
import { PendingSetups, SignInTickets, TICKET_TTL_MS, groupedKey, matchTotp, newRecoveryCodes, newSecret, otpauthUri, recoveryHash } from './mfa.js';
import { OidcClient, SSO_CALLBACK_PATH, SSO_COOKIE, SSO_FLOW_TTL_MS, SsoError, SsoFlows, identityProblem, mergeSso, publicSso, ssoChanges } from './oidc.js';
import { FaeFlushStore, FaeHistory } from './fae-flush.js';
import { AGE_PRESETS, WINDOW_PRESETS } from './window.js';
// Govern (beta): credit governance, per tenant (src/govern/).
import { GovernService } from './govern/cycle.js';
import { registerGovernRoutes } from './govern/routes.js';
// Labs → Status board and Consolidated view (beta): their routes and the Workbench fetch's hooks.
import { registerLabsRoutes } from './labs-routes.js';
import { checkOutboundUrl } from './outbound-url.js';
import {
  SessionStore,
  clearSessionCookie,
  cookieShouldBeSecure,
  describeSession,
  readSessionCookie,
  setSessionCookie,
} from './session.js';
// What the route modules (src/routes/) and this file share that needs nothing of the running server.
import { SYSTEM_ACTOR, clientIp, logSafe } from './routes/shared.js';
import { registerCodeAuthorRoutes } from './routes/code-authors.js';
import { registerFaeFlushRoutes } from './routes/fae-flush.js';
import { registerFusionRoutes } from './routes/fusion.js';
import { createGitConnections, registerGitConnectionRoutes } from './routes/git-connections.js';
import { registerBackupRoutes } from './routes/backups.js';
import { registerSystemReportRoute, registerUpdateRoutes, registerIntegrityRoutes } from './routes/updates.js';
import { registerFeatureRoutes } from './routes/features.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerCreditUsageRoute, registerCreditRoutes, registerCreditRunRoutes } from './routes/credits.js';
import { registerHandsOffPageRoutes, registerHandsOff } from './routes/hands-off.js';
import { registerSupportRoutes } from './routes/support.js';
import { registerImpactRoutes } from './routes/impact.js';
import { registerTrackedReportRoutes } from './routes/tracked-reports.js';
import { registerRelayRoutes, registerRelayPingRoutes } from './routes/relay.js';
import { createReportServerAddress } from './routes/report-server.js';
import { registerTenantRoutes } from './routes/tenants.js';
import { registerLicenceRoutes } from './routes/licence.js';
import { registerHttpsRoutes } from './routes/https.js';
import { createActors } from './routes/actors.js';
import { registerCalculatorRoutes } from './routes/calculator.js';
import { createCreditRules } from './routes/credit-rules.js';
import { registerReminderRoutes } from './routes/reminders.js';
import { registerScanRoutes } from './routes/scan.js';
import { registerAutomationRoutes } from './routes/automation.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerConnectionRoutes } from './routes/connections.js';

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
let setupCode = '';
const DEFAULT_ADMIN_EMAIL = 'admin@mission-zero.local';
/** The generated first administrator's one-time password, until they choose their own. */
const firstAdminFile = path.join(dataDir, 'first-admin-password.txt');

async function prepareAccess() {
  if (iam.hasUsers()) {
    // A data volume used before: no new sign-in is printed, so say whom to sign in as and how to get back in.
    const admin = iam.users().find((u) => u.role === 'admin' && !u.disabled);
    console.log(`[access] Users already set up in ${dataDir}${admin ? `; an administrator is ${admin.email}` : ''}. Lost the password? Run: node scripts/reset-admin.mjs  (in a container: docker exec <name> node scripts/reset-admin.mjs)`);
    return;
  }
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

/**
 * RESET_TWO_STEP=<email>: the way back in for someone whose authenticator app and recovery codes are both gone when
 * no Admin is left to reset it for them (the only Admin, say). At start-up their two-step sign-in is taken off;
 * they sign in with their password and set it up again. Whoever can set the server's environment can do this, as
 * they can run scripts/reset-admin.mjs. Recorded in the audit log. It works once for a person: left in the
 * environment it does nothing more, until the server has started without it.
 */
function resetTwoStepFromEnvironment() {
  const email = String(process.env.RESET_TWO_STEP ?? '').trim().toLowerCase();
  if (!email) return iam.noteTwoStepResetFor('');
  if (iam.twoStepResetFor() === email) return console.warn('! [access] RESET_TWO_STEP was used for this person at an earlier start, so nothing was reset now. Take it out of the environment.');
  const user = iam.findByEmail(email);
  if (!user) return console.warn('! [access] RESET_TWO_STEP names nobody who has access here: nothing was reset. Take it out of the environment.');
  iam.noteTwoStepResetFor(email);
  if (iam.resetTwoStep(user.id)) {
    audit.record({ type: 'iam', outcome: 'changed', reason: `Two-step sign-in reset for ${user.email} from the server's environment (RESET_TWO_STEP).`, actor: SYSTEM_ACTOR });
    console.log(`[access] Two-step sign-in was reset for ${user.email} (RESET_TWO_STEP). Take RESET_TWO_STEP out of the environment now.`);
  } else {
    console.log(`[access] RESET_TWO_STEP: ${user.email} has no two-step sign-in to reset. Take RESET_TWO_STEP out of the environment.`);
  }
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
      const session = await connectCheckmarxOne(storedKey, integrationOverrides(settings));
      activateIntegration(session, storedKey, settings.integrationOverrides ?? {});
      tstate.integrationFailure = { fingerprint: null, until: 0 };
      return session;
    } catch (error) {
      console.warn(`! Stored automation key could not be used: ${error.message}`);
      tstate.integrationFailure = { fingerprint, until: Date.now() + 30_000 + Math.floor(Math.random() * 30_000), error };
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
  // The consolidated view (Labs): given to one person by an Admin, never by a role (src/iam.js PERSON_GRANTS).
  if (user?.consolidated === true && !user.disabled) all.add('consolidated.view');
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

/** A feature held back for those an activation code has unlocked it for (features.js `unlockedBy`), while it has not. */
function featureLocked(feature) {
  return Boolean(feature?.unlockedBy) && !activations.feature(feature.unlockedBy)?.on;
}

/**
 * A Beta feature: in Labs, for roles holding Labs and the item's own permission; SLAs with Beta features; once an
 * Admin made it final, for everyone holding the feature's own permission too (src/features.js).
 */
function requireFeature(id) {
  return (req, res, next) =>
    requireSession(req, res, (error) => {
      if (error) return next(error);
      if (featureLocked(featureById(id))) return res.status(403).json({ error: `“${featureById(id).name}” needs its activation code (Settings → Activation codes).`, locked: true });
      if (mayUse(settingsStore.get(), id, req.permissions)) return next();
      const feature = featureById(id);
      if (feature?.labs) {
        const needs = [LABS_VIEW, labsPermission(id)].filter((p) => !req.permissions.has(p));
        const labels = needs.map((p) => PERMISSIONS.find((x) => x.id === p)?.label ?? p);
        return res.status(403).json({ error: `“${feature.name}” is in Labs: your role needs “${labels.join('” and “') || 'its permission'}”${isFinal(settingsStore.get(), id) ? '' : ' until an Admin makes it final'}.`, permission: needs[0] ?? labsPermission(id) });
      }
      res.status(403).json({ error: `“${feature?.name ?? id}” is a Beta feature: your role needs “Beta features”${isFinal(settingsStore.get(), id) ? '' : ' until an Admin makes it final'}.`, permission: 'beta.use' });
    });
}

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
} = createReportServerAddress({
  tstate, settingsStore, httpsManager, can,
});

// ---- The git connections (GitHub, GitLab, Azure DevOps, Bitbucket): src/routes/git-connections.js ----------------------
// Their helpers are made here, before the areas that use them; the route is registered further down.
const {
  gitCacheDir, githubConfig, cloneHostAllowed, scmHosts, githubClient, gitSets, connectionsStatus,
} = createGitConnections({
  dataDir, tenancy, tstate, settingsStore,
  // Made further down: looked up when used, never before.
  integrationStatus: later(() => integrationStatus),
});

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

/** What this browser may see about itself: who is signed in, what they may do, and the connection. */
function describeMe(session, user) {
  const held = permissionsFor(user);
  const settings = settingsStore.get();
  // "feature.<id>": what the page shows for each Beta feature this person may use (never checked by the server).
  const usable = featureList(settings).filter((f) => !featureLocked(f) && mayUse(settings, f.id, held));
  // "labs.active": Labs shows in the menu only while one of its items is turned on for this person.
  const permissions = [...held, ...usable.map((f) => `feature.${f.id}`), ...(usable.some((f) => inLabs(settings, f.id)) ? ['labs.active'] : [])];
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
    // The Cx Credits Calculator at an address of its own (an Admin's switch): the menu opens it there, for whoever may use the calculator.
    calculator: held.has('projections.use') && settings.calculator?.external && settings.calculator.url ? { url: settings.calculator.url } : null,
    via: session.via,
    // Two-step sign-in for this person: on or not, how many recovery codes are left, and whether an Admin requires it.
    twoStep: { available: Boolean(user.passwordHash), on: Boolean(user.mfa?.secret), since: user.mfa?.secret ? user.mfa.enabledAt ?? '' : '', recoveryLeft: user.mfa?.secret ? (user.mfa.recovery ?? []).length : 0, required: iam.twoStepRequired() },
    // The organisation's Impact figures: what Your profile → Your Impact figures falls back to.
    organisationImpact: (({ currency, hourlyRate, creditPrice, triageMinutes, fixMinutes }) => ({ currency, hourlyRate, creditPrice, triageMinutes, fixMinutes }))(settings.impact),
    integration: { connected: Boolean(integration), tenant },
    // Connection settings put back because new ones did not work: shown once to each administrator.
    configNotices: held.has('integration.cxone') || held.has('integration.smtp') ? guard.unseen(user.id) : [],
    // Whether the code running is what the release workflow built: for those who look after updates.
    integrity: held.has('system.update') && integrity.last ? { state: integrity.last.state, summary: integrity.last.summary } : null,
    // The page's languages this person may use (Hebrew only for the people chosen).
    languages: languageAccess.available(allowedLanguages(user.id)),
    // Add-ons a code has unlocked (in date or not): until then the page does not show them.
    unlocked: { tenants: Boolean(activations.tenants()) || tenancy.enabled, impact: Boolean(activations.feature('impact')?.on), faeFlush: Boolean(activations.feature('faeFlush')?.on), govern: Boolean(activations.feature('govern')?.on), statusBoard: Boolean(activations.feature('statusBoard')?.on), consolidated: Boolean(activations.feature('consolidated')?.on) },
    // The product licence's end, for the Admins' banner in the last 30 days (src/activation.js).
    licence: held.has('activation.manage') ? (({ until, daysLeft, warn, activation }) => ({ until, daysLeft, warn, activation }))(activations.product()) : null,
    // Backups, for the Admins' notice: 'save-key' while nobody confirmed saving the backup key, 'not-encrypted' while they are plain.
    backupNotice: held.has('backup.manage') ? backupKey.status().notice : null,
    // The organisation's name (given with the terms of use), for what CxMissionZero makes for others.
    organisationName: terms.organisationName(),
    // Get help: the support portal here, or email to an address (installations whose mail cannot leave).
    support: (({ mode, email }) => ({ mode, email }))(supportChannel(settingsStore.get())),
    // The name and logo the page shows this person: theirs while they present their own branding.
    branding: (({ appName, logoUrl }) => ({ appName: appName || 'CxMissionZero', logoUrl: logoUrl || '', own: Boolean(ownBranding(user, held)) }))(overlayBranding(settings.branding, ownBranding(user, held))),
    // Several Checkmarx One tenants: the one this person works in now, and the ones they may switch to.
    tenancy: tenancy.enabled
      ? {
          current: { id: tenancy.current().id, name: tenantName(tenancy.current().id) },
          // With when each last fetched (tenants loaded since the start), for the switcher (Labs → Consolidated view).
          tenants: tenantsOf(user, held).map((id) => ({ id, name: tenantName(id), ...labs.fetchInfo(id) })),
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
    // Single sign-on, when it is on and can work: the button's label, and whether passwords are for Admins only.
    const { sso, ready } = ssoState();
    return res.json({ connected: false, signedIn: false, setup: !iam.hasUsers() && Boolean(setupCode), firstStart, passwordReset: passwordResetReady().ready, sso: ready ? { label: sso.label, passwordAdminsOnly: sso.passwordAdminsOnly } : null });
  }
  res.json(describeMe(session, user));
});

/** Sign-in attempts per address, to slow down guessing across many accounts. */
const SIGN_IN_WINDOW_MS = 10 * 60 * 1000;
const signInAttempts = new Map();
function tooManySignIns(req) {
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
  return recent.length > 30;
}
function throttleSignIn(req, res) {
  if (!tooManySignIns(req)) return false;
  res.status(429).json({ error: 'Too many sign-in attempts from this address. Wait a few minutes.' });
  return true;
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
    // (An email address is at most 254 characters: nothing longer is looked up, or written to the audit log.)
    const email = String(req.body?.email ?? '').trim().slice(0, 254);
    let user;
    try {
      // (With a second step to come, or a password that is no longer enough, this is not a sign-in yet.)
      user = await iam.signIn(email, String(req.body?.password ?? ''), Date.now(), { more: (u) => passwordNotEnough(u) || needsTwoStep(u) });
    } catch (error) {
      const known = error.userId ? iam.user(error.userId) : null;
      res.locals.activityUser = known ?? { email };
      // (Listed only so many a minute, by address and in all: nobody has signed in here, and the log is never trimmed.)
      if (refusalListed(`address ${clientIp(req)}`, Date.now(), 'signIn')) auditAccess(req, 'refused', `Sign-in refused for ${email || '(no email)'}: ${error.message}${error.locked ? ' Account locked.' : ''}`, known);
      throw error;
    }
    res.locals.activityUser = user;
    // Single sign-on is on and passwords are kept for Admins: said only to someone who typed the right password.
    if (passwordNotEnough(user)) {
      res.locals.signInRefused = true;
      if (refusalListed(`address ${clientIp(req)}`, Date.now(), 'signIn')) auditAccess(req, 'refused', `Sign-in refused for ${user.email}: only Admins may sign in with a password; everyone else uses single sign-on.`, user);
      return res.status(403).json({ error: 'Signing in with a password is turned off for this account. Use single sign-on.', sso: true });
    }
    // Two-step sign-in: no session yet, only a ticket for the code (or, when an Admin requires it and this person has none, for setting it up).
    if (needsTwoStep(user)) {
      const secret = user.mfa?.secret ? '' : newSecret();
      const ticket = signInTickets.issue(user.id, { secret });
      // (In User activity this is not a sign-in yet.)
      res.locals.activityAction = secret ? 'Typed the right password: asked to set up two-step sign-in' : 'Typed the right password: asked for the two-step code';
      res.set('Cache-Control', 'no-store');
      return res.json({ twoStep: true, ticket, minutes: Math.round(TICKET_TTL_MS / 60_000), ...(secret ? { setup: twoStepSetup(user, secret) } : {}) });
    }
    res.status(201).json(openPasswordSession(req, res, user, 'signed in with a password'));
  }),
);

/** The session a password sign-in gives (single sign-on gives the same one, `via` apart), with its cookie and audit entry. */
function openPasswordSession(req, res, user, how, via = 'password') {
  const session = sessions.createLinked(integrationSession);
  Object.assign(session, { userId: user.id, via });
  saveSignInsSoon();
  setSessionCookie(req, res, session.id);
  res.locals.activityUser = user;
  auditAccess(req, 'info', `${user.email} ${how}.`, user);
  return describeMe(session, user);
}

// ---------------------------------------------------------------------------
// Two-step sign-in (src/mfa.js): a code from an authenticator app after the password
// ---------------------------------------------------------------------------

const signInTickets = new SignInTickets();
const pendingSetups = new PendingSetups();
/** A second step stands between this person's correct password and a session: they have it on, or an Admin requires it. */
const needsTwoStep = (user) => Boolean(user.mfa?.secret) || iam.twoStepRequired();
/** What the page shows to set an authenticator app up: the key (also in groups of four) and the address its QR code carries. */
const twoStepSetup = (user, secret) => ({ secret, key: groupedKey(secret), otpauth: otpauthUri(user.email, secret) });
const TICKET_OVER = 'That sign-in is over: it lasts five minutes and takes a few tries. Sign in again.';
const WRONG_CODE = 'That code is not right. Use the newest code in your authenticator app, and check that the phone\'s clock is right.';

/** Turn two-step sign-in on for `user` with a secret their app has just proved it holds: ten new recovery codes, shown this once. */
function turnOnTwoStep(user, secret, step) {
  const codes = newRecoveryCodes();
  iam.enableTwoStep(user.id, secret, { step, recovery: codes.map((code) => recoveryHash(user.id, code)) });
  return codes;
}

/** The second step: the ticket from the password step, and a code (or a recovery code). Only then is there a session. */
app.post(
  '/api/session/two-step',
  asyncRoute(async (req, res) => {
    if (throttleSignIn(req, res)) return;
    const ticket = String(req.body?.ticket ?? '');
    const typed = String(req.body?.code ?? '').slice(0, 40);
    const entry = signInTickets.get(ticket);
    const user = entry ? iam.user(entry.userId) : null;
    const refused = (status, message, why, extra = {}) => {
      if (refusalListed(`address ${clientIp(req)}`, Date.now(), 'signIn')) auditAccess(req, 'refused', `Sign-in refused${user ? ` for ${user.email}` : ''}: ${why}`, user);
      return res.status(status).json({ error: message, ...extra });
    };
    if (!entry || !user) return refused(401, TICKET_OVER, 'the two-step sign-in was over, or was never started.', { restart: true });
    res.locals.activityUser = user;
    if (user.disabled) {
      signInTickets.consume(ticket);
      return refused(403, 'This account is disabled. Ask an administrator.', 'the account is disabled.', { restart: true });
    }
    let how = 'signed in with a password and a two-step code';
    let recoveryCodes = null;
    if (entry.secret) {
      // An Admin requires two-step sign-in and this person had none: the first right code turns it on.
      if (user.mfa?.secret) {
        signInTickets.consume(ticket);
        return refused(409, 'Two-step sign-in was turned on for this account in the meantime. Sign in again.', 'two-step sign-in was set up elsewhere in the meantime.', { restart: true });
      }
      const step = matchTotp(entry.secret, typed);
      if (!step) {
        const left = signInTickets.wrong(ticket);
        return refused(401, left ? WRONG_CODE : TICKET_OVER, 'wrong code while setting up two-step sign-in.', { restart: !left });
      }
      recoveryCodes = turnOnTwoStep(user, entry.secret, step);
      audit.record({ type: 'iam', outcome: 'changed', reason: `${user.email} turned on two-step sign-in (required at sign-in).`, actor: resetActor(req, user.email) });
      how = 'signed in with a password and set up two-step sign-in';
    } else {
      if (!user.mfa?.secret) {
        signInTickets.consume(ticket);
        return refused(409, 'Two-step sign-in was reset for this account in the meantime. Sign in again.', 'two-step sign-in was reset in the meantime.', { restart: true });
      }
      let result;
      try {
        result = iam.checkTwoStep(user.id, typed);
      } catch (error) {
        if (error.status === 423) {
          signInTickets.consume(ticket);
          return refused(423, error.message, 'the account is locked after too many wrong attempts.', { restart: true });
        }
        if (error.status !== 401) throw error;
        const left = signInTickets.wrong(ticket);
        const over = !left || Boolean(error.locked);
        if (over) signInTickets.consume(ticket);
        return refused(401, over ? TICKET_OVER : WRONG_CODE, `wrong two-step code.${error.locked ? ' Account locked.' : ''}`, { restart: over });
      }
      if (result.kind === 'recovery') {
        audit.record({ type: 'iam', outcome: 'changed', reason: `${user.email} used a recovery code to sign in: it is gone, ${result.left} left.`, actor: resetActor(req, user.email) });
        how = `signed in with a password and a recovery code (${result.left} left)`;
      }
    }
    signInTickets.consume(ticket);
    iam.recordSignIn(user);
    const me = openPasswordSession(req, res, iam.user(user.id), how);
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ ...me, ...(recoveryCodes ? { recoveryCodes } : {}) });
  }),
);

/** Someone signed in turns two-step sign-in on: first a secret to put in their authenticator app (kept in memory until proved). */
app.post('/api/me/two-step/setup', requireSession, (req, res) => {
  if (!req.user.passwordHash) return res.status(400).json({ error: 'Two-step sign-in is for people who sign in with a password. Set a password first.' });
  if (req.user.mfa?.secret) return res.status(400).json({ error: 'Two-step sign-in is already on.' });
  res.set('Cache-Control', 'no-store');
  res.json(twoStepSetup(req.user, pendingSetups.start(req.user.id)));
});

/** …then the code their app shows: only now is it on. The recovery codes are shown this once. */
app.post(
  '/api/me/two-step/enable',
  requireSession,
  asyncRoute(async (req, res) => {
    if (req.user.mfa?.secret) return res.status(400).json({ error: 'Two-step sign-in is already on.' });
    const secret = pendingSetups.get(req.user.id);
    if (!secret) return res.status(400).json({ error: 'That key is more than ten minutes old. Start again.', restart: true });
    const step = matchTotp(secret, req.body?.code);
    if (!step) return res.status(400).json({ error: WRONG_CODE });
    const recoveryCodes = turnOnTwoStep(req.user, secret, step);
    pendingSetups.clear(req.user.id);
    audit.record({ type: 'iam', outcome: 'changed', reason: `${req.user.email} turned on two-step sign-in.`, actor: await adminActor(req) });
    res.set('Cache-Control', 'no-store');
    res.json({ recoveryCodes, me: describeMe(req.session, iam.user(req.user.id)) });
  }),
);

/** A current code from the app, checked for someone signed in (turning it off, new recovery codes). Wrong ones count towards the lock. */
async function ownTwoStepCode(req, res, what) {
  try {
    iam.checkTwoStep(req.user.id, req.body?.code, { recovery: false });
    return true;
  } catch (error) {
    if (error.status !== 401 && error.status !== 423) throw error;
    audit.record({ type: 'iam', outcome: 'refused', reason: `${req.user.email} could not ${what}: ${error.status === 423 ? 'too many wrong codes' : 'wrong code'}.`, actor: await adminActor(req) });
    res.status(error.status === 423 ? 423 : 400).json({ error: error.status === 423 ? error.message : WRONG_CODE });
    return false;
  }
}

/** Turn one's own two-step sign-in off: only with a current code, and not while an Admin requires it. */
app.post(
  '/api/me/two-step/disable',
  requireSession,
  asyncRoute(async (req, res) => {
    if (!req.user.mfa?.secret) return res.status(400).json({ error: 'Two-step sign-in is not on.' });
    if (iam.twoStepRequired()) return res.status(403).json({ error: 'An administrator requires two-step sign-in for everyone who signs in with a password, so it cannot be turned off.' });
    if (!(await ownTwoStepCode(req, res, 'turn off two-step sign-in'))) return;
    iam.resetTwoStep(req.user.id);
    signInTickets.revokeUser(req.user.id);
    audit.record({ type: 'iam', outcome: 'changed', reason: `${req.user.email} turned off two-step sign-in.`, actor: await adminActor(req) });
    res.json({ me: describeMe(req.session, iam.user(req.user.id)) });
  }),
);

/** Ten new recovery codes in place of the old ones: with a current code. */
app.post(
  '/api/me/two-step/recovery-codes',
  requireSession,
  asyncRoute(async (req, res) => {
    if (!req.user.mfa?.secret) return res.status(400).json({ error: 'Two-step sign-in is not on.' });
    if (!(await ownTwoStepCode(req, res, 'make new recovery codes'))) return;
    const recoveryCodes = newRecoveryCodes();
    iam.setRecoveryCodes(req.user.id, recoveryCodes.map((code) => recoveryHash(req.user.id, code)));
    audit.record({ type: 'iam', outcome: 'changed', reason: `${req.user.email} made new recovery codes; the old ones no longer work.`, actor: await adminActor(req) });
    res.set('Cache-Control', 'no-store');
    res.json({ recoveryCodes, me: describeMe(req.session, iam.user(req.user.id)) });
  }),
);

// ---------------------------------------------------------------------------
// Single sign-on with OpenID Connect (src/oidc.js)
// ---------------------------------------------------------------------------

const oidc = new OidcClient();
const ssoFlows = new SsoFlows();

/** Single sign-on as set, the address the identity provider sends people back to, and whether it can work now (and if not, why). */
function ssoState() {
  const sso = iam.sso();
  // The address set under Settings, or, when that one is not an https address, the deployment's own (REPORT_SERVER_URL).
  const base = tenancy.run(DEFAULT_TENANT, () => resetLinkBase(settingsStore.get())) || resetLinkBase({ links: {} });
  const missing = [];
  if (!sso.issuer || !sso.clientId) missing.push('The identity provider\'s address and the client id are not set.');
  if (!base) missing.push('No https address for this server is set (Settings → Server address).');
  return { sso, base, redirectUri: base ? `${base}${SSO_CALLBACK_PATH}` : '', missing, ready: sso.enabled && missing.length === 0 };
}

/**
 * With single sign-on on and "only Admins may still sign in with a password": a correct password is not enough for
 * anyone else. Only those two switches decide, both an Admin's. Whether single sign-on can work right now (the
 * server's address, which others may change) never does: it could otherwise be used to bring passwords back.
 */
function passwordNotEnough(user) {
  const sso = iam.sso();
  return sso.enabled && sso.passwordAdminsOnly && user.role !== 'admin';
}

const SSO_ADDRESS_ADMIN = 'Single sign-on is on, and the identity provider sends people back to this server\'s address, so only an Admin changes it.';
const SSO_NEEDS_ADDRESS = 'Single sign-on is on, and people come back from the identity provider to this server\'s address, so it must stay an https address. Give an https address, or turn single sign-on off first (People & roles → Sign-in).';
/**
 * Why the server's address may not be changed as asked ('' when it may): while single sign-on is on, only an Admin
 * changes it, and a change that would leave no https address for the way back is refused for everyone, Admins too
 * (they turn single sign-on off first). (The first tenant's address: the one sign-in uses.)
 */
function ssoAddressProblem(req, links) {
  if (!links || !('reportServerUrl' in links) || (req.tenantId ?? DEFAULT_TENANT) !== DEFAULT_TENANT || !iam.sso().enabled) return '';
  const current = settingsStore.get();
  const next = mergeSettings(current, { links: { reportServerUrl: links.reportServerUrl } }).links.reportServerUrl;
  if (next === current.links.reportServerUrl) return '';
  // Any change moves the way back from the identity provider: that is for an Admin, who can change it there too.
  if (req.user?.role !== 'admin') return SSO_ADDRESS_ADMIN;
  return resetLinkBase({ links: { reportServerUrl: next } }) || (!next && resetLinkBase({ links: {} })) ? '' : SSO_NEEDS_ADDRESS;
}

/** One cookie by name, as readSessionCookie reads the session's. */
function readCookie(req, name) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}
const SSO_COOKIE_PATH = '/api/session/oidc';
const setSsoCookie = (req, res, value) => res.append('Set-Cookie', [`${SSO_COOKIE}=${value}`, `Path=${SSO_COOKIE_PATH}`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.round(SSO_FLOW_TTL_MS / 1000)}`, cookieShouldBeSecure(req) ? 'Secure' : ''].filter(Boolean).join('; '));
const clearSsoCookie = (res) => res.append('Set-Cookie', `${SSO_COOKIE}=; Path=${SSO_COOKIE_PATH}; HttpOnly; SameSite=Lax; Max-Age=0`);

/**
 * Back to the sign-in page with a short code, which picks the sentence the page shows (public/app.js). What went
 * wrong is written, scrubbed, in the server log and the audit log: never a token, the client secret or the
 * provider's own error text.
 */
function ssoRefused(req, res, code, why, user = null) {
  res.locals.signInRefused = true;
  if (user) res.locals.activityUser = user;
  // (Listed only so many a minute, in the audit log and in the server log: nobody has signed in here.)
  if (refusalListed(`address ${clientIp(req)}`, Date.now(), 'signIn')) {
    console.warn(`! [single sign-on] Not signed in (${code}): ${logSafe(why)}.`);
    auditAccess(req, 'refused', `Single sign-on refused${user ? ` for ${user.email}` : ''}: ${why}.`, user);
  }
  res.redirect(`/#sso=${code}`);
}

/** The "single sign-on" button: off to the identity provider, with a state, a nonce and a PKCE challenge for the way back. */
app.get(
  '/api/session/oidc/start',
  asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (tooManySignIns(req)) return res.redirect('/#sso=busy');
    const { sso, redirectUri, ready, base } = ssoState();
    if (!sso.enabled) return res.redirect('/#sso=off');
    if (!ready) return res.redirect('/#sso=setup');
    // Opened at another address than the server's own (an IP address, an old name): the round trip begins where it
    // ends, or the browser would not send its cookie on the way back. Once only (`at`), so it can never go in circles.
    const here = requestOrigin(req);
    if (req.query.at === undefined && here && new URL(here).host.toLowerCase() !== new URL(base).host.toLowerCase()) return res.redirect(`${base}/api/session/oidc/start?at=server`);
    const flow = ssoFlows.start();
    let url;
    try {
      url = await oidc.authorizationUrl(sso, redirectUri, flow);
    } catch (error) {
      if (!(error instanceof SsoError)) throw error;
      console.warn(`! [single sign-on] Could not start (${error.code}): ${logSafe(error.message)}.`);
      return res.redirect(`/#sso=${error.code}`);
    }
    setSsoCookie(req, res, flow.cookie);
    res.redirect(url);
  }),
);

/** The way back from the identity provider: the code is exchanged, the ID token verified, and the person it names signed in. */
app.get(
  SSO_CALLBACK_PATH,
  asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const one = (value) => (typeof value === 'string' ? value : '');
    const flow = ssoFlows.take(one(req.query.state), readCookie(req, SSO_COOKIE));
    // The answer to a sign-in this browser started was counted when it started. Anything else is an attempt of its own.
    if (!flow && tooManySignIns(req)) return res.redirect('/#sso=busy');
    const { sso, redirectUri, ready, base } = ssoState();
    if (!sso.enabled) return ssoRefused(req, res, 'off', 'single sign-on is turned off');
    if (!ready) return ssoRefused(req, res, 'setup', 'single sign-on is not set up completely');
    if (!flow) return ssoRefused(req, res, 'expired', 'the answer belongs to no sign-in started from this browser in the last ten minutes (state)');
    if (req.query.error !== undefined) {
      const said = /^[a-z0-9_.-]{1,60}$/i.test(one(req.query.error)) ? one(req.query.error) : 'an error';
      return ssoRefused(req, res, 'cancelled', `the identity provider answered ${said}`);
    }
    const code = one(req.query.code);
    if (!code || code.length > 4096) return ssoRefused(req, res, 'provider', 'the identity provider sent no code');
    let identity;
    try {
      identity = await oidc.finish(sso, redirectUri, { code, ...flow });
      const problem = identityProblem(sso, identity);
      if (problem) throw problem;
    } catch (error) {
      if (!(error instanceof SsoError)) throw error;
      return ssoRefused(req, res, error.code, error.message);
    }
    // Someone who has signed in this way before is the person linked to that account at the provider, whatever
    // its email address says now. Anyone else is found by email, once, and linked from then on.
    const linked = iam.findBySso(identity.issuer, identity.sub);
    let user = linked ?? iam.findByEmail(identity.email);
    if (user && !linked) {
      if (user.sso?.sub) return ssoRefused(req, res, 'link', `${user.email} is linked to another account at the identity provider (reset the single sign-on link under People & roles if that account was made anew)`, user);
      // Whatever the "verified" switch says: people who may manage people are never linked on an address the provider does not vouch for.
      if (!identity.verified && iam.permissionsOf({ ...user, disabled: false }).has('iam.manage')) {
        return ssoRefused(req, res, 'email', `the identity provider does not mark ${identity.email} as verified, and someone who may manage people is not signed in on such an address until they are linked`, user);
      }
    }
    if (!user && sso.provision === 'create') {
      // (The same rule for someone about to be added with a role that may manage people.)
      if (!identity.verified && iam.permissionsOf({ role: sso.role, disabled: false }).has('iam.manage')) {
        return ssoRefused(req, res, 'email', `the identity provider does not mark ${identity.email} as verified, and nobody is added with a role that may manage people on such an address`);
      }
      // An Admin chose to add people the identity provider signs in, with this role (never Admin: src/oidc.js).
      const added = await iam.createUser({ email: identity.email, name: identity.name, role: sso.role, mustChangePassword: false });
      audit.record({ type: 'iam', outcome: 'changed', reason: `Added ${added.email} as ${iam.role(added.role)?.name ?? added.role} at their first single sign-on.`, actor: SYSTEM_ACTOR, details: { user: added } });
      user = iam.user(added.id);
    }
    if (!user) return ssoRefused(req, res, 'unknown', `${identity.email} is not in People & roles`);
    if (user.disabled) return ssoRefused(req, res, 'disabled', 'the account is disabled', user);
    if (!linked) {
      iam.linkSso(user.id, identity);
      audit.record({ type: 'iam', outcome: 'changed', reason: `${user.email} was linked to their account at the identity provider at their first single sign-on.`, actor: resetActor(req, user.email) });
      user = iam.user(user.id);
    }
    iam.recordSignIn(user);
    openPasswordSession(req, res, user, 'signed in with single sign-on', 'sso');
    clearSsoCookie(res);
    res.redirect(`${base}/`);
  }),
);

// ---------------------------------------------------------------------------
// Forgotten password: a one-time link to the account's own email (src/password-reset.js)
// ---------------------------------------------------------------------------

const passwordResets = new PasswordResets();
/** Links being used right now, so one link cannot set two passwords at once. */
const resetsInFlight = new Set();
const RESET_ASKED = 'If that address has an account that may reset its password here, a link to choose a new one is on its way. It works once, for 30 minutes. Nothing arrived? Check spam, or ask an administrator.';
const RESET_DEAD = 'This link no longer works: it was used, a newer one was sent, it is more than 30 minutes old, or the password has changed since. Ask for a new one.';

/**
 * The address reset links point at: only the one set for this server (Settings → Server address,
 * or REPORT_SERVER_URL / PUBLIC_URL), never the address a request came in on, which anyone can
 * forge to steer the link (and its secret) to their own site. https, unless it is this computer.
 */
function resetLinkBase(settings) {
  const url = String(settings.links?.reportServerUrl || config.reportServerUrl || '');
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOOPBACK.test(parsed.hostname))) return url.replace(/\/+$/, '');
  } catch {}
  return '';
}

/** Whether "Forgot your password?" can work, and if not why (the main tenant's email and address). */
function passwordResetReady() {
  return tenancy.run(DEFAULT_TENANT, () => {
    const settings = settingsStore.get();
    const policy = iam.passwordResetPolicy();
    const missing = [];
    if (policy === 'off') missing.push('Turned off.');
    if (!isVerified(settings)) missing.push('The email server is not set up and tested (Settings → Email server).');
    if (!resetLinkBase(settings)) missing.push('No https address for this server is set (Settings → Server address).');
    return { ready: missing.length === 0, policy, missing };
  });
}

/** Admins (who may manage people or tenants) can be kept out of resetting by email. */
const managesPeople = (user) => {
  const held = iam.permissionsOf({ ...user, disabled: false });
  return held.has('iam.manage') || held.has('tenants.manage');
};

const resetActor = (req, email = '') => ({ kind: 'user', user: email, ip: clientIp(req), userAgent: String(req.get('user-agent') ?? '').slice(0, 200) });
const utc = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** Look the person up and send the link, after the answer was given (so timing says nothing). */
async function sendResetLink(email, req) {
  const user = iam.findByEmail(email);
  const settings = settingsStore.get();
  const base = resetLinkBase(settings);
  const why = !user
    ? 'no account has that address'
    : user.disabled
      ? 'the account is disabled'
      : !user.passwordHash
        ? 'the account signs in with a Checkmarx One key only'
        : !resetAllowed(iam.passwordResetPolicy(), { isAdmin: managesPeople(user) })
          ? 'resetting by email is not allowed for this account'
          : user.email.toLowerCase() === MAINTAINER_EMAIL.toLowerCase()
            ? 'this address is never emailed by the server'
            : !base || !isVerified(settings)
              ? 'email or the server address is not set up'
              : !passwordResets.maySend(user.id)
                ? 'too many links for this account in the last hour'
                : '';
  if (why) {
    // What was typed is kept only when it is an account here: it may be a password typed in the wrong box.
    auditAccess(req, 'refused', `Password reset asked${user ? ` for ${user.email}` : ' for an address with no account here'}: no link sent (${why}).`, user);
    return;
  }
  const { token, exp } = passwordResets.issue(user);
  const appName = appNameNow();
  // The secret travels after #: browsers never send that part to a server, nor in a Referer.
  const link = `${base}/#reset=${token}`;
  const message = systemEmail({
    appName,
    subject: `Reset your ${appName} password`,
    lines: [
      `Someone, hopefully you, asked to reset the password of ${user.email} on ${appName}.`,
      'To choose a new password, open the link below. It works once, for 30 minutes, and only on this server.',
    ],
    facts: [['Asked from', clientIp(req) || 'unknown'], ['Asked at', utc(Date.now())], ['Link works until', utc(exp)]],
    buttons: [{ label: 'Choose a new password', url: link }],
    footer: 'Did not ask for this? Ignore this email: your password stays as it is, and the link stops working by itself. If it keeps happening, tell an administrator.',
    replyHelp: false,
  });
  try {
    await sendReminderMail(settings, message, { exact: true, to: [user.email] });
    auditAccess(req, 'info', `Password reset link sent to ${user.email} (works until ${utc(exp)}).`, user);
  } catch (error) {
    passwordResets.revokeUser(user.id);
    auditAccess(req, 'failed', `Password reset link for ${user.email} could not be sent: ${error.message}`, user);
  }
}

/** "Forgot your password?": always the same answer, whether or not the address has an account. */
app.post('/api/session/password-reset', (req, res) => {
  if (passwordResets.ipBlocked(clientIp(req))) return res.status(429).json({ error: 'Too many requests from this address. Wait a quarter of an hour.' });
  passwordResets.noteIp(clientIp(req));
  const email = String(req.body?.email ?? '').trim().slice(0, 254);
  if (!email) return res.status(400).json({ error: 'Enter the email address you sign in with.' });
  res.status(202).json({ message: RESET_ASKED });
  setImmediate(() =>
    tenancy.run(DEFAULT_TENANT, () => sendResetLink(email, req)).catch((error) => console.error(`[password reset] ${error.message}`)),
  );
});

/** Does a link still work? Says whose account it is for (partly hidden), so the person knows. */
app.post('/api/session/password-reset/check', (req, res) => {
  if (passwordResets.ipBlocked(clientIp(req))) return res.status(429).json({ error: 'Too many requests from this address. Wait a quarter of an hour.' });
  const user = passwordResets.check(req.body?.token, (id) => iam.user(id));
  if (!user || !resetAllowed(iam.passwordResetPolicy(), { isAdmin: managesPeople(user) })) {
    passwordResets.noteIp(clientIp(req));
    return res.status(400).json({ error: RESET_DEAD });
  }
  res.json({ email: maskEmail(user.email), minutes: Math.round(RESET_TTL_MS / 60_000) });
});

/** Choose the new password: the link is used up, and every session of the account ends. */
app.post(
  '/api/session/password-reset/confirm',
  asyncRoute(async (req, res) => {
    if (passwordResets.ipBlocked(clientIp(req))) return res.status(429).json({ error: 'Too many requests from this address. Wait a quarter of an hour.' });
    const token = String(req.body?.token ?? '');
    const password = String(req.body?.password ?? '');
    const user = passwordResets.check(token, (id) => iam.user(id));
    if (!user || !resetAllowed(iam.passwordResetPolicy(), { isAdmin: managesPeople(user) })) {
      passwordResets.noteIp(clientIp(req));
      return res.status(400).json({ error: RESET_DEAD });
    }
    if (resetsInFlight.has(user.id)) return res.status(409).json({ error: 'This link is already being used. Wait a moment.' });
    resetsInFlight.add(user.id);
    try {
      const problem = passwordProblem(password);
      if (problem) return res.status(400).json({ error: problem });
      if (await iam.isCurrentPassword(user.id, password)) return res.status(400).json({ error: 'Choose a password different from the current one.' });
      passwordResets.consume(token);
      await iam.setPassword(user.id, password, { mustChange: false });
      passwordResets.revokeUser(user.id);
      // Whoever was signed in as them, maybe the person who made the reset necessary, is signed out.
      endSessionsOf(user.id);
      audit.record({ type: 'iam', outcome: 'changed', reason: `${user.email} reset their password with an emailed link.`, actor: resetActor(req, user.email) });
      const appName = appNameNow();
      const settings = tenancy.run(DEFAULT_TENANT, () => settingsStore.get());
      sendReminderMail(
        settings,
        systemEmail({
          appName,
          subject: `Your ${appName} password was changed`,
          lines: [`The password of ${user.email} on ${appName} was just changed with a reset link sent to this address, and every place it was signed in was signed out.`],
          facts: [['Changed from', clientIp(req) || 'unknown'], ['Changed at', utc(Date.now())]],
          footer: 'Was this not you? Tell an administrator at once: they can disable the account and set a new password.',
          replyHelp: false,
        }),
        { exact: true, to: [user.email] },
      ).catch((error) => console.error(`[password reset] The confirmation to ${user.email} could not be sent: ${error.message}`));
      res.json({ email: user.email });
    } finally {
      resetsInFlight.delete(user.id);
    }
  }),
);

/** Who may reset a forgotten password by email: for the whole server, so a Super Admin's when there are several tenants. */
app.put('/api/iam/policy', requirePermission('iam.manage'), (req, res) => {
  if (tenancy.enabled && !isSuperAdmin(req.permissions)) return res.status(403).json({ error: 'Sign-in rules are for the whole server: a Super Admin changes them.' });
  const { before, after } = iam.setPasswordResetPolicy(String(req.body?.passwordReset ?? ''));
  if (before !== after) {
    audit.record({ type: 'iam', outcome: 'changed', reason: `Password reset by email: ${RESET_POLICY_NAMES[before]} → ${RESET_POLICY_NAMES[after]}.`, actor: { kind: 'user', user: req.user.email, ip: clientIp(req) } });
  }
  res.json(passwordResetReady());
});
const RESET_POLICY_NAMES = { everyone: 'everyone', 'not-admins': 'everyone but Admins', off: 'off' };

/** Two-step sign-in for everyone and single sign-on are an Admin's to set (the Admin role), for the whole server. */
const maySetSignInSecurity = (req) => can(req, 'iam.manage') && req.user.role === 'admin' && (!tenancy.enabled || isSuperAdmin(req.permissions));

/** What the Admin's Sign-in page shows of them: never the client secret, only whether one is set. */
function signInSecurityView() {
  const { sso, redirectUri, missing } = ssoState();
  return {
    twoStepRequired: iam.twoStepRequired(),
    sso: publicSso(sso),
    redirectUri,
    missing,
    // The roles people added by single sign-on may be given: every role but Admin.
    roles: iam.roles().filter((r) => r.id !== 'admin').map((r) => ({ id: r.id, name: r.name })),
  };
}

app.put(
  '/api/iam/sign-in',
  requirePermission('iam.manage'),
  asyncRoute(async (req, res) => {
    if (!maySetSignInSecurity(req)) return res.status(403).json({ error: tenancy.enabled && req.user.role === 'admin' ? 'Sign-in rules are for the whole server: a Super Admin changes them.' : 'Only an Admin changes two-step sign-in for everyone and single sign-on.' });
    const body = req.body ?? {};
    if ('twoStepRequired' in body) {
      const { before, after } = iam.setTwoStepRequired(body.twoStepRequired === true);
      if (before !== after) await auditIam(req, `Two-step sign-in for everyone who signs in with a password: ${before ? 'required' : 'not required'} → ${after ? 'required' : 'not required'}.`);
    }
    if (body.sso && typeof body.sso === 'object') {
      const next = mergeSso(iam.sso(), body.sso, { roles: iam.roles().filter((r) => r.id !== 'admin').map((r) => r.id) });
      const { before, after } = iam.setSso(next);
      const changed = ssoChanges(before, after);
      if (changed.length) {
        oidc.forget();
        // (The client secret is never part of the log: only that it changed, and whether one is set.)
        await auditIam(req, `Changed single sign-on: ${changed.join(', ')}.`, { before: publicSso(before), after: publicSso(after) });
      }
      // Another identity provider: the links to people's accounts at the old one mean nothing there.
      if (before.issuer.replace(/\/+$/, '') !== after.issuer.replace(/\/+$/, '')) {
        const cleared = iam.clearSsoLinks();
        if (cleared) await auditIam(req, `The identity provider changed: the single sign-on links of ${cleared} ${cleared === 1 ? 'person' : 'people'} were reset. Each is linked again at their next single sign-on.`);
      }
    }
    res.json(iamView(req));
  }),
);

/** The Admin's "Check" button: can the identity provider be reached as set, through this server's proxy and trusted certificates? */
app.post(
  '/api/iam/sign-in/sso/check',
  requirePermission('iam.manage'),
  asyncRoute(async (req, res) => {
    if (!maySetSignInSecurity(req)) return res.status(403).json({ error: 'Only an Admin checks single sign-on.' });
    const { sso, missing } = ssoState();
    if (!sso.issuer) return res.json({ ok: false, message: 'Give the identity provider\'s address first, and save.' });
    const result = await oidc.check(sso);
    res.json({ ok: result.ok && !missing.length, message: [result.message, ...(result.ok ? missing : [])].join(' ') });
  }),
);

/**
 * Reset someone's link to their account at the identity provider (it was made anew there, so its subject changed):
 * their next single sign-on links them again, by their email address. One's own included.
 */
app.delete(
  '/api/iam/users/:id/sso-link',
  requirePermission('iam.manage'),
  asyncRoute(async (req, res) => {
    const target = visibleUser(req, req.params.id);
    if (!iam.canGrant(req.permissions, iam.permissionsOf({ ...target, disabled: false }))) {
      return res.status(403).json({ error: 'You cannot reset this person\'s single sign-on link: their role holds permissions you do not have.' });
    }
    if (iam.unlinkSso(target.id)) await auditIam(req, `Reset the single sign-on link of ${target.email}.`);
    res.json(iamView(req));
  }),
);

/** An Admin takes someone's two-step sign-in off (a lost phone): they set it up again themselves, at once when it is required. */
app.delete(
  '/api/iam/users/:id/two-step',
  requirePermission('iam.manage'),
  asyncRoute(async (req, res) => {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Turn your own two-step sign-in off under Settings → Your profile.' });
    const target = visibleUser(req, req.params.id);
    if (!iam.canGrant(req.permissions, iam.permissionsOf({ ...target, disabled: false }))) {
      return res.status(403).json({ error: 'You cannot reset this person\'s two-step sign-in: their role holds permissions you do not have.' });
    }
    if (iam.resetTwoStep(target.id)) {
      signInTickets.revokeUser(target.id);
      pendingSetups.clear(target.id);
      await auditIam(req, `Reset two-step sign-in for ${target.email}.`);
    }
    res.json(iamView(req));
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
      res.locals.activityUser = { email: seen };
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
    res.locals.activityUser = user;
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
  if (session?.userId) res.locals.activityUser = iam.user(session.userId);
  // Never the integration: signing out ends only this person's session.
  if (id && id !== tstate.automationSessionId && id !== tstate.bootstrapSessionId) sessions.destroy(id);
  clearSessionCookie(res);
  res.json({ connected: false, signedIn: false });
});

app.get('/api/me', requireSession, (req, res) => res.json(describeMe(req.session, req.user)));

/** A page or tab someone opened, or an action done in the page alone (the PDF summary): User activity. */
app.post('/api/activity', requireSession, (req, res) => {
  const kind = req.body?.kind === 'event' ? 'event' : 'page';
  const name = String(req.body?.name ?? '').trim();
  if (!/^[\w .,:/#&()'’›→-]{1,80}$/u.test(name)) return res.status(400).json({ error: 'Not a page or action name.' });
  activity.record({ user: req.user.email, name: req.user.name ?? '', role: iam.role(req.user.role)?.name ?? req.user.role, ip: clientIp(req), kind, action: kind === 'page' ? `Opened ${name}` : name, route: '/api/activity', method: 'POST', status: 204 });
  res.status(204).end();
});

/** What people did here, newest first: for those who may see the audit log. */
app.get('/api/activity', requirePermission('audit.view'), (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(activity.list({ limit: req.query.limit, offset: req.query.offset, user: String(req.query.user ?? ''), q: String(req.query.q ?? ''), kind: String(req.query.kind ?? ''), from: String(req.query.from ?? ''), to: String(req.query.to ?? '') }));
});

app.get('/api/activity/export', requirePermission('audit.view'), (req, res) => {
  res.set('Content-Disposition', `attachment; filename="user-activity-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.type('text/csv').send(activity.csv());
});

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
    const name = cleanName(req.body?.organisationName);
    if (!name && !terms.organisationName()) return res.status(400).json({ error: 'Write your organisation’s name: it goes on the projection reports and other documents CxMissionZero makes.' });
    terms.acceptForOrganisation({ by: req.user.email, ip: clientIp(req), name });
    audit.record({ type: 'access', outcome: 'changed', reason: `Terms of use v${terms.version} accepted for the organisation by ${req.user.email}${name ? ` (organisation name: ${name})` : ''}.`, actor, details: { terms: { version: terms.version, hash: terms.hash, scope: 'organisation' } } });
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
    // Signed in by single sign-on, with no password here: they cannot give themselves one (it would outlast
    // their account at the identity provider). An Admin sets one for them under People & roles.
    if (!user.passwordHash && req.session.via === 'sso') {
      return res.status(403).json({ error: 'You signed in with single sign-on and have no password here, so you cannot set one yourself. An administrator can give you one under People & roles.' });
    }
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
 * One's own profile: name, language, time zone, programming languages and Impact figures. A time zone picked up
 * from the computer by itself (quiet) is stored without an audit entry; everything else is audited.
 */
app.put(
  '/api/me/profile',
  requireSession,
  asyncRoute(async (req, res) => {
    const patch = {};
    for (const key of ['name', 'language', 'timeZone', 'timeZoneAuto', 'programmingLanguages', 'impact', 'look', 'theme', 'accent', 'scanColours']) if (key in (req.body ?? {})) patch[key] = req.body[key];
    if (patch.language && !languageAccess.isAvailable(String(patch.language), allowedLanguages(req.user.id))) return res.status(400).json({ error: 'That language is not available.' });
    const { before, after } = iam.updateProfile(req.user.id, patch);
    const changed = [
      ...(before.name !== after.name ? ['name'] : []),
      ...Object.keys(after.profile).filter((k) => JSON.stringify(before.profile[k]) !== JSON.stringify(after.profile[k])),
    ];
    // How the app looks to them (look, light or dark, accent, Fusion and LAST colours) is theirs alone: never an audit entry.
    const appearance = ['look', 'theme', 'accent', 'scanColours'];
    const quiet = changed.every((k) => appearance.includes(k)) || (req.body?.quiet === true && changed.every((k) => k === 'timeZone' || k === 'language'));
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

app.get('/api/me/profile/options', requireSession, (req, res) => res.json({ languages: PROFILE_LANGUAGES.filter((code) => languageAccess.isAvailable(code, allowedLanguages(req.user.id))), programmingLanguages: PROGRAMMING_LANGUAGES }));

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
    permissions: PERMISSIONS.filter((p) => !dormantPermissions().includes(p.id)),
    // Whether this person may add roles (New role, Duplicate): the matrix shows the buttons only then.
    rolesChangeable: can(req, 'iam.manage') && mayChangeRoles(req),
    me: { id: req.user.id, permissions: [...req.permissions] },
    tenants: tenancy.enabled && isSuperAdmin(req.permissions) ? tenancy.list().map((t) => ({ id: t.id, name: tenantName(t.id) })) : null,
    signIn: can(req, 'iam.manage') ? { ...passwordResetReady(), canChange: !tenancy.enabled || isSuperAdmin(req.permissions), security: maySetSignInSecurity(req) ? signInSecurityView() : null } : null,
    // Labs → Consolidated view: an Admin ticks who may see it, once its activation code is in force.
    consolidatedGrant: !featureLocked(featureById('consolidated')) && can(req, 'iam.manage') && req.user.role === 'admin',
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
  // A sign-in waiting for its two-step code ends too.
  signInTickets.revokeUser(userId);
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

/**
 * An Admin edits someone's profile: their sign-in email, name, language, time zone, programming
 * languages, Impact figures and look. Only people whose permissions the Admin holds all of (the
 * same rule as changing their role), never themselves (that is Your profile). A new email ends any
 * reset link sent to the old one, and both addresses are told.
 */
const ADMIN_PROFILE_FIELDS = ['name', 'language', 'timeZone', 'timeZoneAuto', 'programmingLanguages', 'impact', 'look', 'theme', 'accent', 'scanColours'];
function managedUser(req) {
  const user = visibleUser(req, req.params.id);
  if (user.id === req.user.id) throw Object.assign(new Error('Change your own profile under Settings → Your profile.'), { status: 400 });
  if (!iam.canGrant(req.permissions, iam.permissionsOf({ ...user, disabled: false }))) {
    throw Object.assign(new Error('You cannot change this person: their role holds permissions you do not have.'), { status: 403 });
  }
  return user;
}
const managedView = (req, id) => {
  const user = iam.users().find((u) => u.id === id);
  return { user: { ...user, canManage: true, roleName: iam.role(user.role)?.name ?? user.role } };
};

app.get('/api/iam/users/:id/profile', requirePermission('iam.manage'), (req, res) => {
  const user = managedUser(req);
  res.json({ ...managedView(req, user.id), languages: languageAccess.available(allowedLanguages(user.id)) });
});

app.put(
  '/api/iam/users/:id/profile',
  requirePermission('iam.manage'),
  asyncRoute(async (req, res) => {
    const target = managedUser(req);
    const body = req.body ?? {};
    const patch = {};
    for (const key of ADMIN_PROFILE_FIELDS) if (key in body) patch[key] = body[key];
    if (patch.language && !languageAccess.isAvailable(String(patch.language), allowedLanguages(target.id))) return res.status(400).json({ error: 'That language is not available to this person.' });
    // Checked whole before anything is saved, so a bad field never leaves half a change behind.
    cleanProfile(patch);
    let email = null;
    if ('email' in body) email = iam.changeEmail(target.id, String(body.email ?? ''), actorOf(req));
    const { before, after } = Object.keys(patch).length ? iam.updateProfile(target.id, patch) : { before: publicUser(iam.user(target.id)), after: publicUser(iam.user(target.id)) };
    const changed = Object.keys(patch).filter((k) => JSON.stringify(k === 'name' ? before.name : before.profile[k]) !== JSON.stringify(k === 'name' ? after.name : after.profile[k]));
    const emailChanged = email && email.before !== email.after;
    if (emailChanged || changed.length) {
      const what = [emailChanged ? `email ${email.before} → ${email.after}` : '', ...changed].filter(Boolean).join(', ');
      await auditIam(req, `Changed ${emailChanged ? email.before : after.email}'s profile: ${what}.`, { before, after: publicUser(iam.user(target.id)) });
    }
    if (emailChanged) {
      // A reset link sent to the old address must not reset the account now that it is someone else's.
      passwordResets.revokeUser(target.id);
      tellEmailChanged(email.before, email.after, req.user.email);
    }
    res.json(managedView(req, target.id));
  }),
);

app.put(
  '/api/iam/users/:id/avatar',
  requirePermission('iam.manage'),
  asyncRoute(async (req, res) => {
    const target = managedUser(req);
    const after = iam.setAvatar(target.id, String(req.body?.image ?? ''));
    await auditIam(req, `${after.avatarAt ? 'Changed' : 'Removed'} ${after.email}'s picture.`);
    res.json(managedView(req, target.id));
  }),
);

/** Both addresses hear about a changed sign-in email (best effort: only when email is set up). */
function tellEmailChanged(before, after, by) {
  const settings = tenancy.run(DEFAULT_TENANT, () => settingsStore.get());
  if (!isVerified(settings)) return;
  const appName = appNameNow();
  const notes = [
    [before, `The sign-in email of your ${appName} account was changed from ${before} to ${after} by ${by}. From now on you sign in with ${after}, and links and reminders go there.`],
    [after, `This address now signs in to ${appName}: ${by} changed the account's email from ${before} to ${after}.`],
  ];
  for (const [to, line] of notes) {
    if (to.toLowerCase() === MAINTAINER_EMAIL.toLowerCase()) continue;
    sendReminderMail(
      settings,
      systemEmail({ appName, subject: `Your ${appName} sign-in email was changed`, lines: [line], facts: [['Changed at', utc(Date.now())]], footer: 'Not expected? Tell an administrator at once.', replyHelp: false }),
      { exact: true, to: [to] },
    ).catch((error) => console.error(`[profile] Could not tell ${to} about the new email: ${error.message}`));
  }
}

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
    // A permission not listed right now (Hebrew while its code is not in force) keeps what the role had.
    const dormant = dormantPermissions();
    const held = iam.role(req.params.id)?.permissions ?? [];
    const asked = Array.isArray(req.body?.permissions) ? req.body.permissions : [];
    const body = { ...(req.body ?? {}), permissions: [...asked.filter((p) => !dormant.includes(p)), ...held.filter((p) => dormant.includes(p))] };
    const { before, after } = iam.saveRole(req.params.id, body, actorOf(req));
    const added = after.permissions.filter((p) => !before.permissions.includes(p));
    const removed = before.permissions.filter((p) => !after.permissions.includes(p));
    if (before.name !== after.name) await auditIam(req, `Renamed role "${before.name}" to "${after.name}".`, { before: { id: after.id, name: before.name }, after: { id: after.id, name: after.name } });
    if (added.length || removed.length || before.description !== after.description) {
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
// Certificates outgoing HTTPS trusts (src/trust.js): a server that left out its
// intermediate is completed on its own; a company proxy's root is shown to an
// Admin to trust, or uploaded. Applied at once, no restart.
// ---------------------------------------------------------------------------

/** The "not trusted" TLS code somewhere in an error's causes (fetch wraps it twice). */
function untrustedCode(error) {
  for (let e = error, depth = 0; e && depth < 5; e = e.cause, depth++) if (isUntrustedCode(e.code)) return e.code;
  return '';
}

/** The Checkmarx One hosts a key connects to: IAM, then the API. */
function cxHosts(apiKey, endpoints = {}) {
  try {
    const c = deriveConnection(apiKey, endpoints);
    return [...new Set([c.iamUrl, c.baseUrl].filter(Boolean))].map((u) => {
      const url = new URL(u);
      return { host: url.hostname, port: Number(url.port) || 443 };
    });
  } catch {
    return [];
  }
}

/**
 * Why `hosts` are not trusted, when `error` says so: a server that left out its intermediate is
 * completed ("repaired"); otherwise what an Admin is shown ("needs-consent" with the root found,
 * "needs-upload" with the issuer's name). null when the error was something else.
 */
async function certificateTrouble(error, hosts) {
  if (!untrustedCode(error)) return null;
  let repaired = null;
  for (const { host, port } of hosts) {
    let found;
    try {
      found = await trust.diagnose(host, port);
    } catch (cause) {
      return { status: 'unknown', host, port, error: cause.message };
    }
    if (found.status === 'repaired') {
      repaired = found;
      audit.record({ type: 'settings', outcome: 'changed', reason: `${host} left out its intermediate certificate: fetched ${found.added.map((a) => `"${a.subject}"`).join(', ')} from its issuer, which a trusted root vouches for.`, actor: SYSTEM_ACTOR, details: { host, port, added: found.added } });
    } else if (found.status !== 'trusted') {
      return found;
    }
  }
  return repaired;
}

/** Connect to Checkmarx One with a key; a certificate chain that could be completed is, and tried once more. */
async function connectCheckmarxOne(apiKey, endpoints) {
  try {
    return await withTimeout(sessions.create(apiKey, endpoints), 'Checkmarx One');
  } catch (error) {
    const found = await certificateTrouble(error, cxHosts(apiKey, endpoints));
    if (found?.status === 'repaired') return withTimeout(sessions.create(apiKey, endpoints), 'Checkmarx One');
    if (found) error.certificate = found;
    throw error;
  }
}

const SERVER_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
function trustTarget(body) {
  const host = String(body?.host ?? '').trim().toLowerCase();
  const port = Number(body?.port ?? 443);
  if (!SERVER_NAME.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw Object.assign(new Error('Give a server name and port, for example eu.iam.checkmarx.net and 443.'), { status: 400 });
  return { host, port };
}
/** Trusted certificates are the whole server's: changed from the first tenant only. */
function refuseOtherTenants(req, res) {
  if (mayChangeRoles(req)) return false;
  res.status(403).json({ error: 'Trusted certificates apply to the whole server, so only people who work in the first tenant change them.' });
  return true;
}
const TRUST_EDIT = ['integration.cxone', 'integration.smtp'];

app.get('/api/trust', requirePermission('settings.view', ...TRUST_EDIT), (req, res) => res.set('Cache-Control', 'no-store').json({ certificates: trust.list() }));

/** Trust the root a server presents, by the fingerprint the Admin was shown (looked up again here). */
app.post(
  '/api/trust/presented',
  requirePermission(...TRUST_EDIT),
  asyncRoute(async (req, res) => {
    if (refuseOtherTenants(req, res)) return;
    const { host, port } = trustTarget(req.body);
    const actor = await adminActor(req);
    const done = await trust.trustPresented(host, port, String(req.body?.fingerprint256 ?? ''), { by: actor.user });
    if (done.added.length) audit.record({ type: 'settings', outcome: 'changed', reason: `Trusted the certificate ${host} presents: ${done.added.map((a) => `"${a.subject}"`).join(', ')}.`, actor, details: { host, port, added: done.added } });
    res.json({ ...done, certificates: trust.list() });
  }),
);

/** Upload certificate authorities; with the server that failed, only those its chain needs are kept. */
app.post(
  '/api/trust/upload',
  requirePermission(...TRUST_EDIT),
  asyncRoute(async (req, res) => {
    if (refuseOtherTenants(req, res)) return;
    const data = String(req.body?.data ?? '');
    if (!data.trim()) return res.status(400).json({ error: 'Choose a certificate file (.pem, .crt or .cer).' });
    if (data.length > 3_000_000) return res.status(413).json({ error: 'That file is too large for certificates (3 MB at most).' });
    const target = req.body?.host ? trustTarget(req.body) : null;
    const chain = target ? await trust.presented(target.host, target.port).catch(() => null) : null;
    const actor = await adminActor(req);
    const added = trust.upload(data, { by: actor.user, chain, host: target?.host ?? '' });
    if (added.length) audit.record({ type: 'settings', outcome: 'changed', reason: `Trusted uploaded certificate${added.length === 1 ? '' : 's'}: ${added.map((a) => `"${a.subject}"`).join(', ')}.`, actor, details: { host: target?.host ?? '', added } });
    const now = target ? await trust.diagnose(target.host, target.port, { repair: false }).catch(() => null) : null;
    res.json({ added, trusted: now ? now.status === 'trusted' : null, certificates: trust.list() });
  }),
);

app.delete(
  '/api/trust/:fingerprint',
  requirePermission(...TRUST_EDIT),
  asyncRoute(async (req, res) => {
    if (refuseOtherTenants(req, res)) return;
    const removed = trust.remove(String(req.params.fingerprint));
    if (!removed) return res.status(404).json({ error: 'That certificate is not in the list.' });
    audit.record({ type: 'settings', outcome: 'changed', reason: `No longer trusts the certificate "${removed.subject}".`, actor: await adminActor(req), details: { removed } });
    res.json({ certificates: trust.list() });
  }),
);

// ---------------------------------------------------------------------------
// Network & proxy (src/network.js): how this server reaches the internet, a check that
// says where a connection stops, and the sheet a network team needs. Server-wide.
// ---------------------------------------------------------------------------

/** Set when the proxy was saved or removed: it is used from the next start, which follows at once when supervised. */
let networkChangedAt = '';

/** The Checkmarx One hosts this server uses: the stored key's, the environment's, else the one typed. */
function networkTargets(typed = '') {
  const settings = settingsStore.get();
  const known = [
    ...(settings.automationApiKey ? cxHosts(settings.automationApiKey, integrationOverrides(settings)) : []),
    ...(config.bootstrapApiKey ? cxHosts(config.bootstrapApiKey, config.overrides) : []),
  ];
  const text = String(typed ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  if (text) {
    const [host, port] = text.split(':');
    if (!SERVER_NAME.test(host)) throw Object.assign(new Error('Give a Checkmarx One address, for example ind.iam.checkmarx.net.'), { status: 400 });
    return [{ host, port: Number(port) || 443 }];
  }
  const seen = new Set();
  return known.filter((t) => !seen.has(t.host) && seen.add(t.host));
}

/** Git hosts with a token: the ones code authors are read from. */
function gitHosts(settings) {
  const out = [];
  const github = githubConfig(settings);
  if (github.token) out.push({ label: 'GitHub', host: hostOfUrl(github.apiUrl) });
  for (const [id, cfg] of Object.entries(scmConfigs(settings))) {
    const url = [cfg?.apiUrl, cfg?.orgUrl].find((u) => /^https?:\/\//.test(u ?? ''));
    if (cfg?.token && url) out.push({ label: SCM_LABELS[id] ?? id, host: hostOfUrl(url) });
  }
  return out;
}

/** The identity provider's host and port, while single sign-on is on: one more connection for the network team's sheet. */
function ssoHost() {
  const sso = iam.sso();
  if (!sso.enabled) return null;
  try {
    const url = new URL(sso.issuer);
    return { host: url.hostname, port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80) };
  } catch {
    return null;
  }
}

function networkView() {
  const settings = settingsStore.get();
  const proxy = activeProxy(dataDir);
  let letsEncrypt = Boolean(LETSENCRYPT_DOMAIN);
  try {
    letsEncrypt ||= Boolean(acme.status()?.issued);
  } catch {}
  const rows = requirements({
    checkmarxOne: networkTargets(),
    smtp: settings.smtp?.host ? { host: settings.smtp.host, port: settings.smtp.port } : null,
    backupMail: backupMailbox.email && backupMailbox.host ? { host: backupMailbox.host, port: backupMailbox.port } : null,
    git: gitHosts(settings),
    sso: ssoHost(),
    letsEncrypt,
    updates: updates.supervised,
    inboundPort: Number(process.env.HTTPS_PUBLIC_PORT || process.env.PORT) || 3000,
    proxy,
  });
  const saved = readNetwork(dataDir);
  return {
    proxy: proxy ? { ...proxy, hasPassword: Boolean(saved?.proxy?.password) } : null,
    changedAt: networkChangedAt,
    supervised: updates.supervised,
    targets: networkTargets(),
    requirements: rows,
    text: requirementsText(rows, { proxy }),
  };
}

/** The proxy typed in the form, with the saved password when the same user leaves it blank. */
function typedProxy(body) {
  if (!String(body?.url ?? '').trim()) return null;
  const typed = cleanProxy(body);
  const saved = readNetwork(dataDir)?.proxy;
  if (typed.username && !typed.password && saved?.username === typed.username && saved.url === typed.url) typed.password = saved.password;
  return typed;
}

app.get('/api/network', requirePermission('settings.view', ...TRUST_EDIT), (req, res) => res.set('Cache-Control', 'no-store').json(networkView()));

/** Check the way to Checkmarx One with the proxy typed (or directly), step by step, before anything is saved. */
app.post(
  '/api/network/check',
  requirePermission(...TRUST_EDIT),
  asyncRoute(async (req, res) => {
    const proxy = typedProxy(req.body);
    const targets = networkTargets(req.body?.target);
    if (!targets.length) return res.status(400).json({ error: 'Give the Checkmarx One address to check, for example ind.iam.checkmarx.net (the IAM address of your region).' });
    const results = [];
    for (const t of targets) results.push(await checkRoute({ proxy: proxy ? proxyWithAuth(proxy) : '', host: t.host, port: t.port }));
    res.json({ ok: results.every((r) => r.ok), via: proxy ? proxy.url : 'direct', results });
  }),
);

/** Save the proxy (after the same check) and restart the server to use it. */
app.put(
  '/api/network',
  requirePermission(...TRUST_EDIT),
  asyncRoute(async (req, res) => {
    if (refuseOtherTenants(req, res)) return;
    const proxy = typedProxy(req.body);
    if (!proxy) return res.status(400).json({ error: 'Give the proxy as host:port, for example proxy.acme.local:8080.' });
    const targets = networkTargets(req.body?.target);
    const results = [];
    for (const t of targets) results.push(await checkRoute({ proxy: proxyWithAuth(proxy), host: t.host, port: t.port }));
    // A proxy that cannot be reached, or refuses Checkmarx One, is not saved: it would only stop what works.
    const blocked = results.find((r) => r.steps.some((s) => !s.ok && (s.step === 'proxy' || s.step === 'tunnel')));
    if (blocked) return res.status(422).json({ error: 'Not saved: Checkmarx One could not be reached through this proxy.', results });
    const actor = await adminActor(req);
    saveNetwork(dataDir, { proxy, changedAt: new Date().toISOString(), changedBy: actor.user });
    networkChangedAt = new Date().toISOString();
    audit.record({ type: 'settings', outcome: 'changed', reason: `Outgoing connections now go through the proxy ${proxy.url}${proxy.username ? ` (signing in as ${proxy.username})` : ''}.`, actor, details: { url: proxy.url, username: proxy.username, noProxy: proxy.noProxy } });
    if (updates.supervised) setTimeout(() => updates.switchTo({ type: 'restart', by: actor.user }), 600).unref?.();
    res.json({ ...networkView(), results, restarting: updates.supervised });
  }),
);

app.delete(
  '/api/network',
  requirePermission(...TRUST_EDIT),
  asyncRoute(async (req, res) => {
    if (refuseOtherTenants(req, res)) return;
    if (!readNetwork(dataDir)) return res.status(404).json({ error: 'No proxy is set here.' });
    const actor = await adminActor(req);
    saveNetwork(dataDir, null);
    networkChangedAt = new Date().toISOString();
    audit.record({ type: 'settings', outcome: 'changed', reason: 'Outgoing connections no longer go through the proxy set in Settings.', actor });
    if (updates.supervised) setTimeout(() => updates.switchTo({ type: 'restart', by: actor.user }), 600).unref?.();
    res.json({ ...networkView(), restarting: updates.supervised });
  }),
);

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
registerLicenceRoutes(app, {
  audit, activations, languageAccess, asyncRoute, can, requirePermission, refusalListed, adminActor,
});

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

registerHandsOffPageRoutes(app, {
  settingsStore, audit, integrationSession, resolveAutomationSession, scheduler, asyncRoute, can, requirePermission,
  sendingSettings, adminActor, audienceSetting, serverUrl, sendStatus, selfCheck, healthView,
});

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

registerUpdateRoutes(app, { dataDir, audit, asyncRoute, requirePermission, backupToFolder, updates });

// ---- Settings → Beta features: src/routes/features.js -----------------------------------------------------------------
registerFeatureRoutes(app, {
  settingsStore, audit, scheduler, asyncRoute, requireSession, can, requirePermission, featureLocked,
});

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
