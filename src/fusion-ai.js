/**
 * Fusion results (Labs): the Risk Hub list of each project whose latest scan ran the AI engine ("ai" among its
 * engines), as Checkmarx One's Risk Hub shows it: a Fusion scan (Fusion on in the scan's settings) or a LAST scan
 * (Fusion off: LLM-based scanning alone).
 *
 *   - The risks: the same Risk Hub API the Workbench reads (GET /api/risks/?projectId=…, src/cxone/risks.js), every
 *     scanner (SAST, SCA, IaC, API Security…), each with its severity, state, where it is, its ids and its status as
 *     Risk Hub gives it: New, Recurrent or Fixed.
 *   - What the AI engine found among them: GET /api/sast-results?scan-id=…&is-ai-generated=1 (the results Checkmarx
 *     One marks `isAiGenerated`, "LLM-Based: Yes"), matched to the risks by id; they bring their language, CWE,
 *     source and sink. A risk that says `isAiGenerated` itself counts too.
 * Only what the AI engine reported is kept (from MZ-01.00.95): the page is about the AI engine, so the traditional
 * engines' risks are left out, and so is a project whose latest scan's AI engine reported nothing (LAST on by
 * default, nothing scanned by AI). A Fusion scan's AI results are Fusion's, except those in a language the
 * traditional SAST engine does not support (src/sast-languages.js): LAST's (language-agnostic static testing); a
 * LAST scan's are LAST's. Each keeps the description Checkmarx One gives it. Read-only: nothing starts a scan.
 */
import { mapWithConcurrency } from './cxone/client.js';
import { isProbeMiss } from './cxone/discovery.js';
import { normalizeRisk } from './cxone/risks.js';
import { sastCoverage } from './sast-languages.js';
import { scanTypeOf } from './fusion-usage.js';

export const AI_FILTER = { 'is-ai-generated': 1, 'is-ai-generated-operation': 'EQUAL' };
export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
/** Risk Hub's states: To verify (each new risk's), Confirmed, Proposed not exploitable, Not exploitable, Urgent. */
export const STATES = ['TO_VERIFY', 'CONFIRMED', 'PROPOSED_NOT_EXPLOITABLE', 'NOT_EXPLOITABLE', 'URGENT'];
/** LAST: found by the AI engine in a language only it covers; Fusion: every other risk of a Fusion scan. */
export const ENGINES = ['FUSION', 'LAST'];
/** ['fusion', 'LAST', 'x'] → ['FUSION', 'LAST']; none (or nothing known) → both. */
export const cleanEngines = (v) => {
  const list = (Array.isArray(v) ? v : String(v ?? '').split(',')).map((e) => String(e).trim().toUpperCase()).filter((e) => ENGINES.includes(e));
  return list.length ? ENGINES.filter((e) => list.includes(e)) : [...ENGINES];
};
const PAGE = 500;
const MAX_PAGES = 40;
/** At most this many results are kept to list per read; the counts cover them all. */
export const MAX_LISTED = 5000;

