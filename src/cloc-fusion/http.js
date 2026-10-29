// Vendored from cloc-fusion 1.3.2 (commit 1a320621d0f5), MIT licence: src/cloc-fusion/LICENSE. Do not edit here: scripts/sync-cloc-fusion.mjs copies it again.
// A small JSON-over-HTTPS client for the providers' REST APIs: retries on rate limits and server
// errors, follows pagination, and never puts the token anywhere but the Authorization header.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In a web page (the standalone HTML), the browser follows redirects itself and drops the
// Authorization header when one leads to another origin; it does not let a page read the redirect
// target, nor set User-Agent.
const IN_BROWSER = typeof window !== 'undefined' && typeof window.document !== 'undefined';

export class HttpError extends Error {
  constructor(message, { status, url, body } = {}) {
    super(message);
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/** How long to wait before retrying a response, in ms (null: don't retry). */
function retryDelay(res, attempt) {
  const after = res.headers.get('retry-after');
  if (after) {
    const s = Number(after);
    if (Number.isFinite(s)) return Math.min(s * 1000, 120000);
    const at = Date.parse(after);
    if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), 120000);
  }
  // GitHub: primary rate limit exhausted. Wait for a reset that is close; give up on a far one.
  if (res.headers.get('x-ratelimit-remaining') === '0' && res.headers.get('x-ratelimit-reset')) {
    const wait = Number(res.headers.get('x-ratelimit-reset')) * 1000 - Date.now() + 1000;
    return wait <= 120000 ? Math.max(1000, wait) : null;
  }
  return Math.min(1000 * 2 ** attempt, 30000);
}

export class ApiClient {
  /**
   * @param {object} o
   * @param {string} o.name      provider name, for messages
   * @param {string} o.baseUrl   API root
   * @param {Record<string,string>} [o.headers] auth and other headers
   * @param {string[]} [o.trustedOrigins] other origins the auth headers may go to (the API root's always may)
   * @param {number} [o.maxConcurrent] requests in flight at once through this client
   */
  constructor({ name, baseUrl, headers = {}, fetchImpl = (...args) => globalThis.fetch(...args), retries = 5, timeoutMs = 60000, trustedOrigins = [], maxConcurrent = 16 }) {
    this.name = name;
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.headers = headers;
    this.fetch = fetchImpl;
    this.retries = retries;
    this.timeoutMs = timeoutMs;
    this.trusted = new Set([originOf(this.baseUrl), ...trustedOrigins.map(originOf)].filter(Boolean));
    this.maxConcurrent = maxConcurrent;
    this.active = 0;
    this.queue = [];
    this.requests = 0;
  }

