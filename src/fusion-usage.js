/**
 * What each Fusion project's scans used (Labs → Fusion results): the model its latest Fusion scan ran with,
 * its lines of code, how many AI scans it had over a period, and the Checkmarx One credits it used then.
 *
 *   - Scan type: Fusion when the latest scan ran the AI engine with Fusion on (scan.config.ai.fusionEnabled, in the
 *     scan's own settings), LAST when it ran it with Fusion off (LLM-based scanning), none otherwise.
 *   - Model: the latest scan's own configuration when it says (`llmModel`); else what Checkmarx One resolved for
 *     that scan (GET /api/configuration/scan), with where it was set: the project, the tenant, or Checkmarx One's
 *     own ("Environment"). Each is said with where it came from.
 *   - What the AI added: the scan's steps (GET /api/scans/{id}/workflow): "Deduplicated 47 out of 273 total
 *     results" is 273 found, 47 already found by the traditional engine, 226 added.
 *   - Lines of code and files: the latest scan's SAST details and metadata (GET /api/sast-metadata?scan-ids=…).
 *   - AI scans: the completed scans over the period that ran the AI engine, Fusion's and LAST's apart.
 *   - The tenant's credits (GET /api/credits/info) and AI settings (GET /api/configuration/tenant).
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
const FUSION_KEY = 'scan.config.ai.fusionEnabled';
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
  return text(configEntry(body, MODEL_KEY)?.value, 60);
}

/** One setting of a configuration answer (a list of entries, or { configEntries }). */
function configEntry(body, key) {
  const entries = Array.isArray(body) ? body : Array.isArray(body?.configEntries) ? body.configEntries : [];
  return entries.find((e) => e?.key === key) ?? null;
}

const quiet = async (fn) => {
  try {
    return await fn();
  } catch (error) {
    if (isProbeMiss(error) || [400, 401, 403].includes(error.status)) return null;
    throw error;
  }
};

/** 'true' / true → true, 'false' / false → false, anything else → null (not said). */
const flag = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);
/** Where Checkmarx One says a scan's setting came from: the scan, the project, the tenant, or its own (Environment). */
const ORIGINS = { scan: 'scan', project: 'project', tenant: 'tenant', environment: 'environment' };
const originOf = (v) => ORIGINS[String(v ?? '').trim().toLowerCase()] ?? '';
/** The AI part of a scan's own configuration (metadata.configs, type "ai"): { llmModel, fusionEnabled }. */
export function scanAiConfig(scan) {
  const configs = Array.isArray(scan?.metadata?.configs) ? scan.metadata.configs : [];
  const ai = configs.find((c) => String(c?.type ?? '').toLowerCase() === 'ai')?.value;
  return ai && typeof ai === 'object' ? ai : null;
}

/**
 * What kind of scan it was: 'fusion' when the AI engine ran with Fusion on (scan.config.ai.fusionEnabled), 'last'
 * when it ran with Fusion off (LLM-based scanning, LAST's), 'none' when it did not run. A scan that does not say
 * whether Fusion was on is taken as Fusion, as earlier versions took every AI scan.
 */
export function scanTypeOf(engines, fusionEnabled) {
  const ran = !Array.isArray(engines) || engines.some((e) => String(e).toLowerCase() === 'ai');
  if (!ran) return 'none';
  return fusionEnabled === false ? 'last' : 'fusion';
}

/**
 * What a scan's steps say (GET /api/scans/{id}/workflow): which AI worker ran ("last-worker-fusion" for Fusion,
 * "last-worker" for LAST), how many results the AI engine found and how many of them the traditional engine had
 * already found ("Deduplicated 47 out of 273 total results"), and whether Fusion credits were reserved for it.
 */
export function readSteps(steps) {
  const out = { worker: '', aiFound: null, aiDuplicates: null, aiAdded: null, fusionCredits: '' };
  for (const step of Array.isArray(steps) ? steps : []) {
    const source = String(step?.Source ?? step?.source ?? '').toLowerCase();
    const info = String(step?.Info ?? step?.info ?? '');
    if (/^last-worker-fusion/.test(source)) out.worker = 'fusion';
    else if (/^last-worker/.test(source) && !out.worker) out.worker = 'last';
    const dedup = /deduplicated\s+(\d+)\s+out\s+of\s+(\d+)/i.exec(info);
    if (dedup) {
      out.aiDuplicates = Number(dedup[1]);
      out.aiFound = Number(dedup[2]);
      out.aiAdded = Math.max(0, out.aiFound - out.aiDuplicates);
    }
    if (/^checkmarx-fusion-credit/.test(source)) {
      if (/credits are disabled|skipping credit/i.test(info)) out.fusionCredits = 'off';
      else if (!out.fusionCredits && /reserv|seiz/i.test(info) && !/started|ended/i.test(info)) out.fusionCredits = 'reserved';
    }
  }
  return out;
}

