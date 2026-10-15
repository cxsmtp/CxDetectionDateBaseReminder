/**
 * Forgotten passwords: a one-time link sent to the account's own email address.
 *
 * - The link carries 32 random bytes. Only their SHA-256 is kept (in memory), so neither a
 *   copy of the data folder nor a memory dump of the store gives anyone a working link.
 * - One link per person at a time: asking again replaces the earlier one. It works once,
 *   for 30 minutes, and only while the account's password is the one it was made for, so
 *   a password changed any other way ends it too. A restart ends every link.
 * - Asking never says whether an address has an account: the answer is always the same,
 *   and the work (looking the person up, sending the email) happens after it is given.
 * - Asking is limited per address and per network address, so nobody can flood a mailbox.
 */
import { createHash, randomBytes } from 'node:crypto';

export const RESET_TTL_MS = 30 * 60 * 1000;
/** Per person: at most this many links an hour, and never two within a minute. */
export const PER_ACCOUNT_PER_HOUR = 3;
export const PER_ACCOUNT_GAP_MS = 60 * 1000;
/** Per network address: this many requests for a link, and links that did not work, a quarter of an hour. */
export const PER_IP_PER_WINDOW = 10;
const IP_WINDOW_MS = 15 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Who may reset a forgotten password by email (People & roles → Sign-in). */
export const RESET_POLICIES = ['everyone', 'not-admins', 'off'];

// Looked up by the token's hash, so a timing difference could only ever say something about a hash nobody knows.
const hex = (text) => createHash('sha256').update(String(text)).digest('hex');
/** What a link is bound to: the password the account had when it was made. */
const passwordStamp = (passwordHash) => hex(`mz-reset\n${passwordHash ?? ''}`);

/** A link's token: 43 URL-safe characters (256 bits). Anything else is not one of ours. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** "d•••@acme.io": enough for the owner to recognise, not enough to collect addresses. */
export function maskEmail(email) {
  const [local = '', domain = ''] = String(email ?? '').split('@');
  if (!domain) return '';
  return `${local.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(6, local.length - 1)))}@${domain}`;
}

export class PasswordResets {
  #links = new Map(); // sha256(token) hex -> { userId, stamp, exp }
  #sent = new Map(); // userId -> [times links were sent]
  #asked = new Map(); // ip -> [times]
  #now;

  constructor({ now = () => Date.now() } = {}) {
    this.#now = now;
  }

  /** Has this network address asked (or tried dead links) too often lately? Counts nothing. */
  ipBlocked(ip) {
    const now = this.#now();
    return (this.#asked.get(String(ip || 'unknown')) ?? []).filter((t) => now - t < IP_WINDOW_MS).length >= PER_IP_PER_WINDOW;
  }

  /** Count a request for a link, or a link that did not work, against this network address. */
  noteIp(ip) {
    const now = this.#now();
    const key = String(ip || 'unknown');
    const recent = (this.#asked.get(key) ?? []).filter((t) => now - t < IP_WINDOW_MS);
    recent.push(now);
    // Re-inserted, so the map stays in order of last use; addresses long quiet are forgotten first.
    this.#asked.delete(key);
    this.#asked.set(key, recent);
    for (const [k, times] of this.#asked) {
      if (this.#asked.size <= 10_000) break;
      if (!times.some((t) => now - t < IP_WINDOW_MS)) this.#asked.delete(k);
    }
  }

  /** May a link go to this person now (3 an hour, a minute apart)? */
  maySend(userId) {
    const now = this.#now();
    const times = (this.#sent.get(userId) ?? []).filter((t) => now - t < HOUR_MS);
    this.#sent.set(userId, times);
    if (times.length >= PER_ACCOUNT_PER_HOUR) return false;
    return !times.length || now - times[times.length - 1] >= PER_ACCOUNT_GAP_MS;
  }

  /**
   * A new link for `user` ({id, passwordHash}). Any earlier link of theirs stops working.
   * Returns the token (it goes only into the email) and when it expires.
   */
  issue(user) {
    const now = this.#now();
    this.revokeUser(user.id);
    this.#prune(now);
    const token = randomBytes(32).toString('base64url');
    const exp = now + RESET_TTL_MS;
    this.#links.set(hex(token), { userId: user.id, stamp: passwordStamp(user.passwordHash), exp });
    this.#sent.set(user.id, [...(this.#sent.get(user.id) ?? []), now]);
    return { token, exp };
  }

  /**
   * The link's person, if it still works: the token is one of ours, not used, not expired,
   * and the account still has the password it was made for. `userOf(id)` reads the account.
   * Returns the user, or null (never why: an expired link and a made-up one look alike).
   */
  check(token, userOf) {
    if (!TOKEN_PATTERN.test(String(token ?? ''))) return null;
    const key = hex(token);
    const link = this.#links.get(key);
    if (!link) return null;
    if (link.exp <= this.#now()) {
      this.#links.delete(key);
      return null;
    }
    const user = userOf(link.userId);
    if (!user || user.disabled || !user.passwordHash || passwordStamp(user.passwordHash) !== link.stamp) {
      this.#links.delete(key);
      return null;
    }
    return user;
  }

  /** Use the link: it never works again, and neither does any other link of that person's. */
  consume(token) {
    const link = this.#links.get(hex(token));
    if (link) this.revokeUser(link.userId);
  }

  /** End every link of one person (their password changed, they were removed or disabled). */
  revokeUser(userId) {
    for (const [key, link] of this.#links) if (link.userId === userId) this.#links.delete(key);
  }

  /** Links still waiting (for tests and diagnostics). */
  get size() {
    this.#prune(this.#now());
    return this.#links.size;
  }

  #prune(now) {
    for (const [key, link] of this.#links) if (link.exp <= now) this.#links.delete(key);
  }
}

/** Whether `policy` lets this person reset by email. `isAdmin`: they may manage people or tenants. */
export function resetAllowed(policy, { isAdmin }) {
  if (policy === 'off') return false;
  if (policy === 'not-admins') return !isAdmin;
  return true;
}
