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
import { filterProjectsByActivity, getLastScans, lastScanDate, listApplications, listProjects } from './cxone/projects.js';
import { BRANCH_HOW, branchScopeOf, linesOfCode, onBranch, primaryScans } from './cxone/branches.js';
import { AGE_BUCKETS, collectProjectRisks, createRiskSource, normalizeRisk, projectReads, readGate, selectRisks } from './cxone/risks.js';
import { DEFAULT_ENGINES, cleanEngines, engineScope, inEngines } from './engines.js';
import { discover } from './cxone/discovery.js';
import { collectInitiators, groupRisksByInitiator, groupRisksByProject, projectsInScope, scanInitiator, scanInitiatorEmail } from './cxone/initiators.js';
import { AI_SCANNERS, resolveAiIds, warmScanResults } from './cxone/ai-assist.js';
import { mapWithConcurrency } from './cxone/client.js';
import { matchesVulnerability, topNames, vulnerabilityQuery } from './vuln-search.js';
import { ReportGrants } from './report-grants.js';
import { gitPatch, patchLinks } from './remediation-patch.js';
import { CREDIT_COST, CreditLedger } from './credits.js';
import { CreditAllocations, creditFigures, REMEDIABLE_STATE, alreadySent, billingUnit, remediable, remediationCandidates, triageRows } from './credit-allocations.js';
import { poolSummary } from './credit-usage.js';
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
import { SCM_LABELS, SCM_PROVIDERS, providerOf, scmClients, scmConfigs } from './scm/providers.js';
import { acknowledgeStart } from './updates/companion.js';
import { githubIssues, gitlabIssues, openSlaIssues } from './sla-issues.js';
import { BrandFonts } from './brand-fonts.js';
import { TrackedReports } from './tracked-reports.js';
import { FindingJournal } from './finding-journal.js';
import { ScanAttribution } from './scan-attribution.js';
import { ReportFiles } from './report-files.js';
import { reportWords } from './report-i18n.js';
import { ProjectionStore, ReportStore, TenantReadStore, readFusionOffer, readJobView, readProgressOf, readTenant, seriesFor } from './projections.js';
import { buildCalculatorLauncher, buildStandaloneCalculator, projectionFileProblem, reportRuntime } from './standalone-calculator.js';
import { CLOC_FUSION, GIT_COUNT_LIMITS, clocFusionPage, connectionSource, createGitCounter, gitSource, listOrganizations, listRepositories, sweepLeftovers } from './fusion-git.js';
import { reportFileName as projectionFileName } from '../public/calculator/report.js';
import { MAX_PROJECTS, cleanOrigins, readLimit } from '../public/calculator/model.js';
import { buildReminder, buildTemplateData } from './reminder.js';
import { exampleLinks, projectUrl, riskUrl } from './links.js';
import { AutomationState, Scheduler } from './automation.js';
import { buildBrandedReminder, effectiveBranding, personName, REMINDER_PLACEHOLDERS } from './reminder-email.js';
import { focusProjects, nextRunAfter } from './automation-config.js';
import { checkServiceUrl, deriveConnection, publicConnection } from './cxone/endpoints.js';
import { onMailFailure, sendReminderMail, sendTestEmail, testConnection } from './mailer.js';
import { checkCxKey, checkEnvFile, explainCxone, explainSmtp, refusedByCheck } from './troubleshoot.js';
import { TrustStore, isUntrustedCode } from './trust.js';
import { activeProxy, checkRoute, cleanProxy, proxyWithAuth, readNetwork, requirements, requirementsText, saveNetwork } from './network.js';
import { SettingsStore, cleanPersonalBranding, hasEnvironmentSmtp, hostOfUrl, isVerified, mergeSettings, overlayBranding, parseAddressList, publicSettings, smtpFingerprint, supportChannel } from './settings.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { systemEmail } from './hands-off.js';
import { BACKUP_SUBJECT, findBackupInMailbox } from './mail-inbox.js';
import { ConnectionGuard, describeCxone, describeSmtp } from './connection-guard.js';
import { ENV_SETTINGS, isSecretVariable, parseEnvText, settingsFromEnv } from './env-import.js';
import { addSla, slaSummary } from './sla.js';
import { numberedVariable, setForRepo } from './scm/instances.js';
import { SessionPersistence, sessionKey } from './handover.js';
import { InstanceLock } from './instance-lock.js';
import { clearHalfSaved, flushPendingNow, StateFileError } from './state-file.js';
import { inlineScriptHashes, pruneAttempts, sameOriginGuard, securityHeaders, trustProxySetting, viaTrustedProxy } from './security.js';
import { describeCertificate } from './tls.js';
import { HSTS_AGES, HttpsManager } from './https-manager.js';
import { AcmeService, CHALLENGE_PREFIX, RENEW_DAYS, cleanNames, validName } from './acme.js';
import { ActivationStore, DEACTIVATED_MESSAGE, ISSUER_KEYS, checkCode } from './activation.js';
import { GATED_LANGUAGES, LanguageAccess } from './languages.js';
import { DEFAULT_TENANT, Tenancy, scoped, scopedState } from './tenancy.js';
import { KnownAddresses, scopeKnownAddresses } from './known-addresses.js';
import { Terms, cleanName } from './terms.js';
import { DEFAULT_TEMPLATE, TEMPLATE_VARIABLES } from './template.js';
import { featureById, featureList, inLabs, isFinal, labsPermission, LABS_VIEW, mayUse } from './features.js';
import { scanLanguages, scanTypes, tenantCredits } from './fusion-usage.js';
import { journeyOf } from './journey.js';
import { SupportDesk } from './support.js';
import { PasswordResets, RESET_TTL_MS, maskEmail, resetAllowed } from './password-reset.js';
import { PendingSetups, SignInTickets, TICKET_TTL_MS, groupedKey, matchTotp, newRecoveryCodes, newSecret, otpauthUri, recoveryHash } from './mfa.js';
import { OidcClient, SSO_CALLBACK_PATH, SSO_COOKIE, SSO_FLOW_TTL_MS, SsoError, SsoFlows, identityProblem, mergeSso, publicSso, ssoChanges } from './oidc.js';
import { FaeFlushStore, FaeHistory } from './fae-flush.js';
import { AGE_PRESETS, WINDOW_PRESETS, describeWindow, resolveWindow, withinWindow } from './window.js';
// Govern (beta): credit governance, per tenant (src/govern/).
import { GovernService } from './govern/cycle.js';
import { registerGovernRoutes } from './govern/routes.js';
// Labs → Status board and Consolidated view (beta): their routes and the Workbench fetch's hooks.
import { registerLabsRoutes } from './labs-routes.js';
import { attachScanFacts } from './status-board.js';
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
import { SYSTEM_ACTOR, clientIp, escapeHtml, escapeHtmlText, idList, logSafe } from './routes/shared.js';
import { registerCodeAuthorRoutes } from './routes/code-authors.js';
import { registerFaeFlushRoutes } from './routes/fae-flush.js';
import { registerFusionRoutes } from './routes/fusion.js';
import { createGitConnections, registerGitConnectionRoutes } from './routes/git-connections.js';
import { registerBackupRoutes } from './routes/backups.js';
import { registerSystemReportRoute, registerUpdateRoutes, registerIntegrityRoutes } from './routes/updates.js';
import { registerFeatureRoutes } from './routes/features.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerCreditUsageRoute, registerCreditRoutes } from './routes/credits.js';
import { registerHandsOffPageRoutes, registerHandsOff } from './routes/hands-off.js';
import { registerSupportRoutes } from './routes/support.js';
import { registerImpactRoutes } from './routes/impact.js';
import { registerTrackedReportRoutes } from './routes/tracked-reports.js';

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
    // Typed addresses are checked before the key goes anywhere: https, never a link-local or metadata address.
    if (overrides.baseUrl) overrides.baseUrl = checkServiceUrl(overrides.baseUrl, 'API URL');
    if (overrides.iamUrl) overrides.iamUrl = checkServiceUrl(overrides.iamUrl, 'IAM URL');
    const session = await connectCheckmarxOne(key, {
      baseUrl: overrides.baseUrl || config.overrides.baseUrl,
      iamUrl: overrides.iamUrl || config.overrides.iamUrl,
      tenant: overrides.tenant || config.overrides.tenant,
    });
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
      const session = await connectCheckmarxOne(key, integrationOverrides(settings));
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
  if (!productActive()) return;
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
    // Saved as typed, but never an address the key must not go to (https, no link-local or metadata address).
    for (const [field, label] of [['baseUrl', 'API URL'], ['iamUrl', 'IAM URL']]) if (field in body && overrides[field]) overrides[field] = checkServiceUrl(overrides[field], label);
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
    const addressProblem = ssoAddressProblem(req, changes.links);
    if (addressProblem) return res.status(400).json({ error: addressProblem, applied: [], refused, ignored, findings });
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
    // The credit pool stays within what the tenant has left in Checkmarx One (read afresh): a pool set or changed
    // above it is refused. One left as it was saves with the rest; spending stops at what the tenant has left anyway.
    const size = Number(allowed.aiTriage?.monthlyCreditLimit);
    if (Number.isFinite(size) && size > 0 && size !== Number(settingsStore.get().aiTriage?.monthlyCreditLimit ?? 0)) {
      const tenant = await tenantCreditsOf(req, { fresh: true });
      if (tenant && size > tenant.available) {
        return res.status(400).json({ error: `The credit pool (${size.toLocaleString('en')}) cannot be more than the ${tenant.available.toLocaleString('en')} credits this tenant has left in Checkmarx One (${(tenant.total ?? tenant.available).toLocaleString('en')} in all, ${(tenant.used ?? 0).toLocaleString('en')} used).`, tenant });
      }
    }
    const addressProblem = ssoAddressProblem(req, allowed.links);
    if (addressProblem) return res.status(400).json({ error: addressProblem });
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
  const brand = effectiveBranding({ ...settings.reminderEmail, senderName: '', replyTo: '', logo: 'portal', color: '', footer: '' }, settings);
  res.json({
    ...scheduler.status,
    config: settings.automation,
    // Act → Automation → Email: the email's own fields, and what "Same as the portal" stands for.
    reminderEmail: settings.reminderEmail,
    portal: { senderName: brand.senderName, fromAddress: settings.smtp.fromAddress || '', logoUrl: brand.logoUrl, colours: brand.colours, footer: brand.footer },
    placeholders: REMINDER_PLACEHOLDERS,
    serverTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    // When the next run would go out on these settings, on or off (the Schedule tab says so).
    wouldRunAt: nextRunAfter(settings.automation, new Date())?.toISOString() ?? null,
    lastPreview: tstate.automationPreview ? previewSummary(tstate.automationPreview) : null,
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
    const saved = settingsStore.get().automation;
    res.json({ ...scheduler.status, config: saved, wouldRunAt: nextRunAfter(saved, new Date())?.toISOString() ?? null });
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

/** Each person's interactive report, attached to their reminder (Act → Automation → Email). */
async function automationReport(session, risks, { initiator = null, to = [] } = {}) {
  const settings = sendingSettings();
  const filename = `vulnerability-report-${new Date().toISOString().slice(0, 10)}.html`;
  const { html } = await buildInteractiveReport(session, risks, {
    settings,
    relayUrl: resolveReportServer(null, settingsStore.get()).url,
    initiatorsByProject: {},
    initiator,
    audience: { recipient: [].concat(to).join(', '), purpose: 'attached to a scheduled reminder' },
    publish: filename,
  });
  return { filename, content: html, contentType: 'text/html' };
}

const SEVERITY_SHORT = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low', INFO: 'Info' };

/** What Preview shows of a pass: the tiles, one row per email, and those with no address yet. */
function previewSummary(preview) {
  const { decided, at } = preview;
  const count = (risks, severity) => risks.filter((r) => r.severity === severity).length;
  const limitsText = (risks) => {
    const highest = new Map();
    for (const r of risks) highest.set(r.severity, Math.max(highest.get(r.severity) ?? 0, r.threshold ?? 0));
    return ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].filter((s) => highest.has(s)).map((s) => `${SEVERITY_SHORT[s]} ${highest.get(s)} d`).join(' · ');
  };
  const projectsOf = (risks) => [...new Set(risks.map((r) => r.projectName))].sort();
  const rows = decided.messages.map((m, index) => ({
    index,
    to: m.to.join(', '),
    label: m.label,
    projects: projectsOf(m.risks),
    critical: count(m.risks, 'CRITICAL'),
    high: count(m.risks, 'HIGH'),
    medium: count(m.risks, 'MEDIUM'),
    limits: limitsText(m.risks),
  }));
  const missing = decided.failures.filter((f) => f.noAddress);
  const missingRisks = missing.flatMap((f) => f.risks ?? []);
  const crossed = decided.crossed;
  const bySeverity = Object.fromEntries(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((s) => [s, count(crossed, s)]));
  return {
    at,
    people: rows.length + missing.length,
    projects: new Set(crossed.map((r) => r.projectId)).size,
    findings: crossed.length,
    critical: bySeverity.CRITICAL,
    bySeverity,
    total: decided.total,
    inFocus: decided.inFocus,
    open: decided.open.length,
    rows,
    noAddress: missing.length
      ? { people: missing.map((f) => f.to), projects: projectsOf(missingRisks), critical: count(missingRisks, 'CRITICAL'), high: count(missingRisks, 'HIGH'), medium: count(missingRisks, 'MEDIUM'), limits: limitsText(missingRisks) }
      : null,
    problems: decided.failures.filter((f) => !f.noAddress).map((f) => ({ to: f.to, error: f.error })),
  };
}

/** Who a pass would email now, and what, on the saved settings: nothing is sent or remembered. */
app.post(
  '/api/automation/preview',
  requirePermission('settings.automation'),
  asyncRoute(async (req, res) => {
    if (!(await resolveAutomationSession())) {
      return res.status(409).json({ error: 'Connect the server to Checkmarx One first (Settings → Checkmarx One).' });
    }
    const decided = await presenter.exit(() => scheduler.preview());
    if (!decided) return res.status(409).json({ error: 'Connect the server to Checkmarx One first (Settings → Checkmarx One).' });
    tstate.automationPreview = { at: new Date().toISOString(), decided };
    res.json(previewSummary(tstate.automationPreview));
  }),
);

/** One email of the last preview, as its person would get it. */
app.get('/api/automation/preview/:index', requirePermission('settings.automation'), (req, res) => {
  const message = tstate.automationPreview?.decided.messages[Number.parseInt(req.params.index, 10)];
  if (!message) return res.status(404).json({ error: 'Preview again: that email is no longer in the preview.' });
  res.json({ to: message.to.join(', '), subject: message.reminder.subject, html: message.reminder.html });
});

/** The last preview, emailed to whoever asks: the list of who would get what, not anyone's email. */
app.post(
  '/api/automation/preview/email-me',
  requirePermission('settings.automation'),
  asyncRoute(async (req, res) => {
    const preview = tstate.automationPreview;
    if (!preview) return res.status(409).json({ error: 'Preview first, then email it to yourself.' });
    const s = previewSummary(preview);
    const cell = 'padding:6px 8px;border-bottom:1px solid #e6e2d8';
    const rows = s.rows.map((r) => `<tr><td style="${cell}">${escapeHtmlText(r.to)}</td><td style="${cell}">${escapeHtmlText(r.projects.join(', '))}</td><td style="${cell}" align="right">${r.critical}</td><td style="${cell}" align="right">${r.high}</td><td style="${cell}" align="right">${r.medium}</td><td style="${cell}">${escapeHtmlText(r.limits)}</td></tr>`);
    if (s.noAddress) rows.push(`<tr><td style="${cell}">No address yet (${s.noAddress.people.length})</td><td style="${cell}">${escapeHtmlText(s.noAddress.projects.join(', '))}</td><td style="${cell}" align="right">${s.noAddress.critical}</td><td style="${cell}" align="right">${s.noAddress.high}</td><td style="${cell}" align="right">${s.noAddress.medium}</td><td style="${cell}">${escapeHtmlText(s.noAddress.limits)}</td></tr>`);
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;color:#1f2330"><p>Who the next reminder run would email, previewed ${escapeHtmlText(s.at.slice(0, 16).replace('T', ' '))} UTC: ${s.people} people, ${s.projects} projects, ${s.findings} findings past a limit (${s.critical} critical). Nothing was sent to them.</p><table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px"><tr><th align="left" style="${cell}">Person</th><th align="left" style="${cell}">Projects</th><th style="${cell}">Critical</th><th style="${cell}">High</th><th style="${cell}">Medium</th><th align="left" style="${cell}">Limits crossed</th></tr>${rows.join('')}</table></div>`;
    const text = [`Who the next reminder run would email: ${s.people} people, ${s.projects} projects, ${s.findings} findings past a limit (${s.critical} critical). Nothing was sent to them.`, '', ...s.rows.map((r) => `${r.to}: ${r.projects.join(', ')} — ${r.critical} critical, ${r.high} high, ${r.medium} medium (${r.limits})`)].join('\n');
    const result = await sendSystemMail([req.user.email], { subject: `Reminder preview: ${s.people} people, ${s.findings} findings past a limit`, html, text });
    if (!result.sent) return res.status(502).json({ error: result.error || 'The preview could not be emailed.' });
    res.json({ sent: true, to: req.user.email });
  }),
);

/** A sample of the reminder email on the fields as typed (not saved yet), for the Email tab's preview. */
function sampleReminder(fields, req) {
  const settings = settingsStore.get();
  const email = mergeSettings(settings, { reminderEmail: fields ?? {} }).reminderEmail;
  // The first person of the last preview, else a made-up one: the email as they would get it.
  const real = tstate.automationPreview?.decided.messages.find((m) => m.group);
  const risks = real?.risks ?? [
    { projectId: 'p1', projectName: 'payments-api', severity: 'CRITICAL', ageDays: 41, threshold: 30 },
    { projectId: 'p1', projectName: 'payments-api', severity: 'CRITICAL', ageDays: 33, threshold: 30 },
    { projectId: 'p1', projectName: 'payments-api', severity: 'HIGH', ageDays: 38, threshold: 30 },
    { projectId: 'p2', projectName: 'payments-web', severity: 'CRITICAL', ageDays: 33, threshold: 30 },
    { projectId: 'p2', projectName: 'payments-web', severity: 'HIGH', ageDays: 31, threshold: 30 },
  ];
  const person = real?.group ?? { initiator: 'ana.lopez', email: 'ana.lopez@example.com' };
  const data = buildTemplateData(risks, { tenant: '', links: null, branding: settings.branding, initiator: person });
  const per = new Map();
  for (const r of risks) {
    const p = per.get(r.projectId) ?? { critical: 0, high: 0, oldestDays: 0 };
    if (r.severity === 'CRITICAL') p.critical += 1;
    if (r.severity === 'HIGH') p.high += 1;
    p.oldestDays = Math.max(p.oldestDays, r.ageDays ?? 0);
    per.set(r.projectId, p);
  }
  data.projects = data.projects.map((p) => ({ ...p, ...per.get(p.projectId), url: real ? p.url : '' }));
  data.crossedLimits = risks.map((r) => ({ days: r.threshold }));
  const built = buildBrandedReminder(data, email, settings, { initiator: person.initiator, to: person.email, buttonUrl: 'https://checkmarx.example/projects', why: 'You get this because you last scanned these projects.' });
  return { ...built, as: personName(person.initiator, person.email) || person.email, sample: !real, email };
}

// The preview may show a real person's projects (from the last Preview), so it is for those who manage automation.
app.post('/api/automation/email/preview', requirePermission('settings.automation'), (req, res) => {
  const { subject, html, as, sample } = sampleReminder(req.body ?? {}, req);
  res.json({ subject, html, as, sample });
});

/** The sample, sent to whoever asks (and only them), with the sender name and reply-to it would carry. */
app.post(
  '/api/automation/email/test',
  requirePermission('settings.automation'),
  asyncRoute(async (req, res) => {
    const settings = sendingSettings();
    if (!isVerified(settings)) return res.status(409).json({ error: 'Test the Email server first (Settings → Email server).' });
    const built = sampleReminder(req.body ?? {}, req);
    await sendReminderMail(settings, { subject: `[Test] ${built.subject}`, html: built.html, text: built.text }, { exact: true, to: [req.user.email], cc: [], bcc: [], ...(built.from.name ? { fromName: built.from.name } : {}), ...(built.from.replyTo ? { replyTo: built.from.replyTo } : {}) });
    res.json({ sent: true, to: req.user.email });
  }),
);

/** Save the reminder email (Act → Automation → Email); `restore: true` puts back the default. */
app.put(
  '/api/automation/email',
  requirePermission('settings.automation'),
  asyncRoute(async (req, res) => {
    const saved = settingsStore.save({ reminderEmail: req.body ?? {} });
    res.json({ reminderEmail: saved.reminderEmail });
  }),
);

/** How many projects a focus covers (Act → Automation → Focus), on the server's connection; listed for five minutes. */
app.post(
  '/api/automation/focus/match',
  requirePermission('settings.automation'),
  asyncRoute(async (req, res) => {
    const session = await resolveAutomationSession();
    if (!session) return res.status(409).json({ error: 'Connect the server to Checkmarx One first (Settings → Checkmarx One).' });
    const cached = tstate.focusLists;
    const lists = cached && Date.now() - cached.at < 5 * 60_000
      ? cached
      : { at: Date.now(), projects: await listProjects(session.client), applications: await listApplications(session.client).catch(() => []) };
    tstate.focusLists = lists;
    const focus = mergeSettings(settingsStore.get(), { automation: { focus: req.body ?? {} } }).automation.focus;
    const matched = focusProjects(lists.projects, focus, lists.applications);
    const known = new Set(lists.applications.map((a) => a.name.toLowerCase()));
    res.json({
      total: lists.projects.length,
      matched: matched.length,
      names: matched.slice(0, 12).map((p) => p.name),
      unknownApplications: focus.applications.filter((name) => !known.has(name.toLowerCase())),
      applications: lists.applications.map((a) => a.name).sort((a, b) => a.localeCompare(b)).slice(0, 500),
    });
  }),
);

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
      return res.status(409).json({ error: 'Load findings on the Workbench first, then send a reminder.' });
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
  // Only a plain host[:port] (requestHost's rule): never a path, user name or other site smuggled into a header.
  const forwardedHost = viaTrustedProxy(req) ? String(req.get('x-forwarded-host') ?? '').split(',')[0].trim() : '';
  const host = /^([\w.-]+|\[[0-9a-f:.]+\])(:\d{1,5})?$/i.test(forwardedHost) ? forwardedHost : requestHost(req);
  return host ? `${req.protocol}://${host}` : '';
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

/**
 * What a report sends to name a finding is short: ids, a project's name, the engine. Anything longer is not from a
 * report, and is refused before it is looked at (or written anywhere).
 */
const RELAY_FIELD_MAX = { projectId: 200, projectName: 512, riskId: 512, scanId: 200, scanner: 40, alternateId: 512, groupId: 512, grant: 512 };
const RELAY_FIELDS = [...Object.entries(RELAY_FIELD_MAX), ['exp', 40]];
/** (Run for every finding of every report request: a plain loop, nothing made along the way.) */
function relayFieldsFit(raw) {
  if (raw === null || typeof raw !== 'object') return true;
  for (let i = 0; i < RELAY_FIELDS.length; i += 1) {
    const value = raw[RELAY_FIELDS[i][0]];
    if (value === undefined || value === null) continue;
    if ((typeof value === 'string' ? value : String(value)).length > RELAY_FIELDS[i][1]) return false;
  }
  return true;
}

/**
 * Refused report requests are written to the audit log, but only so many: nobody has signed in on these routes, so
 * without a limit anyone who can reach the server could fill the disk with them. Past REFUSED_AUDIT_PER_MINUTE
 * from one address (or four times that from everyone) in a minute, the rest are counted, and one line says how
 * many were left out.
 */
const REFUSED_AUDIT_PER_MINUTE = 10;
/** One count per kind of refusal, so a flood of one kind never hides another: kind -> { since, total, byKey, leftOut }. */
const refusedAudits = new Map();
const REFUSED_KINDS = {
  report: { perKey: REFUSED_AUDIT_PER_MINUTE, total: REFUSED_AUDIT_PER_MINUTE * 4, what: 'refused report requests' },
  licence: { perKey: REFUSED_AUDIT_PER_MINUTE, total: REFUSED_AUDIT_PER_MINUTE * 4, what: 'refused product activation codes' },
  signIn: { perKey: 30, total: 120, what: 'refused sign-ins' },
};
/** May one more refusal from `key` (an address, a report) be listed in the audit log this minute? */
function refusalListed(key, now = Date.now(), kind = 'report') {
  const limits = REFUSED_KINDS[kind];
  let state = refusedAudits.get(kind);
  if (!state) refusedAudits.set(kind, (state = { since: 0, total: 0, byKey: new Map(), leftOut: 0 }));
  if (now - state.since >= 60_000) {
    if (state.leftOut) {
      audit.record({ type: 'access', outcome: 'refused', reason: `${state.leftOut} more ${limits.what} in the minute before were not listed one by one (too many at once).`, actor: SYSTEM_ACTOR });
    }
    Object.assign(state, { since: now, total: 0, leftOut: 0 });
    state.byKey.clear();
  }
  const seen = state.byKey.get(key) ?? 0;
  if (seen >= limits.perKey || state.total >= limits.total) {
    state.leftOut += 1;
    return false;
  }
  // (The map cannot grow past the total allowed in a minute.)
  state.byKey.set(key, seen + 1);
  state.total += 1;
  return true;
}
const mayAuditRefusal = (req, now = Date.now()) => refusalListed(`address ${clientIp(req)}`, now);

function grantedFindings(req, res, { type = '', actor = null, list: given = req.body?.findings } = {}) {
  const list = Array.isArray(given) ? given : [];
  if (list.length === 0 || list.length > RELAY_MAX_FINDINGS) {
    res.status(400).json({ error: `Send between 1 and ${RELAY_MAX_FINDINGS} findings.` });
    return null;
  }
  if (!list.every(relayFieldsFit)) {
    res.status(400).json({ error: 'This request is not from a report.' });
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
    if (problem && type && mayAuditRefusal(req)) {
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
/** Who asks to spend, for Govern's spend guard (beta): the person's email, or the emailed report's recipient. */
const governRequester = (actor) => String(actor?.email || actor?.recipient || '').toLowerCase();
const creditsRemaining = () => creditLedger.remaining(settingsStore.get().aiTriage?.monthlyCreditLimit ?? 0, new Date(), poolPeriod());

/** The tenant's credits as last read from Checkmarx One, and this app's spending total then. */
let tenantSeen = null;
/**
 * What the tenant has left in Checkmarx One now: as last read, less what this app has spent since. Null when never
 * read. A read older than a couple of minutes is refreshed behind, through the session that read it.
 */
function tenantLeft() {
  if (!tenantSeen) return null;
  if (Date.now() - tenantSeen.at > TENANT_CREDITS_MS && tenantSeen.session?.client) tenantCreditsOf({ session: tenantSeen.session }, { wait: false }).catch(() => {});
  const spent = creditLedger.usedInPeriod('all').total - tenantSeen.spent;
  return Math.max(0, tenantSeen.available - Math.max(0, spent));
}
/** Why `credits` more cannot be spent: the tenant has too few left in Checkmarx One. Empty when they fit, or nothing is known. */
function tenantShortfall(credits) {
  const left = tenantLeft();
  if (left === null) return '';
  const free = Math.max(0, left - creditLedger.reserved);
  return credits > free ? `Checkmarx One has ${free.toLocaleString('en')} credit${free === 1 ? '' : 's'} left for this tenant, ${credits} needed. Ask your administrator.` : '';
}
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
    out[projectId] = { triage: b.triage, remediation: b.remediation, severities: b.severities };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Audit: every credit decision, attributed and traceable
// ---------------------------------------------------------------------------

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
    via: session?.via === 'cxone' ? `Checkmarx One key${session.cxUser ? ` (${session.cxUser})` : ''}` : session?.via === 'sso' ? 'single sign-on' : 'password',
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
  console.log(`[credits] ${allocations.migrated.length} project allocation(s) made automatically by an earlier release were removed; allocate on the Workbench.`);
}

/** How many findings a refused request's audit entry lists; the rest are counted. */
const REFUSED_FINDINGS_LISTED = 20;

/**
 * A whole request turned away before anything was sent: one entry per project. From a report (nobody signed in)
 * only so many a minute are listed, by the report and the address it came from, and each lists a few of its
 * findings and counts the rest: a report's holder could otherwise repeat a refused request with hundreds of
 * findings until the audit log, which is never trimmed, filled the disk.
 */
function auditRefusedRequest(type, actor, findings, reason, outcome = 'refused') {
  const kind = type === 'remediation' ? 'remediation' : 'triage';
  const perFinding = kind === 'remediation' ? CREDIT_COST.remediation : 1;
  const fromReport = actor?.kind === 'report';
  const byProject = new Map();
  for (const f of findings) {
    if (!byProject.has(f.projectId)) byProject.set(f.projectId, []);
    byProject.get(f.projectId).push(f);
  }
  for (const group of byProject.values()) {
    if (fromReport && !refusalListed(`report ${actor.reportId || actor.ip || ''}`)) continue;
    const listed = fromReport ? group.slice(0, REFUSED_FINDINGS_LISTED) : group;
    auditCredit({
      type,
      outcome,
      reason,
      actor,
      findings: listed,
      kind,
      requested: new Set(group.map((f) => f.alternateId)).size * perFinding,
      ...(listed.length < group.length ? { details: { findingsInRequest: group.length, findingsListed: listed.length } } : {}),
    });
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
  return tenantShortfall(credits);
}

/** Lets a report (or the Settings page) check an address really is this server. Never needs a connection. */
app.get('/api/relay/ping', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ service: 'mission-zero-relay', ok: true });
});

/**
 * The report's wording in another language, for a reader who picks it in a report (it carries only
 * its reader's own). Open languages only: a language behind an activation code travels inside the
 * reports of the people it is on for, and is never served here.
 */
app.get('/api/relay/report-words/:code', (req, res) => {
  const strings = reportWords(String(req.params.code));
  if (!strings) return res.status(404).json({ error: 'That language is not available.' });
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ language: req.params.code, version: PACKAGE_VERSION, strings });
});

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
    const [{ perProject, ...tenant }, offer] = await Promise.all([readTenant(client, { branches: branchScopeOf(req.body?.branches), maxProjects: readLimit(req.body?.maxProjects) }), readFusionOffer(client).catch(() => ({ models: [], remainingCredits: null }))]);
    projectionReads.save(perProject);
    res.json({ ...tenant, ...offer });
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

