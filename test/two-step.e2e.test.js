// Two-step sign-in, end to end, on the real server: turning it on with a first code, the ticket between the
// password and the code (no session before), wrong codes and their limits, a code used twice, recovery
// codes, an Admin requiring it for everyone and resetting someone's, and what none of it touches (signing in
// with a Checkmarx One key). Nothing secret may reach the audit log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { codeAt, totp, totpStep } from '../src/mfa.js';
import { freePort } from './free-port.js';
import { FIRST_PASSWORD, MEMBER_NEXT_PASSWORD, NEXT_PASSWORD, mockApiKey } from './test-credentials.js';

const MOCK_PORT = await freePort();
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const DEV_PASSWORD = MEMBER_NEXT_PASSWORD;
const ANALYST_PASSWORD = `analyst-${randomBytes(12).toString('base64url')}`;
const children = [];
let log = '';
let dataDir;
let serial = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A browser with its own cookie, and its own address (so each has its own count of sign-in attempts). */
function browser() {
  let cookie = '';
  const ip = `198.51.100.${(serial += 1)}`;
  const call = async (method, url, body) => {
    const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.getSetCookie().find((c) => c.startsWith('cxdr_sid='));
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null), setCookie: Boolean(set) };
  };
  call.signedIn = async () => (await call('GET', '/api/me')).status === 200;
  return call;
}
const admin = browser();
const dev = browser();

