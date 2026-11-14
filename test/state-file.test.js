// Reading and writing state files (src/state-file.js): a damaged file is never taken for an empty one,
// and a save keeps the file it replaces as the last good copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { StateFileError, appendDurable, clearHalfSaved, flushPendingNow, flushesSettled, readState, removeState, writeState } from '../src/state-file.js';

/** A folder of its own for one test, removed when the test ends. */
function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-file-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Run `fn` with console.error collected instead of printed; returns [result, lines]. */
function quietly(fn) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.join(' '));
  try {
    return [fn(), lines];
  } finally {
    console.error = original;
  }
}

const damagedCopies = (dir, name) => fs.readdirSync(dir).filter((f) => f.startsWith(`${name}.damaged-`));

test('no file and no last good copy: the fallback (a new installation)', (t) => {
  const file = path.join(folder(t), 'iam.json');
  assert.deepEqual(readState(file, { fallback: { users: [] } }), { users: [] });
  assert.equal(readState(file), null, 'null unless a fallback is given');
  assert.equal(fs.existsSync(file), false, 'reading makes no file');
});

test('a good file is read as what it holds', (t) => {
  const file = path.join(folder(t), 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ smtp: { host: 'mail.example' } }));
  assert.deepEqual(readState(file, { fallback: {} }), { smtp: { host: 'mail.example' } });
  // A byte-order mark an editor put in front is not damage.
  fs.writeFileSync(file, `\uFEFF${JSON.stringify([1, 2])}`);
  assert.deepEqual(readState(file, { fallback: {} }), [1, 2]);
});

test('a damaged file with a good last copy: the copy is used, the damaged file is kept, and it is said loudly', (t) => {
  const dir = folder(t);
  const file = path.join(dir, 'iam.json');
  writeState(file, { users: ['ada'] });
  writeState(file, { users: ['ada', 'grace'] });
  fs.writeFileSync(file, '{"users":["ada","gr'); // cut short

  const [value, lines] = quietly(() => readState(file, { fallback: {} }));
  assert.deepEqual(value, { users: ['ada'] }, 'the last good copy, not the fallback');
  const kept = damagedCopies(dir, 'iam.json');
  assert.equal(kept.length, 1, 'the damaged file is moved aside, not deleted');
  assert.match(kept[0], /^iam\.json\.damaged-\d{4}-\d{2}-\d{2}T[\d-]+Z$/, 'named with the time, without colons');
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), '{"users":["ada","gr');
  assert.equal(lines.length, 1, 'one line on the error log');
  assert.ok(lines[0].includes(file) && /last good copy/.test(lines[0]), lines[0]);

  // The next save puts a whole file back; the copy that saved the day stays until then.
  writeState(file, value);
  assert.deepEqual(readState(file, { fallback: {} }), { users: ['ada'] });
});

test('a damaged file without a last good copy: refused with what to do, and the file is left exactly as it is', (t) => {
  const dir = folder(t);
  const file = path.join(dir, 'triage-credits.json');
  fs.writeFileSync(file, '{"entries":[{"credits":3},');
  const before = fs.statSync(file);

  let error;
  try {
    readState(file, { fallback: { entries: [] }, holds: 'the credit ledger' });
  } catch (e) {
    error = e;
  }
  assert.ok(error instanceof StateFileError, 'never the fallback for a damaged file');
  assert.equal(error.code, 'STATE_FILE_DAMAGED');
  assert.equal(error.file, file);
  // The message is complete on its own: which file, what happens now, and both ways out.
  assert.ok(error.message.includes(file), error.message);
  assert.match(error.message, /the credit ledger/);
  assert.match(error.message, /will not start/);
  assert.match(error.message, /nothing is written over it/);
  assert.match(error.message, /scripts\/restore\.mjs/);
  assert.match(error.message, /move triage-credits\.json out of/);

  assert.equal(fs.readFileSync(file, 'utf8'), '{"entries":[{"credits":3},', 'untouched');
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  assert.deepEqual(fs.readdirSync(dir), ['triage-credits.json'], 'nothing moved aside, nothing made');
});

test('a zero-length file (a crash in the middle of a save) is damage, not an empty store', (t) => {
  const dir = folder(t);
  const file = path.join(dir, 'tracked-reports.json');
  fs.writeFileSync(file, '');
  assert.throws(() => readState(file, { fallback: { reports: [] } }), (error) => error instanceof StateFileError && /empty: zero bytes/.test(error.message));
  assert.equal(fs.statSync(file).size, 0, 'left as it is');

  // With a last good copy beside it, the copy is used.
  fs.writeFileSync(`${file}.bak`, JSON.stringify({ reports: [{ id: 'r1' }] }));
  const [value] = quietly(() => readState(file, { fallback: { reports: [] } }));
  assert.deepEqual(value, { reports: [{ id: 'r1' }] });
  assert.equal(damagedCopies(dir, 'tracked-reports.json').length, 1);
});

test('JSON that is not an object or a list (null, a number) is damage too', (t) => {
  const file = path.join(folder(t), 'settings.json');
  for (const text of ['null', '42', '"text"']) {
    fs.writeFileSync(file, text);
    assert.throws(() => readState(file, { fallback: {} }), { code: 'STATE_FILE_DAMAGED' }, text);
  }
});

