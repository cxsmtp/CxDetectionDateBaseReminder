// Cx Credits Calculator, Include scans from: each scan's origin as a readable label, only the scans from the
// origins ticked counted (how often each project is scanned for Fusion; the backlog and trend for triage &
// remediation, each project at its latest scan from them), what is saved with the customer, the report's
// line, and the one Apply for every setting at the top.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { byOrigins, cleanScope, frequencyOf, inScope, originCounts, scopeActive, settingChanges, topSettings } from '../public/calculator/model.js';
import { assumptionItems, buildReport, wording } from '../public/calculator/report.js';
import { cleanFusion, cleanTr, migrate, patchProfile } from '../public/calculator/profiles.js';
import { ORIGIN_NOT_SAID, TenantReadStore, readTenant, scanOrigin, seriesFor, weeklyBacklog } from '../src/projections.js';

const DAY = 86400000;
const now = Date.parse('2026-10-09T00:00:00Z');
const at = (days) => new Date(now - days * DAY).toISOString();
const zero = { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0 };
const sum = (high, fresh = 0, engine = 'SAST') => ({ total: { ...zero, High: high }, fresh: { ...zero, High: fresh }, byEngine: { [engine]: { total: { ...zero, High: high }, fresh: { ...zero, High: fresh } } } });

test('a scan’s origin: the tool Checkmarx One names, as a readable label; else its user agent; else "Not said"', () => {
  const cases = [
    [{ sourceOrigin: 'Jenkins' }, 'Jenkins'],
    [{ sourceOrigin: 'Github Action' }, 'GitHub Actions'],
    [{ sourceOrigin: 'GitHub Actions' }, 'GitHub Actions'],
    [{ sourceOrigin: 'ADO' }, 'Azure DevOps'],
    [{ sourceOrigin: 'Azure Pipelines' }, 'Azure DevOps'],
    [{ sourceOrigin: 'gitlab-ci' }, 'GitLab CI'],
    [{ sourceOrigin: 'TeamCity' }, 'TeamCity'],
    [{ sourceOrigin: 'Bitbucket' }, 'Bitbucket Pipelines'],
    [{ sourceOrigin: 'cx-cli' }, 'CLI'],
    [{ sourceOrigin: 'ASTCLI' }, 'CLI'],
    [{ sourceOrigin: 'Postman' }, 'API'],
    [{ sourceOrigin: 'Webapp' }, 'Web portal (by hand)'],
    [{ sourceOrigin: 'VS Code' }, 'IDE'],
    [{ sourceOrigin: 'GitHub' }, 'GitHub'],
    [{ sourceOrigin: 'Some Other Tool' }, 'Some Other Tool'],
    [{ sourceOrigin: '  ', userAgent: 'ASTCLI/2.3.1 Jenkins/2.4' }, 'Jenkins'],
    [{ userAgent: 'Mozilla/5.0' }, ORIGIN_NOT_SAID],
    [{ sourceType: 'zip' }, ORIGIN_NOT_SAID],
    [{ sourceType: 'github' }, 'GitHub'],
    [{}, 'Not said'],
    [null, 'Not said'],
  ];
  for (const [scan, label] of cases) assert.equal(scanOrigin(scan), label, JSON.stringify(scan));
  assert.equal(scanOrigin({ sourceOrigin: `a\u0000b${'x'.repeat(100)}` }).length, 60, 'a name not known here is kept, cleaned and short');
});

/** Project p1: Jenkins every week, CLI twice; p2: CLI only; p3: Jenkins only, one scan before the window. */
function tenant() {
  const summaries = new Map([
    ['j1', sum(10)], ['j2', sum(9)], ['c1', sum(4, 4)], ['j3', sum(8)], ['c2', sum(2)],
    ['q1', sum(5)],
    ['o1', sum(7)],
  ]);
  const perProject = [
    // Oldest last, as Checkmarx One lists them.
    { project: { id: 'p1' }, before: null, scans: [{ id: 'c2', createdAt: at(1), sourceOrigin: 'cx-cli' }, { id: 'j3', createdAt: at(2), sourceOrigin: 'Jenkins' }, { id: 'c1', createdAt: at(6), sourceOrigin: 'cx-cli' }, { id: 'j2', createdAt: at(9), sourceOrigin: 'Jenkins' }, { id: 'j1', createdAt: at(16), sourceOrigin: 'Jenkins' }] },
    { project: { id: 'p2' }, before: null, scans: [{ id: 'q1', createdAt: at(3), sourceOrigin: 'ASTCLI' }] },
    { project: { id: 'p3' }, before: { id: 'o1', createdAt: at(400), sourceOrigin: 'Jenkins' }, scans: [] },
  ];
  return { summaries, perProject };
}

