/**
 * Credit projections: saved customer profiles, each with an à la carte projection (what clearing the
 * backlog costs in triage and remediation credits, from two Checkmarx One exports) and a Fusion
 * projection (what one Fusion scan of each project costs, from the lines of code its last scan
 * counted). Kept per tenant in projections.json, so a projection can be reopened and carried on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { mapWithConcurrency } from './cxone/client.js';
import { getLastScans, lastScanDate, listProjects } from './cxone/projects.js';
import { FUSION_DEFAULTS, fusionTerms, wholeNumber } from '../public/projections/fusion.js';

export const MAX_PROFILES = 200;
/** One profile, saved: the two exports' weekly series and a logo fit well inside this. */
export const MAX_PROFILE_BYTES = 3 * 1024 * 1024;
const MAX_FUSION_PROJECTS = 5000;
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info'];
const LOGO = /^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const finite = (value, fallback = null) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : fallback);

/** One export's weekly series as the calculator reads it, keeping only numbers and dates. */
function series(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.weeks)) return null;
  const weeks = value.weeks.slice(0, 2000).map((w) => text(w, 32));
  const bySeverity = {};
  for (const s of SEVERITIES) {
    const list = Array.isArray(value.bySeverity?.[s]) ? value.bySeverity[s] : [];
    bySeverity[s] = weeks.map((_, i) => finite(list[i], 0));
  }
  const meta = value.meta && typeof value.meta === 'object' ? value.meta : {};
  return {
    weeks,
    bySeverity,
    meta: {
      fileName: text(meta.fileName, 200),
      sheet: text(meta.sheet, 200),
      layout: text(meta.layout, 20),
      exportedAt: meta.exportedAt ? text(meta.exportedAt, 40) : null,
      filters: Array.isArray(meta.filters) ? meta.filters.slice(0, 50).map((f) => (typeof f === 'string' ? text(f, 300) : f && typeof f === 'object' ? Object.fromEntries(Object.entries(f).slice(0, 10).map(([k, v]) => [text(k, 60), text(v, 300)])) : null)).filter(Boolean) : [],
    },
    warnings: Array.isArray(value.warnings) ? value.warnings.slice(0, 20).map((w) => text(w, 500)) : [],
  };
}

/** The calculator's own state (public/projections/calculator), kept to what it needs and can safely show. */
export function cleanAlaCarte(value) {
  if (!value || typeof value !== 'object') return null;
  const plan = {};
  for (const s of SEVERITIES) {
    const row = value.plan?.[s];
    if (row && typeof row === 'object') plan[s] = { selected: Math.max(0, finite(row.selected, 0)), fp: Math.min(100, Math.max(0, finite(row.fp, 0))) };
  }
  const a = value.assumptions && typeof value.assumptions === 'object' ? value.assumptions : {};
  const falsePositive = {};
  for (const s of SEVERITIES) if (Number.isFinite(Number(a.falsePositive?.[s]))) falsePositive[s] = Math.min(100, Math.max(0, Number(a.falsePositive[s])));
  return {
    version: 1,
    customer: text(value.customer, 200),
    preparedBy: text(value.preparedBy, 200),
    logoDataUrl: typeof value.logoDataUrl === 'string' && LOGO.test(value.logoDataUrl) ? value.logoDataUrl : null,
    totals: series(value.totals),
    fixed: series(value.fixed),
    plan: Object.keys(plan).length ? plan : null,
    planTouched: Boolean(value.planTouched),
    assumptions: {
      ...(Number.isFinite(Number(a.triageCredits)) ? { triageCredits: Math.max(0, Number(a.triageCredits)) } : {}),
      ...(Number.isFinite(Number(a.remediationCredits)) ? { remediationCredits: Math.max(0, Number(a.remediationCredits)) } : {}),
      falsePositive,
    },
    windowWeeks: finite(value.windowWeeks),
    horizonMonths: finite(value.horizonMonths),
    pace: finite(value.pace),
    reportTitle: text(value.reportTitle, 200),
    reportValidity: text(value.reportValidity, 200),
  };
}

/** The Fusion projection: its terms, and the projects with the lines of code they count at. */
export function cleanFusion(value) {
  const v = value && typeof value === 'object' ? value : {};
  const terms = fusionTerms(v);
  const projects = (Array.isArray(v.projects) ? v.projects : []).slice(0, MAX_FUSION_PROJECTS).map((p) => ({
    id: text(p?.id, 100) || `manual-${randomUUID().slice(0, 8)}`,
    name: text(p?.name, 200) || 'Unnamed project',
    loc: wholeNumber(p?.loc),
    locOverride: wholeNumber(p?.locOverride),
    scanId: text(p?.scanId, 100),
    scanAt: p?.scanAt ? text(p.scanAt, 40) : null,
    source: ['sast-metadata', 'scan', 'none', 'manual'].includes(p?.source) ? p.source : 'manual',
    included: p?.included !== false,
  }));
  return { ...terms, readAt: v.readAt ? text(v.readAt, 40) : null, projects };
}

