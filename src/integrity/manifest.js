/**
 * The list of every file a release runs, with its SHA-256: written once when the image is built
 * (scripts/integrity.mjs write), signed by the release workflow (a GitHub build attestation of this
 * very file), and compared with the files on disk whenever the server checks itself.
 *
 * Covered: package.json, package-lock.json, LICENSE, TERMS.md, CHANGELOG.md, and everything under
 * src/, public/, scripts/ and node_modules/ (regular files only; links are never followed).
 * Not covered: what the build or the update page writes beside them (integrity.json itself,
 * version.json, .node-version) and npm's own bookkeeping (node_modules/.package-lock.json).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MANIFEST_FILE = 'integrity.json';
export const TOP_FILES = ['package.json', 'package-lock.json', 'LICENSE', 'TERMS.md', 'CHANGELOG.md'];
export const TREES = ['src', 'public', 'scripts', 'node_modules'];
const SKIP = new Set(['node_modules/.package-lock.json']);
const SKIP_DIRS = new Set(['node_modules/.bin', 'node_modules/.cache']);

/** Every covered file under `root`, as sorted forward-slash paths. */
export function coveredFiles(root) {
  const out = [];
  for (const file of TOP_FILES) {
    const stat = fs.lstatSync(path.join(root, file), { throwIfNoEntry: false });
    if (stat?.isFile()) out.push(file);
  }
  const walk = (rel) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(child)) walk(child);
      } else if (entry.isFile() && !SKIP.has(child)) out.push(child);
    }
  };
  for (const tree of TREES) walk(tree);
  return out.sort();
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** The manifest of `root`: deterministic (sorted, no time), so the same files give the same bytes. */
export function buildManifest(root, { version = '', commit = '', repository = '' } = {}) {
  const files = {};
  for (const file of coveredFiles(root)) files[file] = sha256(fs.readFileSync(path.join(root, file)));
  return { format: 1, version, commit, repository, files };
}

/** The manifest as written to disk: the bytes whose SHA-256 the release workflow signs. */
export const manifestText = (manifest) => `${JSON.stringify(manifest, null, 1)}\n`;

/** The manifest next to the running code, with the SHA-256 of its exact bytes; null when there is none. */
export function readManifest(root) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, MANIFEST_FILE));
  } catch {
    return null;
  }
  try {
    const manifest = JSON.parse(text.toString('utf8'));
    if (manifest?.format !== 1 || typeof manifest.files !== 'object') return { error: 'The file list is not in a known format.', digest: sha256(text) };
    return { manifest, digest: sha256(text) };
  } catch {
    return { error: 'The file list cannot be read.', digest: sha256(text) };
  }
}

/**
 * The files on disk against the manifest: changed (different content), missing (listed, not there)
 * and extra (there, not listed). `ok` only when all three are empty.
 */
export function compareFiles(root, manifest) {
  const listed = manifest.files ?? {};
  const changed = [];
  const missing = [];
  for (const [file, hash] of Object.entries(listed)) {
    // A name that would leave the folder is never read: it counts as changed.
    if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
      changed.push(file);
      continue;
    }
    let data;
    try {
      data = fs.readFileSync(path.join(root, file));
    } catch {
      missing.push(file);
      continue;
    }
    if (sha256(data) !== hash) changed.push(file);
  }
  const extra = coveredFiles(root).filter((file) => !(file in listed));
  return { ok: !changed.length && !missing.length && !extra.length, checked: Object.keys(listed).length, changed, missing, extra };
}

/** compareFiles without holding up the server: files are read and hashed a few at a time. */
export async function compareFilesAsync(root, manifest, { atOnce = 8 } = {}) {
  const listed = Object.entries(manifest.files ?? {});
  const changed = [];
  const missing = [];
  let next = 0;
  const worker = async () => {
    while (next < listed.length) {
      const [file, hash] = listed[next++];
      if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
        changed.push(file);
        continue;
      }
      let data;
      try {
        data = await fs.promises.readFile(path.join(root, file));
      } catch {
        missing.push(file);
        continue;
      }
      if (sha256(data) !== hash) changed.push(file);
    }
  };
  await Promise.all(Array.from({ length: atOnce }, worker));
  const extra = coveredFiles(root).filter((file) => !(file in manifest.files));
  changed.sort();
  missing.sort();
  return { ok: !changed.length && !missing.length && !extra.length, checked: listed.length, changed, missing, extra };
}
