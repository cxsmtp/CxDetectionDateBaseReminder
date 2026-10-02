/**
 * The credit pool and how credits were used over time.
 *
 * The pool (Settings → AI & credits) is the most the utility may spend,
 * triage and remediation together, per month or as one pool. Every project
 * allocation is given out of it: what is free to give is what the pool has
 * left minus what projects were allocated and have not used yet.
 *
 * Usage over a period comes from the credit ledger's entries, bucketed by
 * day, week (Monday first) or month, in UTC like the ledger.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_RANGE_DAYS = 732;
export const BUCKETS = ['day', 'week', 'month'];

/**
 * @param {{size: number, period: 'month'|'all', used: {triage, remediation, total}, reserved?: number, allocations: Array}} input
 */
export function poolSummary({ size = 0, period = 'month', used, reserved = 0, allocations = [] }) {
  const allocated = { triage: 0, remediation: 0 };
  const outstanding = { triage: 0, remediation: 0 };
  for (const p of allocations) {
    for (const kind of ['triage', 'remediation']) {
      allocated[kind] += p[kind]?.allocated ?? 0;
      outstanding[kind] += p[kind]?.remaining ?? 0;
    }
  }
  const outstandingTotal = outstanding.triage + outstanding.remediation;
  const limited = size > 0;
  const remaining = limited ? Math.max(0, size - used.total - reserved) : null;
  return {
    size: limited ? size : 0,
    limited,
    period: period === 'all' ? 'all' : 'month',
    used: { triage: used.triage, remediation: used.remediation, total: used.total },
    reserved,
    remaining,
    allocated: { ...allocated, total: allocated.triage + allocated.remediation },
    // Given to projects and not used yet: spoken for, but still in the pool.
    outstanding: { ...outstanding, total: outstandingTotal },
    // What can still be given to projects.
    unallocated: limited ? Math.max(0, remaining - outstandingTotal) : null,
    overAllocated: limited ? Math.max(0, outstandingTotal - remaining) : 0,
  };
}

const isoDay = (date) => date.toISOString().slice(0, 10);
const parseDay = (text) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(text ?? ''))) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || isoDay(date) !== text ? null : date;
};

/** The start of the bucket a time falls in. */
export function bucketStart(date, bucket) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  if (bucket === 'month') d.setUTCDate(1);
  if (bucket === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d;
}

function nextBucket(date, bucket) {
  const d = new Date(date);
  if (bucket === 'day') d.setUTCDate(d.getUTCDate() + 1);
  else if (bucket === 'week') d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d;
}

/** Day buckets up to two months, weeks up to a year, months beyond. */
export const autoBucket = (days) => (days <= 62 ? 'day' : days <= 370 ? 'week' : 'month');

/**
 * Check and complete a period: from/to as YYYY-MM-DD (inclusive, UTC),
 * defaulting to the last 30 days. Throws a 400 for a bad one.
 */
export function resolveRange({ from, to, bucket } = {}, now = new Date()) {
  const bad = (message) => Object.assign(new Error(message), { status: 400 });
  const end = to ? parseDay(to) : parseDay(isoDay(now));
  if (!end) throw bad('"to" must be a date (YYYY-MM-DD).');
  const start = from ? parseDay(from) : new Date(end.getTime() - 29 * DAY_MS);
  if (!start) throw bad('"from" must be a date (YYYY-MM-DD).');
  if (start > end) throw bad('"from" must be on or before "to".');
  const days = Math.round((end - start) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) throw bad(`Choose a period of at most ${MAX_RANGE_DAYS} days.`);
  const chosen = BUCKETS.includes(bucket) ? bucket : autoBucket(days);
  return { from: isoDay(start), to: isoDay(end), days, bucket: chosen };
}

/**
 * Credits used per bucket, per project and in total, for ledger `entries`
 * (as CreditLedger.entriesBetween returns them) within a resolved range.
 */
export function usageSeries(entries, { from, to, bucket, projectId = '' }) {
  const start = parseDay(from);
  const end = new Date(parseDay(to).getTime() + DAY_MS);
  const series = [];
  const index = new Map();
  for (let d = bucketStart(start, bucket); d < end; d = nextBucket(d, bucket)) {
    const row = { start: isoDay(d), triage: 0, remediation: 0, credits: 0, requests: 0 };
    index.set(row.start, row);
    series.push(row);
  }
  const byProject = new Map();
  const totals = { triage: 0, remediation: 0, credits: 0, requests: 0, projects: 0 };
  for (const e of entries) {
    const at = new Date(e.at);
    if (at < start || at >= end) continue;
    if (projectId && e.projectId !== projectId) continue;
    const kind = e.kind === 'remediation' ? 'remediation' : 'triage';
    const row = index.get(isoDay(bucketStart(at, bucket)));
    if (row) {
      row[kind] += e.credits;
      row.credits += e.credits;
      row.requests += 1;
    }
    const p = byProject.get(e.projectId) ?? { projectId: e.projectId, projectName: '', triage: 0, remediation: 0, credits: 0, requests: 0, lastUsedAt: '' };
    p[kind] += e.credits;
    p.credits += e.credits;
    p.requests += 1;
    if (e.projectName) p.projectName = e.projectName;
    if (e.at > p.lastUsedAt) p.lastUsedAt = e.at;
    byProject.set(e.projectId, p);
    totals[kind] += e.credits;
    totals.credits += e.credits;
    totals.requests += 1;
  }
  totals.projects = byProject.size;
  let running = 0;
  for (const row of series) row.cumulative = running += row.credits;
  return {
    from,
    to,
    bucket,
    series,
    totals,
    byProject: [...byProject.values()].sort((a, b) => b.credits - a.credits || a.projectName.localeCompare(b.projectName)),
  };
}