const summary = (p) => ({
  id: p.id,
  name: p.name,
  customer: p.alaCarte?.customer || '',
  createdAt: p.createdAt,
  createdBy: p.createdBy,
  updatedAt: p.updatedAt,
  updatedBy: p.updatedBy,
  hasAlaCarte: Boolean(p.alaCarte?.totals && p.alaCarte?.fixed),
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
      return Array.isArray(raw.profiles) ? raw.profiles.filter((p) => p && typeof p.id === 'string') : [];
    } catch {
      return [];
    }
  }

  #save() {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, profiles: this.#profiles }), { mode: 0o600 });
    fs.renameSync(tmp, this.#file);
  }

  list() {
    return [...this.#profiles].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(summary);
  }

  get(id) {
    const found = this.#profiles.find((p) => p.id === id);
    if (!found) throw fail(404, 'That projection profile no longer exists.');
    return structuredClone(found);
  }

  create({ name, by }) {
    if (this.#profiles.length >= MAX_PROFILES) throw fail(409, `There are already ${MAX_PROFILES} projection profiles. Delete one first.`);
    const now = new Date().toISOString();
    const profile = {
      id: randomUUID(),
      name: text(name, 120) || 'New projection',
      createdAt: now,
      createdBy: text(by, 254),
      updatedAt: now,
      updatedBy: text(by, 254),
      alaCarte: null,
      fusion: { ...FUSION_DEFAULTS, readAt: null, projects: [] },
    };
    this.#profiles.push(profile);
    this.#save();
    return structuredClone(profile);
  }

  /** Save what changed: its name, the à la carte state, the Fusion projection (each optional). */
  update(id, patch = {}, by = '') {
    const index = this.#profiles.findIndex((p) => p.id === id);
    if (index === -1) throw fail(404, 'That projection profile no longer exists.');
    const next = { ...this.#profiles[index] };
    if (patch.name !== undefined) next.name = text(patch.name, 120) || next.name;
    if (patch.alaCarte !== undefined) next.alaCarte = cleanAlaCarte(patch.alaCarte);
    if (patch.fusion !== undefined) next.fusion = cleanFusion(patch.fusion);
    next.updatedAt = new Date().toISOString();
    next.updatedBy = text(by, 254);
    if (Buffer.byteLength(JSON.stringify(next)) > MAX_PROFILE_BYTES) throw fail(413, 'This profile is too large to save (over 3 MB). Use a smaller logo, or exports covering fewer weeks.');
    this.#profiles[index] = next;
    this.#save();
    return summary(next);
  }

  remove(id) {
    const before = this.#profiles.length;
    this.#profiles = this.#profiles.filter((p) => p.id !== id);
    if (this.#profiles.length === before) throw fail(404, 'That projection profile no longer exists.');
    this.#save();
  }
}

/**
 * Every project in the tenant with the lines of code its last scan counted: the SAST scan
 * metadata (GET /api/sast-metadata/{scanId}), else the scan's own SAST status details. A project
 * with no completed scan, or none with SAST, is listed with no lines, to be typed in.
 */
export async function readProjectLines(client, { concurrency = 8 } = {}) {
  const projects = (await listProjects(client)).slice(0, MAX_FUSION_PROJECTS);
  const lastScans = await getLastScans(client, projects.map((p) => p.id)).catch(() => ({}));
  const rows = await mapWithConcurrency(projects, concurrency, async (project) => {
    const scan = lastScans[project.id];
    const row = { id: project.id, name: project.name, loc: null, scanId: scan?.id ?? '', scanAt: lastScanDate(scan), source: 'none', included: true };
    if (!scan?.id) return row;
    try {
      const meta = await client.request(`/api/sast-metadata/${encodeURIComponent(scan.id)}`, { retries: 1, background: true });
      const loc = wholeNumber(meta?.loc);
      if (loc !== null) return { ...row, loc, source: 'sast-metadata' };
    } catch {}
    try {
      const details = await client.request(`/api/scans/${encodeURIComponent(scan.id)}`, { retries: 1, background: true });
      const sast = (Array.isArray(details?.statusDetails) ? details.statusDetails : []).find((d) => String(d?.name).toLowerCase() === 'sast');
      const loc = wholeNumber(sast?.loc);
      if (loc !== null) return { ...row, loc, source: 'scan' };
    } catch {}
    return row;
  });
  return rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
