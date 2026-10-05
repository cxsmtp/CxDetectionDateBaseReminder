// Updating without losing anything: the running server is stopped the way a
// container update stops it (SIGTERM), and a new one starts on the same data
// folder. People signed in stay signed in, with the data they fetched, and
// credits allocated before the update are still there. Two servers can never
// share one data folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { freePort } from './free-port.js';
import { HANDOVER_FILE, SessionPersistence, sessionKey } from '../src/handover.js';
import { InstanceLock, LOCK_FILE } from '../src/instance-lock.js';
import { FIRST_PASSWORD, NEXT_PASSWORD, mockApiKey } from './test-credentials.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('saved sign-ins: ids only hashed, fetched data saved apart and read back with its dates, ended ones deleted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-'));
  const store = new SessionPersistence(dir);
  const key = sessionKey('secret-session-id');
  const scan = { projects: [{ projectId: 'p1' }], detectionWindow: { from: new Date('2026-01-01T00:00:00Z'), to: null, label: 'x' } };
  store.saveIndex([{ key, userId: 'u1', via: 'password', createdAt: 1, lastUsedAt: Date.now() }]);
  store.saveScan(key, scan);
  await sleep(200);
  const files = fs.readdirSync(path.join(dir, 'sessions'));
  assert.deepEqual(files.sort(), [`${key}.scan.json.gz`, 'index.json'].sort());
  for (const name of files) {
    assert.equal(fs.statSync(path.join(dir, 'sessions', name)).mode & 0o777, 0o600);
    assert.ok(!fs.readFileSync(path.join(dir, 'sessions', name)).includes('secret-session-id'), 'the session id itself is never written');
  }
  const [entry] = new SessionPersistence(dir).load();
  assert.equal(entry.key, key);
  assert.ok(store.readScan(key).detectionWindow.from instanceof Date);
  store.forget(key);
  store.saveIndex([]);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'sessions')), ['index.json']);
  assert.deepEqual(new SessionPersistence(dir).load(), []);

  // A clean stop of MZ-01.00.10 left a handover file: read once, then gone.
  fs.writeFileSync(path.join(dir, HANDOVER_FILE), zlib.gzipSync(JSON.stringify({ version: 1, savedAt: Date.now(), sessions: [{ key, userId: 'u1', via: 'password', createdAt: 1, lastUsedAt: Date.now(), lastScan: scan }] })));
  const [legacy] = new SessionPersistence(dir).load();
  assert.ok(legacy.lastScan.detectionWindow.from instanceof Date);
  assert.equal(fs.existsSync(path.join(dir, HANDOVER_FILE)), false);
});

test('fetched data is saved at once, then at most every SESSION_SAVE_SECONDS; a stop writes what is still waiting', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-'));
  const store = new SessionPersistence(dir);
  const key = sessionKey('throttled');
  store.saveIndex([{ key, userId: 'u1', via: 'password', createdAt: 1, lastUsedAt: Date.now() }]);
  const scan = (n) => ({ projects: [{ projectId: `p${n}` }], detectionWindow: { from: null, to: null, label: 'x' } });
  store.saveScan(key, scan(1));
  await sleep(200);
  assert.equal(store.readScan(key).projects[0].projectId, 'p1', 'the first save is written at once');
  store.saveScan(key, scan(2));
  store.saveScan(key, scan(3));
  await sleep(200);
  assert.equal(store.readScan(key).projects[0].projectId, 'p1', 'later ones wait their turn');
  store.saveIndex([{ key, userId: 'u1', via: 'password', createdAt: 1, lastUsedAt: Date.now() }]);
  assert.ok(fs.existsSync(path.join(dir, 'sessions', `${key}.scan.json.gz`)), 'a waiting save keeps its file');
  store.flushSync();
  assert.equal(store.readScan(key).projects[0].projectId, 'p3', 'a stop writes the latest at once');
  store.forget(key);
});

test('instance lock: a live server keeps others out; a dead one is taken over; a clean stop frees it at once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-'));
  const first = await new InstanceLock(dir).acquire();
  await assert.rejects(new InstanceLock(dir).acquire({ waitMs: 300 }), /Another CxMissionZero server .* is using this data folder/);
  first.release();
  const second = await new InstanceLock(dir).acquire({ waitMs: 300 });
  second.release();
  assert.equal(fs.existsSync(path.join(dir, LOCK_FILE)), false);

  // A server that died without letting go: its heartbeat goes stale.
  fs.writeFileSync(path.join(dir, LOCK_FILE), JSON.stringify({ id: 'dead', host: 'old', beat: Date.now() - 60_000 }));
  const third = await new InstanceLock(dir).acquire({ waitMs: 300 });
  third.release();
});

