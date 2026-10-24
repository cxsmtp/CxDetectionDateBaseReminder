// The browser code that takes words, addresses and links from outside the page (a server, this
// browser's storage, a translation file): what it lets in, run here as the page runs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import { safeMarkup } from '../public/i18n.js';
import { nextSpeedster, shuffled, SPEEDSTERS } from '../public/speedsters.js';

const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// "Copy git command" (src/report/report.client.js)
// ---------------------------------------------------------------------------

const reportClient = vm.runInNewContext(`${read('src/report/report.client.js')}\n;({ gitCommandUrl, webAddress })`, {
  window: {},
  document: { getElementById: () => ({}) }, // a report with words: it waits for them (setTimeout)
  setTimeout: () => 0,
  URL,
});

test('the git command takes the fix link only when nothing in it means anything to cmd, PowerShell or a shell', () => {
  const { gitCommandUrl } = reportClient;
  const good = 'https://mz.example/api/relay/patch/WyJzMSIsImExIiwxXQ.Zm9vYmFyLV8?t=acme-2';
  assert.equal(gitCommandUrl(good), good);
  assert.equal(gitCommandUrl('http://mz.local:3000/base/api/relay/patch/a.b'), 'http://mz.local:3000/base/api/relay/patch/a.b');
  for (const bad of [
    'https://mz.example/api/relay/patch/$(calc)',
    'https://mz.example/api/relay/patch/a`calc`',
    'https://mz.example/api/relay/patch/%USERPROFILE%',
    'https://mz.example/api/relay/patch/a!x!',
    'https://mz.example/api/relay/patch/a^&calc',
    'https://mz.example/x" & calc & "',
    'https://mz.example/x;calc',
    'https://user:pw@mz.example/x',
    'https://mz.example/x#frag',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'not a link',
    undefined,
  ]) assert.equal(gitCommandUrl(bad), '', String(bad));
});

test("the report's server, as corrected in this browser, is an http(s) address or nothing", () => {
  const { webAddress } = reportClient;
  assert.equal(webAddress('https://mz.example/base/'), 'https://mz.example/base');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'https://u:p@mz.example', 'mz.example', '', null]) assert.equal(webAddress(bad), '', String(bad));
});

// ---------------------------------------------------------------------------
// The report's words (src/report/i18n-boot.client.js)
// ---------------------------------------------------------------------------

/** Run the report's language start-up with this island, storage and server; returns its word loader and the addresses it fetched. */
async function bootWords({ island, stored = {}, serverWords = {} }) {
  let loader = null;
  const fetched = [];
  const storage = new Map(Object.entries(stored));
  const context = vm.createContext({
    t: (text) => text,
    setAvailable() {},
    setLoader: (fn) => {
      loader = fn;
    },
    preferredLanguage: () => 'en',
    currentLanguage: () => 'en',
    setLanguage: async (code) => code,
    startI18n: async () => 'en',
    collect: () => [],
    document: {
      getElementById: (id) =>
        id === 'report-i18n' ? { textContent: JSON.stringify(island) } : id === 'report-data' ? { textContent: JSON.stringify({ config: { relayUrl: 'https://mz.example/' } }) } : null,
    },
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) },
    fetch: async (url) => {
      fetched.push(url);
      return { ok: true, status: 200, json: async () => ({ strings: serverWords }) };
    },
    window: {},
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(read('src/report/i18n-boot.client.js'), context);
  await new Promise((resolve) => setImmediate(resolve));
  return { loader, fetched };
}

const ISLAND = { default: '', version: '1', fetch: true, languages: [['en', 'English'], ['ja', '日本語'], ['de', 'Deutsch']], strings: { ja: JSON.parse('{"Triage":"トリアージ","__proto__":{"polluted":true},"constructor":"x"}') } };

test("a language the report does not offer is never looked up, and no word can reach an object's prototype", async () => {
  const { loader, fetched } = await bootWords({ island: ISLAND });
  for (const code of ['__proto__', 'constructor', 'toString', 'xx']) await assert.rejects(loader(code), /not offered/, code);
  const ja = await loader('ja');
  assert.equal(ja.Triage, 'トリアージ');
  assert.equal(Object.getPrototypeOf(ja), null);
  assert.ok(!Object.hasOwn(ja, '__proto__') && !Object.hasOwn(ja, 'constructor'));
  assert.equal({}.polluted, undefined);
  assert.deepEqual(fetched, [], 'carried words are not fetched');
});

