/**
 * Fusion results (Labs): what Checkmarx One's AI engine found in SAST, read per project from its latest scan.
 *
 * Checkmarx One marks these SAST results `isAiGenerated` (the "LAST" engine), and its SAST endpoints take the
 * filter `is-ai-generated=1` (`is-ai-generated-operation=EQUAL` where operations apply):
 *   - GET /api/sast-results?scan-id=…            every result of the scan, here only the AI-generated ones;
 *   - GET /api/sast-scan-summary/aggregate        the scan's AI-generated results counted by severity;
 *   - GET /api/sast-scan-summary/compare/aggregate  against the scan before: how many were fixed since.
 * Each result keeps what the Checkmarx One results page shows: severity, the vulnerability (query), status
 * (New, Recurrent), state, language, CWE, source and sink, first and last found, and its hash, which opens it
 * in Risk Hub. Read-only: nothing here starts a scan.
 *
 * Each result is Fusion's or LAST's (src/sast-languages.js): Fusion when the traditional SAST engine supports its
 * language or framework too, LAST (language-agnostic static testing) when the AI engine alone covers it.
 */
import { mapWithConcurrency } from './cxone/client.js';
import { isProbeMiss } from './cxone/discovery.js';
import { sastCoverage } from './sast-languages.js';

export const AI_FILTER = { 'is-ai-generated': 1, 'is-ai-generated-operation': 'EQUAL' };
export const SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];
/** Fusion: the traditional SAST engine supports the language too; LAST: the AI engine alone. */
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

/** The scan's AI-generated results by severity, as Checkmarx One counts them (null when it cannot say). */
async function aiSeverityCounts(client, scanId, trace) {
  try {
    const body = await client.request('/api/sast-scan-summary/aggregate', { query: { 'scan-id': scanId, 'group-by-field': 'SEVERITY', ...AI_FILTER, limit: 100 }, retries: 1, background: true, trace });
    const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
    for (const s of Array.isArray(body?.summaries) ? body.summaries : []) {
      const sev = upper(s?.severity);
      if (sev in counts) counts[sev] += Number(s?.count) || 0;
    }
    return counts;
  } catch (error) {
    if (isProbeMiss(error) || error.status === 400) return null;
    throw error;
  }
}

/** The completed scan before `latestId` (newest first), to compare with; null when there is none. */
async function previousScan(client, projectId, latestId, trace) {
  try {
    const body = await client.request('/api/scans', { query: { 'project-id': projectId, statuses: 'Completed', sort: '-created_at', limit: 5 }, retries: 1, background: true, trace });
    const scans = (Array.isArray(body?.scans) ? body.scans : []).filter((s) => (!s.status || s.status === 'Completed') && scanIdOf(s) && scanIdOf(s) !== latestId);
    scans.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
    return scans[0] ?? null;
  } catch (error) {
    if (isProbeMiss(error)) return null;
    throw error;
  }
}

/**
 * How many AI-generated results the latest scan fixed against the scan before, Fusion's and LAST's apart
 * (grouped by language): { FUSION, LAST }, either null when it cannot say; null when there is nothing to compare.
 */
async function aiFixed(client, scanId, baseScanId, trace) {
  if (!baseScanId) return null;
  try {
    const body = await client.request('/api/sast-scan-summary/compare/aggregate', { query: { 'scan-id': scanId, 'base-scan-id': baseScanId, 'group-by-field': 'LANGUAGE', 'is-ai-generated': 1, status: 'FIXED', limit: 10000 }, retries: 1, background: true, trace });
    const rows = Array.isArray(body?.summaries) ? body.summaries : [];
    const fixed = { FUSION: 0, LAST: 0 };
    let unnamed = 0;
    for (const s of rows) {
      const n = Number(s?.count) || 0;
      const language = s?.language ?? s?.languageName ?? s?.lang;
      if (!language) unnamed += n;
      else fixed[sastCoverage({ language }) ? 'FUSION' : 'LAST'] += n;
    }
    // Counts that do not say their language cannot be told apart: neither figure is known then.
    return unnamed ? { FUSION: null, LAST: null } : fixed;
  } catch (error) {
    if (isProbeMiss(error) || error.status === 400) return null;
    throw error;
  }
}

const COUNTED = [...SEVERITIES, 'total', 'NEW', 'RECURRENT', 'FIXED'];
const emptyCounts = () => ({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0, total: 0, NEW: 0, RECURRENT: 0, FIXED: 0 });

/**
 * Read Fusion (AI-generated SAST results) for `projects` ([{ id, name }]) from their latest completed scans
 * (`scans`: { projectId: scan }, as getLastScans gives). Returns the counts per project and overall (by
 * severity, and New / Recurrent / Fixed since the scan before) for every AI-generated result, and in `engines`
 * for Fusion's and LAST's apart; and every result to list, each saying whose it is (`engine`).
 */
