/**
 * FAE Flush (Labs, then Act): Findings Analysis (FAE) cuts noise only from results found after it was turned on;
 * the backlog stays. FAE Flush clears it once, for the whole tenant, and leaves every project as it is (its
 * history, triage, automations and integrations):
 *
 *   1. Copy the code: the exact code of the project's latest scan, as Checkmarx One keeps it. First its own copy,
 *      read where it is: GET /api/repostore/code/{scanId} answers 302 with a signed storage address (15 minutes),
 *      handed to the new scan, so nothing passes through this server; else downloaded and uploaded again
 *      (POST /api/uploads, then PUT); else the repository at the latest scan's commit. Which one is a run option.
 *   2. Scan it on a new project, "<name>_FAE" (POST /api/projects, tagged mz-fae-flush), with the project's own
 *      SAST settings and Findings Analysis on (PATCH /api/configuration/project), SAST only (POST /api/scans).
 *   3. Compare: each SAST result of the project still To verify against the FAE scan's results, by similarity id.
 *   4. Mark: each one the FAE scan did not report becomes Proposed not exploitable in the original project
 *      (POST /api/sast-results-predicates), with a comment naming the FAE scan.
 *   5. Revalidate: both read again; every result marked is still not reported, and is marked.
 *   6. Remove "<name>_FAE" (DELETE /api/projects/{id}), when the person who started it chose so.
 *
 * Several projects at once, a few scans at a time; a project stops and asks (an "exception") when something looks
 * off: the FAE scan did not complete, the code it scanned differs, or it would mark unusually many, or report
 * many results the project does not have. The run is kept on disk and carries on after a restart. Every result
 * marked is kept, so the run can be undone (back to To verify, only those still as it left them), and in a history
 * that outlives the run (fae-flush-history.json), for the value it brought. A run may only report what it would
 * mark ("report"), to mark later. With debug on, every call to Checkmarx One is logged (signatures hidden).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mapWithConcurrency } from './cxone/client.js';
import { FAE_FLUSH_TAG } from './cxone/projects.js';

export const FAE_TAG = FAE_FLUSH_TAG;
export const FAE_SUFFIX = '_FAE';
export const PNE = 'PROPOSED_NOT_EXPLOITABLE';
export const NE = 'NOT_EXPLOITABLE';
/** What a run marks the false positives as: Proposed not exploitable, or (Admins only) Not exploitable. */
export const MARK_AS = { pne: PNE, ne: NE };
export const STATE_NAME = { [PNE]: 'Proposed not exploitable', [NE]: 'Not exploitable' };
/** The state a run marks with. */
export const markState = (job) => MARK_AS[job?.options?.markAs] ?? PNE;
export const TO_VERIFY = 'TO_VERIFY';
/** Where a project is: waiting, at work (copying … cleaning), stopped to ask, or finished one way or another. */
export const STEPS = ['waiting', 'copying', 'scanning', 'comparing', 'needs-ok', 'reported', 'marking', 'revalidating', 'cleaning', 'done', 'skipped', 'left-out', 'undone'];
const WORKING = new Set(['copying', 'scanning', 'comparing', 'marking', 'revalidating', 'cleaning']);
// "reported": compared in a report-only run, waiting for "Mark now".
const FINISHED = new Set(['done', 'skipped', 'left-out', 'undone', 'reported']);
/** Where the code comes from: Checkmarx One's own copy in place, downloaded and uploaded, the repository; or each in turn. */
export const SOURCES = ['auto', 'link', 'upload', 'git'];
export const SOURCE_LABEL = { link: 'Checkmarx One’s own copy', upload: 'download and upload', git: 'the repository' };
/** Mark what the FAE scan no longer reports, or only report it (marked later, with "Mark now"). */
export const MODES = ['mark', 'report'];
const DEBUG_MAX = 500;
/** Projects whose scan is under way count against "scans at once". */
const SCANNING = new Set(['copying', 'scanning']);

/** When a project stops and asks before marking. */
export const LIMITS = Object.freeze({
  // The FAE scan counted this much more or fewer lines of code than the project's latest scan.
  locDrift: 0.02,
  // It would mark more than this share of the project's To verify results (with at least `minForShare` of them).
  markShare: 0.9,
  minForShare: 20,
  // The FAE scan reported more than this share of results the project does not have.
  extraShare: 0.25,
  // A scan still running after this long.
  scanHours: 12,
});
/** "Stop and ask me if": how readily a project stops before marking. */
export const SENSITIVITY = Object.freeze({
  rarely: Object.freeze({ locDrift: 0.1, markShare: 0.98, minForShare: 50, extraShare: 0.5, scanHours: 24 }),
  normal: LIMITS,
  often: Object.freeze({ locDrift: 0.01, markShare: 0.75, minForShare: 10, extraShare: 0.1, scanHours: 6 }),
});
const PAGE = 500;
const PAGES = 40;
const PREDICATES_AT_ONCE = 100;

const text = (v, max = 300) => (v === null || v === undefined ? '' : String(v).slice(0, max));
const whole = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : null);
const upper = (v) => text(v, 60).trim().toUpperCase();
const sastLoc = (scan) => whole((Array.isArray(scan?.statusDetails) ? scan.statusDetails : []).find((d) => String(d?.name).toLowerCase() === 'sast')?.loc);
const sastDone = (scan) => (Array.isArray(scan?.statusDetails) ? scan.statusDetails : []).find((d) => String(d?.name).toLowerCase() === 'sast');
/** The repository, branch and commit a scan was made from (a repository scan's handler), when it says. */
const gitOf = (scan) => {
  const g = scan?.metadata?.Handler?.GitHandler ?? scan?.metadata?.handler?.gitHandler ?? {};
  return { repoUrl: text(g.repo_url ?? g.repoUrl, 500), commit: text(g.commit_id ?? g.commitId, 80) };
};
/** Signed storage addresses carry their signature in the query: never kept in a log. */
const SIGNED = /(X-Amz-(?:Signature|Credential|Security-Token)=)[^&"'\s\\]+/gi;
export const redact = (value) => JSON.parse(JSON.stringify(value ?? null).replace(SIGNED, '$1[hidden]'));

/** The run, kept on disk (DATA_DIR/<tenant>/fae-flush.json): the last one, with every project's progress. */
export class FaeFlushStore {
  constructor({ file }) {
    this.file = file;
    try {
      this.job = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.job = null;
    }
    this.preview = null;
    // Debug mode and its log: for this server's life only (never written to disk).
    this.debug = { on: false, log: [] };
  }

  save() {
    if (!this.job) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.job));
    fs.renameSync(tmp, this.file);
  }
}