test('a missing file with a last good copy beside it (a crash between the two renames of a save): the copy is used', (t) => {
  const dir = folder(t);
  const file = path.join(dir, 'tenants.json');
  fs.writeFileSync(`${file}.bak`, JSON.stringify({ enabled: true }));
  const [value, lines] = quietly(() => readState(file, { fallback: {} }));
  assert.deepEqual(value, { enabled: true }, 'not the fallback: this is no new installation');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /is missing/);
  // The copy becomes the file again (and stays), so a backup made before the next save still holds it.
  assert.deepEqual(fs.readdirSync(dir).sort(), ['tenants.json', 'tenants.json.bak']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { enabled: true });
  assert.equal(fs.statSync(file).mode & 0o777, fs.statSync(`${file}.bak`).mode & 0o777);
  const [again, quiet] = quietly(() => readState(file, { fallback: {} }));
  assert.deepEqual(again, { enabled: true });
  assert.deepEqual(quiet, [], 'read as any other file from then on');
});

test('a damaged file put right from its copy is whole again on the disk, with the damaged one kept aside', (t) => {
  const dir = folder(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{"smtp":');
  fs.writeFileSync(`${file}.bak`, JSON.stringify({ smtp: { host: 'mail.acme.io' } }), { mode: 0o600 });
  const [value] = quietly(() => readState(file, { fallback: {} }));
  assert.deepEqual(value, { smtp: { host: 'mail.acme.io' } });
  const names = fs.readdirSync(dir).sort();
  assert.equal(names.length, 3);
  assert.ok(names.some((name) => name.startsWith('settings.json.damaged-')));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { smtp: { host: 'mail.acme.io' } });
});

test('damaged, and the last good copy damaged too: refused, both left as they are, both named', (t) => {
  const dir = folder(t);
  const file = path.join(dir, 'iam.json');
  fs.writeFileSync(file, '{');
  fs.writeFileSync(`${file}.bak`, '');
  assert.throws(() => readState(file, { fallback: {} }), (error) => error instanceof StateFileError && /move iam\.json and iam\.json\.bak out of/.test(error.message));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['iam.json', 'iam.json.bak']);
  assert.equal(fs.readFileSync(file, 'utf8'), '{');
});

// Root reads a file whatever its mode, so this can only be shown as another user (as CI runs).
test('a file this server may not read is refused and left where it is, even with a last good copy beside it', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, (t) => {
  const dir = folder(t);
  const file = path.join(dir, 'iam.json');
  writeState(file, { users: ['ada'] });
  writeState(file, { users: ['ada', 'grace'] });
  fs.chmodSync(file, 0o000);
  // Not damage, and not for the server to put aside: whoever runs it puts the permissions right.
  assert.throws(() => readState(file, { fallback: {} }), (error) => error instanceof StateFileError && /cannot be read/.test(error.message));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['iam.json', 'iam.json.bak'], 'nothing moved aside');
  fs.chmodSync(file, 0o600);
  assert.deepEqual(readState(file, { fallback: {} }), { users: ['ada', 'grace'] });
});

