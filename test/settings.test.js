import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_SETTINGS,
  SettingsStore,
  isVerified,
  mergeSettings,
  parseAddressList,
  publicSettings,
  smtpFingerprint,
} from '../src/settings.js';

const tempFile = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cxdr-')), 'settings.json');

const base = () => structuredClone(DEFAULT_SETTINGS);

test('parseAddressList accepts every separator and drops invalid entries', () => {
  assert.deepEqual(parseAddressList('a@x.com, b@x.com'), ['a@x.com', 'b@x.com']);
  assert.deepEqual(parseAddressList('a@x.com\nb@x.com;c@x.com'), ['a@x.com', 'b@x.com', 'c@x.com']);
  assert.deepEqual(parseAddressList(['a@x.com', 'nope', '']), ['a@x.com']);
  assert.deepEqual(parseAddressList('a@x.com a@x.com'), ['a@x.com'], 'duplicates collapse');
  assert.deepEqual(parseAddressList(''), []);
  assert.deepEqual(parseAddressList(null), []);
});

test('an omitted password keeps the stored one; an explicit null clears it', () => {
  const current = mergeSettings(base(), { smtp: { password: 'secret' } });
  assert.equal(current.smtp.password, 'secret');

  // Saving an unrelated field must not wipe the credential.
  const kept = mergeSettings(current, { smtp: { host: 'smtp.example.com' } });
  assert.equal(kept.smtp.password, 'secret');
  assert.equal(mergeSettings(current, { smtp: { password: '' } }).smtp.password, 'secret');
  assert.equal(mergeSettings(current, { smtp: { password: null } }).smtp.password, '');
});

test('port is coerced into range and other fields are type-checked', () => {
  assert.equal(mergeSettings(base(), { smtp: { port: '2525' } }).smtp.port, 2525);
  assert.equal(mergeSettings(base(), { smtp: { port: 0 } }).smtp.port, 1);
  assert.equal(mergeSettings(base(), { smtp: { port: 99999 } }).smtp.port, 65535);
  assert.equal(mergeSettings(base(), { smtp: { port: 'abc' } }).smtp.port, 587);
  assert.equal(mergeSettings(base(), { smtp: { secure: 'yes' } }).smtp.secure, false);
  assert.equal(mergeSettings(base(), { smtp: { host: '  h  ' } }).smtp.host, 'h');
});

test('a risks path must be absolute, or it is ignored', () => {
  assert.equal(mergeSettings(base(), { endpoints: { risksPath: '/api/risks/' } }).endpoints.risksPath, '/api/risks/');
  assert.equal(mergeSettings(base(), { endpoints: { risksPath: 'api/risks' } }).endpoints.risksPath, '');
  assert.equal(
    mergeSettings(base(), { endpoints: { risksPath: 'https://evil.example.com/x' } }).endpoints.risksPath,
    '',
    'an absolute URL must not be accepted as a path',
  );
});

test('changing any connection field invalidates a previous successful test', () => {
  let settings = mergeSettings(base(), {
    smtp: { host: 'smtp.example.com', user: 'me', password: 'pw' },
  });
  settings = { ...settings, verifiedAt: '2026-09-17T00:00:00Z', verifiedFingerprint: smtpFingerprint(settings.smtp) };
  assert.equal(isVerified(settings), true);

  // Recipients and template are not connection details: the test survives.
  const cosmetic = mergeSettings(settings, { recipients: { to: 'a@x.com' } });
  assert.equal(isVerified(cosmetic), true);

  for (const change of [{ host: 'other' }, { port: 2525 }, { user: 'you' }, { password: 'new' }, { secure: true }]) {
    const changed = mergeSettings(settings, { smtp: change });
    assert.equal(isVerified(changed), false, `${JSON.stringify(change)} should clear verification`);
  }
});

test('the SMTP password never reaches the browser payload', () => {
  const settings = mergeSettings(base(), { smtp: { password: 'hunter2', user: 'me' } });
  const shown = publicSettings(settings);

  assert.equal(shown.smtp.password, undefined);
  assert.equal(shown.smtp.passwordSet, true);
  assert.ok(!JSON.stringify(shown).includes('hunter2'));
  assert.equal(publicSettings(base()).smtp.passwordSet, false);
});

test('settings round-trip through the file and are written owner-only', () => {
  const file = tempFile();
  const store = new SettingsStore({ file });

  store.save({
    smtp: { host: 'smtp.example.com', port: 2525, password: 'pw' },
    recipients: { to: 'a@x.com, b@x.com' },
    template: { subject: 'Hi {{tenant}}' },
  });

  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);

  const reloaded = new SettingsStore({ file }).get();
  assert.equal(reloaded.smtp.host, 'smtp.example.com');
  assert.equal(reloaded.smtp.port, 2525);
  assert.deepEqual(reloaded.recipients.to, ['a@x.com', 'b@x.com']);
  assert.equal(reloaded.template.subject, 'Hi {{tenant}}');
  // Fields the older file never had still come back present.
  assert.equal(reloaded.template.html, DEFAULT_SETTINGS.template.html);
});

test('a missing or corrupt settings file falls back to defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxdr-'));
  assert.deepEqual(new SettingsStore({ file: path.join(dir, 'nope.json') }).get(), DEFAULT_SETTINGS);

  const corrupt = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corrupt, '{ not json');
  assert.deepEqual(new SettingsStore({ file: corrupt }).get(), DEFAULT_SETTINGS);
});

test('markVerified pins the fingerprint of the settings in force', () => {
  const store = new SettingsStore({ file: tempFile() });
  store.save({ smtp: { host: 'smtp.example.com', password: 'pw' } });
  assert.equal(isVerified(store.get()), false);

  store.markVerified();
  assert.equal(isVerified(store.get()), true);

  store.save({ smtp: { host: 'elsewhere.example.com' } });
  assert.equal(isVerified(store.get()), false, 'a host change must force a retest');
});
