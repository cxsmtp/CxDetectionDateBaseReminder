import { CxApiError, extractItems } from './client.js';

/**
 * Endpoint discovery.
 *
 * The Risk Management and Feedback App services have moved between paths as
 * they rolled out, and a tenant's API gateway may answer an unknown path with
 * 400, 403, 404 or 405 depending on how it is fronted.  Rather than guessing
 * once and failing, the client probes a candidate list, remembers what
 * answered, and can report the whole probe to the operator.
 */

/** Statuses that mean "this path is not the one" rather than "give up". */
export const PROBE_MISS_STATUSES = new Set([400, 403, 404, 405, 501]);

export const isProbeMiss = (error) =>
  error instanceof CxApiError && PROBE_MISS_STATUSES.has(error.status);

export const RISK_PATH_CANDIDATES = [
  '/api/risk-management/risks/{projectId}',
  '/api/risk-management/projects/{projectId}/risks',
  '/api/risk-management/risks',
  '/api/risk-management/project-risks/{projectId}',
  '/api/risks/{projectId}',
];

export const FEEDBACK_LIST_CANDIDATES = [
  '/api/feedbackapps',
  '/api/feedback-apps',
  '/api/feedbackapps/list',
  '/api/integrations/feedback-apps',
  '/api/integrations/feedbackapps',
  '/api/notifications/feedbackapps',
];

/** Build the candidate list for a target, with the configured path tried first. */
export function candidatesFor(target, configuredPath) {
  const base = target === 'risks' ? RISK_PATH_CANDIDATES : FEEDBACK_LIST_CANDIDATES;
  const rest = base.filter((path) => path !== configuredPath);
  return configuredPath ? [configuredPath, ...rest] : base;
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
export async function discover(client, target, { configuredPath, projectId = '' } = {}) {
  const results = [];

  for (const candidate of candidatesFor(target, configuredPath)) {
    const usesPathParam = candidate.includes('{projectId}');
    if (usesPathParam && !projectId) continue;

    const path = candidate.replace('{projectId}', encodeURIComponent(projectId));
    const query =
      target === 'risks' && !usesPathParam ? { 'project-id': projectId, limit: 1 } : { limit: 1 };

    const result = await probePath(client, path, { query });
    results.push({ ...result, template: candidate });
    if (result.ok) break; // First working path wins; no need to keep probing.
  }

  const match = results.find((result) => result.ok)?.template ?? null;

  return {
    target,
    projectId: projectId || null,
    results,
    match,
    // The trigger endpoint lives under the same prefix as the list endpoint,
    // so finding one tells us where the other is. Without this, pinning a
    // corrected list path would silently leave the trigger path stale.
    suggestedTriggerPath: target === 'feedbackApps' && match ? triggerPathFor(match) : null,
  };
}

/** Derive the notify path that pairs with a working Feedback Apps list path. */
export function triggerPathFor(listPath) {
  return `${String(listPath).replace(/\/+$/, '').replace(/\/list$/, '')}/{appId}/notify`;
}
