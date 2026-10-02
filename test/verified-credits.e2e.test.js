// Credits needed are confirmed with Checkmarx One twice before any demand:
// "Refresh & verify" reads the findings and their result ids twice, and
// allocating "what is needed" refuses when the two reads disagree.
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
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Origin: BASE, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '2', RISKS: '6', INITIATORS: '1' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: KEY, CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme', REPORT_SIGNING_KEY: 'verify-test',
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
  await admin('POST', '/api/session/password', { email: 'admin@acme.io', password: 'temporary password 1' });
  await admin('POST', '/api/me/password', { current: 'temporary password 1', next: 'correct horse battery' });
  assert.equal((await admin('GET', '/api/scan')).status, 200);
});

test.after(() => {
  for (const child of children) child.kill();
});

test('refresh & verify: two agreeing reads give the exact results to triage', async () => {
  const r = await admin('POST', '/api/credits/verify', { projectIds: ['p0', 'p1'], severities: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (const v of r.body.verified) {
    assert.equal(v.agreed, true, JSON.stringify(v));
    assert.equal(v.reads[0], v.reads[1], 'both reads counted the same results');
    assert.ok(v.triage.results <= v.triage.rows, 'rows sharing a result are billed once');
    assert.ok(v.triage.results > 0);
  }
  assert.ok(r.body.projects.p0.verified.agreed);
});

test('allocating what is needed gives exactly the verified count', async () => {
  const r = await admin('POST', '/api/credits/allocate', { projectIds: ['p0'], allocate: ['triage'], ruleChanges: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((severity) => ({ severity, include: true })) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // The allocation used the reads it just made: what was given is what Checkmarx One confirmed.
  const verified = r.body.projects.p0;
  assert.equal(r.body.given, verified.triage.allocated);
  const again = (await admin('POST', '/api/credits/verify', { projectIds: ['p0'] })).body.verified[0];
  assert.equal(verified.triage.allocated, again.triage.results, 'allocated = results confirmed twice');
});

test('when Checkmarx One gives different answers on the two reads, nothing is allocated', async () => {
  await fetch(`${MOCK}/__changing?on=1`);
  try {
    const v = await admin('POST', '/api/credits/verify', { projectIds: ['p1'] });
    assert.equal(v.status, 200);
    assert.equal(v.body.verified[0].agreed, false);
    assert.match(v.body.verified[0].reason, /different results on the two reads/);

    const r = await admin('POST', '/api/credits/allocate', { projectIds: ['p1'], allocate: ['triage'] });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /could not be confirmed twice/);
  } finally {
    await fetch(`${MOCK}/__changing?on=0`);
  }
  // Settled again: allocation goes through.
  const ok = await admin('POST', '/api/credits/allocate', { projectIds: ['p1'], allocate: ['triage'] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('the troubleshooting log records the disagreement, and holds nothing sensitive', async () => {
  const r = await fetch(`${BASE}/api/diagnostics/download`, { headers: { Cookie: cookie } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="mission-zero-troubleshooting-MZ-/);
  const text = await r.text();
  const log = JSON.parse(text);
  assert.ok(log.discrepancies.byEvent['credit-verify-disagreed'] >= 1, 'the two disagreeing reads are in the log');
  assert.ok(log.features['POST /api/credits/verify']?.uses >= 1, 'feature usage is counted');
  assert.ok(log.recommendations.length >= 1);
  for (const leak of ['admin@acme.io', '127.0.0.1', 'Project 0', 'Project 1', KEY, 'correct horse battery', 'acme']) {
    assert.ok(!text.includes(leak), `the log must not contain ${leak}`);
  }
});

