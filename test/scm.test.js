// GitLab, Azure DevOps and Bitbucket for the beta features: which host a repository is on,
// each token only for its own host, blame through the host's API where it has one, and
// usernames → addresses by every method each host offers, compared on coverage and cost.
// The hosts are API doubles answering like the real ones, counting requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { blameFindings, parseRepoUrl } from '../src/github/blame.js';
import { loginFromNoreply } from '../src/github/identity.js';
import { azureClient, azureMethods, vsspsUrl } from '../src/scm/azure.js';
import { bitbucketClient, bitbucketMethods, parseRaw } from '../src/scm/bitbucket.js';
import { gitlabBlame, gitlabClient, gitlabMethods } from '../src/scm/gitlab.js';
import { directoryMatcher, evaluateMethods, resolveWith, validUsername } from '../src/scm/identity.js';
import { cloneAuthFor, commitUrl, providerOf, scmConfigs } from '../src/scm/providers.js';

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const basic = (header) => Buffer.from(header.replace(/^Basic /, ''), 'base64').toString();

function gitRepo(authors) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-git-'));
  execFileSync('git', ['init', '-q', dir]);
  authors.forEach(([name, email], i) => {
    fs.writeFileSync(path.join(dir, `f${i}.txt`), String(i));
    execFileSync('git', ['-C', dir, 'add', '.']);
    execFileSync('git', ['-C', dir, '-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-m', `c${i}`]);
  });
  return dir;
}

test('settings and environment give each host its connection; the right host is found for a repository', () => {
  const configs = scmConfigs({ beta: { gitlab: { apiUrl: 'https://git.acme.io' } } }, {
    GITLAB_TOKEN: 'glpat', AZURE_DEVOPS_ORG_URL: 'https://dev.azure.com/acme', AZURE_DEVOPS_TOKEN: 'pat', BITBUCKET_URL: 'https://bitbucket.acme.io', BITBUCKET_TOKEN: 'bbt',
  });
  assert.equal(configs.gitlab.apiUrl, 'https://git.acme.io/api/v4');
  assert.equal(configs.gitlab.tokenSource, 'environment');
  assert.equal(configs.bitbucket.kind, 'server');
  const on = (url) => providerOf(parseRepoUrl(url), configs, 'https://api.github.com');
  assert.equal(on('https://github.com/acme/api.git'), 'github');
  assert.equal(on('https://git.acme.io/team/api.git'), 'gitlab');
  assert.equal(on('https://gitlab.com/team/api'), 'gitlab');
  assert.equal(on('https://acme@dev.azure.com/acme/Payments/_git/api'), 'azure');
  assert.equal(on('https://bitbucket.acme.io/scm/PAY/api.git'), 'bitbucket');
  assert.equal(on('https://bitbucket.org/acme/api.git'), 'bitbucket');
  assert.equal(on('https://code.other.org/x/y.git'), '');
  assert.equal(vsspsUrl('https://dev.azure.com/acme'), 'https://vssps.dev.azure.com/acme');
  assert.equal(vsspsUrl('https://acme.visualstudio.com'), 'https://acme.vssps.visualstudio.com');
});

test('each token goes only to its own host (and an Azure DevOps token only to its organisation)', () => {
  const configs = scmConfigs({ beta: {
    gitlab: { token: 'glpat' },
    azure: { orgUrl: 'https://dev.azure.com/acme', token: 'pat' },
    bitbucket: { kind: 'cloud', token: 'bbtoken' },
  } }, {});
  assert.equal(basic(cloneAuthFor('https://gitlab.com/a/b.git', configs)), 'oauth2:glpat');
  assert.equal(basic(cloneAuthFor('https://dev.azure.com/acme/P/_git/r', configs)), ':pat');
  assert.equal(cloneAuthFor('https://dev.azure.com/other-org/P/_git/r', configs), '', 'another organisation never gets the token');
  assert.equal(basic(cloneAuthFor('https://bitbucket.org/acme/api.git', configs)), 'x-token-auth:bbtoken');
  assert.equal(cloneAuthFor('https://github.com/acme/api.git', configs), '', 'not a GitHub token');
  assert.equal(cloneAuthFor('https://evil.example/acme/api.git', configs), '');
  const app = scmConfigs({ beta: { bitbucket: { kind: 'cloud', username: 'jdoe', token: 'app-pass' } } }, {});
  assert.equal(basic(cloneAuthFor('https://bitbucket.org/acme/api.git', app)), 'jdoe:app-pass', 'an app password goes with its username');
  // The API client refuses to send its token anywhere else, even when handed a full address.
  const client = gitlabClient({ apiUrl: 'https://gitlab.com/api/v4', token: 't' }, async () => json(200, {}));
  assert.throws(() => client.url('https://evil.example/api'), /Refusing to send GitLab credentials/);
});