// ---- The product licence: whether CxMissionZero works, and a product code entered on the deactivation page ----
// Open to anyone who reaches the server: only a code the maintainer signed can do anything here.
app.get('/api/licence', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { active, until, message } = activations.product();
  res.json({ active, until, message });
});

const licenceTries = new Map();
app.post('/api/licence/activate', (req, res) => {
  // A few tries a minute from one address: a code cannot be guessed, but there is no reason to let anyone try.
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (licenceTries.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= 10) return res.status(429).json({ error: 'Too many tries. Wait a minute, then enter the code again.' });
  licenceTries.set(ip, [...recent, now]);
  if (licenceTries.size > 1000) licenceTries.clear();
  const result = checkCode(String(req.body?.code ?? '').trim().slice(0, 4000));
  // In date by the licence's own clock too (never earlier than the latest time it has seen).
  const passed = result.valid && Date.parse(result.expires) <= activations.now();
  // Open to everyone: only a code that runs longer than the one in force, and was not issued before it, is taken.
  const stale = result.valid && result.scope === 'product' && !passed ? activations.refusal(result, { mustExtend: true }) : '';
  if (!result.valid || result.scope !== 'product' || passed || stale) {
    const reason = !result.valid ? result.reason || 'This activation code is not valid.' : result.scope !== 'product' ? 'This is not a CxMissionZero activation code.' : passed ? `This activation code ended on ${result.expires.slice(0, 10)}.` : stale;
    if (refusalListed(`address ${ip}`, now, 'licence')) audit.record({ type: 'settings', outcome: 'refused', reason: `Product activation code refused: ${reason}`, actor: { kind: 'system', user: `deactivation page (${ip})` } });
    return res.status(400).json({ error: reason });
  }
  activations.record(result, `deactivation page (${ip})`);
  audit.record({ type: 'settings', outcome: 'changed', reason: `Product activation code applied: CxMissionZero works until ${result.expires.slice(0, 10)} (${result.org}).`, actor: { kind: 'system', user: `deactivation page (${ip})` }, details: { activation: { id: result.id, org: result.org, scope: result.scope, action: result.action, expires: result.expires } } });
  const { active, until } = activations.product();
  res.json({ active, until });
});