export async function readAiFusion(client, projects, scans, { concurrency = 4, trace = null } = {}) {
  const readAt = new Date().toISOString();
  const withScan = projects.filter((p) => scanIdOf(scans?.[p.id]));
  const failures = [];
  const per = await mapWithConcurrency(withScan, concurrency, async (project) => {
    const scan = scans[project.id];
    const scanId = scanIdOf(scan);
    try {
      const [rows, counted, before] = await Promise.all([
        aiResults(client, scanId, trace),
        aiSeverityCounts(client, scanId, trace),
        previousScan(client, project.id, scanId, trace),
      ]);
      const all = rows.map((r) => cleanAiResult(r, project, scanId));
      const results = all.filter((r) => r.ai && r.resultId);
      const unmarked = all.filter((r) => !r.marked).length;
      const fixed = await aiFixed(client, scanId, scanIdOf(before), trace);
      return { project, scanId, scanAt: iso(scan.updatedAt ?? scan.createdAt), baseScanId: scanIdOf(before) || null, results, counted, fixed, unmarked };
    } catch (error) {
      failures.push({ projectId: project.id, status: error.status ?? 0, message: text(error.message, 200) });
      return { project, scanId, results: [], counted: null, fixed: null, error: true };
    }
  });
  const totals = { ...emptyCounts(), engines: { FUSION: emptyCounts(), LAST: emptyCounts() } };
  let unmarkedAll = 0;
  const byProject = {};
  const results = [];
  for (const p of per) {
    const engines = { FUSION: emptyCounts(), LAST: emptyCounts() };
    for (const r of p.results) {
      const e = engines[r.engine];
      e[r.severity] += 1;
      if (r.status === 'NEW' || r.status === 'RECURRENT') e[r.status] += 1;
    }
    for (const engine of ENGINES) {
      const e = engines[engine];
      e.total = SEVERITIES.reduce((n, s) => n + e[s], 0);
      const fixed = p.fixed ? p.fixed[engine] : null;
      e.FIXED = fixed ?? 0;
      e.fixedKnown = fixed !== null && fixed !== undefined;
    }
    const c = { ...emptyCounts(), projectName: p.project.name, scanId: p.scanId, scanAt: p.scanAt ?? null, baseScanId: p.baseScanId ?? null, error: Boolean(p.error), engines };
    for (const k of COUNTED) c[k] = engines.FUSION[k] + engines.LAST[k];
    c.fixedKnown = engines.FUSION.fixedKnown && engines.LAST.fixedKnown;
    // Checkmarx One's own count of the scan's AI-generated results, beside the listed ones.
    c.reported = p.counted ? SEVERITIES.reduce((n, s) => n + p.counted[s], 0) : null;
    unmarkedAll += p.unmarked ?? 0;
    if (!c.total && !c.FIXED) continue;
    byProject[p.project.id] = c;
    for (const k of COUNTED) {
      totals[k] += c[k];
      for (const engine of ENGINES) totals.engines[engine][k] += engines[engine][k];
    }
    results.push(...p.results);
  }
  const RANK = { CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 };
  results.sort((a, b) => RANK[b.severity] - RANK[a.severity] || String(b.firstFoundAt ?? '').localeCompare(String(a.firstFoundAt ?? '')));
  return {
    readAt,
    available: true,
    source: 'ai-sast',
    scanned: withScan.length,
    noScan: projects.length - withScan.length,
    failures,
    // SAST results that did not say whether the AI engine found them (a Checkmarx One without the flag).
    unmarked: unmarkedAll,
    projects: byProject,
    totals,
    listed: Math.min(results.length, MAX_LISTED),
    results: results.slice(0, MAX_LISTED),
  };
}

/**
 * The read results as findings the Workbench's credit, triage and remediation code works on: one project
 * entry per project with results, each result a SAST finding whose ids are its hash (as Risk Hub's).
 */
export function aiFindings(fusion) {
  const projects = new Map();
  for (const r of fusion?.results ?? []) {
    const p = projects.get(r.projectId) ?? { projectId: r.projectId, projectName: r.projectName, risks: [], scanId: r.scanId };
    p.risks.push({
      id: r.resultId,
      riskId: r.resultId,
      alternateId: r.hash || r.resultId,
      similarityId: r.similarityId,
      groupId: '',
      scanId: r.scanId,
      projectId: r.projectId,
      projectName: r.projectName,
      scanner: 'SAST',
      severity: r.severity,
      state: r.state,
      status: r.status,
      title: r.name,
      firstDetectedAt: r.firstFoundAt,
      location: r.sourceFile,
      engine: r.engine,
    });
    projects.set(r.projectId, p);
  }
  return {
    projects: [...projects.values()],
    initiators: Object.fromEntries([...projects.values()].map((p) => [p.projectId, { scanId: p.scanId }])),
  };
}
