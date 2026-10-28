// The Cx Credits Calculator on its own (src/standalone-calculator.js): one HTML file, built from the app's own
// calculator, that runs with no server and calls nowhere.
import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { buildStandaloneCalculator, calculatorMarkup, standaloneMarkup, wrapModule } from '../src/standalone-calculator.js';
import { newProfile, newReport, patchProfile, restoreProfile } from '../public/calculator/profiles.js';

test('a module becomes a function scope: its named imports read from those before it, its exports returned', () => {
  const index = new Map([['calculator/model.js', 0], ['calculator/charts.js', 1]]);
  const out = wrapModule('calculator/charts.js', "import { SEVERITIES, amount as sum } from './model.js';\nexport const A = 1;\nexport function f() { return SEVERITIES; }\nexport async function g() {}\nconst hidden = 2;\n", index);
  assert.match(out, /const \{ SEVERITIES, amount: sum \} = __m\[0\];/);
  assert.match(out, /return \{ A, f, g \};/);
  assert.ok(!/^export /m.test(out));
  assert.throws(() => wrapModule('calculator/charts.js', "import { x } from './nowhere.js';", index), /not bundled/);
  assert.throws(() => wrapModule('calculator/charts.js', 'export default 1;', index), /does not handle/);
});

test('the file: the calculator page shown, its own words for the exports, nothing fetched from anywhere', () => {
  const html = buildStandaloneCalculator({ version: '1.0.89' });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<div id="page-calculator" class="page calc-page">/, 'shown, not hidden');
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'sha256-[^"]*; script-src-attr 'none'; style-src 'unsafe-inline'; style-src-elem 'sha256-[^']+'; style-src-attr 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'/);
  assert.ok(!/(src|href)="(https?:)?\/\//i.test(html), 'no script, style or link from elsewhere');
  assert.deepEqual(html.match(/url\((?!data:)[^)]*\)/g) ?? [], [], 'every font and drawing inside');
  assert.ok(!html.includes('Use the two Checkmarx One exports instead'));
  assert.match(html, /SIL Open Font License/);
  assert.match(html, /MZ-01\.00\.89/);
  assert.ok(!/brand-fonts|founders[\w-]*\.(woff2?|otf|ttf)/i.test(html), 'the licensed face is never in it');
  // Its script compiles as one script: every module bundled, nothing left to import.
  const js = html.slice(html.indexOf('<script type="module">') + 22, html.lastIndexOf('</script>'));
  assert.doesNotThrow(() => new vm.Script(js));
  assert.ok(js.includes('startStandalone({ samples:'));
  // Its own tab switcher (CxMissionZero's is in app.js, not in the file): Fusion, Impact and the reports open.
  assert.ok(js.includes('[data-ptpanel^="${group}:"]'), 'the tabs switch their panels');
  assert.match(html, /id="calc-fusion-on" checked/, 'Fusion can be left out');
});

test('the page is cut out of index.html whole, and a changed wording fails the build rather than the file', () => {
  const page = calculatorMarkup('<p><div id="page-calculator" class="page calc-page" hidden><div><div></div></div><span>x</span></div><div id="next"></div></p>');
  assert.equal(page, '<div id="page-calculator" class="page calc-page"><div><div></div></div><span>x</span></div>');
  assert.throws(() => standaloneMarkup('<div>nothing</div>'), /no longer says/);
});

test('the summary is one strip, in the app and in the file: the mix, the total and its bundles, the bundle size behind a "?"', () => {
  const app = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const html of [app, buildStandaloneCalculator({ version: '1.1.5' })]) {
    assert.match(html, /<div class="calc-strip" role="group" aria-label="Credits required">/);
    // The bar is a picture: each part's figure and share are written beside it.
    assert.match(html, /<div class="calc-mix-bar" id="calc-mix-bar" aria-hidden="true"><\/div>/);
    for (const id of ['calc-horizon', 'calc-extra', 'calc-sum-tr', 'calc-sum-tr-split', 'calc-sum-fusion', 'calc-sum-fusion-split', 'calc-sum-total', 'calc-sum-bundles', 'calc-sum-exact', 'calc-mix-tr-pct', 'calc-mix-fusion-pct', 'calc-mix-extra-pct']) assert.match(html, new RegExp(`id="${id}"`), id);
    // The "?" on Bundles is a real button that says whether its box is open; the box holds the credits per bundle.
    assert.match(html, /<button type="button" class="calc-why calc-bundle-q" id="calc-bundle-q" aria-expanded="false" aria-controls="calc-bundle-item"/);
    assert.match(html, /<div class="calc-bundle-pop" id="calc-bundle-item" role="group" aria-labelledby="calc-bundle-label" hidden>\s*<label class="field"><span id="calc-bundle-label">Credits per bundle<\/span><input type="text" inputmode="numeric" id="calc-bundle"/);
    assert.doesNotMatch(html, /calc-bundle-change|class="calc-sum"|calc-sum-item/, 'no Change button, no tiles');
  }
});

