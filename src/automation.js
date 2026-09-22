import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { listProjects } from './cxone/projects.js';
import { collectProjectRisks } from './cxone/risks.js';
import { collectInitiators, groupRisksByInitiator } from './cxone/initiators.js';
import { buildReminder } from './reminder.js';
import { sendReminderMail } from './mailer.js';
import { DEFAULT_AUTOMATION } from './automation-config.js';

export { DEFAULT_AUTOMATION, mergeAutomation, parseThresholds } from './automation-config.js';

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
  const sorted = [...thresholds].sort((a, b) => a - b);
  const crossed = [];
  const seen = new Set();

  for (const risk of risks) {
    const key = riskKey(risk);
    seen.add(key);
    if (risk.ageDays === null || risk.ageDays === undefined) continue;

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
      return { notified: raw.notified ?? {}, runs: Array.isArray(raw.runs) ? raw.runs : [] };
    } catch {
      return { notified: {}, runs: [] };
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
}) {
  const automation = settings.automation;
  const started = Date.now();
  const dryRun = automation.dryRun && !force ? true : automation.dryRun;

  if (!verified && !dryRun) {
    return { ok: false, skipped: true, reason: 'SMTP has not passed a connection test, so nothing can be sent.' };
  }

  // Automation always looks at the whole tenant: a scope filter here would
  // silently exclude projects from ever being reported.
  const projects = await listProjects(client);
  const scan = await collectProjectRisks(client, config, projects, { now });

  const initiators = await collectInitiators(client, connection, projects, {
    rules: settings.initiators,
    useDirectory: settings.initiators.useDirectory,
    concurrency: config.concurrency,
  });

  const wantedSeverities = automation.severities.length ? new Set(automation.severities) : null;
  const open = scan.projects
    .flatMap((summary) => summary.risks)
    .filter((risk) => !wantedSeverities || wantedSeverities.has(risk.severity));

  const { crossed, seen } = findCrossings(open, automation.thresholds, state.ledger, { mode: automation.mode });

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
    };
  }

  const common = {
    buckets: [],
    tenant: connection.tenant,
    initiatorsByProject: initiators.byProject,
    links: settings.links,
    connection,
    now,
  };

  const messages = [];
  const failures = [];

  if (automation.groupBy === 'initiator') {
    for (const group of groupRisksByInitiator(crossed, initiators.byProject)) {
      if (!group.email) {
        failures.push({ to: group.initiator || '(unknown)', error: 'No email address could be resolved.' });
        continue;
      }
      const reminder = buildReminder(group.risks, settings.template, { ...common, initiator: group });
      messages.push({ to: [group.email], reminder, riskCount: group.risks.length, label: group.initiator });
    }
  } else {
    const reminder = buildReminder(crossed, settings.template, common);
    messages.push({ to: settings.recipients.to, reminder, riskCount: crossed.length, label: 'configured list' });
  }

  let sent = 0;
  for (const message of messages) {
    if (dryRun) {
      sent += 1;
      continue;
    }
    try {
      await sendReminderMail(settings, message.reminder, { to: message.to });
      sent += 1;
    } catch (error) {
      failures.push({ to: message.to.join(', '), error: error.message });
    }
  }

  // Only mark what actually went out, so a failed send is retried next run.
  const reported = dryRun || failures.length === 0 ? crossed : crossed.filter((risk) => wasSent(risk, messages, failures));
  const { pruned } = applyLedger(state.ledger, dryRun ? [] : reported, seen, now);
  state.persist();

  return {
    ok: failures.length === 0,
    dryRun,
    scanned: open.length,
    crossed: crossed.length,
    sent,
    pruned,
    failures,
    elapsedMs: Date.now() - started,
    thresholds: automation.thresholds,
  };
}

/** Whether the message carrying this finding was delivered. */
function wasSent(risk, messages, failures) {
  const failedTo = new Set(failures.map((f) => f.to));
  const message = messages.find((m) => m.reminder.data.projects.some((p) => p.projectId === risk.projectId));
  return message ? !failedTo.has(message.to.join(', ')) : false;
}

// ---------------------------------------------------------------------------

/** Drives runOnce on a timer, and reports when the next pass is due. */
export class Scheduler {
  #timer = null;
  #running = false;
  #nextRunAt = null;
  #resolve;
  #state;
  #settingsStore;
  #config;

  #verified;

  constructor({ resolveSession, state, settingsStore, config, isVerified }) {
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
      runs: this.#state.runs.slice(0, 10),
      trackedFindings: Object.keys(this.#state.ledger.notified).length,
    };
  }

  /** Apply the current settings: start, stop or re-space the timer. */
  sync() {
    const { enabled, intervalMinutes } = this.#settingsStore.get().automation;
    this.stop();
    if (!enabled) return;

    const period = intervalMinutes * 60_000;
    this.#nextRunAt = new Date(Date.now() + period).toISOString();
    this.#timer = setInterval(() => this.tick(), period);
    this.#timer.unref?.();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#nextRunAt = null;
  }

  async tick({ force = false } = {}) {
    // Overlapping passes would double-send, so a slow run simply skips a beat.
    if (this.#running) return { ok: false, skipped: true, reason: 'A run is already in progress.' };

    this.#running = true;
    try {
      const session = this.#resolve();
      if (!session) {
        return this.#state.recordRun({
          ok: false,
          skipped: true,
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
      });
      return this.#state.recordRun(result);
    } catch (error) {
      return this.#state.recordRun({ ok: false, error: error.message });
    } finally {
      this.#running = false;
      const { enabled, intervalMinutes } = this.#settingsStore.get().automation;
      if (enabled) this.#nextRunAt = new Date(Date.now() + intervalMinutes * 60_000).toISOString();
    }
  }
}
