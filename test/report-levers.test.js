import test from 'node:test';
import assert from 'node:assert/strict';
import { analyse, creditSummary, fusionEstimate, seriesRows, trProjection } from '../public/calculator/model.js';
import { buildReport } from '../public/calculator/report.js';
import { changePeriod, foldProjects, leverData, leverInputs, recentRates } from '../public/calculator/levers.js';
import { applyLever } from '../public/calculator/report-live.js';
import { projectionFileProblem, reportRuntime } from '../src/standalone-calculator.js';

const weeks = ['2026-01-03', '2026-02-07', '2026-03-07', '2026-04-04', '2026-05-02', '2026-06-06', '2026-07-04', '2026-08-01', '2026-09-05', '2026-10-03'];
const { totalRows, fixedRows } = seriesRows(
  { weeks, bySeverity: { Critical: [40, 44, 47, 52, 55, 58, 61, 63, 66, 70], High: [610, 640, 660, 690, 720, 735, 760, 790, 805, 830], Medium: [1500, 1520, 1560, 1600, 1610, 1650, 1690, 1700, 1740, 1780], Low: [900, 910, 905, 920, 930, 940, 945, 950, 955, 960] } },
  { weeks, bySeverity: { Critical: [3, 4, 4, 5, 5, 6, 6, 5, 6, 6], High: [30, 32, 35, 36, 38, 40, 41, 42, 44, 45], Medium: [40, 42, 44, 45, 46, 48, 50, 52, 53, 55], Low: [10, 10, 11, 12, 12, 12, 13, 13, 14, 14] } },
);
const analysis = analyse(totalRows, fixedRows, 6);
const FREQ = ['more-5-week', 'more-5-week', '1-5-week', '1-5-week', '1-5-week', '2-weeks', 'month', 'month', '3-months', 'year', 'rare', '2-weeks'];
const NAMES = ['payments-api', 'checkout-web', 'claims-portal', 'broker-api', 'policy-engine', 'mobile-app', 'data-lake', 'reporting-svc', 'legacy-batch', 'hr-tools', 'archive-svc', 'partner-gw'];
const projects = NAMES.map((name, i) => ({ id: `p${i}`, name, loc: [182400, 96000, 240000, 61200, 120500, 38900, 64000, 22000, 23900, 9000, 4000, 51000][i], frequency: FREQ[i], criticality: [5, 5, 4, 4, 3, 3, 2, 2, 1, 1, 1, 3][i], ...(i === 3 ? { scansOverride: 40, modelOverride: 'm2' } : {}) }));
const settings = { periodMonths: 12, defaultModel: 'm1', models: [{ id: 'm1', name: 'opus-4.7', creditsPer10k: 40 }, { id: 'm2', name: 'haiku-4.5', creditsPer10k: 8 }, { id: 'm3', name: 'opus-5.5', creditsPer10k: null }], byFrequency: { 'more-5-week': { scans: 52, model: 'm1' }, '1-5-week': { scans: 26 }, '2-weeks': { scans: 12, model: 'm2' }, month: { scans: 6, model: 'm2' }, '3-months': { scans: 4, model: 'm2' }, year: { scans: 1, model: 'm2' }, rare: { scans: 1, model: 'm2' } }, byCriticality: { 5: { scans: 60 } } };
const plan = { selected: { High: 500 }, fpPercent: { Critical: 20 }, includeFuture: true, aiDeclinePercent: 20, fusionUpliftPercent: 5 };
const est = fusionEstimate(projects, settings);
const inputsFor = (details) => leverInputs({ analysis, plan, months: 12, fusionOn: true, recent: recentRates(analyse(totalRows, fixedRows, 6)), fusion: { settings: est.settings, projects, remainingCredits: 1000 }, totals: { extraPercent: 10, bundleCredits: 10000 }, details });
const base = { version: 2, customer: 'Globex', generatedAt: '2026-10-30T09:00:00Z', source: { kind: 'cxone' }, tr: null, fusion: null, fusionNew: null, impact: null };

test('the levers work the report out again exactly as the calculator does', () => {
  const data = leverData(base, inputsFor(true));
  const projection = trProjection(analysis, plan, { months: 12, fusion: true });
  assert.deepEqual(data.tr.totals, projection.totals);
  assert.equal(data.fusion.totals.credits, est.totals.credits);
  assert.deepEqual(data.fusion.byFrequency, est.byFrequency);
  assert.deepEqual(data.summary, creditSummary(projection.totals.credits, est.totals.credits, { extraPercent: 10, bundleCredits: 10000 }));
  assert.equal(data.fusion.rows.length, projects.length);
});

