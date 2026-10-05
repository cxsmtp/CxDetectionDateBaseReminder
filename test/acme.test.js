// Let's Encrypt (ACME v2) from the server itself: against a strict mock CA that checks every
// signature and nonce, really fetches the HTTP-01 answer, and signs the CSR into a real chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createPublicKey, X509Certificate } from 'node:crypto';

import { AcmeService, CHALLENGE_PREFIX, RENEW_DAYS, cleanNames, validName } from '../src/acme.js';
import { startMockAcme } from './mock-acme.js';

/** A tiny plain-http server answering the challenge path from the service (as src/server.js does). */
async function challengeServer(service) {
  const server = http.createServer((req, res) => {
    const token = req.url.startsWith(CHALLENGE_PREFIX) ? req.url.slice(CHALLENGE_PREFIX.length) : '';
    const value = service().challenge(token);
    res.writeHead(value ? 200 : 404, { 'Content-Type': 'text/plain' });
    res.end(value ?? 'Not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

/** Everything wired: a challenge server, a mock CA validating against it, and a service whose fetch maps the names there. */
async function setup(caOptions = {}) {
  let service;
  const answers = await challengeServer(() => service);
  const ca = await startMockAcme({ challengeBase: () => answers.base, ...caOptions });
  // The names (mz.example.com …) do not resolve: the self-check's fetch goes to the challenge server instead.
  const fetchVia = (url, options) => fetch(String(url).replace(/^http:\/\/[a-z0-9.-]+\.example\.com/, answers.base), options);
  const installed = [];
  const https = { install: async (args) => (installed.push(args), { summary: { issuer: 'Mock ACME Root', fingerprint: 'ab' } }) };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-'));
  service = new AcmeService({ dataDir, https, log: {}, fetch: fetchVia, directories: { production: ca.url, staging: ca.url }, pollMs: 20 });
  return { service, ca, installed, dataDir, close: async () => { await ca.close(); await answers.close(); } };
}

const files = (installed) => Object.fromEntries(installed.files.map((f) => [f.name, Buffer.from(f.data, 'base64').toString()]));

test('names: public DNS names only — no IP, wildcard, single label or local name', () => {
  assert.equal(validName('mz.company.com'), true);
  for (const bad of ['10.0.0.5', '*.company.com', 'localhost', 'server', 'mz.local', 'host.internal', 'a..b.com', '']) assert.equal(validName(bad), false, bad);
  assert.deepEqual(cleanNames('MZ.Company.com, www.company.com mz.company.com'), ['mz.company.com', 'www.company.com']);
  assert.throws(() => cleanNames(''), /Enter the name/);
  assert.throws(() => cleanNames('10.1.2.3'), /IP address/);
  assert.throws(() => cleanNames('*.company.com'), /wildcard/);
});

test('a certificate is obtained end to end: account, HTTP-01, CSR, chain; installed with its own key', async () => {
  const env = await setup();
  try {
    env.service.start({ names: 'mz.example.com', email: 'appsec@example.com', agree: true, by: 'admin@acme.io' });
    assert.equal(env.service.running, true);
    await env.service.settled();
    const status = env.service.status();
    assert.equal(status.last.ok, true, status.last.error);
    assert.equal(status.enabled, true, 'renews by itself from now on');
    assert.deepEqual(status.issued.names, ['mz.example.com']);
    assert.ok(status.daysLeft >= 88 && status.daysLeft <= 90, String(status.daysLeft));
    // Installed: the chain from the CA, and the key the CSR was made with.
    assert.equal(env.installed.length, 1);
    const f = files(env.installed[0]);
    const leaf = new X509Certificate(f['letsencrypt.crt']);
    assert.match(leaf.subjectAltName, /DNS:mz\.example\.com/);
    assert.match(leaf.issuer, /Mock ACME Root/);
    assert.equal(createPublicKey(f['letsencrypt.key']).export({ format: 'jwk' }).n, leaf.publicKey.export({ format: 'jwk' }).n, 'the key matches the certificate');
    assert.equal(env.installed[0].confirm, true);
    assert.deepEqual(env.installed[0].hosts, ['mz.example.com']);
    // The CA really fetched the answer from this server; the self-check went first.
    assert.ok(env.ca.log.validations.every((v) => v.ok), JSON.stringify(env.ca.log.validations));
    // Nothing left published once done.
    assert.equal(env.service.challenge('anything-longer-than-8'), null);
    // The account key is kept (0600) and reused.
    const key = path.join(env.dataDir, 'tls', 'acme', 'account.key');
    assert.equal(fs.statSync(key).mode & 0o777, 0o600);
  } finally {
    await env.close();
  }
});

test('a stale nonce is retried once; the agreement must be accepted; one request at a time', async () => {
  const env = await setup({ badNonceOnce: true });
  try {
    assert.throws(() => env.service.start({ names: 'mz.example.com' }), /Subscriber Agreement/);
    env.service.start({ names: 'mz.example.com', agree: true });
    assert.throws(() => env.service.start({ names: 'mz.example.com', agree: true }), /already being requested/);
    await env.service.settled();
    assert.equal(env.service.status().last.ok, true, env.service.status().last.error);
  } finally {
    await env.close();
  }
});

test('the self-check stops a request whose name does not reach this server (no CA limits used up)', async () => {
  const env = await setup();
  try {
    // A name the test fetch does not map: nothing answers.
    env.service.start({ names: 'mz.unreachable.test', agree: true });
    await env.service.settled();
    const last = env.service.status().last;
    assert.equal(last.ok, false);
    assert.match(last.error, /could not reach itself/);
    assert.equal(last.precheck[0].ok, false);
    assert.equal(env.ca.log.requests.filter((r) => r.includes('new-order')).length, 0, 'the CA was not asked');
    assert.equal(env.installed.length, 0);
  } finally {
    await env.close();
  }
});

test('a failed CA check is reported with the CA\'s reason, and nothing is installed', async () => {
  const env = await setup({ failChallenge: true });
  try {
    env.service.start({ names: 'mz.example.com', agree: true });
    await env.service.settled();
    const last = env.service.status().last;
    assert.equal(last.ok, false);
    assert.match(last.error, /Let's Encrypt: .*refused \(on purpose\)/);
    assert.equal(env.installed.length, 0);
    assert.equal(env.service.status().enabled, false);
  } finally {
    await env.close();
  }
});

test('renewal: due within 30 days of expiry, not after a recent failure, and off when disabled', async () => {
  const env = await setup();
  try {
    env.service.start({ names: 'mz.example.com', agree: true });
    await env.service.settled();
    const validTo = Date.parse(env.service.status().issued.validTo);
    assert.equal(env.service.renewalDue(), false, 'fresh');
    assert.equal(env.service.renewalDue(validTo - (RENEW_DAYS - 1) * 86_400_000), true, 'inside the last 30 days');
    env.service.renew({ by: 'test' });
    await env.service.settled();
    assert.equal(env.installed.length, 2, 'renewed: a second certificate installed');
    env.service.disable();
    assert.equal(env.service.renewalDue(validTo), false, 'not after it was turned off');
    assert.throws(() => env.service.disable(), /not on/);
  } finally {
    await env.close();
  }
});