/**
 * Every result FAE Flush marked, kept after the run (DATA_DIR/<tenant>/fae-flush-history.json): one entry per
 * project and run, with each result's similarity id, severity and vulnerability, and what was undone since.
 */
export class FaeHistory {
  constructor({ file }) {
    this.file = file;
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      this.data = { entries: [] };
    }
    if (!Array.isArray(this.data?.entries)) this.data = { entries: [] };
  }

  find(runId, projectId) {
    return this.data.entries.find((e) => e.runId === runId && e.projectId === projectId) ?? null;
  }

  /** Add or replace one project's marks in a run. */
  put(entry) {
    const at = this.data.entries.findIndex((e) => e.runId === entry.runId && e.projectId === entry.projectId);
    if (at >= 0) this.data.entries[at] = { ...this.data.entries[at], ...entry };
    else this.data.entries.push(entry);
    this.save();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
/**
 * What FAE Flush has been worth: the false positives it took off people's hands (those still marked), by severity,
 * state, run and project, in results as Checkmarx One counts them and in distinct findings, and what that saves with
 * the figures under Settings → AI & credit pool → Impact (`impact`: { triageMinutes, hourlyRate, creditPrice,
 * currency }): the manual triage hours (a person triages each finding once), the AI Triage credits (one per result)
 * not needed, and the money both come to.
 */
export function valueOf(history, impact = {}) {
  const entries = history?.data?.entries ?? [];
  const sev = () => Object.fromEntries(SEVERITY_ORDER.map((k) => [k, 0]));
  const total = { marked: 0, markedFindings: 0, undone: 0, kept: 0, keptFindings: 0, toVerify: 0, bySeverity: sev(), byState: { [PNE]: 0, [NE]: 0 } };
  const minutes = Number(impact.triageMinutes) > 0 ? Number(impact.triageMinutes) : 20;
  const rate = Number(impact.hourlyRate) || 0;
  const price = Number(impact.creditPrice) || 0;
  const priced = rate > 0 || price > 0;
  // What a number of findings (triaged by hand) and results (one AI Triage credit each) are worth.
  const moneyOf = (findings, results) => (priced ? Math.round(((findings * minutes) / 60) * rate + results * price) : null);
  const runs = new Map();
  const projects = new Map();
  for (const e of entries) {
    const items = e.items ?? [];
    const marked = items.reduce((n, it) => n + (Number(it[3]) || 1), 0);
    const undone = e.undone ?? 0;
    const undoneFindings = e.undoneFindings ?? e.undone ?? 0;
    const kept = Math.max(0, marked - undone);
    const keptFindings = Math.max(0, items.length - undoneFindings);
    total.marked += marked;
    total.markedFindings += items.length;
    total.undone += undone;
    total.kept += kept;
    total.keptFindings += keptFindings;
    total.toVerify += e.toVerify ?? 0;
    total.byState[e.state === NE ? NE : PNE] += kept;
    const bySev = sev();
    for (const [, severity, , results] of items) bySev[SEVERITY_ORDER.includes(severity) ? severity : 'MEDIUM'] += Number(results) || 1;
    for (const [k, n] of Object.entries(e.undoneBySeverity ?? {})) if (k in bySev) bySev[k] = Math.max(0, bySev[k] - n);
    for (const k of SEVERITY_ORDER) total.bySeverity[k] += bySev[k];
    const run = runs.get(e.runId) ?? { runId: e.runId, at: e.at, by: e.by ?? '', state: e.state === NE ? NE : PNE, projects: 0, toVerify: 0, marked: 0, revalidated: 0, undone: 0, kept: 0, keptFindings: 0 };
    Object.assign(run, { projects: run.projects + 1, toVerify: run.toVerify + (e.toVerify ?? 0), marked: run.marked + marked, revalidated: run.revalidated + (e.revalidated ?? 0), undone: run.undone + undone, kept: run.kept + kept, keptFindings: run.keptFindings + keptFindings, at: run.at < e.at ? run.at : e.at });
    runs.set(e.runId, run);
    const proj = projects.get(e.projectId) ?? { projectId: e.projectId, project: e.project, runs: 0, toVerify: 0, kept: 0, keptFindings: 0, last: '' };
    Object.assign(proj, { project: e.project || proj.project, runs: proj.runs + 1, toVerify: proj.toVerify + (e.toVerify ?? 0), kept: proj.kept + kept, keptFindings: proj.keptFindings + keptFindings, last: proj.last > e.at ? proj.last : e.at });
    projects.set(e.projectId, proj);
  }
  const hours = Math.round(((total.keptFindings * minutes) / 60) * 10) / 10;
  const hoursCost = rate > 0 ? Math.round(((total.keptFindings * minutes) / 60) * rate) : null;
  const creditsCost = price > 0 ? Math.round(total.kept * price * 100) / 100 : null;
  for (const x of [...runs.values(), ...projects.values()]) x.money = moneyOf(x.keptFindings, x.kept);
  return {
    total,
    saved: {
      hours,
      minutesPerTriage: minutes,
      hourlyRate: rate,
      creditPrice: price,
      hoursCost,
      credits: total.kept,
      creditsCost,
      money: priced ? Math.round(((hoursCost ?? 0) + (creditsCost ?? 0)) * 100) / 100 : null,
      currency: text(impact.currency || 'USD', 8),
    },
    runs: [...runs.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))),
    projects: [...projects.values()].sort((a, b) => b.kept - a.kept || a.project.localeCompare(b.project)),
  };
}

/** Every SAST result of a scan, page by page (cut short at PAGE × PAGES). */
export async function scanResults(client, scanId) {
  const out = [];
  for (let page = 0; page < PAGES; page += 1) {
    const body = await client.request('/api/sast-results', { query: { 'scan-id': scanId, limit: PAGE, offset: page * PAGE }, retries: 2, background: true });
    const rows = Array.isArray(body?.results) ? body.results : [];
    out.push(...rows);
    const total = Number(body?.totalCount);
    if (rows.length < PAGE || (Number.isFinite(total) && out.length >= total)) break;
  }
  return out;
}

