// Labs per role (MZ-01.01.09): Labs itself and each item in it are permissions of their own; Labs shows only
// while one of its items is turned on for the person; roles an older version saved keep what they could use.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_ROLES, IamStore, LABS_ITEM_PERMISSIONS, PERMISSIONS } from '../src/iam.js';
import { FEATURES, inLabs, LABS_FEATURES, LABS_VIEW, labsPermission, mayUse } from '../src/features.js';

test('Labs and every item in it have a permission of their own, in one Labs group', () => {
  const labs = PERMISSIONS.filter((p) => p.id.startsWith('labs.'));
  assert.deepEqual(labs.map((p) => p.id), [LABS_VIEW, ...LABS_ITEM_PERMISSIONS]);
  assert.ok(labs.every((p) => p.group === 'Labs' && p.label && p.description && !p.special && !p.adminOnly), 'any role may be given them');
  assert.deepEqual(LABS_FEATURES.map(labsPermission).sort(), [...LABS_ITEM_PERMISSIONS].sort(), 'one for each Labs feature');
  assert.deepEqual(FEATURES.filter((f) => !f.labs).map((f) => f.id), ['sla'], 'SLAs live in Settings, not Labs');
});

test('in Labs while Beta; FAE Flush and Govern leave it once final, the others stay', () => {
  const final = (id) => ({ features: { [id]: { stage: 'final' } } });
  for (const id of LABS_FEATURES) assert.equal(inLabs({}, id), true, id);
  assert.equal(inLabs(final('faeFlush'), 'faeFlush'), false);
  assert.equal(inLabs(final('govern'), 'govern'), false);
  assert.equal(inLabs(final('statusBoard'), 'statusBoard'), true);
  assert.equal(inLabs({}, 'sla'), false);
});

test('every Labs item needs both Labs and its own permission while in Beta', () => {
  for (const id of LABS_FEATURES) {
    const own = labsPermission(id);
    const extra = id === 'consolidated' ? ['consolidated.view'] : [];
    assert.equal(mayUse({}, id, new Set([LABS_VIEW, own, ...extra])), true, id);
    assert.equal(mayUse({}, id, new Set([own, ...extra])), false, `${id} without Labs`);
    assert.equal(mayUse({}, id, new Set([LABS_VIEW, ...extra, 'beta.use', 'findings.fetch', 'govern.view', 'govern.request', 'integration.cxone'])), false, `${id} without its own`);
  }
});

test('new installations: Admin and Security Analyst have every Labs item; User and Security Champion the Status board and Govern', () => {
  const store = new IamStore({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'labs-new-')), 'iam.json') });
  for (const id of ['admin', 'analyst']) for (const p of [LABS_VIEW, ...LABS_ITEM_PERMISSIONS]) assert.ok(store.role(id).permissions.includes(p), `${id}: ${p}`);
  for (const id of ['user', 'champion']) assert.deepEqual(store.role(id).permissions.filter((p) => p.startsWith('labs.')).sort(), ['labs.govern', 'labs.statusBoard', 'labs.view']);
  assert.ok(DEFAULT_ROLES.user.permissions.includes('labs.view'));
});

test('MZ-01.01.09, once, on roles an older version saved: each role keeps the Labs items it could use', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'labs-mig-')), 'iam.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    migrations: ['roles-1.0.63', 'roles-govern'],
    users: [{ id: 'u1', email: 'ana@acme.io', role: 'role-ops', consolidated: true }],
    roles: {
      analyst: { permissions: ['findings.fetch', 'beta.use', 'govern.view'] },
      user: { permissions: ['findings.fetch', 'reports.view', 'govern.request'] },
      champion: { permissions: ['govern.view', 'govern.approve'] },
      'role-ops': { name: 'Ops', permissions: ['reports.view'] },
      'role-audit': { name: 'Auditors', permissions: ['audit.view'] },
    },
  }));
  const iam = new IamStore({ file });
  const labs = (id) => iam.role(id).permissions.filter((p) => p.startsWith('labs.')).sort();
  assert.deepEqual(labs('analyst'), [LABS_VIEW, ...LABS_ITEM_PERMISSIONS].sort(), 'Beta features gave every Labs item');
  assert.deepEqual(labs('user'), ['labs.govern', 'labs.statusBoard', 'labs.view'], 'Fetch findings the board, a Govern permission Govern');
  assert.deepEqual(labs('champion'), ['labs.govern', 'labs.view']);
  assert.deepEqual(labs('role-ops'), ['labs.consolidated', 'labs.view'], 'someone in it was ticked for the consolidated view');
  assert.deepEqual(labs('role-audit'), [], 'nothing in Labs before: nothing now');
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).migrations.includes('roles-labs'), 'kept, so it is made once');
  // Made once: an item taken off afterwards stays off.
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.roles.user.permissions = raw.roles.user.permissions.filter((p) => p !== 'labs.statusBoard');
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.ok(!new IamStore({ file }).role('user').permissions.includes('labs.statusBoard'));
});
