// The product licence (src/activation.js): CxMissionZero works until the end of 31 March 2027 (UTC), or a
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
const store = () => new ActivationStore({ file: path.join(fs.mkdtempSync(path.join(dir, 's-')), 'activation.json'), keys: [publicKey] });

test('it works until the end of 31 March 2027 (UTC), with a warning for Admins in the last 30 days', () => {
  assert.equal(PRODUCT_DEADLINE, '2027-04-01T00:00:00.000Z');
  assert.equal(DEACTIVATED_MESSAGE, 'The product has been deactivated. Please reach out to Bhawani Singh.');
  const s = store();
  assert.deepEqual((({ active, warn }) => [active, warn])(s.product(at('2026-10-21T12:00:00Z'))), [true, false]);
  assert.deepEqual((({ active, warn }) => [active, warn])(s.product(at('2027-01-15T00:00:00Z'))), [true, false], 'January 2027: still working, no warning yet');
  const march = s.product(at('2027-03-15T00:00:00Z'));
  assert.deepEqual([march.active, march.warn, march.daysLeft], [true, true, 17]);
  assert.equal(s.product(at('2027-03-31T23:59:59Z')).active, true, 'all of 31 March');
  const after = s.product(at('2027-04-01T00:00:00Z'));
  assert.deepEqual([after.active, after.warn, after.message], [false, false, DEACTIVATED_MESSAGE]);
});

test('its clock never goes back: a server clock set back after the end does not bring it back, even after a restart', () => {
  const file = path.join(fs.mkdtempSync(path.join(dir, 'c-')), 'activation.json');
  const s = new ActivationStore({ file });
  assert.equal(s.product(at('2027-04-03T00:00:00Z')).active, false);
  assert.equal(s.product(at('2026-11-01T00:00:00Z')).active, false, 'set back to November: still deactivated');
  assert.equal(new ActivationStore({ file }).product(at('2026-11-01T00:00:00Z')).active, false, 'kept on disk');
});

test('a product code moves the end to its date; the script issues one to the end of a day, UTC', () => {
  const code = script('product', keyFile, '2027-06-30');
  const r = checkCode(code, { keys: [publicKey] });
  assert.deepEqual([r.valid, r.scope, r.action, r.org, r.expires], [true, 'product', 'activate', 'Everyone', '2027-07-01T00:00:00.000Z']);
  const s = store();
  s.record(r, 'test');
  assert.equal(s.product(at('2027-05-01T00:00:00Z')).active, true, 'past the built-in end: the code carries it');
  assert.deepEqual(s.product(at('2027-05-01T00:00:00Z')).activation.org, 'Everyone', 'one key for everyone');
  assert.equal(s.product(at('2027-07-01T00:00:00Z')).active, false, 'and stops at its end');
  // A product code that would end before the built-in date does not shorten it.
  const early = store();
  early.record(checkCode(script('product', keyFile, '2027-02-28'), { keys: [publicKey], now: at('2026-11-14T00:00:00Z') }), 'test');
  assert.equal(early.product(at('2027-03-20T00:00:00Z')).active, true);
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

test('the kept code is what counts: a date edited in activation.json, or an entry without its code, changes nothing', () => {
  const file = path.join(fs.mkdtempSync(path.join(dir, 't-')), 'activation.json');
  const first = new ActivationStore({ file, keys: [publicKey] });
  first.record(checkCode(script('product', keyFile, '2027-06-30'), { keys: [publicKey] }), 'test');
  assert.equal(new ActivationStore({ file, keys: [publicKey] }).product(at('2027-06-01T00:00:00Z')).active, true, 'kept across a restart');
  // The date pushed out by hand: the signed code still says 30 June.
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(raw.product.code.startsWith('MZ1.'), 'the signed code is kept with the entry');
  raw.product.expires = '2099-01-01T00:00:00.000Z';
  fs.writeFileSync(file, JSON.stringify(raw));
  const edited = new ActivationStore({ file, keys: [publicKey] }).product(at('2027-08-01T00:00:00Z'));
  assert.deepEqual([edited.active, edited.until], [false, '2027-07-01T00:00:00.000Z']);
  // The code taken off the entry (as a version before MZ-01.01.10 kept it), or swapped for something else: only the built-in date is left.
  for (const product of [{ ...raw.product, code: undefined }, { ...raw.product, code: 'MZ1.e30.AAAA' }, { ...raw.product, code: script('feature', keyFile, 'Acme', 'impact', 'on') }]) {
    // (seenAt cleared: the licence's own clock, kept in the same file, would otherwise hold these checks at a later date.)
    fs.writeFileSync(file, JSON.stringify({ ...raw, seenAt: '', product }));
    const s = new ActivationStore({ file, keys: [publicKey] });
    assert.equal(s.product(at('2027-03-31T00:00:00Z')).active, true, 'the built-in date still applies');
    assert.deepEqual([s.product(at('2027-05-01T00:00:00Z')).active, s.product(at('2027-05-01T00:00:00Z')).activation], [false, null]);
  }
  // A code signed by another key counts for nothing either.
  fs.writeFileSync(file, JSON.stringify({ ...raw, seenAt: '', expires: undefined }));
  assert.equal(new ActivationStore({ file, keys: [] }).product(at('2027-05-01T00:00:00Z')).active, false);
  // A feature entry kept by an earlier version (no code) stays as it was; one whose code was edited does not.
  fs.writeFileSync(file, JSON.stringify({ features: { impact: { org: 'Acme', scope: 'feature:impact', action: 'activate', expires: '2028-01-01T00:00:00.000Z' }, govern: { org: 'Acme', scope: 'feature:govern', action: 'activate', expires: '2028-01-01T00:00:00.000Z', code: 'MZ1.e30.AAAA' } } }));
  const kept = new ActivationStore({ file, keys: [publicKey] });
  assert.equal(kept.feature('impact', at('2027-06-01T00:00:00Z')).on, true);
  assert.equal(kept.feature('govern', at('2027-06-01T00:00:00Z')), null);
});
