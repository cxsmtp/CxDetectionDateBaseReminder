/**
 * The source-code hosts the beta features know: GitHub, GitLab, Azure DevOps and Bitbucket
 * (cloud or self-hosted). From the settings (or GITLAB_*, AZURE_DEVOPS_*, BITBUCKET_* in the
 * environment): which host a repository is on, how to clone it (each token only ever goes
 * to its own host), how to blame through the host's API, and how to match usernames.
 */

import { gitHostOf } from '../github/identity.js';
import { AZURE_LABELS, azureCheck, azureClient, azureMethods } from './azure.js';
import { BITBUCKET_LABELS, bitbucketBlame, bitbucketCheck, bitbucketClient, bitbucketCloneAuth, bitbucketMethods, isCloud } from './bitbucket.js';
import { explainGit } from '../troubleshoot.js';
import { GITLAB_LABELS, gitlabBlame, gitlabCheck, gitlabClient, gitlabMethods, gitlabWebUrl } from './gitlab.js';
import { azureOrgKey, normalizeAzureOrgUrl } from './azure-url.js';

export const SCM_PROVIDERS = ['github', 'gitlab', 'azure', 'bitbucket'];
export const SCM_LABELS = { github: 'GitHub', gitlab: 'GitLab', azure: 'Azure DevOps', bitbucket: 'Bitbucket' };
export const METHOD_LABELS = { gitlab: GITLAB_LABELS, azure: AZURE_LABELS, bitbucket: BITBUCKET_LABELS };

const hostOf = (url) => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
};
const env = (source, name) => String(source[name] ?? '').trim();

/**
 * A token from the environment goes only to the host the environment names (or, when it names
 * none, the provider's public host): changing the address in Settings never redirects it.
 */
const sameHost = (a, b) => {
  const norm = (h) => (h === 'bitbucket.org' ? 'api.bitbucket.org' : h);
  return Boolean(a) && norm(a) === norm(b);
};
function environmentToken(source, tokenName, urlName, defaultHost, effectiveUrl) {
  const token = env(source, tokenName);
  if (!token) return '';
  return sameHost(hostOf(effectiveUrl), hostOf(env(source, urlName)) || defaultHost) ? token : '';
}

