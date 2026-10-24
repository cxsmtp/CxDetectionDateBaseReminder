// Outbound addresses (SSRF), secrets in addresses, error details and log lines: the checks on the
// GitHub client, git clones, the SCM client, the update registry, the integrity check, updates and
// the standalone calculator's launcher.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { blockedHost, checkOutboundUrl, outboundUrlProblem } from '../src/outbound-url.js';
import { GitHubClient } from '../src/github/client.js';
import { parseRepoUrl } from '../src/github/blame.js';
import { ScmClient } from '../src/scm/client.js';
import { ImageRegistry, isImageRef } from '../src/updates/registry.js';
import { UpdateService } from '../src/updates/service.js';
import { IntegrityService } from '../src/integrity/service.js';
import { startLauncher } from '../src/calculator-launcher.js';
import { mockApiKey } from './test-credentials.js';

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});

test('outbound addresses: https (http only to this machine), never link-local or metadata, no credentials', () => {
  for (const host of ['169.254.169.254', '[fe80::1]', 'metadata.google.internal', '100.100.100.200', '168.63.129.16', '[fd00:ec2::254]', '[::ffff:169.254.169.254]', '0.0.0.0']) {
    assert.equal(blockedHost(new URL(`https://${host}/`).hostname), true, host);
  }
  for (const host of ['api.github.com', '10.0.0.5', 'gitlab.internal.acme', '[2001:db8::1]']) assert.equal(blockedHost(new URL(`https://${host}/`).hostname), false, host);
  // Other spellings of the metadata address come out of the URL parser as 169.254.169.254.
  assert.match(outboundUrlProblem('http://2852039166/latest/meta-data'), /https|link-local/);
  assert.match(outboundUrlProblem('https://0xa9fea9fe/'), /link-local/);
  assert.equal(outboundUrlProblem('https://ghe.acme.com/api/v3'), '');
  assert.equal(outboundUrlProblem('http://127.0.0.1:8080/api'), '');
  assert.match(outboundUrlProblem('http://127.0.0.1:8080/api', { allowLoopbackHttp: false }), /https/);
  assert.match(outboundUrlProblem('http://example.com/'), /https/);
  assert.match(outboundUrlProblem('https://user:pass@example.com/'), /user name or password/);
  assert.throws(() => checkOutboundUrl('https://user:pa55@example.com/', { label: 'GitHub API URL' }), (e) => e.status === 400 && !e.message.includes('pa55'));
  assert.equal(checkOutboundUrl(' https://api.github.com '), 'https://api.github.com');
});

test('GitHub client: a link-local or plain-http API address is refused before the token is sent', async () => {
  let called = 0;
  const fetchImpl = async () => {
    called += 1;
    return new Response('{}', { status: 200 });
  };
  const gh = new GitHubClient({ token: 't', apiUrl: 'https://169.254.169.254/api/v3', fetchImpl });
  await assert.rejects(gh.rest('/user'), (e) => e.status === 400 && /link-local/.test(e.message));
  await assert.rejects(new GitHubClient({ token: 't', apiUrl: 'http://ghe.acme.com/api/v3', fetchImpl }).graphql('{viewer{login}}'), /https/);
  assert.equal(called, 0);
  assert.deepEqual(await new GitHubClient({ apiUrl: 'https://api.github.com', fetchImpl }).rest('/user'), {});
  assert.equal(called, 1);
});

test('repository addresses from scan data: never one on a link-local or metadata host', () => {
  assert.equal(parseRepoUrl('https://169.254.169.254/latest/meta-data'), null);
  assert.equal(parseRepoUrl('https://metadata.google.internal/computeMetadata/v1'), null);
  assert.equal(parseRepoUrl('https://github.com/acme/app.git').cloneUrl, 'https://github.com/acme/app.git');
});

test('SCM client: credentials never in a query string, never to a link-local base address', () => {
  const gl = new ScmClient({ name: 'GitLab', baseUrl: 'https://gitlab.acme.com/api/v4', auth: 'Bearer x' });
  assert.throws(() => gl.url('/users', { private_token: 'secret' }), /credential/);
  assert.throws(() => gl.url('/users', { access_token: 'secret' }), /credential/);
  assert.equal(gl.url('/users', { username: 'kim', continuationToken: 'abc' }).search, '?username=kim&continuationToken=abc');
  assert.throws(() => new ScmClient({ name: 'GitLab', baseUrl: 'https://169.254.169.254/api/v4' }).url('/users'), /link-local/);
});

