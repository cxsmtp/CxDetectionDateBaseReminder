// Cx Credits Calculator, Fusion — new customer, Count from git (src/fusion-git.js): code lines counted the way
// cloc counts them (by language, without blank and comment lines; binary and over 1 MB skipped), only from hosts
// that may be called, with the token sent to its own host as a header and nowhere else, and the temporary folder
// gone whatever happens. Repositories are real ones, served over git's own HTTP protocol on this computer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CLOC_LEFT_OUT, clocLines, parseCloc } from '../public/calculator/model.js';
import { cleanFusionNew, cleanGitFrom, migrate, patchProfile, newProfile } from '../public/calculator/profiles.js';
import { GIT_COUNT_LIMITS, KNOWN_LANGUAGES, cleanRepositories, countDirectory, countLines, countRepository, createGitCounter, gitSource, isBinary, languageOf, listRepositories, redact, repoAddress, resolvePin, sweepLeftovers } from '../src/fusion-git.js';
import { makeRepo, startGitHost } from './fake-git-host.js';

const TOKEN = `ghp_${'a1B2'.repeat(9)}`;
const OTHER = `glpat-${'z9Y8'.repeat(5)}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-count-repos-'));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'git-count-tmp-'));
const leftovers = () => fs.readdirSync(tmpRoot).filter((n) => n.startsWith('mz-git-count-'));
let host;

const FILES = {
  'src/Main.java': '// a comment\npackage x;\n\n/* block\n   comment */\nclass Main {\n  String u = "http://acme.io/*";\n  int x = 1; // trailing\n}\n',
  'web/app.ts': 'const a = `line one\n// still the string\n`;\n/** doc */\nexport const b = 2;\n',
  'tools/run.py': '#!/usr/bin/env python3\n"""Module doc\nover two lines\n"""\nimport os  # why\n\nprint("# not a comment")\n',
  'README.md': '# Title\n\nSome words.\n',
  'config.yml': '# settings\nname: x\n',
  'scripts/build': '#!/bin/bash\n# build it\necho hi\n',
  'copy/Main.java': '// a comment\npackage x;\n\n/* block\n   comment */\nclass Main {\n  String u = "http://acme.io/*";\n  int x = 1; // trailing\n}\n',
  'fake.js': Buffer.from([0x63, 0x6f, 0, 0x6e, 0x0a]),
  'big.js': 'x();\n'.repeat(300_000),
  'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]),
};

test.before(async () => {
  makeRepo(root, 'globex', 'claims-portal', FILES);
  makeRepo(root, 'globex', 'old-site', { 'index.html': '<!-- c -->\n<p>x</p>\n' });
  makeRepo(root, 'globex', 'broker-api', { 'main.go': 'package main\n// c\nfunc main() {}\n' }, { branch: 'develop' });
  host = await startGitHost(root, { tokens: [TOKEN] });
});
test.after(() => host?.close());

