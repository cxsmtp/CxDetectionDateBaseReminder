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
import { fakeSmtp } from './fake-smtp.js';
import { FIRST_PASSWORD, NEXT_PASSWORD, mockApiKey } from './test-credentials.js';

const MOCK_PORT = await freePort();
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const FLIP_MS = 2500; // the mock's AI Triage takes this long to publish verdicts
const KEY = mockApiKey({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' });
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

test('stage 8 — clean slate: every project\'s unused credits come back to the pool, without loading findings; used ones stay', async () => {
  await admin('POST', '/api/credits/allocate', { projectIds: ['p0'], triageAdd: 4 });
  const before = (await admin('GET', '/api/credits')).body.allocations.find((p) => p.projectId === 'p0');
  const unused = before.triage.remaining + before.remediation.remaining;
  assert.ok(unused >= 4, JSON.stringify(before));
  assert.equal((await admin('POST', '/api/credits/reclaim', {})).status, 400, 'say which projects, or all');
  const r = await admin('POST', '/api/credits/reclaim', { all: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.reclaimed, unused);
  const after = r.body.allocations.find((p) => p.projectId === 'p0');
  assert.equal(after.triage.remaining + after.remediation.remaining, 0);
  assert.equal(after.triage.used, before.triage.used, 'used credits stay counted');
  assert.equal(after.triage.allocated, before.triage.used);
  assert.equal((await admin('POST', '/api/credits/reclaim', { projectIds: ['p0'] })).body.reclaimed, 0, 'nothing left to take back');
  const audit = (await admin('GET', '/api/audit?types=allocation&limit=50')).body;
  assert.ok(audit.entries.some((e) => /clean slate/.test(e.reason)), 'the take-back is in the audit log');
  assert.equal((await admin('GET', '/api/audit/verify')).body.ok, true);
});

test('stage 9 — credits are given on the Credit Control page too: any Checkmarx One project, no findings loaded, out of the pool', async () => {
  const list = await admin('GET', '/api/credits/projects');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual(list.body.projects.map((p) => p.projectId).sort(), ['p0', 'p1'], 'every Checkmarx One project, not only those holding credits');
  assert.equal(list.body.projects.find((p) => p.projectId === 'p1').allocated, false);

  // A project nobody has given anything yet (its findings are not needed).
  const r = await admin('POST', '/api/credits/give', { projectId: 'p1', triage: 5, remediation: 6 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.given, 11);
  assert.equal(r.body.projectName, 'Project 1');
  const p1 = r.body.allocations.find((p) => p.projectId === 'p1');
  assert.deepEqual([p1.triage.allocated, p1.triage.remaining, p1.triage.extra], [5, 5, 5]);
  assert.deepEqual([p1.remediation.allocated, p1.remediation.remaining, p1.remediation.extra], [6, 6, 6]);
  // Giving again adds on top.
  const more = await admin('POST', '/api/credits/give', { projectId: 'p1', triage: 2 });
  assert.equal(more.body.allocations.find((p) => p.projectId === 'p1').triage.allocated, 7);

  // Refused: nothing to give, negative or fractional credits, an unknown project, more than the pool has free.
  assert.equal((await admin('POST', '/api/credits/give', { projectId: 'p1' })).status, 400);
  assert.equal((await admin('POST', '/api/credits/give', { projectId: 'p1', triage: -3 })).status, 400);
  assert.equal((await admin('POST', '/api/credits/give', { projectId: 'p1', triage: 1.5 })).status, 400);
  assert.equal((await admin('POST', '/api/credits/give', { triage: 1 })).status, 400);
  assert.equal((await admin('POST', '/api/credits/give', { projectId: 'nope', triage: 1 })).status, 404);
  const pool = (await admin('GET', '/api/credits')).body.pool;
  await admin('PUT', '/api/settings', { aiTriage: { monthlyCreditLimit: pool.used.total + pool.outstanding.total + 3 } });
  const over = await admin('POST', '/api/credits/give', { projectId: 'p1', triage: 4 });
  assert.equal(over.status, 409, JSON.stringify(over.body));
  assert.match(over.body.error, /Only 3 credits left in the credit pool/);
  assert.equal((await admin('POST', '/api/credits/give', { projectId: 'p1', triage: 3 })).status, 200, 'exactly what is free fits');
  await admin('PUT', '/api/settings', { aiTriage: { monthlyCreditLimit: 0 } });

  // Every gift, and the refusal, is in the audit log.
  const audit = (await admin('GET', '/api/audit?types=allocation&limit=50')).body;
  const given = audit.entries.filter((e) => /on the Credit Control page/.test(e.reason));
  assert.equal(given.length, 3);
  assert.ok(given.some((e) => e.reason === 'Gave 5 AI Triage and 6 AI Remediation credits on the Credit Control page.'), given.map((e) => e.reason).join('\n'));
  assert.ok(audit.entries.some((e) => e.outcome === 'refused' && /Only 3 credits left/.test(e.reason)));
  assert.equal((await admin('GET', '/api/audit/verify')).body.ok, true);

  // Take back still works on what was given here.
  const back = await admin('POST', '/api/credits/reclaim', { projectIds: ['p1'] });
  assert.equal(back.body.reclaimed, 16);
});

test('stage 10 — Triage now / Remediate now from Credit Control and from a tracked report spend what the projects were given', async () => {
  // p1 was given credits on Credit Control (stage 9) and they were taken back: give again.
  assert.equal((await admin('POST', '/api/credits/give', { projectId: 'p1', triage: 6, remediation: 6 })).status, 200);
  assert.equal((await admin('POST', '/api/credits/run', { severities: ['CRITICAL'] })).status, 400, 'triage or remediation');
  assert.equal((await admin('POST', '/api/credits/run', { kind: 'triage', severities: [] })).status, 400, 'a severity');

  // Credit Control: critical findings of the ticked project (r0, r4, r8), read fresh: no Dashboard fetch needed.
  const triage = await admin('POST', '/api/credits/run', { kind: 'triage', severities: ['CRITICAL'], projectIds: ['p1'], notifyInitiators: false });
  assert.equal(triage.status, 200, JSON.stringify(triage.body));
  assert.equal(triage.body.started, 3, JSON.stringify(triage.body));
  const p1 = () => triage.body.allocations.find((p) => p.projectId === 'p1');
  assert.deepEqual([p1().triage.used, p1().triage.remaining], [3, 3]);
  const early = await admin('POST', '/api/credits/run', { kind: 'remediation', severities: ['CRITICAL'], projectIds: ['p1'], notifyInitiators: false });
  assert.equal(early.body.requested, 0, 'nothing is confirmed until AI Triage gives its verdicts');

  // A tracked report on p1's high findings: triage them from the report (r1, r5, r9).
  const created = await admin('POST', '/api/tracked-reports', { name: 'p1 high', projectIds: ['p1'], severities: ['HIGH'] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { id } = created.body;
  const fromReport = await admin('POST', `/api/tracked-reports/${id}/triage`, { severities: ['HIGH'], notifyInitiators: false });
  assert.equal(fromReport.body.started, 3, JSON.stringify(fromReport.body));
  assert.equal(fromReport.body.report.credits.triage.remaining, 0);

  // Verdicts: r0 (critical) and r9 (high) are confirmed.
  await sleep(FLIP_MS + 500);
  const fromReportFix = await admin('POST', `/api/tracked-reports/${id}/remediate`, { severities: ['HIGH'], notifyInitiators: false });
  assert.equal(fromReportFix.status, 200, JSON.stringify(fromReportFix.body));
  assert.equal(fromReportFix.body.started, 1, `r9 only — ${JSON.stringify(fromReportFix.body)}`);
  assert.equal(fromReportFix.body.report.credits.remediation.remaining, 3);
  assert.deepEqual(fromReportFix.body.report.latest.toRemediate, {}, 'nothing confirmed is left to remediate: the button stops glowing');
  const fix = await admin('POST', '/api/credits/run', { kind: 'remediation', severities: ['CRITICAL', 'HIGH'], projectIds: ['p1'], notifyInitiators: false });
  assert.equal(fix.body.started, 1, `r0 only: r9 is already remediated — ${JSON.stringify(fix.body)}`);
  assert.deepEqual([fix.body.allocations.find((p) => p.projectId === 'p1').remediation.used, fix.body.allocations.find((p) => p.projectId === 'p1').remediation.remaining], [6, 0]);

  // The Dashboard's balances follow, wherever the credits were given or used.
  const views = await admin('GET', '/api/credits/views');
  assert.equal(views.status, 200);
  assert.deepEqual([views.body.projects.p1.remediation.used, views.body.projects.p1.remediation.remaining], [6, 0]);
  const audit = (await admin('GET', '/api/audit?types=triage,remediation&limit=500')).body;
  assert.ok(audit.entries.some((e) => /Credit Control: triage critical/.test(e.details?.origin ?? '')), 'where it was started is in the audit log');
  assert.ok(audit.entries.some((e) => /Tracked report "p1 high": remediate/.test(e.details?.origin ?? '')));
  assert.equal((await admin('GET', '/api/audit/verify')).body.ok, true);
});

test('stage 10b — credits for triage and remediation are allocated from Credit Control and from a tracked report too', async () => {
  assert.equal((await admin('POST', '/api/credits/allocate-needed', { projectIds: ['p1'] })).status, 400, 'severities or extra credits');
  const before = (await admin('GET', '/api/credits')).body.allocations.find((p) => p.projectId === 'p1');
  // Credit Control: what p1's medium findings need (r2, r6, r10 still to triage), plus 3 extra for remediation.
  const r = await admin('POST', '/api/credits/allocate-needed', { severities: ['MEDIUM'], remediationAdd: 3, projectIds: ['p1'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p1 = r.body.allocations.find((p) => p.projectId === 'p1');
  assert.equal(p1.triage.remaining - before.triage.remaining, 3, 'one credit per medium result still to triage');
  assert.equal(p1.remediation.remaining - before.remediation.remaining, 3);

  // A tracked report's Triage tab: extra credits for its projects.
  const created = await admin('POST', '/api/tracked-reports', { name: 'p1 extra', projectIds: ['p1'], severities: ['LOW'] });
  const fromReport = await admin('POST', `/api/tracked-reports/${created.body.id}/allocate`, { severities: [], triageAdd: 2 });
  assert.equal(fromReport.status, 200, JSON.stringify(fromReport.body));
  assert.equal(fromReport.body.report.credits.triage.remaining, p1.triage.remaining + 2);

  const audit = (await admin('GET', '/api/audit?types=allocation&limit=50')).body;
  assert.ok(audit.entries.some((e) => e.reason === 'Changed from Credit Control.'));
  assert.ok(audit.entries.some((e) => e.reason === 'Changed from tracked report "p1 extra".'));
  assert.equal((await admin('GET', '/api/audit/verify')).body.ok, true);
});

test('stage 11 — Impact: hours saved, noise removed and the debt, from the readings and the credits; settings checked; one-page summary', async () => {
  const before = await admin('GET', '/api/impact?days=30');
  assert.equal(before.status, 200, JSON.stringify(before.body));
  const d = before.body;
  assert.ok(d.since, 'readings started with the first fetch');
  assert.ok(d.credits.triage >= 14, `triage credits in the period: ${d.credits.triage}`);
  assert.ok(d.aiTriaged > 0);
  assert.ok(d.noiseRemoved > 0, 'findings AI Triage showed not exploitable');
  // Defaults: 20 min per triaged result, 120 per fix proven by Checkmarx One (the mock never removes a finding).
  assert.equal(d.aiFixed, 0);
  assert.equal(d.hours.total, Math.round(((d.credits.triage * 20) / 60) * 10) / 10);
  assert.deepEqual([d.money.value, d.money.cost], [null, null], 'no money until a rate and a price are set');
  assert.ok(d.debt.now > 0 && d.series.length >= 1);
  assert.equal(d.monthlyOn, false);

  // Settings: checked, then used.
  assert.equal((await admin('PUT', '/api/settings', { impact: { triageMinutes: 0 } })).status, 400);
  assert.equal((await admin('PUT', '/api/settings', { impact: { currency: 'euros' } })).status, 400);
  const saved = await admin('PUT', '/api/settings', { impact: { triageMinutes: 30, hourlyRate: 100, creditPrice: 2, currency: 'eur', monthlyTo: 'ciso@acme.io, not-an-address' } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const after = (await admin('GET', '/api/impact?days=30')).body;
  assert.equal(after.hours.triage, Math.round(((after.credits.triage * 30) / 60) * 10) / 10);
  assert.equal(after.money.value, Math.round(after.hours.total * 100 * 100) / 100);
  assert.equal(after.money.cost, after.credits.total * 2);
  assert.equal(after.money.currency, 'EUR');
  assert.deepEqual(after.monthlyTo, ['ciso@acme.io']);
  assert.equal(after.monthlyOn, true);

  const page = await fetch(`${BASE}/api/impact/summary.html?days=30`, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-disposition') ?? '', /attachment; filename="impact-/);
  const html = await page.text();
  assert.match(html, /Hours saved/);
  assert.match(html, /How these are worked out/);
  // No mail server tested yet: refused with the reason.
  assert.notEqual((await admin('POST', '/api/impact/email', {})).status, 200);
  // With one: last month's summary, to the list only, numbers and no chart (mail clients drop SVG).
  const smtp = await fakeSmtp();
  try {
    await admin('PUT', '/api/settings', { smtp: { host: '127.0.0.1', port: smtp.port, secure: false, requireAuth: false, rejectUnauthorized: false, fromAddress: 'mz@acme.io', fromName: 'CxMissionZero' } });
    assert.equal((await admin('POST', '/api/settings/connections/check', { rollback: false })).body.smtp.ok, true);
    const sent = await admin('POST', '/api/impact/email', {});
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.deepEqual(sent.body.to, ['ciso@acme.io']);
    assert.match(sent.body.month, /^\d{4}-\d{2}$/);
    const message = smtp.messages.at(-1);
    assert.deepEqual(message.to, ['ciso@acme.io']);
    assert.match(message.raw, /impact/i);
    assert.doesNotMatch(message.raw, /<svg/);
  } finally {
    await smtp.close();
  }
  await admin('PUT', '/api/settings', { impact: { triageMinutes: 20, hourlyRate: 0, creditPrice: 0, currency: 'USD', monthlyTo: '' } });
});
