// The product licence (src/activation.js): CxMissionZero works until the end of 31 December 2026 (UTC), or a
// product code's date if later; its clock never goes back; and the standalone calculator checks the same codes
// in the browser (src/licence-gate.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { webcrypto } from 'node:crypto';

import { ActivationStore, DEACTIVATED_MESSAGE, ISSUER_KEYS, PRODUCT_DEADLINE, checkCode } from '../src/activation.js';
import { licenceGateScript, productCodeUntil } from '../src/licence-gate.js';
import { buildStandaloneCalculator } from '../src/standalone-calculator.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'licence-'));
const keyFile = path.join(dir, 'issuer.pem');
const script = (...args) => execFileSync(process.execPath, ['scripts/activation.mjs', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const publicKey = script('keygen', keyFile).split('\n').pop();
const at = (iso) => Date.parse(iso);
const store = () => new ActivationStore({ file: path.join(fs.mkdtempSync(path.join(dir, 's-')), 'activation.json') });

test('it works until the end of 31 December 2026 (UTC), with a warning for Admins in the last 30 days', () => {
  assert.equal(PRODUCT_DEADLINE, '2027-01-01T00:00:00.000Z');
  assert.equal(DEACTIVATED_MESSAGE, 'The product has been deactivated. Please reach out to Bhawani Singh.');
  const s = store();
  assert.deepEqual((({ active, warn }) => [active, warn])(s.product(at('2026-10-21T12:00:00Z'))), [true, false]);
  const december = s.product(at('2026-12-15T00:00:00Z'));
  assert.deepEqual([december.active, december.warn, december.daysLeft], [true, true, 17]);
  assert.equal(s.product(at('2026-12-31T23:59:59Z')).active, true, 'all of 31 December');
  const after = s.product(at('2027-01-01T00:00:00Z'));
  assert.deepEqual([after.active, after.warn, after.message], [false, false, DEACTIVATED_MESSAGE]);
});

test('its clock never goes back: a server clock set back after the end does not bring it back, even after a restart', () => {
  const file = path.join(fs.mkdtempSync(path.join(dir, 'c-')), 'activation.json');
  const s = new ActivationStore({ file });
  assert.equal(s.product(at('2027-01-03T00:00:00Z')).active, false);
  assert.equal(s.product(at('2026-11-01T00:00:00Z')).active, false, 'set back to November: still deactivated');
  assert.equal(new ActivationStore({ file }).product(at('2026-11-01T00:00:00Z')).active, false, 'kept on disk');
});

test('a product code moves the end to its date; the script issues one to the end of a day, UTC', () => {
  const code = script('product', keyFile, '2027-06-30');
  const r = checkCode(code, { keys: [publicKey] });
  assert.deepEqual([r.valid, r.scope, r.action, r.org, r.expires], [true, 'product', 'activate', 'Everyone', '2027-07-01T00:00:00.000Z']);
  const s = store();
  s.record(r, 'test');
  assert.equal(s.product(at('2027-03-01T00:00:00Z')).active, true);
  assert.deepEqual(s.product(at('2027-03-01T00:00:00Z')).activation.org, 'Everyone', 'one key for everyone');
  assert.equal(s.product(at('2027-07-01T00:00:00Z')).active, false, 'and stops at its end');
  // A product code that would end before the built-in date does not shorten it.
  const early = store();
  early.record({ ...r, expires: '2026-11-30T00:00:00.000Z' }, 'test');
  assert.equal(early.product(at('2026-12-20T00:00:00Z')).active, true);
  // Only "activate": a product code cannot be made to switch it off.
  assert.equal(checkCode(code.replace(/^MZ1\.[^.]+/, (head) => `MZ1.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(head.slice(4), 'base64url')), action: 'deactivate' })).toString('base64url')}`), { keys: [publicKey] }).valid, false);
  // A months count works too.
  assert.equal(checkCode(script('product', keyFile, '3'), { keys: [publicKey] }).valid, true);
});

test('the browser check (standalone calculator) accepts the same product codes, and nothing else', async () => {
  const code = script('product', keyFile, '2027-06-30');
  assert.equal(await productCodeUntil(code, [publicKey], webcrypto.subtle), at('2027-07-01T00:00:00Z'));
  assert.equal(await productCodeUntil(code, ISSUER_KEYS, webcrypto.subtle), 0, 'another key');
  assert.equal(await productCodeUntil(script('lang', keyFile, 'Acme Bank', 'he', 'on'), [publicKey], webcrypto.subtle), 0, 'not a product code');
  const [head, payload, sig] = code.split('.');
  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), expires: '2099-01-01T00:00:00.000Z' })).toString('base64url');
  assert.equal(await productCodeUntil(`${head}.${changed}.${sig}`, [publicKey], webcrypto.subtle), 0, 'a date changed by hand');
  assert.equal(await productCodeUntil('garbage', [publicKey], webcrypto.subtle), 0);
});

test('the standalone calculator carries the gate before it starts, with the maintainer’s key and the same end', () => {
  const gate = licenceGateScript();
  assert.ok(gate.includes(JSON.stringify(at(PRODUCT_DEADLINE))) && gate.includes(ISSUER_KEYS[0]) && gate.includes('Bhawani Singh'));
  assert.doesNotThrow(() => new Function(gate), 'valid script');
  const html = buildStandaloneCalculator({ version: '1.0.93' });
  assert.ok(html.indexOf('window.__mzBlocked = true') < html.indexOf('<script type="module">'), 'decided before the calculator runs');
  assert.match(html, /if \(!window\.__mzBlocked\) window\.__mzStart\(\);/);
});