test('lines are counted as cloc counts them: by language, without blank lines or comments', () => {
  assert.deepEqual(countLines(FILES['src/Main.java'], 'Java'), { code: 5, comment: 3, blank: 1 }, 'a comment marker inside a string is not one');
  assert.deepEqual(countLines(FILES['web/app.ts'], 'TypeScript'), { code: 4, comment: 1, blank: 0 }, 'a template string runs over lines');
  assert.deepEqual(countLines(FILES['tools/run.py'], 'Python'), { code: 2, comment: 4, blank: 1 }, 'docstrings and # are comments, as cloc counts them');
  assert.deepEqual(countLines('-- c\nSELECT 1; /* x */\n/* a\nb */\n', 'SQL'), { code: 1, comment: 3, blank: 0 });
  assert.deepEqual(countLines('-- c\n--[[ block\nstill ]]\nprint(1)\n', 'Lua'), { code: 1, comment: 3, blank: 0 });
  assert.deepEqual(countLines('<!-- a\n\nb -->\n<p>hi</p>\n', 'HTML'), { code: 1, comment: 2, blank: 1 }, 'a blank line inside a comment is blank');
  assert.deepEqual(countLines('REM x\n@echo off\n:: y\n', 'DOS Batch'), { code: 1, comment: 2, blank: 0 });
  assert.deepEqual(countLines('=begin\nputs 2\n=end\nputs 1 # c\n', 'Ruby'), { code: 1, comment: 3, blank: 0 });
  assert.deepEqual(countLines("' c\nDim x = \"it's\"\nREM y\n", 'Visual Basic .NET'), { code: 1, comment: 2, blank: 0 });
  assert.deepEqual(countLines('{"a": 1,\n\n "b": "//"}\n', 'JSON'), { code: 2, comment: 0, blank: 1 }, 'JSON has no comments');
  assert.deepEqual(countLines('a\r\n\r\n// b\r\n', 'C#'), { code: 1, comment: 1, blank: 1 }, 'Windows line ends');
  assert.deepEqual(countLines('      * old style\n       MOVE 1 TO X.\n', 'COBOL'), { code: 1, comment: 1, blank: 0 });
});

test('a file\'s language by its name, as cloc names it, for every language the cloc import leaves out and the usual code', () => {
  for (const [file, lang] of [['a/B.java', 'Java'], ['x.d.ts', 'TypeScript'], ['x.tsx', 'TypeScript'], ['a.cs', 'C#'], ['a.h', 'C/C++ Header'], ['Dockerfile', 'Dockerfile'], ['Makefile', 'make'], ['pom.xml', 'Maven'], ['build.gradle.kts', 'Gradle'], ['main.tf', 'HCL'], ['a.vue', 'Vuejs Component'], ['run.sh', 'Bourne Shell'], ['a.ps1', 'PowerShell'], ['a.bat', 'DOS Batch'], ['a.cshtml', 'Razor']]) {
    assert.equal(languageOf(file), lang, file);
  }
  for (const [file, lang] of [['a.json', 'JSON'], ['a.yaml', 'YAML'], ['a.md', 'Markdown'], ['a.xml', 'XML'], ['a.csv', 'CSV'], ['a.txt', 'Text'], ['a.svg', 'SVG'], ['a.html', 'HTML']]) assert.equal(languageOf(file), lang, file);
  assert.deepEqual(CLOC_LEFT_OUT.filter((l) => !KNOWN_LANGUAGES.includes(l)), [], 'every language the cloc import leaves out by default is known');
  assert.equal(languageOf('scripts/build', '#!/usr/bin/env bash'), 'Bourne Again Shell', 'no extension: the #! line says');
  assert.equal(languageOf('BUILD'), 'Starlark');
  assert.equal(languageOf('constructor'), '', 'never an object\'s own keys');
  assert.equal(languageOf('a.constructor'), '');
  assert.equal(languageOf('LICENSE'), '');
  assert.equal(languageOf('.eslintrc'), '');
  assert.equal(languageOf('photo.png'), '');
  assert.equal(isBinary(Buffer.from([1, 0, 2])), true);
  assert.equal(isBinary(Buffer.from('plain')), false);
});

