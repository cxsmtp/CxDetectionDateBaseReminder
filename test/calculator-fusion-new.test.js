// Cx Credits Calculator, Fusion — new customer: code not in Checkmarx One yet, its lines counted with cloc.
// The cloc reports it reads, how its credits are worked out, how a customer keeps it, and the total.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { CLOC_LEFT_OUT, clocLines, clocName, creditSummary, fusionTotal, newCustomerEstimate, parseCloc } from '../public/calculator/model.js';
import { cleanFusionNew, newProfile, newReport, patchProfile } from '../public/calculator/profiles.js';
import { buildReport } from '../public/calculator/report.js';
import { slideContent } from '../public/calculator/slides.js';

const MODELS = [{ id: 'm1', name: 'opus-4.7', creditsPer10k: 40 }, { id: 'm2', name: 'haiku-4.5', creditsPer10k: 8 }];

test('cloc reports are read as cloc writes them: --json and --csv, one repository or --by-file over many', () => {
  // cloc --json: one repository, named after the file.
  const one = JSON.stringify({ header: { cloc_url: 'github.com/AlDanial/cloc', cloc_version: '2.02' }, Java: { nFiles: 10, blank: 900, comment: 300, code: 18240 }, XML: { nFiles: 2, blank: 0, comment: 0, code: 400 }, SUM: { nFiles: 12, code: 18640 } });
  assert.deepEqual(parseCloc(one, 'C:\\code\\trade-finance.json'), [{ name: 'trade-finance', langs: { Java: 18240, XML: 400 } }]);
  // cloc --json --by-file run on the folder holding the repositories: a project per folder in it.
  const many = JSON.stringify({ header: {}, '/src/payments/a/A.cs': { blank: 1, comment: 1, code: 100, language: 'C#' }, '/src/payments/B.cs': { blank: 1, comment: 1, code: 50, language: 'C#' }, '/src/portal/x.ts': { blank: 0, comment: 0, code: 70, language: 'TypeScript' }, SUM: {} });
  assert.deepEqual(parseCloc(many, 'all.json'), [{ name: 'payments', langs: { 'C#': 150 } }, { name: 'portal', langs: { TypeScript: 70 } }]);
  // cloc --csv, and --csv --by-file.
  const csv = 'files,language,blank,comment,code,"github.com/AlDanial/cloc v 2.02  T=0.50 s"\n12,Python,100,200,5400\n3,YAML,1,1,80\n15,SUM,101,201,5480\n';
  assert.deepEqual(parseCloc(csv, 'risk-engine.csv'), [{ name: 'risk-engine', langs: { Python: 5400, YAML: 80 } }]);
  const csvByFile = 'language,filename,blank,comment,code,"github.com/AlDanial/cloc v 2.02"\nJava,/src/a/X.java,1,1,500\nGo,/src/b/main.go,1,1,300\nSUM,,2,2,800\n';
  assert.deepEqual(parseCloc(csvByFile, 'x.csv'), [{ name: 'a', langs: { Java: 500 } }, { name: 'b', langs: { Go: 300 } }]);
  // Anything else is refused, with what to do.
  assert.throws(() => parseCloc('hello', 'notes.txt'), /notes\.txt is not a cloc report: run cloc with --json or --csv/);
  assert.throws(() => parseCloc('{"a": 1}', 'x.json'), /not a cloc report/);
  assert.equal(clocName('payments-api.cloc.json'), 'payments-api');
});

test('only code lines count, without documentation, data and markup unless the reader counts them', () => {
  const p = { langs: { Java: 182400, Kotlin: 21800, XML: 40200, Markdown: 2200, JSON: 900 } };
  assert.deepEqual([...CLOC_LEFT_OUT].sort(), ['CSV', 'HTML', 'JSON', 'Markdown', 'SVG', 'Text', 'XML', 'YAML']);
  assert.equal(clocLines(p), 204200);
  assert.equal(clocLines(p, ['Markdown']), 204200 + 40200 + 900);
  assert.equal(clocLines({ ...p, locOverride: 5000 }), 5000, 'lines typed win');
  assert.equal(clocLines({ langs: {} }), null, 'nothing counted yet');
});

test('a new customer\'s credits: each project rounded up to 10K units × its scans × its model\'s credits per 10K', () => {
  const est = newCustomerEstimate(
    { defaultScans: 12, projects: [{ id: 'a', name: 'trade-finance', langs: { Java: 182400, XML: 40000 } }, { id: 'b', name: 'typed', langs: {}, locOverride: 25000, scansOverride: 2, modelOverride: 'm2' }, { id: 'c', name: 'off', langs: { Go: 90000 }, included: false }] },
    { models: MODELS, defaultModel: 'm1' },
  );
  const [tf, typed, off] = est.rows;
  assert.deepEqual([tf.lines, tf.units, tf.scans, tf.model, tf.credits], [182400, 19, 12, 'm1', 19 * 12 * 40]);
  assert.deepEqual([typed.lines, typed.units, typed.scans, typed.model, typed.credits], [25000, 3, 2, 'm2', 3 * 2 * 8]);
  assert.equal(off.credits, 0);
  assert.equal(est.totals.credits, 9120 + 48);
  assert.equal(est.totals.projects, 2);
  assert.equal(est.settings.defaultModel, 'm1', 'the existing customer tab\'s model when none is chosen');
  assert.equal(newCustomerEstimate({ projects: [{ id: 'x', langs: { Java: 1 } }] }, { models: [{ id: 'm', name: 'x', creditsPer10k: null }] }).totals.unknownRate, 1, 'a model without a rate is said, not counted as free');
});

