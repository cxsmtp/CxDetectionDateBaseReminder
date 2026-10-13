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
import { getLastScans, lastScanDate, listApplications, listProjects } from './cxone/projects.js';
import { CRITICALITIES, DEFAULT_TR, FREQUENCIES, LOOKBACKS, aheadSettings, amount, cleanScope, creditSummary, frequencyOf, fusionSettings, totalsSettings, wholeNumber } from '../public/calculator/model.js';

export const MAX_PROFILES = 200;
/** One profile, saved: the two exports' weekly series fit well inside this. */
export const MAX_PROFILE_BYTES = 3 * 1024 * 1024;
export const MAX_REPORTS = 500;
export const MAX_REPORT_BYTES = 4 * 1024 * 1024;
const MAX_PROJECTS = 5000;
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info'];
const PLAN = ['Critical', 'High', 'Medium', 'Low'];
const FREQ_IDS = new Set(FREQUENCIES.map((f) => f.id));
const DAY = 86400000;

const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const finite = (value, fallback = null) => (value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback);
const isoDay = (value) => (/^\d{4}-\d{2}-\d{2}/.test(String(value ?? '')) ? String(value).slice(0, 10) : null);
const iso = (value) => (value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null);

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** One export's weekly series as the parser gives it, keeping only dates and numbers. */
function series(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.weeks)) return null;
  const weeks = value.weeks.slice(0, 2000).map((w) => isoDay(w) ?? '');
  const bySeverity = {};
  for (const s of SEVERITIES) {
    const list = Array.isArray(value.bySeverity?.[s]) ? value.bySeverity[s] : [];
    bySeverity[s] = weeks.map((_, i) => Math.max(0, finite(list[i], 0)));
  }
  const meta = value.meta && typeof value.meta === 'object' ? value.meta : {};
  return {
    weeks,
    bySeverity,
    meta: {
      source: meta.source === 'cxone' ? 'cxone' : 'upload',
      fileName: text(meta.fileName, 200),
      sheet: text(meta.sheet, 200),
      layout: text(meta.layout, 20),
      exportedAt: meta.exportedAt ? text(meta.exportedAt, 40) : null,
      readAt: iso(meta.readAt),
      projects: wholeNumber(meta.projects),
      scans: wholeNumber(meta.scans),
      // Read from Checkmarx One: the engines counted ([] = every engine), and whether the read could tell them apart.
      engines: cleanEngines(meta.engines),
      engineSplit: meta.engineSplit !== false,
    },
  };
}

const perSeverity = (value, fallback, lo, hi) => Object.fromEntries(PLAN.map((s) => [s, Math.min(hi, Math.max(lo, finite(value?.[s], fallback[s])))]));
/** How many of each severity to triage: a number, or null for every open one (the default). */
const chosen = (value) => Object.fromEntries(PLAN.map((s) => [s, value?.[s] === null || value?.[s] === undefined || value?.[s] === '' ? null : Math.min(1e9, Math.max(0, finite(value[s], 0)))]));

/** The triage & remediation projection: the backlog read, the plan per severity, and what is still to come. */
export function cleanTr(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    totals: series(v.totals),
    fixed: series(v.fixed),
    selected: chosen(v.selected),
    triageCost: perSeverity(v.triageCost, DEFAULT_TR.triageCost, 0, 1000),
    fpPercent: perSeverity(v.fpPercent, DEFAULT_TR.fpPercent, 0, 100),
    remediationCost: perSeverity(v.remediationCost, DEFAULT_TR.remediationCost, 0, 1000),
    lookbackMonths: LOOKBACKS.includes(Number(v.lookbackMonths)) ? Number(v.lookbackMonths) : DEFAULT_TR.lookbackMonths,
    // The engines whose findings are projected: SAST and SCA (what AI Triage and Remediation act on) unless more are ticked.
    engines: cleanEngines(v.engines).length ? cleanEngines(v.engines) : [...DEFAULT_ENGINES],
    ...aheadSettings(v),
  };
}

