// Vendored from cloc-fusion 1.3.2 (commit 1a320621d0f5), MIT licence: src/cloc-fusion/LICENSE. Do not edit here: scripts/sync-cloc-fusion.mjs copies it again.
// Counting lines like cloc: per file, code / comment / blank lines by the language's comment syntax.
// Quoted strings are skipped within a line (so a route like '/*' does not open a comment); strings
// spanning lines are not tracked, the usual approximation, which moves totals by well under 1%.
import { languageOf, isExcludedPath, globToRegExp } from './languages.js';

// Per language: the characters that can start a comment or a string, as a search regex, so a
// line's plain code is skipped in one jump instead of character by character.
const SCANNERS = new WeakMap();
function scannerOf(lang) {
  let sc = lang && SCANNERS.get(lang);
  if (sc) return sc;
  const line = lang?.line || [];
  const block = lang?.block || [];
  const starts = new Set(['"', "'", '`', ...line.map((t) => t[0]), ...block.map((b) => b[0][0])]);
  const cls = [...starts].map((c) => c.replace(/[\\\]^-]/g, '\\$&')).join('');
  sc = { line, block, next: new RegExp(`[${cls}]`, 'g') };
  if (lang) SCANNERS.set(lang, sc);
  return sc;
}

const MAX_PATH = 4096;

const isSpace = (ch) => ch <= 32 || ch === 0xa0 || ch === 0xfeff;

/**
 * Count one file's text. Returns { code, comment, blank }. A single pass over the text with no
 * per-line strings: plain code is skipped in one regex jump, and the next comment-or-string start
 * and the end of an open block comment are remembered, so the work stays linear in the file size.
 */
export function countText(text, lang) {
  if (text.indexOf('\n') < 0 && text.indexOf('\r') >= 0) text = text.replace(/\r/g, '\n'); // classic Mac line ends
  let code = 0;
  let comment = 0;
  let blank = 0;
  let inBlock = null;
  let blockEnd = -2; // where the open block comment closes (-1: never), once looked up
  let nextAt = -2; // the next comment-or-string start at or after a position, once looked up
  const { line: lineTokens, block: blockTokens, next } = scannerOf(lang);
  const n = text.length;
  let pos = 0;
  while (pos < n) {
    let end = text.indexOf('\n', pos);
    if (end < 0) end = n;
    const e = end > pos && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
    let i = pos;
    while (i < e && isSpace(text.charCodeAt(i))) i++;
    pos = end + 1;
    if (i >= e) {
      blank++;
      continue;
    }
    let hasCode = false;
    let hasComment = false;
    outer: while (i < e) {
      if (inBlock) {
        hasComment = true;
        if (blockEnd === -2 || (blockEnd !== -1 && blockEnd < i)) blockEnd = text.indexOf(inBlock[1], i);
        if (blockEnd === -1 || blockEnd + inBlock[1].length > e) break; // closes on a later line, or never
        i = blockEnd + inBlock[1].length;
        inBlock = null;
        blockEnd = -2;
        continue;
      }
      const ch = text.charCodeAt(i);
      if (isSpace(ch)) {
        i++;
        continue;
      }
      for (const t of lineTokens) {
        if (text.startsWith(t, i) && i + t.length <= e) {
          hasComment = true;
          break outer;
        }
      }
      for (const b of blockTokens) {
        if (text.startsWith(b[0], i) && i + b[0].length <= e) {
          inBlock = b;
          blockEnd = -2;
          hasComment = true;
          i += b[0].length;
          continue outer;
        }
      }
      hasCode = true;
      if (ch === 34 || ch === 39 || ch === 96) {
        // Skip a quoted string to its closing quote on this line (backslash escapes honoured).
        let j = i + 1;
        while (j < e && text.charCodeAt(j) !== ch) j += text.charCodeAt(j) === 92 ? 2 : 1;
        i = j + 1;
        continue;
      }
      // Plain code: jump to the next character that could start a comment or a string.
      if (nextAt !== -1 && nextAt <= i) {
        next.lastIndex = i + 1;
        const m = next.exec(text);
        nextAt = m ? m.index : -1;
      }
      i = nextAt === -1 || nextAt > e ? e : nextAt;
    }
    if (hasCode) code++;
    else if (hasComment) comment++;
    else blank++;
  }
  return { code, comment, blank };
}

const looksBinary = (buf) => typeof buf !== 'string' && buf.subarray(0, 8000).includes(0);
const utf8 = new TextDecoder();

/**
 * A function (path, size) → language or null: which files to count (known languages, not
 * excluded, not too big). The globs are compiled once, not per file.
 */
export function makeSelector({ exclude = [], include = [], maxFileBytes = 2 * 1024 * 1024 } = {}) {
  const ex = exclude.map(globToRegExp);
  const inc = include.map(globToRegExp);
  return (path, size = 0) => {
    // Real paths are short; a huge one is hostile (and slow to match), so it is skipped.
    if (path.length > MAX_PATH || size > maxFileBytes || isExcludedPath(path)) return null;
    if (ex.length && ex.some((re) => re.test(path))) return null;
    if (inc.length && !inc.some((re) => re.test(path))) return null;
    return languageOf(path);
  };
}

/** The tree entries ([{ path, size, oid }]) to count, each with its language. */
export function selectFiles(entries, options = {}) {
  const select = makeSelector(options);
  const out = [];
  for (const e of entries) {
    const lang = select(e.path, e.size);
    if (lang) out.push({ ...e, lang });
  }
  return out;
}

/** Accumulates per-language and per-category totals as files are counted. */
export class LocTally {
  constructor() {
    this.languages = Object.create(null);
    this.files = 0;
  }

  add(lang, buf) {
    if (looksBinary(buf)) return;
    const c = countText(typeof buf === 'string' ? buf : utf8.decode(buf), lang);
    const t = (this.languages[lang.name] ||= { category: lang.category, files: 0, code: 0, comment: 0, blank: 0 });
    t.files++;
    t.code += c.code;
    t.comment += c.comment;
    t.blank += c.blank;
    this.files++;
  }

  /** Totals for the languages whose category is counted, by basis (code | code+comments | all). */
  summary({ countCategories = ['code', 'markup', 'iac'], locBasis = 'code' } = {}) {
    const cats = new Set(countCategories);
    const byCategory = Object.create(null);
    let loc = 0;
    let files = 0;
    let code = 0;
    let comment = 0;
    let blank = 0;
    for (const t of Object.values(this.languages)) {
      const bc = (byCategory[t.category] ||= { files: 0, code: 0, comment: 0, blank: 0 });
      bc.files += t.files;
      bc.code += t.code;
      bc.comment += t.comment;
      bc.blank += t.blank;
      if (!cats.has(t.category)) continue;
      files += t.files;
      code += t.code;
      comment += t.comment;
      blank += t.blank;
      loc += locBasis === 'all' ? t.code + t.comment + t.blank : locBasis === 'code+comments' ? t.code + t.comment : t.code;
    }
    const top = Object.entries(this.languages)
      .filter(([, t]) => cats.has(t.category))
      .sort((a, b) => b[1].code - a[1].code);
    return { loc, files, code, comment, blank, byCategory, languages: this.languages, mainLanguage: top[0]?.[0] ?? null };
  }
}
