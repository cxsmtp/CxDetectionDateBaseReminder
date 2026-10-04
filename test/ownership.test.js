// Code owners (CODEOWNERS) and the pull or merge request a blamed commit came in through.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { addOwnership, codeownersInDir, githubChange, gitlabChange, ownersOf, parseCodeowners, patternRegex } from '../src/scm/ownership.js';

test('patterns are read the way GitHub reads them', () => {
  const m = (pattern, path) => patternRegex(pattern).test(path);
  assert.ok(m('*', 'src/a.js'));
  assert.ok(m('*.js', 'src/deep/a.js'));
  assert.ok(!m('*.js', 'src/a.ts'));
  assert.ok(m('/build/logs/', 'build/logs/x/y.log'));
  assert.ok(!m('/build/logs/', 'src/build/logs/y.log'));
  assert.ok(m('apps/', 'apps/x.js') && m('apps/', 'src/apps/x.js'), 'a folder name without a leading slash matches anywhere');
  assert.ok(m('docs/*', 'docs/a.md'));
  assert.ok(!m('docs/*', 'docs/sub/a.md'), '"docs/*" is not its subfolders');
  assert.ok(m('**/logs', 'deep/logs/a.log'));
  assert.ok(m('/src/**/*.java', 'src/a/b/C.java'));
  assert.ok(m('/README.md', 'README.md') && !m('/README.md', 'docs/README.md'));
  assert.ok(m('src/a.c', 'src/a.c') && !m('src/a.c', 'x/src/a.c'), 'a path with a slash in it is anchored');
  assert.equal(patternRegex('!secret'), null);
  assert.ok(!m('a.(js)', 'aXjs'), 'regex characters are literal');
});

test('the last matching rule wins; a rule with no owners clears them', () => {
  const rules = parseCodeowners(`
# Default owners
*       @acme/everyone
*.js    @js-owner   # trailing comment
/apps/  @acme/apps alice@acme.com
/apps/github
not-an-owner-line notowner
`);
  assert.deepEqual(ownersOf(rules, 'README.md'), ['@acme/everyone']);
  assert.deepEqual(ownersOf(rules, 'src/x.js'), ['@js-owner']);
  assert.deepEqual(ownersOf(rules, 'apps/x.js'), ['@acme/apps', 'alice@acme.com']);
  assert.deepEqual(ownersOf(rules, 'apps/github/x.js'), [], 'no owners on the last match');
  assert.deepEqual(ownersOf(rules, 'not-an-owner-line'), [], 'words that are not owners are dropped');
  assert.deepEqual(ownersOf([], 'a'), []);
});

test("GitLab sections: each section's last match counts, with the section's default owners", () => {
  const rules = parseCodeowners(`
[Docs] @docs-team
*.md
[Backend][2] @backend
/src/
^[Security] @sec/leads
/src/auth/ @sec/auth
`);
  assert.deepEqual(ownersOf(rules, 'README.md'), ['@docs-team']);
  assert.deepEqual(ownersOf(rules, 'src/auth/login.md'), ['@docs-team', '@backend', '@sec/auth']);
  assert.deepEqual(ownersOf(rules, 'src/x.java'), ['@backend']);
});

test('the file is read from a clone at the scanned commit, in the host\'s order of places', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'owners-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t.t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t.t' } }).toString().trim();
    git('init', '-q');
    mkdirSync(join(dir, '.github'));
    writeFileSync(join(dir, '.github', 'CODEOWNERS'), '* @first\n');
    git('add', '.');
    git('commit', '-qm', 'one');
    const first = git('rev-parse', 'HEAD');
    writeFileSync(join(dir, '.github', 'CODEOWNERS'), '* @second\n');
    writeFileSync(join(dir, 'CODEOWNERS'), '* @root\n');
    git('add', '.');
    git('commit', '-qm', 'two');
    assert.equal((await codeownersInDir(dir, { refs: [first] })).text.trim(), '* @first');
    assert.equal((await codeownersInDir(dir, { refs: [] })).text.trim(), '* @second');
    assert.equal((await codeownersInDir(dir, { refs: [], provider: 'gitlab' })).path, 'CODEOWNERS');
    const unsafe = await codeownersInDir(dir, { refs: ['--output=x'] });
    assert.equal(unsafe.ref, 'HEAD', 'an unsafe ref is never passed to git');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeGithub(routes) {
  const calls = [];
  return {
    calls,
    hasToken: true,
    async rest(path, query) {
      calls.push(path);
      for (const [pattern, answer] of routes) {
        if (pattern.test(path)) {
          if (answer instanceof Error) throw answer;
          return typeof answer === 'function' ? answer(path, query) : answer;
        }
      }
      throw Object.assign(new Error('Not Found'), { status: 404 });
    },
  };
}

