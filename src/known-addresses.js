/**
 * Addresses scan initiators resolved to before, by username.
 *
 * The IAM directory is the source of truth, but it is read over the network
 * on every fetch; when it cannot be read, the last address a username
 * resolved to is a far better answer than none. Kept on disk next to the
 * settings so it survives a restart.
 */

import fs from 'node:fs';
import path from 'node:path';

const EMAIL_RE = /^(?=[^]{3,254}$)[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ENTRIES = 20_000;

/** Keys that would reach Object.prototype on a plain object. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class KnownAddresses {
  #file;
  #entries = Object.create(null);
  #dirty = false;
  #timer = null;

  constructor({ file = null } = {}) {
    this.configure(file);
  }

  /** Point the store at a file (loading what it holds). */
  configure(file) {
    this.#file = file;
    this.#entries = Object.create(null);
    if (!file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw.addresses === 'object') {
        for (const [key, value] of Object.entries(raw.addresses)) if (!UNSAFE_KEYS.has(key)) this.#entries[key] = value;
      }
    } catch {}
  }

  get(username) {
    return this.#entries[String(username ?? '').trim().toLowerCase()]?.email ?? '';
  }

  remember(username, email) {
    const key = String(username ?? '').trim().toLowerCase();
    const value = String(email ?? '').trim();
    if (!key || UNSAFE_KEYS.has(key) || !EMAIL_RE.test(value) || this.#entries[key]?.email === value) return;
    this.#entries[key] = { email: value, at: new Date().toISOString() };
    const keys = Object.keys(this.#entries);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => this.#entries[a].at.localeCompare(this.#entries[b].at));
      for (const old of keys.slice(0, keys.length - MAX_ENTRIES)) delete this.#entries[old];
    }
    this.#dirty = true;
    // Written once per burst: a fetch remembers many addresses at a time.
    this.#timer ??= setTimeout(() => this.flush(), 1000);
    this.#timer.unref?.();
  }

  flush() {
    clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.#dirty || !this.#file) return;
    this.#dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true, mode: 0o700 });
      const tmp = `${this.#file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ addresses: this.#entries }), { mode: 0o600 });
      fs.renameSync(tmp, this.#file);
    } catch (error) {
      console.warn(`[initiators] could not save known addresses: ${error.message}`);
    }
  }
}

const shared = new KnownAddresses();
let scope = null;

/**
 * Where `knownAddresses` points: by default one store for the server; with several
 * Checkmarx One tenants, `pick` returns the running tenant's own (src/tenancy.js).
 */
export function scopeKnownAddresses(pick) {
  scope = pick;
}

/** Shared by the dashboard fetch, tracked reports and automation (the running tenant's, when scoped). */
export const knownAddresses = new Proxy(shared, {
  get(target, prop) {
    const store = scope?.() ?? target;
    const value = store[prop];
    return typeof value === 'function' ? value.bind(store) : value;
  },
});
