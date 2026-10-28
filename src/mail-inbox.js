/**
 * Replies to MissionZero's own emails (hands-off mode): read the unread mail in
 * the mailbox it sends from, over IMAP, and mark it read. Only the sender, the
 * subject and the plain text are kept, never attachments; each message is cut
 * to 64 KB. The account is the email server's (Settings → Email server); the
 * IMAP host defaults to its host.
 *
 * Tests read from a folder of JSON files instead (MZ_TEST_INBOX_DIR, only under
 * the test runner), so the command path is covered without a mail server.
 */

import fs from 'node:fs';
import path from 'node:path';

import { redactSecrets, verifiesCertificate, warnUnverified } from './mailer.js';

const MAX_TEXT = 64 * 1024;
const MAX_MESSAGES = 25;
/**
 * The largest backup attachment read from the mailbox. Backups are emailed only up to 15 MB
 * (MAX_ATTACHMENT_BYTES in server.js) and mail servers rarely carry more than 25 MB; anyone can
 * send mail to the mailbox, so nothing bigger is held in memory.
 */
export const MAX_BACKUP_BYTES = 25 * 1024 * 1024;

/**
 * The IMAP client's options. Certificates are checked: for replies, unless an Admin turned the
 * check off for the email server (the same account, the same choice, said in the server log);
 * for backups, always, as nothing lets an Admin turn it off there. The password is only ever
 * sent over TLS: from the start (993), or else STARTTLS must be offered and taken, so a server
 * (or anyone in between) that leaves STARTTLS out gets no sign-in at all.
 */
export function imapOptions(account, { allowUnverified = false } = {}) {
  const verify = allowUnverified ? verifiesCertificate(account) : true;
  if (!verify) warnUnverified('mailbox (IMAP)', account);
  const secure = account.secure !== false;
  return {
    host: account.host,
    port: account.port,
    secure,
    // imapflow refuses both at once; without it, STARTTLS is only tried, and a password could go in clear.
    ...(secure ? {} : { doSTARTTLS: true }),
    auth: { user: account.user, pass: account.password },
    tls: { rejectUnauthorized: verify },
    logger: false,
    socketTimeout: 60_000,
  };
}

