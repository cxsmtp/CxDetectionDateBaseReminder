import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_ROLES, IamStore, PERMISSION_IDS } from '../src/iam.js';

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iam-')), 'iam.json');
const PW = 'correct horse battery';

async function seeded() {
  const iam = new IamStore({ file: file() });
  const admin = await iam.createUser({ email: 'Admin@Acme.io', name: 'Ada', role: 'admin', password: PW, mustChangePassword: false });
  const analyst = await iam.createUser({ email: 'ana@acme.io', role: 'analyst', password: PW, mustChangePassword: false });
  const user = await iam.createUser({ email: 'u@acme.io', role: 'user', password: PW, cxoneIdentities: ['jdoe'] });
  const as = (u) => ({ actorPerms: iam.permissionsOf(iam.user(u.id)), actorId: u.id });
  return { iam, admin, analyst, user, as };
}

test('default roles: Admin holds everything; Security Analyst all but the Admin-only permissions; User the basics', () => {
  assert.deepEqual(DEFAULT_ROLES.admin.permissions, PERMISSION_IDS);
  for (const special of ['integration.cxone', 'integration.smtp', 'credits.limit', 'backup.manage']) {
    assert.ok(!DEFAULT_ROLES.analyst.permissions.includes(special), special);
  }
  for (const p of ['iam.view', 'iam.manage', 'credits.allocate', 'settings.template', 'audit.view', 'triage.run']) {
    assert.ok(DEFAULT_ROLES.analyst.permissions.includes(p), p);
  }
  assert.deepEqual(new Set(DEFAULT_ROLES.user.permissions), new Set(['findings.fetch', 'reminders.send', 'initiators.tag', 'reports.view', 'reports.remind', 'credits.view', 'settings.view']));
  assert.ok(!DEFAULT_ROLES.user.permissions.some((p) => p.startsWith('iam.')), 'IAM is hidden from users');
});

test('passwords are hashed, never stored or returned in clear, and sign-in matches email case-insensitively', async () => {
  const { iam } = await seeded();
  const raw = fs.readFileSync(iam.file, 'utf8');
  assert.ok(!raw.includes(PW));
  assert.ok(!JSON.stringify(iam.users()).includes('scrypt'));
  assert.equal((await iam.signIn('ADMIN@acme.io', PW)).email, 'admin@acme.io');
  await assert.rejects(iam.signIn('admin@acme.io', 'wrong password!'), { status: 401, message: 'Wrong email or password.' });
  await assert.rejects(iam.signIn('nobody@acme.io', PW), { status: 401, message: 'Wrong email or password.' });
});

test('five wrong passwords lock the account for a while, even against the right one', async () => {
  const { iam } = await seeded();
  const now = Date.now();
  for (let i = 0; i < 5; i += 1) await assert.rejects(iam.signIn('u@acme.io', 'not the password', now), { status: 401 });
  await assert.rejects(iam.signIn('u@acme.io', PW, now + 1000), { status: 423 });
  assert.equal((await iam.signIn('u@acme.io', PW, now + 16 * 60 * 1000)).email, 'u@acme.io');
});

test('Checkmarx One identities map to users by email, username or client id', async () => {
  const { iam } = await seeded();
  assert.equal(iam.findByCxIdentity({ email: 'ANA@acme.io' }).email, 'ana@acme.io');
  assert.equal(iam.findByCxIdentity({ user: 'JDoe' }).email, 'u@acme.io');
  assert.equal(iam.findByCxIdentity({ user: 'stranger' }), null);
  await assert.rejects(iam.createUser({ email: 'x@acme.io', role: 'user', cxoneIdentities: ['jdoe'] }), { status: 409 });
});

