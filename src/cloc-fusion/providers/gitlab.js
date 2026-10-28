// Vendored from cloc-fusion 1.3.2 (commit 1a320621d0f5), MIT licence: src/cloc-fusion/LICENSE. Do not edit here: scripts/sync-cloc-fusion.mjs copies it again.
// GitLab (gitlab.com and self-managed). Organizations are top-level groups; subgroups are included.
import { ApiClient, basic } from '../http.js';

export default {
  id: 'gitlab',
  label: 'GitLab (gitlab.com or self-managed)',
  defaultApiUrl: 'https://gitlab.com/api/v4',
  apiUrlHint: 'https://gitlab.com/api/v4 — self-managed: https://<host>/api/v4',
  orgNoun: 'top-level group',
  authMethods: [
    {
      id: 'pat',
      label: 'Personal, group or project access token',
      help: [
        'Create one at <web>/-/user_settings/personal_access_tokens',
        '  (or a group access token under the group: Settings → Access tokens).',
        'Scopes: read_api and read_repository. Role: at least Reporter.',
        'Groups that sign in through Okta / SAML SSO accept tokens of members who have signed in once with SSO.',
      ],
    },
  ],

  client(conn, secret) {
    return new ApiClient({ name: 'GitLab', baseUrl: conn.apiUrl || this.defaultApiUrl, headers: { Authorization: `Bearer ${secret.token}` } });
  },

  async whoami(api) {
    const me = await api.get('/user');
    return me.username;
  },

  async listOrgs(api) {
    const groups = await api.paginate('/groups?top_level_only=true&min_access_level=10&per_page=100&order_by=name');
    return [{ id: '@me', label: 'My own projects (personal namespace)' }, ...groups.map((g) => ({ id: g.full_path, label: g.name === g.full_path ? g.full_path : `${g.full_path} — ${g.name}` }))];
  },

  async listRepos(api, org) {
    // '@all': every project this sign-in is a member of, in any namespace.
    const path = org === '@all' ? '/projects?membership=true&per_page=100&simple=false' : org === '@me' ? '/projects?owned=true&per_page=100&simple=false' : `/groups/${encodeURIComponent(org)}/projects?include_subgroups=true&with_shared=false&per_page=100`;
    const list = await api.paginate(path);
    return list.map((p) => ({
      id: String(p.id),
      name: p.path,
      fullName: p.path_with_namespace,
      cloneUrl: p.http_url_to_repo,
      webUrl: p.web_url,
      defaultBranch: p.default_branch || null,
      archived: Boolean(p.archived),
      fork: Boolean(p.forked_from_project),
      private: p.visibility !== 'public',
      empty: Boolean(p.empty_repo),
      sizeKb: p.statistics?.repository_size ? Math.round(p.statistics.repository_size / 1024) : null,
      language: null,
      createdAt: p.created_at || null,
      pushedAt: p.last_activity_at || null,
    }));
  },

  gitHosts(conn) {
    return [new URL(conn.apiUrl || this.defaultApiUrl).host.toLowerCase()];
  },

  gitAuthHeader(_conn, secret) {
    return basic('oauth2', secret.token);
  },

  archive(repo) {
    return { url: `/projects/${encodeURIComponent(repo.id)}/repository/archive.tar.gz?sha=${encodeURIComponent(repo.defaultBranch)}`, format: 'tgz' };
  },

  async commits(api, repo, since) {
    const base = `/projects/${encodeURIComponent(repo.id)}/repository/commits?ref_name=${encodeURIComponent(repo.defaultBranch)}`;
    const list = await api.paginate(`${base}&since=${encodeURIComponent(since)}&per_page=100`);
    const out = list.map((c) => ({ t: Date.parse(c.committed_date || c.created_at), email: c.author_email || '', name: c.author_name || '', merge: (c.parent_ids?.length || 0) > 1 }));
    if (!out.length) {
      const last = await api.get(`${base}&per_page=1`, { allow404: true });
      return { commits: out, lastCommitAt: Array.isArray(last) && last[0] ? last[0].committed_date : null };
    }
    return { commits: out };
  },
};
