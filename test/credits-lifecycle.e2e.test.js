// Credits, stage by stage: the real server against the mock Checkmarx One,
// checking allocation, use and the audit trail after every step of a
// triage → verdict → remediation cycle. Nothing may be counted twice, no
// allocation may jump while AI Triage runs, and every credit must be in the
// audit log.
import test from 'node:test';
import { freePort } from './free-port.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ReportGrants } from '../src/report-grants.js';

const MOCK_PORT = await freePort();
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const FLIP_MS = 2500; // the mock's AI Triage takes this long to publish verdicts
const KEY = (() => {
  const e = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${e({ alg: 'none' })}.${e({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' })}.sig`;
})();
const grants = new ReportGrants({ secret: 'lifecycle-test' });
const children = [];
let log = '';
let cookie = '';

async function admin(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function relay(url, body) {
  const r = await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The mock: p0 has 12 SAST findings r0..r11, severities cycling critical, high, medium, low.
// After triage, i % 3 === 0 becomes Confirmed (verdict vulnerable), the rest Proposed not exploitable.
const finding = (i, overrides = {}) => {
  const base = { projectId: 'p0', projectName: 'Project 0', riskId: `p0-r${i}`, scanId: 'scan-p0', scanner: 'SAST', alternateId: `alt-p0-r${i}`, groupId: `sim-p0-r${i}`, ...overrides };
  return { ...base, ...grants.issue(base) };
};
const CRITICAL_AND_HIGH = [0, 1, 4, 5, 8, 9];

async function balance() {
  const { body } = await relay('/api/relay/credits', { findings: [finding(0)] });
  const { triage, remediation } = body.projects.p0;
  return { triage: [triage.allocated, triage.used, triage.remaining], remediation: [remediation.allocated, remediation.used, remediation.remaining] };
}
async function dashboardRecalculation() {
  const r = await admin('POST', '/api/credits/refresh', { projectIds: ['p0'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return balance();
}

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-'));
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '2', RISKS: '12', FLIP_MS: String(FLIP_MS) }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: KEY, CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme', REPORT_SIGNING_KEY: 'lifecycle-test',
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: 'temporary password 1',
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
  const settings = await admin('PUT', '/api/settings', { aiTriage: { enabled: true, remediationEnabled: true, allowRetriage: false, allowReremediation: false, monthlyCreditLimit: 0 } });
  assert.equal(settings.status, 200, JSON.stringify(settings.body));
});

test.after(() => {
  for (const child of children) child.kill();
});

test('stage 0 — fetch: nothing is allocated on its own; the dashboard shows what is needed', async () => {
  const scan = await admin('GET', '/api/scan');
  assert.equal(scan.status, 200);
  assert.deepEqual(await balance(), { triage: [0, 0, 0], remediation: [0, 0, 0] }, 'a fetch never allocates');
  const p0 = scan.body.projects.find((p) => p.projectId === 'p0').credits;
  assert.deepEqual(p0.need, { triage: 6, remediation: 0 }, '6 critical/high findings to verify, none confirmed yet');
  assert.deepEqual(p0.shortfall, { triage: 6, remediation: 0 });
  // A report reader cannot triage before anyone allocated.
  const early = await relay('/api/relay/triage', { findings: [finding(0)] });
  assert.equal(early.body.results[0].status, 402, JSON.stringify(early.body));
  assert.deepEqual(await dashboardRecalculation(), { triage: [0, 0, 0], remediation: [0, 0, 0] }, 'nor does a refresh');
});

test('stage 0b — the administrator allocates what triage needs: exactly the findings to verify', async () => {
  const r = await admin('POST', '/api/credits/allocate', { projectIds: ['p0'], allocate: ['triage'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.given, 6);
  assert.deepEqual(await balance(), { triage: [6, 0, 6], remediation: [0, 0, 0] });
  const again = await admin('POST', '/api/credits/allocate', { projectIds: ['p0'], allocate: ['triage'] });
  assert.equal(again.body.given, 0, 'allocating again gives nothing more: the need is covered');
});

test('stage 1 — triage all: 6 charged, and the allocation does not jump while AI Triage runs', async () => {
  const r = await relay('/api/relay/triage', { findings: CRITICAL_AND_HIGH.map((i) => finding(i)) });
  assert.equal(r.status, 200);
  assert.ok(r.body.results.every((x) => x.ok), JSON.stringify(r.body));
  assert.deepEqual(await balance(), { triage: [6, 6, 0], remediation: [0, 0, 0] });
  assert.deepEqual(await dashboardRecalculation(), { triage: [6, 6, 0], remediation: [0, 0, 0] });
  assert.equal((await admin('GET', '/api/scan')).status, 200);
  assert.deepEqual(await balance(), { triage: [6, 6, 0], remediation: [0, 0, 0] }, 'a full re-fetch agrees');
});

test('stage 2 — triage all again while still running: refused, nothing charged', async () => {
  const r = await relay('/api/relay/triage', { findings: CRITICAL_AND_HIGH.map((i) => finding(i)) });
  assert.ok(r.body.results.every((x) => !x.ok && x.retriage), JSON.stringify(r.body));
  const dash = await admin('POST', '/api/triage/run', { projectIds: ['p0'], severities: ['CRITICAL', 'HIGH'] });
  assert.equal(dash.body.started ?? 0, 0, `dashboard "triage now" started nothing: ${JSON.stringify(dash.body)}`);
  assert.deepEqual(await balance(), { triage: [6, 6, 0], remediation: [0, 0, 0] });
});

test('stage 3 — verdicts arrive: remediation is needed for the confirmed ones only, and allocated only when asked', async () => {
  await sleep(FLIP_MS + 500);
  const refreshed = await admin('POST', '/api/credits/refresh', { projectIds: ['p0'] });
  assert.deepEqual(refreshed.body.projects.p0.need.remediation, 6, '2 confirmed (r0, r9) × 3; the 4 proposed not exploitable need nothing');
  assert.deepEqual(await balance(), { triage: [6, 6, 0], remediation: [0, 0, 0] }, 'verdicts never allocate on their own');
  const results = await relay('/api/relay/triage-results', { findings: CRITICAL_AND_HIGH.map((i) => finding(i)) });
  const states = Object.fromEntries(results.body.results.map((x, k) => [CRITICAL_AND_HIGH[k], x.state]));
  assert.deepEqual(states, { 0: 'CONFIRMED', 1: 'PROPOSED_NOT_EXPLOITABLE', 4: 'PROPOSED_NOT_EXPLOITABLE', 5: 'PROPOSED_NOT_EXPLOITABLE', 8: 'PROPOSED_NOT_EXPLOITABLE', 9: 'CONFIRMED' });
  const r = await admin('POST', '/api/credits/allocate', { projectIds: ['p0'], allocate: ['remediation'] });
  assert.equal(r.body.given, 6);
  assert.deepEqual(await balance(), { triage: [6, 6, 0], remediation: [6, 0, 6] });
});

test('stage 3b — the fence: AI Remediation is refused for anything not confirmed', async () => {
  for (const i of [1, 2]) {
    // r1: proposed not exploitable; r2: medium, never triaged (to verify).
    const r = await relay('/api/relay/remediate', { findings: [finding(i)] });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.notConfirmed, true);
  }
  assert.deepEqual(await balance(), { triage: [6, 6, 0], remediation: [6, 0, 6] }, 'nothing charged');
});

test('stage 4 — remediate one: 3 charged; doing it again is refused; allocation unchanged', async () => {
  const r = await relay('/api/relay/remediate', { findings: [finding(0)] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(await balance(), { triage: [6, 6, 0], remediation: [6, 3, 3] });
  assert.deepEqual(await dashboardRecalculation(), { triage: [6, 6, 0], remediation: [6, 3, 3] });
  const again = await relay('/api/relay/remediate', { findings: [finding(0)] });
  assert.ok([409].includes(again.status), `refused: ${again.status} ${JSON.stringify(again.body)}`);
  assert.deepEqual(await balance(), { triage: [6, 6, 0], remediation: [6, 3, 3] });
});

test('stage 4a — a fix as a git patch: the link needs the report grant, and the patch only comes once the fix is written', async () => {
  const forged = await relay('/api/relay/patch-link', { findings: [{ ...finding(0), alternateId: 'alt-p0-r1' }] });
  assert.equal(forged.status, 403, 'another finding under r0\'s grant');
  const r = await relay('/api/relay/patch-link', { findings: [finding(0)] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.url, /^http:\/\/[^/]+\/api\/relay\/patch\/[\w-]+\.[\w-]+$/);
  const token = r.body.url.split('/patch/')[1];
  const running = await fetch(`${BASE}/api/relay/patch/${token}`);
  assert.equal(running.status, 404, 'AI Remediation is still writing the fix');
  assert.match(await running.text(), /no code changes for this finding yet/);
  assert.equal(running.headers.get('cache-control'), 'no-store');
  const tampered = await fetch(`${BASE}/api/relay/patch/${token.replace(/^./, (c) => (c === 'e' ? 'f' : 'e'))}`);
  assert.equal(tampered.status, 404);
  assert.match(await tampered.text(), /incomplete or was changed/);
});

test('stage 4b — "Remediate selected" remediates the remaining confirmed finding only, from what was allocated', async () => {
  const r = await admin('POST', '/api/remediation/run', { projectIds: ['p0'], severities: ['CRITICAL', 'HIGH'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.started, 1, `r9 only: r0 is already remediated, the rest are not confirmed — ${JSON.stringify(r.body)}`);
  assert.equal(r.body.notConfirmed, 4);
  assert.deepEqual(await balance(), { triage: [6, 6, 0], remediation: [6, 6, 0] });
  const nothing = await admin('POST', '/api/remediation/run', { projectIds: ['p0'], severities: ['CRITICAL', 'HIGH'] });
  assert.equal(nothing.body.requested, 0, 'nothing confirmed is left to remediate');
});

test('stage 5 — two rows for one result are triaged and counted once', async () => {
  // r2 (medium) listed twice, e.g. the same vulnerability in two places: one result, one credit.
  await admin('POST', '/api/credits/allocate', { projectIds: ['p0'], triageAdd: 5 });
  const before = (await balance()).triage;
  const twin = finding(2, { riskId: 'p0-r2-copy' });
  const r = await relay('/api/relay/triage', { findings: [finding(2), twin] });
  assert.ok(r.body.results[0].ok, JSON.stringify(r.body));
  const after = (await balance()).triage;
  assert.equal(after[1] - before[1], 1, 'one credit for one result');
});

test('stage 6 — the monthly limit stops spending exactly at the limit', async () => {
  const used = (await balance()).triage[1] + (await balance()).remediation[1];
  await admin('PUT', '/api/settings', { aiTriage: { monthlyCreditLimit: used + 1 } });
  await admin('POST', '/api/credits/allocate', { projectIds: ['p0'], triageAdd: 10 });
  const two = await relay('/api/relay/triage', { findings: [finding(3), finding(6)] });
  assert.equal(two.body.results[0].status, 402, 'two would pass the limit');
  const one = await relay('/api/relay/triage', { findings: [finding(3)] });
  assert.ok(one.body.results[0].ok, 'one fits');
  const more = await relay('/api/relay/triage', { findings: [finding(6)] });
  assert.equal(more.body.results[0].status, 402, 'limit reached');
  await admin('PUT', '/api/settings', { aiTriage: { monthlyCreditLimit: 0 } });
});

test('stage 7 — every credit is in the audit log, and the log matches the ledger', async () => {
  const month = new Date().toISOString().slice(0, 7);
  const rec = await admin('GET', `/api/audit/reconcile?month=${month}`);
  assert.equal(rec.body.matched, true, JSON.stringify(rec.body));
  assert.equal(rec.body.ledgerTotal, rec.body.auditedTotal);
  // 6 + 1 (r2) + 1 (r3) triage, 3 + 3 remediation.
  assert.equal(rec.body.ledgerTotal, 14);
  const audit = (await admin('GET', '/api/audit?types=triage,remediation&limit=500')).body;
  assert.equal(audit.totals.charged, 14);
  assert.equal(audit.totals.triageCharged, 8);
  assert.equal(audit.totals.remediationCharged, 6);
  const refused = audit.entries.filter((e) => e.outcome === 'refused').map((e) => e.reason).join('\n');
  assert.match(refused, /re-triage is switched off/);
  assert.match(refused, /runs only on confirmed findings/);
  assert.match(refused, /month|limit/i);
  assert.equal((await admin('GET', '/api/audit/verify')).body.ok, true);
});
