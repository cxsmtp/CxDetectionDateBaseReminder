// Git blame that never names the wrong developer, on real git repositories: whitespace-only
// and listed reformatting commits, bots and moved code are looked past; a line that changed
// after the scan, or a scanned commit that is gone, is reported as unsure, never as sure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { blameInDir, confidenceOf, isBot, looksLikeFormatting } from '../src/github/blame.js';

const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', HOME: os.tmpdir() };
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { env, encoding: 'utf8' }).trim();

/** A repository; `commit(who, files, message)` writes the files and commits as that person. */
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blame-'));
  git(dir, 'init', '-q', '-b', 'main');
  const commit = (who, files, message) => {
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    git(dir, 'add', '-A');
    execFileSync('git', ['-C', dir, '-c', `user.name=${who.name}`, '-c', `user.email=${who.email}`, 'commit', '-q', '-m', message], { env });
    return git(dir, 'rev-parse', 'HEAD');
  };
  return { dir, commit };
}

const alice = { name: 'Alice Dev', email: 'alice@acme.io' };
const bob = { name: 'Bob Format', email: 'bob@acme.io' };
const bot = { name: 'dependabot[bot]', email: '49699333+dependabot[bot]@users.noreply.github.com' };
const VULNERABLE = '  return db.query("SELECT * FROM users WHERE id = " + id);';
const file = (line, before = []) => [...before, 'function find(id) {', line, '}', ''].join('\n');

test('bots and reformatting are recognised', () => {
  assert.ok(isBot(bot.name, bot.email));
  assert.ok(isBot('Renovate Bot', 'renovate@whitesourcesoftware.com'));
  assert.ok(isBot('github-actions', '41898282+github-actions[bot]@users.noreply.github.com'));
  assert.ok(!isBot('Bottomley James', 'james@acme.io'), 'a person whose name contains "bot"');
  assert.ok(looksLikeFormatting('Run prettier on the whole repo'));
  assert.ok(!looksLikeFormatting('Fix login form'));
});

test('a whitespace-only change does not take the blame', async () => {
  const { dir, commit } = repo();
  commit(alice, { 'app.js': file(VULNERABLE) }, 'Add user lookup');
  const scanned = commit(bob, { 'app.js': file(`\t${VULNERABLE.trim()}`) }, 'Tabs, not spaces');
  const blame = await blameInDir(dir, { refs: [scanned], path: 'app.js', line: 2, expect: 'query', env });
  assert.equal(blame.authorEmail, alice.email);
  assert.equal(blame.exact, true);
  assert.equal(blame.matches, true);
  assert.equal(confidenceOf(blame, { scannedCommit: scanned }).level, 'high');
});

test('commits listed in .git-blame-ignore-revs are skipped', async () => {
  const { dir, commit } = repo();
  commit(alice, { 'app.js': file(VULNERABLE) }, 'Add user lookup');
  const reformat = commit(bob, { 'app.js': file(VULNERABLE.replace(/"/g, "'")) }, 'Single quotes everywhere');
  const scanned = commit(bob, { '.git-blame-ignore-revs': `# mass reformatting\n${reformat}\n` }, 'Ignore the quote change in blame');
  const blame = await blameInDir(dir, { refs: [scanned], path: 'app.js', line: 2, expect: 'query', env });
  assert.equal(blame.authorEmail, alice.email);
  assert.equal(blame.ignoredRevs, 1);
});

test('a bot’s commit is looked past, to the person who wrote the line', async () => {
  const { dir, commit } = repo();
  commit(alice, { 'app.js': file(VULNERABLE) }, 'Add user lookup');
  const scanned = commit(bot, { 'app.js': file(`${VULNERABLE} // bumped`) }, 'Bump db from 1.0 to 1.1');
  const blame = await blameInDir(dir, { refs: [scanned], path: 'app.js', line: 2, expect: 'query', env });
  assert.equal(blame.authorEmail, alice.email);
  assert.deepEqual(blame.skippedBots.map((b) => b.author), ['dependabot[bot]']);
  const confidence = confidenceOf(blame, { scannedCommit: scanned });
  assert.equal(confidence.level, 'high');
  assert.match(confidence.reason, /past 1 bot commit/);
});

test('code that was only moved stays with its author', async () => {
  const { dir, commit } = repo();
  commit(alice, { 'app.js': file(VULNERABLE) }, 'Add user lookup');
  const scanned = commit(bob, { 'app.js': file(VULNERABLE, ['// helpers', 'const a = 1;', 'const b = 2;', '']) }, 'Add helpers above');
  const blame = await blameInDir(dir, { refs: [scanned], path: 'app.js', line: 6, expect: 'query', env });
  assert.equal(blame.authorEmail, alice.email);
});

test('a line that no longer holds the vulnerable code, or a scanned commit that is gone, is never "sure"', async () => {
  const { dir, commit } = repo();
  const scanned = commit(alice, { 'app.js': file(VULNERABLE) }, 'Add user lookup');
  // The scanned line, at a later version where someone replaced it.
  commit(bob, { 'app.js': file('  return db.users.findById(id);') }, 'Use the ORM');
  const changed = await blameInDir(dir, { refs: ['main'], path: 'app.js', line: 2, expect: 'query', env });
  assert.equal(changed.matches, false);
  assert.equal(confidenceOf(changed, { scannedCommit: '' }).level, 'low');

  const missing = 'f'.repeat(40);
  const later = await blameInDir(dir, { refs: [missing, 'main'], path: 'app.js', line: 2, expect: 'findById', env });
  assert.equal(later.fallback, true);
  assert.equal(confidenceOf(later, { scannedCommit: missing }).level, 'low', 'blamed at a later version');

  const atScan = await blameInDir(dir, { refs: [scanned], path: 'app.js', line: 2, expect: 'query', env });
  assert.equal(confidenceOf(atScan, { scannedCommit: scanned }).level, 'high');
  assert.equal(await blameInDir(dir, { refs: ['--output=/tmp/x'], path: '-x', line: 1, env }), null, 'nothing from scan data is read as an option');
});

test('a host API answer: sure at the scanned commit, to check when it looks like reformatting', () => {
  const api = { commit: 'a'.repeat(40), ref: 'a'.repeat(40), exact: true, authorName: 'Alice Dev', authorEmail: 'alice@acme.io', via: 'GitHub blame', message: 'Add user lookup', matches: null };
  assert.equal(confidenceOf(api, { scannedCommit: 'a'.repeat(40) }).level, 'high');
  assert.equal(confidenceOf({ ...api, message: 'Reformat with prettier' }, { scannedCommit: 'a'.repeat(40) }).level, 'medium');
  assert.equal(confidenceOf({ ...api, exact: false, ref: 'main', matches: true }, { scannedCommit: '' }).level, 'medium');
});
