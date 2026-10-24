import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { AuditLog } from '../src/audit-log.js';
import { PENDING_RESTORE, applyPendingRestore, createBackup, describeBackup, listBackups, readBackup, restoreBackup, writeBackupTo } from '../src/backup.js';
import { insideProject, migrateLegacyData, resolveDataDir, statePaths } from '../src/data-dir.js';
import { PASSPHRASE } from './test-credentials.js';

const tmpDir = (p = 'mz-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

async function seed(dir) {
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ smtp: { host: 'mail.acme.io' } }));
  fs.writeFileSync(path.join(dir, 'triage-credits.json'), JSON.stringify({ entries: [{ projectId: 'p1', credits: 3 }] }));
  fs.writeFileSync(path.join(dir, 'credit-allocations.json'), JSON.stringify({ projects: { p1: { triage: 10 } } }));
  fs.writeFileSync(path.join(dir, 'report-signing.key'), 'k'.repeat(64));
  const log = new AuditLog({ dir: path.join(dir, 'audit'), keyFile: path.join(dir, 'audit.key') });
  log.record({ type: 'triage', outcome: 'charged', credits: { kind: 'triage', requested: 3, charged: 3 } }, new Date('2026-08-10T10:00:00Z'));
  log.record({ type: 'triage', outcome: 'charged', credits: { kind: 'triage', requested: 1, charged: 1 } }, new Date('2026-09-10T10:00:00Z'));
  await log.settled();
  fs.mkdirSync(path.join(dir, 'git-cache', 'x'), { recursive: true }); // a cache: never backed up
  fs.writeFileSync(path.join(dir, 'git-cache', 'x', 'HEAD'), 'ref');
}

test('the state folder is outside the project by default, and DATA_DIR / SETTINGS_FILE are honoured', () => {
  assert.deepEqual(resolveDataDir({}, { cwd: '/srv/app', home: '/home/svc' }), { dir: '/home/svc/.mission-zero', source: 'default' });
  assert.deepEqual(resolveDataDir({ DATA_DIR: '/var/lib/mz' }, { cwd: '/srv/app', home: '/h' }), { dir: '/var/lib/mz', source: 'DATA_DIR' });
  assert.equal(resolveDataDir({ SETTINGS_FILE: 'conf/s.json' }, { cwd: '/srv/app', home: '/h' }).dir, '/srv/app/conf');
  assert.equal(insideProject('/srv/app/data', '/srv/app'), true);
  assert.equal(insideProject('/var/lib/mz', '/srv/app'), false);
  assert.equal(insideProject('/srv/app-data', '/srv/app'), false);
  assert.equal(statePaths('/d', '/etc/mz/settings.json')['settings.json'], '/etc/mz/settings.json');
});

test('an upgrade copies the old in-project data folder once, and leaves the old copy', async () => {
  const legacy = tmpDir();
  await seed(legacy);
  const target = path.join(tmpDir(), 'state');
  const copied = migrateLegacyData(target, { legacyDir: legacy });
  assert.ok(copied.includes('settings.json') && copied.includes('audit/') && copied.includes('audit.key'));
  assert.ok(fs.existsSync(path.join(legacy, 'settings.json')));
  assert.equal(new AuditLog({ dir: path.join(target, 'audit'), keyFile: path.join(target, 'audit.key') }).verify().ok, true);
  assert.deepEqual(migrateLegacyData(target, { legacyDir: legacy }), [], 'never twice');
});

test('a backup restores every file into an empty server, and the audit chain still verifies', async () => {
  const source = tmpDir();
  await seed(source);
  const { buffer, summary } = createBackup({ dataDir: source });
  assert.equal(summary.encrypted, false);
  const info = describeBackup(readBackup(buffer));
  assert.deepEqual(info.auditMonths, ['2026-08', '2026-09']);
  assert.ok(info.hasSettings && info.hasLedger && info.hasAllocations && info.hasAuditKey);

  const fresh = path.join(tmpDir(), 'new-server');
  const { restored, replacedDir } = restoreBackup(readBackup(buffer), { dataDir: fresh });
  assert.equal(replacedDir, null);
  assert.equal(restored.length, summary.files);
  assert.ok(!fs.existsSync(path.join(fresh, 'git-cache')));
  for (const name of ['settings.json', 'triage-credits.json', 'credit-allocations.json', 'report-signing.key', 'audit.key']) {
    assert.deepEqual(fs.readFileSync(path.join(fresh, name)), fs.readFileSync(path.join(source, name)), name);
  }
  const log = new AuditLog({ dir: path.join(fresh, 'audit'), keyFile: path.join(fresh, 'audit.key') });
  assert.equal(log.record({ type: 'backup', outcome: 'info' }).seq, 3, 'the chain carries on');
  await log.settled();
  assert.equal(log.verify().ok, true);
});

