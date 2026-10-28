// The Cx Credits Calculator's customers and reports, checked the same way wherever they are kept: on the
// server (src/projections.js, in the data folder) and in the standalone calculator (in the browser). No
// Node or browser APIs beyond crypto and TextEncoder, so both can use it.

import { CRITICALITIES, DEFAULT_TR, FREQUENCIES, LOOKBACKS, MAX_CLOC_LANGUAGES, MAX_PROJECTS, aheadSettings, cleanScope, creditSummary, fusionSettings, fusionTotal, impactSettings, modelsNamed, newCustomerSettings, totalsSettings, wholeNumber } from './model.js';
import { DEFAULT_ENGINES, cleanEngines } from '../engines.js';

export const MAX_PROFILES = 200;
/** One profile, saved: about 550 bytes a project read, so 50,000 projects and the weekly series fit inside this. */
export const MAX_PROFILE_BYTES = 32 * 1024 * 1024;
export const MAX_REPORTS = 500;
export const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info'];
const PLAN = ['Critical', 'High', 'Medium', 'Low'];
const FREQ_IDS = new Set(FREQUENCIES.map((f) => f.id));
// How a project's branch was chosen (src/cxone/branches.js BRANCH_HOW).
const BRANCH_HOWS = ['primary', 'guessed', 'latest', 'none', 'unknown', 'any'];

/** A random id: crypto.randomUUID where there is one, else the same shape from getRandomValues. */
export function newId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

export const fail = (status, message) => Object.assign(new Error(message), { status });
export const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
export const finite = (value, fallback = null) => (value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback);
export const isoDay = (value) => (/^\d{4}-\d{2}-\d{2}/.test(String(value ?? '')) ? String(value).slice(0, 10) : null);
export const iso = (value) => (value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null);

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
      // One branch per project ('primary') or every branch ('all'); '' for a read made before branches were told apart.
      branches: ['primary', 'all'].includes(meta.branches) ? meta.branches : '',
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

/** {SAST: n, …}: known engines only, whole numbers; null when none were given. */
function openCounts(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  for (const [engine, n] of Object.entries(value)) {
    const key = cleanEngines([engine])[0];
    const count = wholeNumber(n);
    if (key && count !== null) out[key] = count;
  }
  return Object.keys(out).length ? out : null;
}

/** The Fusion projection: its settings, and the projects with what Checkmarx One said of them. */
export function cleanFusion(value) {
  const v = value && typeof value === 'object' ? value : {};
  const settings = fusionSettings(v);
  const models = new Set(settings.models.map((m) => m.id));
  const projects = (Array.isArray(v.projects) ? v.projects : []).slice(0, MAX_PROJECTS).map((p) => ({
    id: text(p?.id, 100) || `manual-${newId().slice(0, 8)}`,
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
    // The branch its scans were counted on, and how it was chosen (src/cxone/branches.js).
    branch: text(p?.branch, 200),
    branchHow: BRANCH_HOWS.includes(p?.branchHow) ? p.branchHow : '',
    // Open findings now, per engine (its latest scan): unknown (null) for a project added by hand or read before.
    openByEngine: openCounts(p?.openByEngine),
  }));
  return { ...settings, readAt: iso(v.readAt), projects };
}

/**
 * Fusion for a new customer: projects whose lines of code were counted with cloc (each language's code
 * lines), or typed, with their own scans and model. The models are the Fusion page's, so a model is kept
 * by id only.
 */
export function cleanFusionNew(value) {
  const v = value && typeof value === 'object' ? value : {};
  const projects = (Array.isArray(v.projects) ? v.projects : []).slice(0, MAX_PROJECTS).map((p) => ({
    id: text(p?.id, 100) || `new-${newId().slice(0, 8)}`,
    name: text(p?.name, 200) || 'Unnamed project',
    file: text(p?.file, 200),
    langs: Object.fromEntries(
      Object.entries(p?.langs && typeof p.langs === 'object' ? p.langs : {})
        .slice(0, MAX_CLOC_LANGUAGES)
        .map(([lang, n]) => [text(lang, 60), wholeNumber(n) ?? 0])
        .filter(([lang]) => lang && !['__proto__', 'constructor', 'prototype'].includes(lang)),
    ),
    locOverride: wholeNumber(p?.locOverride),
    included: p?.included !== false,
    scansOverride: wholeNumber(p?.scansOverride),
    modelOverride: typeof p?.modelOverride === 'string' && p.modelOverride ? text(p.modelOverride, 60) : null,
  }));
  return { ...newCustomerSettings(v), projects };
}

