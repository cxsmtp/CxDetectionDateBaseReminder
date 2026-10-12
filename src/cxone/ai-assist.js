/**
 * Identifiers for Checkmarx One AI Triage and AI Remediation.
 *
 * Both APIs take `alternateId` values from GET /api/results, and AI Triage
 * results are read back by `groupId`. The risks API gives us neither
 * directly, so they are resolved once, server-side, when a report is built:
 * each finding is matched to its /api/results row by scanner type and
 * similarityId (plus packageIdentifier for SCA), the same way Checkmarx's
 * own reference tooling does it.
 */

import { mapWithConcurrency } from './client.js';
import { TtlCache } from '../ttl-cache.js';

export const AI_SCANNERS = new Set(['SAST', 'SCA']);
const GROUP_SEPARATOR = '#-#';
const RESULTS_PAGE_SIZE = 500;

/**
 * similarityId and packageIdentifier for a finding. For SAST the risks API's
 * groupId *is* the similarityId; for SCA it is
 * `<similarityId>#-#<packageIdentifier>#-#<projectId>`.
 */
function matchKey(finding) {
  const [groupSimilarity, groupPackage] = String(finding.groupId || '').split(GROUP_SEPARATOR);
  return {
    similarityId: String(finding.similarityId || groupSimilarity || ''),
    packageIdentifier: String(finding.packageIdentifier || groupPackage || ''),
  };
}

export function groupIdFor(finding) {
  if (finding.groupId) return finding.groupId;
  const { similarityId, packageIdentifier } = matchKey(finding);
  if (!similarityId) return '';
  if (finding.scanner === 'SCA') {
    return packageIdentifier ? [similarityId, packageIdentifier, finding.projectId].join(GROUP_SEPARATOR) : '';
  }
  return similarityId;
}

/** A scan's /api/results rows; `cache` (scanId → promise) lets one report build read each scan once. */
function fetchScanResults(client, scanId, cache = null) {
  if (!cache) return readScanResults(client, scanId);
  if (!cache.has(scanId)) cache.set(scanId, readScanResults(client, scanId));
  return cache.get(scanId);
}

/**
 * A completed scan's results, without their code-path nodes, for matching findings to result ids:
 * kept 30 minutes per scan (CX_RESULT_IDS_CACHE_SECONDS) and shared, as a scan's result ids never
 * change. Credit checks read each project's findings and live states afresh every time; only this
 * lookup table is reused, so the two reads, allocating and triaging do not each walk the scan again.
 */
const RESULT_IDS_TTL_MS = Math.max(0, Number(process.env.CX_RESULT_IDS_CACHE_SECONDS ?? 1800) || 0) * 1000;
// Per connection (a signed-in person's Checkmarx One client): never shared between keys or tenants.
const resultIds = new WeakMap();
function scanResultIds(client, scanId) {
  const read = () => readScanResults(client, scanId, { nodes: false });
  if (!(RESULT_IDS_TTL_MS > 0)) return read();
  if (!resultIds.has(client)) resultIds.set(client, new TtlCache({ max: 200 }));
  return resultIds.get(client).wrap(String(scanId), read, RESULT_IDS_TTL_MS);
}

/**
 * Start reading a scan's result ids ahead of need (no wait, no error): a credit check started
 * meanwhile, or right after, finds the lookup table ready or joins the read already under way.
 */
const WARM_AT_ONCE = 2;
let warming = 0;
const warmQueue = [];
export function warmScanResults(client, scanId) {
  if (!scanId || !(RESULT_IDS_TTL_MS > 0)) return;
  // Two scans at a time at most, so reading ahead never crowds out what people are waiting for.
  if (warmQueue.length >= 50) return;
  warmQueue.push(() => scanResultIds(client, scanId));
  pumpWarm();
}
function pumpWarm() {
  while (warming < WARM_AT_ONCE && warmQueue.length) {
    warming += 1;
    warmQueue.shift()()
      .catch(() => {})
      .finally(() => {
        warming -= 1;
        pumpWarm();
      });
  }
}

async function readScanResults(client, scanId, { nodes = true } = {}) {
  const rows = [];
  for await (const row of client.paginate('/api/results/', {
    itemsKey: 'results',
    query: { 'scan-id': scanId, ...(nodes ? {} : { 'include-nodes': false }) },
    limit: RESULTS_PAGE_SIZE,
    maxItems: 50_000,
    offsetIsPage: true,
    // Pages are numbered and their count is not known: 8 asked for at a time, in order.
    parallel: 8,
  })) {
    rows.push(row);
  }
  return rows;
}

// A scan's rows by engine and similarity id, built once per list: looking each finding up in the
// whole list was quadratic, and a large project has tens of thousands of both.
const rowIndexes = new WeakMap();
function rowsFor(rows, type, similarityId) {
  let index = rowIndexes.get(rows);
  if (!index) {
    index = new Map();
    for (const row of rows) {
      const key = `${String(row.type ?? '').toLowerCase()}\u0000${String(row.similarityId ?? '')}`;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(row);
    }
    rowIndexes.set(rows, index);
  }
  return index.get(`${type}\u0000${similarityId}`) ?? [];
}

