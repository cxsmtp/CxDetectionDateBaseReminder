// A git host on this computer for the tests: real repositories served over git's smart HTTP protocol (git
// http-backend), a GitHub-like API that lists them (organizations, the token's own and every repository it can
// reach), their commits and their archives (through a redirect to a second "download" host, like
// codeload.github.com, which must never be sent a token), and a record of every Authorization header each was sent.
// Plain http on 127.0.0.1: the one address the server lets a test double use (src/outbound-url.js).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const DAY = 86_400_000;

/**
 * A bare repository at `root/owner/name.git` holding `files` ({path: text or Buffer}) on `branch`. `history`:
 * commits made before it, [{at (ms), email, name}], each touching a file no counter reads; `at`: when the files'
 * own commit is made (now). Partial clones and fetches by object id are allowed, as on the big hosts.
 */
export function makeRepo(root, owner, name, files, { branch = 'main', history = [], at = Date.now(), email = 'test@acme.io', author = 'Test' } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-git-work-'));
  const run = (args, env = {}) => execFileSync('git', args, { cwd: work, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: email, ...env } });
  const stamp = (ms) => `${Math.floor(ms / 1000)} +0000`;
  run(['init', '--quiet', '-b', branch]);
  [...history].sort((a, b) => a.at - b.at).forEach((c, i) => {
    fs.writeFileSync(path.join(work, '.history'), `${i}\n`);
    run(['add', '-A']);
    run(['commit', '--quiet', '-m', `change ${i}`], { GIT_AUTHOR_NAME: c.name ?? 'Dev', GIT_AUTHOR_EMAIL: c.email ?? 'dev@acme.io', GIT_COMMITTER_NAME: c.name ?? 'Dev', GIT_COMMITTER_EMAIL: c.email ?? 'dev@acme.io', GIT_AUTHOR_DATE: stamp(c.at), GIT_COMMITTER_DATE: stamp(c.at) });
  });
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
    fs.writeFileSync(path.join(work, file), content);
  }
  run(['add', '-A']);
  run(['commit', '--quiet', '--allow-empty', '-m', 'files'], { GIT_AUTHOR_DATE: stamp(at), GIT_COMMITTER_DATE: stamp(at) });
  const bare = path.join(root, owner, `${name}.git`);
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  execFileSync('git', ['clone', '--quiet', '--bare', work, bare], { stdio: 'pipe' });
  for (const [key, value] of [['uploadpack.allowFilter', 'true'], ['uploadpack.allowAnySHA1InWant', 'true'], ['http.receivepack', 'false']]) execFileSync('git', ['-C', bare, 'config', key, value]);
  fs.rmSync(work, { recursive: true, force: true });
  return { bare, commit: execFileSync('git', ['-C', bare, 'rev-parse', 'HEAD']).toString().trim() };
}

/** `n` commits by `people` ([email]), one every `everyDays` days back from now. */
export const commitsEvery = (n, everyDays, people = ['dev@acme.io']) => Array.from({ length: n }, (_, i) => ({ at: Date.now() - (i + 1) * everyDays * DAY, email: people[i % people.length], name: people[i % people.length].split('@')[0] }));

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

/**
 * Serve `root` on 127.0.0.1. `tokens`: the only Authorization the host accepts (Basic x-access-token:… for git,
 * Bearer … for its API); none needed when empty. The API (under /api/v3): /user, /user/orgs, /user/repos,
 * /orgs/:owner/repos, /repos/:owner/:name/commits and /repos/:owner/:name/tarball/:ref (a redirect to the download
 * host). The owner `me` is the token's own account. `slow`: ms to wait before answering git (for a time limit).
 */
