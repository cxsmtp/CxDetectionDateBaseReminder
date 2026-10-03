// Fail-safe: the same vulnerability is never sent for AI Triage twice, even
// when several requests (two tabs, two people, a report and the Dashboard)
// ask at the same moment. The mock Checkmarx One counts every result id sent.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A signed-in browser of its own (its own session). */
function browser() {
  let cookie = '';
  return async (method, url, body) => {
    const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Origin: BASE, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'once-'));
  // Slow triage calls, so two requests really overlap.
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '150', PROJECTS: '2', RISKS: '5', INITIATORS: '1' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: KEY, CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme', REPORT_SIGNING_KEY: 'once-test',
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: 'temporary password 1', SMTP_HOST: '',
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
});

test.after(() => {
  for (const child of children) child.kill();
});

test('two people triaging the same findings at once: each result is sent once', async () => {
  const first = browser();
  await first('POST', '/api/session/password', { email: 'admin@acme.io', password: 'temporary password 1' });
  await first('POST', '/api/me/password', { current: 'temporary password 1', next: 'correct horse battery' });
  const second = browser();
  await second('POST', '/api/session/password', { email: 'admin@acme.io', password: 'correct horse battery' });
  for (const who of [first, second]) assert.equal((await who('GET', '/api/scan')).status, 200);

  const ask = { projectIds: ['p0', 'p1'], severities: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] };
  const [a, b] = await Promise.all([first('POST', '/api/triage/run', ask), second('POST', '/api/triage/run', ask)]);
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(b.status, 200, JSON.stringify(b.body));

  const stats = await (await fetch(`${MOCK}/__stats`)).json();
  assert.ok(stats.resultsSent > 0, 'something was triaged');
  assert.equal(stats.maxSendsPerResult, 1, 'no result was sent twice');

  // And afterwards, asking again sends nothing new.
  const again = await first('POST', '/api/triage/run', ask);
  const after = await (await fetch(`${MOCK}/__stats`)).json();
  assert.equal(after.maxSendsPerResult, 1);
  assert.equal(after.resultsSent, stats.resultsSent);
  assert.ok(again.status === 200 || again.status === 409, JSON.stringify(again.body));
});