test('GitLab blame: one request per file, every finding in it placed by its line', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    assert.equal(init.headers.Authorization, 'Bearer glpat');
    return json(200, [
      { commit: { id: 'a1', author_name: 'Ann', author_email: 'ann@acme.io', authored_date: '2026-01-01T00:00:00Z', message: 'first\nbody' }, lines: ['l1', 'l2'] },
      { commit: { id: 'b2', author_name: 'Bob', author_email: '42-bob.k@users.noreply.gitlab.com', authored_date: '2026-02-01T00:00:00Z', message: 'second' }, lines: ['l3'] },
    ]);
  };
  const configs = scmConfigs({ beta: { gitlab: { token: 'glpat' } } }, {});
  const clients = { gitlab: gitlabClient(configs.gitlab, fetchImpl), azure: null, bitbucket: bitbucketClient(configs.bitbucket, async () => json(404, {})) };
  const repo = parseRepoUrl('https://gitlab.com/team/api.git');
  const item = (line) => ({ finding: {}, location: { path: 'src/app.js', line }, version: { commit: 'abc', branch: 'main' }, repo });
  const items = [item(2), item(3)];
  await blameFindings(items, { gh: null, apiUrl: 'https://api.github.com', cacheDir: os.tmpdir(), scm: { configs, clients } });
  assert.equal(calls.length, 1, 'one request for the file');
  assert.match(calls[0], /\/api\/v4\/projects\/team%2Fapi\/repository\/files\/src%2Fapp\.js\/blame\?ref=abc/);
  assert.equal(items[0].blame.authorEmail, 'ann@acme.io');
  assert.equal(items[0].blame.via, 'GitLab blame');
  assert.equal(items[0].blame.url, 'https://gitlab.com/team/api/-/commit/a1');
  assert.equal(items[1].blame.commit, 'b2');
  assert.equal(loginFromNoreply(items[1].blame.authorEmail), 'bob.k', "GitLab's noreply address names the user");
  // Ranges, for a direct call.
  const ranges = await gitlabBlame(clients.gitlab, { owner: 'team', repo: 'api', ref: 'main', path: 'src/app.js' });
  assert.deepEqual(ranges.map((r) => [r.start, r.end]), [[1, 2], [3, 3]]);
});

test('Bitbucket Data Center blame through its API; Bitbucket Cloud and Azure DevOps fall back to git', async () => {
  const fetchImpl = async (url) => {
    assert.match(String(url), /\/rest\/api\/1\.0\/projects\/PAY\/repos\/api\/browse\/src\/a\.js\?blame=true&noContent=true&at=main/);
    return json(200, [
      { author: { name: 'jdoe', emailAddress: 'jane@acme.io', displayName: 'Jane Doe' }, authorTimestamp: 1767225600000, commitHash: 'c0ffee', lineNumber: 1, spannedLines: 10 },
    ]);
  };
  const configs = scmConfigs({ beta: { bitbucket: { kind: 'server', apiUrl: 'https://bitbucket.acme.io', token: 't' } } }, {});
  const clients = { gitlab: gitlabClient(configs.gitlab), azure: null, bitbucket: bitbucketClient(configs.bitbucket, fetchImpl) };
  const items = [{ finding: {}, location: { path: 'src/a.js', line: 7 }, version: { branch: 'main' }, repo: parseRepoUrl('https://bitbucket.acme.io/scm/PAY/api.git') }];
  await blameFindings(items, { gh: null, apiUrl: 'https://api.github.com', cacheDir: os.tmpdir(), scm: { configs, clients } });
  assert.equal(items[0].blame.authorEmail, 'jane@acme.io');
  assert.equal(items[0].blame.login, 'jdoe');
  assert.equal(items[0].blame.url, 'https://bitbucket.acme.io/projects/PAY/repos/api/commits/c0ffee');

  // No blame API: git blame is the way (here switched off, so it says so).
  const cloud = scmConfigs({ beta: { bitbucket: { kind: 'cloud', token: 't' }, azure: { orgUrl: 'https://dev.azure.com/acme', token: 'p' } } }, {});
  const none = async () => assert.fail('no API blame for Bitbucket Cloud or Azure DevOps');
  const cloudClients = { gitlab: gitlabClient(cloud.gitlab, none), azure: azureClient(cloud.azure, none), bitbucket: bitbucketClient(cloud.bitbucket, none) };
  const rest = ['https://bitbucket.org/acme/api.git', 'https://dev.azure.com/acme/P/_git/api'].map((url) => ({ finding: {}, location: { path: 'a.js', line: 1 }, version: {}, repo: parseRepoUrl(url) }));
  await blameFindings(rest, { gh: null, apiUrl: 'https://api.github.com', cacheDir: os.tmpdir(), useLocal: false, scm: { configs: cloud, clients: cloudClients } });
  assert.deepEqual(rest.map((i) => i.provider), ['bitbucket', 'azure']);
  assert.ok(rest.every((i) => /local git blame is switched off/.test(i.problem)));
  assert.equal(commitUrl('azure', rest[1].repo, 'abc', cloud), 'https://dev.azure.com/acme/P/_git/api/commit/abc');
});

