import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_SETTINGS,
  SettingsStore,
  applyEnvironmentSmtp,
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

test('the product is CxMissionZero; an earlier default name saved by auto-save becomes it, a chosen name stays', () => {
  assert.equal(DEFAULT_SETTINGS.branding.appName, 'CxMissionZero');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cxdr-'));
  const load = (appName) => {
    const file = path.join(dir, `${appName.replace(/\W/g, '')}.json`);
    fs.writeFileSync(file, JSON.stringify({ branding: { appName, companyName: 'Acme' } }));
    return new SettingsStore({ file }).get().branding;
  };
  assert.equal(load('Mission Zero').appName, 'CxMissionZero');
  assert.equal(load('Detection Date Reminder').appName, 'CxMissionZero');
  assert.equal(load('Acme AppSec').appName, 'Acme AppSec');
  assert.equal(load('Mission Zero').companyName, 'Acme', 'the rest of the branding is kept');
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

test('tagging one initiator must not clear the others', () => {
  const store = new SettingsStore({ file: tempFile() });
  store.save({ initiators: { overrides: 'alice = alice@x.com\nbob = bob@x.com' } });

  // How the tag endpoint saves: current overrides spread, plus the new one.
  const current = store.get().initiators.overrides;
  const after = store.save({ initiators: { overrides: { ...current, carl: 'carl@x.com' } } });

  assert.deepEqual(after.initiators.overrides, {
    alice: 'alice@x.com',
    bob: 'bob@x.com',
    carl: 'carl@x.com',
  });
});

test('an override survives a restart and other settings are untouched', () => {
  const file = tempFile();
  const store = new SettingsStore({ file });
  store.save({ smtp: { host: 'smtp.example.com' }, initiators: { overrides: { jdoe: 'jane@x.com' } } });

  const reloaded = new SettingsStore({ file }).get();
  assert.equal(reloaded.initiators.overrides.jdoe, 'jane@x.com');
  assert.equal(reloaded.smtp.host, 'smtp.example.com');
  assert.equal(reloaded.initiators.useDirectory, true, 'unrelated defaults stay put');
});

test('SMTP values from the environment are trimmed and unquoted', () => {
  const saved = { ...process.env };
  try {
    process.env.SMTP_HOST = ' "smtp.gmail.com" \r';
    process.env.SMTP_USER = 'me@gmail.com \r';
    process.env.SMTP_PASS = 'abcd efgh ijkl mnop\r';
    process.env.SMTP_PORT = '587\r';
    const applied = applyEnvironmentSmtp(base());
    assert.equal(applied.smtp.host, 'smtp.gmail.com');
    assert.equal(applied.smtp.user, 'me@gmail.com');
    assert.equal(applied.smtp.password, 'abcd efgh ijkl mnop');
    assert.equal(applied.smtp.port, 587);
  } finally {
    for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PORT']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test('the browser icon: MZ0 by default; an uploaded image (up to 100 KB) or an https address; anything else refused', () => {
  assert.equal(base().branding.iconUrl, '', 'empty: CxMissionZero\'s own MZ0');
  const png = `data:image/png;base64,${Buffer.from('fake png').toString('base64')}`;
  assert.equal(mergeSettings(base(), { branding: { iconUrl: png } }).branding.iconUrl, png);
  assert.equal(mergeSettings(base(), { branding: { iconUrl: 'https://acme.com/icon.svg' } }).branding.iconUrl, 'https://acme.com/icon.svg');
  const ico = `data:image/x-icon;base64,${Buffer.from('ico').toString('base64')}`;
  assert.equal(mergeSettings(base(), { branding: { iconUrl: ico } }).branding.iconUrl, ico);
  for (const bad of ['http://acme.com/icon.png', 'javascript:alert(1)', 'data:text/html;base64,PGI+', `data:image/png;base64,${'A'.repeat(150_000)}`]) {
    assert.throws(() => mergeSettings(base(), { branding: { iconUrl: bad } }), /browser icon/, bad.slice(0, 30));
  }
  const set = mergeSettings(base(), { branding: { iconUrl: png } });
  assert.equal(mergeSettings(set, { branding: { iconUrl: '' } }).branding.iconUrl, '', 'back to MZ0');
  assert.equal(mergeSettings(set, { branding: { appName: 'X' } }).branding.iconUrl, png, 'other branding changes keep it');
});
