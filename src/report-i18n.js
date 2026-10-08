/**
 * The words of an interactive report, per language. A report is read away from this server (an
 * email attachment, a downloaded file), so it carries its reader's language with it: the one in
 * their profile, and a language behind an activation code (Hebrew) when it is on for them. Any
 * other language the reader picks in the report comes from this server when it is reachable
 * (GET /api/relay/report-words/<code>), and is kept in their browser.
 *
 * i18n/report-keys.json lists the report's wording (scripts/i18n-report.mjs); the translations are
 * the page's own, public/i18n/<code>.json.
 */
import { readFileSync } from 'node:fs';

import { GATED_LANGUAGES, OPEN_LANGUAGES } from './languages.js';
import { PACKAGE_VERSION } from './version.js';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
let keys = null;
const cache = new Map();

/** The report's wording, English. */
export function reportKeys() {
  keys ??= read('../i18n/report-keys.json');
  return keys;
}

/** {name, words} for one language: only the report's wording, and only what is translated. */
function language(code) {
  if (!cache.has(code)) {
    let file = null;
    try {
      file = read(`../public/i18n/${code}.json`);
    } catch {}
    const words = {};
    for (const key of reportKeys()) {
      const out = file?.strings?.[key];
      if (typeof out === 'string' && out && out !== key) words[key] = out;
    }
    cache.set(code, { name: file?.name ?? code, words });
  }
  return cache.get(code);
}

/** One open language's report words, for the relay ({} when it has none). A gated language is never served this way. */
export function reportWords(code) {
  if (!OPEN_LANGUAGES.includes(code) || code === 'en') return null;
  return language(code).words;
}

/**
 * The i18n option for generateHtmlReport. `codes`: the languages this server offers the reader (a
 * gated language only to someone it is on for); `preferred`: their profile language, the one the
 * report opens in. The report carries that language's words, and a gated one's; `fetch` says the
 * others can be asked for (a report with no server address to ask stays with what it carries).
 */
export function reportI18n({ codes = OPEN_LANGUAGES, preferred = '', fetch = true } = {}) {
  const languages = [['en', 'English']];
  const strings = {};
  for (const code of codes) {
    if (code === 'en') continue;
    const { name, words } = language(code);
    if (!Object.keys(words).length) continue;
    const carried = code === preferred || code in GATED_LANGUAGES;
    if (!carried && !fetch) continue;
    languages.push([code, name]);
    if (carried) strings[code] = words;
  }
  // No profile language: the reader's browser decides (i18n-boot.client.js).
  const start = languages.some(([code]) => code === preferred) ? preferred : '';
  return { default: start, languages, strings, fetch, version: PACKAGE_VERSION };
}