test('only the scans from the origins ticked count: each project at its latest scan from them, the rest left out', () => {
  const { summaries, perProject } = tenant();
  const w = weeklyBacklog(perProject, summaries, { now, weeks: 3 });
  // Every scan: p1 at 10, 9 then 2 (its CLI scan is the latest); p2 from week 3; p3 all along.
  assert.deepEqual(w.totals.bySeverity.High, [17, 16, 14]);
  assert.deepEqual(w.byProject.get('p1').o, ['CLI', 'Jenkins'], 'where its scans came from');
  assert.ok(w.byProject.get('p1').x?.length === 5, 'scanned from two origins: its scans are kept in short');
  assert.equal(w.byProject.get('p2').x, undefined, 'one origin only: nothing more to keep');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'origins-')), 'projection-read.json');
  new TenantReadStore({ file }).save({ readAt: at(0), weeks: w.totals.weeks, byProject: w.byProject });
  const read = new TenantReadStore({ file }).get();
  const all = ['p1', 'p2', 'p3'];
  assert.deepEqual(seriesFor(read, all).totals.bySeverity.High, [17, 16, 14], 'no origins chosen: every scan');
  assert.deepEqual(seriesFor(read, all, null, ['CLI', 'Jenkins']).totals.bySeverity.High, [17, 16, 14], 'every origin ticked: the same');
  // Jenkins only: p1 at its Jenkins scans (10, 9, 8), its CLI scans left out; p2 has none (left out); p3 as it was.
  const jenkins = seriesFor(read, all, null, ['Jenkins']);
  assert.deepEqual(jenkins.totals.bySeverity.High, [17, 16, 15]);
  assert.deepEqual(jenkins.fixed.bySeverity.High, [0, 1, 1], 'fixes between its Jenkins scans only');
  assert.deepEqual([jenkins.totals.meta.projects, jenkins.totals.meta.scans, jenkins.totals.meta.origins, jenkins.totals.meta.originSplit], [2, 4, ['Jenkins'], true]);
  // CLI only: p1 from its first CLI scan (4 new, then 2 the same week), and p2; p3 left out.
  const cli = seriesFor(read, all, null, ['CLI']);
  assert.deepEqual(cli.totals.bySeverity.High, [0, 0, 7]);
  assert.deepEqual(cli.fixed.bySeverity.High, [0, 0, 2]);
  assert.equal(cli.totals.meta.projects, 2);
  assert.ok(cli.totals.sast && cli.fixed.sast, 'SAST’s own part is kept for Fusion’s extra findings');
  assert.deepEqual(cli.totals.sast.High, cli.totals.bySeverity.High);
  assert.equal(seriesFor(read, all, null, []).totals.meta.projects, 0, 'no origin ticked: nothing counts');
  // A read made before origins were recorded counts every scan, and says so.
  const old = { ...read, series: Object.fromEntries(Object.entries(read.series).map(([id, own]) => [id, { scans: own.scans, e: own.e }])) };
  const before = seriesFor(old, all, null, ['Jenkins']);
  assert.deepEqual([before.totals.bySeverity.High, before.totals.meta.originSplit], [[17, 16, 14], false]);
});

