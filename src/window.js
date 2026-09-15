/**
 * Time windows used to narrow a fetch before it runs.
 *
 * Two independent windows are supported:
 *   activity  - which PROJECTS are fetched, by last completed scan date.
 *               Narrowing this genuinely reduces API calls.
 *   detection - which FINDINGS are counted, by first-detection date.
 *               Narrowing this focuses the reminder on a period of interest.
 */

const MS_PER_DAY = 86_400_000;

export const WINDOW_PRESETS = [
  { id: 'any', label: 'Any time', days: null },
  { id: '7d', label: 'Last week', days: 7 },
  { id: '30d', label: 'Last month', days: 30 },
  { id: '90d', label: 'Last 90 days', days: 90 },
  { id: '365d', label: 'Last year', days: 365 },
  { id: 'custom', label: 'Custom range…', days: null },
];

export class WindowError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WindowError';
    this.status = 400;
  }
}

const parse = (value, label) => {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new WindowError(`${label} is not a valid date.`);
  return date;
};

/**
 * Normalise a window from either a preset id or an explicit from/to pair.
 *
 * @param {{preset?: string, from?: string, to?: string}} input
 * @param {string} label  Used in error messages.
 * @param {Date} [now]
 * @returns {{from: Date|null, to: Date|null, label: string}|null} null = unbounded
 */
export function resolveWindow(input, label, now = new Date()) {
  if (!input) return null;

  const preset = input.preset ?? (input.from || input.to ? 'custom' : 'any');
  if (preset === 'any') return null;

  if (preset === 'custom') {
    const from = parse(input.from, `${label} "from" date`);
    const to = parse(input.to, `${label} "to" date`);
    if (!from && !to) return null;
    if (from && to && from > to) {
      throw new WindowError(`${label} range starts after it ends.`);
    }
    // An end date from a date picker means "end of that day".
    const end = to ? new Date(to.getTime() + (/T/.test(String(input.to)) ? 0 : MS_PER_DAY - 1)) : null;
    return { from, to: end, label: `${from ? from.toISOString().slice(0, 10) : 'any'} → ${end ? end.toISOString().slice(0, 10) : 'now'}` };
  }

  const found = WINDOW_PRESETS.find((entry) => entry.id === preset);
  if (!found || found.days === null) throw new WindowError(`Unknown ${label} window "${preset}".`);
  return {
    from: new Date(now.getTime() - found.days * MS_PER_DAY),
    to: null,
    label: found.label,
  };
}

/** Is `value` (a date, ISO string, or null) inside the window? */
export function withinWindow(window, value) {
  if (!window) return true;
  if (!value) return false; // An undated item cannot be shown to fall inside a window.
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  if (window.from && date < window.from) return false;
  if (window.to && date > window.to) return false;
  return true;
}

/** Serialisable description for the UI and for the scan response. */
export function describeWindow(window) {
  if (!window) return { active: false, label: 'Any time', from: null, to: null };
  return {
    active: true,
    label: window.label,
    from: window.from ? window.from.toISOString() : null,
    to: window.to ? window.to.toISOString() : null,
  };
}
