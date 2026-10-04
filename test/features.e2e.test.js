// Making a Beta feature final, for real: an Admin promotes "Code authors"; from then on
// someone who may only send reminders can use it, scheduled reminders can email the code
// authors, and the change is audited. Only an Admin may change a stage.
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

/** A browser of its own (its own cookie). */
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
const user = browser();

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'features-'));
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '2', RISKS: '4' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: KEY, CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme',
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: 'temporary password 1',
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
  await admin('POST', '/api/me/password', { current: 'temporary password 1', next: 'correct horse battery' });
  assert.equal((await admin('POST', '/api/iam/users', { email: 'uma@acme.io', role: 'user', password: 'temporary password 1' })).status, 201);
  await user('POST', '/api/session/password', { email: 'uma@acme.io', password: 'temporary password 1' });
  assert.equal((await user('POST', '/api/me/password', { current: 'temporary password 1', next: 'correct horse battery' })).status, 200);
});

test.after(() => {
  for (const child of children) child.kill();
});

test('while Beta: only people with Beta access can use it, and the Admin sees the switch', async () => {
  const list = await admin('GET', '/api/features');
  assert.equal(list.status, 200);
  assert.equal(list.body.canManage, true);
  assert.deepEqual(list.body.features.map((f) => [f.id, f.stage]), [['codeAuthors', 'beta'], ['sla', 'beta'], ['identityMatching', 'beta']]);
  const me = (await user('GET', '/api/me')).body;
  assert.equal(me.features.codeAuthors, 'beta');
  assert.ok(!me.permissions.includes('feature.codeAuthors'));
  assert.equal((await user('POST', '/api/beta/authors/find', {})).status, 403);
  assert.equal((await user('GET', '/api/features')).body.canManage, false);
});

