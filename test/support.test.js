import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeSupport, supportChannel } from '../src/settings.js';

test('Get help: the settings win, then SUPPORT_MODE / SUPPORT_EMAIL, then the portal; email mode needs an address', () => {
  assert.deepEqual(supportChannel({}, {}), { mode: 'portal', email: '', chosen: '' });
  assert.deepEqual(supportChannel({}, { SUPPORT_MODE: 'email', SUPPORT_EMAIL: 'help@vendor.io' }), { mode: 'email', email: 'help@vendor.io', chosen: '' });
  assert.equal(supportChannel({}, { SUPPORT_MODE: 'email' }).mode, 'portal', 'no address: the portal');
  assert.equal(supportChannel({ support: { mode: 'portal', email: '' } }, { SUPPORT_MODE: 'email', SUPPORT_EMAIL: 'help@vendor.io' }).mode, 'portal', 'an Admin chose the portal');
  assert.deepEqual(supportChannel({ support: { mode: 'email', email: 'it@acme.io' } }, { SUPPORT_EMAIL: 'help@vendor.io' }), { mode: 'email', email: 'it@acme.io', chosen: 'email' });
  assert.throws(() => mergeSupport({}, { mode: 'fax' }), /portal or email/);
  assert.throws(() => mergeSupport({}, { email: 'nope' }), /one email address/);
  assert.deepEqual(mergeSupport({}, { mode: 'email', email: ' it@acme.io ' }), { mode: 'email', email: 'it@acme.io' });
});
