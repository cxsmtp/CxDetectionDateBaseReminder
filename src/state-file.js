/**
 * Reading and writing the server's state files, so that a damaged file is never mistaken for an
 * empty one and a save survives a crash of the machine.
 *
 * Two things went wrong before this module:
 * - A file that could not be read (cut short by a crash, edited by hand into something that is
 *   not JSON) was treated as "nothing saved yet". The server then carried on empty and, at the
 *   next save, wrote over what was left: a cut-short iam.json meant "no users", a new first
 *   administrator, and the old users gone.
 * - A save was written and renamed into place but never flushed, so a machine that lost power
 *   just after could come back with a zero-length file.
 *
 * So every JSON state store reads with readState() and writes with writeState():
 * - writeState() writes a new file beside the old one, flushes it to the disk, keeps the file it
 *   replaces as <file>.bak (the last good copy), puts the new one in place and flushes the folder.
 * - readState() gives the fallback only when there is no file and no last good copy (a new
 *   installation). A damaged file is put right from <file>.bak when that reads (the damaged one
 *   is kept as <file>.damaged-<time>), and otherwise it stops with a StateFileError that says
 *   what to do. It never answers "empty" for a file that is there and cannot be read.
 *
 * No dependencies beyond Node itself: scripts and the launcher can use it too.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** What a state file's last good copy is called: the file writeState() replaced last. */
export const lastGoodCopy = (file) => `${file}.bak`;

/**
 * A state file that is there and cannot be used, with no last good copy to fall back on. The
 * message is written for the person running the server and is complete on its own: which file,
 * what happens now, and the two ways out.
 */
export class StateFileError extends Error {
  /**
   * @param {string} file    the state file
   * @param {string} reason  what is wrong with it, in a few words ('' when it is missing and only its copy is damaged)
   * @param {object} [more]
   * @param {string} [more.holds]  what the file keeps ("the users and roles"), named in the message
   * @param {string} [more.copy]   what is wrong with its last good copy, when there is one
   * @param {Error}  [more.cause]
   */
  constructor(file, reason, { holds = '', copy = '', cause } = {}) {
    const bak = lastGoodCopy(file);
    const names = [reason ? path.basename(file) : '', copy ? path.basename(bak) : ''].filter(Boolean);
    super(
      [
        `The state file ${file} ${reason ? `is damaged (${reason})` : 'is missing'}${holds ? `. It holds ${holds}` : ''}.`,
        copy ? `Its last good copy, ${bak}, cannot be used either (${copy}).` : `There is no last good copy of it (${bak}) to use instead.`,
        'CxMissionZero will not start, and will not carry on as if the file were empty, so that nothing is written over it. There are two ways out:',
        '  1. Restore a backup, with the server stopped: node scripts/restore.mjs <backup file> --yes  (what is in the state folder now is moved aside, never deleted).',
        `  2. Or start this part afresh, on purpose: move ${names.join(' and ')} out of ${path.dirname(file)} (somewhere safe, not deleted), then start the server again. What the file held is then gone from the server.`,
      ].join('\n'),
      cause ? { cause } : undefined,
    );
    this.name = 'StateFileError';
    this.code = 'STATE_FILE_DAMAGED';
    this.file = file;
  }
}

/** JSON text, as a state file holds it. A byte-order mark an editor added in front is not damage. */
function parseJson(buffer) {
  const value = JSON.parse(buffer.toString('utf8').replace(/^﻿/, ''));
  // Every state file holds an object (or a list): a bare null, number or text is not one a store wrote.
  if (value === null || typeof value !== 'object') throw new Error('it holds no JSON object');
  return value;
}

/** A short reason a person can act on, from whatever reading or parsing threw. */
const reasonOf = (error) => String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 160);

/** Try one file: {state: 'ok', value} | {state: 'missing'} | {state: 'damaged' | 'unreadable', reason}. */
function attempt(file, parse) {
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'missing' };
    // There, but this server may not read it (permissions, a folder in its place, a failing disk).
    return { state: 'unreadable', reason: `it cannot be read: ${reasonOf(error)}` };
  }
  if (!buffer.length) return { state: 'damaged', reason: 'it is empty: zero bytes, as a crash in the middle of a save leaves it' };
  try {
    return { state: 'ok', value: parse(buffer) };
  } catch (error) {
    return { state: 'damaged', reason: `its contents are not valid: ${reasonOf(error)}` };
  }
}

