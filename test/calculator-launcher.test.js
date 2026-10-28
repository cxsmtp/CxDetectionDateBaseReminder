// The standalone calculator's launcher (cx-credits-calculator.mjs): built from src/standalone-calculator.js,
// run as a user runs it, it serves the calculator on this computer only and reads a (mock) Checkmarx One with
// the API key given to it, with CxMissionZero's own code. Only the page it served may use it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { buildCalculatorLauncher, buildStandaloneCalculator, moduleGraph } from '../src/standalone-calculator.js';
import { startLauncher } from '../src/calculator-launcher.js';
import { makeRepo, startGitHost } from './fake-git-host.js';
import { freePort } from './free-port.js';
import { mockApiKey } from './test-credentials.js';

const MOCK_PORT = await freePort();
const PORT = await freePort();
const KEY = mockApiKey({ iss: `http://127.0.0.1:${MOCK_PORT}/auth/realms/acme`, azp: 'integration' });
const children = [];
let log = '';
const launcherTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-tmp-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A request with any Host header (fetch will not set one). */
const raw = (method, url, { host, headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ method, host: u.hostname, port: u.port, path: u.pathname, headers: { ...headers, ...(host ? { Host: host } : {}) } }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });

let token = '';
const call = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-Calculator-Token': token }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
};

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-'));
  const file = path.join(dir, 'cx-credits-calculator.mjs');
  fs.writeFileSync(file, buildCalculatorLauncher({ version: '9.9.9' }));
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '3', RISKS: '4' }, stdio: 'ignore' }));
  // Its own temporary folder, to see that a count from git leaves nothing in it.
  const launcher = spawn(process.execPath, [file, '--port', String(PORT), '--no-open'], { cwd: dir, env: { ...process.env, TMPDIR: launcherTmp }, stdio: ['ignore', 'pipe', 'pipe'] });
  launcher.stdout.on('data', (d) => (log += d));
  launcher.stderr.on('data', (d) => (log += d));
  children.push(launcher);
  const end = Date.now() + 15000;
  while (!log.includes(`http://127.0.0.1:${PORT}/`)) {
    if (Date.now() > end) throw new Error(log);
    await sleep(100);
  }
});

test.after(() => {
  for (const child of children) child.kill();
});

test('the file: the reading code and the page, nothing else; the page may call only the launcher', () => {
  const text = buildCalculatorLauncher({ version: '9.9.9' });
  const files = Object.keys(JSON.parse(text.match(/^const FILES = (.*);$/m)[1]));
  assert.deepEqual(files.sort(), moduleGraph(path.resolve('src/calculator-launcher.js')).map((f) => path.relative(process.cwd(), f).split(path.sep).join('/')).sort());
  assert.ok(files.includes('src/projections.js') && files.includes('src/cxone/client.js'));
  assert.ok(!files.some((f) => /server|settings|iam|session|audit/.test(f)), 'no part of the server that holds its data');
  const page = buildStandaloneCalculator({ version: '9.9.9', launcher: true });
  assert.match(page, /connect-src 'self'/);
  // The token goes into a JSON island the launcher fills; the script that reads it is fixed, so the CSP can name it by hash.
  assert.match(page, /<script type="application\/json" id="cx-launcher">"__CALCULATOR_LAUNCHER__"<\/script>/);
  assert.match(page, /window\.CX_LAUNCHER = JSON\.parse\(document\.getElementById\('cx-launcher'\)\.textContent\);/);
  assert.match(page, /id="sa-key"/);
  assert.match(buildStandaloneCalculator({ version: '9.9.9' }), /connect-src 'none'/, 'the plain file still calls nowhere');
});

