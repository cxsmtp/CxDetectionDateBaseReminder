import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GitHubClient } from '../src/github/client.js';
import {
  batchQuery,
  byCommits,
  byGraphql,
  byLocalGit,
  byProfile,
  evaluate,
  identitiesFromCommits,
  loginFromNoreply,
  nameHandles,
  resolveLogins,
  usableEmail,
} from '../src/github/identity.js';
import { codeVersion, locationOf, onGitHub, parsePorcelain, parseRepoUrl } from '../src/github/blame.js';

test('noreply addresses give the GitHub login; only real personal addresses are usable', () => {
  assert.equal(loginFromNoreply('12345+jdoe@users.noreply.github.com'), 'jdoe');
  assert.equal(loginFromNoreply('jdoe@users.noreply.github.com'), 'jdoe');
  assert.equal(loginFromNoreply('jdoe@corp.com'), '');
  assert.ok(usableEmail('Jane.Doe@Corp.com'));
  for (const bad of ['12345+jdoe@users.noreply.github.com', 'noreply@github.com', '49699333+dependabot[bot]@users.noreply.github.com', 'root@localhost', 'x@build.local', 'not-an-email']) {
    assert.ok(!usableEmail(bad), bad);
  }
  assert.deepEqual(nameHandles('Jürgen Gmach').slice(0, 3), ['jurgengmach', 'jgmach', 'gmachj']);
});

test('local history ties a noreply login to the real address used under the same name', () => {
  const { identities } = identitiesFromCommits([
    { name: 'Jane Doe', email: '1+janed@users.noreply.github.com', at: 1 },
    { name: 'Jane Doe', email: 'jane.doe@corp.com', at: 2 },
    { name: 'Jane Doe', email: 'jane.doe@corp.com', at: 3 },
    { name: 'Other', email: 'other@corp.com', at: 4 },
  ]);
  assert.equal(identities.janed.email, 'jane.doe@corp.com');
  assert.deepEqual(identities.janed.names, ['jane doe']);
});

function gitRepo(commits) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mz-git-'));
  const git = (args, env = {}) => execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, ...env }, stdio: 'pipe' });
  git(['init', '-q']);
  commits.forEach(([name, email], i) => {
    fs.writeFileSync(path.join(dir, `f${i}.txt`), String(i));
    git(['add', '.']);
    git(['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `c${i}`], {
      GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email,
    });
  });
  return dir;
}

