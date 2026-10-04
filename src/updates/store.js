/**
 * Installed versions of the app, in the data volume (`<data>/app/`), for
 * updates and rollbacks from the Settings page without touching the server.
 *
 *   app/versions/<version>/   the app's files (src, public, node_modules, …) and version.json
 *   app/active.json           which one runs: a version, or the image's own ("built-in")
 *   app/events.jsonl          what the supervisor did: switches, automatic rollbacks, crashes
 *
 * The image's own files stay the safe fallback: when the image itself is
 * replaced (a podman pull), the choice made under the previous image is
 * dropped and the new image's files run.
 */

import fs from 'node:fs';
import path from 'node:path';

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const MAX_TOTAL = 300 * 1024 * 1024;
// Any published version can be installed, including ones from before the launcher existed.
const REQUIRED = ['package.json', 'src/server.js', 'public/index.html'];

export const BUILT_IN = 'built-in';

/** -1, 0 or 1, comparing "1.0.27"-style versions. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  return 0;
}

const readJson = (file, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class VersionStore {
  constructor({ dataDir, builtInDir, builtInVersion }) {
    this.root = path.join(dataDir, 'app');
    this.versionsDir = path.join(this.root, 'versions');
    this.activeFile = path.join(this.root, 'active.json');
    this.eventsFile = path.join(this.root, 'events.jsonl');
    this.builtIn = { version: builtInVersion, dir: builtInDir };
  }

  #dirOf(version) {
    if (!VERSION.test(String(version))) throw Object.assign(new Error(`Not a version: ${version}`), { status: 400 });
    return path.join(this.versionsDir, version);
  }

  /** Installed versions, newest first: [{version, dir, image, digest, tag, revision, installedAt, bytes}]. */
  list() {
    let names = [];
    try {
      names = fs.readdirSync(this.versionsDir).filter((n) => VERSION.test(n));
    } catch {}
    return names
      .map((version) => {
        const dir = path.join(this.versionsDir, version);
        const info = readJson(path.join(dir, 'version.json'), null);
        return info && REQUIRED.every((f) => fs.existsSync(path.join(dir, f))) ? { ...info, version, dir } : null;
      })
      .filter(Boolean)
      .sort((a, b) => compareVersions(b.version, a.version));
  }

  /** The admin's choice as written: {version, builtInVersion, at, by} or null. */
  choice() {
    const value = readJson(this.activeFile, null);
    return value && typeof value === 'object' ? value : null;
  }

  /** What runs: {version, dir, source: 'image' | 'update', reason}. */
  active() {
    const choice = this.choice();
    const image = { ...this.builtIn, source: 'image' };
    if (!choice || choice.version === BUILT_IN) return { ...image, reason: 'the image’s own version' };
    if (choice.builtInVersion !== this.builtIn.version) {
      return { ...image, reason: `the image was replaced (MZ-${choice.builtInVersion} → MZ-${this.builtIn.version}), so its own version runs` };
    }
    const installed = this.list().find((v) => v.version === choice.version);
    if (!installed) return { ...image, reason: `MZ-${choice.version} is not installed any more` };
    return { version: installed.version, dir: installed.dir, source: 'update', reason: 'chosen on the Update page' };
  }

  /** Run `version` (or BUILT_IN) from the next start. */
  choose(version, { by = '' } = {}) {
    if (version !== BUILT_IN && !this.list().some((v) => v.version === version)) {
      throw Object.assign(new Error(`MZ-${version} is not installed.`), { status: 404 });
    }
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writeJsonAtomic(this.activeFile, { version, builtInVersion: this.builtIn.version, at: new Date().toISOString(), by });
  }

  /**
   * Install the files of one version (Map of relative path → Buffer) as
   * `version`. Written to a temporary folder, checked, then moved in place.
   */
  install(files, meta = {}) {
    const pkg = files.get('package.json');
    let version = '';
    try {
      version = String(JSON.parse(pkg.toString('utf8')).version ?? '');
    } catch {}
    if (!VERSION.test(version)) throw Object.assign(new Error('The update has no readable version in package.json.'), { status: 422 });
    const missing = REQUIRED.filter((f) => !files.has(f));
    if (missing.length) throw Object.assign(new Error(`The update is missing ${missing.join(', ')}: not installed.`), { status: 422 });
    let total = 0;
    for (const data of files.values()) total += data.length;
    if (total > MAX_TOTAL) throw Object.assign(new Error('The update is larger than expected: not installed.'), { status: 422 });

    fs.mkdirSync(this.versionsDir, { recursive: true, mode: 0o700 });
    const target = this.#dirOf(version);
    const staging = `${target}.installing-${process.pid}`;
    fs.rmSync(staging, { recursive: true, force: true });
    for (const [rel, data] of files) {
      const file = path.join(staging, rel);
      if (!file.startsWith(`${staging}${path.sep}`)) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data, { mode: 0o644 });
    }
    writeJsonAtomic(path.join(staging, 'version.json'), {
      version,
      image: meta.image ?? '',
      tag: meta.tag ?? '',
      digest: meta.digest ?? '',
      revision: meta.revision ?? '',
      created: meta.created ?? '',
      installedAt: new Date().toISOString(),
      installedBy: meta.by ?? '',
      bytes: total,
      files: files.size,
    });
    const old = `${target}.old-${process.pid}`;
    if (fs.existsSync(target)) fs.renameSync(target, old);
    fs.renameSync(staging, target);
    fs.rmSync(old, { recursive: true, force: true });
    return { version, dir: target, bytes: total, files: files.size };
  }

  /** Keep the running version, the previous one and the newest `keep`; remove the rest. */
  prune({ keep = 3, protect = [] } = {}) {
    const removed = [];
    const list = this.list();
    const keepSet = new Set([...list.slice(0, keep).map((v) => v.version), ...protect]);
    for (const v of list) {
      if (keepSet.has(v.version)) continue;
      fs.rmSync(v.dir, { recursive: true, force: true });
      removed.push(v.version);
    }
    return removed;
  }

  record(event) {
    try {
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
      fs.appendFileSync(this.eventsFile, line, { mode: 0o600 });
      const stat = fs.statSync(this.eventsFile);
      if (stat.size > 256 * 1024) {
        const lines = fs.readFileSync(this.eventsFile, 'utf8').trim().split('\n').slice(-500);
        fs.writeFileSync(this.eventsFile, `${lines.join('\n')}\n`, { mode: 0o600 });
      }
    } catch {}
  }

  /** The latest supervisor events, newest first. */
  events(limit = 50) {
    try {
      return fs
        .readFileSync(this.eventsFile, 'utf8')
        .trim()
        .split('\n')
        .slice(-limit)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .reverse();
    } catch {
      return [];
    }
  }
}
