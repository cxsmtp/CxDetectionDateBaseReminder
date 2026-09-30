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
  if (finding.scanner === 'SCA' && packageIdentifier && matches.length > 1) {
    const narrowed = matches.filter((row) => row.data?.packageIdentifier === packageIdentifier);
    if (narrowed.length) matches = narrowed;
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
