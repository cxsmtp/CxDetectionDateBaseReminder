/**
 * Who wrote the vulnerable code: from a Checkmarx One finding to the commit
 * (and author) that last touched its line.
 *
 *   1. Location: the finding's result row gives file and line — the sink node
 *      of a SAST data flow (where the vulnerable call is), or the KICS line.
 *   2. Code version: the scan's commit when Checkmarx One recorded one, else
 *      its branch, else the project's main branch.
 *   3. Blame through the host's API, one request per file whatever the number
 *      of findings in it: GitHub GraphQL, GitLab REST, Bitbucket Data Center
 *      REST. Otherwise `git blame` on a clone, made with that host's own token
 *      (Azure DevOps, Bitbucket Cloud, any host without a token…).
 *   4. Never the wrong person: git blame ignores whitespace-only changes and
 *      code that was only moved, honours the repository's
 *      .git-blame-ignore-revs, and looks past commits made by bots. Each answer
 *      says how sure it is (see confidenceOf); only a sure one is ever emailed
 *      without someone choosing it.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { mapWithConcurrency } from '../cxone/client.js';
import { ensureClone } from './identity.js';
import { apiBlamer, cloneAuthFor, commitUrl, providerOf } from '../scm/providers.js';

const run = promisify(execFile);

/** {host, owner, repo, cloneUrl} from https or ssh repository addresses; null when unrecognised. */
export function parseRepoUrl(url) {
  const value = String(url || '').trim();
  let m = /^https?:\/\/(?:[^@/]+@)?([^/:]+(?::\d+)?)\/(.+?)(?:\.git)?\/?$/i.exec(value);
  if (!m) m = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/i.exec(value);
  if (!m) return null;
  const host = m[1].toLowerCase();
  const parts = m[2].split('/').filter(Boolean);
  if (parts.length < 2) return null;
  // Azure DevOps: org/project/_git/repo
  const gitIndex = parts.indexOf('_git');
  const owner = gitIndex > 0 ? parts.slice(0, gitIndex).join('/') : parts.slice(0, -1).join('/');
  const repo = parts.at(-1);
  return { host, owner, repo, cloneUrl: `https://${host}/${m[2].replace(/\.git$/, '')}${host.includes('dev.azure.com') ? '' : '.git'}` };
}

/** Is this repository on the GitHub the client talks to (github.com or the Enterprise host)? */
export function onGitHub(repo, apiUrl = 'https://api.github.com') {
  if (!repo) return false;
  if (repo.host === 'github.com') return /api\.github\.com/.test(apiUrl);
  try {
    return new URL(apiUrl).host.toLowerCase() === repo.host;
  } catch {
    return false;
  }
}

/** File and line of a result row: the SAST sink, or the KICS line. SCA has no line. */
export function locationOf(row) {
  const data = row?.data ?? {};
  const nodes = Array.isArray(data.nodes) ? data.nodes : [];
  if (nodes.length) {
    const sink = nodes.at(-1);
    const source = nodes[0];
    return {
      path: String(sink.fileName ?? sink.fullName ?? '').replace(/^\/+/, ''),
      line: Number(sink.line) || 0,
      column: Number(sink.column) || 0,
      // What the vulnerable code says there (a call or variable name): checked against the blamed line.
      name: String(sink.name ?? '').slice(0, 200),
      source: source && source !== sink ? { path: String(source.fileName ?? '').replace(/^\/+/, ''), line: Number(source.line) || 0 } : null,
    };
  }
  if (data.filename || data.fileName) {
    return { path: String(data.filename ?? data.fileName).replace(/^\/+/, ''), line: Number(data.line) || 0, column: 0, source: null };
  }
  return null;
}

/** The scan's repository, branch and commit, as far as Checkmarx One recorded them. */
export function codeVersion(scan, project = {}) {
  const git = scan?.metadata?.Handler?.GitHandler ?? scan?.metadata?.handler?.gitHandler ?? {};
  return {
    repoUrl: git.repo_url || git.repoUrl || scan?.repoUrl || project.repoUrl || '',
    commit: git.commit_id || git.commitId || git.commit || scan?.commitId || scan?.commit || '',
    branch: scan?.branch || git.branch || project.mainBranch || '',
  };
}

