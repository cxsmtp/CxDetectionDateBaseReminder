// The Beta page with another source-code host, end to end: a GitLab connection (from the
// environment, as GITLAB_URL / GITLAB_TOKEN), tested, the username methods compared on real
// usernames, and the matches kept as initiator overrides. GitLab here is a local double.
// Saving the connection on the page, and the token never coming back: see the last test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('GitLab on the Beta page: save, test, compare methods, keep matches', async (t) => {
  const seen = [];
  const gitlab = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push({ path: u.pathname, auth: req.headers.authorization });
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.headers.authorization !== 'Bearer glpat-test') return send(401, { message: '401 Unauthorized' });
      if (u.pathname === '/api/v4/user') return send(200, { username: 'svc-mz' });
      if (u.pathname === '/api/graphql') {
        const { variables } = JSON.parse(body);
        const known = { 'jane.doe': 'jane.doe@acme.io' };
        return send(200, { data: { users: { nodes: variables.names.filter((n) => known[n]).map((n) => ({ username: n, name: 'Jane Doe', publicEmail: known[n], commitEmail: null })) } } });
      }
      if (u.pathname === '/api/v4/users') return send(200, u.searchParams.get('username') === 'bob' ? [{ username: 'bob', name: 'Bob', public_email: 'bob@acme.io' }] : []);
      return send(404, { message: '404 Not found' });
    });
  });
  const glPort = await freePort();
  await new Promise((r) => gitlab.listen(glPort, '127.0.0.1', r));
  t.after(() => gitlab.close());

  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-e2e-'));
  let log = '';
  const server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', HTTPS: 'off', BACKUP_INTERVAL_HOURS: '0', SMTP_HOST: '', CX_API_KEY: '', GITHUB_TOKEN: '', GITLAB_TOKEN: 'glpat-test', GITLAB_URL: `http://127.0.0.1:${glPort}`, ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: 'temporary password 1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  t.after(() => server.kill());
  for (let i = 0; i < 150 && !(/running on/.test(log) && /First administrator/.test(log)); i++) await sleep(100);

  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const call = async (method, route, body) => {
    const res = await fetch(base + route, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  await call('POST', '/api/session/password', { email: 'admin@acme.io', password: 'temporary password 1' });
  await call('POST', '/api/me/password', { current: 'temporary password 1', next: 'correct horse battery' });

  const check = await call('POST', '/api/beta/scm/check', { provider: 'gitlab' });
  assert.deepEqual(check.json.gitlab, { ok: true, who: 'svc-mz' });

  const report = await call('POST', '/api/beta/scm/evaluate', { provider: 'gitlab', logins: ['jane.doe', 'bob', 'nobody', 'ann@acme.io'] });
  assert.equal(report.status, 200, JSON.stringify(report.json));
  assert.equal(report.json.methods.graphql.resolved, 1);
  assert.equal(report.json.methods.graphql.requests, 1);
  assert.equal(report.json.methods.users.resolved, 1, 'bob, from his profile');
  assert.match(report.json.methods.localGit.skipped, /No local repositories/);
  assert.equal(report.json.combined['jane.doe'].email, 'jane.doe@acme.io');
  assert.equal(report.json.combined['ann@acme.io'].method, 'address');
  assert.ok(report.json.recommendation.length);
  assert.ok(seen.every((s) => s.auth === 'Bearer glpat-test'), 'the token went to GitLab, as a bearer token');

  const applied = await call('POST', '/api/beta/scm/apply', { provider: 'gitlab', mappings: [{ login: 'jane.doe', email: 'jane.doe@acme.io' }] });
  assert.equal(applied.json.applied, 1, 'a GitLab username with a dot is fine');
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  assert.equal(stored.initiators.overrides['jane.doe'], 'jane.doe@acme.io');
  assert.equal((await call('POST', '/api/beta/scm/evaluate', { provider: 'github', logins: ['x'] })).status, 400, 'GitHub has its own comparison');
});

test('host connections saved in Settings: tokens kept server side, never sent back; https only', async () => {
  const { SettingsStore, publicSettings } = await import('../src/settings.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-settings-'));
  const store = new SettingsStore({ file: path.join(dir, 'settings.json') });
  store.save({ beta: { gitlab: { apiUrl: 'https://git.acme.io', token: 'glpat-x', projects: ['team/api', 'not a project'] }, bitbucket: { kind: 'cloud', username: 'jdoe', token: 'app-pass', repos: ['acme/api'] } } });
  const shown = publicSettings(store.get());
  assert.equal(shown.beta.gitlab.tokenSet, true);
  assert.deepEqual(shown.beta.gitlab.projects, ['team/api']);
  assert.ok(!JSON.stringify(shown).includes('glpat-x') && !JSON.stringify(shown).includes('app-pass'), 'no token in what the browser gets');
  store.save({ beta: { gitlab: { group: 'acme' } } });
  assert.equal(store.get().beta.gitlab.token, 'glpat-x', 'an omitted token is kept');
  store.save({ beta: { gitlab: { token: null } } });
  assert.equal(store.get().beta.gitlab.token, '', 'null clears it');
  assert.throws(() => store.save({ beta: { azure: { orgUrl: 'http://dev.azure.com/acme' } } }), /https address/);
});
