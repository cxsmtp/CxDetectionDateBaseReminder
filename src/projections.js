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
import { getLastScans, lastScanDate, listProjects } from './cxone/projects.js';
import { CRITICALITIES, DEFAULT_TR, FREQUENCIES, LOOKBACKS, amount, frequencyOf, fusionSettings, wholeNumber } from '../public/calculator/model.js';

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
  return { weeks, bySeverity, meta: { fileName: text(meta.fileName, 200), sheet: text(meta.sheet, 200), layout: text(meta.layout, 20), exportedAt: meta.exportedAt ? text(meta.exportedAt, 40) : null } };
}

const perSeverity = (value, fallback, lo, hi) => Object.fromEntries(PLAN.map((s) => [s, Math.min(hi, Math.max(lo, finite(value?.[s], fallback[s])))]));

/** The triage & remediation projection: the two exports, and the plan per severity. */
export function cleanTr(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    totals: series(v.totals),
    fixed: series(v.fixed),
    selected: perSeverity(v.selected, { Critical: 0, High: 0, Medium: 0, Low: 0 }, 0, 1e9),
    triageCost: perSeverity(v.triageCost, DEFAULT_TR.triageCost, 0, 1000),
    fpPercent: perSeverity(v.fpPercent, DEFAULT_TR.fpPercent, 0, 100),
    remediationCost: perSeverity(v.remediationCost, DEFAULT_TR.remediationCost, 0, 1000),
    lookbackMonths: LOOKBACKS.includes(Number(v.lookbackMonths)) ? Number(v.lookbackMonths) : DEFAULT_TR.lookbackMonths,
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
    included: p?.included !== false,
    scansOverride: wholeNumber(p?.scansOverride),
    modelOverride: models.has(p?.modelOverride) ? p.modelOverride : null,
  }));
  return { ...settings, readAt: iso(v.readAt), projects };
}

/** A profile from MZ-01.00.61 (its à la carte calculator state): the exports and plan carry over. */
function migrate(profile) {
  if (profile.tr || !profile.alaCarte) return profile;
  const a = profile.alaCarte;
  const selected = Object.fromEntries(PLAN.map((s) => [s, finite(a.plan?.[s]?.selected, 0)]));
  const fpPercent = Object.fromEntries(PLAN.map((s) => [s, finite(a.plan?.[s]?.fp, finite(a.assumptions?.falsePositive?.[s], DEFAULT_TR.fpPercent[s]))]));
  const triage = finite(a.assumptions?.triageCredits, 1);
  const remediation = finite(a.assumptions?.remediationCredits, 3);
  const tr = cleanTr({ totals: a.totals, fixed: a.fixed, selected, fpPercent, triageCost: Object.fromEntries(PLAN.map((s) => [s, triage])), remediationCost: Object.fromEntries(PLAN.map((s) => [s, remediation])) });
  const fusion = profile.fusion ? cleanFusion({ ...profile.fusion, defaultScans: 1, models: profile.fusion.creditsPerBundle ? [{ id: 'model-1', name: '', creditsPer10k: profile.fusion.creditsPerBundle, source: 'manual' }] : [] }) : cleanFusion({});
  const { alaCarte, ...rest } = profile;
  return { ...rest, customer: profile.customer || a.customer || '', tr, fusion };
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
    const profile = { id: randomUUID(), name: text(name, 120) || 'New customer', createdAt: now, createdBy: text(by, 254), updatedAt: now, updatedBy: text(by, 254), tr: cleanTr({}), fusion: cleanFusion({}) };
    this.#profiles.push(profile);
    this.#save();
    return structuredClone(profile);
  }

  /** Save what changed: the customer's name, the T&R projection, the Fusion projection (each optional). */
  update(id, patch = {}, by = '') {
    const index = this.#profiles.findIndex((p) => p.id === id);
    if (index === -1) throw fail(404, 'That customer no longer exists.');
    const next = { ...this.#profiles[index] };
    if (patch.name !== undefined) next.name = text(patch.name, 120) || next.name;
    if (patch.tr !== undefined) next.tr = cleanTr(patch.tr);
    if (patch.fusion !== undefined) next.fusion = cleanFusion(patch.fusion);
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
    report.totalCredits = (report.trCredits ?? 0) + (report.fusionCredits ?? 0);
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
async function scanCounts(client, { now = Date.now(), days = 365 } = {}) {
  const from = new Date(now - days * DAY).toISOString();
  const counts = new Map();
  for await (const scan of client.paginate('/api/scans', { query: { 'from-date': from, statuses: 'Completed', sort: '-created_at' }, itemsKey: 'scans', limit: 200, maxItems: 100_000 })) {
    const id = scan?.projectId;
    if (!id) continue;
    const at = Date.parse(scan.createdAt ?? scan.updatedAt ?? '');
    const entry = counts.get(id) ?? { count: 0, first: Infinity };
    entry.count += 1;
    if (Number.isFinite(at)) entry.first = Math.min(entry.first, at);
    counts.set(id, entry);
  }
  return counts;
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

/**
 * Every project in the tenant for Fusion: lines of code from its last scan, its criticality, and
 * how often it was scanned over the last year (a project younger than that: since it was created).
 */
export async function readFusionProjects(client, { concurrency = 8, now = Date.now() } = {}) {
  const projects = (await listProjects(client)).slice(0, MAX_PROJECTS);
  const [lastScans, counts] = await Promise.all([getLastScans(client, projects.map((p) => p.id)).catch(() => ({})), scanCounts(client, { now }).catch(() => new Map())]);
  const rows = await mapWithConcurrency(projects, concurrency, async (project) => {
    const scan = lastScans[project.id];
    const stats = counts.get(project.id) ?? { count: 0, first: Infinity };
    const born = Date.parse(project.createdAt ?? '');
    const windowDays = Math.max(7, Math.min(365, (now - Math.max(now - 365 * DAY, Number.isFinite(born) ? born : 0)) / DAY));
    const frequency = frequencyOf(stats.count, windowDays);
    const lines = scan?.id ? await linesOfScan(client, scan.id) : { loc: null, source: 'none' };
    return {
      id: project.id,
      name: project.name,
      criticality: CRITICALITIES.includes(Number(project.criticality)) ? Number(project.criticality) : null,
      scanCount: stats.count,
      scansPerWeek: Math.round(frequency.perWeek * 100) / 100,
      frequency: frequency.id,
      lastScanAt: lastScanDate(scan),
      scanId: scan?.id ?? '',
      ...lines,
      included: true,
    };
  });
  return rows;
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

