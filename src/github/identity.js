/**
 * Map GitHub usernames (often the scan initiator of SCM-triggered scans) to
 * real email addresses. Four independent methods, each reporting what it
 * found, how sure it is and what it cost, so they can be compared on real data:
 *
 *   profile   REST GET /users/{login}: the public profile email. One request
 *             per user; only works when the user made the email public.
 *   commits   The email on the user's own commits: REST commits by author in
 *             the repositories you name, or commit search across an org.
 *             Finds hidden profile emails, since git records the author email.
 *   graphql   One GraphQL request per 50 users: public email plus
 *             organizationVerifiedDomainEmails (the org's verified-domain
 *             address, visible to org members even when the profile hides it).
 *   localGit  git log of repositories you have: commits made with GitHub's
 *             noreply address (ID+login@users.noreply.github.com) reveal the
 *             login; the same author name on other commits reveals the real
 *             address. No API calls at all.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { mapWithConcurrency } from '../cxone/client.js';

const run = promisify(execFile);
const EMAIL_RE = /^(?=[^]{3,254}$)[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const NOREPLY_RE = /^(?:(\d+)\+)?([a-z\d](?:[a-z\d-]{0,38}))@users\.noreply\.(?:github\.com|[\w.-]+)$/i;
const LOGIN_RE = /^[a-z\d](?:[a-z\d-]{0,38})$/i;

export const METHODS = ['localGit', 'graphql', 'commits', 'profile'];
export const METHOD_LABELS = {
  profile: 'Public profile (REST)',
  commits: 'Commit author (REST)',
  graphql: 'GraphQL batch',
  localGit: 'Local git history',
};

/** The username in a noreply address, or '': GitHub's ID+login@users.noreply…, GitLab's ID-username@users.noreply…. */
export function loginFromNoreply(email) {
  const value = String(email || '').trim();
  const gitlab = /^\d+-([\w.-]+)@users\.noreply\.(?!github\.com$)[\w.-]+$/i.exec(value);
  if (gitlab) return gitlab[1];
  const match = NOREPLY_RE.exec(value);
  return match ? match[2] : '';
}

/** A real, personal address: not noreply, not a bot, not a placeholder. */
export function usableEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(value)) return false;
  if (NOREPLY_RE.test(value)) return false;
  if (/(^|[.@])(noreply|no-reply|donotreply)([.@]|$)/.test(value)) return false;
  if (/\[bot\]|^bot@|dependabot|renovate|github-actions|action@github\.com/.test(value)) return false;
  if (/@(localhost|example\.(com|org)|.*\.local|.*\.localdomain)$/.test(value)) return false;
  return true;
}

