/**
 * Protected branches, and the primary branch they suggest.
 *
 * A project's primary branch is set in Checkmarx One; when it is not, the best guess is the branch its
 * git host protects, in an order most teams share: main, master, trunk, then develop, release, security,
 * hotfix and production branches. This module holds that order (an Admin can change it), matches branch
 * names against it, and reads what each git host protects:
 *
 * - GitHub: GET /repos/{owner}/{repo}/branches?protected=true
 * - GitLab: GET /projects/{path}/protected_branches (names may be wildcards: release/*)
 * - Azure DevOps: branch policies on the repository (GET {project}/_apis/policy/configurations)
 * - Bitbucket Cloud: GET /repositories/{workspace}/{repo}/branch-restrictions;
 *   Data Center: GET /rest/branch-permissions/2.0/projects/{project}/repos/{repo}/restrictions
 *
 * Every read uses the tokens already set for the git hosts (Settings → Beta features), each only on its
 * own host. A repository on a host with no connection is read from Checkmarx One alone.
 */

import { branchName } from './cxone/branches.js';
import { onGitHub, parseRepoUrl } from './github/blame.js';
import { cloneAuthFor, providerOf, SCM_LABELS } from './scm/providers.js';

/** The order protected branches are suggested in: each entry is one or more names or globs, separated by |. */
export const DEFAULT_ORDER = Object.freeze(['main', 'master', 'trunk', 'develop|dev|development', 'release/*|release|releases/*', 'security|security/*', 'hotfix/*|hotfix', 'prod|production|stable|live']);

const MAX_ORDER = 20;
const MAX_PATTERN = 120;

