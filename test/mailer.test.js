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
