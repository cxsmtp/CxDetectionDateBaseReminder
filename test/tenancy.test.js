import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_TENANT, Tenancy, scoped, scopedState } from '../src/tenancy.js';

const make = () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenancy-'));
  const tenancy = new Tenancy({ dataDir, build: ({ id, dir }) => ({ store: { id, dir, hello: function () { return `hi from ${this.id}`; } }, state: { count: 0 } }) });
  return { dataDir, tenancy };
};

test('one tenant: the first, whose files are the state folder\'s own', () => {
  const { dataDir, tenancy } = make();
  assert.equal(tenancy.enabled, false);
  assert.deepEqual(tenancy.ids(), [DEFAULT_TENANT]);
  assert.equal(tenancy.current().id, DEFAULT_TENANT);
  assert.equal(tenancy.dirOf(DEFAULT_TENANT), dataDir);
  assert.equal(tenancy.run(DEFAULT_TENANT, () => 'ran'), 'ran');
  assert.throws(() => tenancy.add({ name: 'Acme EU' }), /Turn on several tenants first/);
});

test('several tenants: each request or job sees its own stores, through awaits and timers', async () => {
  const { dataDir, tenancy } = make();
  tenancy.enable({ by: 'admin@acme.io' });
  const eu = tenancy.add({ name: 'Acme EU' });
  assert.equal(eu.id, 'acme-eu');
  assert.equal(tenancy.dirOf(eu.id), path.join(dataDir, 'tenants', 'acme-eu'));
  const store = scoped(tenancy, 'store');
  const state = scopedState(tenancy);
  const seen = await tenancy.run(eu.id, async () => {
    await new Promise((r) => setTimeout(r, 5));
    state.count += 1;
    return [store.id, store.hello(), await new Promise((r) => setTimeout(() => r(tenancy.current().id), 5))];
  });
  assert.deepEqual(seen, ['acme-eu', 'hi from acme-eu', 'acme-eu']);
  assert.equal(tenancy.run(eu.id, () => state.count), 1);
  assert.equal(state.count, 0, 'outside any tenant: the first tenant');
  assert.deepEqual(tenancy.each((id) => store.id), [DEFAULT_TENANT, 'acme-eu']);
});

test('names are unique; the first tenant stays; removing keeps the files; off needs one tenant left', () => {
  const { dataDir, tenancy } = make();
  tenancy.enable({ by: 'a' });
  const eu = tenancy.add({ name: 'Acme EU' });
  assert.throws(() => tenancy.add({ name: 'acme eu' }), /already a tenant named/);
  assert.throws(() => tenancy.disable(), /Remove the other tenants first/);
  assert.throws(() => tenancy.remove(DEFAULT_TENANT), /cannot be removed/);
  tenancy.remove(eu.id);
  assert.ok(!tenancy.has(eu.id));
  assert.ok(fs.readdirSync(path.join(dataDir, 'tenants')).some((n) => n.startsWith('acme-eu.removed-')));
  tenancy.disable();
  assert.equal(tenancy.enabled, false);
  // Kept across restarts.
  const again = new Tenancy({ dataDir, build: () => ({}) });
  assert.equal(again.enabled, false);
  assert.deepEqual(again.ids(), [DEFAULT_TENANT]);
});