test('update registry: a sign-in address from the registry is checked, and the token stays on its own site', async () => {
  const seen = [];
  let realm = '';
  const server = await listen((req, res) => {
    if (req.url.startsWith('/token')) {
      seen.push(req.headers.authorization ?? '');
      return res.end(JSON.stringify({ token: 'anon' }));
    }
    if (req.headers.authorization !== 'Bearer anon') {
      res.writeHead(401, { 'www-authenticate': `Bearer realm="${realm}",service="fake"` });
      return res.end();
    }
    res.end(JSON.stringify({ tags: ['1.0.0'] }));
  });
  const port = server.address().port;
  try {
    realm = 'http://169.254.169.254/token';
    await assert.rejects(new ImageRegistry({ image: `127.0.0.1:${port}/acme/mz`, token: 'registry-secret' }).tags(), /does not call/);
    // Another site's sign-in service: answered, but without the registry's token.
    realm = `http://localhost:${port}/token`;
    assert.deepEqual(await new ImageRegistry({ image: `127.0.0.1:${port}/acme/mz`, token: 'registry-secret' }).tags(), ['1.0.0']);
    assert.deepEqual(seen, ['']);
    // Its own site: the token goes with it.
    realm = `http://127.0.0.1:${port}/token`;
    await new ImageRegistry({ image: `127.0.0.1:${port}/acme/mz`, token: 'registry-secret' }).tags();
    assert.match(seen[1], /^Basic /);
  } finally {
    server.close();
  }
  assert.throws(() => new ImageRegistry({ image: '169.254.169.254/acme/mz' }), /link-local/);
});

test('updates: only a tag or digest is installed, and the audit line stays one line', async () => {
  assert.equal(isImageRef('1.0.99'), true);
  assert.equal(isImageRef(`sha256:${'a'.repeat(64)}`), true);
  assert.equal(isImageRef('1.0.99\nForged entry'), false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-updates-'));
  const records = [];
  const updates = new UpdateService({ store: { root }, runningVersion: '1.0.0', image: '127.0.0.1:9/acme/mz', supervised: true, record: (r) => records.push(r), fetch: async () => { throw new Error('offline\r\nForged: entry'); } });
  assert.throws(() => updates.install('1.0.0\nUpdate to 9.9.9 succeeded'), (e) => e.status === 400);
  assert.equal(records.length, 0);
  updates.install('1.0.1');
  for (let i = 0; i < 50 && !records.length; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(records.length, 1);
  assert.doesNotMatch(records[0].reason, /[\r\n]/);
});

test('integrity: a bundle address from the attestations answer is never a link-local or plain-http one', async () => {
  const asked = [];
  const fetch = async (url) => {
    asked.push(String(url));
    if (String(url).includes('/attestations/')) return new Response(JSON.stringify({ attestations: [{ bundle_url: 'http://169.254.169.254/latest/meta-data/iam' }, { bundle_url: 'http://bundles.example.com/b.json' }] }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-integrity-'));
  const service = new IntegrityService({ appDir: dataDir, dataDir, repository: 'acme/mission', fetch, api: 'https://api.github.com' });
  const result = await service.verifyOrigin('a'.repeat(64));
  assert.equal(result.ok, false);
  assert.deepEqual(asked, [`https://api.github.com/repos/acme/mission/attestations/sha256:${'a'.repeat(64)}`]);
});

test('calculator launcher: this computer only, and unexpected errors stay in its window', async () => {
  await assert.rejects(startLauncher({ html: '"__CALCULATOR_LAUNCHER__"', host: '0.0.0.0', open: false, log: () => {} }), /only serves this computer/);
  const logs = [];
  const log = (line) => {
    logs.push(line);
    if (line.startsWith('Connected')) throw new Error('ENOENT /home/someone/internal/path');
  };
  const launcher = await startLauncher({ html: '<p>"__CALCULATOR_LAUNCHER__"</p>', open: false, log, connect: () => ({ request: async () => ({}) }) });
  try {
    const page = await (await fetch(launcher.url)).text();
    const token = JSON.parse(page.slice(page.indexOf('{'), page.lastIndexOf('}') + 1)).token;
    const post = (route, body) => fetch(new URL(route, launcher.url), { method: 'POST', headers: { 'x-calculator-token': token, 'Content-Type': 'application/json' }, body });
    const notJson = await post('/launcher/connect', '{not json');
    assert.equal(notJson.status, 400);
    const key = mockApiKey({ iss: 'http://127.0.0.1:9/auth/realms/acme' });
    const failed = await post('/launcher/connect', JSON.stringify({ apiKey: key }));
    assert.equal(failed.status, 500);
    const { error } = await failed.json();
    assert.doesNotMatch(error, /internal\/path|ENOENT/);
    assert.ok(logs.some((l) => l.includes('internal/path')), 'the details are in the launcher window');
  } finally {
    await launcher.close();
  }
});
