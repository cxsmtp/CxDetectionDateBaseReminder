/**
 * Fusion results (Labs): what Checkmarx One's Fusion correlation re-scored, per project.
 *
 * Fusion correlates one engine's findings with another's (an SCA package whose vulnerable
 * call SAST can reach: an exploitable path) and gives the result a new risk score. Its
 * Results service lists, per application, every result whose score it changed
 * (`/applications/{id}/risk-scores`: old and new risk, the two engines, why); its
 * Dispatcher says how the latest Fusion scan of an application went (`/{id}/scan-status`).
 *
 * Both live under /api/correlation on the tenant (its own Swagger, /spec/v1: "Fusion Results"
 * and "Fusion Dispatcher" give servers /api/correlation/results and /api/correlation/dispatcher).
 * A tenant that does not run them there serves Fusion's scored results through Application Risk
 * Management instead (/api/risk-management: the applications, then each one's results with their
 * risk score and projects), as Troubleshoot found on a customer's tenant; that is read then.
 * Read-only: nothing here starts a scan.
 */
import { CxApiError, mapWithConcurrency } from './cxone/client.js';
import { isProbeMiss } from './cxone/discovery.js';

// The gateway answering for a service with nothing running behind it ("503 no available server"):
// the route is there, the service is not. Told apart from a miss so the page can say so.
const NOT_RUNNING = new Set([502, 503, 504]);
import { listApplications } from './cxone/projects.js';

export const FUSION_RESULTS_BASES = ['/api/correlation/results'];
export const FUSION_DISPATCHER_BASES = ['/api/correlation/dispatcher'];
/** Application Risk Management, read when the correlation service is not there. */
export const RISK_MANAGEMENT_BASE = '/api/risk-management';

/** A risk score's severity, as Checkmarx One bands them: 9+ critical, 7+ high, 4+ medium, above 0 low. */
export const SEVERITY_FLOORS = [['CRITICAL', 9], ['HIGH', 7], ['MEDIUM', 4], ['LOW', 0]];
export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

export function severityOfScore(score) {
  const n = Number(score);
  if (score === null || score === undefined || score === '' || !Number.isFinite(n)) return null;
  if (n <= 0) return 'NONE';
  return SEVERITY_FLOORS.find(([, floor]) => n >= floor)[0];
}

const RANK = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
const ON_TOP = new Set(['CRITICAL', 'HIGH']);
const text = (v, max = 400) => (v === null || v === undefined ? '' : String(v).slice(0, max));
const score = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10) / 10);

/** At most this many results are kept to list; the counts cover them all. */
export const MAX_LISTED = 5000;
const PAGE = 100;
const MAX_PAGES = 50;

// Which path each service answered at, per connection (a WeakMap keyed by the client).
const bases = new WeakMap();

/**
 * The service's path, and what the probe read there when it was found just now; when none
 * answered, what each said ({ tried: [{ path, status }] }), so the page can tell "not here"
 * (404) from "not allowed" (403).
 */
async function findBase(client, candidates, kind, probe) {
  const known = bases.get(client)?.[kind];
  // A path someone pinned since is tried first, whatever was found before.
  if (known && known === candidates[0]) return { base: known };
  let found = null;
  const tried = [];
  for (const base of candidates) {
    try {
      const body = await probe(base);
      found = { base, body };
      break;
    } catch (error) {
      if (!isProbeMiss(error) && !NOT_RUNNING.has(error.status)) throw error;
      tried.push({ path: error.path || base, status: error.status });
    }
  }
  // Only a path that answered is kept: a miss is tried again next time (Fusion may be turned on later,
  // and the dispatcher's probe asks about one application, which may simply have no scan yet).
  if (found) bases.set(client, { ...bases.get(client), [kind]: found.base });
  return found ?? { tried };
}

/**
 * Every result Fusion re-scored in one application. The service takes no paging parameters;
 * should it ever page (fewer results than totalCount), the next pages are asked for by offset.
 */