function findRow(rows, finding) {
  const { similarityId, packageIdentifier } = matchKey(finding);
  if (!similarityId) return null;
  const type = finding.scanner.toLowerCase();
  let matches = rowsFor(rows, type, similarityId);
  // SCA: the same vulnerability in another version of the package is another
  // finding. Never stand one in for the other — AI Triage would run (and
  // charge) for the wrong one, and this one's verdict would never come.
  if (finding.scanner === 'SCA' && packageIdentifier && matches.length) {
    const known = matches.filter((row) => row.data?.packageIdentifier);
    const exact = matches.filter((row) => row.data?.packageIdentifier === packageIdentifier);
    if (exact.length) matches = exact;
    else if (known.length) return null;
  }
  // SAST groups findings by pattern, so rows sharing a similarityId all map
  // to the same AI Triage verdict and any of them is a valid representative.
  return matches[0] ?? null;
}

/**
 * Fill in `scanId`, `alternateId` and `groupId` on AI-eligible findings, in
 * place. Never throws: a finding that cannot be resolved simply stays
 * ineligible for the AI actions, and the reason is recorded on it.
 *
 * @param {CxClient} client
 * @param {Array} findings        normalised risks (at most a few dozen)
 * @param {(finding) => string} latestScanId  fallback scan per project
 */
export async function resolveAiIds(client, findings, latestScanId = () => '', cache = null) {
  const pending = [];
  for (const finding of findings) {
    if (!AI_SCANNERS.has(finding.scanner)) {
      finding.aiUnavailable = `AI Triage and Remediation support SAST and SCA only (this is ${finding.scanner || 'an unknown engine'}).`;
      continue;
    }
    finding.scanId ||= latestScanId(finding) || '';
    if (!finding.scanId) {
      finding.aiUnavailable = 'No completed scan is known for this project.';
      continue;
    }
    if (!finding.alternateId) pending.push(finding);
    finding.groupId = groupIdFor(finding);
  }

  const byScan = new Map();
  for (const finding of pending) {
    if (!byScan.has(finding.scanId)) byScan.set(finding.scanId, []);
    byScan.get(finding.scanId).push(finding);
  }

  await mapWithConcurrency([...byScan.entries()], 3, async ([scanId, group]) => {
    let rows;
    try {
      rows = cache ? await fetchScanResults(client, scanId, cache) : await scanResultIds(client, scanId);
    } catch (error) {
      for (const finding of group) finding.aiUnavailable = `Could not read scan results: ${error.message}`;
      return;
    }
    for (const finding of group) {
      const row = findRow(rows, finding);
      if (!row?.alternateId) {
        finding.aiUnavailable = 'This finding was not found in the latest scan results.';
        continue;
      }
      finding.alternateId = String(row.alternateId);
      finding.similarityId ||= String(row.similarityId ?? '');
      finding.packageIdentifier ||= String(row.data?.packageIdentifier ?? '');
      finding.state ||= String(row.state ?? '').toUpperCase();
      finding.groupId = groupIdFor(finding);
    }
  });

  for (const finding of findings) {
    if (!finding.aiUnavailable && !finding.groupId) {
      finding.aiUnavailable = 'Checkmarx One did not return a vulnerability group id for this finding.';
    }
  }
  return findings;
}

/**
 * The scan result row behind each finding, for its exact code location.
 * SAST rows sharing a similarity id can sit in different files, so prefer the
 * row with the finding's own alternate id, then one in the finding's file.
 * Returns Map(finding → row); findings without a row are left out.
 */
export async function resultRowsFor(client, findings, latestScanId = () => '', cache = null) {
  const byScan = new Map();
  for (const finding of findings) {
    const scanId = finding.scanId || latestScanId(finding);
    if (!scanId) continue;
    if (!byScan.has(scanId)) byScan.set(scanId, []);
    byScan.get(scanId).push(finding);
  }
  const rows = new Map();
  await mapWithConcurrency([...byScan.entries()], 3, async ([scanId, group]) => {
    let all;
    try {
      all = await fetchScanResults(client, scanId, cache);
    } catch {
      return;
    }
    for (const finding of group) {
      const type = String(finding.scanner || '').toLowerCase();
      const { similarityId } = matchKey(finding);
      const sameType = all.filter((row) => String(row.type ?? '').toLowerCase() === type);
      const byAlt = finding.alternateId && sameType.find((row) => String(row.alternateId) === String(finding.alternateId));
      const candidates = similarityId ? sameType.filter((row) => String(row.similarityId ?? '') === similarityId) : [];
      const file = String(finding.location || '').split(' :: ')[0].replace(/^\/+/, '');
      const inFile =
        file &&
        candidates.find((row) => {
          const node = row.data?.nodes?.at(-1);
          const name = String(node?.fileName ?? row.data?.filename ?? '').replace(/^\/+/, '');
          return name && (name === file || name.endsWith(`/${file}`) || file.endsWith(`/${name}`));
        });
      const row = byAlt || inFile || candidates[0];
      if (row) rows.set(finding, { ...row, scanId });
    }
  });
  return rows;
}
