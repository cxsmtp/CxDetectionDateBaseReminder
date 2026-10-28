// Cx Credits Calculator, Count from git, end to end: the routes behind the calculator's permission; the Admin's
// git connection offered by name and host (its token never reaches the browser); a token typed for one count
// used for it and nothing else (never in an answer, a log, a saved file or an address); the count followed
// repository by repository; and nothing of the code left in the temporary folder. The git hosts are real
// repositories served over git's own HTTP protocol on this computer (test/fake-git-host.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';
import { FIRST_PASSWORD, NEXT_PASSWORD } from './test-credentials.js';
import { makeRepo, startGitHost } from './fake-git-host.js';

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const CONNECTION_TOKEN = `ghp_conn${'Q7w'.repeat(10)}`;
const TYPED_TOKEN = `ghp_typed${'K3x'.repeat(10)}`;
const WRONG_TOKEN = `ghp_${'wrong'.repeat(8)}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-count-e2e-repos-'));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-count-e2e-data-'));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-count-e2e-tmp-'));
let server;
let log = '';
let admin;
let uma;
let connected;
let customer;

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Every file under `dir`, as text. */
const allText = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => fs.readFileSync(path.join(e.parentPath ?? e.path, e.name), 'latin1')).join('\n');

async function follow(as, job) {
  const end = Date.now() + 60_000;
  while (job.state === 'running' && Date.now() < end) {
    await sleep(200);
    const r = await as('GET', `/api/projections/git/count?id=${encodeURIComponent(job.id)}`);
    assert.equal(r.status, 200, r.text);
    assert.ok(!r.text.includes(CONNECTION_TOKEN) && !r.text.includes(TYPED_TOKEN));
    job = r.body;
  }
  return job;
}

test.before(async () => {
  makeRepo(root, 'globex', 'claims-portal', { 'src/Main.java': '// c\nclass Main {}\n\n', 'web/app.ts': 'export const a = 1;\n', 'README.md': '# x\n' });
  makeRepo(root, 'globex', 'policy-engine', { 'Engine.kt': 'fun main() {}\n/* c */\n' });
  connected = await startGitHost(root, { tokens: [CONNECTION_TOKEN] });
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, TMPDIR: tmpDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
    ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD,
    // The Admin's git connection: a GitHub Enterprise-like host on this computer.
    GITHUB_TOKEN: CONNECTION_TOKEN, GITHUB_API_URL: `${connected.url}/api/v3`, GITHUB_ORG: 'globex',
  };
  delete env.CX_API_KEY;
  server = spawn(process.execPath, ['src/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const end = Date.now() + 15000;
  while (!(await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false))) {
    if (Date.now() > end) throw new Error(log);
    await sleep(100);
  }
  admin = browser();
  uma = browser();
  // The first Admin is ready a moment after the server answers.
  let signIn;
  for (let i = 0; i < 10 && !log.includes('[access] First administrator created'); i += 1) await sleep(200);
  for (let i = 0; i < 5 && !(signIn?.status < 300); i += 1) {
    if (i) await sleep(500);
    signIn = await admin('POST', '/api/session/password', { email: 'admin@acme.io', password: FIRST_PASSWORD });
  }
  assert.ok(signIn.status < 300, `${signIn.text}\n${log}`);
  await admin('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD });
  assert.equal((await admin('POST', '/api/iam/users', { email: 'uma@acme.io', name: 'uma', role: 'user', password: FIRST_PASSWORD })).status, 201);
  await uma('POST', '/api/session/password', { email: 'uma@acme.io', password: FIRST_PASSWORD });
  await uma('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD });
  customer = (await admin('POST', '/api/projections', { name: 'Globex' })).body.customer;
});

test.after(async () => {
  server?.kill();
  await connected?.close();
});

test('only with the calculator\'s permission', async () => {
  for (const [method, url] of [['GET', '/api/projections/git/connections'], ['POST', '/api/projections/git/repositories'], ['POST', '/api/projections/git/count'], ['GET', '/api/projections/git/count?id=x']]) {
    assert.equal((await uma(method, url, method === 'GET' ? undefined : {})).status, 403, `${method} ${url}`);
  }
  assert.equal((await fetch(`${BASE}/api/projections/git/connections`)).status, 401, 'signed out');
});

test('the Admin\'s git connection: offered by name and host, counted with its token, which never reaches the browser', async () => {
  const list = await admin('GET', '/api/projections/git/connections');
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(list.body.connections, [{ id: 'github-1', provider: 'github', label: 'GitHub', host: `127.0.0.1:${connected.port}`, owner: 'globex' }]);
  assert.ok(!list.text.includes(CONNECTION_TOKEN));
  const repos = await admin('POST', '/api/projections/git/repositories', { connection: 'github-1', owner: 'globex' });
  assert.equal(repos.status, 200, repos.text);
  assert.deepEqual(repos.body.repositories.map((r) => r.path), ['globex/claims-portal', 'globex/policy-engine']);
  assert.ok(!repos.text.includes(CONNECTION_TOKEN));
  const started = await admin('POST', '/api/projections/git/count', { connection: 'github-1', repositories: repos.body.repositories.map((r) => ({ url: r.url, branch: r.branch })) });
  assert.equal(started.status, 202, started.text);
  assert.deepEqual(started.body.repositories.map((r) => r.state), ['waiting', 'waiting']);
  const job = await follow(admin, started.body);
  assert.equal(job.state, 'done');
  const [claims, policy] = job.repositories;
  assert.equal(claims.state, 'done', claims.error);
  assert.deepEqual([claims.name, claims.branch, claims.lines], ['claims-portal', 'main', 3]);
  assert.deepEqual(claims.languages, { Java: { files: 1, code: 1 }, TypeScript: { files: 1, code: 1 }, Markdown: { files: 1, code: 1 } });
  assert.match(claims.commit, /^[0-9a-f]{7}$/);
  assert.deepEqual(policy.languages, { Kotlin: { files: 1, code: 1 } });
  assert.equal((await uma('GET', `/api/projections/git/count?id=${job.id}`)).status, 403);
  // Each repository a project, with where it came from: kept with the customer, never a token.
  const saved = await admin('PUT', `/api/projections/${customer.id}`, { fusionNew: { projects: [{ name: claims.name, langs: { Java: 1, TypeScript: 1, Markdown: 1 }, git: { url: claims.url, branch: claims.branch, commit: claims.commit, countedAt: claims.countedAt, connection: 'github-1', token: CONNECTION_TOKEN } }] } });
  assert.equal(saved.status, 200, saved.text);
  const opened = (await admin('GET', `/api/projections/${customer.id}`)).body.customer;
  assert.deepEqual(opened.fusionNew.projects[0].git, { host: `127.0.0.1:${connected.port}`, path: 'globex/claims-portal', url: claims.url, branch: 'main', commit: claims.commit, countedAt: claims.countedAt, connection: 'github-1' });
});

test('a token typed for one count: used for it, sent to its host as a header, and never kept, logged or sent back', async () => {
  const other = await startGitHost(root, { tokens: [TYPED_TOKEN] });
  try {
    const token = { provider: 'github', address: other.url, token: TYPED_TOKEN };
    const repos = await admin('POST', '/api/projections/git/repositories', { token, owner: 'globex' });
    assert.equal(repos.status, 200, repos.text);
    const started = await admin('POST', '/api/projections/git/count', { token, repositories: [`${other.url}/globex/policy-engine.git`] });
    assert.equal(started.status, 202, started.text);
    assert.ok(!started.text.includes(TYPED_TOKEN));
    const job = await follow(admin, started.body);
    assert.equal(job.repositories[0].state, 'done', job.repositories[0].error);
    const gitCalls = other.seen.filter((s) => !s.path.startsWith('/api/'));
    assert.ok(gitCalls.length && gitCalls.every((s) => s.authorization === `Basic ${Buffer.from(`x-access-token:${TYPED_TOKEN}`).toString('base64')}`), 'as a header, to its own host');
    assert.ok(!other.seen.some((s) => s.query.includes(TYPED_TOKEN)), 'never in an address');
    assert.ok(!connected.seen.some((s) => s.authorization.includes(Buffer.from(`x-access-token:${TYPED_TOKEN}`).toString('base64')) || s.authorization.includes(TYPED_TOKEN)), 'never to another host');
    // A wrong token: said, without the token.
    const wrong = await admin('POST', '/api/projections/git/count', { token: { ...token, token: WRONG_TOKEN }, repositories: [`${other.url}/globex/policy-engine`] });
    const failed = await follow(admin, wrong.body);
    assert.match(failed.repositories[0].error, /refused: check the token/);
    assert.ok(!JSON.stringify(failed).includes(WRONG_TOKEN));
  } finally {
    await other.close();
  }
  await sleep(200);
  assert.ok(!log.includes(TYPED_TOKEN) && !log.includes(CONNECTION_TOKEN), 'not in the server\'s log');
  const kept = allText(dataDir);
  assert.ok(!kept.includes(TYPED_TOKEN), 'not in any file the server keeps (audit, activity, customers)');
  assert.ok(!kept.includes(Buffer.from(`x-access-token:${TYPED_TOKEN}`).toString('base64')));
  assert.deepEqual(fs.readdirSync(tmpDir).filter((n) => n.startsWith('mz-git-count-')), [], 'nothing of the code left behind');
});

test('only hosts that may be called: never a link-local or metadata address, never a host not connected or allowed', async () => {
  const metadata = await admin('POST', '/api/projections/git/repositories', { token: { provider: 'gitlab', address: 'https://169.254.169.254', token: TYPED_TOKEN }, owner: 'x' });
  assert.equal(metadata.status, 400);
  assert.match(metadata.body.error, /link-local or cloud metadata/);
  const elsewhere = await admin('POST', '/api/projections/git/count', { token: { provider: 'gitlab', address: 'https://git.internal.acme.io', token: TYPED_TOKEN }, repositories: ['https://git.internal.acme.io/a/b'] });
  assert.equal(elsewhere.status, 400);
  assert.match(elsewhere.body.error, /not counted: connect that host on the Beta page, or add it to SCM_ALLOWED_HOSTS/);
  const pasted = await admin('POST', '/api/projections/git/count', { connection: 'github-1', repositories: ['https://169.254.169.254/a/b'] });
  assert.equal(pasted.status, 400);
  const injected = await admin('POST', '/api/projections/git/count', { token: { provider: 'github', address: 'https://github.com', token: `${TYPED_TOKEN}\nX-Evil: 1` }, repositories: ['https://github.com/a/b'] });
  assert.equal(injected.status, 400);
  assert.ok(!injected.text.includes(TYPED_TOKEN));
  assert.equal((await admin('POST', '/api/projections/git/count', { connection: 'gitlab-7', repositories: ['https://github.com/a/b'] })).status, 404, 'a connection that is not set up');
  assert.equal((await admin('POST', '/api/projections/git/count', { connection: 'github-1', repositories: Array.from({ length: 51 }, (_, i) => `https://github.com/a/r${i}`) })).status, 400, 'at most 50 a count');
  assert.ok(!log.includes(TYPED_TOKEN));
});
