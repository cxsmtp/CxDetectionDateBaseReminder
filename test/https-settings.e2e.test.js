// HTTPS from Settings → HTTPS (Admin only), on a running server, with no restart: http and
// https side by side on one port, a company certificate checked before use (chain, key, names),
// the switch to HTTPS only (only from a page already open over HTTPS), what plain http gets
// afterwards (pages redirect, reports are told the new address), HSTS, a certificate request
// for IT, putting the previous certificate back, and the way back in from the command line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createPublicKey, generateKeyPairSync, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

import { freePort } from './free-port.js';
import { DEFAULT_ROLES } from '../src/iam.js';
import { makeCertificate } from '../src/tls.js';

const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
test.after(() => {
  for (const child of children) child.kill();
});

/** A company CA: root, intermediate, and a server certificate for localhost / 127.0.0.1. */
function companyChain({ names = ['localhost', '127.0.0.1'], publicKey } = {}) {
  const root = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const mid = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const leaf = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const rootSubject = { cn: 'Acme Root CA', o: 'Acme' };
  const midSubject = { cn: 'Acme Issuing CA', o: 'Acme' };
  const rootCert = makeCertificate({ subject: rootSubject, publicKey: root.publicKey, signerKey: root.privateKey, ca: true, days: 3650 });
  const midCert = makeCertificate({ subject: midSubject, issuer: rootSubject, publicKey: mid.publicKey, signerKey: root.privateKey, ca: true, days: 1825 });
  const leafCert = makeCertificate({ subject: { cn: names[0] }, issuer: midSubject, names, publicKey: publicKey ?? leaf.publicKey, signerKey: mid.privateKey });
  return { rootCert, midCert, leafCert, leafKey: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
const file = (name, text) => ({ name, data: Buffer.from(text).toString('base64') });

/** The public key inside a PEM certificate request (SubjectPublicKeyInfo is its third field). */
function csrPublicKey(csrPem) {
  const der = Buffer.from(csrPem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  const read = (buf, at) => {
    let len = buf[at + 1];
    let head = 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = (len << 8) | buf[at + 2 + i];
      head += n;
    }
    return { start: at, body: at + head, end: at + head + len };
  };
  const info = read(der, read(der, 0).body); // CertificationRequestInfo
  let at = info.body;
  for (let i = 0; i < 2; i++) at = read(der, at).end; // version, subject
  const spki = read(der, at);
  return createPublicKey({ key: der.subarray(spki.start, spki.end), format: 'der', type: 'spki' });
}

function start(env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'https-settings-'));
  let log = '';
  const child = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, HOST: '127.0.0.1', DATA_DIR: dataDir, BACKUP_INTERVAL_HOURS: '0', REPORT_SIGNING_KEY: 'https-settings', SMTP_HOST: '', GITHUB_TOKEN: '', CX_API_KEY: '', REPORT_SERVER_URL: '', TLS_CERT_FILE: '', TLS_KEY_FILE: '', TLS_PFX_FILE: '', TLS_SELF_SIGNED: '', ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: 'temporary password 1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  children.push(child);
  return { child, dataDir, log: () => log };
}
async function until(check, ms = 15000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(100);
  }
}

