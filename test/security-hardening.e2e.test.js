// Hardening end to end, on the real server: oversized script-error reports, template previews
// by someone who may not edit the template, tokens that stay with their host, the address put
// into automatic reports, other sessions ended by a password change, initiator tags that do
// not overwrite, bad report filters, a malformed cookie, and the integration key's host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';
import { FIRST_PASSWORD, NEXT_PASSWORD, mockApiKey } from './test-credentials.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = await freePort();
const PW = NEXT_PASSWORD;
const ENV_TOKEN = 'ghp-env-secret';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hardening-e2e-'));
const children = [];
let log = '';

// A stand-in GitHub API that records the Authorization header of every request.
const seen = [];
const github = http.createServer((req, res) => {
  seen.push({ path: req.url, auth: req.headers.authorization ?? '' });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ login: 'svc-mz' }));
});
const GH_PORT = await freePort();

/** A browser with its own session cookie; any header can be set (Host included). */
function browser() {
  let cookie = '';
  return (method, route, body, headers = {}) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port: PORT,
          path: route,
          method,
          headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (d) => (text += d));
          res.on('end', () => {
            const set = res.headers['set-cookie'];
            if (set) cookie = set[0].split(';')[0];
            let json = null;
            try {
              json = JSON.parse(text);
            } catch {}
            resolve({ status: res.statusCode, body: json, text });
          });
        },
      );
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
}

const as = {};
const storedSettings = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));

test.before(async () => {
  await new Promise((r) => github.listen(GH_PORT, '127.0.0.1', r));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', HTTPS: 'off', BACKUP_INTERVAL_HOURS: '0',
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD,
      SMTP_HOST: '', CX_API_KEY: '', REPORT_SERVER_URL: '', PUBLIC_URL: '', TRUST_PROXY: '',
      GITHUB_TOKEN: ENV_TOKEN, GITHUB_API_URL: '', GITLAB_TOKEN: '', AZURE_DEVOPS_TOKEN: '', BITBUCKET_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  children.push(server);
  for (let i = 0; i < 150 && !(/running on/.test(log) && /First administrator/.test(log)); i++) await sleep(100);

  as.admin = browser();
  assert.equal((await as.admin('POST', '/api/session/password', { email: 'admin@acme.io', password: FIRST_PASSWORD })).status, 201, log);
  assert.equal((await as.admin('POST', '/api/me/password', { current: FIRST_PASSWORD, next: PW })).status, 200);
  for (const [name, email, role] of [['analyst', 'ana@acme.io', 'analyst'], ['user', 'uma@acme.io', 'user']]) {
    assert.equal((await as.admin('POST', '/api/iam/users', { email, role, password: FIRST_PASSWORD })).status, 201);
    as[name] = browser();
    assert.equal((await as[name]('POST', '/api/session/password', { email, password: FIRST_PASSWORD })).status, 201);
    assert.equal((await as[name]('POST', '/api/me/password', { current: FIRST_PASSWORD, next: PW })).status, 200);
  }
});

test.after(() => {
  for (const child of children) child.kill();
  github.close();
});

test('a script-error report is small: a huge one is refused, a normal one recorded', async () => {
  assert.equal((await as.user('POST', '/api/diagnostics/client-error', { message: 'boom', line: 3 })).status, 204);
  const huge = await as.user('POST', '/api/diagnostics/client-error', { message: 'x'.repeat(100_000) });
  assert.equal(huge.status, 413);
  assert.equal(huge.body.error, 'That request is too large.');
});

test('settings and the template preview work with Checkmarx One not connected; only template editors preview their own markup', async () => {
  assert.equal((await as.user('GET', '/api/settings')).status, 200);
  const injected = { subject: 'INJECTED subject', html: '<p>INJECTED body</p>' };
  const byUser = await as.user('POST', '/api/settings/template/preview', injected);
  assert.equal(byUser.status, 200, byUser.text);
  assert.doesNotMatch(byUser.body.html + byUser.body.subject, /INJECTED/, 'a User previews the saved template');
  const byAdmin = await as.admin('POST', '/api/settings/template/preview', injected);
  assert.equal(byAdmin.status, 200, byAdmin.text);
  assert.match(byAdmin.body.html, /INJECTED body/);
  const bomb = await as.admin('POST', '/api/settings/template/preview', { html: '{{#projects}}'.repeat(5) + 'x' + '{{/projects}}'.repeat(5) });
  assert.equal(bomb.status, 400);
  assert.match(bomb.body.error, /nested too deeply/);
});

