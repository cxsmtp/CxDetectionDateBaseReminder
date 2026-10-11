// Cx Credits Calculator: the arithmetic (triage & remediation, and Fusion scans rounded up per
// project), the saved customers and reports, what is kept of what the page sends, the report
// file, the activation scope and the organisation name.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';

import { allocate, analyse, backlogForecast, creditSummary, frequencyOf, fusionEstimate, fusionSettings, seriesRows, severityForecast, suggestedScans, totalsSettings, trCost, unitsOf, weeklyTrend } from '../public/calculator/model.js';
import { buildReport, reportFileName } from '../public/calculator/report.js';
import { MAX_PROFILE_BYTES, ProjectionStore, ReportStore, cleanFusion, cleanReportData, cleanTr, countersOf, readFusionOffer, readFusionProjects, readTenant, weeklyBacklog } from '../src/projections.js';
import { ActivationStore, checkCode } from '../src/activation.js';
import { Terms, cleanName } from '../src/terms.js';
import { STATE_DIRS } from '../src/data-dir.js';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const totals = { weeks: ['2026-01-03', '2026-02-07', '2026-03-07', '2026-04-04'], bySeverity: { Critical: [10, 12, 14, 16], High: [100, 110, 120, 130], Medium: [5, 5, 5, 5], Low: [1, 1, 1, 1] } };
const fixed = { weeks: ['2026-03-07', '2026-04-04'], bySeverity: { Critical: [1, 2], High: [3, 4] } };

test('triage & remediation: backlog, debt growth, fix rate, credits and forecasts', () => {
  const { totalRows, fixedRows } = seriesRows(totals, fixed);
  const latest = analyse(totalRows, fixedRows, 0);
  assert.deepEqual(latest.perSeverity.Critical, { current: 16, prior: 14, fixed: 2, debtRate: (2 / 14) * 100, fixRate: 12.5 });
  assert.equal(latest.total.current, 152);
  assert.equal(latest.monthlyChange, 12, '(152 − 116) over 3 months');
  const quarter = analyse(totalRows, fixedRows, 3);
  assert.equal(quarter.previousDate, '2026-01-03', 'three months back');
  assert.equal(quarter.perSeverity.Critical.fixed, 3);

  // 1 credit per triage, 3 per remediation, 30% false positives (which pay triage only); never more than is open.
  const cost = trCost(latest, { selected: { Critical: 16, High: 999 }, triageCost: {}, fpPercent: {}, remediationCost: {} });
  assert.equal(cost.rows.High.selected, 130);
  assert.equal(cost.rows.Critical.triageCredits, 16);
  assert.ok(Math.abs(cost.rows.Critical.remediationCredits - 16 * 0.7 * 3) < 1e-9);
  assert.ok(Math.abs(cost.totals.credits - (146 + 146 * 0.7 * 3)) < 1e-9);
  assert.equal(cost.totals.backlogAfter, 6);
  const custom = trCost(latest, { selected: { Low: 1 }, triageCost: { Low: 2 }, fpPercent: { Low: 100 }, remediationCost: { Low: 5 } });
  assert.equal(custom.totals.credits, 2, 'all false positives: triage only');

  const forecast = backlogForecast(latest, 146, 2);
  assert.deepEqual(forecast.slice(-3).map((p) => [p.month, p.actual, p.forecast, p.withPlan]), [['2026-04', 152, 152, 6], ['2026-05', null, 164, 18], ['2026-06', null, 176, 30]]);
  const bySeverity = severityForecast(latest, cost, 3);
  assert.equal(bySeverity.length, 4 + 3);
  assert.ok(bySeverity.at(-1).CriticalF >= 0);
  const weekly = weeklyTrend(totalRows, fixedRows, 52);
  assert.deepEqual(weekly.at(-1), { date: '2026-04-04', backlog: 152, fixed: 6, fixRate: (6 / 152) * 100, debtRate: (12 / 140) * 100 });
});