/** A fake GitLab: GraphQL users (with or without commitEmail), /users, commits. */
function fakeGitlab(users, { commitEmailField = true } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push(u.pathname);
    if (u.pathname === '/api/graphql') {
      const { query, variables } = JSON.parse(init.body);
      if (!commitEmailField && query.includes('commitEmail')) return json(200, { errors: [{ message: "Field 'commitEmail' doesn't exist on type 'UserCore'" }] });
      const nodes = variables.names.filter((n) => users[n]).map((n) => ({ username: n, name: users[n].name, publicEmail: users[n].public ?? '', ...(commitEmailField ? { commitEmail: users[n].commit ?? null } : {}) }));
      return json(200, { data: { users: { nodes } } });
    }
    if (u.pathname === '/api/v4/users') {
      const name = u.searchParams.get('username');
      return json(200, users[name] ? [{ username: name, name: users[name].name, public_email: users[name].public ?? '' }] : []);
    }
    const m = /^\/api\/v4\/projects\/(.+)\/repository\/commits$/.exec(u.pathname);
    if (m) {
      const author = u.searchParams.get('author');
      const user = Object.values(users).find((x) => x.name === author);
      return json(200, user?.commitsAs ? [{ author_name: author, author_email: user.commitsAs }, { author_name: author, author_email: user.commitsAs }] : []);
    }
    return json(404, { message: '404 Not found' });
  };
  return { client: gitlabClient({ apiUrl: 'https://gitlab.test/api/v4', token: 't' }, fetchImpl), calls };
}

test('GitLab: GraphQL resolves 100 users per request (older GitLab without commit email too); profile and commits find the rest', async () => {
  const users = {};
  for (let i = 0; i < 250; i += 1) users[`dev${i}`] = { name: `Dev ${i}`, public: i % 5 === 0 ? `dev${i}@acme.io` : '', commit: i % 2 === 0 ? `dev${i}@corp.io` : '' };
  users['jane.doe'] = { name: 'Jane Doe', commitsAs: 'jane.doe@acme.io' };
  const { client, calls } = fakeGitlab(users);
  const cfg = { projects: ['team/api'] };
  const methods = Object.fromEntries(gitlabMethods(client, cfg, {}).map((m) => [m.id, m]));
  const graphql = await methods.graphql.run(Object.keys(users));
  assert.equal(calls.filter((c) => c === '/api/graphql').length, 3, '251 usernames → 3 requests');
  assert.equal(graphql.results.dev0.email, 'dev0@acme.io', 'the public email');
  assert.equal(graphql.results.dev2.email, 'dev2@corp.io', 'else the commit email');
  assert.equal(graphql.results.dev1, undefined);
  const commits = await methods.commits.run(['jane.doe']);
  assert.equal(commits.results['jane.doe'].email, 'jane.doe@acme.io');
  assert.equal(commits.results['jane.doe'].confidence, 'high');

  const older = fakeGitlab({ amy: { name: 'Amy', public: 'amy@acme.io' } }, { commitEmailField: false });
  const again = await gitlabMethods(older.client, cfg, {}).find((m) => m.id === 'graphql').run(['amy']);
  assert.equal(again.results.amy.email, 'amy@acme.io');
  assert.equal(older.calls.length, 2, 'asked once more without commitEmail');
  assert.ok(gitlabMethods(older.client, {}, {}).find((m) => m.id === 'commits').skip, 'commits need projects named');
});

