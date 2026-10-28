// Vendored from cloc-fusion 1.3.2 (commit 1a320621d0f5), MIT licence: src/cloc-fusion/LICENSE. Do not edit here: scripts/sync-cloc-fusion.mjs copies it again.
// GitHub (github.com and GitHub Enterprise Server).
import { ApiClient, basic } from '../http.js';

export default {
  id: 'github',
  label: 'GitHub (github.com or Enterprise Server)',
  defaultApiUrl: 'https://api.github.com',
  apiUrlHint: 'https://api.github.com — for Enterprise Server: https://<host>/api/v3',
  orgNoun: 'organization',
  authMethods: [
    {
      id: 'pat',
      label: 'Personal access token (classic or fine-grained)',
      help: [
        'Create one at <web>/settings/tokens.',
        'Classic token scopes: repo (read private repos) and read:org (list your organizations).',
        'Fine-grained token: one per organization (resource owner), Repository access "All repositories",',
        '  permissions Metadata: Read and Contents: Read.',
        'Organizations that sign in through Okta / SAML SSO: after creating the token click',
        '  "Configure SSO" next to it and authorize it for each organization, or GitHub returns 403.',
      ],
    },
    {
      id: 'gh-cli',
      label: 'Reuse my GitHub CLI sign-in (gh auth login: browser / SSO)',
      help: ['Runs `gh auth token` each time; sign in first with `gh auth login` (add `--hostname <host>` for Enterprise Server).'],
      tokenCommand: (conn) => (hostOf(conn) === 'github.com' ? ['gh', 'auth', 'token'] : ['gh', 'auth', 'token', '--hostname', hostOf(conn)]),
    },
  ],

  client(conn, secret) {
    return new ApiClient({
      name: 'GitHub',
      baseUrl: conn.apiUrl || this.defaultApiUrl,
      headers: { Authorization: `Bearer ${secret.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
  },

  async whoami(api) {
    const me = await api.get('/user');
    return me.login;
  },

  async listOrgs(api) {
    const orgs = await api.paginate('/user/orgs?per_page=100');
    return [{ id: '@me', label: 'My own repositories (personal account)' }, ...orgs.map((o) => ({ id: o.login, label: o.description ? `${o.login} — ${o.description.slice(0, 60)}` : o.login }))];
  },

  async listRepos(api, org) {
    // '@all': every repository this sign-in can reach (owned, as a collaborator, or through an organization).
    const path =
      org === '@all' ? '/user/repos?affiliation=owner,collaborator,organization_member&per_page=100' : org === '@me' ? '/user/repos?affiliation=owner&per_page=100' : `/orgs/${encodeURIComponent(org)}/repos?type=all&per_page=100`;
    const list = await api.paginate(path);
    return list.map((r) => ({
      id: String(r.id),
      name: r.name,
      fullName: r.full_name,
      cloneUrl: r.clone_url,
      webUrl: r.html_url,
      defaultBranch: r.default_branch || null,
      archived: Boolean(r.archived || r.disabled),
      fork: Boolean(r.fork),
      private: Boolean(r.private),
      empty: r.size === 0,
      sizeKb: r.size ?? null,
      language: r.language || null,
      createdAt: r.created_at || null,
      pushedAt: r.pushed_at || null,
    }));
  },

  /** Hosts its clone URLs may point to: github.com, or the Enterprise Server's own host. */
  gitHosts(conn) {
    return [hostOf(conn)];
  },

  gitAuthHeader(_conn, secret) {
    return basic('x-access-token', secret.token);
  },

  // Git-free engine: the default branch as a tarball, and its commits since a date.
  archive(repo) {
    return { url: `/repos/${repo.fullName}/tarball/${encodeURIComponent(repo.defaultBranch)}`, format: 'tgz' };
  },

  async commits(api, repo, since) {
    const ref = encodeURIComponent(repo.defaultBranch);
    const list = await api.paginate(`/repos/${repo.fullName}/commits?sha=${ref}&since=${encodeURIComponent(since)}&per_page=100`, { emptyOn: [409] });
    const out = list.map((c) => ({ t: Date.parse(c.commit?.committer?.date || c.commit?.author?.date), email: c.commit?.author?.email || c.author?.login || '', name: c.commit?.author?.name || c.author?.login || '', merge: (c.parents?.length || 0) > 1 }));
    if (!out.length) {
      const last = await api.get(`/repos/${repo.fullName}/commits?sha=${ref}&per_page=1`, { allow404: true, emptyOn: [409] });
      const c = Array.isArray(last) ? last[0] : null;
      return { commits: out, lastCommitAt: c ? c.commit?.committer?.date : null };
    }
    return { commits: out };
  },
};

function hostOf(conn) {
  try {
    const h = new URL(conn.apiUrl || 'https://api.github.com').host;
    return h === 'api.github.com' ? 'github.com' : h;
  } catch {
    return 'github.com';
  }
}
