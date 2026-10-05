// Activation codes: only codes signed by a trusted key, well formed and not expired are valid.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

import { ISSUER_KEYS, checkCode, readCode } from '../src/activation.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-'));
const keyFile = path.join(dir, 'issuer.pem');
const script = (...args) => execFileSync(process.execPath, ['scripts/activation.mjs', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const publicKey = script('keygen', keyFile).split('\n').pop();
const issue = (org, max, months) => script('issue', keyFile, org, String(max), ...(months ? [String(months)] : []));

test('no issuer key is built in until the maintainer adds theirs', () => {
  assert.deepEqual(ISSUER_KEYS, []);
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
