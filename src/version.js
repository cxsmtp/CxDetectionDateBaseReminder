import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** "1.2.3" → "MZ-01.02.03": the version shown in the app's corner and the log. */
export function displayVersion(semver) {
  const parts = String(semver ?? '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return `MZ-${parts.slice(0, 3).map((n) => String(n).padStart(2, '0')).join('.')}`;
}

const packageFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');

/** This build's version, from package.json (bumped with every change merged to main). */
export const APP_VERSION = displayVersion(JSON.parse(fs.readFileSync(packageFile, 'utf8')).version);
