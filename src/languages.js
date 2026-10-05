/**
 * Which languages the page offers. Most are open to everyone; a few are gated
 * behind an activation code (see src/activation.js). Today only Hebrew (he) is
 * gated: it appears only while a valid Hebrew activation code is in force, and a
 * deactivation code (or the code expiring) removes it. The state is server-wide,
 * kept in languages.json, and re-checked against the clock on every read.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Languages always available, in the order the picker shows them. */
export const OPEN_LANGUAGES = ['en', 'ja', 'zh-TW', 'zh-CN', 'ko', 'es', 'de', 'fr', 'ar', 'vi', 'th', 'ms', 'id'];
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

  /** The gated languages switched on and not past their activation code's expiry. */
  activeGated(now = Date.now()) {
    return Object.keys(GATED_LANGUAGES).filter((code) => {
      const entry = this.#state.gated[code];
      return entry?.on === true && Date.parse(entry.expires) > now;
    });
  }

  /** Is this language available to offer now? */
  isAvailable(code, now = Date.now()) {
    return OPEN_LANGUAGES.includes(code) || this.activeGated(now).includes(code);
  }

  /** Every language code available now, open ones first. */
  available(now = Date.now()) {
    return [...OPEN_LANGUAGES, ...this.activeGated(now)];
  }

  /** What a gated language's state is (for the Settings page), including when it lapses. */
  status(code) {
    const entry = this.#state.gated[code];
    if (!entry?.on) return { code, on: false };
    return { code, on: Date.parse(entry.expires) > Date.now(), org: entry.org ?? '', expires: entry.expires, expired: Date.parse(entry.expires) <= Date.now() };
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
      this.#state.gated[code] = { on: true, org: result.org ?? '', expires: result.expires, activatedAt: new Date().toISOString() };
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