const keyOf = (r) => text(r?.similarityID ?? r?.similarityId, 80);
/** A result the FAE scan reported: there, and not judged not exploitable by Findings Analysis itself. */
const reportedByFae = (r) => ![PNE, 'NOT_EXPLOITABLE'].includes(upper(r?.state));

/**
 * The project's open SAST results still To verify, against the FAE scan's results, by similarity id. Checkmarx
 * One keeps a result's state by similarity id, so one mark covers every result sharing it: counts are in results,
 * as Checkmarx One shows them, and in distinct findings (similarity ids).
 * { toVerify, toVerifyFindings, reported, notReported (results), notReportedList: [{ similarityId, severity, query,
 * results }], extra }. `extra`: findings the FAE scan reported that the project does not have at all.
 */
export function compareResults(original, fae) {
  const open = original.filter((r) => upper(r?.state || TO_VERIFY) === TO_VERIFY && upper(r?.status) !== 'FIXED' && keyOf(r));
  const theirs = new Set(fae.filter(reportedByFae).map(keyOf).filter(Boolean));
  const ours = new Set(original.map(keyOf).filter(Boolean));
  const findings = new Map();
  for (const r of open) {
    const key = keyOf(r);
    const f = findings.get(key);
    if (f) f.results += 1;
    else findings.set(key, { similarityId: key, severity: upper(r.severity) || 'MEDIUM', query: text(r.queryName, 120), results: 1 });
  }
  const notReportedList = [];
  let reported = 0;
  for (const f of findings.values()) {
    if (theirs.has(f.similarityId)) reported += f.results;
    else notReportedList.push(f);
  }
  const extra = [...theirs].filter((k) => !ours.has(k)).length;
  const notReported = notReportedList.reduce((n, f) => n + f.results, 0);
  return { toVerify: open.length, toVerifyFindings: findings.size, reported, notReported, notReportedList, extra, faeReported: theirs.size };
}
/** How many results a list of findings stands for (one each when not said). */
const resultsIn = (list) => (list ?? []).reduce((n, m) => n + (Number(m.results) || 1), 0);

/** Why a project stops and asks before marking (null when nothing looks off). */
export function exceptionOf(p, limits = LIMITS) {
  const c = p.counts ?? {};
  if (p.loc && p.faeLoc !== null && p.faeLoc !== undefined && Math.abs(p.faeLoc - p.loc) / p.loc > limits.locDrift) {
    return { code: 'loc', text: `The FAE scan counted ${p.faeLoc} lines of code against ${p.loc} in the project's latest scan: it may not be the same code.` };
  }
  if ((c.toVerify ?? 0) >= limits.minForShare && (c.notReported ?? 0) / c.toVerify > limits.markShare) {
    return { code: 'many', text: `It would mark ${c.notReported} of ${c.toVerify} results To verify (more than ${Math.round(limits.markShare * 100)}%).` };
  }
  if ((c.faeReported ?? 0) > 0 && (c.extra ?? 0) / c.faeReported > limits.extraShare) {
    return { code: 'extra', text: `The FAE scan reported ${c.extra} of its ${c.faeReported} results that the project does not have.` };
  }
  return null;
}

/**
 * Every project of the tenant, as FAE Flush would take it: its latest completed scan, whether SAST ran, its
 * code kept by Checkmarx One, its lines of code and results To verify (GET /api/scan-summary, 50 scans a call),
 * and how long its SAST scan took. Projects that cannot be flushed say why (`leftOut`).
 */
export async function previewTenant(client, { listProjects, getLastScans, concurrency = 4 }) {
  const projects = (await listProjects(client)).filter((p) => !String(p.name ?? '').endsWith(FAE_SUFFIX));
  const scans = await getLastScans(client, projects.map((p) => p.id));
  const rows = await mapWithConcurrency(projects, concurrency, async (p) => {
    const row = { id: p.id, name: text(p.name, 200), groups: Array.isArray(p.groups) ? p.groups : [], criticality: whole(p.criticality), sourceScanId: '', branch: '', loc: null, toVerify: null, sastSeconds: null, codeKept: false, repoUrl: '', commit: '', leftOut: '' };
    const last = scans[p.id];
    const scanId = text(last?.id ?? last?.scanId, 80);
    if (!scanId) return { ...row, leftOut: 'No completed scan.' };
    const scan = await client.request(`/api/scans/${encodeURIComponent(scanId)}`, { retries: 1, background: true }).catch(() => null);
    const sast = sastDone(scan);
    Object.assign(row, { sourceScanId: scanId, branch: text(scan?.branch ?? last?.branch, 200), loc: sastLoc(scan), ...gitOf(scan) });
    if (!sast || String(sast.status ?? '').toLowerCase() !== 'completed') return { ...row, leftOut: 'Its latest scan has no completed SAST scan (FAE is for SAST results).' };
    const took = Date.parse(sast.endDate) - Date.parse(sast.startDate);
    row.sastSeconds = Number.isFinite(took) && took > 0 ? Math.round(took / 1000) : null;
    // Is its code kept? (Checkmarx One's own "download source code" check.)
    row.codeKept = await client.request(`/api/repostore/scans/${encodeURIComponent(scanId)}`, { method: 'HEAD', retries: 0, background: true }).then(() => true, () => false);
    // Without its code kept, only its repository can give the same code again.
    if (!row.codeKept && !row.repoUrl) return { ...row, leftOut: 'Checkmarx One does not keep the code of its latest scan.' };
    return row;
  });
  // Results To verify, from the scans' summaries.
  const ids = rows.filter((r) => !r.leftOut).map((r) => r.sourceScanId);
  for (let i = 0; i < ids.length; i += 50) {
    const body = await client.request('/api/scan-summary', { query: { 'scan-ids': ids.slice(i, i + 50) }, retries: 1, background: true }).catch(() => null);
    for (const s of Array.isArray(body?.scansSummaries) ? body.scansSummaries : []) {
      const row = rows.find((r) => r.sourceScanId === s.scanId);
      const n = (s.sastCounters?.stateCounters ?? []).find((c) => upper(c.state) === TO_VERIFY)?.counter;
      if (row) row.toVerify = whole(n) ?? 0;
    }
  }
  const eligible = rows.filter((r) => !r.leftOut);
  return {
    readAt: new Date().toISOString(),
    projects: rows,
    eligible: eligible.length,
    leftOut: rows.length - eligible.length,
    toVerify: eligible.reduce((n, r) => n + (r.toVerify ?? 0), 0),
    sastSeconds: eligible.reduce((n, r) => n + (r.sastSeconds ?? 0), 0),
  };
}