test('nobody can grant more than they hold: an analyst cannot create, promote or touch an Admin', async () => {
  const { iam, admin, analyst, user, as } = await seeded();
  await assert.rejects(iam.createUser({ email: 'new@acme.io', role: 'admin' }, as(analyst)), { status: 403 });
  assert.equal((await iam.createUser({ email: 'new@acme.io', role: 'user' }, as(analyst))).role, 'user');
  assert.throws(() => iam.updateUser(user.id, { role: 'admin' }, as(analyst)), { status: 403 });
  assert.throws(() => iam.updateUser(admin.id, { disabled: true }, as(analyst)), { status: 403 });
  assert.throws(() => iam.deleteUser(admin.id, as(analyst)), { status: 403 });
  await assert.rejects(iam.setPassword(admin.id, 'a brand new password', { actorPerms: as(analyst).actorPerms }), { status: 403 });
  assert.throws(() => iam.saveRole(null, { name: 'Sneaky', permissions: ['integration.smtp'] }, as(analyst)), { status: 403 });
  assert.equal(iam.updateUser(user.id, { role: 'analyst' }, as(analyst)).after.role, 'analyst');
  // The admin can do all of it.
  assert.equal(iam.updateUser(analyst.id, { role: 'user' }, as(admin)).after.role, 'user');
});

test('there is always an active Admin, and nobody can lock themselves out', async () => {
  const { iam, admin, as } = await seeded();
  assert.throws(() => iam.updateUser(admin.id, { role: 'user' }, as(admin)), { status: 400 });
  assert.throws(() => iam.updateUser(admin.id, { disabled: true }, as(admin)), { status: 400 });
  assert.throws(() => iam.deleteUser(admin.id, as(admin)), { status: 400 });
  const second = await iam.createUser({ email: 'admin2@acme.io', role: 'admin' }, as(admin));
  iam.updateUser(admin.id, { disabled: true }, { actorPerms: iam.permissionsOf(iam.user(second.id)), actorId: second.id });
  assert.throws(() => iam.updateUser(second.id, { role: 'user' }, { actorPerms: new Set(PERMISSION_IDS), actorId: 'someone' }), /at least one active Admin/);
});

test('custom roles: permissions apply at once, the Admin role is locked, roles in use cannot be removed', async () => {
  const { iam, admin, user, as } = await seeded();
  const { after: auditor } = iam.saveRole(null, { name: 'Auditor', permissions: ['audit.view', 'audit.export', 'not.a.permission'] }, as(admin));
  assert.deepEqual(auditor.permissions, ['audit.view', 'audit.export']);
  iam.updateUser(user.id, { role: auditor.id }, as(admin));
  assert.ok(iam.permissionsOf(iam.user(user.id)).has('audit.export'));
  assert.ok(!iam.permissionsOf(iam.user(user.id)).has('findings.fetch'));
  assert.throws(() => iam.deleteRole(auditor.id, as(admin)), { status: 400 });
  assert.throws(() => iam.saveRole('admin', { permissions: [] }, as(admin)), { status: 400 });
  assert.throws(() => iam.deleteRole('user', as(admin)), { status: 400 });
  iam.saveRole('user', { permissions: ['findings.fetch'] }, as(admin));
  assert.deepEqual(new IamStore({ file: iam.file }).role('user').permissions, ['findings.fetch'], 'saved');
  iam.updateUser(user.id, { disabled: true }, as(admin));
  assert.equal(iam.permissionsOf(iam.user(user.id)).size, 0, 'a disabled user holds nothing');
});

test('weak passwords are refused, and an administrator reset forces a change at next sign-in', async () => {
  const { iam, admin, user, as } = await seeded();
  await assert.rejects(iam.setPassword(user.id, 'short'), { status: 400 });
  await assert.rejects(iam.setPassword(user.id, 'aaaaaaaaaaaaaaaa'), { status: 400 });
  const reset = await iam.setPassword(user.id, 'temporary password 1', { mustChange: true, actorPerms: as(admin).actorPerms });
  assert.equal(reset.mustChangePassword, true);
});

test('role ids are only ever the roles themselves: "constructor" and "__proto__" are not roles', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iam-proto-'));
  const store = new IamStore({ file: path.join(dir, 'iam.json') });
  for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(store.role(id), null, id);
    await assert.rejects(store.createUser({ email: `x-${id.replace(/_/g, '')}@acme.io`, role: id, password: 'correct horse battery' }), /role does not exist/, id);
    assert.throws(() => store.deleteRole(id, { actorPerms: new Set(PERMISSION_IDS) }), /No such role/, id);
    assert.throws(() => store.saveRole(id, { name: 'x', permissions: [] }, { actorPerms: new Set(PERMISSION_IDS) }), /No such role/, id);
  }
  assert.equal(Object.getPrototypeOf({}).polluted, undefined);
});
