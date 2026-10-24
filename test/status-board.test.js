// Labs → Status board and Consolidated view (Beta): the pure parts — a project's row and health, the figures line,
// failed scans and their reasons, a project's last scans, each tenant's card, the tenant colours, and who may use them.
import test from 'node:test';
import assert from 'node:assert/strict';

import { applicationsByProject, attachScanFacts, boardFigures, boardOf, boardRow, engineNames, failedScansSince, failureReason, healthOf, recentScans, summaryTotal } from '../src/status-board.js';
import { consolidatedFigures, crossProjects, governSummary, tenantHealth, tenantSummary, workbenchSnapshot } from '../src/consolidated.js';
import { TENANT_COLOURS, tenantColour } from '../public/tenant-colour.js';
import { mayUse } from '../src/features.js';
import { IamStore, PERSON_GRANTS } from '../src/iam.js';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString();
const summary = (over = {}) => ({ projectId: 'p1', projectName: 'payments-api', bySeverity: { CRITICAL: 2, HIGH: 5, MEDIUM: 9, LOW: 4, INFO: 7 }, languages: ['Java'], branch: 'main', scanType: 'fusion', sla: { overdue: 3 }, ...over });

test('engines: lower case, KICS and IaC are one, no repeats', () => {
  assert.deepEqual(engineNames(['SAST', 'sca', 'IaC', 'kics', 'Containers', 'ai']), ['sast', 'sca', 'kics', 'containers', 'ai']);
  assert.deepEqual(engineNames(null), []);
});

test('why a scan failed, from its status details', () => {
  const scan = { status: 'Failed', statusDetails: [{ name: 'sast', status: 'Failed', details: 'out of memory' }, { name: 'sca', status: 'Completed' }, { name: 'kics', status: 'Failed' }] };
  assert.equal(failureReason(scan), 'SAST: out of memory; KICS');
  assert.equal(failureReason({ status: 'Failed' }), '');
});

test('health: green under 7 days, amber under 30, red after, failed whatever its age, never scanned', () => {
  assert.deepEqual([healthOf(0.5), healthOf(6.9), healthOf(7), healthOf(29.9), healthOf(30), healthOf(1, { at: 'x' }), healthOf(null)], ['fresh', 'fresh', 'aging', 'aging', 'stale', 'failed', 'never']);
});

test('the facts a fetch adds: scan time and engines, applications, groups, and a failure only when newer than the results', () => {
  const rows = [summary({ projectId: 'p1' }), summary({ projectId: 'p2' }), summary({ projectId: 'p3' })];
  attachScanFacts(rows, {
    scans: { p1: { id: 's1', updatedAt: daysAgo(3), engines: ['sast'] }, p2: { id: 's2', updatedAt: daysAgo(1) }, p3: { id: 's3', updatedAt: daysAgo(1) } },
    engines: { p2: ['SAST', 'SCA'] },
    applications: applicationsByProject([{ name: 'Web', projectIds: ['p1', 'p2'] }, { name: 'Billing', projectIds: ['p1'] }]),
    groups: { p1: ['team-a'] },
    failed: { p1: [{ at: daysAgo(1), reason: 'SAST: out of memory', engines: ['sast'] }], p2: [{ at: daysAgo(2), reason: 'old' }] },
  });
  assert.deepEqual(rows[0].applications, ['Billing', 'Web']);
  assert.deepEqual(rows[0].engines, ['sast']);
  assert.deepEqual(rows[1].engines, ['sast', 'sca'], 'read with the scan types');
  assert.equal(rows[0].scanFailed.reason, 'SAST: out of memory', 'failed after its last results');
  assert.equal(rows[1].scanFailed, null, 'failed before its last completed scan: not shown as failed');
  assert.deepEqual([rows[0].failedScans, rows[1].failedScans, rows[2].failedScans], [1, 1, 0]);
  // Not known (Checkmarx One did not answer): never "none failed".
  const unknown = attachScanFacts([summary()], { failed: null });
  assert.equal(unknown[0].failedScans, null);
});

