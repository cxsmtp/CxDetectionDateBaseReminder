/**
 * FAE Flush (Labs, then Act): Findings Analysis (FAE) cuts noise only from results found after it was turned on;
 * the backlog stays. FAE Flush clears it once, for the whole tenant, and leaves every project as it is (its
 * history, triage, automations and integrations):
 *
 *   1. Copy the code: the exact code of the project's latest scan, as Checkmarx One keeps it
 *      (GET /api/repostore/code/{scanId}, a zip), uploaded again (POST /api/uploads, then PUT).
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
 * marked is kept, so the run can be undone (back to To verify, only those still as it left them).
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
export const TO_VERIFY = 'TO_VERIFY';
/** Where a project is: waiting, at work (copying … cleaning), stopped to ask, or finished one way or another. */
export const STEPS = ['waiting', 'copying', 'scanning', 'comparing', 'needs-ok', 'marking', 'revalidating', 'cleaning', 'done', 'skipped', 'left-out', 'undone'];
const WORKING = new Set(['copying', 'scanning', 'comparing', 'marking', 'revalidating', 'cleaning']);
const FINISHED = new Set(['done', 'skipped', 'left-out', 'undone']);
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
const PAGE = 500;
const PAGES = 40;
const PREDICATES_AT_ONCE = 100;

const text = (v, max = 300) => (v === null || v === undefined ? '' : String(v).slice(0, max));
const whole = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : null);
const upper = (v) => text(v, 60).trim().toUpperCase();
const sastLoc = (scan) => whole((Array.isArray(scan?.statusDetails) ? scan.statusDetails : []).find((d) => String(d?.name).toLowerCase() === 'sast')?.loc);
const sastDone = (scan) => (Array.isArray(scan?.statusDetails) ? scan.statusDetails : []).find((d) => String(d?.name).toLowerCase() === 'sast');

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
  }

  save() {
    if (!this.job) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.job));
    fs.renameSync(tmp, this.file);
  }
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
 * The project's open SAST results still To verify, against the FAE scan's results, by similarity id:
 * { toVerify, reported, notReported: [{ similarityId, severity, query }], extra }.
 * `extra`: results the FAE scan reported that the project does not have at all.
 */
export function compareResults(original, fae) {
  const open = original.filter((r) => upper(r?.state || TO_VERIFY) === TO_VERIFY && upper(r?.status) !== 'FIXED' && keyOf(r));
  const theirs = new Set(fae.filter(reportedByFae).map(keyOf).filter(Boolean));
  const ours = new Set(original.map(keyOf).filter(Boolean));
  const seen = new Set();
  const notReported = [];
  let reported = 0;
  for (const r of open) {
    const key = keyOf(r);
    if (seen.has(key)) continue;
    seen.add(key);
    if (theirs.has(key)) reported += 1;
    else notReported.push({ similarityId: key, severity: upper(r.severity) || 'MEDIUM', query: text(r.queryName, 120) });
  }
  const extra = [...theirs].filter((k) => !ours.has(k)).length;
  return { toVerify: seen.size, reported, notReported, extra, faeReported: theirs.size };
}

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
    const row = { id: p.id, name: text(p.name, 200), groups: Array.isArray(p.groups) ? p.groups : [], criticality: whole(p.criticality), sourceScanId: '', branch: '', loc: null, toVerify: null, sastSeconds: null, leftOut: '' };
    const last = scans[p.id];
    const scanId = text(last?.id ?? last?.scanId, 80);
    if (!scanId) return { ...row, leftOut: 'No completed scan.' };
    const scan = await client.request(`/api/scans/${encodeURIComponent(scanId)}`, { retries: 1, background: true }).catch(() => null);
    const sast = sastDone(scan);
    Object.assign(row, { sourceScanId: scanId, branch: text(scan?.branch ?? last?.branch, 200), loc: sastLoc(scan) });
    if (!sast || String(sast.status ?? '').toLowerCase() !== 'completed') return { ...row, leftOut: 'Its latest scan has no completed SAST scan (FAE is for SAST results).' };
    const took = Date.parse(sast.endDate) - Date.parse(sast.startDate);
    row.sastSeconds = Number.isFinite(took) && took > 0 ? Math.round(took / 1000) : null;
    // Is its code kept? (Checkmarx One's own "download source code" check.)
    const kept = await client.request(`/api/repostore/scans/${encodeURIComponent(scanId)}`, { method: 'HEAD', retries: 0, background: true }).then(() => true, () => false);
    if (!kept) return { ...row, leftOut: 'Checkmarx One does not keep the code of its latest scan.' };
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
  const totals = { toVerify: 0, reported: 0, notReported: 0, marked: 0, revalidated: 0, undone: 0 };
  for (const p of job?.projects ?? []) {
    steps[p.step] = (steps[p.step] ?? 0) + 1;
    for (const k of Object.keys(totals)) totals[k] += p.counts?.[k] ?? 0;
  }
  const finished = (job?.projects ?? []).filter((p) => FINISHED.has(p.step)).length;
  const kept = [...(job?.projects ?? []), ...(job?.earlier ?? [])].filter((p) => p.faeProjectId && !p.faeDeleted).length;
  return { steps, totals, finished, projects: job?.projects?.length ?? 0, faeKept: kept };
}