/** Each host's connection: what Settings stores, else the environment. Tokens included (server side only). */
export function scmConfigs(settings, source = process.env) {
  const beta = settings.beta ?? {};
  const gl = beta.gitlab ?? {};
  const az = beta.azure ?? {};
  const bb = beta.bitbucket ?? {};
  const gitlabApi = (gl.apiUrl || env(source, 'GITLAB_URL') || 'https://gitlab.com').replace(/\/+$/, '');
  const gitlabUrl = /\/api\/v4$/.test(gitlabApi) ? gitlabApi : `${gitlabApi}/api/v4`;
  const gitlabEnvToken = environmentToken(source, 'GITLAB_TOKEN', 'GITLAB_URL', 'gitlab.com', gitlabUrl);
  const gitlab = {
    apiUrl: gitlabUrl,
    token: gl.token || gitlabEnvToken,
    tokenSource: gl.token ? 'settings' : gitlabEnvToken ? 'environment' : 'none',
    group: gl.group || env(source, 'GITLAB_GROUP'),
    projects: gl.projects ?? [],
  };
  gitlab.host = hostOf(gitlab.apiUrl);
  const azureUrl = normalizeAzureOrgUrl(az.orgUrl || env(source, 'AZURE_DEVOPS_ORG_URL'));
  // The .env token is for the .env organisation (any form of its address), or any on dev.azure.com when it names none.
  const azureEnvUrl = normalizeAzureOrgUrl(env(source, 'AZURE_DEVOPS_ORG_URL'));
  const azureEnvToken = env(source, 'AZURE_DEVOPS_TOKEN') && (azureEnvUrl ? azureOrgKey(azureEnvUrl) === azureOrgKey(azureUrl) : hostOf(azureUrl || 'https://dev.azure.com') === 'dev.azure.com') ? env(source, 'AZURE_DEVOPS_TOKEN') : '';
  const azure = {
    orgUrl: azureUrl,
    token: az.token || azureEnvToken,
    tokenSource: az.token ? 'settings' : azureEnvToken ? 'environment' : 'none',
    repos: az.repos ?? [],
  };
  azure.host = hostOf(azure.orgUrl);
  const kind = bb.kind || (env(source, 'BITBUCKET_URL') && !/bitbucket\.org/.test(env(source, 'BITBUCKET_URL')) ? 'server' : 'cloud');
  const bitbucket = {
    kind,
    apiUrl: (bb.apiUrl || env(source, 'BITBUCKET_URL') || 'https://api.bitbucket.org/2.0').replace(/\/+$/, ''),
    username: bb.username || env(source, 'BITBUCKET_USERNAME'),
    token: bb.token,
    workspace: bb.workspace || env(source, 'BITBUCKET_WORKSPACE'),
    repos: bb.repos ?? [],
  };
  if (kind === 'cloud' && /bitbucket\.org$/.test(hostOf(bitbucket.apiUrl)) && !/api\.bitbucket\.org/.test(bitbucket.apiUrl)) bitbucket.apiUrl = 'https://api.bitbucket.org/2.0';
  const bitbucketEnvToken = environmentToken(source, 'BITBUCKET_TOKEN', 'BITBUCKET_URL', 'api.bitbucket.org', bitbucket.apiUrl);
  bitbucket.token = bb.token || bitbucketEnvToken;
  bitbucket.tokenSource = bb.token ? 'settings' : bitbucketEnvToken ? 'environment' : 'none';
  bitbucket.host = kind === 'cloud' ? 'bitbucket.org' : hostOf(bitbucket.apiUrl);
  const configs = { gitlab, azure, bitbucket };
  for (const [id, cfg] of Object.entries(configs)) cfg.authFor = (url) => cloneAuthFor(url, configs, id);
  return configs;
}

/** Which host a repository ({host, owner}) is on: 'github', 'gitlab', 'azure', 'bitbucket' or ''. */
export function providerOf(repo, configs, githubApiUrl = 'https://api.github.com') {
  if (!repo?.host) return '';
  const host = repo.host.toLowerCase();
  if (host === 'github.com' || host === gitHostOf(githubApiUrl)) return 'github';
  if (host === 'gitlab.com' || (configs.gitlab.host && host === configs.gitlab.host)) return 'gitlab';
  if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com') || (configs.azure.host && host === configs.azure.host)) return 'azure';
  if (host === 'bitbucket.org' || (configs.bitbucket.host && host === configs.bitbucket.host)) return 'bitbucket';
  return '';
}

/**
 * The Authorization header for cloning `url` with the matching host's token, or '' — never a
 * token for another host. Azure DevOps tokens belong to one organisation: only its repositories.
 */
export function cloneAuthFor(url, configs, only = '') {
  const host = hostOf(url);
  if (!host) return '';
  const { gitlab, azure, bitbucket } = configs;
  if ((!only || only === 'gitlab') && gitlab.token && host === gitlab.host) return `Basic ${Buffer.from(`oauth2:${gitlab.token}`).toString('base64')}`;
  // Azure DevOps tokens belong to one organisation: its repositories only, whichever form their address takes
  // (dev.azure.com/acme/… or acme.visualstudio.com/…).
  if ((!only || only === 'azure') && azure.token && azure.orgUrl) {
    const org = azureOrgKey(azure.orgUrl);
    const repo = azureOrgKey(url);
    const server = !org.startsWith('dev.azure.com/');
    if (server ? host === azure.host : repo === org) return `Basic ${Buffer.from(`:${azure.token}`).toString('base64')}`;
  }
  if ((!only || only === 'bitbucket') && bitbucket.token && host === bitbucket.host) return bitbucketCloneAuth(bitbucket);
  return '';
}

