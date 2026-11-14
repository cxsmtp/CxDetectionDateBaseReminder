/**
 * Single sign-on with OpenID Connect: people sign in at the organisation's identity provider
 * (Microsoft Entra ID, Okta, Keycloak, Google, …) and come back here with a code.
 *
 * - The authorization code flow, with PKCE (S256), `state` and `nonce`. What a round trip needs is
 *   kept here in memory (SsoFlows), for ten minutes, once, and tied to the browser that started it by
 *   an HttpOnly, SameSite=Lax cookie.
 * - Where the provider's endpoints and keys are comes from <issuer>/.well-known/openid-configuration,
 *   kept for an hour and read again when something does not verify.
 * - The ID token is verified here with Node's own crypto against the provider's keys (JWKS): RS256,
 *   PS256 or ES256 only (never "none", never a shared-secret HS*), then its issuer, audience (and
 *   authorized party), expiry, issue time and nonce.
 * - Every address called (discovery, keys, token, userinfo) passes the server's rule for outgoing
 *   addresses (src/outbound-url.js): https only (plain http just for this machine), never a link-local
 *   or cloud metadata address, by name or by what the name resolves to. Calls are made with fetch,
 *   so they go through the proxy and trust the certificates every other outgoing call does
 *   (src/network.js, src/trust.js). Redirects are not followed.
 * - What a person is told is a plain sentence chosen by a short code; tokens, the client secret and
 *   the provider's own error text are never part of it, nor of what is logged.
 *
 * Nothing here knows about people or sessions: src/server.js decides who the email belongs to.
 */
import { constants, createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';

import { proxyFor } from './network.js';
import { blockedHost, outboundUrlProblem } from './outbound-url.js';

export const SSO_CALLBACK_PATH = '/api/session/oidc/callback';
export const SSO_COOKIE = 'cxdr_sso';
export const SSO_FLOW_TTL_MS = 10 * 60 * 1000;
export const ID_TOKEN_ALGORITHMS = ['RS256', 'PS256', 'ES256'];
const DEFAULT_LABEL = 'Sign in with single sign-on';
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
/** Keys and discovery are read again after a failure, but not more often than this. */
const REFRESH_GAP_MS = 30 * 1000;
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_TOKEN_CHARS = 64 * 1024;
/** How far the provider's clock and this server's may differ. */
const CLOCK_SKEW_S = 60;
const EMAIL = /^(?=[^]{3,254}$)[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const LOOPBACK_HTTP = /^http:\/\/(localhost|127(\.\d{1,3}){3}|\[::1\])(:\d+)?(\/|$)/i;

/** Single sign-on as saved in iam.json (policy.sso). */
export const DEFAULT_SSO = {
  enabled: false,
  issuer: '',
  clientId: '',
  // A secret like the mail password: stored, never sent to a browser.
  clientSecret: '',
  label: DEFAULT_LABEL,
  // Email domains that may sign in this way; none listed: any.
  domains: [],
  // 'existing': only people already in People & roles. 'create': add them at their first sign-in, with `role`.
  provision: 'existing',
  role: 'user',
  requireVerifiedEmail: true,
  // With single sign-on on: only people with the Admin role may still sign in with a password.
  passwordAdminsOnly: false,
};

/** Why single sign-on did not sign someone in: `code` picks the sentence the page shows; `message` is for the audit log and the server log. */
export class SsoError extends Error {
  /** `keys`: the provider's keys may have changed since they were read, so reading them again may put it right. */
  constructor(code, message, { keys = false } = {}) {
    super(message);
    this.name = 'SsoError';
    this.code = code;
    this.keys = keys;
  }
}

const refuse = (message) => Object.assign(new Error(message), { status: 400 });
const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);

/** A list of email domains from a text or a list: lower case, without "@". Anything that is not a domain throws. */
function cleanDomains(value, { strict = true } = {}) {
  const entries = (Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/)).map((d) => String(d ?? '').trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  const out = [];
  for (const domain of entries) {
    const ok = domain.length <= 253 && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain);
    if (!ok && strict) throw refuse(`"${domain.slice(0, 60)}" is not an email domain. Write domains such as company.com, separated by commas.`);
    if (ok && !out.includes(domain)) out.push(domain);
  }
  return out.slice(0, 50);
}

