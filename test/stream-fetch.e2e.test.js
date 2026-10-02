// Fetching streams: each project's row arrives as soon as it is read (NDJSON),
// then the full result. Until it is done, triage, remediation and credit
// allocation are refused for that session, and allowed again afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';

const MOCK_PORT = await freePort();
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const KEY = (() => {
  const e = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${e({ alg: 'none' })}.${e({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' })}.sig`;
})();
const children = [];
let log = '';
let cookie = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function admin(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-'));
  // Slow enough that the fetch is still running while the test acts on it.
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '120', PROJECTS: '6', RISKS: '3', INITIATORS: '2' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: KEY, CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme', REPORT_SIGNING_KEY: 'stream-test',
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: 'temporary password 1', SMTP_HOST: '', CX_FETCH_CONCURRENCY: '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  children.push(server);
  const end = Date.now() + 20000;
  while (!/Successfully authenticated/.test(log)) {
    if (Date.now() > end) throw new Error(log);
    await sleep(100);
  }
  await admin('POST', '/api/session/password', { email: 'admin@acme.io', password: 'temporary password 1' });
  await admin('POST', '/api/me/password', { current: 'temporary password 1', next: 'correct horse battery' });
});

test.after(() => {
  for (const child of children) child.kill();
});

test('rows stream in as projects are read; actions on the data wait for the end', async () => {
  const response = await fetch(`${BASE}/api/scan?stream=1`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  let checkedLock = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      events.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
    }
    // Mid-fetch: every action on the data is refused, with a reason the page can show.
    if (!checkedLock && events.some((e) => e.type === 'start') && !events.some((e) => e.type === 'done')) {
      checkedLock = true;
      for (const [url, body] of [
        ['/api/triage/run', { projectIds: ['p0'], severities: ['HIGH'] }],
        ['/api/remediation/run', { projectIds: ['p0'], severities: ['HIGH'] }],
        ['/api/credits/allocate', { projectIds: ['p0'], kind: 'triage', severities: ['HIGH'] }],
      ]) {
        const r = await admin('POST', url, body);
        assert.equal(r.status, 409, `${url} while fetching`);
        assert.equal(r.body.fetching, true, url);
        assert.match(r.body.error, /still being fetched/);
      }
    }
  }
  assert.ok(checkedLock, 'the lock was checked while the fetch was running');

  const types = events.map((e) => e.type);
  assert.equal(types[0], 'start');
  assert.equal(types.at(-1), 'done');
  const start = events[0];
  const rows = events.filter((e) => e.type === 'project').map((e) => e.project);
  assert.equal(start.total, 6);
  assert.equal(rows.length, 6, 'one row per project, before the end');
  assert.ok(rows.every((r) => r.projectId && r.counts && !('risks' in r)), 'rows carry the summary, not the findings');
  const done = events.at(-1);
  assert.deepEqual(done.projects.map((p) => p.projectId).sort(), rows.map((r) => r.projectId).sort());
  assert.equal(done.totals.projects, 6);
  assert.ok(done.projects.every((p) => p.initiator), 'the final result names who ran each latest scan');

  // Done: the lock is gone (any refusal now is about the request, not the fetch).
  const after = await admin('POST', '/api/triage/run', { projectIds: ['p0'], severities: ['HIGH'] });
  assert.notEqual(after.body?.fetching, true);
});

test('the plain (non-streaming) fetch still answers with one JSON reply', async () => {
  const r = await admin('GET', '/api/scan');
  assert.equal(r.status, 200);
  assert.equal(r.body.projects.length, 6);
  assert.equal(r.body.totals.projects, 6);
});
