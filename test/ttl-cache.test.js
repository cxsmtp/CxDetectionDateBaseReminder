import test from 'node:test';
import assert from 'node:assert/strict';

import { Semaphore, TtlCache } from '../src/ttl-cache.js';

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

test('concurrent asks for the same key share one load', async () => {
  const cache = new TtlCache();
  let loads = 0;
  const loader = async () => {
    loads += 1;
    await tick(10);
    return 'v';
  };
  const answers = await Promise.all(Array.from({ length: 100 }, () => cache.wrap('k', loader, 1000)));
  assert.equal(loads, 1);
  assert.ok(answers.every((a) => a === 'v'));
  assert.equal(await cache.wrap('k', loader, 1000), 'v');
  assert.equal(loads, 1, 'fresh value served from the cache');
});

test('time to live can depend on the answer, and failures are not cached', async () => {
  const cache = new TtlCache();
  await cache.wrap('settled', async () => ({ done: true }), (v) => (v.done ? 60_000 : 1));
  assert.deepEqual(cache.get('settled'), { done: true });
  await assert.rejects(cache.wrap('bad', async () => { throw new Error('upstream down'); }, 60_000));
  let calls = 0;
  await cache.wrap('bad', async () => { calls += 1; return 'ok'; }, 60_000);
  assert.equal(calls, 1, 'a failed load is retried next time');
});

test('peek answers at once: nothing yet, then fresh, then stale while it refreshes', async () => {
  const cache = new TtlCache();
  let version = 0;
  const loader = async () => {
    version += 1;
    await tick(5);
    return version;
  };
  assert.equal(cache.peek('k', loader, 20), undefined, 'unknown: loads in the background');
  await tick(15);
  assert.deepEqual(cache.peek('k', loader, 20), { value: 1, fresh: true });
  await tick(30);
  assert.deepEqual(cache.peek('k', loader, 20), { value: 1, fresh: false }, 'stale value, refresh started');
  await tick(15);
  assert.deepEqual(cache.peek('k', loader, 20), { value: 2, fresh: true });
  assert.equal(cache.peek('other', null, 20), undefined, 'no loader: nothing is started');
});

test('the cache keeps at most `max` entries, dropping the least recently used', () => {
  const cache = new TtlCache({ max: 3 });
  for (const k of ['a', 'b', 'c']) cache.set(k, k, 60_000);
  cache.get('a');
  cache.set('d', 'd', 60_000);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 'a');
  assert.equal(cache.size, 3);
});

test('the semaphore never exceeds its limit, and interactive work jumps the background queue', async () => {
  const gate = new Semaphore(2);
  let active = 0;
  let peak = 0;
  const order = [];
  const job = (name, ms) => async () => {
    active += 1;
    peak = Math.max(peak, active);
    await tick(ms);
    order.push(name);
    active -= 1;
  };
  const runs = [
    gate.run(job('first', 20)),
    gate.run(job('second', 20)),
    ...Array.from({ length: 5 }, (_, i) => gate.run(job(`background-${i}`, 5), { low: true })),
  ];
  await tick(2);
  runs.push(gate.run(job('interactive', 5)));
  await Promise.all(runs);
  assert.equal(peak, 2);
  assert.ok(order.indexOf('interactive') < order.indexOf('background-0'), `order: ${order.join(', ')}`);
});

test('a person waiting never joins a background load; later callers join theirs', async () => {
  const cache = new TtlCache();
  let releaseBackground;
  let calls = 0;
  cache.peek('k', () => new Promise((resolve) => { calls += 1; releaseBackground = () => resolve('background'); }), 60_000);
  const clicked = cache.wrap('k', async () => { calls += 1; return 'interactive'; }, 60_000);
  const joined = cache.wrap('k', async () => { calls += 1; return 'third'; }, 60_000);
  assert.equal(await clicked, 'interactive', 'the click did not wait on the queued background read');
  assert.equal(await joined, 'interactive');
  assert.equal(calls, 2);
  releaseBackground();
  await new Promise((r) => setImmediate(r));
  // Two background refreshes of one key still share a load.
  let background = 0;
  const slow = () => new Promise((resolve) => { background += 1; setTimeout(() => resolve('x'), 5); });
  cache.delete('k');
  cache.peek('k2', slow, 60_000);
  cache.peek('k2', slow, 60_000);
  assert.equal(background, 1);
});
