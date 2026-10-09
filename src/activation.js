/**
 * Activation codes for multi-tenant mode's Super Admin tasks (docs/multi-tenant.md).
 *
 * Multi-tenant mode itself works on every installation. Adding tenants, switching between
 * them and approving a tenant's own email server need an activation code issued by the
 * maintainer to an organisation that runs several Checkmarx One tenants. A code is checked
 * here, offline: nothing is sent anywhere.
 *
 * A code is `MZ1.<payload>.<signature>` (base64url): the payload is JSON
 * { v, id, org, maxTenants, issued, expires }, signed with the maintainer's Ed25519 key;
 * the public half is ISSUER_KEYS below. Codes are made with scripts/activation.mjs.
 */
import { createPublicKey, verify } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** The maintainer's public key(s), base64 SPKI DER. Empty: no code is valid yet. */
export const ISSUER_KEYS = [
  'MCowBQYDK2VwAyEAlWEwF9lhzKv0IZ1GaDJSmlJqaZd7Gc1JqvYju52uKo4=',
];

const PREFIX = 'MZ1';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Admins are told this long before a code expires. */
export const WARN_DAYS = 30;

const fail = (reason) => ({ valid: false, reason });

/** The issuer keys this process trusts: ISSUER_KEYS, and a test key only under `node --test`. */
function trustedKeys() {
  const keys = [...ISSUER_KEYS];
  if (process.env.NODE_TEST_CONTEXT && process.env.MZ_ACTIVATION_TEST_KEY) keys.push(process.env.MZ_ACTIVATION_TEST_KEY);
  return keys;
}

/** Read a code without trusting it: the payload, or null. */
export function readCode(code) {
  const parts = String(code ?? '').trim().split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  try {
    return { payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')), signed: Buffer.from(`${parts[0]}.${parts[1]}`), signature: Buffer.from(parts[2], 'base64url') };
  } catch {
    return null;
  }
}

/**
 * What a code may unlock. "tenants" is several Checkmarx One tenants; "lang:<code>" a gated
 * language; "calculator" the Cx Credits Calculator (credit projections for customers).
 */
export const SCOPES = new Set(['tenants', 'lang:he', 'calculator']);
/** For a language or calculator scope, whether the code turns it on or off. */
export const ACTIONS = new Set(['activate', 'deactivate']);

/**
 * Check a code: signed by a trusted key, well formed, not expired.
 * Returns { valid, reason?, id, org, scope, action, maxTenants, issued, expires, daysLeft, warn }.
 * `scope` defaults to "tenants" (codes issued before scopes existed). For a "lang:*"
 * scope, `action` is "activate" or "deactivate" and there is no tenant count.
 */
export function checkCode(code, { now = Date.now(), keys = trustedKeys() } = {}) {
  const read = readCode(code);
  if (!read) return fail('This is not an activation code.');
  if (!keys.length) return fail('This installation has no activation key to check codes with.');
  const signedBy = keys.some((key) => {
    try {
      return verify(null, read.signed, createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' }), read.signature);
    } catch {
      return false;
    }
  });
  if (!signedBy) return fail('This activation code is not valid.');
  const p = read.payload;
  const scope = String(p.scope ?? 'tenants');
  const expires = Date.parse(p.expires);
  const base = p.v === 1 && p.id && p.org && SCOPES.has(scope) && Number.isFinite(expires);
  const forTenants = scope === 'tenants' && Number.isInteger(p.maxTenants) && p.maxTenants >= 2;
  const action = String(p.action ?? '');
  const forLang = (scope.startsWith('lang:') || scope === 'calculator') && ACTIONS.has(action);
  if (!base || !(forTenants || forLang)) return fail('This activation code is not valid.');
  const daysLeft = Math.ceil((expires - now) / DAY_MS);
  const info = {
    id: String(p.id),
    org: String(p.org),
    scope,
    action: forLang ? action : '',
    maxTenants: forTenants ? p.maxTenants : 0,
    issued: String(p.issued ?? ''),
    expires: new Date(expires).toISOString(),
    daysLeft,
  };
  if (expires <= now) return { ...info, valid: false, expired: true, reason: `This activation code expired on ${info.expires.slice(0, 10)}.` };
  return { ...info, valid: true, warn: daysLeft <= WARN_DAYS };
}

/**
 * The activation codes accepted on this installation (DATA_DIR/activation.json): which
 * scopes they unlock, for whom, until when. Gated languages keep their own state
 * (src/languages.js); this keeps the multi-tenant one and the history of what was entered.
 */
export class ActivationStore {
  #file;
  #state;

  constructor({ file }) {
    this.#file = file;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      this.#state = { tenants: raw.tenants ?? null, calculator: raw.calculator ?? null, history: Array.isArray(raw.history) ? raw.history : [] };
    } catch {
      this.#state = { tenants: null, calculator: null, history: [] };
    }
  }

  #save() {
    mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#state, null, 2), { mode: 0o600 });
    renameSync(tmp, this.#file);
  }

  /** Record an accepted code (the result of checkCode) and who entered it. */
  record(result, by = '') {
    const entry = { id: result.id, org: result.org, scope: result.scope, action: result.action || 'activate', expires: result.expires, at: new Date().toISOString(), by: String(by ?? '') };
    if (result.scope === 'tenants') this.#state.tenants = { ...entry, maxTenants: result.maxTenants };
    if (result.scope === 'calculator') this.#state.calculator = entry;
    this.#state.history = [entry, ...this.#state.history].slice(0, 50);
    this.#save();
    return entry;
  }

  /** The multi-tenant activation in force: { org, maxTenants, expires, daysLeft, warn } or null. */
  tenants(now = Date.now()) {
    const t = this.#state.tenants;
    if (!t) return null;
    const daysLeft = Math.ceil((Date.parse(t.expires) - now) / DAY_MS);
    return { org: t.org, maxTenants: t.maxTenants, expires: t.expires, at: t.at, by: t.by, daysLeft, valid: daysLeft > 0, warn: daysLeft > 0 && daysLeft <= WARN_DAYS };
  }

  /** The Cx Credits Calculator: on (a code turned it on and has not expired), with when it ends; or null. */
  calculator(now = Date.now()) {
    const c = this.#state.calculator;
    if (!c || c.action !== 'activate') return null;
    const daysLeft = Math.ceil((Date.parse(c.expires) - now) / DAY_MS);
    if (daysLeft <= 0) return null;
    return { org: c.org, expires: c.expires, at: c.at, by: c.by, daysLeft, warn: daysLeft <= WARN_DAYS };
  }

  history() {
    return this.#state.history.map((h) => ({ ...h }));
  }
}
