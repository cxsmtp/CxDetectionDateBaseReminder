/**
 * Labs → Consolidated view (Beta): every connected tenant in one place, read only.
 *
 * Each tenant's figures come from what that tenant already holds in memory: the last Workbench fetch made in it (a
 * slim copy kept with the tenant by the fetch itself), the Checkmarx One credits it last read, its credit pool, and
 * Govern's budgets when Govern runs there. Nothing here calls Checkmarx One, and nothing is written to a tenant but
 * one line in its audit log for each visit (src/labs-routes.js).
 */
import { boardFigures, boardRow } from './status-board.js';
import { tenantColour } from '../public/tenant-colour.js';

/** A fetch older than this makes the tenant "stale" (still shown). */
export const STALE_FETCH_MS = 24 * 60 * 60 * 1000;

const text = (v, max = 300) => (v === null || v === undefined ? '' : String(v).trim().slice(0, max));
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * The copy of a Workbench fetch a tenant keeps for the consolidated view: the board's rows (no findings), when, and
 * by whom. `result` is runScan's result (its projects are the summaries with the board's facts attached).
 */
export function workbenchSnapshot(result, { by = '', now = Date.now(), projectsTotal = null } = {}) {
  const rows = (result?.projects ?? []).map((p) => boardRow(p, now));
  return { at: new Date(now).toISOString(), by: text(by, 254), rows, projectsTotal: num(projectsTotal) ?? rows.length, partial: Boolean(result?.notRead) };
}

/**
 * Govern in a tenant, read defensively from what is already in memory (Govern may not run there, or not have been
 * started since the server started): { on, budgeted, budgets, restricted } or null. Never starts Govern.
 */
export function governSummary(context, { locked = false } = {}) {
  const g = context?.govern;
  if (!g || locked) return null;
  try {
    // src/server.js keeps Govern lazily: { loaded(), get() }; only a service already made is read.
    const svc = typeof g.get === 'function' ? (g.loaded?.() ? g.get() : null) : g;
    if (!svc) return { on: null, budgeted: null, budgets: null, restricted: null };
    const figures = svc.view?.overview?.figures;
    if (figures) return { on: true, budgeted: num(figures.assigned), budgets: num(figures.budgets), restricted: num(figures.restricted) };
    const store = svc.store ?? svc;
    const budgets = store?.budgets instanceof Map ? [...store.budgets.values()].filter((b) => b?.active !== false) : [];
    return { on: true, budgeted: budgets.reduce((n, b) => n + (num(b.amount) ?? 0), 0), budgets: budgets.length, restricted: null };
  } catch {
    return null;
  }
}

/** healthy | failed | stale | notLoaded: the tenant's last fetch, as the cards and the switcher say it. */
export function tenantHealth(snapshot, error, now = Date.now()) {
  const at = Date.parse(snapshot?.at ?? '') || 0;
  const failedAt = Date.parse(error?.at ?? '') || 0;
  if (!at && !failedAt) return 'notLoaded';
  if (failedAt > at) return 'failed';
  if (now - at > STALE_FETCH_MS) return 'stale';
  return 'healthy';
}

/**
 * One tenant's card: { id, name, colour, health, projects, sev, total, ch, overdue, fusion, last, credits, pool,
 * govern, fetchedAt, fetchedBy, error }. `credits`: the Checkmarx One credits it last read ({ used, available, total,
 * readAt }); `pool`: its CxMissionZero credit pool.
 */
export function tenantSummary({ id, name, colour = tenantColour(id), snapshot = null, error = null, credits = null, pool = null, govern = null, now = Date.now() }) {
  const rows = snapshot?.rows ?? [];
  const figures = boardFigures(rows);
  const sev = rows.reduce((t, r) => ({ critical: t.critical + r.sev.critical, high: t.high + r.sev.high, medium: t.medium + r.sev.medium, low: t.low + r.sev.low }), { critical: 0, high: 0, medium: 0, low: 0 });
  return {
    id: text(id, 80),
    name: text(name, 80) || text(id, 80),
    colour,
    health: tenantHealth(snapshot, error, now),
    loaded: Boolean(snapshot),
    projects: snapshot ? rows.length : null,
    projectsTotal: snapshot?.projectsTotal ?? null,
    sev,
    total: sev.critical + sev.high + sev.medium + sev.low,
    ch: sev.critical + sev.high,
    overdue: rows.reduce((n, r) => n + (r.overdue ?? 0), 0),
    fusion: figures.fusion,
    last: figures.last,
    failed7: figures.failed7,
    stale30: figures.stale30,
    credits: credits ? { used: num(credits.used), available: num(credits.available), total: num(credits.total), readAt: text(credits.readAt, 40) || null } : null,
    pool: pool ? { size: pool.limited ? num(pool.size) : null, used: num(pool.used?.total ?? pool.used), available: num(pool.remaining) } : null,
    govern,
    fetchedAt: snapshot?.at ?? null,
    fetchedBy: snapshot?.by ?? '',
    partial: Boolean(snapshot?.partial),
    error: error ? { at: text(error.at, 40), message: text(error.message, 300) } : null,
  };
}

/** Every tenant's projects in one list, each row naming its tenant. */
export function crossProjects(tenants) {
  const out = [];
  for (const t of tenants) for (const r of t.snapshot?.rows ?? []) out.push({ ...r, tenantId: t.id, tenantName: t.name, colour: t.colour ?? tenantColour(t.id) });
  return out;
}

/** The figures line across tenants. */
export function consolidatedFigures(summaries) {
  const sum = (f) => summaries.reduce((n, s) => n + (f(s) ?? 0), 0);
  const credited = summaries.filter((s) => s.credits);
  return {
    tenants: summaries.length,
    loaded: summaries.filter((s) => s.loaded).length,
    projects: sum((s) => s.projects),
    critical: sum((s) => s.sev.critical),
    high: sum((s) => s.sev.high),
    overdue: sum((s) => s.overdue),
    creditsUsed: credited.length ? credited.reduce((n, s) => n + (s.credits.used ?? 0), 0) : null,
    creditsTotal: credited.length ? credited.reduce((n, s) => n + (s.credits.total ?? (s.credits.used ?? 0) + (s.credits.available ?? 0)), 0) : null,
  };
}
