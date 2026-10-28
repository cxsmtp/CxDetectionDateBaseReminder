/**
 * Fusion — new customer, Count from git (public/calculator/page.js), with cloc-fusion's engine (src/cloc-fusion/,
 * vendored from cloc-fusion 1.3.2): a customer's repositories discovered across connections and organizations,
 * then measured where they are kept. For each repository: its code lines by language, counted the way cloc counts
 * them; the commits on its default branch in the last 365 days (merges left out) and so its change frequency; the
 * date of its last commit; and how many people committed to it in the last 90 days (bots left out). Two engines:
 * git (a bare, blob-less clone of the default branch back to the start of the window, into a folder of its own,
 * deleted at once) and the platform's API (the branch's archive, read in memory, and its commit list).
 *
 * Where the code is: the Admin's git connections (src/scm/, by id: their tokens never leave the server), or a
 * token typed for one run. Either way the token goes to its own host only, as an Authorization header (git gets it
 * through the environment, scoped to the repository's origin, never on a command line, in an address or on disk),
 * and is in no answer, log line or error. CxMissionZero's hardening stays around the engine: hosts on the allowed
 * list only, names that lead to link-local or cloud metadata addresses refused and git and the API client held to
 * the addresses checked, no redirects for git (by hand, credentials dropped, for the API), counts seen only by
 * whoever started them, and temporary folders swept after a crash. Names and emails of the people who committed are
 * never kept: each repository keeps a count, and a run its count of different people (by a salted hash, in memory).
 * Used by CxMissionZero (src/server.js) and the standalone calculator's launcher (src/calculator-launcher.js), so
 * only Node.js and relative imports.
 */

import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import dnsCallback from 'node:dns';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { azureOrgKey, azureOrgName, normalizeAzureOrgUrl } from './scm/azure-url.js';
import { blockedHost, outboundUrlProblem } from './outbound-url.js';
import { providerOf } from './cloc-fusion/providers/index.js';
import { allOrgIds, classifyRepos, dedupeRepos } from './cloc-fusion/discover.js';
import { commitStats, parseLsTree, safeBranch as engineBranch } from './cloc-fusion/git.js';
import { analyzeRepoApi } from './cloc-fusion/apiengine.js';
import { LocTally, selectFiles } from './cloc-fusion/loc.js';
import { DEV_WINDOW_DAYS, contributorKey, isBot } from './cloc-fusion/commits.js';
import { FREQUENCIES, frequencyOf } from './cloc-fusion/fusion.js';
import { pool } from './cloc-fusion/pool.js';
import { HttpError } from './cloc-fusion/http.js';
import { CLOC_FUSION } from './cloc-fusion/origin.js';

export { CLOC_FUSION };

export const GIT_COUNT_LIMITS = Object.freeze({
  repositories: 1000,
  repoBytes: 2 * 1024 * 1024 * 1024,
  fileBytes: 1024 * 1024,
  timeoutMs: 10 * 60_000,
  concurrency: 4,
  listed: 10_000,
  windowDays: 365,
});
export const GIT_PROVIDERS = ['github', 'gitlab', 'azure', 'bitbucket'];
export const ENGINES = ['auto', 'git', 'api'];
const LABELS = { github: 'GitHub', gitlab: 'GitLab', azure: 'Azure DevOps', bitbucket: 'Bitbucket' };
const TEMP_PREFIX = 'mz-git-count-';
const DAY = 86_400_000;
// The categories counted toward a repository's lines when nothing is left out (cloc-fusion's default).
const COUNTED = ['code', 'markup', 'iac'];
// The platforms' own API and download hosts, beside the git hosts: called by the API engine only.
const PUBLIC_API_HOSTS = ['api.github.com', 'codeload.github.com', 'api.bitbucket.org'];

const fail = (status, message) => Object.assign(new Error(message), { status });

// ---- git ---------------------------------------------------------------------------------------