test('a save keeps the version before it as the last good copy, and only that one', (t) => {
  const dir = folder(t);
  const file = path.join(dir, 'nested', 'settings.json');
  writeState(file, { n: 1 }, { space: 2 });
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({ n: 1 }, null, 2), 'the indentation asked for');
  assert.equal(fs.existsSync(`${file}.bak`), false, 'the first save has nothing to keep');

  writeState(file, { n: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { n: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), { n: 1 });

  writeState(file, { n: 3 });
  assert.deepEqual(JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8')), { n: 2 }, 'the copy before is replaced');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['settings.json', 'settings.json.bak'], 'no temporary file is left');
});

test('files are readable by the server\'s user alone (0600), the folder made for them 0700', { skip: process.platform === 'win32' }, (t) => {
  const dir = folder(t);
  const file = path.join(dir, 'made', 'iam.json');
  const umask = process.umask(0);
  t.after(() => process.umask(umask));
  writeState(file, { users: [] });
  writeState(file, { users: ['ada'] });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${file}.bak`).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  // Another mode when asked (a certificate anyone may read).
  const cert = path.join(dir, 'server.crt');
  writeState(cert, 'PEM', { mode: 0o644 });
  assert.equal(fs.statSync(cert).mode & 0o777, 0o644);
});

test('text and bytes are written as they are; a key file is checked by its own rule', (t) => {
  const dir = folder(t);
  const key = path.join(dir, 'audit.key');
  const bytes = Buffer.alloc(32, 7);
  writeState(key, bytes);
  assert.deepEqual(fs.readFileSync(key), bytes);
  const parse = (buffer) => {
    if (buffer.length < 32) throw new Error('too short for a key');
    return buffer;
  };
  assert.deepEqual(readState(key, { parse }), bytes);
  fs.writeFileSync(key, Buffer.alloc(5));
  assert.throws(() => readState(key, { parse }), (error) => error instanceof StateFileError && /too short for a key/.test(error.message));

  const text = path.join(dir, 'notes.txt');
  writeState(text, 'line one\n');
  assert.equal(fs.readFileSync(text, 'utf8'), 'line one\n');
});

test('keepLast: false leaves no copy, and removes one an earlier save left; removeState takes the copy with the file', (t) => {
  const dir = folder(t);
  const file = path.join(dir, 'server.key');
  writeState(file, 'one', { keepLast: false });
  writeState(file, 'two', { keepLast: false });
  assert.deepEqual(fs.readdirSync(dir), ['server.key']);
  // What must not linger: a save that keeps no copy takes away the one that is there.
  writeState(file, 'three');
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), 'two');
  writeState(file, 'four', { keepLast: false });
  assert.deepEqual(fs.readdirSync(dir), ['server.key']);
  assert.equal(fs.readFileSync(file, 'utf8'), 'four');

  const proxy = path.join(dir, 'network.json');
  writeState(proxy, { proxy: { url: 'http://a' } });
  writeState(proxy, { proxy: { url: 'http://b' } });
  removeState(proxy);
  // Left behind, the copy would be read as the file the next time.
  assert.equal(readState(proxy, { fallback: null }), null);
});

test('a save that cannot be made leaves the file as it was, and no temporary file behind', (t) => {
  const dir = folder(t);
  const file = path.join(dir, 'iam.json');
  writeState(file, { n: 1 });
  // Something in the way of the last good copy (a folder with a file in it) makes the save fail half-way.
  fs.mkdirSync(`${file}.bak`);
  fs.writeFileSync(path.join(`${file}.bak`, 'in-the-way'), '');
  assert.throws(() => writeState(file, { n: 2 }));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { n: 1 });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['iam.json', 'iam.json.bak']);
});

test('appendDurable adds to the end of a log, making it (0600) when it is not there', (t) => {
  const file = path.join(folder(t), 'log', 'events.jsonl');
  appendDurable(file, '{"n":1}\n');
  appendDurable(file, '{"n":2}\n');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"n":1}\n{"n":2}\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('files a crash left in the middle of a save are removed at the next start; nothing else is touched', (t) => {
  const dir = folder(t);
  const old = new Date(Date.now() - 3_600_000);
  const leave = (name, when) => {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"smtp":{"pass":"secret"}}');
    if (when) fs.utimesSync(file, when, when);
    return file;
  };
  const crashed = leave('settings.json.0123456789abcdef.tmp', old);
  const inTenant = leave('tenants/acme/iam.json.fedcba9876543210.tmp', old);
  const beingSaved = leave('iam.json.00112233445566ff.tmp'); // a script saving at this moment
  const state = leave('settings.json', old);
  const copy = leave('settings.json.bak', old);
  const someoneElses = leave('notes.tmp', old);
  const tooDeep = leave('git-cache/a/b/c/x.json.0123456789abcdef.tmp', old);
  assert.deepEqual(clearHalfSaved(dir).sort(), [crashed, inTenant].sort());
  for (const file of [beingSaved, state, copy, someoneElses, tooDeep]) assert.ok(fs.existsSync(file), `${path.relative(dir, file)} is left`);
  assert.deepEqual(clearHalfSaved(path.join(dir, 'not-there')), []);
});

test('a log written on the request path is in its file at once, and flushed in the background, grouped', async (t) => {
  const dir = folder(t);
  const log = path.join(dir, 'audit', 'audit-2026-11.jsonl');
  const flushes = [];
  const original = fs.fdatasync;
  fs.fdatasync = (fd, done) => {
    flushes.push(fd);
    return original(fd, done);
  };
  t.after(() => {
    fs.fdatasync = original;
  });
  for (let i = 0; i < 50; i += 1) appendDurable(log, `{"seq":${i}}\n`, { flush: 'soon' });
  // Before any flush has finished: every line is there for a reader, and for the server's next start.
  assert.equal(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length, 50);
  await flushesSettled();
  assert.ok(flushes.length >= 1 && flushes.length <= 2, `50 entries written together took ${flushes.length} flush(es), not 50`);
  // Nothing waiting any more: both return at once.
  await flushesSettled();
  flushPendingNow();
});

test('a server that stops flushes what is still waiting; a file removed meanwhile is not an error', async (t) => {
  const dir = folder(t);
  const [, lines] = await (async () => {
    const said = [];
    const original = console.error;
    console.error = (...args) => said.push(args.join(' '));
    try {
      appendDurable(path.join(dir, 'a.jsonl'), 'one\n', { flush: 'soon' });
      writeState(path.join(dir, 'settings.json'), { a: 1 });
      flushPendingNow();
      appendDurable(path.join(dir, 'gone.jsonl'), 'two\n', { flush: 'soon' });
      fs.rmSync(path.join(dir, 'gone.jsonl'));
      await flushesSettled();
      return [null, said];
    } finally {
      console.error = original;
    }
  })();
  assert.deepEqual(lines, []);
  assert.deepEqual(readState(path.join(dir, 'settings.json')), { a: 1 });
});
