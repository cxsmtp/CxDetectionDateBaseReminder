// Reading Checkmarx One faster without reading it wrong: pages a few at once
// (in order, each row once, whatever the total claims), and recent project
// reads shared only when they are still current.
import test from 'node:test';
import assert from 'node:assert/strict';

import { CxClient } from '../src/cxone/client.js';
import { collectProjectRisks, projectReads } from '../src/cxone/risks.js';

/** A client whose collection has `rows` rows but claims `claimed` in its total. */
class PagedClient extends CxClient {
  constructor({ rows, claimed = rows, failAt = -1, latency = 5 }) {
    super({ baseUrl: 'http://x', tokenUrl: 'http://x', apiKey: 'k' }, { getToken: async () => 'h.e30.tok' });
    Object.assign(this, { rows, claimed, failAt, latency, calls: [], inFlight: 0, peak: 0 });
  }
  async request(_path, { query }) {
    this.calls.push(query.offset);
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    await new Promise((r) => setTimeout(r, this.latency * (1 + Math.random())));
    this.inFlight -= 1;
    if (query.offset === this.failAt) throw new Error(`page at ${query.offset} failed`);
    const items = Array.from({ length: Math.max(0, Math.min(query.limit, this.rows - query.offset)) }, (_, i) => ({ id: query.offset + i }));
    return { items, totalCount: this.claimed };
  }
}
const all = async (client, options = {}) => {
  const out = [];
  for await (const item of client.paginate('/x', { itemsKey: 'items', limit: 100, ...options })) out.push(item.id);
  return out;
};
const range = (n) => Array.from({ length: n }, (_, i) => i);

test('pages after the first are read a few at once, and handed out in order', async () => {
  const client = new PagedClient({ rows: 950 });
  assert.deepEqual(await all(client), range(950));
  assert.equal(client.calls.length, 10);
  assert.ok(client.peak > 1 && client.peak <= 4, `a few at once (peak ${client.peak})`);
});

test('the end is where it always was: the total, or the first short page when the total is too high', async () => {
  const low = new PagedClient({ rows: 730, claimed: 300 });
  assert.deepEqual(await all(low), range(300));
  assert.equal(low.calls.length, 3, 'no page past the total is asked for');
  assert.deepEqual(await all(new PagedClient({ rows: 250, claimed: 900 })), range(250));
  // Without a total: one page at a time until a short one, as before.
  const unknown = new PagedClient({ rows: 250, claimed: undefined });
  assert.deepEqual(await all(unknown), range(250));
});

test('maxItems is respected, and a failed page fails the read without an unhandled rejection', async () => {
  assert.deepEqual(await all(new PagedClient({ rows: 950 }), { maxItems: 420 }), range(420));
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(all(new PagedClient({ rows: 950, failAt: 500, latency: 2 })), /page at 500 failed/);
    // A page asked for ahead fails after the reader has stopped reading.
    const early = new PagedClient({ rows: 950, failAt: 400, latency: 2 });
    let seen = 0;
    for await (const item of early.paginate('/x', { itemsKey: 'items', limit: 100 })) {
      if (++seen === 150 || item === undefined) break;
    }
    assert.equal(seen, 150);
    assert.ok(early.calls.includes(400), 'the failing page was asked for');
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

/** A risks source backed by a fake client: counts reads per project. */
function riskClient() {
  const reads = new Map();
  return {
    reads,
    async *paginate(_path, { query }) {
      reads.set(query.projectId, (reads.get(query.projectId) ?? 0) + 1);
      for (let i = 0; i < 3; i++) yield { id: `${query.projectId}-r${i}`, severity: 'HIGH', firstDetectionDate: '2026-01-01T00:00:00Z' };
    },
  };
}
const config = { risks: { path: '/api/risks/', autodiscover: false }, concurrency: 2 };
const projects = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
const scans = (suffix = '') => ({ a: { id: `scan-a${suffix}` }, b: { id: `scan-b${suffix}` } });

test('a recent read is shared on the same key while the latest scan is the same', async () => {
  projectReads.clear();
  const client = riskClient();
  const first = await collectProjectRisks(client, config, projects, { shared: { identity: 'key1', lastScans: scans() } });
  const second = await collectProjectRisks(client, config, projects, { shared: { identity: 'key1', lastScans: scans() } });
  assert.equal(first.reused, 0);
  assert.equal(second.reused, 2);
  assert.deepEqual([...client.reads.values()], [1, 1]);
  assert.deepEqual(second.projects.map((p) => p.totalRisks), [3, 3]);

  // Another key never sees it; a rescan, or "fresh", reads again.
  assert.equal((await collectProjectRisks(client, config, projects, { shared: { identity: 'key2', lastScans: scans() } })).reused, 0);
  assert.equal((await collectProjectRisks(client, config, projects, { shared: { identity: 'key1', lastScans: scans('-2') } })).reused, 0);
  assert.equal((await collectProjectRisks(client, config, projects, { shared: { identity: 'key1', lastScans: scans('-2'), fresh: true } })).reused, 0);
  // Without a shared identity (automation, tracked reports): always read.
  assert.equal((await collectProjectRisks(client, config, projects)).reused, 0);
});

test('a project triaged or remediated from here is read afresh for the next 30 minutes', async () => {
  projectReads.clear();
  const client = riskClient();
  const shared = { identity: 'key1', lastScans: scans() };
  await collectProjectRisks(client, config, projects, { shared });
  projectReads.forget('a');
  for (let i = 0; i < 3; i++) {
    const again = await collectProjectRisks(client, config, projects, { shared });
    assert.equal(again.reused, 1, 'only b is reused');
  }
  assert.equal(client.reads.get('a'), 4);
  assert.equal(client.reads.get('b'), 1);
  projectReads.clear();
});
