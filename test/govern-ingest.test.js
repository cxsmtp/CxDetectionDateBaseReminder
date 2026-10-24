// Govern (beta): reading consumption — complete polls only, the unknown-viewBy trap, and increments from a sliding window.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UsageSeries, actionType, consumptionRow, readConsumption, readDimension, readOrg, sumIncrements } from '../src/govern/ingest.js';

const DAY = 86_400_000;

/** A fake client answering /api/credits/consumption from `views` (viewBy → rows); unknown views answer the user view. */
function fakeCx(views, { fail = null, size: forced = null } = {}) {
  const calls = [];
  return {
    calls,
    async request(p, { query = {} } = {}) {
      calls.push({ p, query });
      if (p !== '/api/credits/consumption') throw Object.assign(new Error('404'), { status: 404 });
      if (fail?.(query)) throw Object.assign(new Error('503 Service Unavailable'), { status: 503 });
      const rows = views[query.viewBy] ?? views.user;
      const size = forced ?? query.size;
      return { items: rows.slice((query.page - 1) * size, query.page * size), totalItems: rows.length, totalPages: Math.ceil(rows.length / size), currentPage: query.page };
    },
  };
}
const users = [{ name: 'Ada', userEmail: 'ada@acme.io', creditsUsed: 10 }, { name: 'bob@acme.io', creditsUsed: 4 }, { name: 'cx-carol', creditsUsed: '2.5' }];

test('rows are normalised: key by email, name or id; action types; credits never NaN', () => {
  assert.equal(consumptionRow('user', users[0]).key, 'ada@acme.io');
  assert.equal(consumptionRow('user', users[1]).email, 'bob@acme.io', 'an email-shaped name is the email');
  assert.equal(consumptionRow('user', users[2]).credits, 2.5);
  assert.equal(consumptionRow('project', { name: 'Payments API', creditsUsed: 3 }).key, 'payments api', 'project rows without an id');
  assert.equal(consumptionRow('project', { projectId: 'p1', creditsUsed: 'x' }).credits, 0);
  assert.equal(consumptionRow('user', { creditsUsed: 1 }), null);
  assert.equal(consumptionRow('user', { name: '__proto__' }), null);
  assert.deepEqual([actionType('AI_Triage'), actionType('Auto Triage'), actionType('fusion_scan'), actionType('Remediation')], ['triage', 'auto_triage', 'fusion', 'remediation']);
  const a = consumptionRow('action', { actionType: 'Remediation', creditsUsed: 9, transactionCount: 3 });
  assert.deepEqual([a.key, a.transactions], ['remediation', 3]);
});

test('a dimension is complete only when every page arrived and the subjects match totalItems', async () => {
  const ok = await readDimension(fakeCx({ user: users }), 'user', { pageSize: 2 });
  assert.equal(ok.complete, true);
  assert.equal(ok.pagesFetched, 2);
  const broken = await readDimension(fakeCx({ user: users }, { fail: (q) => q.page === 2 }), 'user', { pageSize: 2 });
  assert.equal(broken.complete, false, 'a failed page is never a complete poll (B10)');
  assert.equal(broken.status, 503);
  // A row that moved across the page boundary is counted once, and the poll is not complete.
  const moved = fakeCx({ user: [...users.slice(0, 2), users[1]] });
  const dup = await readDimension(moved, 'user', { pageSize: 2 });
  assert.equal(dup.rows.size, 2);
  assert.equal(dup.complete, false, 'distinct subjects short of totalItems (B31)');
});

test('the unknown-viewBy trap: a dimension answering like the probe (the user view) is not reported; a failing probe decides nothing', async () => {
  const cx = fakeCx({ user: users, action: [{ actionType: 'Triage', creditsUsed: 5, transactionCount: 5 }], project: [{ projectId: 'p1', name: 'P1', creditsUsed: 3 }] });
  const r = await readConsumption(cx, { window: 'last_30_days', pageSize: 100, dimensions: ['user', 'action', 'project', 'group'] });
  assert.equal(r.dims.group.supported, false);
  assert.equal(r.dims.group.result, null);
  assert.equal(r.dims.action.supported, true);
  assert.equal(r.dims.project.supported, true);
  assert.equal(cx.calls.filter((c) => c.query.viewBy === '__mz_unsupported_probe__').length, 1, 'probed once per cycle');
  // Known support: no probe at all.
  const again = fakeCx({ user: users });
  await readConsumption(again, { window: 'last_30_days', pageSize: 100, support: { group: false, action: true, project: true, application: true }, dimensions: ['user', 'group'] });
  assert.equal(again.calls.filter((c) => c.query.viewBy === '__mz_unsupported_probe__').length, 0);
  assert.equal(again.calls.filter((c) => c.query.viewBy === 'group').length, 0, 'an unsupported dimension is not read again');
  // A 403 leaves support unknown, never "unsupported".
  const denied = { request: async () => { throw Object.assign(new Error('403'), { status: 403 }); } };
  const d = await readConsumption(denied, { window: 'last_30_days', pageSize: 100, dimensions: ['project'] });
  assert.equal(d.dims.project.supported, null);
});

