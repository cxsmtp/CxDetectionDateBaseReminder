// The generated first administrator's sign-in is printed once in the server
// log, and kept in a file only the server's user can read until the
// administrator chooses their own password.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort } from './free-port.js';

const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-admin-'));
const file = path.join(dataDir, 'first-admin-password.txt');
let server;
let log = '';

test.before(async () => {
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir };
  for (const name of ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'FIRST_ADMIN', 'CX_API_KEY']) delete env[name];
  server = spawn(process.execPath, ['src/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const up = await fetch(`${BASE}/api/health`).then((r) => r.ok, () => false);
    if (up && log.includes('Password: ')) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start:\n${log}`);
});

test.after(() => server?.kill());

test('the first sign-in is in the log and a private file, and the file goes once replaced', async () => {
  const password = fs.readFileSync(file, 'utf8').trim();
  assert.ok(password.length >= 16);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.ok(log.includes('Email:    admin@mission-zero.local'), 'the log shows the email');
  assert.ok(log.includes(`Password: ${password}`), 'the log shows the password');

  const signIn = await fetch(`${BASE}/api/session/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@mission-zero.local', password }),
  });
  assert.ok(signIn.ok, `sign-in: ${signIn.status}`);
  const cookie = signIn.headers.get('set-cookie').split(';')[0];

  const change = await fetch(`${BASE}/api/me/password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ current: password, next: 'a brand new passphrase 42' }),
  });
  assert.ok(change.ok, `change: ${change.status}`);
  assert.equal(fs.existsSync(file), false, 'the one-time password file is deleted');
});
