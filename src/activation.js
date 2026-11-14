/**
 * Activation codes for multi-tenant mode's Super Admin tasks (docs/multi-tenant.md), and the product licence.
 *
 * The product licence: CxMissionZero works until the end of 31 March 2027 (UTC). After that every page shows
 * that it has been deactivated, until a product activation code from the maintainer is entered; the code says
 * until when it works (docs/activation-codes.md). Data is never deleted, and backups go on.
 *
 * What is kept of an accepted code is the signed code itself, and it is checked again each time this starts:
 * a date changed by hand in activation.json counts for nothing. A product entry kept by a version before
 * MZ-01.01.10 has no code with it, so it no longer counts until the code is entered again (the built-in date
 * still applies); entries of the other scopes kept by those versions stay as they were.
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
import { existsSync } from 'node:fs';

import { readState, writeState } from './state-file.js';

/** The maintainer's public key(s), base64 SPKI DER. Empty: no code is valid yet. */
export const ISSUER_KEYS = [
  'MCowBQYDK2VwAyEAlWEwF9lhzKv0IZ1GaDJSmlJqaZd7Gc1JqvYju52uKo4=',
];

const PREFIX = 'MZ1';
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** Admins are told this long before a code expires. */
export const WARN_DAYS = 30;

/** Without a product activation code, CxMissionZero works until this moment: the end of 31 March 2027, UTC. */
export const PRODUCT_DEADLINE = '2027-04-01T00:00:00.000Z';
/** What every page says once it has stopped. */
export const DEACTIVATED_MESSAGE = 'The product has been deactivated. Please reach out to Bhawani Singh.';

const fail = (reason) => ({ valid: false, reason });

// A release (the image) carries the list of its files (integrity.json, src/integrity/manifest.js); a development copy does not.
const RELEASE = existsSync(new URL('../integrity.json', import.meta.url));

/**
 * The issuer keys this process trusts: ISSUER_KEYS, and a test key only under `node --test` in a development copy
 * (never in a release, where it would let anyone sign their own codes).
 */