async function riskScores(client, base, appId, trace = null) {
  const path = `${base}/applications/${encodeURIComponent(appId)}/risk-scores`;
  const out = [];
  const seen = new Set();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await client.request(path, { query: page ? { offset: out.length, limit: PAGE } : undefined, retries: 1, background: true, trace });
    const rows = Array.isArray(body?.results) ? body.results : [];
    let fresh = 0;
    for (const r of rows) {
      const key = `${r?.projectId}\u0000${r?.resultId}\u0000${r?.scanId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      fresh += 1;
    }
    const total = Number(body?.totalCount);
    // Done: everything counted, no count given, or nothing new (paging not honoured).
    if (!Number.isFinite(total) || out.length >= total || !fresh) break;
  }
  return out;
}

async function scanStatus(client, base, appId, trace = null) {
  try {
    const s = await client.request(`${base}/${encodeURIComponent(appId)}/scan-status`, { retries: 1, background: true, trace });
    if (!s) return null;
    const at = Number(s.scanTimestamp);
    return {
      status: text(s.scanStatus, 40) || 'Unknown',
      stage: Number.isFinite(Number(s.stage)) ? Number(s.stage) : null,
      stageDescription: text(s.stageDescription, 200),
      // Seconds or milliseconds since 1970: either way, a date.
      at: Number.isFinite(at) && at > 0 ? new Date(at < 1e12 ? at * 1000 : at).toISOString() : null,
      error: text(s.errorMessage, 400),
    };
  } catch (error) {
    if (error instanceof CxApiError && error.status === 404) return null;
    throw error;
  }
}

/** One result, cleaned, with its old and new severity. */
export function cleanResult(r, appId) {
  const oldRisk = score(r?.oldRiskValue);
  const newRisk = score(r?.newRiskValue);
  return {
    projectId: text(r?.projectId, 80),
    resultId: text(r?.resultId, 200),
    applicationId: text(appId, 80),
    scanId: text(r?.scanId, 80),
    fusionScanId: text(r?.fusionScanId, 80),
    vulnerabilityEngine: text(r?.vulnerabilityEngine, 40),
    correlatedEngine: text(r?.correlatedEngine, 40),
    oldRisk,
    newRisk,
    oldSeverity: severityOfScore(oldRisk),
    newSeverity: severityOfScore(newRisk),
    info: text(r?.resultInfo, 600),
  };
}

const emptyCounts = () => ({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, NONE: 0, total: 0, raised: 0, lowered: 0, raisedToTop: 0 });

/**
 * Count results per project and overall. A result counts under its new severity;
 * raised or lowered by comparing its new score with its old; "raised to the top"
 * when it is now critical or high and was not before (the risk Fusion brought up).
 */
export function summarize(results) {
  const projects = {};
  const totals = emptyCounts();
  // A result that belongs to several projects counts in each of them, and once in the totals.
  const counted = new Set();
  for (const r of results) {
    const p = (projects[r.projectId] ??= { ...emptyCounts(), applications: [] });
    if (r.applicationId && !p.applications.includes(r.applicationId)) p.applications.push(r.applicationId);
    const key = r.resultId ? `${r.applicationId}\u0000${r.resultId}` : null;
    const once = !key || !counted.has(key);
    if (key) counted.add(key);
    for (const c of once ? [p, totals] : [p]) {
      c.total += 1;
      if (r.newSeverity) c[r.newSeverity] += 1;
      if (r.oldRisk !== null && r.newRisk !== null) {
        if (r.newRisk > r.oldRisk) c.raised += 1;
        else if (r.newRisk < r.oldRisk) c.lowered += 1;
      }
      // Brought up only when its earlier score is known (Application Risk Management gives none).
      if (ON_TOP.has(r.newSeverity) && r.oldRisk !== null && (RANK[r.oldSeverity] ?? 0) < RANK.HIGH) c.raisedToTop += 1;
    }
  }
  return { projects, totals };
}

const upper = (v) => (v === null || v === undefined ? '' : String(v).trim().toUpperCase());
const firstScore = (...values) => values.map(score).find((v) => v !== null) ?? null;

/**
 * One Application Risk Management result, one row per project in scope it belongs to. Its risk is
 * { score, severity }; a score it had before, when the answer gives one, makes it raised or lowered.
 */
export function cleanRiskResult(r, appId, inScope) {
  const newRisk = firstScore(r?.risk?.score, r?.riskScore, r?.score);
  const oldRisk = firstScore(r?.originalRisk?.score, r?.previousRisk?.score, r?.oldRisk?.score, r?.originalRiskScore, r?.oldRiskValue);
  const given = upper(r?.risk?.severity ?? r?.riskSeverity ?? r?.severity);
  const newSeverity = SEVERITIES.includes(given) ? given : severityOfScore(newRisk);
  const projects = (Array.isArray(r?.projects) ? r.projects : []).map((p) => text(typeof p === 'object' ? p?.id : p, 80)).filter(Boolean);
  return [...new Set(projects)].filter((id) => !inScope || inScope.has(id)).map((projectId) => ({
    projectId,
    resultId: text(r?.id ?? r?.hash, 200),
    applicationId: text(appId, 80),
    scanId: text(r?.scanId, 80),
    fusionScanId: '',
    vulnerabilityEngine: text(r?.type ?? r?.engine, 40),
    correlatedEngine: text(r?.correlatedEngine, 40),
    oldRisk,
    newRisk,
    oldSeverity: severityOfScore(oldRisk),
    newSeverity,
    info: text(r?.name ?? r?.resultInfo, 600),
  }));
}

/** Every Application Risk Management result of one application, page by page (limit and offset). */
async function riskResults(client, appId, trace = null) {
  const path = `${RISK_MANAGEMENT_BASE}/${encodeURIComponent(appId)}/results`;
  const out = [];
  const seen = new Set();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await client.request(path, { query: { limit: PAGE, offset: out.length }, retries: 1, background: true, trace });
    const rows = Array.isArray(body?.results) ? body.results : Array.isArray(body) ? body : [];
    let fresh = 0;
    for (const r of rows) {
      const key = String(r?.id ?? r?.hash ?? `${out.length}`);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      fresh += 1;
    }
    const total = Number(body?.totalCount ?? body?.total ?? body?.totalResults ?? body?.count);
    // Done: nothing new (an empty page, or paging not honoured), or everything counted. A page shorter than
    // asked is not the end: the service may give fewer per page than asked for.
    if (!fresh || (Number.isFinite(total) && out.length >= total)) break;
  }
  return out;
}

/** Every application Application Risk Management lists, page by page as for its results. */
async function riskApplications(client, trace = null) {
  const out = [];
  const seen = new Set();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await client.request(`${RISK_MANAGEMENT_BASE}/summary`, { query: page ? { limit: PAGE, offset: out.length } : undefined, retries: 1, background: true, trace });
    const rows = (Array.isArray(body?.summary) ? body.summary : Array.isArray(body) ? body : []).filter((a) => a?.id);
    let fresh = 0;
    for (const a of rows) {
      if (seen.has(String(a.id))) continue;
      seen.add(String(a.id));
      out.push(a);
      fresh += 1;
    }
    const total = Number(body?.totalCount ?? body?.total ?? body?.count);
    if (!fresh || !Number.isFinite(total) || out.length >= total) break;
  }
  return out;
}

/** Fusion through Application Risk Management: its applications holding a project in scope, and their results. */
async function readRiskManagement(client, inScope, { concurrency, trace, readAt, tried }) {
  let listed;
  try {
    listed = await riskApplications(client, trace);
  } catch (error) {
    if (!isProbeMiss(error) && !NOT_RUNNING.has(error.status)) throw error;
    return { readAt, available: false, tried: [...tried, { path: error.path || `${RISK_MANAGEMENT_BASE}/summary`, status: error.status }], applications: [], results: [], listed: 0, ...summarize([]) };
  }
  const known = new Set(listed.map((a) => String(a.id)));
  const apps = (await listApplications(client).catch(() => [])).filter((a) => a.projectIds.some((id) => inScope.has(id)));
  const read = apps.filter((a) => known.has(a.id));
  const perApp = await mapWithConcurrency(read, concurrency, async (app) => ({ app, rows: await riskResults(client, app.id, trace).catch((error) => (isProbeMiss(error) ? [] : Promise.reject(error))) }));
  const byKey = new Map();
  for (const { app, rows } of perApp) {
    for (const row of rows) for (const r of cleanRiskResult(row, app.id, inScope)) byKey.set(`${r.projectId}\u0000${r.resultId || byKey.size}`, r);
  }
  const results = [...byKey.values()];
  const { projects, totals } = summarize(results);
  const appRow = (app, extra = {}) => ({ id: app.id, name: app.name, projects: app.projectIds.filter((id) => inScope.has(id)).length, results: new Set(results.filter((r) => r.applicationId === app.id).map((r, i) => r.resultId || `row-${i}`)).size, scan: null, ...extra });
  return {
    readAt,
    available: true,
    source: 'risk-management',
    applications: [...read.map((app) => appRow(app)), ...apps.filter((a) => !known.has(a.id)).map((app) => appRow(app, { notScanned: true }))],
    projects,
    totals,
    listed: Math.min(results.length, MAX_LISTED),
    results: results.sort((a, b) => (b.newRisk ?? 0) - (a.newRisk ?? 0)).slice(0, MAX_LISTED),
  };
}

/**
 * Read Fusion's results for the projects in `projectIds` (the Workbench's last fetch):
 * the applications holding them, each one's re-scored results and latest Fusion scan.
 */
export async function readFusion(client, projectIds, { concurrency = 4, trace = null, resultsPath = '', dispatcherPath = '' } = {}) {
  const inScope = new Set([...projectIds].map(String));
  const readAt = new Date().toISOString();
  // A path pinned under Troubleshoot first, then where tenants serve it.
  const resultsBases = [...new Set([resultsPath, ...FUSION_RESULTS_BASES].filter(Boolean))];
  const dispatcherBases = [...new Set([dispatcherPath, ...FUSION_DISPATCHER_BASES].filter(Boolean))];
  const listScanned = (base) => client.request(`${base}/applications`, { retries: 1, background: true, trace });
  // A path pinned under Troubleshoot to Application Risk Management reads it straight away.
  if (resultsPath.startsWith(RISK_MANAGEMENT_BASE)) return readRiskManagement(client, inScope, { concurrency, trace, readAt, tried: [] });
  const found = await findBase(client, resultsBases, 'results', listScanned);
  // No correlation service: Fusion's scored results through Application Risk Management.
  if (!found.base) return readRiskManagement(client, inScope, { concurrency, trace, readAt, tried: found.tried });
  const resultsBase = found.base;
  const scanned = new Set(((found.body !== undefined ? found.body : await listScanned(resultsBase))?.applications ?? []).map(String));
  const apps = (await listApplications(client).catch(() => [])).filter((a) => a.projectIds.some((id) => inScope.has(id)));
  // An application Fusion has results for, holding a project in scope.
  const read = apps.filter((a) => scanned.has(a.id));
  const dispatcherBase = read.length
    ? (await findBase(client, dispatcherBases, 'dispatcher', (base) => client.request(`${base}/${encodeURIComponent(read[0].id)}/scan-status`, { retries: 1, background: true, trace })))?.base ?? null
    : null;
  const perApp = await mapWithConcurrency(read, concurrency, async (app) => {
    const [rows, status] = await Promise.all([
      riskScores(client, resultsBase, app.id, trace).catch((error) => (isProbeMiss(error) ? [] : Promise.reject(error))),
      dispatcherBase ? scanStatus(client, dispatcherBase, app.id, trace).catch(() => null) : null,
    ]);
    return { app, rows, status };
  });
  // One row per project and result: the same result met again (in another scan, or another application) counts once.
  const byKey = new Map();
  for (const { app, rows } of perApp) {
    for (const row of rows) {
      const r = cleanResult(row, app.id);
      if (!r.projectId || !inScope.has(r.projectId)) continue;
      byKey.set(`${r.projectId}\u0000${r.resultId || byKey.size}`, r);
    }
  }
  const results = [...byKey.values()];
  const { projects, totals } = summarize(results);
  const appRow = ({ app, status }) => ({ id: app.id, name: app.name, projects: app.projectIds.filter((id) => inScope.has(id)).length, results: results.filter((r) => r.applicationId === app.id).length, scan: status });
  const order = (r) => -(r.newRisk ?? 0);
  return {
    readAt,
    available: true,
    source: 'correlation',
    applications: [...perApp.map(appRow), ...apps.filter((a) => !scanned.has(a.id)).map((app) => ({ ...appRow({ app, status: null }), notScanned: true }))],
    projects,
    totals,
    listed: Math.min(results.length, MAX_LISTED),
    results: results.sort((a, b) => order(a) - order(b)).slice(0, MAX_LISTED),
  };
}

/** The paths Troubleshoot offers to test first: where tenants serve Fusion, and where its results also appear. */
export const PROBE_DEFAULTS = [
  '/api/correlation/results/applications',
  '/api/correlation/results/applications/{appId}/summary',
  '/api/correlation/results/applications/{appId}/risk-scores',
  '/api/correlation/dispatcher/{appId}/scan-status',
  '/api/fusion-results/applications',
  '/api/fusion/results/applications',
  '/api/risk-management/summary',
  '/api/risk-management/{appId}/results',
  '/api/flags',
];

/**
 * Troubleshoot: call each path once (GET, through this connection), {appId} replaced by an application's
 * id, and say what came back: status, time, the start of the answer, and the full exchange via `trace`.
 */
export async function probeFusion(client, paths, { appId = '', trace = null } = {}) {
  const out = [];
  for (const path of paths) {
    const url = path.replaceAll('{appId}', encodeURIComponent(appId));
    const started = Date.now();
    if (path.includes('{appId}') && !appId) {
      out.push({ path, url, status: 0, ok: false, ms: 0, answer: 'No application to put in {appId}: load findings on the Workbench first.' });
      continue;
    }
    try {
      const body = await client.request(url, { retries: 0, trace, query: url.includes('risk-management/') && url.endsWith('/results') ? { limit: 5 } : undefined });
      out.push({ path, url, status: 200, ok: true, ms: Date.now() - started, answer: (typeof body === 'string' ? body : JSON.stringify(body) ?? '').slice(0, 600) });
    } catch (error) {
      out.push({ path, url, status: error.status ?? 0, ok: false, ms: Date.now() - started, answer: String(error.body || error.message).slice(0, 600) });
    }
  }
  return out;
}
