// Find a vulnerability on the Dashboard ("SQL injection", "SSRF", "CWE-89"): only its findings
// are loaded, and every action (credits verified twice included) works on those alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { matchesVulnerability, topNames, vulnerabilityQuery, words } from '../src/vuln-search.js';
import { freePort } from './free-port.js';
import { FIRST_PASSWORD, NEXT_PASSWORD, mockApiKey } from './test-credentials.js';

test('what is typed matches Checkmarx One\'s names: case, underscores, short forms, several at once, CWE', () => {
  const q = (text) => vulnerabilityQuery(text);
  const m = (text, title, cweId = '') => matchesVulnerability(q(text), { title, cweId });
  assert.equal(words('Reflected_XSS-All Clients'), 'reflected xss all clients');
  assert.equal(q('   '), null);
  assert.ok(m('SQL injection', 'SQL_Injection'));
  assert.ok(m('sql inject', 'Blind_SQL_Injections'), 'a word may be the start of a longer one');
  assert.ok(!m('SQL injection', 'Command_Injection'));
  assert.ok(m('SSRF', 'Server_Side_Request_Forgery') && m('ssrf', 'SSRF'));
  assert.ok(m('xss', 'Reflected_XSS_All_Clients') && m('XSS', 'Stored_Cross_Site_Scripting'));
  assert.ok(m('SQLi', 'SQL_Injection'));
  assert.ok(m('SSRF, path traversal', 'Path_Traversal'), 'commas: any one of them');
  assert.ok(m('CWE-89', 'Anything', '89') && m('cwe 89', 'X', 'CWE-89') && !m('CWE-89', 'SQL_Injection', '79'));
  assert.ok(!m('injection', 'Log_Forging'));
  assert.equal(q('x'.repeat(500)).text.length, 200, 'long input is cut');
  assert.equal(q(Array.from({ length: 30 }, (_, i) => `t${i}`).join(',')).terms.length, 10, 'at most ten terms');
  assert.deepEqual(topNames(new Map([['b', 2], ['a', 2], ['c', 5]])), [{ name: 'c', count: 5 }, { name: 'a', count: 2 }, { name: 'b', count: 2 }]);
});

const MOCK_PORT = await freePort();
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const children = [];
let log = '';
let cookie = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function admin(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Origin: BASE, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vuln-'));
  // 3 projects, 24 findings each, named round twelve Checkmarx One query names: 4 of them are SSRF.
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '3', RISKS: '24', INITIATORS: '1', VULN_NAMES: '1' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: mockApiKey({ iss: `${MOCK}/auth/realms/acme`, azp: 'integration' }), CX_BASE_URL: MOCK, CX_IAM_URL: MOCK, CX_TENANT: 'acme',
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD, SMTP_HOST: '',
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
  await admin('POST', '/api/session/password', { email: 'admin@acme.io', password: FIRST_PASSWORD });
  await admin('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD });
});

test.after(() => {
  for (const child of children) child.kill();
});

test('every finding, then only SSRF: its findings alone, and the names of every finding to suggest', async () => {
  const all = await admin('GET', '/api/scan');
  assert.equal(all.status, 200);
  assert.equal(all.body.totals.risks, 72);
  assert.equal(all.body.vulnerability, '');
  assert.ok(all.body.vulnerabilityNames.some((n) => n.name === 'SQL_Injection' && n.count === 6));

  const ssrf = await admin('GET', '/api/scan?vulnerability=SSRF');
  assert.equal(ssrf.status, 200);
  assert.equal(ssrf.body.vulnerability, 'SSRF');
  assert.equal(ssrf.body.totals.risks, 12, 'SSRF and Server_Side_Request_Forgery: 4 in each of 3 projects');
  assert.deepEqual(Object.keys(ssrf.body.totals.severities).sort(), ['HIGH', 'MEDIUM']);
  assert.equal(ssrf.body.vulnerabilityNames.length, 12, 'suggestions still name every finding read');

  // A reload shows the search it was loaded with.
  const last = await admin('GET', '/api/scan/last');
  assert.equal(last.body.request.vulnerability, 'SSRF');
  assert.equal(last.body.vulnerability, 'SSRF');
});

test('credits verified twice count only the searched vulnerability', async () => {
  await admin('GET', '/api/scan?vulnerability=CWE-89');
  const v = await admin('POST', '/api/credits/verify', { projectIds: ['p0'], severities: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] });
  assert.equal(v.status, 200);
  const [p0] = v.body.verified;
  assert.equal(p0.agreed, true, JSON.stringify(p0));
  // CWE-89: SQL_Injection (finding 0, 12) and Blind_SQL_Injections (8, 20): 4 of the project's 24.
  assert.equal(p0.triage.rows, 4);
  assert.equal(v.body.projects.p0.totalRisks, 4);
});

test('a project without the vulnerability is not part of the result', async () => {
  const none = await admin('GET', '/api/scan?vulnerability=deserialization');
  assert.equal(none.status, 200);
  assert.equal(none.body.totals.risks, 0);
  assert.equal(none.body.projects.length, 0);
});

test('narrow to Checkmarx One applications: only their projects are loaded', async () => {
  const options = await admin('GET', '/api/scope/options?refresh=1');
  assert.equal(options.status, 200);
  assert.deepEqual(options.body.applications.map((a) => [a.name, a.projects]), [['Mobile', 1], ['Payments', 1], ['Platform', 1], ['Web', 0]]);
  const mobile = options.body.applications.find((a) => a.name === 'Mobile');
  const scan = await admin('GET', `/api/scan?application=${mobile.id}`);
  assert.equal(scan.status, 200);
  assert.deepEqual(scan.body.projects.map((p) => p.projectId), ['p1']);
  assert.deepEqual(scan.body.scope.applications, ['Mobile']);
  const last = await admin('GET', '/api/scan/last');
  assert.deepEqual([last.body.request.applications, last.body.request.applicationNames], [[mobile.id], ['Mobile']]);
  // An application and a project together: both.
  const both = await admin('GET', `/api/scan?application=${mobile.id}&project=p2`);
  assert.deepEqual(both.body.projects.map((p) => p.projectId).sort(), ['p1', 'p2']);
});
