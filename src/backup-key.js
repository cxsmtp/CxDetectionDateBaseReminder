/**
 * The server's own backup key: what encrypts every backup when nobody gave a BACKUP_PASSPHRASE.
 *
 * A backup holds the Checkmarx One key, the mail password and the signing keys. Before this, it was
 * encrypted only when BACKUP_PASSPHRASE was set; otherwise the file was plain wherever it went. Now:
 *
 * - A NEW installation makes a key of its own at its first start and encrypts every backup with it, in
 *   the same format a passphrase gives: `BACKUP_PASSPHRASE=<the key>` opens such a backup anywhere.
 * - An EXISTING installation is left as it was: its backups stay plain until an Admin turns encryption
 *   on (Audit → State & backups), which makes the key then.
 * - BACKUP_PASSPHRASE, when set, wins: backups are encrypted with it and the key here is not used.
 * - BACKUP_ENCRYPTION=off keeps backups plain on purpose (a passphrase still wins).
 *
 * New or existing is decided once, at the first start that finds no decision, and written to
 * backup-key.json in the state folder (0600, no last good copy: it holds a secret). It is never
 * decided again. "New" means nothing from before is there: no state file of any version (any .json,
 * .jsonl or .key file in the folder, or a last good copy of one), no audit month, no tenant folder, no
 * saved sign-in, nothing a restore or an update left, and no plain backup in the backup folder. At a
 * first start the folder holds only the server's lock at that moment. Anything else is an existing
 * installation, so a doubt always ends in "leave it as it was", never in encrypting the backups of
 * people who have no key for them.
 *
 * The key is not part of a backup, is never emailed and never logged. An Admin reads it on the Audit
 * page and keeps it somewhere else: without it (or the server's state folder), a backup cannot be opened.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { STATE_DIRS, statePaths } from './data-dir.js';
import { lastGoodCopy, readState, writeState } from './state-file.js';

export const BACKUP_KEY_FILE = 'backup-key.json';

/** Letters and digits that are not mistaken for one another when read or typed (no I, O, 0, 1). */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const GROUPS = 8;
const GROUP_SIZE = 4;

/** A new key: 8 groups of 4 letters and digits (160 random bits), e.g. K7QM-2HXD-… */
export function generateBackupKey() {
  // 32 symbols: the low five bits of a random byte pick one, each equally likely.
  const symbols = [...randomBytes(GROUPS * GROUP_SIZE)].map((byte) => ALPHABET[byte & 31]);
  const groups = [];
  for (let i = 0; i < GROUPS; i += 1) groups.push(symbols.slice(i * GROUP_SIZE, (i + 1) * GROUP_SIZE).join(''));
  return groups.join('-');
}

/**
 * The key as it is stored, from the way someone typed it (lower case, spaces, no dashes): '' when the
 * text is not a backup key at all (a passphrase of the Admin's own, for instance).
 */
export function canonicalBackupKey(text) {
  const symbols = String(text ?? '').toUpperCase().replace(/[\s-]+/g, '');
  if (symbols.length !== GROUPS * GROUP_SIZE || [...symbols].some((s) => !ALPHABET.includes(s))) return '';
  return symbols.match(new RegExp(`.{${GROUP_SIZE}}`, 'g')).join('-');
}

/** BACKUP_ENCRYPTION=off (or 0, false, no): backups are left plain on purpose. */
export const encryptionOptedOut = (env = process.env) => /^(off|0|false|no)$/i.test(String(env.BACKUP_ENCRYPTION ?? '').trim());

const SEALED_MAGIC = Buffer.from('MZBK1\n');
function isPlainBackupFile(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(SEALED_MAGIC.length);
      fs.readSync(fd, head, 0, head.length, 0);
      return !head.equals(SEALED_MAGIC);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Cannot be read: counted as a plain backup, so the doubt ends in "leave it as it was".
    return true;
  }
}

/** Folders, beside the backed-up ones, that only a server which has run leaves something in. */
const WORK_DIRS = ['tenants', 'sessions', 'updater', 'report-files', 'git-cache'];
/** What a state file of any version is called: <name>.json, .jsonl or .key, its .bak, or one put aside as damaged. */
const STATE_LIKE = /\.(json|jsonl|key)(\.bak|\.damaged-.*)?$/;
/** A save that never finished (src/state-file.js): not state. */
const HALF_SAVED = /\.tmp$/;

const entries = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/**
 * What this installation holds from before, as a few words for the server's log; '' when nothing
 * (a new installation). Looked at before the server has loaded or written anything of its own.
 */
export function earlierState({ dataDir, settingsFile = '', backupDir = '' }) {
  // The state files by name (an older SETTINGS_FILE setup keeps its settings outside the folder), and their last good copies.
  for (const [name, file] of Object.entries(statePaths(dataDir, settingsFile))) {
    if (fs.existsSync(file)) return name;
    if (fs.existsSync(lastGoodCopy(file))) return `${name}.bak`;
  }
  // The folders a server fills as it runs.
  for (const dir of [...STATE_DIRS, ...WORK_DIRS]) {
    if (entries(path.join(dataDir, dir)).length) return `${dir}/`;
  }
  // Anything else a server of any version keeps directly in the folder: its files are .json, .jsonl and .key
  // (with .bak and .damaged-<time> beside them), and a restore leaves replaced-<time>/ or a staged backup.
  // A certificate or another file someone put there is not state. This file itself is never there yet.
  const left = entries(dataDir).find((name) => name !== BACKUP_KEY_FILE && !HALF_SAVED.test(name) && (STATE_LIKE.test(name) || name.startsWith('replaced-') || name === 'restore-pending.mzbackup'));
  if (left) return left;
  for (const dir of new Set([path.join(dataDir, 'backups'), backupDir].filter(Boolean).map((d) => path.resolve(d)))) {
    const plain = entries(dir).find((name) => name.endsWith('.mzbackup') && isPlainBackupFile(path.join(dir, name)));
    if (plain) return `a backup that is not encrypted (${plain})`;
  }
  return '';
}

