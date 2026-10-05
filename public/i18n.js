// The page in the reader's language: menus, options, buttons and hints.
//
// English is the source. Each other language is one file, public/i18n/<code>.json, mapping the
// English wording to the translation; it is fetched only when that language is chosen, so in
// English nothing here runs beyond reading the saved choice. The page is written in English as
// before, and the words are swapped as they appear: once for the whole page, then for whatever
// the app adds or changes. Anything marked translate="no" (names, findings, logs, code, the
// terms of use) is left exactly as it is, and wording with no translation stays in English.
//
// A sentence with inline markup (<b>, <code>, a link…) is translated as one piece, so its word
// order can follow the language; numbers in a sentence become {0}, {1}… in the key, so
// "Take back 5 unused credits" and "Take back 12 unused credits" share one translation.

export const LANGUAGES = [
  ['en', 'English'],
  ['ja', '日本語'],
  ['zh-TW', '繁體中文（台灣）'],
  ['zh-CN', '简体中文'],
  ['ko', '한국어'],
  ['es', 'Español'],
  ['vi', 'Tiếng Việt'],
  ['th', 'ไทย'],
  ['ms', 'Bahasa Melayu'],
  ['id', 'Bahasa Indonesia'],
];
const CODES = new Set(LANGUAGES.map(([code]) => code));
const STORE = 'mz-lang';

/** The language to use: the saved choice, else the browser's when it is one of ours, else English. */
export function preferredLanguage(saved = readSaved(), browser = globalThis.navigator?.languages ?? []) {
  if (CODES.has(saved)) return saved;
  for (const tag of browser) {
    const lower = String(tag).toLowerCase();
    if (/^zh-(tw|hk|mo|hant)/.test(lower)) return 'zh-TW';
    if (lower.startsWith('zh')) return 'zh-CN';
    const primary = lower.split('-')[0] === 'in' ? 'id' : lower.split('-')[0];
    if (CODES.has(primary)) return primary;
    if (primary === 'en') return 'en';
  }
  return 'en';
}

function readSaved() {
  try {
    return localStorage.getItem(STORE);
  } catch {
    return null;
  }
}

export const norm = (text) => String(text).replace(/\s+/g, ' ').trim();
const LETTER = /\p{L}/u;
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'data-label', 'label'];
// Never translated: code and anything typed by or shown for a person.
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'PRE', 'CODE', 'KBD', 'SAMP', 'svg', 'SVG', 'math']);
// Phrasing elements that may sit inside a translated sentence.
const INLINE = new Set(['B', 'STRONG', 'I', 'EM', 'A', 'SPAN', 'BR', 'SMALL', 'ABBR', 'SUB', 'SUP', 'MARK', 'U', 'S', 'Q', 'TIME', 'WBR', 'CODE', 'KBD']);

let lang = 'en';
let dict = null; // Map: English → translation
let observer = null;
const textDone = new WeakMap(); // Text node → { src, out }
const attrDone = new WeakMap(); // Element → Map(attribute → { src, out })
const htmlDone = new WeakMap(); // Element → { src, out }

export const currentLanguage = () => lang;

/** The translation of one piece of English, or null when there is none. */
function lookup(text) {
  if (!dict) return null;
  const hit = dict.get(text);
  if (hit !== undefined) return hit;
  if (!/\d/.test(text)) return null;
  const numbers = [];
  const key = text.replace(/\d+/g, (digits) => `{${numbers.push(digits) - 1}}`);
  const pattern = dict.get(key);
  return pattern === undefined ? null : pattern.replace(/\{(\d+)\}/g, (whole, i) => numbers[i] ?? whole);
}

/** Translate English wording for code that builds text itself (dialogs, the busy line). */
export function t(text) {
  if (lang === 'en' || text == null) return text;
  const source = String(text);
  const key = norm(source);
  if (!key) return source;
  const out = lookup(key);
  if (out != null) return out;
  // A message of several lines: each line on its own.
  return source.includes('\n') ? source.split('\n').map((line) => (norm(line) ? lookup(norm(line)) ?? line : line)).join('\n') : source;
}

const skipped = (el) => el.closest?.('[translate]')?.getAttribute('translate') === 'no';

/** Is everything inside this element plain text and inline markup, without ids (which the app looks up)? */
function inlineOnly(el) {
  for (const child of el.childNodes) {
    if (child.nodeType === 1) {
      if (!INLINE.has(child.tagName) || child.id || child.getAttribute('translate') === 'no' || !inlineOnly(child)) return false;
    } else if (child.nodeType !== 3 && child.nodeType !== 8) return false;
  }
  return true;
}

