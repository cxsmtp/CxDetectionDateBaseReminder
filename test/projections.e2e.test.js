// Cx Credits Calculator, end to end: nothing until its activation code is applied, then only for
// the people with the permission; customers saved and reopened; the Fusion read against the mock
// Checkmarx One (lines of code, criticality, how often each project is scanned); reports kept and
// downloaded again; the organisation name; and off again with a deactivation code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fusionEstimate } from '../public/calculator/model.js';
import { freePort } from './free-port.js';
import { FIRST_PASSWORD, NEXT_PASSWORD, mockApiKey } from './test-credentials.js';

const MOCK_PORT = await freePort();
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const PROJECTS = 30;
const children = [];
let log = '';
let dataDir = '';
const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calc-key-'));
const keyFile = path.join(keyDir, 'issuer.pem');
const script = (...args) => execFileSync(process.execPath, ['scripts/activation.mjs', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const publicKey = script('keygen', keyFile).split('\n').pop();

function browser() {
  let cookie = '';
  return async (method, url, body) => {
    const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, body: json, text };
  };
}
const admin = browser();
const ana = browser();
const uma = browser();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calc-'));
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: String(PROJECTS), RISKS: '2' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0', ORGANISATION_NAME: 'Acme Partners',
      CX_API_KEY: mockApiKey({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' }), CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme',
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD, MZ_ACTIVATION_TEST_KEY: publicKey,
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
});

test.after(() => {
  for (const child of children) child.kill();
});

let customerId = '';

test('nothing until its activation code is applied: not in the menu, refused by the server', async () => {
  const me = (await admin('GET', '/api/me')).body;
  assert.equal(me.unlocked.calculator, false);
  assert.ok(me.permissions.includes('projections.use'), 'the permission alone is not enough');
  const refused = await admin('GET', '/api/projections');
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /activation code/);
  assert.equal((await admin('POST', '/api/projections/fusion/read', {})).status, 403);

  const code = script('calculator', keyFile, 'Acme Partners', 'on');
  const applied = await admin('POST', '/api/activation', { code });
  assert.equal(applied.status, 200, applied.text);
  assert.match(applied.body.applied, /Cx Credits Calculator turned on/);
  assert.equal(applied.body.calculator.org, 'Acme Partners');
  assert.equal((await admin('GET', '/api/me')).body.unlocked.calculator, true);
});

test('then for the people with the permission only', async () => {
  assert.equal((await ana('GET', '/api/projections')).status, 200, 'Security Analysts have it on a new installation');
  assert.equal((await uma('GET', '/api/me')).body.permissions.includes('projections.use'), false);
  for (const [method, url] of [['GET', '/api/projections'], ['POST', '/api/projections'], ['POST', '/api/projections/fusion/read'], ['GET', '/api/projections/reports'], ['POST', '/api/projections/reports'], ['GET', '/api/projections/x'], ['PUT', '/api/projections/x'], ['DELETE', '/api/projections/x']]) {
    assert.equal((await uma(method, url, method === 'GET' ? undefined : {})).status, 403, `${method} ${url}`);
  }
  assert.equal((await fetch(`${BASE}/api/projections`)).status, 401, 'signed out');
});

test('a customer is saved as it is worked on, and opens again as it was left', async () => {
  const list = await ana('GET', '/api/projections');
  assert.equal(list.body.organisationName, 'Acme Partners', 'ORGANISATION_NAME');
  const created = await ana('POST', '/api/projections', { name: 'Globex' });
  assert.equal(created.status, 201, created.text);
  customerId = created.body.customer.id;
  const tr = { totals: { weeks: ['2026-09-05', '2026-09-12'], bySeverity: { Critical: [4, 5], High: [10, 12] }, meta: { fileName: 'Total.xlsx' } }, fixed: { weeks: ['2026-09-12'], bySeverity: { Critical: [1] }, meta: { fileName: 'Fixed.xlsx' } }, selected: { Critical: 5, High: 6 }, fpPercent: { High: 20 }, lookbackMonths: 0 };
  const saved = await ana('PUT', `/api/projections/${customerId}`, { tr });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.body.customer.hasTr, true);
  const opened = (await admin('GET', `/api/projections/${customerId}`)).body.customer;
  assert.deepEqual(opened.tr.totals.bySeverity.High, [10, 12]);
  assert.equal(opened.tr.selected.High, 6);
  assert.equal(opened.tr.fpPercent.High, 20);
  assert.equal(opened.tr.lookbackMonths, 0);
  assert.equal((await ana('PUT', `/api/projections/${customerId}`, { name: 'Globex — renewal' })).body.customer.name, 'Globex — renewal');
  assert.equal((await ana('PUT', '/api/projections/nope', { name: 'x' })).status, 404);
});

