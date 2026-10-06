/**
 * One-click links in MissionZero's own emails (hands-off mode, self-healing):
 * pause, resume, run now, send the status, stop the status, mark a case solved.
 *
 * A link carries what to do, for whom, in which tenant and until when, signed
 * with the server's key, so nobody can make one up or change one. Opening it
 * shows a page with one button: mail scanners that open every link never act.
 * A short reference in each email's subject lets a reply be matched to the
 * person it was sent to (src/hands-off.js reads the command).
 */

import { timingSafeEqual } from 'node:crypto';

export const ACTIONS = ['pause', 'resume', 'run', 'status', 'stop', 'solved'];
const DAY_MS = 86_400_000;
/** How long a link or reference stays good. */
export const LINK_DAYS = 30;

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * A signed token: `mac(text)` is the server's keyed hash (reportGrants.macText).
 * payload: { a: action, e: email, t: tenant id, r?: reference (a case number) }.
 */
export function signAction(mac, { a, e, t = '', r = '' }, now = Date.now()) {
  if (!ACTIONS.includes(a)) throw new Error(`Unknown action ${a}.`);
  const body = b64({ a, e: String(e).toLowerCase(), t, ...(r ? { r } : {}), x: now + LINK_DAYS * DAY_MS });
  return `${body}.${mac(`action\n${body}`)}`;
}

/** The payload of a genuine, unexpired token; null otherwise. */
export function readAction(mac, token, now = Date.now()) {
  const [body, sig, extra] = String(token ?? '').trim().split('.');
  if (!body || !sig || extra !== undefined || body.length > 2000) return null;
  const expected = Buffer.from(mac(`action\n${body}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || !ACTIONS.includes(payload.a) || typeof payload.e !== 'string' || !(payload.x > now)) return null;
  return payload;
}

/**
 * The short reference in the subject and at the end of every hands-off email:
 * derived from the address it was sent to, so a reply from that address can be
 * checked without anything stored, and short enough that no mail client breaks it.
 */
export const replyReference = (mac, email) => `MZR-${mac(`reply\n${String(email).toLowerCase()}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`;

/** The references (MZR-…) in a subject or text. */
export const findReferences = (text) => [...new Set(String(text ?? '').match(/MZR-[A-Za-z0-9]{12}/g) ?? [])];

/** The tenant a token names, read before it is checked (the check runs in that tenant). */
export function peekTenant(token) {
  try {
    const t = JSON.parse(Buffer.from(String(token ?? '').split('.')[0], 'base64url').toString('utf8'))?.t;
    return typeof t === 'string' ? t : '';
  } catch {
    return '';
  }
}
