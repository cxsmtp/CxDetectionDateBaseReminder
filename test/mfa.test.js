// Two-step sign-in, piece by piece: the codes (RFC 6238's own test values), the key and the address an
// authenticator app takes, recovery codes, the tickets between the password and the code, what is kept
// with the person in iam.json, and the QR code (against matrices made by an independent encoder).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { IamStore } from '../src/iam.js';
import {
  PendingSetups, RECOVERY_CODES, SignInTickets, TICKET_MAX_WRONG, TICKET_TTL_MS, base32Decode, base32Encode, codeAt, groupedKey, matchTotp, newRecoveryCodes, newSecret,
  otpauthUri, recoveryHash, totp, totpStep, typedCode, typedRecoveryCode,
} from '../src/mfa.js';
import { QR_MAX_BYTES, qrMatrix, qrSvgPath } from '../public/qr.js';
import { lastGoodCopy } from '../src/state-file.js';

// RFC 6238, appendix B: the SHA-1 secret is the ASCII text "12345678901234567890"; the values there have 8 digits, a 6-digit code is their last six.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
const RFC_VALUES = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];

test('the codes are RFC 6238 codes: HMAC-SHA1, 30 seconds, six digits', () => {
  for (const [seconds, eight] of RFC_VALUES) assert.equal(totp(RFC_SECRET, seconds * 1000), eight.slice(2), `at ${seconds}`);
  assert.equal(totpStep(59_000), 1);
  assert.equal(codeAt(RFC_SECRET, 1), '287082');
});

test('base32 there and back, as authenticator apps write keys', () => {
  // RFC 4648's examples.
  for (const [plain, encoded] of [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']]) {
    assert.equal(base32Encode(Buffer.from(plain)), encoded);
    assert.equal(base32Decode(encoded).toString(), plain);
  }
  const bytes = randomBytes(20);
  assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
  assert.deepEqual(base32Decode(groupedKey(base32Encode(bytes)).toLowerCase()), bytes, 'spaces and lower case are fine');
  assert.throws(() => base32Decode('not base32!'));
  const secret = newSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/, '160 bits');
  assert.notEqual(secret, newSecret());
});

test('a code works for its own step, the one before and the one after; and only once', () => {
  const secret = newSecret();
  const now = 1_700_000_000_000;
  const step = totpStep(now);
  assert.equal(matchTotp(secret, codeAt(secret, step), { now }), step);
  assert.equal(matchTotp(secret, codeAt(secret, step - 1), { now }), step - 1, 'the step before');
  assert.equal(matchTotp(secret, codeAt(secret, step + 1), { now }), step + 1, 'the step after');
  assert.equal(matchTotp(secret, codeAt(secret, step - 2), { now }), 0, 'two steps back is too old');
  assert.equal(matchTotp(secret, codeAt(secret, step + 2), { now }), 0);
  assert.equal(matchTotp(secret, ` ${codeAt(secret, step).slice(0, 3)} ${codeAt(secret, step).slice(3)} `, { now }), step, 'typed as "123 456"');
  // Used once: nothing at or before the step of the last code used.
  assert.equal(matchTotp(secret, codeAt(secret, step), { now, after: step }), 0, 'the same code again');
  assert.equal(matchTotp(secret, codeAt(secret, step - 1), { now, after: step }), 0, 'an older code after a newer one was used');
  assert.equal(matchTotp(secret, codeAt(secret, step + 1), { now, after: step }), step + 1);
  for (const wrong of ['', '12345', '1234567', 'abcdef', null, undefined, 123456.5]) assert.equal(matchTotp(secret, wrong, { now }), 0, String(wrong));
  assert.equal(typedCode('12 34 56'), '123456');
  assert.equal(typedCode('ABCDE-FGHJK'), '');
});

test('the address for the authenticator app names the issuer and the person', () => {
  const secret = newSecret();
  const uri = new URL(otpauthUri('ada+test@acme.io', secret));
  assert.equal(uri.protocol, 'otpauth:');
  assert.equal(uri.host, 'totp');
  assert.equal(decodeURIComponent(uri.pathname), '/CxMissionZero:ada+test@acme.io');
  assert.deepEqual(Object.fromEntries(uri.searchParams), { secret, issuer: 'CxMissionZero', algorithm: 'SHA1', digits: '6', period: '30' });
});

