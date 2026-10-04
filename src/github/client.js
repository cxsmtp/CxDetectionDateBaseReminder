/**
 * Minimal GitHub client (REST and GraphQL) for the beta identity features.
 *
 * Works with github.com and GitHub Enterprise Server (apiUrl
 * https://github.example.com/api/v3, GraphQL at …/api/graphql). Counts the
 * requests it makes and remembers the last rate-limit headers, so methods can
 * be compared on cost as well as results.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class GitHubError extends Error {
  constructor(message, status = 0, body = null) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.body = body;
  }
}

export class GitHubClient {
  #token;

  /** @param {{token?: string, apiUrl?: string, graphqlUrl?: string, fetchImpl?: typeof fetch}} options */
  constructor({ token = '', apiUrl = 'https://api.github.com', graphqlUrl = '', fetchImpl = fetch } = {}) {
    this.#token = String(token || '').trim();
    this.apiUrl = String(apiUrl || 'https://api.github.com').replace(/\/+$/, '');
    // github.com: api.github.com/graphql; Enterprise: https://host/api/graphql next to /api/v3.
    this.graphqlUrl = graphqlUrl || (this.apiUrl.endsWith('/api/v3') ? this.apiUrl.replace(/\/v3$/, '/graphql') : `${this.apiUrl}/graphql`);
    this.fetch = fetchImpl;
    this.requests = { rest: 0, graphql: 0, search: 0 };
    this.rateLimit = {};
  }

  /** For authenticated git clones of private repositories (sent as a header, never stored). */
  get token() {
    return this.#token;
  }

  get hasToken() {
    return Boolean(this.#token);
  }

  get totalRequests() {
    return this.requests.rest + this.requests.graphql + this.requests.search;
  }

  #headers() {
    return {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'mission-zero-reminders',
      ...(this.#token ? { Authorization: `Bearer ${this.#token}` } : {}),
    };
  }

  #noteLimits(response, bucket) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining !== null) {
      this.rateLimit[bucket] = {
        remaining: Number(remaining),
        limit: Number(response.headers.get('x-ratelimit-limit')),
        resetAt: Number(response.headers.get('x-ratelimit-reset')) * 1000 || null,
      };
    }
  }

  async #send(url, init, bucket, attempt = 0) {
    this.requests[bucket] += 1;
    let response;
    try {
      response = await this.fetch(url, init);
    } catch (error) {
      if (attempt < 2) {
        await sleep(500 * 2 ** attempt);
        return this.#send(url, init, bucket, attempt + 1);
      }
      throw new GitHubError(`Could not reach GitHub: ${error.message}`);
    }
    this.#noteLimits(response, bucket);
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    // Secondary rate limits answer 403/429 with Retry-After: wait once, briefly.
    const retryAfter = Number(response.headers.get('retry-after'));
    if ((response.status === 429 || (response.status === 403 && retryAfter)) && attempt < 1 && retryAfter <= 10) {
      await sleep(Math.max(1, retryAfter) * 1000);
      return this.#send(url, init, bucket, attempt + 1);
    }
    if (!response.ok) {
      throw new GitHubError(body?.message || `GitHub answered ${response.status}.`, response.status, body);
    }
    return body;
  }

  /** GET a REST path, e.g. rest('/users/octocat') or rest('/search/commits', {q: '…'}). */
  rest(path, query = {}) {
    const url = new URL(this.apiUrl + path);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    const bucket = path.startsWith('/search/') ? 'search' : 'rest';
    return this.#send(url, { headers: this.#headers() }, bucket);
  }

  /** POST JSON to a REST path, e.g. post('/repos/o/r/issues', {title, body}). Needs a token. */
  post(path, body) {
    if (!this.#token) throw new GitHubError('Writing to GitHub needs a token.', 401);
    return this.#send(new URL(this.apiUrl + path), { method: 'POST', headers: { ...this.#headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 'rest');
  }

  /** Run a GraphQL query; GraphQL needs a token. Partial data comes back with `errors` alongside. */
  async graphql(query, variables = {}) {
    if (!this.#token) throw new GitHubError('GitHub GraphQL needs a token.', 401);
    const body = await this.#send(
      this.graphqlUrl,
      { method: 'POST', headers: { ...this.#headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) },
      'graphql',
    );
    if (body?.errors?.length && !body.data) throw new GitHubError(body.errors[0].message, 200, body);
    return body;
  }
}
