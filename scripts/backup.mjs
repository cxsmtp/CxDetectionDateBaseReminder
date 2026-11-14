#!/usr/bin/env node
/**
 * Back up the whole server state into one file (works with the server running
 * or stopped).
 *
 *   node scripts/backup.mjs [output file or folder]
 *
 * Default output: $BACKUP_DIR, else the current folder. The backup is encrypted
 * as the server's own are: with BACKUP_PASSPHRASE when set, else with the
 * server's backup key (in the state folder) when encryption is on, else not at
 * all. BACKUP_ENCRYPTION=off keeps it plain. The state folder comes from
 * DATA_DIR / SETTINGS_FILE, as for the server (default ~/.mission-zero).
 */
import '../src/load-env.js';
import fs from 'node:fs';
import path from 'node:path';

import { backupFileName, createBackup, describeBackup, readBackup } from '../src/backup.js';
import { BackupKeyStore } from '../src/backup-key.js';
import { resolveDataDir } from '../src/data-dir.js';

const { dir: dataDir } = resolveDataDir();
const settingsFile = process.env.SETTINGS_FILE?.trim() || '';
const target = process.argv[2] || process.env.BACKUP_DIR || '.';

if (!fs.existsSync(dataDir)) {
  console.error(`No state folder at ${dataDir}. Set DATA_DIR to the server's state folder.`);
  process.exit(1);
}
// Read only: whether this installation is new or existing is the server's to decide, at its start.
let backupKey;
try {
  backupKey = new BackupKeyStore({ dataDir });
} catch (error) {
  // The key file is there and cannot be read: said in plain words, as the server says it, and nothing is written.
  console.error(`Cannot back up: ${error.message}`);
  process.exit(1);
}
const passphrase = backupKey.secret();
const isFolder = (fs.existsSync(target) && fs.statSync(target).isDirectory()) || target.endsWith('/');
const out = isFolder ? path.join(target, backupFileName()) : target;
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });

const { buffer, summary } = createBackup({ dataDir, settingsFile, passphrase });
const info = describeBackup(readBackup(buffer, { passphrase })); // prove it reads back before saying it worked
fs.writeFileSync(out, buffer, { mode: 0o600 });
console.log(`Backed up ${summary.files} files (${summary.bytes} bytes) from ${dataDir}`);
console.log(`  → ${path.resolve(out)} (${summary.size} bytes${summary.encrypted ? `, encrypted with ${backupKey.source === 'passphrase' ? 'BACKUP_PASSPHRASE' : 'the server\'s backup key'}` : ''})`);
console.log(`  audit months: ${info.auditMonths.join(', ') || 'none'}; checksum ${summary.sha256.slice(0, 16)}…`);
if (backupKey.source === 'key' && !backupKey.status().keySaved) console.log('  Nobody has confirmed saving the backup key yet: an Admin saves it from Audit → State & backups. Without it this backup cannot be opened on another server.');
if (!summary.encrypted) console.log('  Not encrypted: it holds the SMTP password and stored keys. Keep it where only admins can read it, or turn encryption on (Audit → State & backups, or BACKUP_PASSPHRASE).');
