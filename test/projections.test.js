// Cx Credits Calculator: the arithmetic (triage & remediation, and Fusion scans rounded up per
// project), the saved customers and reports, what is kept of what the page sends, the report
// file, the activation scope and the organisation name.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';

import { allocate, analyse, backlogForecast, frequencyOf, fusionEstimate, fusionSettings, seriesRows, severityForecast, suggestedScans, trCost, unitsOf, weeklyTrend } from '../public/calculator/model.js';
import { buildReport, reportFileName } from '../public/calculator/report.js';
import { MAX_PROFILE_BYTES, ProjectionStore, ReportStore, cleanFusion, cleanReportData, cleanTr, readFusionOffer, readFusionProjects } from '../src/projections.js';
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

test('reading Fusion data from Checkmarx One: lines, criticality, scans in a year; models and credits when the tenant says them', async () => {
  const now = Date.parse('2026-10-09T00:00:00Z');
  const client = {
    async *paginate(url, { query } = {}) {
      if (url === '/api/projects') yield* [{ id: 'p1', name: 'Busy', criticality: 5, createdAt: '2020-01-01T00:00:00Z' }, { id: 'p2', name: 'New', criticality: 2, createdAt: '2026-09-25T00:00:00Z' }, { id: 'p3', name: 'Never' }];
      if (url === '/api/scans') {
        assert.equal(query.statuses, 'Completed');
        yield* Array.from({ length: 300 }, (_, i) => ({ projectId: 'p1', createdAt: new Date(now - i * 86400000).toISOString() }));
        yield* [1, 2, 3, 4].map((d) => ({ projectId: 'p2', createdAt: new Date(now - d * 86400000).toISOString() }));
      }
    },
    async request(url) {
      if (url === '/api/projects/last-scan') return { p1: { id: 's1', updatedAt: '2026-10-08T00:00:00Z' }, p2: { id: 's2' } };
      if (url === '/api/sast-metadata/s1') return { loc: 12000 };
      if (url === '/api/sast-metadata/s2') throw new Error('404');
      if (url === '/api/scans/s2') return { statusDetails: [{ name: 'sast', loc: 18000 }] };
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

test('the calculator activation code: on and off, recorded, and only for its scope', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keys = [publicKey.export({ format: 'der', type: 'spki' }).toString('base64')];
  const code = (payload) => {
    const head = `MZ1.${Buffer.from(JSON.stringify({ v: 1, id: 'x1', org: 'Acme', issued: '2026-01-01', expires: '2027-01-01T00:00:00Z', ...payload })).toString('base64url')}`;
    return `${head}.${sign(null, Buffer.from(head), privateKey).toString('base64url')}`;
  };
  const now = Date.parse('2026-10-09T00:00:00Z');
  const on = checkCode(code({ scope: 'calculator', action: 'activate' }), { keys, now });
  assert.equal(on.valid, true);
  assert.equal(on.scope, 'calculator');
  assert.equal(checkCode(code({ scope: 'calculator' }), { keys, now }).valid, false, 'needs on or off');
  const store = new ActivationStore({ file: path.join(tmp('act-'), 'activation.json') });
  assert.equal(store.calculator(now), null);
  store.record(on, 'admin@acme.io');
  assert.equal(store.calculator(now).org, 'Acme');
  assert.equal(store.calculator(Date.parse('2027-02-01')), null, 'off once it expires');
  store.record(checkCode(code({ scope: 'calculator', action: 'deactivate' }), { keys, now }), 'admin@acme.io');
  assert.equal(store.calculator(now), null);
  assert.equal(store.tenants(), null, 'other add-ons untouched');
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
