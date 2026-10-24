/**
 * Govern (beta): the read model every page reads (SPEC §8.2). Built after each cycle and after each change
 * (a budget, a decision, a request), from memory only; requests filter and page these arrays, and the overview is
 * serialised once with its ETag, so a page view costs neither a file read nor a Checkmarx One call.
 */
import { tabOf, labelOfUser } from './attribution.js';
import { KINDS } from './enforce.js';
import { daysLeft, effectiveAmount, periodWindow } from './evaluate.js';
import { DIMENSIONS, sumIncrements } from './ingest.js';
import { entityKey, hashOf } from './store.js';

const DAY = 86_400_000;
const round = (n) => Math.round(Number(n) * 100) / 100;

/** A readable label of an entity from the org mirror, else what the budget cached. */
export function entityLabel(index, type, id, fallback = '') {
  if (type === 'user') {
    const u = index.org.users.get(id);
    return u ? labelOfUser(u) : fallback || id;
  }
  if (type === 'group') return index.org.groups.get(id)?.path ?? (fallback || id);
  if (type === 'project') return index.org.projects.get(id)?.name ?? (fallback || id);
  if (type === 'application') return index.org.applications.get(id)?.name ?? (fallback || id);
  return fallback || id;
}

/** The status a budget's row shows, with its restrictions folded in. */
function rowStatus(state, holdsOf) {
  if (!state) return 'not_evaluated';
  if (state.needsConfirmation) return 'needs_confirmation';
  if (state.status !== 'over') return state.status;
  const h = holdsOf;
  if (!h.total) return 'over';
  if (h.partial || h.failed || h.skipped) return 'partial';
  if (h.pending) return 'restricting';
  return 'restricted';
}

/** Daily credits by action type over the last `days` days, from the action dimension's increments. */
function trend(series, now, days = 90) {
  const start = Math.floor(now / DAY) * DAY - (days - 1) * DAY;
  const labels = Array.from({ length: days }, (_, i) => new Date(start + i * DAY).toISOString().slice(0, 10));
  const out = {};
  let estimated = false;
  for (const [action, list] of series?.increments ?? []) {
    const values = labels.map((_, i) => {
      const r = sumIncrements(list, start + i * DAY, start + (i + 1) * DAY);
      estimated ||= r.estimated && r.sum > 0;
      return round(r.sum);
    });
    if (values.some((v) => v > 0)) out[action] = values;
  }
  return { days: labels, series: out, estimated };
}

/**
 * Build the view. `svc`: { store, holds, holder, notifier, series, dimState, runs, nextRunAt, pool() }.
 */
