import { TokenProvider } from './auth.js';

export class CxApiError extends Error {
  constructor(message, { status = 0, path = '', body = '' } = {}) {
    super(message);
    this.name = 'CxApiError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

const RETRYABLE = new Set([429, 502, 503, 504]);

/**
 * Checkmarx One negotiates API versions through the Accept header and answers
 * 400 Bad Request when it is missing. Only v1.0 exists today.
 */
export const ACCEPT = 'application/json; version=1.0';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Thin authenticated wrapper around the Checkmarx One REST API. */
export class CxClient {
  #connection;
  #tokens;

  /**
   * @param {{baseUrl: string, tokenUrl: string, apiKey: string}} connection
   *   Per-session connection descriptor, built from the API key the operator
   *   pasted into the portal.
   */
  constructor(connection, tokenProvider = new TokenProvider(connection)) {
    this.#connection = connection;
    this.#tokens = tokenProvider;
  }

  get baseUrl() {
    return this.#connection.baseUrl;
  }

  /**
   * @param {string} path  API path, optionally with a query string.
   * @param {object} [options]
   * @param {string} [options.method]
   * @param {object} [options.query]
   * @param {any}    [options.body]      JSON-serialised when present.
   * @param {string} [options.accept]
   * @param {number} [options.retries]
   */
  async request(path, { method = 'GET', query, body, accept = ACCEPT, retries = 3 } = {}) {
    if (!this.baseUrl) throw new CxApiError('Checkmarx One API URL is not configured.', { path });

    const url = new URL(path.startsWith('http') ? path : `${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) value.forEach((entry) => url.searchParams.append(key, String(entry)));
      else url.searchParams.set(key, String(value));
    }

    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const token = await this.#tokens.getToken();
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: accept,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      if (response.ok) {
        if (response.status === 204) return null;
        const text = await response.text();
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }

      const detail = (await response.text().catch(() => '')).slice(0, 1000);

      // A 401 usually means the cached token aged out mid-flight; retry once
      // with a fresh one before giving up.
      if (response.status === 401 && attempt < retries) {
        this.#tokens.reset();
        continue;
      }

      lastError = new CxApiError(
        `${method} ${url.pathname} failed: ${response.status} ${response.statusText}`,
        { status: response.status, path: url.pathname, body: detail },
      );

      if (!RETRYABLE.has(response.status) || attempt === retries) throw lastError;

      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 500);
    }

    throw lastError ?? new CxApiError(`${method} ${path} failed.`, { path });
  }

  /**
   * Walk an offset/limit paginated collection.  Checkmarx One is not entirely
   * consistent about the envelope key, so the caller says where the rows live.
   */
  async *paginate(path, { query = {}, itemsKey, limit = 100, maxItems = 10_000 } = {}) {
    let offset = 0;
    let fetched = 0;

    while (fetched < maxItems) {
      const page = await this.request(path, { query: { ...query, offset, limit } });
      const items = extractItems(page, itemsKey);
      if (items.length === 0) return;

      for (const item of items) {
        yield item;
        fetched += 1;
        if (fetched >= maxItems) return;
      }

      const total = Number(
        page?.filteredTotalCount ??
          page?.totalCount ??
          page?.metaData?.filteredResults ??
          page?.metaData?.totalResults,
      );
      if (items.length < limit) return;
      if (Number.isFinite(total) && fetched >= total) return;
      offset += limit;
    }
  }
}

/** Pull the row array out of a response envelope of unknown shape. */
export function extractItems(page, itemsKey) {
  if (Array.isArray(page)) return page;
  if (!page || typeof page !== 'object') return [];
  if (itemsKey && Array.isArray(page[itemsKey])) return page[itemsKey];

  for (const key of ['items', 'results', 'data', 'content', 'risks', 'projects', 'entries']) {
    if (Array.isArray(page[key])) return page[key];
  }
  // Last resort: a single array-valued property.
  const arrays = Object.values(page).filter(Array.isArray);
  return arrays.length === 1 ? arrays[0] : [];
}

/** Run `worker` over `items` with a bounded number of parallel calls. */
export async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}
