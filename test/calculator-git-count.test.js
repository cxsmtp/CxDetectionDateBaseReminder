// Cx Credits Calculator, Fusion — new customer, Count from git (src/fusion-git.js), with cloc-fusion's engine
// (src/cloc-fusion/): repositories discovered across organizations, then measured with git or with the platform's
// API: code lines the way cloc counts them, commits on the default branch and so the change frequency, developers
// in the last 90 days. Only from hosts that may be called, with the token sent to its own host as a header and
// nowhere else, names and emails never kept, and the temporary folder gone whatever happens. Repositories are real
// ones, served over git's own HTTP protocol on this computer, with a GitHub-like API and download host
// (test/fake-git-host.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { clocLines, parseCloc } from '../public/calculator/model.js';
import { cleanActivity, cleanFusionNew, cleanGitFrom, migrate, patchProfile, newProfile } from '../public/calculator/profiles.js';
import { GIT_COUNT_LIMITS, cleanRepositories, createGitCounter, gitEnv, gitSource, guardedFetch, listOrganizations, listRepositories, measureRepository, redact, repoAddress, resolvePin, sweepLeftovers } from '../src/fusion-git.js';
import { countText } from '../src/cloc-fusion/loc.js';
import { isExcludedPath, languageOf } from '../src/cloc-fusion/languages.js';
import { commitsEvery, makeRepo, startGitHost } from './fake-git-host.js';

const TOKEN = `ghp_${'a1B2'.repeat(9)}`;
const OTHER = `glpat-${'z9Y8'.repeat(5)}`;
const DAY = 86_400_000;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-count-repos-'));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'git-count-tmp-'));
const leftovers = () => fs.readdirSync(tmpRoot).filter((n) => n.startsWith('mz-git-count-'));
let host;

const FILES = {
  'src/Main.java': '// a comment\npackage x;\n\n/* block\n   comment */\nclass Main {\n  String u = "http://acme.io/*";\n  int x = 1; // trailing\n}\n',
  'web/app.ts': '/** doc */\nexport const b = 2;\nconst c = "//not a comment";\n',
  'tools/run.py': '"""Module doc\nover two lines\n"""\nimport os  # why\n\nprint("# not a comment")\n',
  'README.md': '# Title\n\nSome words.\n',
  'config.yml': '# settings\nname: x\n',
  'copy/Main.java': '// a comment\npackage x;\n\n/* block\n   comment */\nclass Main {\n  String u = "http://acme.io/*";\n  int x = 1; // trailing\n}\n',
  'node_modules/dep/index.js': 'x();\n'.repeat(50),
  'fake.js': Buffer.from([0x63, 0x6f, 0, 0x6e, 0x0a]),
  'big.js': 'x();\n'.repeat(300_000),
  'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]),
};
// Two people a week on claims-portal (and a bot), one a month on broker-api; one of them works on both.
const BUSY = [...commitsEvery(80, 2, ['ana@globex.io', 'raj@globex.io']), { at: Date.now() - 3 * DAY, email: '49699333+dependabot[bot]@users.noreply.github.com', name: 'dependabot[bot]' }];
const MONTHLY = commitsEvery(10, 30, ['raj@globex.io']);

test.before(async () => {
  makeRepo(root, 'globex', 'claims-portal', FILES, { history: BUSY });
  makeRepo(root, 'globex', 'old-site', { 'index.html': '<!-- c -->\n<p>x</p>\n' });
  makeRepo(root, 'globex', 'fork-of-x', { 'a.rb': 'puts 1\n' });
  makeRepo(root, 'globex', 'broker-api', { 'main.go': 'package main\n// c\nfunc main() {}\n' }, { branch: 'develop', history: MONTHLY });
  makeRepo(root, 'initech', 'ledger', { 'Ledger.cs': 'class L {}\n' }, { at: Date.now() - 500 * DAY, history: [{ at: Date.now() - 600 * DAY }] });
  makeRepo(root, 'me', 'dotfiles', { 'setup.sh': 'echo hi\n' });
  host = await startGitHost(root, { tokens: [TOKEN] });
});
test.after(() => host?.close());

