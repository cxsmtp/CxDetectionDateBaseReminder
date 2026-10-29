/**
 * Govern (beta): the per-tenant state on disk, and the rules every budget, exemption and setting is checked by.
 *
 * Everything lives in the tenant's state folder under govern/ (SPEC §2.12):
 *   budgets.json    budgets and exemptions, each with a version (optimistic concurrency), and a data version
 *   periods.json    each budget's state per period (used, status, warned/breached, grace after an admin restore)
 *   subjects.json   attribution decisions (pinned / rejected / ignored, with aliases) and the queue
 *   requests.json   credit requests and their threads
 *   settings.json   Govern settings (the webhook secret too: write-only through the API, never returned)
 *   runs.json       the last cycles
 * Holds (enforce.js), alerts and the outbox (notify.js) and usage series (ingest.js, usage-<dimension>.json) keep their
 * own files; org.json, dimensions.json and credits.json hold the last good org, dimension support and tenant credits.
 * The folder is in every backup (data-dir.js STATE_DIRS).
 *
 * Files are written whole and atomically: an unguessable temporary name created only if nothing is there
 * (never through a link left in its place), mode 0600, flushed to disk, then renamed. Requests never read a
 * file: everything here is in memory, and only changes are written.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ENTITY_TYPES = ['user', 'group', 'project', 'application'];
export const PERIODS = ['monthly', 'quarterly', 'custom', 'lifetime'];
export const MODES = ['monitor', 'enforce'];
export const WINDOWS = ['last_month', 'last_30_days', 'last_90_days', 'last_180_days', 'last_year'];
export const WINDOW_DAYS = { last_month: 31, last_30_days: 30, last_90_days: 90, last_180_days: 180, last_year: 365 };
export const SEVERITIES = ['info', 'warning', 'error', 'critical'];
export const CYCLE_MINUTES = [0, 2, 5, 15, 60];
/** The roles a breached user loses by default: Checkmarx One's AI views. view-scans is opt-in (it removes ordinary scan viewing too). */
export const DEFAULT_AI_ROLES = ['view-risk-management', 'view-risk-management-dashboard', 'view-risk-management-tab'];
export const MAX_AMOUNT = 100_000_000;
const MAX_ID = 200;

export const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });

/** A key that is safe as an object key and in a file: a bounded string, never one that reaches Object.prototype. */
export function cleanId(value, { label = 'id', max = MAX_ID } = {}) {
  const id = String(value ?? '').trim();
  if (!id || id.length > max || /[\u0000-\u001f\u007f]/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw fail(400, `That ${label} is not valid.`);
  return id;
}

/** Plain text of at most `max` characters, control characters (but tabs and line breaks) removed. Never trimmed when `keep`. */
export function cleanText(value, max = 1024, { keep = false } = {}) {
  const text = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return (keep ? text : text.trim()).slice(0, max);
}

const isoOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const t = Date.parse(String(value));
  return Number.isFinite(t) ? new Date(t).toISOString() : NaN;
};

