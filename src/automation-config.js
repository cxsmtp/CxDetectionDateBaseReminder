/**
 * Automation configuration schema.
 *
 * Deliberately dependency-free (engines.js is a leaf too): settings.js needs these defaults, and
 * automation.js needs settings.js (through the mailer), so anything shared
 * between them has to live in a leaf module or the two form an import cycle.
 */
import { DEFAULT_ENGINES, cleanEngines } from './engines.js';

export const DEFAULT_AUTOMATION = {
  enabled: false,
  // 'crossing' mails only findings that newly passed a threshold.
  // 'digest' mails everything currently past the lowest threshold, every run.
  mode: 'crossing',
  thresholds: [30, 60, 90],
  intervalMinutes: 360,
  severities: [],
  // The engines whose findings are reminded about: SAST and SCA (what AI Triage and Remediation act on)
  // unless chosen otherwise; [] means every engine (what a schedule saved before engines existed keeps).
  engines: [...DEFAULT_ENGINES],
  // One branch per project, its primary branch ('primary'), or every branch ('all': what a schedule saved
  // before branches were told apart keeps), and whether projects whose scan counted no lines of code are left out.
  branches: 'primary',
  leaveOutNoCode: true,
  groupBy: 'initiator',
  // Kept so a run can be rehearsed in production without mailing anyone.
  dryRun: false,
  // Also email the developer who last changed each vulnerable line (once "Code authors" is final).
  notifyCodeAuthors: false,
  // Age limits for each severity of its own (Act → Automation → Reminders), instead of `thresholds` for all.
  // A severity with no days is not reminded about.
  perSeverity: false,
  severityLimits: { CRITICAL: [7, 14, 30], HIGH: [30, 60], MEDIUM: [90], LOW: [] },
  // What reminders cover (→ Focus): applications by name, project tags (key or key:value), and project
  // names with * and ? as wildcards to keep or leave out. Empty: every project.
  focus: { applications: [], tags: [], projects: [], exclude: [] },
  // When runs go out: 'schedule' (these days, at this time, in this time zone; empty: the server's) or
  // 'interval' (every intervalMinutes). A schedule saved before there was a choice keeps its interval.
  when: 'schedule',
  days: [1, 2, 3, 4, 5],
  at: '09:00',
  timeZone: '',
};

export const LIMIT_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

const FOCUS_MAX = 50;

/** Names, tags or patterns typed as "a, b" or a list: trimmed, de-duplicated, at most 50 of 120 characters. */
export function parseNames(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[,;\n]+/);
  return [...new Set(list.map((entry) => String(entry ?? '').trim().slice(0, 120)).filter(Boolean))].slice(0, FOCUS_MAX);
}

/** "7, 14, 30" → [7, 14, 30]; blank or "none" → [] (that severity is not reminded about). */
export function parseLimits(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/);
  return [...new Set(list.map((entry) => Number.parseInt(entry, 10)).filter((n) => Number.isFinite(n) && n > 0 && n <= 3650))].sort((a, b) => a - b).slice(0, 10);
}

/** A valid IANA time zone, else '' (the server's own). */
export function cleanTimeZone(value) {
  const zone = String(value ?? '').trim();
  if (!zone || zone.length > 64) return '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return '';
  }
}

export class AutomationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AutomationError';
    this.status = status;
  }
}

/** Coerce administrator input into a usable automation config. */
export function mergeAutomation(current, incoming = {}) {
  const next = { ...current };

  if ('enabled' in incoming) next.enabled = Boolean(incoming.enabled);
  if ('dryRun' in incoming) next.dryRun = Boolean(incoming.dryRun);
  if ('notifyCodeAuthors' in incoming) next.notifyCodeAuthors = incoming.notifyCodeAuthors === true;
  if ('mode' in incoming) next.mode = incoming.mode === 'digest' ? 'digest' : 'crossing';
  if ('groupBy' in incoming) {
    next.groupBy = ['none', 'initiator', 'project'].includes(incoming.groupBy) ? incoming.groupBy : 'initiator';
  }

  if ('intervalMinutes' in incoming) {
    const minutes = Number.parseInt(incoming.intervalMinutes, 10);
    // Below 15 minutes is pointless against daily-changing data and only
    // burns API quota; a week is the longest that still catches a threshold
    // reasonably close to when it is crossed.
    next.intervalMinutes = Number.isFinite(minutes) ? Math.min(10_080, Math.max(15, minutes)) : current.intervalMinutes;
  }

  if ('thresholds' in incoming) next.thresholds = parseThresholds(incoming.thresholds, current.thresholds);

  if ('severities' in incoming) {
    const allowed = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
    const list = Array.isArray(incoming.severities)
      ? incoming.severities
      : String(incoming.severities ?? '').split(/[\s,;]+/);
    next.severities = [...new Set(list.map((s) => String(s).trim().toUpperCase()).filter((s) => allowed.includes(s)))];
  }

  if ('engines' in incoming) next.engines = cleanEngines(incoming.engines);
  if ('branches' in incoming) next.branches = incoming.branches === 'all' ? 'all' : 'primary';
  if ('leaveOutNoCode' in incoming) next.leaveOutNoCode = incoming.leaveOutNoCode !== false;

  if ('perSeverity' in incoming) next.perSeverity = incoming.perSeverity === true;
  if (incoming.severityLimits && typeof incoming.severityLimits === 'object') {
    const limits = { ...(current.severityLimits ?? DEFAULT_AUTOMATION.severityLimits) };
    for (const severity of LIMIT_SEVERITIES) if (severity in incoming.severityLimits) limits[severity] = parseLimits(incoming.severityLimits[severity]);
    next.severityLimits = limits;
  }
  if (incoming.focus && typeof incoming.focus === 'object') {
    const focus = { ...DEFAULT_AUTOMATION.focus, ...(current.focus ?? {}) };
    for (const key of ['applications', 'tags', 'projects', 'exclude']) if (key in incoming.focus) focus[key] = parseNames(incoming.focus[key]);
    next.focus = focus;
  }
  if ('when' in incoming) next.when = incoming.when === 'interval' ? 'interval' : 'schedule';
  if ('days' in incoming) {
    const days = [...new Set((Array.isArray(incoming.days) ? incoming.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    if (!days.length) throw new AutomationError('Choose at least one day for reminders to go out.');
    next.days = days;
  }
  if ('at' in incoming) {
    const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(incoming.at ?? '').trim());
    if (!match) throw new AutomationError('Give the time reminders go out as hours and minutes, such as 09:00.');
    next.at = `${match[1].padStart(2, '0')}:${match[2]}`;
  }
  if ('timeZone' in incoming) {
    const zone = cleanTimeZone(incoming.timeZone);
    if (String(incoming.timeZone ?? '').trim() && !zone) throw new AutomationError('That time zone is not known. Use a name such as Europe/Berlin, or leave it blank for the server\'s.');
    next.timeZone = zone;
  }

  return next;
}

/** "30, 60, 90" or [30,60,90] -> a sorted list of positive day counts. */
export function parseThresholds(value, fallback = DEFAULT_AUTOMATION.thresholds) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/);
  const days = [
    ...new Set(
      list
        .map((entry) => Number.parseInt(entry, 10))
        .filter((n) => Number.isFinite(n) && n > 0 && n <= 3650),
    ),
  ].sort((a, b) => a - b);

  return days.length > 0 ? days : fallback;
}

