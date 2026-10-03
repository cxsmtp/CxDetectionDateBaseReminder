/**
 * Bitbucket Cloud (bitbucket.org) and Bitbucket Data Center / Server: who wrote a line, and
 * usernames to addresses.
 *
 * Blame: Data Center's REST `browse/:path?blame=true` (one request per file). Bitbucket Cloud
 * has no public blame API: git blame on a clone made with the app password or access token.
 *
 * Usernames → addresses, cheapest first.
 * Cloud: Bitbucket never shows a user's email, but every commit records it:
 *   localGit   git history of named repositories — no API calls;
 *   commits    recent commits of repositories you name: each commit links the Bitbucket user
 *              (nickname, account id) to the address in its author line — many people per request;
 *   members    workspace members (nickname → display name), joined to the authors in local history.
 * Data Center:
 *   localGit, commits (as above, from its REST API);
 *   directory  the user directory, up to 1000 people per request;
 *   users      user search, one request per user.
 */

import { byLocalGit, usableEmail } from '../github/identity.js';
import { mapWithConcurrency } from '../cxone/client.js';
import { ScmClient } from './client.js';
import { directoryMatcher, validUsername } from './identity.js';

export const BITBUCKET_LABELS = {
  localGit: 'Local git history',
  commits: 'Commit authors',
  members: 'Workspace members + local history',
  directory: 'User directory',
  users: 'User search',
};

export const isCloud = (cfg) => cfg.kind !== 'server';

/** The Authorization header: an app password (username + password), or an access token. */
export function bitbucketAuth(cfg) {
  if (!cfg.token) return '';
  return cfg.username ? `Basic ${Buffer.from(`${cfg.username}:${cfg.token}`).toString('base64')}` : `Bearer ${cfg.token}`;
}

/** For git over https: app password as user:password; Cloud access tokens as x-token-auth; Data Center tokens as Bearer. */
export function bitbucketCloneAuth(cfg) {
  if (!cfg.token) return '';
  if (cfg.username) return `Basic ${Buffer.from(`${cfg.username}:${cfg.token}`).toString('base64')}`;
  return isCloud(cfg) ? `Basic ${Buffer.from(`x-token-auth:${cfg.token}`).toString('base64')}` : `Bearer ${cfg.token}`;
}

export function bitbucketClient(cfg, fetchImpl = fetch) {
  return new ScmClient({ name: 'Bitbucket', baseUrl: cfg.apiUrl, auth: bitbucketAuth(cfg), fetchImpl });
}

/** Data Center repository addresses: https://host/scm/PROJ/repo.git → {project: 'PROJ', repo}. */
const dcProject = (owner) => String(owner).replace(/^scm\//i, '');

/** Blame ranges for one file at one ref (Data Center only). */
export async function bitbucketBlame(client, cfg, { owner, repo, ref, path }) {
  if (isCloud(cfg)) return null;
  const project = dcProject(owner);
  const base = `/rest/api/1.0/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}`;
  const body = await client.get(`${base}/browse/${path.split('/').map(encodeURIComponent).join('/')}`, { blame: 'true', noContent: 'true', ...(ref ? { at: ref } : {}) });
  const list = Array.isArray(body) ? body : body?.blame;
  if (!Array.isArray(list)) return null;
  const web = client.baseUrl;
  return list.map((b) => {
    const commit = b.commitHash ?? b.commitId ?? b.displayCommitHash ?? '';
    return {
      start: Number(b.lineNumber),
      end: Number(b.lineNumber) + Math.max(1, Number(b.spannedLines) || 1) - 1,
      commit,
      date: b.authorTimestamp ? new Date(Number(b.authorTimestamp)).toISOString() : '',
      url: commit ? `${web}/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}/commits/${commit}` : '',
      message: '',
      authorName: b.author?.displayName ?? b.author?.name ?? '',
      authorEmail: String(b.author?.emailAddress ?? '').toLowerCase(),
      login: b.author?.name ?? b.author?.slug ?? '',
    };
  });
}

/** "Jane Doe <jane@acme.com>" → {name, email}. */
export function parseRaw(raw) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(String(raw ?? ''));
  return m ? { name: m[1], email: m[2].toLowerCase() } : { name: String(raw ?? '').trim(), email: '' };
}

/** People seen on recent commits: Bitbucket user ↔ the address in the commit's author line. */
async function commitAuthors(client, cfg, repos, pages = 3) {
  const entries = [];
  for (const entry of repos.slice(0, 10)) {
    if (isCloud(cfg)) {
      let url = `/repositories/${entry.split('/').map(encodeURIComponent).join('/')}/commits`;
      for (let page = 0; page < pages && url; page += 1) {
        const body = await client.get(url, page ? {} : { pagelen: 100 });
        for (const c of body?.values ?? []) {
          const { name, email } = parseRaw(c.author?.raw);
          const user = c.author?.user;
          if (!user || !usableEmail(email)) continue;
          entries.push({ keys: [user.nickname, user.username, user.account_id, user.uuid, user.display_name].filter(Boolean), name: user.display_name || name, email, evidence: `Bitbucket user on commits in ${entry}` });
        }
        url = body?.next ?? '';
      }
    } else {
      const [project, repo] = entry.split('/');
      let start = 0;
      for (let page = 0; page < pages; page += 1) {
        const body = await client.get(`/rest/api/1.0/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo)}/commits`, { limit: 100, start });
        for (const c of body?.values ?? []) {
          const a = c.author ?? {};
          if (!usableEmail(a.emailAddress)) continue;
          entries.push({ keys: [a.name, a.slug, a.displayName].filter(Boolean), name: a.displayName ?? a.name ?? '', email: a.emailAddress, evidence: `Bitbucket user on commits in ${entry}` });
        }
        if (body?.isLastPage !== false) break;
        start = body.nextPageStart;
      }
    }
  }
  return entries;
}

