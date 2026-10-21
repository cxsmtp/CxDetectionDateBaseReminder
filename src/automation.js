import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getLastScans, listApplications, listProjects } from './cxone/projects.js';
import { collectProjectRisks } from './cxone/risks.js';
import { BRANCH_HOW, onBranch, primaryScans, withCode } from './cxone/branches.js';
import { collectInitiators, groupRisksByInitiator, groupRisksByProject } from './cxone/initiators.js';
import { buildReminder, buildTemplateData } from './reminder.js';
import { buildBrandedReminder, DEFAULT_REMINDER_EMAIL } from './reminder-email.js';
import { projectsListUrl } from './links.js';
import { sendReminderMail } from './mailer.js';
import { DEFAULT_AUTOMATION, focusProjects, limitsFor, nextRunAfter } from './automation-config.js';
import { engineScope, inEngines } from './engines.js';
import { knownAddresses } from './known-addresses.js';
import { escalationMail, newlyOverdue, pruneEscalated, riskKey as slaKey } from './sla.js';

export { DEFAULT_AUTOMATION, focusProjects, limitsFor, mergeAutomation, nextRunAfter, parseThresholds } from './automation-config.js';

/**
 * Unattended reminders.
 *
 * The tool watches for findings crossing an age threshold (30 / 60 / 90 days,
 * or whatever the administrator configures) and mails about them on its own.
 *
 * The hard part is not the timer, it is *not* nagging: a daily sweep would
 * re-send the same finding every day once it passed 30 days. So each
 * (finding, threshold) pair is recorded in a ledger once it has been reported,
 * and only pairs absent from the ledger are mailed. A finding therefore
 * produces at most one message per threshold it crosses, which is what "the
 * moment it crosses" means in practice.
 */

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const MAX_RUNS_KEPT = 50;

export class AutomationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AutomationError';
    this.status = status;
  }
}

const riskKey = (risk) => `${risk.projectId}:${risk.id}`;

/**
 * Which findings have newly crossed which thresholds.
 *
 * A finding that is already 200 days old on the first run has crossed 30, 60
 * and 90 — it is reported once, against the highest threshold it has passed,
 * rather than three times.
 */
export function findCrossings(risks, thresholds, ledger, { mode = 'crossing' } = {}) {
  // One list for every finding, or a function giving each finding's own (its severity's limits).
  const limitsOf = typeof thresholds === 'function' ? thresholds : () => thresholds;
  const crossed = [];
  const seen = new Set();

  for (const risk of risks) {
    const key = riskKey(risk);
    seen.add(key);
    if (risk.ageDays === null || risk.ageDays === undefined) continue;

    const sorted = [...(limitsOf(risk) ?? [])].sort((a, b) => a - b);
    const passed = sorted.filter((days) => risk.ageDays >= days);
    if (passed.length === 0) continue;

    const highest = passed[passed.length - 1];

    if (mode === 'digest') {
      crossed.push({ ...risk, threshold: highest });
      continue;
    }

    const already = ledger.notified[key] ?? {};
    // Report the highest newly-passed threshold, so one finding that is
    // already very old does not generate a message per threshold.
    const unreported = passed.filter((days) => !already[String(days)]);
    if (unreported.length === 0) continue;

    crossed.push({ ...risk, threshold: unreported[unreported.length - 1], newThresholds: unreported });
  }

  return { crossed, seen };
}

/** Record what was reported, and forget findings that are no longer open. */
export function applyLedger(ledger, crossed, seen, now = new Date()) {
  const stamp = now.toISOString();

  for (const risk of crossed) {
    const key = riskKey(risk);
    ledger.notified[key] ??= {};
    for (const days of risk.newThresholds ?? [risk.threshold]) {
      ledger.notified[key][String(days)] = stamp;
    }
  }

  // A finding that has been fixed drops out of the results; dropping it from
  // the ledger too stops the file growing without bound, and means a genuine
  // regression is reported again.
  let pruned = 0;
  for (const key of Object.keys(ledger.notified)) {
    if (!seen.has(key)) {
      delete ledger.notified[key];
      pruned += 1;
    }
  }

  return { pruned };
}