// ---------------------------------------------------------------------------

/** The wall-clock parts of `date` in `timeZone` ('' is this machine's). */
function zoned(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { ...(timeZone ? { timeZone } : {}), hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { year: +parts.year, month: +parts.month, day: +parts.day, hour: +parts.hour % 24, minute: +parts.minute, second: +parts.second, weekday };
}

/** The instant a wall-clock time in `timeZone` falls on (the later one when clocks go back; on when they skip it). */
function instantOf({ year, month, day, hour, minute }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let at = guess;
  for (let i = 0; i < 3; i += 1) {
    const seen = zoned(new Date(at), timeZone);
    const shown = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute);
    if (shown === guess) return at;
    at += guess - shown;
  }
  return at;
}

/**
 * When a schedule next goes out after `from`: the first chosen day, at `at`, in the time zone. An interval
 * goes out `intervalMinutes` after `from`. Null when nothing would ever go out.
 */
export function nextRunAfter(automation, from = new Date()) {
  if (automation.when !== 'schedule') return new Date(from.getTime() + (automation.intervalMinutes ?? 360) * 60_000);
  const days = new Set(automation.days ?? []);
  if (!days.size) return null;
  const [hour, minute] = String(automation.at ?? '09:00').split(':').map(Number);
  const zone = cleanTimeZone(automation.timeZone);
  const today = zoned(from, zone);
  for (let offset = 0; offset <= 8; offset += 1) {
    // Calendar arithmetic on the zone's own date, so a day is a day across a clock change.
    const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    if (!days.has(date.getUTCDay())) continue;
    const at = instantOf({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour, minute }, zone);
    if (at > from.getTime()) return new Date(at);
  }
  return null;
}

/** The age limits that apply to a finding: its severity's own, or the same for every severity. */
export function limitsFor(automation, severity) {
  if (!automation.perSeverity) return automation.thresholds ?? [];
  return automation.severityLimits?.[severity] ?? [];
}

/** A name pattern (`*` any run, `?` one character, any case), matched in linear time: no regex to backtrack on. */
export function glob(pattern) {
  const p = pattern.toLowerCase();
  const test = (name) => {
    const s = String(name ?? '').toLowerCase();
    let i = 0;
    let j = 0;
    let star = -1;
    let mark = 0;
    while (i < s.length) {
      if (j < p.length && (p[j] === '?' || p[j] === s[i])) { i++; j++; }
      else if (j < p.length && p[j] === '*') { star = j++; mark = i; }
      else if (star >= 0) { j = star + 1; i = ++mark; }
      else return false;
    }
    while (p[j] === '*') j++;
    return j === p.length;
  };
  return { test };
}

/**
 * The projects reminders cover (→ Focus): those in a named application, with a named tag (key, or key:value)
 * or a name matching a pattern — any of them; every project when none is named — less those matching a
 * "leave out" pattern. `applications` is the tenant's ({id, name, projectIds}).
 */
export function focusProjects(projects, focus = {}, applications = []) {
  const names = (focus.applications ?? []).map((n) => n.toLowerCase());
  const tags = focus.tags ?? [];
  const keep = (focus.projects ?? []).map(glob);
  const drop = (focus.exclude ?? []).map(glob);
  const inApps = new Set(applications.filter((a) => names.includes(a.name.toLowerCase()) || names.includes(String(a.id).toLowerCase())).flatMap((a) => a.projectIds));
  const anyNamed = names.length || tags.length || keep.length;
  const tagged = (project) =>
    tags.some((tag) => {
      const at = tag.indexOf(':');
      const key = (at < 0 ? tag : tag.slice(0, at)).trim();
      const entries = Object.entries(project.tags ?? {});
      return entries.some(([k, v]) => k.toLowerCase() === key.toLowerCase() && (at < 0 || String(v ?? '').toLowerCase() === tag.slice(at + 1).trim().toLowerCase()));
    });
  return projects.filter(
    (project) =>
      (!anyNamed || inApps.has(project.id) || tagged(project) || keep.some((re) => re.test(project.name))) &&
      !drop.some((re) => re.test(project.name)),
  );
}
