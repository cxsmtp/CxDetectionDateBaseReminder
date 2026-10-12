#!/usr/bin/env node
// The list of every file CxMissionZero runs, with its SHA-256 (src/integrity/manifest.js).
//
//   node scripts/integrity.mjs write [folder] --version 1.0.72 --commit <sha> --repository owner/name
//       writes <folder>/integrity.json (the image build does this; the release workflow signs it)
//   node scripts/integrity.mjs check [folder]
//       compares the files with their list; exits 1 when any is changed, missing or added
//
// In a running container:  podman exec mission-zero node scripts/integrity.mjs check
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MANIFEST_FILE, buildManifest, compareFiles, manifestText, readManifest } from '../src/integrity/manifest.js';

const args = process.argv.slice(2);
const command = args.shift();
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? String(args.splice(i, 2)[1] ?? '') : '';
};
const version = option('version');
const commit = option('commit');
const repository = option('repository');
const root = path.resolve(args[0] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));

if (command === 'write') {
  const manifest = buildManifest(root, { version: version || JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, commit, repository });
  fs.writeFileSync(path.join(root, MANIFEST_FILE), manifestText(manifest));
  console.log(`${Object.keys(manifest.files).length} files listed in ${MANIFEST_FILE}.`);
} else if (command === 'check') {
  const read = readManifest(root);
  if (!read) {
    console.log(`No ${MANIFEST_FILE} here: this copy was not built by the release workflow (or is older than MZ-01.00.72).`);
    process.exit(1);
  }
  if (read.error) {
    console.log(read.error);
    process.exit(1);
  }
  const r = compareFiles(root, read.manifest);
  console.log(`MZ-${read.manifest.version}${read.manifest.commit ? ` (commit ${read.manifest.commit.slice(0, 12)})` : ''}: ${r.checked} files listed; list SHA-256 ${read.digest}.`);
  if (r.ok) console.log('Every file matches the list.');
  else {
    for (const [label, list] of [['Changed', r.changed], ['Missing', r.missing], ['Not in the list', r.extra]]) if (list.length) console.log(`${label} (${list.length}): ${list.slice(0, 20).join(', ')}${list.length > 20 ? ', …' : ''}`);
    process.exit(1);
  }
} else {
  console.log('Usage: node scripts/integrity.mjs write|check [folder] [--version x --commit sha --repository owner/name]');
  process.exit(2);
}
