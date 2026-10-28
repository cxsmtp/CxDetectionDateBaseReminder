/**
 * Cx Credits Calculator: customer profiles, the projection reports made from them, and what the
 * Fusion page reads from Checkmarx One. Per tenant: profiles in projections.json, reports in
 * projection-reports/ (one file each), both in every backup.
 *
 * A profile is one customer: their triage & remediation projection (two Checkmarx One exports and
 * the plan) and their Fusion projection (each project's lines of code, criticality and scan
 * frequency, and how many Fusion scans each needs). A report is a snapshot of both, as figures,
 * from which the browser builds the HTML file it downloads (public/calculator/report.js).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { mapWithConcurrency } from './cxone/client.js';
import { DEFAULT_ENGINES, cleanEngines, engineOf, engineScope } from './engines.js';
import { countProjects, getLastScans, lastScanDate, listApplications, listProjects } from './cxone/projects.js';
import { BRANCH_HOW, branchOf, primaryScans } from './cxone/branches.js';
import { CRITICALITIES, DEFAULT_READ_PROJECTS, amount, frequencyOf, modelsNamed, readLimit, wholeNumber } from '../public/calculator/model.js';
import { modelChoices } from './fusion-usage.js';
import { MAX_PROFILES, MAX_REPORTS, cleanFusion, cleanReportData, cleanTr, fail, finite, iso, migrate, newProfile, newReport, patchProfile, reportMeta, summary, text } from '../public/calculator/profiles.js';

// The rules for customers and reports are shared with the standalone calculator (public/calculator/profiles.js).
export { MAX_PROFILES, MAX_PROFILE_BYTES, MAX_REPORTS, MAX_REPORT_BYTES, cleanFusion, cleanReportData, cleanTr } from '../public/calculator/profiles.js';

const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info'];
const DAY = 86400000;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class ProjectionStore {
  #file;
  #profiles;

  constructor({ file }) {
    this.#file = file;
    this.#profiles = this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
      return Array.isArray(raw.profiles) ? raw.profiles.filter((p) => p && typeof p.id === 'string').map(migrate) : [];
    } catch {
      return [];
    }
  }

  #save() {
    writeJson(this.#file, { version: 2, profiles: this.#profiles });
  }

  list() {
    return [...this.#profiles].sort((a, b) => String(a.name).localeCompare(String(b.name))).map(summary);
  }

  get(id) {
    const found = this.#profiles.find((p) => p.id === id);
    if (!found) throw fail(404, 'That customer no longer exists.');
    return structuredClone(found);
  }

  create({ name, by, impact = {} }) {
    if (this.#profiles.length >= MAX_PROFILES) throw fail(409, `There are already ${MAX_PROFILES} customers. Delete one first.`);
    const profile = newProfile({ name, by, impact });
    this.#profiles.push(profile);
    this.#save();
    return structuredClone(profile);
  }

  /** Save what changed: the customer's name, the T&R projection, the Fusion projection, the extra % and bundle size, the scope, the impact's assumptions (each optional). */
  update(id, patch = {}, by = '') {
    const index = this.#profiles.findIndex((p) => p.id === id);
    if (index === -1) throw fail(404, 'That customer no longer exists.');
    const next = patchProfile(this.#profiles[index], patch, by);
    this.#profiles[index] = next;
    this.#save();
    return summary(next);
  }

  remove(id) {
    const before = this.#profiles.length;
    this.#profiles = this.#profiles.filter((p) => p.id !== id);
    if (this.#profiles.length === before) throw fail(404, 'That customer no longer exists.');
    this.#save();
  }
}

const REPORT_ID = /^[0-9a-f-]{36}$/;

/** Projection reports: each in its own file, listed newest first; the oldest go past MAX_REPORTS. */
export class ReportStore {
  #dir;

  constructor({ dir }) {
    this.#dir = dir;
  }

  #file(id) {
    if (!REPORT_ID.test(String(id))) throw fail(404, 'That report no longer exists.');
    return path.join(this.#dir, `${id}.json`);
  }

  #all() {
    let names = [];
    try {
      names = fs.readdirSync(this.#dir).filter((n) => /^[0-9a-f-]{36}\.json$/.test(n));
    } catch {}
    const out = [];
    for (const name of names) {
      try {
        const { data, ...meta } = JSON.parse(fs.readFileSync(path.join(this.#dir, name), 'utf8'));
        out.push(meta);
      } catch {}
    }
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  list(customerId = '') {
    return this.#all().filter((r) => !customerId || r.customerId === customerId);
  }

  get(id) {
    try {
      return JSON.parse(fs.readFileSync(this.#file(id), 'utf8'));
    } catch (error) {
      if (error.status) throw error;
      throw fail(404, 'That report no longer exists.');
    }
  }

  add({ customerId, customer, by, data }) {
    const report = newReport({ customerId, customer, by, data });
    writeJson(this.#file(report.id), report);
    for (const old of this.#all().slice(MAX_REPORTS)) fs.rmSync(this.#file(old.id), { force: true });
    return reportMeta(report);
  }

  remove(id) {
    const file = this.#file(id);
    if (!fs.existsSync(file)) throw fail(404, 'That report no longer exists.');
    fs.rmSync(file);
  }
}

// ---------------------------------------------------------------------------------------------
// What the Fusion page reads from Checkmarx One
// ---------------------------------------------------------------------------------------------

/** Completed scans per project in the last year (one paginated read of the tenant's scan list). */
const SEVERITY_NAME = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low', INFO: 'Info', INFORMATION: 'Info' };
const zeros = () => Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
const SCAN_PAGE = 200;
/** Scans kept per project for the weekly backlog: enough for a project scanned several times a day. */
const MAX_SCANS_PER_PROJECT = 600;
const SUMMARY_CHUNK = 40;

/**
 * One project's completed scans since `from`, newest first (up to the cap), how many there are,
 * and the last one before `from` (the backlog the window starts with). A project without a scan
 * since then: its last scan is that one.
 */
async function projectScans(client, projectId, { from, lastScan, branch = '' }) {
  const scans = [];
  let count = null;
  // On `branch` only, when given: asked of Checkmarx One, and checked here (a scan that says another branch is left out).
  const onBranch = (x) => !branch || !branchOf(x) || branchOf(x) === branch;
  let ignored = false;
  for (let offset = 0; scans.length < MAX_SCANS_PER_PROJECT; offset += SCAN_PAGE) {
    const page = await client.request('/api/scans', { query: { 'project-id': projectId, statuses: 'Completed', 'from-date': from, sort: '-created_at', offset, limit: SCAN_PAGE, ...(branch ? { branch } : {}) }, retries: 2, background: true });
    const listed = (Array.isArray(page?.scans) ? page.scans : []).filter((x) => x?.id && (!x.projectId || x.projectId === projectId));
    const items = listed.filter(onBranch);
    if (items.length < listed.length) ignored = true;
    count ??= wholeNumber(page?.filteredTotalCount ?? page?.totalCount);
    scans.push(...items);
    if (listed.length < SCAN_PAGE) break;
  }
  // The tenant listed other branches' scans too: its count is not this branch's.
  if (ignored) count = null;
  const at = (scan) => Date.parse(scan?.createdAt ?? scan?.updatedAt ?? '');
  scans.sort((a, b) => at(b) - at(a));
  let before = null;
  if (!scans.length && lastScan?.id && at(lastScan) < Date.parse(from)) before = lastScan;
  else {
    try {
      const page = await client.request('/api/scans', { query: { 'project-id': projectId, statuses: 'Completed', 'to-date': from, sort: '-created_at', limit: branch ? 20 : 1, ...(branch ? { branch } : {}) }, retries: 1, background: true });
      const found = (Array.isArray(page?.scans) ? page.scans : []).find((x) => x?.id && at(x) < Date.parse(from) && onBranch(x));
      if (found) before = found;
    } catch {}
  }
  return { scans, count: count ?? scans.length, before };
}

/**
 * A scan summary's results by severity, and the new ones: over every engine it lists (total, fresh),
 * and for each engine apart (byEngine: {SAST: {total, fresh}, …}).
 */
export function countersOf(summary) {
  const total = zeros();
  const fresh = zeros();
  const byEngine = {};
  const add = (into, severity, n) => {
    const name = SEVERITY_NAME[String(severity ?? '').toUpperCase()];
    const value = wholeNumber(n);
    if (name && value) into[name] += value;
  };
  for (const [key, counters] of Object.entries(summary ?? {})) {
    if (!/Counters$/.test(key) || !counters || typeof counters !== 'object') continue;
    // "sastCounters", "kicsCounters", "apiSecCounters"…: the engine is in the name.
    const engine = engineOf(key.replace(/Counters$/, ''));
    const own = (byEngine[engine] ??= { total: zeros(), fresh: zeros() });
    for (const c of Array.isArray(counters.severityCounters) ? counters.severityCounters : []) {
      add(total, c?.severity, c?.counter);
      add(own.total, c?.severity, c?.counter);
    }
    for (const c of Array.isArray(counters.severityStatusCounters) ? counters.severityStatusCounters : []) {
      if (!/^new$/i.test(String(c?.status ?? ''))) continue;
      add(fresh, c?.severity, c?.counter);
      add(own.fresh, c?.severity, c?.counter);
    }
  }
  return { total, fresh, byEngine };
}

/**
 * Where a scan came from (its scan origin), as a readable label: what Checkmarx One says started it
 * (`sourceOrigin`: the plugin or tool, as its CLI's --agent names it), else what its `userAgent` or
 * `sourceType` show. A tool not known here keeps the name Checkmarx One gives; nothing said is "Not said".
 */
export const ORIGIN_NOT_SAID = 'Not said';
const ORIGIN_LABELS = [
  [/jenkins/i, 'Jenkins'],
  [/git\s*hub[\s_-]*action|gh[\s_-]*action/i, 'GitHub Actions'],
  [/azure|\bado\b|vsts|\btfs\b/i, 'Azure DevOps'],
  [/git\s*lab/i, 'GitLab CI'],
  [/bit\s*bucket/i, 'Bitbucket Pipelines'],
  [/team\s*city/i, 'TeamCity'],
  [/bamboo/i, 'Bamboo'],
  [/circle\s*ci/i, 'CircleCI'],
  [/travis/i, 'Travis CI'],
  [/vs\s*code|visual\s*studio|jetbrains|intellij|eclipse|\bide\b/i, 'IDE'],
  [/web\s*hook|\bscm\b|pull[\s_-]*request/i, 'Code repository (webhook)'],
  [/git\s*hub/i, 'GitHub'],
  [/web\s*app|web\s*portal|\bportal\b|\bui\b|manual|^web$/i, 'Web portal (by hand)'],
  [/postman|\bapi\b|\brest\b/i, 'API'],
  [/\bcli\b|ast[\s_-]*cli|cx[\s_-]*cli/i, 'CLI'],
];
const labelOf = (value) => ORIGIN_LABELS.find(([pattern]) => pattern.test(value))?.[1] ?? '';
export function scanOrigin(scan) {
  const said = text(scan?.sourceOrigin, 60);
  if (said) return labelOf(said) || said;
  // A user agent or source type says something only when it names a tool ("zip" or "git" does not).
  return labelOf(text(scan?.userAgent, 200)) || labelOf(text(scan?.sourceType, 60)) || ORIGIN_NOT_SAID;
}

/** A summary's counts per engine; one without them (made before engines were told apart) is one engine, "ALL". */
const perEngine = (summary) => summary?.byEngine ?? { ALL: { total: summary?.total ?? zeros(), fresh: summary?.fresh ?? zeros() } };
/** Is this engine counted? "ALL" (counts that could not be told apart) always is. */
const counted = (engine, engines) => !engines || engine === 'ALL' || engines.includes(engine);

/** Summaries (results by severity) of these scans, keyed by scan id. */
async function scanSummaries(client, scanIds, { concurrency = 6, onChunk } = {}) {
  const chunks = [];
  for (let i = 0; i < scanIds.length; i += SUMMARY_CHUNK) chunks.push(scanIds.slice(i, i + SUMMARY_CHUNK));
  const out = new Map();
  await mapWithConcurrency(chunks, concurrency, async (ids) => {
    try {
      const body = await client.request('/api/scan-summary', { query: { 'scan-ids': ids }, retries: 2, background: true });
      for (const summary of Array.isArray(body?.scansSummaries) ? body.scansSummaries : []) if (summary?.scanId) out.set(summary.scanId, countersOf(summary));
    } catch {}
    onChunk?.(ids.length);
  });
  return out;
}

/** Each week's end, oldest first: the last is `now`. */
const weekEnds = (now, count) => Array.from({ length: count }, (_, i) => now - (count - 1 - i) * 7 * DAY);

/**
 * One project's own weeks, engine by engine ({ SAST: { t, f }, … }: the backlog at each week's end and the
 * fixes in each week, by severity), from its scans oldest first: `line` is [{ at, ran, by }], `by` a scan's
 * counts per engine and `ran` the engines it ran (null: those it reports).
 */
function projectWeeks(line, ends) {
  const blank = () => Object.fromEntries(SEVERITIES.map((s) => [s, ends.map(() => 0)]));
  const out = {};
  // Each engine on its own timeline: the scans that ran it. A scan that ran only some engines (a SAST-only
  // scan between full ones) leaves the others' last results standing, rather than counting them fixed and
  // then new again. A scan that does not say which engines it ran is taken to have run those it reports.
  for (const engine of new Set(line.flatMap((x) => Object.keys(x.by)))) {
    const mine = line.filter((x) => engine === 'ALL' || (x.ran?.has(engine) ?? engine in x.by));
    if (!mine.length) continue;
    const of = (x) => x.by[engine] ?? { total: zeros(), fresh: zeros() };
    const own = (out[engine] = { t: blank(), f: blank() });
    let k = 0;
    for (let w = 0; w < ends.length; w += 1) {
      while (k + 1 < mine.length && mine[k + 1].at <= ends[w]) k += 1;
      if (mine[k].at > ends[w]) continue;
      for (const s of SEVERITIES) own.t[s][w] += of(mine[k]).total[s] ?? 0;
    }
    for (let i = 1; i < mine.length; i += 1) {
      const w = ends.findIndex((end) => mine[i].at <= end && mine[i].at > end - 7 * DAY);
      if (w === -1) continue;
      const prev = of(mine[i - 1]);
      const next = of(mine[i]);
      // What this engine's scan before reported, plus what it found new, less what it reports now.
      for (const s of SEVERITIES) own.f[s][w] += Math.max(0, (prev.total[s] ?? 0) + (next.fresh[s] ?? 0) - (next.total[s] ?? 0));
    }
  }
  return out;
}

/** A scan as a project keeps it to work its weeks out again (see weeklyBacklog), in short: its time, origin (an index), engines run and counts. */
const packScan = (x, origins) => ({
  t: x.at,
  o: origins.indexOf(x.origin),
  r: x.ran ? [...x.ran] : null,
  s: Object.fromEntries(Object.entries(x.by).map(([engine, c]) => [engine, [...SEVERITIES.map((s) => c.total?.[s] ?? 0), ...SEVERITIES.map((s) => c.fresh?.[s] ?? 0)]])),
});
const unpackScan = (p) => {
  const counts = (a, from) => Object.fromEntries(SEVERITIES.map((s, i) => [s, Number(a?.[from + i]) || 0]));
  const by = Object.entries(p?.s && typeof p.s === 'object' ? p.s : {}).map(([engine, a]) => [engine, { total: counts(a, 0), fresh: counts(a, SEVERITIES.length) }]);
  return { at: Number(p?.t), ran: Array.isArray(p?.r) ? new Set(p.r) : null, by: Object.fromEntries(by) };
};

/**
 * The tenant's backlog and fixes, week by week, as the two Checkmarx One exports give them
 * ("Total" and "Fixed Vulnerabilities by Severity"), worked out from every project's scans:
 * the backlog at a week's end is each project's last scan by then, added up; a week's fixes are
 * what each scan that week no longer reports (the scan before it, plus what it found new, less
 * what it reports). A project scanned before the window counts from its last scan before it.
 */
export function weeklyBacklog(perProject, summaries, { now = Date.now(), weeks = 52, engines = null } = {}) {
  const ends = weekEnds(now, weeks);
  const blank = () => Object.fromEntries(SEVERITIES.map((s) => [s, ends.map(() => 0)]));
  const totals = blank();
  const fixed = blank();
  // SAST's own part of the totals: Fusion's extra findings are counted on SAST only.
  const sastTotals = blank();
  const sastFixed = blank();
  // Unknown when a scan summary did not tell its engines apart ('ALL').
  let sastKnown = true;
  // The engines the tenant's own totals count (null: every engine); each project keeps every engine apart.
  const scope = engineScope(engines);
  const at = (scan) => Date.parse(scan?.createdAt ?? scan?.updatedAt ?? '');
  const ranOf = (scan) => (Array.isArray(scan.engines) && scan.engines.length ? new Set(scan.engines.map(engineOf)) : null);
  let scansUsed = 0;
  // Each project's own weeks, per engine, so the backlog of any set of projects and engines can be added up later.
  const byProject = new Map();
  for (const { project, scans, before } of perProject) {
    const timeline = [...(before ? [before] : []), ...[...scans].reverse()].filter((scan) => summaries.has(scan.id) && Number.isFinite(at(scan)));
    if (!timeline.length) continue;
    scansUsed += timeline.length;
    const line = timeline.map((scan) => ({ at: at(scan), ran: ranOf(scan), by: perEngine(summaries.get(scan.id)), origin: scanOrigin(scan) }));
    const e = projectWeeks(line, ends);
    for (const [engine, pair] of Object.entries(e)) {
      if (engine === 'ALL') sastKnown = false;
      if (!counted(engine, scope)) continue;
      for (const s of SEVERITIES) {
        for (let w = 0; w < ends.length; w += 1) {
          totals[s][w] += pair.t[s][w];
          fixed[s][w] += pair.f[s][w];
          if (engine !== 'SAST') continue;
          sastTotals[s][w] += pair.t[s][w];
          sastFixed[s][w] += pair.f[s][w];
        }
      }
    }
    // Where its scans came from (o). Scanned from more than one, it keeps its scans in short too (x), so its
    // weeks can be worked out again from the scans of only some of them (seriesFor).
    const origins = [...new Set(line.map((x) => x.origin))].sort();
    const own = { e, scans: line.length, o: origins, ...(origins.length > 1 ? { x: line.map((x) => packScan(x, origins)) } : {}) };
    if (project?.id) byProject.set(String(project.id), own);
  }
  const days = ends.map((t) => new Date(t).toISOString().slice(0, 10));
  const sast = (part) => (sastKnown ? { sast: part } : {});
  return { totals: { weeks: days, bySeverity: totals, ...sast(sastTotals) }, fixed: { weeks: days, bySeverity: fixed, ...sast(sastFixed) }, scans: scansUsed, byProject, engines: scope ?? [] };
}

/** A project's weeks from its scans from these origins only (its scans kept in short: see weeklyBacklog). */
function fromOrigins(own, kept, ends) {
  const index = new Set(kept.map((o) => own.o.indexOf(o)));
  const line = (Array.isArray(own.x) ? own.x : []).filter((p) => index.has(p?.o)).map(unpackScan).filter((x) => Number.isFinite(x.at)).sort((a, b) => a.at - b.at);
  return { scans: line.length, e: projectWeeks(line, ends) };
}

/**
 * The backlog and fixes, week by week, of these projects only (ids), from a read's own weeks per
 * project: the same two series the whole tenant has, for a scope. `origins`: only the scans from these
 * scan origins count (null: every scan). A project with none of them is left out; one scanned from
 * several keeps the scans from these, its weeks worked out again from them.
 */
export function seriesFor(read, ids, engines = null, origins = null) {
  const weeks = Array.isArray(read?.weeks) ? read.weeks : [];
  const blank = () => Object.fromEntries(SEVERITIES.map((s) => [s, weeks.map(() => 0)]));
  const totals = blank();
  const fixed = blank();
  const sastTotals = blank();
  const sastFixed = blank();
  const scope = engineScope(engines);
  const wanted = Array.isArray(origins) ? new Set(origins.map((o) => text(o, 60)).filter(Boolean)) : null;
  // The read's own week ends: its last week ends when it was read.
  const ends = weekEnds(Date.parse(read?.readAt ?? '') || Date.now(), weeks.length);
  let projects = 0;
  let scans = 0;
  // A read made before engines were told apart counts every engine: said, so the page can ask for a new read.
  let engineSplit = true;
  // The same for a read made before scan origins were recorded: it counts every scan.
  let originSplit = true;
  // Whether SAST's own part is known: not for a read that counted every engine together.
  let sastKnown = true;
  const add = (pair, t = totals, f = fixed) => {
    for (const s of SEVERITIES) {
      for (let w = 0; w < weeks.length; w += 1) {
        t[s][w] += Number(pair.t?.[s]?.[w]) || 0;
        f[s][w] += Number(pair.f?.[s]?.[w]) || 0;
      }
    }
  };
  for (const id of new Set((Array.isArray(ids) ? ids : []).map(String))) {
    let own = Object.hasOwn(read?.series ?? {}, id) ? read.series[id] : null;
    if (!own) continue;
    if (wanted && !Array.isArray(own.o)) originSplit = false;
    else if (wanted) {
      const kept = own.o.filter((o) => wanted.has(o));
      if (!kept.length) continue;
      if (kept.length < own.o.length) own = fromOrigins(own, kept, ends);
    }
    projects += 1;
    scans += wholeNumber(own.scans) ?? 0;
    if (own.e && typeof own.e === 'object') {
      for (const [engine, pair] of Object.entries(own.e)) {
        if (!counted(engine, scope)) continue;
        if (engine === 'ALL') {
          sastKnown = false;
          if (scope) engineSplit = false;
        }
        add(pair);
        if (engine === 'SAST') add(pair, sastTotals, sastFixed);
      }
    } else {
      sastKnown = false;
      if (scope) engineSplit = false;
      add(own);
    }
  }
  // The scan origins counted ([] = every one).
  const meta = { source: 'cxone', readAt: read?.readAt ?? null, projects, scans, scoped: true, engines: scope ?? [], engineSplit, origins: wanted ? [...wanted].sort() : [], originSplit };
  // SAST's own part, for Fusion's extra findings.
  const sast = (part) => (sastKnown ? { sast: part } : {});
  return { totals: { weeks, bySeverity: totals, ...sast(sastTotals), meta }, fixed: { weeks, bySeverity: fixed, ...sast(sastFixed), meta } };
}

/**
 * The last read of the tenant for the calculator: each project's weeks, kept on the server (too
 * many to send to the page or save with a customer). One file per tenant, replaced by every read;
 * not in backups (the next read makes it again).
 */
export class TenantReadStore {
  #file;
  #cache = null;

  constructor({ file }) {
    this.#file = file;
  }

  save({ readAt, weeks, byProject }) {
    const series = {};
    // Per engine (own.e); a read saved before engines were told apart has t and f, every engine together.
    // Where its scans came from (o) and, scanned from several, its scans in short (x): see weeklyBacklog.
    for (const [id, own] of byProject ?? []) series[id] = own.e ? { scans: own.scans, e: own.e, ...(own.o ? { o: own.o } : {}), ...(own.x ? { x: own.x } : {}) } : { scans: own.scans, t: own.t, f: own.f };
    const value = { readAt, weeks, series };
    // No file: kept in memory only (the standalone calculator's launcher).
    if (this.#file) writeJson(this.#file, value);
    this.#cache = value;
  }

  get() {
    if (this.#cache || !this.#file) return this.#cache;
    try {
      this.#cache = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
    } catch {
      this.#cache = null;
    }
    return this.#cache;
  }
}

/**
 * Everything the Cx Credits Calculator reads from the tenant, in one pass over its projects:
 * for Fusion, each project's lines of code (its last scan), criticality and how often it was
 * scanned in the last year (counted project by project); for triage & remediation, the backlog
 * and fixes week by week over the last `weeks` weeks, from the same scans' summaries.
 * `onProgress(step, done, total)` follows it: "projects" (each project's scans and lines of code), then "summaries".
 * `maxProjects`: how many of the tenant's projects it takes (DEFAULT_READ_PROJECTS unless set; `limited` says when there were more).
 */
export async function readTenant(client, { concurrency = 8, now = Date.now(), weeks = 52, onProgress = () => {}, branches = 'primary', maxProjects = DEFAULT_READ_PROJECTS } = {}) {
  const limit = readLimit(maxProjects);
  const listed = {};
  const [projects, applications] = await Promise.all([listProjects(client, { maxItems: limit, stats: listed }), listApplications(client).catch(() => [])]);
  // Stopped at the limit: how many there are, so the page can say what was left out.
  const total = listed.stopped ? await countProjects(client).catch(() => null) : null;
  const limited = listed.stopped && (total === null || total > projects.length) ? { read: projects.length, limit, total } : null;
  // Each project's applications, by name (a project may be in several).
  const appsOf = new Map();
  for (const app of applications) for (const id of app.projectIds) appsOf.set(id, [...(appsOf.get(id) ?? []), app.name]);
  onProgress('projects', 0, projects.length);
  const anyBranch = await getLastScans(client, projects.map((p) => p.id)).catch(() => ({}));
  // Each project's primary branch only (else main, else master: src/cxone/branches.js), unless every branch
  // is asked for: the same findings counted once, not once per branch scanned.
  const choice = await primaryScans(client, projects, { all: branches === 'all', lastScans: anyBranch, concurrency, background: true }).catch(() => null);
  const lastScans = choice?.scans ?? anyBranch;
  const yearAgo = now - 365 * DAY;
  const from = new Date(Math.min(yearAgo, now - weeks * 7 * DAY)).toISOString();
  let done = 0;
  const perProject = await mapWithConcurrency(projects, concurrency, async (project) => {
    const lastScan = lastScans[project.id] ?? null;
    const want = choice?.branches[project.id] ?? { branch: '', how: BRANCH_HOW.any };
    const branch = [BRANCH_HOW.primary, BRANCH_HOW.guessed, BRANCH_HOW.latest].includes(want.how) ? want.branch : '';
    let history = { scans: [], count: 0, before: null, failed: false };
    // A primary branch never scanned has no scans to count.
    if (want.how !== BRANCH_HOW.none) {
      try {
        history = { ...(await projectScans(client, project.id, { from, lastScan, branch })), failed: false };
      } catch {
        history.failed = true;
      }
    }
    const latest = history.scans[0] ?? lastScan ?? history.before;
    const lines = latest?.id ? await linesOfScan(client, latest.id) : { loc: null, source: 'none' };
    onProgress('projects', (done += 1), projects.length);
    return { project, lastScan, latest, lines, branch: want.branch, branchHow: want.how, ...history };
  });

  // Fusion: how often each project was scanned in the last year (a younger project: since it was created).
  const rows = perProject.map(({ project, latest, lastScan, lines, scans, before, count, failed, branch, branchHow }) => {
    const born = Date.parse(project.createdAt ?? '');
    const windowDays = Math.max(7, Math.min(365, (now - Math.max(yearAgo, Number.isFinite(born) ? born : 0)) / DAY));
    const yearScans = scans.filter((x) => Date.parse(x.createdAt ?? '') >= yearAgo);
    const inYear = scans.length >= MAX_SCANS_PER_PROJECT || count > scans.length ? count : yearScans.length;
    // Scans that could not be listed: the last scan still says whether it was within the year.
    const lastAt = Date.parse(lastScanDate(latest) ?? '');
    const scanCount = failed ? (lastAt >= yearAgo ? 1 : 0) : inYear;
    const frequency = frequencyOf(scanCount, windowDays);
    // Where its scans came from: each scan origin with its scans in the year (those listed, scaled up to the count
    // when there were more), so the page can count the scans from only some. An origin of a scan before the year
    // (the one its backlog starts from) is there with 0: the project still has a scan from it.
    const origins = {};
    for (const x of [...scans, ...(before ? [before] : [])]) origins[scanOrigin(x)] = 0;
    if (failed || (!scans.length && !before)) {
      if (latest?.id) origins[scanOrigin(latest)] = scanCount;
    } else {
      for (const x of yearScans) origins[scanOrigin(x)] += 1;
      if (yearScans.length && scanCount > yearScans.length) for (const o of Object.keys(origins)) origins[o] = Math.round((origins[o] * scanCount) / yearScans.length);
    }
    return {
      id: project.id,
      name: project.name,
      applications: (appsOf.get(String(project.id)) ?? []).slice(0, 50),
      groups: (Array.isArray(project.groups) ? project.groups : []).map((g) => String(g?.name ?? g ?? '')).filter(Boolean).slice(0, 50),
      initiator: String(latest?.initiator ?? lastScan?.initiator ?? '').slice(0, 254),
      criticality: CRITICALITIES.includes(Number(project.criticality)) ? Number(project.criticality) : null,
      scanCount,
      // The days its scans were counted over (a year, or since it was created), for its frequency from only some origins.
      scanDays: Math.round(windowDays * 100) / 100,
      origins,
      scansPerWeek: Math.round(frequency.perWeek * 100) / 100,
      frequency: frequency.id,
      lastScanAt: lastScanDate(latest),
      scanId: latest?.id ?? '',
      ...lines,
      branch,
      branchHow,
      included: true,
    };
  });

  // Triage & remediation: the scans' summaries, then the weeks.
  const ids = [...new Set(perProject.flatMap(({ scans, before }) => [...(before ? [before.id] : []), ...scans.map((x) => x.id)]))];
  let summarised = 0;
  onProgress('summaries', 0, ids.length);
  const summaries = await scanSummaries(client, ids, { onChunk: (n) => onProgress('summaries', (summarised += n), ids.length) });
  // The tenant's own totals count SAST and SCA, the engines AI Triage and Remediation act on; a scope
  // with other engines is added up from each project's engines (seriesFor).
  const weekly = weeklyBacklog(perProject, summaries, { now, weeks, engines: DEFAULT_ENGINES });
  // Each project's open findings now, engine by engine (its latest scan with a summary): "no open findings" in the scope.
  perProject.forEach(({ latest, scans, before }, i) => {
    const counted = [latest, ...scans, before].find((x) => x?.id && summaries.has(x.id));
    const summary = counted ? summaries.get(counted.id) : null;
    if (!summary) return;
    rows[i].openByEngine = Object.fromEntries(Object.entries(perEngine(summary)).map(([engine, { total }]) => [engine, SEVERITIES.reduce((n, s) => n + (total[s] ?? 0), 0)]));
  });
  const readAt = new Date(now).toISOString();
  const meta = { source: 'cxone', readAt, projects: projects.length, ...(limited ? { projectsLimit: limit, projectsTotal: total } : {}), scans: weekly.scans, engines: weekly.engines, engineSplit: true, origins: [], originSplit: true, branches: branches === 'all' ? 'all' : 'primary' };
  return {
    projects: rows,
    limited,
    applications: [...new Set(applications.map((a) => a.name))].sort((a, b) => a.localeCompare(b)),
    tr: summaries.size ? { totals: { ...weekly.totals, meta }, fixed: { ...weekly.fixed, meta } } : null,
    readAt,
    // Each project's weeks: kept on the server (TenantReadStore), never sent to the page.
    perProject: { readAt, weeks: weekly.totals.weeks, byProject: weekly.byProject },
  };
}

/** Lines of code a scan counted: its SAST scan metadata, else the scan's own SAST details. */
async function linesOfScan(client, scanId) {
  try {
    const meta = await client.request(`/api/sast-metadata/${encodeURIComponent(scanId)}`, { retries: 1, background: true });
    const loc = wholeNumber(meta?.loc);
    if (loc !== null) return { loc, source: 'sast-metadata' };
  } catch {}
  try {
    const details = await client.request(`/api/scans/${encodeURIComponent(scanId)}`, { retries: 1, background: true });
    const sast = (Array.isArray(details?.statusDetails) ? details.statusDetails : []).find((d) => String(d?.name).toLowerCase() === 'sast');
    const loc = wholeNumber(sast?.loc);
    if (loc !== null) return { loc, source: 'scan' };
  } catch {}
  return { loc: null, source: 'none' };
}

/** Every project in the tenant for Fusion (see readTenant). */
export async function readFusionProjects(client, options = {}) {
  return (await readTenant(client, options)).projects;
}

/** The first number under any of these keys, at any depth (an answer whose shape is not documented). */
function findNumber(value, keys, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  for (const [k, v] of Object.entries(value)) if (keys.test(k) && amount(v) !== null && typeof v !== 'object') return amount(v);
  for (const v of Object.values(value)) {
    const found = findNumber(v, keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/** Model entries in an answer: objects with a name and a credit rate. */
function findModels(value, depth = 0, out = []) {
  if (!value || typeof value !== 'object' || depth > 5 || out.length > 20) return out;
  if (Array.isArray(value)) {
    for (const item of value) {
      const name = item && typeof item === 'object' ? text(item.displayName ?? item.name ?? item.model ?? item.modelName, 80) : '';
      const rate = item && typeof item === 'object' ? findNumber(item, /credit|cost|price/i) : null;
      if (name && rate !== null) out.push({ id: `tenant-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 60), name, description: text(item.description, 200), creditsPer10k: rate, source: 'tenant' });
      else findModels(item, depth + 1, out);
    }
  } else for (const v of Object.values(value)) findModels(v, depth + 1, out);
  return out;
}

/**
 * Where a tenant may say which Fusion models it offers (with their credits), and what credits it has left. The
 * models it offers are its "LLM Model" setting's choices (GET /api/configuration/tenant); the others are tried,
 * never relied on. Its credits left: GET /api/credits/info ("available").
 */
export const FUSION_MODEL_PATHS = ['/api/fusion/models', '/api/fusion/config', '/api/scan-config/fusion/models'];
export const CREDIT_BALANCE_PATHS = ['/api/credits/info', '/api/fusion/credits', '/api/credits/balance'];

/**
 * The Fusion models the tenant offers ({ name, creditsPer10k }) and the credits it has left, when
 * the tenant answers one of the places above; otherwise none and null, to be typed in by hand.
 */
export async function readFusionOffer(client) {
  const tryRead = async (paths) => {
    for (const p of paths) {
      try {
        const body = await client.request(p, { retries: 0, background: true });
        if (body && typeof body === 'object') return body;
      } catch {}
    }
    return null;
  };
  const [modelsBody, creditsBody, tenantBody] = await Promise.all([tryRead(FUSION_MODEL_PATHS), tryRead(CREDIT_BALANCE_PATHS), tryRead(['/api/configuration/tenant'])]);
  // The models its "LLM Model" setting offers (names only: their credits are typed in), then any with a rate.
  const entries = Array.isArray(tenantBody) ? tenantBody : Array.isArray(tenantBody?.configEntries) ? tenantBody.configEntries : [];
  const offered = modelsNamed(modelChoices(entries.find((e) => e?.key === 'scan.config.ai.llmModel')), 'tenant');
  const priced = modelsBody ? findModels(modelsBody) : [];
  const models = [...priced, ...offered.filter((m) => !priced.some((p) => p.name.toLowerCase() === m.name.toLowerCase()))];
  const unique = [...new Map(models.map((m) => [m.id, m])).values()];
  const remainingCredits = creditsBody ? findNumber(creditsBody, /remaining|balance|available/i) : null;
  return { models: unique, remainingCredits };
}