test('the total counts Fusion for the existing customer and for the new customer, each only when ticked', () => {
  assert.equal(fusionTotal({ totals: { credits: 100 } }, { totals: { credits: 50 } }), 150);
  assert.equal(fusionTotal(null, { totals: { credits: 50 } }), 50);
  assert.equal(fusionTotal(null, null), null, 'neither: no Fusion part');
  assert.equal(fusionTotal({ totals: { credits: null } }, null), null);
});

test('a customer keeps the new customer tab: cleaned like everything else saved, and in its reports\' total', () => {
  const fresh = newProfile({ name: 'Acme' });
  assert.deepEqual(fresh.fusionNew, { defaultScans: 12, defaultModel: null, leftOut: [...CLOC_LEFT_OUT], optOut: false, projects: [] });
  const next = patchProfile(fresh, { fusionNew: { optOut: true, defaultScans: '6', leftOut: ['JSON', 'JSON', ''], projects: [{ name: 'x'.repeat(300), langs: { Java: '1,000', ['__proto__']: 5, constructor: 1 }, scansOverride: '3', modelOverride: 'm1' }] } });
  const p = next.fusionNew.projects[0];
  assert.equal(next.fusionNew.optOut, true);
  assert.equal(next.fusionNew.defaultScans, 6);
  assert.deepEqual(next.fusionNew.leftOut, ['JSON']);
  assert.equal(p.name.length, 200);
  assert.deepEqual(p.langs, { Java: 1000 }, 'only languages, never an object\'s own keys');
  assert.equal(p.scansOverride, 3);
  assert.deepEqual(cleanFusionNew(null).projects, []);
  const report = newReport({ customerId: 'c', customer: 'Acme', data: { fusion: { totals: { credits: 1000 } }, fusionNew: { totals: { credits: 500 } }, summary: { settings: { extraPercent: 10 } } } });
  assert.equal(report.fusionCredits, 1500);
  assert.equal(report.totalCredits, 1650);
});

test('the projection report and its PDF show the new customer as its own part of the total', () => {
  const est = newCustomerEstimate({ projects: [{ id: 'a', name: 'trade-finance', langs: { Java: 182400 } }] }, { models: MODELS });
  const fusionNew = { periodMonths: 12, defaultScans: 12, defaultModel: 'm1', models: MODELS, leftOut: [...CLOC_LEFT_OUT], byModel: est.byModel, totals: est.totals, rows: est.rows.map((r) => ({ name: r.name, included: true, lines: r.lines, units: r.units, scans: r.scans, model: r.model, credits: r.credits, languages: r.languages })) };
  const fusion = { periodMonths: 12, defaultScans: 1, defaultModel: 'm1', models: MODELS, rules: {}, byFrequency: [], byModel: [], totals: { projects: 1, lines: 10000, units: 1, scans: 1, credits: 40 }, rows: [] };
  const data = { customer: 'Globex', generatedAt: '2026-10-27T10:00:00Z', months: 12, summary: creditSummary(null, 40 + est.totals.credits, {}), tr: null, fusion, fusionNew };
  const html = buildReport(data, {});
  assert.match(html, /Fusion — new customer/);
  assert.match(html, /Fusion — existing customer/);
  assert.match(html, new RegExp(`>${(40 + est.totals.credits).toLocaleString('en')}<`), 'the total counts both parts');
  assert.match(html, /trade-finance/);
  const { pages } = slideContent(data, {});
  assert.ok(JSON.stringify(pages.find((p) => p.kind === 'total')).includes('Fusion — new customer'));
  assert.ok(pages.find((p) => p.kind === 'fusion').lines.some((l) => l.includes('New customer (code counted from git, a cloc-fusion report or cloc)')));
});

test('the page: two Fusion tabs, the two ticks under Add Fusion, and the new customer\'s part in the summary', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /data-pt="fusion">Fusion — existing customer<\/button>\s*<button type="button" role="tab" class="ptab" data-pt="fusion-new">Fusion — new customer<\/button>/);
  assert.match(html, /id="calc-fusion-on" checked \/> Existing customer/);
  assert.match(html, /id="calc-fusion-new-on" checked \/> New customer/);
  // One Fusion tile, for the part that applies (both added up when both do).
  assert.match(html, /<span id="calc-sum-fusion-label">Fusion<\/span>/);
  assert.doesNotMatch(html, /id="calc-sum-fusion-new"/);
  assert.match(html, /docker\.io\/aldanial\/cloc --json --quiet \/src &gt; payments-api\.json/);
  // Saved like the rest of a customer, on the server and in the standalone calculator.
  for (const file of ['../src/server.js', '../public/calculator/standalone.js']) {
    assert.match(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), /\['name', 'tr', 'fusion', 'fusionNew', 'totals', 'scope', 'impact'\]/);
  }
});
