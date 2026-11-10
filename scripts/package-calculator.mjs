#!/usr/bin/env node
// The Cx Credits Calculator for a computer without Node.js, in two forms, for Windows and macOS:
//
//   1. Ready to run (Cx-Credits-Calculator-<system>.zip): the official Node.js for that system beside
//      cx-credits-calculator.mjs and a Start file to double-click. Nothing is installed; the official,
//      signed Node.js is what runs.
//   2. One program (Cx-Credits-Calculator-<system>-app.zip): Node.js with the calculator inside one file
//      (Node's single executable applications). Not signed by a publisher: Windows and macOS ask once.
//
// Each zip has the one-page guide in it when --guide names it. Node.js comes from nodejs.org, checked
// against the checksums pinned here; the single program is made with the same Node.js version as this
// one (the blob must match it). macOS single programs must be signed (ad hoc is enough) or Apple silicon
// will not run them: on a Mac this uses its own codesign; elsewhere it needs rcodesign (--rcodesign),
// and without either the macOS single program is skipped (the ready-to-run zip is still made).
//
//   node scripts/package-calculator.mjs <folder with cx-credits-calculator.mjs> <out folder> [--guide <pdf>] [--rcodesign <path>] [--only windows-x64,macos-arm64,macos-x64,linux-x64]
//
// One system at a time, its downloads removed as it goes, so it needs about 300 MB free.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NODE = 'v22.22.0';
// From https://nodejs.org/dist/v22.22.0/SHASUMS256.txt.
const TARGETS = {
  'windows-x64': { archive: `node-${NODE}-win-x64.zip`, sha256: 'c97fa376d2becdc8863fcd3ca2dd9a83a9f3468ee7ccf7a6d076ec66a645c77a', bin: 'node.exe', os: 'windows' },
  'macos-arm64': { archive: `node-${NODE}-darwin-arm64.tar.gz`, sha256: '5ed4db0fcf1eaf84d91ad12462631d73bf4576c1377e192d222e48026a902640', bin: 'bin/node', os: 'macos' },
  'macos-x64': { archive: `node-${NODE}-darwin-x64.tar.gz`, sha256: '5ea50c9d6dea3dfa3abb66b2656f7a4e1c8cef23432b558d45fb538c7b5dedce', bin: 'bin/node', os: 'macos' },
  // For checking the single program here; not published.
  'linux-x64': { archive: `node-${NODE}-linux-x64.tar.xz`, sha256: '9aa8e9d2298ab68c600bd6fb86a6c13bce11a4eca1ba9b39d79fa021755d7c37', bin: 'bin/node', os: 'linux' },
};
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const POSTJECT = 'postject@1.0.0-alpha.6';
const NAME = 'Cx Credits Calculator';