// ---- Activation codes (Settings → Activation codes): add-ons unlocked by the maintainer ----

function activationView(req) {
  return {
    // Seeing the page (activation.view) is not changing it.
    canManage: can(req, 'activation.manage'),
    keyConfigured: ISSUER_KEYS.length > 0,
    // Only the add-ons a code has unlocked (expired ones too, to renew): nothing else is named.
    languages: Object.fromEntries(Object.keys(GATED_LANGUAGES).map((code) => [code, languageAccess.status(code)]).filter(([, s]) => s.on || s.expired)),
    tenants: activations.tenants(),
    features: Object.fromEntries(['impact', 'faeFlush', 'govern', 'statusBoard', 'consolidated'].map((name) => [name, activations.feature(name)]).filter(([, f]) => f)),
    product: activations.product(),
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
  // An older code entered again would undo the one in force (a feature turned off, a shorter date).
  const stale = result.scope.startsWith('lang:') ? '' : activations.refusal(result);
  if (stale) {
    audit.record({ type: 'settings', outcome: 'refused', reason: `Activation code refused: ${stale}`, actor });
    return res.status(400).json({ error: stale });
  }
  let what;
  if (result.scope.startsWith('lang:')) {
    const applied = languageAccess.apply(result, { by: req.user.id });
    what = `${applied.code === 'he' ? 'Hebrew' : applied.code} ${applied.on ? `turned on until ${result.expires.slice(0, 10)}, for the roles with its permission (People & roles)` : 'turned off'}`;
  } else if (result.scope === 'feature:impact') {
    what = `the Cx Credits Calculator's Impact tab ${result.action === 'activate' ? `turned on until ${result.expires.slice(0, 10)}` : 'turned off'}`;
  } else if (result.scope === 'feature:faeFlush') {
    what = `FAE Flush (Labs) ${result.action === 'activate' ? `turned on until ${result.expires.slice(0, 10)}, for the roles with Labs: FAE Flush` : 'turned off: a run under way pauses'}`;
  } else if (result.scope === 'feature:statusBoard') {
    what = `the Status board (Labs) ${result.action === 'activate' ? `turned on until ${result.expires.slice(0, 10)}, for the roles with Labs: Status board` : 'turned off'}`;
  } else if (result.scope === 'feature:consolidated') {
    what = `the Consolidated view (Labs) ${result.action === 'activate' ? `turned on until ${result.expires.slice(0, 10)}, for the people an Admin ticks under People & roles whose role has Labs: Consolidated view` : 'turned off'}`;
  } else if (result.scope === 'feature:govern') {
    what = `Govern (Labs) ${result.action === 'activate' ? `turned on until ${result.expires.slice(0, 10)}, for the roles with Labs: Govern` : 'turned off: its cycles stop, restrictions already made stay until restored'}`;
  } else if (result.scope === 'product') {
    what = `CxMissionZero activated for ${result.org} until ${result.expires.slice(0, 10)}`;
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
          cap: tenantLeft(),
          requester: governRequester(base.actor),
        });
        if (!reservation) {
          // Govern (beta): a used-up budget in Enforce mode says so; otherwise concurrent requests hold the credits.
          results.push({ alternateIds, ok: false, status: 402, error: creditLedger.lastRefusal || 'Credits are busy with another request; try again in a moment.' });
          auditCredit({ ...base, outcome: 'refused', reason: creditLedger.lastRefusal || 'Credits reserved by concurrent requests; nothing sent.' });
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
        cap: tenantLeft(),
        requester: governRequester(base.actor),
      });
      if (!reservation && creditLedger.lastRefusal) {
        // Govern (beta): a used-up budget in Enforce mode.
        auditCredit({ ...base, outcome: 'refused', reason: creditLedger.lastRefusal });
        return res.status(402).json({ error: creditLedger.lastRefusal });
      }
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
 * After the administrator ran AI Triage or Remediation from the Workbench or a
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
/** Projects verified at once (each with its two reads side by side); the connection's limit still caps the calls. */
const VERIFY_AT_ONCE = Math.max(1, Number(process.env.CX_VERIFY_CONCURRENCY) || 8);
/** Calls to Checkmarx One one verify keeps waiting or running at once (3 projects × 4 pages ahead, as before MZ-01.00.65). */
const VERIFY_SLOTS = 12;