/** The run's figures: how many projects at each step, and the results To verify, reported, marked and revalidated. */
export function summaryOf(job) {
  const steps = Object.fromEntries(STEPS.map((s) => [s, 0]));
  const totals = { toVerify: 0, toVerifyFindings: 0, reported: 0, notReported: 0, notReportedFindings: 0, marked: 0, markedFindings: 0, revalidated: 0, undone: 0 };
  for (const p of job?.projects ?? []) {
    steps[p.step] = (steps[p.step] ?? 0) + 1;
    for (const k of Object.keys(totals)) totals[k] += p.counts?.[k] ?? 0;
  }
  const finished = (job?.projects ?? []).filter((p) => FINISHED.has(p.step)).length;
  const kept = [...(job?.projects ?? []), ...(job?.earlier ?? [])].filter((p) => p.faeProjectId && !p.faeDeleted).length;
  return { steps, totals, finished, projects: job?.projects?.length ?? 0, faeKept: kept };
}

/** A run's options, made safe: where the code comes from, mark or report only, and how readily it stops to ask. */
export function cleanOptions(o = {}) {
  return {
    source: SOURCES.includes(o.source) ? o.source : 'auto',
    mode: MODES.includes(o.mode) ? o.mode : 'mark',
    markAs: o.markAs === 'ne' ? 'ne' : 'pne',
    sensitivity: o.sensitivity in SENSITIVITY ? o.sensitivity : 'normal',
  };
}

/**
 * Runs a FAE Flush: `clientOf()` gives the tenant's Checkmarx One client (null while there is none), `record`
 * notes what happened (the audit log), `history` keeps every result marked, `tmpDir` holds a project's code
 * between download and upload (only when Checkmarx One's own copy cannot be used in place).
 */
export class FaeFlushRunner {
  constructor({ store, clientOf, record = () => {}, history = null, tmpDir = os.tmpdir(), limits = LIMITS, now = () => Date.now() }) {
    Object.assign(this, { store, clientOf, record, history, tmpDir, limits, now });
    this.busy = new Set();
  }

  get job() {
    return this.store.job;
  }

  get debug() {
    return (this.store.debug ??= { on: false, log: [] });
  }

  /** When a project stops and asks, for this run (its sensitivity), else the runner's own. */
  get limitsNow() {
    const chosen = this.job?.options?.sensitivity;
    return chosen && chosen !== 'normal' ? SENSITIVITY[chosen] : this.limits;
  }

  // ---- Debugging -----------------------------------------------------------------------------------------------

  setDebug(on) {
    this.debug.on = Boolean(on);
    return this.debug;
  }

  clearDebug() {
    this.debug.log = [];
    return this.debug;
  }

  /** One line of the debug log (signatures hidden), while debug is on. */
  note(entry, p = null) {
    if (!this.debug.on) return;
    this.debug.log.push(redact({ at: new Date(this.now()).toISOString(), project: p?.name ?? '', step: p?.step ?? '', ...entry }));
    if (this.debug.log.length > DEBUG_MAX) this.debug.log.splice(0, this.debug.log.length - DEBUG_MAX);
  }

  /** The client, every call of it logged for `p` while debug is on. */
  via(client, p = null) {
    const trace = (entry) => this.note(entry, p);
    const timed = async (method, target, run, said) => {
      const started = Date.now();
      try {
        const out = await run();
        this.note({ method, url: target, ok: true, ms: Date.now() - started, answer: said(out) }, p);
        return out;
      } catch (error) {
        this.note({ method, url: target, ok: false, status: error.status ?? null, ms: Date.now() - started, error: text(error.message, 500), answer: text(error.body, 500) }, p);
        throw error;
      }
    };
    return {
      baseUrl: client.baseUrl,
      request: (target, opts = {}) => client.request(target, { ...opts, trace: this.debug.on ? trace : opts.trace }),
      download: (target, file) => timed('GET', target, () => client.download(target, file), (bytes) => ({ bytes })),
      uploadFile: (url, file) => timed('PUT', url, () => client.uploadFile(url, file), (bytes) => ({ bytes })),
      redirectOf: (target) => timed('GET (redirect)', target, () => client.redirectOf(target), (r) => r),
      probeUrl: (url) => timed('GET (first byte)', url, () => client.probeUrl(url), (r) => r),
    };
  }

  /** What a project went through: each step tried, which way the code came, and what went wrong. */
  attempt(p, what, ok, detail = '') {
    (p.attempts ??= []).push({ at: new Date(this.now()).toISOString(), what, ok, detail: text(detail, 300) });
    if (p.attempts.length > 30) p.attempts.splice(0, p.attempts.length - 30);
  }

  // ---- The run -------------------------------------------------------------------------------------------------

  /** Start a run for the projects of the last preview that can be flushed. */
  start({ by, concurrency = 4, deleteFae, preview, options = {} }) {
    if (this.job && !['done', 'stopped'].includes(this.job.state)) throw Object.assign(new Error('A FAE Flush is already under way: pause or finish it first.'), { status: 409 });
    if (typeof deleteFae !== 'boolean') throw Object.assign(new Error('Say whether to delete or keep the _FAE projects once each is checked.'), { status: 400 });
    if (!preview?.projects?.length) throw Object.assign(new Error('Check the projects first.'), { status: 409 });
    const at = new Date(this.now()).toISOString();
    // _FAE projects an earlier run kept: still listed, so "Delete all _FAE projects" finds them.
    const earlier = [...(this.job?.earlier ?? []), ...(this.job?.projects ?? []).filter((p) => p.faeProjectId && !p.faeDeleted).map((p) => ({ name: p.name, faeProjectId: p.faeProjectId, faeDeleted: false }))].filter((p) => !p.faeDeleted);
    this.store.job = {
      earlier,
      id: randomUUID(),
      startedAt: at,
      startedBy: text(by, 254),
      concurrency: Math.min(20, Math.max(1, whole(concurrency) ?? 4)),
      deleteFae,
      options: cleanOptions(options),
      state: 'running',
      finishedAt: null,
      projects: preview.projects.map((p) => ({
        id: p.id, name: p.name, groups: p.groups ?? [], criticality: p.criticality ?? null, sourceScanId: p.sourceScanId, branch: p.branch, loc: p.loc,
        codeKept: p.codeKept !== false, repoUrl: p.repoUrl ?? '', commit: p.commit ?? '',
        step: p.leftOut ? 'left-out' : 'waiting', note: p.leftOut || '', faeProjectId: '', faeScanId: '', faeLoc: null, faeDeleted: false,
        codeSource: '', failedSources: [], attempts: [], counts: { toVerify: p.toVerify ?? null }, marked: [], exception: null, updatedAt: at,
      })),
    };
    this.store.save();
    this.record('started', { projects: this.job.projects.filter((p) => p.step === 'waiting').length, deleteFae, concurrency: this.job.concurrency, ...this.job.options });
    return this.job;
  }

