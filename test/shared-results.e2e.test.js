// Several findings can be one Checkmarx One result: more than one code path
// (data flow) into the same vulnerable code. The Dashboard's credit needs say
// which ones, so they are triaged, charged and fixed together.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';
import { FIRST_PASSWORD, NEXT_PASSWORD, mockApiKey } from './test-credentials.js';

test('the credit needs name the findings that are one result, with where they are', async (t) => {
  const MOCK_PORT = await freePort();
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
  const KEY = mockApiKey({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-'));
  // 8 findings: 0–3 and their twins 4–7 (same similarity group): 4 results.
  const mock = spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '1', RISKS: '8', SHARED: '1' }, stdio: 'ignore' });
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: KEY, CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme', REPORT_SIGNING_KEY: 'shared-test',
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD, SMTP_HOST: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    mock.kill();
    server.kill();
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const end = Date.now() + 15000;
  while (!/Successfully authenticated/.test(log)) {
    if (Date.now() > end) throw new Error(log);
    await new Promise((r) => setTimeout(r, 100));
  }
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return r.json().catch(() => null);
  };
  await call('POST', '/api/session/password', { email: 'admin@acme.io', password: FIRST_PASSWORD });
  await call('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD });
  const scan = await call('GET', '/api/scan');
  const credits = scan.projects[0].credits;
  assert.equal(credits.toTriageRows.CRITICAL, 2);
  assert.equal(credits.toTriage.CRITICAL, 1, 'two findings, one result, one credit');
  const critical = credits.sharedResults.find((g) => g.severity === 'CRITICAL');
  assert.equal(critical.findings, 2);
  assert.equal(critical.title, 'Finding p0-r0');
  assert.deepEqual(critical.places, ['file0.js :: handler0', 'file0.js :: handler4'], 'where each code path ends');
  assert.ok(['result', 'group'].includes(critical.tie));
  assert.equal(credits.sharedResults.length, 4, 'every shared result is named');
});