/**
 * Each project's latest scan (`scans`: { projectId: scan }, as getLastScans gives): what kind of scan it was
 * (scanType: 'fusion' | 'last' | 'none'), the model it ran with and where that was set (modelFrom: 'scan',
 * 'project', 'tenant' or 'environment', Checkmarx One's own), its lines of code and files, the SAST engine's
 * version, its engines, and what its steps say the AI engine added. The scan's settings and steps are read only for
 * a scan that ran the AI engine.
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
    const own = scanAiConfig(scan);
    let fusionEnabled = flag(own?.fusionEnabled);
    let model = modelIn(own) || modelIn(scan?.metadata ?? scan?.config ?? null);
    let modelFrom = model ? 'scan' : '';
    const engines = Array.isArray(scan?.engines) ? scan.engines : null;
    const ranAi = !engines || engines.some((e) => String(e).toLowerCase() === 'ai');
    let steps = null;
    if (scanId && ranAi) {
      // What the scan ran with, as Checkmarx One resolves it (scan, project, tenant or its own default), and its steps.
      const [settings, workflow] = await Promise.all([
        model && fusionEnabled !== null ? null : quiet(() => client.request('/api/configuration/scan', { query: { 'project-id': projectId, 'scan-id': scanId }, retries: 1, background: true, trace })),
        quiet(() => client.request(`/api/scans/${encodeURIComponent(scanId)}/workflow`, { retries: 1, background: true, trace })),
      ]);
      const entry = configEntry(settings, MODEL_KEY);
      if (!model && text(entry?.value)) {
        model = text(entry.value, 60);
        modelFrom = originOf(entry.originLevel) || 'scan';
      }
      if (fusionEnabled === null) fusionEnabled = flag(configEntry(settings, FUSION_KEY)?.value);
      steps = readSteps(workflow);
      // A scan that says neither way: its AI worker does.
      if (fusionEnabled === null && steps.worker) fusionEnabled = steps.worker === 'fusion';
      if (!model && !settings) {
        model = configModel(await quiet(() => client.request('/api/configuration/project', { query: { 'project-id': projectId }, retries: 1, background: true, trace })));
        modelFrom = model ? 'project' : '';
        if (!model) {
          model = await tenant();
          modelFrom = model ? 'tenant' : '';
        }
      }
    }
    out[projectId] = {
      scanType: scan ? scanTypeOf(engines, fusionEnabled) : 'none',
      fusionEnabled,
      model,
      modelFrom,
      loc: whole(sast?.loc),
      files: null,
      engineVersion: '',
      scanEngines: engines ? engines.map((e) => text(e, 40)) : [],
      aiReported: steps?.aiFound ?? null,
      aiDuplicates: steps?.aiDuplicates ?? null,
      aiAdded: steps?.aiAdded ?? null,
      fusionCredits: steps?.fusionCredits ?? '',
    };
  });
  // Files and the SAST engine's version, for every AI scan at once (a few scans to a call).
  const ai = projectIds.filter((id) => out[id] && out[id].scanType !== 'none');
  for (let i = 0; i < ai.length; i += 50) {
    const batch = ai.slice(i, i + 50);
    const byScan = new Map(batch.map((id) => [text(scans[id]?.id ?? scans[id]?.scanId, 80), id]));
    const ids = [...byScan.keys()].filter(Boolean);
    if (!ids.length) continue;
    const [meta, versions] = await Promise.all([
      quiet(() => client.request('/api/sast-metadata', { query: { 'scan-ids': ids }, retries: 1, background: true, trace })),
      quiet(() => client.request('/api/sast-metadata/engine-version', { query: { 'scan-ids': ids }, retries: 1, background: true, trace })),
    ]);
    for (const m of Array.isArray(meta?.scans) ? meta.scans : []) {
      const f = out[byScan.get(text(m?.scanId, 80))];
      if (!f) continue;
      f.files = whole(m.fileCount);
      f.loc ??= whole(m.loc);
    }
    for (const v of Array.isArray(versions) ? versions : []) {
      const f = out[byScan.get(text(v?.scanId, 80))];
      if (f) f.engineVersion = text(v.engineVersion, 40);
    }
  }
  return out;
}

/**
 * What kind of scan each project's latest scan was (`scans`: { projectId: scan }): { projectId: 'fusion' | 'last' |
 * 'none' }. A scan whose engines say no AI is 'none' without asking; the others are read a hundred at a time
 * (GET /api/scans?scan-ids=…) for their own AI settings. Projects Checkmarx One does not answer for are left out.
 */
