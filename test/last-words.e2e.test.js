// Stopping: when the service is stopped (SIGTERM) without anyone asking from the
// Update page, the server backs its data up first and emails the administrators
// the encrypted copy, with how to bring it back. A restart loop sends one email,
// not one per stop. Without a passphrase the copy is never attached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createBackup, readBackup } from '../src/backup.js';
import { freePort } from './free-port.js';
import { fakeSmtp } from './fake-smtp.js';
import { FIRST_PASSWORD, NEXT_PASSWORD, PASSPHRASE } from './test-credentials.js';

let smtp;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readable = (raw) => raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

test.before(async () => {
  smtp = await fakeSmtp();
});
test.after(async () => {
  await smtp?.close();
});

/** Start a server on `dataDir`, sign the Admin in, set up the mail server; returns { stop() }. */
async function start(dataDir, env = {}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let log = '';
  const server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', HTTPS: 'off', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0', SMTP_HOST: '', CX_API_KEY: '', ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const end = Date.now() + 15000;
  while (!/running on/.test(log)) {
    if (Date.now() > end) throw new Error(log);
    await sleep(100);
  }
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  if (/First administrator created/.test(log) || !(await call('POST', '/api/session/password', { email: 'admin@acme.io', password: NEXT_PASSWORD })).body?.signedIn) {
    while (!/First administrator created/.test(log)) await sleep(100);
    await call('POST', '/api/session/password', { email: 'admin@acme.io', password: FIRST_PASSWORD });
    await call('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD });
    await call('PUT', '/api/settings', { smtp: { host: '127.0.0.1', port: smtp.port, secure: false, requireAuth: false, rejectUnauthorized: false, fromAddress: 'mz@acme.io', fromName: 'MissionZero' } });
    assert.equal((await call('POST', '/api/settings/connections/check', { rollback: false })).body.smtp.ok, true);
  }
  return {
    log: () => log,
    call,
    stop: () => new Promise((resolve) => {
      server.once('exit', (code) => resolve(code));
      server.kill('SIGTERM');
    }),
  };
}

const stoppedMails = () => smtp.messages.filter((m) => m.to.includes('admin@acme.io') && /MissionZero stopped/.test(readable(m.raw)));

test('stopped by someone: a backup first, and the encrypted copy to the administrators with how to restore it', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-words-'));
  const server = await start(dataDir, { BACKUP_PASSPHRASE: PASSPHRASE });
  const code = await server.stop();
  assert.equal(code, 0, server.log());
  assert.match(server.log(), /Before stopping: .*\.mzbackup/);
  const backups = fs.readdirSync(path.join(dataDir, 'backups')).filter((f) => f.endsWith('.mzbackup'));
  assert.equal(backups.length, 1);

  const [mail] = stoppedMails();
  assert.ok(mail, 'the Admin got the email');
  const text = readable(mail.raw);
  assert.match(text, /backup is attached/);
  assert.match(text, /Restore from backup/);
  // The attachment is the backup itself, and it opens with the passphrase.
  const part = new RegExp(`filename="?${backups[0].replace(/\./g, '\\.')}"?[\\s\\S]*?\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]+?)\\r\\n--`).exec(mail.raw);
  assert.ok(part, 'attached');
  const bundle = readBackup(Buffer.from(part[1].replace(/\s+/g, ''), 'base64'), { passphrase: PASSPHRASE });
  assert.ok(bundle.files['iam.json'], 'with the people in it');

  // A restart loop: the next stop backs up again, but emails nobody. (Backups are named to the second.)
  await sleep(1100);
  const again = await start(dataDir, { BACKUP_PASSPHRASE: PASSPHRASE });
  await again.stop();
  assert.equal(fs.readdirSync(path.join(dataDir, 'backups')).filter((f) => f.endsWith('.mzbackup')).length, 2);
  assert.equal(stoppedMails().length, 1, 'one email, not one per stop');
});

test('without a passphrase the copy is never attached: the email says where it is', async () => {
  const before = stoppedMails().length;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-words-plain-'));
  const server = await start(dataDir, { BACKUP_PASSPHRASE: '' });
  await server.stop();
  const mail = stoppedMails().at(-1);
  assert.equal(stoppedMails().length, before + 1);
  assert.match(readable(mail.raw), /not attached because it is not encrypted/);
  assert.doesNotMatch(mail.raw, /\.mzbackup"?\r\nContent-Transfer-Encoding: base64/);
});

test('every backup goes to the backup mailbox, and a new server brings the newest one back by itself', async () => {
  const mailbox = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-mailbox-'));
  const env = { BACKUP_PASSPHRASE: PASSPHRASE, BACKUP_EMAIL: 'vault@acme.io', BACKUP_EMAIL_PASSWORD: 'mailbox password', BACKUP_EMAIL_IMAP_HOST: '127.0.0.1', MZ_TEST_BACKUP_MAILBOX_DIR: mailbox, LAST_WORDS_EVERY_HOURS: '0' };
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-mail-a-'));
  const a = await start(first, env);
  assert.equal((await a.call('POST', '/api/backup/now')).status, 200);
  const sent = await (async () => {
    for (let i = 0; i < 50; i++) {
      const m = smtp.messages.find((x) => x.to.includes('vault@acme.io'));
      if (m) return m;
      await sleep(100);
    }
    return null;
  })();
  assert.ok(sent, 'the backup was emailed to the backup mailbox');
  assert.match(sent.raw, /Subject: MissionZero backup /);
  const attachment = /filename="?(mission-zero-[^"\r\n]+\.mzbackup)"?[\s\S]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/.exec(sent.raw);
  assert.ok(attachment, 'attached');
  fs.writeFileSync(path.join(mailbox, attachment[1]), Buffer.from(attachment[2].replace(/\s+/g, ''), 'base64'));
  await a.stop();

  // Someone plants a newer, unencrypted backup in the mailbox: it must never be taken.
  const forgedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forged-'));
  fs.writeFileSync(path.join(forgedDir, 'iam.json'), JSON.stringify({ users: [{ id: 'x', email: 'mallory@evil.example', role: 'admin' }] }));
  fs.writeFileSync(path.join(mailbox, 'mission-zero-2999-01-01T00-00-00.mzbackup'), createBackup({ dataDir: forgedDir }).buffer);

  // A new server, an empty state folder: it finds the real backup and starts as the old one was.
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-mail-b-'));
  const b = await start(second, env);
  assert.match(b.log(), /Found mission-zero-.*\.mzbackup in vault@acme\.io: restoring it/);
  assert.doesNotMatch(b.log(), /2999-01-01/);
  const me = await b.call('GET', '/api/me');
  assert.equal(me.body.user.email, 'admin@acme.io', 'signed in with the password set on the old server');
  assert.equal((await b.call('GET', '/api/settings')).body.smtp.host, '127.0.0.1', 'with its settings');
  const audit = (await b.call('GET', '/api/audit?types=backup&limit=20')).body.entries.map((e) => e.reason).join('\n');
  assert.match(audit, /found by itself in the backup mailbox vault@acme\.io/);
  await b.stop();
});