  setState(state) {
    if (!this.job) return null;
    if (state === 'paused' && this.job.state === 'running') this.job.state = 'paused';
    else if (state === 'running' && this.job.state === 'paused') this.job.state = 'running';
    this.store.save();
    return this.job;
  }

  /** A report-only run's projects, marked now: every one compared, as a run that marks would have. */
  markReported(by) {
    const ready = (this.job?.projects ?? []).filter((p) => p.step === 'reported');
    if (!ready.length) throw Object.assign(new Error('Nothing waits to be marked.'), { status: 409 });
    this.job.options = { ...cleanOptions(this.job.options), mode: 'mark' };
    for (const p of ready) this.move(p, 'marking');
    Object.assign(this.job, { state: 'running', finishedAt: null });
    this.record('mark-now', { projects: ready.length, results: ready.reduce((n, p) => n + (p.counts?.notReported ?? 0), 0), by });
    this.store.save();
    return ready.length;
  }

  /** A person's answer to a project that stopped to ask: 'mark', 'skip' or 'retry'. */
  decide(projectId, decision, by) {
    const p = this.job?.projects.find((x) => x.id === projectId);
    if (!p || p.step !== 'needs-ok') throw Object.assign(new Error('That project is not waiting for an answer.'), { status: 409 });
    const code = p.exception?.code;
    if (decision === 'mark') {
      // "Mark anyway" once compared; "Accept" after a revalidation that did not match. Never without an FAE scan's results.
      if (code === 'scan' || code === 'error' || !p.pending) throw Object.assign(new Error('Nothing to mark: retry or skip it.'), { status: 409 });
      this.move(p, code === 'revalidation' ? (this.job.deleteFae ? 'cleaning' : 'done') : this.job.options?.mode === 'report' ? 'reported' : 'marking');
    } else if (decision === 'retry') {
      if (code === 'scan' || code === 'copy') p.failedSources = [];
      this.move(p, p.faeScanId && code !== 'scan' ? 'comparing' : 'waiting');
    } else if (decision === 'skip') this.move(p, this.job.deleteFae && p.faeProjectId && code !== 'scan' ? 'cleaning' : 'skipped', `Skipped by ${text(by, 254)}`);
    else throw Object.assign(new Error('Mark, skip or retry.'), { status: 400 });
    this.attempt(p, `answered: ${decision}`, true, by);
    this.record('decided', { project: p.name, decision, reason: p.exception?.text ?? '', by });
    p.exception = decision === 'retry' ? null : p.exception;
    this.store.save();
    return p;
  }

  move(p, step, note = '') {
    p.step = step;
    if (note) p.note = note;
    p.updatedAt = new Date(this.now()).toISOString();
  }

  /** One turn: start what has room, advance what is at work. Never more than one step of a project at a time. */
  async tick() {
    const job = this.job;
    if (!job || job.state !== 'running') return;
    const client = this.clientOf();
    if (!client) return;
    const scanning = job.projects.filter((p) => SCANNING.has(p.step)).length;
    let room = job.concurrency - scanning;
    const turn = [];
    for (const p of job.projects) {
      if (this.busy.has(p.id)) continue;
      if (p.step === 'waiting') {
        if (room <= 0) continue;
        room -= 1;
        turn.push(p);
      } else if (WORKING.has(p.step)) turn.push(p);
    }
    await mapWithConcurrency(turn, Math.max(2, job.concurrency), (p) => this.advance(client, p));
    if (job.projects.every((p) => FINISHED.has(p.step))) {
      job.state = 'done';
      job.finishedAt = new Date(this.now()).toISOString();
      const s = summaryOf(job);
      this.record('finished', { projects: s.projects, marked: s.totals.marked, revalidated: s.totals.revalidated, toVerify: s.totals.toVerify, reportOnly: s.steps.reported, state: STATE_NAME[markState(this.job)] });
    }
    this.store.save();
  }

  async advance(client, p) {
    this.busy.add(p.id);
    const traced = this.via(client, p);
    try {
      if (p.step === 'waiting' || p.step === 'copying') await this.copy(traced, p);
      else if (p.step === 'scanning') await this.poll(traced, p);
      else if (p.step === 'comparing') await this.compare(traced, p);
      else if (p.step === 'marking') await this.mark(traced, p);
      else if (p.step === 'revalidating') await this.revalidate(traced, p);
      else if (p.step === 'cleaning') await this.clean(traced, p);
    } catch (error) {
      p.exception = { code: error.code === 'copy' ? 'copy' : 'error', text: `${p.step}: ${text(error?.message, 400)}`, at: new Date(this.now()).toISOString() };
      this.attempt(p, p.step, false, error?.message);
      this.move(p, 'needs-ok');
    } finally {
      this.busy.delete(p.id);
      this.store.save();
    }
  }

  /** The ways to get the project's code to try, in turn: as chosen, else Checkmarx One's own copy, download, the repository. */
  sourcesFor(p) {
    const chosen = this.job.options?.source ?? 'auto';
    if (chosen !== 'auto') return [chosen];
    // Automatic: downloaded and uploaded again, else the repository. Checkmarx One's own copy in place only when chosen:
    // its scanner fetches the signed address without an access token, which some tenants' gateway refuses.
    return ['upload', 'git'].filter((s) => !(p.failedSources ?? []).includes(s) && (s === 'git' ? Boolean(p.repoUrl) : p.codeKept !== false));
  }

