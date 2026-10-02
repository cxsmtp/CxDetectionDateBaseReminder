#!/usr/bin/env node
/**
 * Rebuild the server state from a backup. Run it with the server STOPPED.
 *
 *   node scripts/restore.mjs <backup file> [--yes]
 *
 * Without --yes it only checks the backup and shows what it holds. Files
 * already in the state folder are moved to replaced-<time>/, never deleted.
 * BACKUP_PASSPHRASE opens an encrypted backup. The state folder comes from
 * DATA_DIR / SETTINGS_FILE, as for the server (default ~/.mission-zero).
 */
import '../src/load-env.js';
import fs from 'node:fs';

import { describeBackup, readBackup, restoreBackup } from '../src/backup.js';
import { prepareDataDir, resolveDataDir } from '../src/data-dir.js';

const [file, flag] = process.argv.slice(2);
if (!file) {
  console.error('Usage: node scripts/restore.mjs <backup file> [--yes]');
  process.exit(2);
}
const { dir: dataDir } = resolveDataDir();
const settingsFile = process.env.SETTINGS_FILE?.trim() || '';

let bundle;
try {
  bundle = readBackup(fs.readFileSync(file), { passphrase: process.env.BACKUP_PASSPHRASE || '' });
} catch (error) {
  console.error(`Cannot restore: ${error.message}`);
  process.exit(1);
}
const info = describeBackup(bundle);
console.log(`Backup from ${info.createdAt} (host ${info.host}): ${info.files} files, ${info.bytes} bytes, checksum OK.`);
console.log(`  settings: ${info.hasSettings ? 'yes' : 'no'}; credit ledger: ${info.hasLedger ? 'yes' : 'no'}; allocations: ${info.hasAllocations ? 'yes' : 'no'}`);
console.log(`  audit months: ${info.auditMonths.join(', ') || 'none'}${info.hasAuditKey ? '' : ' (no audit key: the restored log cannot be verified)'}`);
console.log(`  target state folder: ${dataDir}`);
if (flag !== '--yes') {
  console.log('\nNothing written. Stop the server, then run again with --yes to restore.');
  process.exit(0);
}
prepareDataDir(dataDir);
const { restored, replacedDir } = restoreBackup(bundle, { dataDir, settingsFile });
console.log(`\nRestored ${restored.length} files into ${dataDir}.`);
if (replacedDir) console.log(`Files that were there before are in ${replacedDir}.`);
console.log('Start the server; the Audit tab\'s "Verify integrity" confirms the restored log.');
