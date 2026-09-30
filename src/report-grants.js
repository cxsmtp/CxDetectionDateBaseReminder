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

  /** @param {{file?: string, secret?: string}} options */
  constructor({ file, secret } = {}) {
    this.#key = secret ? Buffer.from(secret) : loadOrCreateKey(file);
  }

  #mac(finding, exp) {
    const message = [...FIELDS.map((field) => String(finding[field] ?? '')), String(exp)].join('\n');
    return createHmac('sha256', this.#key).update(message).digest('base64url');
  }

  macText(text) {
    return createHmac('sha256', this.#key).update(text).digest('base64url');
  }

  issue(finding, now = Date.now()) {
    const exp = now + GRANT_TTL_MS;
    return { exp, grant: this.#mac(finding, exp) };
  }

  /** '' when the finding's grant is valid, otherwise 'expired' or 'invalid'. */
  verify(finding, now = Date.now()) {
    const exp = Number(finding?.exp);
    if (!Number.isFinite(exp)) return 'invalid';
    if (exp <= now) return 'expired';
    const expected = Buffer.from(this.#mac(finding, exp));
    const given = Buffer.from(String(finding.grant ?? ''));
    return given.length === expected.length && timingSafeEqual(given, expected) ? '' : 'invalid';
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
