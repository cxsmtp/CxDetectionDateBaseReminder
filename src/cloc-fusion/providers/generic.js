// Vendored from cloc-fusion 1.3.2 (commit 1a320621d0f5), MIT licence: src/cloc-fusion/LICENSE. Do not edit here: scripts/sync-cloc-fusion.mjs copies it again.
// Any other Git server (Gitea, Gerrit, AWS CodeCommit over HTTPS, a plain git host…): a list of
// clone URLs, with an optional username + token for HTTPS basic auth.
import { basic } from '../http.js';

export default {
  id: 'generic',
  label: 'Any other Git server (a list of clone URLs)',
  defaultApiUrl: '',
  apiUrlHint: '',
  orgNoun: 'group',
  authMethods: [
    { id: 'none', label: 'No authentication (public repos, or git credentials already set up on this machine)', help: [] },
    { id: 'basic', label: 'Username + password / token over HTTPS', needsUsername: 'Username', help: ['Whatever your server accepts for `git clone https://…`.'] },
    { id: 'bearer', label: 'Bearer token header', help: ['Sent as "Authorization: Bearer <token>" to git.'] },
  ],

  client() {
    return null;
  },

  async whoami() {
    return 'git';
  },

  async listOrgs(_api, conn) {
    return [{ id: conn.name, label: conn.name }];
  },

  async listRepos(_api, _org, conn) {
    return (conn.repos || []).map((entry) => {
      const url = typeof entry === 'string' ? entry : entry.url;
      const name = (typeof entry === 'object' && entry.name) || url.replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop();
      let fullName = name;
      try {
        fullName = new URL(url).pathname.replace(/^\/+|\.git$/g, '') || name;
      } catch {}
      return { id: url, name, fullName, cloneUrl: url, webUrl: null, defaultBranch: (typeof entry === 'object' && entry.branch) || null, archived: false, fork: false, private: true, empty: false, sizeKb: null, language: null, createdAt: null, pushedAt: null };
    });
  },

  gitAuthHeader(conn, secret) {
    const m = conn.auth?.method;
    if (m === 'basic' && secret.token) return basic(secret.username || '', secret.token);
    if (m === 'bearer' && secret.token) return `Bearer ${secret.token}`;
    return null;
  },
};