const [from, outDir, ...rest] = process.argv.slice(2);
const option = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
if (!from || !outDir) {
  console.error('node scripts/package-calculator.mjs <folder with cx-credits-calculator.mjs> <out folder> [--guide <pdf>] [--rcodesign <path>] [--only <systems>]');
  process.exit(2);
}
if (process.version !== NODE) {
  console.error(`Run this with Node.js ${NODE}: the single program's blob is made by the Node.js it runs in (this is ${process.version}).`);
  process.exit(2);
}
const only = (option('--only') ?? 'windows-x64,macos-arm64,macos-x64').split(',');
const guide = option('--guide');
const rcodesign = option('--rcodesign');
// How a macOS program is signed here: the Mac's own codesign, rcodesign when given, or not at all (skipped).
const signer = process.platform === 'darwin' ? 'codesign' : rcodesign ? 'rcodesign' : null;
const launcher = fs.readFileSync(path.join(from, 'cx-credits-calculator.mjs'), 'utf8');
fs.mkdirSync(outDir, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-calc-package-'));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], ...opts });

// The single program's blob: the calculator's files and page as assets, and a small CommonJS start (sea-main.cjs).
function makeBlob() {
  const at = (marker) => launcher.indexOf(marker);
  const files = launcher.slice(at('\nconst FILES = ') + 15, at('\nconst HTML = ') - 1);
  const html = launcher.slice(at('\nconst HTML = ') + 14, at('\n\nconst args = ') - 1);
  fs.writeFileSync(path.join(work, 'files.json'), JSON.stringify(JSON.parse(files)));
  fs.writeFileSync(path.join(work, 'page.html'), JSON.parse(html));
  fs.copyFileSync(new URL('./calculator-sea-main.cjs', import.meta.url), path.join(work, 'sea-main.cjs'));
  fs.writeFileSync(path.join(work, 'sea-config.json'), JSON.stringify({ main: 'sea-main.cjs', output: 'sea-prep.blob', disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets: { 'files.json': 'files.json', 'page.html': 'page.html' } }));
  run(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { cwd: work });
  return path.join(work, 'sea-prep.blob');
}

async function download(target) {
  const file = path.join(work, target.archive);
  const response = await fetch(`https://nodejs.org/dist/${NODE}/${target.archive}`);
  if (!response.ok) throw new Error(`${target.archive}: nodejs.org answered ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const sum = createHash('sha256').update(data).digest('hex');
  if (sum !== target.sha256) throw new Error(`${target.archive}: checksum ${sum} is not the one pinned (${target.sha256})`);
  fs.writeFileSync(file, data);
  return file;
}

/** Only Node.js itself and its licence, out of the archive. */
function extract(target, archive, into) {
  fs.mkdirSync(into, { recursive: true });
  const top = target.archive.replace(/\.(zip|tar\.gz|tar\.xz)$/, '');
  if (target.archive.endsWith('.zip')) run('unzip', ['-q', '-j', '-o', archive, `${top}/${target.bin}`, `${top}/LICENSE`, '-d', into]);
  else {
    run('tar', ['-xf', archive, '-C', into, '--strip-components', String(target.bin.split('/').length), `${top}/${target.bin}`]);
    run('tar', ['-xf', archive, '-C', into, '--strip-components', '1', `${top}/LICENSE`]);
  }
  fs.rmSync(archive);
  return { node: path.join(into, path.basename(target.bin)), licence: path.join(into, 'LICENSE') };
}

const zip = (folder, name) => {
  const file = path.resolve(outDir, name);
  fs.rmSync(file, { force: true });
  run('zip', ['-q', '-r', '-X', '-9', file, path.basename(folder)], { cwd: path.dirname(folder) });
  return file;
};
const readme = (os) => `${NAME}\n\nOpen "Getting started.pdf" first.\n\n${os === 'windows' ? 'Double-click "Start Cx Credits Calculator.cmd".' : os === 'macos' ? 'Right-click "Start Cx Credits Calculator.command", choose Open, then Open again (only the first time).' : 'Run ./start.sh'}\nThe calculator opens in your browser at http://127.0.0.1:47317/. Your customers and reports are saved in cx-credits-calculator-data.json in this folder.\nTo stop it, close the window it runs in.\n`;

// Ready to run: Node.js beside the calculator, and a Start file that runs it from this folder.
function readyToRun(id, target, node, licence) {
  const folder = path.join(work, 'ready', NAME);
  fs.rmSync(path.join(work, 'ready'), { recursive: true, force: true });
  fs.mkdirSync(path.join(folder, 'node'), { recursive: true });
  fs.copyFileSync(path.join(from, 'cx-credits-calculator.mjs'), path.join(folder, 'cx-credits-calculator.mjs'));
  fs.renameSync(node, path.join(folder, 'node', path.basename(node)));
  fs.copyFileSync(licence, path.join(folder, 'node', 'LICENSE'));
  if (target.os === 'windows') {
    fs.writeFileSync(path.join(folder, 'Start Cx Credits Calculator.cmd'), ['@echo off', 'title Cx Credits Calculator', 'cd /d "%~dp0"', '"%~dp0node\\node.exe" "%~dp0cx-credits-calculator.mjs" %*', 'if errorlevel 1 pause', ''].join('\r\n'));
  } else {
    const start = path.join(folder, target.os === 'macos' ? 'Start Cx Credits Calculator.command' : 'start.sh');
    fs.writeFileSync(start, ['#!/bin/bash', '# Cx Credits Calculator: runs from this folder, with the Node.js beside it.', 'cd "$(dirname "$0")" || exit 1', './node/node ./cx-credits-calculator.mjs "$@"', 'status=$?', '[ $status -ne 0 ] && read -r -p "Press Enter to close. " _', 'exit $status', ''].join('\n'));
    fs.chmodSync(start, 0o755);
    fs.chmodSync(path.join(folder, 'node', 'node'), 0o755);
  }
  fs.writeFileSync(path.join(folder, 'README.txt'), readme(target.os));
  if (guide) fs.copyFileSync(guide, path.join(folder, 'Getting started.pdf'));
  const out = zip(folder, `Cx-Credits-Calculator-${id}.zip`);
  fs.rmSync(path.join(work, 'ready'), { recursive: true, force: true });
  return out;
}

// One program: a copy of Node.js with the blob put in (and signed ad hoc on macOS).
function oneProgram(id, target, node, blob) {
  const folder = path.join(work, 'app', NAME);
  fs.rmSync(path.join(work, 'app'), { recursive: true, force: true });
  fs.mkdirSync(folder, { recursive: true });
  const program = path.join(folder, target.os === 'windows' ? `${NAME}.exe` : NAME);
  fs.copyFileSync(node, program);
  fs.chmodSync(program, 0o755);
  if (target.os === 'macos' && signer === 'codesign') run('codesign', ['--remove-signature', program]);
  if (target.os === 'macos' && signer === 'rcodesign') {
    run(rcodesign, ['remove-code-signature', program, program + '.unsigned']);
    fs.renameSync(program + '.unsigned', program);
  }
  run('npx', ['--yes', POSTJECT, program, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', SENTINEL, ...(target.os === 'macos' ? ['--macho-segment-name', 'NODE_SEA'] : [])]);
  if (target.os === 'macos' && signer === 'codesign') run('codesign', ['--sign', '-', program]);
  if (target.os === 'macos' && signer === 'rcodesign') run(rcodesign, ['sign', program]);
  fs.writeFileSync(path.join(folder, 'README.txt'), `${NAME}\n\nOpen "Getting started.pdf" first.\n\n${target.os === 'windows' ? `Double-click "${NAME}.exe". The first time, Windows may say it protected your PC: choose More info, then Run anyway.` : target.os === 'macos' ? `Right-click "${NAME}", choose Open, then Open again (only the first time).` : `Run "./${NAME}".`}\nThe calculator opens in your browser at http://127.0.0.1:47317/. Your customers and reports are saved in cx-credits-calculator-data.json beside the program.\nTo stop it, close the window it runs in.\n`);
  if (guide) fs.copyFileSync(guide, path.join(folder, 'Getting started.pdf'));
  const out = zip(folder, `Cx-Credits-Calculator-${id}-app.zip`);
  fs.rmSync(path.join(work, 'app'), { recursive: true, force: true });
  return out;
}

try {
  const blob = makeBlob();
  for (const id of only) {
    const target = TARGETS[id];
    if (!target) throw new Error(`Not a system this makes: ${id}`);
    console.log(`${id}: Node.js ${NODE}`);
    const { node, licence } = extract(target, await download(target), path.join(work, id));
    const app = target.os !== 'macos' || signer ? oneProgram(id, target, node, blob) : null;
    if (!app) console.log(`  ${id}: single program skipped (signing it needs a Mac's codesign or --rcodesign)`);
    const ready = readyToRun(id, target, node, licence);
    fs.rmSync(path.join(work, id), { recursive: true, force: true });
    for (const file of [ready, app].filter(Boolean)) console.log(`  ${path.basename(file)}  ${(fs.statSync(file).size / 1048576).toFixed(1)} MB  sha256 ${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`);
  }
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