export async function scanTypes(client, scans, { concurrency = 4, background = true, trace = null } = {}) {
  const out = {};
  const ask = [];
  for (const [projectId, scan] of Object.entries(scans ?? {})) {
    const id = text(scan?.id ?? scan?.scanId, 80);
    if (!id) continue;
    if (Array.isArray(scan.engines) && scanAiConfig(scan)) out[projectId] = scanTypeOf(scan.engines, flag(scanAiConfig(scan).fusionEnabled));
    else if (Array.isArray(scan.engines) && !scan.engines.some((e) => String(e).toLowerCase() === 'ai')) out[projectId] = 'none';
    else ask.push([id, projectId]);
  }
  const batches = [];
  for (let i = 0; i < ask.length; i += 100) batches.push(ask.slice(i, i + 100));
  await mapWithConcurrency(batches, concurrency, async (batch) => {
    const byScan = new Map(batch);
    const body = await quiet(() => client.request('/api/scans', { query: { 'scan-ids': [...byScan.keys()], limit: batch.length, offset: 0 }, retries: 1, background, trace }));
    for (const scan of Array.isArray(body?.scans) ? body.scans : []) {
      const projectId = byScan.get(text(scan?.id, 80));
      if (!projectId || !Array.isArray(scan.engines)) continue;
      out[projectId] = scanTypeOf(scan.engines, flag(scanAiConfig(scan)?.fusionEnabled));
    }
  });
  return out;
}

/**
 * The tenant's Checkmarx One credits (GET /api/credits/info): { available, total, used, actionsAvailable,
 * actionsPerformed, state, readAt }, or null when it does not answer.
 */
export async function tenantCredits(client, { background = true, trace = null } = {}) {
  const body = await quiet(() => client.request('/api/credits/info', { retries: 1, background, trace }));
  const n = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Number(v));
  const available = n(body?.available);
  if (available === null) return null;
  return {
    available,
    total: n(body.total),
    used: n(body.used),
    actionsAvailable: n(body.actionsAvailable),
    actionsPerformed: n(body.actionsPerformed),
    state: text(body.enforcement?.state, 30),
    readAt: new Date().toISOString(),
  };
}

/**
 * The tenant's AI settings (GET /api/configuration/tenant): Fusion on, LLM-based scanning on, the model it sets
 * (often none: Checkmarx One's own then) and the models it offers. Null when it does not answer.
 */
export async function tenantAi(client, { trace = null } = {}) {
  const body = await quiet(() => client.request('/api/configuration/tenant', { retries: 1, background: true, trace }));
  if (!body) return null;
  const model = configEntry(body, MODEL_KEY);
  return {
    fusionEnabled: flag(configEntry(body, FUSION_KEY)?.value),
    llmBased: flag(configEntry(body, 'scan.config.sast.extendedAnalysis')?.value),
    model: text(model?.value, 60),
    models: modelChoices(model),
  };
}

/** The models a "LLM Model" setting offers (its valuetypeparams: "opus-4.7,haiku-4.5,…"). */
export function modelChoices(entry) {
  return [...new Set(String(entry?.valuetypeparams ?? '').split(',').map((m) => text(m, 60).trim()).filter(Boolean))].slice(0, 20);
}

/** How a scan in a list counts: { ai, fusion, last } (0 or 1 each), by its engines and its own AI settings. */
function scanKind(scan) {
  const type = scanTypeOf(Array.isArray(scan?.engines) ? scan.engines : [], flag(scanAiConfig(scan)?.fusionEnabled));
  return { ai: type === 'none' ? 0 : 1, fusion: type === 'fusion' ? 1 : 0, last: type === 'last' ? 1 : 0 };
}