/** API clients for the hosts that are set up (a token, or a self-hosted address). */
export function scmClients(configs, fetchImpl = fetch) {
  return {
    gitlab: gitlabClient(configs.gitlab, fetchImpl),
    azure: configs.azure.orgUrl ? azureClient(configs.azure, fetchImpl) : null,
    bitbucket: bitbucketClient(configs.bitbucket, fetchImpl),
  };
}

/** The username methods for a host, cheapest first. */
export function methodsFor(provider, clients, configs, { localSources = [], cacheDir }) {
  if (provider === 'gitlab') return gitlabMethods(clients.gitlab, configs.gitlab, { localSources, cacheDir });
  if (provider === 'azure') {
    if (!clients.azure) return [{ id: 'graph', label: AZURE_LABELS.graph, skip: 'Set the Azure DevOps organisation address first.', run: async () => ({ results: {} }) }];
    return azureMethods(clients.azure, configs.azure, { localSources, cacheDir });
  }
  if (provider === 'bitbucket') return bitbucketMethods(clients.bitbucket, configs.bitbucket, { localSources, cacheDir });
  return [];
}

/** Blame through the host's API, when it has one (GitLab, Bitbucket Data Center) and a token. null: use git blame. */
export function apiBlamer(provider, clients, configs) {
  if (provider === 'gitlab' && clients.gitlab.hasToken) return { via: 'GitLab blame', blame: (args) => gitlabBlame(clients.gitlab, args) };
  if (provider === 'bitbucket' && !isCloud(configs.bitbucket) && clients.bitbucket.hasToken) return { via: 'Bitbucket blame', blame: (args) => bitbucketBlame(clients.bitbucket, configs.bitbucket, args) };
  return null;
}

/** A link to a commit on its host, for a blame found with local git. */
export function commitUrl(provider, repo, sha, configs) {
  if (!sha || !repo) return '';
  if (provider === 'github' && repo.host === 'github.com') return `https://github.com/${repo.owner}/${repo.repo}/commit/${sha}`;
  if (provider === 'gitlab') return `${repo.host === configs.gitlab.host ? gitlabWebUrl(configs.gitlab.apiUrl) : `https://${repo.host}`}/${repo.owner}/${repo.repo}/-/commit/${sha}`;
  if (provider === 'azure') return `https://${repo.host}/${repo.owner}/_git/${repo.repo}/commit/${sha}`;
  if (provider === 'bitbucket') {
    if (repo.host === 'bitbucket.org') return `https://bitbucket.org/${repo.owner}/${repo.repo}/commits/${sha}`;
    return `https://${repo.host}/projects/${repo.owner.replace(/^scm\//i, '')}/repos/${repo.repo}/commits/${sha}`;
  }
  return '';
}

/** Is each host's token accepted? {gitlab: {ok, who|reason}, …} for the hosts that have one. */
export async function checkConnections(clients, configs, only = SCM_PROVIDERS) {
  const out = {};
  const run = async (id, fn) => {
    try {
      out[id] = await fn();
    } catch (error) {
      out[id] = { ok: false, reason: `${SCM_LABELS[id]} refused: ${error.message}`, help: explainGit(id, error, { url: configs[id]?.apiUrl || configs[id]?.orgUrl || '' }) };
    }
  };
  if (only.includes('gitlab') && configs.gitlab.token) await run('gitlab', () => gitlabCheck(clients.gitlab));
  if (only.includes('azure') && configs.azure.token && clients.azure) await run('azure', () => azureCheck(clients.azure));
  // A token alone does not say which organisation it is for.
  else if (only.includes('azure') && configs.azure.token) out.azure = { ok: false, reason: 'Azure DevOps: add the organisation, for example https://dev.azure.com/acme (or just acme). A token is made for one organisation.', help: explainGit('azure', new Error('organisation missing')) };
  if (only.includes('bitbucket') && configs.bitbucket.token) await run('bitbucket', () => bitbucketCheck(clients.bitbucket, configs.bitbucket));
  return out;
}