test('Azure DevOps: the organisation directory resolves everyone in a few requests; identity search and commits one by one', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    calls.push(`${u.host}${u.pathname}`);
    if (u.pathname === '/acme/_apis/graph/users') {
      const page = u.searchParams.get('continuationToken') ? 2 : 1;
      const value = page === 1
        ? [{ principalName: 'jane.doe@acme.onmicrosoft.com', mailAddress: 'jane.doe@acme.io', displayName: 'Jane Doe' }, { principalName: 'sam@acme.io', mailAddress: '', displayName: 'Sam Lee' }]
        : [{ principalName: 'bob.k@acme.io', mailAddress: 'bob.k@acme.io', displayName: 'Bob Kay' }];
      return json(200, { value }, page === 1 ? { 'x-ms-continuationtoken': 'next' } : {});
    }
    if (u.pathname === '/acme/_apis/identities') return json(200, { value: u.searchParams.get('filterValue') === 'Ann' ? [{ providerDisplayName: 'Ann', properties: { Mail: { $value: 'ann@acme.io' } } }] : [] });
    if (/\/_apis\/git\/repositories\/api\/commits$/.test(u.pathname)) return json(200, { value: u.searchParams.get('searchCriteria.author') === 'zed' ? [{ author: { name: 'Zed', email: 'zed@acme.io' } }, { author: { name: 'Zed', email: 'zed@acme.io' } }] : [] });
    return json(404, {});
  };
  const cfg = { orgUrl: 'https://dev.azure.com/acme', token: 'pat', repos: ['Payments/api'] };
  const client = azureClient(cfg, fetchImpl);
  const methods = Object.fromEntries(azureMethods(client, cfg, {}).map((m) => [m.id, m]));
  const graph = await methods.graph.run(['jane.doe', 'Jane Doe', 'bob.k@acme.io', 'samlee', 'bkay', 'nobody']);
  assert.equal(calls.filter((c) => c.endsWith('/graph/users')).length, 2, 'two pages for the whole organisation');
  assert.equal(graph.results['jane.doe'].email, 'jane.doe@acme.io', 'the sign-in name');
  assert.equal(graph.results['Jane Doe'].email, 'jane.doe@acme.io', 'the display name');
  assert.equal(graph.results['bob.k@acme.io'].email, 'bob.k@acme.io');
  assert.equal(graph.results.samlee.email, 'sam@acme.io', 'name form, medium');
  assert.equal(graph.results.samlee.confidence, 'medium');
  assert.equal(graph.results.nobody, undefined);
  assert.ok(calls.every((c) => c.startsWith('vssps.dev.azure.com') || c.startsWith('dev.azure.com')), 'only the organisation and its directory');
  assert.equal((await methods.identities.run(['Ann', 'Ghost'])).results.Ann.email, 'ann@acme.io');
  assert.equal((await methods.commits.run(['zed'])).results.zed.email, 'zed@acme.io');
  assert.ok(azureMethods(azureClient({ orgUrl: 'https://tfs.acme.io/tfs/Default' }, fetchImpl), { orgUrl: 'https://tfs.acme.io/tfs/Default' }, {}).find((m) => m.id === 'graph').skip, 'no token: skipped with a reason');
});

