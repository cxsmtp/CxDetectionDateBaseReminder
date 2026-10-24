// Govern (beta): the in-memory usage index — swapped as one reference, never changed under a reader.
import test from 'node:test';
import assert from 'node:assert/strict';

import { UsageSeries } from '../src/govern/ingest.js';
import { IndexHolder, UsageIndex } from '../src/govern/usage-index.js';

const T = Date.UTC(2026, 9, 1);
const rows = (o) => new Map(Object.entries(o).map(([k, v]) => [k, { key: k, name: k, email: '', id: '', credits: v, transactions: v }]));

test('an index built before the next poll keeps answering as it was; the holder swaps to the next in one step', () => {
  const series = { user: new UsageSeries({}), action: new UsageSeries({}) };
  series.user.add({ at: T, window: 'last_30_days', rows: rows({ a: 30 }) });
  series.action.add({ at: T, window: 'last_30_days', rows: rows({ triage: 4, remediation: 9 }) });
  const dims = { user: { supported: true }, action: { supported: true } };
  const first = new UsageIndex({ at: T, series, attribution: { user: new Map([['a', 'u1']]) }, dims });
  const holder = new IndexHolder();
  assert.equal(holder.current.available('user'), false, 'empty until the first poll');
  holder.swap(first);
  const reader = holder.current;
  series.user.add({ at: T + 86_400_000, window: 'last_30_days', rows: rows({ a: 40 }) });
  assert.equal(reader.usage('user', 'u1').used, 30, 'the old index does not see the new poll');
  holder.swap(new UsageIndex({ at: T + 1, series, attribution: { user: new Map([['a', 'u1']]) }, dims }));
  assert.ok(Math.abs(holder.current.usage('user', 'u1').used - 41) < 1e-9);
  assert.deepEqual(first.byAction().map((a) => a.action), ['remediation', 'triage']);
  assert.deepEqual(first.top('user'), [{ entityId: 'u1', credits: 30 }]);
  assert.equal(first.available('group'), false);
  assert.equal(first.usage('group', 'g1').available, false, 'unknown, not 0');
});

test('members join groups by path, or by a unique name only', () => {
  const index = new UsageIndex({
    org: {
      users: new Map([['u1', { id: 'u1', groups: ['/eng/web'] }], ['u2', { id: 'u2', groups: ['dup'] }], ['u3', { id: 'u3', groups: ['solo'] }]]),
      groups: new Map([['g1', { id: 'g1', name: 'web', path: '/eng/web' }], ['g2', { id: 'g2', name: 'dup', path: '/a/dup' }], ['g3', { id: 'g3', name: 'dup', path: '/b/dup' }], ['g4', { id: 'g4', name: 'solo', path: '/solo' }]]),
    },
  });
  assert.deepEqual(index.membersOf('g1'), ['u1']);
  assert.deepEqual(index.membersOf('g2'), [], 'an ambiguous group name is not joined (B23)');
  assert.deepEqual(index.membersOf('g4'), ['u3']);
});
