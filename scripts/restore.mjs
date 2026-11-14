#!/usr/bin/env node
/**
 * Rebuild the server state from a backup. Run it with the server STOPPED.
 *
 *   node scripts/restore.mjs <backup file> [--yes] [--force]
 *
 * Without --yes it only checks the backup and shows what it holds. Files
 * already in the state folder are moved to replaced-<time>/, never deleted.
 * An encrypted backup opens with BACKUP_PASSPHRASE: the passphrase the server
 * that made it had, or that server's backup key (saved from Audit → State &
 * backups). A backup this state folder's own server made opens without it. The
 * state folder comes from DATA_DIR / SETTINGS_FILE, as for the server (default
 * ~/.mission-zero).
 *
 * Restored into a folder that has decided nothing about backup encryption yet
 * (a rebuilt server) with a server's backup key, the folder keeps that key: the
 * rebuilt server goes on encrypting its backups with the key already saved.
 *
 * A running server would keep writing its own copy over the restored files, so
 * the restore takes the server's lock on the state folder first and refuses
 * while a server holds it. A lock left by a server that crashed is watched for
 * INSTANCE_LOCK_STALE_SECONDS (30) and then taken over. --force restores
 * without looking at the lock: only when that server is certainly not running.
 */
import '../src/load-env.js';
import fs from 'node:fs';

import { BackupKeyError, describeBackup, isSealed, readBackup, restoreBackup } from '../src/backup.js';
import { BackupKeyStore, canonicalBackupKey } from '../src/backup-key.js';
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

// What may open an encrypted backup: BACKUP_PASSPHRASE (a passphrase, or a server's backup key), then the
// backup key this state folder already holds (a backup this same server made).
let ownKey = null;
try {
  ownKey = new BackupKeyStore({ dataDir });
} catch {
  // Its key file cannot be read: the restore goes on with what was given.
}
const given = process.env.BACKUP_PASSPHRASE || '';
const secrets = [...new Set([given, ownKey?.reveal() ?? ''].filter(Boolean))];

let bundle;
let sealed = false;
/** The secret the backup opened with ('' for a plain one). */
let openedWith = '';
try {
  const buffer = fs.readFileSync(file);
  sealed = isSealed(buffer);
  if (!sealed || !secrets.length) {
    bundle = readBackup(buffer);
  } else {
    for (const secret of secrets) {
      try {
        bundle = readBackup(buffer, { passphrase: secret });
        openedWith = secret;
        break;
      } catch (error) {
        if (!(error instanceof BackupKeyError) || secret === secrets.at(-1)) throw error;
      }
    }
  }
} catch (error) {
  if (error instanceof BackupKeyError) {
    console.error(
      error.code === 'BACKUP_KEY_NEEDED'
        ? 'Cannot restore: this backup is encrypted, and no backup key or passphrase was given.'
        : `Cannot restore: this backup is encrypted, and it did not open with ${given ? 'the BACKUP_PASSPHRASE given' : 'this state folder\'s own backup key'}. The key or passphrase is wrong, or the backup is damaged.`,
    );
    console.error('It opens with the backup key of the server that made it (an Admin saved it from Audit → State & backups), or with the BACKUP_PASSPHRASE that server had.');
    console.error('Give it in BACKUP_PASSPHRASE and run this again:');
    console.error('  Linux, macOS:  BACKUP_PASSPHRASE=<the key> npm run restore -- <backup file>');
    console.error('  Windows cmd:   set BACKUP_PASSPHRASE=<the key>   then   npm run restore -- <backup file>');
    console.error('Nothing was written.');
  } else {
    console.error(`Cannot restore: ${error.message}`);
  }
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
let keptKey = false;
try {
  // The lock is beaten between files: a long restore gives its timer no turn, and a lock that stopped changing
  // would be taken over by a server started meanwhile.
  done = restoreBackup(bundle, { dataDir, settingsFile, onFile: () => lock?.touch() });
  // A rebuilt server (nothing decided here yet) restored with a server's backup key keeps that key, so its
  // backups stay encrypted with the one already saved. A passphrase of the Admin's own is never written down.
  if (sealed && ownKey && !ownKey.decided) keptKey = ownKey.adopt(openedWith);
} finally {
  lock?.release();
}
console.log(`\nRestored ${done.restored.length} files into ${dataDir}.`);
if (done.replacedDir) console.log(`Files that were there before are in ${done.replacedDir}.`);
if (keptKey) {
  console.log('This server goes on encrypting its backups with the same backup key.');
} else if (sealed && ownKey && !ownKey.decided && !canonicalBackupKey(openedWith)) {
  console.log('The backup was encrypted with a passphrase: start the server with the same BACKUP_PASSPHRASE to keep its backups encrypted.');
  console.log('Without it they are not encrypted until an Admin turns encryption on (Audit → State & backups).');
}
console.log('Start the server; the Audit tab\'s "Verify integrity" confirms the restored log.');
