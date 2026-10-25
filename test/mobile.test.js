import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LANGUAGE_CODES } from '../scripts/i18n-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const PREFIX = ':root[data-phone]:root:root:root';

test('the phone layout only ever applies on a phone, and outranks every look without !important', () => {
  const css = read('public/mobile.css');
  assert.match(css, /^\/\*[^]*?\*\/\s*@media \(max-width: 760px\) \{/, 'one media block for phones');
  const body = css.slice(css.indexOf('{') + 1, css.lastIndexOf('}'));
  // Keyframes hold "from"/"to" blocks; every other rule's selectors all start at the phone root.
  const withoutKeyframes = body.replace(/@keyframes[^{]+\{[^{}]*\{[^{}]*\}[^{}]*\{[^{}]*\}\s*\}/g, '');
  const rules = [...withoutKeyframes.matchAll(/([^{}]+)\{[^{}]*\}/g)].map((m) => m[1].replace(/\/\*[^]*?\*\//g, '').trim()).filter(Boolean);
  assert.ok(rules.length > 150, `the phone layout has its rules (${rules.length})`);
  for (const rule of rules) {
    for (const selector of rule.split(',').map((s) => s.trim())) {
      assert.ok(selector.startsWith(PREFIX), `starts at the phone root: ${selector.slice(0, 120)}`);
    }
  }
  assert.doesNotMatch(css, /url\(\s*['"]?https?:/i, 'nothing is fetched from outside');
});

test('on a phone nothing scrolls sideways, and setting up waits for a computer', () => {
  const css = read('public/mobile.css');
  assert.doesNotMatch(css, /overflow(-x)?:\s*(auto|scroll)\s*;(?![^}]*overflow-y)/, 'no sideways scrolling area');
  for (const rule of css.match(/[^{}]+\{[^{}]*overflow-x[^{}]*\}/g) ?? []) assert.doesNotMatch(rule, /overflow-x:\s*(auto|scroll)/, rule.slice(0, 160));
  assert.match(css, /\.m-picked \{ display: none; \}/, 'more than three tabs become one button and a sheet');
  assert.match(css, /\.m-seg \{ display: grid; grid-auto-flow: column; grid-auto-columns: minmax\(0, 1fr\)/, 'up to three share the width');
  assert.match(css, /#getting-started \{ display: none; \}/, 'no six-step setup on a phone');
  assert.match(css, /#totals\.totals \{ display: grid;[^}]*repeat\(3, minmax\(0, 1fr\)\)/, 'the totals are a grid, three across');
  assert.match(css, /\.gv-figs \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/, 'so are the Labs figures');
  // Engines and branch wait behind Narrow down; the search stays and the rest waits behind Filter.
  assert.match(css, /\.m-scope-sheet \.scope-row > \.scope-field:has\(> details\) \{ display: none;/);
  assert.match(css, /\.m-scope-sheet \.scope-row:has\(#narrow-toggle\[aria-expanded="true"\]\) > \.scope-field:has\(> details\) \{ display: grid; \}/);
  const js = read('public/mobile.js');
  assert.match(js, /document\.querySelectorAll\('\.filters, \.gv-tools'\)/);
  assert.match(js, /const rest = \[\.\.\.box\.children\]\.filter\(\(el\) => el !== search\)/);
});

test('the phone pieces stay out of sight on a wider screen', () => {
  const css = read('public/styles.css');
  const rule = css.match(/:root:not\(\[data-phone\]\) :is\(([^)]+)\) \{ display: none !important; \}/);
  assert.ok(rule, 'one rule hides them');
  for (const piece of ['.m-more', '.m-select', '.m-sev', '.m-scope-row', '.m-sheet', '.m-backdrop', '.m-detail-head']) {
    assert.ok(rule[1].includes(piece), `${piece} is hidden off a phone`);
  }
  // The raised 3D buttons of the newer looks leave the phone's flat controls alone (golden buttons untouched too).
  const chains = read('public/nextgen.css').match(/:root\[data-ui="nextgen"\] :is\(button:not\(\.is-golden\)[^{]*\{/g) ?? [];
  assert.ok(chains.length >= 4);
  for (const chain of chains) assert.ok(chain.includes(':not(.m-flat)'), 'flat phone controls are left flat');
});

test('the page loads the phone layer after the looks, and starts it once the menu exists', () => {
  const html = read('public/index.html');
  const looks = html.indexOf('href="nextgen.css"');
  const phone = html.indexOf('href="mobile.css"');
  assert.ok(looks > 0 && phone > looks, 'mobile.css comes after nextgen.css');
  const app = read('public/app.js');
  assert.match(app, /import \{ initMobile \} from '\.\/mobile\.js';/);
  assert.equal(app.match(/^initMobile\(\);$/gm)?.length, 1, 'started once, at the top level');
});

test('the phone layer writes only its own markup: names and labels go in as text', () => {
  const js = read('public/mobile.js');
  assert.match(js, /^export function initMobile\(/m);
  const allowed = new Set(['MORE_ICON', 'CLOSE_ICON', 'BACK_ICON', 'SCOPE_ICON', 'HELP_ICON', 'CHEVRON', 'ROW_ICONS[key]', 'label', 'id', 'title', 'closeLabel', "b.querySelector('svg')?.outerHTML ?? ''", "svg('<path d=\"M4 6h16M7 12h10M10 18h4\" />')"]);
  const templates = [...js.matchAll(/innerHTML = `([^`]*)`/g)].map((m) => m[1]);
  assert.ok(templates.length >= 5);
  for (const template of templates) {
    for (const [, expr] of template.matchAll(/\$\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g)) {
      if (expr.startsWith('\n') || expr.includes('?') && expr.includes(':') && !expr.includes('outerHTML')) {
        // The sheet's close control: a fixed choice between two of the module's own buttons.
        assert.match(expr, /done\s*\?/, `only the Done-or-close choice is computed: ${expr}`);
        continue;
      }
      assert.ok(allowed.has(expr.trim()), `only the module's own constants go into markup: ${expr}`);
    }
  }
  // The person's name, role, the project's actions and the scope summary are set as text.
  for (const sink of ["me.querySelector('b').textContent = name", "act.querySelector('.m-lbl').textContent", "scopeRow.querySelector('b').textContent"]) {
    assert.ok(js.includes(sink), sink);
  }
  // The callers pass fixed English labels that the page translates; no caller passes data.
  for (const [, args] of js.matchAll(/makeSheet\(\{([^}]*)\}\)/g)) assert.doesNotMatch(args, /\$\{|\+/);
});

test('the Load button in the summary row is the Workbench\'s own Load findings (or Stop while loading)', () => {
  const js = read('public/mobile.js');
  assert.match(js, /\(stopBtn && !stopBtn\.hidden \? stopBtn : fetchBtn\)\?\.click\(\)/);
  assert.match(js, /load\.disabled = !loading && Boolean\(fetchBtn\?\.disabled\)/, 'disabled when Load findings is');
  assert.match(js, /fetchBtn\.classList\.contains\('perm-hidden'\)/, 'hidden when the person may not load findings');
});

test('a project\'s actions on a phone act on that project alone', () => {
  const js = read('public/mobile.js');
  const actOn = js.slice(js.indexOf('const actOn ='), js.indexOf('};', js.indexOf('const actOn =')));
  assert.match(actOn, /input\[data-select\]:checked/, 'every other ticked project is unticked first');
  assert.match(actOn, /own && !own\.checked/, 'then this one is ticked');
  assert.match(actOn, /#act-bar \[data-rail-open=/, 'the same panel the selection bar opens');
  assert.match(js, /#act-bar \[data-rail-open\]'\)\]\.filter\(\(b\) => !b\.hidden && !b\.classList\.contains\('perm-hidden'\)/, 'only actions the person may take');
});

test('every word the phone layer shows is translated into each language', () => {
  const words = ['More', 'Menu', 'What to load', 'Filter', 'Done', 'Load', 'Select', 'Projects', 'Tenant', 'Connections', 'Language', 'Theme', 'Get help', 'Close'];
  const catalog = JSON.parse(read('i18n/catalog.json'));
  for (const word of words) assert.ok(catalog[word], `"${word}" is in the catalog`);
  for (const code of LANGUAGE_CODES) {
    const { strings } = JSON.parse(read(`public/i18n/${code}.json`));
    for (const word of words) assert.ok(strings[word], `${code}: "${word}"`);
  }
});