test('Bitbucket Cloud: commits tie each user to the address in the author line; members join local history', async () => {
  const dir = gitRepo([['Kim Park', 'kim.park@acme.io']]);
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/2.0/repositories/acme/api/commits') {
      if (u.searchParams.get('page') === '2') return json(200, { values: [{ author: { raw: 'Lee Chan <lee@acme.io>', user: { nickname: 'lchan', display_name: 'Lee Chan', account_id: '7:2' } } }] });
      return json(200, {
        values: [
          { author: { raw: 'Jane Doe <jane@acme.io>', user: { nickname: 'jdoe', display_name: 'Jane Doe', account_id: '7:1' } } },
          { author: { raw: 'ci <noreply@acme.io>' } },
        ],
        next: 'https://api.bitbucket.org/2.0/repositories/acme/api/commits?page=2',
      });
    }
    if (u.pathname === '/2.0/workspaces/acme/members') return json(200, { values: [{ user: { nickname: 'kpark', display_name: 'Kim Park' } }] });
    return json(404, {});
  };
  const cfg = { kind: 'cloud', apiUrl: 'https://api.bitbucket.org/2.0', token: 't', workspace: 'acme', repos: ['acme/api'] };
  const client = bitbucketClient(cfg, fetchImpl);
  const methods = Object.fromEntries(bitbucketMethods(client, cfg, { localSources: [dir] }).map((m) => [m.id, m]));
  const commits = await methods.commits.run(['jdoe', '7:2', 'nobody']);
  assert.equal(commits.results.jdoe.email, 'jane@acme.io');
  assert.equal(commits.results['7:2'].email, 'lee@acme.io', 'the account id, from the next page');
  assert.equal(client.totalRequests, 2);
  const members = await methods.members.run(['kpark']);
  assert.equal(members.results.kpark.email, 'kim.park@acme.io');
  assert.deepEqual(parseRaw('Jane Doe <Jane@Acme.io>'), { name: 'Jane Doe', email: 'jane@acme.io' });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Bitbucket Data Center: the user directory (1000 a request) and user search', async () => {
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname === '/rest/api/1.0/users' && !u.searchParams.get('filter')) {
      return json(200, Number(u.searchParams.get('start')) ? { values: [{ name: 'zed', emailAddress: 'zed@acme.io', displayName: 'Zed' }], isLastPage: true } : { values: [{ name: 'jdoe', slug: 'jdoe', emailAddress: 'jane@acme.io', displayName: 'Jane Doe' }], isLastPage: false, nextPageStart: 1000 });
    }
    if (u.pathname === '/rest/api/1.0/users') return json(200, { values: u.searchParams.get('filter') === 'amy' ? [{ name: 'amy', emailAddress: 'amy@acme.io' }] : [] });
    return json(404, {});
  };
  const cfg = { kind: 'server', apiUrl: 'https://bitbucket.acme.io', token: 't', repos: [] };
  const client = bitbucketClient(cfg, fetchImpl);
  const methods = Object.fromEntries(bitbucketMethods(client, cfg, {}).map((m) => [m.id, m]));
  const directory = await methods.directory.run(['jdoe', 'zed', 'janedoe']);
  assert.equal(directory.results.jdoe.email, 'jane@acme.io');
  assert.equal(directory.results.zed.email, 'zed@acme.io');
  assert.equal(directory.results.janedoe.confidence, 'medium');
  assert.equal(client.totalRequests, 2);
  assert.equal((await methods.users.run(['amy'])).results.amy.email, 'amy@acme.io');
  assert.ok(methods.commits.skip, 'commits need repositories named');
});

test('the comparison reports coverage and cost per method; resolving runs the cheapest first and stops', async () => {
  let calls = 0;
  const client = { get totalRequests() { return calls; } };
  const methods = [
    { id: 'free', label: 'Free', run: async (logins) => ({ results: Object.fromEntries(logins.filter((l) => l === 'a').map((l) => [l, { email: 'a@acme.io', confidence: 'high', evidence: 'x' }])) }) },
    { id: 'paid', label: 'Paid', run: async (logins) => { calls += logins.length; return { results: Object.fromEntries(logins.map((l) => [l, { email: `${l}@acme.io`, confidence: 'medium', evidence: 'y' }])) }; } },
    { id: 'off', label: 'Off', skip: 'Needs a token.', run: async () => assert.fail('skipped methods never run') },
  ];
  const report = await evaluateMethods({ methods, logins: ['a', 'b'], client });
  assert.equal(report.methods.free.requests, 0);
  assert.equal(report.methods.paid.requests, 2);
  assert.equal(report.methods.off.skipped, 'Needs a token.');
  assert.equal(report.combined.a.method, 'free', 'high beats medium');
  assert.equal(report.resolved, 2);
  assert.ok(report.recommendation.some((l) => /Cheapest per match: Free/.test(l)));
  calls = 0;
  const found = await resolveWith(methods, ['a', 'b']);
  assert.equal(found.a.method, 'free');
  assert.equal(found.b.method, 'paid');
  assert.equal(calls, 1, 'the paid method only saw what was left');
});

test('directory matching never guesses between two people; usernames are checked per host', () => {
  const match = directoryMatcher([
    { keys: ['sam'], name: 'Sam Lee', email: 'sam.lee@acme.io', evidence: 'd' },
    { keys: ['slee2'], name: 'Sam Lee', email: 'sam.lee@other.io', evidence: 'd' },
  ]);
  assert.equal(match('sam').email, 'sam.lee@acme.io', 'an exact key is fine');
  assert.equal(match('samlee'), null, 'the name is shared by two addresses: left out');
  assert.ok(validUsername('gitlab', 'jane.doe_2'));
  assert.ok(!validUsername('github', 'jane.doe_2'));
  assert.ok(validUsername('azure', 'Jane Doe'));
});
