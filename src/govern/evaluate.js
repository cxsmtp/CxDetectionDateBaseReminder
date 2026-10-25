/**
 * Govern (beta): evaluating budgets — a pure function of (budget, period state, usage index, now), no Checkmarx
 * One call, no file, never throwing past one budget (B13).
 *
 * Status is recomputed from usage on every evaluation (B17): within / near / over, or exempt, not reported,
 * inactive, not open. A breach is an event counted per period (breachSeq): after any automatic release (credits
 * raised, usage fell, budget switched to Monitor and back) a new breach makes a new hold (B4). Only an admin's
 * restore gives a grace: no hold until usage grows past the figure at the restore by `graceGrowBy`, or the grace
 * ends (the period's end unless the admin chose a time).
 *
 * `hold`: true (should be held), false (should be released, with `releaseReason`), or null (leave as it is: the
 * usage is stale or not reported — never a release or a hold on unknown data, B10).
 */

const DAY = 86_400_000;

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;

/** The period a budget is in at `now`: { key, start, end (ms or null), open } or { error }. */
export function periodWindow(budget, now = Date.now()) {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  switch (budget.period) {
    case 'monthly':
      return { key: `${y}-${pad(m + 1)}`, start: Date.UTC(y, m, 1), end: Date.UTC(y, m + 1, 1), open: true };
    case 'quarterly': {
      const q = Math.floor(m / 3);
      return { key: `${y}-Q${q + 1}`, start: Date.UTC(y, q * 3, 1), end: Date.UTC(y, q * 3 + 3, 1), open: true };
    }
    case 'custom': {
      const start = Date.parse(budget.customStart);
      const end = budget.customEnd ? Date.parse(budget.customEnd) : null;
      if (!Number.isFinite(start) || (end !== null && !(end > start))) return { error: 'The custom period has no valid start, or ends before it starts.' };
      return { key: `custom:${ymd(new Date(start))}:${end === null ? 'open' : ymd(new Date(end))}`, start, end, open: now >= start && (end === null || now < end) };
    }
    case 'lifetime': {
      const start = Date.parse(budget.createdAt) || 0;
      return { key: 'lifetime', start, end: null, open: true };
    }
    default:
      return { error: `Unknown period "${budget.period}".` };
  }
}

/** The budget's amount now: its own plus approved top-ups still in date. */
export function effectiveAmount(budget, now = Date.now()) {
  let amount = Number(budget.amount) || 0;
  for (const t of budget.topUps ?? []) if (!t.until || Date.parse(t.until) > now) amount += Number(t.amount) || 0;
  return Math.round(amount * 10000) / 10000;
}

/**
 * Evaluate one budget. `ctx`: { index (UsageIndex), isExempt(type, id), graceGrowBy }. `prev`: the stored state of
 * this budget's current period, or null. Returns { state, hold, releaseReason, notices: [{ kind, severity, … }] }.
 */
export function evaluateBudget(budget, prev, ctx, now = Date.now()) {
  try {
    return evaluate(budget, prev, ctx, now);
  } catch (error) {
    return { state: prev ?? null, hold: null, releaseReason: '', notices: [{ kind: 'error', severity: 'error', title: `Budget for ${budget.entityLabel || budget.entityId} could not be evaluated`, body: String(error.message).slice(0, 300), dedupe: `evalerror:${budget.id}:${new Date(now).toISOString().slice(0, 10)}` }] };
  }
}