/** Run git; resolves its output. `signal` stops it (time limit, size limit). */
function git(args, { env, signal, maxBuffer = 64 * 1024 * 1024, bin = 'git', input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { env, signal, maxBuffer, encoding: 'buffer', windowsHide: true }, (error, stdout, stderr) => {
      if (error) return reject(Object.assign(error, { stderr: stderr?.toString('utf8') ?? '' }));
      resolve(stdout);
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

/** Each object's content, read from git's own store as git hands them over (git cat-file --batch). */
function readBlobs(dir, oids, onBlob, { env, signal, bin = 'git' } = {}) {
  return new Promise((resolve, reject) => {
    if (!oids.length) return resolve();
    const child = spawn(bin, ['-C', dir, 'cat-file', '--batch'], { env, signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buf = Buffer.alloc(0);
    let want = null;
    let stderr = '';
    let failed = null;
    child.stdout.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      try {
        for (;;) {
          if (!want) {
            const nl = buf.indexOf(10);
            if (nl < 0) break;
            const head = buf.subarray(0, nl).toString('utf8').split(' ');
            buf = buf.subarray(nl + 1);
            if (head[1] === 'missing' || head.length < 3) continue;
            want = { oid: head[0], size: Number(head[2]) };
          }
          if (buf.length < want.size + 1) break;
          const body = buf.subarray(0, want.size);
          buf = buf.subarray(want.size + 1);
          const { oid } = want;
          want = null;
          onBlob(oid, body);
        }
      } catch (error) {
        failed = error;
        child.kill();
      }
    });
    child.stderr.on('data', (d) => (stderr += d).length > 4000 && (stderr = stderr.slice(-4000)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (failed) return reject(failed);
      if (code !== 0) return reject(Object.assign(new Error(`git cat-file stopped (${code})`), { stderr }));
      resolve();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(`${oids.join('\n')}\n`);
  });
}

/** A folder's size on disk, in bytes (a clone being made: its pack files grow). */
function folderBytes(dir) {
  let total = 0;
  const walk = (folder) => {
    let entries = [];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {}
      }
    }
  };
  walk(dir);
  return total;
}

/**
 * git's environment for one repository: the Authorization header (when there is one) through config variables
 * only, for the repository's own origin (http.<origin>/.extraHeader, so not for any other host git might be sent
 * to), no credential helper or prompt, no redirects, and the addresses checked (http.curloptResolve).
 */
export function gitEnv(authHeader, { http: plain = false, pin = '', origin = '' } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_ALLOW_PROTOCOL: plain ? 'https:http' : 'https', GIT_LFS_SKIP_SMUDGE: '1' };
  // Nothing that would write the header out (git's traces), and no other settings passed down.
  for (const name of Object.keys(env)) if (/^GIT_(TRACE|CURL_VERBOSE|CONFIG_(COUNT|KEY_|VALUE_|PARAMETERS)|DIR$|WORK_TREE$|SSH_COMMAND$)/.test(name)) delete env[name];
  const config = [['credential.helper', ''], ['http.followRedirects', 'false'], ['core.askPass', '']];
  if (authHeader) config.push([origin ? `http.${origin}/.extraHeader` : 'http.extraHeader', `Authorization: ${authHeader}`]);
  // git connects to the addresses checked here, not to a second look-up of the name (git 2.37 and later).
  if (pin) config.push(['http.curloptResolve', pin]);
  env.GIT_CONFIG_COUNT = String(config.length);
  config.forEach(([key, value], i) => Object.assign(env, { [`GIT_CONFIG_KEY_${i}`]: key, [`GIT_CONFIG_VALUE_${i}`]: value }));
  return env;
}

/** Is git there? '' when it is, else what to say. */
export async function gitMissing(bin = 'git') {
  try {
    await git(['--version'], { bin });
    return '';
  } catch (error) {
    return error.code === 'ENOENT' ? 'Git is not installed on this computer: install it from https://git-scm.com, then count again.' : `Git could not be started: ${String(error.message).split('\n')[0]}`;
  }
}

/** git's version as [major, minor], or null when it is not there. */
async function gitVersionOf(bin = 'git') {
  try {
    const m = /(\d+)\.(\d+)/.exec((await git(['--version'], { bin })).toString('utf8'));
    return m ? [Number(m[1]), Number(m[2])] : null;
  } catch {
    return null;
  }
}

/** The engine a run uses: git when git 2.31 or later is here (auto), else the platforms' APIs. */
export async function chooseEngine(requested = 'auto', bin = 'git') {
  const wanted = ENGINES.includes(requested) ? requested : 'auto';
  if (wanted === 'api') return 'api';
  const v = await gitVersionOf(bin);
  const ok = Boolean(v && (v[0] > 2 || (v[0] === 2 && v[1] >= 31)));
  if (wanted === 'git' && !ok) throw fail(409, v ? 'The git engine needs git 2.31 or later on this computer: update git, or choose the API engine.' : 'Git is not installed on this computer: install it from https://git-scm.com, or choose the API engine.');
  return ok ? 'git' : 'api';
}

// ---- Addresses and tokens -----------------------------------------------------------------------

/** Every form a secret takes in a request: hidden wherever it could appear in a message. */
export function redact(text, secrets = []) {
  let out = String(text ?? '').replace(/\/\/[^/@\s]*@/g, '//');
  for (const secret of secrets) if (secret && secret.length >= 4) out = out.split(secret).join('[hidden]');
  return out;
}

const SEGMENT = /^[\w.~%@+-]+$/;
/**
 * A repository's clone address, checked: https (plain http only to this computer, for a test double),
 * never a link-local or cloud metadata address, and without a password. A user name some hosts put in
 * their own addresses (https://acme@dev.azure.com/…) is dropped. {url, host, hostname, path, name}.
 */
export function repoAddress(value) {
  const text = String(value ?? '').trim();
  if (/^(git@|ssh:\/\/)/i.test(text)) throw fail(400, 'Use the repository’s https address: the token goes over https only.');
  let url;
  try {
    url = new URL(text);
  } catch {
    throw fail(400, `Not a repository address: ${text.slice(0, 80).replace(/\/\/[^/@\s]*@/, '//')}`);
  }
  if (url.password) throw fail(400, 'A clone address must not carry a password: give the token in step 1.');
  url.username = '';
  const problem = outboundUrlProblem(url.href);
  if (problem) throw fail(400, `The address ${url.host} ${problem}.`);
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || parts.some((p) => p === '..' || p === '.' || !SEGMENT.test(p))) throw fail(400, `Not a repository address: ${url.host}${url.pathname.slice(0, 80)}`);
  const name = decodeURIComponent(parts.at(-1)).replace(/\.git$/i, '') || 'Project';
  return { url: `${url.protocol}//${url.host}/${parts.join('/')}`, host: url.host.toLowerCase(), hostname: url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1'), path: decodeURIComponent(parts.join('/')).replace(/\.git$/i, ''), name, origin: `${url.protocol}//${url.host}` };
}

/** Never a host whose name leads to a link-local or cloud metadata address; the addresses it leads to ([] for an address typed as such). */
async function checkResolved(hostname) {
  if (net.isIP(hostname)) return [];
  let addresses = [];
  try {
    addresses = await dns.lookup(hostname, { all: true });
  } catch {
    throw fail(400, `${hostname} could not be found.`);
  }
  if (addresses.some((a) => blockedHost(a.address))) throw fail(400, `${hostname} points at a link-local or cloud metadata address, which is never called.`);
  return addresses.map((a) => a.address);
}

/** curl's resolve entry that holds `address` to the checked `ips`: host:port:ip[,ip]. */
export function resolvePin(address, ips) {
  if (!ips.length) return '';
  const port = new URL(address.url).port || (address.url.startsWith('http:') ? '80' : '443');
  return `${address.hostname}:${port}:${ips.map((ip) => (ip.includes(':') ? `[${ip}]` : ip)).join(',')}`;
}

/** A name look-up for the API client's connections that never hands back a link-local or metadata address. */
function safeLookup(hostname, options, callback) {
  dnsCallback.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some((a) => blockedHost(a.address))) return callback(Object.assign(new Error(`${hostname} points at a link-local or cloud metadata address, which is never called.`), { code: 'EBLOCKED' }));
    if (options?.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

/**
 * The API engine's fetch: each call (and each hop of a redirect, which cloc-fusion's client follows by hand,
 * credentials dropped off its own origin) checked first: https only (plain http only to this computer), a host
 * `allowHost(hostname)` allows, and a connection made to the address checked (the look-up refuses link-local and
 * metadata addresses), not to a second look-up. `signal` stops it with the repository's time limit.
 */
export function guardedFetch({ allowHost = () => true, signal = null } = {}) {
  return async function fetchGuarded(input, init = {}) {
    const url = new URL(String(input));
    // Refusals are cloc-fusion's own error, so its client says them at once instead of trying again.
    const problem = outboundUrlProblem(url.href);
    if (problem) throw new HttpError(`The address ${url.host} ${problem}.`, { status: 400 });
    const hostname = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
    if (!allowHost(hostname)) throw new HttpError(`${hostname} is not a host this server calls: connect it on the Beta page, or add it to SCM_ALLOWED_HOSTS.`, { status: 400 });
    const signals = [init.signal, signal].filter(Boolean);
    const stop = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    const lib = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = lib.request(url, { method: init.method ?? 'GET', headers: init.headers ?? {}, signal: stop, lookup: safeLookup }, (res) => {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) for (const one of [].concat(value ?? [])) headers.append(key, String(one));
        const empty = [204, 205, 304].includes(res.statusCode) || (init.method ?? 'GET') === 'HEAD';
        if (empty) res.resume();
        resolve(new Response(empty ? null : Readable.toWeb(res), { status: res.statusCode, statusText: res.statusMessage, headers }));
      });
      req.on('error', (error) => reject(error.code === 'EBLOCKED' ? new HttpError(error.message, { status: 400 }) : error));
      req.end(init.body);
    });
  };
}

