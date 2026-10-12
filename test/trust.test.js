// Outbound HTTPS behind a company proxy that inspects it, or to a server that leaves out its
// intermediate certificate: found, explained, and trusted without a restart (src/trust.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { generateKeyPairSync } from 'node:crypto';

import { makeCertificate } from '../src/tls.js';
import { TrustStore, caIssuersUrls, describe, inspect, isUntrustedCode, parseCertificates } from '../src/trust.js';

const original = tls.getCACertificates('default');
test.after(() => tls.setDefaultCACertificates(original));

const key = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pemKey = (k) => k.privateKey.export({ type: 'pkcs8', format: 'pem' });

/** A root, an intermediate (its "CA Issuers" link at `aia`), and a certificate for localhost. */
function pki(rootName, { aia = '' } = {}) {
  const root = key();
  const inter = key();
  const leaf = key();
  const R = { cn: rootName, o: 'Acme Corp' };
  const I = { cn: `${rootName} Issuing CA`, o: 'Acme Corp' };
  const rootPem = makeCertificate({ subject: R, publicKey: root.publicKey, signerKey: root.privateKey, ca: true });
  const interPem = makeCertificate({ subject: I, issuer: R, publicKey: inter.publicKey, signerKey: root.privateKey, ca: true });
  const leafPem = makeCertificate({ subject: { cn: 'localhost' }, issuer: I, names: ['localhost'], publicKey: leaf.publicKey, signerKey: inter.privateKey, caIssuers: aia });
  return { rootPem, interPem, leafPem, leafKey: pemKey(leaf) };
}

async function serve(options) {
  // Connection: close, so each request makes a new connection and sees the trust list as it is now.
  const server = https.createServer(options, (req, res) => res.writeHead(200, { Connection: 'close' }).end('ok')).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { server, port: server.address().port };
}

async function get(port) {
  try {
    const res = await fetch(`https://localhost:${port}/`);
    return await res.text();
  } catch (error) {
    return error.cause?.code || error.message;
  }
}

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trust-'));

test('certificates are read from PEM bundles, DER and base64 DER; links and names are found', () => {
  const { rootPem, interPem, leafPem } = pki('Zscaler Root CA', { aia: 'http://pki.example.test/issuing.crt' });
  assert.equal(parseCertificates(rootPem + interPem).length, 2);
  const der = parseCertificates(rootPem)[0].raw;
  assert.equal(parseCertificates(der)[0].fingerprint256, parseCertificates(rootPem)[0].fingerprint256);
  assert.equal(parseCertificates(der.toString('base64'))[0].fingerprint256, parseCertificates(rootPem)[0].fingerprint256);
  assert.deepEqual(parseCertificates('not a certificate'), []);
  const [leaf] = parseCertificates(leafPem);
  assert.deepEqual(caIssuersUrls(leaf), ['http://pki.example.test/issuing.crt']);
  const root = describe(parseCertificates(rootPem)[0]);
  assert.equal(root.subject, 'Zscaler Root CA');
  assert.equal(root.vendor, 'Zscaler');
  assert.equal(root.selfSigned, true);
  assert.equal(describe(leaf).ca, false);
  assert.ok(isUntrustedCode('UNABLE_TO_GET_ISSUER_CERT_LOCALLY') && isUntrustedCode('SELF_SIGNED_CERT_IN_CHAIN') && !isUntrustedCode('CERT_HAS_EXPIRED'));
});

test('a proxy that presents its root: found, shown, trusted by fingerprint, kept across restarts, removable', async () => {
  const p = pki('Netskope Root CA');
  const { server, port } = await serve({ cert: p.leafPem + p.interPem + p.rootPem, key: p.leafKey });
  const data = dir();
  try {
    const store = new TrustStore({ dir: data });
    assert.equal(await get(port), 'SELF_SIGNED_CERT_IN_CHAIN');
    const found = await store.diagnose('localhost', port);
    assert.equal(found.status, 'needs-consent');
    assert.equal(found.candidate.subject, 'Netskope Root CA');
    assert.equal(found.candidate.vendor, 'Netskope');
    assert.equal(store.list().length, 0, 'nothing trusted without an Admin');

    await assert.rejects(store.trustPresented('localhost', port, 'AA:BB'), /no longer presents/);
    const done = await store.trustPresented('localhost', port, found.candidate.fingerprint256, { by: 'admin@acme.io' });
    assert.equal(done.status, 'trusted');
    assert.equal(await get(port), 'ok', 'fetch trusts it at once, no restart');
    assert.equal(store.list()[0].addedBy, 'admin@acme.io');
    assert.equal(store.list()[0].source, 'detected');
    assert.equal(fs.statSync(path.join(data, 'trust', 'certificates.json')).mode & 0o777, 0o600);
    assert.ok(fs.readFileSync(process.env.GIT_SSL_CAINFO, 'utf8').includes(p.rootPem.trim().split('\n')[1]), 'git is given the same list');

    // A fresh handshake each time (fetch may resume a TLS session, which skips the check).
    tls.setDefaultCACertificates(original);
    assert.equal((await inspect('localhost', port)).authorized, false);
    const again = new TrustStore({ dir: data });
    assert.equal((await inspect('localhost', port)).authorized, true, 'kept in the data folder');
    assert.equal(again.list().length, 1);
    again.remove(found.candidate.fingerprint256);
    assert.equal((await inspect('localhost', port)).error, 'SELF_SIGNED_CERT_IN_CHAIN');
    assert.equal(process.env.GIT_SSL_CAINFO, undefined);
  } finally {
    server.close();
    tls.setDefaultCACertificates(original);
  }
});

