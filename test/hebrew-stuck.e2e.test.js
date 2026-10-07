// A server where an older version turned Hebrew on for nobody, not even the Admin who applied the
// code: on its next start, Hebrew is opened to that Admin, so it is never on with nobody able to see it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';
import { FIRST_PASSWORD, NEXT_PASSWORD } from './test-credentials.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('Hebrew left on for nobody is opened to the Admin who applied its code', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'he-stuck-'));
  const expires = new Date(Date.now() + 100 * 86_400_000).toISOString();
  fs.writeFileSync(path.join(dataDir, 'languages.json'), JSON.stringify({ gated: { he: { on: true, org: 'Acme', expires, activatedAt: new Date().toISOString(), users: [] } } }));
  fs.writeFileSync(path.join(dataDir, 'activation.json'), JSON.stringify({ tenants: null, history: [{ id: 'x', org: 'Acme', scope: 'lang:he', action: 'activate', expires, at: new Date().toISOString(), by: 'admin@acme.io' }] }));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let log = '';
  const server = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', HTTPS: 'off', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0', SMTP_HOST: '', GITHUB_TOKEN: '', CX_API_KEY: '', ADMIN_EMAIL: 'admin@acme.io', ADMIN_PASSWORD: FIRST_PASSWORD },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => server.kill());
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  const end = Date.now() + 15000;
  while (!/running on/.test(log) || !/First administrator created/.test(log)) {
    if (Date.now() > end) throw new Error(log);
    await sleep(100);
  }
  assert.match(log, /he was on for nobody: now open to admin@acme\.io/);
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  await call('POST', '/api/session/password', { email: 'admin@acme.io', password: FIRST_PASSWORD });
  await call('POST', '/api/me/password', { current: FIRST_PASSWORD, next: NEXT_PASSWORD });
  assert.ok((await call('GET', '/api/me')).body.languages.includes('he'), 'the Admin sees Hebrew in the language list');
  assert.equal((await fetch(`${base}/i18n/he.json`)).status, 404, 'and nobody signed out does');
});
