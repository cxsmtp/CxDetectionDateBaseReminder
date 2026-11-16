// The Cx Credits Calculator on a server as it is installed: the built-in calculator is muted, and the
// calculator runs on its own at an address an Admin gives. Off until then (no menu item, nothing under
// /api/projections); turned on, whoever may use the calculator is sent to that address, by the menu and
// by /calculator. (test/projections.e2e.test.js is the built-in calculator, on with CALCULATOR_BUILTIN=on.)
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
const CALCULATOR = 'http://calc.acme.io:8333/';
const children = [];
let log = '';

function browser() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(BASE + url, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json, text, location: res.headers.get('location'), headers: res.headers };
  };
}
const admin = browser();
const ana = browser();
const uma = browser();
const nobody = browser();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calc-muted-'));
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '3', RISKS: '2' }, stdio: 'ignore' }));
  // (Whatever this machine's own environment says, this server is started without the built-in calculator.)
  const { CALCULATOR_BUILTIN: _, ...env } = process.env;
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0', CALCULATOR_BUILTIN: '',
      CX_API_KEY: mockApiKey({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' }), CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme',
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD,
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
  for (const [as, email, role] of [[ana, 'ana@acme.io', 'analyst'], [uma, 'uma@acme.io', 'user']]) {
    assert.equal((await admin('POST', '/api/iam/users', { email, name: email.split('@')[0], role, password: FIRST_PASSWORD })).status, 201);
    await as('POST', '/api/session/password', { email, password: FIRST_PASSWORD });
    assert.equal((await as('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD })).status, 200);
  }
  // A Security Analyst is given the calculator, as an Admin would for whoever is to use it.
  const role = (await admin('GET', '/api/iam')).body.roles.find((r) => r.id === 'analyst');
  const given = await admin('PUT', '/api/iam/roles/analyst', { name: role.name, description: role.description, permissions: [...role.permissions, 'projections.use'] });
  assert.equal(given.status, 200, JSON.stringify(given.body));
});

test.after(() => {
  for (const child of children) child.kill();
});

test('off as installed: no calculator in the menu, and the built-in calculator answers nobody', async () => {
  assert.equal((await admin('GET', '/api/me')).body.calculator, null);
  assert.equal((await ana('GET', '/api/me')).body.calculator, null);
  const address = (await admin('GET', '/api/calculator/address')).body;
  assert.deepEqual(address.calculator, { external: false, url: '' });
  assert.equal(address.builtIn, false);
  // Every route of the built-in calculator: an Admin, someone given the calculator, and someone not signed in.
  for (const [method, url, body] of [
    ['GET', '/api/projections'], ['POST', '/api/projections', { name: 'Customer' }], ['GET', '/api/projections/standalone'], ['GET', '/api/projections/standalone?kind=launcher'],
    ['GET', '/api/projections/reports'], ['POST', '/api/projections/read', {}], ['GET', '/api/projections/git/connections'], ['DELETE', '/api/projections/reports/x'], ['PUT', '/api/projections/x', {}],
  ]) {
    for (const [who, as] of [['an Admin', admin], ['an analyst', ana], ['nobody', nobody]]) {
      const answer = await as(method, url, body);
      assert.equal(answer.status, 404, `${method} ${url} for ${who}`);
      assert.equal(answer.body.calculatorOff, true);
      assert.match(answer.body.error, /not part of this CxMissionZero server/);
    }
  }
  // /calculator leads nowhere but CxMissionZero's own page.
  for (const as of [admin, ana, uma, nobody]) {
    const answer = await as('GET', '/calculator');
    assert.equal(answer.status, 302);
    assert.equal(answer.location, '/');
  }
});

test('an Admin gives the address and turns it on: whoever may use the calculator is sent there', async () => {
  // The address alone, not turned on: still off.
  assert.deepEqual((await admin('PUT', '/api/calculator/address', { url: CALCULATOR })).body.calculator, { external: false, url: CALCULATOR });
  assert.equal((await admin('GET', '/api/me')).body.calculator, null);
  assert.equal((await admin('GET', '/calculator')).location, '/');

  assert.deepEqual((await admin('PUT', '/api/calculator/address', { external: true })).body.calculator, { external: true, url: CALCULATOR });
  assert.deepEqual((await admin('GET', '/api/me')).body.calculator, { url: CALCULATOR });
  assert.deepEqual((await ana('GET', '/api/me')).body.calculator, { url: CALCULATOR });
  assert.equal((await uma('GET', '/api/me')).body.calculator, null, 'a role without the calculator is told nothing');

  // /calculator: on to the address for them, and CxMissionZero's own page for everyone else.
  for (const as of [admin, ana]) {
    const answer = await as('GET', '/calculator');
    assert.equal(answer.status, 302);
    assert.equal(answer.location, CALCULATOR);
    assert.equal(answer.headers.get('referrer-policy'), 'no-referrer', 'the calculator is not told where its visitor came from');
    assert.equal(answer.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await admin('GET', '/calculator/')).location, CALCULATOR, 'with a slash at the end too');
  for (const as of [uma, nobody]) assert.equal((await as('GET', '/calculator')).location, '/');

  // The built-in calculator stays muted: the address is a link, not a way in.
  assert.equal((await admin('GET', '/api/projections')).status, 404);
});

test('turned off again: gone from the menu, the address kept, and each change audited', async () => {
  assert.deepEqual((await admin('PUT', '/api/calculator/address', { external: false })).body.calculator, { external: false, url: CALCULATOR });
  assert.equal((await admin('GET', '/api/me')).body.calculator, null);
  assert.equal((await ana('GET', '/calculator')).location, '/');
  const reasons = (await admin('GET', '/api/audit?limit=50')).body.entries.map((e) => e.reason).join('\n');
  assert.match(reasons, /The Cx Credits Calculator's address was set to http:\/\/calc\.acme\.io:8333\/ \(not turned on\)/);
  assert.match(reasons, /The Cx Credits Calculator was turned on: the menu opens http:\/\/calc\.acme\.io:8333\//);
  assert.match(reasons, /The Cx Credits Calculator was turned off: the menu no longer shows it/);
});