/** One request over http or https; {status, headers, json, text}. `ca` checks the certificate; without it, it is not checked. */
function call(url, { method = 'GET', headers = {}, body, ca } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = lib.request(url, { method, ca, rejectUnauthorized: Boolean(ca), headers: { ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('an Admin moves a running server from http to HTTPS from the Settings page, without a restart', async () => {
  const port = await freePort();
  const server = start({ PORT: String(port), HTTPS: 'off' });
  const HTTP = `http://127.0.0.1:${port}`;
  const HTTPS_ = `https://127.0.0.1:${port}`;
  await until(() => /running on http:\/\//.test(server.log()) && /First administrator created/.test(server.log()));

  // Sign in (over http, as the server runs now) and choose a password.
  let cookie = '';
  const as = async (base, method, route, body, extra = {}) => {
    const res = await call(`${base}${route}`, { method, body, headers: { Cookie: cookie, ...(extra.headers ?? {}) }, ca: extra.ca });
    const set = res.headers['set-cookie'];
    if (set) cookie = String(set).split(';')[0];
    return res;
  };
  const first = await as(HTTP, 'POST', '/api/session/password', { email: 'admin@acme.io', password: 'temporary password 1' });
  assert.ok(first.status < 300, `${first.status} ${first.text} ${server.log()}`);
  assert.equal((await as(HTTP, 'POST', '/api/me/password', { current: 'temporary password 1', next: 'correct horse battery' })).status, 200);
  assert.equal((await call(`${HTTP}/api/https`)).status, 401, 'signed-in Admins only');
  assert.ok(!DEFAULT_ROLES.analyst.permissions.includes('security.https'), 'an Admin-only permission');

  let status = (await as(HTTP, 'GET', '/api/https')).json;
  assert.equal(status.mode, 'http');
  assert.equal(status.chosenHere, false);
  await assert.rejects(call(`${HTTPS_}/api/health`), 'no TLS while the server is HTTP only');

  // 1. HTTPS next to http, on the same port: nothing changes for http users.
  status = (await as(HTTP, 'POST', '/api/https/mode', { mode: 'both' })).json;
  assert.equal(status.mode, 'both');
  assert.equal(status.certificate.trust, 'self-signed', 'a self-signed one until a real one is uploaded');
  assert.equal((await call(`${HTTP}/api/health`)).status, 200);
  assert.equal((await call(`${HTTPS_}/api/health`)).status, 200);

  // 2. The company certificate, checked before use.
  const chain = companyChain();
  const leafOnly = (await as(HTTP, 'POST', '/api/https/inspect', { files: [file('server.crt', chain.leafCert), file('server.key', chain.leafKey)] })).json;
  assert.equal(leafOnly.usable, true);
  assert.equal(leafOnly.trust, 'incomplete', 'the missing intermediate is spotted');
  assert.equal(leafOnly.checks.find((c) => c.id === 'trust').level, 'warn');
  const wrongKey = await as(HTTP, 'POST', '/api/https/inspect', { files: [file('server.crt', chain.leafCert), file('other.key', companyChain().leafKey)] });
  assert.equal(wrongKey.status, 400);
  assert.match(wrongKey.json.error, /does not belong to any of these certificates/);
  const otherNames = await as(HTTP, 'POST', '/api/https/inspect', { files: [file('bundle.pem', companyChain({ names: ['mz.acme.io'] }).leafCert + chain.midCert), file('k.key', chain.leafKey)] });
  assert.equal(otherNames.status, 400, 'a key from another pair');
  const full = (await as(HTTP, 'POST', '/api/https/inspect', { files: [file('server.crt', chain.leafCert), file('chain.pem', chain.midCert + chain.rootCert), file('server.key', chain.leafKey)] })).json;
  assert.equal(full.trust, 'company');
  assert.equal(full.checks.find((c) => c.id === 'names').level, 'ok', JSON.stringify(full.checks));
  assert.deepEqual(full.summary.chain.map((c) => c.subject), ['localhost', 'Acme Issuing CA', 'Acme Root CA']);

  // Put to use at once; it verifies against the company root, with the whole chain served.
  const installed = await as(HTTP, 'POST', '/api/https/certificate', { files: [file('server.crt', chain.leafCert), file('chain.pem', chain.midCert + chain.rootCert), file('server.key', chain.leafKey)] });
  assert.equal(installed.status, 200, installed.text);
  assert.equal((await call(`${HTTPS_}/api/health`, { ca: chain.rootCert })).status, 200, 'trusted by a browser that trusts the company root');
  assert.equal(fs.statSync(path.join(server.dataDir, 'tls', 'uploaded', 'server.key')).mode & 0o777, 0o600);

  // 3. HTTPS only: refused from an http page, done from an https one.
  const fromHttp = await as(HTTP, 'POST', '/api/https/mode', { mode: 'https' });
  assert.equal(fromHttp.status, 409);
  assert.equal(fromHttp.json.needsHttps, true);
  const switched = await as(HTTPS_, 'POST', '/api/https/mode', { mode: 'https', updateAddress: true }, { ca: chain.rootCert });
  assert.equal(switched.status, 200, switched.text);
  assert.equal(switched.json.addressChanged, `https://127.0.0.1:${port}`, 'the reminder server address follows');

  // Plain http now: pages redirect, API calls and reports are told where to go.
  const page = await call(`${HTTP}/dashboard?x=1`);
  assert.equal(page.status, 308);
  assert.equal(page.headers.location, `https://127.0.0.1:${port}/dashboard?x=1`);
  const relay = await call(`${HTTP}/api/relay/hello`, { method: 'POST', body: {}, headers: { Origin: 'null' } });
  assert.equal(relay.status, 426);
  assert.equal(relay.json.movedTo, `https://127.0.0.1:${port}`);
  assert.equal(relay.headers['access-control-allow-origin'], '*', 'a report opened from disk can read the answer');
  assert.equal((await call(`${HTTP}/api/relay/hello`, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST' } })).status, 204);

  // 4. Hardening: HSTS only now, and at the chosen age.
  const hsts = await as(HTTPS_, 'POST', '/api/https/hardening', { hsts: { enabled: true, maxAge: 86400 }, minVersion: 'TLSv1.3' }, { ca: chain.rootCert });
  assert.equal(hsts.status, 200, hsts.text);
  const hardened = await call(`${HTTPS_}/api/health`, { ca: chain.rootCert });
  assert.equal(hardened.headers['strict-transport-security'], 'max-age=86400');
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, maxVersion: 'TLSv1.2', ca: chain.rootCert, servername: 'localhost' }, () => resolve(socket.end()));
    socket.on('error', reject);
  }), 'TLS 1.2 refused once 1.3 is the lowest');
  const backToHttp = await as(HTTPS_, 'POST', '/api/https/mode', { mode: 'http', confirm: true }, { ca: chain.rootCert });
  assert.equal(backToHttp.status, 409, 'not while HSTS is on');

  // 5. A renewal through a request made here: only the certificate comes back from IT.
  const made = await as(HTTPS_, 'POST', '/api/https/request', { names: ['localhost', '127.0.0.1'], organization: 'Acme' }, { ca: chain.rootCert });
  assert.equal(made.status, 200, made.text);
  assert.match(made.json.csr, /BEGIN CERTIFICATE REQUEST/);
  const renewed = companyChain({ publicKey: csrPublicKey(made.json.csr) });
  const paired = await as(HTTPS_, 'POST', '/api/https/certificate', { files: [file('renewed.cer', renewed.leafCert), file('chain.pem', renewed.midCert)] }, { ca: chain.rootCert });
  assert.equal(paired.status, 200, paired.text);
  assert.equal(paired.json.status.request, null, 'the request is used up');
  assert.equal(paired.json.report.summary.chain[1].subject, 'Acme Issuing CA');
  const served = await new Promise((resolve, reject) => {
    const socket = tls.connect({ host: '127.0.0.1', port, ca: renewed.rootCert, servername: 'localhost' }, () => {
      resolve(new X509Certificate(socket.getPeerCertificate().raw).fingerprint256);
      socket.end();
    });
    socket.on('error', reject);
  });
  assert.equal(served, new X509Certificate(renewed.leafCert).fingerprint256, 'the renewed certificate is served, with no restart');

  // ... and back to the previous one in one click.
  const back = await as(HTTPS_, 'POST', '/api/https/certificate/previous', {}, { ca: renewed.rootCert });
  assert.equal(back.status, 200, back.text);
  assert.equal((await call(`${HTTPS_}/api/health`, { ca: chain.rootCert })).status, 200, 'the first certificate is served again');

  // 6. Locked out? The command line puts http back next to https, and HSTS off, within seconds.
  execFileSync(process.execPath, ['scripts/https.mjs', 'both'], { env: { ...process.env, DATA_DIR: server.dataDir } });
  await until(async () => (await call(`${HTTP}/api/health`)).status === 200, 10000);
  assert.equal((await call(`${HTTPS_}/api/health`, { ca: chain.rootCert })).headers['strict-transport-security'], undefined);

  // Every change is in the audit log.
  const audit = fs.readdirSync(path.join(server.dataDir, 'audit')).map((f) => fs.readFileSync(path.join(server.dataDir, 'audit', f), 'utf8')).join('');
  for (const words of ['HTTP and HTTPS side by side', 'HTTPS certificate for localhost put to use', 'HTTPS only', 'HSTS on', 'Certificate request created', 'Previous HTTPS certificate put back', 'scripts/https.mjs']) {
    assert.ok(audit.includes(words), `audit: ${words}`);
  }
});

test('the image default (HTTPS=on) answers plain http on the same port with a redirect', async () => {
  const port = await freePort();
  const server = start({ PORT: String(port), HTTPS: 'on' });
  await until(() => /running on https:\/\//.test(server.log()));
  const moved = await call(`http://127.0.0.1:${port}/`);
  assert.equal(moved.status, 308);
  assert.equal(moved.headers.location, `https://127.0.0.1:${port}/`);
  assert.equal((await call(`https://127.0.0.1:${port}/api/health`)).status, 200);
  // The container's health check works whatever the mode.
  execFileSync(process.execPath, ['scripts/healthcheck.mjs'], { env: { ...process.env, PORT: String(port) } });
});
