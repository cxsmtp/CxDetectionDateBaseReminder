/**
 * Free certificates from Let's Encrypt (any ACME v2 certificate authority, RFC 8555), got and
 * renewed by this server itself, from Settings → HTTPS: no reverse proxy and no request to IT.
 *
 * How it works:
 * - An ECDSA P-256 account key (DATA_DIR/tls/acme/, one per CA directory) signs every
 *   request to the CA (JWS, ES256).
 * - The CA checks that each name points at this server with the HTTP-01 challenge: it fetches
 *   http://<name>/.well-known/acme-challenge/<token> on port 80, which this server answers in
 *   every HTTPS mode (src/server.js). Before asking, the server tries that address itself,
 *   so a wrong DNS entry or a closed port 80 is found without using up the CA's limits.
 * - A CSR with a new RSA key (src/tls.js) is sent; the certificate chain that comes back is
 *   put to use like an uploaded one (HttpsManager.install: checked, swapped in without a
 *   restart, the previous certificate kept).
 * - It is renewed by itself 30 days before it expires.
 *
 * Nothing but these requests to the CA leaves the server.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { certificateRequest, isIp } from './tls.js';

export const DIRECTORIES = {
  production: 'https://acme-v02.api.letsencrypt.org/directory',
  staging: 'https://acme-staging-v02.api.letsencrypt.org/directory',
};
export const SUBSCRIBER_AGREEMENT = 'https://letsencrypt.org/repository/';
export const CHALLENGE_PREFIX = '/.well-known/acme-challenge/';
/** Renewed when it has fewer days left than this. */
export const RENEW_DAYS = 30;
/** After a failed attempt, the automatic renewal waits this long before trying again. */
const RETRY_AFTER_FAILURE_MS = 6 * 60 * 60 * 1000;
const POLL_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_NAMES = 20;
const TOKEN = /^[A-Za-z0-9_-]{8,128}$/;

const b64u = (data) => Buffer.from(data).toString('base64url');
const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pemBody = (pem) => Buffer.from(String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');

/** A name a CA can issue for with HTTP-01: a DNS name with a dot, no IP address, no wildcard. */
export function validName(name) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n || n.length > 253 || isIp(n) || n.startsWith('*.') || !n.includes('.')) return false;
  if (n === 'localhost' || n.endsWith('.localhost') || n.endsWith('.local') || n.endsWith('.internal')) return false;
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(n);
}

/** The names to ask for: lower case, each once, checked. Throws with what is wrong. */
export function cleanNames(names) {
  const list = (Array.isArray(names) ? names : String(names ?? '').split(/[\s,]+/)).map((n) => String(n).trim().toLowerCase()).filter(Boolean);
  const unique = [...new Set(list)];
  if (!unique.length) throw fail(400, 'Enter the name people use to reach this server, e.g. mz.company.com.');
  if (unique.length > MAX_NAMES) throw fail(400, `At most ${MAX_NAMES} names.`);
  const bad = unique.find((n) => !validName(n));
  if (bad) {
    const why = isIp(bad) ? 'an IP address' : bad.startsWith('*.') ? 'a wildcard (it needs a DNS check this server cannot do)' : 'not a public DNS name';
    throw fail(400, `"${bad}" cannot get a Let's Encrypt certificate: it is ${why}. Use a DNS name that points at this server.`);
  }
  return unique;
}

/** Read an ACME error into one sentence a person can act on. */
function problemError(body, status) {
  const type = String(body?.type ?? '').replace('urn:ietf:params:acme:error:', '');
  const detail = String(body?.detail ?? (typeof body === 'string' ? body : '') ?? '').slice(0, 400) || `HTTP ${status}`;
  const hints = {
    rateLimited: ' Let\'s Encrypt limits how often certificates are issued: wait, or test with the staging service.',
    connection: ' Let\'s Encrypt could not reach this server on port 80: check the DNS name and that port 80 is open to the internet.',
    dns: ' Check that the DNS name exists and points at this server.',
    unauthorized: ' The answer at that address did not come from this server: check the DNS name and any proxy or firewall in front.',
    rejectedIdentifier: ' Let\'s Encrypt does not issue for this name.',
    caa: ' A CAA record in DNS forbids Let\'s Encrypt for this name.',
  };
  return fail(502, `Let's Encrypt: ${detail}${hints[type] ?? ''}`, { acmeType: type });
}