const TOKEN = /^[\x21-\x7e]{4,4096}$/;
const b64 = (text) => Buffer.from(text).toString('base64');

/**
 * Where the code is, from a host, its address and a token: the API to discover repositories with (cloc-fusion's
 * provider and connection), the git host the token belongs to, and the Authorization header for each. `token` may
 * be "user:password" for Bitbucket (an app password). The token itself stays inside the object returned (in
 * `secrets`, for redaction, and `secret`, for cloc-fusion's client): nothing here writes it anywhere. `key` names
 * the source in a run ('token', or the Admin's connection's id).
 */
export function gitSource({ provider, address = '', token = '', key = 'token' } = {}) {
  if (!GIT_PROVIDERS.includes(provider)) throw fail(400, 'Choose the git host: GitHub, GitLab, Azure DevOps or Bitbucket.');
  const secret = String(token ?? '').trim();
  if (!TOKEN.test(secret)) throw fail(400, secret ? 'That token has spaces or characters a token does not have: paste it again.' : 'Paste the token.');
  const defaults = { github: 'https://github.com', gitlab: 'https://gitlab.com', bitbucket: 'https://bitbucket.org', azure: '' };
  let typed = String(address ?? '').trim() || defaults[provider];
  if (provider === 'azure') typed = normalizeAzureOrgUrl(typed);
  if (!typed) throw fail(400, 'Give the Azure DevOps organisation, for example https://dev.azure.com/acme.');
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(typed) ? typed : `https://${typed}`);
  } catch {
    throw fail(400, 'That address is not a web address.');
  }
  const problem = outboundUrlProblem(url.href);
  if (problem) throw fail(400, `The address ${problem}.`);
  const host = url.host.toLowerCase();
  const origin = `${url.protocol}//${url.host}`;
  const base = url.pathname.replace(/\/+$/, '');
  let source;
  if (provider === 'github') {
    const cloud = host === 'github.com' || host === 'api.github.com';
    const apiUrl = cloud ? 'https://api.github.com' : `${origin}${base.replace(/\/api\/v3$/, '')}/api/v3`;
    source = { apiUrl, gitHost: cloud ? 'github.com' : host, apiAuth: `Bearer ${secret}`, cloneAuth: `Basic ${b64(`x-access-token:${secret}`)}`, engine: { provider: 'github', apiUrl, method: 'pat' } };
  } else if (provider === 'gitlab') {
    const apiUrl = `${origin}${base.replace(/\/api\/v4$/, '')}/api/v4`;
    source = { apiUrl, gitHost: host, apiAuth: `Bearer ${secret}`, cloneAuth: `Basic ${b64(`oauth2:${secret}`)}`, engine: { provider: 'gitlab', apiUrl, method: 'pat' } };
  } else if (provider === 'azure') {
    const auth = `Basic ${b64(`:${secret}`)}`;
    const orgUrl = `${origin}${base}`;
    const cloud = host === 'dev.azure.com';
    const parts = base.split('/').filter(Boolean);
    // Services: the organisations live under https://dev.azure.com; Server: the collections under its address.
    const apiUrl = cloud ? 'https://dev.azure.com' : `${origin}${parts.length ? `/${parts.slice(0, -1).join('/')}` : ''}`;
    source = { apiUrl: orgUrl, gitHost: host, apiAuth: auth, cloneAuth: auth, org: azureOrgKey(orgUrl), engine: { provider: 'azure', apiUrl, method: 'pat', defaultOrg: cloud ? azureOrgName(orgUrl) : parts.at(-1) ?? '' } };
  } else {
    const cloud = host === 'bitbucket.org' || host === 'api.bitbucket.org';
    const pair = secret.includes(':') ? `Basic ${b64(secret)}` : '';
    const apiUrl = cloud ? 'https://api.bitbucket.org/2.0' : `${origin}${base.replace(/\/rest\/api\/1\.0$/, '')}`;
    source = {
      apiUrl,
      gitHost: cloud ? 'bitbucket.org' : host,
      apiAuth: pair || `Bearer ${secret}`,
      cloneAuth: pair || (cloud ? `Basic ${b64(`x-token-auth:${secret}`)}` : `Bearer ${secret}`),
      cloud,
      engine: { provider: cloud ? 'bitbucket' : 'bitbucket-server', apiUrl, method: pair ? 'app-password' : cloud ? 'access-token' : 'http-token' },
    };
  }
  const secrets = [secret, source.apiAuth, source.cloneAuth, ...[source.apiAuth, source.cloneAuth].map((a) => a.replace(/^\w+ /, ''))];
  // Azure DevOps organisations this token may be sent to over git: its own, and each one its account lists.
  const orgs = new Set(source.org ? [source.org] : []);
  return {
    key: String(key),
    provider,
    label: LABELS[provider],
    ...source,
    secrets,
    /** What cloc-fusion's client takes (the header it sends is replaced by `apiAuth`, so the two never differ). */
    secret: splitPair(secret),
    apiHost: new URL(source.engine.apiUrl).hostname.toLowerCase(),
    /** The header for cloning `repo` ({host, url}): only on the token's own host (an Azure DevOps token: its own organisations). */
    authFor(repo) {
      if (repo.host !== source.gitHost) return '';
      if (provider === 'azure' && source.org.startsWith('dev.azure.com/') && !orgs.has(azureOrgKey(repo.url))) return '';
      return source.cloneAuth;
    },
    /** Azure DevOps organisations its own account listed (Everything this token can see): git may send it there too. */
    addOrganizations(names) {
      if (provider === 'azure' && source.org.startsWith('dev.azure.com/')) for (const n of names) if (/^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/.test(n)) orgs.add(`dev.azure.com/${n.toLowerCase()}`);
    },
  };
}
function splitPair(secret) {
  const at = secret.indexOf(':');
  return at > 0 ? { username: secret.slice(0, at), token: secret.slice(at + 1) } : { username: '', token: secret };
}