test('lines are counted with cloc-fusion\'s engine, as cloc counts them: by language, without blank lines or comments', () => {
  assert.deepEqual(countText(FILES['src/Main.java'], languageOf('a/Main.java')), { code: 5, comment: 3, blank: 1 }, 'a comment marker inside a string is not one');
  assert.deepEqual(countText(FILES['web/app.ts'], languageOf('app.ts')), { code: 2, comment: 1, blank: 0 });
  assert.deepEqual(countText(FILES['tools/run.py'], languageOf('run.py')), { code: 2, comment: 3, blank: 1 }, 'docstrings and # are comments');
  assert.deepEqual(countText('-- c\nSELECT 1; /* x */\n/* a\nb */\n', languageOf('q.sql')), { code: 1, comment: 3, blank: 0 });
  assert.deepEqual(countText('a\r\n\r\n// b\r\n', languageOf('a.cs')), { code: 1, comment: 1, blank: 1 }, 'Windows line ends');
  for (const [file, lang] of [['a/B.java', 'Java'], ['x.tsx', 'TypeScript'], ['a.cs', 'C#'], ['Dockerfile', 'Dockerfile'], ['main.tf', 'Terraform'], ['a.json', 'JSON'], ['a.yaml', 'YAML'], ['a.md', 'Markdown'], ['a.html', 'HTML'], ['a.xml', 'XML']]) assert.equal(languageOf(file)?.name, lang, file);
  assert.equal(languageOf('LICENSE'), null);
  assert.equal(languageOf('a.constructor'), null, 'never an object\'s own keys');
  assert.equal(isExcludedPath('web/node_modules/x/a.js'), true, 'dependencies are not the customer\'s code');
  assert.equal(isExcludedPath('dist/app.min.js'), true);
  assert.equal(isExcludedPath('src/app.js'), false);
});

test('addresses: https (http only to this computer), never a link-local or metadata address, never a password', () => {
  assert.deepEqual(repoAddress('https://acme@dev.azure.com/acme/Payments/_git/payments-api'), { url: 'https://dev.azure.com/acme/Payments/_git/payments-api', host: 'dev.azure.com', hostname: 'dev.azure.com', path: 'acme/Payments/_git/payments-api', name: 'payments-api', origin: 'https://dev.azure.com' }, 'a user name a host puts in its own address is dropped');
  assert.equal(repoAddress('https://github.com/globex/claims-portal.git').name, 'claims-portal');
  assert.throws(() => repoAddress(`https://x:${TOKEN}@github.com/a/b`), (error) => /must not carry a password/.test(error.message) && !error.message.includes(TOKEN));
  for (const bad of ['https://169.254.169.254/a/b', 'https://metadata.google.internal/a/b', 'https://[fe80::1]/a/b', 'https://[::ffff:169.254.169.254]/a/b', 'https://100.100.100.200/a/b']) assert.throws(() => repoAddress(bad), /link-local or cloud metadata/, bad);
  assert.throws(() => repoAddress('http://git.acme.io/a/b'), /https/);
  assert.throws(() => repoAddress('git@github.com:a/b.git'), /https address/);
  assert.throws(() => repoAddress('https://github.com/a/../b'), /Not a repository address/);
  assert.throws(() => gitSource({ provider: 'gitlab', address: 'https://169.254.169.254', token: TOKEN }), /link-local or cloud metadata/);
  assert.throws(() => gitSource({ provider: 'github', token: `${TOKEN}\r\nX-Evil: 1` }), /characters a token does not have/, 'nothing can be slipped into a header');
  assert.throws(() => gitSource({ provider: 'svn', token: TOKEN }), /Choose the git host/);
  assert.throws(() => cleanRepositories(Array.from({ length: 1001 }, (_, i) => `https://github.com/a/r${i}`)), /At most 1000 repositories a run/);
  assert.equal(cleanRepositories(['https://github.com/a/b', 'https://github.com/a/b', { url: 'https://github.com/a/c', branch: '--upload-pack=x' }]).length, 2, 'each once');
  const [cleaned] = cleanRepositories([{ url: 'https://github.com/a/c', branch: '--upload-pack=x', fullName: '../../user', id: 'x\ny', org: 'a' }]);
  assert.deepEqual([cleaned.branch, cleaned.fullName, cleaned.id, cleaned.org], ['', '', '', 'a'], 'a branch is never read as an option, nor a name as a path elsewhere');
});

