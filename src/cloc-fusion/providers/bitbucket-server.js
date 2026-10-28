// Vendored from cloc-fusion 1.3.2 (commit 1a320621d0f5), MIT licence: src/cloc-fusion/LICENSE. Do not edit here: scripts/sync-cloc-fusion.mjs copies it again.
// Bitbucket Data Center / Server. Organizations are projects.
import { ApiClient } from '../http.js';
import { pool } from '../pool.js';

const nextOf = (data, _res, url) => {
  if (!data || data.isLastPage !== false || data.nextPageStart === undefined) return null;
  const u = new URL(url);
  u.searchParams.set('start', String(data.nextPageStart));
  return u.toString();
};

export default {
  id: 'bitbucket-server',
  label: 'Bitbucket Data Center / Server',
  defaultApiUrl: '',
  apiUrlHint: 'https://bitbucket.example.com (the address you open in a browser)',
  orgNoun: 'project',
  authMethods: [
    {
      id: 'http-token',
      label: 'HTTP access token (personal, project or repository)',
      help: ['Profile picture → Manage account → HTTP access tokens. Permissions: Project read, Repository read.'],
    },
  ],

  client(conn, secret) {
    const root = String(conn.apiUrl || '').replace(/\/+$/, '').replace(/\/rest\/api\/1\.0$/, '');
    return new ApiClient({ name: 'Bitbucket Server', baseUrl: `${root}/rest/api/1.0`, headers: { Authorization: `Bearer ${secret.token}` } });
  },

  async whoami(api) {
    const { res } = await api.request('/projects?limit=1');
    return res.headers.get('x-ausername') || 'signed in';
  },

  async listOrgs(api) {
    const list = await api.paginate('/projects?limit=100', { items: (d) => d?.values || [], next: nextOf });
    return list.map((p) => ({ id: p.key, label: `${p.key} — ${p.name}` }));
  },

  async listRepos(api, org) {
    const list = await api.paginate(`/projects/${encodeURIComponent(org)}/repos?limit=100`, { items: (d) => d?.values || [], next: nextOf });
    const out = new Array(list.length);
    await pool(list, 8, async (r, i) => {
      let defaultBranch = null;
      try {
        const b = await api.get(`/projects/${encodeURIComponent(org)}/repos/${encodeURIComponent(r.slug)}/default-branch`, { allow404: true });
        defaultBranch = b?.displayId || null;
      } catch {}
      out[i] = {
        id: String(r.id),
        name: r.slug,
        fullName: `${org}/${r.slug}`,
        cloneUrl: stripUser((r.links?.clone || []).find((c) => c.name === 'http')?.href || ''),
        webUrl: r.links?.self?.[0]?.href,
        defaultBranch,
        archived: Boolean(r.archived),
        fork: Boolean(r.origin),
        private: !r.public,
        empty: false,
        sizeKb: null,
        language: null,
        createdAt: null,
        pushedAt: null,
      };
    });
    return out;
  },

  gitHosts(conn) {
    return [new URL(conn.apiUrl).host.toLowerCase()];
  },

  gitAuthHeader(_conn, secret) {
    return `Bearer ${secret.token}`;
  },

  archive(repo) {
    const [project, slug] = repo.fullName.split('/');
    return { url: `/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(slug)}/archive?format=tgz&at=${encodeURIComponent(`refs/heads/${repo.defaultBranch}`)}`, format: 'tgz' };
  },

  async commits(api, repo, since) {
    const [project, slug] = repo.fullName.split('/');
    const sinceT = Date.parse(since);
    const out = [];
    let lastCommitAt = null;
    for (let start = 0, pages = 0; pages < 10000; pages++) {
      const page = await api.get(`/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(slug)}/commits?until=${encodeURIComponent(`refs/heads/${repo.defaultBranch}`)}&limit=100&start=${start}`, { allow404: true });
      let older = false;
      for (const c of page?.values || []) {
        lastCommitAt ??= new Date(c.committerTimestamp || c.authorTimestamp).toISOString();
        const t = c.committerTimestamp || c.authorTimestamp;
        if (t < sinceT) {
          older = true;
          break;
        }
        out.push({ t, email: c.author?.emailAddress || c.author?.name || '', name: c.author?.displayName || c.author?.name || '', merge: (c.parents?.length || 0) > 1 });
      }
      if (older || !page || page.isLastPage !== false || !(page.nextPageStart > start)) break;
      start = page.nextPageStart;
    }
    return { commits: out, lastCommitAt };
  },
};

function stripUser(url) {
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return url;
  }
}