/**
 * A profile saved before, brought up to date. MZ-01.01.03: new findings a month are averaged over 12 months
 * by default, not 3 (a quarter's pace said too little about a year's); a customer on the old default follows.
 */
export function migrate(profile) {
  const before = migrateToV3(profile);
  if (before.planVersion !== 3) return before;
  const old = before.tr && Number(before.tr.lookbackMonths) === 3;
  return { ...before, planVersion: 4, tr: old ? { ...before.tr, lookbackMonths: DEFAULT_TR.lookbackMonths } : before.tr };
}

/** A profile from MZ-01.00.61 (its à la carte calculator state): the exports and plan carry over. */
function migrateToV3(profile) {
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

export const summary = (p) => ({
  id: p.id,
  name: p.name,
  createdAt: p.createdAt,
  createdBy: p.createdBy,
  updatedAt: p.updatedAt,
  updatedBy: p.updatedBy,
  hasTr: Boolean(p.tr?.totals && p.tr?.fixed),
  fusionProjects: p.fusion?.projects?.length ?? 0,
  fusionNewProjects: p.fusionNew?.projects?.length ?? 0,
});

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


/** A new customer, its projections empty and its impact from the organisation's defaults. */
export function newProfile({ name, by = '', impact = {} } = {}) {
  const now = new Date().toISOString();
  return { id: newId(), name: text(name, 120) || 'New customer', planVersion: 4, createdAt: now, createdBy: text(by, 254), updatedAt: now, updatedBy: text(by, 254), tr: cleanTr({}), fusion: cleanFusion({ models: modelsNamed() }), fusionNew: cleanFusionNew({}), totals: totalsSettings({}), scope: cleanScope({}), impact: impactSettings(impact) };
}

/** A customer with what changed applied: the name, the T&R projection, the Fusion projection, the extra % and bundle size, the scope, the impact's assumptions (each optional). */
export function patchProfile(profile, patch = {}, by = '') {
  const next = { ...profile };
  if (patch.name !== undefined) next.name = text(patch.name, 120) || next.name;
  if (patch.tr !== undefined) next.tr = cleanTr(patch.tr);
  if (patch.fusion !== undefined) next.fusion = cleanFusion(patch.fusion);
  if (patch.fusionNew !== undefined) next.fusionNew = cleanFusionNew(patch.fusionNew);
  if (patch.totals !== undefined) next.totals = totalsSettings(patch.totals);
  if (patch.scope !== undefined) next.scope = cleanScope(patch.scope);
  // The impact's assumptions: minutes by hand, the hourly cost, the credit price, the currency.
  if (patch.impact !== undefined) next.impact = impactSettings(patch.impact);
  next.updatedAt = new Date().toISOString();
  next.updatedBy = text(by, 254);
  if (bytes(next) > MAX_PROFILE_BYTES) throw fail(413, `This customer is too large to save (over ${MAX_PROFILE_BYTES / 1024 / 1024} MB): read fewer projects (Projects to read, at the top).`);
  return next;
}

/** A projection report: its figures as data only, with the total, the extra % on top and the bundles worked out again. */
export function newReport({ customerId, customer, by = '', data }) {
  const clean = cleanReportData(data);
  const report = {
    id: newId(),
    customerId: text(customerId, 100),
    customer: text(customer, 120) || 'Customer',
    createdAt: new Date().toISOString(),
    createdBy: text(by, 254),
    trCredits: finite(clean?.tr?.totals?.credits, null),
    // Fusion for the customer's projects in Checkmarx One and for its new code (cloc), together.
    fusionCredits: fusionTotal(clean?.fusion, clean?.fusionNew),
    data: clean,
  };
  const sum = creditSummary(report.trCredits, report.fusionCredits, clean?.summary?.settings);
  Object.assign(report, { extraPercent: sum.settings.extraPercent, bundleCredits: sum.settings.bundleCredits, totalCredits: sum.total, bundles: sum.bundles });
  if (bytes(report) > MAX_REPORT_BYTES) throw fail(413, `This report is too large to keep (over ${MAX_REPORT_BYTES / 1024 / 1024} MB): read fewer projects (Projects to read, at the top).`);
  return report;
}

/** A report without its figures, as lists show it. */
export const reportMeta = ({ data, ...meta }) => meta;