  url(path) {
    if (/^https?:\/\//i.test(path)) return path;
    return `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  async slot() {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    await new Promise((r) => this.queue.push(r));
  }

  release() {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }

  /**
   * One HTTP exchange with retries on rate limits, server errors and network failures. The auth
   * headers only ever go to trusted origins: a pagination link or API call to any other host is
   * refused, and a redirect elsewhere (e.g. GitHub's archive download host) is followed without them.
   * Returns the ok Response (or the 404 / emptyOn one when allowed).
   */
  async send(path, { method = 'GET', body, headers = {}, accept = null, allow = [], timeoutMs = this.timeoutMs, retries = this.retries } = {}) {
    let url = this.url(path);
    if (!this.trusted.has(originOf(url))) throw new HttpError(`${this.name}: refusing to send credentials to ${originOf(url) || url}, which is not the configured API address`, { url });
    // A browser keeps custom headers across a redirect, and an archive host (codeload.github.com)
    // refuses a cross-origin request carrying them: downloads from a page send only Authorization,
    // which the browser itself drops when the redirect leaves the API's origin.
    const own = IN_BROWSER && accept === '*/*' ? Object.fromEntries(Object.entries(this.headers).filter(([k]) => k.toLowerCase() === 'authorization')) : this.headers;
    await this.slot();
    try {
      for (let attempt = 0; ; attempt++) {
        let res;
        let target = url;
        try {
          // Redirects by hand, so credentials never follow one to another host.
          for (let hops = 0; ; hops++) {
            const auth = this.trusted.has(originOf(target));
            this.requests++;
            res = await this.fetch(target, {
              method,
              headers: { Accept: 'application/json', ...(IN_BROWSER ? {} : { 'User-Agent': 'cloc-fusion' }), ...(auth ? own : {}), ...(auth ? headers : {}), ...(accept ? { Accept: accept } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
              body: body ? JSON.stringify(body) : undefined,
              signal: AbortSignal.timeout(timeoutMs),
              redirect: IN_BROWSER ? 'follow' : 'manual',
            });
            const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
            if (!loc) break;
            if (hops >= 5) throw new HttpError(`${this.name}: too many redirects from ${new URL(url).pathname}`, { url });
            await res.body?.cancel().catch(() => {});
            const nextUrl = new URL(loc, target);
            if (nextUrl.protocol !== 'https:' && nextUrl.protocol !== new URL(target).protocol) throw new HttpError(`${this.name}: refusing a redirect from https to ${nextUrl.protocol}`, { url });
            target = nextUrl.toString();
          }
        } catch (err) {
          if (err instanceof HttpError) throw err;
          if (attempt < retries) {
            await sleep(Math.min(1000 * 2 ** attempt, 30000));
            continue;
          }
          throw new HttpError(`${this.name}: could not reach ${new URL(url).host} (${err.cause?.code || err.name === 'TimeoutError' ? 'timed out' : err.message})`, { url });
        }
        if (res.ok || allow.includes(res.status)) return res;
        const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0');
        const delay = retryable && attempt < retries ? retryDelay(res, attempt) : null;
        if (delay !== null) {
          await res.body?.cancel().catch(() => {});
          await sleep(delay);
          continue;
        }
        if (res.headers.get('x-ratelimit-remaining') === '0' && res.headers.get('x-ratelimit-reset')) {
          const at = new Date(Number(res.headers.get('x-ratelimit-reset')) * 1000);
          throw new HttpError(`${this.name}: API rate limit reached; it resets at ${at.toLocaleTimeString()}. Run again then (add --resume with the partial report to skip what is done).`, { status: res.status, url });
        }
        const text = await res.text().catch(() => '');
        let detail = text.slice(0, 300);
        try {
          const j = JSON.parse(text);
          detail = j.message || j.error_description || j.error?.message || j.error || j.errors?.[0]?.message || detail;
          if (typeof detail === 'object') detail = JSON.stringify(detail);
        } catch {}
        if (/<html/i.test(detail)) detail = 'an HTML page (sign-in page or proxy?)';
        throw new HttpError(`${this.name}: ${method} ${new URL(url).pathname} → HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 300)}` : ''}`, { status: res.status, url, body: text.slice(0, 500) });
      }
    } finally {
      this.release();
    }
  }

  /** GET (or other method) returning { data, res }; data is null for an allowed 404 / emptyOn status. */
  async request(path, { method, body, headers, allow404 = false, emptyOn = [] } = {}) {
    const allow = [...emptyOn, ...(allow404 ? [404] : [])];
    const res = await this.send(path, { method, body, headers, allow });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { data: null, res };
    }
    const text = await readText(res, MAX_JSON_BYTES);
    try {
      return { data: text ? JSON.parse(text) : null, res };
    } catch {
      throw new HttpError(`${this.name}: ${this.url(path)} did not return JSON (is the API URL right? a sign-in page or proxy may have answered)`, { status: res.status, url: this.url(path), body: text.slice(0, 300) });
    }
  }

  async get(path, opts) {
    return (await this.request(path, opts)).data;
  }

  /** The response of a download (an archive), for streaming; allowed up to `timeoutMs` in all. */
  async download(path, { timeoutMs = 30 * 60000, retries } = {}) {
    return this.send(path, { accept: '*/*', timeoutMs, retries });
  }

  /**
   * Every item of a paginated list. `next(data, res, url)` returns the next page's URL or null;
   * `items(data)` the page's items. Stops after `max` items.
   */
  async paginate(path, { items = (d) => d, next = linkNext, max = 1000000, emptyOn = [] } = {}) {
    const out = [];
    let url = this.url(path);
    const seen = new Set();
    while (url && !seen.has(url) && out.length < max) {
      seen.add(url);
      const { data, res } = await this.request(url, { emptyOn });
      const got = data && items(data);
      const page = Array.isArray(got) ? got : [];
      for (const item of page) out.push(item);
      url = page.length ? next(data, res, url) : null;
      if (url && !/^https?:/i.test(url)) url = this.url(url);
    }
    return out.slice(0, max);
  }
}

// An API answer larger than this is refused rather than read into memory.
const MAX_JSON_BYTES = 64 * 1024 * 1024;

async function readText(res, limit) {
  const declared = Number(res.headers.get('content-length'));
  if (declared > limit) throw new HttpError(`response too large (${Math.round(declared / 1048576)} MB)`, { status: res.status });
  if (!res.body) return '';
  const decoder = new TextDecoder();
  let out = '';
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > limit) {
      throw new HttpError(`response larger than ${Math.round(limit / 1048576)} MB refused`, { status: res.status });
    }
    out += decoder.decode(chunk, { stream: true });
  }
  return out + decoder.decode();
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** RFC 5988 Link header rel="next" (GitHub, GitLab). */
export function linkNext(_data, res) {
  const link = res.headers.get('link');
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (m) return m[1];
  }
  return null;
}

const base64 = (s) => (typeof Buffer !== 'undefined' ? Buffer.from(s).toString('base64') : btoa(String.fromCharCode(...new TextEncoder().encode(s))));
export const basic = (user, pass) => `Basic ${base64(`${user}:${pass}`)}`;