export const validLogin = (login) => LOGIN_RE.test(String(login || '').trim());
const normName = (name) => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Rank candidate emails: most commits, then most recent. */
function best(candidates) {
  return [...candidates.values()].sort((a, b) => b.count - a.count || b.last - a.last)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Method 1 — public profile (REST, one request per user)
// ---------------------------------------------------------------------------

export async function byProfile(gh, logins) {
  const results = {};
  const errors = [];
  await mapWithConcurrency(logins, 4, async (login) => {
    try {
      const user = await gh.rest(`/users/${encodeURIComponent(login)}`);
      if (usableEmail(user?.email)) {
        results[login] = { email: user.email.toLowerCase(), confidence: 'high', evidence: 'Public email on the GitHub profile', name: user.name ?? '' };
      }
    } catch (error) {
      if (error.status !== 404) errors.push(`${login}: ${error.message}`);
    }
  });
  return { results, errors };
}

// ---------------------------------------------------------------------------
// Method 2 — author email on the user's own commits (REST)
// ---------------------------------------------------------------------------

/**
 * With `repos` ("owner/name"): list commits by author in each (cheap, core
 * rate limit). Without: commit search, optionally within `org` (search has
 * its own, much smaller limit — 30 requests a minute).
 */
export async function byCommits(gh, logins, { repos = [], org = '' } = {}) {
  const results = {};
  const errors = [];
  let limited = false;
  await mapWithConcurrency(logins, repos.length ? 4 : 1, async (login) => {
    if (limited) return;
    const candidates = new Map();
    const note = (author, when) => {
      const email = String(author?.email || '').toLowerCase();
      if (!usableEmail(email)) return;
      const c = candidates.get(email) ?? { email, count: 0, last: 0, name: author.name ?? '' };
      c.count += 1;
      c.last = Math.max(c.last, Date.parse(when || author?.date || 0) || 0);
      candidates.set(email, c);
    };
    try {
      if (repos.length) {
        for (const repo of repos.slice(0, 10)) {
          const commits = await gh.rest(`/repos/${repo}/commits`, { author: login, per_page: 30 }).catch((error) => {
            if (error.status === 404 || error.status === 409) return [];
            throw error;
          });
          for (const c of commits ?? []) note(c.commit?.author, c.commit?.author?.date);
          if (candidates.size) break;
        }
      } else {
        const q = `author:${login}${org ? ` org:${org}` : ''}`;
        const found = await gh.rest('/search/commits', { q, per_page: 30, sort: 'author-date', order: 'desc' });
        for (const item of found?.items ?? []) note(item.commit?.author, item.commit?.author?.date);
      }
    } catch (error) {
      if (error.status === 403 || error.status === 429) {
        limited = true;
        errors.push(`Rate limited after ${Object.keys(results).length} user(s): ${error.message}`);
        return;
      }
      if (error.status !== 404 && error.status !== 422) errors.push(`${login}: ${error.message}`);
      return;
    }
    const top = best(candidates);
    if (top) {
      results[login] = {
        email: top.email,
        confidence: top.count >= 2 ? 'high' : 'medium',
        evidence: `Author email on ${top.count} of their commit(s)${candidates.size > 1 ? ` (${candidates.size} addresses seen)` : ''}`,
        name: top.name,
      };
    }
  });
  return { results, errors, limited };
}

// ---------------------------------------------------------------------------
// Method 3 — GraphQL, 50 users per request
// ---------------------------------------------------------------------------

/** The batched query: one aliased `user` lookup per login. Logins are validated, so they are safe to inline. */
export function batchQuery(logins, org = '') {
  const orgField = org && validLogin(org) ? ` organizationVerifiedDomainEmails(login: "${org}")` : '';
  return `query {\n${logins
    .map((login, i) => `  u${i}: user(login: "${login}") { login name email${orgField} }`)
    .join('\n')}\n}`;
}

export async function byGraphql(gh, logins, { org = '', batchSize = 50 } = {}) {
  const results = {};
  const errors = [];
  const valid = logins.filter(validLogin);
  for (let i = 0; i < valid.length; i += batchSize) {
    const batch = valid.slice(i, i + batchSize);
    let body;
    try {
      body = await gh.graphql(batchQuery(batch, org));
    } catch (error) {
      errors.push(error.message);
      if (error.status === 401 || error.status === 403) break;
      continue;
    }
    batch.forEach((login, n) => {
      const user = body?.data?.[`u${n}`];
      if (!user) return;
      const verified = (user.organizationVerifiedDomainEmails ?? []).find(usableEmail);
      if (verified) {
        results[login] = { email: verified.toLowerCase(), confidence: 'high', evidence: `Verified ${org} domain email`, name: user.name ?? '' };
      } else if (usableEmail(user.email)) {
        results[login] = { email: user.email.toLowerCase(), confidence: 'high', evidence: 'Public email (GraphQL)', name: user.name ?? '' };
      }
    });
    // Unknown logins come back as NOT_FOUND errors next to the data: expected, not a failure.
    for (const e of body?.errors ?? []) if (e.type !== 'NOT_FOUND') errors.push(e.message);
  }
  return { results, errors };
}

/**
 * The reverse direction, batched: which GitHub user owns each email (search
 * `in:email` matches public emails only). 25 per request.
 */
export async function emailsToLogins(gh, emails, { batchSize = 25 } = {}) {
  const found = {};
  const list = emails.filter((e) => EMAIL_RE.test(e) && !/["\\]/.test(e));
  for (let i = 0; i < list.length; i += batchSize) {
    const batch = list.slice(i, i + batchSize);
    const query = `query {\n${batch
      .map((email, n) => `  e${n}: search(query: "${email} in:email", type: USER, first: 1) { nodes { ... on User { login } } }`)
      .join('\n')}\n}`;
    const body = await gh.graphql(query);
    batch.forEach((email, n) => {
      const login = body?.data?.[`e${n}`]?.nodes?.[0]?.login;
      if (login) found[email] = login;
    });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Method 4 — local git history
// ---------------------------------------------------------------------------

/** Parse `git log --format=%an%x1f%ae%x1f%at` output into commits. */
export function parseGitLog(text) {
  const commits = [];
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    const [name, email, at] = line.split('\x1f');
    commits.push({ name: name ?? '', email: String(email ?? '').toLowerCase(), at: Number(at) * 1000 || 0 });
  }
  return commits;
}

/**
 * From commits, map each GitHub login to real addresses. A noreply commit
 * ties a login to an author name; commits under the same name with a real
 * address give that address (strong when also tied through the login in the
 * address, e.g. jdoe@corp.com for login jdoe).
 */
export function identitiesFromCommits(commits) {
  const byName = new Map(); // name -> Map(email -> {count,last})
  const loginNames = new Map(); // login -> Set(names)
  for (const c of commits) {
    const name = normName(c.name);
    const login = loginFromNoreply(c.email);
    if (login) {
      const key = login.toLowerCase();
      if (!loginNames.has(key)) loginNames.set(key, { login, names: new Set(), commits: 0 });
      const entry = loginNames.get(key);
      entry.names.add(name);
      entry.commits += 1;
      continue;
    }
    if (!usableEmail(c.email) || !name) continue;
    if (!byName.has(name)) byName.set(name, new Map());
    const emails = byName.get(name);
    const e = emails.get(c.email) ?? { email: c.email, count: 0, last: 0 };
    e.count += 1;
    e.last = Math.max(e.last, c.at);
    emails.set(c.email, e);
  }

  const identities = {};
  for (const [key, { login, names, commits: noreplyCommits }] of loginNames) {
    const candidates = new Map();
    for (const name of names) for (const [email, e] of byName.get(name) ?? []) candidates.set(email, e);
    const top = best(candidates);
    identities[key] = {
      login,
      noreplyCommits,
      names: [...names],
      email: top?.email ?? '',
      candidates: [...candidates.values()].map((c) => c.email),
      confidence: !top ? 'none' : top.email.split('@')[0] === key || top.count >= 3 ? 'high' : 'medium',
    };
  }
  return { identities, authors: byName };
}

/** Letters and digits only, lower case: "Doug Wilson", "doug.wilson", "doug-wilson" → "dougwilson". */
export const handle = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\d]/g, '');

/** Usual login forms of a person's name: dougwilson, dwilson, wilsond, dougw. */
export function nameHandles(name) {
  const parts = String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(Boolean);
  if (!parts.length) return [];
  const forms = [parts.join('')];
  if (parts.length >= 2) {
    const first = parts[0];
    const last = parts.at(-1);
    forms.push(first[0] + last, last + first[0], first + last[0], first + last, last + first);
  }
  return [...new Set(forms)];
}

/** Common enterprise-managed-user and bot affixes: "cx-jdoe", "jdoe_acme", "jdoe-acme". */
export const stripAffixes = (login) => String(login || '').replace(/^(cx|ext|svc|adm)[-_]/i, '').replace(/[_-](corp|ext|emu|[a-z]{2,6}inc)$/i, '');

/**
 * Author names and email local parts as handles, each pointing at the address
 * used most with it. A handle shared by different addresses of different
 * people is ambiguous and left out.
 */
function handleIndex(authors) {
  const index = new Map();
  const add = (key, email, count, why) => {
    if (key.length < 3) return;
    const current = index.get(key);
    if (!current) index.set(key, { email, count, why });
    else if (current.email !== email) {
      if (count > current.count * 3) index.set(key, { email, count, why });
      else if (current.count <= count * 3) index.set(key, { ...current, ambiguous: true });
    } else current.count += count;
  };
  for (const [name, emails] of authors) {
    for (const [email, e] of emails) {
      for (const form of nameHandles(name)) add(form, email, e.count, 'the author name');
      // "kev.kirsche+github" → "kevkirsche"
      add(handle(email.split('@')[0].replace(/\+.*$/, '')), email, e.count, 'the email address');
    }
  }
  for (const [key, value] of index) if (value.ambiguous) index.delete(key);
  return index;
}

const CLONE_FRESH_MS = 10 * 60_000;
const clones = new Map();

/**
 * A local clone for a repository URL, created or refreshed — at most once
 * every 10 minutes, and once for concurrent callers.
 */
export function ensureClone(url, { cacheDir, token = '', authHeader = '', blobs = false } = {}) {
  const key = `${cacheDir}|${url}|${blobs}`;
  const known = clones.get(key);
  if (known && Date.now() - known.at < CLONE_FRESH_MS) return known.promise;
  const promise = cloneOrFetch(url, { cacheDir, authHeader: authHeader || (token ? githubAuth(token) : ''), blobs });
  clones.set(key, { at: Date.now(), promise });
  promise.catch(() => clones.delete(key));
  return promise;
}

/** The git host a GitHub API address belongs to: api.github.com → github.com, ghe.acme.com/api/v3 → ghe.acme.com. */
export function gitHostOf(apiUrl = 'https://api.github.com') {
  try {
    const host = new URL(apiUrl).host.toLowerCase();
    return host === 'api.github.com' ? 'github.com' : host;
  } catch {
    return 'github.com';
  }
}

/** The token only for repositories on the GitHub it belongs to — never sent to other hosts. */
export function tokenFor(url, gh) {
  if (!gh?.hasToken) return '';
  try {
    return new URL(url).host.toLowerCase() === gitHostOf(gh.apiUrl) ? gh.token : '';
  } catch {
    return '';
  }
}

/** GitHub's form of a token for git over https. */
const githubAuth = (token) => `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;

async function cloneOrFetch(url, { cacheDir, authHeader = '', blobs = false } = {}) {
  try {
    return await cloneOnce(url, { cacheDir, authHeader, blobs });
  } catch (error) {
    // Credentials the host does not accept: public repositories still clone without them.
    if (!authHeader) throw error;
    return cloneOnce(url, { cacheDir, authHeader: '', blobs });
  }
}

async function cloneOnce(url, { cacheDir, authHeader = '', blobs = false } = {}) {
  if (!/^https:\/\/[\w.-]+(:\d+)?\/[\w.\-/]+$/.test(url)) throw new Error(`Not an https repository address: ${url}`);
  const dir = path.join(cacheDir, `${createHash('sha256').update(url).digest('hex').slice(0, 16)}${blobs ? '-full' : ''}`);
  // Credentials go in an environment-only header: never in arguments, never on disk.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (authHeader) {
    Object.assign(env, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.extraHeader',
      GIT_CONFIG_VALUE_0: `Authorization: ${authHeader}`,
    });
  }
  const opts = { env, timeout: 10 * 60_000, maxBuffer: 64 * 1024 * 1024 };
  if (fs.existsSync(path.join(dir, 'HEAD'))) {
    await run('git', ['-C', dir, 'fetch', '--quiet', '--prune', 'origin', '+refs/heads/*:refs/heads/*'], opts).catch(() => {});
  } else {
    fs.mkdirSync(cacheDir, { recursive: true });
    // Blame reads many old versions of a file, which a partial clone would fetch
    // one by one: clone fully for blame; history-only (no files) for identities.
    await run('git', ['clone', '--quiet', '--bare', ...(blobs ? [] : ['--filter=tree:0']), url, dir], opts);
  }
  return { dir, env };
}

/**
 * Local git history for `sources`: paths to existing clones, or https URLs
 * (cloned into `cacheDir` without file contents).
 */
export async function byLocalGit(logins, sources, { cacheDir, token = '', gh = null, since = '', authFor = null } = {}) {
  const errors = [];
  const commits = [];
  for (const source of sources) {
    try {
      // Each host's own credentials (authFor), the GitHub token for GitHub, or none.
      const auth = authFor?.(source) || '';
      const repo = /^https:\/\//.test(source) ? (await ensureClone(source, { cacheDir, authHeader: auth, token: auth ? '' : gh ? tokenFor(source, gh) : token })).dir : source;
      const args = ['-C', repo, 'log', '--all', '--format=%an%x1f%ae%x1f%at'];
      if (since) args.push(`--since=${since}`);
      const { stdout } = await run('git', args, { maxBuffer: 256 * 1024 * 1024, timeout: 5 * 60_000 });
      commits.push(...parseGitLog(stdout));
      // Committers too: web edits and merges are committed under the user's noreply address.
      const { stdout: committers } = await run('git', ['-C', repo, 'log', '--all', '--format=%cn%x1f%ce%x1f%ct', ...(since ? [`--since=${since}`] : [])], { maxBuffer: 256 * 1024 * 1024, timeout: 5 * 60_000 });
      commits.push(...parseGitLog(committers));
    } catch (error) {
      errors.push(`${source}: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
    }
  }
  const { identities, authors } = identitiesFromCommits(commits);
  const results = {};
  const wanted = logins.length ? logins : Object.values(identities).map((i) => i.login);
  const byHandle = handleIndex(authors);
  for (const login of wanted) {
    const id = identities[login.toLowerCase()];
    if (id?.email) {
      results[login] = {
        email: id.email,
        confidence: id.confidence,
        evidence: `Noreply commits as ${id.names.join(' / ')} (${id.noreplyCommits}); same author on commits with this address`,
      };
      continue;
    }
    // Company repositories rarely contain the login at all: developers commit
    // with their work address. Match the login to an author name or address.
    const key = handle(login);
    const match =
      byHandle.get(key) ??
      byHandle.get(handle(stripAffixes(login))) ??
      // "tjrhines1" → "tjrhines"
      (/\d$/.test(key) ? byHandle.get(key.replace(/\d+$/, '')) : undefined);
    if (match) {
      results[login] = { email: match.email, confidence: 'medium', evidence: `Login matches ${match.why} on ${match.count} commit(s)` };
    }
  }
  return { results, errors, commits: commits.length, loginsSeen: Object.keys(identities).length };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Run the chosen methods for `logins` and compare them: coverage, requests
 * spent and time taken, the best address per login, and a recommendation
 * drawn from these numbers.
 */
