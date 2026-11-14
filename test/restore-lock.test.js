// The restore script writes the whole data folder, so it must never run beside a
// live server: it takes the server's lock first, refuses while a server holds
// it, and --force is for the operator who knows that server is gone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { createBackup } from '../src/backup.js';
import { InstanceLock, LOCK_FILE } from '../src/instance-lock.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function folder(t, name = 'restore-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A backup file holding one setting, and a data folder holding another. */
function setUp(t) {
  const source = folder(t);
  fs.writeFileSync(path.join(source, 'settings.json'), JSON.stringify({ from: 'the backup' }));
  const backup = path.join(folder(t), 'state.mzbackup');
  fs.writeFileSync(backup, createBackup({ dataDir: source }).buffer);
  const dataDir = folder(t);
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ from: 'the running server' }));
  return { backup, dataDir };
}

const settings = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).from;
const replaced = (dataDir) => fs.readdirSync(dataDir).filter((name) => name.startsWith('replaced-'));

function restore(dataDir, args) {
  const env = { ...process.env, DATA_DIR: dataDir, SETTINGS_FILE: '', BACKUP_PASSPHRASE: '', INSTANCE_LOCK_STALE_SECONDS: '3' };
  const proc = spawn(process.execPath, ['scripts/restore.mjs', ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (err += d));
  return new Promise((resolve) => proc.on('exit', (code) => resolve({ code, out, err })));
}

test('restore refuses while a server is running on the data folder, and --force restores anyway', async (t) => {
  const { backup, dataDir } = setUp(t);
  const server = await new InstanceLock(dataDir, { staleMs: 900 }).acquire();
  t.after(() => server.release());
  const lockBefore = () => JSON.parse(fs.readFileSync(path.join(dataDir, LOCK_FILE), 'utf8')).id;

  // Looking at a backup writes nothing and needs no lock.
  const look = await restore(dataDir, [backup]);
  assert.equal(look.code, 0, look.err);
  assert.match(look.out, /Nothing written/);

  const refused = await restore(dataDir, [backup, '--yes']);
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.err, /Cannot restore: a CxMissionZero server \(host .*\) is running on /);
  assert.match(refused.err, /Stop the server first, then run this again\. Nothing was written\./);
  assert.match(refused.err, /--force/);
  assert.equal(settings(dataDir), 'the running server');
  assert.deepEqual(replaced(dataDir), []);
  assert.equal(lockBefore(), server.id, 'the server still has its lock');
  assert.equal(server.held, true);

  // The flags in either order; the server's lock is not touched.
  const forced = await restore(dataDir, ['--force', backup, '--yes']);
  assert.equal(forced.code, 0, forced.err);
  assert.match(forced.out, /--force: restoring without checking/);
  assert.match(forced.out, /Restored 1 files into /);
  assert.equal(settings(dataDir), 'the backup');
  assert.equal(replaced(dataDir).length, 1, 'what was there is kept aside');
  assert.equal(lockBefore(), server.id);
  assert.equal(server.held, true);
});

test('restore goes ahead when no server holds the folder, and after a crashed server\'s lock has gone stale', async (t) => {
  const { backup, dataDir } = setUp(t);

  // No lock at all: at once.
  const free = await restore(dataDir, [backup, '--yes']);
  assert.equal(free.code, 0, free.err);
  assert.equal(settings(dataDir), 'the backup');
  assert.equal(fs.existsSync(path.join(dataDir, LOCK_FILE)), false, 'the restore lets go of the lock');

  // A lock left by a server that died: watched for the stale time (3 s here), then taken over.
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ from: 'the crashed server' }));
  fs.writeFileSync(path.join(dataDir, LOCK_FILE), JSON.stringify({ id: 'dead', host: 'old-host', pid: 1, startedAt: 'before the crash', beat: Date.now() }));
  const started = performance.now();
  const after = await restore(dataDir, [backup, '--yes']);
  assert.equal(after.code, 0, after.err);
  assert.ok(performance.now() - started >= 3000, 'not before the lock had gone unchanged for the stale time');
  assert.match(after.out, /A server \(host old-host, started before the crash\) left its lock on this folder\. Watching it for up to 3 s/);
  assert.equal(settings(dataDir), 'the backup');
  assert.equal(fs.existsSync(path.join(dataDir, LOCK_FILE)), false);
});
