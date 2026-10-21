// Labs → Fusion: how Fusion's re-scored results are read, banded and counted (src/fusion.js), and the
// figures the tab shows from them (public/fusion-view.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import { CxApiError } from '../src/cxone/client.js';
import { readFusion, severityOfScore, summarize, cleanResult } from '../src/fusion.js';
import { fusionResultRows, fusionRows, fusionTiles, fusionTotalOf } from '../public/fusion-view.js';

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
    // Where the tenant's own Swagger (/spec/v1) puts them; a page of 100 of 120, then the rest by offset.
    '/api/correlation/results/applications': { applications: ['a1', 'a3'] },
    '/api/correlation/results/applications/a1/risk-scores': (q) => ({ totalCount: 120, results: page(Number(q.offset ?? 0)) }),
    '/api/correlation/dispatcher/a1/scan-status': { scanStatus: 'Completed', stage: 100, scanTimestamp: 1760000000 },
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
  assert.equal(client.calls.filter((c) => c === '/api/correlation/results/applications').length, 1, 'listed once, not probed again');
});

test('a tenant without Fusion, or a key not allowed to read it: nothing to show, and what was asked and answered', async () => {
  const f = await readFusion(fakeClient({ '/api/applications': { applications: [] } }), ['p1']);
  assert.equal(f.available, false);
  assert.equal(f.totals.total, 0);
  assert.deepEqual(f.tried, [{ path: '/api/correlation/results/applications', status: 404 }, { path: '/api/risk-management/summary', status: 404 }]);
  const refused = fakeClient({});
  refused.request = async (path) => { throw new CxApiError('Forbidden', { status: 403, path }); };
  assert.deepEqual((await readFusion(refused, ['p1'])).tried, [{ path: '/api/correlation/results/applications', status: 403 }, { path: '/api/risk-management/summary', status: 403 }]);
});

