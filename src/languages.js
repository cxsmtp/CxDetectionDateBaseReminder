/**
 * Which languages the page offers. Most are open to everyone; a few are gated
 * behind an activation code (see src/activation.js). Today only Hebrew (he) is
 * gated: it appears only while a valid Hebrew activation code is in force, and a
 * deactivation code (or the code expiring) removes it. With the code in force, an Admin
 * chooses the people who may use it: only they are offered it (`users`). Turned on before
 * people could be chosen (MZ-01.00.47), it stays open to everyone until people are chosen.
 * The state is server-wide, kept in languages.json, and re-checked against the clock on
 * every read.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Languages always available, in the order the picker shows them. */
export const OPEN_LANGUAGES = ['en', 'ja', 'zh-TW', 'zh-CN', 'ko', 'es', 'pt-BR', 'de', 'fr', 'ar', 'vi', 'th', 'ms', 'id'];
/** Gated language code → the activation scope that unlocks it. */
export const GATED_LANGUAGES = { he: 'lang:he' };

export class LanguageAccess {
  #file;
  #state;

  constructor({ file } = {}) {
    this.#file = file ?? null;
    this.#state = this.#load();
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
      return raw && typeof raw === 'object' && raw.gated && typeof raw.gated === 'object' ? { gated: raw.gated } : { gated: {} };
    } catch {
      return { gated: {} };
    }
  }

  #save() {
    if (!this.#file) return;
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.#state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.#file);
  }

  /**
   * The gated languages switched on, not past their activation code's expiry, and open to this
   * person (`userId`; without one, only those open to everyone).
   */
  activeGated(userId = null, now = Date.now()) {
    return Object.keys(GATED_LANGUAGES).filter((code) => {
      const entry = this.#state.gated[code];
      if (entry?.on !== true || Date.parse(entry.expires) <= now) return false;
      return !Array.isArray(entry.users) || (Boolean(userId) && entry.users.includes(userId));
    });
  }

  /** May this person (or, without one, anyone) be offered this language now? */
  isAvailable(code, userId = null, now = Date.now()) {
    return OPEN_LANGUAGES.includes(code) || this.activeGated(userId, now).includes(code);
  }

  /** Every language code available to this person now, open ones first. */
  available(userId = null, now = Date.now()) {
    return [...OPEN_LANGUAGES, ...this.activeGated(userId, now)];
  }

  /** What a gated language's state is (for the Settings page), including when it lapses, and who may use it (null: everyone). */
  status(code) {
    const entry = this.#state.gated[code];
    if (!entry?.on) return { code, on: false };
    return { code, on: Date.parse(entry.expires) > Date.now(), org: entry.org ?? '', expires: entry.expires, expired: Date.parse(entry.expires) <= Date.now(), users: Array.isArray(entry.users) ? [...entry.users] : null };
  }

  /** Choose the people who may use a gated language (their user ids). Returns the new status. */
  setUsers(code, userIds) {
    const entry = this.#state.gated[code];
    if (!(code in GATED_LANGUAGES)) throw Object.assign(new Error('That language is not behind an activation code.'), { status: 400 });
    if (!entry?.on) throw Object.assign(new Error('Turn the language on with its activation code first.'), { status: 409 });
    entry.users = [...new Set((Array.isArray(userIds) ? userIds : []).map(String).filter(Boolean))].slice(0, 10_000);
    this.#save();
    return this.status(code);
  }

  /**
   * Apply a verified activation-code result (from activation.checkCode) whose scope is a
   * gated language: "activate" switches it on until the code's expiry, "deactivate" off.
   * Returns { code, on } or throws for a non-language or invalid result.
   */
  apply(result) {
    if (!result?.valid && result?.action !== 'deactivate') throw Object.assign(new Error(result?.reason || 'This activation code is not valid.'), { status: 400 });
    const code = String(result.scope ?? '').startsWith('lang:') ? result.scope.slice('lang:'.length) : '';
    if (!code || !(code in GATED_LANGUAGES)) throw Object.assign(new Error('This code does not unlock a language.'), { status: 400 });
    if (result.action === 'activate') {
      if (!result.valid) throw Object.assign(new Error(result.reason || 'This activation code is not valid.'), { status: 400 });
      // A renewed code keeps the people already chosen; a first one starts with nobody chosen.
      const previous = this.#state.gated[code];
      this.#state.gated[code] = { on: true, org: result.org ?? '', expires: result.expires, activatedAt: new Date().toISOString(), users: Array.isArray(previous?.users) ? previous.users : [] };
    } else if (result.action === 'deactivate') {
      // A deactivation code is honoured whether or not it is itself still in date.
      this.#state.gated[code] = { on: false, org: result.org ?? '', expires: result.expires ?? '', deactivatedAt: new Date().toISOString() };
    } else {
      throw Object.assign(new Error('This code does not turn a language on or off.'), { status: 400 });
    }
    this.#save();
    return { code, on: this.#state.gated[code].on };
  }
}
