// Labs → Fusion: how Fusion's re-scored results are read, banded and counted (src/fusion.js), and the
// figures the tab shows from them (public/fusion-view.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { CxApiError } from '../src/cxone/client.js';
import { readFusion, severityOfScore, summarize, cleanResult } from '../src/fusion.js';
import { fusionRows, fusionTiles, fusionTotalOf } from '../public/fusion-view.js';

/** A Checkmarx One that answers `routes` (path → body or function of query) and 404 elsewhere. */
function fakeClient(routes) {
  const calls = [];
  return {
    calls,
    async request(path, { query } = {}) {
      calls.push(path);
      const hit = routes[path];
      if (hit === undefined) throw new CxApiError('Not Found', { status: 404, path });
      return typeof hit === 'function' ? hit(query ?? {}) : hit;
    },
    async *paginate(path) {
      calls.push(path);
      for (const app of routes[path]?.applications ?? []) yield app;
    },
  };
}

test('a risk score is banded as Checkmarx One bands severities: 9+ critical, 7+ high, 4+ medium, above 0 low', () => {
  assert.deepEqual([10, 9, 8.9, 7, 6.9, 4, 3.9, 0.1, 0, null, 'x'].map(severityOfScore), ['CRITICAL', 'CRITICAL', 'HIGH', 'HIGH', 'MEDIUM', 'MEDIUM', 'LOW', 'LOW', 'NONE', null, null]);
});

test('counts per project: under the new severity, raised or lowered, and what Fusion brought up to critical or high', () => {
  const rows = [
    cleanResult({ projectId: 'p1', resultId: 'a', oldRiskValue: 5.5, newRiskValue: 9.4 }, 'app'),
    cleanResult({ projectId: 'p1', resultId: 'b', oldRiskValue: 7.5, newRiskValue: 8.0 }, 'app'),
    cleanResult({ projectId: 'p2', resultId: 'c', oldRiskValue: 6.8, newRiskValue: 3.1 }, 'app'),
  ];
  const { projects, totals } = summarize(rows);
  assert.equal(projects.p1.CRITICAL, 1);
  assert.equal(projects.p1.HIGH, 1);
  assert.equal(projects.p1.raisedToTop, 1, 'high already before: not brought up by Fusion');
  assert.equal(projects.p1.raised, 2);
  assert.equal(projects.p2.lowered, 1);
  assert.deepEqual([totals.total, totals.LOW, totals.raisedToTop], [3, 1, 1]);
});

test('reads only the applications Fusion scanned that hold a fetched project, every page, each result once', async () => {
  const page = (offset) => Array.from({ length: offset ? 20 : 100 }, (_, i) => ({ projectId: i % 2 ? 'p1' : 'p9', resultId: `r${offset + i}`, oldRiskValue: 3, newRiskValue: 8, scanId: 's' }));
  const client = fakeClient({
    '/api/applications': { applications: [{ id: 'a1', name: 'Payments', projectIds: ['p1', 'p9'] }, { id: 'a2', name: 'Web', projectIds: ['p2'] }, { id: 'a3', name: 'Other', projectIds: ['p7'] }] },
    // Answers at the second place tried.
    '/api/fusion/results/applications': { applications: ['a1', 'a3'] },
    '/api/fusion/results/applications/a1/risk-scores': (q) => ({ totalCount: 120, results: page(Number(q.offset ?? 0)) }),
    '/api/fusion-dispatcher/a1/scan-status': { scanStatus: 'Completed', stage: 100, scanTimestamp: 1760000000 },
  });
  const f = await readFusion(client, ['p1', 'p2']);
  assert.equal(f.available, true);
  assert.equal(f.totals.total, 60, 'the 120 results, only those of p1 (in scope)');
  assert.equal(f.totals.raisedToTop, 60);
  assert.deepEqual(Object.keys(f.projects), ['p1']);
  assert.ok(!client.calls.some((c) => c.includes('/a3/')), 'a3 holds no fetched project');
  const a1 = f.applications.find((a) => a.id === 'a1');
  assert.equal(a1.scan.status, 'Completed');
  assert.equal(a1.scan.at, new Date(1760000000 * 1000).toISOString(), 'seconds since 1970');
  assert.equal(f.applications.find((a) => a.id === 'a2').notScanned, true);

  // The path found is kept for the connection: the next read goes straight there.
  client.calls.length = 0;
  await readFusion(client, ['p1']);
  assert.ok(!client.calls.includes('/api/fusion-results/applications'));
});

test('a tenant without Fusion: nothing to show, and no error', async () => {
  const f = await readFusion(fakeClient({ '/api/applications': { applications: [] } }), ['p1']);
  assert.equal(f.available, false);
  assert.equal(f.totals.total, 0);
});

test('the tiles: share of open findings, raised to critical or high, results per credit entered', () => {
  const fusion = { totals: { total: 50, CRITICAL: 10, HIGH: 15, raisedToTop: 12, lowered: 4 }, projects: { p1: { total: 30, raisedToTop: 12 }, p2: { total: 20, raisedToTop: 0 } }, applications: [] };
  const scope = { openFindings: 1000, projects: 8 };
  const t = fusionTiles(fusion, scope, '100');
  assert.deepEqual(t.share, { results: 50, open: 1000, percent: 5, projects: 2, of: 8 });
  assert.deepEqual(t.top, { raised: 12, projects: 1, lowered: 4 });
  assert.deepEqual(t.perCredit, { credits: 100, results: 0.5, top: 0.25, creditsPerTop: 4 });
  assert.equal(fusionTiles(fusion, scope, '').perCredit.results, null, 'no credits entered: nothing made up');
});

test('rows: most critical first, named from the fetch; the Workbench column is empty until Fusion is read', () => {
  const fusion = {
    applications: [{ id: 'a1', name: 'Payments', scan: { status: 'Completed', at: '2026-10-20T10:00:00Z' } }],
    projects: { p1: { CRITICAL: 0, HIGH: 2, total: 2, applications: ['a1'] }, p2: { CRITICAL: 1, HIGH: 0, total: 1, applications: ['a1'] } },
  };
  const rows = fusionRows(fusion, { names: { p1: 'Shop', p2: 'Bank' } });
  assert.deepEqual(rows.map((r) => r.name), ['Bank', 'Shop']);
  assert.deepEqual(rows[0].applications, ['Payments']);
  assert.equal(rows[0].scan.status, 'Completed');
  assert.equal(fusionTotalOf(null, 'p1'), null);
  assert.equal(fusionTotalOf(fusion, 'p1'), 2);
  assert.equal(fusionTotalOf(fusion, 'p3'), 0);
});