// ---------------------------------------------------------------------------

/** Persisted ledger plus a short run history, for the status panel. */
export class AutomationState {
  #file;
  #state;

  constructor({ file } = {}) {
    this.#file = file ?? path.join(process.cwd(), 'data', 'automation-state.json');
    this.#state = this.#load();
  }

  get file() {
    return this.#file;
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
      return { notified: raw.notified ?? {}, escalated: raw.escalated ?? {}, runs: Array.isArray(raw.runs) ? raw.runs : [], impactSent: typeof raw.impactSent === 'string' ? raw.impactSent : '' };
    } catch {
      return { notified: {}, escalated: {}, runs: [], impactSent: '' };
    }
  }

  get ledger() {
    return this.#state;
  }

  get runs() {
    return this.#state.runs;
  }

  recordRun(entry) {
    this.#state.runs.unshift({ id: randomUUID(), at: new Date().toISOString(), ...entry });
    this.#state.runs = this.#state.runs.slice(0, MAX_RUNS_KEPT);
    this.persist();
    return this.#state.runs[0];
  }

  /** The last month ('YYYY-MM') whose impact summary was emailed (src/impact-summary.js). */
  get impactSent() {
    return this.#state.impactSent ?? '';
  }

  set impactSent(month) {
    this.#state.impactSent = String(month);
    this.persist();
  }

  /** Forget every reported pair, so the next run reports from scratch. */
  reset() {
    this.#state.notified = {};
    this.persist();
  }

  persist() {
    const dir = path.dirname(this.#file);
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    const temp = `${this.#file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.#state, null, 2), { mode: FILE_MODE });
    fs.renameSync(temp, this.#file);
  }
}

// ---------------------------------------------------------------------------

/**
 * What a pass would do, without doing it: the open findings in focus, those newly past a limit, and the
 * messages they make (each person's, or the fixed list's). Nothing is sent and the ledger is only read,
 * so Act → Automation → Preview shows exactly what a run would send.
 */
export async function decide({ client, connection, config, settings, ledger, now = new Date(), reportFor = null }) {
  const automation = settings.automation;

  // Each project's primary branch only (unless every branch is chosen): a branch never scanned is not
  // reminded about, and nor (unless chosen otherwise) is a project whose scan counted no lines of code.
  let projects = await listProjects(client);
  const total = projects.length;
  // What reminders cover (→ Focus): named applications, tags and projects, less those left out.
  const focus = automation.focus ?? {};
  if (focus.applications?.length || focus.tags?.length || focus.projects?.length || focus.exclude?.length) {
    const applications = focus.applications?.length ? await listApplications(client).catch(() => []) : [];
    projects = focusProjects(projects, focus, applications);
  }
  const inFocus = projects.length;
  // What is known of each scan is kept per Checkmarx One key, the same key the Workbench's sessions share.
  const identity = connection?.apiKey ? createHash('sha256').update(`${connection.baseUrl ?? ''}\u0000${connection.tenant ?? ''}\u0000${connection.apiKey}`).digest('base64url').slice(0, 22) : '';
  const choice = automation.branches === 'all' ? null : await primaryScans(client, projects, { identity, concurrency: config.concurrency }).catch(() => null);
  if (choice) projects = projects.filter((p) => choice.branches[p.id]?.how !== BRANCH_HOW.none);
  if (automation.leaveOutNoCode) {
    const scans = choice?.scans ?? (await getLastScans(client, projects.map((p) => p.id)).catch(() => ({})));
    projects = (await withCode(client, projects, scans, { identity, concurrency: config.concurrency })).kept;
  }
  const scan = await collectProjectRisks(client, config, projects, {
    now,
    scans: choice?.scans ?? null,
    refine: choice ? (project, risks) => onBranch(client, choice, project.id, risks, { identity }) : null,
  });

  const initiators = await collectInitiators(client, connection, projects, {
    rules: settings.initiators,
    useDirectory: settings.initiators.useDirectory,
    concurrency: config.concurrency,
    memory: knownAddresses,
    ...(choice ? { lastScans: choice.scans } : {}),
  });

  const wantedSeverities = automation.severities.length ? new Set(automation.severities) : null;
  // Only the engines chosen (SAST and SCA unless chosen otherwise; none chosen means every engine).
  const engines = engineScope(automation.engines);
  // Findings triaged as not exploitable (proposed or confirmed) are left out,
  // unless the administrator switched that off.
  const skipNotExploitable = settings.aiTriage?.skipNotExploitable !== false;
  const open = scan.projects
    .flatMap((summary) => summary.risks)
    .filter((risk) => !wantedSeverities || wantedSeverities.has(risk.severity))
    .filter((risk) => inEngines(risk, engines))
    .filter((risk) => !skipNotExploitable || !['NOT_EXPLOITABLE', 'PROPOSED_NOT_EXPLOITABLE'].includes(risk.state));

  // Each finding's limits: its severity's own (→ Reminders), or the same for every severity.
  const { crossed, seen } = findCrossings(open, (risk) => limitsFor(automation, risk.severity), ledger, { mode: automation.mode });
  const composed = crossed.length ? await compose(crossed, { settings, connection, initiators, now, reportFor }) : { messages: [], failures: [] };
  return { projects: scan.projects, total, inFocus, open, initiators, crossed, seen, ...composed };
}

/** The messages for what crossed: each person's own (or each project's), and the fixed list's. */
async function compose(crossed, { settings, connection, initiators, now, reportFor }) {
  const automation = settings.automation;
  const email = { ...DEFAULT_REMINDER_EMAIL, ...(settings.reminderEmail ?? {}) };
  const common = {
    buckets: [],
    tenant: connection.tenant,
    initiatorsByProject: initiators.byProject,
    links: settings.links,
    connection,
    branding: settings.branding,
    now,
  };
  /** One message: the branded email (→ Email), or the HTML template when that is chosen. */
  const build = (risks, group, why) => {
    if (email.style === 'html') return buildReminder(risks, settings.template, { ...common, ...(group ? { initiator: group } : {}) });
    const data = buildTemplateData(risks, { ...common, ...(group ? { initiator: group } : {}) });
    const per = new Map();
    for (const risk of risks) {
      const p = per.get(risk.projectId) ?? { critical: 0, high: 0, oldestDays: 0 };
      if (risk.severity === 'CRITICAL') p.critical += 1;
      if (risk.severity === 'HIGH') p.high += 1;
      p.oldestDays = Math.max(p.oldestDays, risk.ageDays ?? 0);
      per.set(risk.projectId, p);
    }
    data.projects = data.projects.map((p) => ({ ...p, ...per.get(p.projectId) }));
    data.crossedLimits = risks.map((r) => ({ severity: r.severity, days: r.threshold }));
    const buttonUrl = data.projects.length === 1 ? data.projects[0].url : projectsListUrl(connection, settings.links);
    const built = buildBrandedReminder(data, email, settings, { initiator: group?.initiator ?? '', to: group?.email ?? '', buttonUrl, why });
    return { ...built, data, projects: data.projects };
  };
  const attach = async (risks, group, to) => {
    if (!email.attachReport || !reportFor) return {};
    try {
      return { attachments: [await reportFor(risks, { initiator: group, to })] };
    } catch (error) {
      return { attachError: error.message };
    }
  };

  const messages = [];
  const failures = [];

  // Who gets them: Settings → Who gets reminders (each developer, the fixed list, or both), as everywhere else.
  const audience = ['initiator', 'list', 'both'].includes(settings.reminders?.audience) ? settings.reminders.audience : automation.groupBy === 'none' ? 'list' : 'initiator';
  const perDeveloper = audience !== 'list';
  const groupBy = perDeveloper ? (automation.groupBy === 'project' ? 'project' : 'initiator') : 'none';

  if (groupBy === 'initiator' || groupBy === 'project') {
    const groups =
      groupBy === 'project'
        ? groupRisksByProject(crossed, initiators.byProject)
        : groupRisksByInitiator(crossed, initiators.byProject);

    for (const group of groups) {
      if (!group.email) {
        failures.push({ to: group.initiator || '(unknown)', error: 'No email address could be resolved.', noAddress: true, risks: group.risks });
        continue;
      }
      const reminder = build(group.risks, group, 'You get this because you last scanned these projects.');
      // Exactly this person (plus the list's Cc/Bcc only when that is switched on): never
      // the configured list by default, which would copy them on someone else's projects.
      const copy = settings.initiators?.copyConfiguredRecipients === true;
      messages.push({
        to: [group.email],
        overrides: { exact: true, to: [group.email], cc: copy ? settings.recipients.cc : [], bcc: copy ? settings.recipients.bcc : [] },
        reminder,
        risks: group.risks,
        riskCount: group.risks.length,
        label: group.initiator,
        group,
      });
    }
  }
  if (audience !== 'initiator') {
    const list = settings.recipients ?? {};
    if (!list.to?.length && !list.cc?.length && !list.bcc?.length) {
      failures.push({ to: 'the fixed list', error: 'The fixed list is empty: add addresses on the Workbench (Remind → The fixed list), or send to each developer only.' });
    } else {
      const reminder = build(crossed, null, 'You get this as one of the people kept informed of these projects.');
      messages.push({ to: list.to, reminder, risks: crossed, riskCount: crossed.length, label: 'configured list' });
    }
  }
  return { messages, failures, attach };
}

/**
 * One unattended pass: fetch everything, find what has newly crossed, mail it.
 *
 * Returns a run record rather than throwing, so a failure is visible in the
 * status panel instead of taking the timer down with it.
 */
export async function runOnce({
  client,
  connection,
  config,
  settings,
  state,
  verified = false,
  now = new Date(),
  force = false,
  notifyAuthors = null,
  openIssues = null,
  reportFor = null,
}) {
  const automation = settings.automation;
  const started = Date.now();
  const dryRun = automation.dryRun && !force ? true : automation.dryRun;

  if (!verified && !dryRun) {
    return { ok: false, skipped: true, reason: 'SMTP has not passed a connection test, so nothing can be sent.' };
  }

  const decided = await decide({ client, connection, config, settings, ledger: state.ledger, now, reportFor });
  const { open, initiators, crossed, seen, messages, failures } = decided;

  // SLAs (Beta): findings that went past their SLA since the last run, escalated once each.
  const escalation = await escalateOverdue({ open, settings, state, initiators, dryRun, now, openIssues, context: { client, connection, projects: decided.projects, initiators: initiators.byProject } });

  if (crossed.length === 0) {
    const { pruned } = applyLedger(state.ledger, [], seen, now);
    state.persist();
    return {
      ok: true,
      dryRun,
      scanned: open.length,
      crossed: 0,
      sent: 0,
      pruned,
      elapsedMs: Date.now() - started,
      reason: 'Nothing new crossed a threshold.',
      ...(escalation ? { escalation } : {}),
    };
  }

  // A run's record keeps where each failure went, not the findings behind it.
  const failed = failures.map(({ risks, noAddress, ...f }) => f);
  let sent = 0;
  for (const message of messages) {
    if (dryRun) {
      sent += 1;
      continue;
    }
    try {
      const extra = await decided.attach(message.risks, message.group ?? null, message.to);
      const from = message.reminder.from ?? {};
      await sendReminderMail(settings, message.reminder, {
        ...(message.overrides ?? { to: message.to }),
        ...(extra.attachments ? { attachments: extra.attachments } : {}),
        ...(from.name ? { fromName: from.name } : {}),
        ...(from.replyTo ? { replyTo: from.replyTo } : {}),
      });
      sent += 1;
    } catch (error) {
      failed.push({ to: message.to.join(', '), error: error.message });
    }
  }

  // Only mark what actually went out, so a failed send is retried next run.
  const reported = dryRun || failed.length === 0 ? crossed : crossed.filter((risk) => wasSent(risk, messages, failed));
  const { pruned } = applyLedger(state.ledger, dryRun ? [] : reported, seen, now);
  state.persist();

  // The developer who last changed each vulnerable line, as well (when switched on): never
  // a reason for the run to fail, and never repeated for a finding (only what just crossed).
  let codeAuthors;
  if (automation.notifyCodeAuthors && notifyAuthors) {
    try {
      codeAuthors = await notifyAuthors(crossed, { client, connection, projects: decided.projects, initiators: initiators.byProject, dryRun });
    } catch (error) {
      codeAuthors = { error: error.message };
    }
  }

  return {
    ok: failed.length === 0,
    dryRun,
    scanned: open.length,
    crossed: crossed.length,
    sent,
    pruned,
    failures: failed,
    elapsedMs: Date.now() - started,
    thresholds: automation.perSeverity ? automation.severityLimits : automation.thresholds,
    ...(codeAuthors ? { codeAuthors } : {}),
    ...(escalation ? { escalation } : {}),
  };
}

/**
 * Escalate what went past its SLA since the last run (Settings → SLAs): one
 * email to the escalation list, each finding only once. A failed send is tried
 * again next run; in test mode nothing is sent or remembered. Never a reason
 * for the run to fail. Returns {escalated, sent} or null when escalation is off.
 */
async function escalateOverdue({ open, settings, state, initiators, dryRun, now, openIssues = null, context = {} }) {
  const sla = settings.sla;
  const mail = Boolean(sla?.escalate && sla.escalateTo?.length);
  const issues = Boolean(sla?.openIssues && openIssues);
  if (!mail && !issues) return null;
  const result = {};
  let changed = false;

  if (mail) {
    const escalated = (state.ledger.escalated ??= {});
    if (pruneEscalated(escalated, open)) changed = true;
    const items = newlyOverdue(open, sla, escalated, now.getTime());
    Object.assign(result, { escalated: items.length, sent: false });
    if (items.length && dryRun) result.dryRun = true;
    else if (items.length) {
      const message = escalationMail(items, { appName: settings.branding?.appName, companyName: settings.branding?.companyName, initiators: initiators.byProject });
      try {
        await sendReminderMail(settings, message, { exact: true, to: sla.escalateTo, cc: [], bcc: [] });
        for (const { risk } of items) escalated[slaKey(risk)] = now.toISOString();
        Object.assign(result, { sent: true, to: sla.escalateTo.length });
        changed = true;
      } catch (error) {
        result.error = error.message;
      }
    }
  }

  // The same findings, once each, as an issue in their project's repository (its own record,
  // so turning one on later does not skip what the other already covered).
  if (issues) {
    const issued = (state.ledger.issued ??= {});
    if (pruneEscalated(issued, open)) changed = true;
    const items = newlyOverdue(open, sla, issued, now.getTime());
    if (!items.length) result.issues = { opened: 0, findings: 0 };
    else {
      try {
        const done = await openIssues(items, { ...context, dryRun });
        result.issues = {
          opened: done.opened.length,
          findings: done.opened.reduce((n, o) => n + o.findings, 0),
          urls: done.opened.map((o) => o.url).filter(Boolean),
          skipped: done.skipped,
          ...(dryRun ? { dryRun: true } : {}),
        };
        if (!dryRun) {
          for (const [key, url] of Object.entries(done.issuedKeys)) issued[key] = { at: now.toISOString(), url: typeof url === 'string' ? url : '' };
          if (Object.keys(done.issuedKeys).length) changed = true;
        }
      } catch (error) {
        result.issues = { error: error.message };
      }
    }
  }
  if (changed) state.persist();
  return result;
}

/** Whether the message carrying this finding was delivered. */
function wasSent(risk, messages, failures) {
  const failedTo = new Set(failures.map((f) => f.to));
  const message = messages.find((m) => m.reminder.data.projects.some((p) => p.projectId === risk.projectId));
  return message ? !failedTo.has(message.to.join(', ')) : false;
}

// ---------------------------------------------------------------------------

/** Drives runOnce on a timer (every so many minutes, or on chosen days at a time), and reports when the next pass is due. */
export class Scheduler {
  #timer = null;
  #running = false;
  #nextRunAt = null;
  #resolve;
  #state;
  #settingsStore;
  #config;

  #verified;

  #notifyAuthors;

  #openIssues;

  #reportFor;

  constructor({ resolveSession, state, settingsStore, config, isVerified, notifyAuthors = null, openIssues = null, reportFor = null }) {
    this.#notifyAuthors = notifyAuthors;
    this.#openIssues = openIssues;
    this.#reportFor = reportFor;
    this.#resolve = resolveSession;
    this.#state = state;
    this.#settingsStore = settingsStore;
    this.#config = config;
    this.#verified = isVerified;
  }

  get status() {
    const automation = this.#settingsStore.get().automation;
    return {
      enabled: automation.enabled,
      running: this.#running,
      nextRunAt: automation.enabled ? this.#nextRunAt : null,
      intervalMinutes: automation.intervalMinutes,
      when: automation.when ?? 'interval',
      runs: this.#state.runs.slice(0, 10),
      trackedFindings: Object.keys(this.#state.ledger.notified).length,
    };
  }

  /** Apply the current settings: start, stop or re-time the timer. */
  sync() {
    this.stop();
    if (!this.#settingsStore.get().automation.enabled) return;
    this.#arm();
  }

  /** The next pass, from now. A timer is at most a day long (setTimeout's limit is ~24.8 days), then looks again. */
  #arm() {
    const next = nextRunAfter(this.#settingsStore.get().automation, new Date());
    this.#nextRunAt = next ? next.toISOString() : null;
    if (!next) return;
    const wait = Math.max(1000, next.getTime() - Date.now());
    const day = 24 * 60 * 60_000;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (wait > day) return this.#arm();
      this.tick().finally(() => {
        if (this.#settingsStore.get().automation.enabled && !this.#timer) this.#arm();
      });
    }, Math.min(wait, day));
    this.#timer.unref?.();
  }

  stop() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#nextRunAt = null;
  }

  /**
   * What a pass would send now, without sending or remembering anything (Act → Automation → Preview), on
   * the given settings (the saved ones when none are given).
   */
  async preview({ settings = this.#settingsStore.get() } = {}) {
    const session = this.#resolve();
    if (!session) return null;
    return decide({ client: session.client, connection: session.connection, config: this.#config(), settings, ledger: structuredClone(this.#state.ledger) });
  }

  async tick({ force = false } = {}) {
    // Overlapping passes would double-send, so a slow run simply skips a beat.
    if (this.#running) return { ok: false, skipped: true, reason: 'A run is already in progress.' };

    // Hands-off mode: paused from an email (a link or a PAUSE reply) until a date. Run now still runs.
    const pausedUntil = this.#settingsStore.get().handsOff?.pausedUntil;
    if (!force && pausedUntil && Date.parse(pausedUntil) > Date.now()) {
      return { ok: true, skipped: true, reason: `Paused until ${pausedUntil}.` };
    }

    this.#running = true;
    try {
      const session = this.#resolve();
      if (!session) {
        return this.#state.recordRun({
          ok: false,
          skipped: true,
          how: force ? 'now' : 'scheduled',
          reason:
            'No stored Checkmarx credential. Set CX_API_KEY, or arm automation with the current key on the Settings page.',
        });
      }

      const result = await runOnce({
        client: session.client,
        connection: session.connection,
        config: this.#config(),
        settings: this.#settingsStore.get(),
        state: this.#state,
        verified: this.#verified(this.#settingsStore.get()),
        force,
        notifyAuthors: this.#notifyAuthors,
        openIssues: this.#openIssues,
        reportFor: this.#reportFor ? (risks, options) => this.#reportFor(session, risks, options) : null,
      });
      return this.#state.recordRun({ how: force ? 'now' : 'scheduled', ...result });
    } catch (error) {
      return this.#state.recordRun({ ok: false, how: force ? 'now' : 'scheduled', error: error.message });
    } finally {
      this.#running = false;
      // A pass run by hand leaves the schedule as it was; an interval counts again from now.
      const automation = this.#settingsStore.get().automation;
      if (automation.enabled && (automation.when ?? 'interval') !== 'schedule') {
        this.stop();
        this.#arm();
      }
    }
  }
}
