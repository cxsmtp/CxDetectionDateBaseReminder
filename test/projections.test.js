// Cx Credits Calculator: the arithmetic (triage & remediation, and Fusion scans rounded up per
// project), the saved customers and reports, what is kept of what the page sends, the report
// file, the activation scope and the organisation name.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';

import { aheadMonths, aheadSettings, allocate, analyse, backlogForecast, cleanScope, creditSummary, frequencyOf, fusionEstimate, fusionSettings, globMatch, inScope, planForecast, resolveSelected, scopeActive, seriesRows, severityForecast, severityPlan, suggestedScans, totalsSettings, trCost, trProjection, unitsOf, weeklyTrend, SEVERITIES } from '../public/calculator/model.js';
import { buildReport, reportFileName } from '../public/calculator/report.js';
import { MAX_PROFILE_BYTES, ProjectionStore, ReportStore, TenantReadStore, cleanFusion, cleanReportData, cleanTr, countersOf, readFusionOffer, readFusionProjects, readTenant, seriesFor, weeklyBacklog } from '../src/projections.js';
import { ActivationStore, checkCode } from '../src/activation.js';
import { Terms, cleanName } from '../src/terms.js';
import { STATE_DIRS } from '../src/data-dir.js';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const totals = { weeks: ['2026-01-03', '2026-02-07', '2026-03-07', '2026-04-04'], bySeverity: { Critical: [10, 12, 14, 16], High: [100, 110, 120, 130], Medium: [5, 5, 5, 5], Low: [1, 1, 1, 1] } };
const fixed = { weeks: ['2026-03-07', '2026-04-04'], bySeverity: { Critical: [1, 2], High: [3, 4] } };

