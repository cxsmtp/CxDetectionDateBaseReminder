import test from 'node:test';
import assert from 'node:assert/strict';

import { MailError, fromAddress, sendReminderMail } from '../src/mailer.js';
import { DEFAULT_SETTINGS, mergeSettings, smtpFingerprint } from '../src/settings.js';

const verified = (over = {}) => {
  const settings = mergeSettings(structuredClone(DEFAULT_SETTINGS), {
    smtp: { host: 'smtp.example.com', user: 'me', password: 'pw', fromAddress: 'sec@example.com' },
    recipients: { to: 'team@example.com' },
    ...over,
  });
  return { ...settings, verifiedAt: '2026-09-17T00:00:00Z', verifiedFingerprint: smtpFingerprint(settings.smtp) };
};

const message = { subject: 'Reminder', html: '<p>hi</p>', text: 'hi' };

test('fromAddress quotes the display name and falls back to the auth user', () => {
  assert.equal(
    fromAddress({ fromName: 'Checkmarx Reminders', fromAddress: 'a@x.com' }),
    '"Checkmarx Reminders" <a@x.com>',
  );
  assert.equal(fromAddress({ fromName: '', fromAddress: 'a@x.com' }), 'a@x.com');
  assert.equal(fromAddress({ fromName: '', fromAddress: '', user: 'u@x.com' }), 'u@x.com');
  assert.equal(fromAddress({ fromName: '', fromAddress: '', user: '' }), '');
  // A stray quote in the display name must not break the header.
  assert.equal(fromAddress({ fromName: 'A"B', fromAddress: 'a@x.com' }), '"AB" <a@x.com>');
});

test('sending is refused until the current SMTP settings have passed a test', async () => {
  const unverified = mergeSettings(structuredClone(DEFAULT_SETTINGS), {
    smtp: { host: 'smtp.example.com', fromAddress: 'a@x.com' },
    recipients: { to: 'team@example.com' },
  });

  await assert.rejects(sendReminderMail(unverified, message), (error) => {
    assert.ok(error instanceof MailError);
    assert.match(error.message, /Test the SMTP connection/);
    return true;
  });
});

test('a settings change after a passing test re-locks sending', async () => {
  const settings = verified();
  const changed = mergeSettings(settings, { smtp: { host: 'moved.example.com' } });

  await assert.rejects(sendReminderMail(changed, message), /Test the SMTP connection/);
});

test('sending is refused when no recipient is configured anywhere', async () => {
  const settings = verified({ recipients: { to: '' } });
  await assert.rejects(sendReminderMail(settings, message), /No recipients are configured/);
});

test('sending is refused without a From address', async () => {
  const base = mergeSettings(structuredClone(DEFAULT_SETTINGS), {
    smtp: { host: 'smtp.example.com', requireAuth: false, user: '', fromAddress: '' },
    recipients: { to: 'team@example.com' },
  });
  const settings = { ...base, verifiedAt: 'x', verifiedFingerprint: smtpFingerprint(base.smtp) };

  await assert.rejects(sendReminderMail(settings, message), /No From address is configured/);
});

test('per-send recipient overrides are used in place of the stored list', async () => {
  const settings = verified();
  // No SMTP server is listening, so this fails at connect -- after the
  // recipient checks, which is what this asserts.
  await assert.rejects(
    sendReminderMail(settings, message, { to: ['override@example.com'] }),
    (error) => {
      assert.ok(!/No recipients/.test(error.message), 'overrides should satisfy the recipient check');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// TLS mode

test('tlsModeMismatch catches implicit TLS on a STARTTLS port and the reverse', async () => {
  const { tlsModeMismatch } = await import('../src/mailer.js');

  // The reported case: smtp.gmail.com:587 with Implicit TLS switched on.
  assert.match(tlsModeMismatch({ port: 587, secure: true }), /expects STARTTLS/);
  assert.match(tlsModeMismatch({ port: 25, secure: true }), /expects STARTTLS/);
  assert.match(tlsModeMismatch({ port: 465, secure: false }), /TLS from the first byte/);

  // Correct pairings, and a non-standard port we should not second-guess.
  assert.equal(tlsModeMismatch({ port: 587, secure: false }), '');
  assert.equal(tlsModeMismatch({ port: 465, secure: true }), '');
  assert.equal(tlsModeMismatch({ port: 1025, secure: true }), '');
  assert.equal(tlsModeMismatch({ port: '587', secure: true }) === '', false, 'string ports count too');
});

test('a stalled handshake on a mismatched port names the mismatch, not the firewall', async () => {
  // Port 465 with implicit TLS off, pointed at a port that never answers:
  // the timeout must be explained by the mismatch rather than blamed on the
  // network, which is what made the original report hard to act on.
  const settings = verified({ smtp: { host: '127.0.0.1', port: 465, secure: false } });

  await assert.rejects(sendReminderMail(settings, message), (error) => {
    assert.ok(error instanceof MailError);
    assert.doesNotMatch(error.message, /check the host, port and any firewall/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Credentials

test('a Gmail App Password pasted with spaces is accepted as typed', async () => {
  const { normalizePassword } = await import('../src/mailer.js');
  const gmail = (password) => normalizePassword({ host: 'smtp.gmail.com', password });

  // Google displays App Passwords as four groups of four.
  assert.equal(gmail('abcd efgh ijkl mnop'), 'abcdefghijklmnop');
  assert.equal(gmail(' abcdefghijklmnop '), 'abcdefghijklmnop');
  assert.equal(gmail('abcdefghijklmnop'), 'abcdefghijklmnop');
  assert.equal(normalizePassword({ host: 'smtp.googlemail.com', password: 'abcd efgh ijkl mnop' }), 'abcdefghijklmnop');
});

test('passwords that are not App Passwords are never altered', async () => {
  const { normalizePassword } = await import('../src/mailer.js');

  // A real passphrase on Gmail: not 16 alphanumerics once stripped, so left alone.
  assert.equal(normalizePassword({ host: 'smtp.gmail.com', password: 'correct horse battery' }), 'correct horse battery');
  // Any other server may legitimately use spaces in a secret.
  assert.equal(normalizePassword({ host: 'smtp.corp.example', password: 'a b c d' }), 'a b c d');
  assert.equal(normalizePassword({ host: 'smtp.corp.example', password: 'abcd efgh ijkl mnop' }), 'abcd efgh ijkl mnop');
  // A lookalike host must not be treated as Google.
  assert.equal(normalizePassword({ host: 'smtp.gmail.com.evil.io', password: 'abcd efgh ijkl mnop' }), 'abcd efgh ijkl mnop');
  assert.equal(normalizePassword({ host: 'smtp.gmail.com', password: '' }), '');
});