/**
 * One complete, independent read from Checkmarx One of what a project needs:
 * its findings and their live states (risks API), then the scan results that
 * AI Triage and AI Remediation would be sent (results API). Returns the exact
 * billed result ids, not an estimate.
 */
async function readProjectNeed(session, project, { detectionWindow = null, scanIdOf = () => '', severities = null, keep = null, gate = null, branchChoice = null } = {}) {
  const started = Date.now();
  // Only the branch that counts for the project (branchChoice), as the findings it replaces were read.
  const scan = branchChoice?.scans?.[project.projectId];
  const read = await collectProjectRisks(session.client, activeConfig(), [{ id: project.projectId, name: project.projectName }], {
    detectionWindow,
    keep,
    gate,
    scans: branchChoice ? { [project.projectId]: scan } : null,
    refine: branchChoice ? (p, risks) => onBranch(session.client, branchChoice, p.id, risks, { identity: readerIdentity(session), gate }) : null,
  });
  const summary = read.projects[0];
  if (summary.error) throw Object.assign(new Error(`${project.projectName}: ${summary.error}`), { status: 502 });
  const rule = severities?.length ? severities : allocations.severitiesOf(project.projectId);
  const ai = summary.risks.filter((r) => rule.includes(r.severity) && AI_SCANNERS.has(r.scanner));
  const readAt = Date.now();
  await resolveAiIds(session.client, ai, () => scanIdOf(project.projectId));
  const timing = { readMs: readAt - started, lookupMs: Date.now() - readAt };
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
    timing,
  };
}