/** A part's content, at most `max` bytes: a Buffer, or null when the part is larger (nothing more is fetched). */
export async function downloadCapped(client, uid, part, max) {
  const { content } = (await client.download(String(uid), part, { uid: true, maxBytes: max + 1 })) ?? {};
  if (!content) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of content) {
    size += chunk.length;
    if (size > max) {
      content.destroy?.();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * A client whose late socket errors (a timeout after a refused connect) are dropped: what went wrong
 * reaches the caller through the call that failed, and the client is closed there.
 */
function quiet(client) {
  client.on('error', () => {});
  return client;
}

/** Said when the mailbox server offers no STARTTLS (the same words in the self-check and the server log). */
export const NO_STARTTLS =
  'The mailbox server offers no encrypted connection, and MissionZero never sends a password without one. How to fix it: use port 993 (encrypted from the start), or ask the mail server\'s administrator to turn on STARTTLS for this port.';

/** An IMAP failure, never with the password in it (servers and libraries can echo commands). */
function safeError(error, account) {
  if (error?.tlsFailed || /does not support STARTTLS/i.test(String(error?.message ?? ''))) {
    return Object.assign(new Error(NO_STARTTLS), { code: 'ENOSTARTTLS' });
  }
  const message = redactSecrets(String(error?.message ?? error), { user: account.user, password: account.password });
  if (error && typeof error === 'object' && message !== error.message) {
    try {
      error.message = message;
    } catch {
      return Object.assign(new Error(message), { code: error.code });
    }
  }
  return error;
}

/** The plain-text part of a message's structure (or its HTML one): { part, type }. */
function textPart(node) {
  if (!node) return null;
  if (node.childNodes?.length) {
    let html = null;
    for (const child of node.childNodes) {
      const found = textPart(child);
      if (found?.type === 'text/plain') return found;
      if (found && !html) html = found;
    }
    return html;
  }
  if (node.disposition === 'attachment') return null;
  if (node.type === 'text/plain' || node.type === 'text/html') return { part: node.part || '1', type: node.type };
  return null;
}

const htmlToText = (html) => String(html).replace(/<(br|\/p|\/div)[^>]*>/gi, '\n').replace(/<blockquote[\s\S]*$/i, '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function readStream(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    size += chunk.length;
    if (size > MAX_TEXT) break;
  }
  return Buffer.concat(chunks).subarray(0, MAX_TEXT).toString('utf8');
}

/**
 * The unread messages, marked read: [{ from, subject, text }].
 * account: { host, port, secure, user, password, rejectUnauthorized }.
 */
export async function readReplies(account) {
  const testDir = process.env.NODE_TEST_CONTEXT && process.env.MZ_TEST_INBOX_DIR;
  if (testDir) return readTestInbox(testDir);
  const { ImapFlow } = await import('imapflow');
  const client = quiet(new ImapFlow(imapOptions(account, { allowUnverified: true })));
  try {
    return await readUnread(client);
  } catch (error) {
    client.close();
    throw safeError(error, account);
  }
}

async function readUnread(client) {
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const found = [];
    for await (const message of client.fetch({ seen: false }, { uid: true, envelope: true, bodyStructure: true }, { uid: true })) {
      found.push(message);
      if (found.length >= MAX_MESSAGES) break;
    }
    const out = [];
    for (const message of found) {
      const part = textPart(message.bodyStructure);
      let text = '';
      if (part) {
        const { content } = await client.download(String(message.uid), part.part, { uid: true, maxBytes: MAX_TEXT });
        text = content ? await readStream(content) : '';
        if (part.type === 'text/html') text = htmlToText(text);
      }
      out.push({ from: String(message.envelope?.from?.[0]?.address ?? '').toLowerCase(), subject: String(message.envelope?.subject ?? ''), text });
    }
    if (found.length) await client.messageFlagsAdd(found.map((m) => m.uid), ['\\Seen'], { uid: true });
    return out;
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

/** Test inbox: each *.json file is one message ({from, subject, text}); read files are removed. */
function readTestInbox(dir) {
  const out = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort() : []) {
    const file = path.join(dir, name);
    try {
      const m = JSON.parse(fs.readFileSync(file, 'utf8'));
      out.push({ from: String(m.from ?? '').toLowerCase(), subject: String(m.subject ?? ''), text: String(m.text ?? '') });
    } catch {}
    fs.rmSync(file, { force: true });
  }
  return out;
}

/** What a backup email's subject starts with: how a new server finds the backups in the mailbox. */
export const BACKUP_SUBJECT = 'MissionZero backup';

/** The parts of a message that are .mzbackup attachments. */
function backupParts(node, out = []) {
  if (!node) return out;
  for (const child of node.childNodes ?? []) backupParts(child, out);
  const name = node.dispositionParameters?.filename || node.parameters?.name || '';
  if (/\.mzbackup$/i.test(name)) out.push({ part: node.part || '1', name, size: node.size ?? 0 });
  return out;
}

/**
 * The newest backup in a mailbox that `accept(buffer)` takes (it checks the
 * passphrase), or null: { buffer, name, date }. Reads only messages whose subject
 * starts with BACKUP_SUBJECT, the newest 20, and changes nothing in the mailbox.
 * Tests read *.mzbackup files from MZ_TEST_BACKUP_MAILBOX_DIR instead (test runner only).
 */
export async function findBackupInMailbox(account, accept) {
  const testDir = process.env.NODE_TEST_CONTEXT && process.env.MZ_TEST_BACKUP_MAILBOX_DIR;
  if (testDir) {
    const names = fs.existsSync(testDir) ? fs.readdirSync(testDir).filter((n) => n.endsWith('.mzbackup')).sort().reverse() : [];
    for (const name of names) {
      const buffer = fs.readFileSync(path.join(testDir, name));
      if (accept(buffer)) return { buffer, name, date: '' };
    }
    return null;
  }
  const { ImapFlow } = await import('imapflow');
  const client = quiet(new ImapFlow(imapOptions(account)));
  try {
    return await searchBackups(client, accept);
  } catch (error) {
    client.close();
    throw safeError(error, account);
  }
}

async function searchBackups(client, accept) {
  await client.connect();
  const lock = await client.getMailboxLock('INBOX', { readOnly: true });
  try {
    const uids = (await client.search({ subject: BACKUP_SUBJECT }, { uid: true })) || [];
    const messages = [];
    for await (const m of client.fetch(uids.slice(-20), { uid: true, envelope: true, bodyStructure: true }, { uid: true })) messages.push(m);
    messages.sort((a, b) => new Date(b.envelope?.date ?? 0) - new Date(a.envelope?.date ?? 0));
    for (const message of messages) {
      for (const part of backupParts(message.bodyStructure)) {
        if (Number(part.size) > MAX_BACKUP_BYTES * 1.4) continue; // base64 grows it by a third: too large before it is fetched
        const buffer = await downloadCapped(client, message.uid, part.part, MAX_BACKUP_BYTES);
        if (buffer && accept(buffer)) return { buffer, name: part.name, date: message.envelope?.date ? new Date(message.envelope.date).toISOString() : '' };
      }
    }
    return null;
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}
