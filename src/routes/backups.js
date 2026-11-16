/**
 * Audit → State & backups: the routes under /api/backup (src/backup.js, src/backup-key.js).
 *
 * What the page shows (the state folder, the backup folder, the last backup, encryption and its key), a backup
 * now or as a download, and a restore: the uploaded file is checked and staged, and applied when the server
 * next starts, before anything loads (src/server.js). The scheduled backup, the copy to the backup mailbox and
 * the backup before a stop stay in src/server.js, with the start-up and the shutdown they belong to.
 */
import path from 'node:path';
import express from 'express';
import { config } from '../config.js';
import { insideProject } from '../data-dir.js';
import { BackupKeyError, PENDING_RESTORE, collectStateFiles, createBackup, describeBackup, listBackups, readBackup } from '../backup.js';
import fs from 'node:fs';
import os from 'node:os';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';

/**
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerBackupRoutes(app, d) {
  const {
    projectDir, dataDir, dataDirSource, backupKey, restoredAtStart, audit, asyncRoute, requirePermission, adminActor,
    backupConfig, lastBackup, settleState, backupToFolder,
  } = d;

  app.get('/api/backup', requirePermission('backup.view'), (req, res) => {
    const files = collectStateFiles(dataDir, config.settingsFile);
    const bytes = files.reduce((sum, f) => sum + fs.statSync(f.path).size, 0);
    res.json({
      dataDir,
      source: dataDirSource,
      insideProject: insideProject(dataDir, projectDir),
      files: files.length,
      bytes,
      backupDir: backupConfig.dir,
      backupDirExplicit: backupConfig.explicitDir,
      sameDisk: !backupConfig.explicitDir || insideProject(backupConfig.dir, dataDir),
      intervalHours: backupConfig.intervalHours,
      keep: backupConfig.keep,
      encrypted: Boolean(backupConfig.passphrase),
      // What encrypts a backup made now, whether its key was saved elsewhere, and whether an Admin can turn it on (never the key).
      encryption: backupKey.status(),
      last: lastBackup(),
      backups: listBackups(backupConfig.dir).slice(0, 30),
      pendingRestore: fs.existsSync(path.join(dataDir, PENDING_RESTORE)),
      restoredAtStart: restoredAtStart && { createdAt: restoredAtStart.createdAt, files: restoredAtStart.files, replacedDir: restoredAtStart.replacedDir },
    });
  });

  /**
   * The server's own backup key (src/backup-key.js), for those who may download and restore backups (Admins).
   * It is shown on request only, each showing is audited (never the key), and it goes nowhere else: not into
   * a backup, an email or a log.
   */
  app.post('/api/backup/key/show', requirePermission('backup.manage'), asyncRoute(async (req, res) => {
    const key = backupKey.reveal();
    if (!key) return res.status(409).json({ error: 'This server has no backup key: backup encryption has not been turned on.' });
    audit.record({ type: 'backup', outcome: 'info', reason: 'Backup key shown.', actor: await adminActor(req) });
    await audit.settled();
    const { keyCreatedAt, keySaved } = backupKey.status();
    res.set('Cache-Control', 'no-store').json({ key, createdAt: keyCreatedAt, saved: keySaved, host: os.hostname() });
  }));

  /** "I have saved it": an Admin kept the backup key somewhere other than this server. */
  app.post('/api/backup/key/confirm', requirePermission('backup.manage'), asyncRoute(async (req, res) => {
    const actor = await adminActor(req);
    if (!backupKey.confirmSaved({ by: actor.email })) return res.status(409).json({ error: 'This server has no backup key: backup encryption has not been turned on.' });
    audit.record({ type: 'backup', outcome: 'changed', reason: 'Backup key confirmed as saved somewhere other than this server.', actor });
    res.json({ encryption: backupKey.status() });
  }));

  /** Turn backup encryption on, on an installation whose backups were plain: the server makes its backup key now. */
  app.post('/api/backup/encryption', requirePermission('backup.manage'), asyncRoute(async (req, res) => {
    if (req.body?.on !== true) return res.status(400).json({ error: 'Backup encryption can be turned on here. To keep backups plain, set BACKUP_ENCRYPTION=off on the server.' });
    const before = backupKey.status();
    if (before.source === 'passphrase') return res.status(409).json({ error: 'Backups are already encrypted, with BACKUP_PASSPHRASE.' });
    if (before.optedOut) return res.status(409).json({ error: 'BACKUP_ENCRYPTION=off is set on the server: remove it and restart to encrypt backups.' });
    const actor = await adminActor(req);
    if (backupKey.turnOn({ by: actor.email })) {
      audit.record({ type: 'backup', outcome: 'changed', reason: 'Backup encryption turned on: backups are encrypted with this server\'s backup key from now on.', actor });
    }
    res.json({ encryption: backupKey.status() });
  }));

  /** Download a backup now (encrypted with BACKUP_PASSPHRASE or the server's backup key, when either is in use). */
  app.get('/api/backup/download', requirePermission('backup.manage'), asyncRoute(async (req, res) => {
    await settleState();
    const { buffer, summary } = createBackup({ dataDir, settingsFile: config.settingsFile, passphrase: backupConfig.passphrase });
    audit.record({
      type: 'backup',
      outcome: 'info',
      reason: `Backup downloaded (${summary.files} files${summary.encrypted ? ', encrypted' : ', not encrypted'}).`,
      actor: await adminActor(req),
      details: { backup: summary },
    });
    const stamp = summary.createdAt.replace(/[:.]/g, '-').slice(0, 19);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="mission-zero-${stamp}.mzbackup"`);
    res.send(buffer);
  }));

  app.post('/api/backup/now', requirePermission('backup.run'), asyncRoute(async (req, res) => {
    const result = await backupToFolder(await adminActor(req), 'Manual');
    if (!result.ok) return res.status(500).json({ error: `Backup failed: ${result.error}` });
    res.json({ ...result, backups: listBackups(backupConfig.dir).slice(0, 30) });
  }));

  /**
   * Upload a backup. ?check=1 only reads it and says what it holds. Otherwise
   * it is staged and applied at the next start: the running server would write
   * its in-memory state straight over restored files.
   */
  app.post(
    '/api/backup/restore',
    requirePermission('backup.manage'),
    express.raw({ type: () => true, limit: '200mb' }),
    asyncRoute(async (req, res) => {
      const actor = await adminActor(req);
      let bundle;
      // What the person typed first, then what this server encrypts with: a backup of its own opens without asking.
      const given = String(req.get('x-backup-passphrase') ?? '');
      try {
        bundle = readBackup(req.body ?? Buffer.alloc(0), { passphrases: [given, ...backupKey.candidates()] });
      } catch (error) {
        const needsKey = error instanceof BackupKeyError;
        // Nothing was typed and this server's own key does not open it: say whose key is needed, not "wrong".
        const message = needsKey && !given
          ? 'This backup is encrypted, and this server\'s own backup key or passphrase does not open it. Give the backup key of the server that made it (saved from its Audit → State & backups), or the BACKUP_PASSPHRASE that server had.'
          : error.message;
        if (req.query.check !== '1') audit.record({ type: 'backup', outcome: 'refused', reason: `Restore refused: ${message}`, actor });
        return res.status(400).json({ error: message, needsKey });
      }
      const info = describeBackup(bundle);
      if (req.query.check === '1') return res.json({ backup: info });
      // Staged decrypted: it sits in the state folder (0600) beside the same secrets.
      const pending = path.join(dataDir, PENDING_RESTORE);
      const partial = `${pending}.${randomUUID()}.partial`;
      fs.writeFileSync(partial, zlib.gzipSync(Buffer.from(JSON.stringify(bundle))), { mode: 0o600, flag: 'wx' });
      fs.renameSync(partial, pending);
      audit.record({
        type: 'backup',
        outcome: 'changed',
        reason: `Restore staged from the backup of ${info.createdAt}: applied at the next restart.`,
        actor,
        details: { restore: { createdAt: info.createdAt, host: info.host, files: info.files, sha256: info.sha256 } },
      });
      await audit.settled();
      res.json({ backup: info, staged: true, restartRequired: true });
    }),
  );

  app.delete('/api/backup/restore', requirePermission('backup.manage'), asyncRoute(async (req, res) => {
    const pending = path.join(dataDir, PENDING_RESTORE);
    if (fs.existsSync(pending)) {
      fs.rmSync(pending, { force: true });
      audit.record({ type: 'backup', outcome: 'changed', reason: 'Staged restore cancelled.', actor: await adminActor(req) });
    }
    res.json({ pendingRestore: false });
  }));
}