test('served on this computer only, to the page it served: another name for it, or no secret, is refused', async () => {
  const page = await raw('GET', `http://127.0.0.1:${PORT}/`);
  assert.equal(page.status, 200);
  token = JSON.parse(page.text.match(/<script type="application\/json" id="cx-launcher">(\{[^}]*\})<\/script>/)[1]).token;
  assert.ok(token.length >= 32);
  assert.equal((await raw('GET', `http://127.0.0.1:${PORT}/`, { host: `evil.example:${PORT}` })).status, 421, 'a name pointed at this computer');
  assert.equal((await raw('GET', `http://127.0.0.1:${PORT}/launcher/status`)).status, 403, 'no secret');
  const preflight = await raw('OPTIONS', `http://127.0.0.1:${PORT}/launcher/connect`, { headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-calculator-token' } });
  assert.ok(!preflight.headers['access-control-allow-origin'], 'no other site may call it');
});

test('connect with the API key, read the tenant as CxMissionZero does, narrow it; the key is never shown back', async () => {
  assert.equal((await call('POST', '/api/projections/read', {})).status, 409, 'not connected yet');
  assert.equal((await call('POST', '/launcher/connect', { apiKey: 'nonsense' })).status, 400);
  const connected = await call('POST', '/launcher/connect', { apiKey: KEY });
  assert.equal(connected.status, 200, JSON.stringify(connected.body));
  assert.deepEqual([connected.body.connected, connected.body.tenant], [true, 'acme']);
  assert.ok(!JSON.stringify(connected.body).includes(KEY));
  let job = (await call('POST', '/api/projections/read', { branches: 'primary' })).body;
  const end = Date.now() + 60000;
  while (job.state === 'running' && Date.now() < end) {
    await sleep(300);
    job = (await call('GET', '/api/projections/read')).body;
  }
  assert.equal(job.state, 'done', JSON.stringify(job));
  assert.equal(job.result.projects.length, 3);
  assert.ok(job.result.tr.totals.weeks.length > 0, 'the backlog week by week');
  const one = job.result.projects[0].id;
  const series = await call('POST', '/api/projections/series', { projectIds: [one] });
  assert.equal(series.status, 200);
  assert.ok(series.body.totals.weeks.length > 0);
  assert.ok(!log.includes(KEY), 'the key is never printed');
  assert.equal((await call('POST', '/launcher/disconnect', {})).body.connected, false);
  assert.equal((await call('GET', '/launcher/status')).body.connected, false);
});

test('count code lines from git on this computer, with a token typed for that count only', async () => {
  const typed = `ghp_launcher${'R4t'.repeat(8)}`;
  const repos = fs.mkdtempSync(path.join(os.tmpdir(), 'launcher-repos-'));
  makeRepo(repos, 'globex', 'claims-portal', { 'src/Main.java': '// c\nclass Main {}\n', 'web/app.ts': 'export const a = 1;\n\n' });
  const host = await startGitHost(repos, { tokens: [typed] });
  try {
    assert.deepEqual((await call('GET', '/api/projections/git/connections')).body, { connections: [] }, 'no Admin\'s connections here: a token only');
    const token = { provider: 'github', address: host.url, token: typed };
    const listed = await call('POST', '/api/projections/git/repositories', { token, owner: 'globex' });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(listed.body.repositories.map((r) => r.path), ['globex/claims-portal']);
    let job = (await call('POST', '/api/projections/git/count', { token, repositories: [{ url: listed.body.repositories[0].url, branch: 'main' }] })).body;
    const end = Date.now() + 60000;
    while (job.state === 'running' && Date.now() < end) {
      await sleep(200);
      job = (await call('GET', `/api/projections/git/count?id=${job.id}`)).body;
    }
    assert.equal(job.state, 'done', JSON.stringify(job));
    assert.deepEqual(job.repositories[0].languages, { Java: { files: 1, code: 1 }, TypeScript: { files: 1, code: 1 } });
    assert.ok(!JSON.stringify(job).includes(typed));
    assert.ok(host.seen.filter((s) => !s.path.startsWith('/api/')).every((s) => s.authorization === `Basic ${Buffer.from(`x-access-token:${typed}`).toString('base64')}`));
    assert.ok(!log.includes(typed), 'the token is never printed');
    assert.deepEqual(fs.readdirSync(launcherTmp).filter((n) => n.startsWith('mz-git-count-')), [], 'nothing of the code left behind');
    assert.equal((await call('POST', '/api/projections/git/count', { token: { ...token, address: 'https://169.254.169.254' }, repositories: ['https://169.254.169.254/a/b'] })).status, 400, 'never a link-local or metadata address');
  } finally {
    await host.close();
  }
});

test('without git on this computer, the launcher says so plainly', async () => {
  const launcher = await startLauncher({ html: '<!doctype html><script type="application/json" id="cx-launcher">"__CALCULATOR_LAUNCHER__"</script>', open: false, log: () => {}, gitBin: path.join(os.tmpdir(), 'no-such-git-here') });
  try {
    const page = await fetch(launcher.url).then((r) => r.text());
    const secret = JSON.parse(page.match(/id="cx-launcher">(\{[^}]*\})</)[1]).token;
    const r = await fetch(`${launcher.url}api/projections/git/count`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Calculator-Token': secret }, body: JSON.stringify({ token: { provider: 'github', token: 'ghp_abcdefgh' }, repositories: ['https://github.com/a/b'] }) });
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /Git is not installed on this computer: install it from https:\/\/git-scm\.com/);
  } finally {
    await launcher.close();
  }
});