test('a read records each project’s scans per origin, for Fusion’s scan frequency, and the weeks per origin', async () => {
  const scans = {
    p1: [...Array.from({ length: 30 }, (_, i) => ({ id: `j${i}`, projectId: 'p1', createdAt: at(i * 10 + 1), sourceOrigin: 'Jenkins' })), { id: 'w1', projectId: 'p1', createdAt: at(5), sourceOrigin: 'Webapp' }],
    p2: [],
  };
  const client = {
    async *paginate(url) {
      if (url === '/api/projects') yield* [{ id: 'p1', name: 'One', createdAt: '2020-01-01T00:00:00Z' }, { id: 'p2', name: 'Old', createdAt: '2020-01-01T00:00:00Z' }];
    },
    async request(url, { query } = {}) {
      if (url === '/api/scans' && query['to-date']) return { scans: query['project-id'] === 'p2' ? [{ id: 'o2', projectId: 'p2', createdAt: at(500), sourceOrigin: 'cx-cli' }] : [] };
      if (url === '/api/scans') return { filteredTotalCount: scans[query['project-id']].length, scans: scans[query['project-id']] };
      if (url === '/api/scan-summary') return { scansSummaries: query['scan-ids'].map((scanId) => ({ scanId, sastCounters: { severityCounters: [{ severity: 'HIGH', counter: 3 }] } })) };
      if (url === '/api/projects/last-scan') return { p1: { id: 'j0' }, p2: { id: 'o2' } };
      return {};
    },
  };
  const out = await readTenant(client, { now, weeks: 4 });
  const [p1, p2] = out.projects;
  assert.deepEqual(p1.origins, { 'Web portal (by hand)': 1, Jenkins: 30 });
  assert.equal(p1.scanCount, 31);
  assert.equal(p1.scanDays, 365);
  assert.deepEqual(p2.origins, { CLI: 0 }, 'scanned before the year only: it has a scan from there');
  assert.deepEqual(out.tr.totals.meta.origins, [], 'the tenant’s own backlog counts every origin');
  assert.deepEqual(out.perProject.byProject.get('p1').o, ['Jenkins', 'Web portal (by hand)']);
  // Saved with the customer: kept, cleaned.
  const saved = cleanFusion({ projects: out.projects }).projects;
  assert.deepEqual([saved[0].origins, saved[0].scanDays], [p1.origins, 365]);
  assert.deepEqual(cleanFusion({ projects: [{ id: 'x', name: 'X', origins: { __proto__: null, constructor: 3, Jenkins: '4', '': 2 } }] }).projects[0].origins, { Jenkins: 4 });
  assert.equal(cleanFusion({ projects: [{ id: 'x', name: 'X' }] }).projects[0].origins, null, 'read before origins were recorded');
});

test('Fusion counts how often each project is scanned from the origins ticked; one with no such scan is left out', () => {
  const p = { id: 'p1', name: 'One', source: 'sast-metadata', loc: 20000, scanCount: 60, frequency: frequencyOf(60, 365).id, scansPerWeek: 1.15, scanDays: 365, origins: { Jenkins: 52, 'Web portal (by hand)': 8 } };
  assert.equal(byOrigins(p, null), p, 'every origin');
  assert.equal(byOrigins(p, ['Jenkins', 'Web portal (by hand)', 'CLI']), p, 'all of its origins ticked');
  const jenkins = byOrigins(p, ['Jenkins']);
  assert.deepEqual([jenkins.scanCount, jenkins.frequency], [52, '1-5-week']);
  const byHand = byOrigins(p, ['Web portal (by hand)']);
  assert.deepEqual([byHand.scanCount, byHand.frequency], [8, '2-months'], 'eight scans a year: about once in 2 months');
  assert.equal(byOrigins(p, ['CLI']), null, 'no scan from there: left out');
  assert.equal(byOrigins({ ...p, origins: {} }, ['CLI']), null, 'never scanned: left out once origins are chosen');
  assert.equal(byOrigins({ ...p, origins: null }, ['CLI']).scanCount, 60, 'read before origins were recorded: as it was');
  assert.equal(byOrigins({ ...p, source: 'manual' }, ['CLI']).scanCount, 60, 'added by hand: always counts');
  // The frequency the scope filters on is the one from those scans.
  assert.equal(inScope(byHand, { frequencies: ['2-months'], leaveOutNoCode: false }), true);
  // The drop-down: each origin with its scans and projects, most scans first, "Not said" last.
  const counts = originCounts([p, { id: 'p2', origins: { 'Not said': 90, Jenkins: 4 } }, { id: 'p3', origins: null }, { id: 'm', source: 'manual', origins: { CLI: 1 } }]);
  assert.deepEqual(counts, [
    { origin: 'Jenkins', scans: 56, projects: 2 },
    { origin: 'Web portal (by hand)', scans: 8, projects: 1 },
    { origin: 'Not said', scans: 90, projects: 1 },
  ]);
});

test('the origins ticked are saved with the customer (null: every one); a customer saved before loads with every one', () => {
  assert.equal(cleanScope({}).origins, null);
  assert.deepEqual(cleanScope({ origins: ['Jenkins', 'Jenkins', ' CLI ', '', 7] }).origins, ['Jenkins', 'CLI', '7']);
  assert.deepEqual(cleanScope({ origins: [] }).origins, [], 'none ticked is kept as none');
  assert.equal(cleanScope({ origins: 'Jenkins' }).origins, null);
  assert.equal(scopeActive({ origins: ['Jenkins'] }), false, 'origins choose scans, not projects');
  const old = migrate({ id: 'c1', name: 'Old', planVersion: 4, scope: { applications: ['Mobile'] }, tr: cleanTr({}), fusion: cleanFusion({}) });
  const loaded = patchProfile(old, {});
  assert.equal(cleanScope(loaded.scope).origins, null);
  assert.deepEqual(patchProfile(old, { scope: { origins: ['GitHub Actions'] } }).scope.origins, ['GitHub Actions']);
  // The series saved keeps which origins it counted, and whether the read could tell.
  const tr = cleanTr({ totals: { weeks: ['2026-10-01'], bySeverity: {}, meta: { source: 'cxone', origins: ['Jenkins'], originSplit: false } } });
  assert.deepEqual([tr.totals.meta.origins, tr.totals.meta.originSplit], [['Jenkins'], false]);
  assert.deepEqual(cleanTr({ totals: { weeks: ['2026-10-01'], bySeverity: {}, meta: { source: 'cxone' } } }).totals.meta.origins, []);
  assert.equal(cleanFusion({ readLimit: 500 }).readLimit, 500);
  assert.equal(cleanFusion({}).readLimit, null);
});