test('without project details: the same credits, and no project named anywhere in the file', () => {
  const inputs = inputsFor(false);
  const data = leverData(base, inputs);
  const full = leverData(base, inputsFor(true));
  assert.equal(data.fusion.totals.credits, full.fusion.totals.credits);
  assert.deepEqual(data.fusion.byFrequency, full.fusion.byFrequency);
  assert.deepEqual(data.fusion.byModel, full.fusion.byModel);
  assert.equal(data.fusion.totals.projects, projects.length);
  assert.deepEqual(data.fusion.rows, []);
  const runtime = reportRuntime();
  const html = buildReport(data, { live: { inputs, sentInputs: inputs, sentTotal: data.summary.total, base, words: {}, runtime } });
  const withoutScript = html.replace(`<script>${runtime.text}</script>`, '');
  for (const name of NAMES) assert.ok(!withoutScript.includes(name), name);
  assert.match(html, /Project names and details were left out of this report/);
});

test('folded projects keep their count, units and what was set for them', () => {
  const folded = foldProjects(projects);
  assert.equal(folded.reduce((n, g) => n + g.count, 0), projects.length);
  assert.ok(folded.every((g) => !('name' in g) && !('id' in g)));
  assert.ok(folded.some((g) => g.scansOverride === 40 && g.modelOverride === 'm2'));
});

test('levers move the figures: backlog, false positives, a model rate, a frequency, a project, the period', () => {
  let inputs = inputsFor(true);
  const before = leverData(base, inputs).summary.total;
  inputs = applyLever(inputs, 'sel.High', '100');
  assert.ok(leverData(base, inputs).summary.total < before);
  const fp = leverData(base, applyLever(inputs, 'fp.Medium', '90')).tr.rows.Medium.fp;
  assert.equal(fp, 90);
  const cheaper = leverData(base, applyLever(inputs, 'rate.m1', '10')).fusion.totals.credits;
  assert.ok(cheaper < leverData(base, inputs).fusion.totals.credits);
  const scans = leverData(base, applyLever(inputs, 'fscans.month', '12')).fusion.byFrequency.find((b) => b.id === 'month').scans;
  assert.equal(scans, 24);
  const key = inputs.fusion.projects.find((p) => p.name === 'payments-api').key;
  const row = leverData(base, applyLever(inputs, `pmodel.${key}`, 'm2')).fusion.rows.find((r) => r.name === 'payments-api');
  assert.equal(row.model, 'm2');
  const longer = changePeriod(inputs, 24);
  assert.equal(longer.months, 24);
  assert.equal(longer.fusion.settings.byFrequency['more-5-week'].scans, 104);
  assert.equal(longer.fusion.projects.find((p) => p.key === 3).scansOverride, 80);
  assert.equal(applyLever(inputs, 'nothing.here', '1'), inputs);
});

test('a report with its levers runs only its own script; one without has none', () => {
  const inputs = inputsFor(true);
  const data = leverData(base, inputs);
  const runtime = reportRuntime();
  const live = buildReport(data, { live: { inputs, sentInputs: inputs, sentTotal: data.summary.total, base, words: {}, runtime } });
  assert.ok(live.includes(`script-src ${runtime.hash};`));
  assert.ok(live.includes("connect-src 'none'"));
  const rest = live.replace(`<script>${runtime.text}</script>`, '');
  assert.equal(rest.length, live.length - runtime.text.length - 17);
  assert.deepEqual(rest.match(/<script[^>]*>/g), ['<script type="application/json" id="cx-live">']);
  assert.ok(live.includes('id="cx-live"'));
  const plain = buildReport(data, {});
  assert.ok(!/<script/i.test(plain));
  // What the email route accepts: either one, and nothing else with a script in it.
  assert.equal(projectionFileProblem(live), '');
  assert.equal(projectionFileProblem(plain), '');
  assert.notEqual(projectionFileProblem(live.replace('</body>', '<script>alert(1)</script></body>')), '');
  assert.notEqual(projectionFileProblem(live.replace(runtime.text, `${runtime.text};alert(1)`)), '');
  assert.notEqual(projectionFileProblem(live.replace("connect-src 'none'", 'connect-src *')), '');
  assert.notEqual(projectionFileProblem(live.replace('</body>', '<img src="https://x.example/a.png"></body>')), '');
  assert.notEqual(projectionFileProblem(live.replace('href="#fusion"', 'href="https://x.example/"')), '');
});

test('the report carries its phrases for translation, and its wording follows them', () => {
  const runtime = reportRuntime();
  assert.ok(runtime.phrases.includes('Try other numbers'));
  assert.ok(runtime.phrases.includes('Download my version'));
  const inputs = inputsFor(true);
  const data = leverData(base, inputs);
  const html = buildReport(data, { t: (s) => (s === 'Try other numbers' ? 'Probieren Sie andere Zahlen' : s), live: { inputs, sentInputs: inputs, sentTotal: data.summary.total, base, words: { 'Try other numbers': 'Probieren Sie andere Zahlen' }, runtime } });
  assert.match(html, /Probieren Sie andere Zahlen/);
  assert.match(html, /"words":\{"Try other numbers":"Probieren Sie andere Zahlen"\}/);
});