/** An order as an Admin typed it: up to 20 entries of names and globs, nothing else. */
export function cleanOrder(list) {
  if (!Array.isArray(list)) return [...DEFAULT_ORDER];
  const out = [];
  for (const item of list) {
    const alternatives = String(item ?? '')
      .split('|')
      .map((x) => x.trim().replace(/^refs\/heads\//, ''))
      .filter((x) => x && x.length <= MAX_PATTERN && /^[\w./*+@-]+$/.test(x));
    const entry = [...new Set(alternatives)].join('|');
    if (entry && !out.includes(entry)) out.push(entry);
    if (out.length >= MAX_ORDER) break;
  }
  return out.length ? out : [...DEFAULT_ORDER];
}

const globCache = new Map();
/** A glob (* for any run of characters) as a regular expression, matched whole and without case. */
function globRe(glob) {
  let re = globCache.get(glob);
  if (!re) {
    re = new RegExp(`^${glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
    if (globCache.size > 500) globCache.clear();
    globCache.set(glob, re);
  }
  return re;
}

/** Does a branch name match a pattern (a name or a glob, or several separated by |)? */
export function matchesPattern(name, pattern) {
  const branch = branchName(name);
  if (!branch) return false;
  return String(pattern ?? '')
    .split('|')
    .some((alt) => alt && globRe(alt.trim()).test(branch));
}

/** Where a branch comes in the order (0 first); Infinity when it matches no entry. */
export function rankIn(name, order = DEFAULT_ORDER) {
  const i = order.findIndex((pattern) => matchesPattern(name, pattern));
  return i < 0 ? Infinity : i;
}

/** Is a branch protected, by the names and patterns its git host protects? */
export const isProtected = (name, protectedNames = []) => protectedNames.some((p) => matchesPattern(name, p));

/** Branch names (no globs) sorted by the order, then by name. */
export function sortByOrder(names, order = DEFAULT_ORDER) {
  return [...new Set(names.map(branchName).filter(Boolean))].sort((a, b) => rankIn(a, order) - rankIn(b, order) || a.localeCompare(b));
}

/**
 * The primary branch to suggest for a project: of the branches it has (`branches`: scanned in Checkmarx One,
 * and those its git host lists), the protected one that comes first in the order; with no protected branch
 * known (no git host read), the branch that comes first in the order among the first three entries (main,
 * master, trunk). { branch, why: 'protected' | 'pattern' | '' }.
 */
export function suggestPrimary({ branches = [], protectedNames = [], order = DEFAULT_ORDER } = {}) {
  const names = [...new Set(branches.map(branchName).filter(Boolean))];
  // A protected name the host gives as a plain name counts even when no scan ran on it yet.
  for (const p of protectedNames) if (p && !p.includes('*') && !names.includes(branchName(p))) names.push(branchName(p));
  const protectedOnes = names.filter((n) => isProtected(n, protectedNames));
  if (protectedOnes.length) {
    const ranked = sortByOrder(protectedOnes, order);
    return { branch: ranked[0], why: 'protected' };
  }
  const leading = order.slice(0, 3);
  const guessed = sortByOrder(names.filter((n) => rankIn(n, leading) !== Infinity), leading);
  return guessed.length ? { branch: guessed[0], why: 'pattern' } : { branch: '', why: '' };
}

const MAX_NAMES = 200;
const names = (list) => [...new Set(list.map((n) => branchName(n)).filter(Boolean))].slice(0, MAX_NAMES);

/**
 * What a repository's git host protects. `hosts`: { github: GitHubClient|null, githubApiUrl, configs, clients }
 * (scmConfigs and scmClients). Resolves { provider, label, repo, names, error }: provider '' when the address
 * is not on a connected host (or not a repository address at all).
 */
export async function readProtected(repoUrl, hosts) {
  const repo = parseRepoUrl(repoUrl);
  if (!repo) return { provider: '', label: '', repo: '', names: [], error: '' };
  const where = `${repo.owner}/${repo.repo}`;
  const provider = providerOf(repo, hosts.configs, hosts.githubApiUrl);
  const base = { provider, label: SCM_LABELS[provider] ?? '', repo: where, names: [], error: '' };
  try {
    if (provider === 'github') {
      if (!hosts.github || !onGitHub(repo, hosts.githubApiUrl)) return { ...base, provider: '' };
      const body = await hosts.github.rest(`/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/branches`, { protected: 'true', per_page: 100 });
      return { ...base, names: names((Array.isArray(body) ? body : []).map((b) => b?.name)) };
    }
    if (provider === 'gitlab') {
      if (!hosts.configs.gitlab.token) return { ...base, provider: '' };
      const body = await hosts.clients.gitlab.get(`/projects/${encodeURIComponent(where)}/protected_branches`, { per_page: 100 });
      return { ...base, names: names((Array.isArray(body) ? body : []).map((b) => b?.name)) };
    }
    if (provider === 'azure') {
      // A token belongs to one organisation: only its repositories are read.
      if (!hosts.clients.azure || !cloneAuthFor(repo.cloneUrl, hosts.configs, 'azure')) return { ...base, provider: '' };
      const project = repo.owner.split('/').at(-1);
      const org = hosts.clients.azure.org;
      const meta = await org.get(`/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo.repo)}`, { 'api-version': '7.1' });
      const repoId = String(meta?.id ?? '');
      const policies = await org.get(`/${encodeURIComponent(project)}/_apis/policy/configurations`, { 'api-version': '7.1' });
      const found = [];
      for (const policy of Array.isArray(policies?.value) ? policies.value : []) {
        if (policy?.isEnabled === false || policy?.isDeleted) continue;
        for (const scope of Array.isArray(policy?.settings?.scope) ? policy.settings.scope : []) {
          if (scope?.repositoryId && repoId && String(scope.repositoryId) !== repoId) continue;
          const ref = String(scope?.refName ?? '');
          if (!ref.startsWith('refs/heads/')) continue;
          found.push(String(scope?.matchKind).toLowerCase() === 'prefix' ? `${branchName(ref)}*` : ref);
        }
      }
      return { ...base, names: names(found) };
    }
    if (provider === 'bitbucket') {
      if (!hosts.configs.bitbucket.token) return { ...base, provider: '' };
      const client = hosts.clients.bitbucket;
      if (hosts.configs.bitbucket.kind === 'cloud') {
        const body = await client.get(`/repositories/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/branch-restrictions`, { pagelen: 100 });
        const list = (Array.isArray(body?.values) ? body.values : []).filter((r) => r?.branch_match_kind !== 'branching_model').map((r) => r?.pattern);
        return { ...base, names: names(list) };
      }
      const project = repo.owner.replace(/^scm\//i, '');
      const body = await client.get(`/rest/branch-permissions/2.0/projects/${encodeURIComponent(project)}/repos/${encodeURIComponent(repo.repo)}/restrictions`, { limit: 100 });
      const list = (Array.isArray(body?.values) ? body.values : [])
        .map((r) => r?.matcher)
        .filter((m) => ['BRANCH', 'PATTERN'].includes(String(m?.type?.id ?? '').toUpperCase()))
        .map((m) => m?.displayId ?? m?.id);
      return { ...base, names: names(list) };
    }
  } catch (error) {
    const status = Number(error?.status) || 0;
    const reason = status === 401 || status === 403 ? 'the token may not read branch protection here' : status === 404 ? 'not found, or the token cannot see it' : 'not readable now';
    return { ...base, error: `${base.label}: ${reason}.` };
  }
  return base;
}
