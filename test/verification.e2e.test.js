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
async function inCheckmarxOne(path, resultIDs, scanID = 'scan-p0') {
  const token = await fetch(`${MOCK}/auth/realms/acme/protocol/openid-connect/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: KEY }) }).then((r) => r.json());
  const r = await fetch(MOCK + path, { method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ scanID, buckets: [{ scannerType: 'sast', resultIDs }] }) });
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
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '3', RISKS: '4', FLIP_MS: String(FLIP_MS), RESCAN_MS: String(RESCAN_MS), INEFFECTIVE: 'p0-r1', UPLOAD_PROJECTS: 'p1' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: KEY, CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme',
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: 'temporary password 1',
      // A developer's window is 24 hours at least: here an "hour" lasts 50 ms, so 24 hours pass in 1.2 s.
      VERIFY_HOUR_MS: '50', REPORT_SERVER_URL: BASE,
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

test('a rescan stays credited to the developer whose work it verifies, not to the API key that started it', async () => {
  const sent = await fetch(`${MOCK}/__rescans`).then((r) => r.json());
  const [, first] = Object.entries(sent).find(([id]) => id.startsWith('rescan-p0-'));
  assert.equal(first.tags.cxmissionzero, 'verification');
  assert.equal(first.tags['verifies-work-of'], 'dev0@acme.com');
  assert.equal(first.tags['requested-by'], 'admin@acme.io');
  // Checkmarx One now says the latest scan of p0 was started by this server's key...
  const latest = await (async () => {
    const token = await fetch(`${MOCK}/auth/realms/acme/protocol/openid-connect/token`, { method: 'POST', body: new URLSearchParams({ refresh_token: KEY }) }).then((r) => r.json());
    return fetch(`${MOCK}/api/projects/last-scan`, { headers: { Authorization: `Bearer ${token.access_token}` } }).then((r) => r.json());
  })();
  assert.equal(latest.p0.initiator, 'cxmissionzero');
  // ...but reminders, reports and the dashboard still name the developer.
  const fetched = await admin('GET', '/api/scan');
  const p0 = fetched.body.projects.find((p) => p.projectId === 'p0');
  assert.equal(p0.initiator, 'dev0@acme.com');
});

test('the developer goes first: once everything in scope is dealt with, they rescan their own fixes', async () => {
  const created = await admin('POST', '/api/tracked-reports', { name: 'Medium in p0', severities: ['MEDIUM'], projectIds: ['p0'] });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal((await admin('GET', `/api/tracked-reports/${id}/rescan-links`)).status, 409, 'not closed yet: no rescan for anyone');

  // AI Triage judges p0-r2 not exploitable: nothing in scope is left open.
  await inCheckmarxOne('/api/ai-triage/triage', ['alt-p0-r2']);
  await sleep(FLIP_MS + 200);
  const closed = await refresh(id);
  assert.equal(closed.latest.closure.closed, true);
  assert.equal(closed.verification ?? null, null, 'nothing rescans by itself: it is the developer\'s turn');
  assert.equal(closed.verifyWindow.graceHours, 48);
  assert.deepEqual(closed.verifyWindow.developers.map((d) => d.email), ['dev0@acme.com']);

  // Their link: a page with one button, and the same grant works from their report.
  const { links } = (await admin('GET', `/api/tracked-reports/${id}/rescan-links`)).body;
  const grant = new URL(links[0].link).searchParams.get('g');
  const page = await fetch(links[0].link).then((r) => r.text());
  assert.match(page, /Rescan now/);
  assert.match(page, /48 hours left/);
  const state = await fetch(`${BASE}/api/relay/rescan-state`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant }) }).then((r) => r.json());
  assert.equal(state.state, 'ready');
  const forged = await fetch(`${BASE}/api/relay/rescan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant: `${grant.split('.')[0]}.x` }) });
  assert.equal(forged.status, 403);

  const started = await fetch(`${BASE}/api/relay/rescan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant }) });
  assert.equal(started.status, 200);
  assert.equal((await started.json()).state, 'scanning');
  const again = await fetch(`${BASE}/api/relay/rescan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant }) });
  assert.equal(again.status, 409, 'once per round');

  const scanning = await refresh(id);
  assert.equal(scanning.verification.by, 'dev0@acme.com');
  assert.equal(scanning.verification.automatic, false);
  assert.equal(scanning.verifyWindow.startedBy, 'dev0@acme.com');
  const sent = await fetch(`${MOCK}/__rescans`).then((r) => r.json());
  const tags = Object.values(sent).at(-1).tags;
  assert.equal(tags['requested-by'], 'dev0@acme.com', 'started by the developer');
  assert.equal(tags['verifies-work-of'], 'dev0@acme.com');

  await sleep(RESCAN_MS + 300);
  const done = await refresh(id);
  assert.equal(done.verification.result.accepted, 1);
  assert.equal(done.verification.result.zero, true, 'nothing left in scope: at zero');
  assert.match(await fetch(links[0].link).then((r) => r.text()), /verified at zero/);
});

test('nobody rescans in time: it is rescanned on the developers\' behalf, once', async () => {
  const created = await admin('POST', '/api/tracked-reports', { name: 'Medium in p2', severities: ['MEDIUM'], projectIds: ['p2'] });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const settings = await admin('PUT', `/api/tracked-reports/${id}/verify-settings`, { auto: true, graceHours: 2 });
  assert.equal(settings.body.verify.auto, true);
  assert.equal(settings.body.verify.graceHours, 24, 'never less than 24 hours');

  await inCheckmarxOne('/api/ai-triage/triage', ['alt-p2-r2'], 'scan-p2');
  await sleep(FLIP_MS + 200);
  const opened = await refresh(id);
  assert.ok(opened.verifyWindow, 'the developers\' turn');
  assert.equal(opened.verification ?? null, null);

  await sleep(24 * 50 + 300); // 24 "hours"
  const behalf = await refresh(id);
  assert.equal(behalf.verification.automatic, true);
  assert.match(behalf.verification.projects[0].scanId, /^rescan-p2-/);
  assert.ok(behalf.verifyWindow.startedAt);
  assert.equal((await refresh(id)).verification.round, 1, 'one rescan per round, not one a minute');
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
  assert.match(reasons, /started by dev0@acme\.com, who fixed the findings/);
  assert.match(reasons, /on its developers' behalf: nobody rescanned within 24 hours/);
  assert.match(reasons, /its developers have until/);
  assert.match(reasons, /moved to round 2/);
});
