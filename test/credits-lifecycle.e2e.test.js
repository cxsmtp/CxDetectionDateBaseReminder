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
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, BACKUP_INTERVAL_HOURS: '0',
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

test('stage 0 — fetch: triage covers each critical/high finding to verify once; nothing to remediate yet', async () => {
  assert.equal((await admin('GET', '/api/scan')).status, 200);
  assert.deepEqual(await balance(), { triage: [6, 0, 6], remediation: [0, 0, 0] });
});

test('stage 1 — triage all: 6 charged, and the allocation does not jump while AI Triage runs', async () => {
  const r = await relay('/api/relay/triage', { findings: CRITICAL_AND_HIGH.map((i) => finding(i)) });
  assert.equal(r.status, 200);
  assert.ok(r.body.results.every((x) => x.ok), JSON.stringify(r.body));
  assert.deepEqual(await balance(), { triage: [6, 6, 0], remediation: [0, 0, 0] });
  // The findings still read "To verify" while AI Triage runs: the dashboard's recalculation used to count them again (6 → 12).
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

test('stage 3 — verdicts arrive: remediation is allocated 3 per confirmed finding; triage stays as used', async () => {
  await sleep(FLIP_MS + 500);
  // r0 and r9 are confirmed (vulnerable); r1, r4, r5, r8 proposed not exploitable.
  assert.deepEqual(await dashboardRecalculation(), { triage: [6, 6, 0], remediation: [6, 0, 6] });
  const results = await relay('/api/relay/triage-results', { findings: CRITICAL_AND_HIGH.map((i) => finding(i)) });
  const states = Object.fromEntries(results.body.results.map((x, k) => [CRITICAL_AND_HIGH[k], x.state]));
  assert.deepEqual(states, { 0: 'CONFIRMED', 1: 'PROPOSED_NOT_EXPLOITABLE', 4: 'PROPOSED_NOT_EXPLOITABLE', 5: 'PROPOSED_NOT_EXPLOITABLE', 8: 'PROPOSED_NOT_EXPLOITABLE', 9: 'CONFIRMED' });
  assert.ok(results.body.results.every((x) => x.triagedAt), 'every one is known as triaged');
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
  // 6 + 1 (r2) + 1 (r3) triage, 3 remediation.
  assert.equal(rec.body.ledgerTotal, 11);
  const audit = (await admin('GET', '/api/audit?types=triage,remediation&limit=500')).body;
  assert.equal(audit.totals.charged, 11);
  assert.equal(audit.totals.triageCharged, 8);
  assert.equal(audit.totals.remediationCharged, 3);
  const refused = audit.entries.filter((e) => e.outcome === 'refused').map((e) => e.reason).join('\n');
  assert.match(refused, /re-triage is switched off/);
  assert.match(refused, /month|limit/i);
  assert.equal((await admin('GET', '/api/audit/verify')).body.ok, true);
});