/** A minimal ACME v2 client: account, order, HTTP-01, finalize, download. */
export class AcmeClient {
  #directoryUrl;
  #key;
  #jwk;
  #kid = '';
  #directory = null;
  #nonce = '';
  #fetch;
  #pollMs;

  /**
   * @param {object} options
   * @param {string} options.directoryUrl  the CA's directory
   * @param {string} options.accountKey    PEM, an EC P-256 private key
   * @param {Function} [options.fetch]
   * @param {number} [options.pollMs]      first wait between status checks
   */
  constructor({ directoryUrl, accountKey, fetch = globalThis.fetch, pollMs = 1000 }) {
    this.#directoryUrl = directoryUrl;
    this.#key = createPrivateKey(accountKey);
    const jwk = createPublicKey(this.#key).export({ format: 'jwk' });
    this.#jwk = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
    this.#fetch = fetch;
    this.#pollMs = pollMs;
  }

  /** RFC 7638 thumbprint of the account key: the second half of every key authorization. */
  get thumbprint() {
    const { crv, kty, x, y } = this.#jwk;
    return b64u(createHash('sha256').update(JSON.stringify({ crv, kty, x, y })).digest());
  }

  keyAuthorization(token) {
    return `${token}.${this.thumbprint}`;
  }

  async directory() {
    if (this.#directory) return this.#directory;
    const res = await this.#fetch(this.#directoryUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw fail(502, `The certificate authority's directory answered HTTP ${res.status}.`);
    this.#directory = await res.json();
    return this.#directory;
  }

  async #newNonce() {
    const res = await this.#fetch((await this.directory()).newNonce, { method: 'HEAD', signal: AbortSignal.timeout(30_000) });
    const nonce = res.headers.get('replay-nonce');
    if (!nonce) throw fail(502, 'The certificate authority gave no nonce.');
    return nonce;
  }

  /** A signed POST (payload '' is POST-as-GET). Retries once on a stale nonce. */
  async #post(url, payload, { useJwk = false, accept } = {}) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const nonce = this.#nonce || (await this.#newNonce());
      this.#nonce = '';
      const header = { alg: 'ES256', nonce, url, ...(useJwk ? { jwk: this.#jwk } : { kid: this.#kid }) };
      const protectedB64 = b64u(JSON.stringify(header));
      const payloadB64 = payload === '' ? '' : b64u(JSON.stringify(payload));
      const signature = sign('sha256', Buffer.from(`${protectedB64}.${payloadB64}`), { key: this.#key, dsaEncoding: 'ieee-p1363' });
      const res = await this.#fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/jose+json', ...(accept ? { Accept: accept } : {}) },
        body: JSON.stringify({ protected: protectedB64, payload: payloadB64, signature: b64u(signature) }),
        signal: AbortSignal.timeout(60_000),
      });
      const next = res.headers.get('replay-nonce');
      if (next) this.#nonce = next;
      const type = res.headers.get('content-type') ?? '';
      const body = /json/.test(type) ? await res.json().catch(() => ({})) : await res.text();
      if (res.ok) return { status: res.status, headers: res.headers, body };
      if (attempt === 0 && body?.type === 'urn:ietf:params:acme:error:badNonce') continue;
      throw problemError(body, res.status);
    }
    throw fail(502, 'The certificate authority kept refusing the request.');
  }

  /** Register (or find) the account for this key; the terms of service must have been agreed to. */
  async account(email = '') {
    const dir = await this.directory();
    const res = await this.#post(dir.newAccount, { termsOfServiceAgreed: true, ...(email ? { contact: [`mailto:${email}`] } : {}) }, { useJwk: true });
    this.#kid = res.headers.get('location') ?? '';
    if (!this.#kid) throw fail(502, 'The certificate authority did not return an account.');
    return this.#kid;
  }

  async #get(url) {
    return (await this.#post(url, '')).body;
  }

  /** Wait until the object at `url` reaches one of `done` statuses (or fails). */
  async #poll(url, done, failed = ['invalid']) {
    const until = Date.now() + POLL_TIMEOUT_MS;
    let wait = this.#pollMs;
    for (;;) {
      const body = await this.#get(url);
      if (done.includes(body.status)) return body;
      if (failed.includes(body.status)) return body;
      if (Date.now() > until) throw fail(504, 'The certificate authority took too long to answer; try again in a few minutes.');
      await sleep(wait);
      wait = Math.min(wait * 2, 5000);
    }
  }

  /**
   * Get a certificate for `names`. `publish(token, keyAuthorization)` makes the challenge
   * answer available on port 80 and `unpublish(token)` removes it.
   * Returns { chain (PEM), key (PEM) }.
   */
  async obtain({ names, email = '', publish, unpublish = () => {} }) {
    const dir = await this.directory();
    await this.account(email);
    const created = await this.#post(dir.newOrder, { identifiers: names.map((value) => ({ type: 'dns', value })) });
    const orderUrl = created.headers.get('location');
    let order = created.body;
    const tokens = [];
    try {
      for (const authzUrl of order.authorizations ?? []) {
        const authz = await this.#get(authzUrl);
        if (authz.status === 'valid') continue;
        const challenge = (authz.challenges ?? []).find((c) => c.type === 'http-01');
        if (!challenge) throw fail(502, `The certificate authority offers no HTTP check for ${authz.identifier?.value ?? 'a name'}.`);
        publish(challenge.token, this.keyAuthorization(challenge.token));
        tokens.push(challenge.token);
        await this.#post(challenge.url, {});
        const result = await this.#poll(authzUrl, ['valid']);
        if (result.status !== 'valid') {
          const problem = (result.challenges ?? []).find((c) => c.type === 'http-01')?.error;
          throw problemError(problem ?? { detail: `${authz.identifier?.value}: the check failed.` }, 403);
        }
      }
      const request = certificateRequest(names);
      order = await this.#poll(orderUrl, ['ready', 'valid']);
      if (order.status === 'ready') {
        await this.#post(order.finalize, { csr: b64u(pemBody(request.csr)) });
        order = await this.#poll(orderUrl, ['valid']);
      }
      if (order.status !== 'valid' || !order.certificate) throw problemError(order.error ?? { detail: 'The order was not completed.' }, 502);
      const chain = (await this.#post(order.certificate, '', { accept: 'application/pem-certificate-chain' })).body;
      if (!String(chain).includes('-----BEGIN CERTIFICATE-----')) throw fail(502, 'The certificate authority did not send a certificate.');
      return { chain: String(chain), key: request.key };
    } finally {
      for (const token of tokens) unpublish(token);
    }
  }
}

/**
 * The Let's Encrypt option of Settings → HTTPS: its choices (DATA_DIR/acme.json), the challenge
 * answers, getting a certificate in the background, and renewing it.
 */
export class AcmeService {
  #file;
  #keyDir;
  #state;
  #https;
  #log;
  #fetch;
  #directories;
  #pollMs;
  #challenges = new Map();
  #running = null;
  #timer = null;
  #listeners = new Set();

  /**
   * @param {object} options
   * @param {string} options.dataDir
   * @param {{install: Function}} options.https  the HttpsManager the certificate is put into
   */
  constructor({ dataDir, https, log = console, fetch = globalThis.fetch, directories = DIRECTORIES, pollMs = 1000 }) {
    this.#file = path.join(dataDir, 'acme.json');
    this.#keyDir = path.join(dataDir, 'tls', 'acme');
    this.#https = https;
    this.#log = log;
    this.#fetch = fetch;
    this.#directories = directories;
    this.#pollMs = pollMs;
    this.#state = this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
      return { enabled: false, names: [], email: '', staging: false, skipPrecheck: false, last: null, issued: null, ...raw };
    } catch {
      return { enabled: false, names: [], email: '', staging: false, skipPrecheck: false, last: null, issued: null };
    }
  }

  #save() {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.#state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.#file);
  }

  /** Called with { kind: 'issued' | 'failed', ... } after every attempt (for the audit log). */
  onEvent(listener) {
    this.#listeners.add(listener);
  }

  #emit(event) {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {}
    }
  }

  /** The answer the CA expects at /.well-known/acme-challenge/<token>, or null. */
  challenge(token) {
    const t = String(token ?? '');
    return TOKEN.test(t) ? this.#challenges.get(t) ?? null : null;
  }

  #directoryUrl(staging) {
    return staging ? this.#directories.staging : this.#directories.production;
  }

  /** The account key for one CA directory, made the first time (kept: the account is reused). */
  #accountKey(staging) {
    const file = path.join(this.#keyDir, staging ? 'account-staging.key' : 'account.key');
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {}
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    fs.mkdirSync(this.#keyDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, pem, { mode: 0o600 });
    return pem;
  }

  get running() {
    return Boolean(this.#running);
  }

  status(now = Date.now()) {
    const s = this.#state;
    const validTo = s.issued?.validTo ? Date.parse(s.issued.validTo) : NaN;
    return {
      enabled: Boolean(s.enabled),
      names: s.names,
      email: s.email,
      staging: Boolean(s.staging),
      skipPrecheck: Boolean(s.skipPrecheck),
      running: this.running,
      last: s.last,
      issued: s.issued,
      daysLeft: Number.isFinite(validTo) ? Math.floor((validTo - now) / 86_400_000) : null,
      renewsFrom: Number.isFinite(validTo) ? new Date(validTo - RENEW_DAYS * 86_400_000).toISOString() : null,
      agreement: SUBSCRIBER_AGREEMENT,
    };
  }

  /**
   * Before asking the CA: fetch each name's challenge address the way the CA will, so a DNS
   * name that points elsewhere or a closed port 80 is found first (failed checks count
   * against the CA's limits). Returns [{ name, ok, error }].
   */
  async precheck(names) {
    const results = [];
    for (const name of names) {
      const token = `mz-check-${randomBytes(12).toString('base64url')}`;
      const expected = `${token}.self-check`;
      this.#challenges.set(token, expected);
      try {
        const res = await this.#fetch(`http://${name}${CHALLENGE_PREFIX}${token}`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
        const body = res.ok ? (await res.text()).trim() : '';
        results.push(body === expected ? { name, ok: true } : { name, ok: false, error: res.ok ? 'another server answered at this name' : `HTTP ${res.status}` });
      } catch (error) {
        results.push({ name, ok: false, error: error.cause?.code || error.name === 'TimeoutError' ? `no answer (${error.cause?.code ?? 'timeout'})` : error.message });
      } finally {
        this.#challenges.delete(token);
      }
    }
    return results;
  }

  /**
   * Get a certificate, in the background (poll status()). `agree`: the person accepted the
   * CA's subscriber agreement. `skipPrecheck`: for a server that cannot reach its own public
   * name (hairpin NAT) although the internet can.
   */
  start({ names, email = '', staging = false, agree = false, skipPrecheck = false, by = '' } = {}) {
    if (this.#running) throw fail(409, 'A certificate is already being requested.');
    if (agree !== true) throw fail(400, 'Agree to the Let\'s Encrypt Subscriber Agreement first.');
    const clean = cleanNames(names);
    const mail = String(email ?? '').trim().slice(0, 200);
    if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw fail(400, 'Enter a valid email address, or leave it empty.');
    const job = { names: clean, email: mail, staging: Boolean(staging), skipPrecheck: Boolean(skipPrecheck), by: String(by ?? '') };
    this.#state.last = { at: new Date().toISOString(), running: true, by: job.by, names: clean, staging: job.staging };
    this.#save();
    this.#running = this.#run(job).finally(() => {
      this.#running = null;
    });
    return this.status();
  }

  /** Wait for the attempt in progress (tests, and shutdown). */
  async settled() {
    await this.#running?.catch(() => {});
  }

  async #run(job) {
    const at = new Date().toISOString();
    try {
      if (!job.skipPrecheck) {
        const checks = await this.precheck(job.names);
        const failed = checks.filter((c) => !c.ok);
        if (failed.length) {
          throw fail(409, `This server could not reach itself at ${failed.map((c) => `http://${c.name}/ (${c.error})`).join(', ')}. Let's Encrypt checks the same address on port 80: point the DNS name at this server and open port 80 to the internet. If the internet can reach it but this server cannot reach its own public name, tick "Skip the self-check".`, { precheck: checks });
        }
      }
      const client = new AcmeClient({ directoryUrl: this.#directoryUrl(job.staging), accountKey: this.#accountKey(job.staging), fetch: this.#fetch, pollMs: this.#pollMs });
      const { chain, key } = await client.obtain({
        names: job.names,
        email: job.email,
        publish: (token, value) => this.#challenges.set(token, value),
        unpublish: (token) => this.#challenges.delete(token),
      });
      const report = await this.#https.install({
        files: [
          { name: 'letsencrypt.crt', data: Buffer.from(chain).toString('base64') },
          { name: 'letsencrypt.key', data: Buffer.from(key).toString('base64') },
        ],
        hosts: job.names,
        confirm: true,
        by: job.by ? `Let's Encrypt, for ${job.by}` : "Let's Encrypt",
      });
      const leaf = new X509Certificate(chain);
      this.#state = {
        ...this.#state,
        enabled: true,
        names: job.names,
        email: job.email,
        staging: job.staging,
        skipPrecheck: job.skipPrecheck,
        issued: { at: new Date().toISOString(), validTo: new Date(leaf.validTo).toISOString(), names: job.names, issuer: report.summary?.issuer ?? leaf.issuer, staging: job.staging, fingerprint: report.summary?.fingerprint ?? '' },
        last: { at, ok: true, by: job.by, names: job.names, staging: job.staging },
      };
      this.#save();
      this.#log.log?.(`[https] Let's Encrypt certificate for ${job.names.join(', ')} put to use (valid until ${this.#state.issued.validTo.slice(0, 10)}${job.staging ? ', staging: not trusted by browsers' : ''}).`);
      this.#emit({ kind: 'issued', names: job.names, staging: job.staging, validTo: this.#state.issued.validTo, by: job.by });
    } catch (error) {
      this.#state = { ...this.#state, last: { at, ok: false, error: error.message, by: job.by, names: job.names, staging: job.staging, ...(error.precheck ? { precheck: error.precheck } : {}) } };
      this.#save();
      this.#log.warn?.(`! [https] Let's Encrypt certificate for ${job.names.join(', ')} not obtained: ${error.message}`);
      this.#emit({ kind: 'failed', names: job.names, staging: job.staging, error: error.message, by: job.by });
    }
  }

  /** Stop renewing on its own (the certificate in use stays until it expires or is replaced). */
  disable() {
    if (!this.#state.enabled) throw fail(400, 'Automatic renewal is not on.');
    this.#state = { ...this.#state, enabled: false };
    this.#save();
  }

  /** Is a renewal due now? */
  renewalDue(now = Date.now()) {
    const s = this.#state;
    if (!s.enabled || !s.issued?.validTo || this.#running) return false;
    if (Date.parse(s.issued.validTo) - now > RENEW_DAYS * 86_400_000) return false;
    if (s.last && !s.last.ok && !s.last.running && now - Date.parse(s.last.at) < RETRY_AFTER_FAILURE_MS) return false;
    return true;
  }

  /** Renew now, with the names and choices of the certificate in use. */
  renew({ by = 'automatic renewal' } = {}) {
    const s = this.#state;
    if (!s.names?.length) throw fail(400, 'No Let\'s Encrypt certificate has been requested yet.');
    return this.start({ names: s.names, email: s.email, staging: s.staging, skipPrecheck: s.skipPrecheck, agree: true, by });
  }

  /** Check twice a day whether a renewal is due (and once soon after start). */
  startRenewal({ intervalMs = 12 * 60 * 60 * 1000, firstMs = 2 * 60 * 1000 } = {}) {
    const check = () => {
      try {
        if (this.renewalDue()) {
          this.#log.log?.(`[https] Renewing the Let's Encrypt certificate for ${this.#state.names.join(', ')}.`);
          this.renew();
        }
      } catch (error) {
        this.#log.warn?.(`! [https] Let's Encrypt renewal could not start: ${error.message}`);
      }
    };
    const first = setTimeout(check, firstMs);
    first.unref?.();
    this.#timer = setInterval(check, intervalMs);
    this.#timer.unref?.();
  }

  stop() {
    clearInterval(this.#timer);
  }
}
