// Cx Credits Calculator, end to end: a permission, no activation code (Admins have it; Security
// Analysts once an Admin ticks it); customers saved and reopened; the Fusion read against the mock
// Checkmarx One (lines of code, criticality, how often each project is scanned); reports kept,
// downloaded again and deleted by Admins only; the organisation name; and off again by unticking it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fusionEstimate, inScope } from '../public/calculator/model.js';
import { buildReport } from '../public/calculator/report.js';
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

let customerId = '';

/** Tick (or untick) the calculator for the built-in Security Analyst role, as an Admin does on People & roles. */
async function analystsGetCalculator(on) {
  const role = (await admin('GET', '/api/iam')).body.roles.find((r) => r.id === 'analyst');
  const permissions = on ? [...role.permissions, 'projections.use'] : role.permissions.filter((p) => p !== 'projections.use');
  const r = await admin('PUT', '/api/iam/roles/analyst', { name: role.name, description: role.description, permissions });
  assert.equal(r.status, 200, r.text);
}

test('a permission, with no activation code: Admins have it from the start, other roles once an Admin ticks it', async () => {
  const me = (await admin('GET', '/api/me')).body;
  assert.equal(me.unlocked.calculator, undefined, 'nothing to unlock');
  assert.ok(me.permissions.includes('projections.use'));
  assert.equal((await admin('GET', '/api/projections')).status, 200);
  assert.equal((await ana('GET', '/api/projections')).status, 403, 'not for Security Analysts until an Admin gives it to them');
  await analystsGetCalculator(true);
  assert.equal((await ana('GET', '/api/projections')).status, 200);
});