test('only an Admin can make it final; then whoever may send reminders can use it, and it is audited', async () => {
  assert.equal((await user('PUT', '/api/features/codeAuthors', { stage: 'final' })).status, 403);
  assert.equal((await admin('PUT', '/api/features/codeAuthors', { stage: 'gold' })).status, 400);
  assert.equal((await admin('PUT', '/api/features/nope', { stage: 'final' })).status, 404);
  const made = await admin('PUT', '/api/features/codeAuthors', { stage: 'final' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.features[0].stage, 'final');
  assert.equal(made.body.features[0].changedBy, 'admin@acme.io');

  const me = (await user('GET', '/api/me')).body;
  assert.equal(me.features.codeAuthors, 'final');
  assert.ok(me.permissions.includes('feature.codeAuthors'));
  assert.ok(!me.permissions.includes('feature.identityMatching'), 'the other one is still Beta');
  // Allowed now: it only asks for a fetch first.
  assert.equal((await user('POST', '/api/beta/authors/find', {})).status, 409);
  assert.equal((await user('GET', '/api/beta/scm/logins?provider=github')).status, 403, 'identity matching is still Beta');

  const audit = await admin('GET', '/api/audit?type=system');
  const reasons = (audit.body.entries ?? audit.body.events ?? []).map((e) => e.reason).join('\n');
  assert.match(reasons, /Code authors \(git blame\)” made final/);
});

test('scheduled reminders also look up the code authors of what crossed, once switched on', async () => {
  const saved = await admin('PUT', '/api/automation', { notifyCodeAuthors: true, dryRun: true, mode: 'digest', thresholds: '1' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.config.notifyCodeAuthors, true);
  const ran = await admin('POST', '/api/automation/run', {});
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  const run = ran.body.run;
  assert.ok(run.crossed > 0, JSON.stringify(run));
  assert.ok(run.codeAuthors && typeof run.codeAuthors.findings === 'number', JSON.stringify(run.codeAuthors));
  assert.ok(!run.codeAuthors.error, run.codeAuthors.error);
});

test('back to Beta: access closes again, and scheduled runs leave the code authors alone', async () => {
  assert.equal((await admin('PUT', '/api/features/codeAuthors', { stage: 'beta' })).status, 200);
  assert.equal((await user('POST', '/api/beta/authors/find', {})).status, 403);
  const run = (await admin('POST', '/api/automation/run', {})).body.run;
  assert.match(run.codeAuthors?.skipped ?? '', /still a Beta feature/);
});

test('SLAs (Beta): only those who may use them change them; fetched projects carry overdue and due-soon; runs escalate once', async () => {
  // Not for someone without Beta access, while Beta.
  assert.ok(!(await user('GET', '/api/me')).body.permissions.includes('feature.sla'));
  const refused = await user('PUT', '/api/settings', { sla: { days: { CRITICAL: 1 } } });
  assert.ok(refused.status === 403 || refused.body?.ignored?.includes('sla') || refused.body?.sla?.days?.CRITICAL !== 1, JSON.stringify(refused.body).slice(0, 200));

  const set = await admin('PUT', '/api/settings', { sla: { days: { CRITICAL: 2, HIGH: 2, MEDIUM: 2, LOW: 2 }, escalate: true, escalateTo: 'lead@acme.io' } });
  assert.equal(set.status, 200, JSON.stringify(set.body).slice(0, 300));
  assert.deepEqual(set.body.sla.days, { CRITICAL: 2, HIGH: 2, MEDIUM: 2, LOW: 2 });
  assert.deepEqual(set.body.sla.escalateTo, ['lead@acme.io']);

  const scan = await admin('GET', '/api/scan');
  assert.equal(scan.status, 200);
  const overdue = scan.body.projects.reduce((n, p) => n + p.sla.overdue, 0);
  assert.ok(overdue > 0, 'the mock findings are weeks old: past a 2-day SLA');
  assert.equal(scan.body.totals.sla.overdue, overdue);
  const last = await admin('GET', '/api/scan/last');
  assert.equal(last.body.totals.sla.overdue, overdue, 'a reload shows them as they are now');

  // Test mode: counted, nothing sent, nothing remembered.
  await admin('PUT', '/api/automation', { dryRun: true, notifyCodeAuthors: false });
  const run = (await admin('POST', '/api/automation/run', {})).body.run;
  assert.equal(run.escalation?.dryRun, true, JSON.stringify(run));
  assert.ok(run.escalation.escalated > 0);
  const again = (await admin('POST', '/api/automation/run', {})).body.run;
  assert.equal(again.escalation.escalated, run.escalation.escalated, 'test mode remembered nothing, so the same findings are counted again');

  // Escalation off: nothing about SLAs in the run.
  await admin('PUT', '/api/settings', { sla: { escalate: false } });
  const off = (await admin('POST', '/api/automation/run', {})).body.run;
  assert.equal(off.escalation, undefined);
});

test('who gets reminders is one choice: scheduled runs follow it, and "both" with an empty fixed list says so', async () => {
  const set = await admin('PUT', '/api/settings', { reminders: { audience: 'both' }, recipients: { to: '', cc: '', bcc: '' } });
  assert.equal(set.status, 200, JSON.stringify(set.body).slice(0, 200));
  assert.equal(set.body.reminders.audience, 'both');
  await admin('PUT', '/api/automation', { dryRun: true, mode: 'digest', thresholds: '1', notifyCodeAuthors: false });
  const run = (await admin('POST', '/api/automation/run', {})).body.run;
  assert.ok(run.crossed > 0, JSON.stringify(run));
  assert.ok((run.failures ?? []).some((f) => /fixed list is empty/.test(f.error)), JSON.stringify(run.failures));
  // Someone who may not change the list cannot change who gets reminders either.
  const theirs = await user('PUT', '/api/settings', { reminders: { audience: 'list' } });
  assert.notEqual(theirs.body?.reminders?.audience, 'list');
  await admin('PUT', '/api/settings', { reminders: { audience: 'initiator' } });
});
