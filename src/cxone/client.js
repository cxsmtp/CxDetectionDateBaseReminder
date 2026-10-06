import { Semaphore } from '../ttl-cache.js';
import { TokenProvider } from './auth.js';

/** Calls to Checkmarx One in flight at once, per connection; the rest queue. */
const MAX_CONCURRENT = Math.max(1, Number(process.env.CX_MAX_CONCURRENCY) || 24);

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
// Pages of one collection read at once once its size is known (CX_PAGES_AT_ONCE).
const PAGES_AT_ONCE = Math.max(1, Number(process.env.CX_PAGES_AT_ONCE) || 4);
// One request may not hang the caller for minutes (Node's fetch has no overall timeout).
const REQUEST_TIMEOUT_MS = Math.max(5_000, Number(process.env.CX_REQUEST_TIMEOUT_MS) || 60_000);

/** "fetch failed" says nothing: name the host and the network reason (timeout, DNS, TLS, refused…). */
export function networkReason(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return `no answer within ${Math.round(REQUEST_TIMEOUT_MS / 1000)} s`;
  const cause = error?.cause;
  const code = cause?.code || error?.code || '';
  const known = {
    ENOTFOUND: 'host name not found (DNS)',
    EAI_AGAIN: 'DNS lookup failed temporarily',
    ECONNREFUSED: 'connection refused',
    ECONNRESET: 'connection reset',
    ETIMEDOUT: 'connection timed out',
    UND_ERR_CONNECT_TIMEOUT: 'connection timed out',
    UND_ERR_SOCKET: 'connection closed unexpectedly',
    CERT_HAS_EXPIRED: 'TLS certificate expired',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate not trusted (proxy or missing CA — see NODE_EXTRA_CA_CERTS)',
    SELF_SIGNED_CERT_IN_CHAIN: 'TLS certificate not trusted (proxy or missing CA — see NODE_EXTRA_CA_CERTS)',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed TLS certificate',
  };
  return known[code] || [code, cause?.message || error?.message].filter(Boolean).join(': ') || 'network error';
}

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
  #limit = new Semaphore(MAX_CONCURRENT);

  constructor(connection, tokenProvider = new TokenProvider(connection)) {
    this.#connection = connection;
    this.#tokens = tokenProvider;
  }

  /**
   * Who this connection acts as, from the access token's claims (username,
   * email, name), for the audit log. Never throws.
   */
  async identity() {
    try {
      const token = await this.#tokens.getToken();
      const claims = JSON.parse(Buffer.from(String(token).split('.')[1] ?? '', 'base64url').toString('utf8'));
      return {
        user: claims.preferred_username || claims.email || claims.name || claims.sub || '',
        email: claims.email || '',
        name: claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' '),
        clientId: claims.azp || '',
      };
    } catch {
      return { user: '', email: '', name: '', clientId: '' };
    }
  }

  /** Requests running and queued against Checkmarx One right now. */
  get load() {
    return { active: this.#limit.active, waiting: this.#limit.waiting, waitingBackground: this.#limit.waitingLow, limit: this.#limit.limit };
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
  async request(path, { method = 'GET', query, body, accept = ACCEPT, retries = 3, background = false } = {}) {
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
      let response;
      let text = '';
      try {
        // Only the network round trip holds a slot; back-off waits do not.
        [response, text] = await this.#limit.run(async () => {
          const r = await fetch(url, {
            method,
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: accept,
              ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          return [r, await r.text().catch(() => '')];
        }, { low: background });
      } catch (error) {
        // A dropped connection or DNS hiccup: as retryable as a 503.
        lastError = Object.assign(new CxApiError(`Could not reach Checkmarx One at ${url.host}: ${networkReason(error)}.`, { status: 502, path: url.pathname }), { cause: error });
        if (attempt === retries) throw lastError;
        await sleep(2 ** attempt * 500);
        continue;
      }

      if (response.ok) {
        if (response.status === 204 || !text) return null;
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }

      const detail = text.slice(0, 1000);

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
   *
   * When the first page says how many rows there are, the remaining pages are
   * read a few at a time instead of one after another (still within the
   * shared limit on calls to Checkmarx One), and handed out in order. The end
   * is where it always was: the total, or the first short page.
   */
  async *paginate(path, { query = {}, itemsKey, limit = 100, maxItems = 10_000, offsetIsPage = false, parallel = PAGES_AT_ONCE } = {}) {
    let offset = 0;
    let fetched = 0;
    const read = (at) => this.request(path, { query: { ...query, offset: at, limit } });

    while (fetched < maxItems) {
      const page = await read(offset);
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
      // GET /api/results numbers pages rather than rows, and its totalCount
      // has been seen reporting only the first page, so a short page is the
      // only reliable end marker there.
      if (offsetIsPage) {
        offset += 1;
        continue;
      }
      if (Number.isFinite(total) && fetched >= total) return;
      offset += limit;

      // The rest at once (a few ahead), now that the size is known.
      if (parallel > 1 && Number.isFinite(total) && total > fetched) {
        const offsets = [];
        for (let at = offset; at < Math.min(total, offset + (maxItems - fetched)); at += limit) offsets.push(at);
        // Marked handled when asked for: a page that fails while an earlier one
        // is still awaited must not count as an unhandled rejection. Awaiting it
        // still throws.
        const ask = (at) => {
          const pending = read(at);
          pending.catch(() => {});
          return pending;
        };
        const ahead = offsets.slice(0, parallel).map(ask);
        let next = ahead.length;
        let lastFull = true;
        for (let i = 0; i < offsets.length && lastFull; i++) {
          const rows = extractItems(await ahead[i], itemsKey);
          if (next < offsets.length) ahead.push(ask(offsets[next++]));
          for (const item of rows) {
            yield item;
            fetched += 1;
            if (fetched >= maxItems) return;
          }
          // Ran out early: the total was generous.
          lastFull = rows.length >= limit;
        }
        if (!lastFull || fetched >= total) return;
        offset = offsets.length ? offsets[offsets.length - 1] + limit : offset;
      }
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