test('a proxy that presents its certificate for the site and its intermediate, not its root: asked to upload; a whole exported store is narrowed to what is needed', async () => {
  const p = pki('Zscaler Root CA');
  const others = [pki('Unrelated One'), pki('Unrelated Two')].map((o) => o.rootPem + o.interPem).join('');
  const { server, port } = await serve({ cert: p.leafPem + p.interPem, key: p.leafKey });
  try {
    const store = new TrustStore({ dir: dir() });
    assert.equal(await get(port), 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'what customers saw');
    const found = await store.diagnose('localhost', port);
    assert.equal(found.status, 'needs-upload');
    assert.equal(found.issuer, 'Zscaler Root CA');
    assert.equal(found.vendor, 'Zscaler');
    const chain = await store.presented('localhost', port);
    assert.throws(() => store.upload(p.leafPem), /server's own certificate/);
    assert.throws(() => store.upload('hello'), /no certificate/);
    assert.throws(() => store.upload(others, { chain, host: 'localhost' }), /None of the 4 certificate\(s\).*"Zscaler Root CA"/);
    const added = store.upload(others + p.rootPem + p.interPem, { by: 'admin@acme.io', chain, host: 'localhost' });
    assert.deepEqual(added.map((a) => a.subject), ['Zscaler Root CA'], 'only the root the chain needs, out of 5');
    assert.equal(await get(port), 'ok');
    assert.equal(store.upload(p.rootPem).length, 0, 'the same one twice is kept once');
  } finally {
    server.close();
    tls.setDefaultCACertificates(original);
  }
});

test('a proxy that presents only its certificate for the site: its root is asked for by name', async () => {
  const p = pki('Corp Inspection Root');
  const { server, port } = await serve({ cert: p.leafPem, key: p.leafKey });
  try {
    const store = new TrustStore({ dir: dir() });
    assert.equal(await get(port), 'UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    const found = await store.diagnose('localhost', port);
    assert.equal(found.status, 'needs-upload');
    assert.equal(found.issuer, 'Corp Inspection Root Issuing CA');
    const added = store.upload(p.rootPem + p.interPem, { chain: await store.presented('localhost', port), host: 'localhost' });
    assert.deepEqual(added.map((a) => a.subject), ['Corp Inspection Root Issuing CA', 'Corp Inspection Root']);
    assert.equal(await get(port), 'ok');
  } finally {
    server.close();
    tls.setDefaultCACertificates(original);
  }
});

test('a server that leaves out its intermediate: fetched from its issuer link and kept only because a trusted root vouches for it', async () => {
  // The "public" root is trusted first, as Mozilla's are; the site sends only its own certificate.
  let interDer;
  const aiaServer = http.createServer((req, res) => (req.url === '/issuing.crt' ? res.end(interDer) : res.writeHead(404).end())).listen(0, '127.0.0.1');
  await new Promise((r) => aiaServer.once('listening', r));
  const p = pki('Public Trust Root', { aia: `http://127.0.0.1:${aiaServer.address().port}/issuing.crt` });
  interDer = parseCertificates(p.interPem)[0].raw;
  const { server, port } = await serve({ cert: p.leafPem, key: p.leafKey });
  try {
    tls.setDefaultCACertificates([...original, p.rootPem]);
    const store = new TrustStore({ dir: dir() });
    assert.equal(await get(port), 'UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    const fixed = await store.diagnose('localhost', port);
    assert.equal(fixed.status, 'repaired');
    assert.equal(fixed.added[0].subject, 'Public Trust Root Issuing CA');
    assert.equal(store.list()[0].source, 'intermediate');
    assert.equal(await get(port), 'ok');
    assert.equal((await store.diagnose('localhost', port)).status, 'trusted');
  } finally {
    server.close();
    aiaServer.close();
    tls.setDefaultCACertificates(original);
  }
});

test('an issuer link to a cloud\'s instance metadata is never followed', async () => {
  const p = pki('Corp Root', { aia: 'http://169.254.169.254/latest/meta-data/' });
  const { server, port } = await serve({ cert: p.leafPem, key: p.leafKey });
  try {
    const store = new TrustStore({ dir: dir() });
    const started = Date.now();
    assert.equal((await store.diagnose('localhost', port)).status, 'needs-upload');
    assert.ok(Date.now() - started < 3000, 'refused at once, not tried');
  } finally {
    server.close();
  }
});

test('an issuer link that serves an unrelated certificate is not trusted', async () => {
  const other = pki('Somebody Else');
  const aiaServer = http.createServer((req, res) => res.end(parseCertificates(other.interPem)[0].raw)).listen(0, '127.0.0.1');
  await new Promise((r) => aiaServer.once('listening', r));
  const p = pki('Corp Root', { aia: `http://127.0.0.1:${aiaServer.address().port}/issuing.crt` });
  const { server, port } = await serve({ cert: p.leafPem, key: p.leafKey });
  try {
    tls.setDefaultCACertificates([...original, other.rootPem]);
    const store = new TrustStore({ dir: dir() });
    const found = await store.diagnose('localhost', port);
    assert.equal(found.status, 'needs-upload');
    assert.equal(store.list().length, 0);
  } finally {
    server.close();
    aiaServer.close();
    tls.setDefaultCACertificates(original);
  }
});
