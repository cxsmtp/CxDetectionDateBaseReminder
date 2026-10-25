/**
 * Labs → Status board (Beta): every project's last scan and its results at a glance.
 *
 * Built from what the Workbench fetch already read (src/server.js runScan): the latest scan of each project on the
 * branch that counts, its engines (read with the scan types, no extra call), the open results by severity, and the
 * languages. The fetch adds two cheap reads when the board is unlocked, both tenant-wide and cached per Checkmarx One
 * key: the applications (a few pages), and the scans that failed in the last 7 days (one page in most tenants). A
 * page view reads none of this from Checkmarx One: it reads the session's fetched data.
 *
 * The side panel's last five scans of one project are read when the panel opens (three calls), and kept: a
 * completed scan never changes.
 */
import { lastScanDate } from './cxone/projects.js';

const DAY_MS = 86_400_000;
/** Scanned under this many days ago: fresh (green); under STALE_DAYS: ageing (amber); else stale (red). */
export const FRESH_DAYS = 7;
export const STALE_DAYS = 30;
/** Failed scans are looked for this far back. */
export const FAILED_DAYS = 7;
/** The engines every row shows (run or not), in this order; others are added when a scan ran them. */
export const BOARD_ENGINES = ['sast', 'sca', 'kics', 'containers'];
export const ENGINE_LABELS = { sast: 'SAST', sca: 'SCA', kics: 'KICS', containers: 'Containers', apisec: 'API Security', 'api-security': 'API Security', microengines: 'Secrets', ai: 'AI' };

const text = (v, max = 200) => (v === null || v === undefined ? '' : String(v).trim().slice(0, max));
const timeOf = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : 0;
};

