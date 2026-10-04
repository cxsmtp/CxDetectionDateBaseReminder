// "Apply fix in my workspace" and "Copy git command": the report's patcher
// (run here exactly as the report inlines it) and the server's git patch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { fileChanges, gitPatch, patchLinks, repoPath } from '../src/remediation-patch.js';

const MZPatch = vm.runInNewContext(`${fs.readFileSync(new URL('../src/report/patch.client.js', import.meta.url), 'utf8')}\nMZPatch`);

const FILE = ['const a = 1;', 'function query(id) {', '  return db.run("SELECT * FROM t WHERE id=" + id);', '}', 'module.exports = query;', ''].join('\n');
const DIFF = [
  '--- a/src/db.js',
  '+++ b/src/db.js',
  '@@ -2,3 +2,3 @@',
  ' function query(id) {',
  '-  return db.run("SELECT * FROM t WHERE id=" + id);',
  '+  return db.run("SELECT * FROM t WHERE id=?", [id]);',
  ' }',
].join('\n');

test('the patcher applies a diff where it says, keeping the file as it was otherwise', () => {
  const result = MZPatch.apply(FILE, DIFF);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.changes, 1);
  assert.equal(result.moved, 0);
  assert.equal(result.text, FILE.replace('id=" + id);', 'id=?", [id]);'));
});

test('the patcher finds a change that moved since the scan, and keeps CRLF line endings', () => {
  const moved = `// header\n// added since the scan\n${FILE}`.replace(/\n/g, '\r\n');
  const result = MZPatch.apply(moved, DIFF);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.moved, 1);
  assert.match(result.text, /id=\?", \[id\]\);\r\n\}\r\n/);
  assert.ok(!/[^\r]\n/.test(result.text), 'every line still ends in CRLF');
});

test('the patcher refuses, and writes nothing, when the code there was changed', () => {
  const changed = FILE.replace('SELECT *', 'SELECT id');
  const result = MZPatch.apply(changed, DIFF);
  assert.equal(result.ok, false);
  assert.match(result.error, /no longer matches/);
  assert.equal(result.text, undefined);
});

test('the patcher handles several hunks, a new file and a trimmed blank context line', () => {
  const file = ['a', 'b', '', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].join('\n') + '\n';
  const diff = ['@@ -1,4 +1,4 @@', ' a', '-b', '+B', '', ' c', '@@ -8,2 +8,3 @@', ' g', '+G2', ' h'].join('\n');
  const result = MZPatch.apply(file, diff);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.text, ['a', 'B', '', 'c', 'd', 'e', 'f', 'g', 'G2', 'h', 'i'].join('\n') + '\n');
  const created = MZPatch.apply('', ['--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1,2 @@', '+one', '+two'].join('\n'));
  assert.equal(created.ok, true, created.error);
  assert.equal(created.text, 'one\ntwo\n');
  assert.equal(MZPatch.parse('--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+x').created, true);
  assert.match(MZPatch.apply('x\n', '--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-x').error, /deletes the file/);
});

test('the patcher only writes inside the picked folder, and knows one repository by its https and ssh names', () => {
  assert.equal(JSON.stringify(MZPatch.segments('/src/db.js')), '["src","db.js"]');
  for (const bad of ['../etc/passwd', 'src/../../x', '.git/config', 'a//b', 'C:/Windows/x', '']) assert.equal(MZPatch.segments(bad), null, bad);
  const key = MZPatch.repoKey('https://github.com/Acme/App.git');
  assert.equal(key, 'github.com/acme/app');
  assert.equal(MZPatch.repoKey('git@github.com:acme/app.git'), key);
  assert.equal(MZPatch.repoKey('ssh://git@github.com:22/acme/app'), key);
  assert.equal(MZPatch.repoKey('https://user:token@github.com/acme/app/'), key);
  assert.equal(JSON.stringify(MZPatch.remotes('[remote "origin"]\n\turl = git@github.com:acme/app.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n')), '["git@github.com:acme/app.git"]');
});