/** The Fusion projection: its settings, and the projects with what Checkmarx One said of them. */
export function cleanFusion(value) {
  const v = value && typeof value === 'object' ? value : {};
  const settings = fusionSettings(v);
  const models = new Set(settings.models.map((m) => m.id));
  const projects = (Array.isArray(v.projects) ? v.projects : []).slice(0, MAX_PROJECTS).map((p) => ({
    id: text(p?.id, 100) || `manual-${randomUUID().slice(0, 8)}`,
    name: text(p?.name, 200) || 'Unnamed project',
    loc: wholeNumber(p?.loc),
    locOverride: wholeNumber(p?.locOverride),
    criticality: CRITICALITIES.includes(Number(p?.criticality)) ? Number(p.criticality) : null,
    frequency: FREQ_IDS.has(p?.frequency) ? p.frequency : 'rare',
    scansPerWeek: Math.max(0, finite(p?.scansPerWeek, 0)),
    scanCount: wholeNumber(p?.scanCount) ?? 0,
    lastScanAt: iso(p?.lastScanAt),
    scanId: text(p?.scanId, 100),
    source: ['sast-metadata', 'scan', 'none', 'manual'].includes(p?.source) ? p.source : 'manual',
    applications: (Array.isArray(p?.applications) ? p.applications : []).slice(0, 50).map((a) => text(a, 200)).filter(Boolean),
    groups: (Array.isArray(p?.groups) ? p.groups : []).slice(0, 50).map((g) => text(g, 200)).filter(Boolean),
    initiator: text(p?.initiator, 254),
    included: p?.included !== false,
    scansOverride: wholeNumber(p?.scansOverride),
    modelOverride: models.has(p?.modelOverride) ? p.modelOverride : null,
  }));
  return { ...settings, readAt: iso(v.readAt), projects };
}

/** A profile from MZ-01.00.61 (its à la carte calculator state): the exports and plan carry over. */
function migrate(profile) {
  // MZ-01.00.69: Fusion's default extra findings went from 20% to 5%; a profile still on the old default follows.
  if (profile.planVersion === 2) {
    const old = profile.tr && Number(profile.tr.fusionUpliftPercent) === 20;
    return { ...profile, planVersion: 3, tr: old ? { ...profile.tr, fusionUpliftPercent: DEFAULT_TR.fusionUpliftPercent } : profile.tr };
  }
  // Before MZ-01.00.67 nothing chosen was 0 everywhere: now it is every open finding (null).
  if (profile.tr && !profile.planVersion) {
    const sel = profile.tr.selected ?? {};
    const none = PLAN.every((s) => !Number(sel[s]));
    const lookback = LOOKBACKS.includes(Number(profile.tr.lookbackMonths)) ? profile.tr.lookbackMonths : DEFAULT_TR.lookbackMonths;
    return { ...profile, planVersion: 3, tr: { ...profile.tr, lookbackMonths: lookback, ...(none ? { selected: Object.fromEntries(PLAN.map((s) => [s, null])) } : {}) } };
  }
  if (profile.tr || !profile.alaCarte) return profile;
  const a = profile.alaCarte;
  const selected = Object.fromEntries(PLAN.map((s) => [s, finite(a.plan?.[s]?.selected, 0)]));
  const fpPercent = Object.fromEntries(PLAN.map((s) => [s, finite(a.plan?.[s]?.fp, finite(a.assumptions?.falsePositive?.[s], DEFAULT_TR.fpPercent[s]))]));
  const triage = finite(a.assumptions?.triageCredits, 1);
  const remediation = finite(a.assumptions?.remediationCredits, 3);
  const tr = cleanTr({ totals: a.totals, fixed: a.fixed, selected, fpPercent, triageCost: Object.fromEntries(PLAN.map((s) => [s, triage])), remediationCost: Object.fromEntries(PLAN.map((s) => [s, remediation])) });
  const fusion = profile.fusion ? cleanFusion({ ...profile.fusion, defaultScans: 1, models: profile.fusion.creditsPerBundle ? [{ id: 'model-1', name: '', creditsPer10k: profile.fusion.creditsPerBundle, source: 'manual' }] : [] }) : cleanFusion({});
  const { alaCarte, ...rest } = profile;
  return { ...rest, planVersion: 3, customer: profile.customer || a.customer || '', tr, fusion };
}

