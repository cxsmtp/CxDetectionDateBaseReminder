/**
 * Labs → Fusion results → Troubleshoot: test the Checkmarx One paths Fusion may be served at, once each,
 * read-only. Fusion's results themselves are read in src/fusion-ai.js (the SAST results Checkmarx One marks
 * AI-generated).
 */
/** The paths Troubleshoot offers to test first: where tenants serve Fusion, and where its results also appear. */
export const PROBE_DEFAULTS = [
  '/api/sast-results',
  '/api/correlation/results/applications',
  '/api/correlation/results/applications/{appId}/summary',
  '/api/correlation/results/applications/{appId}/risk-scores',
  '/api/correlation/dispatcher/{appId}/scan-status',
  '/api/fusion-results/applications',
  '/api/fusion/results/applications',
  '/api/risk-management/summary',
  '/api/risk-management/{appId}/results',
  '/api/flags',
];

/**
 * Troubleshoot: call each path once (GET, through this connection), {appId} replaced by an application's
 * id, and say what came back: status, time, the start of the answer, and the full exchange via `trace`.
 */
export async function probeFusion(client, paths, { appId = '', trace = null } = {}) {
  const out = [];
  for (const path of paths) {
    const url = path.replaceAll('{appId}', encodeURIComponent(appId));
    const started = Date.now();
    if (path.includes('{appId}') && !appId) {
      out.push({ path, url, status: 0, ok: false, ms: 0, answer: 'No application to put in {appId}: load findings on the Workbench first.' });
      continue;
    }
    try {
      const body = await client.request(url, { retries: 0, trace, query: url.includes('risk-management/') && url.endsWith('/results') ? { limit: 5 } : undefined });
      out.push({ path, url, status: 200, ok: true, ms: Date.now() - started, answer: (typeof body === 'string' ? body : JSON.stringify(body) ?? '').slice(0, 600) });
    } catch (error) {
      out.push({ path, url, status: error.status ?? 0, ok: false, ms: Date.now() - started, answer: String(error.body || error.message).slice(0, 600) });
    }
  }
  return out;
}
