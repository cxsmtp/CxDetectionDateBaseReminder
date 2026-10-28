// Cx Credits Calculator, Count from git with cloc-fusion's engine, end to end: the routes behind the calculator's
// permission; the Admin's git connection offered by name and host (its token never reaches the browser), its
// organizations found and everything it can see listed; a token typed for one run used for it and nothing else
// (never in an answer, a log, a saved file or an address); both engines; the run followed repository by repository,
// with commits, change frequency and developers, never a name or an email; cloc-fusion's page handed out as noted;
// and nothing of the code left in the temporary folder. The git hosts are real repositories served over git's own
// HTTP protocol on this computer, with a GitHub-like API and download host (test/fake-git-host.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';
import { FIRST_PASSWORD, NEXT_PASSWORD } from './test-credentials.js';
import { commitsEvery, makeRepo, startGitHost } from './fake-git-host.js';
import { CLOC_FUSION } from '../src/cloc-fusion/origin.js';

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const CONNECTION_TOKEN = `ghp_conn${'Q7w'.repeat(10)}`;
const TYPED_TOKEN = `ghp_typed${'K3x'.repeat(10)}`;
const WRONG_TOKEN = `ghp_${'wrong'.repeat(8)}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-count-e2e-repos-'));
const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'git-count-e2e-other-'));
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
const EMAILS = /ana@globex\.io|raj@globex\.io|lee@initech\.io/;

/** Follow a run with partial views (only what changed), as the page does; every view checked for tokens and emails. */
async function follow(as, job) {
  const end = Date.now() + 90_000;
  const rows = [];
  for (const r of job.repositories) rows[r.i] = r;
  let seq = job.seq;
  while (job.state === 'running' && Date.now() < end) {
    await sleep(200);
    const r = await as('GET', `/api/projections/git/count?id=${encodeURIComponent(job.id)}&after=${seq}`);
    assert.equal(r.status, 200, r.text);
    assert.ok(!r.text.includes(CONNECTION_TOKEN) && !r.text.includes(TYPED_TOKEN));
    assert.ok(!EMAILS.test(r.text), 'no one\'s email');
    job = r.body;
    for (const row of job.repositories) rows[row.i] = row;
    seq = job.seq;
  }
  return { ...job, repositories: rows };
}

test.before(async () => {
  makeRepo(root, 'globex', 'claims-portal', { 'src/Main.java': '// c\nclass Main {}\n\n', 'web/app.ts': 'export const a = 1;\n', 'README.md': '# x\n' }, { history: commitsEvery(60, 2, ['ana@globex.io', 'raj@globex.io']) });
  makeRepo(root, 'globex', 'policy-engine', { 'Engine.kt': 'fun main() {}\n/* c */\n' }, { history: commitsEvery(6, 30, ['raj@globex.io']) });
  makeRepo(root, 'initech', 'ledger', { 'Ledger.cs': 'class L {}\n' }, { history: commitsEvery(3, 20, ['lee@initech.io']) });
  makeRepo(otherRoot, 'umbrella', 'labs', { 'lab.py': 'x = 1\n' });
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
  for (const [method, url] of [['GET', '/api/projections/git/connections'], ['POST', '/api/projections/git/organizations'], ['POST', '/api/projections/git/repositories'], ['POST', '/api/projections/git/count'], ['GET', '/api/projections/git/count?id=x'], ['GET', '/api/projections/git/cloc-fusion']]) {
    assert.equal((await uma(method, url, method === 'GET' ? undefined : {})).status, 403, `${method} ${url}`);
  }
  assert.equal((await fetch(`${BASE}/api/projections/git/connections`)).status, 401, 'signed out');
  assert.equal((await fetch(`${BASE}/api/projections/git/cloc-fusion`)).status, 401, 'signed out');
});

test('the Admin\'s git connection: offered by name and host, its organizations found, everything it can see listed, measured with both engines; its token never reaches the browser', async () => {
  const list = await admin('GET', '/api/projections/git/connections');
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(list.body.connections, [{ id: 'github-1', provider: 'github', label: 'GitHub', host: `127.0.0.1:${connected.port}`, owner: 'globex' }]);
  assert.deepEqual(list.body.limits, { repositories: 1000, windowDays: 365 });
  assert.ok(!list.text.includes(CONNECTION_TOKEN));
  const orgs = await admin('POST', '/api/projections/git/organizations', { connections: ['github-1'] });
  assert.equal(orgs.status, 200, orgs.text);
  assert.deepEqual(orgs.body.sources.map((s) => [s.source, s.who, s.organizations.map((o) => o.id)]), [['github-1', 'me', ['@me', 'globex', 'initech']]]);
  // As before: its own organization when none is picked.
  const own = await admin('POST', '/api/projections/git/repositories', { connections: ['github-1'] });
  assert.deepEqual(own.body.repositories.map((r) => r.path), ['globex/claims-portal', 'globex/policy-engine']);
  const everything = await admin('POST', '/api/projections/git/repositories', { connections: [{ id: 'github-1', everything: true }] });
  assert.equal(everything.status, 200, everything.text);
  assert.deepEqual(everything.body.repositories.map((r) => [r.path, r.source]), [['globex/claims-portal', 'github-1'], ['globex/policy-engine', 'github-1'], ['initech/ledger', 'github-1']]);
  assert.ok(!everything.text.includes(CONNECTION_TOKEN));
  const [claims, policy, ledger] = everything.body.repositories;
  // The git engine for two, then the API engine for the third.
  const started = await admin('POST', '/api/projections/git/count', { connections: ['github-1'], engine: 'git', repositories: [claims, policy] });
  assert.equal(started.status, 202, started.text);
  assert.deepEqual(started.body.repositories.map((r) => r.state), ['waiting', 'waiting']);
  const job = await follow(admin, started.body);
  assert.equal(job.state, 'done');
  assert.equal(job.engine, 'git');
  const [c, p] = job.repositories;
  assert.equal(c.state, 'done', c.error);
  assert.deepEqual([c.name, c.branch, c.lines], ['claims-portal', 'main', 2]);
  assert.deepEqual(c.languages, { Java: { category: 'code', files: 1, code: 1 }, TypeScript: { category: 'code', files: 1, code: 1 }, Markdown: { category: 'docs', files: 1, code: 1 } });
  assert.match(c.commit, /^[0-9a-f]{7}$/);
  assert.deepEqual([c.commits, c.frequency, c.devs90], [61, '1-5-week', 3]);
  assert.deepEqual([p.commits, p.frequency, p.devs90], [7, 'month', 2]);
  assert.equal(job.summary.developers, 3, 'raj on both counts once');
  const viaApi = await follow(admin, (await admin('POST', '/api/projections/git/count', { connections: ['github-1'], engine: 'api', repositories: [ledger] })).body);
  assert.deepEqual([viaApi.engine, viaApi.repositories[0].state, viaApi.repositories[0].lines, viaApi.repositories[0].commits], ['api', 'done', 1, 4]);
  assert.ok(connected.downloads.length > 0 && connected.downloads.every((d) => d.authorization === ''), 'the download host never gets the token');
  assert.equal((await uma('GET', `/api/projections/git/count?id=${job.id}`)).status, 403);
  // Each repository a project, with where it came from and how it changes: kept with the customer, never a token, a name or an email.
  const activity = { commits: c.commits, windowDays: c.windowDays, lastCommitAt: c.lastCommitAt, frequency: c.frequency, devs90: c.devs90, engine: 'git', contributors90: [{ email: 'ana@globex.io' }] };
  const saved = await admin('PUT', `/api/projections/${customer.id}`, { fusionNew: { projects: [{ name: c.name, langs: { Java: 1, TypeScript: 1, Markdown: 1 }, git: { url: c.url, branch: c.branch, commit: c.commit, countedAt: c.countedAt, connection: 'github-1', token: CONNECTION_TOKEN }, activity }] } });
  assert.equal(saved.status, 200, saved.text);
  const opened = (await admin('GET', `/api/projections/${customer.id}`)).body.customer;
  assert.deepEqual(opened.fusionNew.projects[0].git, { host: `127.0.0.1:${connected.port}`, path: 'globex/claims-portal', url: c.url, branch: 'main', commit: c.commit, countedAt: c.countedAt, connection: 'github-1' });
  assert.equal(opened.fusionNew.projects[0].activity.frequency, '1-5-week');
  assert.ok(!JSON.stringify(opened).includes('ana@globex.io'));
});

test('a token typed for one run, beside the Admin\'s connection: used for its own host only, as a header, and never kept, logged or sent back', async () => {
  const other = await startGitHost(otherRoot, { tokens: [TYPED_TOKEN] });
  try {
    const token = { provider: 'github', address: other.url, token: TYPED_TOKEN };
    const orgs = await admin('POST', '/api/projections/git/organizations', { connections: ['github-1'], token });
    assert.deepEqual(orgs.body.sources.map((s) => s.source), ['github-1', 'token']);
    assert.ok(!orgs.text.includes(TYPED_TOKEN));
    const repos = await admin('POST', '/api/projections/git/repositories', { connections: [{ id: 'github-1', orgs: ['initech'] }], token: { ...token, orgs: ['umbrella'] } });
    assert.equal(repos.status, 200, repos.text);
    assert.deepEqual(repos.body.repositories.map((r) => [r.path, r.source]), [['initech/ledger', 'github-1'], ['umbrella/labs', 'token']]);
    const started = await admin('POST', '/api/projections/git/count', { connections: ['github-1'], token, repositories: repos.body.repositories });
    assert.equal(started.status, 202, started.text);
    assert.ok(!started.text.includes(TYPED_TOKEN));
    const job = await follow(admin, started.body);
    assert.deepEqual(job.repositories.map((r) => r.state), ['done', 'done'], JSON.stringify(job.repositories.map((r) => r.error)));
    const gitCalls = other.seen.filter((s) => !s.path.startsWith('/api/'));
    assert.ok(gitCalls.length && gitCalls.every((s) => s.authorization === `Basic ${Buffer.from(`x-access-token:${TYPED_TOKEN}`).toString('base64')}`), 'as a header, to its own host');
    assert.ok(!other.seen.some((s) => s.query.includes(TYPED_TOKEN)), 'never in an address');
    assert.ok(!connected.seen.some((s) => s.authorization.includes(Buffer.from(`x-access-token:${TYPED_TOKEN}`).toString('base64')) || s.authorization.includes(TYPED_TOKEN)), 'never to another host');
    assert.ok(!other.seen.some((s) => s.authorization.includes(CONNECTION_TOKEN) || s.authorization.includes(Buffer.from(`x-access-token:${CONNECTION_TOKEN}`).toString('base64'))), 'nor the Admin\'s token to the typed one\'s host');
    // A wrong token: said, without the token.
    const wrong = await admin('POST', '/api/projections/git/count', { token: { ...token, token: WRONG_TOKEN }, repositories: [`${other.url}/umbrella/labs`] });
    const failed = await follow(admin, wrong.body);
    assert.match(failed.repositories[0].error, /refused: check the token/);
    assert.ok(!JSON.stringify(failed).includes(WRONG_TOKEN));
  } finally {
    await other.close();
  }
  await sleep(200);
  assert.ok(!log.includes(TYPED_TOKEN) && !log.includes(CONNECTION_TOKEN), 'not in the server\'s log');
  assert.ok(!EMAILS.test(log), 'nor anyone\'s email');
  const kept = allText(dataDir);
  assert.ok(!kept.includes(TYPED_TOKEN), 'not in any file the server keeps (audit, activity, customers)');
  assert.ok(!kept.includes(Buffer.from(`x-access-token:${TYPED_TOKEN}`).toString('base64')));
  assert.ok(!EMAILS.test(kept));
  assert.match(kept, /measured from git \(cloc-fusion \d+\.\d+\.\d+, git engine\)/, 'the audit log says what was measured, and how');
  assert.deepEqual(fs.readdirSync(tmpDir).filter((n) => n.startsWith('mz-git-count-')), [], 'nothing of the code left behind');
});

test('cloc-fusion\'s one-file page, handed out as noted', async () => {
  const page = await admin('GET', '/api/projections/git/cloc-fusion');
  assert.equal(page.status, 200);
  assert.deepEqual([page.body.file, page.body.version, page.body.sha256], ['cloc-fusion.html', CLOC_FUSION.version, CLOC_FUSION.sha256]);
  assert.equal(createHash('sha256').update(page.body.html).digest('hex'), CLOC_FUSION.sha256);
});

test('only hosts that may be called: never a link-local or metadata address, never a host not connected or allowed', async () => {
  const metadata = await admin('POST', '/api/projections/git/repositories', { token: { provider: 'gitlab', address: 'https://169.254.169.254', token: TYPED_TOKEN }, owner: 'x' });
  assert.equal(metadata.status, 400);
  assert.match(metadata.body.error, /link-local or cloud metadata/);
  const elsewhere = await admin('POST', '/api/projections/git/count', { token: { provider: 'gitlab', address: 'https://git.internal.acme.io', token: TYPED_TOKEN }, repositories: ['https://git.internal.acme.io/a/b'] });
  assert.equal(elsewhere.status, 400);
  assert.match(elsewhere.body.error, /not counted: connect that host on the Beta page, or add it to SCM_ALLOWED_HOSTS/);
  const orgsElsewhere = await admin('POST', '/api/projections/git/organizations', { token: { provider: 'gitlab', address: 'https://git.internal.acme.io', token: TYPED_TOKEN } });
  assert.equal(orgsElsewhere.status, 400);
  const pasted = await admin('POST', '/api/projections/git/count', { connection: 'github-1', repositories: ['https://169.254.169.254/a/b'] });
  assert.equal(pasted.status, 400);
  const injected = await admin('POST', '/api/projections/git/count', { token: { provider: 'github', address: 'https://github.com', token: `${TYPED_TOKEN}\nX-Evil: 1` }, repositories: ['https://github.com/a/b'] });
  assert.equal(injected.status, 400);
  assert.ok(!injected.text.includes(TYPED_TOKEN));
  assert.equal((await admin('POST', '/api/projections/git/count', { connections: ['gitlab-7'], repositories: ['https://github.com/a/b'] })).status, 404, 'a connection that is not set up');
  assert.equal((await admin('POST', '/api/projections/git/count', { connections: ['github-1'], repositories: Array.from({ length: 1001 }, (_, i) => `https://github.com/a/r${i}`) })).status, 400, 'at most 1,000 a run');
  assert.equal((await admin('POST', '/api/projections/git/repositories', { connections: [{ id: 'github-1', orgs: ['../../user'] }] })).status, 400, 'an organization is a name, never a path');
  assert.ok(!log.includes(TYPED_TOKEN));
});
