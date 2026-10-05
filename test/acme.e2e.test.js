// LETSENCRYPT_DOMAIN, end to end on the real server: it answers the CA's check on plain http,
// gets the certificate, switches to HTTPS only by itself, serves the new certificate, and
// still answers the CA's checks over http (for renewals) while everything else is redirected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

import { freePort } from './free-port.js';
import { startMockAcme } from './mock-acme.js';
import { FIRST_PASSWORD } from './test-credentials.js';

const children = [];
let ca;
test.after(async () => {
  for (const child of children) child.kill();
  await ca?.close();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}

/** The certificate served on `port` for `servername`, checked against `rootPem`. */
function served(port, servername, rootPem) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, servername, ca: rootPem, rejectUnauthorized: true }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      resolve(cert);
    });
    socket.on('error', reject);
  });
}

test('LETSENCRYPT_DOMAIN: certificate obtained at start, HTTPS only by itself, challenge path still on http', async () => {
  const PORT = await freePort();
  ca = await startMockAcme({ challengeBase: () => `http://127.0.0.1:${PORT}` });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-e2e-'));
  let log = '';
  const child = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0', SMTP_HOST: '', GITHUB_TOKEN: '', CX_API_KEY: '', HTTPS: '',
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD,
      LETSENCRYPT_DOMAIN: 'mz.example.com', LETSENCRYPT_EMAIL: 'appsec@example.com', ACME_DIRECTORY_URL: ca.url,
      // mz.example.com does not resolve here, so the server cannot reach itself by that name.
      LETSENCRYPT_SKIP_CHECK: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  children.push(child);
  const end = Date.now() + 30_000;
  while (!/Let's Encrypt certificate for mz\.example\.com put to use/.test(log)) {
    if (Date.now() > end || /not obtained/.test(log)) throw new Error(log.slice(-2000));
    await sleep(100);
  }
  assert.match(log, /Getting a Let's Encrypt certificate for mz\.example\.com \(LETSENCRYPT_DOMAIN\)/);
  assert.ok(ca.log.validations.length >= 1 && ca.log.validations.every((v) => v.ok), JSON.stringify(ca.log.validations));

  // HTTPS only, by itself.
  while (JSON.parse(fs.readFileSync(path.join(dataDir, 'https.json'), 'utf8')).mode !== 'https') {
    if (Date.now() > end) throw new Error('did not switch to HTTPS only');
    await sleep(100);
  }
  // The certificate served is the CA's, for the name, and verifies against its root.
  const cert = await served(PORT, 'mz.example.com', ca.rootPem);
  assert.match(cert.subjectaltname, /DNS:mz\.example\.com/);
  assert.match(cert.issuer.CN, /Mock ACME Root/);

  // Plain http: everything redirects to https, except the CA's check, answered directly.
  const page = await get(`http://127.0.0.1:${PORT}/`);
  assert.equal(page.status, 308);
  const check = await get(`http://127.0.0.1:${PORT}/.well-known/acme-challenge/unknown-token-1234`);
  assert.equal(check.status, 404, 'answered on http, not redirected');
  assert.equal(check.body, 'Not found');

  // State kept for renewal; the account key private.
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'acme.json'), 'utf8'));
  assert.equal(state.enabled, true);
  assert.deepEqual(state.names, ['mz.example.com']);
  assert.equal(fs.statSync(path.join(dataDir, 'tls', 'acme', 'account.key')).mode & 0o777, 0o600);

  // A restart with the certificate still current does not ask the CA again.
  child.kill();
  await new Promise((r) => child.on('exit', r));
  const before = ca.log.requests.filter((r) => r.includes('new-order')).length;
  let log2 = '';
  const again = spawn(process.execPath, ['src/server.js'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0', SMTP_HOST: '', GITHUB_TOKEN: '', CX_API_KEY: '', HTTPS: '', LETSENCRYPT_DOMAIN: 'mz.example.com', ACME_DIRECTORY_URL: ca.url, LETSENCRYPT_SKIP_CHECK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  again.stdout.on('data', (d) => (log2 += d));
  again.stderr.on('data', (d) => (log2 += d));
  children.push(again);
  const end2 = Date.now() + 20_000;
  while (!/in use until .*; renewed by itself/.test(log2)) {
    if (Date.now() > end2) throw new Error(log2.slice(-1500));
    await sleep(100);
  }
  assert.equal(ca.log.requests.filter((r) => r.includes('new-order')).length, before, 'no new order');
});
