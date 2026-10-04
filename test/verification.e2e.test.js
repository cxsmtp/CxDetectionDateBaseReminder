// Verifying fixes with a rescan: the real server against the mock Checkmarx One.
// A tracked report's round is rescanned (by hand, or automatically once every
// finding in scope is dealt with); what is gone is fixed, what is still there
// after remediation is a fix that did not work; then the next round starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';

const MOCK_PORT = await freePort();
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const RESCAN_MS = 1200;
const FLIP_MS = 400;
const KEY = (() => {
  const e = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${e({ alg: 'none' })}.${e({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' })}.sig`;
})();
const children = [];
let log = '';
let cookie = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function admin(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** Act in "Checkmarx One" directly, as a developer or AI would: triage or remediate results. */
async function inCheckmarxOne(path, resultIDs) {
  const token = await fetch(`${MOCK}/auth/realms/acme/protocol/openid-connect/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: KEY }) }).then((r) => r.json());
  const r = await fetch(MOCK + path, { method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ scanID: 'scan-p0', buckets: [{ scannerType: 'sast', resultIDs }] }) });
  assert.ok(r.ok, `${path}: ${r.status}`);
}

const refresh = async (id) => {
  const r = await admin('POST', `/api/tracked-reports/${id}/refresh`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-'));
  // 2 projects × 4 findings: r0 critical, r1 high, r2 medium, r3 low. p1 was scanned from uploaded code.
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '2', RISKS: '4', FLIP_MS: String(FLIP_MS), RESCAN_MS: String(RESCAN_MS), INEFFECTIVE: 'p0-r1', UPLOAD_PROJECTS: 'p1' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: KEY, CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme',
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
  const fetched = await admin('GET', '/api/scan');
  assert.equal(fetched.status, 200, JSON.stringify(fetched.body) + log.slice(-800));
});

test.after(() => {
  for (const child of children) child.kill();
});

let roundsId = '';

test('a rescan by hand: what is gone is fixed, a remediated finding still there did not work, uploaded code waits for its next scan', async () => {
  const created = await admin('POST', '/api/tracked-reports', { name: 'Critical and high', severities: ['CRITICAL', 'HIGH'], projectIds: ['p0', 'p1'] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  roundsId = created.body.id;
  assert.equal(created.body.baselineCount, 4);
  assert.equal(created.body.latest.closure.closed, false, 'nothing dealt with yet');
  assert.equal(created.body.latest.closure.awaiting, 4);

  // A developer remediates both of p0's findings in Checkmarx One; the fix for p0-r1 does not work.
  await inCheckmarxOne('/api/remediation/remediate', ['alt-p0-r0', 'alt-p0-r1']);

  const started = await admin('POST', `/api/tracked-reports/${roundsId}/verify`);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const [p0, p1] = started.body.verification.projects;
  assert.equal(p0.status, 'Queued');
  assert.match(p0.scanId, /^rescan-p0-/);
  assert.equal(p0.branch, 'main');
  assert.deepEqual(p0.engines, ['sast', 'sca', 'kics']);
  assert.equal(p1.status, 'waiting');
  assert.match(p1.error, /uploaded code/);
  assert.equal((await admin('POST', `/api/tracked-reports/${roundsId}/verify`)).status, 409, 'one at a time');

  await sleep(RESCAN_MS + 300);
  const after = await refresh(roundsId);
  const v = after.verification;
  assert.equal(v.projects[0].status, 'Completed');
  assert.equal(v.result.checked, 2);
  assert.equal(v.result.fixed, 1, 'p0-r0 is gone');
  assert.deepEqual(v.result.stillFound.map((f) => f.riskId), ['p0-r1']);
  assert.equal(v.result.notChecked, 2, 'p1 waits for a scan from its pipeline');
  assert.equal(v.result.zero, false);
  assert.equal(v.finishedAt, null, 'still watching p1');
  assert.equal(after.latest.outcomes.resolved, 1);
});

test('automatic: the moment every finding in scope is dealt with, the rescan starts by itself', async () => {
  const created = await admin('POST', '/api/tracked-reports', { name: 'Medium in p0', severities: ['MEDIUM'], projectIds: ['p0'] });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal((await admin('PUT', `/api/tracked-reports/${id}/verify-settings`, { auto: true })).body.verify.auto, true);
  assert.equal((await refresh(id)).verification ?? null, null, 'not closed yet: no rescan');

  // AI Triage judges p0-r2 not exploitable: nothing in scope is left open.
  await inCheckmarxOne('/api/ai-triage/triage', ['alt-p0-r2']);
  await sleep(FLIP_MS + 200);
  const closed = await refresh(id);
  assert.equal(closed.latest.closure.closed, true);
  assert.equal(closed.verification.automatic, true);
  assert.match(closed.verification.projects[0].scanId, /^rescan-p0-/);

  await sleep(RESCAN_MS + 300);
  const done = await refresh(id);
  assert.equal(done.verification.result.accepted, 1);
  assert.equal(done.verification.result.zero, true, 'nothing left in scope: at zero');
  assert.ok(done.verification.finishedAt);
  assert.equal((await refresh(id)).verification.round, 1, 'one automatic rescan per round, not one a minute');
});

test('the next round starts on the new scan with a new scope, and the round so far is kept', async () => {
  const next = await admin('POST', `/api/tracked-reports/${roundsId}/next-round`, { severities: ['MEDIUM', 'LOW'] });
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.equal(next.body.round, 2);
  assert.deepEqual(next.body.filters.severities, ['MEDIUM', 'LOW']);
  // p0-r2 was triaged not exploitable: out. p0-r3, p1-r2 and p1-r3 are the new round's work.
  assert.equal(next.body.baselineCount, 3);
  assert.equal(next.body.rounds.length, 1);
  assert.equal(next.body.rounds[0].round, 1);
  assert.equal(next.body.rounds[0].verification.result.fixed, 1);
  assert.equal(next.body.verification, null);
  assert.equal((await admin('POST', `/api/tracked-reports/${roundsId}/next-round`, { severities: [] })).status, 400);

  const audit = await admin('GET', '/api/audit?type=verification');
  const reasons = (audit.body?.entries ?? audit.body?.events ?? []).map((e) => e.reason).join('\n');
  assert.match(reasons, /Verification rescan of "Critical and high" \(round 1\) started/);
  assert.match(reasons, /1 fixed, 1 still found/);
  assert.match(reasons, /started automatically/);
  assert.match(reasons, /moved to round 2/);
});
