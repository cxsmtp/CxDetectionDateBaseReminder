/**
 * Signed, expiring permissions carried by an emailed report.
 *
 * The report asks this server to run AI Triage with the server's own
 * Checkmarx One connection. Each finding in the report carries a grant: an
 * HMAC over exactly the identifiers the relay will act on, plus an expiry.
 * The relay acts only on findings whose grant verifies, so the server cannot
 * be used to triage anything a report did not list.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const FIELDS = ['projectId', 'projectName', 'riskId', 'scanId', 'scanner', 'alternateId', 'groupId'];

/**
 * The tenant a report belongs to, bound into the grant so a report cannot act in
 * another tenant. The first tenant ("default", and every report from before
 * multi-tenancy) adds nothing, so its existing report links keep verifying.
 */
export const DEFAULT_TENANT = 'default';
const tenantPart = (finding) => {
  const tenant = String(finding?.tenant ?? '');
  return tenant && tenant !== DEFAULT_TENANT ? `\u0000tenant:${tenant}` : '';
};
const grantMessage = (finding, exp) => [...FIELDS.map((field) => String(finding[field] ?? '')), String(exp)].join('\n') + tenantPart(finding);

/** A key that survives restarts, so reports stay usable until they expire. */
function loadOrCreateKey(file) {
  if (!file) return randomBytes(32);
  try {
    const existing = fs.readFileSync(file);
    if (existing.length >= 32) return existing;
  } catch {}
  const key = randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, key, { mode: 0o600 });
  return key;
}

export class ReportGrants {
  #key;
  #tenantOf;
  #verified = new Map(); // grant -> the message it was verified for

  /**
   * @param {{file?: string, secret?: string, tenantOf?: () => string}} options
   *   `tenantOf`: the running tenant (several tenants). Every grant, link and token is then
   *   bound to it, whatever tenant a request claims, so a report acts only in its own tenant.
   */
  constructor({ file, secret, tenantOf = null } = {}) {
    this.#key = secret ? Buffer.from(secret) : loadOrCreateKey(file);
    this.#tenantOf = tenantOf;
  }

  /** The finding as signed: in the running tenant when there is one. */
  #bound(finding) {
    return this.#tenantOf ? { ...finding, tenant: this.#tenantOf() } : finding;
  }

  #mac(finding, exp) {
    return createHmac('sha256', this.#key).update(grantMessage(this.#bound(finding), exp)).digest('base64url');
  }

  macText(text) {
    const tenant = this.#tenantOf?.();
    return createHmac('sha256', this.#key).update(tenant && tenant !== DEFAULT_TENANT ? `${text}\u0000tenant:${tenant}` : text).digest('base64url');
  }

  issue(finding, now = Date.now()) {
    const exp = now + GRANT_TTL_MS;
    return { exp, grant: this.#mac(finding, exp) };
  }

  /**
   * '' when the finding's grant is valid, otherwise 'expired' or 'invalid'. A grant that
   * verified once is remembered with the exact message it signs, so an open report polling
   * every few seconds is not re-hashed each time: a later request is accepted from memory
   * only when it names exactly the same fields and expiry (anything else is hashed again).
   */
  verify(finding, now = Date.now()) {
    const exp = Number(finding?.exp);
    if (!Number.isFinite(exp)) return 'invalid';
    if (exp <= now) return 'expired';
    const grant = String(finding.grant ?? '');
    const message = grantMessage(this.#bound(finding), exp);
    if (this.#verified.get(grant) === message) return '';
    const expected = Buffer.from(createHmac('sha256', this.#key).update(message).digest('base64url'));
    const given = Buffer.from(grant);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'invalid';
    this.#verified.set(grant, message);
    if (this.#verified.size > 50_000) this.#verified.delete(this.#verified.keys().next().value);
    return '';
  }
}

/**
 * Who a report was made for, signed, so the audit log can say whose report
 * an action came from. {id, recipient, issuedAt, sig}; the recipient cannot
 * be changed without breaking the signature.
 */
ReportGrants.prototype.signReport = function signReport({ id, recipient = '', issuedAt = new Date().toISOString() }) {
  return { id, recipient, issuedAt, sig: this.macText(`report\n${id}\n${recipient}\n${issuedAt}`) };
};

ReportGrants.prototype.verifyReport = function verifyReport(token) {
  if (!token || typeof token !== 'object') return null;
  const { id, recipient = '', issuedAt = '', sig = '' } = token;
  if (!id || !sig) return null;
  const expected = Buffer.from(this.macText(`report\n${id}\n${recipient}\n${issuedAt}`));
  const given = Buffer.from(String(sig));
  return given.length === expected.length && timingSafeEqual(given, expected) ? { id: String(id), recipient: String(recipient), issuedAt: String(issuedAt) } : null;
};
