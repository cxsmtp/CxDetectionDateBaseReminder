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
  const value = JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''));
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
 * The last good copy becomes the file again (the copy stays), so the file is there for whatever reads the
 * folder without this module: a backup made before the store's next save would otherwise leave it out, and a
 * restore of that backup would start the store empty. Made only if nothing has the name; best effort.
 */
function putBack(bak, file) {
  try {
    fs.copyFileSync(bak, file, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(file, fs.statSync(bak).mode & 0o777);
    syncDirSoon(path.dirname(file));
  } catch {}
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
      putBack(bak, file);
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
    if (!fs.existsSync(file)) putBack(bak, file);
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
 * Flushes done in the background, grouped. A flush on the request path holds every other request up
 * for as long as the disk takes (a millisecond usually, far longer when the disk is busy), so the ones
 * that only make a change last through a power cut, and are not needed to keep a file whole, are
 * done here: one at a time per path, and a flush asked for while one is running is done once more
 * after it, however many asked. What was written is on the disk a few milliseconds later.
 */
const pending = new Map(); // path -> { kind, again }, in the order asked for
let flushing = false;
let idle = [];
let saidFlush = '';

/**
 * One flush at a time, whatever the number of files and folders waiting: the flushes use the pool of
 * threads Node also compresses responses and checks passwords with, and a disk that has stopped
 * answering must tie up one of those threads, not all of them.
 */
function nextFlush() {
  if (flushing) return;
  const first = pending.entries().next().value;
  if (!first) {
    for (const resolve of idle.splice(0)) resolve();
    return;
  }
  const [target, job] = first;
  flushing = true;
  job.again = false;
  const done = (error) => {
    const quiet = !error || error.code === 'ENOENT' || (job.kind === 'dir' && ['EINVAL', 'EPERM', 'EISDIR', 'EACCES', 'ENOTSUP', 'EBADF'].includes(error.code));
    if (!quiet && saidFlush !== error.message) {
      console.error(`! [data] ${target} was written but could not be flushed to the disk: ${error.message}`);
      saidFlush = error.message;
    }
    flushing = false;
    // Written to again meanwhile: once more, after the others that are waiting.
    pending.delete(target);
    if (job.again) pending.set(target, job);
    nextFlush();
  };
  // A file is opened for reading where that is enough to flush it (not on Windows).
  fs.open(target, job.kind === 'dir' || process.platform !== 'win32' ? 'r' : 'r+', (openError, fd) => {
    if (openError) return done(openError);
    const flushed = (error) => fs.close(fd, () => done(error));
    if (job.kind === 'dir') fs.fsync(fd, flushed);
    else fs.fdatasync(fd, flushed);
  });
}

function flushSoon(target, kind) {
  const job = pending.get(target);
  if (job) {
    job.again = true;
    return;
  }
  pending.set(target, { kind, again: false });
  nextFlush();
}

/** Flush a folder in the background (see above): the file just renamed into it is whole either way. */
export function syncDirSoon(dir) {
  flushSoon(dir, 'dir');
}

/** Resolves once every background flush asked for so far is done. */
export function flushesSettled() {
  if (!pending.size && !flushing) return Promise.resolve();
  return new Promise((resolve) => idle.push(resolve));
}

/** Do, now and before returning, every background flush still waiting: for a server that is stopping. */
export function flushPendingNow() {
  for (const [target, job] of pending) {
    try {
      if (job.kind === 'dir') syncDir(target);
      else {
        const fd = fs.openSync(target, process.platform !== 'win32' ? 'r' : 'r+');
        try {
          fs.fdatasyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch {}
  }
}

/**
 * Save a state file so that a crash at any moment leaves either the old contents or the new, never half:
 * 1. the new contents go to a file beside it, under a name nobody can guess, created only if nothing has
 *    that name yet (never written through a link left in its place), readable by this server's user alone;
 * 2. that file is flushed to the disk;
 * 3. the file being replaced becomes <file>.bak, the last good copy (in place of the one before);
 * 4. the new file takes its place, and the folder is flushed in the background so both renames are on
 *    the disk a few milliseconds later.
 * A crash between 3 and 4 leaves only <file>.bak, which readState() uses. A power cut before the folder's
 * flush leaves the file as it was before this save, or as it is after it: whole in both cases.
 *
 * @param {string} file
 * @param {object|string|Buffer} data  an object is written as JSON; text and bytes as they are
 * @param {object} [options]
 * @param {number} [options.mode]   the file's permissions (0600)
 * @param {number|string} [options.space]  JSON indentation, as JSON.stringify takes it
 * @param {boolean} [options.keepLast]  false: no <file>.bak is kept, and one left by an earlier save is
 *   removed. For what must not linger once it is replaced (sign-ins that ended, a secret taken out on
 *   purpose), for a key or certificate where the one before is of no use, and for a folder a backup takes
 *   every file of. The write is flushed all the same.
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
    let kept = false;
    if (keepLast) {
      try {
        fs.renameSync(file, lastGoodCopy(file));
        kept = true;
      } catch (error) {
        // Nothing to keep: the first save of this file.
        if (error.code !== 'ENOENT') throw error;
      }
    }
    try {
      fs.renameSync(tmp, file);
    } catch (error) {
      // The new file could not take its place: the one just set aside goes back, so the file is not left missing.
      if (kept) {
        try {
          fs.renameSync(lastGoodCopy(file), file);
        } catch {}
      }
      throw error;
    }
    // Only once the new file is in place: there is never a moment with neither.
    if (!keepLast) fs.rmSync(lastGoodCopy(file), { force: true });
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  syncDirSoon(dir);
}

/**
 * Remove a state file on purpose, and its last good copy with it: left behind, the copy would be
 * read as the file the next time (readState() takes a missing file with a copy for a crash mid-save).
 */
export function removeState(file) {
  fs.rmSync(file, { force: true });
  fs.rmSync(lastGoodCopy(file), { force: true });
}

/** What writeState() calls the file it writes before it takes the state file's place. */
const HALF_SAVED = /\.[0-9a-f]{16}\.tmp$/;

/**
 * Remove what a crash in the middle of a save left behind: files writeState() was still writing when the
 * server died. They were never put in place, hold a copy of what was being saved (keys and passwords
 * among it), and nothing reads them. Looked for in `dir` and the folders in it, `depth` levels down; one
 * younger than `olderThanMs` is left, in case a script is saving at this moment. Returns the paths removed.
 */
export function clearHalfSaved(dir, { depth = 2, olderThanMs = 10 * 60_000, now = Date.now() } = {}) {
  const removed = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) removed.push(...clearHalfSaved(full, { depth: depth - 1, olderThanMs, now }));
      continue;
    }
    if (!entry.isFile() || !HALF_SAVED.test(entry.name)) continue;
    try {
      if (now - fs.statSync(full).mtimeMs < olderThanMs) continue;
      fs.rmSync(full, { force: true });
      removed.push(full);
    } catch {}
  }
  return removed;
}

/**
 * Add text to the end of an append-only log and have it on the disk before returning: the file is opened
 * by its path, written, flushed and closed, every time. No descriptor is kept between appends, so a log
 * that was made read-only, moved aside or replaced is seen at the next append, not written to behind
 * the folder's back.
 *
 * Throws when it cannot. The error's `written` says how far it got: false, nothing was added (try again
 * later); true, the text is in the file and only the flush failed (adding it again would repeat it).
 *
 * `flush: 'soon'` is for a log written on the request path (the audit log): the text is in the file
 * before this returns, so it survives the server crashing or being killed, and the flush that makes it
 * survive a power cut is done in the background, grouped with the entries written just after
 * (flushesSettled() waits for it, flushPendingNow() does it at once).
 */
export function appendDurable(file, text, { flush = 'now' } = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const isNew = !fs.existsSync(file);
  const fd = fs.openSync(file, 'a', 0o600);
  let written = false;
  try {
    try {
      fs.appendFileSync(fd, text);
      written = true;
      if (flush !== 'soon') fs.fdatasyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (flush === 'soon') {
      flushSoon(file, 'file');
      if (isNew) syncDirSoon(dir);
      return;
    }
    // A log made just now: its name has to reach the disk too.
    if (isNew) syncDir(dir);
  } catch (error) {
    throw Object.assign(error, { written });
  }
}