test('a row: open results by severity (info left out), critical + high, overdue, age; the figures line', () => {
  const [a] = attachScanFacts([summary()], { scans: { p1: { id: 's1', updatedAt: daysAgo(40) } }, failed: {} });
  const row = boardRow(a, NOW);
  assert.deepEqual(row.sev, { critical: 2, high: 5, medium: 9, low: 4 });
  assert.deepEqual([row.total, row.ch, row.overdue, row.health, row.scanType], [20, 7, 3, 'stale', 'fusion']);
  assert.equal(Math.round(row.ageDays), 40);
  const fresh = boardRow({ ...a, scanAt: daysAgo(2), failedScans: 2, scanFailed: { at: daysAgo(1), reason: 'x' } }, NOW);
  const never = boardRow({ ...summary({ projectId: 'p9', bySeverity: {} }), scanAt: null, failedScans: 0 }, NOW);
  const f = boardFigures([row, fresh, never]);
  assert.deepEqual([f.projects, f.scanned30, f.failed7, f.failedProjects, f.stale30, f.ch, f.critical], [3, 1, 2, 1, 2, 14, 4]);
  assert.equal(boardFigures([{ ...row, failedScans: null }]).failed7, null, 'not known stays unknown');
  assert.equal(boardOf(null), null);
  assert.equal(boardOf({ projects: [a], view: { fetchedAt: 'then' } }, NOW).rows.length, 1);
});

test('failed scans: every page while full, only failed ones in the window, newest first', async () => {
  const asked = [];
  const scan = (i, status = 'Failed', at = daysAgo(1)) => ({ id: `s${i}`, projectId: `p${i % 3}`, status, createdAt: at, statusDetails: [{ name: 'sast', status: 'Failed', details: 'boom' }] });
  const pages = [Array.from({ length: 100 }, (_, i) => scan(i, i === 5 ? 'Completed' : 'Failed', daysAgo((i % 5) + 0.5))), [scan(100), scan(101, 'Failed', daysAgo(30))]];
  const client = { request: async (path, { query }) => (asked.push(query), { scans: pages[query.offset / 100] ?? [] }) };
  const out = await failedScansSince(client, { since: daysAgo(7) });
  assert.equal(asked.length, 2);
  assert.equal(asked[0].statuses, 'Failed');
  assert.equal(Object.values(out).flat().length, 100, '99 failed on the first page, 1 on the second in the window');
  for (const list of Object.values(out)) assert.ok(list.every((x, i) => i === 0 || Date.parse(list[i - 1].at) >= Date.parse(x.at)));
  assert.equal(out.p1[0].reason, 'SAST: boom');
});

test('a project\'s last scans: duration, lines of code, results and the change from the completed scan before', async () => {
  const client = {
    request: async (path, { query }) => {
      if (path === '/api/scans') return { scans: [{ id: 'c', status: 'Failed', createdAt: daysAgo(0.1), updatedAt: daysAgo(0.09), statusDetails: [{ name: 'sast', status: 'Failed', details: 'oom' }] }, { id: 'b', status: 'Completed', createdAt: daysAgo(1), updatedAt: new Date(Date.parse(daysAgo(1)) + 90_000).toISOString(), engines: ['sast'] }, { id: 'a', status: 'Completed', createdAt: daysAgo(2), updatedAt: daysAgo(2) }] };
      if (path === '/api/sast-metadata') return { scans: query['scan-ids'].map((id) => ({ scanId: id, loc: 1000 })) };
      if (path === '/api/scan-summary') return { scansSummaries: [{ scanId: 'b', sastCounters: { severityCounters: [{ severity: 'HIGH', counter: 7 }] }, kicsCounters: { totalCounter: 3 } }, { scanId: 'a', sastCounters: { severityCounters: [{ severity: 'HIGH', counter: 12 }] } }] };
      return null;
    },
  };
  const rows = await recentScans(client, 'p1', { limit: 5 });
  assert.deepEqual(rows.map((r) => [r.id, r.status, r.results, r.delta, r.loc]), [['c', 'Failed', null, null, 1000], ['b', 'Completed', 10, -2, 1000], ['a', 'Completed', 12, null, 1000]]);
  assert.equal(rows[1].seconds, 90);
  assert.equal(rows[0].reason, 'SAST: oom');
  assert.equal(summaryTotal({ scanId: 'x' }), null);
});