test('recovery codes: ten, random, and only their hashes need keeping', () => {
  const codes = newRecoveryCodes();
  assert.equal(codes.length, RECOVERY_CODES);
  assert.equal(new Set(codes).size, RECOVERY_CODES);
  for (const code of codes) assert.match(code, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/, 'no letters or digits that look alike');
  const [code] = codes;
  assert.equal(recoveryHash('u1', code), recoveryHash('u1', code.toLowerCase().replace('-', ' ')), 'however it is typed');
  assert.notEqual(recoveryHash('u1', code), recoveryHash('u2', code), 'bound to the person');
  assert.doesNotMatch(recoveryHash('u1', code), new RegExp(code.replace('-', ''), 'i'));
  assert.equal(typedRecoveryCode('123456'), '', 'six digits is a code from the app, not a recovery code');
});

test('a ticket is for one person, five minutes and a few wrong codes; used once', () => {
  const tickets = new SignInTickets();
  const now = 1_000_000;
  const ticket = tickets.issue('ada', {}, now);
  assert.match(ticket, /^[A-Za-z0-9_-]{43}$/, '256 random bits');
  assert.deepEqual(tickets.get(ticket, now + 1), { userId: 'ada', secret: '', exp: now + TICKET_TTL_MS });
  assert.equal(tickets.get(`${ticket.slice(0, -1)}${ticket.endsWith('A') ? 'B' : 'A'}`, now), null, 'another ticket');
  assert.equal(tickets.get('', now), null);
  assert.equal(tickets.get({ toString: () => ticket }, now), null, 'only a text');
  assert.equal(tickets.get(ticket, now + TICKET_TTL_MS), null, 'over after five minutes');
  assert.equal(tickets.size, 0);

  const second = tickets.issue('ada', { secret: 'KEY' }, now);
  assert.equal(tickets.get(second, now).secret, 'KEY');
  for (let i = 1; i < TICKET_MAX_WRONG; i += 1) assert.equal(tickets.wrong(second), TICKET_MAX_WRONG - i);
  assert.ok(tickets.get(second, now), 'still good after four wrong codes');
  assert.equal(tickets.wrong(second), 0);
  assert.equal(tickets.get(second, now), null, 'over after the fifth');

  const third = tickets.issue('ada', {}, now);
  assert.equal(tickets.consume(third), true);
  assert.equal(tickets.get(third, now), null, 'used: never again');

  const a = tickets.issue('ada', {}, now);
  const b = tickets.issue('bob', {}, now);
  tickets.revokeUser('ada');
  assert.equal(tickets.get(a, now), null);
  assert.ok(tickets.get(b, now), 'someone else\'s is left');
});

test('tickets never pile up: a few a person, and a limit in all', () => {
  const tickets = new SignInTickets({ max: 10 });
  const mine = Array.from({ length: 6 }, () => tickets.issue('ada'));
  assert.equal(mine.filter((t) => tickets.get(t)).length, 3, 'the oldest of one person go first');
  for (let i = 0; i < 50; i += 1) tickets.issue(`user-${i}`);
  assert.ok(tickets.size <= 10, `${tickets.size} kept`);
});

test('a secret shown to someone signed in waits ten minutes for its first code', () => {
  const pending = new PendingSetups();
  const secret = pending.start('ada', 0);
  assert.equal(pending.get('ada', 1), secret);
  assert.equal(pending.get('bob', 1), '');
  assert.notEqual(pending.start('ada', 2), secret, 'starting again makes a new one');
  assert.equal(pending.get('ada', 11 * 60_000), '', 'too old');
  pending.clear('ada');
  assert.equal(pending.get('ada', 3), '');
});

/** A code the app would not show at `now`, nor a step or two either side. */
function wrongCode(secret, now = Date.now()) {
  const step = totpStep(now);
  const good = new Set([-2, -1, 0, 1, 2].map((d) => codeAt(secret, step + d)));
  for (let n = 0; ; n += 1) {
    const code = String(n).padStart(6, '0');
    if (!good.has(code)) return code;
  }
}

// --- What is kept with the person (iam.json) -----------------------------------------------

async function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfa-'));
  const file = path.join(dir, 'iam.json');
  const iam = new IamStore({ file });
  const password = `pw-${randomBytes(12).toString('base64url')}`;
  const ada = await iam.createUser({ email: 'ada@acme.io', role: 'admin', password, mustChangePassword: false });
  return { iam, file, ada, password };
}