const matchAll = (entries, logins, extra = {}) => {
  const match = directoryMatcher(entries);
  const results = {};
  for (const login of logins) {
    const hit = match(login);
    if (hit) results[login] = hit;
  }
  return { results, errors: [], ...extra };
};

async function byCommits(client, cfg, logins) {
  const entries = await commitAuthors(client, cfg, cfg.repos ?? []);
  return matchAll(entries, logins, { people: new Set(entries.map((e) => e.email)).size });
}

/** Cloud: members give each nickname a display name; local history gives that name an address. */
async function byMembers(client, cfg, logins, localSources, cacheDir) {
  const members = [];
  let url = `/workspaces/${encodeURIComponent(cfg.workspace)}/members`;
  for (let page = 0; page < 20 && url; page += 1) {
    const body = await client.get(url, page ? {} : { pagelen: 100 });
    for (const m of body?.values ?? []) if (m.user) members.push(m.user);
    url = body?.next ?? '';
  }
  const names = {};
  for (const login of logins) {
    const value = login.toLowerCase();
    const member = members.find((u) => [u.nickname, u.username, u.account_id, u.display_name].some((k) => String(k ?? '').toLowerCase() === value));
    if (member?.display_name) names[login] = member.display_name;
  }
  if (!Object.keys(names).length) return { results: {}, errors: [] };
  const local = await byLocalGit(Object.values(names), localSources, { cacheDir, authFor: cfg.authFor });
  const results = {};
  for (const [login, name] of Object.entries(names)) {
    const hit = local.results[name];
    if (hit) results[login] = { ...hit, confidence: 'medium', evidence: `Workspace member ${name}; ${hit.evidence}` };
  }
  return { results, errors: local.errors };
}

async function byDirectory(client, logins) {
  const entries = [];
  let start = 0;
  for (let page = 0; page < 20; page += 1) {
    const body = await client.get('/rest/api/1.0/users', { limit: 1000, start });
    for (const u of body?.values ?? []) if (usableEmail(u.emailAddress)) entries.push({ keys: [u.name, u.slug, u.displayName].filter(Boolean), name: u.displayName ?? '', email: u.emailAddress, evidence: 'Bitbucket user directory' });
    if (body?.isLastPage !== false) break;
    start = body.nextPageStart;
  }
  return matchAll(entries, logins, { directory: entries.length });
}

async function byUsers(client, logins) {
  const results = {};
  const errors = [];
  await mapWithConcurrency(logins, 4, async (login) => {
    try {
      const body = await client.get('/rest/api/1.0/users', { filter: login, limit: 25 });
      const user = (body?.values ?? []).find((u) => [u.name, u.slug].some((k) => String(k ?? '').toLowerCase() === login.toLowerCase()));
      if (usableEmail(user?.emailAddress)) results[login] = { email: user.emailAddress.toLowerCase(), confidence: 'high', evidence: 'Bitbucket user profile', name: user.displayName ?? '' };
    } catch (error) {
      if (error.status !== 404) errors.push(`${login}: ${error.message}`);
    }
  });
  return { results, errors };
}

export function bitbucketMethods(client, cfg, { localSources = [], cacheDir }) {
  const valid = (logins) => logins.filter((l) => validUsername('bitbucket', l));
  const noToken = client.hasToken ? '' : `Needs a Bitbucket ${isCloud(cfg) ? 'app password or access token' : 'HTTP access token'}.`;
  const methods = [
    { id: 'localGit', label: BITBUCKET_LABELS.localGit, skip: localSources.length ? '' : 'No local repositories or clone URLs given.', run: (logins) => byLocalGit(valid(logins), localSources, { cacheDir, authFor: cfg.authFor }) },
    { id: 'commits', label: BITBUCKET_LABELS.commits, skip: noToken || (cfg.repos?.length ? '' : `Name the repositories to read (${isCloud(cfg) ? 'workspace/repository' : 'PROJECT/repository'}) in the Bitbucket connection.`), run: (logins) => byCommits(client, cfg, valid(logins)) },
  ];
  if (isCloud(cfg)) {
    methods.push({
      id: 'members',
      label: BITBUCKET_LABELS.members,
      skip: noToken || (!cfg.workspace ? 'Set the workspace in the Bitbucket connection.' : !localSources.length ? 'Needs local repositories or clone URLs too, to find the members\' addresses.' : ''),
      run: (logins) => byMembers(client, cfg, valid(logins), localSources, cacheDir),
    });
  } else {
    methods.push({ id: 'directory', label: BITBUCKET_LABELS.directory, skip: noToken, run: (logins) => byDirectory(client, valid(logins)) });
    methods.push({ id: 'users', label: BITBUCKET_LABELS.users, skip: noToken, run: (logins) => byUsers(client, valid(logins)) });
  }
  return methods;
}

export async function bitbucketCheck(client, cfg) {
  if (isCloud(cfg)) {
    try {
      const me = await client.get('/user');
      return { ok: true, who: me?.username ?? me?.nickname ?? me?.display_name ?? '' };
    } catch (error) {
      // Workspace and repository access tokens cannot read /user: the workspace answers instead.
      if (!cfg.workspace || error.status !== 401 && error.status !== 403) throw error;
      await client.get(`/repositories/${encodeURIComponent(cfg.workspace)}`, { pagelen: 1 });
      return { ok: true, who: `access token for ${cfg.workspace}` };
    }
  }
  const body = await client.get('/rest/api/1.0/users', { limit: 1 });
  if (!Array.isArray(body?.values)) throw new Error('Bitbucket did not answer as Bitbucket Data Center.');
  return { ok: true, who: 'token accepted' };
}
