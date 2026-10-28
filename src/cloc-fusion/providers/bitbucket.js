// Vendored from cloc-fusion 1.3.2 (commit 1a320621d0f5), MIT licence: src/cloc-fusion/LICENSE. Do not edit here: scripts/sync-cloc-fusion.mjs copies it again.
// Bitbucket Cloud (bitbucket.org). Organizations are workspaces.
import { ApiClient, basic } from '../http.js';

const nextOf = (data) => data?.next || null;
// A guard against a server that never ends its pages: 1,000,000 commits.
const MAX_PAGES = 10000;

export default {
  id: 'bitbucket',
  label: 'Bitbucket Cloud (bitbucket.org)',
  defaultApiUrl: 'https://api.bitbucket.org/2.0',
  apiUrlHint: 'https://api.bitbucket.org/2.0',
  orgNoun: 'workspace',
  authMethods: [
    {
      id: 'api-token',
      label: 'Atlassian API token with scopes (your Atlassian email + token)',
      needsUsername: 'Atlassian account email',
      help: [
        'Create one at https://id.atlassian.com/manage-profile/security/api-tokens → "Create API token with scopes" → Bitbucket.',
        'Scopes: read:user:bitbucket, read:workspace:bitbucket, read:repository:bitbucket.',
        'Okta / SAML SSO through Atlassian Guard: sign in once with SSO, then create the token.',
      ],
    },
    {
      id: 'access-token',
      label: 'Workspace, project or repository access token (Premium)',
      help: [
        'Workspace settings → Security → Access tokens. Scopes: Repositories: Read (and Account: Read if available).',
        'A workspace token cannot list other workspaces: type the workspace slug when asked.',
      ],
    },
    {
      id: 'app-password',
      label: 'App password (legacy; being retired by Atlassian)',
      needsUsername: 'Bitbucket username (not email)',
      help: ['Personal settings → App passwords. Permissions: Account: Read, Workspace membership: Read, Repositories: Read.'],
    },
  ],

  authHeader(conn, secret) {
    const m = conn.auth?.method;
    if (m === 'access-token') return `Bearer ${secret.token}`;
    return basic(secret.username || '', secret.token);
  },

  client(conn, secret) {
    return new ApiClient({ name: 'Bitbucket', baseUrl: conn.apiUrl || this.defaultApiUrl, headers: { Authorization: this.authHeader(conn, secret) }, trustedOrigins: ['https://bitbucket.org'] });
  },

  async whoami(api, conn) {
    if (conn.auth?.method === 'access-token') return 'access token';
    const me = await api.get('/user');
    return me.username || me.display_name;
  },

  async listOrgs(api) {
    // Atlassian has moved this list between endpoints; try the current one first.
    const tries = [
      ['/user/workspaces?pagelen=100', (v) => v.workspace || v],
      ['/user/permissions/workspaces?pagelen=100', (v) => v.workspace],
      ['/workspaces?pagelen=100', (v) => v],
    ];
    let lastErr;
    for (const [path, pick] of tries) {
      try {
        const list = await api.paginate(path, { items: (d) => d?.values || [], next: nextOf });
        const seen = new Map();
        for (const v of list) {
          const w = pick(v);
          if (w?.slug && !seen.has(w.slug)) seen.set(w.slug, { id: w.slug, label: w.name && w.name !== w.slug ? `${w.slug} — ${w.name}` : w.slug });
        }
        return [...seen.values()];
      } catch (err) {
        lastErr = err;
        if (![404, 410].includes(err.status)) break;
      }
    }
    throw lastErr;
  },

  async listRepos(api, org) {
    const list = await api.paginate(`/repositories/${encodeURIComponent(org)}?pagelen=100`, { items: (d) => d?.values || [], next: nextOf });
    return list.map((r) => ({
      id: r.uuid,
      name: r.slug,
      fullName: r.full_name,
      cloneUrl: stripUser((r.links?.clone || []).find((c) => c.name === 'https')?.href || `https://bitbucket.org/${r.full_name}.git`),
      webUrl: r.links?.html?.href,
      defaultBranch: r.mainbranch?.name || null,
      archived: false,
      fork: Boolean(r.parent),
      private: Boolean(r.is_private),
      empty: !r.mainbranch,
      sizeKb: Number.isFinite(r.size) ? Math.round(r.size / 1024) : null,
      language: r.language || null,
      createdAt: r.created_on || null,
      pushedAt: r.updated_on || null,
    }));
  },

  gitHosts() {
    return ['bitbucket.org'];
  },

  gitAuthHeader(conn, secret) {
    const m = conn.auth?.method;
    if (m === 'access-token') return basic('x-token-auth', secret.token);
    if (m === 'api-token') return basic('x-bitbucket-api-token-auth', secret.token);
    return basic(secret.username || '', secret.token);
  },

  archive(repo) {
    return { url: `https://bitbucket.org/${repo.fullName}/get/${encodeURIComponent(repo.defaultBranch)}.tar.gz`, format: 'tgz' };
  },

  async commits(api, repo, since) {
    // Newest first, no date filter: read pages until a commit is older than the window.
    const sinceT = Date.parse(since);
    const out = [];
    let lastCommitAt = null;
    let url = `/repositories/${repo.fullName}/commits/${encodeURIComponent(repo.defaultBranch)}?pagelen=100`;
    const seen = new Set();
    while (url && !seen.has(url) && seen.size < MAX_PAGES) {
      seen.add(url);
      const page = await api.get(url, { allow404: true });
      const items = page?.values || [];
      let older = false;
      for (const c of items) {
        const t = Date.parse(c.date);
        lastCommitAt ??= c.date;
        if (t < sinceT) {
          older = true;
          break;
        }
        out.push({ t, email: (c.author?.raw?.match(/<([^>]+)>/) || [])[1] || c.author?.user?.uuid || '', name: c.author?.user?.display_name || String(c.author?.raw || '').replace(/<[^>]*>/, '').trim(), merge: (c.parents?.length || 0) > 1 });
      }
      url = older ? null : page?.next || null;
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