/**
 * The scans whose result ids a credit check of this project will look up: those its fetched
 * findings name, and its latest scan. Reading them is the slow part of a check on a large scan.
 */
function warmProject(session, project, severities = null) {
  // Only what the check will look up: AI-eligible findings of the severities counted, not yet matched.
  const rule = severities?.length ? severities : allocations.severitiesOf(project.projectId);
  const latest = session.lastScan?.initiators?.[project.projectId]?.scanId ?? '';
  const ids = new Set();
  for (const r of project.risks ?? []) {
    if (!AI_SCANNERS.has(r.scanner) || r.alternateId || !rule.includes(r.severity)) continue;
    const id = r.scanId || latest;
    if (id) ids.add(id);
  }
  for (const id of [...ids].slice(0, 5)) warmScanResults(session.client, id);
}

/**
 * Verify what projects need: two independent reads from Checkmarx One that must
 * agree, result id for result id. On agreement the project's findings and
 * credit needs are replaced by what Checkmarx One said; on disagreement (the
 * data is changing, e.g. someone is triaging) nothing is trusted.
 */
/**
 * Two independent reads of one project, side by side (each its own requests to Checkmarx One);
 * `agreed` only when every billed result id matches.
 */
async function doubleRead(session, project, options) {
  const [first, second] = await Promise.all([readProjectNeed(session, project, options), readProjectNeed(session, project, options)]);
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
  // The same findings the Workbench shows: its date window, its engines and its vulnerability search
  // (the verified read replaces the loaded findings, so it must keep to the same ones).
  const vulnerability = vulnerabilityQuery(scan?.vulnerability);
  const engines = scan?.engines ?? null;
  const keep = vulnerability || engines ? (risk) => inEngines(risk, engines) && (!vulnerability || matchesVulnerability(vulnerability, risk)) : null;
  // Its projects and their two reads side by side, never queuing more calls than one verify did before (VERIFY_SLOTS).
  const options = { detectionWindow: scan?.detectionWindow ?? null, scanIdOf: (id) => scan?.initiators?.[id]?.scanId ?? '', severities, keep, gate: readGate(session.client, VERIFY_SLOTS), branchChoice: branchChoiceOfScan(scan) };
  const out = await mapWithConcurrency(projects, VERIFY_AT_ONCE, async (p) => {
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
        timing: { readMs: Math.max(first.timing.readMs, second.timing.readMs), lookupMs: Math.max(first.timing.lookupMs, second.timing.lookupMs) },
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
    if (!req.session.lastScan) return res.status(409).json({ error: 'Load findings on the Workbench first.' });
    const projects = scanProjects(req, req.body?.projectIds);
    for (const p of projects) stateCache.delete(p.projectId);
    const severities = cleanSeverities(req.body?.severities);
    const started = Date.now();
    const results = await verifyNeeds(req.session, projects, { severities: severities.length ? SEVERITIES.filter((s) => severities.includes(s)) : null });
    const ms = Date.now() - started;
    const slowest = (key) => results.reduce((n, r) => Math.max(n, r.timing?.[key] ?? 0), 0);
    // How long each part took, so a slow check says where the time went (no names or ids).
    diagnostics.usage('credit-verify', { projects: projects.length, ms, readMs: slowest('readMs'), lookupMs: slowest('lookupMs') });
    res.json({
      ms,
      timing: { readMs: slowest('readMs'), lookupMs: slowest('lookupMs') },
      verified: results,
      projects: Object.fromEntries(projects.map((p) => [p.projectId, { ...projectRow(p), credits: p.credits, verified: p.verified }])),
    });
  }),
);