/** The same from one of the Admin's connections (src/scm/providers.js scmConfigs, src/server.js githubConfig). */
export function connectionSource(provider, cfg = {}, key = 'token') {
  if (provider === 'github') return gitSource({ provider, address: cfg.apiUrl, token: cfg.token, key });
  if (provider === 'gitlab') return gitSource({ provider, address: cfg.apiUrl, token: cfg.token, key });
  if (provider === 'azure') return gitSource({ provider, address: cfg.orgUrl, token: cfg.token, key });
  const cloud = cfg.kind !== 'server';
  return gitSource({ provider, address: cloud ? 'https://bitbucket.org' : cfg.apiUrl, token: cfg.username ? `${cfg.username}:${cfg.token}` : cfg.token, key });
}

// ---- Discovery: organizations, then their repositories (cloc-fusion's providers) -----------------

/**
 * cloc-fusion's provider and API client for a source: its connection, the header MZ worked out, and a fetch that
 * calls only `allowHost`'s hosts, the API's own and the platforms' download hosts, each checked as it is called.
 */
export function openSession(source, { allowHost = () => true, fetchImpl = null, signal = null } = {}) {
  const provider = providerOf(source.engine.provider);
  const conn = { name: source.key, provider: source.engine.provider, apiUrl: source.engine.apiUrl, auth: { method: source.engine.method }, includePersonal: true };
  const api = provider.client(conn, source.secret);
  api.headers = { ...api.headers, Authorization: source.apiAuth };
  const hosts = (hostname) => hostname === source.apiHost || PUBLIC_API_HOSTS.includes(hostname) || allowHost(hostname);
  const guarded = guardedFetch({ allowHost: hosts, signal });
  // A test double stands in for the network, still behind the same host check.
  api.fetch = fetchImpl ? (url, init) => (hosts(new URL(String(url)).hostname) ? fetchImpl(url, init) : Promise.reject(new HttpError(`${new URL(String(url)).hostname} is not a host this server calls.`, { status: 400 }))) : guarded;
  api.retries = 3;
  api.timeoutMs = 60_000;
  return { provider, api, conn };
}

/** What the platform said, in words: never the token. */
function apiProblem(error, source, what) {
  if (error.status === 401 || error.status === 403) return fail(400, `${source.label} refused the token: check it may read ${what}.`);
  if (error.status === 404) return fail(404, `${source.label} has no ${what} that this token may read.`);
  if (error.status && error.status < 500 && !error.url) return error;
  return fail(502, `${source.label} could not be read: ${redact(error.message, source.secrets).slice(0, 200)}`);
}

const ORG = /^(@me|@all|[\w.~ -]{1,200}(\/[\w.~ -]{1,200}){0,10})$/;

/**
 * The organizations (GitHub), top-level groups (GitLab), organizations or collections (Azure DevOps), workspaces
 * (Bitbucket) or projects (Bitbucket Data Center) a source's token can list, with who it signed in as.
 * `@me` is the token's own account where the platform has one. The connection's own organization is always there.
 */
export async function listOrganizations(source, { allowHost, fetchImpl, defaultOrg = '' } = {}) {
  const { provider, api, conn } = openSession(source, { allowHost, fetchImpl });
  let who = '';
  try {
    who = (await provider.whoami(api, conn)) ?? '';
  } catch (error) {
    throw apiProblem(error, source, 'its own account');
  }
  let organizations = [];
  let problem = '';
  try {
    organizations = (await provider.listOrgs(api, conn)).map((o) => ({ id: String(o.id), label: String(o.label ?? o.id).slice(0, 120) }));
  } catch (error) {
    // A token made for one organization cannot list others: its own is still there.
    problem = redact(apiProblem(error, source, 'the list of organizations').message, source.secrets);
  }
  const own = String(defaultOrg || source.engine.defaultOrg || '').trim();
  if (own && ORG.test(own) && !organizations.some((o) => o.id.toLowerCase() === own.toLowerCase())) organizations.unshift({ id: own, label: own });
  source.addOrganizations(organizations.map((o) => o.id));
  return { source: source.key, label: source.label, host: source.gitHost, who: String(who).slice(0, 120), organizations: organizations.slice(0, 2000), problem };
}

/** One repository as the page lists it: where it is, its default branch and what the API engine needs. */
function listedRepo(source, r) {
  let address;
  try {
    address = repoAddress(r.cloneUrl);
  } catch {
    return null;
  }
  const sizeKb = Number(r.sizeKb);
  return {
    source: source.key,
    org: String(r.org ?? ''),
    name: address.name,
    path: String(r.fullName ?? address.path),
    fullName: String(r.fullName ?? address.path),
    url: address.url,
    branch: safeBranch(r.defaultBranch) ? r.defaultBranch : '',
    id: r.id === undefined || r.id === null ? '' : String(r.id),
    project: r.project ? String(r.project) : '',
    sizeBytes: Number.isFinite(sizeKb) && r.sizeKb !== null ? sizeKb * 1024 : null,
    archived: r.archived === true,
    fork: r.fork === true,
    empty: r.empty === true,
    createdAt: r.createdAt ?? null,
    pushedAt: r.pushedAt ?? null,
  };
}