test('restoring over existing state moves it aside instead of deleting it', async () => {
  const source = tmpDir();
  await seed(source);
  const { buffer } = createBackup({ dataDir: source });
  const target = tmpDir();
  fs.writeFileSync(path.join(target, 'settings.json'), '{"newer":true}');
  fs.mkdirSync(path.join(target, 'audit'));
  fs.writeFileSync(path.join(target, 'audit', 'audit-2026-10.jsonl'), '{}\n');
  const { replacedDir } = restoreBackup(readBackup(buffer), { dataDir: target });
  assert.equal(fs.readFileSync(path.join(replacedDir, 'settings.json'), 'utf8'), '{"newer":true}');
  assert.ok(fs.existsSync(path.join(replacedDir, 'audit', 'audit-2026-10.jsonl')));
  assert.ok(!fs.existsSync(path.join(target, 'audit', 'audit-2026-10.jsonl')), 'only the backup\'s months remain');
});

test('encrypted backups need the passphrase; damaged or foreign files are refused', async () => {
  const source = tmpDir();
  await seed(source);
  const { buffer } = createBackup({ dataDir: source, passphrase: PASSPHRASE });
  assert.ok(!buffer.includes(Buffer.from('mail.acme.io')));
  assert.throws(() => readBackup(buffer), /encrypted/);
  assert.throws(() => readBackup(buffer, { passphrase: 'wrong' }), /Wrong passphrase/);
  assert.equal(describeBackup(readBackup(buffer, { passphrase: PASSPHRASE })).hasSettings, true);

  assert.throws(() => readBackup(Buffer.from('hello')), /Not a CxMissionZero backup/);
  const plain = JSON.parse(zlib.gunzipSync(createBackup({ dataDir: source }).buffer));
  plain.files['settings.json'].data = Buffer.from('{"tampered":1}').toString('base64');
  assert.throws(() => readBackup(zlib.gzipSync(JSON.stringify(plain))), /damaged/);
  const escape = JSON.parse(zlib.gunzipSync(createBackup({ dataDir: source }).buffer));
  escape.files['../../etc/passwd'] = escape.files['settings.json'];
  assert.throws(() => readBackup(zlib.gzipSync(JSON.stringify(escape))), /unexpected file name/);
});

test('scheduled backups keep only the newest N', async () => {
  const source = tmpDir();
  await seed(source);
  const folder = path.join(tmpDir(), 'backups');
  for (let day = 1; day <= 5; day += 1) writeBackupTo(folder, { dataDir: source, keep: 3, now: new Date(`2026-09-0${day}T02:00:00Z`) });
  const kept = listBackups(folder).map((b) => b.name);
  assert.equal(kept.length, 3);
  assert.match(kept[0], /2026-09-05/);
});

test('a restore staged from the web page is applied at the next start', async () => {
  const source = tmpDir();
  await seed(source);
  const bundle = readBackup(createBackup({ dataDir: source }).buffer);
  const target = tmpDir();
  fs.writeFileSync(path.join(target, PENDING_RESTORE), zlib.gzipSync(JSON.stringify(bundle)));
  const applied = applyPendingRestore({ dataDir: target });
  assert.equal(applied.hasLedger, true);
  assert.ok(!fs.existsSync(path.join(target, PENDING_RESTORE)));
  assert.equal(applyPendingRestore({ dataDir: target }), null);
});