/** Write `text` to `file` atomically: unguessable temporary name, created only if absent, 0600, synced, renamed. */
export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** Append one line and make sure it is on disk before returning (a write-ahead record). */
export function appendDurable(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, line.endsWith('\n') ? line : `${line}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Every readable line of a JSON Lines file (a torn last line, from a crash mid-write, is skipped). */
export function readJsonl(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

export const hashOf = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

// ---------------------------------------------------------------------------
// Budgets and exemptions
// ---------------------------------------------------------------------------

export const entityKey = (type, id) => `${type}:${id}`;

const bool = (value, fallback) => (value === undefined || value === null || value === '' ? fallback : value === true || value === 'true');

/** A number of credits: decimals allowed, 0 … 100,000,000, at most 4 decimals. */
export function cleanAmount(value, label = 'Budget') {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(n) || n < 0 || n > MAX_AMOUNT) throw fail(400, `${label} must be a number of credits from 0 to ${MAX_AMOUNT.toLocaleString('en')}.`);
  return Math.round(n * 10000) / 10000;
}

/**
 * A budget from a request (or a CSV row), on top of `existing` when changing one: unknown fields are ignored,
 * every field is checked and bounded. `canEnforce`: the actor holds govern.enforce (Enforce needs it).
 */
export function cleanBudget(input = {}, existing = null, { actor = '', canEnforce = false, now = new Date() } = {}) {
  const has = (k) => Object.hasOwn(input, k) && input[k] !== undefined;
  const base = existing ?? {
    id: randomUUID(),
    version: 0,
    entityType: '',
    entityId: '',
    entityLabel: '',
    amount: 0,
    period: 'monthly',
    customStart: null,
    customEnd: null,
    warnPct: 80,
    mode: 'monitor',
    enforcedBy: null,
    active: true,
    includeMembers: false,
    includeSubgroups: false,
    countExisting: false,
    holdUntilReleased: false,
    maxTargets: 25,
    fanoutConfirmedAt: null,
    notes: '',
    topUps: [],
    createdAt: now.toISOString(),
    createdBy: actor,
  };
  const b = { ...base, topUps: [...(base.topUps ?? [])] };
  if (!existing) {
    if (!ENTITY_TYPES.includes(input.entityType)) throw fail(400, 'Choose who the budget is for: a user, group, project or application.');
    b.entityType = input.entityType;
    b.entityId = cleanId(input.entityId, { label: 'entity id' });
  }
  if (has('entityLabel')) b.entityLabel = cleanText(input.entityLabel, 512);
  if (!existing && (!has('amount') || input.amount === '' || input.amount === null)) throw fail(400, 'Give the budget an amount of credits.');
  if (has('amount')) b.amount = cleanAmount(input.amount);
  if (has('period')) {
    if (!PERIODS.includes(input.period)) throw fail(400, 'The period is monthly, quarterly, custom or lifetime.');
    b.period = input.period;
  }
  if (has('customStart')) b.customStart = isoOrNull(input.customStart);
  if (has('customEnd')) b.customEnd = isoOrNull(input.customEnd);
  if (Number.isNaN(b.customStart) || Number.isNaN(b.customEnd)) throw fail(400, 'Dates are YYYY-MM-DD or a full ISO 8601 time.');
  if (b.period === 'custom') {
    if (!b.customStart) throw fail(400, 'A custom period needs a start date.');
    if (b.customEnd && Date.parse(b.customEnd) <= Date.parse(b.customStart)) throw fail(400, 'The end date must be after the start date.');
  } else {
    b.customStart = null;
    b.customEnd = null;
  }
  if (has('warnPct')) {
    const pct = Number(input.warnPct);
    if (!Number.isInteger(pct) || pct < 1 || pct > 100) throw fail(400, 'The warning threshold is a whole percentage from 1 to 100.');
    b.warnPct = pct;
  }
  if (has('mode')) {
    if (!MODES.includes(input.mode)) throw fail(400, 'The mode is monitor or enforce.');
    if (input.mode === 'enforce' && b.mode !== 'enforce') {
      if (!canEnforce) throw fail(403, 'Only someone allowed to enforce budgets can switch one to Enforce.', { permission: 'govern.enforce' });
      b.enforcedBy = { by: actor, at: now.toISOString() };
    }
    if (input.mode === 'monitor') b.enforcedBy = null;
    b.mode = input.mode;
  }
  if (has('active')) b.active = bool(input.active, b.active);
  if (has('includeMembers')) b.includeMembers = bool(input.includeMembers, false);
  if (has('includeSubgroups')) b.includeSubgroups = bool(input.includeSubgroups, false);
  if (b.entityType !== 'group') {
    b.includeMembers = false;
    b.includeSubgroups = false;
  }
  if (has('countExisting')) b.countExisting = bool(input.countExisting, false);
  if (has('holdUntilReleased')) b.holdUntilReleased = bool(input.holdUntilReleased, false);
  if (has('maxTargets')) {
    const n = Number(input.maxTargets);
    if (!Number.isInteger(n) || n < 1 || n > 10_000) throw fail(400, 'The most targets one breach may restrict is a whole number from 1 to 10,000.');
    b.maxTargets = n;
  }
  if (has('fanoutConfirmed')) {
    // Restricting more projects than the budget's ceiling is an enforcement decision.
    if (input.fanoutConfirmed === true && !canEnforce) throw fail(403, 'Only someone allowed to enforce budgets can confirm restricting that many projects.', { permission: 'govern.enforce' });
    b.fanoutConfirmedAt = input.fanoutConfirmed === true ? now.toISOString() : null;
  }
  if (has('notes')) b.notes = cleanText(input.notes, 1024, { keep: true });
  // An Enforce budget stays Enforce: making it restrict more (or sooner) is an enforcement decision too.
  if (existing?.mode === 'enforce' && b.mode === 'enforce' && !canEnforce && widensEnforcement(existing, b)) {
    throw fail(403, 'Only someone allowed to enforce budgets can change what an Enforce budget restricts.', { permission: 'govern.enforce' });
  }
  return b;
}

/** Switches that make a budget restrict more when turned on (active: a paused budget restricts nothing). */
const WIDENING_SWITCHES = ['active', 'includeMembers', 'includeSubgroups', 'countExisting', 'holdUntilReleased'];

/**
 * Whether `after` restricts more than `before`: more projects per breach, fewer credits, a switch turned on, or a
 * different period or dates (which can only be judged by someone who may enforce). Pausing it, lowering its
 * ceiling, raising its amount, switching a widening option off, its notes and warning threshold do not.
 */
export function widensEnforcement(before, after) {
  if (Number(after.maxTargets) > Number(before.maxTargets)) return true;
  if (Number(after.amount) < Number(before.amount)) return true;
  if (WIDENING_SWITCHES.some((k) => Boolean(after[k]) && !Boolean(before[k]))) return true;
  return after.period !== before.period || (after.customStart ?? null) !== (before.customStart ?? null) || (after.customEnd ?? null) !== (before.customEnd ?? null);
}

/** What an audit entry or the page shows of a budget (everything: a budget holds no secret). */
export const budgetView = (b) => (b ? JSON.parse(JSON.stringify(b)) : null);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS = {
  cycleMinutes: 15,
  window: 'last_30_days',
  pageSize: 1000,
  orgRefreshMinutes: 30,
  aiRoles: DEFAULT_AI_ROLES,
  aiOnlyGroups: [],
  prDisableUnreadable: false,
  graceGrowBy: 1,
  driftEveryCycles: 4,
  maxTargetsDefault: 25,
  requestExpiryDays: 14,
  staleAfterCycles: 3,
  notify: {
    minSeverity: 'warning',
    email: { on: false, recipients: [], minSeverity: 'warning' },
    webhook: { on: false, url: '', secret: '', minSeverity: 'warning' },
  },
};

const EMAIL = /^(?=[^]{3,254}$)[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const ROLE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,99}$/;

/**
 * Settings from a request on top of `current`. The webhook secret is write-only: absent or null keeps it,
 * '' clears it. `checkUrl(url)` throws when the webhook address may not be called (outbound-url.js).
 */
export function cleanSettings(input = {}, current = DEFAULT_SETTINGS, { checkUrl = null } = {}) {
  const s = JSON.parse(JSON.stringify(current));
  const has = (o, k) => o && Object.hasOwn(o, k) && o[k] !== undefined;
  if (has(input, 'cycleMinutes')) {
    const n = Number(input.cycleMinutes);
    if (!CYCLE_MINUTES.includes(n)) throw fail(400, 'Cycles run every 2, 5, 15 or 60 minutes, or 0 (off).');
    s.cycleMinutes = n;
  }
  if (has(input, 'window')) {
    if (!WINDOWS.includes(input.window)) throw fail(400, `The lookback window is one of ${WINDOWS.join(', ')}.`);
    s.window = input.window;
  }
  for (const [key, min, max, label] of [
    ['pageSize', 1, 1000, 'The page size'],
    ['orgRefreshMinutes', 5, 1440, 'The org refresh interval (minutes)'],
    ['driftEveryCycles', 1, 96, 'The drift check (every N cycles)'],
    ['maxTargetsDefault', 1, 10_000, 'The default most targets per breach'],
    ['requestExpiryDays', 1, 365, 'Days before an open request expires'],
    ['staleAfterCycles', 1, 96, 'Cycles before usage counts as stale'],
  ]) {
    if (!has(input, key)) continue;
    const n = Number(input[key]);
    if (!Number.isInteger(n) || n < min || n > max) throw fail(400, `${label} is a whole number from ${min} to ${max}.`);
    s[key] = n;
  }
  if (has(input, 'graceGrowBy')) s.graceGrowBy = cleanAmount(input.graceGrowBy, 'The grace after a restore');
  if (has(input, 'prDisableUnreadable')) s.prDisableUnreadable = input.prDisableUnreadable === true;
  if (has(input, 'aiRoles')) {
    const roles = [...new Set((Array.isArray(input.aiRoles) ? input.aiRoles : []).map((r) => String(r).trim()).filter(Boolean))];
    if (!roles.length || roles.length > 20 || roles.some((r) => !ROLE_NAME.test(r))) throw fail(400, 'Name 1 to 20 Checkmarx One roles (letters, digits, . _ : - and spaces).');
    s.aiRoles = roles;
  }
  if (has(input, 'aiOnlyGroups')) {
    const groups = [...new Set((Array.isArray(input.aiOnlyGroups) ? input.aiOnlyGroups : []).map((g) => String(g).trim()).filter(Boolean))];
    if (groups.length > 100) throw fail(400, 'At most 100 AI-only groups.');
    s.aiOnlyGroups = groups.map((g) => cleanId(g, { label: 'group id' }));
  }
  const notify = input.notify;
  if (notify && typeof notify === 'object') {
    const sev = (v, label) => {
      if (!SEVERITIES.includes(v)) throw fail(400, `${label} is info, warning, error or critical.`);
      return v;
    };
    if (has(notify, 'minSeverity')) s.notify.minSeverity = sev(notify.minSeverity, 'The minimum severity');
    const email = notify.email;
    if (email && typeof email === 'object') {
      if (has(email, 'on')) s.notify.email.on = email.on === true;
      if (has(email, 'minSeverity')) s.notify.email.minSeverity = sev(email.minSeverity, 'The email minimum severity');
      if (has(email, 'recipients')) {
        const list = (Array.isArray(email.recipients) ? email.recipients : String(email.recipients).split(/[,;\s]+/)).map((a) => String(a).trim().toLowerCase()).filter(Boolean);
        if (list.length > 50 || list.some((a) => !EMAIL.test(a))) throw fail(400, 'Recipients are up to 50 email addresses.');
        s.notify.email.recipients = [...new Set(list)];
      }
    }
    const hook = notify.webhook;
    if (hook && typeof hook === 'object') {
      if (has(hook, 'on')) s.notify.webhook.on = hook.on === true;
      if (has(hook, 'minSeverity')) s.notify.webhook.minSeverity = sev(hook.minSeverity, 'The webhook minimum severity');
      if (has(hook, 'url')) {
        const url = String(hook.url ?? '').trim();
        if (url.length > 2000) throw fail(400, 'That webhook address is too long.');
        if (url && checkUrl) checkUrl(url);
        s.notify.webhook.url = url;
      }
      if (has(hook, 'secret') && hook.secret !== null) {
        const secret = String(hook.secret);
        if (secret.length > 256) throw fail(400, 'The webhook signing secret is at most 256 characters.');
        s.notify.webhook.secret = secret;
      }
    }
  }
  if (s.notify.webhook.on && !s.notify.webhook.url) throw fail(400, 'Give the webhook an address before turning it on.');
  return s;
}

/** Settings as the page and the audit log see them: the secret is never shown, only whether one is set. */
export function publicSettings(s) {
  const out = JSON.parse(JSON.stringify(s));
  out.notify.webhook.secretSet = Boolean(s.notify.webhook.secret);
  delete out.notify.webhook.secret;
  return out;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class GovernStore {
  #dir;
  /** Budgets by id. */
  budgets = new Map();
  /** Exemptions by `${type}:${id}`. */
  exemptions = new Map();
  /** Period states by `${budgetId}|${periodKey}`. */
  periods = new Map();
  /** Attribution decisions by `${dimension}:${subjectKey}`. */
  decisions = new Map();
  /** Credit requests by id. */
  requests = new Map();
  settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  /** The last cycles, newest first. */
  runs = [];
  /** Changes with each write of budgets, exemptions, decisions or requests: part of every view's ETag. */
  dataVersion = 0;

  constructor({ dir }) {
    this.#dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const budgets = readJson(this.#file('budgets.json'), {});
    for (const b of Array.isArray(budgets.budgets) ? budgets.budgets : []) if (b?.id && ENTITY_TYPES.includes(b.entityType)) this.budgets.set(String(b.id), b);
    for (const e of Array.isArray(budgets.exemptions) ? budgets.exemptions : []) if (e?.entityType && e?.entityId) this.exemptions.set(entityKey(e.entityType, e.entityId), e);
    this.dataVersion = Number(budgets.dataVersion) || 0;
    const periods = readJson(this.#file('periods.json'), {});
    for (const p of Array.isArray(periods.periods) ? periods.periods : []) if (p?.budgetId && p?.periodKey) this.periods.set(`${p.budgetId}|${p.periodKey}`, p);
    const subjects = readJson(this.#file('subjects.json'), {});
    for (const d of Array.isArray(subjects.decisions) ? subjects.decisions : []) if (d?.key) this.decisions.set(String(d.key), d);
    const requests = readJson(this.#file('requests.json'), {});
    for (const r of Array.isArray(requests.requests) ? requests.requests : []) if (r?.id) this.requests.set(String(r.id), r);
    const stored = readJson(this.#file('settings.json'), null);
    if (stored) {
      try {
        this.settings = cleanSettings(stored, DEFAULT_SETTINGS);
        // A stored secret is kept as it was (cleanSettings only takes a new one).
        this.settings.notify.webhook.secret = String(stored.notify?.webhook?.secret ?? '');
      } catch {
        this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
      }
    }
    const runs = readJson(this.#file('runs.json'), {});
    this.runs = Array.isArray(runs.runs) ? runs.runs.slice(0, 20) : [];
  }

  get dir() {
    return this.#dir;
  }

  #file(name) {
    return path.join(this.#dir, name);
  }

  saveBudgets() {
    this.dataVersion += 1;
    writeAtomic(this.#file('budgets.json'), JSON.stringify({ dataVersion: this.dataVersion, budgets: [...this.budgets.values()], exemptions: [...this.exemptions.values()] }));
  }

  savePeriods() {
    writeAtomic(this.#file('periods.json'), JSON.stringify({ periods: [...this.periods.values()] }));
  }

  saveDecisions() {
    this.dataVersion += 1;
    writeAtomic(this.#file('subjects.json'), JSON.stringify({ decisions: [...this.decisions.values()] }));
  }

  saveRequests() {
    this.dataVersion += 1;
    writeAtomic(this.#file('requests.json'), JSON.stringify({ requests: [...this.requests.values()] }));
  }

  saveSettings() {
    this.dataVersion += 1;
    writeAtomic(this.#file('settings.json'), JSON.stringify(this.settings));
  }

  saveRuns() {
    writeAtomic(this.#file('runs.json'), JSON.stringify({ runs: this.runs.slice(0, 20) }));
  }

  budgetFor(entityType, entityId) {
    for (const b of this.budgets.values()) if (b.entityType === entityType && b.entityId === entityId) return b;
    return null;
  }

  isExempt(entityType, entityId) {
    return this.exemptions.has(entityKey(entityType, entityId));
  }
}