/** A sentence with markup in it, translated whole: it has its own words and at least one inline element. */
function isSentence(el) {
  if (SKIP.has(el.tagName) || INLINE.has(el.tagName) && el.tagName !== 'SPAN' && el.tagName !== 'A') return false;
  let element = false;
  let words = false;
  for (const child of el.childNodes) {
    if (child.nodeType === 1) element = true;
    else if (child.nodeType === 3 && LETTER.test(child.nodeValue)) words = true;
  }
  return element && words && inlineOnly(el);
}

// A word that means two things ("To": an email's recipients, or the end of a date range) is told
// apart by data-i18n-ctx on an element around it: "date|To" is looked up first, then "To".
const contextOf = (el) => el?.closest?.('[data-i18n-ctx]')?.dataset.i18nCtx ?? '';
const lookupIn = (el, key) => {
  const ctx = contextOf(el);
  return (ctx && lookup(`${ctx}|${key}`)) ?? lookup(key);
};

function doText(node) {
  const value = node.nodeValue;
  const done = textDone.get(node);
  if (done && done.out === value) return;
  const key = norm(value);
  if (!key || !LETTER.test(key)) return;
  const out = lookupIn(node.parentElement, key);
  if (out == null) return;
  const next = value.match(/^\s*/)[0] + out + value.match(/\s*$/)[0];
  textDone.set(node, { src: value, out: next });
  if (next !== value) node.nodeValue = next;
}

function doAttrs(el) {
  for (const name of ATTRS) {
    const value = el.getAttribute(name);
    if (!value) continue;
    let done = attrDone.get(el);
    if (done?.get(name)?.out === value) continue;
    const key = norm(value);
    if (!LETTER.test(key)) continue;
    const out = lookupIn(el, key);
    if (out == null) continue;
    if (!done) attrDone.set(el, (done = new Map()));
    done.set(name, { src: value, out });
    if (out !== value) el.setAttribute(name, out);
  }
}

const startTag = (el) => `${el.tagName} ${[...el.attributes].map((a) => `${a.name}=${a.value}`).sort().join(' ')}`;

/**
 * Replace a sentence's content with `html`, keeping its inline elements (a link the app listens
 * to stays the same element): each one moves to where the new wording puts it.
 */
function swapIn(el, html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const originals = [...el.children];
  for (const fresh of [...template.content.children]) {
    const tag = startTag(fresh);
    const index = originals.findIndex((o) => o && startTag(o) === tag);
    if (index === -1) continue;
    const twin = originals[index];
    originals[index] = null;
    twin.replaceChildren(...fresh.childNodes);
    fresh.replaceWith(twin);
  }
  el.replaceChildren(...template.content.childNodes);
}

function doSentence(el) {
  const html = el.innerHTML;
  const done = htmlDone.get(el);
  if (done && done.out === html) return;
  const out = lookup(norm(html));
  if (out == null) {
    htmlDone.delete(el);
    return;
  }
  swapIn(el, out);
  htmlDone.set(el, { src: html, out: el.innerHTML });
  for (const child of el.querySelectorAll('*')) doAttrs(child);
}

/** Translate everything under `node` (an element or a text node). */
function walk(node) {
  if (node.nodeType === 3) return doText(node);
  if (node.nodeType !== 1 || SKIP.has(node.tagName)) return;
  if (node.getAttribute('translate') === 'no') {
    for (const yes of node.querySelectorAll('[translate="yes"]')) if (yes.parentElement.closest('[translate]') === node) walk(yes);
    return;
  }
  doAttrs(node);
  // A sentence is translated whole or not at all: words translated one by one read badly.
  if (isSentence(node)) return doSentence(node);
  for (let child = node.firstChild; child; child = child.nextSibling) walk(child);
}

/** The nearest element that holds `node` as a whole sentence, if any. */
function sentenceOf(node) {
  let el = node.nodeType === 1 ? node : node.parentElement;
  while (el && INLINE.has(el.tagName) && !el.id) el = el.parentElement;
  return el && isSentence(el) ? el : null;
}

function onMutations(records) {
  const seen = new Set();
  for (const record of records) {
    const target = record.target;
    const element = target.nodeType === 1 ? target : target.parentElement;
    if (!element || skipped(element)) continue;
    if (record.type === 'attributes') {
      doAttrs(target);
      continue;
    }
    const sentence = sentenceOf(target);
    if (sentence) {
      if (!seen.has(sentence)) {
        seen.add(sentence);
        doSentence(sentence);
      }
      continue;
    }
    if (record.type === 'characterData') doText(target);
    else for (const node of record.addedNodes) if (node.isConnected) walk(node);
  }
  observer.takeRecords(); // our own changes
}

