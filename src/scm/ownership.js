/**
 * Who owns the vulnerable code, besides who last changed it (read-only):
 *
 *   - Code owners: the repository's CODEOWNERS file, at the scanned version, read the way
 *     GitHub and GitLab read it (the last matching rule wins; on GitLab, the last matching
 *     rule of each [Section]). Read through the host's API on GitHub and GitLab, or from
 *     the clone already made for git blame on any host.
 *   - The change request it came in through: for the blamed commit, the pull request (GitHub)
 *     or merge request (GitLab) that merged it, its author, and who approved it.
 *
 * Every lookup is optional: a repository without a CODEOWNERS file, a token without the
 * scope, or a host without the API simply leaves the field empty.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { mapWithConcurrency } from '../cxone/client.js';

const run = promisify(execFile);

/** Where each host looks for the file, in its own order. */
export const CODEOWNERS_PATHS = {
  github: ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'],
  gitlab: ['CODEOWNERS', 'docs/CODEOWNERS', '.gitlab/CODEOWNERS'],
  azure: ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS', '.azuredevops/CODEOWNERS'],
  bitbucket: ['.bitbucket/CODEOWNERS', 'CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'],
};
const MAX_FILE = 256 * 1024;
const MAX_RULES = 2000;
const MAX_OWNERS = 20;
const HASH = /^[0-9a-f]{7,64}$/i;
const SAFE_REF = /^(?!-)[\w./-]{1,200}$/;
// @user, @org/team, @group/sub-group, or an email address.
const OWNER = /^(?:@[\w.-]+(?:\/[\w.-]+)*|[^\s@]+@[^\s@]+\.[^\s@]+)$/;

/** A gitignore-style CODEOWNERS pattern as a regular expression for repository paths. */
export function patternRegex(pattern) {
  let p = String(pattern).replace(/\\ /g, ' ');
  if (!p || p.startsWith('!')) return null; // negation is not supported by GitHub or GitLab
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.startsWith('/') || p.includes('/');
  // "docs/*" is the files directly in docs/, not those in its subfolders (GitHub's reading).
  const shallow = p.endsWith('/*') && !p.endsWith('**/*');
  p = p.replace(/^\/+/, '');
  if (!p) return /^.*$/; // "/" or "/*"-like root rules
  let body = '';
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') {
        body += '(?:.*/)?';
        i += 2;
      } else {
        body += '.*';
        i += 1;
      }
    } else if (c === '*') body += '[^/]*';
    else if (c === '?') body += '[^/]';
    else body += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}${dirOnly ? '/.*' : shallow ? '' : '(?:/.*)?'}$`);
}

/** The rules of a CODEOWNERS file: [{pattern, regex, owners, section}], in file order. */
export function parseCodeowners(text) {
  const rules = [];
  let section = '';
  let sectionOwners = [];
  for (const raw of String(text ?? '').slice(0, MAX_FILE).split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    // GitLab sections: [Name], ^[Optional], [Name][2] @default-owners
    const head = /^\^?\[([^\]]+)\](?:\[\d+\])?\s*(.*)$/.exec(line);
    if (head) {
      section = head[1].trim();
      sectionOwners = head[2].split(/\s+/).filter((o) => OWNER.test(o));
      continue;
    }
    const parts = line.match(/(?:\\ |\S)+/g) ?? [];
    const [pattern, ...rest] = parts;
    const regex = patternRegex(pattern);
    if (!regex) continue;
    const owners = rest.filter((o) => OWNER.test(o));
    rules.push({ pattern, regex, owners: owners.length ? owners : sectionOwners, section });
    if (rules.length >= MAX_RULES) break;
  }
  return rules;
}

/** The owners of a file: the last matching rule's (per section, for GitLab's sections). */
export function ownersOf(rules, path) {
  const file = String(path ?? '').replace(/^\/+/, '');
  if (!file || !rules?.length) return [];
  const last = new Map();
  for (const rule of rules) if (rule.regex.test(file)) last.set(rule.section, rule);
  const owners = [];
  for (const rule of last.values()) for (const o of rule.owners) if (!owners.includes(o)) owners.push(o);
  return owners.slice(0, MAX_OWNERS);
}

/** The CODEOWNERS text from a clone at `ref`, or ''. */
export async function codeownersInDir(dir, { refs = [], provider = 'github', env = process.env } = {}) {
  const paths = CODEOWNERS_PATHS[provider] ?? CODEOWNERS_PATHS.github;
  for (const ref of [...new Set([...refs, 'HEAD'])].filter((r) => SAFE_REF.test(r))) {
    for (const path of paths) {
      try {
        const { stdout } = await run('git', ['-C', dir, 'show', `${ref}:${path}`], { env, timeout: 60_000, maxBuffer: MAX_FILE * 2 });
        return { text: stdout, path, ref };
      } catch {
        /* not at this path or ref */
      }
    }
  }
  return null;
}

/** The CODEOWNERS text through GitHub's contents API, or null. */
export async function githubCodeowners(gh, { owner, repo, refs = [] }) {
  // The scanned version only (or the default branch): at most three requests a repository.
  for (const ref of [refs[0] ?? ''].filter((r) => r === '' || SAFE_REF.test(r))) {
    for (const path of CODEOWNERS_PATHS.github) {
      try {
        const body = await gh.rest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}`, ref ? { ref } : {});
        if (body?.content && body.encoding === 'base64') return { text: Buffer.from(body.content, 'base64').toString('utf8'), path, ref };
      } catch (error) {
        if (error.status && error.status !== 404) return null; // no access: stop asking
      }
    }
  }
  return null;
}

