// A customer whose company proxy inspects HTTPS pastes their API key: Connect & store says
// which certificate their network presents; Trust and connect (or an upload) connects, with
// no restart and no environment variable. Only Admins of the first tenant change the list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

import { makeCertificate } from '../src/tls.js';
import { freePort } from './free-port.js';
import { FIRST_PASSWORD, NEXT_PASSWORD, mockApiKey } from './test-credentials.js';

const MOCK_PORT = await freePort();
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const children = [];
const closers = [];
let log = '';
let cookie = '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function admin(method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Origin: BASE, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => null) };
}

const key = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
/** A company proxy's certificates: root, issuing CA, and what it shows for "localhost". */
function proxyPki(name) {
  const root = key();
  const inter = key();
  const leaf = key();
  const R = { cn: name, o: 'Acme Corp' };
  const I = { cn: `${name} Issuing`, o: 'Acme Corp' };
  return {
    rootPem: makeCertificate({ subject: R, publicKey: root.publicKey, signerKey: root.privateKey, ca: true }),
    interPem: makeCertificate({ subject: I, issuer: R, publicKey: inter.publicKey, signerKey: root.privateKey, ca: true }),
    leafPem: makeCertificate({ subject: { cn: 'localhost' }, issuer: I, names: ['localhost'], publicKey: leaf.publicKey, signerKey: inter.privateKey }),
    leafKey: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

/** HTTPS in front of the mock Checkmarx One, as an inspecting proxy would be. */
async function inspectingProxy(cert, keyPem) {
  const server = https.createServer({ cert, key: keyPem }, (req, res) => {
    const upstream = http.request({ host: '127.0.0.1', port: MOCK_PORT, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${MOCK_PORT}` } }, (answer) => {
      res.writeHead(answer.statusCode, { ...answer.headers, connection: 'close' });
      answer.pipe(res);
    });
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => server.close());
  const port = server.address().port;
  return { port, url: `https://localhost:${port}` };
}

test.before(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trust-e2e-'));
  children.push(spawn(process.execPath, ['loadtest/mock-cxone.mjs'], { env: { ...process.env, PORT: String(MOCK_PORT), LAT: '1', PROJECTS: '2', RISKS: '4' }, stdio: 'ignore' }));
  const server = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0',
      CX_API_KEY: '', CX_BASE_URL: '', CX_IAM_URL: '', CX_TENANT: '', NODE_EXTRA_CA_CERTS: '',
      ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD, SMTP_HOST: '', GITHUB_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  children.push(server);
  const end = Date.now() + 20000;
  for (;;) {
    const up = await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false);
    if (up) break;
    if (Date.now() > end) throw new Error(log);
    await sleep(100);
  }
  // The first administrator is created just after the server starts answering.
  while ((await admin('POST', '/api/session/password', { email: 'admin@acme.io', password: FIRST_PASSWORD })).status !== 201) {
    if (Date.now() > end) throw new Error(log);
    await sleep(100);
  }
  await admin('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD });
});

test.after(() => {
  for (const child of children) child.kill();
  for (const close of closers) close();
});

test('a proxy that presents its root: Connect & store shows it, Trust and connect connects', async () => {
  const pki = proxyPki('Zscaler Root CA');
  const proxy = await inspectingProxy(pki.leafPem + pki.interPem + pki.rootPem, pki.leafKey);
  const apiKey = mockApiKey({ iss: `${proxy.url}/auth/realms/acme`, azp: 'integration' });
  const body = { apiKey, baseUrl: proxy.url, iamUrl: proxy.url, tenant: 'acme' };

  const first = await admin('POST', '/api/integration/cxone', body);
  assert.ok(first.status >= 400, JSON.stringify(first.body));
  const help = first.body.help;
  assert.equal(help.code, 'cx.proxy-cert');
  assert.match(help.problem, /presents its own certificate for localhost, issued by "Zscaler Root CA" \(Zscaler\)/);
  assert.equal(help.certificate.status, 'needs-consent');
  assert.equal(help.certificate.host, 'localhost');
  assert.equal(help.certificate.port, proxy.port);
  assert.ok(!JSON.stringify(first.body).includes('NODE_EXTRA_CA_CERTS'), 'no environment variable to set');

  const wrong = await admin('POST', '/api/trust/presented', { host: 'localhost', port: proxy.port, fingerprint256: 'AA:BB' });
  assert.equal(wrong.status, 409);
  const bad = await admin('POST', '/api/trust/presented', { host: 'local host; rm -rf', port: proxy.port, fingerprint256: 'AA' });
  assert.equal(bad.status, 400);

  const trusted = await admin('POST', '/api/trust/presented', { host: 'localhost', port: proxy.port, fingerprint256: help.certificate.candidate.fingerprint256 });
  assert.equal(trusted.status, 200, JSON.stringify(trusted.body));
  assert.equal(trusted.body.certificates.length, 1);
  assert.equal(trusted.body.certificates[0].addedBy, 'admin@acme.io');

  const second = await admin('POST', '/api/integration/cxone', body);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.connected, true);
  assert.equal(second.body.connection.tenant, 'acme');

  const audit = await admin('GET', '/api/audit?type=settings');
  assert.ok(JSON.stringify(audit.body).includes('Trusted the certificate localhost presents'), 'in the audit log');
});

test('a proxy that presents only its issuing CA: an uploaded store is narrowed to its root, and it connects', async () => {
  const pki = proxyPki('Netskope Root');
  const others = proxyPki('Unrelated Root');
  const proxy = await inspectingProxy(pki.leafPem + pki.interPem, pki.leafKey);
  const body = { apiKey: mockApiKey({ iss: `${proxy.url}/auth/realms/acme`, azp: 'integration' }), baseUrl: proxy.url, iamUrl: proxy.url, tenant: 'acme' };

  const first = await admin('POST', '/api/integration/cxone', body);
  assert.equal(first.body.help.certificate.status, 'needs-upload');
  assert.equal(first.body.help.certificate.issuer, 'Netskope Root');
  assert.match(first.body.help.problem, /issued by "Netskope Root" \(Netskope\)/);

  const empty = await admin('POST', '/api/trust/upload', { data: 'hello', host: 'localhost', port: proxy.port });
  assert.equal(empty.status, 400);
  const unrelated = await admin('POST', '/api/trust/upload', { data: others.rootPem, host: 'localhost', port: proxy.port });
  assert.equal(unrelated.status, 400);
  assert.match(unrelated.body.error, /"Netskope Root"/);

  const uploaded = await admin('POST', '/api/trust/upload', { data: others.rootPem + pki.rootPem + others.interPem, host: 'localhost', port: proxy.port });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  assert.deepEqual(uploaded.body.added.map((a) => a.subject), ['Netskope Root']);
  assert.equal(uploaded.body.trusted, true);

  const second = await admin('POST', '/api/integration/cxone', body);
  assert.equal(second.status, 200, JSON.stringify(second.body));

  const list = await admin('GET', '/api/trust');
  assert.equal(list.body.certificates.length, 2);
  const fp = list.body.certificates.find((c) => c.subject === 'Netskope Root').fingerprint256;
  const removed = await admin('DELETE', `/api/trust/${encodeURIComponent(fp)}`);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.certificates.length, 1);
  assert.equal((await admin('DELETE', `/api/trust/${encodeURIComponent(fp)}`)).status, 404);
});

test('without a session the list cannot be read or changed', async () => {
  const anonymous = await fetch(`${BASE}/api/trust`).then((r) => r.status);
  assert.equal(anonymous, 401);
  const upload = await fetch(`${BASE}/api/trust/upload`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: '{"data":"x"}' }).then((r) => r.status);
  assert.equal(upload, 401);
});
