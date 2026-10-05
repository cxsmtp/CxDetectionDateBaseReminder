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

/** The maintainer's public key(s), base64 SPKI DER. Empty: no code is valid yet. */
export const ISSUER_KEYS = [];

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
 * Check a code: signed by a trusted key, well formed, not expired.
 * Returns { valid, reason?, id, org, maxTenants, issued, expires, daysLeft, warn }.
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
  const expires = Date.parse(p.expires);
  if (p.v !== 1 || !p.id || !p.org || !Number.isInteger(p.maxTenants) || p.maxTenants < 2 || !Number.isFinite(expires)) return fail('This activation code is not valid.');
  const daysLeft = Math.ceil((expires - now) / DAY_MS);
  const info = { id: String(p.id), org: String(p.org), maxTenants: p.maxTenants, issued: String(p.issued ?? ''), expires: new Date(expires).toISOString(), daysLeft };
  if (expires <= now) return { ...info, valid: false, expired: true, reason: `This activation code expired on ${info.expires.slice(0, 10)}.` };
  return { ...info, valid: true, warn: daysLeft <= WARN_DAYS };
}
