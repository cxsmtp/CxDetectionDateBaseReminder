// Updating from Settings, for real: the launcher runs the server; an Admin
// installs a version from a registry, the server switches to it; a version
// that does not start is rolled back by itself; and the image's own version
// is one click away.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';
import { FIRST_PASSWORD, NEXT_PASSWORD } from './test-credentials.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OWN = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const mz = (v) => `MZ-${v.split('.').map((n) => n.padStart(2, '0')).join('.')}`;
const sha = (buffer) => `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const temp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `mz-${name}-`));

/** One layer holding this checkout's app as `version` (broken: its server stops at once). */
function appLayer(version, { broken = false } = {}) {
  const dir = temp('img');
  const app = path.join(dir, 'app');
  fs.mkdirSync(app);
  for (const name of ['src', 'public', 'scripts', 'node_modules']) fs.cpSync(path.join(ROOT, name), path.join(app, name), { recursive: true, dereference: true });
  for (const name of ['package-lock.json', 'LICENSE', 'TERMS.md', 'CHANGELOG.md']) fs.copyFileSync(path.join(ROOT, name), path.join(app, name));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ ...pkg, version }));
  if (broken) fs.writeFileSync(path.join(app, 'src', 'server.js'), "throw new Error('broken on purpose');\n");
  return execFileSync('tar', ['-czf', '-', '-C', dir, 'app'], { maxBuffer: 256 * 1024 * 1024 });
}

function registry(images) {
  const blobs = new Map();
  const manifests = new Map();
  for (const { tag, data, version } of images) {
    const config = Buffer.from(JSON.stringify({ created: new Date().toISOString(), config: { Labels: { 'io.cxmissionzero.version': version } }, history: [{ created_by: 'COPY . . # buildkit' }] }));
    blobs.set(sha(config), config).set(sha(data), data);
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, config: { digest: sha(config) }, layers: [{ digest: sha(data), size: data.length }] }));
    manifests.set(sha(manifest), manifest);
    manifests.set(tag, Buffer.from(JSON.stringify({ manifests: [{ digest: sha(manifest), platform: { os: 'linux', architecture: { x64: 'amd64', arm64: 'arm64' }[process.arch] ?? process.arch } }] })));
  }
  const server = http.createServer((req, res) => {
    let m;
    if (req.url === '/v2/acme/mz/tags/list?n=1000') return res.end(JSON.stringify({ tags: images.map((i) => i.tag) }));
    if ((m = req.url.match(/^\/v2\/acme\/mz\/manifests\/(.+)$/)) && manifests.has(m[1])) return res.end(manifests.get(m[1]));
    if ((m = req.url.match(/^\/v2\/acme\/mz\/blobs\/(.+)$/)) && blobs.has(m[1])) return res.end(blobs.get(m[1]));
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let launcher;
let reg;
let base;
let cookie = '';
let log = '';

async function call(method, url, body) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** Wait until the server answers as `version` (through a switch, it is briefly away). */
async function waitFor(version, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const health = await fetch(`${base}/api/health`).then((r) => r.json());
      if (health.version === mz(version)) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`never answered as ${mz(version)}\n${log.slice(-3000)}`);
}

test.before(async () => {
  reg = await registry([
    { tag: '9.9.7', version: '9.9.7', data: appLayer('9.9.7') },
    { tag: '9.9.6', version: '9.9.6', data: appLayer('9.9.6', { broken: true }) },
  ]);
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  launcher = spawn(process.execPath, ['src/launch.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: temp('data'), ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD, UPDATE_IMAGE: `127.0.0.1:${reg.address().port}/acme/mz`, UPDATE_START_TIMEOUT_SECONDS: '60',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  launcher.stdout.on('data', (d) => (log += d));
  launcher.stderr.on('data', (d) => (log += d));
  await waitFor(OWN);
  await call('POST', '/api/session/password', { email: 'admin@acme.io', password: FIRST_PASSWORD });
  await call('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD });
});

test.after(async () => {
  launcher?.kill('SIGTERM');
  await new Promise((r) => (launcher.exitCode !== null ? r() : launcher.once('exit', r)));
  reg?.close();
});

test('the launcher runs the image’s own version, and the Update page sees every published one', async () => {
  assert.match(log, /\[launch\] Starting MZ-\S+ \(the image’s own\)/);
  const checked = await call('POST', '/api/system/update/check');
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.equal(checked.body.supervised, true);
  assert.deepEqual(checked.body.lastCheck.versions.map((v) => v.version), ['9.9.7', '9.9.6']);
  assert.equal(checked.body.running.source, 'image');
});

test('install and switch: the server comes back as the new version, signed-in people still signed in', async () => {
  const started = await call('POST', '/api/system/update/install', { ref: '9.9.7' });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  await waitFor('9.9.7');
  const status = await call('GET', '/api/system/update');
  assert.equal(status.status, 200, 'the sign-in survived the switch');
  assert.equal(status.body.running.version, '9.9.7');
  assert.equal(status.body.running.source, 'update');
  assert.ok(status.body.events.some((e) => e.type === 'started' && e.version === '9.9.7'));
  assert.ok(status.body.installed.some((v) => v.version === '9.9.7' && v.tag === '9.9.7'));
});

test('a version that does not start is rolled back by itself, and never installed automatically again', async () => {
  assert.equal((await call('POST', '/api/system/update/install', { ref: '9.9.6' })).status, 202);
  await sleep(3000);
  await waitFor('9.9.7');
  const status = await call('GET', '/api/system/update');
  const rollback = status.body.events.find((e) => e.type === 'rollback');
  assert.equal(rollback.from, '9.9.6');
  assert.equal(rollback.to, '9.9.7');
  assert.equal(rollback.automatic, true);
  assert.deepEqual(status.body.failed, ['9.9.6']);
  assert.match(log, /MZ-9\.9\.6 failed .*going back to MZ-9\.9\.7/);
});

test('back to the image’s own version in one click; the audit log has every step', async () => {
  assert.equal((await call('POST', '/api/system/update/switch', { version: 'built-in' })).status, 200);
  await waitFor(OWN);
  const status = await call('GET', '/api/system/update');
  assert.equal(status.body.running.source, 'image');
  const audit = await call('GET', '/api/audit?type=system');
  const reasons = (audit.body.entries ?? audit.body.events ?? []).map((e) => e.reason).join('\n');
  assert.match(reasons, /MZ-9\.9\.7 installed \(9\.9\.7/);
  assert.match(reasons, /Switching from MZ-9\.9\.7 to the image’s own/);
  const report = await fetch(`${base}/api/system/report`, { headers: { Cookie: cookie } });
  assert.equal(report.status, 200);
  assert.match(report.headers.get('content-disposition'), /cxmissionzero-report-/);
  assert.equal((await report.json()).supervised, true);
});