  /** Steps 1 and 2: the code of its latest scan, on a new project "<name>_FAE", scanned with Findings Analysis on. */
  async copy(client, p) {
    this.move(p, 'copying');
    this.store.save();
    if (!p.faeProjectId) await this.makeFaeProject(client, p);
    const tried = [];
    for (const source of this.sourcesFor(p)) {
      try {
        p.faeScanId = await this.startScan(client, p, source);
        p.codeSource = source;
        p.scanStartedAt = new Date(this.now()).toISOString();
        this.attempt(p, `code: ${SOURCE_LABEL[source]}`, true, `scan ${p.faeScanId}`);
        this.move(p, 'scanning');
        this.record('scan-started', { project: p.name, faeProject: `${p.name}${FAE_SUFFIX}`, scanId: p.faeScanId, code: SOURCE_LABEL[source] });
        return;
      } catch (error) {
        tried.push(`${SOURCE_LABEL[source]}: ${text(error.message, 200)}`);
        this.attempt(p, `code: ${SOURCE_LABEL[source]}`, false, error.message);
        (p.failedSources ??= []).push(source);
      }
    }
    throw Object.assign(new Error(tried.length ? `The code could not be scanned again. ${tried.join(' · ')}` : 'No way to get its code: Checkmarx One does not keep it, and its repository is not known.'), { code: 'copy' });
  }

  async makeFaeProject(client, p) {
    const created = await client.request('/api/projects', { method: 'POST', body: { name: `${p.name}${FAE_SUFFIX}`, groups: p.groups, ...(p.criticality ? { criticality: p.criticality } : {}), tags: { [FAE_TAG]: this.job.id } }, retries: 1 });
    p.faeProjectId = text(created?.id, 80);
    if (!p.faeProjectId) throw new Error('Checkmarx One did not give the new project an id.');
    // The project's own SAST settings, and Findings Analysis on.
    const settings = await client.request('/api/configuration/project', { query: { 'project-id': p.id }, retries: 1, background: true }).catch(() => []);
    const own = (Array.isArray(settings) ? settings : []).filter((e) => String(e?.originLevel ?? '').toLowerCase() === 'project' && /^scan\.config\.sast\./.test(String(e?.key ?? '')) && e.key !== 'scan.config.sast.findingsAnalysis');
    await client.request('/api/configuration/project', { method: 'PATCH', query: { 'project-id': p.faeProjectId }, body: [...own.map((e) => ({ key: e.key, value: String(e.value ?? '') })), { key: 'scan.config.sast.findingsAnalysis', value: 'true' }], retries: 1 });
    this.attempt(p, 'project made', true, `${p.name}${FAE_SUFFIX} (${own.length} SAST setting(s) copied)`);
  }

  /** The FAE scan, from the code as `source` gives it. */
  async startScan(client, p, source) {
    const scan = (handler, type) => client.request('/api/scans', {
      method: 'POST',
      body: { type, handler: { branch: p.branch || 'main', ...handler }, project: { id: p.faeProjectId }, config: [{ type: 'sast', value: { incremental: 'false', findingsAnalysis: 'true' } }], tags: { [FAE_TAG]: this.job.id } },
      retries: 0,
    }).then((s) => text(s?.id, 80) || Promise.reject(new Error('Checkmarx One did not start the scan.')));
    if (source === 'link') {
      // Checkmarx One's own copy, where it is: the signed address its "download source code" redirects to.
      const { location, status } = await client.redirectOf(`/api/repostore/code/${encodeURIComponent(p.sourceScanId)}`);
      if (!location) throw new Error(`Checkmarx One answered ${status} without a signed address.`);
      return scan({ uploadUrl: location }, 'upload');
    }
    if (source === 'upload') {
      fs.mkdirSync(this.tmpDir, { recursive: true });
      const file = path.join(this.tmpDir, `fae-${p.id.replace(/[^\w-]/g, '')}-${randomUUID()}.zip`);
      try {
        await client.download(`/api/repostore/code/${encodeURIComponent(p.sourceScanId)}`, file);
        const upload = await client.request('/api/uploads', { method: 'POST', retries: 1 });
        const url = text(upload?.url, 4000);
        if (!url) throw new Error('Checkmarx One did not give an upload address.');
        await client.uploadFile(url, file);
        return await scan({ uploadUrl: url }, 'upload');
      } finally {
        fs.rm(file, { force: true }, () => {});
      }
    }
    if (source === 'git') {
      if (!p.repoUrl) throw new Error('Its repository is not known.');
      return scan({ repoUrl: p.repoUrl, ...(p.commit ? { commitId: p.commit } : {}) }, 'git');
    }
    throw new Error(`Unknown source ${source}.`);
  }

  async poll(client, p) {
    const scan = await client.request(`/api/scans/${encodeURIComponent(p.faeScanId)}`, { retries: 1, background: true });
    const status = String(scan?.status ?? '').toLowerCase();
    if (status === 'completed') {
      p.faeLoc = sastLoc(scan);
      this.attempt(p, 'scan completed', true, `${p.faeLoc ?? '?'} LOC`);
      this.move(p, 'comparing');
    } else if (['failed', 'canceled', 'partial'].includes(status)) {
      const detail = text((Array.isArray(scan?.statusDetails) ? scan.statusDetails : []).find((d) => d?.details)?.details, 200);
      this.attempt(p, `scan ${status} (${SOURCE_LABEL[p.codeSource] ?? 'code'})`, false, detail);
      // Automatic: a scan that failed with one way of getting the code tries the next.
      if ((this.job.options?.source ?? 'auto') === 'auto' && status === 'failed' && p.codeSource) {
        (p.failedSources ??= []).push(p.codeSource);
        if (this.sourcesFor(p).length) {
          p.faeScanId = '';
          this.move(p, 'waiting');
          return;
        }
      }
      const how = { failed: 'failed', canceled: 'was canceled', partial: 'only partly completed' }[status];
      p.exception = { code: 'scan', text: `The FAE scan ${how}. Nothing was marked.`, detail, at: new Date(this.now()).toISOString() };
      this.move(p, 'needs-ok');
    } else if (this.now() - Date.parse(p.scanStartedAt ?? 0) > this.limitsNow.scanHours * 3600_000) {
      p.exception = { code: 'scan', text: `The FAE scan has been running for more than ${this.limitsNow.scanHours} hours. Nothing was marked.`, at: new Date(this.now()).toISOString() };
      this.move(p, 'needs-ok');
    }
  }

