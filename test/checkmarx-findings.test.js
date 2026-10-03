// Regression tests for the Checkmarx One findings fixed in MZ-01.00.26 (scans
// 8b12f961 and 0d6b0f2e): each pins the fix so a later change cannot undo it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AuditLog } from '../src/audit-log.js';
import { deriveConnection } from '../src/cxone/endpoints.js';
import { getLastScans } from '../src/cxone/projects.js';
import { ensureClone, setCloneHostCheck } from '../src/github/identity.js';
import { IamStore } from '../src/iam.js';
import { KnownAddresses } from '../src/known-addresses.js';
import { fromAddress } from '../src/mailer.js';

const temp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
const key = (claims) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

test('Checkmarx One addresses: https only, plain http only to this machine (SSRF / cleartext key)', () => {
  assert.throws(() => deriveConnection(key({ iss: 'http://10.0.0.5/auth/realms/acme' })), /must be an https address/);
  assert.throws(() => deriveConnection(key({ iss: 'https://eu.iam.checkmarx.net/auth/realms/acme' }), { baseUrl: 'http://intranet.local' }), /API URL must be an https address/);
  assert.equal(deriveConnection(key({ iss: 'https://eu.iam.checkmarx.net/auth/realms/acme' })).iamUrl, 'https://eu.iam.checkmarx.net');
  assert.equal(deriveConnection(key({ iss: 'http://127.0.0.1:4101/auth/realms/acme' })).tenant, 'acme', 'a local mock still works');
});

test('git clone goes only to allowed hosts (SSRF)', async () => {
  setCloneHostCheck((host) => host === 'github.com');
  try {
    await assert.rejects(ensureClone('https://intranet.local/team/app.git', { cacheDir: temp('clone') }), /not cloned/);
  } finally {
    setCloneHostCheck(null);
  }
});

test('usernames and project ids never reach Object.prototype (prototype pollution)', async () => {
  const known = new KnownAddresses();
  known.remember('__proto__', 'evil@acme.io');
  known.remember('constructor', 'evil@acme.io');
  assert.equal({}.email, undefined);
  assert.equal(known.get('__proto__'), '');

  const client = { request: async () => JSON.parse('{"__proto__": {"polluted": true}, "p1": {"id": "s1"}}') };
  const scans = await getLastScans(client, ['p1']);
  assert.equal(scans.p1.id, 's1');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(scans), null);
});

test('an audit event cannot choose its number or time, which name the log file (path traversal)', () => {
  const root = temp('audit');
  const log = new AuditLog({ dir: path.join(root, 'audit'), keyFile: path.join(root, 'audit.key') });
  const entry = log.record({ type: 'test', outcome: 'info', at: '../../../etc/x', seq: 999 });
  assert.equal(entry.seq, 1);
  assert.match(entry.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'audit')), [`audit-${entry.at.slice(0, 7)}.jsonl`]);
  assert.deepEqual(fs.readdirSync(root).sort(), ['audit', 'audit.key']);
  assert.equal(log.verify().ok, true);
  const linked = log.record({ type: 'test', outcome: 'info', id: '1c7d1b5c-4658-4f13-84c2-3b27aff17bd1' });
  assert.equal(linked.id, '1c7d1b5c-4658-4f13-84c2-3b27aff17bd1', 'an id linked beforehand (the credit ledger) is kept');
});

test('the mail From header cannot be split (header injection)', () => {
  const from = fromAddress({ fromName: 'Security\r\nBcc: victim@acme.io', fromAddress: 'appsec@acme.io' });
  assert.ok(!/[\r\n]/.test(from));
  assert.equal(from, '"SecurityBcc: victim@acme.io" <appsec@acme.io>');
});

test('a locked account looks like any wrong password to someone without it (account enumeration)', async () => {
  const iam = new IamStore({ file: path.join(temp('iam'), 'iam.json') });
  await iam.createUser({ email: 'ann@acme.io', role: 'user', password: 'a long enough password 1' });
  for (let i = 0; i < 10; i++) await iam.signIn('ann@acme.io', 'wrong password').catch(() => {});
  await assert.rejects(iam.signIn('ann@acme.io', 'wrong again'), (error) => error.status === 401 && /Wrong email or password/.test(error.message));
  await assert.rejects(iam.signIn('ann@acme.io', 'a long enough password 1'), (error) => error.status === 423);
});
