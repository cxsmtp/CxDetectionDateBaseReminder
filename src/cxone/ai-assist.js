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

async function fetchScanResults(client, scanId) {
  const rows = [];
  for await (const row of client.paginate('/api/results/', {
    itemsKey: 'results',
    query: { 'scan-id': scanId },
    limit: RESULTS_PAGE_SIZE,
    maxItems: 50_000,
    offsetIsPage: true,
  })) {
    rows.push(row);
  }
  return rows;
}

function findRow(rows, finding) {
  const { similarityId, packageIdentifier } = matchKey(finding);
  if (!similarityId) return null;
  const type = finding.scanner.toLowerCase();
  let matches = rows.filter(
    (row) => String(row.type ?? '').toLowerCase() === type && String(row.similarityId ?? '') === similarityId,
  );
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
export async function resolveAiIds(client, findings, latestScanId = () => '') {
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
      rows = await fetchScanResults(client, scanId);
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
export async function resultRowsFor(client, findings, latestScanId = () => '') {
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
      all = await fetchScanResults(client, scanId);
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
