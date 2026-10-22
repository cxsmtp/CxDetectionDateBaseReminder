/**
 * What each Fusion project's scans used (Labs → Fusion results): the model its latest Fusion scan ran with,
 * its lines of code, how many AI scans it had over a period, and the Checkmarx One credits it used then.
 *
 *   - Model: the latest scan's own configuration when it says (any `llmModel` in it); else the project's
 *     setting "LLM Model" (scan.config.ai.llmModel, GET /api/configuration/project); else the tenant's
 *     (GET /api/configuration/tenant). Each is said with where it came from.
 *   - Lines of code: the latest scan's SAST details (statusDetails → sast → loc).
 *   - AI scans: the project's completed scans over the period that ran the AI engine ("ai" among their engines).
 *   - Credits: GET /api/credits/consumption?viewBy=project (as CxCreditGuard reads it): each project's credits
 *     over the period, with how many AI Triage and AI Remediation actions it took. The rest (at 1 credit a
 *     triage and 3 a remediation) is what its Fusion scans used, an estimate the page says is one.
 * Read-only; a part Checkmarx One does not answer (no permission, an older tenant) is left unknown, never 0.
 */
import { mapWithConcurrency } from './cxone/client.js';
import { isProbeMiss } from './cxone/discovery.js';

/** The periods the consumption endpoint takes (others answer 400), and how many days each reaches back. */
export const USAGE_PERIODS = { last_30_days: 30, last_90_days: 90, last_180_days: 180, last_year: 365 };
export const DEFAULT_PERIOD = 'last_30_days';
const MODEL_KEY = 'scan.config.ai.llmModel';
const TRIAGE_CREDITS = 1;
const REMEDIATION_CREDITS = 3;

const text = (v, max = 120) => (v === null || v === undefined ? '' : String(v).trim().slice(0, max));
const whole = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : null);
const norm = (v) => text(v, 300).toLowerCase();

/** The first model named in a scan's configuration, at any depth: an `llmModel` key, or a config entry for it. */
export function modelIn(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return '';
  if (!Array.isArray(value)) {
    if ((value.key === MODEL_KEY || value.name === 'LLM Model') && text(value.value)) return text(value.value, 60);
    for (const [k, v] of Object.entries(value)) if (/^(llmModel|llm_model|scan\.config\.ai\.llmModel)$/i.test(k) && typeof v === 'string' && v.trim()) return text(v, 60);
  }
  for (const v of Object.values(value)) {
    const found = modelIn(v, depth + 1);
    if (found) return found;
  }
  return '';
}

/** The "LLM Model" setting in a configuration answer (a list of entries, or { configEntries }). */
function configModel(body) {
  const entries = Array.isArray(body) ? body : Array.isArray(body?.configEntries) ? body.configEntries : [];
  return text(entries.find((e) => e?.key === MODEL_KEY)?.value, 60);
}

const quiet = async (fn) => {
  try {
    return await fn();
  } catch (error) {
    if (isProbeMiss(error) || [400, 401, 403].includes(error.status)) return null;
    throw error;
  }
};

/**
 * Each project's model (and where it came from), lines of code and engines, from its latest scan (`scans`:
 * { projectId: scan }, as getLastScans gives): { projectId: { model, modelFrom: 'scan' | 'project' | 'tenant' | '',
 * loc, scanEngines } }. The settings are read only for a Fusion scan that does not name its model.
 */
export async function projectFacts(client, projectIds, scans, { concurrency = 4, trace = null } = {}) {
  let tenantModel;
  const tenant = async () => {
    tenantModel ??= quiet(() => client.request('/api/configuration/tenant', { retries: 1, background: true, trace })).then((body) => configModel(body));
    return tenantModel;
  };
  const out = {};
  await mapWithConcurrency(projectIds, concurrency, async (projectId) => {
    const scanId = text(scans?.[projectId]?.id ?? scans?.[projectId]?.scanId, 80);
    const scan = scanId ? await quiet(() => client.request(`/api/scans/${encodeURIComponent(scanId)}`, { retries: 1, background: true, trace })) : null;
    const sast = (Array.isArray(scan?.statusDetails) ? scan.statusDetails : []).find((d) => String(d?.name).toLowerCase() === 'sast');
    let model = modelIn(scan?.metadata ?? scan?.config ?? null);
    let modelFrom = model ? 'scan' : '';
    const fusion = !Array.isArray(scan?.engines) || scan.engines.some((e) => String(e).toLowerCase() === 'ai');
    if (!model && fusion) {
      model = configModel(await quiet(() => client.request('/api/configuration/project', { query: { 'project-id': projectId }, retries: 1, background: true, trace })));
      modelFrom = model ? 'project' : '';
    }
    if (!model && fusion) {
      model = await tenant();
      modelFrom = model ? 'tenant' : '';
    }
    // Its engines say whether it was a Fusion scan ("ai" among them).
    out[projectId] = { model, modelFrom, loc: whole(sast?.loc), scanEngines: Array.isArray(scan?.engines) ? scan.engines.map((e) => text(e, 40)) : [] };
  });
  return out;
}