test('Fusion: each project rounded up to whole 10K units on its own, credits per 10K LOC per scan', () => {
  assert.equal(unitsOf(12000), 2);
  assert.equal(unitsOf(18000), 2);
  assert.equal(unitsOf(10000), 1);
  assert.equal(unitsOf(0), 0);
  // The user's example: 12,000 + 18,000 lines are 2 + 2 = 4 units, not the 3 that 30,000 would make.
  const est = fusionEstimate(
    [
      { id: 'a', name: 'A', loc: 12000 },
      { id: 'b', name: 'B', loc: 18000 },
    ],
    { defaultScans: 1, models: [{ id: 'opus', name: 'Opus-4.7', creditsPer10k: 2.5 }] },
  );
  assert.equal(est.totals.units, 4);
  assert.equal(est.totals.credits, 10, '4 units × 1 scan × 2.5');
  // A model with no rate: scans and units counted, credits not.
  const unknown = fusionEstimate([{ id: 'a', loc: 25000 }], { models: [{ id: 'm', name: 'New model', creditsPer10k: null }] });
  assert.equal(unknown.totals.units, 3);
  assert.equal(unknown.totals.credits, 0);
  assert.equal(unknown.totals.unknownRate, 1);
});

test('Fusion: scans from the default, scan frequency, criticality and the project, most-scanned first', () => {
  assert.equal(frequencyOf(400, 365).id, 'more-5-week');
  assert.equal(frequencyOf(100, 365).id, '1-5-week');
  assert.equal(frequencyOf(26, 365).id, '2-weeks');
  assert.equal(frequencyOf(12, 365).id, 'month');
  assert.equal(frequencyOf(6, 365).id, '2-months');
  assert.equal(frequencyOf(4, 365).id, '3-months');
  assert.equal(frequencyOf(2, 365).id, '6-months');
  assert.equal(frequencyOf(1, 365).id, 'year');
  assert.equal(frequencyOf(0, 365).id, 'rare');
  assert.equal(frequencyOf(6, 30).id, '1-5-week', 'a new project counts over its own life');
  assert.equal(suggestedScans('more-5-week', 12), 52);
  assert.equal(suggestedScans('month', 6), 3);
  assert.equal(suggestedScans('rare', 3), 1);

  const settings = fusionSettings({
    defaultScans: 2,
    models: [{ id: 'opus', name: 'Opus-4.7', creditsPer10k: 2.5 }, { id: 'haiku', name: 'Haiku-4.5', creditsPer10k: 1.5 }],
    defaultModel: 'haiku',
    byFrequency: { 'more-5-week': { scans: 52, model: 'opus' }, month: { scans: 3 } },
    byCriticality: { 5: { scans: 12 }, 3: { scans: 6, model: 'opus' } },
  });
  assert.deepEqual(allocate({ frequency: 'more-5-week', criticality: 5 }, settings), { scans: 52, from: 'frequency', model: 'opus' }, 'the higher');
  assert.deepEqual(allocate({ frequency: 'month', criticality: 5 }, settings), { scans: 12, from: 'criticality', model: 'haiku' });
  assert.deepEqual(allocate({ frequency: 'year', criticality: 1 }, settings), { scans: 2, from: 'default', model: 'haiku' });
  assert.deepEqual(allocate({ frequency: 'month', criticality: 3 }, { ...settings, combine: 'frequency' }), { scans: 3, from: 'frequency', model: 'opus' });
  assert.deepEqual(allocate({ frequency: 'month', criticality: 3, scansOverride: 9, modelOverride: 'haiku' }, settings), { scans: 9, from: 'project', model: 'haiku' });

  const est = fusionEstimate(
    [
      { id: 'slow', name: 'Slow', loc: 5000, frequency: 'year', criticality: 1 },
      { id: 'busy', name: 'Busy', loc: 12000, frequency: 'more-5-week', scansPerWeek: 9, criticality: 4 },
      { id: 'off', name: 'Off', loc: 90000, frequency: 'month', included: false },
    ],
    settings,
  );
  assert.deepEqual(est.rows.map((r) => r.id), ['busy', 'off', 'slow'], 'most often scanned first');
  assert.equal(est.rows[0].credits, 2 * 52 * 2.5);
  assert.equal(est.rows[2].credits, 1 * 2 * 1.5);
  assert.equal(est.totals.credits, 260 + 3);
  assert.equal(est.totals.projects, 2, 'a left-out project is not counted');
  assert.equal(est.byModel.find((m) => m.id === 'opus').credits, 260);
  assert.equal(est.byFrequency.find((f) => f.id === 'month').projects, 1);
});

