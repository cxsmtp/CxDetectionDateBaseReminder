// The terms of use (TERMS.md) come before anything else: an Admin accepts them for the
// organisation after the first sign-in, then each person accepts them once. Until then the
// API, emailed reports and automation are closed. Acceptances are tied to the exact text and
// recorded in the audit log. ACCEPT_TERMS=<email> lets the deployer accept, by name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';
import { Terms } from '../src/terms.js';
import { FIRST_PASSWORD, NEXT_PASSWORD } from './test-credentials.js';

const children = [];
test.after(() => {
  for (const child of children) child.kill();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terms-'));
  let log = '';
  const child = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, HOST: '127.0.0.1', DATA_DIR: dataDir, BACKUP_INTERVAL_HOURS: '0', REPORT_SIGNING_KEY: 'terms', SMTP_HOST: '', GITHUB_TOKEN: '', CX_API_KEY: '', HTTPS: 'off', ACCEPT_TERMS: '', ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  children.push(child);
  const exited = new Promise((resolve) => child.on('exit', resolve));
  return { dataDir, log: () => log, exited };
}
async function until(check, ms = 15000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(100);
  }
}
function client(base) {
  let cookie = '';
  return async (method, route, body) => {
    const res = await fetch(`${base}${route}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, json: await res.json().catch(() => null) };
  };
}

test('nothing works until an Admin accepts the terms for the organisation, then each person accepts once', async () => {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = start({ PORT: String(port) });
  await until(() => /running on http/.test(server.log()) && /First administrator created/.test(server.log()));

  // Readable by anyone, before signing in.
  const open = await (await fetch(`${base}/api/terms`)).json();
  assert.equal(open.version, '1.0');
  assert.match(open.text, /Not a Checkmarx product/);
  assert.match(open.text, /must not be used, presented or shared with Checkmarx as evidence/);
  assert.equal(open.organisation, null);

  const admin = client(base);
  assert.equal((await admin('POST', '/api/session/password', { email: 'admin@acme.io', password: FIRST_PASSWORD })).status < 300, true);
  assert.equal((await admin('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD })).status, 200);
  const me = (await admin('GET', '/api/me')).json;
  assert.deepEqual(me.terms, { version: '1.0', organisationAccepted: false, accepted: false, canAcceptForOrganisation: true });

  // Closed: the app's API, and emailed reports (which never sign in).
  const blocked = await admin('GET', '/api/report-server');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.termsRequired, true);
  const report = await fetch(`${base}/api/relay/hello`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(report.status, 403);
  assert.match((await report.json()).error, /terms of use/);
  assert.equal((await fetch(`${base}/api/relay/ping`)).status, 200, 'a report can still check the address');

  // Accepting: for the organisation, only the current version, only by an Admin.
  assert.equal((await admin('POST', '/api/terms/accept', { version: '0.9', forOrganisation: true })).status, 409);
  assert.equal((await admin('POST', '/api/terms/accept', { version: '1.0' })).status, 403, 'the Admin says it is for the organisation');
  const accepted = await admin('POST', '/api/terms/accept', { version: '1.0', forOrganisation: true });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.terms.accepted, true);
  const opened = await admin('GET', '/api/report-server');
  assert.equal(opened.status, 200, JSON.stringify(opened.json));
  const reportNow = await (await fetch(`${base}/api/relay/hello`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  assert.doesNotMatch(reportNow.error ?? '', /terms of use/, 'reports are no longer held back by the terms');

  // Another person accepts for themselves before using it.
  assert.ok((await admin('POST', '/api/iam/users', { email: 'dev@acme.io', role: 'user', password: FIRST_PASSWORD })).status < 300);
  const dev = client(base);
  await dev('POST', '/api/session/password', { email: 'dev@acme.io', password: FIRST_PASSWORD });
  await dev('POST', '/api/me/password', { current: FIRST_PASSWORD, next: 'another long passphrase' });
  const devMe = (await dev('GET', '/api/me')).json;
  assert.deepEqual(devMe.terms, { version: '1.0', organisationAccepted: true, accepted: false, canAcceptForOrganisation: false });
  assert.equal((await dev('GET', '/api/report-server')).json.termsRequired, true);
  assert.equal((await dev('POST', '/api/terms/accept', { version: '1.0' })).status, 200);
  assert.equal((await dev('GET', '/api/report-server')).status, 200);

  // On record.
  const audit = fs.readdirSync(path.join(server.dataDir, 'audit')).map((f) => fs.readFileSync(path.join(server.dataDir, 'audit', f), 'utf8')).join('');
  assert.match(audit, /Terms of use v1\.0 accepted for the organisation by admin@acme\.io/);
  assert.match(audit, /Terms of use v1\.0 accepted by dev@acme\.io/);
  const exported = await admin('GET', '/api/audit/export?format=csv');
  assert.equal(exported.status, 200);
});

test('ACCEPT_TERMS: the deployer accepts by name, recorded; anything but an email address stops the start', async () => {
  const port = await freePort();
  const server = start({ PORT: String(port), ACCEPT_TERMS: 'ops.lead@acme.io' });
  await until(() => /First administrator created/.test(server.log()));
  assert.match(server.log(), /accepted for the organisation by ops\.lead@acme\.io \(ACCEPT_TERMS\)/);
  const terms = await (await fetch(`http://127.0.0.1:${port}/api/terms`)).json();
  assert.equal(terms.organisation.by, 'ops.lead@acme.io');
  assert.equal(terms.organisation.via, 'ACCEPT_TERMS');

  const bad = start({ PORT: String(await freePort()), ACCEPT_TERMS: 'yes' });
  assert.equal(await bad.exited, 1);
  assert.match(bad.log(), /ACCEPT_TERMS must be the email address/);
});

test('changed terms are asked for again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terms-unit-'));
  const textFile = path.join(dir, 'TERMS.md');
  fs.writeFileSync(textFile, '# Terms\n\nVersion 1.0\n\nFirst text.\n');
  const first = new Terms({ file: path.join(dir, 'terms.json'), textFile });
  first.acceptForOrganisation({ by: 'admin@acme.io' });
  first.acceptForUser({ userId: 'u1', email: 'a@acme.io' });
  assert.ok(first.organisation());
  assert.equal(first.acceptedBy('u1'), true);
  fs.writeFileSync(textFile, '# Terms\n\nVersion 1.1\n\nChanged text.\n');
  const second = new Terms({ file: path.join(dir, 'terms.json'), textFile });
  assert.equal(second.version, '1.1');
  assert.equal(second.organisation(), null, 'the organisation accepts the new text again');
  assert.equal(second.acceptedBy('u1'), false);
});