test('one Apply: what changed is listed by name, and what needs Checkmarx One read again is marked', () => {
  const applied = topSettings({ allBranches: false, fusionOn: true, fusionNewOn: true, periodMonths: 12, extraPercent: 0, bundleCredits: 10000, scope: { maxProjects: 10000 } });
  const read = { at: '2026-10-09T00:00:00Z', branches: 'primary', limit: null, origins: true };
  assert.deepEqual(settingChanges(applied, applied, read), [], 'nothing changed');
  const next = topSettings({ ...applied, periodMonths: 24, extraPercent: '10', fusionOn: false, scope: { ...applied.scope, origins: ['Jenkins'], applications: ['Mobile'], groups: ['team-a'] } });
  assert.deepEqual(settingChanges(applied, next, read).map((x) => [x.label, x.reads]), [
    ['Add Fusion: Existing customer', false],
    ['Include scans from', false],
    ['Applications', false],
    ['Groups', false],
    ['Projection period', false],
    ['Extra credits (%)', false],
  ]);
  // Every branch: the last read took the primary branch only.
  assert.deepEqual(settingChanges(applied, { ...applied, allBranches: true }, read), [{ key: 'allBranches', label: 'Every branch', reads: true }]);
  // Projects to read: more than where the last read stopped reads again; fewer, or a read that took them all, does not.
  const more = { ...applied, scope: { ...applied.scope, maxProjects: 20000 } };
  assert.equal(settingChanges(applied, more, { ...read, limit: 10000 })[0].reads, true);
  assert.equal(settingChanges(applied, more, read)[0].reads, false, 'the last read took every project');
  assert.equal(settingChanges(applied, { ...applied, scope: { ...applied.scope, maxProjects: 500 } }, { ...read, limit: 10000 })[0].reads, false);
  // Scan origins the last read did not record: read again.
  const origins = { ...applied, scope: { ...applied.scope, origins: ['CLI'] } };
  assert.equal(settingChanges(applied, origins, read)[0].reads, false);
  assert.equal(settingChanges(applied, origins, { ...read, origins: false })[0].reads, true);
  assert.equal(settingChanges(applied, origins, {})[0].reads, false, 'nothing read yet: nothing to read again for');
  // The same choices in another order are no change.
  const a = { ...applied, scope: { ...applied.scope, origins: ['CLI', 'Jenkins'] } };
  assert.deepEqual(settingChanges(a, { ...a, scope: { ...a.scope, origins: ['Jenkins', 'CLI'] } }, read), []);
});

test('the report and the PDF say which scan origins were counted when not all', () => {
  const L = wording();
  const data = (source) => ({ source, summary: { settings: { extraPercent: 0, bundleCredits: 10000 } } });
  const sum = { settings: { extraPercent: 0, bundleCredits: 10000 } };
  assert.ok(assumptionItems(data({ origins: ['Jenkins', 'GitHub Actions'] }), sum, L).includes('Scans from: Jenkins, GitHub Actions.'));
  assert.ok(assumptionItems(data({ origins: ['CLI'], originsFusionOnly: true }), sum, L).includes('Scans from: CLI (for Fusion: the two exports count every scan).'));
  assert.ok(!assumptionItems(data({}), sum, L).some((x) => x.startsWith('Scans from')), 'every origin: nothing said');
  assert.ok(assumptionItems(data({ origins: ['<b>x</b>'] }), sum, L).includes('Scans from: &lt;b&gt;x&lt;/b&gt;.'), 'names are escaped');
  const html = buildReport({ customer: 'Acme', generatedAt: '2026-10-09T00:00:00Z', summary: sum, source: { kind: 'cxone', origins: ['Jenkins'], leftOut: { noOrigin: 3 } }, fusion: null, tr: null });
  assert.match(html, /Scans from: Jenkins\./);
  assert.match(html, /Left out: 3 projects with no scan from those scan origins\./);
});
