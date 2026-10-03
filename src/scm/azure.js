/**
 * Azure DevOps (Services, or Server): usernames to addresses. Azure DevOps has no public
 * blame API, so blame is git blame on a clone made with the personal access token.
 *
 * Usernames → addresses, cheapest first:
 *   localGit    git history of named repositories — no API calls;
 *   graph       the organisation's user directory (Graph API), a few requests for everyone:
 *               sign-in name, mail address and display name;
 *   identities  identity search, one request per user (also on Azure DevOps Server);
 *   commits     commits by that author in repositories you name (project/repository).
 */

import { byLocalGit, usableEmail } from '../github/identity.js';
import { mapWithConcurrency } from '../cxone/client.js';
import { ScmClient } from './client.js';
import { directoryMatcher, validUsername } from './identity.js';

export const AZURE_LABELS = {
  localGit: 'Local git history',
  graph: 'Organisation directory (Graph)',
  identities: 'Identity search',
  commits: 'Commit author',
};

/** https://dev.azure.com/acme → https://vssps.dev.azure.com/acme; acme.visualstudio.com → acme.vssps.visualstudio.com; Server: itself. */
export function vsspsUrl(orgUrl) {
  const url = new URL(orgUrl);
  if (url.host === 'dev.azure.com') return `https://vssps.dev.azure.com${url.pathname.replace(/\/+$/, '')}`;
  if (url.host.endsWith('.visualstudio.com')) return `https://${url.host.replace(/\.visualstudio\.com$/, '.vssps.visualstudio.com')}`;
  return String(orgUrl).replace(/\/+$/, '');
}

/** Two hosts (the organisation, and its directory), one request count. */
export function azureClient(cfg, fetchImpl = fetch) {
  const auth = cfg.token ? `Basic ${Buffer.from(`:${cfg.token}`).toString('base64')}` : '';
  const org = new ScmClient({ name: 'Azure DevOps', baseUrl: cfg.orgUrl, auth, fetchImpl });
  const graph = new ScmClient({ name: 'Azure DevOps directory', baseUrl: vsspsUrl(cfg.orgUrl), auth, fetchImpl });
  return {
    org,
    graph,
    services: /dev\.azure\.com|visualstudio\.com/.test(cfg.orgUrl),
    get hasToken() {
      return org.hasToken;
    },
    get totalRequests() {
      return org.totalRequests + graph.totalRequests;
    },
  };
}

const API = { 'api-version': '7.1' };

async function byGraph(client, logins) {
  const entries = [];
  let continuation = '';
  for (let page = 0; page < 40; page += 1) {
    const { body, headers } = await client.graph.send('/_apis/graph/users', { query: { 'api-version': '7.1-preview.1', subjectTypes: 'aad,msa,vsts', ...(continuation ? { continuationToken: continuation } : {}) } });
    for (const user of body?.value ?? []) {
      const email = [user.mailAddress, user.principalName].find(usableEmail);
      if (!email) continue;
      entries.push({
        keys: [user.principalName, user.mailAddress, user.displayName, user.directoryAlias, String(user.principalName ?? '').split('@')[0]].filter(Boolean),
        name: user.displayName ?? '',
        email,
        evidence: 'Azure DevOps organisation directory',
      });
    }
    continuation = headers.get('x-ms-continuationtoken') ?? '';
    if (!continuation) break;
  }
  const match = directoryMatcher(entries);
  const results = {};
  for (const login of logins) {
    const hit = match(login);
    if (hit) results[login] = hit;
  }
  return { results, errors: [], directory: entries.length };
}

async function byIdentities(client, logins) {
  const results = {};
  const errors = [];
  await mapWithConcurrency(logins, 4, async (login) => {
    try {
      const body = await client.graph.get('/_apis/identities', { searchFilter: 'General', filterValue: login, queryMembership: 'None', ...API });
      const people = (body?.value ?? []).filter((i) => i.isActive !== false);
      const emails = new Set(people.map((i) => [i.properties?.Mail?.$value, i.properties?.Account?.$value].find(usableEmail)).filter(Boolean).map((e) => e.toLowerCase()));
      if (emails.size === 1) {
        const person = people[0];
        results[login] = { email: [...emails][0], confidence: 'high', evidence: 'Azure DevOps identity', name: person.providerDisplayName ?? '' };
      }
    } catch (error) {
      if (error.status !== 404) errors.push(`${login}: ${error.message}`);
    }
  });
  return { results, errors };
}

async function byCommits(client, logins, repos) {
  const results = {};
  const errors = [];
  await mapWithConcurrency(logins, 3, async (login) => {
    const counts = new Map();
    try {
      for (const entry of repos.slice(0, 5)) {
        const [project, repo] = entry.split('/');
        const body = await client.org.get(`/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/commits`, { 'searchCriteria.author': login, 'searchCriteria.$top': 30, ...API }).catch((error) => {
          if (error.status === 404) return null;
          throw error;
        });
        for (const c of body?.value ?? []) {
          if (!usableEmail(c.author?.email)) continue;
          const email = c.author.email.toLowerCase();
          counts.set(email, { count: (counts.get(email)?.count ?? 0) + 1, name: c.author.name ?? '' });
        }
        if (counts.size) break;
      }
    } catch (error) {
      errors.push(`${login}: ${error.message}`);
      return;
    }
    const [email, seen] = [...counts].sort((a, b) => b[1].count - a[1].count)[0] ?? [];
    if (email) results[login] = { email, confidence: seen.count >= 2 && counts.size === 1 ? 'high' : 'medium', evidence: `Author email on ${seen.count} commit(s)`, name: seen.name };
  });
  return { results, errors };
}

export function azureMethods(client, cfg, { localSources = [], cacheDir }) {
  const valid = (logins) => logins.filter((l) => validUsername('azure', l));
  return [
    { id: 'localGit', label: AZURE_LABELS.localGit, skip: localSources.length ? '' : 'No local repositories or clone URLs given.', run: (logins) => byLocalGit(valid(logins), localSources, { cacheDir, authFor: cfg.authFor }) },
    { id: 'graph', label: AZURE_LABELS.graph, skip: !client.hasToken ? 'Needs an Azure DevOps personal access token (Graph: read).' : client.services ? '' : 'The directory (Graph API) is on Azure DevOps Services only; use identity search on Azure DevOps Server.', run: (logins) => byGraph(client, valid(logins)) },
    { id: 'identities', label: AZURE_LABELS.identities, skip: client.hasToken ? '' : 'Needs an Azure DevOps personal access token (Identity: read).', run: (logins) => byIdentities(client, valid(logins)) },
    { id: 'commits', label: AZURE_LABELS.commits, skip: !client.hasToken ? 'Needs an Azure DevOps personal access token (Code: read).' : cfg.repos?.length ? '' : 'Name the repositories to search (project/repository) in the Azure DevOps connection.', run: (logins) => byCommits(client, valid(logins), cfg.repos) },
  ];
}

export async function azureCheck(client) {
  const data = await client.org.get('/_apis/connectionData');
  const who = data?.authenticatedUser?.providerDisplayName ?? '';
  if (!who || /anonymous/i.test(who)) throw Object.assign(new Error('Azure DevOps did not accept the token.'), { status: 401 });
  return { ok: true, who };
}
