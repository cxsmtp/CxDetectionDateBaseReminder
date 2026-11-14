// The server's own backup key (src/backup-key.js): a new installation encrypts its backups from
// the first one, an existing installation is left as it was until an Admin turns encryption on,
// BACKUP_PASSPHRASE wins, BACKUP_ENCRYPTION=off keeps backups plain, and a backup opens only with
// the key it was made with. The restore and backup scripts follow the same rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BackupKeyError, createBackup, isSealed, readBackup, restoreBackup } from '../src/backup.js';
import { BACKUP_KEY_FILE, BackupKeyStore, canonicalBackupKey, earlierState, generateBackupKey } from '../src/backup-key.js';
import { flushPendingNow } from '../src/state-file.js';
import { PASSPHRASE } from './test-credentials.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function folder(t, name = 'backup-key-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const put = (dir, name, text = '{}') => {
  fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
  fs.writeFileSync(path.join(dir, name), text);
};
const stored = (dir) => JSON.parse(fs.readFileSync(path.join(dir, BACKUP_KEY_FILE), 'utf8'));
/** A store as the server makes it at its start, with `env` for its environment. */
const open = (dir, env = {}) => new BackupKeyStore({ dataDir: dir, env });

function script(name, dataDir, args, env = {}) {
  const proc = spawn(process.execPath, [`scripts/${name}.mjs`, ...args], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, SETTINGS_FILE: '', BACKUP_PASSPHRASE: '', BACKUP_ENCRYPTION: '', BACKUP_DIR: '', INSTANCE_LOCK_STALE_SECONDS: '3', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (err += d));
  return new Promise((resolve) => proc.on('exit', (code) => resolve({ code, out, err })));
}

test('a backup key is groups of letters and digits that can be typed, and typing it loosely still gives the key', () => {
  const key = generateBackupKey();
  assert.match(key, /^([A-HJ-NP-Z2-9]{4}-){7}[A-HJ-NP-Z2-9]{4}$/, 'eight groups of four, without I, O, 0 or 1');
  assert.notEqual(generateBackupKey(), key);
  assert.equal(canonicalBackupKey(key), key);
  assert.equal(canonicalBackupKey(` ${key.toLowerCase().replace(/-/g, ' ')} `), key, 'lower case, spaces for dashes');
  assert.equal(canonicalBackupKey(key.replace(/-/g, '')), key, 'no dashes at all');
  assert.equal(canonicalBackupKey('a passphrase of my own'), '', 'a passphrase is not a backup key');
  assert.equal(canonicalBackupKey(key.slice(0, -1)), '');
  assert.equal(canonicalBackupKey(''), '');
});