test('credits required: both parts, an extra % on top, and whole bundles of credits', () => {
  const sum = creditSummary(24000, 700.5, { extraPercent: 10 });
  assert.equal(sum.base, 24700.5);
  assert.equal(sum.extra, 2470.05);
  assert.equal(sum.total, 27170.55);
  assert.equal(sum.bundles, 3, '27,170.55 credits ÷ 10,000 = 2.72, rounded up to 3 bundles');
  assert.equal(creditSummary(20000, null, {}).bundles, 2, 'exactly 2 bundles is not rounded up to 3');
  assert.equal(creditSummary(null, 100, { bundleCredits: 50 }).bundles, 2);
  assert.deepEqual(creditSummary(null, null, {}), { settings: { extraPercent: 0, bundleCredits: 10000 }, tr: null, fusion: null, base: 0, extra: 0, total: 0, exactBundles: 0, bundles: 0 });
  assert.deepEqual(totalsSettings({ extraPercent: '12.345', bundleCredits: '5,000' }), { extraPercent: 12.35, bundleCredits: 5000 });
  assert.deepEqual(totalsSettings({ extraPercent: -5, bundleCredits: 0 }), { extraPercent: 0, bundleCredits: 10000 });
  assert.equal(totalsSettings({ extraPercent: 9000 }).extraPercent, 500);
});

test('customers: saved per field, reopened from disk, and an MZ-01.00.61 profile carried over', () => {
  const dir = tmp('calc-');
  const file = path.join(dir, 'projections.json');
  fs.writeFileSync(file, JSON.stringify({ profiles: [{ id: 'old', name: 'Old one', updatedAt: '2026-10-01T00:00:00Z', alaCarte: { customer: 'Globex', totals, fixed, plan: { High: { selected: 50, fp: 20 } }, assumptions: { triageCredits: 1, remediationCredits: 3 } }, fusion: { bundleLoc: 10000, creditsPerBundle: 2, projects: [{ id: 'm1', name: 'App', locOverride: 12000, source: 'manual' }] } }] }));
  const store = new ProjectionStore({ file });
  const old = store.get('old');
  assert.equal(old.alaCarte, undefined);
  assert.deepEqual(old.tr.totals.bySeverity.High, [100, 110, 120, 130]);
  assert.equal(old.tr.selected.High, 50);
  assert.equal(old.tr.fpPercent.High, 20);
  assert.equal(old.fusion.models[0].creditsPer10k, 2, 'the old credits per bundle become a model');
  assert.equal(old.fusion.projects[0].locOverride, 12000);

  const a = store.create({ name: 'Acme', by: 'sam@acme.io' });
  store.update(a.id, { tr: { totals, fixed, selected: { Critical: 5 }, lookbackMonths: 6 } }, 'kim@acme.io');
  const summary = store.update(a.id, { fusion: { periodMonths: 6, defaultScans: 4, models: [{ id: 'opus', name: 'Opus-4.7', creditsPer10k: 2.5 }], projects: [{ id: 'p1', name: 'One', loc: 12000, frequency: 'month', criticality: 4, source: 'sast-metadata' }] } }, 'kim@acme.io');
  assert.equal(summary.hasTr, true);
  assert.equal(summary.fusionProjects, 1);
  assert.deepEqual(store.get(a.id).totals, { extraPercent: 0, bundleCredits: 10000 });
  store.update(a.id, { totals: { extraPercent: '15', bundleCredits: 'lots' } }, 'kim@acme.io');
  assert.deepEqual(new ProjectionStore({ file }).get(a.id).totals, { extraPercent: 15, bundleCredits: 10000 });
  const again = new ProjectionStore({ file });
  const reopened = again.get(a.id);
  assert.equal(reopened.tr.lookbackMonths, 6);
  assert.equal(reopened.fusion.defaultModel, 'opus');
  assert.equal(reopened.fusion.projects[0].frequency, 'month');
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  assert.throws(() => again.update(a.id, { tr: { totals: { weeks: Array(2000).fill('2026-01-05'), bySeverity: Object.fromEntries(['Critical', 'High', 'Medium', 'Low', 'Info'].map((s) => [s, Array(2000).fill(123456789.123)])) }, fixed: { weeks: Array(2000).fill('2026-01-05'), bySeverity: Object.fromEntries(['Critical', 'High', 'Medium', 'Low', 'Info'].map((s) => [s, Array(2000).fill(123456789.123)])) } }, fusion: { projects: Array.from({ length: 5000 }, (_, i) => ({ id: `p${i}-${'i'.repeat(90)}`, name: 'x'.repeat(200), scanId: 's'.repeat(100) })) } }), (e) => e.status === 413);
  assert.ok(MAX_PROFILE_BYTES > 1e6);
  again.remove(a.id);
  assert.throws(() => again.get(a.id), (e) => e.status === 404);
});