/**
 * Projects someone picked on the Workbench, before they allocate or run anything: their scans'
 * result ids are read now, in the background, so the check that follows does not wait for them.
 * Reads nothing else, changes nothing, answers at once.
 */
app.post('/api/credits/prepare', requirePermission('credits.view'), (req, res) => {
  if (!req.session.lastScan) return res.status(204).end();
  const ids = Array.isArray(req.body?.projectIds) ? req.body.projectIds.slice(0, 25).map(String) : [];
  if (ids.length) for (const p of scanProjects(req, ids)) warmProject(req.session, p);
  res.status(202).end();
});

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
  if (!req.session.lastScan) return res.status(409).json({ error: 'Load findings on the Workbench first.' });
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
    return res.status(409).json({ error: `${reason} Raise the pool under Settings → AI & credit pool.`, pool });
  }
  const beyond = await tenantRefusal(req, given, pool);
  if (beyond) {
    if (changes.length) allocations.save();
    audit.record({ type: 'allocation', outcome: 'refused', reason: beyond, actor, credits: { kind: 'allocation', requested: given, charged: 0 }, details: { projectIds: projects.map((p) => p.projectId), pool } });
    return res.status(409).json({ error: beyond, pool });
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
    auditAllocation({ actor, projectId: p.projectId, projectName: p.projectName, before: before.get(p.projectId), change, reason: needed.length ? `Allocated what the findings need (${needed.join(' and ')}) on the Workbench.` : 'Changed on the Workbench.' });
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
      const reservation = creditLedger.reserve(alternateIds.length, limit, new Date(), { period: poolPeriod(), cap: tenantLeft(), forProject: projectId, requester: governRequester(actor) });
      if (!reservation) {
        const why = creditLedger.lastRefusal || tenantShortfall(alternateIds.length) || `${poolName(limit)} is used up (credit limit reached).`;
        failed += group.length;
        errors.push(`${projectName}: ${why}`);
        auditCredit({ ...base, outcome: 'refused', reason: why });
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
    if (!req.session.lastScan) return res.status(409).json({ error: 'Load findings on the Workbench first.' });
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
    if (!req.session.lastScan) return res.status(409).json({ error: 'Load findings on the Workbench first.' });
    const wanted = cleanSeverities(req.body?.severities);
    if (!wanted.length) return res.status(400).json({ error: 'Pick at least one severity to triage.' });

    const projects = scanProjects(req, req.body?.projectIds);
    const RECENT_MS = 30 * 60 * 1000;
    const originals = new Map();
    const findings = [];
    // Live states, read side by side, and only for projects with a finding of these severities left to triage.
    const candidate = (r) => wanted.includes(r.severity) && (!r.state || r.state === 'TO_VERIFY');
    const lives = await mapWithConcurrency(projects, VERIFY_AT_ONCE, async (p) => ((p.risks ?? []).some(candidate) ? projectStates(req.session, p.projectId).catch(() => null) : null));
    for (const [i, p] of projects.entries()) {
      const live = lives[i];
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
      origin: `Workbench: triage ${wanted.map((s) => s.toLowerCase()).join(', ')} now`,
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
      const reservation = creditLedger.reserve(credits, limit, new Date(), { period: poolPeriod(), projectId, kind: 'remediation', allowance: allocations.balance(projectId).remediation.allocated, cap: tenantLeft(), requester: governRequester(actor) });
      if (!reservation) {
        failed += group.length;
        errors.push(`${projectName}: ${creditLedger.lastRefusal || 'credits are busy with another request; try again in a moment.'}`);
        auditCredit({ ...base, outcome: 'refused', reason: creditLedger.lastRefusal || 'Credits reserved by concurrent requests; nothing sent.' });
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
 * The Workbench's "Remediate selected": AI Remediation for the confirmed
 * findings (and only those) of the chosen severities in the chosen projects,
 * read live. Spends 3 credits each, from remediation credits already
 * allocated — "Allocate for remediation" first.
 */
app.post(
  '/api/remediation/run',
  requirePermission('triage.run'),
  afterFetch,
  asyncRoute(async (req, res) => {
    if (!req.session.lastScan) return res.status(409).json({ error: 'Load findings on the Workbench first.' });
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
      origin: `Workbench: remediate confirmed ${wanted.map((s) => s.toLowerCase()).join(', ')}`,
    });
    for (const p of projects) p.credits = creditView(p);
    const { startedFindings, ...summary } = outcome;
    const notified = req.body?.notifyInitiators === false ? null : await notifyOnBehalf(req.session, 'remediation', startedFindings, req.session.lastScan.initiators ?? {}, await adminActor(req));
    res.json({ ...summary, notConfirmed, notified, projects: Object.fromEntries(projects.map((p) => [p.projectId, p.credits])) });
  }),
);

/** Rescans this server started are credited to the developer they verify (see src/scan-attribution.js). */
const scanAttribution = scoped(tenancy, 'scanAttribution');
const creditFor = (scanId) => scanAttribution.get(scanId);
/** A last-scan record, with a verification rescan credited to whose work it verifies. */
const credited = (scan) => {
  const credit = scan && creditFor(scan.id ?? scan.scanId);
  return credit ? { ...scan, initiator: credit.initiator, initiatorEmail: credit.email || undefined, startedBy: scanInitiator(scan) } : scan;
};

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

/** The credit pool now: size, used (triage / remediation), left, given to projects, free to give. */
/** How long the tenant's Checkmarx One credits, once read, are taken as they are. */
const TENANT_CREDITS_MS = 2 * 60 * 1000;
/** A session's read of the tenant's credits still under way (one at a time). */
const tenantCreditReads = new WeakMap();
/**
 * The tenant's credits in Checkmarx One (GET /api/credits/info), read with this session's connection and kept for a
 * short while; null when there is no connection or Checkmarx One does not say. Once known, an older figure is
 * answered at once while it is read again behind; `fresh` waits for a new read (setting the pool), `wait: false`
 * never waits (a page that only shows it).
 */
async function tenantCreditsOf(req, { fresh = false, wait = true } = {}) {
  const session = req.session;
  const client = session?.client;
  if (!client) return null;
  const kept = session.tenantCredits;
  if (!fresh && kept && Date.now() - kept.at < TENANT_CREDITS_MS) return kept.value;
  let read = tenantCreditReads.get(session);
  if (!read) {
    read = tenantCredits(client, { background: !fresh })
      .catch(() => null)
      .then((value) => {
        session.tenantCredits = { at: Date.now(), value };
        labs.noteCredits(value);
        if (value) tenantSeen = { available: value.available, spent: creditLedger.usedInPeriod('all').total, at: Date.now(), session };
        return value;
      })
      .finally(() => tenantCreditReads.delete(session));
    tenantCreditReads.set(session, read);
  }
  if (fresh) return read;
  if (kept) return kept.value;
  return wait ? read : null;
}

/**
 * Why giving `given` more credits to projects is refused: projects would then hold more than the tenant has left in
 * Checkmarx One (what they were given and have not used yet, plus these). Null when it fits, or nothing is known.
 */
async function tenantRefusal(req, given, pool = creditPool()) {
  if (!given) return null;
  const tenant = await tenantCreditsOf(req);
  if (!tenant) return null;
  const held = (pool.outstanding?.total ?? 0) + given;
  if (held <= tenant.available) return null;
  return `Checkmarx One has ${tenant.available.toLocaleString('en')} credit${tenant.available === 1 ? '' : 's'} left for this tenant; projects would then hold ${held.toLocaleString('en')} (${(pool.outstanding?.total ?? 0).toLocaleString('en')} given and not used yet, ${given.toLocaleString('en')} more).`;
}

function creditPool(settings = settingsStore.get(), list = allocations.list()) {
  const period = poolPeriod(settings);
  const pool = poolSummary({
    size: settings.aiTriage?.monthlyCreditLimit ?? 0,
    period,
    used: creditLedger.usedInPeriod(period),
    reserved: creditLedger.reserved,
    allocations: list,
  });
  // What the tenant has left in Checkmarx One bounds the pool: a pool with more left than that is flagged.
  const left = tenantLeft();
  const overTenant = left !== null && pool.limited && pool.remaining > left;
  // Nor can projects be given more than the tenant has left.
  const unallocated = overTenant ? Math.min(pool.unallocated, Math.max(0, left - pool.outstanding.total)) : pool.unallocated;
  return { ...pool, unallocated, tenantLeft: left, overTenant };
}

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
