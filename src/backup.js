/**
 * Backups: one file that holds everything needed to rebuild this server from
 * scratch — settings, credit ledger and allocations, tracked reports, known
 * addresses, automation state, the audit log and both signing keys.
 *
 * Format: gzip of a JSON bundle
 *   {format, version, createdAt, host, files: {name: {data (base64), size, sha256}}, sha256}
 * where `sha256` covers every file's name and hash, so a damaged backup is
 * refused rather than half-restored. With a passphrase the gzip is sealed with
 * AES-256-GCM (key from scrypt): the backup holds the SMTP password and any
 * stored API key, so keep unencrypted backups somewhere only admins can read.
 *
 * Restore writes the files back into the state folder; whatever was there is
 * moved aside to replaced-<time>/ first, never deleted.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { STATE_DIRS, TENANT_FILES, TENANT_ID, statePaths } from './data-dir.js';

export const BACKUP_FORMAT = 'mission-zero-backup';
const SEALED_FORMAT = 'mission-zero-backup-sealed';
const MAGIC_SEALED = Buffer.from('MZBK1\n');
export const BACKUP_EXTENSION = '.mzbackup';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

function manifestHash(files) {
  const lines = Object.keys(files)
    .sort()
    .map((name) => `${name} ${files[name].sha256} ${files[name].size}`);
  return sha256(lines.join('\n'));
}

/** Every state file present: [{name, path}] (audit months as audit/<file>). */
export function collectStateFiles(dataDir, settingsFile = '') {
  const found = [];
  for (const [name, file] of Object.entries(statePaths(dataDir, settingsFile))) {
    if (fs.existsSync(file)) found.push({ name, path: file });
  }
  for (const dir of STATE_DIRS) {
    const folder = path.join(dataDir, dir);
    if (!fs.existsSync(folder)) continue;
    for (const entry of fs.readdirSync(folder).sort()) {
      const file = path.join(folder, entry);
      if (fs.statSync(file).isFile()) found.push({ name: `${dir}/${entry}`, path: file });
    }
  }
  // Each further tenant's files (tenants/<id>/…); removed tenants' folders are not included.
  const tenantsDir = path.join(dataDir, 'tenants');
  if (fs.existsSync(tenantsDir)) {
    for (const id of fs.readdirSync(tenantsDir).sort()) {
      if (!TENANT_ID.test(id)) continue;
      const folder = path.join(tenantsDir, id);
      for (const name of TENANT_FILES) {
        const file = path.join(folder, name);
        if (fs.existsSync(file)) found.push({ name: `tenants/${id}/${name}`, path: file });
      }
      for (const dir of STATE_DIRS) {
        const sub = path.join(folder, dir);
        if (!fs.existsSync(sub)) continue;
        for (const entry of fs.readdirSync(sub).sort()) {
          const file = path.join(sub, entry);
          if (fs.statSync(file).isFile()) found.push({ name: `tenants/${id}/${dir}/${entry}`, path: file });
        }
      }
    }
  }
  return found;
}

/** Build a backup of the state folder. Returns {buffer, summary}. */
export function createBackup({ dataDir, settingsFile = '', passphrase = '', now = new Date() }) {
  const files = {};
  for (const { name, path: file } of collectStateFiles(dataDir, settingsFile)) {
    const data = fs.readFileSync(file);
    files[name] = { data: data.toString('base64'), size: data.length, sha256: sha256(data) };
  }
  const bundle = {
    format: BACKUP_FORMAT,
    version: 1,
    createdAt: now.toISOString(),
    host: os.hostname(),
    files,
    sha256: manifestHash(files),
  };
  let buffer = zlib.gzipSync(Buffer.from(JSON.stringify(bundle)));
  if (passphrase) buffer = seal(buffer, passphrase);
  return {
    buffer,
    summary: {
      createdAt: bundle.createdAt,
      files: Object.keys(files).length,
      bytes: Object.values(files).reduce((sum, f) => sum + f.size, 0),
      size: buffer.length,
      sha256: bundle.sha256,
      encrypted: Boolean(passphrase),
    },
  };
}

