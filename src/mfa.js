/**
 * Two-step sign-in for people who sign in with a password: a six-digit code from an authenticator
 * app (TOTP, RFC 6238: HMAC-SHA1, 30-second steps), and ten one-time recovery codes for the day the
 * phone is gone. Node's own crypto only.
 *
 * - The secret is kept with the person in iam.json (src/iam.js): the server must be able to work
 *   out the code, so it cannot be a hash. Recovery codes are kept as hashes only.
 * - A code is accepted for its own 30 seconds, the 30 before and the 30 after (clocks differ), and
 *   only once: the step it belonged to is remembered, and nothing at or before it works again.
 * - Between the password and the code there is no session, only a ticket (SignInTickets): random,
 *   kept here in memory as its SHA-256, for one person, five minutes, and a few wrong codes.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** What the authenticator app shows as the account's issuer. */
export const TOTP_ISSUER = 'CxMissionZero';
export const RECOVERY_CODES = 10;
export const TICKET_TTL_MS = 5 * 60 * 1000;
/** Wrong codes one ticket takes before the password has to be typed again. */
export const TICKET_MAX_WRONG = 5;
/** How long a secret shown to someone signed in waits for its first code. */
export const SETUP_TTL_MS = 10 * 60 * 1000;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Bytes as base32 (RFC 4648, no padding): how authenticator apps take a key. */
export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Base32 as bytes: spaces, hyphens, padding and lower case are fine; anything else throws. */
export function base32Decode(text) {
  const clean = String(text ?? '').toUpperCase().replace(/[\s=-]/g, '');
  const out = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('Not a base32 key.');
    value = ((value << 5) | index) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret: 160 random bits, as RFC 4226 recommends, in base32. */
export const newSecret = () => base32Encode(randomBytes(20));

/** The 30-second step a moment falls in. */
export const totpStep = (now = Date.now()) => Math.floor(now / 1000 / TOTP_STEP_SECONDS);

/** The code of one step (HOTP, RFC 4226, with the step as the counter). */
export function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const number = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(number % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/** The code an authenticator app shows now. */
export const totp = (secret, now = Date.now()) => codeAt(secret, totpStep(now));

/** What was typed, as a six-digit code ('' when it is not one). Spaces are fine: apps show "123 456". */
export const typedCode = (value) => {
  const text = String(value ?? '').replace(/\s+/g, '');
  return /^\d{6}$/.test(text) ? text : '';
};

/**
 * The step a typed code belongs to: this one, the one before or the one after. 0 when it matches none,
 * or when its step is at or before `after` (the step of the last code used: a code works once).
 */
export function matchTotp(secret, code, { now = Date.now(), after = 0 } = {}) {
  const typed = typedCode(code);
  if (!typed || !secret) return 0;
  const current = totpStep(now);
  let found = 0;
  // Every step is worked out and compared in constant time, whichever matches.
  for (const step of [current - 1, current, current + 1]) {
    const same = timingSafeEqual(Buffer.from(codeAt(secret, step)), Buffer.from(typed));
    if (same && step > after && !found) found = step;
  }
  return found;
}

/** The address an authenticator app takes (as a QR code, or typed): otpauth://totp/Issuer:account?secret=… */
export function otpauthUri(account, secret, issuer = TOTP_ISSUER) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(String(account ?? ''))}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

/** A key as people type it: groups of four. */
export const groupedKey = (secret) => String(secret ?? '').replace(/(.{4})(?=.)/g, '$1 ');

// Recovery codes: ten letters and digits that cannot be mistaken for each other, in two groups of five (50 random bits).
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newRecoveryCodes(count = RECOVERY_CODES) {
  return Array.from({ length: count }, () => {
    const text = [...randomBytes(10)].map((b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
    return `${text.slice(0, 5)}-${text.slice(5)}`;
  });
}

/** What was typed, as a recovery code without its hyphen ('' when it is not one). */
export const typedRecoveryCode = (value) => {
  const text = String(value ?? '').toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z2-9]{10}$/.test(text) ? text : '';
};

/** What is kept of a recovery code: its SHA-256, bound to the person it is for. */
export function recoveryHash(userId, code) {
  return createHash('sha256').update(`mz-recovery|${userId}|${typedRecoveryCode(code)}`).digest('hex');
}

const digest = (ticket) => createHash('sha256').update(`mz-two-step|${ticket}`).digest('hex');

/**
 * Tickets between a correct password and the code: 256 random bits each, kept as a hash, in memory
 * (a restart ends them, and the password is typed again). A ticket is for one person; `secret` is
 * set when that person is setting two-step sign-in up at sign-in and has no secret saved yet.
 */
export class SignInTickets {
  #tickets = new Map(); // digest -> { userId, exp, wrong, secret }
  #ttlMs;
  #maxWrong;
  #max;

  constructor({ ttlMs = TICKET_TTL_MS, maxWrong = TICKET_MAX_WRONG, max = 5000 } = {}) {
    this.#ttlMs = ttlMs;
    this.#maxWrong = maxWrong;
    this.#max = max;
  }

  issue(userId, { secret = '' } = {}, now = Date.now()) {
    for (const [key, entry] of this.#tickets) if (entry.exp <= now) this.#tickets.delete(key);
    // A person has a few at most (two browsers, a second try): the oldest of theirs goes first.
    const own = [...this.#tickets].filter(([, entry]) => entry.userId === userId);
    for (const [key] of own.slice(0, Math.max(0, own.length - 2))) this.#tickets.delete(key);
    // Never without limit, whoever asks: the oldest of all goes.
    for (const key of this.#tickets.keys()) {
      if (this.#tickets.size < this.#max) break;
      this.#tickets.delete(key);
    }
    const ticket = randomBytes(32).toString('base64url');
    this.#tickets.set(digest(ticket), { userId, exp: now + this.#ttlMs, wrong: 0, secret });
    return ticket;
  }

  /** The ticket's { userId, secret, exp }, or null when it is not one, was used, or is over. */
  get(ticket, now = Date.now()) {
    if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
    const key = digest(ticket);
    const entry = this.#tickets.get(key);
    if (!entry) return null;
    if (entry.exp <= now) {
      this.#tickets.delete(key);
      return null;
    }
    return { userId: entry.userId, secret: entry.secret, exp: entry.exp };
  }

  /** A wrong code on this ticket: how many more it takes (0: the ticket is over). */
  wrong(ticket) {
    const key = digest(String(ticket));
    const entry = this.#tickets.get(key);
    if (!entry) return 0;
    entry.wrong += 1;
    if (entry.wrong >= this.#maxWrong) this.#tickets.delete(key);
    return Math.max(0, this.#maxWrong - entry.wrong);
  }

  /** Used: it never works again. */
  consume(ticket) {
    return this.#tickets.delete(digest(String(ticket)));
  }

  /** End every ticket of a person (their password changed, they were disabled, their two-step sign-in was reset). */
  revokeUser(userId) {
    for (const [key, entry] of this.#tickets) if (entry.userId === userId) this.#tickets.delete(key);
  }

  get size() {
    return this.#tickets.size;
  }
}

/** Secrets shown to people who are signed in and turning two-step sign-in on: kept in memory until the first code proves the app has it. */
export class PendingSetups {
  #pending = new Map(); // userId -> { secret, exp }
  #ttlMs;

  constructor({ ttlMs = SETUP_TTL_MS } = {}) {
    this.#ttlMs = ttlMs;
  }

  start(userId, now = Date.now()) {
    for (const [key, entry] of this.#pending) if (entry.exp <= now) this.#pending.delete(key);
    const secret = newSecret();
    this.#pending.set(userId, { secret, exp: now + this.#ttlMs });
    return secret;
  }

  get(userId, now = Date.now()) {
    const entry = this.#pending.get(userId);
    return entry && entry.exp > now ? entry.secret : '';
  }

  clear(userId) {
    this.#pending.delete(userId);
  }
}