const BLAME_QUERY = `query($owner: String!, $name: String!, $ref: String!, $path: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: $ref) {
      ... on Commit {
        blame(path: $path) {
          ranges {
            startingLine
            endingLine
            commit { oid authoredDate url messageHeadline author { name email user { login } } }
          }
        }
      }
    }
  }
}`;

/** Blame ranges for one file at one ref, from GitHub GraphQL. */
export async function githubBlameRanges(gh, { owner, repo, ref, path }) {
  const body = await gh.graphql(BLAME_QUERY, { owner, name: repo, ref, path });
  const ranges = body?.data?.repository?.object?.blame?.ranges;
  if (!ranges) return null;
  return ranges.map((r) => ({
    start: r.startingLine,
    end: r.endingLine,
    commit: r.commit.oid,
    date: r.commit.authoredDate,
    url: r.commit.url,
    message: r.commit.messageHeadline,
    authorName: r.commit.author?.name ?? '',
    authorEmail: String(r.commit.author?.email ?? '').toLowerCase(),
    login: r.commit.author?.user?.login ?? '',
  }));
}

/** Parse `git blame --porcelain` output for one line (with the line's own text, `content`). */
export function parsePorcelain(text) {
  const lines = String(text).split('\n');
  const header = /^([0-9a-f]{40})\s/.exec(lines[0] || '');
  if (!header) return null;
  const field = (name) => lines.find((l) => l.startsWith(`${name} `))?.slice(name.length + 1) ?? '';
  return {
    commit: header[1],
    authorName: field('author'),
    authorEmail: field('author-mail').replace(/^<|>$/g, '').toLowerCase(),
    date: field('author-time') ? new Date(Number(field('author-time')) * 1000).toISOString() : '',
    message: field('summary'),
    login: '',
    content: (lines.find((l) => l.startsWith('\t')) ?? '').slice(1),
  };
}

/** Commits made by automation, never by the developer who wrote the code: dependabot, renovate, CI… */
export function isBot(name = '', email = '') {
  const who = `${name} ${email}`.toLowerCase();
  return /\[bot\]|(^|[^a-z])(dependabot|renovate|github-actions|gitlab-bot|snyk-bot|greenkeeper|mergify|pre-commit-ci|azure-pipelines|bitbucket-pipelines)([^a-z]|$)/.test(who) || /^(noreply|no-reply|bot|ci|build)@/.test(String(email).toLowerCase());
}

/** Commits that only reformat code (an API blame cannot skip them; local blame does with -w and ignore-revs). */
export const looksLikeFormatting = (message = '') => /\b(re-?format|prettier|black|gofmt|clang-format|eslint --fix|lint fix|whitespace|indentation|code style)\b/i.test(message);

const safeRef = (r) => Boolean(r) && /^[\w./@{}^~-]+$/.test(r) && !r.startsWith('-');
const HASH = /^[0-9a-f]{40}$/;
const MAX_BOT_SKIPS = 3;

/**
 * `git blame` of one line in a clone at `dir`, the way a careful person would:
 *   - at the scanned commit when it is there (`exact`), else the branch, else HEAD;
 *   - ignoring whitespace-only changes and moved or copied code (-w -M -C);
 *   - skipping the commits listed in the repository's .git-blame-ignore-revs (mass reformatting);
 *   - looking past up to 3 commits made by bots, to the person who wrote the line.
 * `expect`: what the vulnerable code says there (the scan's sink name); `matches` tells
 * whether the blamed line still contains it (null when nothing to compare).
 */