test('GitHub: the merged pull request of a commit, and only reviewers whose last word was an approval', async () => {
  const gh = fakeGithub([
    [/\/commits\/abc1234\/pulls$/, [{ number: 7, title: 'open one', merged_at: null }, { number: 12, title: 'Add login', html_url: 'https://github.com/o/r/pull/12', user: { login: 'dev' }, merged_at: '2026-01-02T00:00:00Z' }]],
    [/\/pulls\/12\/reviews$/, [
      { user: { login: 'ann' }, state: 'APPROVED' },
      { user: { login: 'bob' }, state: 'APPROVED' },
      { user: { login: 'bob' }, state: 'CHANGES_REQUESTED' },
      { user: { login: 'cat' }, state: 'COMMENTED' },
    ]],
  ]);
  const change = await githubChange(gh, { owner: 'o', repo: 'r', sha: 'abc1234' });
  assert.deepEqual(change, { kind: 'pull request', number: 12, title: 'Add login', url: 'https://github.com/o/r/pull/12', author: 'dev', mergedAt: '2026-01-02T00:00:00Z', approvers: ['ann'] });
  assert.equal(await githubChange(gh, { owner: 'o', repo: 'r', sha: 'not-a-sha' }), null);
});

test('GitLab: the merge request of a commit, with who approved it', async () => {
  const client = {
    async get(path) {
      if (path.endsWith('/repository/commits/def5678/merge_requests')) return [{ iid: 3, state: 'merged', title: 'Fix', web_url: 'https://gitlab.com/g/r/-/merge_requests/3', author: { username: 'dev' }, merged_by: { username: 'lead' }, merged_at: '2026-02-03' }];
      if (path.endsWith('/merge_requests/3/approvals')) return { approved_by: [{ user: { username: 'ann' } }] };
      throw Object.assign(new Error('nope'), { status: 404 });
    },
  };
  const change = await gitlabChange(client, { owner: 'g', repo: 'r', sha: 'def5678' });
  assert.equal(change.kind, 'merge request');
  assert.equal(change.number, 3);
  assert.equal(change.mergedBy, 'lead');
  assert.deepEqual(change.approvers, ['ann']);
});

test('owners and change requests are filled in once per repository and commit, and missing ones are left out', async () => {
  const codeowners = Buffer.from('* @acme/all\n/src/auth/ @acme/security\n').toString('base64');
  const gh = fakeGithub([
    [/\/contents\/\.github\/CODEOWNERS$/, { content: codeowners, encoding: 'base64' }],
    [/\/commits\/aaa1111\/pulls$/, [{ number: 5, merged_at: 'x', user: { login: 'dev' } }]],
    [/\/pulls\/5\/reviews$/, []],
    [/\/commits\/bbb2222\/pulls$/, []],
  ]);
  const repo = { host: 'github.com', owner: 'o', repo: 'r', cloneUrl: 'https://github.com/o/r.git' };
  const item = (path, commit) => ({ provider: 'github', repo, version: { commit: 'ccc3333', branch: 'main' }, location: { path, line: 1 }, blame: { commit } });
  const items = [item('src/auth/a.js', 'aaa1111'), item('README.md', 'aaa1111'), item('src/b.js', 'bbb2222')];
  await addOwnership(items, { github: () => gh, gitlab: () => null, clone: () => null });
  assert.deepEqual(items.map((i) => i.owners?.list), [['@acme/security'], ['@acme/all'], ['@acme/all']]);
  assert.equal(items[0].owners.file, '.github/CODEOWNERS');
  assert.equal(items[0].change.number, 5);
  assert.deepEqual(items[0].change.approvers, []);
  assert.equal(items[2].change, undefined, 'a commit pushed straight to the branch has no change request');
  assert.equal(gh.calls.filter((p) => p.includes('/contents/')).length, 1, 'one read of the file for the repository');
  assert.equal(gh.calls.filter((p) => p.endsWith('/aaa1111/pulls')).length, 1, 'one lookup per commit');

  // No access (403): no owners, nothing thrown, and no further places are tried.
  const denied = fakeGithub([[/\/contents\//, Object.assign(new Error('Forbidden'), { status: 403 })]]);
  const other = [item('a.js', 'not-hex')];
  await addOwnership(other, { github: () => denied, clone: () => null });
  assert.equal(other[0].owners, undefined);
  assert.equal(denied.calls.length, 1);
});