  /** Step 3, then stop and ask when something looks off; a report-only run stops there. */
  async compare(client, p) {
    const [original, fae] = await Promise.all([scanResults(client, p.sourceScanId), scanResults(client, p.faeScanId)]);
    const c = compareResults(original, fae);
    p.counts = { ...p.counts, toVerify: c.toVerify, toVerifyFindings: c.toVerifyFindings, reported: c.reported, notReported: c.notReported, notReportedFindings: c.notReportedList.length, extra: c.extra, faeReported: c.faeReported, marked: p.counts?.marked ?? 0 };
    p.pending = c.notReportedList;
    this.attempt(p, 'compared', true, `${c.toVerify} results To verify (${c.toVerifyFindings} findings) · ${c.reported} still reported · ${c.notReported} not (${c.notReportedList.length} findings)`);
    const exception = exceptionOf(p, this.limitsNow);
    if (exception) {
      p.exception = { ...exception, at: new Date(this.now()).toISOString() };
      this.move(p, 'needs-ok');
      this.record('needs-ok', { project: p.name, reason: exception.text });
    } else this.move(p, this.job.options?.mode === 'report' ? 'reported' : 'marking');
  }

  /**
   * Step 4: Proposed not exploitable (or Not exploitable, as the run was started), with a comment naming the FAE
   * scan; only what is still To verify. One mark per similarity id covers every result sharing it.
   */
  async mark(client, p) {
    const pending = p.pending ?? [];
    const state = markState(this.job);
    const done = new Set(p.marked.map((m) => m.similarityId));
    const todo = pending.filter((m) => !done.has(m.similarityId));
    const comment = `FAE Flush: not reported when the same code was scanned again with Findings Analysis (project ${p.name}${FAE_SUFFIX}, scan ${p.faeScanId}).`;
    for (let i = 0; i < todo.length; i += PREDICATES_AT_ONCE) {
      const batch = todo.slice(i, i + PREDICATES_AT_ONCE);
      await client.request('/api/sast-results-predicates', { method: 'POST', body: batch.map((m) => ({ similarityId: m.similarityId, projectId: p.id, severity: m.severity, state, comment })), retries: 2 });
      p.marked.push(...batch.map((m) => ({ similarityId: m.similarityId, severity: m.severity, query: m.query ?? '', results: Number(m.results) || 1 })));
      p.counts.marked = resultsIn(p.marked);
      p.counts.markedFindings = p.marked.length;
      this.store.save();
    }
    // Kept after the run: the value it brought.
    this.history?.put({ runId: this.job.id, at: new Date(this.now()).toISOString(), by: this.job.startedBy, projectId: p.id, project: p.name, faeScanId: p.faeScanId, state, toVerify: p.counts.toVerify ?? 0, toVerifyFindings: p.counts.toVerifyFindings ?? 0, items: p.marked.map((m) => [m.similarityId, m.severity, m.query ?? '', m.results ?? 1]), revalidated: 0, undone: 0 });
    this.attempt(p, 'marked', true, `${p.counts.marked} ${STATE_NAME[state]} (${p.marked.length} findings)`);
    this.record('marked', { project: p.name, marked: p.counts.marked, findings: p.marked.length, toVerify: p.counts.toVerify, faeScanId: p.faeScanId, state: STATE_NAME[state] });
    this.move(p, 'revalidating');
  }

  /** Step 5: read both again. Every one marked is marked, and the FAE scan still does not report it. */
  async revalidate(client, p) {
    const [original, fae] = await Promise.all([scanResults(client, p.sourceScanId), scanResults(client, p.faeScanId)]);
    const state = new Map(original.map((r) => [keyOf(r), upper(r.state)]));
    const theirs = new Set(fae.filter(reportedByFae).map(keyOf));
    // As marked; or, marked Proposed, since confirmed Not exploitable by a person.
    const wanted = markState(this.job);
    const asMarked = (s) => s === wanted || (wanted === PNE && s === NE);
    const ok = resultsIn(p.marked.filter((m) => asMarked(state.get(m.similarityId)) && !theirs.has(m.similarityId)));
    const all = resultsIn(p.marked);
    p.counts.revalidated = ok;
    if (this.history?.find(this.job.id, p.id)) this.history.put({ runId: this.job.id, projectId: p.id, revalidated: ok });
    this.attempt(p, 'revalidated', ok === all, `${ok} of ${all}`);
    if (ok < all) {
      p.exception = { code: 'revalidation', text: `Revalidation: ${all - ok} of ${all} results marked are not as expected (changed since, or reported after all).`, at: new Date(this.now()).toISOString() };
      this.move(p, 'needs-ok');
      return;
    }
    delete p.pending;
    this.move(p, this.job.deleteFae ? 'cleaning' : 'done');
  }

  /** Step 6: the copy project removed. */
  async clean(client, p) {
    if (p.faeProjectId && !p.faeDeleted) {
      await client.request(`/api/projects/${encodeURIComponent(p.faeProjectId)}`, { method: 'DELETE', retries: 1 }).catch((error) => (error.status === 404 ? null : Promise.reject(error)));
      p.faeDeleted = true;
      this.attempt(p, 'copy removed', true, `${p.name}${FAE_SUFFIX}`);
      this.record('fae-deleted', { project: p.name, faeProjectId: p.faeProjectId });
    }
    this.move(p, p.note?.startsWith('Skipped') ? 'skipped' : 'done');
  }

  /** Delete every _FAE project of the run still there (one click, any time after); not those a report still needs. */
  async deleteAll() {
    if (!this.clientOf()) throw Object.assign(new Error('No Checkmarx One connection on the server.'), { status: 409 });
    const client = this.via(this.clientOf());
    const left = [...(this.job?.projects ?? []), ...(this.job?.earlier ?? [])].filter((p) => p.faeProjectId && !p.faeDeleted && !WORKING.has(p.step) && p.step !== 'reported');
    let deleted = 0;
    const failed = [];
    await mapWithConcurrency(left, 4, async (p) => {
      try {
        await client.request(`/api/projects/${encodeURIComponent(p.faeProjectId)}`, { method: 'DELETE', retries: 1 }).catch((error) => (error.status === 404 ? null : Promise.reject(error)));
        p.faeDeleted = true;
        deleted += 1;
      } catch (error) {
        failed.push({ project: p.name, error: text(error.message, 200) });
      }
    });
    this.store.save();
    this.record('fae-deleted-all', { deleted, failed: failed.length });
    return { deleted, failed };
  }