export async function blameInDir(dir, { refs = [], path, line, expect = '', env = process.env }) {
  if (!path || path.startsWith('-') || !(line > 0)) return null;
  const opts = { env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 };
  const candidates = [...new Set([...refs, 'HEAD'].filter(safeRef))];
  for (const [index, ref] of candidates.entries()) {
    const ignore = new Set();
    try {
      const { stdout } = await run('git', ['-C', dir, 'show', `${ref}:.git-blame-ignore-revs`], opts);
      for (const entry of stdout.split('\n')) {
        const hash = entry.trim().split(/\s/)[0];
        if (HASH.test(hash) && ignore.size < 500) ignore.add(hash);
      }
    } catch {
      /* the repository has none */
    }
    const skippedBots = [];
    for (let attempt = 0; attempt <= MAX_BOT_SKIPS; attempt += 1) {
      let parsed;
      try {
        const args = ['-C', dir, 'blame', '--porcelain', '-w', '-M', '-C', ...[...ignore].flatMap((h) => ['--ignore-rev', h]), '-L', `${line},${line}`, ref, '--', path];
        parsed = parsePorcelain((await run('git', args, opts)).stdout);
      } catch {
        parsed = null; // ref or path unknown at that ref (or an ignored revision git could not use)
      }
      if (!parsed) break;
      if (isBot(parsed.authorName, parsed.authorEmail) && attempt < MAX_BOT_SKIPS && !ignore.has(parsed.commit)) {
        skippedBots.push({ commit: parsed.commit, author: parsed.authorName });
        ignore.add(parsed.commit);
        continue;
      }
      const wanted = String(expect || '').trim();
      return {
        ...parsed,
        ref,
        exact: index === 0 && refs[0] === ref && HASH.test(ref),
        fallback: index > 0,
        matches: wanted ? parsed.content.includes(wanted) : null,
        skippedBots,
        ignoredRevs: ignore.size,
      };
    }
  }
  return null;
}

/** `git blame` of one line on a partial clone (file contents are fetched on demand). */
export async function localBlame({ cloneUrl, ref, refs = null, path, line, expect = '', cacheDir, token = '', authHeader = '' }) {
  if (!path || path.startsWith('-') || !(line > 0)) return null;
  const wanted = (refs ?? [ref]).filter(safeRef);
  if ((refs ?? [ref]).some((r) => r && !safeRef(r))) return null; // a ref from scan data must never be read as a git option
  const { dir, env } = await ensureClone(cloneUrl, { cacheDir, token, authHeader, blobs: true });
  return blameInDir(dir, { refs: wanted, path, line, expect, env });
}

/**
 * How sure an answer is, and why. Only 'high' is ever emailed without someone choosing it:
 *   high    blamed at the exact scanned commit, by a person (not a bot), and the line still
 *           holds the vulnerable code where that can be checked;
 *   medium  the scan recorded no commit, so the branch was blamed and the line still matches;
 *           or a host API answered with a commit that looks like reformatting;
 *   low     the line no longer holds the vulnerable code, the scanned commit is gone (blamed
 *           at a later version), or the last change was made by a bot.
 */
export function confidenceOf(blame, { scannedCommit = '' } = {}) {
  if (!blame) return { level: 'none', reason: '' };
  if (isBot(blame.authorName, blame.authorEmail)) return { level: 'low', reason: 'The last change to this line was made by a bot.' };
  if (blame.matches === false) return { level: 'low', reason: 'The line no longer holds the vulnerable code: it moved or changed after the scan.' };
  const atScan = blame.exact || (scannedCommit && blame.ref === scannedCommit);
  if (!atScan && scannedCommit) return { level: 'low', reason: 'The scanned commit is not in the repository any more: blamed at a later version.' };
  if (!atScan) return blame.matches ? { level: 'medium', reason: 'The scan recorded no commit: blamed on its branch, and the line still matches.' } : { level: 'low', reason: 'The scan recorded no commit, and the line could not be checked.' };
  if (blame.via !== 'git blame' && looksLikeFormatting(blame.message)) return { level: 'medium', reason: 'The last change looks like reformatting, which the host\'s blame cannot skip.' };
  return { level: 'high', reason: blame.skippedBots?.length ? `Looked past ${blame.skippedBots.length} bot commit${blame.skippedBots.length === 1 ? '' : 's'}.` : '' };
}