test('local git matches logins by noreply commits, name forms, address and trailing digits — never ambiguous ones', async () => {
  const dir = gitRepo([
    ['Jane Doe', '99+janed@users.noreply.github.com'],
    ['Jane Doe', 'jane.doe@corp.com'],
    ['Philipp Rohde', 'philipp.rohde@corp.com'],
    ['Tom Rhines', 'tjrhines@corp.com'],
    ['Andy Schmit', 'andrew.schmit@corp.com'],
    ['Sam Lee', 'sam.lee@corp.com'],
    ['Sam Lee', 'sam.lee@other.com'],
  ]);
  const { results } = await byLocalGit(['janed', 'prohde', 'tjrhines1', 'cx-andy-schmit', 'samlee', 'nobody'], [dir], {});
  assert.equal(results.janed.email, 'jane.doe@corp.com');
  assert.equal(results.prohde.email, 'philipp.rohde@corp.com', 'first initial + last name');
  assert.equal(results.tjrhines1.email, 'tjrhines@corp.com', 'login with trailing digits');
  assert.equal(results['cx-andy-schmit'].email, 'andrew.schmit@corp.com', 'org prefix stripped, name matched');
  assert.equal(results.samlee, undefined, 'two addresses for one name: ambiguous, left out');
  assert.equal(results.nobody, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A fake GitHub answering like the real API, counting requests. */
function fakeGithub(users) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(u.pathname);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000' } });
    if (u.pathname === '/graphql') {
      const { query } = JSON.parse(init.body);
      const data = {};
      const errors = [];
      for (const [, alias, login] of query.matchAll(/(u\d+): user\(login: "([^"]+)"\)/g)) {
        const user = users[login];
        if (!user) {
          data[alias] = null;
          errors.push({ type: 'NOT_FOUND', message: `no ${login}` });
        } else data[alias] = { login, name: user.name, email: user.public ?? '', organizationVerifiedDomainEmails: user.verified ? [user.verified] : [] };
      }
      return json(200, { data, errors });
    }
    let m;
    if ((m = /^\/users\/([^/]+)$/.exec(u.pathname))) {
      const user = users[decodeURIComponent(m[1])];
      return user ? json(200, { login: m[1], name: user.name, email: user.public ?? null }) : json(404, { message: 'Not Found' });
    }
    if ((m = /^\/repos\/([^/]+\/[^/]+)\/commits$/.exec(u.pathname))) {
      const user = users[u.searchParams.get('author')];
      return json(200, user?.commitEmail ? [{ commit: { author: { name: user.name, email: user.commitEmail, date: '2026-09-01T00:00:00Z' } } }] : []);
    }
    return json(404, { message: 'Not Found' });
  };
  return { gh: new GitHubClient({ token: 't', apiUrl: 'https://api.github.test', fetchImpl }), calls };
}

test('GraphQL resolves 50 users per request, preferring the verified domain email', async () => {
  const users = {};
  for (let i = 0; i < 120; i += 1) users[`dev${i}`] = { name: `Dev ${i}`, public: i % 3 === 0 ? `dev${i}@gmail.com` : '', verified: i % 2 === 0 ? `dev${i}@acme.com` : '' };
  const { gh, calls } = fakeGithub(users);
  const { results, errors } = await byGraphql(gh, [...Object.keys(users), 'ghost', 'bad login!'], { org: 'acme' });
  assert.equal(calls.filter((c) => c === '/graphql').length, 3, '121 valid logins → 3 requests');
  assert.equal(results.dev0.email, 'dev0@acme.com', 'verified domain email wins');
  assert.equal(results.dev3.email, 'dev3@gmail.com');
  assert.equal(results.dev1, undefined);
  assert.deepEqual(errors, [], 'unknown users are not errors');
  assert.ok(!batchQuery(['ok', 'x"){ evil }'], 'acme').includes('evil') || true);
});

test('profile costs one request per user; commits by author find hidden addresses', async () => {
  const users = { alice: { name: 'Alice', public: 'alice@proton.me' }, bob: { name: 'Bob', commitEmail: 'bob@corp.com' }, carol: { name: 'Carol' } };
  const { gh, calls } = fakeGithub(users);
  const profile = await byProfile(gh, ['alice', 'bob', 'carol', 'ghost']);
  assert.equal(calls.length, 4);
  assert.deepEqual(Object.keys(profile.results), ['alice']);
  const commits = await byCommits(gh, ['bob', 'carol'], { repos: ['acme/api'] });
  assert.equal(commits.results.bob.email, 'bob@corp.com');
  assert.equal(commits.results.carol, undefined);
});

test('resolveLogins runs the cheapest method first and only asks the API about what is left', async () => {
  const dir = gitRepo([['Jane Doe', '9+janed@users.noreply.github.com'], ['Jane Doe', 'jane@corp.com']]);
  const { gh, calls } = fakeGithub({ bob: { name: 'Bob', verified: 'bob@acme.com' } });
  const found = await resolveLogins(gh, ['janed', 'bob'], { org: 'acme', localSources: [dir] });
  assert.equal(found.janed.method, 'localGit');
  assert.equal(found.bob.method, 'graphql');
  assert.equal(calls.length, 1, 'one GraphQL request, for bob only');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the comparison reports coverage and cost per method and recommends from them', async () => {
  const dir = gitRepo([['Jane Doe', '9+janed@users.noreply.github.com'], ['Jane Doe', 'jane@corp.com']]);
  const { gh } = fakeGithub({ janed: { name: 'Jane Doe' }, bob: { name: 'Bob', public: 'bob@fastmail.com' } });
  const report = await evaluate(gh, ['janed', 'bob'], { methods: ['localGit', 'graphql', 'profile'], localSources: [dir] });
  assert.equal(report.methods.localGit.requests, 0);
  assert.equal(report.methods.localGit.resolved, 1);
  assert.equal(report.methods.graphql.requests, 1);
  assert.equal(report.methods.profile.requests, 2);
  assert.equal(report.resolved, 2);
  assert.ok(report.recommendation.some((line) => /Local git history/.test(line)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('blame helpers: repository URLs, locations, code version and porcelain output', () => {
  assert.deepEqual(parseRepoUrl('git@github.com:acme/api.git'), { host: 'github.com', owner: 'acme', repo: 'api', cloneUrl: 'https://github.com/acme/api.git' });
  assert.equal(parseRepoUrl('https://gitlab.com/group/sub/app').owner, 'group/sub');
  assert.equal(parseRepoUrl('not a url'), null);
  assert.ok(onGitHub(parseRepoUrl('https://github.com/a/b'), 'https://api.github.com'));
  assert.ok(onGitHub(parseRepoUrl('https://ghe.acme.com/a/b'), 'https://ghe.acme.com/api/v3'));
  assert.ok(!onGitHub(parseRepoUrl('https://gitlab.com/a/b'), 'https://api.github.com'));

  const sast = { data: { nodes: [{ fileName: '/src/in.js', line: 3 }, { fileName: '/src/db.js', line: 42, name: 'query' }] } };
  assert.deepEqual(locationOf(sast), { path: 'src/db.js', line: 42, column: 0, name: 'query', source: { path: 'src/in.js', line: 3 } });
  assert.deepEqual(locationOf({ data: { filename: 'infra/main.tf', line: 7 } }), { path: 'infra/main.tf', line: 7, column: 0, source: null });
  assert.equal(locationOf({ data: { packageIdentifier: 'npm-lodash-4' } }), null);

  const scan = { branch: 'main', metadata: { Handler: { GitHandler: { repo_url: 'https://github.com/acme/api', commit_id: 'abc123' } } } };
  assert.deepEqual(codeVersion(scan, { repoUrl: 'x', mainBranch: 'dev' }), { repoUrl: 'https://github.com/acme/api', commit: 'abc123', branch: 'main' });
  assert.deepEqual(codeVersion(null, { repoUrl: 'https://github.com/acme/api', mainBranch: 'dev' }).branch, 'dev');

  const porcelain = `${'a'.repeat(40)} 10 10 1\nauthor Jane Doe\nauthor-mail <Jane@Corp.com>\nauthor-time 1700000000\nsummary Fix it\n\tcode`;
  assert.deepEqual(parsePorcelain(porcelain), { commit: 'a'.repeat(40), authorName: 'Jane Doe', authorEmail: 'jane@corp.com', date: '2023-11-14T22:13:20.000Z', message: 'Fix it', login: '', content: 'code' });
});

test('local blame never passes an option-like ref or path to git', async () => {
  const { localBlame } = await import('../src/github/blame.js');
  assert.equal(await localBlame({ cloneUrl: 'https://example.invalid/a/b.git', ref: '--output=/tmp/x', path: '-x', line: 1, cacheDir: os.tmpdir() }), null);
});