const BODY = {
  results: [{
    finishedAt: 't',
    data: {
      file_changes: [
        { file_path: '/src/db.js', diff: DIFF, analysis: 'parameterised' },
        { file_path: '../../etc/passwd', diff: '@@ -1 +1 @@\n-root\n+evil' },
        { file_path: 'docs/none.md', diff: 'no hunks here' },
      ],
    },
  }],
};

test('the git patch keeps only safe paths, with git headers, and git applies it to a checkout', () => {
  assert.equal(repoPath('/src/db.js'), 'src/db.js');
  assert.equal(repoPath('src/../x'), '');
  assert.deepEqual(fileChanges(BODY).map((c) => c.path), ['src/db.js']);
  const patch = gitPatch(BODY);
  assert.match(patch, /^diff --git a\/src\/db\.js b\/src\/db\.js\n--- a\/src\/db\.js\n\+\+\+ b\/src\/db\.js\n@@ /);
  assert.ok(!patch.includes('passwd'));
  assert.equal(gitPatch({ results: [{ data: {} }] }), '');
  assert.equal(gitPatch(null), '');

  // The one-line command's second half, for real.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-apply-'));
  fs.mkdirSync(path.join(repo, 'src'));
  fs.writeFileSync(path.join(repo, 'src/db.js'), FILE);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'mz-fix.patch'), patch);
  execFileSync('git', ['apply', '--recount', 'mz-fix.patch'], { cwd: repo });
  assert.equal(fs.readFileSync(path.join(repo, 'src/db.js'), 'utf8'), MZPatch.apply(FILE, DIFF).text);

  const created = gitPatch({ results: [{ data: { file_changes: [{ file_path: 'src/new.js', diff: '@@ -0,0 +1,1 @@\n+export {};' }] } }] });
  assert.match(created, /new file mode 100644\n--- \/dev\/null\n\+\+\+ b\/src\/new\.js/);
  execFileSync('git', ['apply', '--recount', '-'], { cwd: repo, input: created });
  assert.equal(fs.readFileSync(path.join(repo, 'src/new.js'), 'utf8'), 'export {};\n');
});

test('patch links are signed, name one finding and expire', () => {
  const links = patchLinks((text) => createHmac('sha256', 'k').update(text).digest('base64url'));
  const token = links.issue({ scanId: 'scan-1', alternateId: 'alt-1' }, 1000);
  assert.deepEqual(links.verify(token, 2000), { scanId: 'scan-1', alternateId: 'alt-1' });
  assert.deepEqual(links.verify(token, 1000 + 8 * 24 * 3600 * 1000), { expired: true });
  const [payload, sig] = token.split('.');
  const other = Buffer.from(JSON.stringify(['scan-1', 'alt-2', Date.now() + 1e9])).toString('base64url');
  assert.equal(links.verify(`${other}.${sig}`), null, 'another finding under the same signature');
  assert.equal(links.verify(`${payload}.${sig}x`), null);
  assert.equal(links.verify(`${payload}`), null);
  assert.equal(links.verify(`${payload}.${sig}.x`), null);
  assert.equal(links.verify(''), null);
});

test('a command for an AI assistant cannot run anything a finding title smuggles in', () => {
  const hostile = 'XSS"; rm -rf / `whoami` $(id) %PATH% ^& | > out & echo \\ \'x\' !hist\nnext';
  const safe = MZPatch.shellSafe(hostile);
  assert.doesNotMatch(safe, /["'`$%^&|<>\\!\n]/);
  assert.match(safe, /^XSS ; rm -rf \/ whoami \(id\) PATH out echo x hist next$/);
  // Run it for real: inside double quotes it is one inert argument.
  const echoed = execFileSync('sh', ['-c', `printf %s "${safe}"`]).toString();
  assert.equal(echoed, safe);
  assert.equal(MZPatch.shellSafe('a'.repeat(5000)).length, 1200);
});