test('what is kept of what the page sends: numbers, dates, known choices and short text', () => {
  const t = cleanTr({ totals: { weeks: ['2026-01-03', '<b>'], bySeverity: { Critical: ['7', 'x'], Bogus: [1] } }, selected: { High: -3 }, fpPercent: { High: 250 }, lookbackMonths: 7, script: 'x' });
  assert.deepEqual(t.totals.weeks, ['2026-01-03', '']);
  assert.deepEqual(t.totals.bySeverity.Critical, [7, 0]);
  assert.equal('Bogus' in t.totals.bySeverity, false);
  assert.equal(t.selected.High, 0);
  assert.equal(t.fpPercent.High, 100);
  assert.equal(t.lookbackMonths, 3);
  assert.equal('script' in t, false);
  const f = cleanFusion({ periodMonths: 999, combine: 'evil', models: [{ id: 'm', name: '<img>', creditsPer10k: '2.5' }], byFrequency: { month: { scans: '4', model: 'nope' } }, projects: [{ name: 'Typed', locOverride: '12,000', frequency: 'hourly', criticality: 9, modelOverride: 'nope' }] });
  assert.equal(f.periodMonths, 60);
  assert.equal(f.combine, 'higher');
  assert.equal(f.models[0].creditsPer10k, 2.5);
  assert.deepEqual(f.byFrequency.month, { scans: 4, model: null });
  assert.equal(f.projects[0].frequency, 'rare');
  assert.equal(f.projects[0].criticality, null);
  assert.equal(f.projects[0].modelOverride, null);
  assert.match(f.projects[0].id, /^manual-/);
  const r = cleanReportData({ a: { b: [1, '2', null, () => 1, NaN] }, __proto__: { polluted: true }, ['x'.repeat(200)]: 'long' });
  assert.deepEqual(r.a.b, [1, '2', null, null, null]);
  assert.equal(({}).polluted, undefined);
  assert.ok(Object.keys(r).every((k) => k.length <= 80));
});

test('reports: kept one file each, listed newest first, per customer, the oldest past the limit dropped', async () => {
  const dir = path.join(tmp('reports-'), 'projection-reports');
  const store = new ReportStore({ dir });
  const first = store.add({ customerId: 'c1', customer: 'Acme', by: 'sam@acme.io', data: { tr: { totals: { credits: 120.5 } }, fusion: { totals: { credits: 30 } } } });
  await new Promise((r) => setTimeout(r, 5));
  const second = store.add({ customerId: 'c2', customer: 'Globex', by: 'sam@acme.io', data: { fusion: { totals: { credits: 7 } } } });
  assert.equal(first.totalCredits, 150.5);
  assert.equal(second.trCredits, null);
  assert.deepEqual(store.list().map((r) => r.id), [second.id, first.id]);
  assert.deepEqual(store.list('c1').map((r) => r.id), [first.id]);
  assert.equal(store.get(first.id).data.tr.totals.credits, 120.5);
  assert.equal('data' in store.list()[0], false, 'the list is without the figures');
  assert.throws(() => store.get('../../etc/passwd'), (e) => e.status === 404);
  store.remove(first.id);
  assert.throws(() => store.get(first.id), (e) => e.status === 404);
  assert.ok(STATE_DIRS.includes('projection-reports'), 'reports are in every backup');
});

