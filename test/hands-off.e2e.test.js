// Hands-off mode and self-healing, end to end: the wizard turns it on, the weekly
// status arrives with one-click links that act only after a confirm, a reply with
// one word steers MissionZero (only from the address the email went to), and the
// self-check notices Checkmarx One going away, tells the Admin, raises a support
// case to forward, hears that it works again, and the case closes from a link.
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
const inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-'));
const children = [];
let mock;
let log = '';
let smtp;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const startMock = () => {
  mock = spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '2', RISKS: '2' }, stdio: 'ignore' });
  children.push(mock);
};

let cookie = '';
async function admin(method, url, body) {
  const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** A message's readable text: quoted-printable undone. */
const readable = (raw) => raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const mailTo = (address, pattern) => smtp.messages.filter((m) => m.to.includes(address) && (!pattern || pattern.test(readable(m.raw))));
async function until(check, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`timed out\n${log.slice(-3000)}`);
}
const linkFor = (message, label) => {
  const text = readable(message.raw);
  return new RegExp(`${label}: (http\\S+/a/[A-Za-z0-9_.-]+)`).exec(text)?.[1];
};

test.before(async () => {
  smtp = await fakeSmtp();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hands-off-'));
  // Auto-update on, and the last update check reached the internet: a lasting problem raises a case.
  fs.mkdirSync(path.join(dataDir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'app', 'update-settings.json'), JSON.stringify({ auto: true }));
  fs.writeFileSync(path.join(dataDir, 'app', 'published.json'), JSON.stringify({ at: new Date().toISOString(), versions: [] }));
  startMock();
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', HTTPS: 'off', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: mockApiKey({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' }), CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme',
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD, REPORT_SERVER_URL: BASE,
      WATCHDOG_EVERY_SECONDS: '600', INBOX_EVERY_SECONDS: '1', MZ_TEST_INBOX_DIR: inbox, MAINTAINER_EMAIL: 'maintainer@vendor.example',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  children.push(server);
  await until(() => /Successfully authenticated/.test(log) && /First administrator created/.test(log));
  await admin('POST', '/api/session/password', { email: 'admin@acme.io', password: FIRST_PASSWORD });
  await admin('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD });
  await admin('PUT', '/api/settings', { smtp: { host: '127.0.0.1', port: smtp.port, secure: false, requireAuth: true, user: 'mz@acme.io', password: 'x', rejectUnauthorized: false, fromAddress: 'mz@acme.io', fromName: 'MissionZero' } });
  assert.equal((await admin('POST', '/api/settings/connections/check', { rollback: false })).body.smtp.ok, true);
});

test.after(async () => {
  for (const child of children) child.kill();
  await smtp?.close();
});

test('the wizard turns hands-off on: reminders, who gets the status, replies', async () => {
  const off = await admin('GET', '/api/hands-off');
  assert.equal(off.body.handsOff.on, false);
  assert.equal(off.body.ready.cxone, true);
  assert.equal((await admin('PUT', '/api/hands-off', { handsOff: { statusHour: 30 } })).status, 400);
  const saved = await admin('PUT', '/api/hands-off', {
    handsOff: { statusTo: 'lead@acme.io', statusDay: 1, statusHour: 8, replies: true },
    automation: { enabled: true, thresholds: '30, 60', severities: ['CRITICAL', 'HIGH'], intervalMinutes: 1440 },
    audience: 'both',
    monthlyTo: 'ciso@acme.io',
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.handsOff.on, true);
  assert.deepEqual(saved.body.handsOff.statusTo, ['lead@acme.io']);
  assert.equal(saved.body.automation.enabled, true);
  assert.deepEqual(saved.body.automation.thresholds, [30, 60]);
  assert.equal(saved.body.audience, 'both');
  assert.deepEqual((await admin('GET', '/api/settings')).body.impact.monthlyTo, ['ciso@acme.io']);
});

test('the status email: one-click links act only after the confirm, for the person they were sent to', async () => {
  assert.equal((await admin('POST', '/api/hands-off/status')).body.sent, 1);
  const status = mailTo('lead@acme.io', /this week/).at(-1);
  assert.ok(status, 'the status went out');
  assert.match(readable(status.raw), /Reminders sent/);
  assert.match(readable(status.raw), /MZR-[A-Za-z0-9]{12}/, 'it carries the reply reference');
  const pause = linkFor(status, 'Pause for 7 days');
  assert.ok(pause, readable(status.raw));

  // Opening the link (as a mail scanner would) does nothing.
  const page = await fetch(pause);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Pause MissionZero for 7 days\?/);
  assert.equal((await admin('GET', '/api/hands-off')).body.paused, false);
  // The button does it.
  const done = await fetch(pause, { method: 'POST' });
  assert.match(await done.text(), /Paused/);
  assert.equal((await admin('GET', '/api/hands-off')).body.paused, true);
  // A changed link is refused.
  const forged = await fetch(pause.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), { method: 'POST' });
  assert.equal(forged.status, 404);
});

