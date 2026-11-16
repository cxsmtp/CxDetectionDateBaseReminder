// Backups are encrypted by default, on the real server: a new installation encrypts from its first
// backup with a key of its own that an Admin can see, save and confirm; an existing installation
// stays plain until an Admin turns encryption on; BACKUP_PASSPHRASE wins; BACKUP_ENCRYPTION=off
// keeps backups plain; and the key is never in the audit log or the server's log.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBackup, isSealed, readBackup } from '../src/backup.js';
import { BACKUP_KEY_FILE, generateBackupKey } from '../src/backup-key.js';
import { freePort } from './free-port.js';
import { FIRST_PASSWORD, MEMBER_NEXT_PASSWORD, MEMBER_PASSWORD, NEXT_PASSWORD, PASSPHRASE } from './test-credentials.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const servers = [];
test.after(async () => {
  await Promise.all(servers.map((s) => s.stop()));
});

function folder(t, name = 'backup-enc-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  // The servers started on this folder are stopped first, and waited for: one still running writes into it (its
  // sign-ins, its logs, a last backup as it stops), and removing a folder that is being written to fails now and
  // then with ENOTEMPTY, which is how this file failed once in six runs and kept two images from being published.
  t.after(async () => {
    await Promise.all(servers.filter((s) => s.dataDir === dir).map((s) => s.stop()));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return dir;
}

/** A browser: keeps its own session cookie. `raw` sends bytes and extra headers (a backup upload). */
function browser(base) {
  let cookie = '';
  const call = async (method, url, body, { headers = {}, raw = false } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...(raw ? { 'Content-Type': 'application/octet-stream' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? (raw ? body : JSON.stringify(body)) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const bytes = Buffer.from(await res.arrayBuffer());
    let json = null;
    try {
      json = JSON.parse(bytes.toString('utf8'));
    } catch {}
    return { status: res.status, body: json, bytes, headers: res.headers };
  };
  return call;
}

/** Start a server on `dataDir` and sign its Admin in; returns { admin, base, log(), stop() }. */
async function start(dataDir, env = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let log = '';
  const server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', HTTPS: 'off', DATA_DIR: dataDir, SETTINGS_FILE: '', ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0', BACKUP_DIR: '', BACKUP_PASSPHRASE: '', BACKUP_ENCRYPTION: '', BACKUP_EMAIL: '', SMTP_HOST: '', CX_API_KEY: '', ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const end = Date.now() + 20000;
  while (!/running on/.test(log)) {
    if (Date.now() > end) throw new Error(log);
    await sleep(100);
  }
  const admin = browser(base);
  if (!(await admin('POST', '/api/session/password', { email: 'admin@acme.io', password: NEXT_PASSWORD })).body?.signedIn) {
    await admin('POST', '/api/session/password', { email: 'admin@acme.io', password: FIRST_PASSWORD });
    assert.equal((await admin('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD })).status, 200);
  }
  const handle = {
    dataDir,
    admin,
    base,
    log: () => log,
    stop: () => new Promise((resolve) => {
      if (server.exitCode !== null) return resolve(server.exitCode);
      server.once('exit', (code) => resolve(code));
      server.kill('SIGTERM');
    }),
  };
  servers.push(handle);
  return handle;
}

const backupAudit = async (admin) => (await admin('GET', '/api/audit?types=backup&limit=50')).body.entries;
const newestBackup = (dataDir) => {
  const dir = path.join(dataDir, 'backups');
  return fs.readFileSync(path.join(dir, fs.readdirSync(dir).filter((f) => f.endsWith('.mzbackup')).sort().at(-1)));
};

test('a new installation: encrypted from the first backup; an Admin sees, saves and confirms the key; nobody else does', async (t) => {
  const dataDir = folder(t);
  const server = await start(dataDir);
  const { admin } = server;
  assert.match(server.log(), /A new installation: every backup is encrypted with this server's own backup key/);

  // Admins are told until the key is confirmed as saved.
  assert.equal((await admin('GET', '/api/me')).body.backupNotice, 'save-key');
  const status = (await admin('GET', '/api/backup')).body;
  assert.equal(status.encrypted, true);
  assert.deepEqual(
    (({ source, encrypted, keySaved, notice, canTurnOn, optedOut }) => ({ source, encrypted, keySaved, notice, canTurnOn, optedOut }))(status.encryption),
    { source: 'key', encrypted: true, keySaved: false, notice: 'save-key', canTurnOn: false, optedOut: false },
  );
  assert.equal(status.encryption.key, undefined, 'the status never carries the key');

  // The first backup to the folder and a downloaded one are both sealed.
  assert.equal((await admin('POST', '/api/backup/now')).status, 200);
  assert.equal(isSealed(newestBackup(dataDir)), true);
  const download = await admin('GET', '/api/backup/download');
  assert.equal(download.status, 200);
  assert.equal(isSealed(download.bytes), true);
  assert.throws(() => readBackup(download.bytes), /is encrypted, and no backup key or passphrase was given/);

  // The Admin asks to see the key: it opens both backups, as BACKUP_PASSPHRASE=<the key> would.
  const shown = await admin('POST', '/api/backup/key/show');
  assert.equal(shown.status, 200);
  assert.equal(shown.headers.get('cache-control'), 'no-store');
  const { key } = shown.body;
  assert.match(key, /^([A-HJ-NP-Z2-9]{4}-){7}[A-HJ-NP-Z2-9]{4}$/);
  assert.ok(readBackup(download.bytes, { passphrase: key }).files['iam.json']);
  assert.ok(readBackup(newestBackup(dataDir), { passphrase: key }).files['iam.json']);
  assert.ok(!Object.keys(readBackup(download.bytes, { passphrase: key }).files).includes(BACKUP_KEY_FILE), 'the key is not inside the backup');
  assert.throws(() => readBackup(download.bytes, { passphrase: generateBackupKey() }), /wrong backup key or passphrase/);

  // Each showing is audited, without the key.
  await admin('POST', '/api/backup/key/show');
  let entries = await backupAudit(admin);
  const showings = entries.filter((e) => e.reason === 'Backup key shown.');
  assert.equal(showings.length, 2);
  assert.equal(showings[0].actor.email, 'admin@acme.io');

  // "I have saved it": the notice goes, and it is audited with who confirmed.
  const confirmed = await admin('POST', '/api/backup/key/confirm');
  assert.equal(confirmed.status, 200);
  assert.deepEqual((({ keySaved, keySavedBy, notice }) => ({ keySaved, keySavedBy, notice }))(confirmed.body.encryption), { keySaved: true, keySavedBy: 'admin@acme.io', notice: null });
  assert.equal((await admin('GET', '/api/me')).body.backupNotice, null);
  entries = await backupAudit(admin);
  assert.ok(entries.some((e) => /Backup key confirmed as saved/.test(e.reason) && e.outcome === 'changed'));
  // It is already on: there is nothing to turn on, and nothing changes.
  assert.equal((await admin('POST', '/api/backup/encryption', { on: true })).body.encryption.source, 'key');
  assert.equal((await admin('POST', '/api/backup/key/show')).body.key, key);

  // Someone who may see the backup status but not download backups: no key, no confirming, no notice.
  assert.equal((await admin('POST', '/api/iam/users', { email: 'ana@acme.io', role: 'analyst', password: MEMBER_PASSWORD })).status, 201);
  const analyst = browser(server.base);
  await analyst('POST', '/api/session/password', { email: 'ana@acme.io', password: MEMBER_PASSWORD });
  assert.equal((await analyst('POST', '/api/me/password', { current: MEMBER_PASSWORD, next: MEMBER_NEXT_PASSWORD })).status, 200);
  assert.equal((await analyst('GET', '/api/backup')).body.encryption.source, 'key', 'the status, without the key');
  for (const [url, body] of [['/api/backup/key/show', null], ['/api/backup/key/confirm', null], ['/api/backup/encryption', { on: true }]]) {
    assert.equal((await analyst('POST', url, body)).status, 403, url);
  }
  assert.equal((await analyst('GET', '/api/me')).body.backupNotice, null);
  assert.equal((await browser(server.base)('POST', '/api/backup/key/show')).status, 401, 'not signed in');

  // The in-app restore: a backup of this server opens by itself; another server's asks for its key.
  assert.equal((await admin('POST', '/api/backup/restore?check=1', download.bytes, { raw: true })).status, 200);
  const elsewhere = folder(t);
  fs.writeFileSync(path.join(elsewhere, 'settings.json'), '{}');
  const otherKey = generateBackupKey();
  const foreign = createBackup({ dataDir: elsewhere, passphrase: otherKey }).buffer;
  const needs = await admin('POST', '/api/backup/restore?check=1', foreign, { raw: true });
  assert.equal(needs.status, 400);
  assert.equal(needs.body.needsKey, true);
  assert.match(needs.body.error, /is encrypted, and this server's own backup key or passphrase does not open it\. Give the backup key of the server that made it/);
  const wrong = await admin('POST', '/api/backup/restore?check=1', foreign, { raw: true, headers: { 'X-Backup-Passphrase': generateBackupKey() } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /wrong backup key or passphrase, or the backup is damaged/);
  const right = await admin('POST', '/api/backup/restore?check=1', foreign, { raw: true, headers: { 'X-Backup-Passphrase': otherKey.toLowerCase() } });
  assert.equal(right.status, 200, JSON.stringify(right.body));
  assert.equal(right.body.backup.hasSettings, true);

  // The key is in its file, readable by the server's user alone, and nowhere else: not the audit log, not the server's log.
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dataDir, BACKUP_KEY_FILE)).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(dataDir, `${BACKUP_KEY_FILE}.bak`)), false);
  await server.stop();
  assert.ok(!server.log().includes(key), 'never in the server\'s log');
  for (const name of fs.readdirSync(path.join(dataDir, 'audit'))) {
    assert.ok(!fs.readFileSync(path.join(dataDir, 'audit', name), 'utf8').includes(key), `never in the audit log (${name})`);
  }
  for (const name of ['activity.jsonl']) {
    if (fs.existsSync(path.join(dataDir, name))) assert.ok(!fs.readFileSync(path.join(dataDir, name), 'utf8').includes(key), `never in ${name}`);
  }
  // The backup made as it stopped is sealed with the same key, and the next start keeps it.
  assert.ok(readBackup(newestBackup(dataDir), { passphrase: key }).files['iam.json']);
  const again = await start(dataDir);
  assert.doesNotMatch(again.log(), /\[backup\] (A new installation|This installation has data from before)/, 'decided once');
  assert.equal((await again.admin('POST', '/api/backup/key/show')).body.key, key);
  assert.equal((await again.admin('GET', '/api/backup')).body.encryption.keySaved, true);
});

test('an existing installation: backups stay plain until an Admin turns encryption on, which shows the key and asks to confirm', async (t) => {
  // Made by an earlier version: its state is there, and it has made plain backups.
  const dataDir = folder(t);
  fs.writeFileSync(path.join(dataDir, 'tracked-reports.json'), JSON.stringify({ reports: [] }));
  const server = await start(dataDir);
  const { admin } = server;
  assert.match(server.log(), /This installation has data from before \(tracked-reports\.json\): its backups are left as they were, not encrypted, until an Admin turns encryption on/);

  assert.equal((await admin('GET', '/api/me')).body.backupNotice, 'not-encrypted');
  const before = (await admin('GET', '/api/backup')).body;
  assert.equal(before.encrypted, false);
  assert.deepEqual(
    (({ source, hasKey, notice, canTurnOn }) => ({ source, hasKey, notice, canTurnOn }))(before.encryption),
    { source: 'none', hasKey: false, notice: 'not-encrypted', canTurnOn: true },
  );
  assert.equal((await admin('POST', '/api/backup/now')).status, 200);
  assert.equal(isSealed(newestBackup(dataDir)), false, 'as it always was');
  assert.ok(readBackup((await admin('GET', '/api/backup/download')).bytes).files['iam.json']);
  assert.equal((await admin('POST', '/api/backup/key/show')).status, 409, 'there is no key yet');
  assert.equal((await admin('POST', '/api/backup/key/confirm')).status, 409);
  assert.equal((await admin('POST', '/api/backup/encryption', {})).status, 400);

  // The Admin turns it on: a key is made, backups are sealed from now on, and the notice asks to save the key.
  const on = await admin('POST', '/api/backup/encryption', { on: true });
  assert.equal(on.status, 200);
  assert.deepEqual((({ source, keySaved, notice }) => ({ source, keySaved, notice }))(on.body.encryption), { source: 'key', keySaved: false, notice: 'save-key' });
  assert.equal((await admin('GET', '/api/me')).body.backupNotice, 'save-key');
  const { key } = (await admin('POST', '/api/backup/key/show')).body;
  await sleep(1100); // backups are named to the second
  assert.equal((await admin('POST', '/api/backup/now')).status, 200);
  assert.ok(readBackup(newestBackup(dataDir), { passphrase: key }).files['iam.json']);
  assert.ok(readBackup((await admin('GET', '/api/backup/download')).bytes, { passphrase: key }).files['iam.json']);
  assert.equal((await admin('POST', '/api/backup/key/confirm')).body.encryption.notice, null);
  assert.equal((await admin('GET', '/api/me')).body.backupNotice, null);

  const reasons = (await backupAudit(admin)).map((e) => `${e.outcome}: ${e.reason} (${e.actor?.email ?? ''})`);
  assert.ok(reasons.some((r) => /^changed: Backup encryption turned on: backups are encrypted with this server's backup key from now on\. \(admin@acme\.io\)/.test(r)), reasons.join('\n'));
  assert.ok(reasons.some((r) => /^info: Backup key shown\. \(admin@acme\.io\)/.test(r)));
  assert.ok(reasons.some((r) => /^changed: Backup key confirmed as saved/.test(r)));
  assert.ok(!JSON.stringify(await backupAudit(admin)).includes(key));
  // The plain backup made before still restores.
  const older = fs.readdirSync(path.join(dataDir, 'backups')).sort()[0];
  assert.equal((await admin('POST', '/api/backup/restore?check=1', fs.readFileSync(path.join(dataDir, 'backups', older)), { raw: true })).status, 200);
});

test('BACKUP_PASSPHRASE wins: backups open with it, not with the server\'s key, and there is nothing to turn on or save', async (t) => {
  const dataDir = folder(t);
  const server = await start(dataDir, { BACKUP_PASSPHRASE: PASSPHRASE });
  const { admin } = server;
  const status = (await admin('GET', '/api/backup')).body;
  assert.equal(status.encrypted, true);
  assert.deepEqual((({ source, notice, canTurnOn }) => ({ source, notice, canTurnOn }))(status.encryption), { source: 'passphrase', notice: null, canTurnOn: false });
  assert.equal((await admin('GET', '/api/me')).body.backupNotice, null);
  const { bytes } = await admin('GET', '/api/backup/download');
  assert.ok(readBackup(bytes, { passphrase: PASSPHRASE }).files['iam.json']);
  const own = JSON.parse(fs.readFileSync(path.join(dataDir, BACKUP_KEY_FILE), 'utf8')).key;
  assert.throws(() => readBackup(bytes, { passphrase: own }), /wrong backup key or passphrase/);
  const on = await admin('POST', '/api/backup/encryption', { on: true });
  assert.equal(on.status, 409);
  assert.match(on.body.error, /already encrypted, with BACKUP_PASSPHRASE/);
  // A backup made before, with the same passphrase, still restores without typing anything.
  assert.equal((await admin('POST', '/api/backup/restore?check=1', bytes, { raw: true })).status, 200);
});

test('BACKUP_ENCRYPTION=off: backups are plain on purpose, without a notice, and cannot be turned on from the page', async (t) => {
  const dataDir = folder(t);
  const server = await start(dataDir, { BACKUP_ENCRYPTION: 'off' });
  const { admin } = server;
  assert.match(server.log(), /BACKUP_ENCRYPTION=off: backups are not encrypted/);
  const status = (await admin('GET', '/api/backup')).body;
  assert.equal(status.encrypted, false);
  assert.deepEqual((({ source, optedOut, notice, canTurnOn }) => ({ source, optedOut, notice, canTurnOn }))(status.encryption), { source: 'none', optedOut: true, notice: null, canTurnOn: false });
  assert.equal((await admin('GET', '/api/me')).body.backupNotice, null);
  assert.ok(readBackup((await admin('GET', '/api/backup/download')).bytes).files['iam.json'], 'plain');
  const on = await admin('POST', '/api/backup/encryption', { on: true });
  assert.equal(on.status, 409);
  assert.match(on.body.error, /BACKUP_ENCRYPTION=off is set on the server/);
});