/** The issuer as it may be saved: an address the server may call, without a query or fragment. '' when it is not one. */
function issuerProblem(issuer) {
  const problem = outboundUrlProblem(issuer, { allowLoopbackHttp: true });
  if (problem) return `The identity provider's address ${problem}.`;
  const url = new URL(issuer);
  if (url.search || url.hash) return 'The identity provider\'s address must not have a "?" or "#" part.';
  return '';
}

const hostOf = (address) => {
  try {
    return new URL(address).host.toLowerCase();
  } catch {
    return '';
  }
};

/** What was saved, made whole: every field present and of its kind. Never throws (a file from another version loads). */
export function storedSso(raw = {}) {
  const saved = raw && typeof raw === 'object' ? raw : {};
  const issuer = text(saved.issuer, 300);
  const out = {
    ...DEFAULT_SSO,
    enabled: saved.enabled === true,
    issuer: issuer && !issuerProblem(issuer) ? issuer : '',
    clientId: text(saved.clientId, 300),
    clientSecret: typeof saved.clientSecret === 'string' ? saved.clientSecret : '',
    label: text(saved.label, 60) || DEFAULT_LABEL,
    domains: cleanDomains(saved.domains, { strict: false }),
    provision: saved.provision === 'create' ? 'create' : 'existing',
    role: text(saved.role, 80) || DEFAULT_SSO.role,
    requireVerifiedEmail: saved.requireVerifiedEmail !== false,
    passwordAdminsOnly: saved.passwordAdminsOnly === true,
  };
  if (!out.issuer || !out.clientId) out.enabled = false;
  if (!out.enabled) out.passwordAdminsOnly = false;
  // People are never added by themselves without a domain to hold them to.
  if (!out.domains.length) out.provision = 'existing';
  return out;
}

/**
 * An Admin's change over what is saved, each field checked; throws (status 400) with a sentence that says what to
 * put right. The client secret: left out keeps the saved one, a text replaces it, null takes it out; and it is
 * never sent to another host, so a new issuer host needs it typed again. `roles`: the ids new people may be given.
 */
export function mergeSso(current, incoming = {}, { roles = [] } = {}) {
  const out = storedSso(current);
  const input = incoming && typeof incoming === 'object' ? incoming : {};
  if ('issuer' in input) {
    const issuer = text(input.issuer, 300);
    if (issuer) {
      const problem = issuerProblem(issuer);
      if (problem) throw refuse(problem);
    }
    if (hostOf(issuer) !== hostOf(out.issuer)) out.clientSecret = '';
    out.issuer = issuer;
  }
  if ('clientId' in input) out.clientId = text(input.clientId, 300);
  if (typeof input.clientSecret === 'string' && input.clientSecret !== '') {
    if (input.clientSecret.length > 2000) throw refuse('That client secret is too long.');
    out.clientSecret = input.clientSecret;
  }
  if (input.clientSecret === null) out.clientSecret = '';
  if ('label' in input) out.label = text(input.label, 60) || DEFAULT_LABEL;
  if ('domains' in input) out.domains = cleanDomains(input.domains);
  if ('requireVerifiedEmail' in input) out.requireVerifiedEmail = input.requireVerifiedEmail !== false;
  if ('provision' in input) {
    if (!['existing', 'create'].includes(input.provision)) throw refuse('Choose who may sign in this way: people already in People & roles, or everyone the identity provider signs in.');
    out.provision = input.provision;
  }
  if ('role' in input) out.role = text(input.role, 80);
  if (out.provision === 'create') {
    // Without a domain, everyone the identity provider signs in (a guest, another organisation's account) would be added.
    if (!out.domains.length) throw refuse('List at least one email domain allowed before adding people at their first single sign-on. Otherwise everyone the identity provider signs in would be added.');
    if (out.role === 'admin') throw refuse('People added by single sign-on cannot be given the Admin role. Choose another role, and make someone an Admin under People & roles.');
    if (!roles.includes(out.role)) throw refuse('Choose the role people added by single sign-on get.');
  }
  if ('enabled' in input) out.enabled = input.enabled === true;
  if ('passwordAdminsOnly' in input) out.passwordAdminsOnly = input.passwordAdminsOnly === true;
  // Turned off: passwords are for everyone again, unless this very change asks otherwise (which is refused below).
  if (!out.enabled && input.passwordAdminsOnly !== true) out.passwordAdminsOnly = false;
  if (out.enabled && (!out.issuer || !out.clientId)) throw refuse('Give the identity provider\'s address and the client id before turning single sign-on on.');
  if (out.passwordAdminsOnly && !out.enabled) throw refuse('Turn single sign-on on before keeping passwords for Admins only.');
  return out;
}