/** Put the English back everywhere (before showing another language). */
function restore(root = document.documentElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let node = walker.currentNode; node; node = walker.nextNode()) {
    if (node.nodeType === 3) {
      const done = textDone.get(node);
      if (done && node.nodeValue === done.out) node.nodeValue = done.src;
      textDone.delete(node);
      continue;
    }
    const html = htmlDone.get(node);
    if (html) {
      htmlDone.delete(node);
      if (node.innerHTML === html.out) swapIn(node, html.src);
    }
    const attrs = attrDone.get(node);
    if (attrs) {
      for (const [name, { src, out }] of attrs) if (node.getAttribute(name) === out) node.setAttribute(name, src);
      attrDone.delete(node);
    }
  }
}

async function load(code) {
  const response = await fetch(`/i18n/${code}.json`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error(`No ${code} translation (${response.status})`);
  const body = await response.json();
  return new Map(Object.entries(body.strings ?? {}).filter(([, out]) => typeof out === 'string' && out));
}

const listeners = new Set();
/** Called with the language code after the page changes language. */
export const onLanguageChange = (fn) => listeners.add(fn);

/** Show the page in `code`, and remember the choice. */
export async function setLanguage(code, { save = true } = {}) {
  if (!CODES.has(code)) code = 'en';
  if (save) {
    try {
      localStorage.setItem(STORE, code);
    } catch {}
  }
  let next = null;
  if (code !== 'en') {
    try {
      next = await load(code);
    } catch (error) {
      console.warn(error);
      code = 'en';
    }
  }
  observer?.disconnect();
  if (dict) restore();
  lang = code;
  dict = next;
  document.documentElement.lang = code;
  if (dict) {
    walk(document.documentElement);
    observer ??= new MutationObserver(onMutations);
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  delete document.documentElement.dataset.i18n;
  for (const fn of listeners) fn(code);
  return code;
}

// ---------------------------------------------------------------------------
// Dates and times: in the person's own time zone (their profile, else this computer's), and
// written the way their language writes them. Code that names a zone or locale keeps it.
// ---------------------------------------------------------------------------

const regional = { timeZone: '' };
let patched = false;
function patchDates() {
  if (patched) return;
  patched = true;
  for (const name of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
    const original = Date.prototype[name];
    Date.prototype[name] = function (locales, options) {
      const zone = regional.timeZone && !options?.timeZone ? { ...options, timeZone: regional.timeZone } : options;
      return original.call(this, locales ?? (lang === 'en' ? undefined : lang), zone);
    };
  }
}

/** Show dates and times in `timeZone` ('' for this computer's). */
export function setTimeZone(timeZone) {
  patchDates();
  try {
    regional.timeZone = timeZone ? new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone : '';
  } catch {
    regional.timeZone = '';
  }
}

/** This computer's time zone ("Asia/Tokyo"). */
export function deviceTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

/** Start in the preferred language. Native dialogs speak it too. */
export function startI18n() {
  patchDates();
  const code = preferredLanguage();
  const confirm = window.confirm.bind(window);
  const alert = window.alert.bind(window);
  const prompt = window.prompt.bind(window);
  window.confirm = (message) => confirm(t(message));
  window.alert = (message) => alert(t(message));
  window.prompt = (message, value) => prompt(t(message), value);
  if (code === 'en') {
    delete document.documentElement.dataset.i18n;
    return Promise.resolve('en');
  }
  return setLanguage(code, { save: false });
}

/**
 * Every piece of English the page would translate under `root`, as it would look it up: for
 * building and checking the translation files (scripts/i18n-collect.mjs).
 */
export function collect(root = document.documentElement) {
  const found = [];
  const add = (text, kind, el) => {
    if (!text || !LETTER.test(text)) return;
    const ctx = contextOf(el);
    const key = ctx ? `${ctx}|${text}` : text;
    const heading = el?.closest?.('section, fieldset, details, dialog, .panel, .card')?.querySelector?.('h1, h2, h3, legend, summary');
    found.push({ key, kind, tag: el?.tagName?.toLowerCase() ?? '', near: heading ? norm(heading.textContent).slice(0, 80) : '' });
  };
  const visit = (node) => {
    if (node.nodeType === 3) return add(norm(node.nodeValue), 'text', node.parentElement);
    if (node.nodeType !== 1 || SKIP.has(node.tagName)) return;
    if (node.getAttribute('translate') === 'no') {
      for (const yes of node.querySelectorAll('[translate="yes"]')) if (yes.parentElement.closest('[translate]') === node) visit(yes);
      return;
    }
    for (const name of ATTRS) if (node.getAttribute(name)) add(norm(node.getAttribute(name)), `attr:${name}`, node);
    if (isSentence(node)) {
      add(norm(node.innerHTML), 'html', node);
      for (const child of node.querySelectorAll('*')) for (const name of ATTRS) if (child.getAttribute(name)) add(norm(child.getAttribute(name)), `attr:${name}`, child);
      return;
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
  };
  visit(root);
  return found;
}
