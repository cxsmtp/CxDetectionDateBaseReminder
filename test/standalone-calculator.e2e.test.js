// The standalone calculator's download, for real: whoever may use the calculator gets one blank HTML file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';
import { FIRST_PASSWORD, NEXT_PASSWORD, mockApiKey } from './test-credentials.js';

const MOCK_PORT = await freePort();
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const KEY = mockApiKey({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' });
const children = [];
let log = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function browser() {
  let cookie = '';
  return async (method, url, body) => {
    const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: r.status, headers: r.headers, text, body: json };
  };
}
const admin = browser();
const user = browser();

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-calc-'));
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '2', RISKS: '2' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0', CX_API_KEY: KEY, CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme', ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD, GITHUB_TOKEN: '', GITLAB_TOKEN: '', AZURE_DEVOPS_TOKEN: '', BITBUCKET_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  children.push(server);
  const end = Date.now() + 15000;
  while (!/Successfully authenticated/.test(log)) {
    if (Date.now() > end) throw new Error(log);
    await sleep(100);
  }
  await admin('POST', '/api/session/password', { email: 'admin@acme.io', password: FIRST_PASSWORD });
  await admin('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD });
  assert.equal((await admin('POST', '/api/iam/users', { email: 'uma@acme.io', role: 'user', password: FIRST_PASSWORD })).status, 201);
  await user('POST', '/api/session/password', { email: 'uma@acme.io', password: FIRST_PASSWORD });
  await user('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD });
});

test.after(() => {
  for (const child of children) child.kill();
});

test('whoever may use the calculator downloads it on its own, blank, as one HTML file; others may not', async () => {
  await admin('POST', '/api/projections', { name: 'Secret Customer Ltd' });
  const r = await admin('GET', '/api/projections/standalone');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="cx-credits-calculator.html"/);
  assert.match(r.text, /<title>Cx Credits Calculator<\/title>/);
  assert.ok(!r.text.includes('Secret Customer Ltd'), 'blank: no customer of this server in it');
  assert.ok(!r.text.includes('admin@acme.io'), 'nobody of this server in it');
  assert.equal((await user('GET', '/api/projections/standalone')).status, 403);
});
