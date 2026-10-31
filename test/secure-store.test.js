import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as store from '../src/secure-store.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-secure-'));
const file = (name) => path.join(dir, name);
const KEY = randomBytes(32);

test.afterEach(() => store.clearDek());

test('passthrough with no key: JSON is written and read as plaintext', () => {
  store.clearDek();
  assert.equal(store.hasKey(), false);
  const f = file('plain.json');
  store.writeJsonAtomic(f, { a: 1, name: 'Globex' });
  assert.deepEqual(store.readJson(f), { a: 1, name: 'Globex' });
  const raw = fs.readFileSync(f, 'utf8');
  assert.equal(raw, '{"a":1,"name":"Globex"}'); // byte-for-byte plaintext, no magic
  assert.equal(store.isSealed(fs.readFileSync(f)), false);
});

test('with a key: JSON round-trips, on disk it is sealed and the plaintext is not present', () => {
  store.setDek(KEY);
  const f = file('enc.json');
  store.writeJsonAtomic(f, { secret: 'Acme Partners', n: 42 });
  const onDisk = fs.readFileSync(f);
  assert.equal(store.isSealed(onDisk), true);
  assert.ok(!onDisk.toString('latin1').includes('Acme Partners'));
  assert.throws(() => JSON.parse(onDisk.toString('utf8')));
  assert.deepEqual(store.readJson(f), { secret: 'Acme Partners', n: 42 });
});

test('the wrong key cannot decrypt', () => {
  store.setDek(KEY);
  const f = file('wrongkey.json');
  store.writeJsonAtomic(f, { x: 1 });
  store.setDek(randomBytes(32));
  assert.throws(() => store.readJson(f, undefined) ?? (() => { throw new Error('decrypt'); })());
  // readJson swallows to fallback on bad JSON, but decryption throws before JSON.parse:
  assert.throws(() => store.readBytes(f));
});

test('a record is bound to its file name (AAD): a blob moved to another name will not open', () => {
  store.setDek(KEY);
  const a = file('a.json');
  store.writeJsonAtomic(a, { v: 'x' });
  const b = file('b.json');
  fs.copyFileSync(a, b); // same bytes, different name
  assert.deepEqual(store.readJson(a), { v: 'x' });
  assert.throws(() => store.readBytes(b)); // AAD mismatch
});

test('tampering is detected (GCM)', () => {
  store.setDek(KEY);
  const f = file('tamper.json');
  store.writeJsonAtomic(f, { v: 'y' });
  const buf = fs.readFileSync(f);
  buf[buf.length - 1] ^= 0x01; // flip a tag byte
  fs.writeFileSync(f, buf);
  assert.throws(() => store.readBytes(f));
});

test('mixed folder: plaintext written with the key off is still readable with the key on', () => {
  store.clearDek();
  const f = file('legacy.json');
  store.writeJsonAtomic(f, { legacy: true });
  store.setDek(KEY);
  assert.deepEqual(store.readJson(f), { legacy: true }); // passthrough read of plaintext
});

test('a sealed file read with no key throws rather than returning garbage', () => {
  store.setDek(KEY);
  const f = file('needskey.json');
  store.writeJsonAtomic(f, { v: 1 });
  store.clearDek();
  assert.throws(() => store.readBytes(f));
});

test('append log: per-line records, O(1) append, decoded on read; mixes with pre-encryption plaintext lines', () => {
  const f = file('audit.jsonl');
  store.clearDek();
  store.appendLine(f, 'line-before-encryption');
  store.setDek(KEY);
  store.appendLine(f, 'event one');
  store.appendLine(f, 'event two');
  const onDisk = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  assert.equal(onDisk[0], 'line-before-encryption'); // old plaintext line untouched
  assert.ok(onDisk[1].startsWith('#MZL1:')); // new lines are sealed records
  assert.ok(!fs.readFileSync(f, 'utf8').includes('event one'));
  assert.deepEqual(store.readLines(f), ['line-before-encryption', 'event one', 'event two']);
});

test('text round-trips, sealed on disk with a key', () => {
  store.setDek(KEY);
  const f = file('note.txt');
  store.writeTextAtomic(f, 'top secret note');
  assert.equal(store.isSealed(fs.readFileSync(f)), true);
  assert.equal(store.readText(f), 'top secret note');
});

test('convertFile encrypts then decrypts a file, idempotently', () => {
  const f = file('convert.json');
  store.clearDek();
  store.writeJsonAtomic(f, { data: 'turn me on' });
  store.setDek(KEY);
  assert.equal(store.convertFile(f, { to: 'encrypted' }), 'encrypted');
  assert.equal(store.convertFile(f, { to: 'encrypted' }), 'unchanged'); // idempotent
  assert.equal(store.isSealed(fs.readFileSync(f)), true);
  assert.deepEqual(store.readJson(f), { data: 'turn me on' });
  assert.equal(store.convertFile(f, { to: 'plaintext' }), 'decrypted');
  assert.equal(store.convertFile(f, { to: 'plaintext' }), 'unchanged');
  assert.equal(fs.readFileSync(f, 'utf8'), '{"data":"turn me on"}');
  assert.equal(store.convertFile(file('nope.json'), { to: 'encrypted' }), 'absent');
});

test('readJson returns the fallback for a missing file', () => {
  store.setDek(KEY);
  assert.deepEqual(store.readJson(file('missing.json'), { default: true }), { default: true });
  assert.equal(store.readText(file('missing.txt'), null), null);
  assert.deepEqual(store.readLines(file('missing.jsonl')), []);
});