function trustedKeys() {
  const keys = [...ISSUER_KEYS];
  if (!RELEASE && process.env.NODE_TEST_CONTEXT && process.env.MZ_ACTIVATION_TEST_KEY) keys.push(process.env.MZ_ACTIVATION_TEST_KEY);
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
 * language; "feature:<name>" a feature held back until it is ready ("feature:impact": the Cx Credits
 * Calculator's Impact tab; "feature:faeFlush": Labs → FAE Flush; "feature:govern": Labs → Govern; "feature:statusBoard" and "feature:consolidated": Labs → Status board and Consolidated view). (MZ-01.00.62's "calculator" scope is gone: the calculator is a permission.)
 */
export const SCOPES = new Set(['tenants', 'lang:he', 'feature:impact', 'feature:faeFlush', 'feature:govern', 'feature:statusBoard', 'feature:consolidated', 'product']);
/** For a language scope, whether the code turns it on or off. */
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
  // A product code only activates: until its date, CxMissionZero works.
  const forLang = ((scope.startsWith('lang:') || scope.startsWith('feature:')) && ACTIONS.has(action)) || (scope === 'product' && action === 'activate');
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
    // The signed code itself: what the store keeps, and checks again when it starts.
    code: String(code).trim(),
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
  /** The entries that count: each as its signed code says (see #seal). */
  #sealed = { tenants: null, product: null, features: {} };
  #keys = null;

  constructor({ file, keys = null }) {
    this.#file = file;
    // The keys kept codes are checked with: the trusted ones, unless given (tests).
    this.#keys = keys;
    // A damaged file is never read as "no codes": the last good copy is used, or the server stops (src/state-file.js).
    const raw = readState(file, { fallback: {}, holds: 'the activation codes entered and the licence\'s clock' });
    this.#state = { tenants: raw.tenants ?? null, features: raw.features && typeof raw.features === 'object' ? raw.features : {}, product: raw.product ?? null, seenAt: String(raw.seenAt ?? ''), history: Array.isArray(raw.history) ? raw.history : [] };
    this.#seal();
  }

  /**
   * Each kept entry as its signed code says it: the scope, the action, the date and the tenant count are read from
   * the code, not from the file. An entry whose code does not verify (edited, or from another key) counts for
   * nothing. So does an entry without a code (kept by a version before MZ-01.01.10, or written by hand): the
   * code is entered once more, for the product, for several tenants and for every feature alike.
   */
  #seal() {
    const sealed = (entry, scope) => {
      if (!entry || typeof entry !== 'object') return null;
      if (!entry.code) return null;
      // now: 0, so an expired code still reads (its date then says it is over).
      const checked = checkCode(entry.code, { now: 0, ...(this.#keys ? { keys: this.#keys } : {}) });
      if (!checked.valid || checked.scope !== scope) return null;
      return { ...entry, org: checked.org, action: checked.action || 'activate', expires: checked.expires, ...(scope === 'tenants' ? { maxTenants: checked.maxTenants } : {}) };
    };
    this.#sealed = {
      tenants: sealed(this.#state.tenants, 'tenants'),
      product: sealed(this.#state.product, 'product'),
      features: Object.fromEntries(Object.entries(this.#state.features).map(([name, entry]) => [name, sealed(entry, `feature:${name}`)]).filter(([, entry]) => entry)),
    };
  }

  #save() {
    // Flushed to the disk, the file it replaces kept as its last good copy.
    writeState(this.#file, this.#state, { space: 2 });
  }

  /**
   * Why a code that checks out must still not replace the one in force for its scope ('' when it may): codes
   * are not tied to one server, so an older one, still in date, could be entered again to undo a later one
   * (to bring back a feature a deactivation code turned off, or to cut the product's date short).
   * - Issued before the code in force: never.
   * - `mustExtend` (the deactivated page, open to everyone): only a code that ends later than the one in force.
   * A code in force that is kept without its signed text (entered before MZ-01.01.10) is not compared.
   */
  refusal(result, { mustExtend = false } = {}) {
    const scope = String(result?.scope ?? '');
    const entry = scope === 'tenants' ? this.#state.tenants : scope === 'product' ? this.#state.product : scope.startsWith('feature:') ? this.#state.features[scope.slice(8)] : null;
    if (!entry?.code) return '';
    const current = checkCode(entry.code, { now: 0, ...(this.#keys ? { keys: this.#keys } : {}) });
    if (!current.valid || current.scope !== scope) return '';
    const issued = Date.parse(result.issued);
    const issuedBefore = Date.parse(current.issued);
    if (Number.isFinite(issued) && Number.isFinite(issuedBefore) && issued < issuedBefore) {
      return `This activation code was issued before the one in force (issued ${current.issued.slice(0, 10)}): ask for a new one.`;
    }
    if (mustExtend && current.action !== 'deactivate' && Date.parse(result.expires) <= Date.parse(current.expires)) {
      return `An activation code that runs until ${current.expires.slice(0, 10)} is already in force: this one does not run longer.`;
    }
    return '';
  }

  /** Record an accepted code (the result of checkCode) and who entered it. */
  record(result, by = '') {
    const entry = { id: result.id, org: result.org, scope: result.scope, action: result.action || 'activate', expires: result.expires, at: new Date().toISOString(), by: String(by ?? '') };
    // Kept with the signed code, so what it says can be checked again and never taken from this file alone.
    const kept = { ...entry, ...(result.code ? { code: result.code } : {}) };
    if (result.scope === 'tenants') this.#state.tenants = { ...kept, maxTenants: result.maxTenants };
    if (result.scope.startsWith('feature:')) this.#state.features[result.scope.slice(8)] = kept;
    if (result.scope === 'product') this.#state.product = kept;
    this.#state.history = [entry, ...this.#state.history].slice(0, 50);
    this.#save();
    this.#seal();
    return entry;
  }

  /** The multi-tenant activation in force: { org, maxTenants, expires, daysLeft, warn } or null. */
  tenants(now = Date.now()) {
    const t = this.#sealed.tenants;
    if (!t) return null;
    const daysLeft = Math.ceil((Date.parse(t.expires) - now) / DAY_MS);
    return { org: t.org, maxTenants: t.maxTenants, expires: t.expires, at: t.at, by: t.by, daysLeft, valid: daysLeft > 0, warn: daysLeft > 0 && daysLeft <= WARN_DAYS };
  }

  /** A held-back feature: on while its last code turned it on and is in date. { on, expired, org, expires } or null. */
  feature(name, now = Date.now()) {
    const f = this.#sealed.features[name];
    if (!f) return null;
    const inDate = Date.parse(f.expires) > now;
    return { on: f.action === 'activate' && inDate, expired: f.action === 'activate' && !inDate, org: f.org, expires: f.expires, at: f.at };
  }

  history() {
    return this.#state.history.map((h) => ({ ...h }));
  }

  /**
   * The time the licence goes by: never earlier than the latest it has seen (kept, at most hourly), so setting the
   * server's clock back does not undo the end date.
   */
  now(now = Date.now()) {
    const seen = Date.parse(this.#state.seenAt) || 0;
    if (now > seen + HOUR_MS) {
      this.#state.seenAt = new Date(now).toISOString();
      try {
        this.#save();
      } catch {}
    }
    return Math.max(now, seen);
  }

  /**
   * Whether CxMissionZero may work: until the end of 31 March 2027 (UTC), or a product code's date if later.
   * { active, until, daysLeft, warn, activation: { org, expires, at } | null, message }.
   */
  product(now = Date.now()) {
    const t = this.now(now);
    const code = this.#sealed.product;
    const coded = code?.action === 'activate' ? Date.parse(code.expires) || 0 : 0;
    const until = Math.max(Date.parse(PRODUCT_DEADLINE), coded);
    const active = t < until;
    const daysLeft = Math.ceil((until - t) / DAY_MS);
    return {
      active,
      until: new Date(until).toISOString(),
      daysLeft,
      warn: active && daysLeft <= WARN_DAYS,
      activation: code ? { org: code.org, expires: code.expires, at: code.at } : null,
      message: active ? '' : DEACTIVATED_MESSAGE,
    };
  }
}