  /** Undo: every result the run marked, back to To verify, but only those still as it left them. */
  async undo(by) {
    if (!this.clientOf()) throw Object.assign(new Error('No Checkmarx One connection on the server.'), { status: 409 });
    const client = this.via(this.clientOf());
    if (this.job?.projects.some((p) => WORKING.has(p.step))) this.job.state = 'paused';
    let restored = 0;
    let changed = 0;
    for (const p of this.job?.projects ?? []) {
      if (!p.marked?.length) continue;
      const current = new Map((await scanResults(client, p.sourceScanId)).map((r) => [keyOf(r), upper(r.state)]));
      const back = p.marked.filter((m) => current.get(m.similarityId) === markState(this.job));
      changed += resultsIn(p.marked) - resultsIn(back);
      for (let i = 0; i < back.length; i += PREDICATES_AT_ONCE) {
        await client.request('/api/sast-results-predicates', { method: 'POST', body: back.slice(i, i + PREDICATES_AT_ONCE).map((m) => ({ similarityId: m.similarityId, projectId: p.id, severity: m.severity, state: TO_VERIFY, comment: `FAE Flush undone by ${text(by, 254)}.` })), retries: 2 });
      }
      const backResults = resultsIn(back);
      restored += backResults;
      const bySeverity = {};
      for (const m of back) bySeverity[m.severity] = (bySeverity[m.severity] ?? 0) + (Number(m.results) || 1);
      if (this.history?.find(this.job.id, p.id)) this.history.put({ runId: this.job.id, projectId: p.id, undone: backResults, undoneFindings: back.length, undoneBySeverity: bySeverity, undoneAt: new Date(this.now()).toISOString() });
      p.counts.undone = backResults;
      p.marked = [];
      p.counts.marked = 0;
      p.counts.markedFindings = 0;
      this.attempt(p, 'undone', true, `${backResults} back to To verify`);
      this.move(p, 'undone');
      this.store.save();
    }
    this.record('undone', { restored, changedSince: changed, by });
    return { restored, changedSince: changed };
  }
}

/**
 * Test one project, read-only: every step FAE Flush would take, and what Checkmarx One answered. Nothing is made
 * or changed. Returns { project, checks: [{ check, ok (true, false, or null: not known), detail }] }.
 */
export async function testProject(client, projectId, { getLastScans }) {
  const checks = [];
  const add = (check, ok, detail = '') => checks.push({ check, ok, detail: text(detail, 400) });
  const last = (await getLastScans(client, [projectId]).catch(() => ({})))[projectId];
  const scanId = text(last?.id ?? last?.scanId, 80);
  if (!scanId) {
    add('Latest completed scan', false, 'None');
    return { projectId, checks };
  }
  const scan = await client.request(`/api/scans/${encodeURIComponent(scanId)}`, { retries: 0 }).catch((error) => (add('Latest completed scan', false, error.message), null));
  if (!scan) return { projectId, checks };
  const sast = sastDone(scan);
  add('Latest completed scan', true, `${scanId} · ${text(scan.status, 30)} · branch ${text(scan.branch, 100) || '—'}`);
  add('SAST in it', String(sast?.status ?? '').toLowerCase() === 'completed', sast ? `${text(sast.status, 30)} · ${sastLoc(scan) ?? '?'} lines of code` : 'No SAST scan');
  const kept = await client.request(`/api/repostore/scans/${encodeURIComponent(scanId)}`, { method: 'HEAD', retries: 0 }).then(() => true, (error) => (add('Code kept by Checkmarx One', false, `${error.status ?? ''} ${error.message}`), false));
  if (kept) add('Code kept by Checkmarx One', true, 'HEAD /api/repostore/scans/… answered');
  const link = await client.redirectOf(`/api/repostore/code/${encodeURIComponent(scanId)}`).catch((error) => (add('Its own copy, in place (signed address)', false, `${error.status ?? ''} ${error.message}`), null));
  if (link) {
    const where = link.location ? new URL(link.location) : null;
    const expires = where ? Number(where.searchParams.get('X-Amz-Expires')) : NaN;
    add('Its own copy, in place (signed address)', Boolean(where), where ? `${link.status} → ${where.host === new URL(client.baseUrl ?? where.href).host ? 'same host' : where.host} ${where.pathname.split('/').slice(0, 4).join('/')}/…${Number.isFinite(expires) ? ` · valid ${expires} s` : ''}` : `${link.status}, no address`);
    if (where) {
      const probe = await client.probeUrl(link.location).catch((error) => (add('The signed address answers', false, error.message), null));
      if (probe) add('The signed address answers', probe.status < 400, `${probe.tried} · ${probe.type || '?'}${probe.size !== null ? ` · ${probe.size} bytes` : ''} (first byte only)`);
    }
  }
  const git = gitOf(scan);
  add('Its repository and commit', git.repoUrl ? true : null, git.repoUrl ? `${git.repoUrl} · ${text(scan.branch, 100) || '—'} · ${git.commit || 'no commit said'}` : 'Not a repository scan (or it does not say)');
  const settings = await client.request('/api/configuration/project', { query: { 'project-id': projectId }, retries: 0 }).catch(() => null);
  const own = (Array.isArray(settings) ? settings : []).filter((e) => String(e?.originLevel ?? '').toLowerCase() === 'project' && /^scan\.config\.sast\./.test(String(e?.key ?? '')));
  add('Its own SAST settings, to copy', settings ? true : null, settings ? `${own.length}: ${own.map((e) => e.key.replace('scan.config.sast.', '')).join(', ') || 'none (it uses the tenant’s)'}` : 'Not read');
  const fae = (Array.isArray(settings) ? settings : []).find((e) => e?.key === 'scan.config.sast.findingsAnalysis');
  add('The Findings Analysis setting', fae ? true : null, fae ? `scan.config.sast.findingsAnalysis = ${text(fae.value, 20) || '—'} (${text(fae.originLevel, 20) || '?'})` : 'Not listed for this project: its name may differ on this tenant');
  const summary = await client.request('/api/scan-summary', { query: { 'scan-ids': [scanId] }, retries: 0 }).catch(() => null);
  const toVerify = (summary?.scansSummaries?.[0]?.sastCounters?.stateCounters ?? []).find((c) => upper(c.state) === TO_VERIFY)?.counter;
  add('Results To verify', toVerify !== undefined ? true : null, toVerify !== undefined ? String(toVerify) : 'Not said');
  add('The API key may make and delete projects, start scans and change states', null, 'Not testable without doing it: the first run shows it');
  return { projectId, scanId, checks };
}
