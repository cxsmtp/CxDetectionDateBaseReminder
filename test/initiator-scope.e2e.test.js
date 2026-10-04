// A scan initiator is only ever sent the projects they ran the latest scan of:
// whatever is selected, in every format (summary, one per project, interactive
// HTML report), from the Dashboard and from a tracked report. Every email the
// server sends is captured by a fake mail server and read back.
//
// The mock tenant: 4 projects, 2 people. dev0 ran p0 and p2; dev1 ran p1 and p3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';
import { decodeMessage, fakeSmtp } from './fake-smtp.js';

const MOCK_PORT = await freePort();
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const KEY = (() => {
  const e = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${e({ alg: 'none' })}.${e({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' })}.sig`;
})();
const OWNERS = { 'dev0@acme.com': ['Project 0', 'Project 2'], 'dev1@acme.com': ['Project 1', 'Project 3'] };
const ALL = ['Project 0', 'Project 1', 'Project 2', 'Project 3'];
const children = [];
let smtp;
let log = '';
let cookie = '';

async function admin(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The emails sent since the last call: {to, projects (named anywhere in the mail or its report), attachments}. */
function sentMail() {
  const mail = smtp.messages.splice(0).map((m) => {
    const decoded = decodeMessage(m.raw);
    const everything = `${decoded.subject}\n${decoded.text}\n${decoded.attachments.join('\n')}`;
    return {
      to: m.to.sort(),
      subject: decoded.subject,
      attachments: decoded.attachments.length,
      projects: ALL.filter((name) => new RegExp(`${name}(?!\\d)`).test(everything)),
    };
  });
  return mail.sort((a, b) => a.to.join().localeCompare(b.to.join()) || a.projects.join().localeCompare(b.projects.join()));
}

/** Each initiator got only (and exactly) their own projects; returns the mail for more checks. */
function assertScoped(mail, { perProject = false, html = false, only = null } = {}) {
  const people = only ?? Object.keys(OWNERS);
  const toPeople = mail.filter((m) => m.to.some((a) => a in OWNERS));
  for (const m of toPeople) {
    assert.equal(m.to.length, 1, `one initiator per email: ${JSON.stringify(m)}`);
    const owned = OWNERS[m.to[0]];
    for (const name of m.projects) assert.ok(owned.includes(name), `${m.to[0]} was sent ${name}, which they did not scan: ${JSON.stringify(m)}`);
    if (html) assert.equal(m.attachments, 1, `the report is attached: ${JSON.stringify(m)}`);
    if (perProject) assert.equal(m.projects.length, 1, `one project per email: ${JSON.stringify(m)}`);
  }
  for (const person of people) {
    const got = toPeople.filter((m) => m.to[0] === person).flatMap((m) => m.projects).sort();
    assert.deepEqual(got, OWNERS[person].filter((p) => mail.some((m) => m.projects.includes(p))), `${person} got all of their own projects`);
  }
  for (const person of Object.keys(OWNERS).filter((p) => !people.includes(p))) {
    assert.ok(!toPeople.some((m) => m.to[0] === person), `${person} was not picked and got nothing`);
  }
  return mail;
}

test.before(async () => {
  smtp = await fakeSmtp();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-'));
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '4', RISKS: '4', INITIATORS: '2' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: KEY, CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme', REPORT_SIGNING_KEY: 'scope-test',
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: 'temporary password 1', SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '',
      REPORT_SERVER_URL: 'https://mz.acme.io',
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
  await admin('PUT', '/api/settings', {
    smtp: { host: '127.0.0.1', port: smtp.port, secure: false, requireAuth: false, rejectUnauthorized: false, fromAddress: 'mz@acme.io' },
    // A Cc on the list: never copied on initiators' emails unless "copy the configured Cc/Bcc" is on.
    recipients: { to: 'lead@acme.io', cc: 'sean@acme.io' },
    initiators: { copyConfiguredRecipients: false },
  });
  assert.equal((await admin('POST', '/api/settings/connections/check', { rollback: false })).body.smtp.ok, true);
  const scan = await admin('GET', '/api/scan');
  assert.equal(scan.status, 200);
  assert.deepEqual(scan.body.projects.map((p) => [p.projectName, p.initiatorEmail]).sort(), [['Project 0', 'dev0@acme.com'], ['Project 1', 'dev1@acme.com'], ['Project 2', 'dev0@acme.com'], ['Project 3', 'dev1@acme.com']]);
  smtp.messages.length = 0;
});

test.after(() => {
  for (const child of children) child.kill();
  smtp?.close();
});

const EVERY_PROJECT = ['p0', 'p1', 'p2', 'p3'];

test('dashboard, summary to scan initiators: each gets one email with only their own projects', async () => {
  const r = await admin('POST', '/api/reminders', { projectIds: EVERY_PROJECT, groupBy: 'initiator' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const mail = assertScoped(sentMail());
  assert.equal(mail.length, 2);
  assert.deepEqual(r.body.sent.map((s) => [s.email, s.projects]).sort(), [['dev0@acme.com', ['Project 0', 'Project 2']], ['dev1@acme.com', ['Project 1', 'Project 3']]], 'the result says who got which projects');
  assert.ok(mail.every((m) => !m.to.includes('sean@acme.io')), 'the configured Cc is not copied');
});

test('dashboard, one email per project: each project only to the person who scanned it', async () => {
  const r = await admin('POST', '/api/reminders', { projectIds: EVERY_PROJECT, groupBy: 'project' });
  assert.equal(r.status, 200);
  assert.equal(assertScoped(sentMail(), { perProject: true }).length, 4);
});

test('dashboard, interactive HTML report to scan initiators: the email and the attached report hold only their projects', async () => {
  const r = await admin('POST', '/api/reminders/send-html-by-initiator', { projectIds: EVERY_PROJECT, groupBy: 'initiator' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const mail = assertScoped(sentMail(), { html: true });
  assert.equal(mail.length, 2);
  assert.deepEqual(r.body.sent.find((s) => s.email === 'dev0@acme.com').projects, ['Project 0', 'Project 2']);
});

test('dashboard, interactive HTML report, one per project', async () => {
  const r = await admin('POST', '/api/reminders/send-html-by-initiator', { projectIds: EVERY_PROJECT, groupBy: 'project' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(assertScoped(sentMail(), { html: true, perProject: true }).length, 4);
});

test('dashboard, interactive HTML report to both: initiators get their own, the recipient list gets everything', async () => {
  const r = await admin('POST', '/api/reminders/send-html-by-initiator', { projectIds: EVERY_PROJECT, groupBy: 'initiator', alsoConsolidated: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const mail = assertScoped(sentMail(), { html: true });
  const lead = mail.filter((m) => m.to.includes('lead@acme.io'));
  assert.equal(lead.length, 1);
  assert.deepEqual(lead[0].projects, ALL);
  assert.equal(lead[0].attachments, 1);
});

test('dashboard, interactive HTML report to the recipient list only: no initiator is mailed', async () => {
  const r = await admin('POST', '/api/reminders/send-html-by-initiator', { projectIds: EVERY_PROJECT, groupBy: 'none' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const mail = sentMail();
  assert.deepEqual(mail.map((m) => m.to), [['lead@acme.io', 'sean@acme.io']], 'the list, with its Cc');
  assert.deepEqual(mail[0].projects, ALL);
});

test('picking one person in Scan initiators mails only that person, in every format', async () => {
  for (const [url, body] of [
    ['/api/reminders', { projectIds: EVERY_PROJECT, groupBy: 'initiator', initiators: ['dev0@acme.com'] }],
    ['/api/reminders', { projectIds: EVERY_PROJECT, groupBy: 'project', initiators: ['dev0@acme.com'] }],
    ['/api/reminders/send-html-by-initiator', { projectIds: EVERY_PROJECT, groupBy: 'initiator', initiators: ['dev0@acme.com'] }],
    ['/api/reminders/send-html-by-initiator', { projectIds: EVERY_PROJECT, groupBy: 'project', initiators: ['dev0@acme.com'] }],
  ]) {
    const r = await admin('POST', url, body);
    assert.equal(r.status, 200, `${url} ${JSON.stringify(r.body)}`);
    assertScoped(sentMail(), { only: ['dev0@acme.com'], html: url.includes('html') });
  }
});

test('a selection that covers part of someone\'s projects mails them only the selected ones', async () => {
  const r = await admin('POST', '/api/reminders/send-html-by-initiator', { projectIds: ['p0', 'p1'], groupBy: 'initiator' });
  assert.equal(r.status, 200);
  const mail = sentMail();
  assert.deepEqual(mail.map((m) => [m.to[0], m.projects]), [['dev0@acme.com', ['Project 0']], ['dev1@acme.com', ['Project 1']]]);
});

test('tracked reports: follow-ups are scoped the same way, in every format', async () => {
  const created = await admin('POST', '/api/tracked-reports', { name: 'All four', projectIds: EVERY_PROJECT });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  for (const [options, check] of [
    [{ sendTo: 'initiator', emailContent: 'summary' }, {}],
    [{ sendTo: 'initiator', emailContent: 'per-project' }, { perProject: true }],
    [{ sendTo: 'initiator', emailContent: 'summary', attachHtml: true }, { html: true }],
    [{ sendTo: 'initiator', emailContent: 'per-project', attachHtml: true }, { html: true, perProject: true }],
    [{ sendTo: 'both', emailContent: 'summary', attachHtml: true }, { html: true }],
  ]) {
    const r = await admin('POST', `/api/tracked-reports/${id}/remind`, options);
    assert.equal(r.status, 200, `${JSON.stringify(options)} ${JSON.stringify(r.body)}`);
    const mail = assertScoped(sentMail(), check);
    const lead = mail.filter((m) => m.to.includes('lead@acme.io'));
    assert.equal(lead.length, options.sendTo === 'both' ? 1 : 0, JSON.stringify(options));
    if (lead.length) assert.deepEqual(lead[0].projects, ALL);
  }
  const listOnly = await admin('POST', `/api/tracked-reports/${id}/remind`, { sendTo: 'list', attachHtml: true });
  assert.equal(listOnly.status, 200, JSON.stringify(listOnly.body));
  assert.deepEqual(sentMail().map((m) => m.to), [['lead@acme.io', 'sean@acme.io']], 'to the list only: no initiator is mailed');
});

test('tracked reports follow who gets reminders everywhere, unless given their own choice', async () => {
  const created = await admin('POST', '/api/tracked-reports', { name: 'Follows the setting', projectIds: EVERY_PROJECT });
  const id = created.body.id;
  assert.equal((await admin('PUT', '/api/settings', { reminders: { audience: 'list' } })).status, 200);
  for (const sendTo of ['settings', 'initiator', undefined]) {
    const r = await admin('POST', `/api/tracked-reports/${id}/remind`, { ...(sendTo ? { sendTo } : {}), attachHtml: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(sentMail().map((m) => m.to), [['lead@acme.io', 'sean@acme.io']], `${sendTo ?? 'nothing'}: the setting (the fixed list)`);
  }
  const own = await admin('POST', `/api/tracked-reports/${id}/remind`, { sendTo: 'developers', attachHtml: true });
  assert.equal(own.status, 200);
  assert.ok(sentMail().every((m) => !m.to.includes('lead@acme.io')), 'its own choice: each developer, not the list');
  const saved = await admin('PUT', `/api/tracked-reports/${id}/automation`, { enabled: false, sendTo: 'initiator' });
  assert.equal(saved.body.automation.sendTo, 'settings', 'the old default is saved as "follow the setting"');
  await admin('PUT', '/api/settings', { reminders: { audience: 'initiator' } });
});

test('the old route that mailed any HTML to any address is gone', async () => {
  const r = await admin('POST', '/api/reminders/with-attachment', { htmlReport: '<p>hi</p>', recipients: { to: ['someone@else.example'] } });
  assert.equal(r.status, 404);
  assert.equal(sentMail().length, 0);
});

test('automatic reminders are scoped the same way, and never copy the configured Cc unless asked', async () => {
  const saved = await admin('PUT', '/api/automation', { enabled: false, dryRun: false, thresholds: '30', intervalMinutes: 60, groupBy: 'initiator', mode: 'crossing', severities: '' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const r = await admin('POST', '/api/automation/run', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.run.sent >= 2, JSON.stringify(r.body.run));
  const mail = assertScoped(sentMail());
  assert.ok(mail.every((m) => !m.to.includes('sean@acme.io')), 'the configured Cc is not copied');
});

test('fetch only named projects or the projects named people last scanned', async () => {
  const options = await admin('GET', '/api/scope/options');
  assert.equal(options.status, 200, JSON.stringify(options.body));
  assert.deepEqual(options.body.projects.map((p) => p.name), ['Project 0', 'Project 1', 'Project 2', 'Project 3']);
  assert.deepEqual(options.body.initiators.map((i) => [i.initiator, i.projects]), [['dev0@acme.com', 2], ['dev1@acme.com', 2]]);

  const names = (body) => body.projects.map((p) => p.projectName).sort();
  const byProject = await admin('GET', '/api/scan?project=p1&project=p3');
  assert.equal(byProject.status, 200);
  assert.deepEqual(names(byProject.body), ['Project 1', 'Project 3']);
  assert.equal(byProject.body.scope.projects, 2);

  const byPerson = await admin('GET', `/api/scan?initiator=${encodeURIComponent('DEV0@acme.com')}`);
  assert.deepEqual(names(byPerson.body), ['Project 0', 'Project 2'], 'case does not matter');
  const byUsername = await admin('GET', '/api/scan?initiator=dev1');
  assert.deepEqual(names(byUsername.body), ['Project 1', 'Project 3'], 'a username finds the address-shaped initiator');

  const either = await admin('GET', '/api/scan?project=p0&initiator=dev1@acme.com');
  assert.deepEqual(names(either.body), ['Project 0', 'Project 1', 'Project 3']);

  // Named projects are fetched whatever the "last scanned in" window says.
  const old = await admin('GET', '/api/scan?project=p2&activityPreset=custom&activityFrom=2001-01-01&activityTo=2001-01-31');
  assert.deepEqual(names(old.body), ['Project 2']);

  const none = await admin('GET', '/api/scan?initiator=nobody@acme.com');
  assert.deepEqual(none.body.projects, []);
  assert.match(none.body.warning, /No project matches/);

  const all = await admin('GET', '/api/scan');
  assert.equal(all.body.projects.length, 4, 'nothing named: every project, as before');
});

test('acting on their behalf: each scan initiator is told, about their own projects only', async () => {
  smtp.messages.length = 0;
  const r = await admin('POST', '/api/triage/run', { projectIds: EVERY_PROJECT, severities: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.started > 0);
  assert.equal(r.body.notified.emailed, 2, JSON.stringify(r.body.notified));
  await sleep(200);
  const mail = assertScoped(sentMail());
  assert.equal(mail.length, 2);
  for (const m of mail) {
    assert.match(m.subject, /AI Triage was started on your behalf/);
    assert.ok(!m.to.includes('lead@acme.io') && !m.to.includes('sean@acme.io'), 'only the initiator, not the configured list');
  }

  // Switched off: nobody is emailed.
  smtp.messages.length = 0;
  const quiet = await admin('POST', '/api/triage/run', { projectIds: EVERY_PROJECT, severities: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'], notifyInitiators: false });
  assert.equal(quiet.body.notified ?? null, null);
  await sleep(200);
  assert.equal(smtp.messages.length, 0);
});

test('taking back unused credits returns them to the pool, never below what was used', async () => {
  const add = await admin('POST', '/api/credits/allocate', { projectIds: ['p0'], triageAdd: 5, remediationAdd: 6 });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  const before = add.body.projects.p0;
  assert.ok(before.triage.remaining >= 5);
  const back = await admin('POST', '/api/credits/allocate', { projectIds: ['p0'], reclaimUnused: ['triage', 'remediation'] });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.reclaimed, before.triage.remaining + before.remediation.remaining);
  const after = back.body.projects.p0;
  assert.equal(after.triage.remaining, 0);
  assert.equal(after.remediation.remaining, 0);
  assert.equal(after.triage.allocated, after.triage.used, 'down to what was used, not below');
  assert.equal(after.extraTriage, 0);
});
