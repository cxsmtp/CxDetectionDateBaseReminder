/**
 * GitLab (gitlab.com or self-managed): who wrote a line, and usernames to addresses.
 *
 * Blame: REST `…/repository/files/:path/blame?ref=` (one request per file, however many
 * findings are in it). Usernames → addresses, cheapest first:
 *   localGit  git history of named repositories (GitLab noreply commits
 *             ID-username@users.noreply.<host> name the user; same author elsewhere gives
 *             the real address) — no API calls;
 *   graphql   one request per 100 users: public email and commit email;
 *   users     REST /users?username=, one request per user: public email (all emails for admins);
 *   commits   the user's name (from /users), then commits by that author in projects you name.
 */

import { byLocalGit, usableEmail } from '../github/identity.js';
import { mapWithConcurrency } from '../cxone/client.js';
import { ScmClient } from './client.js';
import { validUsername } from './identity.js';

export const GITLAB_LABELS = {
  localGit: 'Local git history',
  graphql: 'GraphQL batch',
  users: 'User profile (REST)',
  commits: 'Commits by their name',
};

export function gitlabClient(cfg, fetchImpl = fetch) {
  return new ScmClient({ name: 'GitLab', baseUrl: cfg.apiUrl, auth: cfg.token ? `Bearer ${cfg.token}` : '', fetchImpl });
}

/** https://gitlab.acme.com/api/v4 → https://gitlab.acme.com */
export const gitlabWebUrl = (apiUrl) => String(apiUrl || 'https://gitlab.com/api/v4').replace(/\/api\/v4\/?$/, '');

/** Blame ranges for one file at one ref. */
export async function gitlabBlame(client, { owner, repo, ref, path }) {
  const project = encodeURIComponent(`${owner}/${repo}`);
  const body = await client.get(`/projects/${project}/repository/files/${encodeURIComponent(path)}/blame`, { ref });
  if (!Array.isArray(body)) return null;
  const web = gitlabWebUrl(client.baseUrl);
  const ranges = [];
  let line = 1;
  for (const group of body) {
    const count = Array.isArray(group.lines) ? group.lines.length : 0;
    if (!count) continue;
    const c = group.commit ?? {};
    ranges.push({
      start: line,
      end: line + count - 1,
      commit: c.id,
      date: c.authored_date ?? c.committed_date ?? '',
      url: c.id ? `${web}/${owner}/${repo}/-/commit/${c.id}` : '',
      message: String(c.message ?? c.title ?? '').split('\n')[0],
      authorName: c.author_name ?? '',
      authorEmail: String(c.author_email ?? '').toLowerCase(),
      login: '',
    });
    line += count;
  }
  return ranges;
}

const USERS_QUERY = (withCommitEmail) => `query($names: [String!]) { users(usernames: $names, first: 100) { nodes { username name publicEmail${withCommitEmail ? ' commitEmail' : ''} } } }`;

async function byGraphql(client, logins) {
  const results = {};
  const errors = [];
  const graphql = `${new URL(client.baseUrl).origin}${new URL(client.baseUrl).pathname.replace(/\/api\/v4\/?$/, '')}/api/graphql`;
  let withCommitEmail = true;
  for (let i = 0; i < logins.length; i += 100) {
    const names = logins.slice(i, i + 100);
    let body;
    try {
      body = await client.post(graphql, { query: USERS_QUERY(withCommitEmail), variables: { names } });
      if (withCommitEmail && body?.errors?.some((e) => /commitEmail/.test(e.message))) {
        withCommitEmail = false; // older GitLab: ask again without it
        body = await client.post(graphql, { query: USERS_QUERY(false), variables: { names } });
      }
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    for (const node of body?.data?.users?.nodes ?? []) {
      const login = names.find((n) => n.toLowerCase() === String(node.username).toLowerCase());
      const email = [node.publicEmail, node.commitEmail].find(usableEmail);
      if (login && email) results[login] = { email: email.toLowerCase(), confidence: 'high', evidence: node.publicEmail === email ? 'Public email on the GitLab profile' : 'Commit email on the GitLab profile', name: node.name ?? '' };
    }
  }
  return { results, errors };
}

async function profile(client, login) {
  const found = await client.get('/users', { username: login });
  return Array.isArray(found) ? found.find((u) => String(u.username).toLowerCase() === login.toLowerCase()) ?? null : null;
}

async function byUsers(client, logins) {
  const results = {};
  const errors = [];
  await mapWithConcurrency(logins, 4, async (login) => {
    try {
      const user = await profile(client, login);
      const email = [user?.public_email, user?.email, user?.commit_email].find(usableEmail);
      if (email) results[login] = { email: email.toLowerCase(), confidence: 'high', evidence: 'Email on the GitLab profile', name: user.name ?? '' };
    } catch (error) {
      if (error.status !== 404) errors.push(`${login}: ${error.message}`);
    }
  });
  return { results, errors };
}

async function byCommits(client, logins, projects) {
  const results = {};
  const errors = [];
  await mapWithConcurrency(logins, 3, async (login) => {
    try {
      const user = await profile(client, login);
      if (!user?.name) return;
      const counts = new Map();
      for (const project of projects.slice(0, 5)) {
        const commits = await client.get(`/projects/${encodeURIComponent(project)}/repository/commits`, { author: user.name, per_page: 30, all: true }).catch((error) => {
          if (error.status === 404) return [];
          throw error;
        });
        for (const c of commits ?? []) {
          if (String(c.author_name).toLowerCase() !== String(user.name).toLowerCase() || !usableEmail(c.author_email)) continue;
          const email = c.author_email.toLowerCase();
          counts.set(email, (counts.get(email) ?? 0) + 1);
        }
        if (counts.size) break;
      }
      const [email, count] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
      if (email) results[login] = { email, confidence: count >= 2 ? 'high' : 'medium', evidence: `Author email on ${count} commit(s) by ${user.name}`, name: user.name };
    } catch (error) {
      if (error.status !== 404) errors.push(`${login}: ${error.message}`);
    }
  });
  return { results, errors };
}

/** The methods for these settings, cheapest first. */
export function gitlabMethods(client, cfg, { localSources = [], cacheDir }) {
  const valid = (logins) => logins.filter((l) => validUsername('gitlab', l));
  return [
    { id: 'localGit', label: GITLAB_LABELS.localGit, skip: localSources.length ? '' : 'No local repositories or clone URLs given.', run: async (logins) => byLocalGit(valid(logins), localSources, { cacheDir, authFor: cfg.authFor }) },
    { id: 'graphql', label: GITLAB_LABELS.graphql, skip: client.hasToken ? '' : 'Needs a GitLab token.', run: (logins) => byGraphql(client, valid(logins)) },
    { id: 'users', label: GITLAB_LABELS.users, run: (logins) => byUsers(client, valid(logins)) },
    { id: 'commits', label: GITLAB_LABELS.commits, skip: cfg.projects?.length ? '' : 'Name the projects to search (group/project) in the GitLab connection.', run: (logins) => byCommits(client, valid(logins), cfg.projects) },
  ];
}

/** Is the token accepted? {ok, who}. */
export async function gitlabCheck(client) {
  const me = await client.get('/user');
  return { ok: true, who: me?.username ?? '' };
}