test('a server update keeps people signed in with their fetched data, and keeps every credit', async (t) => {
  const MOCK_PORT = await freePort();
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
  const KEY = mockApiKey({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-'));
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ aiTriage: { enabled: true, remediationEnabled: true, monthlyCreditLimit: 0 } }));
  const mock = spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '3', RISKS: '4', INITIATORS: '2' }, stdio: 'ignore' });
  const servers = [];
  t.after(() => {
    mock.kill();
    for (const s of servers) s.kill('SIGKILL');
  });
  const start = (extra = {}) => {
    const server = spawn(process.execPath, ['src/server.js'], {
      env: {
        ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
        CX_API_KEY: KEY, CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme', REPORT_SIGNING_KEY: 'update-test',
        ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD, SMTP_HOST: '', INSTANCE_LOCK_STALE_SECONDS: '3', ...extra,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.log = '';
    server.stdout.on('data', (d) => (server.log += d));
    server.stderr.on('data', (d) => (server.log += d));
    server.exited = new Promise((resolve) => server.on('exit', (code) => resolve(code)));
    servers.push(server);
    return server;
  };
  const ready = async (server) => {
    const end = Date.now() + 20000;
    while (!/Successfully authenticated/.test(server.log)) {
      if (Date.now() > end) throw new Error(server.log);
      await sleep(100);
    }
  };
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  const v1 = start();
  await ready(v1);
  await call('POST', '/api/session/password', { email: 'admin@acme.io', password: FIRST_PASSWORD });
  await call('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD });
  const fetched = await call('GET', '/api/scan');
  assert.equal(fetched.status, 200);
  const allocated = await call('POST', '/api/credits/allocate', { projectIds: ['p0'], triageAdd: 5 });
  assert.equal(allocated.status, 200, JSON.stringify(allocated.body));
  const before = (await call('GET', '/api/credits')).body.pool;

  // A second server on the same data folder is refused while the first runs.
  const intruder = start({ PORT: String(await freePort()), INSTANCE_LOCK_WAIT_SECONDS: '1' });
  assert.equal(await intruder.exited, 1);
  assert.match(intruder.log, /Another CxMissionZero server .* is using this data folder/);

  // The update: stop the running server the way podman stop / --replace does.
  v1.kill('SIGTERM');
  assert.equal(await v1.exited, 0);
  assert.match(v1.log, /Saved 1 sign-in\(s\) and their fetched data for the next server/);
  assert.match(v1.log, /Stopped cleanly/);

  const v2 = start();
  await ready(v2);
  assert.match(v2.log, /Kept 1 sign-in\(s\) and their fetched data from before this start/);

  // Same browser cookie: still signed in, with the data fetched before the update.
  const me = await call('GET', '/api/session');
  assert.equal(me.body?.signedIn, true, JSON.stringify(me.body));
  assert.equal(me.body.hasScan, true, 'the fetched data came across');
  const verify = await call('POST', '/api/credits/verify', { projectIds: ['p0'], severities: ['CRITICAL', 'HIGH'] });
  assert.equal(verify.status, 200, 'actions on the fetched data work without fetching again');
  assert.deepEqual((await call('GET', '/api/credits')).body.pool, before, 'every credit is where it was');

  // A crash (no clean stop at all): still signed in afterwards, with the data.
  await sleep(300);
  v2.kill('SIGKILL');
  await v2.exited;
  const v3 = start();
  await ready(v3);
  assert.match(v3.log, /Kept 1 sign-in\(s\)/);
  const again = await call('GET', '/api/session');
  assert.equal(again.body?.signedIn, true, 'a crash does not sign anyone out');
  assert.equal(again.body.hasScan, true);

  // A cookie that was never signed in gets nothing.
  const stranger = await fetch(`${BASE}/api/session`, { headers: { Cookie: 'cxdr_sid=made-up' } });
  assert.notEqual((await stranger.json()).signedIn, true);

  // Signing out is final: after another restart that browser is signed out.
  await call('DELETE', '/api/session');
  v3.kill('SIGTERM');
  await v3.exited;
  const v4 = start();
  await ready(v4);
  assert.notEqual((await call('GET', '/api/session')).body?.signedIn, true, 'signed out stays signed out');
});