/**
 * Every repository of the organizations asked for (`orgs`), or of every organization the token can list and every
 * other repository it can reach (`everything`), each once, archived ones and forks marked:
 * {repositories, more, problems: [{source, org, error}]}. An older call names one `owner`.
 */
export async function listRepositories(source, ask, { allowHost, fetchImpl, max = GIT_COUNT_LIMITS.listed } = {}) {
  const want = typeof ask === 'string' || ask === undefined || ask === null ? { orgs: [String(ask ?? '').trim()].filter(Boolean) } : ask;
  const orgsAsked = (Array.isArray(want.orgs) ? want.orgs : []).map((o) => String(o ?? '').trim().replace(/^\/+|\/+$/g, '')).filter(Boolean);
  for (const org of orgsAsked) if (!ORG.test(org) || org.split('/').some((p) => !p.trim() || p === '.' || p === '..')) throw fail(400, 'That organisation or group name has characters a name does not have.');
  const { provider, api, conn } = openSession(source, { allowHost, fetchImpl });
  let orgs = [...new Set(orgsAsked)].slice(0, 500);
  if (want.everything) {
    let listed;
    try {
      listed = await provider.listOrgs(api, conn);
    } catch (error) {
      throw apiProblem(error, source, 'the list of organizations');
    }
    source.addOrganizations(listed.map((o) => String(o.id)));
    orgs = [...new Set([...allOrgIds(listed, conn), ...orgs])];
  }
  if (!orgs.length && source.engine.defaultOrg) orgs = [source.engine.defaultOrg];
  if (!orgs.length) throw fail(400, source.provider === 'bitbucket' ? 'Give the workspace (or the project key on Bitbucket Data Center), or tick Everything this token can see.' : 'Give the organisation or group, or tick Everything this token can see.');
  const problems = [];
  const found = [];
  await pool(orgs, 4, async (org) => {
    try {
      const list = await provider.listRepos(api, org, conn);
      found.push(...classifyRepos({ includeArchived: true, includeForks: true }, conn, org, list.slice(0, max), () => ({})));
    } catch (error) {
      const said = apiProblem(error, source, org.startsWith('@') ? 'the repositories of its own account' : `${org}'s repositories`);
      problems.push({ source: source.key, org, status: said.status, error: redact(said.message, source.secrets) });
    }
  });
  // One organization asked for and refused: said as before (a wrong name, a token that may not read it).
  if (!found.length && problems.length === orgs.length && problems.length === 1) throw fail(problems[0].status ?? 502, problems[0].error);
  const unique = dedupeRepos(found)
    .map((r) => listedRepo(source, r))
    .filter(Boolean)
    .sort((a, b) => a.path.localeCompare(b.path));
  return { repositories: unique.slice(0, max), more: unique.length > max, problems: problems.map(({ status, ...p }) => p) };
}

// ---- Measuring one repository ---------------------------------------------------------------------

const safeBranch = (b) => {
  if (typeof b !== 'string' || !b || b.length > 200 || !/^[\w./@+-]+$/.test(b)) return false;
  try {
    return Boolean(engineBranch(b));
  } catch {
    return false;
  }
};

/** What git or the API said, in words: never the token, never more than a line. */
function engineProblem(error, repo, secrets, limits) {
  if (error.tooBig) return `Over ${Math.round(limits.repoBytes / 1024 ** 3)} GB: not counted. Count it with cloc where the code is, and upload the result.`;
  if (error.timedOut) return `Took longer than ${Math.round(limits.timeoutMs / 60_000)} minutes: not counted.`;
  if (error.code === 'ENOENT') return 'Git is not installed on this computer: install it from https://git-scm.com, then count again.';
  const said = redact(`${error.stderr ?? ''}\n${error.message ?? ''}`, secrets);
  if (error.status === 401 || error.status === 403 || /authentication failed|could not read username|\b401\b|\b403\b|access denied|not authorized|permission/i.test(said)) return `${repo.host} refused: check the token may read this repository.`;
  if (/remote branch .* not found/i.test(said)) return 'That branch is not in the repository.';
  if (error.status === 404 || /not found|does not exist|\b404\b/i.test(said)) return `Not found on ${repo.host}, or the token may not read it.`;
  if (/link-local or cloud metadata|not a host this server calls/i.test(said)) return said.split('\n').map((l) => l.trim()).find(Boolean).slice(0, 200);
  if (/could not resolve host|failed to connect|timed out|connection refused|could not reach/i.test(said)) return `${repo.host} could not be reached.`;
  if (/redirect/i.test(said)) return `${repo.host} sent the request elsewhere (the repository may have moved): give its new address.`;
  const line = said.split('\n').map((l) => l.replace(/^(fatal|error):\s*/i, '').trim()).find(Boolean) ?? 'Git stopped.';
  return line.slice(0, 200);
}

/** Languages as the page keeps them: {Language: {category, files, code}}, most code first. */
function languagesOf(summary) {
  return Object.fromEntries(
    Object.entries(summary.languages ?? {})
      .filter(([, t]) => t.files > 0)
      .sort((a, b) => b[1].code - a[1].code)
      .slice(0, 80)
      .map(([name, t]) => [name, { category: t.category, files: t.files, code: t.code }]),
  );
}

/** cloc-fusion's measurement, made what a run keeps: no names or emails, only counts (and keys to count people once). */
function measured(address, m, { engine, now }) {
  const windowDays = Math.max(1, Number(m.windowDays) || GIT_COUNT_LIMITS.windowDays);
  const f = frequencyOf(m.commits ?? 0, windowDays);
  const people = (m.contributors90 ?? []).filter((c) => !c.bot && !isBot(c.email, c.name)).map(contributorKey).filter(Boolean);
  return {
    name: address.name,
    url: address.url,
    host: address.host,
    path: address.path,
    branch: m.branch ?? '',
    commit: m.headSha ? String(m.headSha).slice(0, 7) : '',
    engine,
    lines: m.loc ?? 0,
    files: m.files ?? 0,
    languages: languagesOf(m),
    commits: m.commits ?? 0,
    windowDays: Math.round(windowDays * 10) / 10,
    lastCommitAt: m.lastCommitAt ?? null,
    frequency: f.id,
    perWeek: Math.round(f.perWeek * 100) / 100,
    devs90: people.length,
    empty: m.empty === true,
    people,
  };
}

