// Gated languages: Hebrew appears only while a valid activation code is in force, and only for
// people whose role allows it (the caller passes what the role allows); a deactivation code (or
// expiry) removes it. Open languages are always available.
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

test('a Hebrew activation code switches it on, for the roles that allow it, until the code expires', () => {
  const f = file();
  const access = new LanguageAccess({ file: f });
  access.apply(activate(Date.now() + 365 * DAY), { by: 'admin' });
  assert.equal(access.status('he').on, true);
  assert.equal(access.isOn('he'), true);
  assert.equal(access.isAvailable('he', ['he']), true, 'for someone whose role allows it');
  assert.ok(access.available(['he']).includes('he'));
  assert.equal(access.isAvailable('he', []), false, 'not for anyone else');
  assert.equal(access.isAvailable('he'), false, 'nor without a role');
  // Persisted: a fresh instance reading the same file sees the same.
  assert.equal(new LanguageAccess({ file: f }).isAvailable('he', ['he']), true);
  // Past the code's expiry it drops off on its own, without a deactivation code.
  assert.equal(access.isAvailable('he', ['he'], Date.now() + 400 * DAY), false);
  assert.equal(access.isOn('he', Date.now() + 400 * DAY), false);
});

test('a list of people kept by MZ-01.00.58 to 62 is no longer what decides', () => {
  const f = file();
  fs.writeFileSync(f, JSON.stringify({ gated: { he: { on: true, org: 'Acme', expires: new Date(Date.now() + 100 * DAY).toISOString(), users: [] } } }));
  const access = new LanguageAccess({ file: f });
  assert.equal(access.isAvailable('he', ['he']), true, 'on for nobody before; on for the roles that allow it now');
  assert.equal('users' in access.status('he'), false);
});

test('a deactivation code turns it off, even if the code itself is out of date', () => {
  const access = new LanguageAccess({ file: file() });
  access.apply(activate(Date.now() + 365 * DAY));
  assert.equal(access.isAvailable('he', ['he']), true);
  access.apply(deactivate(false));
  assert.equal(access.isAvailable('he', ['he']), false);
  assert.equal(access.status('he').on, false);
});

test('an expired activation code cannot switch it on, and non-language codes are refused', () => {
  const access = new LanguageAccess({ file: file() });
  assert.throws(() => access.apply(activate(Date.now() - DAY)), /not valid/);
  assert.throws(() => access.apply({ valid: true, scope: 'tenants', maxTenants: 3 }), /does not unlock a language/);
  assert.equal(access.isAvailable('he'), false);
});
