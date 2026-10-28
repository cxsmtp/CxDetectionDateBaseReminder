// Vendored from cloc-fusion 1.3.2 (commit 1a320621d0f5), MIT licence: src/cloc-fusion/LICENSE. Do not edit here: scripts/sync-cloc-fusion.mjs copies it again.
// Azure DevOps Services (dev.azure.com) and Azure DevOps Server. Organizations are Azure DevOps
// organizations (Server: collections); every project's Git repositories are included.
import { ApiClient, basic } from '../http.js';

const API = 'api-version=7.1';
const VSSPS = 'https://app.vssps.visualstudio.com';
// The Azure DevOps resource id, for Microsoft Entra ID tokens.
const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

const isCloud = (conn) => !conn.apiUrl || /(^|\.)dev\.azure\.com$|\.visualstudio\.com$/i.test(new URL(conn.apiUrl).host);

export default {
  id: 'azure',
  label: 'Azure DevOps (Services or Server)',
  defaultApiUrl: 'https://dev.azure.com',
  apiUrlHint: 'https://dev.azure.com — Server: https://<host>/tfs (collections are the organizations)',
  orgNoun: 'organization',
  authMethods: [
    {
      id: 'pat',
      label: 'Personal access token',
      help: [
        'Create one at https://dev.azure.com/<org>/_usersSettings/tokens (User settings → Personal access tokens).',
        'Organization: "All accessible organizations" so every organization can be listed and scanned.',
        'Scopes: Code (Read), plus User Profile (Read) so the tool can list your organizations for you.',
      ],
    },
    {
      id: 'entra',
      label: 'Microsoft Entra ID via Azure CLI (az login: browser / SSO, works with Okta federation)',
      help: [
        'Runs `az account get-access-token` each time; sign in first with `az login`',
        '  (`az login --allow-no-subscriptions` if your account has no Azure subscription).',
        'Tokens last about an hour; the tool asks for a fresh one when it starts.',
      ],
      tokenCommand: () => ['az', 'account', 'get-access-token', '--resource', ADO_RESOURCE, '--query', 'accessToken', '-o', 'tsv'],
      bearer: true,
    },
  ],

  authHeader(conn, secret) {
    return conn.auth?.method === 'entra' ? `Bearer ${secret.token}` : basic('', secret.token);
  },

  client(conn, secret) {
    return new ApiClient({ name: 'Azure DevOps', baseUrl: (conn.apiUrl || this.defaultApiUrl).replace(/\/+$/, ''), headers: { Authorization: this.authHeader(conn, secret) }, trustedOrigins: isCloud(conn) ? [VSSPS] : [] });
  },

  async whoami(api, conn) {
    if (!isCloud(conn)) {
      const data = await api.get(`/_apis/connectionData`);
      return data?.authenticatedUser?.providerDisplayName || 'signed in';
    }
    try {
      const me = await api.get(`${VSSPS}/_apis/profile/profiles/me?${API}`);
      return me.emailAddress || me.displayName || me.id;
    } catch (err) {
      // A token without the User Profile scope, or made for one organization: checked per organization later.
      if ([401, 403].includes(err.status)) return null;
      throw err;
    }
  },

  async listOrgs(api, conn) {
    if (!isCloud(conn)) {
      const data = await api.get(`/_apis/projectCollections?${API}`);
      return (data?.value || []).map((c) => ({ id: c.name, label: c.name }));
    }
    const me = await api.get(`${VSSPS}/_apis/profile/profiles/me?${API}`);
    const data = await api.get(`${VSSPS}/_apis/accounts?memberId=${encodeURIComponent(me.id)}&${API}`);
    return (data?.value || []).map((a) => ({ id: a.accountName, label: a.accountName }));
  },

  async listRepos(api, org, conn) {
    const base = (conn.apiUrl || this.defaultApiUrl).replace(/\/+$/, '');
    const data = await api.get(`${base}/${encodeURIComponent(org)}/_apis/git/repositories?${API}`);
    return (data?.value || []).map((r) => ({
      id: r.id,
      name: r.name,
      fullName: `${org}/${r.project?.name}/${r.name}`,
      project: r.project?.name,
      cloneUrl: stripUser(r.remoteUrl),
      webUrl: r.webUrl,
      defaultBranch: r.defaultBranch ? r.defaultBranch.replace(/^refs\/heads\//, '') : null,
      archived: Boolean(r.isDisabled),
      fork: Boolean(r.isFork),
      private: r.project?.visibility !== 'public',
      empty: !r.defaultBranch || r.size === 0,
      sizeKb: Number.isFinite(r.size) ? Math.round(r.size / 1024) : null,
      language: null,
      createdAt: null,
      pushedAt: r.project?.lastUpdateTime || null,
    }));
  },

  gitHosts(conn) {
    if (!isCloud(conn)) return [new URL(conn.apiUrl).host.toLowerCase()];
    return null; // dev.azure.com or <org>.visualstudio.com: checked by suffix in allowedHost
  },

  allowedHost(conn, host) {
    if (!isCloud(conn)) return host === new URL(conn.apiUrl).host.toLowerCase();
    return host === 'dev.azure.com' || host.endsWith('.visualstudio.com');
  },

  gitAuthHeader(conn, secret) {
    return this.authHeader(conn, secret);
  },

  repoApi(repo, conn) {
    const base = (conn.apiUrl || this.defaultApiUrl).replace(/\/+$/, '');
    return `${base}/${encodeURIComponent(repo.org)}/${encodeURIComponent(repo.project)}/_apis/git/repositories/${encodeURIComponent(repo.id)}`;
  },

  archive(repo, conn) {
    const v = encodeURIComponent(repo.defaultBranch);
    return { url: `${this.repoApi(repo, conn)}/items?path=%2F&versionDescriptor.versionType=branch&versionDescriptor.version=${v}&%24format=zip&download=true&${API}`, format: 'zip' };
  },

  async commits(api, repo, since, conn) {
    const v = encodeURIComponent(repo.defaultBranch);
    const base = `${this.repoApi(repo, conn)}/commits?searchCriteria.itemVersion.version=${v}&${API}`;
    const out = [];
    for (let skip = 0; skip < 10000000; skip += 1000) {
      const page = await api.get(`${base}&searchCriteria.fromDate=${encodeURIComponent(since)}&searchCriteria.%24top=1000&searchCriteria.%24skip=${skip}`);
      const items = page?.value || [];
      // The list has no parents; Azure DevOps names pull request merges "Merged PR …".
      for (const c of items) out.push({ t: Date.parse(c.committer?.date || c.author?.date), email: c.author?.email || '', name: c.author?.name || '', merge: /^Merged PR \d+/.test(c.comment || '') });
      if (items.length < 1000) break;
    }
    if (!out.length) {
      const last = await api.get(`${base}&searchCriteria.%24top=1`);
      return { commits: out, lastCommitAt: last?.value?.[0]?.committer?.date ?? null };
    }
    return { commits: out };
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