const summary = (p) => ({
  id: p.id,
  name: p.name,
  createdAt: p.createdAt,
  createdBy: p.createdBy,
  updatedAt: p.updatedAt,
  updatedBy: p.updatedBy,
  hasTr: Boolean(p.tr?.totals && p.tr?.fixed),
  fusionProjects: p.fusion?.projects?.length ?? 0,
});

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

  create({ name, by }) {
    if (this.#profiles.length >= MAX_PROFILES) throw fail(409, `There are already ${MAX_PROFILES} customers. Delete one first.`);
    const now = new Date().toISOString();
    const profile = { id: randomUUID(), name: text(name, 120) || 'New customer', planVersion: 3, createdAt: now, createdBy: text(by, 254), updatedAt: now, updatedBy: text(by, 254), tr: cleanTr({}), fusion: cleanFusion({}), totals: totalsSettings({}), scope: cleanScope({}) };
    this.#profiles.push(profile);
    this.#save();
    return structuredClone(profile);
  }

  /** Save what changed: the customer's name, the T&R projection, the Fusion projection, the extra % and bundle size, the scope (each optional). */
  update(id, patch = {}, by = '') {
    const index = this.#profiles.findIndex((p) => p.id === id);
    if (index === -1) throw fail(404, 'That customer no longer exists.');
    const next = { ...this.#profiles[index] };
    if (patch.name !== undefined) next.name = text(patch.name, 120) || next.name;
    if (patch.tr !== undefined) next.tr = cleanTr(patch.tr);
    if (patch.fusion !== undefined) next.fusion = cleanFusion(patch.fusion);
    if (patch.totals !== undefined) next.totals = totalsSettings(patch.totals);
    if (patch.scope !== undefined) next.scope = cleanScope(patch.scope);
    next.updatedAt = new Date().toISOString();
    next.updatedBy = text(by, 254);
    if (Buffer.byteLength(JSON.stringify(next)) > MAX_PROFILE_BYTES) throw fail(413, 'This customer is too large to save (over 3 MB). Use exports covering fewer weeks.');
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

/** A report's figures, kept as data only: strings, numbers, booleans and nulls, nested a little. */
export function cleanReportData(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 2000);
  if (depth > 8) return null;
  if (Array.isArray(value)) return value.slice(0, MAX_PROJECTS).map((v) => cleanReportData(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 200)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k.slice(0, 80)] = cleanReportData(v, depth + 1);
    }
    return out;
  }
  return null;
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
    const clean = cleanReportData(data);
    const report = {
      id: randomUUID(),
      customerId: text(customerId, 100),
      customer: text(customer, 120) || 'Customer',
      createdAt: new Date().toISOString(),
      createdBy: text(by, 254),
      trCredits: finite(clean?.tr?.totals?.credits, null),
      fusionCredits: finite(clean?.fusion?.totals?.credits, null),
      data: clean,
    };
    // The total with the extra % on top, and the bundles it takes, worked out again here.
    const sum = creditSummary(report.trCredits, report.fusionCredits, clean?.summary?.settings);
    Object.assign(report, { extraPercent: sum.settings.extraPercent, bundleCredits: sum.settings.bundleCredits, totalCredits: sum.total, bundles: sum.bundles });
    const body = JSON.stringify(report);
    if (Buffer.byteLength(body) > MAX_REPORT_BYTES) throw fail(413, 'This report is too large to keep (over 4 MB).');
    writeJson(this.#file(report.id), report);
    for (const old of this.#all().slice(MAX_REPORTS)) fs.rmSync(this.#file(old.id), { force: true });
    const { data: _, ...meta } = report;
    return meta;
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
async function projectScans(client, projectId, { from, lastScan }) {
  const scans = [];
  let count = null;
  for (let offset = 0; scans.length < MAX_SCANS_PER_PROJECT; offset += SCAN_PAGE) {
    const page = await client.request('/api/scans', { query: { 'project-id': projectId, statuses: 'Completed', 'from-date': from, sort: '-created_at', offset, limit: SCAN_PAGE }, retries: 2, background: true });
    const items = (Array.isArray(page?.scans) ? page.scans : []).filter((x) => x?.id && (!x.projectId || x.projectId === projectId));
    count ??= wholeNumber(page?.filteredTotalCount ?? page?.totalCount);
    scans.push(...items);
    if (items.length < SCAN_PAGE) break;
  }
  const at = (scan) => Date.parse(scan?.createdAt ?? scan?.updatedAt ?? '');
  scans.sort((a, b) => at(b) - at(a));
  let before = null;
  if (!scans.length && lastScan?.id && at(lastScan) < Date.parse(from)) before = lastScan;
  else {
    try {
      const page = await client.request('/api/scans', { query: { 'project-id': projectId, statuses: 'Completed', 'to-date': from, sort: '-created_at', limit: 1 }, retries: 1, background: true });
      const found = (Array.isArray(page?.scans) ? page.scans : []).find((x) => x?.id && at(x) < Date.parse(from));
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

/**
 * The tenant's backlog and fixes, week by week, as the two Checkmarx One exports give them
 * ("Total" and "Fixed Vulnerabilities by Severity"), worked out from every project's scans:
 * the backlog at a week's end is each project's last scan by then, added up; a week's fixes are
 * what each scan that week no longer reports (the scan before it, plus what it found new, less
 * what it reports). A project scanned before the window counts from its last scan before it.
 */
export function weeklyBacklog(perProject, summaries, { now = Date.now(), weeks = 52, engines = null } = {}) {
  const ends = [];
  for (let k = weeks - 1; k >= 0; k -= 1) ends.push(now - k * 7 * DAY);
  const blank = () => Object.fromEntries(SEVERITIES.map((s) => [s, ends.map(() => 0)]));
  const totals = blank();
  const fixed = blank();
  // The engines the tenant's own totals count (null: every engine); each project keeps every engine apart.
  const scope = engineScope(engines);
  const at = (scan) => Date.parse(scan?.createdAt ?? scan?.updatedAt ?? '');
  let scansUsed = 0;
  // Each project's own weeks, per engine, so the backlog of any set of projects and engines can be added up later.
  const byProject = new Map();
  for (const { project, scans, before } of perProject) {
    const timeline = [...(before ? [before] : []), ...[...scans].reverse()].filter((scan) => summaries.has(scan.id) && Number.isFinite(at(scan)));
    if (!timeline.length) continue;
    scansUsed += timeline.length;
    const own = { e: {}, scans: timeline.length };
    const ownOf = (engine) => (own.e[engine] ??= { t: blank(), f: blank() });
    let k = 0;
    for (let w = 0; w < ends.length; w += 1) {
      while (k + 1 < timeline.length && at(timeline[k + 1]) <= ends[w]) k += 1;
      if (at(timeline[k]) > ends[w]) continue;
      for (const [engine, { total }] of Object.entries(perEngine(summaries.get(timeline[k].id)))) {
        const mine = ownOf(engine);
        for (const s of SEVERITIES) {
          mine.t[s][w] += total[s];
          if (counted(engine, scope)) totals[s][w] += total[s];
        }
      }
    }
    for (let i = 1; i < timeline.length; i += 1) {
      const t = at(timeline[i]);
      const w = ends.findIndex((end) => t <= end && t > end - 7 * DAY);
      if (w === -1) continue;
      const prev = perEngine(summaries.get(timeline[i - 1].id));
      const next = perEngine(summaries.get(timeline[i].id));
      // Each engine on its own: what its scan before reported, plus what it found new, less what it reports now.
      for (const engine of new Set([...Object.keys(prev), ...Object.keys(next)])) {
        for (const s of SEVERITIES) {
          const gone = Math.max(0, (prev[engine]?.total[s] ?? 0) + (next[engine]?.fresh[s] ?? 0) - (next[engine]?.total[s] ?? 0));
          if (!gone) continue;
          ownOf(engine).f[s][w] += gone;
          if (counted(engine, scope)) fixed[s][w] += gone;
        }
      }
    }
    if (project?.id) byProject.set(String(project.id), own);
  }
  const days = ends.map((t) => new Date(t).toISOString().slice(0, 10));
  return { totals: { weeks: days, bySeverity: totals }, fixed: { weeks: days, bySeverity: fixed }, scans: scansUsed, byProject, engines: scope ?? [] };
}

/**
 * The backlog and fixes, week by week, of these projects only (ids), from a read's own weeks per
 * project: the same two series the whole tenant has, for a scope.
 */
export function seriesFor(read, ids, engines = null) {
  const weeks = Array.isArray(read?.weeks) ? read.weeks : [];
  const blank = () => Object.fromEntries(SEVERITIES.map((s) => [s, weeks.map(() => 0)]));
  const totals = blank();
  const fixed = blank();
  const scope = engineScope(engines);
  let projects = 0;
  let scans = 0;
  // A read made before engines were told apart counts every engine: said, so the page can ask for a new read.
  let engineSplit = true;
  const add = (pair) => {
    for (const s of SEVERITIES) {
      for (let w = 0; w < weeks.length; w += 1) {
        totals[s][w] += Number(pair.t?.[s]?.[w]) || 0;
        fixed[s][w] += Number(pair.f?.[s]?.[w]) || 0;
      }
    }
  };
  for (const id of new Set((Array.isArray(ids) ? ids : []).map(String))) {
    const own = Object.hasOwn(read?.series ?? {}, id) ? read.series[id] : null;
    if (!own) continue;
    projects += 1;
    scans += wholeNumber(own.scans) ?? 0;
    if (own.e && typeof own.e === 'object') {
      for (const [engine, pair] of Object.entries(own.e)) {
        if (!counted(engine, scope)) continue;
        if (scope && engine === 'ALL') engineSplit = false;
        add(pair);
      }
    } else {
      if (scope) engineSplit = false;
      add(own);
    }
  }
  const meta = { source: 'cxone', readAt: read?.readAt ?? null, projects, scans, scoped: true, engines: scope ?? [], engineSplit };
  return { totals: { weeks, bySeverity: totals, meta }, fixed: { weeks, bySeverity: fixed, meta } };
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
    for (const [id, own] of byProject ?? []) series[id] = own.e ? { scans: own.scans, e: own.e } : { scans: own.scans, t: own.t, f: own.f };
    const value = { readAt, weeks, series };
    writeJson(this.#file, value);
    this.#cache = value;
  }

  get() {
    if (this.#cache) return this.#cache;
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
 */
export async function readTenant(client, { concurrency = 8, now = Date.now(), weeks = 52, onProgress = () => {} } = {}) {
  const [projects, applications] = await Promise.all([listProjects(client).then((list) => list.slice(0, MAX_PROJECTS)), listApplications(client).catch(() => [])]);
  // Each project's applications, by name (a project may be in several).
  const appsOf = new Map();
  for (const app of applications) for (const id of app.projectIds) appsOf.set(id, [...(appsOf.get(id) ?? []), app.name]);
  onProgress('projects', 0, projects.length);
  const lastScans = await getLastScans(client, projects.map((p) => p.id)).catch(() => ({}));
  const yearAgo = now - 365 * DAY;
  const from = new Date(Math.min(yearAgo, now - weeks * 7 * DAY)).toISOString();
  let done = 0;
  const perProject = await mapWithConcurrency(projects, concurrency, async (project) => {
    const lastScan = lastScans[project.id] ?? null;
    let history = { scans: [], count: 0, before: null, failed: false };
    try {
      history = { ...(await projectScans(client, project.id, { from, lastScan })), failed: false };
    } catch {
      history.failed = true;
    }
    const latest = history.scans[0] ?? lastScan ?? history.before;
    const lines = latest?.id ? await linesOfScan(client, latest.id) : { loc: null, source: 'none' };
    onProgress('projects', (done += 1), projects.length);
    return { project, lastScan, latest, lines, ...history };
  });

  // Fusion: how often each project was scanned in the last year (a younger project: since it was created).
  const rows = perProject.map(({ project, latest, lastScan, lines, scans, count, failed }) => {
    const born = Date.parse(project.createdAt ?? '');
    const windowDays = Math.max(7, Math.min(365, (now - Math.max(yearAgo, Number.isFinite(born) ? born : 0)) / DAY));
    const inYear = scans.length >= MAX_SCANS_PER_PROJECT || count > scans.length ? count : scans.filter((x) => Date.parse(x.createdAt ?? '') >= yearAgo).length;
    // Scans that could not be listed: the last scan still says whether it was within the year.
    const lastAt = Date.parse(lastScanDate(latest) ?? '');
    const scanCount = failed ? (lastAt >= yearAgo ? 1 : 0) : inYear;
    const frequency = frequencyOf(scanCount, windowDays);
    return {
      id: project.id,
      name: project.name,
      applications: (appsOf.get(String(project.id)) ?? []).slice(0, 50),
      groups: (Array.isArray(project.groups) ? project.groups : []).map((g) => String(g?.name ?? g ?? '')).filter(Boolean).slice(0, 50),
      initiator: String(latest?.initiator ?? lastScan?.initiator ?? '').slice(0, 254),
      criticality: CRITICALITIES.includes(Number(project.criticality)) ? Number(project.criticality) : null,
      scanCount,
      scansPerWeek: Math.round(frequency.perWeek * 100) / 100,
      frequency: frequency.id,
      lastScanAt: lastScanDate(latest),
      scanId: latest?.id ?? '',
      ...lines,
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
  const readAt = new Date(now).toISOString();
  const meta = { source: 'cxone', readAt, projects: projects.length, scans: weekly.scans, engines: weekly.engines, engineSplit: true };
  return {
    projects: rows,
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

/** Where a tenant may say which Fusion models it offers, and what credits it has left. Not documented by Checkmarx: tried, never relied on. */
export const FUSION_MODEL_PATHS = ['/api/fusion/models', '/api/fusion/config', '/api/scan-config/fusion/models'];
export const CREDIT_BALANCE_PATHS = ['/api/fusion/credits', '/api/credits/balance', '/api/credits'];

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
  const [modelsBody, creditsBody] = await Promise.all([tryRead(FUSION_MODEL_PATHS), tryRead(CREDIT_BALANCE_PATHS)]);
  const models = modelsBody ? findModels(modelsBody) : [];
  const unique = [...new Map(models.map((m) => [m.id, m])).values()];
  const remainingCredits = creditsBody ? findNumber(creditsBody, /remaining|balance|available/i) : null;
  return { models: unique, remainingCredits };
}