/** Single sign-on settings for the Admin's page: the client secret is replaced by whether one is set. */
export function publicSso(sso) {
  const { clientSecret, ...rest } = storedSso(sso);
  return { ...rest, clientSecretSet: Boolean(clientSecret) };
}

/** Which settings differ between two saved states, by name; the client secret only as "client secret". */
export function ssoChanges(before, after) {
  const names = { enabled: 'on or off', issuer: 'identity provider address', clientId: 'client id', clientSecret: 'client secret', label: 'button label', domains: 'email domains', provision: 'who may sign in', role: 'role for new people', requireVerifiedEmail: 'verified email check', passwordAdminsOnly: 'passwords for Admins only' };
  return Object.keys(names).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key])).map((key) => names[key]);
}

/**
 * Why this identity may not sign in, as an SsoError, or null: the email must be there, be marked verified by the
 * provider (unless the Admin turned that check off), and be in one of the allowed domains (when any are listed).
 */
export function identityProblem(sso, identity) {
  if (!identity?.sub || String(identity.sub).length > 255) return new SsoError('token', 'the identity provider names no subject this server can keep');
  if (!identity?.email) return new SsoError('email', 'the identity provider gave no email address');
  if (sso.requireVerifiedEmail && !identity.verified) return new SsoError('email', `the identity provider does not mark ${identity.email} as verified`);
  const domain = identity.email.split('@').pop();
  if (sso.domains.length && !sso.domains.includes(domain)) return new SsoError('domain', `${identity.email} is not in an allowed email domain`);
  return null;
}

const b64url = (bytes) => Buffer.from(bytes).toString('base64url');
const sha256 = (value) => createHash('sha256').update(value).digest();
/** A random value of 256 bits, as base64url (43 characters): a state, a nonce, a PKCE verifier, a cookie. */
const random = () => b64url(randomBytes(32));
const RANDOM = /^[A-Za-z0-9_-]{43}$/;

/**
 * Round trips to the identity provider that have started and not come back: state → { nonce, verifier, browser }.
 * In memory, ten minutes, used once. `browser` is the hash of the cookie given to the browser that started, so a
 * link to the way back made for someone else's browser signs nobody in.
 */
export class SsoFlows {
  #flows = new Map();
  #ttlMs;
  #max;

  constructor({ ttlMs = SSO_FLOW_TTL_MS, max = 5000 } = {}) {
    this.#ttlMs = ttlMs;
    this.#max = max;
  }

