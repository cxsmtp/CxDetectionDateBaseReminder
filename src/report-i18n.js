/**
 * The words an interactive report carries, per language: the report is read away from this server
 * (an email attachment, a downloaded file), so it brings the translations of its own wording with
 * it, and nothing else. i18n/report-keys.json lists that wording (scripts/i18n-report.mjs); the
 * translations are the page's own, public/i18n/<code>.json.
 */
import { readFileSync } from 'node:fs';

import { OPEN_LANGUAGES } from './languages.js';

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

/**
 * The i18n option for generateHtmlReport: every language `codes` names (those this server offers
 * the reader: a gated language only to someone it is on for), starting in `preferred` (the
 * recipient's profile language) when it is one of them.
 */
export function reportI18n({ codes = OPEN_LANGUAGES, preferred = '' } = {}) {
  const languages = [['en', 'English']];
  const strings = {};
  for (const code of codes) {
    if (code === 'en') continue;
    const { name, words } = language(code);
    if (!Object.keys(words).length) continue;
    languages.push([code, name]);
    strings[code] = words;
  }
  // No profile language: the reader's browser decides (i18n-boot.client.js).
  return { default: strings[preferred] || preferred === 'en' ? preferred : '', languages, strings };
}