test('turned on: the secret is in iam.json (owner only), the recovery codes only as hashes, and nothing of either reaches the page', async () => {
  const { iam, file, ada } = await store();
  const secret = newSecret();
  const codes = newRecoveryCodes();
  const shown = iam.enableTwoStep(ada.id, secret, { step: 5, recovery: codes.map((c) => recoveryHash(ada.id, c)) });
  assert.equal(shown.twoStep, true);
  assert.ok(shown.twoStepSince);
  assert.doesNotMatch(JSON.stringify(iam.users()), new RegExp(secret), 'never in what the page gets');
  const onDisk = fs.readFileSync(file, 'utf8');
  assert.match(onDisk, new RegExp(secret), 'the server must be able to work the code out');
  for (const code of codes) assert.doesNotMatch(onDisk, new RegExp(code.replace('-', '.?')), 'recovery codes are not kept');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // Another process (the server after a restart) reads it back.
  assert.equal(new IamStore({ file }).user(ada.id).mfa.secret, secret);
});

test('a code signs in once; a wrong one counts like a wrong password and five lock the account', async () => {
  const { iam, ada } = await store();
  const secret = newSecret();
  const now = Date.now();
  iam.enableTwoStep(ada.id, secret, { step: totpStep(now) - 5, recovery: [] });
  assert.deepEqual(iam.checkTwoStep(ada.id, totp(secret, now), { now }), { kind: 'code', left: 0 });
  assert.throws(() => iam.checkTwoStep(ada.id, totp(secret, now), { now }), { status: 401 }, 'the same code a second time');
  assert.equal(iam.user(ada.id).failedLogins, 1);
  const wrong = wrongCode(secret, now);
  for (let i = 0; i < 3; i += 1) assert.throws(() => iam.checkTwoStep(ada.id, wrong, { now }), { status: 401, locked: false });
  assert.throws(() => iam.checkTwoStep(ada.id, wrong, { now }), { status: 401, locked: true }, 'the fifth wrong one locks');
  assert.throws(() => iam.checkTwoStep(ada.id, totp(secret, now + 30_000), { now }), { status: 423 }, 'locked: even a right code waits');
  assert.equal(iam.users()[0].locked, true);
  assert.deepEqual(iam.checkTwoStep(ada.id, totp(secret, now + 16 * 60_000), { now: now + 16 * 60_000 }), { kind: 'code', left: 0 }, 'a quarter of an hour later');
});

test('the password step does not count as signed in while a second step is to come', async () => {
  const { iam, ada, password } = await store();
  const secret = newSecret();
  iam.enableTwoStep(ada.id, secret, { recovery: [] });
  assert.throws(() => iam.checkTwoStep(ada.id, wrongCode(secret)), { status: 401 });
  const user = await iam.signIn('ada@acme.io', password, Date.now(), { more: (u) => Boolean(u.mfa?.secret) });
  assert.equal(user.lastLoginAt, '', 'not signed in yet');
  assert.equal(user.failedLogins, 1, 'wrong codes keep counting across password tries');
  await iam.signIn('ada@acme.io', password);
  assert.ok(iam.user(ada.id).lastLoginAt, 'without a second step it is a sign-in, as before');
  assert.equal(iam.user(ada.id).failedLogins, 0);
});

test('a recovery code works once, is gone from the disk and from its last good copy, and can be switched off', async () => {
  const { iam, file, ada } = await store();
  const codes = newRecoveryCodes();
  iam.enableTwoStep(ada.id, newSecret(), { recovery: codes.map((c) => recoveryHash(ada.id, c)) });
  const used = recoveryHash(ada.id, codes[3]);
  assert.match(fs.readFileSync(file, 'utf8'), new RegExp(used));
  assert.throws(() => iam.checkTwoStep(ada.id, codes[3], { recovery: false }), { status: 401 }, 'where only a code from the app will do');
  assert.deepEqual(iam.checkTwoStep(ada.id, codes[3].toLowerCase()), { kind: 'recovery', left: RECOVERY_CODES - 1 });
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), new RegExp(used));
  assert.equal(fs.existsSync(lastGoodCopy(file)), false, 'no copy of the file before keeps the used code');
  assert.throws(() => iam.checkTwoStep(ada.id, codes[3]), { status: 401 }, 'never twice');
  assert.throws(() => iam.checkTwoStep(ada.id, newRecoveryCodes(1)[0]), { status: 401 });
  const fresh = newRecoveryCodes();
  iam.setRecoveryCodes(ada.id, fresh.map((c) => recoveryHash(ada.id, c)));
  assert.throws(() => iam.checkTwoStep(ada.id, codes[0]), { status: 401 }, 'the old ones stop working');
  assert.equal(iam.checkTwoStep(ada.id, fresh[0]).kind, 'recovery');
});