test('never for a role without the permission', async () => {
  assert.equal((await uma('GET', '/api/me')).body.permissions.includes('projections.use'), false);
  for (const [method, url] of [['GET', '/api/projections'], ['POST', '/api/projections'], ['POST', '/api/projections/fusion/read'], ['POST', '/api/projections/read'], ['GET', '/api/projections/read'], ['GET', '/api/projections/reports'], ['POST', '/api/projections/reports'], ['GET', '/api/projections/x'], ['PUT', '/api/projections/x'], ['DELETE', '/api/projections/x']]) {
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
  assert.equal(opened.tr.lookbackMonths, 3, '"Latest" is gone: the trend is always read over months');
  assert.deepEqual([opened.tr.selected.Medium, opened.tr.includeFuture, opened.tr.fusionUpliftPercent, opened.tr.faePercent, opened.tr.aiDeclinePercent], [null, true, 5, 10, 2], 'not chosen: every open finding; and the defaults for what is ahead');
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

test('one read in the background fills both tabs from Checkmarx One: the backlog week by week, and the projects', async () => {
  assert.equal((await ana('GET', '/api/projections/read')).body.state, 'none', 'nothing read yet');
  const started = await ana('POST', '/api/projections/read', {});
  assert.equal(started.status, 202, started.text);
  assert.equal(started.body.state, 'running');
  const again = await admin('POST', '/api/projections/read', {});
  assert.equal(again.body.id, started.body.id, 'one read at a time per tenant: a second one follows the first');
  let job = started.body;
  const end = Date.now() + 20000;
  while (job.state === 'running') {
    assert.ok(Date.now() < end, 'the read finishes');
    await sleep(100);
    job = (await ana('GET', '/api/projections/read')).body;
  }
  assert.equal(job.state, 'done', job.error ?? '');
  const { projects, tr } = job.result;
  assert.equal(projects.length, PROJECTS);
  assert.equal(tr.totals.weeks.length, 52);
  assert.equal(tr.totals.meta.source, 'cxone');
  assert.equal(tr.totals.meta.projects, PROJECTS);
  const backlog = (i) => ['Critical', 'High', 'Medium', 'Low'].reduce((n, s) => n + tr.totals.bySeverity[s][i], 0);
  assert.ok(backlog(51) > 0 && backlog(0) > backlog(51), 'the mock’s backlog shrinks over the year');
  assert.ok(tr.fixed.bySeverity.Low.some((n) => n > 0), 'fixes week by week');
  const saved = await ana('PUT', `/api/projections/${customerId}`, { tr: { totals: tr.totals, fixed: tr.fixed } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal((await ana('GET', `/api/projections/${customerId}`)).body.customer.tr.totals.meta.scans, tr.totals.meta.scans);
  // Each project says its applications, groups and who last scanned it, for narrowing the projects.
  const p1 = projects.find((p) => p.id === 'p1');
  assert.deepEqual([p1.applications, p1.groups, p1.initiator], [['Mobile'], ['team-b'], 'dev1@acme.com']);
  assert.ok(!('perProject' in job.result), 'each project’s weeks stay on the server');

  // A scope: the backlog of its projects only, from the same read (no second read of Checkmarx One).
  const mobile = projects.filter((p) => inScope(p, { applications: ['mobile'] })).map((p) => p.id);
  assert.equal(mobile.length, Math.ceil((PROJECTS - 1) / 4));
  const scoped = await ana('POST', '/api/projections/series', { projectIds: mobile });
  assert.equal(scoped.status, 200, scoped.text);
  assert.equal(scoped.body.totals.meta.projects, mobile.length);
  assert.equal(scoped.body.totals.meta.scoped, true);
  const whole = await ana('POST', '/api/projections/series', { projectIds: projects.map((p) => p.id) });
  assert.deepEqual(whole.body.totals.bySeverity, tr.totals.bySeverity, 'every project: the tenant’s own backlog');
  const rest = await ana('POST', '/api/projections/series', { projectIds: projects.filter((p) => !mobile.includes(p.id)).map((p) => p.id) });
  const at = (b, i) => ['Critical', 'High', 'Medium', 'Low'].reduce((n, s) => n + b.totals.bySeverity[s][i], 0);
  assert.equal(at(scoped.body, 51) + at(rest.body, 51), at(whole.body, 51), 'a scope and the rest add up to the whole');
  assert.equal((await ana('POST', '/api/projections/series', { projectIds: ['__proto__', 'constructor'] })).body.totals.meta.projects, 0);
  assert.equal((await uma('POST', '/api/projections/series', { projectIds: mobile })).status, 403);
  const scope = await ana('PUT', `/api/projections/${customerId}`, { scope: { applications: ['Mobile', '<b>'], names: ['web-*'], frequencies: ['month', 'hourly'], criticalities: [5, 9] } });
  assert.equal(scope.status, 200, scope.text);
  assert.deepEqual((await ana('GET', `/api/projections/${customerId}`)).body.customer.scope, { applications: ['Mobile', '<b>'], projects: [], groups: [], initiators: [], names: ['web-*'], frequencies: ['month'], criticalities: [5], leaveOutNoCode: true, leaveOutNoFindings: false });
});

test('a report is emailed as its file, to the addresses typed, and only when it is one', async () => {
  const data = { organisation: 'Acme Partners', customer: 'Globex', generatedAt: new Date().toISOString(), tr: { totals: { credits: 12, selected: 3 } } };
  const made = await ana('POST', '/api/projections/reports', { customerId, data });
  const id = made.body.report.id;
  const html = buildReport(data);
  const send = (body) => ana('POST', `/api/projections/reports/${id}/email`, { html, ...body });
  assert.equal((await send({ to: '' })).status, 400, 'nobody to send to');
  assert.match((await send({ to: 'not-an-address' })).body.error, /Not an email address/);
  assert.equal((await send({ to: Array.from({ length: 11 }, (_, i) => `p${i}@acme.io`) })).status, 400, 'at most 10');
  assert.equal((await send({ to: 'bhawani.singh@checkmarx.com' })).status, 400, 'the maintainer is never written to from here');
  for (const bad of ['<html><body>hi</body></html>', `${html}<script>alert(1)</script>`, html.replace('<body>', '<body onload="x()">'), html.replace('<main>', '<main><iframe src="https://evil.example"></iframe>')]) {
    assert.equal((await ana('POST', `/api/projections/reports/${id}/email`, { to: 'kim@acme.io', html: bad })).status, 400, bad.slice(-80));
  }
  assert.equal((await ana('POST', '/api/projections/reports/00000000-0000-0000-0000-000000000000/email', { to: 'kim@acme.io', html })).status, 404);
  assert.equal((await uma('POST', `/api/projections/reports/${id}/email`, { to: 'kim@acme.io', html })).status, 403);
  // This server has no tested mail server: said plainly, nothing sent.
  const unsent = await send({ to: 'kim@acme.io, lee@acme.io' });
  assert.equal(unsent.status, 409, unsent.text);
  assert.match(unsent.body.error, /email server/i);
  assert.equal((await admin('DELETE', `/api/projections/reports/${id}`)).status, 200);
});

test('reports are kept, listed, downloaded again and deleted', async () => {
  const data = { organisation: 'Acme Partners', customer: 'Globex', generatedAt: new Date().toISOString(), tr: { totals: { credits: 120.5, selected: 11 } }, fusion: { periodMonths: 12, totals: { credits: 30, scans: 40 } } };
  const made = await ana('POST', '/api/projections/reports', { customerId, data });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.body.report.totalCredits, 150.5);
  assert.equal(made.body.report.bundles, 1);
  const extra = await ana('POST', '/api/projections/reports', { customerId, data: { ...data, summary: { settings: { extraPercent: 20, bundleCredits: 100 } } } });
  assert.equal(extra.body.report.totalCredits, 180.6, 'the extra % on top, worked out again by the server');
  assert.equal(extra.body.report.extraPercent, 20);
  assert.equal(extra.body.report.bundles, 2, '180.6 credits in bundles of 100');
  assert.equal((await admin('DELETE', `/api/projections/reports/${extra.body.report.id}`)).status, 200);
  assert.equal(made.body.report.customer, 'Globex — renewal');
  assert.equal((await ana('POST', '/api/projections/reports', { customerId: 'nope', data })).status, 404);
  const list = await admin('GET', `/api/projections/reports?customer=${customerId}`);
  assert.deepEqual(list.body.reports.map((r) => r.id), [made.body.report.id]);
  const got = await admin('GET', `/api/projections/reports/${made.body.report.id}`);
  assert.equal(got.body.report.data.tr.totals.credits, 120.5);
  assert.ok(fs.existsSync(path.join(dataDir, 'projection-reports', `${made.body.report.id}.json`)), 'kept with the tenant’s data, and in backups');
  assert.equal((await ana('DELETE', `/api/projections/reports/${made.body.report.id}`)).status, 403, 'deleting a report is the Admin role’s alone');
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

test('unticked again, the calculator is gone for that role; the customers stay for when it is back', async () => {
  await analystsGetCalculator(false);
  assert.equal((await ana('GET', '/api/projections')).status, 403);
  await analystsGetCalculator(true);
  assert.equal((await ana('GET', '/api/projections')).body.customers.length, 1);
});