test('triage & remediation: backlog, debt growth, fix rate, credits and forecasts', () => {
  const { totalRows, fixedRows } = seriesRows(totals, fixed);
  const latest = analyse(totalRows, fixedRows, 0);
  const { arrivals, fixedMonthly, netMonthly, addedPct, fixedPct, ...critical } = latest.perSeverity.Critical;
  assert.deepEqual(critical, { current: 16, prior: 14, fixed: 2, debtRate: (2 / 14) * 100, fixRate: 12.5 });
  assert.ok(Math.abs(arrivals - 4 / (28 / 30.44)) < 1e-9, 'new a month: grew by 2 and 2 were fixed, over 28 days');
  // Debt added against fixes, a month, on one footing: both as a share of today's backlog.
  assert.ok(Math.abs(fixedMonthly - 2 / (28 / 30.44)) < 1e-9);
  assert.ok(Math.abs(netMonthly - 2 / (28 / 30.44)) < 1e-9, 'added 4, fixed 2: grows by 2 over the 28 days');
  assert.ok(Math.abs(addedPct - (arrivals / 16) * 100) < 1e-9 && Math.abs(fixedPct - (fixedMonthly / 16) * 100) < 1e-9);
  assert.ok(Math.abs(latest.total.netMonthly - (latest.total.arrivals - latest.total.fixedMonthly)) < 1e-9);
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
  const { fixRate4, debtRate4, addedRate4, fixedRate4, ...week } = weekly.at(-1);
  assert.deepEqual(week, { date: '2026-04-04', backlog: 152, fixed: 6, fixRate: (6 / 152) * 100, debtRate: (12 / 140) * 100, added: 18, addedRate: (18 / 140) * 100, fixedRate: (6 / 140) * 100 });
  assert.ok([fixRate4, debtRate4, addedRate4, fixedRate4].every(Number.isFinite), 'and over the last 4 weeks');
  assert.equal(weekly[0].added, null, 'the first week has nothing before it');
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
  // The impact's assumptions: a new customer starts from the organisation's, and keeps its own once changed.
  const b = store.create({ name: 'Initech', by: 'sam@acme.io', impact: { triageMinutes: 30, hourlyRate: 95, currency: 'gbp' } });
  assert.deepEqual(store.get(b.id).impact, { triageMinutes: 30, fixMinutes: 120, reviewMinutes: 15, hourlyRate: 95, creditPrice: 0, currency: 'GBP', linesPerHour: 200, reviewers: 3, laterFixMultiplier: 5, breachChancePercent: 0.5, breachCost: 4880000, countBreach: false });
  store.update(b.id, { impact: { ...store.get(b.id).impact, creditPrice: 1.5, reviewMinutes: 'x' } }, 'kim@acme.io');
  assert.equal(store.get(b.id).impact.creditPrice, 1.5);
  assert.equal(store.get(b.id).impact.reviewMinutes, 15, 'what cannot be read takes the default');
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
  assert.equal((html.match(/<table(?! class="calc")/g) ?? []).length, (html.match(/<div class="scroll"><table/g) ?? []).length, 'the two-column sums are narrow; every other table scrolls');
  assert.match(html, /<td class="name">a-very-long/);
  assert.match(html, /td\.name\{[^}]*overflow-wrap:anywhere/);
  assert.match(buildReport(data, { lang: 'ar', dir: 'rtl' }), /<html lang="ar" dir="rtl">/);
  // In the app's look: command center with its accent, the reader's theme picked; the classic look unchanged.
  assert.doesNotMatch(html, /--ng-mono/, 'classic unless asked');
  const next = buildReport(data, { look: { ui: 'nextgen', theme: 'dark', accent: 'violet' } });
  assert.match(next, /--ng-mono/);
  assert.match(next, /#6c4265/, 'the plum (violet) accent');
  assert.match(next, /id="theme-dark" checked/);
  assert.doesNotMatch(next, /id="theme-auto" checked/);
  assert.doesNotMatch(next, /<script/i, 'still no scripts');
  const odd = buildReport(data, { look: { ui: 'nextgen', theme: '"><b>', accent: 'nope' } });
  assert.match(odd, /id="theme-auto" checked/, 'an unknown theme: Auto');
  assert.match(odd, /#34507a/, 'an unknown accent: ink (indigo)');
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

test('what is ahead: findings still to come at the trend, more from Fusion, fewer false positives with FAE', () => {
  const { totalRows, fixedRows } = seriesRows(totals, fixed);
  const quarter = analyse(totalRows, fixedRows, 3);
  // High grew 100 → 130 in 91 days with 7 fixed: 37 new findings over 2.99 months.
  const months = 91 / 30.44;
  assert.ok(Math.abs(quarter.perSeverity.High.arrivals - 37 / months) < 1e-9);
  assert.equal(quarter.perSeverity.Medium.arrivals, 0, 'flat and nothing fixed: nothing new');

  // Not chosen: every open finding. Nothing ahead counted: the backlog alone, as before.
  assert.deepEqual(resolveSelected(quarter, {}), { Critical: 16, High: 130, Medium: 5, Low: 1 });
  assert.deepEqual(resolveSelected(quarter, { High: 999, Low: 0 }), { Critical: 16, High: 130, Medium: 5, Low: 0 });
  const backlogOnly = trProjection(quarter, { includeFuture: false }, { months: 12 });
  assert.equal(backlogOnly.totals.toTriage, 152);
  assert.equal(backlogOnly.totals.aheadCredits, 0);
  assert.ok(Math.abs(backlogOnly.totals.credits - trCost(quarter, { selected: { Critical: 16, High: 130, Medium: 5, Low: 1 } }).totals.credits) < 1e-9, 'the same credits as the backlog plan');

  // 12 months ahead, Fusion in the projection: +5% of (backlog + still to come), FAE takes 10% of the new ones (30% are false positives).
  // New findings fall 2% a month as AI is adopted: the first month at today's pace, then 0.98, 0.98², …
  assert.equal(aheadMonths(12, 0), 12);
  assert.ok(Math.abs(aheadMonths(12, 2) - (1 - 0.98 ** 12) / 0.02) < 1e-9);
  assert.ok(Math.abs(aheadMonths(3, 2) - (1 + 0.98 + 0.98 ** 2)) < 1e-9);
  const p = trProjection(quarter, {}, { months: 12, fusion: true });
  const high = p.rows.High;
  const future = (37 / months) * aheadMonths(12, 2);
  assert.ok(Math.abs(high.future - future) < 1e-9);
  assert.ok(Math.abs(p.paced - aheadMonths(12, 2)) < 1e-9);
  assert.ok(Math.abs(trProjection(quarter, { aiDeclinePercent: 0 }, { months: 12 }).rows.High.future - (37 / months) * 12) < 1e-9, 'at 0%: today\'s pace every month');
  assert.ok(Math.abs(high.fusionExtra - (130 + future) * 0.05) < 1e-9);
  assert.ok(Math.abs(high.faeAvoided - (future + high.fusionExtra) * 0.1) < 1e-9);
  assert.ok(Math.abs(high.toTriage - (130 + future + high.fusionExtra - high.faeAvoided)) < 1e-9);
  assert.ok(Math.abs(high.truePositives - (130 + future + high.fusionExtra) * 0.7) < 1e-9, 'FAE removes false positives only');
  assert.ok(Math.abs(high.credits - (high.toTriage * 1 + high.truePositives * 3)) < 1e-9);
  assert.ok(Math.abs(p.totals.backlogCredits + p.totals.aheadCredits - p.totals.credits) < 1e-9);
  // FAE never takes more than the false positives: at 0% false positives it takes none.
  const clean = trProjection(quarter, { fpPercent: { High: 0 }, faePercent: 50 }, { months: 12, fusion: true });
  assert.equal(clean.rows.High.faeAvoided, 0);
  // Without Fusion, nothing more found by it.
  assert.equal(trProjection(quarter, {}, { months: 12 }).totals.fusionExtra, 0);

  // The forecast: as it goes (the trend's net change each month), and with the plan (worked down to what is left).
  const lines = planForecast(quarter, p);
  assert.equal(lines.length, quarter.history.length + 12);
  assert.equal(lines.at(-1).withPlan, 0, 'every open finding triaged, new ones as they come');
  assert.ok(lines.at(-1).asIs > lines[quarter.history.length - 1].actual, 'a growing backlog keeps growing');
  const minis = severityPlan(quarter, p);
  assert.deepEqual(Object.keys(minis), ['Critical', 'High', 'Medium', 'Low']);
  assert.equal(minis.High.at(-1).withPlan, 0);
  // Only part of the backlog chosen: new findings in the same share per severity, and what is
  // not chosen keeps its own trend in the forecast.
  const half = trProjection(quarter, { selected: { High: 65, Critical: 0 } }, { months: 12 });
  assert.ok(Math.abs(half.rows.High.future - (37 / months) * aheadMonths(12, 2) * 0.5) < 1e-9, 'half of High chosen: half of its new findings');
  assert.equal(half.rows.Critical.future, 0, 'none chosen: none still to come');
  assert.ok(Math.abs(half.rows.High.arrivals - (37 / months) * 0.5) < 1e-9);
  assert.ok(Math.abs(half.totals.arrivals - (half.rows.High.arrivals + half.rows.Low.arrivals + half.rows.Medium.arrivals)) < 1e-9);
  const halfLines = planForecast(quarter, half);
  const expected = SEVERITIES.reduce((sum, s) => sum + quarter.monthlyChangeBySeverity[s] * (1 - half.rows[s].share), 0);
  const start = halfLines[quarter.history.length - 1].actual;
  assert.ok(Math.abs(halfLines.at(-1).withPlan - Math.max(0, start - half.totals.selected + expected * 12)) < 1e-9, 'the part not chosen keeps growing');
  assert.ok(severityPlan(quarter, half).Critical.at(-1).withPlan >= quarter.perSeverity.Critical.current, 'Critical not chosen: it keeps its trend');
});

test('which projects count: applications, groups, people, names with wildcards, frequency, criticality', () => {
  assert.ok(globMatch('payments-*', 'Payments-API'));
  assert.ok(globMatch('*-api', 'billing-api') && !globMatch('*-api', 'billing-web'));
  assert.ok(globMatch('svc-?', 'svc-1') && !globMatch('svc-?', 'svc-10'));
  assert.ok(globMatch('*', '') && !globMatch('a', ''));
  const slow = Date.now();
  assert.equal(globMatch('*a*a*a*a*a*a*a*a*b', 'a'.repeat(5000)), false);
  assert.ok(Date.now() - slow < 500, 'no pattern makes it slow');
  const project = { name: 'payments-web', applications: ['Payments'], groups: ['team-a'], initiator: 'kim@acme.io', frequency: 'month', criticality: 4 };
  assert.ok(inScope(project, {}), 'nothing chosen: every project');
  assert.ok(inScope(project, { applications: ['payments', 'Mobile'], names: ['web'] }), 'any of an option, all options; a name without wildcards is a part of it');
  assert.ok(!inScope(project, { applications: ['Payments'], criticalities: [5] }));
  assert.ok(inScope(project, { groups: ['TEAM-A'], initiators: ['kim@acme.io'], frequencies: ['month', 'year'] }));
  assert.ok(!inScope(project, { names: ['api-*'] }));
  assert.ok(!inScope({ name: 'x' }, { applications: ['Payments'] }), 'a project in no application is outside an application scope');
  const sc = cleanScope({ applications: ['A', 'A', ' ', 'x'.repeat(300)], names: Array.from({ length: 30 }, (_, i) => `n${i}`), frequencies: ['month', 'hourly'], criticalities: [5, '3', 9], evil: 1 });
  assert.deepEqual(sc.applications, ['A', 'x'.repeat(200)]);
  assert.equal(sc.names.length, 20);
  assert.deepEqual([sc.frequencies, sc.criticalities, 'evil' in sc], [['month'], [5, 3], false]);
  // Applications and projects picked: these applications' projects, plus these projects; the rest narrows further.
  const pa = { id: 'p1', name: 'payments-api', applications: ['Payments'], groups: ['team-a'] };
  const pb = { id: 'p2', name: 'web', applications: ['Web'], groups: ['team-b'] };
  const pc = { id: 'p3', name: 'mobile', applications: [], groups: ['team-a'] };
  const pick = { applications: ['Payments'], projects: ['p3'] };
  assert.deepEqual([pa, pb, pc].filter((p) => inScope(p, pick)).map((p) => p.id), ['p1', 'p3']);
  assert.deepEqual([pa, pb, pc].filter((p) => inScope(p, { projects: ['p2'] })).map((p) => p.id), ['p2']);
  assert.deepEqual([pa, pb, pc].filter((p) => inScope(p, { ...pick, groups: ['team-a'] })).map((p) => p.id), ['p1', 'p3'], 'groups narrow what was picked');
  assert.deepEqual([pa, pb, pc].filter((p) => inScope(p, { ...pick, groups: ['team-b'] })).map((p) => p.id), []);
  assert.equal(cleanScope({ projects: Array.from({ length: 6000 }, (_, i) => `id-${i}`) }).projects.length, 5000);
  assert.equal(scopeActive({ projects: ['p1'] }), true);
  assert.equal(scopeActive({}), false);
  assert.equal(scopeActive({ groups: ['g'] }), true);
});

test('a customer from before: nothing chosen becomes every open finding, and "Latest" becomes 3 months', () => {
  const file = path.join(tmp('calc-old-'), 'projections.json');
  fs.writeFileSync(file, JSON.stringify({ profiles: [
    { id: 'a', name: 'Untouched', tr: { totals, fixed, selected: { Critical: 0, High: 0, Medium: 0, Low: 0 }, lookbackMonths: 0 } },
    { id: 'b', name: 'Chosen', tr: { totals, fixed, selected: { Critical: 4, High: 0, Medium: 0, Low: 0 }, lookbackMonths: 6 } },
    { id: 'c', name: 'On the old Fusion default', planVersion: 2, tr: { totals, fixed, lookbackMonths: 3, fusionUpliftPercent: 20, faePercent: 10 } },
    { id: 'd', name: 'Fusion typed in', planVersion: 2, tr: { totals, fixed, lookbackMonths: 3, fusionUpliftPercent: 12, faePercent: 10 } },
  ] }));
  const store = new ProjectionStore({ file });
  assert.deepEqual(store.get('a').tr.selected, { Critical: null, High: null, Medium: null, Low: null });
  assert.equal(store.get('a').tr.lookbackMonths, 3);
  assert.deepEqual(store.get('b').tr.selected, { Critical: 4, High: 0, Medium: 0, Low: 0 }, 'a plan someone made is kept');
  assert.equal(store.get('b').tr.lookbackMonths, 6);
  // MZ-01.00.69: Fusion's default went from 20% to 5%. A plan on the old default follows; one typed in is kept.
  assert.equal(store.get('c').tr.fusionUpliftPercent, 5);
  assert.equal(store.get('d').tr.fusionUpliftPercent, 12);
  assert.equal(aheadSettings(store.get('a').tr).fusionUpliftPercent, 5, 'and one from before 1.0.67, which had none: the default');
  const fresh = store.create({ name: 'New', by: 'x' });
  assert.deepEqual(fresh.tr.selected, { Critical: null, High: null, Medium: null, Low: null });
  assert.deepEqual([fresh.tr.includeFuture, fresh.tr.fusionUpliftPercent, fresh.tr.faePercent, fresh.tr.aiDeclinePercent], [true, 5, 10, 2]);
  assert.deepEqual(cleanTr({ fusionUpliftPercent: 9999, faePercent: -4, includeFuture: false, aiDeclinePercent: 50 }), { ...cleanTr({}), fusionUpliftPercent: 300, faePercent: 10, includeFuture: false, aiDeclinePercent: 20 }, 'capped, and what is not a number is the default');
});

test('each project\'s weeks are kept on the server, and any set of them added up', () => {
  const now = Date.parse('2026-10-09T00:00:00Z');
  const at = (days) => new Date(now - days * 86400000).toISOString();
  const sum = (high) => ({ total: { Critical: 0, High: high, Medium: 0, Low: 0, Info: 0 }, fresh: { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 } });
  const summaries = new Map([['a1', sum(10)], ['a2', sum(6)], ['b1', sum(3)]]);
  const w = weeklyBacklog([
    { project: { id: 'pa' }, before: null, scans: [{ id: 'a2', createdAt: at(2) }, { id: 'a1', createdAt: at(10) }] },
    { project: { id: 'pb' }, before: null, scans: [{ id: 'b1', createdAt: at(15) }] },
  ], summaries, { now, weeks: 3 });
  assert.deepEqual(w.totals.bySeverity.High, [3, 13, 9]);
  const file = path.join(tmp('read-'), 'projection-read.json');
  new TenantReadStore({ file }).save({ readAt: at(0), weeks: w.totals.weeks, byProject: w.byProject });
  const read = new TenantReadStore({ file }).get();
  assert.deepEqual(seriesFor(read, ['pa']).totals.bySeverity.High, [0, 10, 6]);
  assert.deepEqual(seriesFor(read, ['pa']).fixed.bySeverity.High, [0, 0, 4]);
  assert.deepEqual(seriesFor(read, ['pa', 'pb', 'pa', 'nope']).totals.bySeverity.High, [3, 13, 9], 'every project: the whole');
  assert.deepEqual([seriesFor(read, ['pb']).totals.meta.projects, seriesFor(read, ['pb']).totals.meta.scans], [1, 1]);
  assert.equal(seriesFor(read, ['__proto__']).totals.meta.projects, 0);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
});

test('the report says the answer first, that it comes from live Checkmarx One data, then how, then every figure', () => {
  const { totalRows, fixedRows } = seriesRows(totals, fixed);
  const analysis = analyse(totalRows, fixedRows, 3);
  const projection = trProjection(analysis, {}, { months: 12, fusion: true });
  const est = fusionEstimate([{ id: 'x', name: 'Payments', loc: 25000, frequency: 'month' }], { models: [{ id: 'm', name: 'Opus-4.7', creditsPer10k: 2.5 }], defaultScans: 2 });
  const summary = creditSummary(projection.totals.credits, est.totals.credits, { extraPercent: 10 });
  const data = {
    version: 2, summary, organisation: 'Acme', customer: 'Globex', generatedAt: '2026-10-09T10:00:00Z', months: 12,
    source: { kind: 'cxone', readAt: '2026-10-09T09:00:00Z', projects: 1, allProjects: 4, scans: 77, scoped: true, scope: { applications: ['Payments'] } },
    tr: { asOf: analysis.latestDate, previousDate: analysis.previousDate, lookbackMonths: 3, months: 12, fusion: true, ahead: projection.ahead, rows: projection.rows, totals: projection.totals, analysis: { ...analysis.perSeverity, total: analysis.total }, monthlyChange: analysis.monthlyChange, history: analysis.history, weekly: weeklyTrend(totalRows, fixedRows), forecast: planForecast(analysis, projection), bySeverity: severityPlan(analysis, projection) },
    fusion: { periodMonths: 12, defaultScans: 2, defaultModel: 'm', models: est.settings.models, rules: est.settings.byFrequency, byFrequency: est.byFrequency, byModel: est.byModel, totals: est.totals, remainingCredits: null, rows: est.rows },
  };
  const html = buildReport(data);
  const at = (text) => html.indexOf(text);
  // How each number is calculated: closed at the end, every step with the figures in.
  assert.ok(at('<details><summary><h2>How each number is calculated</h2>') > at('Appendix: every figure'), 'last, and closed');
  assert.match(html, /The trend is measured over the last 3 months; the projection covers the next 12 months\./);
  const T = data.tr.totals;
  const n = (x) => Math.round(x).toLocaleString();
  assert.ok(html.includes(`${n(T.selected)} + ${n(T.future)} + ${n(T.fusionExtra)} − ${n(T.faeAvoided)} = ${n(T.toTriage)}`), 'to triage, worked out');
  assert.ok(html.includes(`÷ 10,000 credits a bundle = ${(data.summary.total / 10000).toLocaleString(undefined, { maximumFractionDigits: 2 })}, rounded up to ${data.summary.bundles} bundles.`));
  assert.ok(at('Total credits required') > 0 && at('Total credits required') < at('Read live from Checkmarx One'), 'the answer first');
  assert.ok(at('Read live from Checkmarx One') < at('How we got there') && at('How we got there') < at('Assumptions') && at('Assumptions') < at('Appendix: every figure'));
  assert.match(html, new RegExp(`<b class="big">${Math.round(summary.total).toLocaleString('en')}</b>`));
  assert.match(html, /77 scans/);
  assert.match(html, /Projects counted: Applications: Payments/);
  assert.match(html, /More found by Fusion \(5%\)/);
  assert.match(html, /Fewer false positives with FAE \(10%\)/);
  assert.match(html, /class="bar"/);
  assert.doesNotMatch(html, /<script/i);
  // A report made before MZ-01.00.67 (backlog only, old forecast) still opens.
  const cost = trCost(analysis, { selected: { Critical: 4 } });
  const old = buildReport({ customer: 'Old', generatedAt: '2026-10-01T00:00:00Z', tr: { asOf: analysis.latestDate, previousDate: analysis.previousDate, lookbackMonths: 3, rows: cost.rows, totals: cost.totals, analysis: { ...analysis.perSeverity, total: analysis.total }, monthlyChange: analysis.monthlyChange, history: analysis.history, weekly: weeklyTrend(totalRows, fixedRows), forecast: backlogForecast(analysis, 4), severityForecast: severityForecast(analysis, cost) } });
  assert.match(old, /Total credits required/);
  assert.match(old, /<svg/);
});

test('the Fusion projects table sorts by any column; what shows as "—" comes last either way', async () => {
  const { sortProjects, PROJECT_SORT_KEYS } = await import('../public/calculator/model.js');
  assert.deepEqual(PROJECT_SORT_KEYS, ['name', 'criticality', 'frequency', 'lines', 'units', 'scans', 'model', 'credits']);
  const rows = [
    { id: 'a', name: 'payments-api', criticality: 3, frequency: 'month', scanCount: 6, lines: 20000, units: 2, scans: 6, model: 'm2', credits: 120, included: true },
    { id: 'b', name: 'Billing', criticality: null, frequency: 'more-5-week', scanCount: 400, lines: null, units: 0, scans: 52, model: 'm1', credits: 0, included: true },
    { id: 'c', name: 'web10', criticality: 5, frequency: 'more-5-week', scanCount: 300, lines: 90000, units: 9, scans: 52, model: 'm1', credits: 468, included: true },
    { id: 'd', name: 'web9', criticality: 1, frequency: 'year', scanCount: 1, lines: 5000, units: 1, scans: 1, model: '', credits: null, included: false },
  ];
  const ids = (key, dir) => sortProjects(rows, { key, dir }, { modelName: (id) => ({ m1: 'Fast', m2: 'Deep' })[id] }).map((r) => r.id);
  assert.deepEqual(ids('name', 'asc'), ['b', 'a', 'd', 'c'], 'A to Z, ignoring case, numbers in names in number order');
  assert.deepEqual(ids('name', 'desc'), ['c', 'd', 'a', 'b']);
  assert.deepEqual(ids('criticality', 'desc'), ['c', 'a', 'd', 'b'], 'no criticality: last');
  assert.deepEqual(ids('criticality', 'asc'), ['d', 'a', 'c', 'b'], 'no criticality: last both ways');
  assert.deepEqual(ids('frequency', 'desc'), ['b', 'c', 'a', 'd'], 'most often first, then most scans in the year');
  assert.deepEqual(ids('lines', 'desc'), ['c', 'a', 'd', 'b']);
  assert.deepEqual(ids('units', 'desc'), ['c', 'a', 'b', 'd'], 'left out or no units: shown as —, last');
  assert.deepEqual(ids('scans', 'asc'), ['d', 'a', 'b', 'c'], 'ties keep their order');
  assert.deepEqual(ids('model', 'asc'), ['a', 'b', 'c', 'd'], 'by the model name; none last');
  assert.deepEqual(ids('credits', 'desc'), ['c', 'a', 'b', 'd']);
  assert.equal(sortProjects(rows, { key: 'nope' }), rows, 'an unknown column: as it was');
});