test('a reply with one word steers it, only from the address the email went to', async () => {
  const status = mailTo('lead@acme.io', /this week/).at(-1);
  const subject = /^Subject: (.*)$/m.exec(status.raw)[1];
  const reference = /MZR-[A-Za-z0-9]{12}/.exec(readable(status.raw))[0];
  // Someone else replying with the lead's reference is ignored.
  fs.writeFileSync(path.join(inbox, '1.json'), JSON.stringify({ from: 'mallory@evil.example', subject: `Re: ${subject}`, text: `resume\n\n> ${reference}` }));
  // An out-of-office never gets an answer.
  fs.writeFileSync(path.join(inbox, '2.json'), JSON.stringify({ from: 'lead@acme.io', subject: `Automatic reply: ${subject}`, text: 'resume' }));
  await until(() => !fs.readdirSync(inbox).length);
  await sleep(1500);
  assert.equal((await admin('GET', '/api/hands-off')).body.paused, true, 'still paused');
  assert.equal(mailTo('mallory@evil.example').length, 0);

  fs.writeFileSync(path.join(inbox, '3.json'), JSON.stringify({ from: 'lead@acme.io', subject: `Re: ${subject}`, text: `Resume please\n\nOn Monday MissionZero wrote:\n> ${reference}` }));
  await until(async () => (await admin('GET', '/api/hands-off')).body.paused === false);
  await until(() => mailTo('lead@acme.io', /Resumed/).length);
  const audit = (await admin('GET', '/api/audit?types=settings&limit=50')).body.entries.map((e) => e.reason).join('\n');
  assert.match(audit, /lead@acme\.io asked by email to resume/);
});

test('self-check: Checkmarx One goes away, the Admin is told, a case is raised to forward, it recovers, the case closes from a link', async () => {
  mock.kill();
  await sleep(300);
  for (let i = 0; i < 3; i++) await admin('POST', '/api/hands-off/check');
  const health = (await admin('GET', '/api/hands-off')).body.health;
  const problem = health.problems.find((p) => p.key.startsWith('cxone:'));
  assert.ok(problem, JSON.stringify(health));
  assert.ok(problem.tried.includes('Signed in to Checkmarx One again'), 'it tried to repair it first');
  assert.ok(mailTo('admin@acme.io', /needs attention/).length, 'the Admin was told');
  const caseMail = await until(() => mailTo('admin@acme.io', /forward this email/).at(-1));
  const text = readable(caseMail.raw);
  assert.match(text, /maintainer@vendor\.example/);
  assert.match(text, /SUP-0001/);
  assert.match(caseMail.raw, /troubleshooting\.json/, 'with the troubleshooting log attached');
  assert.equal(mailTo('maintainer@vendor.example').length, 0, 'never sent outside by itself');

  startMock();
  await until(async () => {
    await admin('POST', '/api/hands-off/check');
    return !(await admin('GET', '/api/hands-off')).body.health.problems.length;
  });
  assert.ok(mailTo('admin@acme.io', /working again/).length);

  const solved = linkFor(caseMail, 'Mark as solved');
  assert.match(await (await fetch(solved, { method: 'POST' })).text(), /SUP-0001 is closed/);
  assert.equal((await admin('GET', '/api/support/SUP-0001')).body.request.status, 'completed');
});