test('a folder is counted the same way: binary files, files over 1 MB and copies of a file are skipped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-count-dir-'));
  for (const [file, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  const counted = await countDirectory(dir);
  assert.deepEqual(counted.languages.Java, { files: 1, code: 5 }, 'the same file twice is counted once, as cloc does');
  assert.equal(counted.skipped.duplicate, 1);
  assert.deepEqual(counted.languages.TypeScript, { files: 1, code: 4 });
  assert.equal(counted.languages.JavaScript, undefined, 'fake.js is binary, big.js is over 1 MB');
  assert.equal(counted.skipped.binary, 1);
  assert.equal(counted.skipped.large, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('addresses: https (http only to this computer), never a link-local or metadata address, never a password', () => {
  assert.deepEqual(repoAddress('https://acme@dev.azure.com/acme/Payments/_git/payments-api'), { url: 'https://dev.azure.com/acme/Payments/_git/payments-api', host: 'dev.azure.com', hostname: 'dev.azure.com', path: 'acme/Payments/_git/payments-api', name: 'payments-api' }, 'a user name a host puts in its own address is dropped');
  assert.equal(repoAddress('https://github.com/globex/claims-portal.git').name, 'claims-portal');
  assert.throws(() => repoAddress(`https://x:${TOKEN}@github.com/a/b`), (error) => /must not carry a password/.test(error.message) && !error.message.includes(TOKEN));
  assert.throws(() => repoAddress('http://169.254.169.254/latest/meta-data'), /https/);
  for (const bad of ['https://169.254.169.254/latest/meta-data', 'https://169.254.169.254/a/b', 'https://metadata.google.internal/a/b', 'https://[fe80::1]/a/b', 'https://[::ffff:169.254.169.254]/a/b', 'https://100.100.100.200/a/b']) {
    assert.throws(() => repoAddress(bad), /link-local or cloud metadata/, bad);
  }
  assert.throws(() => repoAddress('http://git.acme.io/a/b'), /https/);
  assert.throws(() => repoAddress('git@github.com:a/b.git'), /https address/);
  assert.throws(() => repoAddress('https://github.com/onlyone'), /Not a repository address/);
  assert.throws(() => repoAddress('https://github.com/a/../b'), /Not a repository address/);
  assert.throws(() => gitSource({ provider: 'gitlab', address: 'https://169.254.169.254', token: TOKEN }), /link-local or cloud metadata/);
  assert.throws(() => gitSource({ provider: 'github', token: `${TOKEN}\r\nX-Evil: 1` }), /characters a token does not have/, 'nothing can be slipped into a header');
  assert.throws(() => gitSource({ provider: 'github', token: '' }), /Paste the token/);
  assert.throws(() => gitSource({ provider: 'svn', token: TOKEN }), /Choose the git host/);
  assert.throws(() => cleanRepositories(Array.from({ length: 51 }, (_, i) => `https://github.com/a/r${i}`)), /At most 50 repositories/);
  assert.equal(cleanRepositories(['https://github.com/a/b', 'https://github.com/a/b', { url: 'https://github.com/a/c', branch: '--upload-pack=x' }]).length, 2, 'each once');
  assert.equal(cleanRepositories([{ url: 'https://github.com/a/c', branch: '--upload-pack=x' }])[0].branch, '', 'a branch is never read as an option');
});

test('a token goes only to its own host, as a header: an Azure DevOps token only to its own organisation', () => {
  const gh = gitSource({ provider: 'github', token: TOKEN });
  assert.deepEqual([gh.apiUrl, gh.gitHost], ['https://api.github.com', 'github.com']);
  assert.match(gh.authFor(repoAddress('https://github.com/globex/a')), /^Basic /);
  assert.equal(gh.authFor(repoAddress('https://gitlab.com/globex/a')), '', 'another host gets nothing');
  const ghe = gitSource({ provider: 'github', address: 'https://ghe.acme.io/api/v3', token: TOKEN });
  assert.deepEqual([ghe.apiUrl, ghe.gitHost], ['https://ghe.acme.io/api/v3', 'ghe.acme.io']);
  const gl = gitSource({ provider: 'gitlab', address: 'https://gitlab.acme.io', token: OTHER });
  assert.deepEqual([gl.apiUrl, gl.gitHost], ['https://gitlab.acme.io/api/v4', 'gitlab.acme.io']);
  const az = gitSource({ provider: 'azure', address: 'acme', token: TOKEN });
  assert.match(az.authFor(repoAddress('https://dev.azure.com/acme/P/_git/r')), /^Basic /);
  assert.equal(az.authFor(repoAddress('https://dev.azure.com/other/P/_git/r')), '', 'not another organisation on the same host');
  const bb = gitSource({ provider: 'bitbucket', token: TOKEN });
  assert.deepEqual([bb.apiUrl, bb.gitHost], ['https://api.bitbucket.org/2.0', 'bitbucket.org']);
  assert.equal(redact(`fatal: ${TOKEN} and https://u:p@h/x`, gh.secrets), 'fatal: [hidden] and https://h/x');
});

test('an organisation\'s repositories are listed with their default branch, size and archived, the token as a header only', async () => {
  const source = gitSource({ provider: 'github', address: host.url, token: TOKEN });
  const { repositories, more } = await listRepositories(source, 'globex');
  assert.equal(more, false);
  assert.deepEqual(repositories.map((r) => [r.path, r.branch, r.archived]), [['globex/broker-api', 'main', false], ['globex/claims-portal', 'main', false], ['globex/old-site', 'main', true]]);
  assert.ok(repositories.every((r) => r.url.startsWith(`${host.url}/globex/`) && !r.url.includes('@')), 'clone addresses without credentials');
  assert.equal(repositories[0].sizeBytes, 12 * 1024);
  const call = host.seen.find((s) => s.path === '/api/v3/orgs/globex/repos');
  assert.equal(call.authorization, `Bearer ${TOKEN}`);
  assert.ok(!host.seen.some((s) => s.query.includes(TOKEN)), 'never in an address');
  await assert.rejects(listRepositories(gitSource({ provider: 'github', address: host.url, token: OTHER }), 'globex'), (error) => /refused the token/.test(error.message) && !error.message.includes(OTHER));
});

test('one repository: its latest commit fetched, counted, and the temporary folder deleted at once', async () => {
  const source = gitSource({ provider: 'github', address: host.url, token: TOKEN });
  const steps = [];
  const seenBefore = host.seen.length;
  const counted = await countRepository({ url: `${host.url}/globex/claims-portal.git` }, { source, tmpRoot, onProgress: (p) => steps.push(p.state) });
  assert.equal(counted.name, 'claims-portal');
  assert.equal(counted.branch, 'main');
  assert.match(counted.commit, /^[0-9a-f]{7}$/);
  assert.deepEqual(counted.languages.Java, { files: 1, code: 5 }, 'the same file twice is counted once, as cloc does');
  assert.deepEqual(counted.languages['Bourne Again Shell'], { files: 1, code: 1 }, 'a file with no extension, by its #! line');
  assert.equal(counted.languages.JavaScript, undefined);
  assert.deepEqual(counted.skipped, { binary: 1, large: 1, duplicate: 1 });
  assert.equal(counted.lines, Object.values(counted.languages).reduce((n, l) => n + l.code, 0));
  assert.deepEqual([...new Set(steps)], ['fetching', 'counting']);
  assert.deepEqual(leftovers(), [], 'nothing of the code is kept');
  const gitCalls = host.seen.slice(seenBefore);
  assert.ok(gitCalls.length > 0 && gitCalls.every((s) => s.authorization === `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`), 'the token went as a header');
  assert.ok(!gitCalls.some((s) => s.query.includes(TOKEN)));
  // The same shape as cloc results: the page reads it the same way.
  const langs = Object.fromEntries(Object.entries(counted.languages).map(([l, v]) => [l, v.code]));
  assert.equal(clocLines({ langs }), counted.lines - (langs.Markdown ?? 0) - (langs.YAML ?? 0));
  assert.deepEqual(parseCloc(JSON.stringify(Object.fromEntries(Object.entries(counted.languages).map(([l, v]) => [l, { nFiles: v.files, code: v.code }]))), 'claims-portal.json')[0].langs, langs);
  const develop = await countRepository({ url: `${host.url}/globex/broker-api` }, { source, tmpRoot });
  assert.equal(develop.branch, 'develop', 'its default branch, whatever it is called');
});

test('git connects to the addresses checked, not to a second look-up of the name', async () => {
  assert.equal(resolvePin(repoAddress('https://git.example.com/acme/app'), ['203.0.113.7', '2001:db8::7']), 'git.example.com:443:203.0.113.7,[2001:db8::7]');
  assert.equal(resolvePin(repoAddress('http://localhost:8123/acme/app'), ['127.0.0.1']), 'localhost:8123:127.0.0.1');
  assert.equal(resolvePin(repoAddress('https://203.0.113.7/acme/app'), []), '', 'an address typed as such is already the one called');
  const named = host.url.replace('127.0.0.1', 'localhost');
  const counted = await countRepository({ url: `${named}/globex/claims-portal` }, { source: gitSource({ provider: 'github', address: named, token: TOKEN }), tmpRoot });
  assert.equal(counted.name, 'claims-portal', 'a name still counts, through the pinned address');
});

test('the test host serves plain names only', async () => {
  for (const bad of ['/..%2Fx/info/refs', '/%E0%A4%A', '/api/v3/orgs/..%2Foutside/repos']) assert.equal((await fetch(host.url + bad)).status, 400, bad);
  assert.equal((await fetch(`${host.url}/api/v3/orgs/globex/repos`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200, 'and still answers');
});

test('a refused token, a missing repository, a host not allowed, too big or too slow: said, the token never in it, and the folder gone', async () => {
  const wrong = gitSource({ provider: 'github', address: host.url, token: OTHER });
  await assert.rejects(countRepository({ url: `${host.url}/globex/claims-portal` }, { source: wrong, tmpRoot }), (error) => /refused: check the token/.test(error.message) && !error.message.includes(OTHER));
  const source = gitSource({ provider: 'github', address: host.url, token: TOKEN });
  await assert.rejects(countRepository({ url: `${host.url}/globex/nowhere` }, { source, tmpRoot }), /Not found/);
  await assert.rejects(countRepository({ url: `${host.url}/globex/claims-portal` }, { source, tmpRoot, allowHost: () => false }), /not counted: connect that host on the Beta page, or add it to SCM_ALLOWED_HOSTS/);
  await assert.rejects(countRepository({ url: `${host.url}/globex/claims-portal` }, { source, tmpRoot, limits: { ...GIT_COUNT_LIMITS, repoBytes: 10 } }), /Over 0 GB: not counted|Over \d+ GB/);
  const slow = await startGitHost(root, { tokens: [TOKEN], slow: 3000 });
  try {
    await assert.rejects(countRepository({ url: `${slow.url}/globex/claims-portal` }, { source: gitSource({ provider: 'github', address: slow.url, token: TOKEN }), tmpRoot, limits: { ...GIT_COUNT_LIMITS, timeoutMs: 500 } }), /Took longer than/);
  } finally {
    await slow.close();
  }
  assert.deepEqual(leftovers(), [], 'every folder deleted, also on errors and time limits');
  // A folder left by a process that stopped mid-count goes at the next start.
  const stale = fs.mkdtempSync(path.join(tmpRoot, 'mz-git-count-'));
  fs.utimesSync(stale, new Date(Date.now() - 2 * 3600_000), new Date(Date.now() - 2 * 3600_000));
  assert.equal(sweepLeftovers(tmpRoot), 1);
  assert.deepEqual(leftovers(), []);
});

test('a count is followed by the one who started it; its view never holds the token', async () => {
  const counter = createGitCounter({ tmpRoot });
  const source = gitSource({ provider: 'github', address: host.url, token: TOKEN });
  let job = await counter.start('ana@acme.io', { source, repositories: [{ url: `${host.url}/globex/claims-portal.git`, branch: 'main' }, `${host.url}/globex/nowhere`] });
  assert.equal(job.repositories.length, 2);
  await assert.rejects(counter.start('ana@acme.io', { source, repositories: [`${host.url}/globex/old-site`] }), /already running/);
  assert.throws(() => counter.view('bob@acme.io', job.id), /no longer here/, 'not someone else\'s');
  const end = Date.now() + 30_000;
  while (job.state === 'running' && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 100));
    job = counter.view('ana@acme.io', job.id);
  }
  assert.equal(job.state, 'done');
  assert.deepEqual(job.repositories.map((r) => r.state), ['done', 'failed']);
  assert.equal(job.repositories[0].languages.Java.code, 5);
  assert.match(job.repositories[1].error, /Not found/);
  const text = JSON.stringify(job);
  assert.ok(!text.includes(TOKEN) && !text.includes(Buffer.from(`x-access-token:${TOKEN}`).toString('base64')), 'no form of the token');
  assert.deepEqual(leftovers(), []);
});

test('a customer keeps where each project came from, never a token; customers saved before still open', () => {
  const from = { host: 'x', url: 'https://github.com/globex/claims-portal.git', branch: 'main', commit: '3F2A1C9', countedAt: '2026-10-28T10:00:00Z', connection: 'github-1', token: TOKEN, authorization: `Bearer ${TOKEN}` };
  assert.deepEqual(cleanGitFrom(from), { host: 'github.com', path: 'globex/claims-portal', url: 'https://github.com/globex/claims-portal.git', branch: 'main', commit: '3f2a1c9', countedAt: '2026-10-28T10:00:00.000Z', connection: 'github-1' });
  assert.equal(cleanGitFrom({ url: `https://x-access-token:${TOKEN}@github.com/a/b` }), null, 'an address with credentials is not kept');
  assert.equal(cleanGitFrom({ url: 'javascript:alert(1)' }), null);
  assert.equal(cleanGitFrom({ url: `https://github.com/a/b?token=${TOKEN}` }), null);
  const saved = patchProfile(newProfile({ name: 'Globex' }), { fusionNew: { projects: [{ name: 'claims-portal', langs: { Java: 61240 }, git: from }, { name: 'payments-api', file: 'payments-api.json', langs: { Java: 38900 } }] } });
  const [git, cloc] = saved.fusionNew.projects;
  assert.equal(git.git.commit, '3f2a1c9');
  assert.equal(cloc.git, undefined, 'a project from cloc has no git');
  assert.ok(!JSON.stringify(saved).includes(TOKEN));
  // Saved before Count from git: opens as it was.
  const old = migrate({ ...newProfile({ name: 'Old' }), fusionNew: { projects: [{ id: 'p1', name: 'legacy', file: 'legacy.json', langs: { Go: 100 } }] } });
  assert.deepEqual(cleanFusionNew(old.fusionNew).projects[0], { id: 'p1', name: 'legacy', file: 'legacy.json', langs: { Go: 100 }, locOverride: null, included: true, scansOverride: null, modelOverride: null });
});

test('the page: Count from git beside Upload cloc results, the From column and Count again; the HTML file on its own cannot reach git', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /name="calc-fnew-way" value="git" checked \/> <span>Count from git<\/span>/);
  assert.match(html, /name="calc-fnew-way" value="cloc" \/> <span>Upload cloc results<\/span>/);
  assert.match(html, /<th>Project<\/th><th>From<\/th><th>Languages<\/th>/);
  assert.match(html, /<input type="password" id="calc-git-secret" spellcheck="false" autocomplete="off" \/>/);
  assert.match(html, /totals may differ slightly from cloc's/);
  const page = fs.readFileSync(new URL('../public/calculator/page.js', import.meta.url), 'utf8');
  assert.match(page, /data-fnew-recount>Count again</);
  assert.match(page, /canGit = \(\) => !standalone/);
  assert.match(fs.readFileSync(new URL('../public/calculator/standalone.js', import.meta.url), 'utf8'), /canGit: \(\) => Boolean\(launcher\)/);
});