function seal(plain, passphrase) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const header = JSON.stringify({ format: SEALED_FORMAT, kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') });
  return Buffer.concat([MAGIC_SEALED, Buffer.from(`${header}\n`), data]);
}

function unseal(buffer, passphrase) {
  const rest = buffer.subarray(MAGIC_SEALED.length);
  const newline = rest.indexOf(0x0a);
  const header = JSON.parse(rest.subarray(0, newline).toString('utf8'));
  if (header.format !== SEALED_FORMAT) throw new Error('Not a CxMissionZero backup.');
  if (!passphrase) throw new Error('This backup is encrypted: give its passphrase (BACKUP_PASSPHRASE).');
  const key = scryptSync(passphrase, Buffer.from(header.salt, 'base64'), 32);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(header.tag, 'base64'));
  try {
    return Buffer.concat([decipher.update(rest.subarray(newline + 1)), decipher.final()]);
  } catch {
    throw new Error('Wrong passphrase, or the backup is damaged.');
  }
}

/** The most a backup may unpack to. */
export const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;

/** Read and check a backup. Throws with a readable reason; returns the bundle. */
export function readBackup(buffer, { passphrase = '', maxUnpackedBytes = MAX_UNPACKED_BYTES } = {}) {
  let data = Buffer.from(buffer);
  if (data.subarray(0, MAGIC_SEALED.length).equals(MAGIC_SEALED)) data = unseal(data, passphrase);
  let bundle;
  try {
    // Capped, so a small file that unpacks to gigabytes cannot exhaust the server's memory.
    bundle = JSON.parse(zlib.gunzipSync(data, { maxOutputLength: maxUnpackedBytes }).toString('utf8'));
  } catch (error) {
    if (error?.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new Error(`This backup unpacks to more than ${Math.round(maxUnpackedBytes / 1024 / 1024)} MB, more than any CxMissionZero backup holds. It is damaged or not a CxMissionZero backup.`);
    }
    throw new Error('Not a CxMissionZero backup (or the file is damaged).');
  }
  if (bundle?.format !== BACKUP_FORMAT || typeof bundle.files !== 'object') throw new Error('Not a CxMissionZero backup.');
  if (bundle.version !== 1) throw new Error(`Backup version ${bundle.version} is newer than this server understands.`);
  for (const [name, file] of Object.entries(bundle.files)) {
    if (!safeName(name)) throw new Error(`Backup contains an unexpected file name: ${name}`);
    const bytes = Buffer.from(file.data, 'base64');
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw new Error(`Backup file ${name} is damaged (checksum mismatch).`);
  }
  if (manifestHash(bundle.files) !== bundle.sha256) throw new Error('Backup contents do not match its checksum.');
  return bundle;
}

/** Only the file names a backup can legitimately hold: no paths out of the state folder. */
function safeName(name) {
  const known = Object.keys(statePaths('/'));
  if (known.includes(name)) return true;
  const parts = name.split('/');
  // A further tenant's files: tenants/<id>/<file> or tenants/<id>/audit/<file>.
  if (parts[0] === 'tenants') {
    const [, id, first, second, ...rest] = parts;
    if (!TENANT_ID.test(id ?? '') || rest.length) return false;
    if (second === undefined) return TENANT_FILES.includes(first);
    return STATE_DIRS.includes(first) && /^[\w.-]+$/.test(second) && !second.startsWith('.');
  }
  const [dir, file, ...more] = parts;
  return STATE_DIRS.includes(dir) && !more.length && /^[\w.-]+$/.test(file ?? '') && !file.startsWith('.');
}

/** What a backup holds, for showing before a restore. */
export function describeBackup(bundle) {
  const names = Object.keys(bundle.files);
  const audit = names.filter((n) => n.startsWith('audit/audit-'));
  return {
    createdAt: bundle.createdAt,
    host: bundle.host,
    files: names.length,
    bytes: Object.values(bundle.files).reduce((sum, f) => sum + f.size, 0),
    hasSettings: names.includes('settings.json'),
    hasLedger: names.includes('triage-credits.json'),
    hasAllocations: names.includes('credit-allocations.json'),
    hasAuditKey: names.includes('audit.key'),
    auditMonths: audit.map((n) => n.slice(12, 19)).sort(),
    sha256: bundle.sha256,
  };
}