  /**
   * Start one, with a cookie value made here for it: never one the browser presents, which someone else could
   * have put there to finish the round trip in their own browser.
   */
  start(now = Date.now()) {
    for (const [key, flow] of this.#flows) if (flow.exp <= now) this.#flows.delete(key);
    for (const key of this.#flows.keys()) {
      if (this.#flows.size < this.#max) break;
      this.#flows.delete(key);
    }
    const flow = { state: random(), nonce: random(), verifier: random(), cookie: random() };
    this.#flows.set(flow.state, { nonce: flow.nonce, verifier: flow.verifier, browser: b64url(sha256(flow.cookie)), exp: now + this.#ttlMs });
    return { ...flow, challenge: b64url(sha256(flow.verifier)) };
  }

  /** The round trip a `state` belongs to, once, and only for the browser that started it; else null. */
  take(state, cookie, now = Date.now()) {
    if (!RANDOM.test(String(state ?? ''))) return null;
    const flow = this.#flows.get(state);
    if (!flow) return null;
    this.#flows.delete(state);
    if (flow.exp <= now || !RANDOM.test(String(cookie ?? '')) || b64url(sha256(String(cookie))) !== flow.browser) return null;
    return { nonce: flow.nonce, verifier: flow.verifier };
  }

  get size() {
    return this.#flows.size;
  }
}

/** A JSON part of a token (its header or its claims), or null. */
function tokenPart(part) {
  try {
    const value = JSON.parse(Buffer.from(String(part), 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** The provider's key for a token, as a key object; throws an SsoError when there is none that fits. */
function keyFor(header, keys) {
  const family = header.alg === 'ES256' ? 'EC' : 'RSA';
  const usable = keys.filter((k) => k && typeof k === 'object' && k.kty === family && (k.use === undefined || k.use === 'sig') && (k.alg === undefined || k.alg === header.alg) && (family !== 'EC' || k.crv === 'P-256'));
  const jwk = header.kid !== undefined ? usable.find((k) => k.kid === header.kid) : usable.length === 1 ? usable[0] : null;
  if (!jwk) throw new SsoError('token', 'the ID token is signed with a key the identity provider does not publish', { keys: true });
  let key;
  try {
    // Only the public parts are handed over, whatever else the key set carries.
    key = createPublicKey({ format: 'jwk', key: family === 'EC' ? { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } : { kty: 'RSA', n: jwk.n, e: jwk.e } });
  } catch {
    throw new SsoError('token', 'the identity provider publishes a key that cannot be read');
  }
  if (family === 'RSA' && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new SsoError('token', 'the identity provider\'s RSA key is shorter than 2048 bits');
  return key;
}

/**
 * Verify an ID token against the provider's keys and return its claims; throws an SsoError that says what was
 * wrong (in words fit for the audit log: never the token). `keys`: the JWKS's keys. `now` in milliseconds.
 */
export function verifyIdToken(token, { keys, issuer, clientId, nonce, now = Date.now() }) {
  const parts = typeof token === 'string' && token.length <= MAX_TOKEN_CHARS ? token.split('.') : [];
  const header = parts.length === 3 ? tokenPart(parts[0]) : null;
  const claims = parts.length === 3 ? tokenPart(parts[1]) : null;
  if (!header || !claims) throw new SsoError('token', 'the identity provider sent no ID token that can be read');
  // Only signatures made with the provider's private key: "none" and the shared-secret HS* are refused by name.
  if (!ID_TOKEN_ALGORITHMS.includes(header.alg)) throw new SsoError('token', `the ID token is signed with "${text(header.alg, 20) || 'nothing'}", which is not accepted (only ${ID_TOKEN_ALGORITHMS.join(', ')})`);
  if (header.crit !== undefined) throw new SsoError('token', 'the ID token asks for an extension this server does not know');
  const key = keyFor(header, Array.isArray(keys) ? keys : []);
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2], 'base64url');
  let ok = false;
  try {
    if (header.alg === 'RS256') ok = verifySignature('sha256', signed, key, signature);
    else if (header.alg === 'PS256') ok = verifySignature('sha256', signed, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, signature);
    else ok = signature.length === 64 && verifySignature('sha256', signed, { key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    ok = false;
  }
  if (!ok) throw new SsoError('token', 'the ID token\'s signature does not match the identity provider\'s key', { keys: true });

  const seconds = Math.floor(now / 1000);
  if (typeof claims.iss !== 'string' || claims.iss !== issuer) throw new SsoError('token', 'the ID token comes from another issuer');
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(clientId)) throw new SsoError('token', 'the ID token was made for another application (audience)');
  if (audience.length > 1 && claims.azp !== clientId) throw new SsoError('token', 'the ID token names several audiences and another authorized party');
  if (claims.azp !== undefined && claims.azp !== clientId) throw new SsoError('token', 'the ID token was made for another application (authorized party)');
  if (!Number.isFinite(claims.exp) || claims.exp + CLOCK_SKEW_S <= seconds) throw new SsoError('token', 'the ID token has expired');
  if (!Number.isFinite(claims.iat) || claims.iat - CLOCK_SKEW_S > seconds) throw new SsoError('token', 'the ID token has no issue time, or one in the future');
  if (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf - CLOCK_SKEW_S > seconds)) throw new SsoError('token', 'the ID token is not valid yet');
  if (typeof claims.nonce !== 'string' || claims.nonce !== nonce) throw new SsoError('token', 'the ID token does not belong to this sign-in (nonce)');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new SsoError('token', 'the ID token names no subject');
  return claims;
}

/** An email claim as this server takes it: lower case, and shaped like an address; else ''. */
const emailOf = (value) => {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return EMAIL.test(email) ? email : '';
};
const verifiedOf = (value) => value === true || value === 'true';

/** The provider's error code (a short word such as invalid_client), for the log: never its description. */
const providerCode = (body) => (typeof body?.error === 'string' && /^[a-z0-9_.-]{1,60}$/i.test(body.error) ? body.error : '');

export class OidcClient {
  #fetch;
  #lookup;
  #proxy;
  #now;
  #discovery = new Map(); // issuer -> { doc, at }
  #keys = new Map(); // jwks_uri -> { keys, at }

  /**
   * `fetch`, `lookup`, `proxy` and `now` can be replaced in tests; by default the server's own: fetch goes through
   * the proxy this server uses and trusts the certificates every other outgoing call does.
   */
  constructor({ fetch = (...args) => globalThis.fetch(...args), lookup = dns.promises.lookup, proxy = proxyFor, now = Date.now } = {}) {
    this.#fetch = fetch;
    this.#lookup = lookup;
    this.#proxy = proxy;
    this.#now = now;
  }

  /** Forget what was read from providers (the settings changed). */
  forget() {
    this.#discovery.clear();
    this.#keys.clear();
  }

  /** May the server call this address? Throws an SsoError when not. `localHttp`: plain http to this machine is fine (the issuer itself is). */
  async #allowed(address, what, localHttp) {
    const problem = outboundUrlProblem(address, { allowLoopbackHttp: localHttp });
    if (problem) throw new SsoError('setup', `the ${what} ${problem}`);
    const host = new URL(address).hostname.replace(/^\[(.*)\]$/, '$1');
    // Through a proxy the proxy resolves the name; directly, every address the name resolves to is checked too.
    if (net.isIP(host) || this.#proxy(host)) return;
    let addresses;
    try {
      addresses = await this.#lookup(host, { all: true });
    } catch {
      throw new SsoError('provider', `the ${what}'s host name does not resolve`);
    }
    if (addresses.some((a) => blockedHost(a.address))) throw new SsoError('setup', `the ${what} resolves to a link-local or cloud metadata address, which the server never calls`);
  }

  /** One call: JSON back, bounded in time and size, no redirect followed. Returns { status, body } (body null when it is not JSON). */
  async #call(address, what, localHttp, { method = 'GET', headers = {}, body } = {}) {
    await this.#allowed(address, what, localHttp);
    let response;
    try {
      response = await this.#fetch(address, { method, headers: { Accept: 'application/json', ...headers }, body, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      const code = error?.cause?.code || error?.code || error?.name || 'no answer';
      throw new SsoError('provider', `the ${what} could not be reached (${text(code, 60)})`);
    }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) throw new SsoError('provider', `the ${what} sent more than this server reads`);
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof SsoError) throw error;
      throw new SsoError('provider', `the ${what} stopped answering part way`);
    }
    let parsed = null;
    try {
      parsed = JSON.parse(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'));
    } catch {}
    return { status: response.status, body: parsed && typeof parsed === 'object' ? parsed : null };
  }

  /**
   * The provider's discovery document, checked: it must name this issuer, and its endpoints must be addresses
   * the server may call. Kept for an hour; `refresh` reads it again (not more often than every half minute);
   * `force` reads it now whatever is kept (the Admin's own check).
   */
  async discover(issuer, { refresh = false, force = false } = {}) {
    const now = this.#now();
    const kept = this.#discovery.get(issuer);
    if (kept && !force && now - kept.at < (refresh || kept.failed ? REFRESH_GAP_MS : DISCOVERY_TTL_MS)) return kept.doc;
    const localHttp = LOOPBACK_HTTP.test(issuer);
    const base = issuer.replace(/\/+$/, '');
    const { status, body } = await this.#call(`${base}/.well-known/openid-configuration`, 'identity provider\'s discovery address', localHttp);
    if (status !== 200 || !body) throw new SsoError('provider', `the identity provider's discovery address answered ${status}${body ? '' : ' without JSON'}`);
    if (typeof body.issuer !== 'string' || body.issuer.replace(/\/+$/, '') !== base) throw new SsoError('setup', 'the identity provider\'s discovery document names another issuer than the address set here');
    const doc = { issuer: body.issuer, localHttp };
    for (const [key, what, required] of [['authorization_endpoint', 'sign-in address', true], ['token_endpoint', 'token address', true], ['jwks_uri', 'keys address', true], ['userinfo_endpoint', 'userinfo address', false]]) {
      const value = body[key];
      if (value === undefined && !required) continue;
      if (typeof value !== 'string') throw new SsoError('setup', `the identity provider's discovery document has no ${what}`);
      const problem = outboundUrlProblem(value, { allowLoopbackHttp: localHttp });
      if (problem) throw new SsoError('setup', `the identity provider's ${what} ${problem}`);
      doc[key] = value;
    }
    const methods = body.token_endpoint_auth_methods_supported;
    // The standard's default is the secret in the Authorization header; the body only when the provider says it takes nothing else.
    doc.secretInBody = Array.isArray(methods) && methods.includes('client_secret_post') && !methods.includes('client_secret_basic');
    this.#discovery.set(issuer, { doc, at: now });
    return doc;
  }

  /** The provider's signing keys (JWKS). Kept for an hour; `refresh` and `force` as for discovery. */
  async keys(doc, { refresh = false, force = false } = {}) {
    const now = this.#now();
    const kept = this.#keys.get(doc.jwks_uri);
    if (kept && !force && now - kept.at < (refresh || kept.failed ? REFRESH_GAP_MS : DISCOVERY_TTL_MS)) return kept.keys;
    const { status, body } = await this.#call(doc.jwks_uri, 'identity provider\'s keys address', doc.localHttp);
    if (status !== 200 || !Array.isArray(body?.keys)) throw new SsoError('provider', `the identity provider's keys address answered ${status} without keys`);
    const keys = body.keys.slice(0, 100);
    this.#keys.set(doc.jwks_uri, { keys, at: now });
    return keys;
  }

  /** Where to send the browser: the provider's sign-in address with this round trip's state, nonce and PKCE challenge. */
  async authorizationUrl(sso, redirectUri, { state, nonce, challenge }) {
    const doc = await this.discover(sso.issuer);
    const url = new URL(doc.authorization_endpoint);
    for (const [key, value] of [['response_type', 'code'], ['client_id', sso.clientId], ['redirect_uri', redirectUri], ['scope', 'openid email profile'], ['state', state], ['nonce', nonce], ['code_challenge', challenge], ['code_challenge_method', 'S256']]) {
      url.searchParams.set(key, value);
    }
    return url.href;
  }

  /**
   * The way back: exchange the code, verify the ID token, and say who signed in: { email, verified, name, sub, issuer }.
   * The email comes from the ID token, or from userinfo when the token carries none. Throws an SsoError otherwise.
   */
  async finish(sso, redirectUri, flow) {
    try {
      return await this.#finish(sso, redirectUri, flow);
    } catch (error) {
      // Something did not work with what is kept of this provider: it is read again at the next sign-in, not an hour later.
      for (const kept of [this.#discovery.get(sso.issuer), ...this.#keys.values()]) if (kept) kept.failed = true;
      throw error;
    }
  }

  async #finish(sso, redirectUri, { code, nonce, verifier }) {
    const doc = await this.discover(sso.issuer);
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: sso.clientId, code_verifier: verifier });
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (sso.clientSecret && doc.secretInBody) form.set('client_secret', sso.clientSecret);
    else if (sso.clientSecret) headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(sso.clientId)}:${encodeURIComponent(sso.clientSecret)}`).toString('base64')}`;
    const answer = await this.#call(doc.token_endpoint, 'identity provider\'s token address', doc.localHttp, { method: 'POST', headers, body: form.toString() });
    if (answer.status !== 200 || typeof answer.body?.id_token !== 'string') {
      const said = providerCode(answer.body);
      throw new SsoError(said === 'invalid_client' ? 'setup' : 'provider', `the identity provider did not accept the code (HTTP ${answer.status}${said ? `, ${said}` : ''})`);
    }
    const check = (keys) => verifyIdToken(answer.body.id_token, { keys, issuer: doc.issuer, clientId: sso.clientId, nonce, now: this.#now() });
    let claims;
    try {
      claims = check(await this.keys(doc));
    } catch (error) {
      // The provider may have changed its keys since they were read: read them again, once, and check again.
      if (!(error instanceof SsoError) || !error.keys) throw error;
      claims = check(await this.keys(doc, { refresh: true }));
    }
    let identity = { email: emailOf(claims.email), verified: verifiedOf(claims.email_verified), name: text(claims.name, 120), sub: claims.sub, issuer: doc.issuer };
    if (!identity.email && doc.userinfo_endpoint && typeof answer.body.access_token === 'string') {
      const info = await this.#call(doc.userinfo_endpoint, 'identity provider\'s userinfo address', doc.localHttp, { headers: { Authorization: `Bearer ${answer.body.access_token}` } });
      // Userinfo is believed only when it is about the same person as the verified ID token.
      if (info.status === 200 && info.body?.sub === claims.sub) {
        identity = { ...identity, email: emailOf(info.body.email), verified: verifiedOf(info.body.email_verified), name: text(info.body.name, 120) || identity.name };
      }
    }
    return identity;
  }

  /** For the Admin's "Check" button: can the provider be reached, and what does it publish? Never throws. */
  async check(sso) {
    try {
      const doc = await this.discover(sso.issuer, { force: true });
      const keys = await this.keys(doc, { force: true });
      const usable = keys.filter((k) => ['RSA', 'EC'].includes(k?.kty)).length;
      if (!usable) return { ok: false, message: 'The identity provider answered, but publishes no RSA or EC signing key.' };
      return { ok: true, message: `The identity provider answered: ${usable} signing key${usable === 1 ? '' : 's'} found.`, issuer: doc.issuer };
    } catch (error) {
      if (!(error instanceof SsoError)) throw error;
      return { ok: false, message: `The identity provider could not be checked: ${error.message}.` };
    }
  }
}