/**
 * One repository with git: its default branch (or `branch`) back to the start of the window, blob-less, into a
 * folder of its own, held to the addresses checked; its commits in the window; then only the files worth counting
 * fetched in one go and read where git keeps them; and the folder deleted as soon as it is counted.
 */
async function measureWithGit(repo, address, { source, tmpRoot, limits, onProgress, bin, now }) {
  const ips = await checkResolved(address.hostname);
  const auth = source?.authFor(address) ?? '';
  const env = gitEnv(auth, { http: address.url.startsWith('http:'), pin: resolvePin(address, ips), origin: address.origin });
  const dir = fs.mkdtempSync(path.join(tmpRoot, TEMP_PREFIX));
  fs.chmodSync(dir, 0o700);
  const stop = new AbortController();
  const reason = {};
  const timer = setTimeout(() => {
    reason.timedOut = true;
    stop.abort();
  }, limits.timeoutMs);
  const watch = setInterval(() => {
    if (folderBytes(dir) > limits.repoBytes) {
      reason.tooBig = true;
      stop.abort();
    }
  }, 1000);
  const opts = { env, signal: stop.signal, bin };
  try {
    onProgress({ state: 'clone' });
    const branch = safeBranch(repo.branch) ? repo.branch : '';
    const bare = path.join(dir, 'repo.git');
    const since = new Date(now - limits.windowDays * DAY).toISOString();
    const base = ['clone', '--quiet', '--bare', '--filter=blob:none', '--single-branch', '--no-tags', ...(branch ? ['--branch', branch] : [])];
    try {
      await git([...base, `--shallow-since=${since}`, '--', address.url, bare], opts);
    } catch (error) {
      // No commit in the window (the server refuses an empty shallow clone): the latest commit only.
      if (stop.signal.aborted || !/no commits selected|shallow|deepen/i.test(`${error.stderr ?? ''}${error.message}`)) throw error;
      fs.rmSync(bare, { recursive: true, force: true });
      await git([...base, '--depth=1', '--', address.url, bare], opts);
    }
    let headSha;
    try {
      headSha = (await git(['-C', bare, 'rev-parse', 'HEAD'], opts)).toString('utf8').trim();
    } catch {
      return measured(address, { empty: true, commits: 0, windowDays: limits.windowDays, loc: 0, files: 0, languages: {}, contributors90: [] }, { engine: 'git', now });
    }
    const head = branch || (await git(['-C', bare, 'symbolic-ref', '--short', 'HEAD'], opts).then((b) => b.toString('utf8').trim()).catch(() => ''));
    onProgress({ state: 'history' });
    const log = await git(['-C', bare, 'log', '--format=%ct%x09%ae%x09%an', `--since=${since}`, '--no-merges', 'HEAD'], { ...opts, maxBuffer: 256 * 1024 * 1024 });
    const stats = commitStats(log.toString('utf8'), { now });
    // A repository younger than the window: its age is the window, as in cloc-fusion.
    let windowDays = limits.windowDays;
    if (!fs.existsSync(path.join(bare, 'shallow'))) {
      const roots = (await git(['-C', bare, 'log', '--max-parents=0', '--format=%ct', 'HEAD'], opts)).toString('utf8').split('\n').filter(Boolean).map(Number);
      if (roots.length) windowDays = Math.min(windowDays, Math.max(1, (now - Math.min(...roots) * 1000) / DAY));
    }
    const created = Date.parse(repo.createdAt ?? '');
    if (Number.isFinite(created) && created < now) windowDays = Math.min(windowDays, Math.max(1, (now - created) / DAY));
    if (!stats.lastCommitAt) {
      const t = Number((await git(['-C', bare, 'log', '-1', '--format=%ct', 'HEAD'], opts)).toString('utf8').trim());
      if (t) stats.lastCommitAt = new Date(t * 1000).toISOString();
    }
    onProgress({ state: 'files' });
    const tree = parseLsTree(await git(['-C', bare, 'ls-tree', '-r', '-z', 'HEAD'], { ...opts, maxBuffer: 512 * 1024 * 1024 }));
    const files = selectFiles(tree);
    // Each file, as cloc-fusion's API engine counts the same branch's archive (so both engines agree): a content
    // that is in two places is read once and counted for each.
    const langOf = new Map();
    for (const f of files) langOf.set(f.oid, [...(langOf.get(f.oid) ?? []), f.lang]);
    const oids = [...langOf.keys()];
    if (oids.length) {
      // One fetch for every file needed, rather than one round trip per file on first read.
      await git(['-C', bare, '-c', 'fetch.negotiationAlgorithm=noop', 'fetch', 'origin', '--quiet', '--no-tags', '--no-write-fetch-head', '--recurse-submodules=no', '--filter=blob:none', '--stdin'], { ...opts, input: `${oids.join('\n')}\n` }).catch((error) => {
        if (stop.signal.aborted) throw error;
      });
    }
    const tally = new LocTally();
    let done = 0;
    let said = 0;
    onProgress({ state: 'counting', done, total: oids.length });
    await readBlobs(bare, oids, (oid, body) => {
      if (body.length <= limits.fileBytes) for (const lang of langOf.get(oid) ?? []) tally.add(lang, body);
      done += 1;
      if (Date.now() - said > 250) {
        said = Date.now();
        onProgress({ state: 'counting', done, total: oids.length });
      }
    }, opts);
    onProgress({ state: 'counting', done, total: oids.length });
    if (folderBytes(dir) > limits.repoBytes) throw Object.assign(new Error('too big'), { tooBig: true });
    const sum = tally.summary({ countCategories: COUNTED });
    return measured(address, { ...stats, ...sum, headSha, branch: head, windowDays }, { engine: 'git', now });
  } catch (error) {
    throw Object.assign(error, reason);
  } finally {
    clearTimeout(timer);
    clearInterval(watch);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** One repository through its platform's API: its default branch's archive, read in memory, and its commit list. */
async function measureWithApi(repo, address, { source, allowHost, fetchImpl, tmpRoot, limits, onProgress, now }) {
  const stop = new AbortController();
  const reason = {};
  const timer = setTimeout(() => {
    reason.timedOut = true;
    stop.abort();
  }, limits.timeoutMs);
  const { provider, api, conn } = openSession(source, { allowHost, fetchImpl, signal: stop.signal });
  // A zip (Azure DevOps) is held in a file while it is read: in a folder of its own, swept like a clone's.
  const dir = fs.mkdtempSync(path.join(tmpRoot, TEMP_PREFIX));
  fs.chmodSync(dir, 0o700);
  try {
    const engineRepo = { id: repo.id, name: address.name, fullName: repo.fullName, org: repo.org, project: repo.project, defaultBranch: safeBranch(repo.branch) ? repo.branch : null, createdAt: repo.createdAt ?? null, provider: conn.provider };
    const m = await analyzeRepoApi(engineRepo, {
      session: { provider, api },
      conn,
      workDir: dir,
      windowDays: limits.windowDays,
      maxFileBytes: limits.fileBytes,
      maxArchiveBytes: limits.repoBytes,
      countCategories: COUNTED,
      now,
      onPhase: (phase) => onProgress({ state: phase === 'count' ? 'counting' : phase }),
    });
    return measured(address, { ...m, branch: m.branch ?? repo.branch }, { engine: 'api', now });
  } catch (error) {
    if (/larger than .* MB/.test(error.message ?? '')) reason.tooBig = true;
    throw Object.assign(error, reason);
  } finally {
    clearTimeout(timer);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * One repository measured: with git, or with its platform's API when `engine` is 'api' and it was discovered
 * through `source` (an address pasted, with nothing else known of it, is always cloned). `allowHost(hostname)`:
 * may it be called. Resolves {name, url, host, path, branch, commit, engine, lines, files, languages, commits,
 * windowDays, lastCommitAt, frequency, perWeek, devs90, empty, people} (people: keys to count each person once,
 * never shown or kept).
 */
export async function measureRepository(repo, { source = null, engine = 'git', allowHost = () => true, fetchImpl = null, tmpRoot = os.tmpdir(), limits = GIT_COUNT_LIMITS, onProgress = () => {}, bin = 'git', now = Date.now() } = {}) {
  const address = repoAddress(repo.url);
  if (!allowHost(address.hostname)) throw fail(400, `Repositories on ${address.hostname} are not counted: connect that host on the Beta page, or add it to SCM_ALLOWED_HOSTS.`);
  const secrets = source?.secrets ?? [];
  // The API needs what discovery said: its full name (and id), and its default branch (an empty one has none: git says so).
  const viaApi = engine === 'api' && source && repo.fullName && safeBranch(repo.branch) && (repo.id || source.engine.provider === 'github' || source.engine.provider.startsWith('bitbucket')) && source.authFor(address);
  try {
    if (viaApi) return await measureWithApi(repo, address, { source, allowHost, fetchImpl, tmpRoot, limits, onProgress, now });
    return await measureWithGit(repo, address, { source, tmpRoot, limits, onProgress, bin, now });
  } catch (error) {
    if (error.status && !error.url && !error.timedOut && !error.tooBig) throw Object.assign(new Error(redact(error.message, secrets)), { status: error.status });
    throw fail(502, engineProblem(error, address, secrets, limits));
  }
}

/** Folders a count left behind when the process stopped mid-way (a crash, a restart): removed. */
export function sweepLeftovers(tmpRoot = os.tmpdir(), { olderThanMs = 60 * 60_000 } = {}) {
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(tmpRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(TEMP_PREFIX)) continue;
      const dir = path.join(tmpRoot, entry.name);
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs < olderThanMs) continue;
        fs.rmSync(dir, { recursive: true, force: true });
        removed += 1;
      } catch {}
    }
  } catch {}
  return removed;
}