test('a tenant\'s card: not loaded, healthy, failed, stale; its rows name it; figures across tenants', () => {
  assert.equal(tenantHealth(null, null, NOW), 'notLoaded');
  assert.equal(tenantHealth({ at: daysAgo(0.1) }, null, NOW), 'healthy');
  assert.equal(tenantHealth({ at: daysAgo(0.1) }, { at: daysAgo(0.01) }, NOW), 'failed');
  assert.equal(tenantHealth({ at: daysAgo(0.1) }, { at: daysAgo(1) }, NOW), 'healthy', 'an older failure is past');
  assert.equal(tenantHealth({ at: daysAgo(3) }, null, NOW), 'stale');
  assert.equal(tenantHealth(null, { at: daysAgo(1) }, NOW), 'failed');
  const snapshot = workbenchSnapshot({ projects: [summary(), summary({ projectId: 'p2', scanType: 'last' })] }, { by: 'a@b.c', now: NOW, projectsTotal: 10 });
  const eu = tenantSummary({ id: 'acme-eu', name: 'Acme EU', snapshot, credits: { used: 10, available: 90, total: 100 }, pool: { limited: true, size: 50, used: { total: 5 }, remaining: 45 }, now: NOW });
  assert.deepEqual([eu.projects, eu.projectsTotal, eu.total, eu.ch, eu.overdue, eu.fusion, eu.last, eu.health], [2, 10, 40, 14, 6, 1, 1, 'healthy']);
  assert.deepEqual(eu.pool, { size: 50, used: 5, available: 45 });
  const us = tenantSummary({ id: 'acme-us', name: 'Acme US', now: NOW });
  assert.deepEqual([us.projects, us.health, us.loaded], [null, 'notLoaded', false]);
  const rows = crossProjects([{ id: 'acme-eu', name: 'Acme EU', snapshot }, { id: 'acme-us', name: 'Acme US', snapshot: null }]);
  assert.ok(rows.length === 2 && rows.every((r) => r.tenantName === 'Acme EU' && r.colour === tenantColour('acme-eu')));
  const f = consolidatedFigures([eu, us]);
  assert.deepEqual([f.tenants, f.loaded, f.projects, f.critical, f.creditsUsed, f.creditsTotal], [2, 1, 2, 4, 10, 100]);
});

test('Govern in a tenant: never started here, nothing to read; its own view when it runs', () => {
  assert.equal(governSummary({}), null);
  assert.equal(governSummary({ govern: { loaded: () => true, get: () => ({}) } }, { locked: true }), null, 'locked: Govern off');
  let made = false;
  assert.deepEqual(governSummary({ govern: { loaded: () => false, get: () => ((made = true), {}) } }), { on: null, budgeted: null, budgets: null, restricted: null });
  assert.equal(made, false, 'reading never starts Govern');
  const svc = { view: { overview: { figures: { assigned: 36500, budgets: 12, restricted: 3 } } } };
  assert.deepEqual(governSummary({ govern: { loaded: () => true, get: () => svc } }), { on: true, budgeted: 36500, budgets: 12, restricted: 3 });
});

test('a tenant keeps its colour', () => {
  assert.equal(tenantColour('acme-eu'), tenantColour('acme-eu'));
  const seen = new Set(['default', 'acme-eu', 'acme-us', 'globex', 't-1', 't-2', 't-3', 't-4'].map(tenantColour));
  assert.ok([...seen].every((c) => c >= 0 && c < TENANT_COLOURS));
  assert.ok(seen.size >= 4, 'tenants spread over the colours');
});

test('who may use them: the board for whoever loads findings once unlocked; the consolidated view only with its grant', () => {
  const perms = (...p) => new Set(p);
  assert.equal(mayUse({}, 'statusBoard', perms('findings.fetch')), true);
  assert.equal(mayUse({}, 'statusBoard', perms('reports.view')), false);
  assert.equal(mayUse({}, 'statusBoard', perms('beta.use')), true);
  assert.equal(mayUse({}, 'consolidated', perms('beta.use', 'findings.fetch')), false, 'Beta access is not enough');
  assert.equal(mayUse({ features: { consolidated: { stage: 'final' } } }, 'consolidated', perms('beta.use')), false);
  assert.equal(mayUse({}, 'consolidated', perms('consolidated.view')), true);
  assert.deepEqual(PERSON_GRANTS.map((p) => p.id), ['consolidated.view']);
  // A person's grant never stops an Admin managing them.
  const iam = Object.create(IamStore.prototype);
  assert.equal(iam.canGrant(perms('iam.manage'), perms('consolidated.view')), true);
  assert.equal(iam.canGrant(perms('iam.manage'), perms('integration.cxone')), false);
});