test('a token goes only to its own host, as a header scoped to that origin: an Azure DevOps token only to its own organisations', () => {
  const gh = gitSource({ provider: 'github', token: TOKEN });
  assert.deepEqual([gh.apiUrl, gh.gitHost, gh.engine.provider], ['https://api.github.com', 'github.com', 'github']);
  assert.match(gh.authFor(repoAddress('https://github.com/globex/a')), /^Basic /);
  assert.equal(gh.authFor(repoAddress('https://gitlab.com/globex/a')), '', 'another host gets nothing');
  const gl = gitSource({ provider: 'gitlab', address: 'https://gitlab.acme.io', token: OTHER });
  assert.deepEqual([gl.engine.apiUrl, gl.gitHost], ['https://gitlab.acme.io/api/v4', 'gitlab.acme.io']);
  const az = gitSource({ provider: 'azure', address: 'acme', token: TOKEN });
  assert.deepEqual([az.engine.apiUrl, az.engine.defaultOrg], ['https://dev.azure.com', 'acme']);
  assert.match(az.authFor(repoAddress('https://dev.azure.com/acme/P/_git/r')), /^Basic /);
  assert.equal(az.authFor(repoAddress('https://dev.azure.com/other/P/_git/r')), '', 'not another organisation on the same host');
  az.addOrganizations(['other']);
  assert.match(az.authFor(repoAddress('https://dev.azure.com/other/P/_git/r')), /^Basic /, 'one its own account listed (Everything this token can see)');
  const tfs = gitSource({ provider: 'azure', address: 'https://tfs.acme.io/tfs/DefaultCollection', token: TOKEN });
  assert.deepEqual([tfs.engine.apiUrl, tfs.engine.defaultOrg], ['https://tfs.acme.io/tfs', 'DefaultCollection']);
  const bb = gitSource({ provider: 'bitbucket', token: TOKEN });
  assert.deepEqual([bb.engine.apiUrl, bb.gitHost, bb.engine.method], ['https://api.bitbucket.org/2.0', 'bitbucket.org', 'access-token']);
  assert.equal(gitSource({ provider: 'bitbucket', address: 'https://bitbucket.acme.io', token: TOKEN }).engine.provider, 'bitbucket-server');
  assert.equal(redact(`fatal: ${TOKEN} and https://u:p@h/x`, gh.secrets), 'fatal: [hidden] and https://h/x');
  // git gets the header through its environment, for the repository's origin only, with no helper, prompt or redirect.
  const env = gitEnv('Basic abc', { origin: 'https://github.com', pin: 'github.com:443:140.82.112.3' });
  const config = Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
  assert.deepEqual(config, { 'credential.helper': '', 'http.followRedirects': 'false', 'core.askPass': '', 'http.https://github.com/.extraHeader': 'Authorization: Basic abc', 'http.curloptResolve': 'github.com:443:140.82.112.3' });
  assert.equal(env.GIT_ALLOW_PROTOCOL, 'https');
});