/** A project's completed scans over the period that ran the AI engine (all completed ones when none says its engines). */
async function aiScans(client, projectId, days, trace) {
  const from = new Date(Date.now() - days * 86400000).toISOString();
  const body = await quiet(() => client.request('/api/scans', { query: { 'project-id': projectId, statuses: 'Completed', 'from-date': from, limit: 1000 }, retries: 1, background: true, trace }));
  if (!body) return null;
  const list = (Array.isArray(body?.scans) ? body.scans : []).filter((s) => !s.createdAt || Date.parse(s.createdAt) >= Date.parse(from));
  const told = list.some((s) => Array.isArray(s.engines));
  return told ? list.filter((s) => (s.engines ?? []).map((e) => String(e).toLowerCase()).includes('ai')).length : list.length;
}

/** Every page of credit consumption by project over the period (null when Checkmarx One does not answer). */
async function consumption(client, period, trace) {
  const items = [];
  for (let page = 1; page <= 50; page += 1) {
    const body = await quiet(() => client.request('/api/credits/consumption', { query: { viewBy: 'project', period, page, size: 100, sort_by: 'creditsUsed', sort_order: 'desc' }, retries: 1, background: true, trace }));
    if (!body) return page === 1 ? null : items;
    const rows = Array.isArray(body?.items) ? body.items : Array.isArray(body) ? body : [];
    items.push(...rows);
    const pages = Number(body?.totalPages);
    if (!rows.length || (Number.isFinite(pages) ? page >= pages : rows.length < 100)) break;
  }
  return items;
}

/** One consumption row: its credits, and its AI Triage and AI Remediation actions (other actions counted apart). */
export function usageRow(item) {
  const actions = { triage: 0, remediation: 0, other: 0 };
  for (const a of Array.isArray(item?.actionsPerformed?.actions) ? item.actionsPerformed.actions : []) {
    const type = norm(a?.actionType).replace(/[\s-]+/g, '_');
    const n = whole(a?.transactionCount) ?? 0;
    if (/^(ai_)?triage$|^auto_?triage$/.test(type)) actions.triage += n;
    else if (/^(ai_)?remediation$/.test(type)) actions.remediation += n;
    else actions.other += n;
  }
  const total = Number(item?.creditsUsed ?? item?.credits);
  const credits = Number.isFinite(total) && total >= 0 ? total : 0;
  // What is left once triage (1 each) and remediation (3 each) are taken out: the Fusion scans', estimated.
  const fusion = Math.max(0, Math.round((credits - actions.triage * TRIAGE_CREDITS - actions.remediation * REMEDIATION_CREDITS) * 100) / 100);
  return { credits, fusion, actions };
}

/**
 * The AI scans and credits of these projects (`projects`: [{ id, name }]) over `period`:
 * { period, days, readAt, creditsKnown, projects: { id: { scans, credits, fusion, actions, perScan } }, totals }.
 */
export async function fusionUsage(client, projects, { period = DEFAULT_PERIOD, concurrency = 4, trace = null } = {}) {
  const span = USAGE_PERIODS[period] ? period : DEFAULT_PERIOD;
  const days = USAGE_PERIODS[span];
  const [counts, rows] = await Promise.all([
    mapWithConcurrency(projects, concurrency, (p) => aiScans(client, p.id, days, trace)),
    consumption(client, span, trace),
  ]);
  // A row names its project by id where Checkmarx One gives one, else by name.
  const byId = new Map();
  const byName = new Map();
  for (const item of rows ?? []) {
    const id = text(item?.projectId ?? item?.id, 80);
    if (id) byId.set(id, item);
    const name = norm(item?.name ?? item?.projectName);
    if (name) byName.set(name, item);
  }
  const out = {};
  const totals = { scans: 0, credits: 0, fusion: 0 };
  projects.forEach((p, i) => {
    const item = byId.get(p.id) ?? byName.get(norm(p.name));
    const used = rows ? (item ? usageRow(item) : { credits: 0, fusion: 0, actions: { triage: 0, remediation: 0, other: 0 } }) : null;
    const scans = counts[i];
    out[p.id] = { scans, credits: used?.credits ?? null, fusion: used?.fusion ?? null, actions: used?.actions ?? null, perScan: used && scans ? Math.round((used.fusion / scans) * 10) / 10 : null };
    totals.scans += scans ?? 0;
    totals.credits += used?.credits ?? 0;
    totals.fusion += used?.fusion ?? 0;
  });
  return { period: span, days, readAt: new Date().toISOString(), creditsKnown: rows !== null, projects: out, totals };
}
