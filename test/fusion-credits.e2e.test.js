// Credits → Fusion credits (from MZ-01.01.19), for real against the mock Checkmarx One: the tenant's Fusion projects
// read on their branch; recommendations as the Cx Credits Calculator's Fusion plan works them out; rates set by
// Admins only; allocations from the tenant's credits, with Triage & Remediation, never beyond them; a project whose
// credits are spent has Fusion paused in its Checkmarx One settings, and back as it was once credits are added; the
// plan from the calculator; another branch; the planned Fusion scans scheduled in one click; and more lines of code
// than the credits were worked out for ask Admins and Security Analysts for more.
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
const KEY = mockApiKey({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' });
const children = [];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-credits-'));
let log = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function browser() {
  let cookie = '';
  return async (method, url, body) => {
    const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const raw = await r.text();
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {}
    return { status: r.status, body: json, raw };
  };
}
const admin = browser();
const analyst = browser();
const mock = async (p) => (await fetch(MOCK + p)).json();

async function signIn(b, email) {
  await b('POST', '/api/session/password', { email, password: FIRST_PASSWORD });
  assert.equal((await b('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD })).status, 200);
}

/** The page, read again until `done` says so. */
async function until(done, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const view = (await admin('GET', '/api/fusion-credits')).body;
    if (done(view)) return view;
    if (Date.now() > end) throw new Error(`Timed out: ${JSON.stringify(view?.job)}\n${log.slice(-2000)}`);
    await sleep(150);
  }
}
const row = (view, id) => view.projects.find((p) => p.id === id);
const auditOf = async () => (await admin('GET', '/api/audit?limit=200')).body.entries;

test.before(async () => {
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '0', PROJECTS: '6', RISKS: '4', TENANT_CREDITS: '3000', BRANCHES: '1' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', HTTPS: 'off', DATA_DIR: path.join(dir, 'data'), ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0', BACKUP_ENCRYPTION: 'off', SMTP_HOST: '', CX_API_KEY: KEY, CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme', ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  children.push(server);
  for (let i = 0; i < 150 && !/Successfully authenticated/.test(log); i++) await sleep(100);
  await signIn(admin, 'admin@acme.io');
  assert.equal((await admin('POST', '/api/iam/users', { email: 'sam@acme.io', role: 'analyst', password: FIRST_PASSWORD })).status, 201);
  await signIn(analyst, 'sam@acme.io');
});

test.after(async () => {
  for (const c of children) c.kill();
  await sleep(300);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

test('the tenant\'s Fusion projects are read on their branch, and recommended as the calculator works it out', async () => {
  const start = await admin('GET', '/api/fusion-credits');
  assert.equal(start.status, 200);
  // A new installation starts with the rates it was given.
  assert.deepEqual([start.body.settings.rates['opus-5.5'], start.body.settings.rates['opus-4.7'], start.body.settings.rates['haiku-4.5']], [2, 2.5, 1.5]);
  assert.equal(start.body.settings.pauseWhenSpent, true);
  assert.equal((await admin('POST', '/api/fusion-credits/read')).status, 202);
  const view = await until((v) => v.job.state === 'done');
  // Projects 0, 1 and 3 ran Fusion last (2 and 5 no AI engine; 4 LAST).
  assert.deepEqual(view.projects.filter((p) => p.scanType === 'fusion').map((p) => p.id).sort(), ['p0', 'p1', 'p3']);
  const p0 = row(view, 'p0');
  assert.equal(p0.branch, 'main');
  assert.equal(p0.model, 'mythos-5.1', 'the model its scan ran with');
  assert.ok(p0.loc > 0 && p0.units === Math.ceil(p0.loc / 10000));
  assert.equal(p0.frequency, 'more-5-week', 'scanned 400 times a year');
  assert.equal(p0.planned, 52, 'the calculator\'s plan for that frequency');
  assert.equal(p0.recommended, null, 'no rate for mythos-5.1 yet');
  assert.equal(view.tenant.available, 3000);
});

test('only an Admin sets the rates; then each project is recommended its blocks × planned scans × rate', async () => {
  assert.equal((await analyst('PUT', '/api/fusion-credits/rates', { rates: [{ model: 'mythos-5.1', creditsPer10k: 3 }] })).status, 403);
  const bad = await admin('PUT', '/api/fusion-credits/rates', { rates: [{ model: 'opus-5.5', creditsPer10k: -1 }] });
  assert.equal(bad.status, 400);
  const saved = await admin('PUT', '/api/fusion-credits/rates', { rates: [{ model: 'opus-5.5', creditsPer10k: 2 }, { model: 'opus-4.7', creditsPer10k: 2.5 }, { model: 'haiku-4.5', creditsPer10k: 1.5 }, { model: 'mythos-5.1', creditsPer10k: 3 }, { model: 'opus-5.0', creditsPer10k: 1 }] });
  assert.equal(saved.status, 200, saved.raw);
  const p0 = row(saved.body, 'p0');
  assert.equal(p0.recommended, p0.units * 52 * 3);
  const p1 = row(saved.body, 'p1');
  assert.equal(p1.model, 'opus-5.0');
  assert.equal(p1.recommended, p1.units * p1.planned * 1);
  assert.ok((await auditOf()).some((e) => e.type === 'settings' && /Fusion rates changed/.test(e.reason) && /mythos-5\.1 — → 3/.test(e.reason)));
});

test('allocations come out of the tenant\'s credits: with Triage & Remediation, never more than it has left', async () => {
  const view = (await admin('GET', '/api/fusion-credits')).body;
  const too = await admin('POST', '/api/fusion-credits/allocate', { projects: [{ id: 'p0', credits: 5000 }] });
  assert.equal(too.status, 409);
  assert.match(too.body.error, /3,000 credits left/);
  // The analyst may allocate (credits.allocate), not set rates.
  const p3 = row(view, 'p3');
  const given = await analyst('POST', '/api/fusion-credits/allocate', { projects: [{ id: 'p3', credits: p3.recommended }] });
  assert.equal(given.status, 200, given.raw);
  const after = row(given.body, 'p3');
  assert.deepEqual([after.allocated, after.used, after.left, after.standing], [p3.recommended, 0, p3.recommended, 'ok']);
  assert.equal(after.plan.scans, p3.planned);
  assert.equal(after.plan.loc, p3.loc);
  assert.equal(given.body.tenant.fusionHeld, p3.recommended);
  assert.equal(given.body.tenant.free, 3000 - p3.recommended);
  assert.ok((await auditOf()).some((e) => e.type === 'allocation' && e.credits?.kind === 'fusion' && /Fusion credits allocated/.test(e.reason)));
});

test('a project whose Fusion credits are spent has Fusion paused in Checkmarx One, and back as it was once credits are added', async () => {
  const view = (await admin('GET', '/api/fusion-credits')).body;
  const p1 = row(view, 'p1');
  const cost = p1.units * 1;
  // Credits for two Fusion scans; then three run.
  assert.equal((await admin('POST', '/api/fusion-credits/allocate', { projects: [{ id: 'p1', credits: cost * 2 }] })).status, 200);
  await mock('/__fusion-scan?project=p1&count=3');
  assert.equal((await admin('POST', '/api/fusion-credits/read')).status, 202);
  let now = await until((v) => v.job.state === 'done' && row(v, 'p1').usedScans === 3);
  assert.deepEqual([row(now, 'p1').used, row(now, 'p1').left, row(now, 'p1').standing], [cost * 3, -cost, 'spent']);
  assert.ok(row(now, 'p1').paused, 'paused');
  assert.equal((await mock('/__project-settings')).p1?.['scan.config.ai.fusionEnabled'], 'false');
  assert.ok((await auditOf()).some((e) => e.type === 'system' && /Fusion paused in Checkmarx One/.test(e.reason)));
  // More credits: Fusion is back, and as it was (the tenant's: the project's own setting is removed again).
  const more = await admin('POST', '/api/fusion-credits/allocate', { projects: [{ id: 'p1', credits: cost * 3, mode: 'add' }] });
  assert.equal(more.status, 200);
  now = more.body;
  assert.equal(row(now, 'p1').paused, null);
  assert.equal(row(now, 'p1').left, cost * 2);
  assert.equal((await mock('/__project-settings')).p1?.['scan.config.ai.fusionEnabled'], undefined);
  assert.ok((await auditOf()).some((e) => /Fusion back on in Checkmarx One/.test(e.reason) && /the tenant's setting applies again/.test(e.reason)));
});

test('warn only: an Admin\'s choice puts back what was paused, and pauses nothing more', async () => {
  // Spend p1's credits again.
  await mock('/__fusion-scan?project=p1&count=3');
  await admin('POST', '/api/fusion-credits/read');
  await until((v) => v.job.state === 'done' && row(v, 'p1').paused);
  const rates = (await admin('GET', '/api/fusion-credits')).body.settings.rates;
  const set = await admin('PUT', '/api/fusion-credits/rates', { rates: Object.entries(rates).map(([model, creditsPer10k]) => ({ model, creditsPer10k })), pauseWhenSpent: false });
  assert.equal(set.status, 200);
  assert.equal(row(set.body, 'p1').paused, null);
  assert.equal(row(set.body, 'p1').standing, 'spent');
  assert.equal((await mock('/__project-settings')).p1?.['scan.config.ai.fusionEnabled'], undefined);
  await admin('PUT', '/api/fusion-credits/rates', { rates: Object.entries(rates).map(([model, creditsPer10k]) => ({ model, creditsPer10k })), pauseWhenSpent: true });
});

test('another branch: the project is read there, its usual protected branches offered first', async () => {
  const list = await admin('GET', '/api/fusion-credits/branches?project=p3');
  assert.equal(list.status, 200);
  const names = list.body.branches.map((b) => b.name);
  assert.equal(names[0], 'main', 'its primary branch first');
  assert.deepEqual(names.slice(1, 4), ['develop', 'release/2.1', 'security/patch-7']);
  assert.equal(list.body.branches.find((b) => b.name === 'security/patch-7').protected, 'security');
  const moved = await admin('PUT', '/api/fusion-credits/branch', { projectId: 'p3', branch: 'develop' });
  assert.equal(moved.status, 200, moved.raw);
  assert.equal(row(moved.body, 'p3').branchChosen, true);
  const back = await admin('PUT', '/api/fusion-credits/branch', { projectId: 'p3', branch: '' });
  assert.equal(row(back.body, 'p3').branch, 'main');
  assert.equal(row(back.body, 'p3').branchChosen, false);
});

test('a Fusion plan file from the calculator becomes the plan: its period, its rules and each project\'s own choices', async () => {
  const wrong = await admin('POST', '/api/fusion-credits/plan/import', { file: { kind: 'something-else' } });
  assert.equal(wrong.status, 400);
  const file = {
    kind: 'cx-fusion-plan',
    version: 1,
    customer: 'Acme Bank',
    fusion: {
      periodMonths: 6,
      combine: 'frequency',
      defaultScans: 1,
      models: [{ id: 'm1', name: 'mythos-5.1', creditsPer10k: 4 }, { id: 'm2', name: 'opus-5.0', creditsPer10k: 1 }],
      byFrequency: { 'more-5-week': { scans: 10, model: null } },
      projects: [{ id: 'p0', name: 'Project 0', scansOverride: 3, modelOverride: 'm2' }, { id: 'manual-1', name: 'Typed in' }],
    },
  };
  const used = await admin('POST', '/api/fusion-credits/plan/import', { file });
  assert.equal(used.status, 200, used.raw);
  assert.equal(used.body.settings.plan.periodMonths, 6);
  assert.equal(used.body.settings.plan.source.name, 'Acme Bank');
  assert.equal(used.body.settings.plan.calculatorRates['mythos-5.1'], 4, 'the calculator\'s rates are shown beside');
  const p0 = row(used.body, 'p0');
  assert.deepEqual([p0.planned, p0.plannedModel], [3, 'opus-5.0'], 'the project\'s own scans and model');
  assert.equal(p0.recommended, p0.units * 3 * 1, 'at the Admin\'s rate for its model');
  assert.ok((await auditOf()).some((e) => /now follow the Cx Credits Calculator's plan "Acme Bank"/.test(e.reason)));
});

test('the planned Fusion scans are scheduled in one click: the first now, on its branch, with its model; only while credits last', async () => {
  const view = (await admin('GET', '/api/fusion-credits')).body;
  const p0 = row(view, 'p0');
  // Credits for exactly its plan.
  assert.equal((await admin('POST', '/api/fusion-credits/allocate', { projects: [{ id: 'p0', credits: p0.recommended }] })).status, 200);
  const nothing = await admin('POST', '/api/fusion-credits/schedule', { projectIds: ['p5'] });
  assert.equal(nothing.body.skipped[0].why, 'Give it Fusion credits for the plan first.');
  const scheduled = await admin('POST', '/api/fusion-credits/schedule', { projectIds: ['p0'] });
  assert.equal(scheduled.status, 200, scheduled.raw);
  const s = row(scheduled.body, 'p0').schedule;
  assert.equal(s.started.length, 1, 'the first started at once');
  assert.equal(s.left, 2);
  const started = Object.values(await mock('/__rescans')).filter((r) => r.projectId === 'p0' && r.tags?.cxmissionzero === 'fusion-plan');
  assert.equal(started.length, 1);
  assert.equal(started[0].branch, 'main');
  assert.deepEqual(started[0].config.find((c) => c.type === 'ai').value, { fusionEnabled: 'true', llmModel: 'opus-5.0' });
  assert.ok(started[0].config.some((c) => c.type === 'sast'));
  const stopped = await admin('POST', '/api/fusion-credits/schedule/stop', { projectIds: ['p0'] });
  assert.equal(row(stopped.body, 'p0').schedule.stopped, true);
});

test('more lines of code than the credits were worked out for: the extra needed is said, and asked for once', async () => {
  const before = row((await admin('GET', '/api/fusion-credits')).body, 'p3');
  assert.equal(before.shortfall.extra, 0);
  // The project grows: its next scan counts twice the lines.
  await mock('/__loc?project=p3&times=2');
  await admin('POST', '/api/fusion-credits/read');
  const view = await until((v) => v.job.state === 'done' && row(v, 'p3').units > before.units);
  const p3 = row(view, 'p3');
  assert.ok(p3.shortfall.extra > 0, JSON.stringify(p3.shortfall));
  assert.equal(p3.locAlert.units, p3.units);
  const asked = (await auditOf()).filter((e) => e.project?.id === 'p3' && /more Fusion credits to finish its plan/.test(e.reason));
  assert.equal(asked.length, 1);
  assert.match(asked[0].reason, /grew from/);
  // Read again with nothing new: not asked again.
  await admin('POST', '/api/fusion-credits/read');
  await until((v) => v.job.state === 'done');
  assert.equal((await auditOf()).filter((e) => e.project?.id === 'p3' && /more Fusion credits to finish its plan/.test(e.reason)).length, 1);
});

test('Triage & Remediation allocations count what Fusion holds: the tenant\'s credits are given once', async () => {
  const view = (await admin('GET', '/api/fusion-credits')).body;
  assert.ok(view.tenant.fusionHeld > 0);
  assert.equal(view.tenant.free, Math.round((3000 - view.tenant.triageRemediationHeld - view.tenant.fusionHeld) * 100) / 100);
});

test('someone who may only view credits sees the page but cannot read, allocate or change the plan', async () => {
  const viewer = browser();
  assert.equal((await admin('POST', '/api/iam/users', { email: 'uma@acme.io', role: 'user', password: FIRST_PASSWORD })).status, 201);
  await signIn(viewer, 'uma@acme.io');
  const seen = await viewer('GET', '/api/fusion-credits');
  if (seen.status === 200) {
    assert.equal(seen.body.may.allocate, false);
    assert.equal(seen.body.may.rates, false);
  } else assert.equal(seen.status, 403);
  assert.equal((await viewer('POST', '/api/fusion-credits/allocate', { projects: [{ id: 'p0', credits: 1 }] })).status, 403);
  assert.equal((await viewer('POST', '/api/fusion-credits/read')).status, 403);
  assert.equal((await viewer('PUT', '/api/fusion-credits/plan', { periodMonths: 3 })).status, 403);
  assert.equal((await viewer('POST', '/api/fusion-credits/schedule', { projectIds: ['p0'] })).status, 403);
});
