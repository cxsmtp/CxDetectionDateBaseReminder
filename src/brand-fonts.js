/**
 * The organisation's own brand font (Checkmarx's is Founders Grotesk), supplied by whoever runs the
 * server. Licensed font files are never part of this repository or its image: an organisation that
 * holds a licence puts its copies in BRAND_FONT_DIR (default <DATA_DIR>/fonts), and only its own
 * installation serves them, to its own users. A computer with the font installed (a desktop licence)
 * uses it too, with nothing on the server. Everyone else keeps IBM Plex Sans, which ships with the app.
 *
 * The files are named the usual way (FoundersGrotesk-Light.otf, …-SemiboldItalic.woff2): the weight and
 * style come from the name. Condensed cuts are "MZ Brand Condensed" (Cond) and "MZ Brand Extra Condensed" (XCond).
 */

import fs from 'node:fs';
import path from 'node:path';

const FORMATS = { '.woff2': 'woff2', '.woff': 'woff', '.otf': 'opentype', '.ttf': 'truetype' };
// Preferred when one weight comes in several formats: the smallest to download first.
const RANK = { '.woff2': 0, '.woff': 1, '.otf': 2, '.ttf': 3 };
const WEIGHTS = [
  [/thin|hairline/i, 100],
  [/extra-?light|ultra-?light/i, 200],
  [/light|(?:^|[-_ ])lt(?:$|[-_ .])/i, 300],
  [/semi-?bold|demi-?bold/i, 600],
  [/extra-?bold|ultra-?bold/i, 800],
  [/black|heavy/i, 900],
  [/medium/i, 500],
  [/bold/i, 700],
];
// Founders Grotesk's line box runs from its cap height (63%) to a deep descent (37%), so its text sits high in
// a button or a field: these centre it. Another brand font keeps its own metrics.
const METRICS = { 'Founders Grotesk': ' ascent-override: 80%; descent-override: 20%; line-gap-override: 0%;' };
const LOCAL_WEIGHTS = [[300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold']];

/** What a font file is, from its name: its family, weight and style, or null when it is not a font. */
export function describeFontFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (!(ext in FORMATS)) return null;
  const base = path.basename(file, ext);
  const style = /italic|oblique/i.test(base) ? 'italic' : 'normal';
  const family = /x-?cond|extra-?cond/i.test(base) ? 'MZ Brand Extra Condensed' : /cond(?:ensed)?/i.test(base) ? 'MZ Brand Condensed' : 'MZ Brand Sans';
  const weight = WEIGHTS.find(([re]) => re.test(base.replace(/italic|oblique/gi, '')))?.[1] ?? 400;
  return { file, ext, format: FORMATS[ext], family, weight, style };
}

const quote = (name) => `"${String(name).replace(/["\\\n\r]/g, '')}"`;

/**
 * The @font-face rules for the brand font: the installed copy first (local()), then the server's file
 * when there is one. With neither, the browser moves on to the next font in the stack.
 */
export function brandFontCss(files, { family = 'Founders Grotesk' } = {}) {
  const chosen = new Map();
  for (const f of files) {
    const key = `${f.family}|${f.weight}|${f.style}`;
    if (!chosen.has(key) || RANK[f.ext] < RANK[chosen.get(key).ext]) chosen.set(key, f);
  }
  const rules = [];
  const covered = new Set();
  const metrics = METRICS[family] ?? '';
  for (const f of chosen.values()) {
    covered.add(`${f.family}|${f.weight}|${f.style}`);
    const local = f.family === 'MZ Brand Sans' ? localNames(family, f.weight, f.style) : [];
    const src = [...local.map((n) => `local(${quote(n)})`), `url(brand-fonts/${encodeURIComponent(f.file)}) format("${f.format}")`].join(', ');
    rules.push(`@font-face { font-family: "${f.family}"; font-style: ${f.style}; font-weight: ${f.weight}; font-display: swap;${metrics} src: ${src}; }`);
  }
  // Weights with no file here: a computer with the font installed still uses it.
  for (const [weight] of LOCAL_WEIGHTS) {
    for (const style of ['normal', 'italic']) {
      if (covered.has(`MZ Brand Sans|${weight}|${style}`)) continue;
      rules.push(`@font-face { font-family: "MZ Brand Sans"; font-style: ${style}; font-weight: ${weight}; font-display: swap;${metrics} src: ${localNames(family, weight, style).map((n) => `local(${quote(n)})`).join(', ')}; }`);
    }
  }
  return `${rules.join('\n')}\n`;
}

/** The names an installed copy goes by: "Founders Grotesk Light Italic", "FoundersGrotesk-LightItalic". */
function localNames(family, weight, style) {
  const word = LOCAL_WEIGHTS.find(([w]) => w === weight)?.[1] ?? 'Regular';
  const italic = style === 'italic' ? 'Italic' : '';
  const names = [`${family} ${word}${italic ? ` ${italic}` : ''}`, `${family.replace(/\s+/g, '')}-${word}${italic}`];
  if (word === 'Regular') names.push(italic ? `${family} Italic` : family);
  return names;
}

/** The brand font files in `dir`, read again at most once a minute. */
export class BrandFonts {
  #dir;
  #family;
  #ttlMs;
  #at = 0;
  #files = [];
  #css = '';

  constructor({ dir, family = 'Founders Grotesk', ttlMs = 60_000 } = {}) {
    this.#dir = dir;
    this.#family = family;
    this.#ttlMs = ttlMs;
  }

  get dir() {
    return this.#dir;
  }

  #refresh(now = Date.now()) {
    if (this.#at && now - this.#at < this.#ttlMs) return;
    this.#at = now;
    let names = [];
    try {
      names = fs.readdirSync(this.#dir);
    } catch {}
    this.#files = names.map(describeFontFile).filter(Boolean);
    this.#css = brandFontCss(this.#files, { family: this.#family });
  }

  css() {
    this.#refresh();
    return this.#css;
  }

  /** The full path of a font file the folder holds, or null: nothing else in it is ever served. */
  path(file) {
    this.#refresh();
    const known = this.#files.find((f) => f.file === file);
    return known ? path.join(this.#dir, known.file) : null;
  }

  get count() {
    this.#refresh();
    return this.#files.length;
  }
}