/** The decision and the key, in <state folder>/backup-key.json. */
export class BackupKeyStore {
  #state = null;

  constructor({ dataDir, env = process.env }) {
    this.file = path.join(dataDir, BACKUP_KEY_FILE);
    this.env = env;
    this.#state = readState(this.file, { fallback: null, holds: 'the key this server encrypts its backups with' });
    if (this.#state && typeof this.#state !== 'object') this.#state = null;
  }

  #save() {
    writeState(this.file, this.#state, { mode: 0o600, space: 2, keepLast: false });
  }

  /** Has new-or-existing been decided for this state folder? */
  get decided() {
    return Boolean(this.#state?.mode);
  }

  /**
   * Decide, once, whether this is a new installation (encrypted from the first backup) or an existing
   * one (left plain until an Admin turns encryption on). Returns what was decided, or null when it
   * already had been.
   */
  decide({ settingsFile = '', backupDir = '', now = new Date() } = {}) {
    if (this.decided) return null;
    const found = earlierState({ dataDir: path.dirname(this.file), settingsFile, backupDir });
    const optedOut = encryptionOptedOut(this.env);
    const encrypt = !found && !optedOut;
    this.#state = {
      version: 1,
      mode: encrypt ? 'encrypted' : 'plain',
      decidedAt: now.toISOString(),
      decidedBy: found ? 'existing-installation' : optedOut ? 'opt-out' : 'new-installation',
      ...(encrypt ? { key: generateBackupKey(), keyCreatedAt: now.toISOString(), savedAt: null, savedBy: '' } : {}),
    };
    this.#save();
    return { mode: this.#state.mode, decidedBy: this.#state.decidedBy, found };
  }

  /** Keep the key a restore was opened with (scripts/restore.mjs), when this folder has decided nothing yet. */
  adopt(key, { now = new Date() } = {}) {
    const canonical = canonicalBackupKey(key);
    if (this.decided || !canonical) return false;
    this.#state = { version: 1, mode: 'encrypted', decidedAt: now.toISOString(), decidedBy: 'restore', key: canonical, keyCreatedAt: now.toISOString(), savedAt: now.toISOString(), savedBy: 'restore' };
    this.#save();
    return true;
  }

  get #passphrase() {
    return String(this.env.BACKUP_PASSPHRASE ?? '');
  }

  /** What encrypts a backup made now: 'passphrase' (BACKUP_PASSPHRASE), 'key' (the server's own), or 'none'. */
  get source() {
    if (this.#passphrase) return 'passphrase';
    if (encryptionOptedOut(this.env)) return 'none';
    return this.#state?.mode === 'encrypted' && this.#state.key ? 'key' : 'none';
  }

  /** The secret createBackup() seals with; '' for a plain backup. Never logged, never sent anywhere. */
  secret() {
    const { source } = this;
    return source === 'passphrase' ? this.#passphrase : source === 'key' ? this.#state.key : '';
  }

  /** Every secret a backup of this server may open with, the likeliest first (for a restore). */
  candidates() {
    return [...new Set([this.#passphrase, this.#state?.key ?? ''].filter(Boolean))];
  }

  /** The key itself, for the Admin who asked to see it; '' when the server has none. */
  reveal() {
    return this.#state?.key ?? '';
  }

  /** Turn encryption on (an Admin, on an installation whose backups were plain). Makes the key when there is none. */
  turnOn({ by = '', now = new Date() } = {}) {
    if (this.#state?.mode === 'encrypted' && this.#state.key) return false;
    this.#state = {
      version: 1,
      ...this.#state,
      mode: 'encrypted',
      turnedOnAt: now.toISOString(),
      turnedOnBy: by,
      key: this.#state?.key || generateBackupKey(),
      keyCreatedAt: this.#state?.keyCreatedAt || now.toISOString(),
      savedAt: null,
      savedBy: '',
    };
    this.#save();
    return true;
  }

  /** An Admin says they have saved the key somewhere else. */
  confirmSaved({ by = '', now = new Date() } = {}) {
    if (!this.#state?.key) return false;
    this.#state = { ...this.#state, savedAt: now.toISOString(), savedBy: by };
    this.#save();
    return true;
  }

  /** What the page may know (never the key). */
  status() {
    const { source } = this;
    const optedOut = encryptionOptedOut(this.env);
    const hasKey = Boolean(this.#state?.key);
    const saved = Boolean(this.#state?.savedAt);
    return {
      encrypted: source !== 'none',
      source,
      optedOut,
      hasKey,
      keySaved: saved,
      keySavedAt: this.#state?.savedAt ?? null,
      keySavedBy: this.#state?.savedBy ?? '',
      keyCreatedAt: this.#state?.keyCreatedAt ?? null,
      // An Admin can turn encryption on from the page: nothing in the environment decides it, and it is off.
      canTurnOn: source === 'none' && !optedOut,
      // What Admins are told until they act: the key is in use and nobody confirmed saving it, or backups are plain
      // (not when they are plain on purpose).
      notice: source === 'key' && !saved ? 'save-key' : source === 'none' && !optedOut ? 'not-encrypted' : null,
    };
  }
}
