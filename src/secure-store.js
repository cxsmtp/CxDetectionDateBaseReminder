/**
 * Data-at-rest encryption for CxMissionZero's state folder (docs/licensing-hardening.md, licensing Phase 1).
 *
 * MissionZero keeps its state in ~45 small files, each written by its own store. There is no single I/O
 * chokepoint, so this module is the shared primitive those stores route their reads and writes through.
 * It has two modes:
 *
 *   - No key set (the default, and whenever the product is locked): every call is PASSTHROUGH — plaintext,
 *     byte-for-byte what the app wrote before this module existed. Nothing changes until encryption is turned on.
 *   - A Data Encryption Key set (`setDek`): files are AES-256-GCM. Whole-file records for JSON; per-line records
 *     for append logs (so an append stays O(1) and a growing audit log is not rewritten each line).
 *
 * The key lives only in memory (`setDek`/`clearDek`), and is never written here — it is unwrapped from the license
 * (Phase 1: a mailed code; Phase 2: the signed server token) by the caller and handed in. Reads detect whether a
 * file is encrypted by its magic header, so a folder part-way through migration, or read with the key off, still
 * works. Each record is bound to its file's name (AAD), so a ciphertext cannot be swapped between files.
 *
 * This module writes no plaintext key material and keeps no global state but the in-memory DEK.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAGIC = Buffer.from('MZENC1\0'); // 7 bytes, marks a whole-file encrypted record
const LINE_TAG = '#MZL1:'; // marks a per-line encrypted record in an append log
const NONCE = 12;
const TAG = 16;
const FILE_MODE = 0o600;

let dek = null; // 32 bytes when encryption is on, else null (passthrough)

/** Turn encryption on with a 32-byte Data Encryption Key (held in memory only). */
export function setDek(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('secure-store: the data key must be 32 bytes');
  dek = Buffer.from(key);
}

/** Turn encryption off (the product is locked, or never had a key). Reads of encrypted files then fail; passthrough writes are plaintext. */
export function clearDek() {
  if (dek) dek.fill(0);
  dek = null;
}

/** Is a key set (is encryption on)? */
export const hasKey = () => dek !== null;

/** The additional data a record is bound to: its file's name, so a blob cannot be moved to another file. */
const aadFor = (file) => Buffer.from(path.basename(String(file)), 'utf8');

/** One AES-256-GCM record: MAGIC | nonce(12) | ciphertext | tag(16). */
function seal(plain, aad) {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv('aes-256-gcm', dek, nonce);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, ct, cipher.getAuthTag()]);
}

/** Open a record sealed by `seal`. Throws if the key is wrong or the record was tampered with. */
function open(buf, aad) {
  if (!isSealed(buf)) throw new Error('secure-store: not an encrypted record');
  if (!dek) throw new Error('secure-store: no data key to decrypt with');
  const nonce = buf.subarray(MAGIC.length, MAGIC.length + NONCE);
  const tag = buf.subarray(buf.length - TAG);
  const ct = buf.subarray(MAGIC.length + NONCE, buf.length - TAG);
  const decipher = createDecipheriv('aes-256-gcm', dek, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Does this buffer start with the whole-file magic header? */
export function isSealed(buf) {
  return Buffer.isBuffer(buf) && buf.length >= MAGIC.length + NONCE + TAG && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

/** Write `buf` to `file` atomically (same-dir temp then rename), 0600. Encrypted when a key is set. */
export function writeBytesAtomic(file, buf) {
  const out = dek ? seal(buf, aadFor(file)) : buf;
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, out, { mode: FILE_MODE });
  fs.renameSync(tmp, file);
}

/**
 * Read `file` as bytes. An encrypted record is decrypted (needs the key); a plaintext file is returned as is, so a
 * part-migrated folder and a key-off read both work. Missing file: null.
 */
export function readBytes(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return isSealed(buf) ? open(buf, aadFor(file)) : buf;
}

/** Read JSON (encrypted or plaintext), or `fallback` when the file is missing or unreadable as JSON. */
export function readJson(file, fallback = undefined) {
  const buf = readBytes(file);
  if (buf === null) return fallback;
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return fallback;
  }
}

/** Write a value as JSON, atomically and encrypted when a key is set. */
export function writeJsonAtomic(file, value) {
  writeBytesAtomic(file, Buffer.from(JSON.stringify(value), 'utf8'));
}

/** Read a whole text file (encrypted or plaintext), or `fallback` when missing. */
export function readText(file, fallback = undefined) {
  const buf = readBytes(file);
  return buf === null ? fallback : buf.toString('utf8');
}

/** Write text, atomically and encrypted when a key is set. */
export function writeTextAtomic(file, text) {
  writeBytesAtomic(file, Buffer.from(String(text), 'utf8'));
}

/**
 * Append one line to a log. With a key set the line is a per-line record (`#MZL1:` + base64 of MAGIC|nonce|ct|tag),
 * so the append stays O(1) and the file can mix with any plaintext lines written before encryption was turned on.
 * `line` must not contain a newline (it is one record); a trailing newline is added.
 */
export function appendLine(file, line) {
  const text = String(line).replace(/\n/g, ' ');
  const record = dek ? LINE_TAG + seal(Buffer.from(text, 'utf8'), aadFor(file)).toString('base64') : text;
  fs.appendFileSync(file, `${record}\n`, { mode: FILE_MODE });
}

/** Decode one stored log line: an encrypted record is opened, a plaintext line is returned as is. */
export function decodeLine(file, stored) {
  const s = String(stored);
  if (!s.startsWith(LINE_TAG)) return s;
  return open(Buffer.from(s.slice(LINE_TAG.length), 'base64'), aadFor(file)).toString('utf8');
}

/** Read an append log as decoded lines (encrypted lines opened, plaintext passed through). Missing file: []. */
export function readLines(file) {
  const text = (() => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return '';
      throw error;
    }
  })();
  return text.split('\n').filter((l) => l !== '').map((l) => decodeLine(file, l));
}

/**
 * Re-write one file to the current mode: encrypt a plaintext file (key on) or decrypt an encrypted one (key on,
 * for turning encryption off). Atomic, idempotent — a file already in the target form is left as is. Returns
 * 'encrypted' | 'decrypted' | 'unchanged' | 'absent'. For whole-file JSON/text and report files, not append logs.
 */
export function convertFile(file, { to }) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return 'absent';
    throw error;
  }
  const sealed = isSealed(buf);
  if (to === 'encrypted') {
    if (sealed) return 'unchanged';
    if (!dek) throw new Error('secure-store: no data key to encrypt with');
    writeBytesAtomic(file, buf); // key set -> seal
    return 'encrypted';
  }
  if (to === 'plaintext') {
    if (!sealed) return 'unchanged';
    const plain = open(buf, aadFor(file));
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, plain, { mode: FILE_MODE });
    fs.renameSync(tmp, file);
    return 'decrypted';
  }
  throw new Error(`secure-store: convertFile 'to' must be 'encrypted' or 'plaintext'`);
}