// ---- Runs, followed by the page ------------------------------------------------------------------

const ID = /^[\w.{}:@ -]{1,200}$/;
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * The repositories asked for, each once and checked: its clone address, and what discovery said of it (source,
 * organization, full name, id, project, branch, created). `sources` names the sources of this run; a repository
 * from another, or pasted, goes with no source unless its host is a source's own (that source's token, then).
 */
export function cleanRepositories(list, { sources = new Map(), limits = GIT_COUNT_LIMITS } = {}) {
  const items = Array.isArray(list) ? list : [];
  if (!items.length) throw fail(400, 'Tick or paste at least one repository.');
  const out = new Map();
  for (const item of items.slice(0, limits.repositories * 2)) {
    const address = repoAddress(typeof item === 'string' ? item : item?.url);
    if (out.has(address.url)) continue;
    const named = typeof item === 'object' && item ? item : {};
    let source = sources.get(String(named.source ?? '')) ?? null;
    if (source && !source.authFor(address) && address.host !== source.gitHost) source = null;
    if (!source) source = [...sources.values()].find((s) => s.authFor(address)) ?? null;
    const fullName = text(named.fullName, 300);
    out.set(address.url, {
      url: address.url,
      name: address.name,
      source: source?.key ?? '',
      branch: safeBranch(named.branch) ? named.branch : '',
      org: ID.test(text(named.org, 200)) ? named.org : '',
      fullName: fullName && fullName.split('/').every((p) => p && p !== '.' && p !== '..' && /^[\w.~ -]+$/.test(p)) ? fullName : '',
      id: ID.test(text(named.id, 200)) ? named.id : '',
      project: ID.test(text(named.project, 200)) ? named.project : '',
      createdAt: Number.isFinite(Date.parse(named.createdAt ?? '')) ? new Date(Date.parse(named.createdAt)).toISOString() : null,
    });
  }
  if (out.size > limits.repositories) throw fail(400, `At most ${limits.repositories} repositories a run: tick fewer, and count the rest after.`);
  return [...out.values()];
}

