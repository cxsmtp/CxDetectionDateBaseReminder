#!/usr/bin/env node
/**
 * Rebuild the server state from a backup. Run it with the server STOPPED.
 *
 *   node scripts/restore.mjs <backup file> [--yes] [--force]
 *
 * Without --yes it only checks the backup and shows what it holds. Files
 * already in the state folder are moved to replaced-<time>/, never deleted.
 * BACKUP_PASSPHRASE opens an encrypted backup. The state folder comes from
 * DATA_DIR / SETTINGS_FILE, as for the server (default ~/.mission-zero).
 *
 * A running server would keep writing its own copy over the restored files, so
 * the restore takes the server's lock on the state folder first and refuses
 * while a server holds it. A lock left by a server that crashed is watched for
 * INSTANCE_LOCK_STALE_SECONDS (30) and then taken over. --force restores
 * without looking at the lock: only when that server is certainly not running.
 */
import '../src/load-env.js';
import fs from 'node:fs';

import { describeBackup, readBackup, restoreBackup } from '../src/backup.js';
import { prepareDataDir, resolveDataDir } from '../src/data-dir.js';
import { InstanceLock } from '../src/instance-lock.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [file] = args.filter((a) => !a.startsWith('--'));
if (!file) {
  console.error('Usage: node scripts/restore.mjs <backup file> [--yes] [--force]');
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
if (!flags.has('--yes')) {
  console.log('\nNothing written. Stop the server, then run again with --yes to restore.');
  process.exit(0);
}
prepareDataDir(dataDir);

// Hold the server's lock for the restore, so no server writes the folder meanwhile (or starts halfway through).
let lock = null;
if (flags.has('--force')) {
  console.log('\n--force: restoring without checking whether a server is using this folder.');
} else {
  const staleSeconds = Math.max(3, Number(process.env.INSTANCE_LOCK_STALE_SECONDS ?? 30));
  lock = new InstanceLock(dataDir, { staleMs: staleSeconds * 1000 });
  try {
    await lock.acquire({
      waitMs: 0,
      onWait: (held) => console.log(`\nA server (host ${held.host}, started ${held.startedAt}) left its lock on this folder. Watching it for up to ${staleSeconds} s to see whether that server is still running…`),
    });
  } catch (error) {
    if (error.code !== 'ELOCKED') {
      console.error(`Cannot restore: ${error.message}`);
      process.exit(1);
    }
    console.error(`\nCannot restore: a CxMissionZero server (host ${error.holder.host}, started ${error.holder.startedAt}) is running on ${dataDir}.`);
    console.error('Stop the server first, then run this again. Nothing was written.');
    console.error('If that server is certainly not running any more, add --force to restore anyway.');
    process.exit(1);
  }
}
let done;
try {
  done = restoreBackup(bundle, { dataDir, settingsFile });
} finally {
  lock?.release();
}
console.log(`\nRestored ${done.restored.length} files into ${dataDir}.`);
if (done.replacedDir) console.log(`Files that were there before are in ${done.replacedDir}.`);
console.log('Start the server; the Audit tab\'s "Verify integrity" confirms the restored log.');