/**
 * Write a backup's files into the state folder. Files already there are moved
 * to <dataDir>/replaced-<time>/ first. Returns {restored, replacedDir}.
 */
export function restoreBackup(bundle, { dataDir, settingsFile = '', now = new Date() }) {
  const targets = statePaths(dataDir, settingsFile);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const replacedDir = path.join(dataDir, `replaced-${stamp}`);
  let movedAny = false;
  const moveAside = (file, name) => {
    if (!fs.existsSync(file)) return;
    const to = path.join(replacedDir, name);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.renameSync(file, to);
    movedAny = true;
  };

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // Everything the backup replaces goes aside — including audit months the
  // backup does not have, so the restored audit chain is exactly the backup's.
  for (const [name, file] of Object.entries(targets)) moveAside(file, name);
  for (const dir of STATE_DIRS) {
    const folder = path.join(dataDir, dir);
    if (!fs.existsSync(folder)) continue;
    for (const entry of fs.readdirSync(folder)) moveAside(path.join(folder, entry), `${dir}/${entry}`);
  }
  // The further tenants' folders go aside too, so the restored tenants are exactly the backup's.
  const tenantsDir = path.join(dataDir, 'tenants');
  if (fs.existsSync(tenantsDir)) for (const entry of fs.readdirSync(tenantsDir)) moveAside(path.join(tenantsDir, entry), `tenants/${entry}`);

  const restored = [];
  for (const [name, file] of Object.entries(bundle.files)) {
    const target = targets[name] ?? path.join(dataDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.restore-${process.pid}`;
    fs.writeFileSync(tmp, Buffer.from(file.data, 'base64'), { mode: 0o600 });
    fs.renameSync(tmp, target);
    restored.push(name);
  }
  return { restored, replacedDir: movedAny ? replacedDir : null };
}

/** Timestamped file name for a backup. */
export function backupFileName(now = new Date()) {
  return `mission-zero-${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}${BACKUP_EXTENSION}`;
}

/** Backups in a folder, newest first. */
export function listBackups(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('mission-zero-') && f.endsWith(BACKUP_EXTENSION))
    .map((f) => {
      const stat = fs.statSync(path.join(dir, f));
      return { name: f, size: stat.size, at: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** Write a backup into `dir`, keeping the newest `keep`. Returns {file, summary, removed}. */
export function writeBackupTo(dir, { dataDir, settingsFile = '', passphrase = '', keep = 14, now = new Date() }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { buffer, summary } = createBackup({ dataDir, settingsFile, passphrase, now });
  const file = path.join(dir, backupFileName(now));
  const tmp = `${file}.partial`;
  fs.writeFileSync(tmp, buffer, { mode: 0o600 });
  fs.renameSync(tmp, file);
  const removed = [];
  for (const old of listBackups(dir).slice(Math.max(1, keep))) {
    fs.rmSync(path.join(dir, old.name), { force: true });
    removed.push(old.name);
  }
  return { file, summary, removed };
}

export const PENDING_RESTORE = 'restore-pending.mzbackup';

/**
 * A restore uploaded through the web page is applied at the next start, before
 * anything loads — the running server would otherwise write its in-memory
 * state straight over it. Returns the applied bundle's description, or null.
 */
export function applyPendingRestore({ dataDir, settingsFile = '', passphrase = '' }) {
  const pending = path.join(dataDir, PENDING_RESTORE);
  if (!fs.existsSync(pending)) return null;
  const bundle = readBackup(fs.readFileSync(pending), { passphrase });
  const result = restoreBackup(bundle, { dataDir, settingsFile });
  fs.rmSync(pending, { force: true });
  return { ...describeBackup(bundle), ...result };
}