test('Fusion reads every project: lines of code, criticality and how often it is scanned', async () => {
  const read = await admin('POST', '/api/projections/fusion/read', {});
  assert.equal(read.status, 200, read.text.slice(0, 300));
  const { projects, models, remainingCredits, readAt } = read.body;
  assert.ok(Date.parse(readAt));
  assert.equal(projects.length, PROJECTS);
  assert.deepEqual(models, [], 'the mock does not say its Fusion models: none made up');
  assert.equal(remainingCredits, null);
  const byId = Object.fromEntries(projects.map((p) => [p.id, p]));
  // The mock scans project i 400, 100, 20, 4 or 0 times a year (i % 5), and gives it criticality (i % 5) + 1.
  assert.deepEqual([byId.p0.frequency, byId.p0.criticality, byId.p0.scanCount], ['more-5-week', 1, 400]);
  assert.deepEqual([byId.p1.frequency, byId.p1.criticality], ['1-5-week', 2]);
  assert.equal(byId.p2.frequency, 'month');
  assert.equal(byId.p3.frequency, '3-months');
  assert.deepEqual([byId.p4.frequency, byId.p4.scanCount], ['rare', 0]);
  assert.equal(byId.p0.loc, 1500, 'lines of code from the SAST scan metadata');
  assert.equal(byId.p3.loc, null, 'neither the metadata nor the scan counted them');

  // Saved with the customer, with models typed by hand: the totals follow from the figures read.
  const fusion = { periodMonths: 12, defaultScans: 1, models: [{ id: 'opus', name: 'Opus-4.7', creditsPer10k: 2.5 }, { id: 'haiku', name: 'Haiku-4.5', creditsPer10k: 1.5 }], defaultModel: 'haiku', byFrequency: { 'more-5-week': { scans: 52, model: 'opus' } }, byCriticality: { 5: { scans: 12 } }, projects };
  const saved = await admin('PUT', `/api/projections/${customerId}`, { fusion });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.body.customer.fusionProjects, PROJECTS);
  const back = (await admin('GET', `/api/projections/${customerId}`)).body.customer.fusion;
  const est = fusionEstimate(back.projects, back);
  assert.equal(est.rows[0].frequency, 'more-5-week', 'most often scanned first');
  assert.equal(est.rows[0].model, 'opus');
  assert.ok(est.totals.credits > 0);
});

test('reports are kept, listed, downloaded again and deleted', async () => {
  const data = { organisation: 'Acme Partners', customer: 'Globex', generatedAt: new Date().toISOString(), tr: { totals: { credits: 120.5, selected: 11 } }, fusion: { periodMonths: 12, totals: { credits: 30, scans: 40 } } };
  const made = await ana('POST', '/api/projections/reports', { customerId, data });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.body.report.totalCredits, 150.5);
  assert.equal(made.body.report.customer, 'Globex — renewal');
  assert.equal((await ana('POST', '/api/projections/reports', { customerId: 'nope', data })).status, 404);
  const list = await admin('GET', `/api/projections/reports?customer=${customerId}`);
  assert.deepEqual(list.body.reports.map((r) => r.id), [made.body.report.id]);
  const got = await admin('GET', `/api/projections/reports/${made.body.report.id}`);
  assert.equal(got.body.report.data.tr.totals.credits, 120.5);
  assert.ok(fs.existsSync(path.join(dataDir, 'projection-reports', `${made.body.report.id}.json`)), 'kept with the tenant’s data, and in backups');
  assert.equal((await admin('DELETE', `/api/projections/reports/${made.body.report.id}`)).status, 200);
  assert.equal((await admin('GET', `/api/projections/reports/${made.body.report.id}`)).status, 404);
});

test('the organisation name: an Admin may change it, a User may not', async () => {
  assert.equal((await uma('PUT', '/api/organisation-name', { name: 'Evil' })).status, 403);
  assert.equal((await admin('PUT', '/api/organisation-name', { name: '' })).status, 400);
  const changed = await admin('PUT', '/api/organisation-name', { name: 'Acme Partners EMEA' });
  assert.equal(changed.status, 200);
  assert.equal((await ana('GET', '/api/me')).body.organisationName, 'Acme Partners EMEA');
});

test('a deactivation code turns it off again; the customers stay for when it is back', async () => {
  const off = await admin('POST', '/api/activation', { code: script('calculator', keyFile, 'Acme Partners', 'off') });
  assert.equal(off.status, 200, off.text);
  assert.match(off.body.applied, /turned off/);
  assert.equal((await ana('GET', '/api/projections')).status, 403);
  assert.equal((await admin('GET', '/api/me')).body.unlocked.calculator, false);
  await admin('POST', '/api/activation', { code: script('calculator', keyFile, 'Acme Partners', 'on') });
  assert.equal((await ana('GET', '/api/projections')).body.customers.length, 1);
});