/**
 * Runs a FAE Flush: `clientOf()` gives the tenant's Checkmarx One client (null while there is none), `record`
 * notes what happened (the audit log), `tmpDir` holds a project's code between download and upload.
 */
export class FaeFlushRunner {
  constructor({ store, clientOf, record = () => {}, tmpDir = os.tmpdir(), limits = LIMITS, now = () => Date.now() }) {
    Object.assign(this, { store, clientOf, record, tmpDir, limits, now });
    this.busy = new Set();
  }

  get job() {
    return this.store.job;
  }

  /** Start a run for the projects of the last preview that can be flushed. */
  start({ by, concurrency = 4, deleteFae, preview }) {
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
      state: 'running',
      finishedAt: null,
      projects: preview.projects.map((p) => ({
        id: p.id, name: p.name, groups: p.groups ?? [], criticality: p.criticality ?? null, sourceScanId: p.sourceScanId, branch: p.branch, loc: p.loc,
        step: p.leftOut ? 'left-out' : 'waiting', note: p.leftOut || '', faeProjectId: '', faeScanId: '', faeLoc: null, faeDeleted: false,
        counts: { toVerify: p.toVerify ?? null }, marked: [], exception: null, updatedAt: at,
      })),
    };
    this.store.save();
    this.record('started', { projects: this.job.projects.filter((p) => p.step === 'waiting').length, deleteFae, concurrency: this.job.concurrency });
    return this.job;
  }

  setState(state) {
    if (!this.job) return null;
    if (state === 'paused' && this.job.state === 'running') this.job.state = 'paused';
    else if (state === 'running' && this.job.state === 'paused') this.job.state = 'running';
    this.store.save();
    return this.job;
  }

  /** A person's answer to a project that stopped to ask: 'mark', 'skip' or 'retry'. */
  decide(projectId, decision, by) {
    const p = this.job?.projects.find((x) => x.id === projectId);
    if (!p || p.step !== 'needs-ok') throw Object.assign(new Error('That project is not waiting for an answer.'), { status: 409 });
    const code = p.exception?.code;
    if (decision === 'mark') {
      // "Mark anyway" once compared; "Accept" after a revalidation that did not match. Never without an FAE scan's results.
      if (code === 'scan' || code === 'error' || !p.pending) throw Object.assign(new Error('Nothing to mark: retry or skip it.'), { status: 409 });
      this.move(p, code === 'revalidation' ? (this.job.deleteFae ? 'cleaning' : 'done') : 'marking');
    } else if (decision === 'retry') this.move(p, p.faeScanId && code !== 'scan' ? 'comparing' : 'waiting');
    else if (decision === 'skip') this.move(p, this.job.deleteFae && p.faeProjectId && code !== 'scan' ? 'cleaning' : 'skipped', `Skipped by ${text(by, 254)}`);
    else throw Object.assign(new Error('Mark, skip or retry.'), { status: 400 });
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
      this.record('finished', { projects: s.projects, marked: s.totals.marked, revalidated: s.totals.revalidated, toVerify: s.totals.toVerify });
    }
    this.store.save();
  }

  async advance(client, p) {
    this.busy.add(p.id);
    try {
      if (p.step === 'waiting') await this.copy(client, p);
      else if (p.step === 'copying') await this.copy(client, p);
      else if (p.step === 'scanning') await this.poll(client, p);
      else if (p.step === 'comparing') await this.compare(client, p);
      else if (p.step === 'marking') await this.mark(client, p);
      else if (p.step === 'revalidating') await this.revalidate(client, p);
      else if (p.step === 'cleaning') await this.clean(client, p);
    } catch (error) {
      p.exception = { code: 'error', text: `${p.step}: ${text(error?.message, 300)}`, at: new Date(this.now()).toISOString() };
      this.move(p, 'needs-ok');
    } finally {
      this.busy.delete(p.id);
      this.store.save();
    }
  }

  /** Steps 1 and 2: the code of its latest scan, on a new project "<name>_FAE", scanned with Findings Analysis on. */
  async copy(client, p) {
    this.move(p, 'copying');
    this.store.save();
    fs.mkdirSync(this.tmpDir, { recursive: true });
    const file = path.join(this.tmpDir, `fae-${p.id.replace(/[^\w-]/g, '')}-${randomUUID()}.zip`);
    try {
      await client.download(`/api/repostore/code/${encodeURIComponent(p.sourceScanId)}`, file);
      if (!p.faeProjectId) {
        const created = await client.request('/api/projects', { method: 'POST', body: { name: `${p.name}${FAE_SUFFIX}`, groups: p.groups, ...(p.criticality ? { criticality: p.criticality } : {}), tags: { [FAE_TAG]: this.job.id } }, retries: 1 });
        p.faeProjectId = text(created?.id, 80);
        if (!p.faeProjectId) throw new Error('Checkmarx One did not give the new project an id.');
        // The project's own SAST settings, and Findings Analysis on.
        const settings = await client.request('/api/configuration/project', { query: { 'project-id': p.id }, retries: 1, background: true }).catch(() => []);
        const own = (Array.isArray(settings) ? settings : []).filter((e) => String(e?.originLevel ?? '').toLowerCase() === 'project' && /^scan\.config\.sast\./.test(String(e?.key ?? '')) && e.key !== 'scan.config.sast.findingsAnalysis');
        await client.request('/api/configuration/project', { method: 'PATCH', query: { 'project-id': p.faeProjectId }, body: [...own.map((e) => ({ key: e.key, value: String(e.value ?? '') })), { key: 'scan.config.sast.findingsAnalysis', value: 'true' }], retries: 1 });
      }
      const upload = await client.request('/api/uploads', { method: 'POST', retries: 1 });
      const url = text(upload?.url, 4000);
      if (!url) throw new Error('Checkmarx One did not give an upload address.');
      await client.uploadFile(url, file);
      const scan = await client.request('/api/scans', {
        method: 'POST',
        body: { type: 'upload', handler: { uploadUrl: url, branch: p.branch || 'main' }, project: { id: p.faeProjectId }, config: [{ type: 'sast', value: { incremental: 'false', findingsAnalysis: 'true' } }], tags: { [FAE_TAG]: this.job.id } },
        retries: 1,
      });
      p.faeScanId = text(scan?.id, 80);
      if (!p.faeScanId) throw new Error('Checkmarx One did not start the scan.');
      p.scanStartedAt = new Date(this.now()).toISOString();
      this.move(p, 'scanning');
      this.record('scan-started', { project: p.name, faeProject: `${p.name}${FAE_SUFFIX}`, scanId: p.faeScanId });
    } finally {
      fs.rm(file, { force: true }, () => {});
    }
  }

  async poll(client, p) {
    const scan = await client.request(`/api/scans/${encodeURIComponent(p.faeScanId)}`, { retries: 1, background: true });
    const status = String(scan?.status ?? '').toLowerCase();
    if (status === 'completed') {
      p.faeLoc = sastLoc(scan);
      this.move(p, 'comparing');
    } else if (['failed', 'canceled', 'partial'].includes(status)) {
      p.exception = { code: 'scan', text: `The FAE scan ended ${status}${scan?.statusDetails?.find?.((d) => d?.details)?.details ? `: ${text(scan.statusDetails.find((d) => d?.details).details, 200)}` : ''}. Nothing was marked.`, at: new Date(this.now()).toISOString() };
      this.move(p, 'needs-ok');
    } else if (this.now() - Date.parse(p.scanStartedAt ?? 0) > this.limits.scanHours * 3600_000) {
      p.exception = { code: 'scan', text: `The FAE scan has been running for more than ${this.limits.scanHours} hours. Nothing was marked.`, at: new Date(this.now()).toISOString() };
      this.move(p, 'needs-ok');
    }
  }

  /** Step 3, then stop and ask when something looks off. */
  async compare(client, p) {
    const [original, fae] = await Promise.all([scanResults(client, p.sourceScanId), scanResults(client, p.faeScanId)]);
    const c = compareResults(original, fae);
    p.counts = { ...p.counts, toVerify: c.toVerify, reported: c.reported, notReported: c.notReported.length, extra: c.extra, faeReported: c.faeReported, marked: p.counts?.marked ?? 0 };
    p.pending = c.notReported;
    const exception = exceptionOf(p, this.limits);
    if (exception) {
      p.exception = { ...exception, at: new Date(this.now()).toISOString() };
      this.move(p, 'needs-ok');
      this.record('needs-ok', { project: p.name, reason: exception.text });
    } else this.move(p, 'marking');
  }

  /** Step 4: Proposed not exploitable, with a comment naming the FAE scan; only what is still To verify. */
  async mark(client, p) {
    const pending = p.pending ?? [];
    const done = new Set(p.marked.map((m) => m.similarityId));
    const todo = pending.filter((m) => !done.has(m.similarityId));
    const comment = `FAE Flush: not reported when the same code was scanned again with Findings Analysis (project ${p.name}${FAE_SUFFIX}, scan ${p.faeScanId}).`;
    for (let i = 0; i < todo.length; i += PREDICATES_AT_ONCE) {
      const batch = todo.slice(i, i + PREDICATES_AT_ONCE);
      await client.request('/api/sast-results-predicates', { method: 'POST', body: batch.map((m) => ({ similarityId: m.similarityId, projectId: p.id, severity: m.severity, state: PNE, comment })), retries: 2 });
      p.marked.push(...batch.map((m) => ({ similarityId: m.similarityId, severity: m.severity })));
      p.counts.marked = p.marked.length;
      this.store.save();
    }
    this.record('marked', { project: p.name, marked: p.marked.length, toVerify: p.counts.toVerify, faeScanId: p.faeScanId });
    this.move(p, 'revalidating');
  }

  /** Step 5: read both again. Every one marked is marked, and the FAE scan still does not report it. */
  async revalidate(client, p) {
    const [original, fae] = await Promise.all([scanResults(client, p.sourceScanId), scanResults(client, p.faeScanId)]);
    const state = new Map(original.map((r) => [keyOf(r), upper(r.state)]));
    const theirs = new Set(fae.filter(reportedByFae).map(keyOf));
    const ok = p.marked.filter((m) => state.get(m.similarityId) === PNE && !theirs.has(m.similarityId)).length;
    p.counts.revalidated = ok;
    if (ok < p.marked.length) {
      p.exception = { code: 'revalidation', text: `Revalidation: ${p.marked.length - ok} of ${p.marked.length} results marked are not as expected (changed since, or reported after all).`, at: new Date(this.now()).toISOString() };
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
      this.record('fae-deleted', { project: p.name, faeProjectId: p.faeProjectId });
    }
    this.move(p, p.note?.startsWith('Skipped') ? 'skipped' : 'done');
  }

  /** Delete every _FAE project of the run still there (one click, any time after). */
  async deleteAll() {
    const client = this.clientOf();
    if (!client) throw Object.assign(new Error('No Checkmarx One connection on the server.'), { status: 409 });
    const left = [...(this.job?.projects ?? []), ...(this.job?.earlier ?? [])].filter((p) => p.faeProjectId && !p.faeDeleted && !WORKING.has(p.step));
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
    const client = this.clientOf();
    if (!client) throw Object.assign(new Error('No Checkmarx One connection on the server.'), { status: 409 });
    if (this.job?.projects.some((p) => WORKING.has(p.step))) this.job.state = 'paused';
    let restored = 0;
    let changed = 0;
    for (const p of this.job?.projects ?? []) {
      if (!p.marked?.length) continue;
      const current = new Map((await scanResults(client, p.sourceScanId)).map((r) => [keyOf(r), upper(r.state)]));
      const back = p.marked.filter((m) => current.get(m.similarityId) === PNE);
      changed += p.marked.length - back.length;
      for (let i = 0; i < back.length; i += PREDICATES_AT_ONCE) {
        await client.request('/api/sast-results-predicates', { method: 'POST', body: back.slice(i, i + PREDICATES_AT_ONCE).map((m) => ({ similarityId: m.similarityId, projectId: p.id, severity: m.severity, state: TO_VERIFY, comment: `FAE Flush undone by ${text(by, 254)}.` })), retries: 2 });
      }
      restored += back.length;
      p.counts.undone = back.length;
      p.marked = [];
      p.counts.marked = 0;
      this.move(p, 'undone');
      this.store.save();
    }
    this.record('undone', { restored, changedSince: changed, by });
    return { restored, changedSince: changed };
  }
}