test('emailed reports are kept for download, expire after their lifetime, and ids cannot escape the folder', async () => {
  const { ReportFiles } = await import('../src/report-files.js');
  const dir = path.join(tmpDir(), 'report-files');
  const files = new ReportFiles({ dir, ttlDays: 30 });
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  await files.save(id, '<html>report</html>', { filename: 'Payments-2026-10-01.html' });
  assert.deepEqual([files.get(id).html, files.get(id).filename], ['<html>report</html>', 'Payments-2026-10-01.html']);
  assert.equal(files.get(id, Date.now() + 31 * 86400000), null);
  assert.equal(files.get('../../etc/passwd'), null);
  assert.throws(() => files.save('../x', 'y'));
  assert.ok(files.purge({ force: true, now: Date.now() + 31 * 86400000 }) >= 1);
  assert.equal(files.get(id), null);
});

test('restore writes only inside the state folder, whoever hands it the bundle, and touches nothing when a name is wrong', async () => {
  const source = tmpDir();
  await seed(source);
  const bundle = readBackup(createBackup({ dataDir: source }).buffer);
  const target = tmpDir();
  fs.writeFileSync(path.join(target, 'settings.json'), '{"before":1}');
  const outside = path.join(path.dirname(target), `escaped-${path.basename(target)}`);
  for (const name of ['../escaped', `../${path.basename(outside)}`, 'audit/../../escaped', '/etc/escaped', 'tenants/x/../../escaped', 'audit/.hidden']) {
    const bad = { ...bundle, files: { ...bundle.files, [name]: bundle.files['settings.json'] } };
    assert.throws(() => restoreBackup(bad, { dataDir: target }), /unexpected file name/, name);
  }
  assert.equal(fs.existsSync(outside), false);
  assert.equal(fs.readFileSync(path.join(target, 'settings.json'), 'utf8'), '{"before":1}', 'nothing was moved aside or replaced');
  assert.deepEqual(fs.readdirSync(target), ['settings.json']);

  // A good bundle still restores, with every file private and no temporary file left behind.
  const { restored } = restoreBackup(bundle, { dataDir: target });
  assert.ok(restored.includes('settings.json'));
  const leftovers = fs.readdirSync(target, { recursive: true }).filter((f) => /\.tmp$|restore-|\.partial$/.test(String(f)));
  assert.deepEqual(leftovers, []);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(target, 'settings.json')).mode & 0o777, 0o600);
});

test('a refused backup\'s message names nothing read from it but a checked version number', async () => {
  const source = tmpDir();
  await seed(source);
  const plain = () => JSON.parse(zlib.gunzipSync(createBackup({ dataDir: source }).buffer));
  const secret = 'smtp-password-Hunter2-sudha@acme.io';
  const withName = plain();
  withName.files[`../${secret}`] = withName.files['settings.json'];
  assert.throws(() => readBackup(zlib.gzipSync(JSON.stringify(withName))), (error) => /unexpected file name/.test(error.message) && !error.message.includes(secret));
  const withVersion = plain();
  withVersion.version = secret;
  assert.throws(() => readBackup(zlib.gzipSync(JSON.stringify(withVersion))), (error) => /version/.test(error.message) && !error.message.includes(secret));
  const newer = plain();
  newer.version = 2;
  assert.throws(() => readBackup(zlib.gzipSync(JSON.stringify(newer))), /Backup version 2 is newer/);
});

test('a backup file is written under an unguessable name, never through a file or link already there', { skip: process.platform === 'win32' }, async () => {
  const source = tmpDir();
  await seed(source);
  const folder = path.join(tmpDir(), 'backups');
  const now = new Date('2026-09-01T02:00:00Z');
  fs.mkdirSync(folder, { recursive: true });
  // The names an older version wrote through: a link planted there now leads nowhere.
  const decoy = path.join(tmpDir(), 'decoy');
  fs.writeFileSync(decoy, 'untouched');
  fs.symlinkSync(decoy, path.join(folder, `mission-zero-2026-09-01T02-00-00.mzbackup.partial`));
  const { file } = writeBackupTo(folder, { dataDir: source, now });
  assert.equal(fs.readFileSync(decoy, 'utf8'), 'untouched');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(readBackup(fs.readFileSync(file)).files['settings.json']);
  assert.deepEqual(fs.readdirSync(folder).filter((f) => f.endsWith('.tmp')), []);
});
