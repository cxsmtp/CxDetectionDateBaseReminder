// Outbound connections to mail servers and network checks: certificates checked unless an Admin
// turned the check off (and then said in the log), no password in any error, and a mailbox that
// anyone can send to cannot make the server hold an attachment of any size.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import https from 'node:https';
import tls from 'node:tls';
import { PassThrough, Readable } from 'node:stream';
import { generateKeyPairSync } from 'node:crypto';

import { buildTransport, redactSecrets, testConnection, verifiesCertificate } from '../src/mailer.js';
import { MAX_BACKUP_BYTES, NO_STARTTLS, downloadCapped, findBackupInMailbox, imapOptions, readReplies } from '../src/mail-inbox.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkRoute, readNetwork, saveNetwork } from '../src/network.js';
import { fetchIssuer } from '../src/trust.js';
import { makeCertificate } from '../src/tls.js';
import { testProxy } from './fake-proxy.js';

const PASSWORD = 'Sup3r-Secret-Pa55';

/** An SMTP server that offers AUTH PLAIN and rejects it, echoing back what it was sent. */
async function echoingSmtp() {
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.write('220 echo.smtp ESMTP\r\n');
    let pending = '';
    socket.on('data', (chunk) => {
      pending += chunk.toString();
      const lines = pending.split('\r\n');
      pending = lines.pop();
      for (const line of lines) {
        if (/^EHLO/i.test(line)) socket.write('250-echo.smtp\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^AUTH/i.test(line)) socket.write(`535 5.7.8 Rejected "${line}" (password ${PASSWORD})\r\n`);
        else if (/^QUIT/i.test(line)) socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, close: () => server.close() };
}

test('a mail error never carries the password, even when the server echoes it (as typed or base64)', async () => {
  const smtp = await echoingSmtp();
  try {
    const settings = { host: '127.0.0.1', port: smtp.port, secure: false, requireAuth: true, user: 'mailer@acme.io', password: PASSWORD, rejectUnauthorized: true };
    const error = await testConnection(settings).then(() => null, (e) => e);
    assert.ok(error, 'the server rejects the sign-in');
    const everything = `${error.message} ${JSON.stringify(error.help ?? {})}`;
    assert.ok(!everything.includes(PASSWORD), everything);
    assert.ok(!everything.includes(Buffer.from(`\u0000mailer@acme.io\u0000${PASSWORD}`).toString('base64')), 'not the AUTH PLAIN token either');
  } finally {
    smtp.close();
  }
  // Every form, also inside the help object; nothing else is touched.
  const smtp2 = { user: 'u@acme.io', password: PASSWORD };
  const b64 = Buffer.from(PASSWORD).toString('base64');
  assert.deepEqual(redactSecrets({ a: `x ${PASSWORD} y`, b: [b64], c: 3 }, smtp2), { a: 'x [hidden] y', b: ['[hidden]'], c: 3 });
  assert.equal(redactSecrets('nothing secret', {}), 'nothing secret');
});

test('the mail server certificate is checked unless an Admin explicitly turned it off, and then it is logged once', (t) => {
  assert.equal(verifiesCertificate({}), true);
  assert.equal(verifiesCertificate({ rejectUnauthorized: undefined }), true);
  assert.equal(verifiesCertificate({ rejectUnauthorized: 'false' }), true, 'only an explicit false turns it off');
  assert.equal(verifiesCertificate({ rejectUnauthorized: false }), false);

  const warn = t.mock.method(console, 'warn', () => {});
  const on = buildTransport({ host: 'smtp.acme.test', port: 587, rejectUnauthorized: true });
  assert.equal(on.options.tls.rejectUnauthorized, true);
  assert.equal(on.options.requireTLS, false, 'no login: a relay without TLS still works');
  const login = buildTransport({ host: 'smtp.acme.test', port: 587, user: 'u', password: PASSWORD, requireAuth: true });
  assert.equal(login.options.requireTLS, true, 'a login is never sent before STARTTLS');
  login.close();
  const tls = buildTransport({ host: 'smtp.acme.test', port: 465, secure: true, user: 'u', password: PASSWORD, requireAuth: true });
  assert.equal(tls.options.requireTLS, false, 'already TLS from the start');
  tls.close();
  on.close();
  assert.equal(warn.mock.callCount(), 0);

  const off = { host: 'relay.acme.test', port: 25, rejectUnauthorized: false, user: 'u', password: PASSWORD, requireAuth: true };
  buildTransport(off).close();
  buildTransport(off).close();
  assert.equal(warn.mock.callCount(), 1, 'said once, not on every send');
  const line = warn.mock.calls[0].arguments[0];
  assert.match(line, /Certificate checks are off for the mail server relay\.acme\.test:25/);
  assert.ok(!line.includes(PASSWORD));
});

test('the backup mailbox always checks certificates; reading replies follows the email server\'s choice', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const account = { host: 'imap.acme.test', port: 993, user: 'u', password: PASSWORD, rejectUnauthorized: false };
  assert.equal(imapOptions(account).tls.rejectUnauthorized, true, 'backups: no way to turn it off');
  assert.equal(imapOptions({ ...account, rejectUnauthorized: true }, { allowUnverified: true }).tls.rejectUnauthorized, true);
  assert.equal(imapOptions({ host: 'imap.acme.test', port: 993 }, { allowUnverified: true }).tls.rejectUnauthorized, true, 'on by default');
  assert.equal(imapOptions(account, { allowUnverified: true }).tls.rejectUnauthorized, false, 'replies: the Admin\'s explicit choice');
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /mailbox \(IMAP\) imap\.acme\.test:993/);
});

test('a mailbox password is only sent over TLS: 993 from the start, any other port only after STARTTLS', () => {
  const account = { host: 'imap.acme.test', user: 'u', password: PASSWORD };
  const tls993 = imapOptions({ ...account, port: 993, secure: true });
  assert.equal(tls993.secure, true);
  assert.equal('doSTARTTLS' in tls993, false, 'never both: imapflow refuses secure with doSTARTTLS');
  const plain143 = imapOptions({ ...account, port: 143, secure: false });
  assert.equal(plain143.secure, false);
  assert.equal(plain143.doSTARTTLS, true, 'STARTTLS is required, not just tried');
  assert.equal(imapOptions({ ...account, port: 993 }).secure, true, 'TLS from the start by default');
});

test('a mailbox server that offers no STARTTLS never receives the password, and the Admin is told how to fix it', async () => {
  const seen = [];
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.write('* OK IMAP4rev1 ready\r\n');
    let pending = '';
    socket.on('data', (chunk) => {
      pending += chunk.toString();
      const lines = pending.split('\r\n');
      pending = lines.pop();
      for (const line of lines) {
        seen.push(line);
        const [tag, command] = line.split(' ');
        // As a man in the middle who strips STARTTLS would answer: plain sign-ins offered, no STARTTLS.
        if (/^CAPABILITY$/i.test(command)) socket.write(`* CAPABILITY IMAP4rev1 AUTH=PLAIN AUTH=LOGIN\r\n${tag} OK done\r\n`);
        else if (/^AUTHENTICATE$/i.test(command)) socket.write('+ \r\n');
        else socket.write(`${tag} NO not here\r\n`);
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const account = { host: '127.0.0.1', port, secure: false, user: 'mailbox@acme.io', password: PASSWORD, rejectUnauthorized: true };
  try {
    const replies = await readReplies(account).then(() => null, (e) => e);
    assert.ok(replies, 'reading replies is refused');
    assert.equal(replies.message, NO_STARTTLS);
    assert.match(replies.message, /How to fix it: use port 993/);
    const backups = await findBackupInMailbox(account, () => true).then(() => null, (e) => e);
    assert.equal(backups?.message, NO_STARTTLS, 'the start-up backup search says the same');
  } finally {
    server.close();
  }
  const everything = seen.join('\n');
  assert.ok(!/\b(LOGIN|AUTHENTICATE)\b/i.test(everything), everything);
  assert.ok(!everything.includes(PASSWORD));
  assert.ok(!everything.includes(Buffer.from(PASSWORD).toString('base64').slice(0, 12)));
});

test('a mailbox attachment larger than any backup is not held in memory', async () => {
  const asked = [];
  const client = (size) => ({
    async download(uid, part, options) {
      asked.push(options);
      // As imapflow does with maxBytes: the stream stops at the limit.
      const bytes = Math.min(size, options.maxBytes ?? Infinity);
      const stream = new PassThrough();
      const chunk = Buffer.alloc(64 * 1024, 1);
      (async () => {
        for (let sent = 0; sent < bytes; sent += chunk.length) {
          if (!stream.write(chunk.subarray(0, Math.min(chunk.length, bytes - sent)))) await new Promise((r) => stream.once('drain', r));
        }
        stream.end();
      })();
      return { content: stream };
    },
  });
  const small = await downloadCapped(client(300 * 1024), 7, '2', MAX_BACKUP_BYTES);
  assert.equal(small.length, 300 * 1024);
  assert.equal(asked.at(-1).maxBytes, MAX_BACKUP_BYTES + 1, 'the server is asked for no more than the limit');
  assert.equal(await downloadCapped(client(MAX_BACKUP_BYTES + 5 * 1024 * 1024), 7, '2', MAX_BACKUP_BYTES), null);
  // Even a client that ignores maxBytes is stopped.
  const careless = { download: async () => ({ content: Readable.from((function* () { for (let i = 0; i < 10; i++) yield Buffer.alloc(1024 * 1024); })()) }) };
  assert.equal(await downloadCapped(careless, 1, '2', 3 * 1024 * 1024), null);
  assert.equal(await downloadCapped({ download: async () => ({}) }, 1, '2', 10), null, 'a missing part');
});

test('the network check verifies the name asked for, not the proxy\'s, before it sends anything', async () => {
  const root = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const k = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const R = { cn: 'Route Check Root' };
  const rootPem = makeCertificate({ subject: R, publicKey: root.publicKey, signerKey: root.privateKey, ca: true });
  const cert = makeCertificate({ subject: { cn: 'localhost' }, issuer: R, names: ['localhost'], publicKey: k.publicKey, signerKey: root.privateKey });
  let requests = 0;
  const server = https.createServer({ cert, key: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) }, (req, res) => {
    requests += 1;
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const proxy = await testProxy();
  const original = tls.getCACertificates('default');
  try {
    tls.setDefaultCACertificates([...original, rootPem]);
    const port = server.address().port;
    const named = await checkRoute({ proxy: `http://localhost:${proxy.port}`, host: 'localhost', port });
    assert.equal(named.ok, true);
    assert.equal(requests, 1);
    // 127.0.0.1 through a proxy called "localhost": the certificate is not for 127.0.0.1.
    const byAddress = await checkRoute({ proxy: `http://localhost:${proxy.port}`, host: '127.0.0.1', port });
    const step = byAddress.steps.find((s) => s.step === 'certificate');
    assert.equal(step.ok, false);
    assert.equal(step.code, 'ERR_TLS_CERT_ALTNAME_INVALID');
    assert.equal(requests, 1, 'nothing sent over a connection that is not trusted');
  } finally {
    tls.setDefaultCACertificates(original);
    server.close();
    proxy.close();
  }
});

test('mail errors name neither the mail server nor the account (they reach logs and audit entries)', async () => {
  const closed = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  const settings = { host: '127.0.0.1', port: closed, secure: false, requireAuth: true, user: 'mailer@acme.io', password: PASSWORD };
  const refused = await testConnection(settings).then(() => null, (e) => e);
  assert.match(refused.message, new RegExp(`Nothing is listening on port ${closed} of the mail server`));
  assert.ok(!refused.message.includes('127.0.0.1'));
  const smtp = await echoingSmtp();
  try {
    const rejected = await testConnection({ ...settings, port: smtp.port }).then(() => null, (e) => e);
    assert.ok(!rejected.message.includes('mailer@acme.io'), rejected.message);
  } finally {
    smtp.close();
  }
});

test('a refused issuer link does not repeat the address it resolved to', async () => {
  const error = await fetchIssuer('http://localhost:9/issuing.crt').then(() => null, (e) => e);
  assert.match(error.message, /is not followed \(a local, link-local or metadata address\)/);
  assert.ok(!/127\.0\.0\.1|::1/.test(error.message));
});

test('the proxy settings are written through a fresh private file, never one already there', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'net-save-'));
  const value = { proxy: { url: 'http://proxy.acme.local:8080', username: 'svc', password: PASSWORD, noProxy: '' } };
  saveNetwork(dir, value);
  saveNetwork(dir, value);
  assert.deepEqual(readNetwork(dir), value);
  assert.deepEqual(fs.readdirSync(dir), ['network.json'], 'no temporary file left behind');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'network.json')).mode & 0o777, 0o600);
  saveNetwork(dir, null);
  assert.deepEqual(fs.readdirSync(dir), []);
});
