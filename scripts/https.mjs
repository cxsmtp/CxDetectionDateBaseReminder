#!/usr/bin/env node
/**
 * The way back in when HTTPS settings made the Settings page unreachable (a certificate no
 * browser accepts, HSTS…). Changes the server's HTTPS mode; a running server picks it up
 * within 5 seconds, without a restart. Recorded in the audit log.
 *
 *   node scripts/https.mjs            what is set now
 *   node scripts/https.mjs both       http and https side by side (the safe choice)
 *   node scripts/https.mjs http       plain http only
 *   node scripts/https.mjs https      https only
 *
 *   podman exec mission-zero node scripts/https.mjs both
 */
import '../src/load-env.js';
import fs from 'node:fs';
import path from 'node:path';

import { AuditLog } from '../src/audit-log.js';
import { prepareDataDir, resolveDataDir } from '../src/data-dir.js';
import { MODES, setModeOffline } from '../src/https-manager.js';

const { dir } = resolveDataDir();
prepareDataDir(dir);
const wanted = process.argv[2]?.trim().toLowerCase();
const file = path.join(dir, 'https.json');
let current = {};
try {
  current = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch {}

if (!wanted) {
  console.log(`HTTPS mode: ${current.mode ?? '(not chosen on the Settings page; HTTPS=… decides)'}; HSTS ${current.hsts?.enabled ? 'on' : 'off'}.`);
  console.log(`Change it: node scripts/https.mjs ${MODES.join('|')}`);
  process.exit(0);
}
if (!MODES.includes(wanted)) {
  console.error(`Use one of: ${MODES.join(', ')}.`);
  process.exit(1);
}
const state = setModeOffline(dir, wanted);
const audit = new AuditLog({ dir: path.join(dir, 'audit'), keyFile: path.join(dir, 'audit.key') });
audit.record({ type: 'settings', outcome: 'changed', reason: `HTTPS mode set to ${wanted} from the command line (scripts/https.mjs)${current.hsts?.enabled && !state.hsts?.enabled ? '; HSTS turned off' : ''}.`, actor: { kind: 'system', user: 'scripts/https.mjs' } });
await audit.settled();
console.log(`HTTPS mode is now: ${wanted}. A running server switches within 5 seconds.`);
if (wanted !== 'https') console.log('Open the Settings page (http works again) and fix the certificate under Settings → HTTPS.');