test('the tiles: share of open findings, raised to critical or high, results per credit entered', () => {
  const fusion = { totals: { total: 50, CRITICAL: 10, HIGH: 15, raisedToTop: 12, lowered: 4 }, projects: { p1: { total: 30, raisedToTop: 12 }, p2: { total: 20, raisedToTop: 0 } }, applications: [] };
  const scope = { openFindings: 1000, projects: 8 };
  const t = fusionTiles(fusion, scope, '100');
  assert.deepEqual(t.share, { results: 50, open: 1000, percent: 5, projects: 2, of: 8 });
  assert.deepEqual(t.top, { known: true, raised: 12, projects: 1, lowered: 4 });
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

test('a tenant where the Fusion service is not running (the gateway answers 503): nothing to show, and said so, not an error', async () => {
  const down = fakeClient({});
  down.request = async (path) => { throw new CxApiError('Service Unavailable — no available server', { status: 503, path }); };
  const f = await readFusion(down, ['p1']);
  assert.equal(f.available, false);
  assert.deepEqual(f.tried, [{ path: '/api/correlation/results/applications', status: 503 }, { path: '/api/risk-management/summary', status: 503 }]);
});

test('no correlation service: Fusion is read through Application Risk Management, as the tenant serves it', async () => {
  const result = (id, score, severity, projects) => ({ id, name: `Result ${id}`, hash: `h${id}`, type: 'code', risk: { score, severity }, createdAt: '2026-10-20T14:14:47Z', projects: projects.map((p) => ({ id: p })) });
  const client = fakeClient({
    '/api/applications': { applications: [{ id: 'a1', name: 'PRUOnline', projectIds: ['p1', 'p2'] }, { id: 'a2', name: 'Demo', projectIds: ['p3'] }, { id: 'a3', name: 'Elsewhere', projectIds: ['p9'] }] },
    '/api/risk-management/summary': { summary: [{ id: 'a1', name: 'PRUOnline', riskScore: 9.3, riskSeverity: 'critical' }, { id: 'a3', name: 'Elsewhere', riskScore: 2, riskSeverity: 'low' }] },
    '/api/risk-management/a1/results': (q) => ({ results: Number(q.offset) ? [] : [result('r1', 9.3, 'critical', ['p1']), result('r2', 7.8, 'high', ['p1', 'p2', 'p9']), result('r3', 4.1, 'medium', ['p2'])] }),
  });
  const f = await readFusion(client, ['p1', 'p2', 'p3']);
  assert.equal(f.available, true);
  assert.equal(f.source, 'risk-management');
  assert.ok(client.calls.includes('/api/correlation/results/applications'), 'the correlation service is looked for first');
  assert.ok(!client.calls.includes('/api/risk-management/a3/results'), 'an application with no project in scope is not read');
  assert.deepEqual([f.projects.p1.CRITICAL, f.projects.p1.HIGH, f.projects.p2.HIGH, f.projects.p2.MEDIUM], [1, 1, 1, 1]);
  assert.equal(f.projects.p9, undefined, 'a project outside the scope is not counted');
  assert.equal(f.totals.total, 3, 'r2 belongs to p1 and p2: counted in each, and once in the totals');
  assert.deepEqual(f.applications.map((a) => [a.name, a.results, Boolean(a.notScanned)]), [['PRUOnline', 3, false], ['Demo', 0, true]]);
  assert.equal(f.results[0].info, 'Result r1');
  assert.equal(f.totals.raisedToTop, 0, 'no earlier score: nothing claimed as raised by Fusion');
  assert.equal(fusionTiles(f, { openFindings: 100, projects: 3 }, '').top.known, false);
  // Pinned under Troubleshoot: straight to it.
  const pinned = fakeClient({ '/api/applications': { applications: [{ id: 'a1', name: 'PRUOnline', projectIds: ['p1'] }] }, '/api/risk-management/summary': { summary: [{ id: 'a1' }] }, '/api/risk-management/a1/results': { results: [result('r1', 9.5, 'critical', ['p1'])] } });
  const g = await readFusion(pinned, ['p1'], { resultsPath: '/api/risk-management' });
  assert.equal(g.totals.CRITICAL, 1);
  assert.ok(!pinned.calls.some((c) => c.startsWith('/api/correlation')), 'no correlation call when pinned');
  // Neither there: what each said.
  const none = await readFusion(fakeClient({}), ['p1']);
  assert.equal(none.available, false);
  assert.ok(none.tried.some((t) => t.path === '/api/risk-management/summary' && t.status === 404));
});

test('Application Risk Management giving fewer results per page than asked: every page is still read', async () => {
  const all = Array.from({ length: 7 }, (_, i) => ({ id: `r${i}`, risk: { score: 9.1, severity: 'critical' }, projects: [{ id: 'p1' }] }));
  const client = fakeClient({
    '/api/applications': { applications: [{ id: 'a1', name: 'App', projectIds: ['p1'] }] },
    '/api/risk-management/summary': { summary: [{ id: 'a1' }] },
    // At most 2 per page, whatever is asked; no total given.
    '/api/risk-management/a1/results': (q) => ({ results: all.slice(Number(q.offset ?? 0), Number(q.offset ?? 0) + 2) }),
  });
  const f = await readFusion(client, ['p1']);
  assert.equal(f.totals.total, 7);
  assert.equal(f.totals.CRITICAL, 7);
});

test('a Fusion result naming its project another way, or none at all, is counted, not dropped', async () => {
  const client = fakeClient({
    '/api/applications': { applications: [{ id: 'a1', name: 'Fusion Hub', projectIds: ['p1', 'p2'] }] },
    '/api/risk-management/summary': { summary: [{ id: 'a1', name: 'Fusion Hub' }] },
    '/api/risk-management/a1/results': (q) => ({ results: Number(q.offset) ? [] : [
      { id: 'sca', type: 'sca', risk: { score: 7.5, severity: 'high' }, projects: [{ id: 'p1' }] },
      { id: 'sast', type: 'sast', risk: { score: 7.9, severity: 'high' }, projectId: 'p2' },
      { id: 'iac', type: 'kics', risk: { score: 7.1, severity: 'high' }, project: { id: 'p2' } },
      { id: 'fusion', type: 'sast', risk: { score: 8.2, severity: 'high' } },
    ] }),
  });
  const f = await readFusion(client, ['p1', 'p2']);
  assert.equal(f.totals.HIGH, 4, 'every one of the four');
  assert.deepEqual([f.projects.p1.total, f.projects.p2.total, f.projects['app:a1'].total], [1, 2, 1]);
  assert.equal(fusionRows(f, { names: { p1: 'one', p2: 'two' } }).find((r) => r.projectId === 'app:a1').name, 'Fusion Hub (no project given)');
});

test('every Fusion result once, as Fusion Hub lists it: severity, scanner, name, status, state, when it was detected, and its id', async () => {
  const client = fakeClient({
    '/api/applications': { applications: [{ id: 'a1', name: 'Fusion Hub', projectIds: ['p1', 'p2'] }] },
    '/api/risk-management/summary': { summary: [{ id: 'a1' }] },
    '/api/risk-management/a1/results': (q) => ({ results: Number(q.offset) ? [] : [
      { id: 'r1', name: 'CVE-2026-93687', type: 'sca', status: 'RECURRENT', state: 'TO_VERIFY', risk: { score: 7.4, severity: 'high' }, createdAt: '2026-10-19T08:00:00Z', projects: [{ id: 'p1' }, { id: 'p2' }] },
      { id: 'r2', name: 'Improper Neutralization of Input', type: 'code', status: 'NEW', state: 'TO_VERIFY', risk: { score: 9.2, severity: 'critical' }, firstFoundAt: '2026-10-20T14:14:47Z' },
    ] }),
  });
  const f = await readFusion(client, ['p1', 'p2']);
  const rows = fusionResultRows(f, { names: { p1: 'One', p2: 'Two' } });
  assert.equal(rows.length, 2, 'r1 belongs to two projects: one row');
  assert.deepEqual(rows.map((r) => [r.severity, r.scanner, r.name, r.status, r.state, r.detectedAt, r.id]), [
    ['CRITICAL', 'SAST', 'Improper Neutralization of Input', 'New', 'To verify', '2026-10-20T14:14:47.000Z', 'r2'],
    ['HIGH', 'SCA', 'CVE-2026-93687', 'Recurrent', 'To verify', '2026-10-19T08:00:00.000Z', 'r1'],
  ]);
  assert.deepEqual(rows[1].projects, ['One', 'Two']);
  assert.equal(rows[0].projects[0], 'Fusion Hub (no project given)');
});