/** A scan's engines as lower-case names ("KICS" and "IaC" are one). */
export function engineNames(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    let name = text(raw, 40).toLowerCase();
    if (name === 'iac' || name === 'iac-security') name = 'kics';
    if (name === 'container' || name === 'containers-security') name = 'containers';
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** The engines a failed scan's status details say failed (lower case). */
export function failedEngines(scan) {
  return engineNames((Array.isArray(scan?.statusDetails) ? scan.statusDetails : []).filter((d) => /fail/i.test(String(d?.status ?? ''))).map((d) => d?.name));
}

/** Why a scan failed, from its status details ("SAST: out of memory"); '' when it does not say. */
export function failureReason(scan) {
  const details = (Array.isArray(scan?.statusDetails) ? scan.statusDetails : []).filter((d) => /fail/i.test(String(d?.status ?? '')));
  const parts = details.map((d) => {
    const engine = ENGINE_LABELS[engineNames([d?.name])[0]] ?? text(d?.name, 40).toUpperCase();
    const why = text(d?.details, 240);
    return [engine, why].filter(Boolean).join(': ');
  });
  return parts.filter(Boolean).join('; ').slice(0, 400);
}

/**
 * The tenant's scans that failed since `since` (ISO), newest first, per project: { projectId: [{ id, at, branch,
 * reason, engines }] }. One call for most tenants (a hundred to a page, at most `maxItems`). Throws when Checkmarx
 * One does not answer: the board then says failed scans are not known, never that there are none.
 */
export async function failedScansSince(client, { since, maxItems = 1000, background = true } = {}) {
  const byProject = Object.create(null);
  const limit = 100;
  for (let offset = 0; offset < maxItems; offset += limit) {
    const page = await client.request('/api/scans', { query: { statuses: 'Failed', 'from-date': since, sort: '-created_at', limit, offset }, retries: 1, background });
    const scans = Array.isArray(page?.scans) ? page.scans : [];
    for (const scan of scans) {
      // Some tenants ignore the filter: only failed scans in the window count.
      if (!/^failed$/i.test(String(scan?.status ?? '')) || !scan?.projectId) continue;
      const at = text(scan.createdAt ?? scan.updatedAt, 40);
      if (timeOf(at) < timeOf(since)) continue;
      const projectId = text(scan.projectId, 80);
      if (['__proto__', 'constructor', 'prototype'].includes(projectId)) continue;
      (byProject[projectId] ??= []).push({ id: text(scan.id, 80), at, branch: text(scan.branch, 200), reason: failureReason(scan), engines: failedEngines(scan) });
    }
    if (scans.length < limit) break;
  }
  for (const list of Object.values(byProject)) list.sort((a, b) => timeOf(b.at) - timeOf(a.at));
  return byProject;
}

/** Each project's applications' names, from the tenant's applications ({ id, name, projectIds }). */
export function applicationsByProject(applications) {
  const out = Object.create(null);
  for (const app of Array.isArray(applications) ? applications : []) {
    for (const id of app?.projectIds ?? []) {
      const key = String(id);
      if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      (out[key] ??= []).push(text(app.name, 120));
    }
  }
  for (const list of Object.values(out)) list.sort((a, b) => a.localeCompare(b));
  return out;
}

/**
 * What the board needs of each project, added to the Workbench's project summaries once the fetch has read them:
 * when its latest scan ran and its engines, its applications and groups, and the scans that failed since.
 * `facts`: { scans: {projectId: scan}, engines: {projectId: [..]}, applications: {projectId: [names]},
 * groups: {projectId: [..]}, failed: {projectId: [..]} | null (not known) }.
 */
export function attachScanFacts(summaries, facts = {}) {
  for (const s of summaries ?? []) {
    const id = s.projectId;
    const scan = facts.scans?.[id] ?? null;
    s.scanAt = (scan && lastScanDate(scan)) || s.lastScanDate || null;
    s.scanId = text(scan?.id ?? scan?.scanId, 80);
    s.engines = engineNames(facts.engines?.[id] ?? scan?.engines);
    s.applications = facts.applications?.[id] ?? [];
    s.groups = (facts.groups?.[id] ?? []).map((g) => text(g, 120)).filter(Boolean);
    if (facts.failed) {
      const failed = facts.failed[id] ?? [];
      s.failedScans = failed.length;
      // A failure counts against the project only when it is newer than the results shown.
      const newest = failed[0];
      s.scanFailed = newest && timeOf(newest.at) > timeOf(s.scanAt) ? newest : null;
    } else {
      s.failedScans = null;
      s.scanFailed = null;
    }
  }
  return summaries;
}

/** fresh | aging | stale | failed | never, from the days since the last scan and whether a newer one failed. */
export function healthOf(ageDays, failed) {
  if (failed) return 'failed';
  if (ageDays === null || ageDays === undefined) return 'never';
  if (ageDays < FRESH_DAYS) return 'fresh';
  if (ageDays < STALE_DAYS) return 'aging';
  return 'stale';
}

const count = (by, key) => Math.max(0, Number(by?.[key]) || 0);

/** One row of the board from a Workbench project summary (what the page shows, nothing more). */
export function boardRow(s, now = Date.now()) {
  const sev = { critical: count(s.bySeverity, 'CRITICAL'), high: count(s.bySeverity, 'HIGH'), medium: count(s.bySeverity, 'MEDIUM'), low: count(s.bySeverity, 'LOW') };
  const at = timeOf(s.scanAt ?? s.lastScanDate);
  const ageDays = at ? Math.max(0, (now - at) / DAY_MS) : null;
  const failed = s.scanFailed ? { at: s.scanFailed.at, branch: s.scanFailed.branch, reason: s.scanFailed.reason, engines: s.scanFailed.engines ?? [] } : null;
  return {
    projectId: text(s.projectId, 80),
    name: text(s.projectName, 300),
    url: text(s.url, 2000),
    applications: Array.isArray(s.applications) ? s.applications : [],
    groups: Array.isArray(s.groups) ? s.groups : [],
    languages: Array.isArray(s.languages) ? s.languages : [],
    branch: text(s.branch, 200),
    scanId: text(s.scanId, 80),
    scanAt: at ? new Date(at).toISOString() : null,
    scanType: s.scanType === 'fusion' || s.scanType === 'last' ? s.scanType : '',
    engines: Array.isArray(s.engines) ? s.engines : [],
    sev,
    total: sev.critical + sev.high + sev.medium + sev.low,
    ch: sev.critical + sev.high,
    overdue: Math.max(0, Number(s.sla?.overdue) || 0),
    ageDays: ageDays === null ? null : Math.round(ageDays * 100) / 100,
    failed,
    failedScans: s.failedScans ?? null,
    health: healthOf(ageDays, failed),
    error: text(s.error, 300),
  };
}

/** The figures line: projects, scanned in 30 days, failed scans in 7 days, not scanned for 30+ days, open C+H. */
export function boardFigures(rows) {
  const known = rows.some((r) => r.failedScans !== null && r.failedScans !== undefined);
  return {
    projects: rows.length,
    scanned30: rows.filter((r) => r.ageDays !== null && r.ageDays < STALE_DAYS).length,
    failed7: known ? rows.reduce((n, r) => n + (r.failedScans ?? 0), 0) : null,
    failedProjects: rows.filter((r) => r.failed).length,
    stale30: rows.filter((r) => r.ageDays === null || r.ageDays >= STALE_DAYS).length,
    ch: rows.reduce((n, r) => n + r.ch, 0),
    critical: rows.reduce((n, r) => n + r.sev.critical, 0),
    fusion: rows.filter((r) => r.scanType === 'fusion').length,
    last: rows.filter((r) => r.scanType === 'last').length,
  };
}

/** The board from a session's fetched data ({ projects, view }): rows and figures; null when nothing was fetched. */
export function boardOf(scan, now = Date.now()) {
  if (!scan?.projects) return null;
  const rows = scan.projects.map((p) => boardRow(p, now));
  return { fetchedAt: scan.view?.fetchedAt ?? null, rows, figures: boardFigures(rows), failedKnown: rows.some((r) => r.failedScans !== null) || !rows.length };
}

/** Results by severity in a scan summary (every engine's counters), or null when it has none. */
export function summaryTotal(sum) {
  if (!sum || typeof sum !== 'object') return null;
  let total = 0;
  let any = false;
  for (const [key, counters] of Object.entries(sum)) {
    if (!/Counters$/.test(key) || !counters || typeof counters !== 'object') continue;
    const list = Array.isArray(counters.severityCounters) ? counters.severityCounters : [];
    if (list.length) {
      any = true;
      total += list.reduce((n, c) => n + (Number(c?.counter) || 0), 0);
    } else if (Number.isFinite(Number(counters.totalCounter))) {
      any = true;
      total += Number(counters.totalCounter);
    }
  }
  return any ? total : null;
}

/**
 * A project's last `limit` scans, newest first: status, engines, duration, lines of code, results and the change
 * from the scan before. Three calls (the scans, their lines of code, their results), each failing quietly.
 */
export async function recentScans(client, projectId, { limit = 5, background = false } = {}) {
  const page = await client.request('/api/scans', { query: { 'project-id': projectId, sort: '-created_at', limit: limit + 1, offset: 0 }, retries: 1, background });
  const scans = (Array.isArray(page?.scans) ? page.scans : [])
    .filter((s) => s?.id && (!s.projectId || String(s.projectId) === String(projectId)))
    .sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt))
    .slice(0, limit + 1);
  const ids = scans.map((s) => text(s.id, 80));
  const quiet = (fn) => fn().catch(() => null);
  const [meta, summary] = ids.length
    ? await Promise.all([
        quiet(() => client.request('/api/sast-metadata', { query: { 'scan-ids': ids }, retries: 1, background })),
        quiet(() => client.request('/api/scan-summary', { query: { 'scan-ids': ids }, retries: 1, background })),
      ])
    : [null, null];
  const loc = new Map((Array.isArray(meta?.scans) ? meta.scans : []).map((m) => [text(m?.scanId, 80), Number.isFinite(Number(m?.loc)) ? Number(m.loc) : null]));
  const totals = new Map((Array.isArray(summary?.scansSummaries) ? summary.scansSummaries : []).map((s) => [text(s?.scanId, 80), summaryTotal(s)]));
  const rows = scans.map((s) => {
    const id = text(s.id, 80);
    const start = timeOf(s.createdAt);
    const end = timeOf(s.updatedAt);
    const status = text(s.status, 40) || 'Unknown';
    return {
      id,
      status,
      at: s.createdAt ? new Date(start).toISOString() : null,
      branch: text(s.branch, 200),
      engines: engineNames(s.engines),
      seconds: start && end && end >= start && !/queued|running/i.test(status) ? Math.round((end - start) / 1000) : null,
      loc: loc.get(id) ?? null,
      results: totals.get(id) ?? null,
      reason: /fail/i.test(status) ? failureReason(s) : '',
    };
  });
  // The change in results from the previous completed scan (the one after it in this list).
  for (let i = 0; i < rows.length; i += 1) {
    const before = rows.slice(i + 1).find((r) => r.results !== null && /completed/i.test(r.status));
    rows[i].delta = rows[i].results !== null && before ? rows[i].results - before.results : null;
  }
  return rows.slice(0, limit);
}