async function until(check, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out\n${log.slice(-2000)}`);
}
const auditLog = async () => (await admin('GET', '/api/audit?types=access,iam&limit=200')).body.entries;
const reasons = async () => (await auditLog()).map((e) => `${e.outcome}: ${e.reason}`).join('\n');

/** A code the app would not show now, before or next. */
function wrongCode(secret) {
  const step = totpStep();
  const good = new Set([-2, -1, 0, 1, 2].map((d) => codeAt(secret, step + d)));
  for (let n = 0; ; n += 1) {
    const code = String(n).padStart(6, '0');
    if (!good.has(code)) return code;
  }
}
/**
 * A code the server takes now and has not taken before for this key: the step before, this one or the next (clocks
 * may differ by one), each used once and in order. Waits for the clock when all three are used up.
 */
const usedSteps = new Map();
async function freshCode(secret) {
  for (;;) {
    const now = totpStep();
    const step = [now - 1, now, now + 1].find((candidate) => candidate > (usedSteps.get(secret) ?? 0));
    if (step) {
      usedSteps.set(secret, step);
      return codeAt(secret, step);
    }
    await sleep(500);
  }
}
const password = (email, pw) => browser()('POST', '/api/session/password', { email, password: pw });

let devId = '';
let devSecret = '';
let devRecovery = [];

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'two-step-'));
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '1', RISKS: '1' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', HTTPS: 'off', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: mockApiKey({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' }), CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme',
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD, RESET_TWO_STEP: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  children.push(server);
  await until(() => /Successfully authenticated/.test(log) && /First administrator created/.test(log));
  await admin('POST', '/api/session/password', { email: 'admin@acme.io', password: FIRST_PASSWORD });
  await admin('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD });
  for (const [email, role, pw] of [['dev@acme.io', 'user', DEV_PASSWORD], ['analyst@acme.io', 'analyst', ANALYST_PASSWORD]]) {
    assert.equal((await admin('POST', '/api/iam/users', { email, role, password: FIRST_PASSWORD, cxoneIdentities: email === 'dev@acme.io' ? ['dev-key'] : [] })).status, 201);
    const b = browser();
    await b('POST', '/api/session/password', { email, password: FIRST_PASSWORD });
    assert.equal((await b('POST', '/api/me/password', { current: FIRST_PASSWORD, next: pw })).status, 200);
  }
  devId = (await admin('GET', '/api/iam')).body.users.find((u) => u.email === 'dev@acme.io').id;
});

test.after(() => {
  for (const child of children) child.kill();
});

test('without it, a password signs in as it always did', async () => {
  const signedIn = await dev('POST', '/api/session/password', { email: 'dev@acme.io', password: DEV_PASSWORD });
  assert.equal(signedIn.status, 201);
  assert.equal(signedIn.body.via, 'password');
  assert.deepEqual(signedIn.body.twoStep, { available: true, on: false, since: '', recoveryLeft: 0, required: false });
  assert.equal(signedIn.body.user.twoStep, false);
});

test('turning it on: a key and an address for the app, and only a right code turns it on', async () => {
  const setup = await dev('POST', '/api/me/two-step/setup');
  assert.equal(setup.status, 200);
  assert.match(setup.body.secret, /^[A-Z2-7]{32}$/);
  assert.equal(setup.body.key.replace(/ /g, ''), setup.body.secret);
  const uri = new URL(setup.body.otpauth);
  assert.equal(decodeURIComponent(uri.pathname), '/CxMissionZero:dev@acme.io');
  assert.equal(uri.searchParams.get('issuer'), 'CxMissionZero');
  assert.equal(uri.searchParams.get('secret'), setup.body.secret);
  assert.equal((await dev('GET', '/api/me')).body.twoStep.on, false, 'not on until a code proves the app has the key');

  const wrong = await dev('POST', '/api/me/two-step/enable', { code: wrongCode(setup.body.secret) });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /not right/);
  assert.equal((await dev('POST', '/api/me/two-step/enable', {})).status, 400);

  const on = await dev('POST', '/api/me/two-step/enable', { code: await freshCode(setup.body.secret) });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.recoveryCodes.length, 10);
  assert.equal(on.body.me.twoStep.on, true);
  assert.equal(on.body.me.twoStep.recoveryLeft, 10);
  assert.equal((await dev('POST', '/api/me/two-step/setup')).status, 400, 'already on');
  devSecret = setup.body.secret;
  devRecovery = on.body.recoveryCodes;
  assert.equal((await admin('GET', '/api/iam')).body.users.find((u) => u.id === devId).twoStep, true, 'People shows who has it');
  assert.match(await reasons(), /changed: dev@acme\.io turned on two-step sign-in\./);

  // On the disk: the secret with the person, owner only; the recovery codes as hashes only.
  const file = path.join(dataDir, 'iam.json');
  const saved = fs.readFileSync(file, 'utf8');
  assert.match(saved, new RegExp(devSecret));
  for (const code of devRecovery) assert.doesNotMatch(saved, new RegExp(code));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('signing in: the password gives a ticket and no session; the code gives the session', async () => {
  const b = browser();
  const first = await b('POST', '/api/session/password', { email: 'dev@acme.io', password: DEV_PASSWORD });
  assert.equal(first.status, 200);
  assert.equal(first.body.twoStep, true);
  assert.match(first.body.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.body.setup, undefined, 'nothing about the key');
  assert.equal(first.body.user, undefined, 'nothing about the person yet');
  assert.equal(first.setCookie, false, 'no session cookie');
  assert.equal(await b.signedIn(), false);

  const wrong = await b('POST', '/api/session/two-step', { ticket: first.body.ticket, code: wrongCode(devSecret) });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.restart, false, 'the ticket still takes another try');
  assert.equal(wrong.setCookie, false);
  assert.equal(await b.signedIn(), false);

  const code = await freshCode(devSecret);
  const done = await b('POST', '/api/session/two-step', { ticket: first.body.ticket, code });
  assert.equal(done.status, 201, JSON.stringify(done.body));
  assert.equal(done.body.user.email, 'dev@acme.io');
  assert.equal(done.body.via, 'password');
  assert.equal(done.body.recoveryCodes, undefined);
  assert.equal(await b.signedIn(), true);

  // The ticket is used up, and so is the code: within its window it never works a second time.
  const again = await browser()('POST', '/api/session/two-step', { ticket: first.body.ticket, code });
  assert.equal(again.status, 401);
  assert.equal(again.body.restart, true);
  const other = browser();
  const second = await other('POST', '/api/session/password', { email: 'dev@acme.io', password: DEV_PASSWORD });
  const replay = await other('POST', '/api/session/two-step', { ticket: second.body.ticket, code });
  assert.equal(replay.status, 401, 'the same code with a new ticket');
  assert.equal(await other.signedIn(), false);

  const said = await reasons();
  assert.match(said, /refused: Sign-in refused for dev@acme\.io: wrong two-step code\./);
  assert.match(said, /info: dev@acme\.io signed in with a password and a two-step code\./);
  // User activity tells the two steps apart: the password alone is not a sign-in.
  const steps = ((await admin('GET', '/api/activity?kind=sign-in&limit=50')).body.entries ?? []).filter((e) => e.user === 'dev@acme.io').map((e) => e.action);
  for (const action of ['Typed the right password: asked for the two-step code', 'Sign-in refused', 'Signed in with a password and a two-step code']) assert.ok(steps.includes(action), `${action}: ${steps.join(' | ')}`);
  assert.match(said, /refused: Sign-in refused: the two-step sign-in was over, or was never started\./);
  // The count of wrong tries starts again once someone is in (an Admin's change of the account clears it too).
  assert.equal((await admin('PATCH', `/api/iam/users/${devId}`, { disabled: false })).status, 200);
});

test('a ticket is one person\'s: made up, or without a code, it opens nothing', async () => {
  const b = browser();
  for (const body of [{}, { ticket: 'x', code: '123456' }, { ticket: randomBytes(32).toString('base64url'), code: totp(devSecret) }, { ticket: ['a'], code: { $gt: '' } }]) {
    const r = await b('POST', '/api/session/two-step', body);
    assert.equal(r.status, 401, JSON.stringify(body));
    assert.equal(r.setCookie, false);
  }
  assert.equal(await b.signedIn(), false);
});

test('a recovery code signs in once, is recorded, and is then gone', async () => {
  const b = browser();
  const first = await b('POST', '/api/session/password', { email: 'dev@acme.io', password: DEV_PASSWORD });
  const done = await b('POST', '/api/session/two-step', { ticket: first.body.ticket, code: devRecovery[0].toLowerCase() });
  assert.equal(done.status, 201, JSON.stringify(done.body));
  assert.equal(done.body.twoStep.recoveryLeft, 9);
  const said = await reasons();
  assert.match(said, /changed: dev@acme\.io used a recovery code to sign in: it is gone, 9 left\./);
  assert.match(said, /info: dev@acme\.io signed in with a password and a recovery code \(9 left\)\./);

  const other = browser();
  const second = await other('POST', '/api/session/password', { email: 'dev@acme.io', password: DEV_PASSWORD });
  const twice = await other('POST', '/api/session/two-step', { ticket: second.body.ticket, code: devRecovery[0] });
  assert.equal(twice.status, 401, 'never twice');
  assert.equal(await other.signedIn(), false);
  assert.equal((await admin('PATCH', `/api/iam/users/${devId}`, { disabled: false })).status, 200);
});

test('wrong codes are limited: five end the ticket and lock the account, as wrong passwords do', async () => {
  const b = browser();
  const first = await b('POST', '/api/session/password', { email: 'dev@acme.io', password: DEV_PASSWORD });
  const wrong = wrongCode(devSecret);
  for (let i = 1; i <= 4; i += 1) {
    const r = await b('POST', '/api/session/two-step', { ticket: first.body.ticket, code: wrong });
    assert.deepEqual([r.status, r.body.restart], [401, false], `try ${i}`);
  }
  const fifth = await b('POST', '/api/session/two-step', { ticket: first.body.ticket, code: wrong });
  assert.deepEqual([fifth.status, fifth.body.restart], [401, true]);
  const dead = await b('POST', '/api/session/two-step', { ticket: first.body.ticket, code: totp(devSecret) });
  assert.equal(dead.status, 401, 'the ticket is over, even for the right code');
  const locked = await password('dev@acme.io', DEV_PASSWORD);
  assert.equal(locked.status, 423, 'the account is locked for a quarter of an hour');
  assert.match(await reasons(), /refused: Sign-in refused for dev@acme\.io: wrong two-step code\. Account locked\./);
  assert.equal((await admin('GET', '/api/iam')).body.users.find((u) => u.id === devId).locked, true);
  // An Admin unlocks (enabling an account clears the lock).
  assert.equal((await admin('PATCH', `/api/iam/users/${devId}`, { disabled: false })).status, 200);
  assert.equal((await password('dev@acme.io', DEV_PASSWORD)).status, 200);
});

test('new recovery codes take a current code from the app', async () => {
  assert.equal((await dev('POST', '/api/me/two-step/recovery-codes', { code: wrongCode(devSecret) })).status, 400);
  assert.equal((await dev('POST', '/api/me/two-step/recovery-codes', { code: devRecovery[1] })).status, 400, 'a recovery code is not a current code');
  const fresh = await dev('POST', '/api/me/two-step/recovery-codes', { code: await freshCode(devSecret) });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.equal(fresh.body.recoveryCodes.length, 10);
  assert.ok(!fresh.body.recoveryCodes.includes(devRecovery[2]));
  assert.equal(fresh.body.me.twoStep.recoveryLeft, 10);
  assert.match(await reasons(), /changed: dev@acme\.io made new recovery codes; the old ones no longer work\./);
  const b = browser();
  const first = await b('POST', '/api/session/password', { email: 'dev@acme.io', password: DEV_PASSWORD });
  assert.equal((await b('POST', '/api/session/two-step', { ticket: first.body.ticket, code: devRecovery[2] })).status, 401, 'an old recovery code no longer works');
  devRecovery = fresh.body.recoveryCodes;
  assert.equal((await admin('PATCH', `/api/iam/users/${devId}`, { disabled: false })).status, 200);
});

test('turning one\'s own off takes a current code; then the key is gone and a password alone signs in', async () => {
  const analyst = browser();
  assert.equal((await analyst('POST', '/api/session/password', { email: 'analyst@acme.io', password: ANALYST_PASSWORD })).status, 201);
  const setup = await analyst('POST', '/api/me/two-step/setup');
  const on = await analyst('POST', '/api/me/two-step/enable', { code: await freshCode(setup.body.secret) });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.match(fs.readFileSync(path.join(dataDir, 'iam.json'), 'utf8'), new RegExp(setup.body.secret));

  const refused = await analyst('POST', '/api/me/two-step/disable', { code: wrongCode(setup.body.secret) });
  assert.equal(refused.status, 400);
  assert.equal((await analyst('POST', '/api/me/two-step/disable', { code: on.body.recoveryCodes[0] })).status, 400, 'a recovery code does not turn it off');
  assert.equal((await analyst('POST', '/api/me/two-step/disable', {})).status, 400);
  assert.equal((await analyst('GET', '/api/me')).body.twoStep.on, true);
  const off = await analyst('POST', '/api/me/two-step/disable', { code: await freshCode(setup.body.secret) });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.me.twoStep.on, false);
  const said = await reasons();
  assert.match(said, /refused: analyst@acme\.io could not turn off two-step sign-in: wrong code\./);
  assert.match(said, /changed: analyst@acme\.io turned off two-step sign-in\./);
  // Gone from the disk, and from the last good copy of the file.
  for (const file of ['iam.json', 'iam.json.bak']) {
    const full = path.join(dataDir, file);
    assert.equal(fs.existsSync(full) && fs.readFileSync(full, 'utf8').includes(setup.body.secret), false, file);
  }
  assert.equal((await password('analyst@acme.io', ANALYST_PASSWORD)).status, 201, 'a password alone signs in again');
});

const analyst = browser();

test('only an Admin requires it for everyone; then a person without it sets it up before they get a session', async () => {
  const before = browser();
  assert.equal((await before('POST', '/api/session/password', { email: 'analyst@acme.io', password: ANALYST_PASSWORD })).status, 201);
  assert.equal((await before('GET', '/api/iam')).body.signIn.security, null, 'not shown to someone who is not an Admin');
  assert.equal((await before('PUT', '/api/iam/sign-in', { twoStepRequired: true })).status, 403);
  assert.equal((await dev('PUT', '/api/iam/sign-in', { twoStepRequired: true })).status, 403);
  assert.equal((await admin('GET', '/api/iam')).body.signIn.security.twoStepRequired, false, 'off by default');

  const set = await admin('PUT', '/api/iam/sign-in', { twoStepRequired: true });
  assert.equal(set.status, 200);
  assert.equal(set.body.signIn.security.twoStepRequired, true);
  assert.match(await reasons(), /changed: Two-step sign-in for everyone who signs in with a password: not required → required\./);
  assert.equal(await before.signedIn(), true, 'whoever is signed in carries on');

  // The analyst has none (they turned theirs off): the password gives a key to set up, and no session.
  const first = await analyst('POST', '/api/session/password', { email: 'analyst@acme.io', password: ANALYST_PASSWORD });
  assert.equal(first.status, 200);
  assert.equal(first.body.twoStep, true);
  assert.match(first.body.setup.secret, /^[A-Z2-7]{32}$/);
  assert.match(first.body.setup.otpauth, /^otpauth:\/\/totp\/CxMissionZero:analyst%40acme\.io\?/);
  assert.equal(first.setCookie, false);
  assert.equal(await analyst.signedIn(), false, 'no session before it is set up');
  const secret = first.body.setup.secret;
  assert.equal((await analyst('POST', '/api/session/two-step', { ticket: first.body.ticket, code: wrongCode(secret) })).status, 401);
  assert.equal(await analyst.signedIn(), false);
  const done = await analyst('POST', '/api/session/two-step', { ticket: first.body.ticket, code: await freshCode(secret) });
  assert.equal(done.status, 201, JSON.stringify(done.body));
  assert.equal(done.body.recoveryCodes.length, 10);
  assert.equal(done.body.twoStep.on, true);
  assert.equal(done.body.twoStep.required, true);
  assert.equal(await analyst.signedIn(), true);
  const said = await reasons();
  assert.match(said, /changed: analyst@acme\.io turned on two-step sign-in \(required at sign-in\)\./);
  assert.match(said, /info: analyst@acme\.io signed in with a password and set up two-step sign-in\./);

  const off = await analyst('POST', '/api/me/two-step/disable', { code: await freshCode(secret) });
  assert.equal(off.status, 403, 'not while an Admin requires it');
  assert.equal((await analyst('GET', '/api/me')).body.twoStep.on, true);
  // Someone who already has it is asked for a code, as before.
  const other = await password('dev@acme.io', DEV_PASSWORD);
  assert.equal(other.body.twoStep, true);
  assert.equal(other.body.setup, undefined);
});

test('an Admin resets someone\'s two-step sign-in; nobody resets their own that way', async () => {
  const adminId = (await admin('GET', '/api/me')).body.user.id;
  assert.equal((await analyst('DELETE', `/api/iam/users/${adminId}/two-step`)).status, 404, 'an analyst cannot even see an Admin');
  assert.equal((await dev('DELETE', `/api/iam/users/${devId}/two-step`)).status, 403, 'not without the permission to manage people');
  assert.equal((await admin('DELETE', `/api/iam/users/${adminId}/two-step`)).status, 400, 'one\'s own is turned off with a code');

  const waiting = await password('dev@acme.io', DEV_PASSWORD);
  assert.equal(waiting.body.twoStep, true);
  const reset = await admin('DELETE', `/api/iam/users/${devId}/two-step`);
  assert.equal(reset.status, 200);
  assert.equal(reset.body.users.find((u) => u.id === devId).twoStep, false);
  assert.match(await reasons(), /changed: Reset two-step sign-in for dev@acme\.io\./);
  for (const file of ['iam.json', 'iam.json.bak']) {
    const full = path.join(dataDir, file);
    assert.equal(fs.existsSync(full) && fs.readFileSync(full, 'utf8').includes(devSecret), false, `${file} no longer holds the key`);
  }
  const stale = await browser()('POST', '/api/session/two-step', { ticket: waiting.body.ticket, code: totp(devSecret) });
  assert.equal(stale.status, 401, 'a sign-in that was waiting for the old code is over');
  assert.equal(await dev.signedIn(), true, 'where they are signed in, they stay signed in');

  // Still required: the next sign-in sets it up afresh, with a new key.
  const again = await password('dev@acme.io', DEV_PASSWORD);
  assert.equal(again.status, 200);
  assert.ok(again.body.setup.secret);
  assert.notEqual(again.body.setup.secret, devSecret);
});

test('signing in with a Checkmarx One key is not asked for a code', async () => {
  const b = browser();
  const signedIn = await b('POST', '/api/session', { apiKey: mockApiKey({ iss: `${MOCK}/auth/realms/acme`, preferred_username: 'dev-key' }) });
  assert.equal(signedIn.status, 201, JSON.stringify(signedIn.body));
  assert.equal(signedIn.body.via, 'cxone');
  assert.equal(signedIn.body.user.email, 'dev@acme.io');
  assert.equal(await b.signedIn(), true);
});

test('nothing secret is in the audit log: no key, no code, no recovery code, no ticket', async () => {
  const text = JSON.stringify(await auditLog());
  assert.doesNotMatch(text, new RegExp(devSecret));
  for (const code of devRecovery) assert.doesNotMatch(text, new RegExp(code));
  assert.doesNotMatch(text, /"(ticket|secret|otpauth|recoveryCodes)"/);
  assert.doesNotMatch(text, /otpauth:/);
  assert.doesNotMatch(log, new RegExp(devSecret), 'nor in the server log');
});

test('RESET_TWO_STEP at start-up is the way back in when no Admin is left to reset it', async () => {
  // The Admin turns it on for themselves, then "loses" the app and the recovery codes.
  const setup = await admin('POST', '/api/me/two-step/setup');
  assert.equal((await admin('POST', '/api/me/two-step/enable', { code: totp(setup.body.secret) })).status, 200);
  const blocked = await password('admin@acme.io', NEXT_PASSWORD);
  assert.equal(blocked.body.twoStep, true);
  assert.equal(blocked.body.setup, undefined, 'asked for a code they no longer have');

  // The server is stopped, started once with RESET_TWO_STEP, and that person's two-step sign-in is off.
  const [, first] = children;
  const stopped = new Promise((resolve) => first.once('exit', resolve));
  first.kill();
  await stopped;
  let out = '';
  const second = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', HTTPS: 'off', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: mockApiKey({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' }), CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme', RESET_TWO_STEP: ' Admin@acme.io ',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(second);
  second.stdout.on('data', (d) => (out += d));
  second.stderr.on('data', (d) => (out += d));
  await until(() => /Successfully authenticated/.test(out) || second.exitCode !== null, 20_000).catch(() => {});
  assert.match(out, /Two-step sign-in was reset for admin@acme\.io \(RESET_TWO_STEP\)/, out.slice(-1500));
  assert.doesNotMatch(fs.readFileSync(path.join(dataDir, 'iam.json'), 'utf8'), new RegExp(setup.body.secret));
  // It is required for everyone here, so the Admin sets it up afresh on the way in: with their password alone they are not locked out.
  const again = await until(async () => {
    const r = await password('admin@acme.io', NEXT_PASSWORD).catch(() => null);
    return r?.status === 200 ? r : null;
  });
  assert.ok(again.body.setup.secret, 'a new key to set up');
  const fresh = browser();
  assert.equal((await fresh('POST', '/api/session/two-step', { ticket: again.body.ticket, code: totp(again.body.setup.secret) })).status, 201);
  const entries = (await fresh('GET', '/api/audit?types=iam&limit=50')).body.entries.map((e) => e.reason).join('\n');
  assert.match(entries, /Two-step sign-in reset for admin@acme\.io from the server's environment \(RESET_TWO_STEP\)\./);

  // Left in the environment, the variable does nothing more: the two-step sign-in they just set up again is kept.
  const ended = new Promise((resolve) => second.once('exit', resolve));
  second.kill();
  await ended;
  let third = '';
  const again2 = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', HTTPS: 'off', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: mockApiKey({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' }), CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme', RESET_TWO_STEP: 'admin@acme.io',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(again2);
  again2.stdout.on('data', (d) => (third += d));
  again2.stderr.on('data', (d) => (third += d));
  await until(() => /Successfully authenticated/.test(third) || again2.exitCode !== null, 20_000).catch(() => {});
  assert.match(third, /RESET_TWO_STEP was used for this person at an earlier start, so nothing was reset now/, third.slice(-1500));
  assert.match(fs.readFileSync(path.join(dataDir, 'iam.json'), 'utf8'), new RegExp(again.body.setup.secret), 'still on');
});