/**
 * The runs going and just finished, each one person's: started, then followed (view) until done. The sources
 * (and their tokens) are held by the run while it goes and let go when it ends; a view never has them, nor the
 * people's names or emails: each repository says how many people committed, and the run how many different
 * people across it (counted by keys hashed with a salt of the run's own, in memory only). `maxRunning`: runs at
 * once on this server.
 */
export function createGitCounter({ allowHost = () => true, fetchImpl = null, tmpRoot = os.tmpdir(), limits = GIT_COUNT_LIMITS, maxRunning = 2, keepMs = 30 * 60_000, log = () => {}, bin = 'git' } = {}) {
  const jobs = new Map();
  const prune = () => {
    for (const [id, job] of jobs) if (job.state !== 'running' && Date.now() - Date.parse(job.finishedAt) > keepMs) jobs.delete(id);
  };
  const summary = (job) => {
    const done = job.repositories.filter((r) => r.state === 'done');
    return {
      repositories: job.repositories.length,
      measured: done.length,
      failed: job.repositories.filter((r) => r.state === 'failed').length,
      lines: done.reduce((n, r) => n + (r.lines ?? 0), 0),
      commits: done.reduce((n, r) => n + (r.commits ?? 0), 0),
      developers: job.people.size,
      developerDays: DEV_WINDOW_DAYS,
    };
  };
  const view = (job, after = 0) => ({
    id: job.id,
    state: job.state,
    engine: job.engine,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    host: job.host,
    seq: job.seq,
    summary: summary(job),
    repositories: job.repositories.filter((r) => r.seq > after).map((r) => ({ ...r })),
    partial: after > 0,
  });
  return {
    get running() {
      return [...jobs.values()].filter((j) => j.state === 'running').length;
    },
    /** Start measuring `repositories` for `owner` (who asked) with `sources` (a Map by key); resolves the run as the page sees it. */
    async start(owner, { sources = new Map(), source = null, repositories, engine = 'auto' }) {
      prune();
      const known = new Map(sources);
      if (source) known.set(source.key, source);
      const list = cleanRepositories(repositories, { sources: known, limits });
      if ([...jobs.values()].some((j) => j.owner === owner && j.state === 'running')) throw fail(409, 'A count is already running: wait for it to end.');
      if (this.running >= maxRunning) throw fail(409, 'Other counts are running on this server: try again in a few minutes.');
      const chosen = await chooseEngine(engine, bin);
      // Pasted addresses (nothing known but the address) need git, whichever engine was chosen.
      if (chosen === 'api' && list.some((r) => !r.fullName || !r.source)) {
        const missing = await gitMissing(bin);
        if (missing) throw fail(409, `${missing} (Addresses pasted are counted with git.)`);
      }
      const job = {
        id: randomUUID(),
        owner,
        state: 'running',
        engine: chosen,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        host: [...new Set([...known.values()].map((s) => s.gitHost))].join(', '),
        seq: 0,
        salt: randomBytes(16),
        people: new Set(),
        repositories: list.map((r, i) => ({ i, name: r.name, url: r.url, path: r.fullName || '', org: r.org, source: r.source, branch: r.branch, state: 'waiting', done: 0, total: 0, commit: '', lines: null, languages: null, error: '', seq: 0 })),
      };
      const touch = (row, patch) => {
        Object.assign(row, patch);
        job.seq += 1;
        row.seq = job.seq;
      };
      job.repositories.forEach((row) => touch(row, {}));
      jobs.set(job.id, job);
      let held = known;
      const secretsOf = (key) => held?.get(key)?.secrets ?? [];
      pool(list, Math.min(limits.concurrency, list.length), async (repo, index) => {
        const row = job.repositories[index];
        const src = held?.get(repo.source) ?? null;
        try {
          const result = await measureRepository(repo, { source: src, engine: chosen, allowHost, fetchImpl, tmpRoot, limits, bin, onProgress: (p) => touch(row, p) });
          const { people, ...shown } = result;
          for (const key of people) job.people.add(createHash('sha256').update(job.salt).update(key).digest('base64'));
          touch(row, { ...shown, state: 'done', path: row.path || shown.path, countedAt: new Date().toISOString() });
        } catch (error) {
          touch(row, { state: 'failed', error: error.status ? redact(error.message, secretsOf(repo.source)) : 'Not counted: something went wrong.' });
          if (!error.status) log(`[calculator] Counting ${row.url} from git failed: ${redact(error.stack ?? error.message, secretsOf(repo.source))}`);
        }
      })
        .catch((error) => log(`[calculator] A count stopped: ${redact(error.message, [...(held?.values() ?? [])].flatMap((s) => s.secrets))}`))
        .finally(() => {
          held = null;
          job.salt = null;
          Object.assign(job, { state: 'done', finishedAt: new Date().toISOString() });
          job.seq += 1;
        });
      return view(job);
    },
    /** A run as the page follows it: only its owner's; `after`: only the repositories changed since that view's seq. */
    view(owner, id, { after = 0 } = {}) {
      prune();
      const job = jobs.get(String(id ?? ''));
      if (!job || job.owner !== owner) throw fail(404, 'That count is no longer here: count again.');
      const since = Number(after);
      return view(job, Number.isFinite(since) && since > 0 ? since : 0);
    },
  };
}

// ---- cloc-fusion's one-file page, handed out by the tab -------------------------------------------

let page = null;
/**
 * cloc-fusion.html (src/cloc-fusion/), checked against the SHA-256 noted when it was copied in: {file, version,
 * commit, sha256, bytes, html}. Refused when it does not match (changed since: not handed out).
 */
export function clocFusionPage() {
  if (page) return page;
  const file = new URL(`./cloc-fusion/${CLOC_FUSION.page}`, import.meta.url);
  const bytes = fs.readFileSync(file);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== CLOC_FUSION.sha256) throw fail(500, 'The copy of cloc-fusion here does not match its checksum: it is not handed out.');
  page = Object.freeze({ file: CLOC_FUSION.page, version: CLOC_FUSION.version, commit: CLOC_FUSION.commit, sha256, bytes: bytes.length, html: bytes.toString('utf8') });
  return page;
}

export { FREQUENCIES };