test('reset: the secret is gone from iam.json and no last good copy keeps it', async () => {
  const { iam, file, ada } = await store();
  const secret = newSecret();
  iam.enableTwoStep(ada.id, secret, { recovery: [recoveryHash(ada.id, newRecoveryCodes(1)[0])] });
  iam.updateProfile(ada.id, { name: 'Ada' }); // one more save, so the copy of the file before holds the secret
  assert.match(fs.readFileSync(lastGoodCopy(file), 'utf8'), new RegExp(secret), 'the test means something: the copy held it');
  assert.equal(iam.resetTwoStep(ada.id), true);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), new RegExp(secret));
  assert.equal(fs.existsSync(lastGoodCopy(file)), false);
  assert.equal(iam.users()[0].twoStep, false);
  assert.equal(iam.resetTwoStep(ada.id), false, 'nothing to reset a second time');
  assert.throws(() => iam.checkTwoStep(ada.id, '123456'), { status: 400 });
});

test('"two-step sign-in for everyone" is off until an Admin turns it on, and is kept', async () => {
  const { iam, file } = await store();
  assert.equal(iam.twoStepRequired(), false);
  assert.deepEqual(iam.setTwoStepRequired(true), { before: false, after: true });
  assert.equal(new IamStore({ file }).twoStepRequired(), true);
  assert.equal(new IamStore({ file }).passwordResetPolicy(), 'everyone', 'the other sign-in rules are untouched');
});

// --- The QR code ------------------------------------------------------------------------------

const reference = JSON.parse(fs.readFileSync(new URL('./fixtures/qr-reference.json', import.meta.url), 'utf8'));
const hexRows = (modules) =>
  modules.map((row) => {
    const bits = row.map((dark) => (dark ? '1' : '0')).join('');
    const padded = bits + '0'.repeat((4 - (bits.length % 4)) % 4);
    return padded.match(/.{4}/g).map((nibble) => parseInt(nibble, 2).toString(16)).join('');
  });

test('the QR code is, square for square, what an independent encoder makes: every version from 1 to 20', () => {
  const versions = new Set();
  let compared = 0;
  for (const code of reference.codes) {
    for (const [mask, rows] of Object.entries(code.masks)) {
      const made = qrMatrix(code.text, { mask: Number(mask) });
      assert.equal(made.version, code.version, `version for ${code.text.length} characters`);
      assert.equal(made.size, code.size);
      assert.deepEqual(hexRows(made.modules), rows, `version ${code.version}, mask ${mask}`);
      compared += 1;
    }
    versions.add(code.version);
  }
  assert.deepEqual([...versions].sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.ok(compared >= 40, `${compared} codes compared`);
  assert.ok(reference.codes.some((c) => c.text.startsWith('otpauth://') && Object.keys(c.masks).length === 8), 'an authenticator address, in all eight masks');
});

test('the mask chosen is one of the eight, and the picture has the quiet border around it', () => {
  const uri = otpauthUri('ada@acme.io', newSecret());
  const made = qrMatrix(uri);
  assert.ok(made.mask >= 0 && made.mask <= 7);
  assert.deepEqual(qrMatrix(uri, { mask: made.mask }).modules, made.modules);
  const { side, viewBox, d } = qrSvgPath(uri);
  assert.equal(side, made.size + 8);
  assert.equal(viewBox, `0 0 ${side} ${side}`);
  assert.match(d, /^(M\d+ \d+h\d+v1h-\d+z)+$/);
  // Every dark square is in the path, none outside the code.
  const dark = made.modules.flat().filter(Boolean).length;
  assert.equal([...d.matchAll(/h(\d+)v1/g)].reduce((sum, m) => sum + Number(m[1]), 0), dark);
  assert.throws(() => qrMatrix('x'.repeat(QR_MAX_BYTES + 1)), RangeError);
  assert.equal(qrMatrix('x'.repeat(QR_MAX_BYTES)).version, 20);
  // The longest email there can be still fits.
  assert.ok(qrMatrix(otpauthUri(`${'a'.repeat(242)}@example.com`, newSecret())).version <= 20);
});
