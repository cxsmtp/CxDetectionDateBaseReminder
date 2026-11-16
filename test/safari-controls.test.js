// Safari draws some things its own way, or reads an older spelling: what the style sheets do about it.
// (Chromium is the only browser the browser tests run in, so these are checked in the style sheets themselves.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SHEETS = ['public/styles.css', 'public/nextgen.css', 'public/mobile.css'];
const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
/** Each rule's declarations, comments left out: "selector { … }" by "…". */
const blocks = (css) => [...css.replace(/\/\*[^]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));

test('a list that opens is drawn by the page, the same in every browser, and keeps its arrow in every look', () => {
  const rule = blocks(read('public/styles.css')).find((b) => b.selector === 'select:not([multiple]):not([size])');
  assert.ok(rule, 'the rule for lists that open');
  assert.match(rule.body, /-webkit-appearance:\s*none/);
  assert.match(rule.body, /(?<!-)appearance:\s*none/);
  // A look may set a control's whole background or padding: the arrow and its room stay.
  for (const property of ['background-image', 'background-position', 'background-size', 'background-repeat', 'padding-inline-end']) {
    assert.match(rule.body, new RegExp(`${property}:[^;]+!important`), `${property} holds in every look`);
  }
  assert.match(rule.body, /currentColor/, 'the arrow is in the text colour, light or dark');
});

test('a search field takes the page\'s border and height in Safari', () => {
  const css = read('public/styles.css');
  assert.match(css, /input\[type="search"\]\s*\{[^}]*-webkit-appearance:\s*textfield/);
  assert.match(css, /input\[type="search"\]::-webkit-search-decoration\s*\{[^}]*-webkit-appearance:\s*none/);
});

test('every blur and every "not selectable" is also written the way Safari reads it', () => {
  const missing = [];
  for (const file of SHEETS) {
    for (const { selector, body } of blocks(read(file))) {
      for (const property of ['backdrop-filter', 'user-select']) {
        const plain = new RegExp(`(?<![-\\w])${property}\\s*:`).test(body);
        if (plain && !body.includes(`-webkit-${property}`)) missing.push(`${file}: ${selector.slice(0, 80)} (${property})`);
      }
    }
  }
  assert.deepEqual(missing, []);
});