export async function startGitHost(root, { tokens = [], slow = 0 } = {}) {
  const seen = [];
  const downloads = [];
  const repoDir = (owner, name) => path.join(root, owner, `${name}.git`);
  const owners = () => (fs.existsSync(root) ? fs.readdirSync(root).filter((o) => fs.statSync(path.join(root, o)).isDirectory()) : []);
  const reposOf = (owner) => (fs.existsSync(path.join(root, owner)) ? fs.readdirSync(path.join(root, owner)).filter((n) => n.endsWith('.git')).map((n) => n.slice(0, -4)) : []);
  let port = 0;
  const describe = (owner, name) => ({
    id: Number.parseInt(execFileSync('git', ['-C', repoDir(owner, name), 'rev-parse', 'HEAD']).toString().slice(0, 7), 16),
    name,
    full_name: `${owner}/${name}`,
    clone_url: `http://user@127.0.0.1:${port}/${owner}/${name}.git`,
    html_url: `http://127.0.0.1:${port}/${owner}/${name}`,
    default_branch: execFileSync('git', ['-C', repoDir(owner, name), 'symbolic-ref', '--short', 'HEAD']).toString().trim(),
    size: 12,
    archived: name.startsWith('old'),
    fork: name.startsWith('fork'),
    created_at: new Date(Date.now() - 800 * DAY).toISOString(),
  });

  // The download host: like codeload.github.com, another origin, which gets no Authorization.
  const codeload = http.createServer((req, res) => {
    downloads.push({ path: req.url, authorization: req.headers.authorization ?? '' });
    const m = /^\/([\w.-]+)\/([\w.-]+)\/([\w./-]+)\.tar\.gz$/.exec(req.url);
    if (!m || !fs.existsSync(repoDir(m[1], m[2]))) {
      res.writeHead(404);
      return res.end();
    }
    const sha = execFileSync('git', ['-C', repoDir(m[1], m[2]), 'rev-parse', m[3]]).toString().trim();
    const tgz = execFileSync('git', ['-C', repoDir(m[1], m[2]), 'archive', '--format=tar.gz', `--prefix=${m[1]}-${m[2]}-${sha.slice(0, 7)}/`, m[3]]);
    res.writeHead(200, { 'Content-Type': 'application/x-gzip' });
    res.end(tgz);
  });
  await new Promise((resolve) => codeload.listen(0, '127.0.0.1', resolve));
  const codeloadUrl = `http://127.0.0.1:${codeload.address().port}`;

  const api = (req, res, url) => {
    const p = url.pathname.slice('/api/v3'.length);
    const page = Number(url.searchParams.get('page') || 1);
    const list = (items) => json(res, 200, page > 1 ? [] : items);
    let m;
    if (p === '/user') return json(res, 200, { login: 'me' });
    if (p === '/user/orgs') return list(owners().filter((o) => o !== 'me').map((login) => ({ login })));
    if (p === '/user/repos') {
      const mine = reposOf('me').map((n) => describe('me', n));
      const all = /organization_member/.test(url.searchParams.get('affiliation') ?? '') ? owners().flatMap((o) => reposOf(o).map((n) => describe(o, n))) : mine;
      return list(all);
    }
    if ((m = /^\/orgs\/([\w.-]+)\/repos$/.exec(p))) {
      if (!fs.existsSync(path.join(root, m[1])) || m[1] === 'me') return json(res, 404, { message: 'Not Found' });
      return list(reposOf(m[1]).map((n) => describe(m[1], n)));
    }
    if ((m = /^\/repos\/([\w.-]+)\/([\w.-]+)\/commits$/.exec(p))) {
      if (!fs.existsSync(repoDir(m[1], m[2]))) return json(res, 404, { message: 'Not Found' });
      const since = url.searchParams.get('since');
      const args = ['-C', repoDir(m[1], m[2]), 'log', '--format=%H%x09%P%x09%ae%x09%an%x09%cI', url.searchParams.get('sha') || 'HEAD'];
      if (since) args.push(`--since=${since}`);
      if (url.searchParams.get('per_page') === '1') args.push('-1');
      const commits = execFileSync('git', args).toString().split('\n').filter(Boolean).map((line) => {
        const [sha, parents, email, name, date] = line.split('\t');
        return { sha, parents: parents.split(' ').filter(Boolean).map((s) => ({ sha: s })), commit: { author: { email, name, date }, committer: { date } } };
      });
      return list(commits);
    }
    if ((m = /^\/repos\/([\w.-]+)\/([\w.-]+)\/tarball\/([\w.%-]+)$/.exec(p))) {
      if (!fs.existsSync(repoDir(m[1], m[2]))) return json(res, 404, { message: 'Not Found' });
      res.writeHead(302, { Location: `${codeloadUrl}/${m[1]}/${m[2]}/${decodeURIComponent(m[3])}.tar.gz` });
      return res.end();
    }
    return json(res, 404, { message: 'Not Found' });
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    // Plain names only: nothing encoded but a branch in an archive's address, no . or .. segments, so no path leaves `root`.
    if (/(^|\/)\.\.?(\/|$)/.test(url.pathname) || (/%/.test(url.pathname) && !/\/tarball\/[\w-]+(%2F[\w-]+)*$/.test(url.pathname))) {
      res.writeHead(400);
      return res.end();
    }
    seen.push({ method: req.method, path: url.pathname, query: url.search, authorization: req.headers.authorization ?? '' });
    const isApi = url.pathname.startsWith('/api/v3/');
    const accepted = tokens.map((token) => (isApi ? `Bearer ${token}` : `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`));
    if (!isApi && slow) await new Promise((resolve) => setTimeout(resolve, slow));
    if (tokens.length && !accepted.includes(req.headers.authorization)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fake"', 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: 'Bad credentials' }));
    }
    if (isApi) return api(req, res, url);
    // git's smart HTTP protocol, answered by git itself (a CGI program).
    const child = spawn('git', ['http-backend'], {
      env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] ?? '', HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '', GIT_PROTOCOL: req.headers['git-protocol'] ?? '', REMOTE_ADDR: '127.0.0.1' },
    });
    req.pipe(child.stdin);
    let head = Buffer.alloc(0);
    let started = false;
    child.stdout.on('data', (chunk) => {
      if (started) return res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      started = true;
      const headers = {};
      let status = 200;
      for (const line of head.subarray(0, end).toString().split('\r\n')) {
        const [name, ...value] = line.split(':');
        if (/^status$/i.test(name)) status = Number(value.join(':').trim().split(' ')[0]);
        else headers[name] = value.join(':').trim();
      }
      res.writeHead(status, headers);
      res.write(head.subarray(end + 4));
    });
    child.on('close', () => res.end());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    codeloadUrl,
    seen,
    downloads,
    close: () => Promise.all([server, codeload].map((s) => new Promise((resolve) => {
      s.close(resolve);
      s.closeAllConnections?.();
    }))),
  };
}