export async function evaluate(gh, logins, { methods = METHODS, org = '', repos = [], localSources = [], cacheDir }) {
  const unique = [...new Set(logins.map((l) => String(l).trim()).filter(validLogin))];
  const report = { logins: unique, methods: {}, combined: {}, recommendation: [] };

  const runners = {
    localGit: () => byLocalGit(unique, localSources, { cacheDir, gh }),
    graphql: () => byGraphql(gh, unique, { org }),
    commits: () => byCommits(gh, unique, { repos, org }),
    profile: () => byProfile(gh, unique),
  };

  for (const method of METHODS) {
    if (!methods.includes(method)) continue;
    if (method === 'localGit' && !localSources.length) {
      report.methods[method] = { skipped: 'No local repositories or clone URLs given.' };
      continue;
    }
    if (method === 'graphql' && !gh.hasToken) {
      report.methods[method] = { skipped: 'GraphQL needs a GitHub token.' };
      continue;
    }
    const before = { ...gh.requests };
    const started = Date.now();
    let outcome;
    try {
      outcome = await runners[method]();
    } catch (error) {
      outcome = { results: {}, errors: [error.message] };
    }
    const requests = Object.keys(before).reduce((n, k) => n + (gh.requests[k] - before[k]), 0);
    const resolved = Object.keys(outcome.results).length;
    report.methods[method] = {
      resolved,
      coverage: unique.length ? Math.round((resolved / unique.length) * 100) : 0,
      requests,
      ms: Date.now() - started,
      requestsPerMatch: resolved ? +(requests / resolved).toFixed(2) : null,
      errors: outcome.errors?.slice(0, 5) ?? [],
      limited: Boolean(outcome.limited),
      extra: method === 'localGit' ? { commits: outcome.commits, loginsSeen: outcome.loginsSeen } : undefined,
      results: outcome.results,
    };
    for (const [login, found] of Object.entries(outcome.results)) {
      const current = report.combined[login];
      const rank = { high: 3, medium: 2, low: 1 };
      if (!current || rank[found.confidence] > rank[current.confidence]) report.combined[login] = { ...found, method };
      else if (current.email === found.email) current.agreedBy = [...(current.agreedBy ?? []), method];
    }
  }

  report.rateLimit = gh.rateLimit;
  report.resolved = Object.keys(report.combined).length;
  report.recommendation = recommend(report);
  return report;
}

