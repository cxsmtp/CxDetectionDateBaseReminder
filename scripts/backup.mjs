#!/usr/bin/env node
/**
 * Back up the whole server state into one file (works with the server running
 * or stopped).
 *
 *   node scripts/backup.mjs [output file or folder]
 *
 * Default output: $BACKUP_DIR, else the current folder. BACKUP_PASSPHRASE
 * encrypts the backup. The state folder comes from DATA_DIR / SETTINGS_FILE,
 * as for the server (default ~/.mission-zero).
 */
import '../src/load-env.js';
import fs from 'node:fs';
import path from 'node:path';

import { backupFileName, createBackup, describeBackup, readBackup } from '../src/backup.js';
import { resolveDataDir } from '../src/data-dir.js';

const { dir: dataDir } = resolveDataDir();
const settingsFile = process.env.SETTINGS_FILE?.trim() || '';
const passphrase = process.env.BACKUP_PASSPHRASE || '';
const target = process.argv[2] || process.env.BACKUP_DIR || '.';

if (!fs.existsSync(dataDir)) {
  console.error(`No state folder at ${dataDir}. Set DATA_DIR to the server's state folder.`);
  process.exit(1);
}
const isFolder = (fs.existsSync(target) && fs.statSync(target).isDirectory()) || target.endsWith('/');
const out = isFolder ? path.join(target, backupFileName()) : target;
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });

const { buffer, summary } = createBackup({ dataDir, settingsFile, passphrase });
const info = describeBackup(readBackup(buffer, { passphrase })); // prove it reads back before saying it worked
fs.writeFileSync(out, buffer, { mode: 0o600 });
console.log(`Backed up ${summary.files} files (${summary.bytes} bytes) from ${dataDir}`);
console.log(`  → ${path.resolve(out)} (${summary.size} bytes${summary.encrypted ? ', encrypted' : ''})`);
console.log(`  audit months: ${info.auditMonths.join(', ') || 'none'}; checksum ${summary.sha256.slice(0, 16)}…`);
if (!summary.encrypted) console.log('  Not encrypted: it holds the SMTP password and stored keys. Keep it where only admins can read it, or set BACKUP_PASSPHRASE.');
