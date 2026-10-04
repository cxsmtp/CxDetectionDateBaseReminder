/**
 * More than one connection to the same kind of git host: a second GitHub (an
 * Enterprise server next to github.com, or another organisation's token), a
 * second GitLab, and so on.
 *
 * The first connection of each host is the one the Beta page and the plain
 * variables (GITHUB_TOKEN, GITLAB_TOKEN, AZURE_DEVOPS_TOKEN, BITBUCKET_TOKEN)
 * set. More come from the same variables with a number: GITHUB_TOKEN_2 with
 * GITHUB_API_URL_2, GITLAB_TOKEN_2 with GITLAB_URL_2, up to _9. Each numbered
 * set is read as if it were the plain variables, so every rule that keeps a
 * token on its own host applies to it unchanged.
 */

export const MAX_INSTANCES = 9;

/** Each host's variables: its token, its address, and the rest. */
export const INSTANCE_VARS = {
  github: { token: 'GITHUB_TOKEN', url: 'GITHUB_API_URL', other: ['GITHUB_ORG'] },
  gitlab: { token: 'GITLAB_TOKEN', url: 'GITLAB_URL', other: ['GITLAB_GROUP'] },
  azure: { token: 'AZURE_DEVOPS_TOKEN', url: 'AZURE_DEVOPS_ORG_URL', other: [] },
  bitbucket: { token: 'BITBUCKET_TOKEN', url: 'BITBUCKET_URL', other: ['BITBUCKET_USERNAME', 'BITBUCKET_WORKSPACE'] },
};

const BASE_NAMES = new Map(Object.entries(INSTANCE_VARS).flatMap(([provider, v]) => [v.token, v.url, ...v.other].map((name) => [name, provider])));
export const TOKEN_NAMES = new Set(Object.values(INSTANCE_VARS).map((v) => v.token));

/** GITLAB_TOKEN_2 → {name: 'GITLAB_TOKEN', provider: 'gitlab', n: 2}; anything else → null. */
export function numberedVariable(name) {
  const match = /^([A-Z_]+)_([2-9])$/.exec(String(name));
  if (!match || !BASE_NAMES.has(match[1])) return null;
  return { name: match[1], provider: BASE_NAMES.get(match[1]), n: Number(match[2]) };
}

const clean = (value) => String(value ?? '').trim();

/** Numbered sets stored from an uploaded .env file: {"2": {GITHUB_TOKEN: …}}, only known names. */
export function cleanStoredInstances(stored) {
  const out = {};
  for (const [n, vars] of Object.entries(stored ?? {})) {
    if (!/^[2-9]$/.test(n) || !vars || typeof vars !== 'object') continue;
    const set = {};
    for (const [name, value] of Object.entries(vars)) if (BASE_NAMES.has(name) && clean(value)) set[name] = clean(value).slice(0, 2000);
    if (Object.keys(set).length) out[n] = set;
  }
  return out;
}

/**
 * Merge numbered variables from an uploaded .env file into the stored sets.
 * A new address without a new token in the same file drops the stored token:
 * a token is never sent to a host it was not given for.
 */
export function mergeStoredInstances(stored, incoming) {
  const next = cleanStoredInstances(stored);
  for (const [n, vars] of Object.entries(incoming ?? {})) {
    const set = { ...(next[n] ?? {}) };
    for (const v of Object.values(INSTANCE_VARS)) {
      const newUrl = clean(vars[v.url]);
      if (newUrl && newUrl.replace(/\/+$/, '') !== clean(set[v.url]).replace(/\/+$/, '') && !clean(vars[v.token])) delete set[v.token];
    }
    for (const [name, value] of Object.entries(vars)) if (BASE_NAMES.has(name) && clean(value)) set[name] = clean(value);
    next[n] = set;
  }
  return cleanStoredInstances(next);
}

/** The numbers (2–9) that have a set, from the environment or stored, in order. */
export function extraInstanceNumbers(settings, source = process.env) {
  const numbers = new Set(Object.keys(cleanStoredInstances(settings?.beta?.instances)).map(Number));
  for (const name of Object.keys(source ?? {})) {
    const numbered = numberedVariable(name);
    if (numbered && clean(source[name])) numbers.add(numbered.n);
  }
  return [...numbers].sort((a, b) => a - b);
}

/**
 * Set `n` read as the plain variables: GITHUB_TOKEN_2 becomes GITHUB_TOKEN.
 * What an uploaded .env file stored wins over the environment, as for the first set.
 */
export function instanceSource(settings, n, source = process.env) {
  const stored = cleanStoredInstances(settings?.beta?.instances)[n] ?? {};
  const fromEnv = (name) => clean(source?.[`${name}_${n}`]);
  const out = {};
  for (const v of Object.values(INSTANCE_VARS)) {
    for (const name of v.other) if (stored[name] || fromEnv(name)) out[name] = stored[name] || fromEnv(name);
    const url = stored[v.url] || fromEnv(v.url);
    // The environment's token only goes with the environment's address: a stored address never takes it elsewhere.
    const token = stored[v.token] || (url === fromEnv(v.url) ? fromEnv(v.token) : '');
    if (url) out[v.url] = url;
    if (token) out[v.token] = token;
  }
  return out;
}

/** Which providers set `n` names (a token or an address). */
export function providersIn(vars) {
  return Object.entries(INSTANCE_VARS)
    .filter(([, v]) => clean(vars[v.token]) || clean(vars[v.url]))
    .map(([provider]) => provider);
}

/**
 * The set whose connection fits a repository best: its host has a token there,
 * and (when two sets share a host, like two github.com tokens) its organisation,
 * group or workspace is the repository's owner. `sets`: [{n, hosts: [{host, owner}]}].
 */
export function setForRepo(sets, repo) {
  if (!repo?.host) return sets[0];
  const host = repo.host.toLowerCase();
  const owner = String(repo.owner ?? '').toLowerCase().split('/')[0];
  let best = sets[0];
  let bestScore = 0;
  for (const set of sets) {
    for (const h of set.hosts) {
      if (h.host !== host) continue;
      const score = 1 + (h.owner && h.owner === owner ? 1 : 0);
      if (score > bestScore) [best, bestScore] = [set, score];
    }
  }
  return best;
}
