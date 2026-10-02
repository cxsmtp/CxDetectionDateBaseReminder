import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { CxClient } from '../src/cxone/client.js';
import { clearDirectoryCache, fetchDirectory } from '../src/cxone/directory.js';
import { collectInitiators } from '../src/cxone/initiators.js';
import { KnownAddresses } from '../src/known-addresses.js';

const USERS = [
  { username: 'cx-andy-schmit', email: 'andy.schmit@checkmarx.com' },
  { username: 'cx-jacob-rand', email: 'jacob.rand@checkmarx.com' },
];

/** A fake IAM whose directory listing misbehaves as `plan` says. */
async function iam(plan) {
  const calls = { list: 0, exact: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.searchParams.has('username')) {
      calls.exact += 1;
      if (plan.exact === 'fail') return send(500, {});
      return send(200, USERS.filter((u) => u.username === url.searchParams.get('username')));
    }
    calls.list += 1;
    const outcome = plan.list[Math.min(calls.list - 1, plan.list.length - 1)];
    if (outcome === 'drop') return req.socket.destroy();
    if (outcome !== 'ok') return send(outcome, {});
    send(200, Number(url.searchParams.get('first')) ? [] : USERS);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = new CxClient({ baseUrl: base }, { getToken: async () => 't', reset() {} });
  return { client, connection: { iamUrl: base, tenant: 'acme' }, calls, close: () => server.close() };
}

const projects = [{ id: 'p1', name: 'CxOne-Node' }, { id: 'p2', name: 'juice-world' }];
const lastScans = { p1: { id: 's1', initiator: 'cx-andy-schmit' }, p2: { id: 's2', initiator: 'cx-jacob-rand' } };
const resolve = (env, options = {}) =>
  collectInitiators(env.client, env.connection, projects, { lastScans, rules: {}, useDirectory: true, ...options });

test('a directory request that fails once (503 or a dropped connection) is retried, so everyone resolves first time', async () => {
  for (const hiccup of [503, 'drop']) {
    clearDirectoryCache();
    const env = await iam({ list: [hiccup, 'ok'] });
    try {
      const { byProject, unresolved } = await resolve(env);
      assert.deepEqual(unresolved, [], `after ${hiccup}`);
      assert.equal(byProject.p1.email, 'andy.schmit@checkmarx.com');
      assert.equal(byProject.p2.via, 'directory');
    } finally {
      env.close();
    }
  }
});

test('when the directory listing cannot be read, each unresolved username is looked up exactly', async () => {
  clearDirectoryCache();
  const env = await iam({ list: [500] });
  try {
    const { byProject, unresolved } = await resolve(env);
    assert.deepEqual(unresolved, []);
    assert.equal(byProject.p1.email, 'andy.schmit@checkmarx.com');
    assert.equal(env.calls.exact, 2);
  } finally {
    env.close();
  }
});

test('when IAM cannot be reached at all, the address a username resolved to before is used', async () => {
  clearDirectoryCache();
  const memory = new KnownAddresses();
  const good = await iam({ list: ['ok'] });
  try {
    await resolve(good, { memory });
  } finally {
    good.close();
  }
  assert.equal(memory.get('CX-Andy-Schmit'), 'andy.schmit@checkmarx.com');

  clearDirectoryCache();
  const down = await iam({ list: [500], exact: 'fail' });
  try {
    const { byProject, unresolved } = await resolve(down, { memory });
    assert.deepEqual(unresolved, []);
    assert.deepEqual([byProject.p1.email, byProject.p1.via], ['andy.schmit@checkmarx.com', 'remembered']);
  } finally {
    down.close();
  }
});

test('the directory is reused for a while, and a failed re-read falls back to the last good copy', async () => {
  clearDirectoryCache();
  const env = await iam({ list: ['ok', 500] });
  try {
    assert.equal((await fetchDirectory(env.client, env.connection)).users.length, 2);
    assert.equal((await fetchDirectory(env.client, env.connection)).users.length, 2);
    assert.equal(env.calls.list, 1, 'second read served from the cache');
    const stale = await fetchDirectory(env.client, env.connection, { cacheMs: 0 });
    assert.equal(stale.users.length, 2);
    assert.equal(stale.note, null);
  } finally {
    env.close();
  }
});
