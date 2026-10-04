/**
 * Where this server keeps its state: settings, the credit ledger and
 * allocations, tracked reports, the audit log and the signing keys.
 *
 * Outside the project folder, so redeploying or replacing the code never
 * touches it and it can be backed up on its own:
 *
 *   DATA_DIR       explicit location (e.g. /var/lib/mission-zero)
 *   SETTINGS_FILE  older setups: the folder containing this file
 *   default        ~/.mission-zero (the service user's home)
 *
 * The first start with a new location copies the files from the old
 * in-project ./data folder, so nothing is lost when upgrading.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Every file (and folder) that makes up the server's state. */
export const STATE_FILES = [
  'settings.json',
  'iam.json',
  'report-signing.key',
  'audit.key',
  'triage-credits.json',
  'credit-allocations.json',
  'tracked-reports.json',
  'known-initiators.json',
  'automation-state.json',
  'settings-automation.json',
  'connection-guard.json',
  'scan-attribution.json',
];
export const STATE_DIRS = ['audit'];

export function resolveDataDir(env = process.env, { cwd = process.cwd(), home = os.homedir() } = {}) {
  const explicit = String(env.DATA_DIR ?? '').trim();
  if (explicit) return { dir: path.resolve(cwd, explicit), source: 'DATA_DIR' };
  const settingsFile = String(env.SETTINGS_FILE ?? '').trim();
  if (settingsFile) return { dir: path.dirname(path.resolve(cwd, settingsFile)), source: 'SETTINGS_FILE' };
  return { dir: path.join(home || cwd, '.mission-zero'), source: 'default' };
}

/** Is `dir` inside `project`? (Then a redeploy could delete it.) */
export function insideProject(dir, project = process.cwd()) {
  const rel = path.relative(path.resolve(project), path.resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Copy state from the old in-project ./data folder into `dir` when `dir`
 * has none yet. The old files are left in place (and can be deleted once the
 * new location is confirmed). Returns the names copied.
 */
export function migrateLegacyData(dir, { legacyDir = path.join(process.cwd(), 'data') } = {}) {
  if (path.resolve(legacyDir) === path.resolve(dir)) return [];
  if (!fs.existsSync(legacyDir)) return [];
  if (fs.existsSync(path.join(dir, 'settings.json'))) return [];
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const copied = [];
  for (const name of STATE_FILES) {
    const from = path.join(legacyDir, name);
    if (!fs.existsSync(from)) continue;
    fs.copyFileSync(from, path.join(dir, name));
    fs.chmodSync(path.join(dir, name), 0o600);
    copied.push(name);
  }
  for (const name of STATE_DIRS) {
    const from = path.join(legacyDir, name);
    if (fs.existsSync(from)) {
      fs.cpSync(from, path.join(dir, name), { recursive: true });
      copied.push(`${name}/`);
    }
  }
  return copied;
}

/** Create the folder, readable only by this server's user. */
export function prepareDataDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
  return dir;
}

/**
 * Where each state file lives: {name in a backup → absolute path}. Normally
 * all in `dir`; an older SETTINGS_FILE setup keeps settings (and its
 * automation state) where that variable points.
 */
export function statePaths(dir, settingsFile = '') {
  const paths = Object.fromEntries(STATE_FILES.map((name) => [name, path.join(dir, name)]));
  if (settingsFile) {
    paths['settings.json'] = path.resolve(settingsFile);
    paths['settings-automation.json'] = `${path.resolve(settingsFile).replace(/\.json$/, '')}-automation.json`;
  }
  return paths;
}