test('the report file: named after the customer and the time, everything escaped, nothing loaded from elsewhere', () => {
  assert.equal(reportFileName('Acme Corp / EU', new Date(2026, 9, 9, 14, 5)), 'Acme_Corp_EU_Cx-credits-projection_2026-10-09_1405.html');
  assert.equal(reportFileName('', new Date(2026, 0, 2, 3, 4)), 'Customer_Cx-credits-projection_2026-01-02_0304.html');
  const { totalRows, fixedRows } = seriesRows(totals, fixed);
  const analysis = analyse(totalRows, fixedRows, 3);
  const cost = trCost(analysis, { selected: { Critical: 4 } });
  const est = fusionEstimate([{ id: 'x', name: '<script>alert(1)</script>', loc: 12000, frequency: 'month' }], { models: [{ id: 'm', name: 'Opus-4.7', creditsPer10k: 2.5 }], defaultScans: 2 });
  const html = buildReport({
    organisation: 'Checkmarx <Partner>',
    customer: 'Acme "Corp"',
    preparedBy: 'Sam',
    generatedAt: '2026-10-09T10:00:00Z',
    tr: { asOf: analysis.latestDate, previousDate: analysis.previousDate, lookbackMonths: 3, rows: cost.rows, totals: cost.totals, analysis: { ...analysis.perSeverity, total: analysis.total }, monthlyChange: analysis.monthlyChange, history: analysis.history, weekly: weeklyTrend(totalRows, fixedRows), forecast: backlogForecast(analysis, 4), severityForecast: severityForecast(analysis, cost) },
    fusion: { periodMonths: 12, defaultScans: 2, defaultModel: 'm', models: est.settings.models, rules: est.settings.byFrequency, byFrequency: est.byFrequency, byModel: est.byModel, totals: est.totals, remainingCredits: 29467, rows: est.rows },
  });
  assert.doesNotMatch(html, /<script/i, 'no script in the file, the project name included');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Checkmarx &lt;Partner&gt;/);
  assert.match(html, /Acme &quot;Corp&quot;/);
  assert.match(html, /29,467/);
  assert.match(html, /Opus-4\.7/);
  assert.doesNotMatch(html, /(src|href)="https?:/, 'nothing loaded from another site');
  assert.match(html, /<svg/);
});

