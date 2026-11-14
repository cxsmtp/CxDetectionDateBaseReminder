// scripts/reset-admin.mjs: the way back in for an administrator who lost the password, and the phone with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { IamStore, generatePassword } from '../src/iam.js';
import { newSecret } from '../src/mfa.js';

test('reset-admin sets a temporary password and takes two-step sign-in off, and says so', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-admin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'iam.json');
  const iam = new IamStore({ file });
  const admin = await iam.createUser({ email: 'admin@acme.io', name: 'Ada', role: 'admin', password: generatePassword() });
  iam.enableTwoStep(admin.id, newSecret(), { recovery: [] });
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).users.find((u) => u.email === 'admin@acme.io').mfa?.secret, 'two-step sign-in is on');

  const out = execFileSync(process.execPath, ['scripts/reset-admin.mjs', 'admin@acme.io'], { encoding: 'utf8', env: { ...process.env, DATA_DIR: dir, SETTINGS_FILE: '' } });
  assert.match(out, /Password reset/);
  assert.match(out, /two-step sign-in was taken off/);
  const after = JSON.parse(fs.readFileSync(file, 'utf8')).users.find((u) => u.email === 'admin@acme.io');
  assert.equal(after.mfa, undefined, 'nothing of the secret is left');
  assert.ok(!fs.existsSync(`${file}.bak`) || !/"secret"/.test(fs.readFileSync(`${file}.bak`, 'utf8')), 'nor in the last good copy');
  const entries = fs.readdirSync(path.join(dir, 'audit')).flatMap((name) => fs.readFileSync(path.join(dir, 'audit', name), 'utf8').trim().split('\n').map((line) => JSON.parse(line)));
  assert.ok(entries.some((e) => /two-step sign-in was taken off/.test(e.reason)), 'recorded in the audit log');

  // Someone without two-step sign-in: nothing is said about it.
  const again = execFileSync(process.execPath, ['scripts/reset-admin.mjs', 'admin@acme.io'], { encoding: 'utf8', env: { ...process.env, DATA_DIR: dir, SETTINGS_FILE: '' } });
  assert.doesNotMatch(again, /two-step/);
});