const text = (v, max = 400) => (v === null || v === undefined ? '' : String(v).slice(0, max));
const upper = (v) => text(v, 40).trim().toUpperCase();
const iso = (v) => {
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const scanIdOf = (scan) => text(scan?.id ?? scan?.scanId, 80);
/** Text out of what may be HTML (a description), on one line, at most `max` long. */
const plain = (v, max = 2000) => text(String(v ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim(), max);

/** One AI-generated SAST result, as the results page shows it. */
export function cleanAiResult(r, project, scanId) {
  const nodes = Array.isArray(r?.nodes) ? r.nodes : [];
  const first = nodes[0] ?? {};
  const last = nodes[nodes.length - 1] ?? {};
  const severity = upper(r?.severity);
  const language = text(r?.languageName ?? r?.language, 60);
  const covered = sastCoverage({ language, group: r?.group, file: first.fileName });
  return {
    projectId: text(project.id, 80),
    projectName: text(project.name, 200),
    scanId: text(scanId, 80),
    resultId: text(r?.resultHash ?? r?.id ?? r?.pathSystemID, 200),
    hash: text(r?.resultHash, 120),
    similarityId: text(r?.similarityID ?? r?.similarityId, 40),
    name: text(r?.queryName ?? r?.query, 300).replace(/_/g, ' '),
    severity: SEVERITIES.includes(severity) ? severity : 'INFO',
    status: upper(r?.status),
    state: upper(r?.state),
    language,
    engine: covered ? 'FUSION' : 'LAST',
    // What the traditional engine supports it as: its language, or the framework it was named by.
    coveredAs: covered ? text(covered.framework ?? covered.language, 60) : '',
    cwe: Number.isFinite(Number(r?.cweID ?? r?.cweId)) && Number(r?.cweID ?? r?.cweId) > 0 ? Number(r?.cweID ?? r?.cweId) : null,
    group: text(r?.group, 120),
    sourceFile: text(first.fileName, 400),
    sourceLine: Number.isFinite(Number(first.line)) ? Number(first.line) : null,
    sourceNode: text(first.name, 200),
    sinkFile: text(last.fileName, 400),
    sinkLine: Number.isFinite(Number(last.line)) ? Number(last.line) : null,
    sinkNode: text(last.name, 200),
    nodes: nodes.length,
    firstFoundAt: iso(r?.firstFoundAt),
    foundAt: iso(r?.foundAt),
    confidence: Number.isFinite(Number(r?.confidenceLevel)) ? Number(r.confidenceLevel) : null,
    // What it is and why, as Checkmarx One words it for this result (the AI engine's own explanation), when it does.
    description: plain(r?.description ?? r?.resultDescription ?? r?.data?.description ?? r?.explanation),
    queryId: text(r?.queryIDStr ?? r?.queryID ?? r?.queryId, 40),
    // Only those Checkmarx One says the AI engine found: the filter asks for them, and each must say so itself
    // (a Checkmarx One that ignored the filter would otherwise pass every SAST result off as Fusion's).
    ai: r?.isAiGenerated === true || r?.isAiGenerated === 1 || r?.isAiGenerated === 'true',
    marked: r?.isAiGenerated !== undefined && r?.isAiGenerated !== null,
  };
}

/** Every AI-generated SAST result of one scan, page by page. */
async function aiResults(client, scanId, trace) {
  const out = [];
  const seen = new Set();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await client.request('/api/sast-results', { query: { 'scan-id': scanId, ...AI_FILTER, limit: PAGE, offset: out.length, 'include-nodes': true }, retries: 1, background: true, trace });
    const rows = Array.isArray(body?.results) ? body.results : [];
    let fresh = 0;
    for (const r of rows) {
      const key = String(r?.resultHash ?? r?.id ?? out.length);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      fresh += 1;
    }
    const total = Number(body?.totalCount);
    if (!fresh || (Number.isFinite(total) && out.length >= total)) break;
  }
  return out;
}

/** A Risk Hub risk as the page lists it, with what the AI engine's own result (when it found it) adds. */
export function cleanRisk(raw, project, scanId, ai = null, scanType = 'fusion') {
  const r = normalizeRisk(raw, project);
  const marked = raw?.isAiGenerated === true || raw?.isAiGenerated === 'true' || raw?.isAiGenerated === 1;
  const found = Boolean(ai) || marked;
  const language = text(ai?.language || raw?.languageName || raw?.language, 60);
  const covered = found ? sastCoverage({ language, group: raw?.group, file: ai?.sourceFile || raw?.fileName || raw?.assetName }) : null;
  const severity = upper(r.severity);
  return {
    projectId: r.projectId,
    projectName: r.projectName,
    scanId: text(r.scanId || scanId, 80),
    resultId: text(r.riskId, 200),
    riskId: text(r.riskId, 200),
    hash: text(r.alternateId || ai?.hash || r.riskId, 200),
    alternateId: text(r.alternateId, 200),
    similarityId: text(r.similarityId || ai?.similarityId, 80),
    groupId: text(r.groupId, 400),
    packageIdentifier: text(r.packageIdentifier, 300),
    scanner: text(r.scanner, 40),
    name: text(r.title, 300).replace(/_/g, ' '),
    severity: SEVERITIES.includes(severity) ? severity : 'INFO',
    // New, Recurrent or Fixed: Risk Hub's own word for it.
    status: upper(r.status),
    state: upper(r.state),
    language,
    ai: found,
    // Set by AI Triage (Risk Hub's stateChangedBy "ai").
    aiTriaged: String(raw?.stateChangedBy ?? '').toLowerCase() === 'ai',
    // A LAST scan's risks are all LAST's; a Fusion scan's are Fusion's, but for what the AI engine found in a
    // language only it covers.
    engine: scanType === 'last' || (found && !covered) ? 'LAST' : 'FUSION',
    coveredAs: covered ? text(covered.framework ?? covered.language, 60) : '',
    cwe: Number(r.cweId) > 0 ? Number(r.cweId) : ai?.cwe ?? null,
    location: text(r.location, 400),
    sourceFile: ai?.sourceFile ?? '',
    sourceLine: ai?.sourceLine ?? null,
    sourceNode: ai?.sourceNode ?? '',
    sinkFile: ai?.sinkFile ?? '',
    sinkLine: ai?.sinkLine ?? null,
    sinkNode: ai?.sinkNode ?? '',
    firstFoundAt: r.firstDetectedAt ?? ai?.firstFoundAt ?? null,
    foundAt: ai?.foundAt ?? null,
    description: ai?.description || plain(raw?.description),
    queryId: ai?.queryId ?? '',
  };
}

/** An AI result Risk Hub did not list (or not by an id it gives): listed from the SAST result itself. */
export function riskFromAi(ai, scanType = 'fusion') {
  return {
    ...ai,
    riskId: ai.resultId,
    alternateId: ai.hash,
    groupId: '',
    packageIdentifier: '',
    scanner: 'SAST',
    ai: true,
    aiTriaged: false,
    engine: scanType === 'last' ? 'LAST' : ai.engine,
    location: ai.sourceFile,
  };
}

/** Checkmarx One's description of each query (GET /api/queries/descriptions?ids=…), for results that bring none. */
async function queryDescriptions(client, ids, trace) {
  const out = new Map();
  const wanted = [...new Set(ids.filter((id) => id && id !== '0'))];
  for (let i = 0; i < wanted.length; i += 50) {
    const body = await client.request('/api/queries/descriptions', { query: { ids: wanted.slice(i, i + 50) }, retries: 0, background: true, trace }).catch(() => null);
    for (const d of Array.isArray(body) ? body : Array.isArray(body?.descriptions) ? body.descriptions : []) {
      const said = plain(d?.resultDescription ?? d?.description ?? d?.risk);
      if (said) out.set(String(d?.queryId ?? d?.id ?? ''), said);
    }
  }
  return out;
}

const COUNTED = [...SEVERITIES, 'total', 'NEW', 'RECURRENT', 'FIXED', ...STATES, 'aiFound', 'aiTriaged'];
const emptyCounts = () => Object.fromEntries(COUNTED.map((k) => [k, 0]));
/** Whether a scan ran the AI engine (a Fusion or a LAST scan). */
export const isFusionScan = (engines) => (Array.isArray(engines) ? engines : []).some((e) => String(e).toLowerCase() === 'ai');
/** Fixed in Risk Hub: counted as fixed, not among the open ones. */
export const isFixed = (r) => r?.status === 'FIXED';

/**
 * Read Fusion for `projects` ([{ id, name }]) whose latest completed scan (`scans`: { projectId: scan }, as
 * getLastScans gives) ran the AI engine (`types`: { projectId: 'fusion' | 'last' | 'none' }, from each scan's
 * settings; or `engines`: { projectId: [engine…] }, every AI scan then taken as Fusion), with `riskSource`
 * (createRiskSource: the Workbench's Risk Hub reader). Returns the counts per project and overall (the open ones by
 * severity and by state; New, Recurrent and Fixed as Risk Hub says), Fusion's and LAST's apart in `engines`, and
 * every risk to list, each saying whose it is (`engine`).
 */
export async function readRiskFusion(client, projects, scans, { types = null, engines = {}, riskSource, concurrency = 4, trace = null } = {}) {
  const readAt = new Date().toISOString();
  const typeOf = (id) => types?.[id] ?? scanTypeOf(Array.isArray(engines[id]) ? engines[id] : [], null);
  const withScan = projects.filter((p) => scanIdOf(scans?.[p.id]));
  const fusionScanned = withScan.filter((p) => typeOf(p.id) !== 'none');
  const failures = [];
  const per = await mapWithConcurrency(fusionScanned, concurrency, async (project) => {
    const scan = scans[project.id];
    const scanId = scanIdOf(scan);
    try {
      const [raw, aiRows] = await Promise.all([
        riskSource.fetchForProject(project),
        aiResults(client, scanId, trace).catch((error) => (isProbeMiss(error) || error.status === 400 ? [] : Promise.reject(error))),
      ]);
      // The AI engine's own results, by every id a risk may carry for them.
      const found = new Map();
      for (const row of aiRows) {
        const ai = cleanAiResult(row, project, scanId);
        if (!ai.ai) continue;
        for (const key of [ai.hash, ai.resultId]) if (key) found.set(key, ai);
      }
      // Only the AI engine's: the risks it reported, then its results Risk Hub did not list by any id they carry.
      const used = new Set();
      const results = raw
        .map((item) => {
          const ai = found.get(String(item?.id ?? item?.riskId ?? '')) ?? found.get(String(item?.alternateId ?? '')) ?? null;
          if (ai) used.add(ai);
          return cleanRisk(item, project, scanId, ai, typeOf(project.id));
        })
        .filter((r) => r.resultId && r.ai);
      for (const ai of new Set(found.values())) if (!used.has(ai)) results.push(riskFromAi(ai, typeOf(project.id)));
      return { project, scanId, scanAt: iso(scan.updatedAt ?? scan.createdAt), results };
    } catch (error) {
      failures.push({ projectId: project.id, status: error.status ?? 0, message: text(error.message, 200) });
      return { project, scanId, results: [], error: true };
    }
  });
  // Descriptions for the results that came without one, by their query (not the AI engine's own, which have none).
  const missing = per.flatMap((p) => p.results.filter((r) => !r.description && r.queryId).map((r) => r.queryId));
  if (missing.length) {
    const described = await queryDescriptions(client, missing, trace);
    for (const p of per) for (const r of p.results) if (!r.description && described.has(r.queryId)) r.description = described.get(r.queryId);
  }
  const totals = { ...emptyCounts(), engines: { FUSION: emptyCounts(), LAST: emptyCounts() } };
  const byProject = {};
  const results = [];
  // Left out: a latest scan whose AI engine reported nothing (LAST on by default, no AI results).
  let noAi = 0;
  for (const p of per) {
    if (!p.error && !p.results.length) {
      noAi += 1;
      continue;
    }
    const counts = { FUSION: emptyCounts(), LAST: emptyCounts() };
    const scanners = {};
    for (const r of p.results) {
      const e = counts[r.engine];
      if (isFixed(r)) {
        e.FIXED += 1;
        continue;
      }
      e[r.severity] += 1;
      if (r.status === 'NEW' || r.status === 'RECURRENT') e[r.status] += 1;
      e[STATES.includes(r.state) ? r.state : 'TO_VERIFY'] += 1;
      if (r.ai) e.aiFound += 1;
      if (r.aiTriaged) e.aiTriaged += 1;
      scanners[r.scanner || 'OTHER'] = (scanners[r.scanner || 'OTHER'] ?? 0) + 1;
    }
    for (const engine of ENGINES) {
      counts[engine].total = SEVERITIES.reduce((n, s) => n + counts[engine][s], 0);
      counts[engine].fixedKnown = true;
    }
    const c = { ...emptyCounts(), projectName: p.project.name, scanId: p.scanId, scanAt: p.scanAt ?? null, scanType: typeOf(p.project.id), error: Boolean(p.error), engines: counts, scanners, fixedKnown: true };
    for (const k of COUNTED) c[k] = counts.FUSION[k] + counts.LAST[k];
    byProject[p.project.id] = c;
    for (const k of COUNTED) {
      totals[k] += c[k];
      for (const engine of ENGINES) totals.engines[engine][k] += counts[engine][k];
    }
    results.push(...p.results);
  }
  const RANK = { CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 };
  results.sort((a, b) => isFixed(a) - isFixed(b) || RANK[b.severity] - RANK[a.severity] || String(b.firstFoundAt ?? '').localeCompare(String(a.firstFoundAt ?? '')));
  return {
    readAt,
    available: true,
    source: 'risk-hub',
    scanned: fusionScanned.length,
    // How many of them were Fusion scans, and how many LAST scans.
    kinds: { fusion: Object.values(byProject).filter((p) => p.scanType === 'fusion').length, last: Object.values(byProject).filter((p) => p.scanType === 'last').length },
    // Whose latest scan ran the AI engine but it reported nothing: left out, and said.
    noAi,
    noScan: projects.length - withScan.length,
    // Projects whose latest scan did not run the AI engine: left out, and said.
    notFusion: withScan.length - fusionScanned.length,
    failures,
    projects: byProject,
    totals,
    listed: Math.min(results.length, MAX_LISTED),
    results: results.slice(0, MAX_LISTED),
  };
}

/**
 * The open risks as findings the Workbench's credit, triage and remediation code works on: one project entry per
 * project, each risk with Risk Hub's ids, so allocation, AI Triage and AI Remediation treat them as they do there.
 */
export function aiFindings(fusion) {
  const projects = new Map();
  for (const r of fusion?.results ?? []) {
    if (isFixed(r)) continue;
    const p = projects.get(r.projectId) ?? { projectId: r.projectId, projectName: r.projectName, risks: [], scanId: r.scanId };
    p.risks.push({
      id: r.resultId,
      riskId: r.riskId || r.resultId,
      alternateId: r.alternateId || r.hash || r.resultId,
      similarityId: r.similarityId,
      groupId: r.groupId ?? '',
      packageIdentifier: r.packageIdentifier ?? '',
      scanId: r.scanId,
      projectId: r.projectId,
      projectName: r.projectName,
      scanner: r.scanner || 'SAST',
      severity: r.severity,
      state: r.state,
      status: r.status,
      title: r.name,
      firstDetectedAt: r.firstFoundAt,
      location: r.location || r.sourceFile,
      engine: r.engine,
    });
    projects.set(r.projectId, p);
  }
  return {
    projects: [...projects.values()],
    initiators: Object.fromEntries([...projects.values()].map((p) => [p.projectId, { scanId: p.scanId }])),
  };
}