test('a new installation: its first start makes a key, and every backup is encrypted with it', (t) => {
  const dir = folder(t);
  // What a first start finds: the server's own lock, and perhaps a certificate someone put there.
  put(dir, '.instance-lock', 'lock');
  put(dir, 'server.pem', 'certificate');
  fs.mkdirSync(path.join(dir, 'backups'));
  const store = open(dir);
  assert.equal(store.decided, false);
  const decision = store.decide();
  assert.deepEqual({ mode: decision.mode, decidedBy: decision.decidedBy, found: decision.found }, { mode: 'encrypted', decidedBy: 'new-installation', found: '' });
  assert.equal(store.source, 'key');
  assert.match(store.secret(), /^([A-HJ-NP-Z2-9]{4}-){7}[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(store.status().notice, 'save-key', 'Admins are told until someone confirms the key is saved');
  assert.equal(store.status().key, undefined, 'the status never carries the key');
  assert.ok(!JSON.stringify(store.status()).includes(store.secret()));

  // On disk: readable by the server's user alone, written whole, with no last good copy.
  const file = path.join(dir, BACKUP_KEY_FILE);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${file}.bak`), false);
  assert.equal(stored(dir).key, store.secret());

  // The backup is sealed in the format a passphrase gives: BACKUP_PASSPHRASE=<the key> opens it.
  put(dir, 'settings.json', JSON.stringify({ smtp: { host: 'mail.acme.io' } }));
  const { buffer, summary } = createBackup({ dataDir: dir, passphrase: store.secret() });
  assert.equal(summary.encrypted, true);
  assert.equal(isSealed(buffer), true);
  assert.equal(readBackup(buffer, { passphrase: store.secret() }).files['settings.json'].size > 0, true);

  // Decided once: the next start (state is there now) changes nothing, and keeps the same key.
  const again = open(dir);
  assert.equal(again.decide(), null);
  assert.equal(again.secret(), store.secret());
  flushPendingNow();
});

test('the key is never inside a backup, and a restore leaves it where it is', (t) => {
  const dir = folder(t);
  const store = open(dir);
  store.decide();
  put(dir, 'settings.json', JSON.stringify({ a: 1 }));
  const plain = createBackup({ dataDir: dir });
  const bundle = readBackup(plain.buffer);
  assert.deepEqual(Object.keys(bundle.files), ['settings.json']);
  assert.ok(!JSON.stringify(bundle).includes(store.secret()), 'not in the bundle');
  assert.ok(!Buffer.from(JSON.stringify(bundle)).toString('base64').includes(Buffer.from(store.secret()).toString('base64').slice(0, 20)));
  restoreBackup(bundle, { dataDir: dir });
  assert.equal(open(dir).secret(), store.secret(), 'the server keeps its key through a restore');
  flushPendingNow();
});

test('an existing installation is left as it was: anything from before means its backups stay plain', (t) => {
  const evidence = [
    ['settings.json', (dir) => put(dir, 'settings.json')],
    ['iam.json', (dir) => put(dir, 'iam.json')],
    ['audit.key', (dir) => put(dir, 'audit.key', 'k')],
    ['a last good copy', (dir) => put(dir, 'triage-credits.json.bak')],
    ['an audit month', (dir) => put(dir, 'audit/audit-2026-08.jsonl', '')],
    ['a further tenant', (dir) => put(dir, 'tenants/emea/settings.json')],
    ['a state file this version does not list', (dir) => put(dir, 'terms.json')],
    ['a file put aside as damaged', (dir) => put(dir, 'iam.json.damaged-2026-09-30T02-00-00-000Z')],
    ['a saved sign-in', (dir) => put(dir, 'sessions/index.json')],
    ['what a restore left', (dir) => put(dir, 'replaced-2026-09-30T02-00-00-000Z/settings.json')],
    ['a staged restore', (dir) => put(dir, 'restore-pending.mzbackup', 'x')],
    ['a plain backup in the backup folder', (dir) => put(dir, 'backups/mission-zero-2026-09-30T02-00-00.mzbackup', createBackup({ dataDir: dir }).buffer)],
  ];
  for (const [what, make] of evidence) {
    const dir = folder(t);
    make(dir);
    const store = open(dir);
    const decision = store.decide();
    assert.equal(decision.mode, 'plain', what);
    assert.equal(decision.decidedBy, 'existing-installation', what);
    assert.ok(decision.found, what);
    assert.equal(store.secret(), '', `${what}: backups stay plain`);
    assert.equal(store.reveal(), '', `${what}: no key is made behind the Admin's back`);
    assert.deepEqual({ notice: store.status().notice, canTurnOn: store.status().canTurnOn }, { notice: 'not-encrypted', canTurnOn: true }, what);
    assert.equal(stored(dir).key, undefined, what);
  }

  // Settings kept outside the folder (an older SETTINGS_FILE setup), and a backup folder on another disk.
  const elsewhere = folder(t);
  put(elsewhere, 'conf/settings.json');
  assert.equal(earlierState({ dataDir: folder(t), settingsFile: path.join(elsewhere, 'conf', 'settings.json') }), 'settings.json');
  put(elsewhere, 'share/mission-zero-2026-01-01T00-00-00.mzbackup', createBackup({ dataDir: folder(t) }).buffer);
  assert.match(earlierState({ dataDir: folder(t), backupDir: path.join(elsewhere, 'share') }), /a backup that is not encrypted/);

  // Only encrypted backups in the backup folder are no sign of plain backups: that is a new installation.
  const sealedOnly = folder(t);
  put(sealedOnly, 'backups/mission-zero-2026-09-30T02-00-00.mzbackup', createBackup({ dataDir: folder(t), passphrase: PASSPHRASE }).buffer);
  assert.equal(earlierState({ dataDir: sealedOnly }), '');
  // The decision, once written, holds whatever is found later (the folder is no longer "new" after the first start).
  const fresh = folder(t);
  open(fresh).decide();
  put(fresh, 'settings.json');
  assert.equal(open(fresh).decide(), null);
  assert.equal(open(fresh).source, 'key');
  flushPendingNow();
});

test('an Admin turns encryption on: the key is made then, shown, and confirmed as saved', (t) => {
  const dir = folder(t);
  put(dir, 'settings.json');
  const store = open(dir);
  store.decide();
  assert.equal(store.confirmSaved({ by: 'admin@acme.io' }), false, 'nothing to confirm before there is a key');

  assert.equal(store.turnOn({ by: 'admin@acme.io', now: new Date('2026-11-14T10:00:00Z') }), true);
  const key = store.reveal();
  assert.equal(canonicalBackupKey(key), key);
  assert.deepEqual({ source: store.source, notice: store.status().notice, keySaved: store.status().keySaved }, { source: 'key', notice: 'save-key', keySaved: false });
  assert.equal(store.turnOn({ by: 'admin@acme.io' }), false, 'turning it on twice keeps the key');
  assert.equal(store.reveal(), key);

  assert.equal(store.confirmSaved({ by: 'admin@acme.io', now: new Date('2026-11-14T10:05:00Z') }), true);
  assert.deepEqual(
    (({ notice, keySaved, keySavedAt, keySavedBy }) => ({ notice, keySaved, keySavedAt, keySavedBy }))(open(dir).status()),
    { notice: null, keySaved: true, keySavedAt: '2026-11-14T10:05:00.000Z', keySavedBy: 'admin@acme.io' },
    'kept across a restart',
  );
  assert.deepEqual((({ mode, decidedBy, turnedOnBy }) => ({ mode, decidedBy, turnedOnBy }))(stored(dir)), { mode: 'encrypted', decidedBy: 'existing-installation', turnedOnBy: 'admin@acme.io' });
  flushPendingNow();
});

test('BACKUP_PASSPHRASE wins, on a new installation and on an existing one', (t) => {
  const fresh = folder(t);
  const store = open(fresh, { BACKUP_PASSPHRASE: PASSPHRASE });
  store.decide();
  assert.equal(store.source, 'passphrase');
  assert.equal(store.secret(), PASSPHRASE);
  assert.equal(store.status().notice, null, 'nothing to save: the passphrase is the Admin\'s own');
  assert.equal(store.status().canTurnOn, false);
  assert.deepEqual(store.candidates(), [PASSPHRASE, store.reveal()], 'a restore tries the passphrase first, then the key');
  // Taken away later, the installation that was new goes on encrypted, with its own key.
  assert.equal(open(fresh).source, 'key');

  const existing = folder(t);
  put(existing, 'settings.json');
  const old = open(existing, { BACKUP_PASSPHRASE: PASSPHRASE });
  old.decide();
  assert.deepEqual({ source: old.source, secret: old.secret(), notice: old.status().notice }, { source: 'passphrase', secret: PASSPHRASE, notice: null });
  // And an existing one without it is what it always was: plain, now with a notice.
  assert.deepEqual({ source: open(existing).source, notice: open(existing).status().notice }, { source: 'none', notice: 'not-encrypted' });
  flushPendingNow();
});

test('BACKUP_ENCRYPTION=off keeps backups plain on purpose, and a passphrase still wins', (t) => {
  for (const value of ['off', 'OFF', '0', 'false', 'no']) {
    const dir = folder(t);
    const store = open(dir, { BACKUP_ENCRYPTION: value });
    assert.deepEqual((({ mode, decidedBy }) => ({ mode, decidedBy }))(store.decide()), { mode: 'plain', decidedBy: 'opt-out' }, value);
    assert.deepEqual({ secret: store.secret(), notice: store.status().notice, canTurnOn: store.status().canTurnOn, optedOut: store.status().optedOut }, { secret: '', notice: null, canTurnOn: false, optedOut: true }, value);
    assert.equal(store.reveal(), '', 'no key is made');
  }
  // An installation that encrypts, with the opt-out set later: plain while it is set, encrypted again without it.
  const dir = folder(t);
  open(dir).decide();
  assert.equal(open(dir, { BACKUP_ENCRYPTION: 'off' }).secret(), '');
  assert.equal(open(dir, { BACKUP_ENCRYPTION: 'off' }).source, 'none');
  assert.equal(open(dir).source, 'key');
  assert.equal(open(dir, { BACKUP_ENCRYPTION: 'on' }).source, 'key', 'only "off" opts out');
  assert.equal(open(dir, { BACKUP_ENCRYPTION: 'off', BACKUP_PASSPHRASE: PASSPHRASE }).secret(), PASSPHRASE);
  // Started with the opt-out and later without: nothing changes behind the Admin's back.
  const opted = folder(t);
  open(opted, { BACKUP_ENCRYPTION: 'off' }).decide();
  assert.deepEqual({ source: open(opted).source, notice: open(opted).status().notice, canTurnOn: open(opted).status().canTurnOn }, { source: 'none', notice: 'not-encrypted', canTurnOn: true });
  flushPendingNow();
});

test('a backup opens with its key, typed loosely too; not with a wrong one, and not without one', (t) => {
  const dir = folder(t);
  put(dir, 'settings.json', JSON.stringify({ smtp: { host: 'mail.acme.io' } }));
  const key = generateBackupKey();
  const { buffer } = createBackup({ dataDir: dir, passphrase: key });
  assert.ok(!buffer.includes(Buffer.from('mail.acme.io')));

  assert.ok(readBackup(buffer, { passphrase: key }).files['settings.json']);
  assert.ok(readBackup(buffer, { passphrase: key.toLowerCase().replace(/-/g, ' ') }).files['settings.json'], 'as someone types it');
  assert.ok(readBackup(buffer, { passphrases: ['not this one', key] }).files['settings.json'], 'the first that fits');

  const none = (() => { try { readBackup(buffer); } catch (error) { return error; } })();
  assert.ok(none instanceof BackupKeyError);
  assert.equal(none.code, 'BACKUP_KEY_NEEDED');
  assert.match(none.message, /is encrypted, and no backup key or passphrase was given/);
  const wrong = (() => { try { readBackup(buffer, { passphrase: generateBackupKey() }); } catch (error) { return error; } })();
  assert.ok(wrong instanceof BackupKeyError);
  assert.equal(wrong.code, 'BACKUP_KEY_WRONG');
  assert.match(wrong.message, /wrong backup key or passphrase, or the backup is damaged/);
  assert.ok(!wrong.message.includes(key));

  // Backups made before this: a plain one and one sealed with a passphrase open as they always did.
  assert.ok(readBackup(createBackup({ dataDir: dir }).buffer).files['settings.json']);
  assert.ok(readBackup(createBackup({ dataDir: dir, passphrase: PASSPHRASE }).buffer, { passphrase: PASSPHRASE }).files['settings.json']);
  // A sealed file whose header is cut short is refused as damaged, not with a stack trace.
  assert.throws(() => readBackup(buffer.subarray(0, 20)), /Not a CxMissionZero backup/);
});

test('the scripts: a backup is encrypted with the server\'s key; the restore says when a key is needed or wrong, and a rebuilt server keeps the key', async (t) => {
  // The server that made the backup: a new installation with one setting.
  const source = folder(t);
  const store = open(source);
  store.decide();
  const key = store.secret();
  put(source, 'settings.json', JSON.stringify({ from: 'the backup' }));
  const out = folder(t);
  const made = await script('backup', source, [`${out}/`]);
  assert.equal(made.code, 0, made.err);
  assert.match(made.out, /encrypted with the server's backup key/);
  assert.match(made.out, /Nobody has confirmed saving the backup key yet/);
  assert.ok(!(made.out + made.err).includes(key), 'the key is never printed');
  const [name] = fs.readdirSync(out);
  const backup = path.join(out, name);
  assert.equal(isSealed(fs.readFileSync(backup)), true);

  // Without the key: refused, in plain words, and nothing is written.
  const rebuilt = folder(t);
  const without = await script('restore', rebuilt, [backup, '--yes']);
  assert.equal(without.code, 1);
  assert.match(without.err, /this backup is encrypted, and no backup key or passphrase was given/);
  assert.match(without.err, /BACKUP_PASSPHRASE=<the key> npm run restore/);
  assert.match(without.err, /Nothing was written/);
  assert.deepEqual(fs.readdirSync(rebuilt), []);

  // With the wrong key: refused, saying so.
  const wrongKey = generateBackupKey();
  const wrong = await script('restore', rebuilt, [backup, '--yes'], { BACKUP_PASSPHRASE: wrongKey });
  assert.equal(wrong.code, 1);
  assert.match(wrong.err, /did not open with the BACKUP_PASSPHRASE given\. The key or passphrase is wrong, or the backup is damaged/);
  assert.ok(!(wrong.out + wrong.err).includes(wrongKey), 'what was typed is not echoed');
  assert.deepEqual(fs.readdirSync(rebuilt), []);

  // With the key: looking writes nothing; --yes restores, and the rebuilt server keeps the same key, already saved.
  const look = await script('restore', rebuilt, [backup], { BACKUP_PASSPHRASE: key });
  assert.equal(look.code, 0, look.err);
  assert.match(look.out, /Nothing written/);
  assert.deepEqual(fs.readdirSync(rebuilt), []);
  const done = await script('restore', rebuilt, [backup, '--yes'], { BACKUP_PASSPHRASE: key.toLowerCase() });
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /goes on encrypting its backups with the same backup key/);
  assert.ok(!(done.out + done.err).includes(key));
  assert.equal(JSON.parse(fs.readFileSync(path.join(rebuilt, 'settings.json'), 'utf8')).from, 'the backup');
  const kept = open(rebuilt);
  assert.equal(kept.decide(), null, 'the rebuilt server finds the decision made');
  assert.deepEqual({ secret: kept.secret(), notice: kept.status().notice }, { secret: key, notice: null });

  // The same server restoring a backup of its own needs nothing typed: its folder holds the key.
  put(source, 'settings.json', JSON.stringify({ from: 'later' }));
  const own = await script('restore', source, [backup, '--yes']);
  assert.equal(own.code, 0, own.err);
  assert.equal(JSON.parse(fs.readFileSync(path.join(source, 'settings.json'), 'utf8')).from, 'the backup');
  assert.equal(open(source).secret(), key);

  // A backup sealed with a passphrase of the Admin's own: restored, and the passphrase is never written down.
  const sealed = path.join(out, 'passphrase.mzbackup');
  fs.writeFileSync(sealed, createBackup({ dataDir: source, passphrase: PASSPHRASE }).buffer);
  const other = folder(t);
  const withPassphrase = await script('restore', other, [sealed, '--yes'], { BACKUP_PASSPHRASE: PASSPHRASE });
  assert.equal(withPassphrase.code, 0, withPassphrase.err);
  assert.match(withPassphrase.out, /start the server with the same BACKUP_PASSPHRASE/);
  assert.equal(fs.existsSync(path.join(other, BACKUP_KEY_FILE)), false);

  // An existing installation (plain), and the opt-out: the backup script leaves them plain and says so.
  const plainDir = folder(t);
  put(plainDir, 'settings.json');
  const plain = await script('backup', plainDir, [`${folder(t)}/`]);
  assert.match(plain.out, /Not encrypted/);
  assert.equal(fs.existsSync(path.join(plainDir, BACKUP_KEY_FILE)), false, 'the script decides nothing: that is the server\'s');
  const optOut = folder(t);
  const opted = await script('backup', source, [`${optOut}/`], { BACKUP_ENCRYPTION: 'off' });
  assert.match(opted.out, /Not encrypted/);
  assert.equal(isSealed(fs.readFileSync(path.join(optOut, fs.readdirSync(optOut)[0]))), false);
  // BACKUP_PASSPHRASE wins over the server's key.
  const byPassphrase = folder(t);
  const passed = await script('backup', source, [`${byPassphrase}/`], { BACKUP_PASSPHRASE: PASSPHRASE });
  assert.match(passed.out, /encrypted with BACKUP_PASSPHRASE/);
  const file = fs.readFileSync(path.join(byPassphrase, fs.readdirSync(byPassphrase)[0]));
  assert.ok(readBackup(file, { passphrase: PASSPHRASE }));
  assert.throws(() => readBackup(file, { passphrase: key }), BackupKeyError);
});
