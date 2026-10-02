#!/usr/bin/env node
/**
 * Lost the administrator's password (or the first-start one scrolled out of
 * the log)? Set a new temporary one, printed here once. The server may be
 * running: it picks the change up at once. The administrator chooses their
 * own password at the next sign-in. Recorded in the audit log.
 *
 *   node scripts/reset-admin.mjs [email]
 *   docker exec mission-zero node scripts/reset-admin.mjs
 *   podman exec mission-zero node scripts/reset-admin.mjs
 *
 * Without an email: the first active Admin (created if there is none).
 */
import '../src/load-env.js';
import path from 'node:path';

import { AuditLog } from '../src/audit-log.js';
import { prepareDataDir, resolveDataDir } from '../src/data-dir.js';
import { IamStore, generatePassword } from '../src/iam.js';

const { dir } = resolveDataDir();
prepareDataDir(dir);
const iam = new IamStore({ file: path.join(dir, 'iam.json') });
const wanted = process.argv[2]?.trim();
const password = generatePassword();

let user = wanted ? iam.findByEmail(wanted) : iam.users().find((u) => u.role === 'admin' && !u.disabled);
if (wanted && !user) {
  console.error(`No user ${wanted}. Users: ${iam.users().map((u) => `${u.email} (${u.role})`).join(', ') || 'none'}`);
  process.exit(1);
}
let created = false;
if (!user) {
  user = await iam.createUser({ email: process.env.ADMIN_EMAIL?.trim() || 'admin@mission-zero.local', name: 'Administrator', role: 'admin', password, mustChangePassword: true });
  created = true;
} else {
  await iam.setPassword(user.id, password, { mustChange: true });
  // A locked or disabled admin could not use it otherwise.
  const full = iam.user(user.id);
  if (full.disabled && full.role === 'admin') iam.updateUser(user.id, { disabled: false }, { actorPerms: new Set(iam.role('admin').permissions), actorId: 'reset-admin' });
}

new AuditLog({ dir: path.join(dir, 'audit'), keyFile: path.join(dir, 'audit.key') }).record({
  type: 'iam',
  outcome: 'changed',
  reason: created ? `Administrator ${user.email} created from the command line.` : `Temporary password set for ${user.email} from the command line (reset-admin).`,
  actor: { kind: 'system', user: 'reset-admin command' },
});

console.log('');
console.log(`  ${created ? 'Administrator created' : 'Password reset'} — sign in with:`);
console.log(`      Email:    ${user.email}`);
console.log(`      Password: ${password}`);
console.log('  They choose their own password at sign-in (also anyone already signed in as them, at their next click).');
console.log('');