function evaluate(budget, prev, ctx, now) {
  const win = periodWindow(budget, now);
  const label = budget.entityLabel || budget.entityId;
  if (win.error) {
    return { state: prev, hold: false, releaseReason: 'limit_removed', notices: [{ kind: 'misconfigured', severity: 'error', title: `Budget for ${label} is misconfigured`, body: win.error, dedupe: `badperiod:${budget.id}` }] };
  }
  const iso = (t) => (t === null || t === undefined ? null : new Date(t).toISOString());
  const same = prev && prev.periodKey === win.key ? prev : null;
  const state = {
    budgetId: budget.id,
    periodKey: win.key,
    start: iso(win.start),
    end: iso(win.end),
    used: same?.used ?? 0,
    limit: effectiveAmount(budget, now),
    reported: same?.reported ?? 0,
    available: same?.available ?? false,
    estimated: same?.estimated ?? false,
    stale: false,
    source: same?.source ?? '',
    status: 'within',
    warnedAt: same?.warnedAt ?? null,
    breachedAt: same?.breachedAt ?? null,
    breachSeq: same?.breachSeq ?? 0,
    over: same?.over ?? false,
    grace: same?.grace ?? null,
    lastEvaluatedAt: iso(now),
  };
  const exempt = ctx.isExempt(budget.entityType, budget.entityId);
  if (!budget.active) return { state: { ...state, status: 'inactive' }, hold: false, releaseReason: 'limit_removed', notices: [] };
  if (!win.open) return { state: { ...state, status: 'not_open' }, hold: false, releaseReason: 'period_rollover', notices: [] };
  // Custom periods count from their own start; lifetime from the budget's creation (B16); "count usage from before
  // this period" counts everything MZ knows of from before (what Checkmarx One still reports).
  const from = budget.countExisting ? -Infinity : win.start;
  const u = ctx.index.usage(budget.entityType, budget.entityId, { from, to: Math.min(now, win.end ?? Infinity), includeMembers: budget.includeMembers, includeSubgroups: budget.includeSubgroups });
  if (!u.available) return { state: { ...state, status: 'not_reported', available: false }, hold: null, releaseReason: '', notices: [] };
  Object.assign(state, { used: u.used, reported: u.reported, available: true, estimated: u.estimated, stale: u.stale, source: u.source });
  const limit = state.limit;
  const over = u.used >= limit;
  const pct = limit > 0 ? (u.used / limit) * 100 : 100;
  const near = !over && pct >= budget.warnPct;
  const enforcing = budget.mode === 'enforce' && Boolean(budget.enforcedBy);
  const notices = [];
  const what = `${budget.entityType} ${label}`;
  // Stale usage: the figures shown are the last good ones; nothing is held or released on them.
  if (u.stale) return { state: { ...state, status: exempt ? 'exempt' : over ? 'over' : near ? 'near' : 'within' }, hold: null, releaseReason: '', notices };
  if (near && !state.warnedAt) {
    state.warnedAt = iso(now);
    notices.push({ kind: 'warning', severity: 'warning', title: `${what} is near its budget`, body: `${fmt(u.used)} of ${fmt(limit)} credits used (${Math.round(pct)} %) in ${win.key}.`, dedupe: `warn:${budget.id}:${win.key}` });
  }
  if (over && !state.over) {
    state.breachSeq += 1;
    state.breachedAt = iso(now);
    const severity = enforcing && !exempt ? 'critical' : 'warning';
    const how = exempt ? 'exempt: never restricted' : enforcing ? 'Enforce: restricting' : 'Monitor only: nothing is restricted';
    notices.push({ kind: 'breach', severity, title: `${what} is over its budget`, body: `${fmt(u.used)} of ${fmt(limit)} credits used in ${win.key} (${how}).`, dedupe: `breach:${budget.id}:${win.key}:${state.breachSeq}` });
  }
  if (!over && state.over) notices.push({ kind: 'recovered', severity: 'info', title: `${what} is back under its budget`, body: `${fmt(u.used)} of ${fmt(limit)} credits used in ${win.key}.`, dedupe: `under:${budget.id}:${win.key}:${state.breachSeq}` });
  state.over = over;
  // A grace from an admin's restore lasts until usage grows past the figure then, or its time ends.
  if (state.grace) {
    const ended = (state.grace.until && now >= Date.parse(state.grace.until)) || u.used >= Number(state.grace.usageAtRestore) + Number(state.grace.growBy ?? ctx.graceGrowBy ?? 1);
    if (ended) state.grace = null;
  }
  state.status = exempt ? 'exempt' : over ? 'over' : near ? 'near' : 'within';
  let hold = false;
  let releaseReason = '';
  if (over && enforcing && !exempt && !state.grace) hold = true;
  else if (state.grace && over && enforcing && !exempt) releaseReason = 'admin';
  else releaseReason = exempt ? 'exempted' : !enforcing ? 'limit_removed' : 'credit_increased';
  return { state, hold, releaseReason, notices };
}

const fmt = (n) => (Math.round(Number(n) * 100) / 100).toLocaleString('en');

/**
 * What a breach of this budget restricts (SPEC §4.2): a user loses the AI roles; a project, and each project of a
 * group or application, has Auto Triage turned off and, with a repository known, PR remediation too. Exempt
 * projects are skipped. Returns [{ kind, targetId, label, type }].
 */
export function planTargets(budget, index, isExempt) {
  if (budget.entityType === 'user') {
    const u = index.org.users.get(budget.entityId);
    return [{ kind: 'user_roles', targetId: budget.entityId, type: 'user', label: u ? [u.email || u.username].filter(Boolean)[0] ?? budget.entityId : budget.entityLabel || budget.entityId }];
  }
  const out = [];
  for (const pid of index.projectsOf(budget.entityType, budget.entityId, { includeSubgroups: budget.includeSubgroups })) {
    if (budget.entityType !== 'project' && isExempt('project', pid)) continue;
    const p = index.org.projects.get(pid);
    const label = p?.name ?? pid;
    out.push({ kind: 'auto_triage', targetId: pid, type: 'project', label });
    if (p?.repoId) out.push({ kind: 'pr_remediation', targetId: pid, type: 'project', label, repoId: p.repoId });
  }
  return out;
}

/** Days left in the period (for the page): null for open-ended ones. */
export function daysLeft(state, now = Date.now()) {
  if (!state?.end) return null;
  return Math.max(0, Math.ceil((Date.parse(state.end) - now) / DAY));
}