/**
 * Read a state file.
 * - No file and no last good copy: `fallback` (a new installation).
 * - The file reads: what it holds.
 * - The file is missing or damaged and <file>.bak reads: what the last good copy holds. A damaged
 *   file is moved aside to <file>.damaged-<time> (never deleted), and one line on the error log says so.
 * - Otherwise: throws StateFileError. The damaged file is left exactly as it is.
 *
 * @param {string} file
 * @param {object} [options]
 * @param {*} [options.fallback]  what a new installation starts with
 * @param {(buffer: Buffer) => *} [options.parse]  turns the file's bytes into its value and throws
 *   when they are not what the file should hold (JSON holding an object or a list, unless given)
 * @param {string} [options.holds]  what the file keeps, in a few words, for the message
 */
export function readState(file, { fallback = null, parse = parseJson, holds = '' } = {}) {
  const main = attempt(file, parse);
  if (main.state === 'ok') return main.value;
  const bak = lastGoodCopy(file);
  const copy = attempt(bak, parse);
  if (main.state === 'missing' && copy.state === 'missing') return fallback;
  // A file this server may not read is not put aside: that is for whoever runs it to put right.
  if (copy.state === 'ok' && main.state !== 'unreadable') {
    if (main.state === 'missing') {
      console.error(`! [data] ${file} is missing, but its last good copy ${bak} is there: the last good copy was used. Anything saved after that copy was made is not in it.`);
      return copy.value;
    }
    const aside = `${file}.damaged-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    let kept = `The damaged file is kept as ${aside}.`;
    try {
      fs.renameSync(file, aside);
    } catch (error) {
      kept = `The damaged file could not be moved aside (${reasonOf(error)}); the next save keeps it as ${bak}.`;
    }
    console.error(`! [data] ${file} is damaged (${main.reason}): the last good copy ${bak} was used instead. Anything saved after that copy was made is lost. ${kept}`);
    return copy.value;
  }
  // The reasons are in the message; no `cause` is attached, so what Node prints for an error nobody caught
  // (the server's stores are made as it starts) is the message and where it was thrown, not two stack traces.
  throw new StateFileError(file, main.state === 'missing' ? '' : main.reason, { holds, copy: copy.state === 'missing' ? '' : copy.reason });
}

/** Flush a folder, so a file just created in it or renamed into it is still there after a crash. Does nothing where folders cannot be flushed. */
export function syncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    // Windows (and a few network file systems) cannot open or flush a folder: there is nothing to do there.
    if (!['EINVAL', 'EPERM', 'EISDIR', 'EACCES', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Save a state file so that a crash at any moment leaves either the old contents or the new, never half:
 * 1. the new contents go to a file beside it, under a name nobody can guess, created only if nothing has
 *    that name yet (never written through a link left in its place), readable by this server's user alone;
 * 2. that file is flushed to the disk;
 * 3. the file being replaced becomes <file>.bak, the last good copy (in place of the one before);
 * 4. the new file takes its place, and the folder is flushed so both renames are on the disk.
 * A crash between 3 and 4 leaves only <file>.bak, which readState() uses.
 *
 * @param {string} file
 * @param {object|string|Buffer} data  an object is written as JSON; text and bytes as they are
 * @param {object} [options]
 * @param {number} [options.mode]   the file's permissions (0600)
 * @param {number|string} [options.space]  JSON indentation, as JSON.stringify takes it
 * @param {boolean} [options.keepLast]  false: no <file>.bak is kept (a key or certificate, where the one
 *   before is of no use; a folder a backup takes every file of). The write is flushed all the same.
 */
export function writeState(file, data, { mode = 0o600, space, keepLast = true } = {}) {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, space);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    try {
      fs.writeFileSync(fd, body);
      // The mode asked for, whatever the process's umask took off when the file was made.
      try {
        fs.fchmodSync(fd, mode);
      } catch {}
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (keepLast) {
      try {
        fs.renameSync(file, lastGoodCopy(file));
      } catch (error) {
        // Nothing to keep: the first save of this file.
        if (error.code !== 'ENOENT') throw error;
      }
    }
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  syncDir(dir);
}

/**
 * Remove a state file on purpose, and its last good copy with it: left behind, the copy would be
 * read as the file the next time (readState() takes a missing file with a copy for a crash mid-save).
 */
export function removeState(file) {
  fs.rmSync(file, { force: true });
  fs.rmSync(lastGoodCopy(file), { force: true });
}

/**
 * Add text to the end of an append-only log and have it on the disk before returning. For a log
 * written now and then; one written on every request keeps its file open instead (src/audit-log.js).
 */
export function appendDurable(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const isNew = !fs.existsSync(file);
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.appendFileSync(fd, text);
    fs.fdatasyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // A log made just now: its name has to reach the disk too.
  if (isNew) syncDir(dir);
}