test('increments: the first poll seeds an estimate over its window; later polls add what grew plus what aged out', () => {
  const t0 = Date.UTC(2026, 9, 1);
  const s = new UsageSeries({});
  const rows = (n) => new Map([['a', { key: 'a', credits: n }]]);
  s.add({ at: t0, window: 'last_30_days', rows: rows(30) });
  // The seed: 30 credits spread over the 30 days before, flagged estimated.
  assert.deepEqual(s.usage('a', t0 - 10 * DAY, t0), { sum: 10, estimated: true });
  // A day later the total is the same: one day of the seed aged out, so one credit was spent that day.
  s.add({ at: t0 + DAY, window: 'last_30_days', rows: rows(30) });
  const day = s.usage('a', t0, t0 + DAY);
  assert.ok(Math.abs(day.sum - 1) < 1e-9, JSON.stringify(day));
  // The next day the total is 36: one more credit aged out, so 7 were spent.
  s.add({ at: t0 + 2 * DAY, window: 'last_30_days', rows: rows(36) });
  assert.ok(Math.abs(s.usage('a', t0 + DAY, t0 + 2 * DAY).sum - 7) < 1e-9);
  // Never negative; a change of window seeds again.
  s.add({ at: t0 + 3 * DAY, window: 'last_90_days', rows: rows(1) });
  assert.equal(s.seedAt, t0 + 3 * DAY);
  assert.equal(sumIncrements([[0, 10, 10, 0]], 5, 10).sum, 5, 'prorated by time');
});

test('the series is copy-on-write, compacts old increments without losing credits, and survives a restart', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'govern-series-'));
  const file = path.join(d, 'user.json');
  const s = new UsageSeries({ file });
  const t0 = Date.UTC(2026, 0, 1);
  s.add({ at: t0, window: 'last_30_days', rows: new Map([['a', { key: 'a', credits: 0 }]]) });
  for (let i = 1; i <= 40; i += 1) s.add({ at: t0 + i * 15 * 60_000, window: 'last_30_days', rows: new Map([['a', { key: 'a', credits: i }]]) });
  const held = s.increments.get('a');
  s.add({ at: t0 + 41 * 15 * 60_000, window: 'last_30_days', rows: new Map([['a', { key: 'a', credits: 41 }]]) });
  assert.equal(held.length, 40, 'an index built earlier keeps its arrays');
  const before = s.usage('a', -Infinity, Infinity).sum;
  s.compact(t0 + 30 * DAY);
  assert.ok(s.increments.get('a').length < 41, 'merged into hours');
  assert.ok(Math.abs(s.usage('a', -Infinity, Infinity).sum - before) < 1e-6, 'no credit lost');
  s.save();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = new UsageSeries({ file });
  assert.ok(Math.abs(again.usage('a', -Infinity, Infinity).sum - before) < 1e-6);
  assert.equal(again.lastTotals.get('a'), 41);
});

test('the org: users paged, groups flattened with paths, an implausibly short project list keeps the previous one', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, groups: ['g1'], repoId: i ? 1000 + i : 0 }));
  let projectCalls = 0;
  const cx = {
    async request(p, { query = {} } = {}) {
      if (p.endsWith('/users/v2')) {
        const all = [{ id: 'u1', username: 'ada', email: 'ADA@acme.io', groups: ['/eng'] }, { id: 'u2', username: 'bob' }, { id: 'u3', username: 'cy' }];
        const first = Number(query.first ?? 0);
        return { users: all.slice(first, first + (query.max ?? 2)), filteredCount: 3 };
      }
      if (p.endsWith('/groups')) return [{ id: 'g1', name: 'eng', path: '/eng', subGroups: [{ id: 'g2', name: 'web', path: '/eng/web' }] }];
      if (p === '/api/projects') {
        projectCalls += 1;
        return { projects: many.slice(query.offset, query.offset + query.limit), totalCount: many.length };
      }
      return { applications: [{ id: 'a1', name: 'App', projectIds: ['p1'] }], totalCount: 1 };
    },
  };
  const { org, warnings } = await readOrg(cx, { iamUrl: 'https://iam.acme.io', tenant: 'acme' });
  assert.deepEqual(warnings, []);
  assert.equal(org.users.size, 3);
  assert.equal(org.users.get('u1').email, 'ada@acme.io');
  assert.equal(org.groups.get('g2').parentId, 'g1');
  assert.equal(org.projects.get('p0').repoId, '', 'repoId 0 is no repository');
  assert.equal(org.projects.get('p2').repoId, '1002');
  // Next time only 3 projects come back where there were 30: kept as before until confirmed.
  many.splice(3);
  const again = await readOrg(cx, { iamUrl: 'https://iam.acme.io', tenant: 'acme' }, org);
  assert.equal(again.org.projects.size, 30);
  assert.match(again.warnings.join(' '), /Projects: 3 read where there were 30/);
  assert.ok(projectCalls >= 2);
});
