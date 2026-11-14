// Activation codes: only codes signed by a trusted key, well formed and not expired are valid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';

import { ActivationStore, ISSUER_KEYS, checkCode, readCode } from '../src/activation.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-'));
const keyFile = path.join(dir, 'issuer.pem');
const script = (...args) => execFileSync(process.execPath, ['scripts/activation.mjs', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const publicKey = script('keygen', keyFile).split('\n').pop();
const issue = (org, max, months) => script('issue', keyFile, org, String(max), ...(months ? [String(months)] : []));

test('the built-in issuer key(s) are valid Ed25519 public keys; without any key no code verifies', () => {
  assert.ok(ISSUER_KEYS.length >= 1, 'the maintainer’s public key is built in');
  for (const key of ISSUER_KEYS) {
    const pub = createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' });
    assert.equal(pub.asymmetricKeyType, 'ed25519');
  }
  // With no trusted key, nothing verifies — not even a well-formed code.
  assert.equal(checkCode(issue('Acme', 3), { keys: [] }).valid, false);
});

test('a code from the issuer is valid for 12 months, and says for whom', () => {
  const code = issue('Acme Bank', 4);
  const r = checkCode(code, { keys: [publicKey] });
  assert.equal(r.valid, true, r.reason);
  assert.equal(r.org, 'Acme Bank');
  assert.equal(r.maxTenants, 4);
  assert.ok(r.daysLeft >= 364 && r.daysLeft <= 367, String(r.daysLeft));
  assert.equal(r.warn, false);
  assert.equal(readCode(code).payload.org, 'Acme Bank');
});

test('warned 30 days before, and expired after', () => {
  const code = issue('Acme', 2, 1);
  const soon = checkCode(code, { keys: [publicKey], now: Date.now() + 10 * 86_400_000 });
  assert.equal(soon.valid, true);
  assert.equal(soon.warn, true);
  const late = checkCode(code, { keys: [publicKey], now: Date.now() + 40 * 86_400_000 });
  assert.equal(late.valid, false);
  assert.equal(late.expired, true);
  assert.match(late.reason, /expired/);
});

test('refused: another key, a changed payload, garbage', () => {
  const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const code = issue('Acme', 3);
  assert.equal(checkCode(code, { keys: [other] }).valid, false);
  const [head, , sig] = code.split('.');
  const forged = `${head}.${Buffer.from(JSON.stringify({ ...readCode(code).payload, maxTenants: 99 })).toString('base64url')}.${sig}`;
  assert.equal(checkCode(forged, { keys: [publicKey] }).valid, false);
  assert.equal(checkCode('hello', { keys: [publicKey] }).valid, false);
  assert.equal(checkCode('', { keys: [publicKey] }).valid, false);
});

test('keygen never overwrites a private key', () => {
  assert.throws(() => script('keygen', keyFile));
});

test('Hebrew activate and deactivate codes carry a scope and action', () => {
  const on = script('lang', keyFile, 'Acme', 'he', 'on');
  const r = checkCode(on, { keys: [publicKey] });
  assert.equal(r.valid, true, r.reason);
  assert.equal(r.scope, 'lang:he');
  assert.equal(r.action, 'activate');
  assert.equal(r.maxTenants, 0);
  const off = checkCode(script('lang', keyFile, 'Acme', 'he', 'off'), { keys: [publicKey] });
  assert.equal(off.valid, true);
  assert.equal(off.action, 'deactivate');
});

test('a tenants code is not valid for a language scope, and vice versa', () => {
  const tenants = checkCode(issue('Acme', 3), { keys: [publicKey] });
  assert.equal(tenants.scope, 'tenants');
  assert.equal(tenants.action, '');
  // A language code has no tenant count; a tenants code has no action.
  const lang = checkCode(script('lang', keyFile, 'Acme', 'he', 'on'), { keys: [publicKey] });
  assert.equal(lang.maxTenants, 0);
});

test('the calculator’s Impact tab: off until a feature code turns it on, off again with its off code or when it runs out', () => {
  const on = script('feature', keyFile, 'Acme', 'impact', 'on');
  const off = script('feature', keyFile, 'Acme', 'impact', 'off');
  const r = checkCode(on, { keys: [publicKey] });
  assert.equal(r.valid, true, r.reason);
  assert.equal(r.scope, 'feature:impact');
  assert.equal(r.action, 'activate');
  assert.equal(checkCode(off, { keys: [publicKey] }).action, 'deactivate');
  const store = new ActivationStore({ file: path.join(dir, 'activation.json'), keys: [publicKey] });
  assert.equal(store.feature('impact'), null, 'off by default');
  store.record(r, 'admin');
  assert.equal(store.feature('impact').on, true);
  assert.equal(new ActivationStore({ file: path.join(dir, 'activation.json'), keys: [publicKey] }).feature('impact').on, true, 'kept');
  const later = Date.parse(r.expires) + 1000;
  assert.deepEqual([store.feature('impact', later).on, store.feature('impact', later).expired], [false, true], 'off once it runs out');
  store.record(checkCode(off, { keys: [publicKey] }), 'admin');
  assert.equal(store.feature('impact').on, false);
  assert.equal(store.tenants(), null, 'no tenants unlocked by it');
});

test('a code issued before the one in force is not taken again: an older "on" cannot undo a later "off"', () => {
  const file = path.join(dir, 'replay.json');
  const store = new ActivationStore({ file, keys: [publicKey] });
  const on = checkCode(script('feature', keyFile, 'Acme', 'govern', 'on'), { keys: [publicKey] });
  const off = checkCode(script('feature', keyFile, 'Acme', 'govern', 'off'), { keys: [publicKey] });
  assert.equal(store.refusal(on), '', 'nothing in force yet');
  store.record(on, 'admin');
  assert.equal(store.refusal(on), '', 'the same code again changes nothing, and is not refused');
  assert.equal(store.refusal(off), '');
  store.record(off, 'admin');
  assert.equal(store.feature('govern').on, false);
  assert.match(store.refusal(on), /issued before the one in force/);
  // A new "on", issued after the "off", is what turns it back on.
  assert.equal(store.refusal(checkCode(script('feature', keyFile, 'Acme', 'govern', 'on'), { keys: [publicKey] })), '');
  // Another scope is not compared with this one.
  assert.equal(store.refusal(checkCode(script('feature', keyFile, 'Acme', 'impact', 'on'), { keys: [publicKey] })), '');
});

test('the product licence, where anyone may enter a code: only one that runs longer than the code in force', () => {
  const file = path.join(dir, 'product-replay.json');
  const store = new ActivationStore({ file, keys: [publicKey] });
  const long = checkCode(script('product', keyFile, '2029-01-01'), { keys: [publicKey] });
  const short = checkCode(script('product', keyFile, '2027-07-01'), { keys: [publicKey] });
  const longer = checkCode(script('product', keyFile, '2030-01-01'), { keys: [publicKey] });
  store.record(long, 'deactivation page');
  assert.match(store.refusal(short, { mustExtend: true }), /already in force: this one does not run longer/);
  assert.match(store.refusal(long, { mustExtend: true }), /does not run longer/, 'the same code again is not needed either');
  assert.equal(store.refusal(longer, { mustExtend: true }), '');
  // An Admin, signed in, may enter a newer code that ends sooner (the maintainer shortened it on purpose).
  assert.equal(store.refusal(short), '');
  assert.equal(new ActivationStore({ file, keys: [publicKey] }).product(Date.parse('2028-06-01')).active, true, 'the long code is still the one in force');
});
