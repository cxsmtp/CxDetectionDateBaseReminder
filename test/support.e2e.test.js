// Get help, end to end: a person raises a support case and an enhancement, gets
// a number by email, the support team (support.manage) hears of it, answers and
// moves it on, and nobody else can see it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';
import { fakeSmtp } from './fake-smtp.js';
import { FIRST_PASSWORD, NEXT_PASSWORD, mockApiKey } from './test-credentials.js';

const MOCK_PORT = await freePort();
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const children = [];
let log = '';
let smtp;

function browser() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
const admin = browser();
const uma = browser();
const ola = browser();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The mail the fake server got for `address`, newest last. */
const mailTo = (address) => smtp.messages.filter((m) => m.to.includes(address));

test.before(async () => {
  smtp = await fakeSmtp();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'support-'));
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '1', RISKS: '2' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: mockApiKey({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' }), CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme',
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD, REPORT_SERVER_URL: 'https://mz.acme.io',
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
  await admin('POST', '/api/session/password', { email: 'admin@acme.io', password: FIRST_PASSWORD });
  await admin('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD });
  await admin('PUT', '/api/settings', { smtp: { host: '127.0.0.1', port: smtp.port, secure: false, requireAuth: false, rejectUnauthorized: false, fromAddress: 'mz@acme.io', fromName: 'CxMissionZero' } });
  assert.equal((await admin('POST', '/api/settings/connections/check', { rollback: false })).body.smtp.ok, true);
  for (const [as, email] of [[uma, 'uma@acme.io'], [ola, 'ola@acme.io']]) {
    assert.equal((await admin('POST', '/api/iam/users', { email, name: email.split('@')[0], role: 'user', password: FIRST_PASSWORD })).status, 201);
    await as('POST', '/api/session/password', { email, password: FIRST_PASSWORD });
    assert.equal((await as('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD })).status, 200);
  }
});

test.after(async () => {
  for (const child of children) child.kill();
  await smtp?.close();
});

test('a support case: numbered, emailed to the person and the team, answered, completed; private to them', async () => {
  assert.equal((await uma('POST', '/api/support', { kind: 'case', subject: '', text: 'x' })).status, 400, 'a title');
  assert.equal((await uma('POST', '/api/support', { kind: 'other', subject: 'x', text: 'x' })).status, 400, 'a known kind');

  const raised = await uma('POST', '/api/support', { kind: 'case', subject: 'Reminders stopped', text: 'Nothing has been sent since Monday.\nSteps: open the Dashboard.', priority: 'high' });
  assert.equal(raised.status, 201, JSON.stringify(raised.body));
  const { id } = raised.body.request;
  assert.equal(id, 'SUP-0001');
  assert.equal(raised.body.request.status, 'new');
  assert.equal(raised.body.request.priority, 'high');
  assert.equal(raised.body.emailed.error, '', raised.body.emailed.error);
  // The person gets their number and a link to follow it; the team (the Admin holds support.manage) hears of it.
  const confirmation = mailTo('uma@acme.io').at(-1);
  assert.match(confirmation.raw, /SUP-0001/);
  assert.match(confirmation.raw, /https:\/\/mz\.acme\.io\/#\/help\/SUP-0001/);
  assert.match(mailTo('admin@acme.io').at(-1).raw, /SUP-0001/);
  assert.equal(mailTo('ola@acme.io').length, 0, 'not to other people');

  // Who sees it: the person and the team, nobody else.
  const mine = await uma('GET', '/api/support');
  assert.equal(mine.body.team, false);
  assert.deepEqual(mine.body.requests.map((r) => r.id), [id]);
  assert.deepEqual((await ola('GET', '/api/support')).body.requests, []);
  assert.equal((await ola('GET', `/api/support/${id}`)).status, 404);
  assert.equal((await ola('POST', `/api/support/${id}/messages`, { text: 'me too' })).status, 404);
  const queue = await admin('GET', '/api/support');
  assert.equal(queue.body.team, true);
  assert.equal(queue.body.requests[0].mine, false);

  // The team answers and asks for more: the person gets an email.
  const before = mailTo('uma@acme.io').length;
  const answer = await admin('POST', `/api/support/${id}/messages`, { text: 'Which project?' });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.request.conversation.at(-1).team, true);
  assert.equal((await admin('POST', `/api/support/${id}/status`, { status: 'waiting' })).body.request.status, 'waiting');
  assert.equal(mailTo('uma@acme.io').length, before + 2, 'the answer and the status change');
  assert.match(mailTo('uma@acme.io').at(-1).raw, /Waiting for reply/);

  // Only the team moves it on; the person's answer sends it back to them.
  assert.equal((await uma('POST', `/api/support/${id}/status`, { status: 'completed' })).status, 403);
  const teamMail = mailTo('admin@acme.io').length;
  const reply = await uma('POST', `/api/support/${id}/messages`, { text: 'Project 0.' });
  assert.equal(reply.body.request.status, 'in-progress');
  assert.equal(mailTo('admin@acme.io').length, teamMail + 1);
  assert.equal((await admin('POST', `/api/support/${id}/status`, { status: 'nonsense' })).status, 400);
  const done = await admin('POST', `/api/support/${id}/status`, { status: 'completed' });
  assert.equal(done.body.request.status, 'completed');
  assert.deepEqual(done.body.request.history.map((h) => h.status), ['new', 'waiting', 'in-progress', 'completed']);
  assert.match(mailTo('uma@acme.io').at(-1).raw, /Completed/);
  const full = await uma('GET', `/api/support/${id}`);
  assert.equal(full.body.request.conversation.length, 3);
});

test('an enhancement has its own numbers, and support.manage is a permission the matrix lists', async () => {
  const raised = await ola('POST', '/api/support', { kind: 'enhancement', subject: 'Export to Jira', text: 'One click per finding.' });
  assert.equal(raised.status, 201);
  assert.equal(raised.body.request.id, 'ENH-0001');
  assert.equal(raised.body.request.priority, '');
  assert.match(mailTo('ola@acme.io').at(-1).raw, /ENH-0001/);
  const second = await uma('POST', '/api/support', { kind: 'case', subject: 'Another', text: 'x' });
  assert.equal(second.body.request.id, 'SUP-0002');
  const roles = await admin('GET', '/api/iam');
  assert.ok(JSON.stringify(roles.body).includes('support.manage'));
  assert.equal((await admin('GET', '/api/support')).body.requests.length, 3);
});