/** A project's completed scans over the period that ran the AI engine, Fusion's and LAST's apart (all completed ones when none says its engines). */
async function aiScans(client, projectId, days, trace) {
  const from = new Date(Date.now() - days * 86400000).toISOString();
  const body = await quiet(() => client.request('/api/scans', { query: { 'project-id': projectId, statuses: 'Completed', 'from-date': from, limit: 1000 }, retries: 1, background: true, trace }));
  if (!body) return null;
  const list = (Array.isArray(body?.scans) ? body.scans : []).filter((s) => !s.createdAt || Date.parse(s.createdAt) >= Date.parse(from));
  if (!list.some((s) => Array.isArray(s.engines))) return { ai: list.length, fusion: list.length, last: 0 };
  return list.reduce((n, s) => {
    const k = scanKind(s);
    return { ai: n.ai + k.ai, fusion: n.fusion + k.fusion, last: n.last + k.last };
  }, { ai: 0, fusion: 0, last: 0 });
}

const SCAN_PAGE = 500;
const SCAN_PAGES = 40;
/**
 * The tenant's completed scans over the period, every project at once (GET /api/scans?from-date=…), as
 * { projectId: { ai, fusion, last } }; null when Checkmarx One does not answer, or holds more than this reads.
 */
async function periodScans(client, days, trace) {
  const from = new Date(Date.now() - days * 86400000).toISOString();
  const out = {};
  for (let page = 0; page < SCAN_PAGES; page += 1) {
    const body = await quiet(() => client.request('/api/scans', { query: { statuses: 'Completed', 'from-date': from, limit: SCAN_PAGE, offset: page * SCAN_PAGE }, retries: 1, background: true, trace }));
    if (!body) return null;
    const list = Array.isArray(body?.scans) ? body.scans : [];
    for (const s of list) {
      const id = text(s?.projectId, 80);
      if (!id || (s.createdAt && Date.parse(s.createdAt) < Date.parse(from))) continue;
      const k = scanKind(s);
      const n = (out[id] ??= { ai: 0, fusion: 0, last: 0 });
      n.ai += k.ai;
      n.fusion += k.fusion;
      n.last += k.last;
    }
    const total = Number(body?.filteredTotalCount ?? body?.totalCount);
    if (list.length < SCAN_PAGE || (Number.isFinite(total) && (page + 1) * SCAN_PAGE >= total)) return out;
  }
  return null;
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
 * { period, days, readAt, creditsKnown, projects: { id: { scans, fusionScans, lastScans, credits, fusion, actions,
 * perScan } }, totals, scope }. With `scopeIds` (every project the page's line covers), `scope` says how many of
 * them had a Fusion scan, and how many a LAST scan, over the period (null when the tenant's scans cannot be read).
 */
export async function fusionUsage(client, projects, { period = DEFAULT_PERIOD, scopeIds = null, concurrency = 4, trace = null } = {}) {
  const span = USAGE_PERIODS[period] ? period : DEFAULT_PERIOD;
  const days = USAGE_PERIODS[span];
  const [tenantWide, rows] = await Promise.all([periodScans(client, days, trace), consumption(client, span, trace)]);
  // Each project's own scans when the tenant's list cannot be read.
  const counts = tenantWide ? projects.map((p) => tenantWide[p.id] ?? { ai: 0, fusion: 0, last: 0 }) : await mapWithConcurrency(projects, concurrency, (p) => aiScans(client, p.id, days, trace));
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
  const totals = { scans: 0, fusionScans: 0, lastScans: 0, credits: 0, fusion: 0 };
  projects.forEach((p, i) => {
    const item = byId.get(p.id) ?? byName.get(norm(p.name));
    const used = rows ? (item ? usageRow(item) : { credits: 0, fusion: 0, actions: { triage: 0, remediation: 0, other: 0 } }) : null;
    const scans = counts[i]?.ai ?? null;
    out[p.id] = { scans, fusionScans: counts[i]?.fusion ?? null, lastScans: counts[i]?.last ?? null, credits: used?.credits ?? null, fusion: used?.fusion ?? null, actions: used?.actions ?? null, perScan: used && scans ? Math.round((used.fusion / scans) * 10) / 10 : null };
    totals.scans += scans ?? 0;
    totals.fusionScans += counts[i]?.fusion ?? 0;
    totals.lastScans += counts[i]?.last ?? 0;
    totals.credits += used?.credits ?? 0;
    totals.fusion += used?.fusion ?? 0;
  });
  const ids = scopeIds ?? projects.map((p) => p.id);
  const scope = tenantWide ? { projects: ids.length, withFusion: ids.filter((id) => tenantWide[id]?.fusion > 0).length, withLast: ids.filter((id) => tenantWide[id]?.last > 0).length } : null;
  return { period: span, days, readAt: new Date().toISOString(), creditsKnown: rows !== null, projects: out, totals, scope };
}