test('customers and reports follow the same rules here and on the server', () => {
  const p = newProfile({ name: '  Acme  ', by: 'ana' });
  assert.equal(p.name, 'Acme');
  assert.match(p.id, /^[0-9a-f-]{36}$/);
  const next = patchProfile(p, { name: '', totals: { extraPercent: 10, bundleCredits: 5000 } });
  assert.equal(next.name, 'Acme', 'an empty name keeps the old one');
  assert.equal(next.totals.extraPercent, 10);
  assert.throws(() => patchProfile(p, { name: 'x'.repeat(10), tr: { totals: { weeks: Array(2000).fill('2026-01-01'), bySeverity: { Critical: Array(2000).fill(1e15) } } }, fusion: { projects: Array(5000).fill({ name: 'p'.repeat(200), applications: Array(50).fill('a'.repeat(200)) }) } }), /too large/);
  const r = newReport({ customerId: p.id, customer: p.name, data: { tr: { totals: { credits: 100 } }, fusion: { totals: { credits: 50 } }, summary: { settings: { extraPercent: 10, bundleCredits: 100 } }, evil: { __proto__: { x: 1 } } } });
  assert.equal(r.totalCredits, 165);
  assert.equal(r.bundles, 2);
});

test('a restored backup goes through the same cleaners as a save, and the calculator escapes every figure it writes into a field', () => {
  const bad = '"><b id=x>';
  const saved = newProfile({ name: 'Acme', by: 'ana' });
  const file = {
    ...saved,
    name: `Acme${bad}`,
    stray: '<script>1</script>',
    createdAt: bad,
    fusion: { ...saved.fusion, models: [{ id: 'm1', name: 'opus', creditsPer10k: bad, source: 'manual' }], byFrequency: { daily: { scans: bad } } },
    fusionNew: { ...saved.fusionNew, projects: [{ id: 'n1', name: 'web', locOverride: bad, scansOverride: bad }] },
    totals: { extraPercent: bad, bundleCredits: bad },
  };
  const restored = restoreProfile(file);
  assert.equal(restored.id, saved.id);
  assert.equal(restored.fusion.models[0].creditsPer10k, null, 'not a number: nothing kept');
  assert.equal(restored.stray, undefined, 'nothing the file adds is kept');
  assert.match(restored.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  // Only free text (a name, which the page always escapes) may still hold it; no figure does.
  const { name, ...figures } = restored;
  assert.equal(name, `Acme${bad}`);
  const kept = JSON.stringify(figures);
  assert.ok(!kept.includes('<b'), kept.slice(0, 400));
  assert.equal(restoreProfile({ id: 'x', fusion: 'nonsense' }).fusion.models.length, newProfile({}).fusion.models.length, 'a section that is not one: the defaults');
  // The page writes the models table with the real renderModels: neither a restored nor a raw figure becomes markup.
  const src = fs.readFileSync(new URL('../public/calculator/page.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('  function renderModels() {'), src.indexOf('  function renderRules() {'));
  const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  for (const fusion of [restored.fusion, file.fusion]) {
    const els = {};
    vm.runInNewContext(`${body}\nrenderModels();`, { fusion: () => fusion, $: (id) => (els[id] ??= {}), esc });
    assert.match(els['calc-models'].innerHTML, /data-m="creditsPer10k"/);
    assert.doesNotMatch(els['calc-models'].innerHTML, /<b[\s>]/);
  }
  // Every figure written into a value, placeholder or max is escaped (only the page's own fixed ids and words are not).
  const raw = [...src.matchAll(/(?:value|placeholder|max)="\$\{(?!esc\()([^}]*)\}/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(raw)].sort(), ['k', 'q.id', "scanned === null ? 'Type them' : ''"]);
});

test('its content security policy runs exactly the scripts the file was built with, by hash, and no other', () => {
  for (const launcher of [false, true]) {
    const html = buildStandaloneCalculator({ version: '1.0.89', launcher });
    const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/)[1];
    const scriptSrc = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src '));
    assert.doesNotMatch(scriptSrc, /unsafe-inline|unsafe-eval|\*|data:|blob:|https?:/, 'no inline script runs unless it is one of these');
    const allowed = new Set(scriptSrc.split(/\s+/).slice(1));
    const scripts = [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)].filter(([, attrs = '']) => !/type="application\/json"/.test(attrs));
    assert.equal(scripts.length, launcher ? 5 : 4);
    assert.equal(allowed.size, scripts.length, 'one hash for each script, nothing more');
    for (const [, , text] of scripts) assert.ok(allowed.has(`'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`), 'every script in the file is named');
    assert.ok(!allowed.has(`'sha256-${createHash('sha256').update('alert(1)', 'utf8').digest('base64')}'`));
    assert.match(csp, /script-src-attr 'none'/, 'no event handler attribute runs');
    const styles = [...html.slice(0, html.indexOf('</head>')).matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
    assert.equal(styles.length, 1);
    assert.match(csp, new RegExp(`style-src-elem 'sha256-${createHash('sha256').update(styles[0], 'utf8').digest('base64').replace(/[+/]/g, '\\$&')}';`), 'only its own stylesheet applies');
    assert.match(csp, /object-src 'none'; base-uri 'none'; form-action 'none'/);
    assert.match(csp, launcher ? /connect-src 'self'/ : /connect-src 'none'/);
  }
});
