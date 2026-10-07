// Gated languages: Hebrew appears only while a valid activation code is in force, and only for
// the people an Admin chose; a deactivation code (or expiry) removes it. Open languages are always available.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LanguageAccess, OPEN_LANGUAGES } from '../src/languages.js';

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lang-')), 'languages.json');
const DAY = 86_400_000;
// checkCode marks an activate code past its expiry invalid; mirror that here.
const activate = (expires) => ({ valid: expires > Date.now(), expired: expires <= Date.now(), scope: 'lang:he', action: 'activate', org: 'Acme', expires: new Date(expires).toISOString() });
const deactivate = (valid = true) => ({ valid, scope: 'lang:he', action: 'deactivate', org: 'Acme', expires: new Date(Date.now() - DAY).toISOString() });

test('open languages are always available; Hebrew is not until activated', () => {
  const access = new LanguageAccess({ file: file() });
  for (const code of OPEN_LANGUAGES) assert.equal(access.isAvailable(code), true);
  assert.equal(access.isAvailable('he'), false);
  assert.ok(!access.available().includes('he'));
});

test('a Hebrew activation code switches it on, for the people chosen, until the code expires', () => {
  const f = file();
  const access = new LanguageAccess({ file: f });
  access.apply(activate(Date.now() + 365 * DAY), { by: 'admin' });
  assert.equal(access.status('he').on, true);
  assert.deepEqual(access.status('he').users, ['admin'], 'a new code starts with the Admin who applied it');
  assert.equal(access.isAvailable('he', 'admin'), true, 'so it is never on with nobody able to see it');
  assert.equal(access.isAvailable('he', 'u1'), false);
  access.setUsers('he', ['u1', 'u2', 'u1']);
  assert.deepEqual(access.status('he').users, ['u1', 'u2']);
  assert.equal(access.isAvailable('he', 'u1'), true);
  assert.ok(access.available('u2').includes('he'));
  assert.equal(access.isAvailable('he', 'u3'), false, 'not for anyone else');
  assert.equal(access.isAvailable('he'), false, 'nor without a person');
  // Persisted: a fresh instance reading the same file sees the same.
  assert.equal(new LanguageAccess({ file: f }).isAvailable('he', 'u1'), true);
  // Past the code's expiry it drops off on its own, without a deactivation code.
  assert.equal(access.isAvailable('he', 'u1', Date.now() + 400 * DAY), false);
  // A renewed code keeps the people chosen, whoever applies it.
  access.apply(activate(Date.now() + 700 * DAY), { by: 'someone-else' });
  assert.deepEqual(access.status('he').users, ['u1', 'u2']);
  // Emptied on purpose by an Admin: a renewal keeps it empty.
  access.setUsers('he', []);
  access.apply(activate(Date.now() + 800 * DAY), { by: 'admin' });
  assert.deepEqual(access.status('he').users, []);
});

test('Hebrew left on for nobody by an older version is given to the Admin who applied it; a list emptied on purpose is not', () => {
  const f = file();
  const expires = new Date(Date.now() + 100 * DAY).toISOString();
  fs.writeFileSync(f, JSON.stringify({ gated: { he: { on: true, org: 'Acme', expires, users: [] } } }));
  const access = new LanguageAccess({ file: f });
  assert.equal(access.isAvailable('he', 'admin'), false, 'the old state: on, and nobody sees it');
  assert.equal(access.adopt('he', 'admin'), true);
  assert.deepEqual(access.status('he').users, ['admin']);
  assert.equal(new LanguageAccess({ file: f }).isAvailable('he', 'admin'), true, 'kept');
  assert.equal(access.adopt('he', 'other'), false, 'only while nobody is chosen');
  access.setUsers('he', []);
  assert.equal(access.adopt('he', 'admin'), false, 'an Admin chose nobody on purpose');
  assert.equal(new LanguageAccess({ file: file() }).adopt('he', 'admin'), false, 'nothing to adopt when it is off');
});

test('Hebrew turned on before people could be chosen stays open to everyone until people are chosen', () => {
  const f = file();
  fs.writeFileSync(f, JSON.stringify({ gated: { he: { on: true, org: 'Acme', expires: new Date(Date.now() + 100 * DAY).toISOString() } } }));
  const access = new LanguageAccess({ file: f });
  assert.equal(access.status('he').users, null);
  assert.equal(access.isAvailable('he', 'anyone'), true);
  access.setUsers('he', ['u1']);
  assert.equal(access.isAvailable('he', 'anyone'), false);
  assert.throws(() => new LanguageAccess({ file: file() }).setUsers('he', ['u1']), /Turn the language on/);
});

test('a deactivation code turns it off, even if the code itself is out of date', () => {
  const access = new LanguageAccess({ file: file() });
  access.apply(activate(Date.now() + 365 * DAY));
  access.setUsers('he', ['u1']);
  assert.equal(access.isAvailable('he', 'u1'), true);
  access.apply(deactivate(false));
  assert.equal(access.isAvailable('he', 'u1'), false);
  assert.equal(access.status('he').on, false);
});

test('an expired activation code cannot switch it on, and non-language codes are refused', () => {
  const access = new LanguageAccess({ file: file() });
  assert.throws(() => access.apply(activate(Date.now() - DAY)), /not valid/);
  assert.throws(() => access.apply({ valid: true, scope: 'tenants', maxTenants: 3 }), /does not unlock a language/);
  assert.equal(access.isAvailable('he'), false);
});
