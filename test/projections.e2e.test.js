// Credit projections, end to end: who may open them, saving and reopening a profile, the lines of
// code read from Checkmarx One (the mock: one project in seven has no SAST scan metadata), and
// the calculator page served so that only this server's own page can show it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fusionEstimate } from '../public/projections/fusion.js';
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
    return { status: res.status, body: json, text, headers: res.headers };
  };
}
const admin = browser();
const ana = browser();
const uma = browser();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projections-'));
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: String(PROJECTS), RISKS: '2' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
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
});

test.after(() => {
  for (const child of children) child.kill();
});

test('Admins and Security Analysts have Credit projections; a User does not', async () => {
  assert.ok((await admin('GET', '/api/me')).body.permissions.includes('projections.use'));
  assert.ok((await ana('GET', '/api/me')).body.permissions.includes('projections.use'));
  assert.equal((await uma('GET', '/api/me')).body.permissions.includes('projections.use'), false);
  for (const [method, url] of [['GET', '/api/projections'], ['POST', '/api/projections'], ['POST', '/api/projections/fusion/lines'], ['GET', '/api/projections/x'], ['PUT', '/api/projections/x'], ['DELETE', '/api/projections/x']]) {
    assert.equal((await uma(method, url, method === 'GET' ? undefined : {})).status, 403, `${method} ${url}`);
  }
  assert.equal((await fetch(`${BASE}/api/projections`)).status, 401, 'signed out');
});

test('a profile is saved as it is worked on, and opens again as it was left', async () => {
  const created = await ana('POST', '/api/projections', { name: 'Globex demo' });
  assert.equal(created.status, 201, created.text);
  const { id } = created.body.profile;

  const alaCarte = { customer: 'Globex', preparedBy: 'Ana', totals: { weeks: ['2026-09-07', '2026-09-14'], bySeverity: { Critical: [4, 5], High: [10, 12] }, meta: { fileName: 'Total.xlsx' } }, fixed: { weeks: ['2026-09-07', '2026-09-14'], bySeverity: { Critical: [1, 2] }, meta: { fileName: 'Fixed.xlsx' } }, plan: { Critical: { selected: 5, fp: 20 } }, planTouched: true, assumptions: { triageCredits: 1, remediationCredits: 3 }, horizonMonths: 6 };
  const saved = await ana('PUT', `/api/projections/${id}`, { alaCarte, fusion: { bundleLoc: 10000, creditsPerBundle: 1, projects: [{ id: 'manual-1', name: 'Prospect app', locOverride: 12000, source: 'manual' }, { id: 'manual-2', name: 'Prospect API', locOverride: 18000, source: 'manual' }] } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.body.profile.customer, 'Globex');
  assert.equal(saved.body.profile.hasAlaCarte, true);
  assert.equal(saved.body.profile.updatedBy, 'ana@acme.io');

  const list = await admin('GET', '/api/projections');
  assert.equal(list.body.profiles[0].id, id, 'the people who may use projections share them');
  assert.equal('alaCarte' in list.body.profiles[0], false, 'the list is only the summaries');

  const opened = (await admin('GET', `/api/projections/${id}`)).body.profile;
  assert.equal(opened.name, 'Globex demo');
  assert.deepEqual(opened.alaCarte.totals.bySeverity.High, [10, 12]);
  assert.deepEqual(opened.alaCarte.plan, { Critical: { selected: 5, fp: 20 } });
  assert.equal(fusionEstimate(opened.fusion.projects, opened.fusion).bundles, 4, '12,000 + 18,000 lines: 2 + 2 bundles');

  assert.equal((await ana('PUT', `/api/projections/${id}`, { name: 'Globex — renewal' })).body.profile.name, 'Globex — renewal');
  assert.equal((await ana('PUT', '/api/projections/nope', { name: 'x' })).status, 404);
  const tooBig = await ana('PUT', `/api/projections/${id}`, { alaCarte: { ...alaCarte, logoDataUrl: `data:image/png;base64,${'A'.repeat(3.2 * 1024 * 1024)}` } });
  assert.equal(tooBig.status, 413, tooBig.text.slice(0, 200));
  assert.equal((await ana('GET', `/api/projections/${id}`)).body.profile.alaCarte.customer, 'Globex', 'a save refused leaves what was there');

  // Kept with the rest of this tenant's data (and so in its backups).
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'projections.json'), 'utf8'));
  assert.equal(stored.profiles.find((p) => p.id === id).alaCarte.customer, 'Globex');

  assert.equal((await ana('DELETE', `/api/projections/${id}`)).status, 200);
  assert.equal((await ana('GET', `/api/projections/${id}`)).status, 404);
});

test('Fusion reads every project’s lines of code from its last scan', async () => {
  const read = await admin('POST', '/api/projections/fusion/lines', {});
  assert.equal(read.status, 200, read.text.slice(0, 300));
  const { projects, readAt } = read.body;
  assert.ok(Date.parse(readAt));
  assert.equal(projects.length, PROJECTS);
  const byId = Object.fromEntries(projects.map((p) => [p.id, p]));
  const loc = (i) => 1500 + ((i * 7919) % 48000);
  assert.deepEqual([byId.p0.loc, byId.p0.source, byId.p0.scanId], [loc(0), 'sast-metadata', 'scan-p0']);
  assert.deepEqual([byId.p10.loc, byId.p10.source], [loc(10), 'scan'], 'no scan metadata: the scan’s SAST details');
  assert.deepEqual([byId.p3.loc, byId.p3.source], [null, 'none'], 'neither: to be typed in');
  assert.ok(byId.p1.scanAt);
  const estimate = fusionEstimate(projects, { bundleLoc: 10000, creditsPerBundle: 1 });
  assert.equal(estimate.unknown, projects.filter((p) => p.loc === null).length);
  assert.equal(estimate.bundles, projects.reduce((sum, p) => sum + (p.loc ? Math.ceil(p.loc / 10000) : 0), 0));
  assert.ok(estimate.bundles >= estimate.pooledBundles);
});

test('the calculator is served to be shown inside this server’s own page only', async () => {
  const page = await fetch(`${BASE}/projections/calculator/index.html`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  const html = await page.text();
  for (const [, src] of html.matchAll(/<script src="([^"]+)"/g)) assert.equal((await fetch(`${BASE}/projections/calculator/${src}`)).status, 200, src);
  assert.equal((await fetch(`${BASE}/projections/calculator/samples/Total_Vulnerabilities_by_Severity.xlsx`)).status, 200);
  const app = await fetch(`${BASE}/`);
  assert.equal(app.headers.get('x-frame-options'), 'DENY', 'the app itself is never framed');
  assert.match(app.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});
