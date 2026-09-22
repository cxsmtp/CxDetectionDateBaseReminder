/**
 * Automation configuration schema.
 *
 * Deliberately dependency-free: settings.js needs these defaults, and
 * automation.js needs settings.js (through the mailer), so anything shared
 * between them has to live in a leaf module or the two form an import cycle.
 */

export const DEFAULT_AUTOMATION = {
  enabled: false,
  // 'crossing' mails only findings that newly passed a threshold.
  // 'digest' mails everything currently past the lowest threshold, every run.
  mode: 'crossing',
  thresholds: [30, 60, 90],
  intervalMinutes: 360,
  severities: [],
  groupBy: 'initiator',
  // Kept so a run can be rehearsed in production without mailing anyone.
  dryRun: false,
};

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
  if ('mode' in incoming) next.mode = incoming.mode === 'digest' ? 'digest' : 'crossing';
  if ('groupBy' in incoming) next.groupBy = incoming.groupBy === 'none' ? 'none' : 'initiator';

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
