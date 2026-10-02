// Settings save as typed; a connection that does not work is rolled back to
// the last known good one — when the editor leaves Settings, or the server
// finds it later — and every administrator is told once. Also: configuring
// from an uploaded .env file, and the credit pool and usage the Credits page shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';
import { fakeSmtp } from './fake-smtp.js';

const MOCK_PORT = await freePort();
const PORT = await freePort();
const CLOSED_PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const KEY = (() => {
  const e = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${e({ alg: 'none' })}.${e({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' })}.sig`;
})();
const PW = 'correct horse battery';
const children = [];
const closers = [];
let log = '';
let smtp;
let silent;

function browser() {
  let cookie = '';
  return async (method, url, body) => {
    const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
}
const admin = browser();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mail = (port) => ({ host: '127.0.0.1', port, secure: false, requireAuth: false, rejectUnauthorized: false, fromAddress: 'mz@acme.io', fromName: 'Mission Zero' });

test.before(async () => {
  smtp = await fakeSmtp();
  silent = await fakeSmtp({ silent: true });
  closers.push(smtp.close, silent.close);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-e2e-'));
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '2', RISKS: '6' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: KEY, CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme', REPORT_SIGNING_KEY: 'guard-test',
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: 'temporary password 1', CONNECTION_CHECK_TIMEOUT_MS: '1500',
      SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '',
    },
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
  await admin('POST', '/api/session/password', { email: 'admin@acme.io', password: 'temporary password 1' });
  await admin('POST', '/api/me/password', { current: 'temporary password 1', next: PW });
});

test.after(() => {
  for (const child of children) child.kill();
  for (const close of closers) close();
});

test('the Automation panel reports the integration and mail server as they are now', async () => {
  const before = (await admin('GET', '/api/automation')).body;
  assert.equal(before.integration.connected, true);
  assert.equal(before.integration.connection.tenant, 'acme');
  assert.equal(before.smtpVerified, false);
  await admin('PUT', '/api/settings', { smtp: mail(smtp.port) });
  const check = (await admin('POST', '/api/settings/connections/check', { rollback: false })).body;
  assert.equal(check.smtp.ok, true, JSON.stringify(check));
  const after = (await admin('GET', '/api/automation')).body;
  assert.equal(after.smtpVerified, true, 'a passing check unlocks sending at once');
  assert.equal(after.connections.lastGood.smtp.port, smtp.port);
  assert.equal(after.connections.lastGood.cxone.source, 'environment', 'the CX_API_KEY connection is the first last known good one');
});

test('a mail server that does not work stays saved while editing, and is rolled back on leaving Settings', async () => {
  await admin('PUT', '/api/settings', { smtp: { port: CLOSED_PORT } });
  const status = (await admin('GET', '/api/settings/connections')).body;
  assert.deepEqual(status.pending, { cxone: false, smtp: true });

  const editing = (await admin('POST', '/api/settings/connections/check', { rollback: false })).body;
  assert.equal(editing.smtp.ok, false);
  assert.equal(editing.smtp.rolledBack, undefined, 'still editing: kept so it can be corrected');
  assert.equal((await admin('GET', '/api/settings')).body.smtp.port, CLOSED_PORT);
  // Meanwhile reminders still go out, through the last known good mail server.
  assert.equal((await admin('GET', '/api/scan')).status, 200);
  const preview = await admin('POST', '/api/reminders', { dryRun: true, groupBy: 'none', to: 'team@acme.io' });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.canSend, true, 'sending is not stopped by an edit in progress');

  const leaving = (await admin('POST', '/api/settings/connections/check', { rollback: true })).body;
  assert.equal(leaving.smtp.rolledBack, true);
  assert.equal(leaving.notice.parts[0].part, 'smtp');
  assert.equal(leaving.notice.parts[0].restored.port, smtp.port);
  assert.equal(leaving.notice.parts[0].attempted.port, CLOSED_PORT);
  const settings = (await admin('GET', '/api/settings')).body;
  assert.equal(settings.smtp.port, smtp.port);
  assert.equal(settings.verified, true, 'the last known good settings send at once');
  assert.equal((await admin('GET', '/api/me')).body.configNotices.length, 0, 'the editor saw it as it happened');
});

test('a connection timeout rolls back too, and the administrator is told at the next sign-in', async () => {
  await admin('PUT', '/api/settings', { smtp: { port: silent.port } });
  // The tab was closed on Settings: nobody saw the outcome.
  const result = (await admin('POST', '/api/settings/connections/check', { rollback: true, present: false })).body;
  assert.equal(result.smtp.rolledBack, true);
  assert.equal(result.smtp.timedOut, true, JSON.stringify(result.smtp));

  const next = browser();
  const me = (await next('POST', '/api/session/password', { email: 'admin@acme.io', password: PW })).body;
  assert.equal(me.configNotices.length, 1);
  const [notice] = me.configNotices;
  assert.match(notice.parts[0].error, /timed out/);
  assert.deepEqual(notice.parts[0].restored, { host: '127.0.0.1', port: smtp.port, secure: false, user: '', fromName: 'Mission Zero', fromAddress: 'mz@acme.io' });
  assert.equal((await next('POST', '/api/settings/notices/ack', { ids: [notice.id] })).body.acknowledged, 1);
  assert.equal((await next('GET', '/api/me')).body.configNotices.length, 0, 'shown once');
  const audit = (await admin('GET', '/api/audit?types=settings&limit=50')).body.entries.map((e) => e.reason).join('\n');
  assert.match(audit, /Rolled back to the last known good mail server settings/);
});

test('a Checkmarx One key saved as typed is not used until it works, and a bad one goes back to the last good connection', async () => {
  // Endpoints nothing answers on: as wrong as a wrong key, without a real Checkmarx One to refuse it.
  const nowhere = `http://127.0.0.1:${CLOSED_PORT}`;
  const draft = await admin('PUT', '/api/integration/cxone/draft', { apiKey: 'not-a-real-key', baseUrl: nowhere, iamUrl: nowhere, tenant: 'nowhere' });
  assert.equal(draft.status, 200);
  assert.equal(draft.body.pending, true);
  assert.equal(draft.body.connected, true, 'the running connection is untouched while the new key waits');
  assert.equal((await admin('GET', '/api/scan')).status, 200, 'the utility keeps working meanwhile');

  const leaving = (await admin('POST', '/api/settings/connections/check', { rollback: true })).body;
  assert.equal(leaving.cxone.rolledBack, true, JSON.stringify(leaving));
  assert.equal(leaving.notice.parts[0].restored.tenant, 'acme');
  const integration = (await admin('GET', '/api/integration')).body;
  assert.equal(integration.keyStored, false, 'back to the CX_API_KEY connection');
  assert.equal(integration.pending, false);
  assert.equal(integration.connection.tenant, 'acme');
});

test('a working key saved as typed becomes the integration and the last known good one', async () => {
  await admin('PUT', '/api/integration/cxone/draft', { apiKey: KEY, baseUrl: MOCK, iamUrl: MOCK, tenant: 'acme' });
  const check = (await admin('POST', '/api/settings/connections/check', { rollback: false })).body;
  assert.equal(check.cxone.ok, true, JSON.stringify(check));
  const integration = (await admin('GET', '/api/integration')).body;
  assert.equal(integration.source, 'stored');
  assert.equal(integration.pending, false);
  assert.equal(integration.lastGood.tenant, 'acme');
});

test('a .env file configures the connections, and says what it could not use', async () => {
  const text = [
    '# exported from the old server',
    `SMTP_HOST=127.0.0.1`,
    `SMTP_PORT=${smtp.port}`,
    'SMTP_SECURE=false',
    'SMTP_REQUIRE_AUTH=false',
    'SMTP_USER=alerts-bot',
    'SMTP_FROM=alerts@acme.io',
    'REPORT_SERVER_URL=https://mz.acme.io/',
    'PORT=8080',
  ].join('\n');
  const r = await admin('POST', '/api/settings/import-env', { text });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.ignored, ['PORT']);
  assert.equal(r.body.check.smtp.ok, true, JSON.stringify(r.body.check));
  assert.equal(r.body.settings.smtp.fromAddress, 'alerts@acme.io');
  assert.equal(r.body.settings.links.reportServerUrl, 'https://mz.acme.io');
  assert.equal(r.body.settings.verified, true);
  assert.doesNotMatch(JSON.stringify(r.body), /SMTP_PASS=|not-a-real-key/);
  assert.equal((await admin('POST', '/api/settings/import-env', { text: 'NOTHING=1' })).status, 400);
});

test('the Settings page offers a sample .env that lists every setting an upload applies, and uploading it unfilled changes nothing', async () => {
  const r = await fetch(`${BASE}/sample.env`);
  assert.equal(r.status, 200);
  const sample = await r.text();
  for (const name of ['CX_API_KEY', 'CX_BASE_URL', 'CX_IAM_URL', 'CX_TENANT', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_REQUIRE_AUTH', 'SMTP_REJECT_UNAUTHORIZED', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_FROM_NAME', 'REPORT_SERVER_URL']) {
    assert.match(sample, new RegExp(`^${name}=$`, 'm'), `${name} is there, blank, ready to fill in`);
  }
  assert.equal(sample, fs.readFileSync('.env.example', 'utf8'), '.env.example is the same file');
  assert.match(fs.readFileSync('public/index.html', 'utf8'), /href="sample\.env" download="mission-zero\.env"/);
  const before = (await admin('GET', '/api/settings')).body.smtp;
  const blank = await admin('POST', '/api/settings/import-env', { text: sample });
  assert.equal(blank.status, 400);
  assert.match(blank.body.error, /Every setting in that file is blank/);
  assert.deepEqual((await admin('GET', '/api/settings')).body.smtp, before, 'nothing changed');
});

test('the credit pool is the master limit: projects are never given more than it has free', async () => {
  assert.equal((await admin('GET', '/api/scan')).status, 200);
  await admin('PUT', '/api/settings', { aiTriage: { monthlyCreditLimit: 1000, poolPeriod: 'all' } });
  let pool = (await admin('GET', '/api/credits')).body.pool;
  assert.equal(pool.limited, true);
  assert.equal(pool.period, 'all');
  assert.deepEqual(pool.used, { triage: 0, remediation: 0, total: 0 });
  assert.equal(pool.remaining, 1000);
  const free = pool.unallocated;

  const ok = await admin('POST', '/api/credits/allocate', { projectIds: ['p0'], triageAdd: 5 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  pool = (await admin('GET', '/api/credits')).body.pool;
  assert.equal(pool.unallocated, free - 5);

  const tooMuch = await admin('POST', '/api/credits/allocate', { projectIds: ['p0', 'p1'], triageAdd: Math.ceil(pool.unallocated / 2) + 1 });
  assert.equal(tooMuch.status, 409, JSON.stringify(tooMuch.body));
  assert.match(tooMuch.body.error, /left in the credit pool/);
  assert.equal((await admin('GET', '/api/credits')).body.pool.unallocated, pool.unallocated, 'nothing was given');
  const refused = (await admin('GET', '/api/audit?types=allocation&outcomes=refused')).body.entries;
  assert.equal(refused.length, 1);
});

test('usage over a period, for the Credits page', async () => {
  const r = await admin('GET', '/api/credits/usage?from=2026-01-01&to=2026-01-31');
  assert.equal(r.status, 200);
  assert.equal(r.body.bucket, 'day');
  assert.equal(r.body.series.length, 31);
  assert.ok(Array.isArray(r.body.allocations));
  assert.ok(r.body.pool);
  assert.equal((await admin('GET', '/api/credits/usage?from=2026-02-01&to=2026-01-01')).status, 400);
});