test('words from the server or storage keep exactly the markup of their English, and come from a web address only', async () => {
  const serverWords = { Triage: 'Triage (de)', '<b>Bold</b> text': '<b>Fett</b> Text', 'Plain': '<img src=x onerror=alert(1)>Schlicht', __proto__: 'x' };
  const corrected = await bootWords({ island: ISLAND, serverWords, stored: { 'cxReportServer:https://mz.example': 'javascript:alert(1)' } });
  const de = await corrected.loader('de');
  assert.deepEqual(corrected.fetched, ['https://mz.example/api/relay/report-words/de'], 'a stored address that is not a web one is ignored');
  assert.equal(de.Triage, 'Triage (de)');
  assert.equal(de['<b>Bold</b> text'], '<b>Fett</b> Text');
  assert.equal(de.Plain, undefined, 'a word with markup its English does not have is left out');
  const moved = await bootWords({ island: ISLAND, serverWords, stored: { 'cxReportServer:https://mz.example': 'https://mz2.example/' } });
  await moved.loader('de');
  assert.deepEqual(moved.fetched, ['https://mz2.example/api/relay/report-words/de'], "the reader's correction is used when it is a web address");
});

// ---------------------------------------------------------------------------
// Translations put in as HTML (public/i18n.js)
// ---------------------------------------------------------------------------

test('a translated sentence keeps inline markup only: other elements read as text, handlers and script links go', () => {
  const same = ['Hello <b>world</b> and <a href="#/reports">reports</a>', '<span class="badge warn" data-beta-badge="sla">Beta</span> text', '<a href="https://x.example/?a=1&amp;b=2" target="_blank" rel="noopener">x</a>', '<i aria-hidden="true">i</i> <code>npm</code>', '<a href="#" data-terms-open="">terms</a>', 'a &lt; b'];
  for (const html of same) assert.equal(safeMarkup(html), html);
  assert.equal(safeMarkup('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)>');
  assert.equal(safeMarkup('<x a="<img src=x onerror=alert(1)>">t'), '&lt;x a="&lt;img src=x onerror=alert(1)>">t');
  assert.equal(safeMarkup('<script>alert(1)</script>'), '&lt;script>alert(1)&lt;/script>');
  assert.equal(safeMarkup('<svg onload=alert(1)>'), '&lt;svg onload=alert(1)>');
  assert.equal(safeMarkup('<b onclick="alert(1)" id="x">x</b>'), '<b>x</b>');
  for (const href of ['javascript:alert(1)', ' javascript:alert(1)', 'jav&#97;script:alert(1)', 'data:text/html,x', 'java\tscript:x']) assert.equal(safeMarkup(`<a href="${href}">x</a>`), '<a>x</a>', href);
  assert.equal(safeMarkup('<span title="a > b">t</span>'), '<span title="a &gt; b">t</span>');
  assert.equal(safeMarkup('<!-- c --><b>x</b> < y <b'), '<b>x</b> &lt; y &lt;b');
  // Whatever comes out, the only tags in it are allowed inline ones without handlers.
  for (const tag of safeMarkup('<b/onmouseover=alert(1)>x</b><iframe srcdoc="x"><a href=javascript:1 onclick=1>').match(/<[^>]*>/g) ?? []) {
    assert.match(tag, /^<\/?(b|a)\b/, tag);
    assert.doesNotMatch(tag, /\son|script:/i, tag);
  }
});

test('the translator builds every sentence through the sanitiser', () => {
  const source = read('public/i18n.js');
  assert.match(source, /template\.innerHTML = safeMarkup\(html\);/);
  assert.equal((source.match(/\.innerHTML\s*=(?!=)/g) ?? []).length, 1, 'no other place puts HTML in');
});

// ---------------------------------------------------------------------------
// The "in progress" icons (public/speedsters.js)
// ---------------------------------------------------------------------------

test('the icons are shuffled from the crypto random source, every one once, never the same twice in a row', () => {
  assert.doesNotMatch(read('public/speedsters.js'), /Math\.random/);
  const list = [...Array(20).keys()];
  const out = shuffled(list);
  assert.deepEqual([...out].sort((a, b) => a - b), list);
  assert.deepEqual(list, [...Array(20).keys()], 'the list given is not changed');
  let previous = null;
  for (let i = 0; i < SPEEDSTERS.length * 5; i += 1) {
    const next = nextSpeedster();
    assert.notEqual(next, previous);
    previous = next;
  }
});