export function buildView(svc, now = Date.now(), seq = 0) {
  const { store, holds } = svc;
  const index = svc.holder.current;
  // Restrictions by budget.
  const byBudget = new Map();
  const restrictions = [];
  for (const r of holds.targets.values()) {
    const refs = Object.values(r.refs ?? {});
    for (const ref of refs) {
      const h = byBudget.get(ref.budgetId) ?? { total: 0, applied: 0, partial: 0, failed: 0, pending: 0, skipped: 0, reasons: [] };
      h.total += 1;
      if (r.state === 'applied') h.applied += 1;
      else if (r.state === 'partial') h.partial += 1;
      else if (r.state === 'failed') h.failed += 1;
      else if (r.state === 'skipped') h.skipped += 1;
      else h.pending += 1;
      for (const p of r.partial ?? []) if (h.reasons.length < 10 && !h.reasons.includes(p)) h.reasons.push(p);
      if (r.error && h.reasons.length < 10) h.reasons.push(r.error);
      byBudget.set(ref.budgetId, h);
    }
    if (!refs.length && r.state === 'released') continue;
    restrictions.push({
      key: r.key,
      kind: r.kind,
      what: KINDS[r.kind] ?? r.kind,
      targetType: r.type,
      targetId: r.targetId,
      label: r.label,
      state: refs.length ? r.state : 'release_pending',
      since: r.appliedAt ?? null,
      restoreMode: r.preState?.restoreMode ?? (r.kind === 'user_roles' ? 'exact' : r.restoreMode ?? 'exact'),
      partial: r.partial ?? [],
      note: r.note ?? '',
      error: r.error ?? '',
      releaseReason: r.releaseReason ?? '',
      because: refs.map((ref) => ({ budgetId: ref.budgetId, periodKey: ref.periodKey, label: store.budgets.get(ref.budgetId)?.entityLabel ?? ref.budgetId, since: ref.since })),
    });
  }
  restrictions.sort((a, b) => String(b.since ?? '').localeCompare(String(a.since ?? '')));

  const budgets = [];
  let assigned = 0;
  let usedTotal = 0;
  let near = 0;
  let restricted = 0;
  for (const b of store.budgets.values()) {
    const win = periodWindow(b, now);
    const state = win.error ? null : store.periods.get(`${b.id}|${win.key}`) ?? null;
    const ex = store.exemptions.get(entityKey(b.entityType, b.entityId));
    const h = byBudget.get(b.id) ?? { total: 0, applied: 0, partial: 0, failed: 0, pending: 0, skipped: 0, reasons: [] };
    const limit = effectiveAmount(b, now);
    const used = state?.available ? state.used : null;
    const status = b.active ? rowStatus(state, h) : 'inactive';
    if (b.active) assigned += limit;
    if (used !== null && b.active) usedTotal += used;
    if (status === 'near') near += 1;
    if (['restricted', 'partial', 'restricting'].includes(status)) restricted += 1;
    budgets.push({
      id: b.id,
      version: b.version,
      entityType: b.entityType,
      entityId: b.entityId,
      entityLabel: entityLabel(index, b.entityType, b.entityId, b.entityLabel),
      amount: b.amount,
      limit,
      topUps: (b.topUps ?? []).filter((t) => !t.until || Date.parse(t.until) > now),
      period: b.period,
      periodKey: state?.periodKey ?? (win.key || ''),
      start: state?.start ?? null,
      end: state?.end ?? null,
      daysLeft: daysLeft(state, now),
      customStart: b.customStart,
      customEnd: b.customEnd,
      warnPct: b.warnPct,
      mode: b.mode,
      enforcedBy: b.enforcedBy,
      active: b.active,
      exempt: Boolean(ex),
      exemptReason: ex?.reason ?? '',
      used,
      reported: state?.reported ?? null,
      pct: used !== null && limit > 0 ? round((used / limit) * 100) : used !== null ? 100 : null,
      estimated: Boolean(state?.estimated),
      stale: Boolean(state?.stale),
      source: state?.source ?? '',
      status,
      restrictions: h,
      grace: state?.grace ?? null,
      includeMembers: b.includeMembers,
      includeSubgroups: b.includeSubgroups,
      countExisting: b.countExisting,
      holdUntilReleased: b.holdUntilReleased,
      maxTargets: b.maxTargets,
      fanoutConfirmedAt: b.fanoutConfirmedAt,
      notes: b.notes,
      createdAt: b.createdAt,
      createdBy: b.createdBy,
      updatedAt: b.updatedAt ?? b.createdAt,
      updatedBy: b.updatedBy ?? b.createdBy,
    });
  }
  budgets.sort((a, b) => a.entityType.localeCompare(b.entityType) || a.entityLabel.localeCompare(b.entityLabel));
  const budgetOf = new Map(budgets.map((r) => [entityKey(r.entityType, r.entityId), r]));

  // Attribution queue.
  const attribution = (index.queue ?? []).map((r) => ({ ...r, tab: tabOf(r), entityLabel: r.entityId ? entityLabel(index, r.dimension, r.entityId) : '', suggestions: r.suggestions.map((s) => ({ ...s, label: s.label || entityLabel(index, r.dimension, s.id) })) }));
  const uncounted = attribution.filter((r) => r.tab !== 'matched' && r.status !== 'automation');
  const unattributed = { subjects: uncounted.length, credits: round(uncounted.reduce((n, r) => n + r.credits, 0)), disputes: attribution.filter((r) => r.tab === 'disputes').length };

  // Top consumers per level, with their budget.
  const top = {};
  for (const dim of ['user', 'project', 'group', 'application']) {
    top[dim] = index.available(dim)
      ? index.top(dim, 10).map(({ entityId, credits }) => {
          const b = budgetOf.get(entityKey(dim, entityId));
          return { entityId, label: entityLabel(index, dim, entityId), credits: round(credits), budgetId: b?.id ?? null, limit: b?.limit ?? null, used: b?.used ?? null, pct: b?.pct ?? null, status: b?.status ?? null };
        })
      : null;
  }
  const dims = Object.fromEntries(DIMENSIONS.map((d) => [d, { supported: index.dims[d].supported, stale: index.dims[d].stale, lastAt: index.dims[d].lastAt ? new Date(index.dims[d].lastAt).toISOString() : null, window: index.dims[d].window, estimatedUntil: index.dims[d].seedAt ? new Date(index.dims[d].seedAt + ({ last_month: 31, last_30_days: 30, last_90_days: 90, last_180_days: 180, last_year: 365 }[index.dims[d].window] ?? 30) * DAY).toISOString() : null, note: index.dims[d].note || index.dims[d].error || '' }]));
  const byAction = index.byAction();
  const lastRun = svc.runs()[0] ?? null;
  const pool = svc.pool?.() ?? null;
  const overview = {
    figures: {
      tenantCredits: index.credits ? { total: index.credits.total, used: index.credits.used, available: index.credits.available, readAt: index.credits.readAt } : null,
      pool,
      assigned: round(assigned),
      overPool: pool?.limit ? round(Math.max(0, assigned - pool.limit)) : 0,
      usedThisPeriod: round(usedTotal),
      tenantWindow: byAction ? round(byAction.reduce((n, a) => n + a.credits, 0)) : null,
      near,
      restricted,
      budgets: budgets.length,
      enforcing: budgets.filter((b) => b.mode === 'enforce' && b.active).length,
      lastCycle: lastRun ? { id: lastRun.id, status: lastRun.status, startedAt: lastRun.startedAt, finishedAt: lastRun.finishedAt ?? null } : null,
      nextRunAt: svc.nextRunAt ? new Date(svc.nextRunAt).toISOString() : null,
    },
    byAction,
    trend: trend(svc.series.action, now, 90),
    top,
    dimensions: dims,
    banners: {
      notReported: DIMENSIONS.filter((d) => index.dims[d].supported === false),
      stale: DIMENSIONS.filter((d) => index.dims[d].stale),
      lastGoodAt: Object.fromEntries(DIMENSIONS.map((d) => [d, dims[d].lastAt])),
      unattributed,
      orgReadAt: index.org.readAt,
    },
  };
  const etag = `W/"g${hashOf([store.dataVersion, seq, index.at, now - (now % 60_000)]).slice(0, 20)}"`;
  return { at: now, etag, overview, overviewJson: JSON.stringify(overview), budgets, budgetOf, restrictions, attribution };
}
