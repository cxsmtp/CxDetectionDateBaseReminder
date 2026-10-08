import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { buildReportData } from '../src/reminder.js';
import { generateHtmlReport } from '../src/html-report.js';
import { reportI18n, reportKeys, reportWords } from '../src/report-i18n.js';
import { scriptKeys } from '../scripts/i18n-report.mjs';

const catalog = JSON.parse(fs.readFileSync(new URL('../i18n/catalog.json', import.meta.url), 'utf8'));
const risk = (i, extra = {}) => ({ id: `r${i}`, riskId: `r${i}`, scanId: 's1', projectId: 'p1', projectName: 'Shop', title: `Vuln ${i}`, severity: 'HIGH', scanner: 'SAST', location: `a.js:${i}`, state: 'TO_VERIFY', ageDays: i, alternateId: `a${i}`, groupId: `g${i}`, ...extra });
const islandOf = (html) => JSON.parse(html.match(/<script type="application\/json" id="report-i18n">([\s\S]*?)<\/script>/)?.[1] ?? 'null');

test('every word the report writes is listed for translation, and every listed word is in the catalog', () => {
  const keys = new Set(reportKeys());
  const missing = [...scriptKeys()].filter((key) => !keys.has(key));
  assert.deepEqual(missing, [], 'run node scripts/i18n-report.mjs after changing the report\'s wording');
  assert.deepEqual(reportKeys().filter((key) => !catalog[key]), []);
});

test('wording with names in it is rewritten from data-l, and its key is listed', () => {
  const html = generateHtmlReport(buildReportData([risk(1, { scanner: 'SCA', fixVersion: '1.2.3' }), risk(2, { scanner: 'KICS' })], { tenant: 't' }), { connection: { tenant: 'acme' } });
  const keys = new Set(reportKeys());
  const used = [...html.matchAll(/data-l(?:-title)?="([^"]*)"/g)].map((m) => m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
  assert.ok(used.length >= 4);
  assert.deepEqual(used.filter((key) => !keys.has(key)), []);
  assert.match(html, /<span data-l="tenant \{0\}" data-v="\[&quot;acme&quot;\]" translate="no">tenant acme<\/span>/);
  assert.match(html, /<a href="[^"]*" target="_blank" rel="noopener" translate="no">Vuln 1<\/a>|<span translate="no">Vuln 1<\/span>/, 'a finding\'s title is never translated');
});

test('a report carries its reader\'s language only, offers the rest from the server, and none without one', () => {
  const data = buildReportData([risk(1)], { tenant: 't' });
  const i18n = reportI18n({ codes: ['en', 'ja', 'de', 'fr'], preferred: 'ja' });
  assert.deepEqual(Object.keys(i18n.strings), ['ja']);
  const withServer = islandOf(generateHtmlReport(data, { relayUrl: 'https://mz.example', i18n }));
  assert.equal(withServer.default, 'ja');
  assert.deepEqual(withServer.languages.map(([code]) => code), ['en', 'ja', 'de', 'fr']);
  assert.equal(withServer.fetch, true);
  // No server to ask: it offers what it carries.
  const offline = islandOf(generateHtmlReport(data, { i18n }));
  assert.deepEqual(offline.languages.map(([code]) => code), ['en', 'ja']);
  assert.equal(offline.fetch, false);
  // Nothing to offer: no translator in the report at all.
  const english = generateHtmlReport(data, { i18n: reportI18n({ codes: ['en', 'ja'], preferred: '' }) });
  assert.equal(islandOf(english), null);
  assert.doesNotMatch(english, /<script type="module">/);
  // No profile language: the reader's browser decides.
  assert.equal(islandOf(generateHtmlReport(data, { relayUrl: 'https://mz.example', i18n: reportI18n({ codes: ['en', 'ja'] }) })).default, '');
});

test('a language behind an activation code travels only in the reports of people it is on for, and the server never hands it out', () => {
  assert.equal(reportWords('he'), null);
  assert.equal(reportWords('xx'), null);
  assert.ok(!reportI18n({ codes: ['en', 'ja'] }).languages.some(([code]) => code === 'he'));
  const on = reportI18n({ codes: ['en', 'ja', 'he'] });
  assert.ok(on.languages.some(([code]) => code === 'he'));
  assert.ok(on.strings.he, 'carried, since it cannot be fetched');
  const ja = reportWords('ja');
  assert.ok(Object.keys(ja).every((key) => reportKeys().includes(key)), 'only the report\'s own wording');
});

test('the translator and its start-up are inlined as one module that parses, and nothing in the island can close its tag', () => {
  const i18n = reportI18n({ codes: ['en', 'ja'], preferred: 'ja' });
  i18n.strings.ja = { ...i18n.strings.ja, Triage: '</script><script>alert(1)</script>' };
  const html = generateHtmlReport(buildReportData([risk(1)], { tenant: 't' }), { relayUrl: 'https://mz.example', i18n });
  const module = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
  assert.match(module, /export function setLoader/);
  assert.match(module, /MZReportStart/);
  assert.equal((html.match(/<script>alert\(1\)/g) ?? []).length, 0);
  assert.equal(islandOf(html).strings.ja.Triage, '</script><script>alert(1)</script>');
  assert.match(html, /<select id="report-lang" translate="no">/);
});