test('the API engine calls only hosts allowed, over https (http only to this computer), never a link-local or metadata address', async () => {
  const fetchIt = guardedFetch({ allowHost: (h) => h === '127.0.0.1' || h === 'api.github.com' });
  for (const [url, why] of [['https://169.254.169.254/latest', /link-local or cloud metadata/], ['http://api.github.com/user', /https/], ['https://evil.example/user', /not a host this server calls/]]) {
    await assert.rejects(fetchIt(url), (error) => why.test(error.message), url);
  }
  const res = await fetchIt(`${host.url}/api/v3/user`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.deepEqual(await res.json(), { login: 'me' });
});

test('discovery: every organization the token lists, its own repositories and everything it can see, each once, the token as a header only', async () => {
  const source = gitSource({ provider: 'github', address: host.url, token: TOKEN });
  const orgs = await listOrganizations(source);
  assert.equal(orgs.who, 'me');
  assert.deepEqual(orgs.organizations.map((o) => o.id), ['@me', 'globex', 'initech']);
  const one = await listRepositories(source, { orgs: ['globex'] });
  assert.deepEqual(one.repositories.map((r) => [r.path, r.org, r.branch, r.archived, r.fork]), [['globex/broker-api', 'globex', 'develop', false, false], ['globex/claims-portal', 'globex', 'main', false, false], ['globex/fork-of-x', 'globex', 'main', false, true], ['globex/old-site', 'globex', 'main', true, false]]);
  assert.ok(one.repositories.every((r) => r.url.startsWith(`${host.url}/globex/`) && !r.url.includes('@') && r.source === 'token' && r.id && r.fullName), 'clone addresses without credentials, and what the API engine needs');
  assert.equal(one.repositories[0].sizeBytes, 12 * 1024);
  const two = await listRepositories(source, { orgs: ['globex', 'initech', 'nowhere'] });
  assert.equal(two.repositories.length, 5);
  assert.deepEqual(two.problems.map((p) => p.org), ['nowhere'], 'an organization it cannot read is said, the others still listed');
  const all = await listRepositories(source, { everything: true });
  assert.deepEqual(all.repositories.map((r) => r.path), ['globex/broker-api', 'globex/claims-portal', 'globex/fork-of-x', 'globex/old-site', 'initech/ledger', 'me/dotfiles'], 'every organization and every other repository it can reach, each once');
  assert.ok(host.seen.filter((s) => s.path.startsWith('/api/')).every((s) => s.authorization === `Bearer ${TOKEN}`));
  assert.ok(!host.seen.some((s) => s.query.includes(TOKEN)), 'never in an address');
  await assert.rejects(listRepositories(gitSource({ provider: 'github', address: host.url, token: OTHER }), 'globex'), (error) => /refused the token/.test(error.message) && !error.message.includes(OTHER));
  await assert.rejects(listRepositories(source, { orgs: ['../x'] }), /characters a name does not have/);
});

test('one repository with git: back to a year ago, blob-less, its commits, change frequency and developers, and the folder deleted at once', async () => {
  const source = gitSource({ provider: 'github', address: host.url, token: TOKEN });
  const steps = [];
  const seenBefore = host.seen.length;
  const m = await measureRepository({ url: `${host.url}/globex/claims-portal.git`, createdAt: new Date(Date.now() - 800 * DAY).toISOString() }, { source, engine: 'git', tmpRoot, onProgress: (p) => steps.push(p.state) });
  assert.deepEqual([m.name, m.branch, m.engine], ['claims-portal', 'main', 'git']);
  assert.match(m.commit, /^[0-9a-f]{7}$/);
  assert.deepEqual(m.languages.Java, { category: 'code', files: 2, code: 10 }, 'each file, as cloc-fusion counts them (a copy too)');
  assert.equal(m.languages.JavaScript, undefined, 'binary, over 1 MB, or a dependency: not counted');
  assert.equal(m.languages.Markdown.category, 'docs');
  assert.equal(m.lines, 10 + 2 + 2, 'code, markup and IaC: Java, TypeScript and Python (YAML and Markdown are kept by language, for the page to count or leave out)');
  assert.equal(m.commits, 82, '80 by people, 1 by a bot and the files\' own, merges left out');
  assert.equal(m.frequency, '1-5-week', 'a commit every 2 days, over the 160 days it has existed');
  assert.equal(m.devs90, 3, 'ana, raj and the files\' author: the bot is not a developer');
  assert.equal(m.people.length, 3, 'keys to count each person once across a run (never shown or kept)');
  assert.deepEqual([...new Set(steps)], ['clone', 'history', 'files', 'counting']);
  assert.deepEqual(leftovers(), [], 'nothing of the code is kept');
  const gitCalls = host.seen.slice(seenBefore);
  assert.ok(gitCalls.length > 0 && gitCalls.every((s) => s.authorization === `Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`), 'the token went as a header');
  // The same shape as cloc results: the page reads it the same way.
  const langs = Object.fromEntries(Object.entries(m.languages).map(([l, v]) => [l, v.code]));
  assert.equal(clocLines({ langs }), m.lines);
  assert.deepEqual(parseCloc(JSON.stringify(Object.fromEntries(Object.entries(m.languages).map(([l, v]) => [l, { nFiles: v.files, code: v.code }]))), 'claims-portal.json')[0].langs, langs);
  const develop = await measureRepository({ url: `${host.url}/globex/broker-api` }, { source, engine: 'git', tmpRoot });
  assert.equal(develop.branch, 'develop', 'its default branch, whatever it is called');
  assert.equal(develop.commits, 11);
  assert.equal(develop.frequency, 'month');
  const quiet = await measureRepository({ url: `${host.url}/initech/ledger` }, { source, engine: 'git', tmpRoot });
  assert.deepEqual([quiet.commits, quiet.frequency, quiet.lines, quiet.devs90], [0, 'rare', 1, 0], 'no commit in the window: its latest commit only, still counted');
  assert.match(quiet.lastCommitAt, /^\d{4}-/);
});

test('the API engine: the branch\'s archive from the download host (which never gets the token) and the commit list, the same figures as git', async () => {
  const source = gitSource({ provider: 'github', address: host.url, token: TOKEN });
  const { repositories } = await listRepositories(source, { orgs: ['globex'] });
  const claims = repositories.find((r) => r.path === 'globex/claims-portal');
  const before = host.downloads.length;
  const viaApi = await measureRepository(claims, { source, engine: 'api', tmpRoot });
  const viaGit = await measureRepository(claims, { source, engine: 'git', tmpRoot });
  assert.equal(viaApi.engine, 'api');
  assert.deepEqual(viaApi.languages, viaGit.languages, 'the same lines by language');
  assert.equal(viaApi.commits, viaGit.commits);
  assert.equal(viaApi.devs90, viaGit.devs90);
  assert.equal(host.downloads.length, before + 1);
  assert.ok(host.downloads.every((d) => d.authorization === ''), 'the download host never gets the token');
  assert.deepEqual(leftovers(), []);
  // Pasted (nothing known but the address): always cloned.
  assert.equal((await measureRepository({ url: claims.url }, { source, engine: 'api', tmpRoot })).engine, 'git');
});

test('git connects to the addresses checked, not to a second look-up of the name', async () => {
  assert.equal(resolvePin(repoAddress('https://git.example.com/acme/app'), ['203.0.113.7', '2001:db8::7']), 'git.example.com:443:203.0.113.7,[2001:db8::7]');
  assert.equal(resolvePin(repoAddress('http://localhost:8123/acme/app'), ['127.0.0.1']), 'localhost:8123:127.0.0.1');
  assert.equal(resolvePin(repoAddress('https://203.0.113.7/acme/app'), []), '', 'an address typed as such is already the one called');
  const named = host.url.replace('127.0.0.1', 'localhost');
  const counted = await measureRepository({ url: `${named}/globex/old-site` }, { source: gitSource({ provider: 'github', address: named, token: TOKEN }), engine: 'git', tmpRoot });
  assert.equal(counted.name, 'old-site', 'a name still counts, through the pinned address');
});

test('the test host serves plain names only', async () => {
  for (const bad of ['/..%2Fx/info/refs', '/%E0%A4%A', '/api/v3/orgs/..%2Foutside/repos']) assert.equal((await fetch(host.url + bad)).status, 400, bad);
  assert.equal((await fetch(`${host.url}/api/v3/orgs/globex/repos`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200, 'and still answers');
});

test('a refused token, a missing repository, a host not allowed, too big or too slow: said, the token never in it, and the folder gone', async () => {
  const wrong = gitSource({ provider: 'github', address: host.url, token: OTHER });
  await assert.rejects(measureRepository({ url: `${host.url}/globex/claims-portal` }, { source: wrong, tmpRoot }), (error) => /refused: check the token/.test(error.message) && !error.message.includes(OTHER));
  await assert.rejects(measureRepository({ url: `${host.url}/globex/claims-portal`, fullName: 'globex/claims-portal', id: '1', branch: 'main' }, { source: wrong, engine: 'api', tmpRoot }), (error) => /refused: check the token/.test(error.message) && !error.message.includes(OTHER), 'the API engine says the same');
  const source = gitSource({ provider: 'github', address: host.url, token: TOKEN });
  await assert.rejects(measureRepository({ url: `${host.url}/globex/nowhere` }, { source, tmpRoot }), /Not found/);
  await assert.rejects(measureRepository({ url: `${host.url}/globex/claims-portal` }, { source, tmpRoot, allowHost: () => false }), /not counted: connect that host on the Beta page, or add it to SCM_ALLOWED_HOSTS/);
  await assert.rejects(measureRepository({ url: `${host.url}/globex/claims-portal` }, { source, tmpRoot, limits: { ...GIT_COUNT_LIMITS, repoBytes: 10 } }), /Over \d+ GB/);
  const slow = await startGitHost(root, { tokens: [TOKEN], slow: 3000 });
  try {
    await assert.rejects(measureRepository({ url: `${slow.url}/globex/claims-portal` }, { source: gitSource({ provider: 'github', address: slow.url, token: TOKEN }), tmpRoot, limits: { ...GIT_COUNT_LIMITS, timeoutMs: 500 } }), /Took longer than/);
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

test('a run is followed by the one who started it; its view never holds the token nor anyone\'s name or email; developers counted once across it', async () => {
  const counter = createGitCounter({ tmpRoot });
  const source = gitSource({ provider: 'github', address: host.url, token: TOKEN, key: 'token' });
  const { repositories } = await listRepositories(source, { orgs: ['globex'] });
  const picked = repositories.filter((r) => ['globex/claims-portal', 'globex/broker-api'].includes(r.path));
  let job = await counter.start('ana@acme.io', { sources: new Map([['token', source]]), engine: 'git', repositories: [...picked, `${host.url}/globex/nowhere`] });
  assert.equal(job.repositories.length, 3);
  await assert.rejects(counter.start('ana@acme.io', { sources: new Map([['token', source]]), repositories: [`${host.url}/globex/old-site`] }), /already running/);
  assert.throws(() => counter.view('bob@acme.io', job.id), /no longer here/, 'not someone else\'s');
  const end = Date.now() + 60_000;
  let seq = 0;
  const rows = [];
  while (job.state === 'running' && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 100));
    job = counter.view('ana@acme.io', job.id, { after: seq });
    for (const r of job.repositories) rows[r.i] = r;
    seq = job.seq;
  }
  assert.equal(job.state, 'done');
  assert.deepEqual(rows.map((r) => r.state), ['done', 'done', 'failed'], 'only what changed since the last view, put together');
  assert.match(rows[2].error, /Not found/);
  assert.deepEqual([rows[0].path, rows[0].devs90, rows[1].path, rows[1].devs90], ['globex/broker-api', 2, 'globex/claims-portal', 3]);
  assert.equal(job.summary.developers, 3, 'raj works on both: counted once (ana, raj, the files\' author)');
  assert.equal(job.summary.measured, 2);
  const text = JSON.stringify(counter.view('ana@acme.io', job.id));
  assert.ok(!text.includes(TOKEN) && !text.includes(Buffer.from(`x-access-token:${TOKEN}`).toString('base64')), 'no form of the token');
  assert.ok(!/globex\.io|test@acme\.io|dependabot/.test(text), 'no name or email of anyone who committed');
  assert.deepEqual(leftovers(), []);
});

test('a customer keeps where each project came from and how it changes, never a token, a name or an email; customers saved before still open', () => {
  const from = { host: 'x', url: 'https://github.com/globex/claims-portal.git', branch: 'main', commit: '3F2A1C9', countedAt: '2026-10-28T10:00:00Z', connection: 'github-1', token: TOKEN, authorization: `Bearer ${TOKEN}` };
  assert.deepEqual(cleanGitFrom(from), { host: 'github.com', path: 'globex/claims-portal', url: 'https://github.com/globex/claims-portal.git', branch: 'main', commit: '3f2a1c9', countedAt: '2026-10-28T10:00:00.000Z', connection: 'github-1' });
  assert.equal(cleanGitFrom({ url: `https://x-access-token:${TOKEN}@github.com/a/b` }), null, 'an address with credentials is not kept');
  assert.equal(cleanGitFrom({ url: `https://github.com/a/b?token=${TOKEN}` }), null);
  const activity = { commits: 82, windowDays: 365, lastCommitAt: '2026-10-27T10:00:00Z', frequency: 'more-5-week', devs90: 3, engine: 'git', contributors90: [{ email: 'ana@globex.io', name: 'Ana' }], people: ['ana@globex.io'] };
  assert.deepEqual(cleanActivity(activity), { commits: 82, windowDays: 365, lastCommitAt: '2026-10-27T10:00:00.000Z', frequency: 'more-5-week', devs90: 3, engine: 'git' }, 'counts only');
  assert.equal(cleanActivity({ ...activity, frequency: 'hourly' }), null, 'a frequency the calculator does not know is not kept');
  const saved = patchProfile(newProfile({ name: 'Globex' }), { fusionNew: { projects: [{ name: 'claims-portal', langs: { Java: 61240 }, git: from, activity, criticality: 9 }, { name: 'payments-api', file: 'payments-api.json', langs: { Java: 38900 } }] } });
  const [git, cloc] = saved.fusionNew.projects;
  assert.equal(git.git.commit, '3f2a1c9');
  assert.equal(git.activity.devs90, 3);
  assert.equal(git.criticality, null, 'a criticality is 1 to 5');
  assert.equal(cloc.git, undefined, 'a project from cloc has no git');
  assert.equal(cloc.activity, undefined, 'nor how it changes');
  const text = JSON.stringify(saved);
  assert.ok(!text.includes(TOKEN) && !text.includes('ana@globex.io') && !text.includes('"Ana"'));
  // Saved before Count from git measured commits: opens as it was.
  const old = migrate({ ...newProfile({ name: 'Old' }), fusionNew: { projects: [{ id: 'p1', name: 'legacy', file: 'legacy.json', langs: { Go: 100 } }] } });
  assert.deepEqual(cleanFusionNew(old.fusionNew).projects[0], { id: 'p1', name: 'legacy', file: 'legacy.json', criticality: null, langs: { Go: 100 }, locOverride: null, included: true, scansOverride: null, modelOverride: null });
});

test('the page: Count from git across connections and organizations, Import a cloc-fusion report, Upload cloc results, the download; the HTML file on its own cannot reach git', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /name="calc-fnew-way" value="git" checked \/> <span>Count from git<\/span>/);
  assert.match(html, /name="calc-fnew-way" value="report" \/> <span>Import a cloc-fusion report<\/span>/);
  assert.match(html, /name="calc-fnew-way" value="cloc" \/> <span>Upload cloc results<\/span>/);
  assert.match(html, /id="calc-cf-download">Download cloc-fusion<\/button>/);
  assert.match(html, /id="calc-git-orgs-find">Find organizations<\/button>/);
  assert.match(html, /<option value="api">The platform's API: archives, no git<\/option>/);
  // Developers and 10K units sit inside Change frequency and Lines of code, so the table fits a 1440 screen.
  assert.match(html, /<th>Lines of code<\/th><th>Change frequency<\/th><th>Fusion scans<\/th>/);
  assert.match(html, /<input type="password" id="calc-git-secret" spellcheck="false" autocomplete="off" \/>/);
  assert.match(html, /id="calc-git-offline" hidden>This file on its own cannot reach git/);
  const page = fs.readFileSync(new URL('../public/calculator/page.js', import.meta.url), 'utf8');
  assert.match(page, /developers in the last 90 days/);
  assert.match(page, /10K LOC units <b data-cell="units">/);
  assert.match(page, /data-fnew-recount>Count again</);
  assert.match(page, /gitOn = \(\) => !standalone \|\| canGit\(\)/);
  // The file on its own: the steps and how the server measures are hidden, only the note that it cannot is shown.
  assert.match(html, /<p class="calc-notice calc-warn-note calc-git-how" id="calc-git-how">How it is measured/);
  assert.match(page, /\$\('calc-git-offline'\)\.hidden = on;\s+\$\('calc-git-steps'\)\.hidden = !on;[\s\S]{0,120}\$\('calc-git-how'\)\.hidden = !on;/);
  assert.match(html, /<input type="checkbox" id="calc-fusion-new-on" checked \/> New customer <small>· code counted from git, cloc-fusion or cloc<\/small>/);
  // The summary's Fusion "?" explains both customers' parts.
  assert.match(page, /'fusion-credits': \['fusion-credits', 'fusion-new-credits'\]/);
  assert.match(page, /Everything this token can see/);
  assert.match(fs.readFileSync(new URL('../public/calculator/standalone.js', import.meta.url), 'utf8'), /canGit: \(\) => Boolean\(launcher\)/);
});
