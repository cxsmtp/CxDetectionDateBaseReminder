/**
 * Which languages the page offers. Most are open to everyone; a few are gated
 * behind an activation code (see src/activation.js). Today only Hebrew (he) is
 * gated: it is on only while a valid Hebrew activation code is in force, and a
 * deactivation code (or the code expiring) turns it off. While it is on, the people offered it
 * are those whose role holds its permission (`language.he`, People & roles; Admins always do):
 * the caller passes the gated languages a person's role allows.
 * The state is server-wide, kept in languages.json, and re-checked against the clock on
 * every read. (MZ-01.00.58 to 62 kept a list of people here instead; it is no longer read.)
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

  /** Is this gated language switched on, and its activation code not past its expiry? */
  isOn(code, now = Date.now()) {
    const entry = this.#state.gated[code];
    return code in GATED_LANGUAGES && entry?.on === true && Date.parse(entry.expires) > now;
  }

  /** The gated languages switched on that a person may use: `allowed` is what their role permits. */
  activeGated(allowed = [], now = Date.now()) {
    return Object.keys(GATED_LANGUAGES).filter((code) => allowed.includes(code) && this.isOn(code, now));
  }

  /** May someone whose role permits `allowed` be offered this language now? */
  isAvailable(code, allowed = [], now = Date.now()) {
    return OPEN_LANGUAGES.includes(code) || this.activeGated(allowed, now).includes(code);
  }

  /** Every language code available to someone whose role permits `allowed`, open ones first. */
  available(allowed = [], now = Date.now()) {
    return [...OPEN_LANGUAGES, ...this.activeGated(allowed, now)];
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
  apply(result, { by = null } = {}) {
    if (!result?.valid && result?.action !== 'deactivate') throw Object.assign(new Error(result?.reason || 'This activation code is not valid.'), { status: 400 });
    const code = String(result.scope ?? '').startsWith('lang:') ? result.scope.slice('lang:'.length) : '';
    if (!code || !(code in GATED_LANGUAGES)) throw Object.assign(new Error('This code does not unlock a language.'), { status: 400 });
    if (result.action === 'activate') {
      if (!result.valid) throw Object.assign(new Error(result.reason || 'This activation code is not valid.'), { status: 400 });
      this.#state.gated[code] = { on: true, org: result.org ?? '', expires: result.expires, activatedAt: new Date().toISOString(), ...(by ? { by: String(by) } : {}) };
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