/** The CODEOWNERS text through GitLab's repository files API, or null. */
export async function gitlabCodeowners(client, { owner, repo, refs = [] }) {
  const project = encodeURIComponent(`${owner}/${repo}`);
  for (const ref of [refs[0] ?? 'HEAD'].filter((r) => SAFE_REF.test(r))) {
    for (const path of CODEOWNERS_PATHS.gitlab) {
      try {
        const text = await client.get(`/projects/${project}/repository/files/${encodeURIComponent(path)}/raw`, { ref });
        if (typeof text === 'string') return { text, path, ref };
      } catch (error) {
        if (error.status && error.status !== 404) return null;
      }
    }
  }
  return null;
}

/** The pull request a GitHub commit came in through, with who approved it, or null. */
export async function githubChange(gh, { owner, repo, sha }) {
  if (!HASH.test(sha)) return null;
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const pulls = await gh.rest(`${base}/commits/${sha}/pulls`, { per_page: 10 });
  if (!Array.isArray(pulls) || !pulls.length) return null;
  const pr = pulls.find((p) => p.merged_at) ?? pulls[0];
  const reviews = await gh.rest(`${base}/pulls/${pr.number}/reviews`, { per_page: 100 }).catch(() => []);
  // A reviewer's latest verdict counts: one who approved and later asked for changes did not approve.
  const latest = new Map();
  for (const r of Array.isArray(reviews) ? reviews : []) {
    const who = r.user?.login;
    if (who && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) latest.set(who, r.state);
  }
  return {
    kind: 'pull request',
    number: pr.number,
    title: String(pr.title ?? '').slice(0, 200),
    url: pr.html_url ?? '',
    author: pr.user?.login ?? '',
    mergedAt: pr.merged_at ?? '',
    approvers: [...latest].filter(([, state]) => state === 'APPROVED').map(([who]) => who).slice(0, MAX_OWNERS),
  };
}

/** The merge request a GitLab commit came in through, with who approved it, or null. */
export async function gitlabChange(client, { owner, repo, sha }) {
  if (!HASH.test(sha)) return null;
  const project = encodeURIComponent(`${owner}/${repo}`);
  const mrs = await client.get(`/projects/${project}/repository/commits/${sha}/merge_requests`);
  if (!Array.isArray(mrs) || !mrs.length) return null;
  const mr = mrs.find((m) => m.state === 'merged') ?? mrs[0];
  const approvals = await client.get(`/projects/${project}/merge_requests/${mr.iid}/approvals`).catch(() => null);
  return {
    kind: 'merge request',
    number: mr.iid,
    title: String(mr.title ?? '').slice(0, 200),
    url: mr.web_url ?? '',
    author: mr.author?.username ?? '',
    mergedAt: mr.merged_at ?? '',
    mergedBy: mr.merged_by?.username ?? mr.merge_user?.username ?? '',
    approvers: (approvals?.approved_by ?? []).map((a) => a.user?.username).filter(Boolean).slice(0, MAX_OWNERS),
  };
}

/**
 * Fill in `owners` ({list, file}) and `change` (the pull or merge request) on blamed items.
 * `lookup`: {github(repo) → GitHubClient|null, gitlab(repo) → ScmClient|null, clone(item) → {dir, env}|null}.
 * Each repository's file is read once per version, each commit's change once.
 */
export async function addOwnership(items, lookup, { maxCommits = 100 } = {}) {
  const files = new Map();
  const changes = new Map();
  for (const item of items) {
    if (!item.repo || !item.location?.path) continue;
    const refs = [item.version?.commit, item.version?.branch].filter(Boolean);
    const key = `${item.provider}|${item.repo.host}/${item.repo.owner}/${item.repo.repo}|${refs.join(',')}`;
    if (!files.has(key)) files.set(key, { item, refs, items: [] });
    files.get(key).items.push(item);
    const sha = item.blame?.commit;
    if (sha && (item.provider === 'github' || item.provider === 'gitlab')) {
      const ck = `${item.provider}|${item.repo.host}/${item.repo.owner}/${item.repo.repo}|${sha}`;
      if (!changes.has(ck) && changes.size < maxCommits) changes.set(ck, { item, sha, items: [] });
      changes.get(ck)?.items.push(item);
    }
  }

  await mapWithConcurrency([...files.values()], 4, async (file) => {
    const { item, refs } = file;
    const where = { owner: item.repo.owner, repo: item.repo.repo, refs };
    let found = null;
    try {
      const gh = item.provider === 'github' ? lookup.github?.(item.repo) : null;
      const gl = item.provider === 'gitlab' ? lookup.gitlab?.(item.repo) : null;
      if (gh) found = await githubCodeowners(gh, where);
      else if (gl) found = await gitlabCodeowners(gl, where);
      if (!found) {
        const clone = await lookup.clone?.(item);
        if (clone?.dir) found = await codeownersInDir(clone.dir, { refs, provider: item.provider || 'github', env: clone.env });
      }
    } catch {
      found = null;
    }
    if (!found) return;
    const rules = parseCodeowners(found.text);
    for (const it of file.items) {
      const list = ownersOf(rules, it.location.path);
      if (list.length) it.owners = { list, file: found.path };
    }
  });

  await mapWithConcurrency([...changes.values()], 4, async (entry) => {
    const { item, sha } = entry;
    let change = null;
    try {
      const where = { owner: item.repo.owner, repo: item.repo.repo, sha };
      if (item.provider === 'github') {
        const gh = lookup.github?.(item.repo);
        if (gh) change = await githubChange(gh, where);
      } else {
        const gl = lookup.gitlab?.(item.repo);
        if (gl) change = await gitlabChange(gl, where);
      }
    } catch {
      change = null;
    }
    if (change) for (const it of entry.items) it.change = change;
  });
  return items;
}
