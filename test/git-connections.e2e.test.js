// The header's Git chip, end to end: every git host and every connection to it (the plain
// variables and the numbered ones, GITLAB_TOKEN_2 …), each checked with its own host, and
// tokens never in what the page receives. GitHub and GitLab here are local doubles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';
import { FIRST_PASSWORD, NEXT_PASSWORD } from './test-credentials.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A host double that answers "who am I" for one token, and records who asked. */
async function hostDouble(token, who, route) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.authorization ?? '');
    const ok = req.headers.authorization === `Bearer ${token}` || req.headers.authorization === `token ${token}`;
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ok && new URL(req.url, 'http://x').pathname.endsWith(route) ? { login: who, username: who } : { message: 'Bad credentials' }));
  });
  const port = await freePort();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${port}`, seen, close: () => server.close() };
}

test('Git chip: each connection to each host, checked with its own token; tokens never sent back', async (t) => {
  const gitlab1 = await hostDouble('gl-one', 'svc-one', '/api/v4/user');
  const gitlab2 = await hostDouble('gl-two', 'svc-two', '/api/v4/user');
  const github2 = await hostDouble('gh-two', 'octo-two', '/user');
  const gitlab3 = await hostDouble('right-token', 'nobody', '/api/v4/user');
  t.after(() => [gitlab1, gitlab2, github2, gitlab3].forEach((h) => h.close()));

  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-conn-e2e-'));
  let log = '';
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', HTTPS: 'off', BACKUP_INTERVAL_HOURS: '0', SMTP_HOST: '', CX_API_KEY: '',
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD,
      GITHUB_TOKEN: '', GITHUB_API_URL: '',
      GITLAB_TOKEN: 'gl-one', GITLAB_URL: gitlab1.url,
      GITLAB_TOKEN_2: 'gl-two', GITLAB_URL_2: gitlab2.url,
      GITHUB_TOKEN_2: 'gh-two', GITHUB_API_URL_2: github2.url,
      GITLAB_TOKEN_3: 'wrong-token', GITLAB_URL_3: gitlab3.url,
    },
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
  await call('POST', '/api/session/password', { email: 'admin@acme.io', password: FIRST_PASSWORD });
  await call('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD });

  const { git, github } = (await call('GET', '/api/connections')).json;
  const name = (i) => `${i.provider}${i.n}`;
  assert.deepEqual(git.instances.map(name), ['github2', 'gitlab1', 'gitlab2', 'gitlab3']);
  const by = Object.fromEntries(git.instances.map((i) => [name(i), i]));
  assert.equal(by.gitlab1.ok, true);
  assert.equal(by.gitlab1.who, 'svc-one');
  assert.equal(by.gitlab2.ok, true);
  assert.equal(by.gitlab2.who, 'svc-two');
  assert.equal(by.github2.ok, true);
  assert.equal(by.github2.who, 'octo-two');
  assert.equal(by.gitlab3.ok, false);
  assert.match(by.gitlab3.reason, /refused the token/);
  assert.equal(by.gitlab3.help.code, 'git.gitlab.token', 'and how to fix it');
  assert.match(by.gitlab3.help.steps.join(' '), /read_api/);
  assert.doesNotMatch(JSON.stringify(by.gitlab3.help), /wrong-token/, 'the token is never repeated back');
  assert.equal(by.gitlab3.variables, 'GITLAB_TOKEN_3');
  assert.equal(git.connected, 3);
  assert.equal(git.total, 4);
  assert.equal(git.ok, false, 'one connection does not work');
  assert.deepEqual(git.missing.map((m) => m.provider), ['azure', 'bitbucket']);
  assert.equal(github.ok, false, 'no first GitHub connection');
  assert.doesNotMatch(JSON.stringify(git), /gl-one|gl-two|gh-two|wrong-token/, 'no token in the status');
  // Each token went only to its own host.
  assert.ok(gitlab1.seen.every((a) => a.includes('gl-one')));
  assert.ok(gitlab2.seen.every((a) => a.includes('gl-two')));
  assert.ok(github2.seen.every((a) => a.includes('gh-two')));
  assert.ok(gitlab3.seen.every((a) => a.includes('wrong-token')));

  // Checked at most every 5 minutes: asking again does not call the hosts again.
  const calls = gitlab1.seen.length;
  await call('GET', '/api/connections');
  assert.equal(gitlab1.seen.length, calls);

  // A further connection from an uploaded .env file shows up too, and its token is never sent back.
  const gitlab4 = await hostDouble('gl-four', 'svc-four', '/api/v4/user');
  t.after(() => gitlab4.close());
  const up = await call('POST', '/api/settings/import-env', { text: `GITLAB_TOKEN_4=gl-four\nGITLAB_URL_4=${gitlab4.url}\n` });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.deepEqual(up.json.applied.sort(), ['GITLAB_TOKEN_4', 'GITLAB_URL_4']);
  assert.doesNotMatch(JSON.stringify(up.json), /gl-four/);
  const after = (await call('GET', '/api/connections')).json.git;
  const fourth = after.instances.find((i) => i.provider === 'gitlab' && i.n === 4);
  assert.equal(fourth?.ok, true, JSON.stringify(after));
  assert.equal(fourth.who, 'svc-four');
});
