// A damaged state file, for real: the server does not start as if it were empty. It says which file, in plain
// words, stops with the code the launcher knows not to roll back over, leaves the file as it was, and lets go
// of the data folder's lock. With a last good copy beside it, it starts from that and keeps the damaged one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { freePort } from './free-port.js';

const dirs = [];
test.after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

/** Start the server on a data folder; resolves with how it ended (or `started: true` once it serves, then stops it). */
async function run(dataDir) {
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, ACCEPT_TERMS: 'tests@acme.io', BACKUP_INTERVAL_HOURS: '0', CX_API_KEY: '', GITHUB_TOKEN: '', GITLAB_TOKEN: '', AZURE_DEVOPS_TOKEN: '', BITBUCKET_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  let started = false;
  let over = false;
  const ended = new Promise((resolve) => child.on('exit', (code) => {
    over = true;
    resolve(code);
  }));
  // It either stops by itself, or serves: then it is asked to stop.
  for (let i = 0; i < 150 && !over && !started; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    started = await fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok, () => false);
  }
  if (!over) child.kill(started ? 'SIGTERM' : 'SIGKILL');
  const code = await ended;
  return { code, log, started };
}

const USERS = { version: 1, roles: {}, users: [{ id: 'u1', email: 'ada@acme.io', name: 'Ada', role: 'admin', passwordHash: 'x' }], migrations: [] };

test('a cut-short iam.json with no last good copy: the server stops, says what to do, and writes over nothing', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'damaged-'));
  dirs.push(dataDir);
  const file = path.join(dataDir, 'iam.json');
  const cut = JSON.stringify(USERS).slice(0, 40);
  fs.writeFileSync(file, cut);
  const { code, log, started } = await run(dataDir);
  assert.equal(started, false, log);
  assert.equal(code, 78, log);
  assert.match(log, /! \[data\] The state file .*iam\.json is damaged/);
  assert.match(log, /will not start/);
  assert.match(log, /scripts\/restore\.mjs/);
  assert.doesNotMatch(log, /an administrator was created/, 'never a new first administrator over the old users');
  assert.doesNotMatch(log, /\n\s+at .*\(.*:\d+:\d+\)/, 'plain words, not a stack trace');
  assert.equal(fs.readFileSync(file, 'utf8'), cut, 'the damaged file is left exactly as it was');
  assert.deepEqual(fs.readdirSync(dataDir).filter((f) => /lock/i.test(f)), [], 'the lock on the data folder is let go');
});

test('with its last good copy beside it, the server starts from the copy and keeps the damaged file', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'damaged-'));
  dirs.push(dataDir);
  const file = path.join(dataDir, 'iam.json');
  fs.writeFileSync(`${file}.bak`, JSON.stringify(USERS));
  fs.writeFileSync(file, '');
  const { log, started } = await run(dataDir);
  assert.equal(started, true, log);
  assert.match(log, /iam\.json/);
  assert.match(log, /Users already set up/, 'the people in the copy, not a new first administrator');
  assert.doesNotMatch(log, /an administrator was created/);
  assert.equal(fs.readdirSync(dataDir).filter((f) => f.startsWith('iam.json.damaged-')).length, 1, 'the damaged file is kept beside it');
});
