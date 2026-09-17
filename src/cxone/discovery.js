import { CxApiError, extractItems } from './client.js';

/**
 * Endpoint discovery.
 *
 * The risks endpoint has moved between paths as the service rolled out, and a
 * tenant's API gateway may answer an unknown path with 400, 403, 404 or 405
 * depending on how it is fronted.  Rather than guessing once and failing, the
 * client probes a candidate list, remembers what answered, and can report the
 * whole probe to the operator.
 */

/** Statuses that mean "this path is not the one" rather than "give up". */
export const PROBE_MISS_STATUSES = new Set([400, 403, 404, 405, 501]);

export const isProbeMiss = (error) =>
  error instanceof CxApiError && PROBE_MISS_STATUSES.has(error.status);

export const RISK_PATH_CANDIDATES = [
  // Tenant-wide endpoint: one sweep covers every project and carries the
  // first-detection date, so it is tried first.
  '/api/risks/',
  '/api/risks',
  // "Retrieve Aggregated Risks" in the API reference; probed so the tenant
  // confirms the spelling rather than the code guessing it.
  '/api/risks/aggregate',
  '/api/risks/aggregated',
  '/api/risk-management/risks/{projectId}',
  '/api/risk-management/projects/{projectId}/risks',
  '/api/risk-management/risks',
  '/api/risk-management/project-risks/{projectId}',
  '/api/risks/{projectId}',
];

/** Build the candidate list, with the configured path tried first. */
export function candidatesFor(configuredPath) {
  const rest = RISK_PATH_CANDIDATES.filter((path) => path !== configuredPath);
  return configuredPath ? [configuredPath, ...rest] : [...RISK_PATH_CANDIDATES];
}

const summarise = (payload) => {
  if (payload === null || payload === undefined) return { itemCount: null, snippet: '' };
  const items = extractItems(payload);
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { itemCount: items.length, snippet: text.slice(0, 220) };
};

/**
 * Try one candidate path and describe what happened, without throwing.
 *
 * @returns {{path: string, ok: boolean, status: number, itemCount: number|null,
 *            snippet: string, error: string|null}}
 */
export async function probePath(client, path, { query = {}, method = 'GET' } = {}) {
  try {
    const payload = await client.request(path, { method, query, retries: 0 });
    return { path, ok: true, status: 200, ...summarise(payload), error: null };
  } catch (error) {
    return {
      path,
      ok: false,
      status: error.status ?? 0,
      itemCount: null,
      snippet: (error.body ?? '').slice(0, 220),
      error: error.message,
    };
  }
}

/**
 * Probe every candidate and return the full report, most useful first.
 * Nothing is thrown — a report where every row failed is itself the answer.
 */
/** Probe every risks-endpoint candidate and report what each one returned. */
export async function discover(client, { configuredPath, projectId = '' } = {}) {
  const results = [];

  for (const candidate of candidatesFor(configuredPath)) {
    const usesPathParam = candidate.includes('{projectId}');
    if (usesPathParam && !projectId) continue;

    const path = candidate.replace('{projectId}', encodeURIComponent(projectId));
    // The documented endpoints require `projectId` (camel case) and answer
    // 400 without it; a templated path carries it in the URL instead.
    const query = usesPathParam ? { limit: 1 } : { projectId, limit: 1 };

    const result = await probePath(client, path, { query });
    results.push({ ...result, template: candidate, tenantWide: !usesPathParam });
    if (result.ok) break; // First working path wins; no need to keep probing.
  }

  return {
    projectId: projectId || null,
    results,
    match: results.find((result) => result.ok)?.template ?? null,
  };
}