/**
 * Blame every located finding. `items`: [{finding, location, version, repo}].
 * Files on a host with a blame API are blamed once each through it; the rest
 * with local git, cloned with that host's own token. `scm`: {configs, clients}
 * for GitLab, Azure DevOps and Bitbucket (src/scm/providers.js).
 * Returns the items with `provider`, and `blame` (or `problem`), filled in.
 */
export async function blameFindings(items, { gh, apiUrl, cacheDir, token = '', useGithub = true, useLocal = true, scm = null }) {
  const files = new Map();
  for (const item of items) {
    if (item.problem) continue;
    const { repo, version, location } = item;
    item.provider = scm ? providerOf(repo, scm.configs, apiUrl) : onGitHub(repo, apiUrl) ? 'github' : '';
    // useGithub: "blame through the host's API" (the setting predates the other hosts).
    let blamer = null;
    if (useGithub && item.provider === 'github' && gh?.hasToken && onGitHub(repo, apiUrl)) blamer = { via: 'GitHub blame', blame: (args) => githubBlameRanges(gh, args) };
    else if (useGithub && scm) blamer = apiBlamer(item.provider, scm.clients, scm.configs);
    if (!blamer) continue;
    const refs = [version.commit, version.branch].filter(Boolean);
    const key = `${item.provider}|${repo.host}/${repo.owner}/${repo.repo}|${refs.join(',')}|${location.path}`;
    if (!files.has(key)) files.set(key, { repo, refs, path: location.path, blamer, items: [] });
    files.get(key).items.push(item);
  }

  await mapWithConcurrency([...files.values()], 4, async (file) => {
    for (const ref of file.refs.length ? file.refs : ['HEAD']) {
      let ranges = null;
      try {
        ranges = await file.blamer.blame({ owner: file.repo.owner, repo: file.repo.repo, ref, path: file.path });
      } catch (error) {
        for (const item of file.items) item.apiError = `${file.blamer.via}: ${error.message}`;
      }
      if (!ranges) continue;
      for (const item of file.items) {
        const hit = ranges.find((r) => item.location.line >= r.start && item.location.line <= r.end);
        if (!hit) continue;
        // A bot's commit, or one that only reformatted: the host's blame cannot look past it, local git can.
        if (useLocal && (isBot(hit.authorName, hit.authorEmail) || looksLikeFormatting(hit.message))) item.recheck = { ...hit, ref, via: file.blamer.via };
        else item.blame = { ...hit, ref, exact: ref === item.version.commit && HASH.test(ref), via: file.blamer.via };
      }
      break;
    }
  });

  const rest = items.filter((item) => !item.problem && !item.blame);
  await mapWithConcurrency(rest, 2, async (item) => {
    if (!useLocal) {
      item.problem = item.apiError || 'No blame through this host\'s API, and local git blame is switched off.';
      return;
    }
    try {
      const found = await localBlame({
        cloneUrl: item.repo.cloneUrl,
        refs: [item.version.commit, item.version.branch].filter(Boolean),
        path: item.location.path,
        line: item.location.line,
        expect: item.location.name,
        cacheDir,
        token: onGitHub(item.repo, apiUrl) ? token : '',
        authHeader: scm && item.provider !== 'github' ? cloneAuthFor(item.repo.cloneUrl, scm.configs) : '',
      });
      if (found) item.blame = { ...found, via: 'git blame', url: scm ? commitUrl(item.provider, item.repo, found.commit, scm.configs) : '' };
      else if (item.recheck) item.blame = item.recheck;
      else item.problem = `${item.location.path}:${item.location.line} not found in the repository${item.apiError ? ` (${item.apiError})` : ''}.`;
    } catch (error) {
      if (item.recheck) item.blame = item.recheck;
      else item.problem = `Could not read the repository: ${String(error.stderr || error.message).trim().split('\n')[0]}`;
    }
  });
  for (const item of items) {
    delete item.recheck;
    if (item.blame) item.confidence = confidenceOf(item.blame, { scannedCommit: item.version?.commit ?? '' });
  }
  return items;
}
