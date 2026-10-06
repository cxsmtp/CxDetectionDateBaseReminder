/**
 * A small JSON client for the source-code hosts the beta features talk to (GitLab, Azure
 * DevOps, Bitbucket). Counts its requests, so methods can be compared on cost as well as
 * results, retries a dropped connection and a short "slow down", and never sends its
 * credentials anywhere but its own base address.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ScmError extends Error {
  constructor(message, status = 0, body = null) {
    super(message);
    this.name = 'ScmError';
    this.status = status;
    this.body = body;
  }
}

export class ScmClient {
  #auth;

  /**
   * @param {{name: string, baseUrl: string, auth?: string, headers?: object, fetchImpl?: typeof fetch}} options
   * `auth`: the Authorization header value ('' for none).
   */
  constructor({ name, baseUrl, auth = '', headers = {}, fetchImpl = fetch }) {
    this.name = name;
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.#auth = auth;
    this.extraHeaders = headers;
    this.fetch = fetchImpl;
    this.requests = { rest: 0 };
  }

  get hasToken() {
    return Boolean(this.#auth);
  }

  get totalRequests() {
    return this.requests.rest;
  }

  /** The address for `path` (absolute URLs only when they are on this host). */
  url(path, query = {}) {
    const base = new URL(this.baseUrl);
    const url = /^https?:\/\//.test(path) ? new URL(path) : new URL(this.baseUrl + path);
    if (url.host !== base.host) throw new ScmError(`Refusing to send ${this.name} credentials to ${url.host}.`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    return url;
  }

  /** One request; resolves {body, headers}. */
  async send(path, { method = 'GET', query = {}, body, attempt = 0 } = {}) {
    const url = this.url(path, query);
    this.requests.rest += 1;
    let response;
    try {
      response = await this.fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'cxmissionzero',
          ...(this.#auth ? { Authorization: this.#auth } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...this.extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (attempt < 2) {
        await sleep(500 * 2 ** attempt);
        return this.send(path, { method, query, body, attempt: attempt + 1 });
      }
      throw Object.assign(new ScmError(`Could not reach ${this.name}: ${error.cause?.message || error.message}`), { cause: error });
    }
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    const retryAfter = Number(response.headers.get('retry-after'));
    if (response.status === 429 && attempt < 1 && (!retryAfter || retryAfter <= 10)) {
      await sleep(Math.max(1, retryAfter || 2) * 1000);
      return this.send(path, { method, query, body, attempt: attempt + 1 });
    }
    if (!response.ok) {
      const reason = parsed?.message || parsed?.error?.message || parsed?.error || parsed?.errors?.[0]?.message || `${this.name} answered ${response.status}.`;
      throw new ScmError(typeof reason === 'string' ? reason : JSON.stringify(reason).slice(0, 200), response.status, parsed);
    }
    return { body: parsed, headers: response.headers };
  }

  async get(path, query = {}) {
    return (await this.send(path, { query })).body;
  }

  async post(path, body, query = {}) {
    return (await this.send(path, { method: 'POST', body, query })).body;
  }
}
