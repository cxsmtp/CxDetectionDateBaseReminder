// A git host on this computer for the tests: real repositories served over git's smart HTTP protocol (git
// http-backend), a GitHub-like API that lists them, and a record of every Authorization header it was sent.
// Plain http on 127.0.0.1: the one address the server lets a test double use (src/outbound-url.js).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/** A bare repository at `root/owner/name.git` holding `files` ({path: text or Buffer}) in one commit on `branch`. */
export function makeRepo(root, owner, name, files, { branch = 'main' } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-git-work-'));
  const run = (args, cwd = work) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@acme.io', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@acme.io' } });
  run(['init', '--quiet', '-b', branch]);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
    fs.writeFileSync(path.join(work, file), content);
  }
  run(['add', '-A']);
  run(['commit', '--quiet', '-m', 'first']);
  const bare = path.join(root, owner, `${name}.git`);
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  run(['clone', '--quiet', '--bare', work, bare]);
  fs.rmSync(work, { recursive: true, force: true });
  return { bare, commit: execFileSync('git', ['-C', bare, 'rev-parse', 'HEAD']).toString().trim() };
}

/**
 * Serve `root` on 127.0.0.1. `tokens`: the only Authorization the host accepts (Basic x-access-token:… for git,
 * Bearer … for its API); none needed when empty. The API: GET /api/v3/orgs/:owner/repos. `slow`: ms to wait
 * before answering git (for a time limit).
 */
export async function startGitHost(root, { tokens = [], slow = 0 } = {}) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    // Plain names only: nothing encoded, no . or .. segments, so no path leaves `root`.
    if (/%|(^|\/)\.\.?(\/|$)/.test(url.pathname)) {
      res.writeHead(400);
      return res.end();
    }
    seen.push({ method: req.method, path: url.pathname, query: url.search, authorization: req.headers.authorization ?? '' });
    const api = url.pathname.startsWith('/api/v3/');
    const accepted = tokens.map((token) => (api ? `Bearer ${token}` : `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`));
    if (!api && slow) await new Promise((resolve) => setTimeout(resolve, slow));
    if (tokens.length && !accepted.includes(req.headers.authorization)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fake"', 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: 'Bad credentials' }));
    }
    const org = /^\/api\/v3\/orgs\/([\w.-]+)\/repos$/.exec(url.pathname);
    if (org) {
      const dir = path.join(root, org[1]);
      if (!fs.existsSync(dir)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: 'Not Found' }));
      }
      const page = Number(url.searchParams.get('page') || 1);
      const repos = page > 1 ? [] : fs.readdirSync(dir).filter((n) => n.endsWith('.git')).map((n) => ({ full_name: `${org[1]}/${n.slice(0, -4)}`, clone_url: `http://user@127.0.0.1:${server.address().port}/${org[1]}/${n}`, default_branch: 'main', size: 12, archived: n.startsWith('old') }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(repos));
    }
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
  const port = server.address().port;
  return { port, url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}
