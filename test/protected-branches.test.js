// Protected branches (from MZ-01.01.20): the order they are suggested in, patterns, the suggestion for a project
// with no primary branch, and what each git host says it protects, read with that host's own client only.
import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanOrder, DEFAULT_ORDER, isProtected, matchesPattern, rankIn, readProtected, sortByOrder, suggestPrimary } from '../src/protected-branches.js';
import { scmConfigs } from '../src/scm/providers.js';

test('patterns: names, globs and alternatives, whole and without case', () => {
  assert.ok(matchesPattern('release/2.1', 'release/*'));
  assert.ok(!matchesPattern('pre-release/2.1', 'release/*'));
  assert.ok(matchesPattern('refs/heads/Main', 'main'));
  assert.ok(matchesPattern('dev', 'develop|dev|development'));
  assert.ok(!matchesPattern('devops', 'develop|dev|development'));
  assert.ok(!matchesPattern('main', ''));
  assert.equal(rankIn('trunk'), 2);
  assert.equal(rankIn('feature/x'), Infinity);
  assert.deepEqual(sortByOrder(['feature/a', 'hotfix/1', 'develop', 'master', 'main']), ['main', 'master', 'develop', 'hotfix/1', 'feature/a']);
  assert.ok(isProtected('release/3', ['main', 'release/*']));
});

test("an Admin's order keeps names and globs only, at most twenty", () => {
  assert.deepEqual(cleanOrder(['develop', ' main | master ', 'bad branch', '<script>', 'release/*', 'develop']), ['develop', 'main|master', 'release/*']);
  assert.deepEqual(cleanOrder('nope'), [...DEFAULT_ORDER]);
  assert.deepEqual(cleanOrder([]), [...DEFAULT_ORDER]);
  assert.equal(cleanOrder(Array.from({ length: 40 }, (_, i) => `b${i}`)).length, 20);
});

test('the suggestion: the protected branch first in the order, else a usual name, else none', () => {
  assert.deepEqual(suggestPrimary({ branches: ['develop', 'main', 'feature/x'], protectedNames: ['develop', 'main'] }), { branch: 'main', why: 'protected' });
  // A protected glob makes the branches it matches protected; a protected name counts even before any scan on it.
  assert.deepEqual(suggestPrimary({ branches: ['release/2', 'feature/x'], protectedNames: ['release/*'] }), { branch: 'release/2', why: 'protected' });
  assert.deepEqual(suggestPrimary({ branches: ['feature/x'], protectedNames: ['trunk'] }), { branch: 'trunk', why: 'protected' });
  // Nothing protected known: main, master or trunk when scanned; a develop branch alone is not a guess.
  assert.deepEqual(suggestPrimary({ branches: ['feature/x', 'master'] }), { branch: 'master', why: 'pattern' });
  assert.deepEqual(suggestPrimary({ branches: ['develop'] }), { branch: '', why: '' });
  // The order an Admin chose decides between protected branches.
  assert.deepEqual(suggestPrimary({ branches: ['main', 'develop'], protectedNames: ['main', 'develop'], order: ['develop', 'main'] }), { branch: 'develop', why: 'protected' });
});

/** A client that answers one path, and remembers what it was asked. */
const fake = (answers) => {
  const asked = [];
  const get = async (path, query) => {
    asked.push([path, query]);
    if (!(path in answers)) throw Object.assign(new Error('not found'), { status: 404 });
    return answers[path];
  };
  return { asked, get, rest: get };
};

test('each git host: what it protects, read with its own client', async () => {
  const configs = scmConfigs({ beta: { gitlab: { apiUrl: 'https://gitlab.acme.io', token: 'gl' }, azure: { orgUrl: 'https://dev.azure.com/acme', token: 'az' }, bitbucket: { kind: 'cloud', token: 'bb', username: 'u' } } }, {});
  const github = fake({ '/repos/acme/api/branches': [{ name: 'main' }, { name: 'release/1' }] });
  const gitlab = fake({ '/projects/fin%2Fledger/protected_branches': [{ name: 'master' }, { name: 'release/*' }] });
  const azureOrg = fake({
    '/Mobile/_apis/git/repositories/app': { id: 'r1' },
    '/Mobile/_apis/policy/configurations': { value: [
      { isEnabled: true, settings: { scope: [{ repositoryId: 'r1', refName: 'refs/heads/trunk', matchKind: 'Exact' }] } },
      { isEnabled: true, settings: { scope: [{ repositoryId: null, refName: 'refs/heads/release/', matchKind: 'Prefix' }] } },
      { isEnabled: true, settings: { scope: [{ repositoryId: 'other', refName: 'refs/heads/main', matchKind: 'Exact' }] } },
      { isEnabled: false, settings: { scope: [{ repositoryId: 'r1', refName: 'refs/heads/off', matchKind: 'Exact' }] } },
    ] },
  });
  const bitbucket = fake({ '/repositories/acme/portal/branch-restrictions': { values: [{ pattern: 'master', branch_match_kind: 'glob' }, { branch_type: 'production', branch_match_kind: 'branching_model' }] } });
  const hosts = { github, githubApiUrl: 'https://api.github.com', configs, clients: { gitlab, azure: { org: azureOrg }, bitbucket } };

  assert.deepEqual(await readProtected('https://github.com/acme/api.git', hosts), { provider: 'github', label: 'GitHub', repo: 'acme/api', names: ['main', 'release/1'], error: '' });
  assert.deepEqual(github.asked[0][1], { protected: 'true', per_page: 100 });
  assert.deepEqual((await readProtected('https://gitlab.acme.io/fin/ledger', hosts)).names, ['master', 'release/*']);
  assert.deepEqual((await readProtected('https://dev.azure.com/acme/Mobile/_git/app', hosts)).names, ['trunk', 'release/*']);
  assert.deepEqual((await readProtected('https://bitbucket.org/acme/portal.git', hosts)).names, ['master']);
  // Another Azure DevOps organisation's token is never used: that repository is not read.
  assert.equal((await readProtected('https://dev.azure.com/other/Mobile/_git/app', hosts)).provider, '');
  // A host that refuses says so in a few words; an address that is no repository is skipped.
  const refused = await readProtected('https://github.com/acme/secret', hosts);
  assert.match(refused.error, /^GitHub: not found, or the token cannot see it\.$/);
  assert.deepEqual(await readProtected('not a url', hosts), { provider: '', label: '', repo: '', names: [], error: '' });
  assert.equal((await readProtected('https://git.unknown.io/a/b', hosts)).provider, '');
});
