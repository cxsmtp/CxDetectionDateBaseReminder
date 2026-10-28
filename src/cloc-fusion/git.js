// Vendored from cloc-fusion 1.3.2 (commit 1a320621d0f5), MIT licence: src/cloc-fusion/LICENSE. Do not edit here: scripts/sync-cloc-fusion.mjs copies it again.
// Everything done with git: a bare, blob-less, shallow clone of each repository's default branch
// (commits and trees of the window only, no file contents), its commit history in the window,
// then the contents of the files worth counting at HEAD, fetched in one go and read with
// `git cat-file --batch`. No working tree is written, so Windows path limits and odd file names
// in a repository never get in the way.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { selectFiles, LocTally } from './loc.js';
import { contributorsOf } from './commits.js';

const DAY = 86400000;

/**
 * The environment for git: no prompts, only the expected transport protocols, and the auth header
 * via GIT_CONFIG_* (never on the command line) scoped to the repository's own origin, so it is
 * never sent to any other host (a redirect, or a submodule) git might contact.
 */
export function gitEnv(authHeader, { origin = null, protocols = 'https', base = process.env } = {}) {
  const env = { ...base, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '', LC_ALL: 'C', GIT_ALLOW_PROTOCOL: protocols };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_PARAMETERS', 'GIT_SSH_COMMAND']) delete env[k];
  // No redirects: git would carry the header to the redirect's host for the rest of the clone.
  const cfg = [['http.followRedirects', 'false']];
  if (authHeader) {
    cfg.push([origin ? `http.${origin}/.extraHeader` : 'http.extraHeader', `Authorization: ${authHeader}`]);
    // A credential helper on this machine must not answer instead of (or as well as) the header.
    cfg.push(['credential.helper', '']);
  }
  env.GIT_CONFIG_COUNT = String(cfg.length);
  cfg.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

/** A branch name git accepts and that cannot be mistaken for an option. */
export function safeBranch(name) {
  if (name === null || name === undefined) return null;
  const b = String(name);
  if (!b || b.startsWith('-') || b.length > 255 || /[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$|\.lock$|\.$/.test(b)) throw new Error(`unsafe branch name ${JSON.stringify(b.slice(0, 80))}`);
  return b;
}

/** Run git; resolves { stdout: Buffer, stderr: string }, rejects with the stderr's gist. */
export function git(args, { cwd, env, input, timeoutMs = 30 * 60000, maxBuffer = 512 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env, windowsHide: true });
    const out = [];
    let size = 0;
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`git ${args[0]} timed out after ${Math.round(timeoutMs / 60000)} min`));
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      size += d.length;
      if (size > maxBuffer) child.kill('SIGKILL');
      else out.push(d);
    });
    child.stderr.on('data', (d) => {
      if (err.length < 20000) err += d;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e.code === 'ENOENT' ? new Error('git is not installed or not on PATH') : e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(Object.assign(new Error(gist(err) || `git ${args[0]} exited with ${code}`), { stderr: err, code }));
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

function gist(stderr) {
  if (/could not read Username|Authentication failed|HTTP Basic: Access denied|returned error: 40[13]|terminal prompts disabled/i.test(stderr)) return 'authentication failed or repository not found: the token was refused, cannot read this repository, or it does not exist';
  if (/repository .* not found|returned error: 404|does not appear to be a git repository/i.test(stderr)) return 'repository not found (or the token cannot see it)';
  const lines = String(stderr)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(Cloning into|remote: (Enumerating|Counting|Compressing|Total)|Receiving|Resolving)/.test(l));
  return (lines.find((l) => /^(fatal|error):/.test(l)) || lines[lines.length - 1] || '').replace(/^(fatal|error):\s*/, '').slice(0, 300);
}

export async function gitVersion() {
  const { stdout } = await git(['--version'], { timeoutMs: 15000 });
  const m = stdout.toString().match(/(\d+)\.(\d+)/);
  return m ? { text: stdout.toString().trim(), major: +m[1], minor: +m[2] } : { text: stdout.toString().trim(), major: 0, minor: 0 };
}

/**
 * Read blobs with one `git cat-file --batch`, calling onBlob(item, Buffer) for each.
 * Streams, so memory stays at one file at a time.
 */
function catFileBatch(dir, env, items, onBlob, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], { cwd: dir, env, windowsHide: true });
    let buf = Buffer.alloc(0);
    let idx = 0;
    let need = null; // bytes of the current blob still to read (+1 for the newline)
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('reading files timed out'));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (need === null) {
          const nl = buf.indexOf(10);
          if (nl < 0) return;
          const header = buf.subarray(0, nl).toString();
          buf = buf.subarray(nl + 1);
          if (/ missing$/.test(header)) {
            idx++;
            continue;
          }
          const size = Number(header.split(' ')[2]);
          need = Number.isFinite(size) ? size : 0;
        }
        if (buf.length < need + 1) return;
        const content = buf.subarray(0, need);
        buf = buf.subarray(need + 1);
        need = null;
        try {
          onBlob(items[idx++], content);
        } catch (e) {
          child.kill('SIGKILL');
          reject(e);
          return;
        }
      }
    });
    child.stderr.on('data', (d) => {
      if (err.length < 5000) err += d;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(gist(err) || `git cat-file exited with ${code}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(items.map((i) => i.oid).join('\n') + '\n');
  });
}

/**
 * Parse `git ls-tree -r -z` output into [{ path, oid }] for regular files. (Not `-l`: sizes would
 * make git fetch every missing file one by one, before the single batch fetch.)
 */
export function parseLsTree(buf) {
  const out = [];
  for (const rec of buf.toString('utf8').split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, oid] = rec.slice(0, tab).trim().split(/\s+/);
    if (type !== 'blob' || mode === '120000') continue;
    out.push({ path: rec.slice(tab + 1), oid, size: 0 });
  }
  return out;
}

/** Commit stats from `git log --format=%ct%x09%ae%x09%an` lines (time, author email, author name). */
export function commitStats(text, { now = Date.now(), weeks = 52 } = {}) {
  const series = new Array(weeks).fill(0);
  const authors = new Set();
  const counted = [];
  let commits = 0;
  let last = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    const [ts, email, name = ''] = line.split('\t');
    const t = Number(ts) * 1000;
    if (!Number.isFinite(t)) continue;
    commits++;
    counted.push({ t, email, name });
    if (email) authors.add(email.toLowerCase());
    if (last === null || t > last) last = t;
    const w = Math.floor((now - t) / (7 * DAY));
    if (w >= 0 && w < weeks) series[weeks - 1 - w]++;
  }
  return { commits, authors: authors.size, lastCommitAt: last ? new Date(last).toISOString() : null, weekly: series, ...contributorsOf(counted, now) };
}

/**
 * Clone and measure one repository. Returns
 * { headSha, branch, commits, authors, windowDays, weekly, lastCommitAt, loc, files, code, comment, blank, languages, mainLanguage }.
 */
export async function analyzeRepo(repo, { workDir, authHeader, allowedHosts = null, allowHttp = false, windowDays = 365, includeMerges = false, exclude = [], include = [], maxFileBytes = 2 * 1024 * 1024, countCategories, locBasis, timeoutMs = 30 * 60000, keep = false, now = Date.now(), onPhase = () => {} }) {
  const id = createHash('sha256').update(`${repo.connection}/${repo.cloneUrl}`).digest('hex').slice(0, 10);
  const dir = join(workDir, `${repo.name.replace(/[^\w.-]+/g, '_').slice(0, 40)}-${id}`);
  let url;
  try {
    url = new URL(repo.cloneUrl);
  } catch {
    throw new Error(`not a clone URL: ${String(repo.cloneUrl).slice(0, 100)}`);
  }
  if (!['https:', 'http:', 'file:'].includes(url.protocol)) throw new Error(`unsupported clone URL scheme ${url.protocol}`);
  if (allowedHosts && !allowedHosts(url.host.toLowerCase())) throw new Error(`refusing to clone from ${url.host}: not a host of this connection`);
  if (authHeader && url.protocol === 'http:' && !allowHttp) throw new Error(`refusing to send credentials over plain http to ${url.host}`);
  const branch = safeBranch(repo.defaultBranch);
  const env = gitEnv(authHeader, { origin: url.protocol === 'file:' ? null : url.origin, protocols: url.protocol === 'file:' ? 'file' : url.protocol === 'http:' ? 'http:https' : 'https' });
  const since = new Date(now - windowDays * DAY).toISOString();
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  await mkdir(workDir, { recursive: true });
  try {
    onPhase('clone');
    const base = ['-c', 'core.longpaths=true', 'clone', '--bare', '--quiet', '--filter=blob:none', '--single-branch', '--no-tags'];
    if (branch) base.push('--branch', branch);
    try {
      await git([...base, `--shallow-since=${since}`, '--', url.href, dir], { env, timeoutMs });
    } catch (err) {
      // No commit in the window (the server refuses an empty shallow clone): take the tip only.
      if (!/no commits selected|shallow|deepen/i.test(err.message)) throw err;
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
      await git([...base, '--depth=1', '--', url.href, dir], { env, timeoutMs });
    }

    let headSha;
    try {
      headSha = (await git(['rev-parse', 'HEAD'], { cwd: dir, env })).stdout.toString().trim();
    } catch {
      return { empty: true, commits: 0, authors: 0, devs90: 0, bots90: 0, contributors90: [], windowDays, weekly: [], loc: 0, files: 0, code: 0, comment: 0, blank: 0, languages: {}, mainLanguage: null };
    }
    const headBranch = (await git(['symbolic-ref', '--short', 'HEAD'], { cwd: dir, env }).catch(() => ({ stdout: Buffer.from(repo.defaultBranch || '') }))).stdout.toString().trim();

    onPhase('history');
    const logArgs = ['log', '--format=%ct%x09%ae%x09%an', `--since=${since}`];
    if (!includeMerges) logArgs.push('--no-merges');
    const log = await git([...logArgs, 'HEAD'], { cwd: dir, env });
    const stats = commitStats(log.stdout.toString(), { now });
    // A repository younger than the window: its age is the window, as in the calculator.
    let effectiveWindow = windowDays;
    if (!existsSync(join(dir, 'shallow'))) {
      const roots = (await git(['log', '--max-parents=0', '--format=%ct', 'HEAD'], { cwd: dir, env })).stdout.toString().split('\n').filter(Boolean).map(Number);
      if (roots.length) effectiveWindow = Math.min(windowDays, Math.max(1, (now - Math.min(...roots) * 1000) / DAY));
    }
    if (repo.createdAt) {
      const age = (now - Date.parse(repo.createdAt)) / DAY;
      if (Number.isFinite(age) && age > 0) effectiveWindow = Math.min(effectiveWindow, Math.max(1, age));
    }
    if (!stats.lastCommitAt) {
      const t = Number((await git(['log', '-1', '--format=%ct', 'HEAD'], { cwd: dir, env })).stdout.toString().trim());
      if (t) stats.lastCommitAt = new Date(t * 1000).toISOString();
    }

    onPhase('files');
    const tree = parseLsTree((await git(['ls-tree', '-r', '-z', 'HEAD'], { cwd: dir, env })).stdout);
    const files = selectFiles(tree, { exclude, include });
    const tally = new LocTally();
    if (files.length) {
      // One fetch for every needed file, rather than one round trip per file on first read.
      const oids = [...new Set(files.map((f) => f.oid))];
      await git(['-c', 'fetch.negotiationAlgorithm=noop', 'fetch', 'origin', '--quiet', '--no-tags', '--no-write-fetch-head', '--recurse-submodules=no', '--filter=blob:none', '--stdin'], { cwd: dir, env, input: oids.join('\n') + '\n', timeoutMs }).catch(() => {});
      onPhase('count');
      await catFileBatch(dir, env, files, (f, content) => {
        if (content.length <= maxFileBytes) tally.add(f.lang, content);
      }, timeoutMs);
    }
    const sum = tally.summary({ countCategories, locBasis });
    return {
      headSha,
      branch: headBranch,
      commits: stats.commits,
      authors: stats.authors,
      devs90: stats.devs90,
      bots90: stats.bots90,
      contributors90: stats.contributors90,
      weekly: stats.weekly,
      lastCommitAt: stats.lastCommitAt,
      windowDays: Math.round(effectiveWindow * 10) / 10,
      treeFiles: tree.length,
      engine: 'git',
      ...sum,
    };
  } finally {
    if (!keep) await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