test('GitHub tokens go only to their own host: pointing the API address elsewhere does not send them there', async () => {
  const mock = `http://127.0.0.1:${GH_PORT}`;
  // GITHUB_TOKEN from the environment belongs to api.github.com.
  assert.equal((await as.analyst('PUT', '/api/settings', { beta: { github: { apiUrl: mock } } })).status, 200);
  assert.equal((await as.analyst('GET', '/api/connections')).status, 200);
  assert.ok(!seen.some((s) => s.auth.includes(ENV_TOKEN)), 'the environment token was not sent to the new address');

  // A token saved for this host is used here, and kept while the host stays the same.
  await as.analyst('PUT', '/api/settings', { beta: { github: { apiUrl: mock, token: 'ghp-stored' } } });
  await as.analyst('GET', '/api/connections');
  assert.ok(seen.some((s) => s.auth === 'Bearer ghp-stored'), 'the saved token reaches its own host');
  await as.analyst('PUT', '/api/settings', { beta: { github: { apiUrl: `${mock}/api/v3`, org: 'acme' } } });
  assert.equal(storedSettings().beta.github.token, 'ghp-stored', 'same host: kept');

  // Another host: the saved token is dropped, and nothing secret goes there.
  seen.length = 0;
  await as.analyst('PUT', '/api/settings', { beta: { github: { apiUrl: `http://localhost:${GH_PORT}` } } });
  assert.equal(storedSettings().beta.github.token, '', 'host changed: dropped');
  await as.analyst('GET', '/api/connections');
  assert.ok(seen.every((s) => !s.auth.includes('ghp-stored') && !s.auth.includes(ENV_TOKEN)), JSON.stringify(seen));
});

test('the address automatic reports carry is never taken from a User, or from X-Forwarded-Host', async () => {
  await as.user('GET', '/api/report-server', undefined, { Host: 'evil.example' });
  let shown = await as.admin('GET', '/api/report-server');
  assert.notEqual(shown.body.automatic.url, 'http://evil.example');
  assert.equal(shown.body.automatic.source, 'none');

  await as.admin('GET', '/api/report-server', undefined, { Host: 'mz.acme.io', 'X-Forwarded-Host': 'evil2.example' });
  shown = await as.admin('GET', '/api/report-server');
  assert.equal(shown.body.automatic.url, 'http://mz.acme.io', 'an Admin on the real name is remembered, the forwarded host is not');
});

test('changing your own password signs out your other sessions, not this one', async () => {
  const elsewhere = browser();
  assert.equal((await elsewhere('POST', '/api/session/password', { email: 'uma@acme.io', password: PW })).status, 201);
  assert.equal((await elsewhere('GET', '/api/settings')).status, 200);
  assert.equal((await as.user('POST', '/api/me/password', { current: PW, next: 'another long passphrase' })).status, 200);
  assert.equal((await elsewhere('GET', '/api/settings')).status, 401, 'the other session ended');
  assert.equal((await as.user('GET', '/api/settings')).status, 200, 'this one stays');
});

test('tagging an initiator fills in a missing address; changing one needs the initiator settings', async () => {
  assert.equal((await as.user('POST', '/api/initiators/tag', { initiator: 'jdoe', email: 'jdoe@acme.io' })).status, 200);
  assert.equal((await as.user('POST', '/api/initiators/tag', { initiator: 'jdoe', email: 'jdoe@acme.io' })).status, 200, 'the same address again is fine');
  const overwrite = await as.user('POST', '/api/initiators/tag', { initiator: 'jdoe', email: 'attacker@evil.example' });
  assert.equal(overwrite.status, 409);
  assert.match(overwrite.body.error, /already has an address/);
  assert.equal((await as.analyst('POST', '/api/initiators/tag', { initiator: 'jdoe', email: 'john.doe@acme.io' })).status, 200);
  assert.equal(storedSettings().initiators.overrides.jdoe, 'john.doe@acme.io');
  assert.equal((await as.user('POST', '/api/initiators/tag', { initiator: 'x'.repeat(201), email: 'x@acme.io' })).status, 400);
});

test('bad report filters are a 400, a malformed cookie is a 401: neither is a server error', async () => {
  const bad = await as.user('POST', '/api/reports/html', { buckets: '60+' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /buckets must be a list/);
  assert.equal((await as.user('POST', '/api/reports/html', { severities: { a: 1 } })).status, 400);
  assert.equal((await browser()('GET', '/api/settings', undefined, { Cookie: 'cxdr_sid=%E0%A4%A' })).status, 401);
});

test('the stored Checkmarx One key is dropped when its endpoints move to another host', async () => {
  const key = mockApiKey({ iss: 'http://127.0.0.1:9/auth/realms/acme' });
  let status = await as.admin('PUT', '/api/integration/cxone/draft', { apiKey: key });
  assert.equal(status.body.keyStored, true);
  status = await as.admin('PUT', '/api/integration/cxone/draft', { tenant: 'acme' });
  assert.equal(status.body.keyStored, true, 'same hosts: kept');
  status = await as.admin('PUT', '/api/integration/cxone/draft', { iamUrl: 'https://iam.evil.example' });
  assert.equal(status.body.keyStored, false, 'another IAM host: the key must be given again');
  status = await as.admin('PUT', '/api/integration/cxone/draft', { apiKey: key, iamUrl: 'https://iam.evil.example' });
  assert.equal(status.body.keyStored, true, 'with the key given again');
});
