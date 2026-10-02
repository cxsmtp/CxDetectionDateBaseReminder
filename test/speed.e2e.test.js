// Speed: a project read moments ago is reused by the next fetch (same key, same
// latest scan) instead of read again; "fresh" and triage sent from here bypass
// that. Big projects are read a few pages at once, every finding exactly once.
// Replies are compressed. An emailed report opens with one call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';
import { ReportGrants } from '../src/report-grants.js';

const MOCK_PORT = await freePort();
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const KEY = (() => {
  const e = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${e({ alg: 'none' })}.${e({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' })}.sig`;
})();
const SIGNING_KEY = 'speed-test';
const PROJECTS = 4;
const RISKS = 650; // four pages of 200 per project
const children = [];
let log = '';
let cookie = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function admin(method, url, body, headers = {}) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
}
const relay = (url, body) => fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const mockStats = () => fetch(`${MOCK}/__stats`).then((r) => r.json());

/** Read the fetch stream to the end: the final result. */
async function fetchAll(query = '') {
  const response = await fetch(`${BASE}/api/scan?stream=1${query}`, { headers: { Cookie: cookie, 'Accept-Encoding': 'gzip, br' } });
  assert.equal(response.status, 200);
  const lines = (await response.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { encoding: response.headers.get('content-encoding'), done: lines.at(-1), rows: lines.filter((e) => e.type === 'project') };
}

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speed-'));
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '5', PROJECTS: String(PROJECTS), RISKS: String(RISKS), INITIATORS: '2' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: KEY, CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme', REPORT_SIGNING_KEY: SIGNING_KEY,
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: 'temporary password 1', SMTP_HOST: '', GITHUB_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  children.push(server);
  const end = Date.now() + 20000;
  while (!/Successfully authenticated/.test(log)) {
    if (Date.now() > end) throw new Error(log);
    await sleep(100);
  }
  await admin('POST', '/api/session/password', { email: 'admin@acme.io', password: 'temporary password 1' });
  await admin('POST', '/api/me/password', { current: 'temporary password 1', next: 'correct horse battery' });
});

test.after(() => {
  for (const child of children) child.kill();
});

test('big projects are read a few pages at once, every finding exactly once, and the stream is compressed', async () => {
  const { encoding, done, rows } = await fetchAll('&fresh=1');
  assert.ok(['gzip', 'br'].includes(encoding), `compressed stream (got ${encoding})`);
  assert.equal(rows.length, PROJECTS, 'rows still arrive one per project');
  assert.equal(done.type, 'done');
  for (const p of done.projects) assert.equal(p.totalRisks, RISKS, `${p.projectId}: all ${RISKS} findings, none twice`);
  assert.equal(done.reused, 0, 'fresh: nothing reused');
});

test('a project read moments ago is reused by the next fetch; fresh and triage sent from here read it again', async () => {
  await fetchAll('&fresh=1');
  await fetch(`${MOCK}/__reset`);
  const again = await fetchAll();
  assert.equal(again.done.reused, PROJECTS, 'every project reused');
  assert.equal((await mockStats()).counts.risks ?? 0, 0, 'no findings read from Checkmarx One');
  for (const p of again.done.projects) assert.equal(p.totalRisks, RISKS);

  await fetch(`${MOCK}/__reset`);
  const fresh = await fetchAll('&fresh=1');
  assert.equal(fresh.done.reused, 0);
  assert.equal((await mockStats()).counts.risks, PROJECTS * Math.ceil(RISKS / 200), 'fresh: every page read again');
});

test('big replies are compressed for clients that accept it; small, frequent ones and other clients get them plain', async () => {
  const script = await fetch(`${BASE}/app.js`, { headers: { 'Accept-Encoding': 'br' } });
  assert.equal(script.headers.get('content-encoding'), 'br', 'the page script');
  assert.match(await script.text(), /flare/);
  const plainScript = await fetch(`${BASE}/app.js`, { headers: { 'Accept-Encoding': 'identity' } });
  assert.equal(plainScript.headers.get('content-encoding'), null);
  // A small reply (here a few projects' summaries) is not worth the CPU.
  const small = await admin('GET', '/api/scan', null, { 'Accept-Encoding': 'gzip, br' });
  assert.equal(small.status, 200);
  assert.equal(small.headers.get('content-encoding'), null);
  assert.equal(small.body.projects.length, PROJECTS);
});

test('a report opens with one call: status, credits and where every finding stands', async () => {
  const put = await admin('PUT', '/api/settings', { aiTriage: { enabled: true, remediationEnabled: true } });
  assert.equal(put.status, 200);
  const grants = new ReportGrants({ secret: SIGNING_KEY });
  const finding = (p, i) => {
    const f = { projectId: `p${p}`, projectName: `Project ${p}`, riskId: `p${p}-r${i}`, scanId: `scan-p${p}`, scanner: 'SAST', alternateId: `alt-p${p}-r${i}`, groupId: `sim-p${p}-r${i}` };
    return { ...f, ...grants.issue(f) };
  };
  const list = Array.from({ length: 30 }, (_, i) => finding(i % PROJECTS, i));
  const hello = await relay('/api/relay/hello', { credits: [finding(0, 0), finding(1, 0)], findings: list, remediation: list.slice(0, 5) });
  assert.equal(hello.status, 200, JSON.stringify(hello.body));
  assert.equal(hello.body.connected, true);
  assert.equal(hello.body.tenant, 'acme');
  assert.deepEqual(Object.keys(hello.body.projects).sort(), ['p0', 'p1']);
  assert.equal(hello.body.triageResults.results.length, 30);
  assert.ok(hello.body.triageResults.results.every((r) => typeof r.state === 'string'), 'states read with the opening call');
  assert.equal(hello.body.remediationStatus.results.length, 5);

  // Same answers as the separate calls older reports make.
  const status = await relay('/api/relay/status', {});
  assert.equal(status.body.tenant, hello.body.tenant);
  const separate = await relay('/api/relay/triage-results', { findings: list });
  assert.deepEqual(separate.body.results.map((r) => r.state), hello.body.triageResults.results.map((r) => r.state));

  // Nothing but the status when no lists are sent; a forged finding is refused as anywhere else.
  const bare = await relay('/api/relay/hello', {});
  assert.equal(bare.status, 200);
  assert.equal(bare.body.triageResults, undefined);
  const forged = await relay('/api/relay/hello', { findings: [{ ...list[0], riskId: 'someone-elses' }] });
  assert.equal(forged.status, 403);
});