/** Plain-language recommendation from the measured numbers. */
export function recommend(report) {
  const ran = Object.entries(report.methods).filter(([, m]) => !m.skipped);
  if (!ran.length) return ['Run at least one method to get a recommendation.'];
  const ranked = ran.sort((a, b) => b[1].coverage - a[1].coverage || (a[1].requests ?? 0) - (b[1].requests ?? 0));
  const lines = [];
  const [topName, top] = ranked[0];
  lines.push(`${METHOD_LABELS[topName]} found the most: ${top.resolved} of ${report.logins.length} (${top.coverage}%) for ${top.requests} API request(s).`);
  const cheap = ran.filter(([, m]) => m.resolved && (m.requests === 0 || m.requestsPerMatch <= 0.1));
  if (cheap.length) lines.push(`Cheapest per match: ${cheap.map(([n, m]) => `${METHOD_LABELS[n]} (${m.requests} request(s))`).join(', ')} — run these first.`);
  const union = report.resolved;
  if (union > top.resolved) lines.push(`Combined, the methods found ${union} (${Math.round((union / Math.max(1, report.logins.length)) * 100)}%): run them in order of cost and stop at the first match.`);
  const limited = ran.filter(([, m]) => m.limited);
  if (limited.length) lines.push(`${limited.map(([n]) => METHOD_LABELS[n]).join(', ')} hit GitHub's rate limit — keep it for the leftovers only.`);
  return lines;
}

/**
 * Resolve logins to emails, cheapest method first; each method only sees the
 * logins still unresolved. Order from the measurements: local git (no API
 * calls), GraphQL (one call per 50), commits in named repos, profile (one
 * call each). Returns {login: {email, confidence, evidence, method}}.
 */
export async function resolveLogins(gh, logins, { org = '', repos = [], localSources = [], cacheDir } = {}) {
  let pending = [...new Set(logins.filter(validLogin))];
  const found = {};
  const steps = [
    ['localGit', () => (localSources.length ? byLocalGit(pending, localSources, { cacheDir, gh }) : null)],
    ['graphql', () => (gh?.hasToken ? byGraphql(gh, pending, { org }) : null)],
    ['commits', () => (gh && repos.length ? byCommits(gh, pending, { repos }) : null)],
    ['profile', () => (gh ? byProfile(gh, pending) : null)],
  ];
  for (const [method, step] of steps) {
    if (!pending.length) break;
    let outcome = null;
    try {
      outcome = await step();
    } catch {
      outcome = null;
    }
    if (!outcome) continue;
    for (const [login, result] of Object.entries(outcome.results)) found[login] = { ...result, method };
    pending = pending.filter((login) => !found[login]);
  }
  return found;
}