test('the report file: in the page\'s language, with a light and a dark theme, and long names kept inside their tables', () => {
  const long = 'a-very-long-project-name-without-any-spaces-that-would-push-a-table-out-of-its-box-'.repeat(3);
  const est = fusionEstimate([{ id: 'x', name: long, loc: 120000, frequency: 'month' }], { models: [{ id: 'm', name: 'Opus-4.7', creditsPer10k: 2.5 }], defaultScans: 2 });
  const data = { organisation: 'Acme', customer: long, generatedAt: '2026-10-09T10:00:00Z', fusion: { periodMonths: 12, defaultScans: 2, defaultModel: 'm', models: est.settings.models, rules: est.settings.byFrequency, byFrequency: est.byFrequency, byModel: est.byModel, totals: est.totals, remainingCredits: null, rows: est.rows } };
  const french = new Map([['Projects', 'Projets'], ['Fusion scans over {0} months.', 'Analyses Fusion sur {0} mois.'], ['Theme', 'Thème'], ['Dark', 'Sombre']]);
  const asked = [];
  const html = buildReport(data, { t: (text) => (asked.push(text), french.get(text) ?? text), lang: 'fr' });
  assert.match(html, /<html lang="fr" dir="ltr">/);
  assert.match(html, /<th>Projets<\/th>/);
  assert.match(html, /Analyses Fusion sur 12 mois\./, 'the figures go into the translated wording');
  assert.match(html, /<legend>Thème<\/legend>/);
  assert.ok(asked.includes('{0}: credits projection'), 'every line is asked of the translator');
  // Themes: Auto follows the system, Light and Dark are chosen with CSS alone (no script in the file).
  assert.match(html, /id="theme-auto" checked/);
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /:root:has\(#theme-dark:checked\)/);
  assert.doesNotMatch(html, /<script/i);
  // Every table scrolls inside its own box, and names wrap.
  assert.equal((html.match(/<table/g) ?? []).length, (html.match(/<div class="scroll"><table/g) ?? []).length);
  assert.match(html, /<td class="name">a-very-long/);
  assert.match(html, /td\.name\{[^}]*overflow-wrap:anywhere/);
  assert.match(buildReport(data, { lang: 'ar', dir: 'rtl' }), /<html lang="ar" dir="rtl">/);
});

test('reading Fusion data from Checkmarx One: lines, criticality, scans in a year; models and credits when the tenant says them', async () => {
  const now = Date.parse('2026-10-09T00:00:00Z');
  const iso = (days) => new Date(now - days * 86400000).toISOString();
  const history = {
    p1: Array.from({ length: 300 }, (_, i) => ({ id: `a${i}`, projectId: 'p1', createdAt: iso(i) })),
    p2: [1, 2, 3, 4].map((d) => ({ id: `b${d}`, projectId: 'p2', createdAt: iso(d) })),
    p3: [],
  };
  const client = {
    async *paginate(url) {
      if (url === '/api/projects') yield* [{ id: 'p1', name: 'Busy', criticality: 5, createdAt: '2020-01-01T00:00:00Z' }, { id: 'p2', name: 'New', criticality: 2, createdAt: '2026-09-25T00:00:00Z' }, { id: 'p3', name: 'Never' }];
    },
    async request(url, { query } = {}) {
      if (url === '/api/scans') {
        // Scans are counted project by project, in pages, with the total Checkmarx One gives.
        assert.equal(query.statuses, 'Completed');
        const all = history[query['project-id']].filter((x) => (!query['from-date'] || x.createdAt >= query['from-date']) && (!query['to-date'] || x.createdAt < query['to-date']));
        return { filteredTotalCount: all.length, scans: all.slice(query.offset ?? 0, (query.offset ?? 0) + query.limit) };
      }
      if (url === '/api/scan-summary') return { scansSummaries: query['scan-ids'].map((scanId) => ({ scanId, sastCounters: { severityCounters: [{ severity: 'HIGH', counter: 2 }] } })) };
      if (url === '/api/projects/last-scan') return { p1: { id: 'a0', updatedAt: '2026-10-08T00:00:00Z' }, p2: { id: 'b1' } };
      if (url === '/api/sast-metadata/a0') return { loc: 12000 };
      if (url === '/api/sast-metadata/b1') throw new Error('404');
      if (url === '/api/scans/b1') return { statusDetails: [{ name: 'sast', loc: 18000 }] };
      throw new Error(`unexpected ${url}`);
    },
  };
  const rows = await readFusionProjects(client, { now });
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual([byId.p1.loc, byId.p1.source, byId.p1.criticality, byId.p1.scanCount, byId.p1.frequency], [12000, 'sast-metadata', 5, 300, 'more-5-week']);
  assert.deepEqual([byId.p2.loc, byId.p2.source, byId.p2.frequency], [18000, 'scan', '1-5-week'], '4 scans in its 14 days');
  assert.deepEqual([byId.p3.loc, byId.p3.frequency, byId.p3.criticality], [null, 'rare', null]);

  const none = await readFusionOffer({ request: async () => { throw new Error('404'); } });
  assert.deepEqual(none, { models: [], remainingCredits: null }, 'nothing said: nothing made up');
  const said = await readFusionOffer({
    request: async (url) => {
      if (url === '/api/fusion/models') return { models: [{ name: 'Opus-4.7', description: 'Advanced reasoning', creditsPer10kLoc: 2.5 }, { displayName: 'Haiku-4.5', cost: 1.5 }] };
      if (url === '/api/fusion/credits') return { remainingCredits: 29467 };
      throw new Error('404');
    },
  });
  assert.deepEqual(said.models.map((m) => [m.name, m.creditsPer10k, m.source]), [['Opus-4.7', 2.5, 'tenant'], ['Haiku-4.5', 1.5, 'tenant']]);
  assert.equal(said.remainingCredits, 29467);
});

test('a scan summary counts every engine by severity, and what is new', () => {
  const c = countersOf({
    scanId: 's',
    sastCounters: { severityCounters: [{ severity: 'HIGH', counter: 4 }, { severity: 'LOW', counter: 10 }], severityStatusCounters: [{ severity: 'HIGH', status: 'NEW', counter: 1 }, { severity: 'LOW', status: 'RECURRENT', counter: 9 }] },
    kicsCounters: { severityCounters: [{ severity: 'MEDIUM', counter: 3 }, { severity: 'CRITICAL', counter: 1 }] },
    scaCounters: null,
    totalCounter: 18,
  });
  assert.deepEqual(c.total, { Critical: 1, High: 4, Medium: 3, Low: 10, Info: 0 });
  assert.deepEqual(c.fresh, { Critical: 0, High: 1, Medium: 0, Low: 0, Info: 0 });
});

test('the backlog and fixes week by week come from each project\'s scans, as the two exports have them', () => {
  const now = Date.parse('2026-10-09T00:00:00Z');
  const at = (days) => new Date(now - days * 86400000).toISOString();
  const sum = (high, fresh = 0) => ({ total: { Critical: 0, High: high, Medium: 0, Low: 0, Info: 0 }, fresh: { Critical: 0, High: fresh, Medium: 0, Low: 0, Info: 0 } });
  const summaries = new Map([
    ['old', sum(10)],
    ['w2', sum(8, 1)],
    ['w1', sum(5)],
    ['q', sum(7)],
  ]);
  const perProject = [
    { before: { id: 'old', createdAt: at(400) }, scans: [{ id: 'w1', createdAt: at(1) }, { id: 'w2', createdAt: at(9) }] },
    { before: null, scans: [{ id: 'q', createdAt: at(3) }] },
  ];
  const w = weeklyBacklog(perProject, summaries, { now, weeks: 3 });
  assert.deepEqual(w.totals.weeks, ['2026-09-25', '2026-10-02', '2026-10-09']);
  assert.deepEqual(w.totals.bySeverity.High, [10, 8, 12], 'the scan before the window counts until the next one; a new project from its first scan');
  assert.deepEqual(w.fixed.bySeverity.High, [0, 3, 3], '10 + 1 new - 8, then 8 - 5');
  assert.equal(w.scans, 4);
});

test('one read of the tenant gives both tabs: the Fusion projects and the weekly backlog', async () => {
  const now = Date.parse('2026-10-09T00:00:00Z');
  const scans = { p1: [{ id: 's2', createdAt: new Date(now - 2 * 86400000).toISOString() }, { id: 's1', createdAt: new Date(now - 20 * 86400000).toISOString() }] };
  const steps = [];
  const client = {
    async *paginate(url) {
      if (url === '/api/projects') yield { id: 'p1', name: 'One', createdAt: '2020-01-01T00:00:00Z' };
    },
    async request(url, { query } = {}) {
      if (url === '/api/scans') return query['to-date'] ? { scans: [] } : { filteredTotalCount: 2, scans: scans.p1 };
      if (url === '/api/scan-summary') return { scansSummaries: query['scan-ids'].map((scanId) => ({ scanId, sastCounters: { severityCounters: [{ severity: 'MEDIUM', counter: scanId === 's1' ? 9 : 6 }] } })) };
      if (url === '/api/projects/last-scan') return { p1: { id: 's2' } };
      if (url === '/api/sast-metadata/s2') return { loc: 25000 };
      throw new Error(`unexpected ${url}`);
    },
  };
  const out = await readTenant(client, { now, weeks: 4, onProgress: (step, done, total) => steps.push(`${step} ${done}/${total}`) });
  assert.equal(out.projects[0].scanCount, 2);
  assert.equal(out.projects[0].loc, 25000);
  assert.deepEqual(out.tr.totals.bySeverity.Medium, [0, 9, 9, 6]);
  assert.deepEqual(out.tr.fixed.bySeverity.Medium, [0, 0, 0, 3]);
  assert.equal(out.tr.totals.meta.source, 'cxone');
  assert.deepEqual([out.tr.totals.meta.projects, out.tr.totals.meta.scans], [1, 2]);
  assert.deepEqual(steps, ['projects 0/1', 'projects 1/1', 'summaries 0/2', 'summaries 2/2']);
  // What is saved keeps where it came from.
  const saved = cleanTr({ totals: out.tr.totals, fixed: out.tr.fixed });
  assert.equal(saved.totals.meta.source, 'cxone');
  assert.equal(saved.totals.meta.scans, 2);
  assert.equal(cleanTr({ totals: { weeks: ['2026-01-01'], bySeverity: {}, meta: { fileName: 'x.xlsx' } } }).totals.meta.source, 'upload');
});

test('a new Fusion projection starts from the scans each frequency runs today; a saved one keeps its own', () => {
  const fresh = fusionSettings({ periodMonths: 6 });
  assert.equal(fresh.byFrequency['more-5-week'].scans, 26);
  assert.equal(fresh.byFrequency.rare.scans, 1);
  const kept = fusionSettings({ byFrequency: { month: { scans: 3 } } });
  assert.equal(kept.byFrequency.month.scans, 3);
  assert.equal(kept.byFrequency['more-5-week'].scans, null);
});

test('the calculator is a permission now: a "calculator" activation code is no longer accepted', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys = [publicKey.export({ format: 'der', type: 'spki' }).toString('base64')];
  const code = (payload) => {
    const head = `MZ1.${Buffer.from(JSON.stringify({ v: 1, id: 'x1', org: 'Acme', issued: '2026-01-01', expires: '2027-01-01T00:00:00Z', ...payload })).toString('base64url')}`;
    return `${head}.${sign(null, Buffer.from(head), privateKey).toString('base64url')}`;
  };
  const now = Date.parse('2026-10-09T00:00:00Z');
  assert.equal(checkCode(code({ scope: 'calculator', action: 'activate' }), { keys, now }).valid, false);
  assert.equal(checkCode(code({ scope: 'lang:he', action: 'activate' }), { keys, now }).valid, true, 'Hebrew codes still are');
  // A server that applied one under MZ-01.00.62 starts as before.
  const file = path.join(tmp('act-'), 'activation.json');
  fs.writeFileSync(file, JSON.stringify({ tenants: null, calculator: { org: 'Acme', scope: 'calculator', action: 'activate', expires: '2027-01-01T00:00:00Z' }, history: [] }));
  const store = new ActivationStore({ file });
  assert.equal(store.tenants(), null);
  assert.equal(typeof store.calculator, 'undefined');
});

test('the organisation name: given with the terms, kept when they change, one clean line', () => {
  const dir = tmp('terms-');
  const textFile = path.join(dir, 'TERMS.md');
  fs.writeFileSync(textFile, 'Version 1.0\n\nTerms.');
  const terms = new Terms({ file: path.join(dir, 'terms.json'), textFile });
  assert.equal(terms.organisationName(), '');
  terms.acceptForOrganisation({ by: 'admin@acme.io', name: '  Acme\nCorporation  ' });
  assert.equal(terms.organisationName(), 'Acme Corporation');
  fs.writeFileSync(textFile, 'Version 2.0\n\nNew terms.');
  const changed = new Terms({ file: path.join(dir, 'terms.json'), textFile });
  assert.equal(changed.organisation(), null, 'new terms are asked for again');
  assert.equal(changed.organisationName(), 'Acme Corporation', 'the name stays');
  assert.equal(cleanName('x'.repeat(300)).length, 120);
});
