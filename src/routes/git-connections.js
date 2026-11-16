/**
 * The git connections (GitHub, GitLab, Azure DevOps, Bitbucket): what Settings stores for each, else what the
 * environment gives; which hosts a clone may go to; a check of each connection; and GET /api/connections, the
 * state of every connection for the header's chips (Checkmarx One, the mail server, the git hosts).
 *
 * createGitConnections makes the helpers (githubConfig, gitSets, scmHosts, githubClient, cloneHostAllowed): they
 * are handed back to src/server.js for the areas that read code (code authors, SLA issues, the calculator's count
 * of code, the network page). registerGitConnectionRoutes registers the one route, where it always was.
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { GitHubClient } from '../github/client.js';
import { gitHostOf } from '../github/identity.js';
import { SCM_LABELS, SCM_PROVIDERS, scmClients, scmConfigs, checkConnections as checkScmConnections } from '../scm/providers.js';
import { explainGit } from '../troubleshoot.js';
import { hostOfUrl, isVerified } from '../settings.js';
import { INSTANCE_VARS, extraInstanceNumbers, instanceSource, providersIn } from '../scm/instances.js';
import { scoped } from '../tenancy.js';

/**
 * The helpers, made before the routes of any area that uses them.
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function createGitConnections(d) {
  const { dataDir, tenancy, tstate, settingsStore, integrationStatus } = d;

  // ---------------------------------------------------------------------------
  // Beta: GitHub identity matching, and emailing the authors of vulnerable code
  // ---------------------------------------------------------------------------

  const gitCacheDir = path.join(dataDir, 'git-cache');

  /** The GitHub connection: what Settings stores, else GITHUB_TOKEN / GITHUB_API_URL / GITHUB_ORG from the environment. */
  function githubConfig(settings = settingsStore.get(), source = process.env) {
    const github = settings.beta?.github ?? {};
    const env = (name) => String(source[name] ?? '').trim();
    const defaultApi = !github.apiUrl || github.apiUrl === 'https://api.github.com';
    const apiUrl = defaultApi && env('GITHUB_API_URL') ? env('GITHUB_API_URL').replace(/\/+$/, '') : github.apiUrl || 'https://api.github.com';
    // GITHUB_TOKEN goes only to the host GITHUB_API_URL names (else api.github.com):
    // pointing the API address elsewhere on the Beta page never sends it there.
    const envToken = env('GITHUB_TOKEN') && hostOfUrl(apiUrl) === (hostOfUrl(env('GITHUB_API_URL')) || 'api.github.com') ? env('GITHUB_TOKEN') : '';
    return {
      ...github,
      token: github.token || envToken,
      tokenSource: github.token ? 'settings' : envToken ? 'environment' : 'none',
      apiUrl,
      org: github.org || env('GITHUB_ORG'),
    };
  }

  /**
   * The hosts repositories are cloned from: the public GitHub, GitLab, Bitbucket and Azure DevOps,
   * the hosts connected on the Beta page or in the environment, and SCM_ALLOWED_HOSTS. A
   * repository address from a project or a setting never makes the server call anything else.
   */
  const PUBLIC_SCM_HOSTS = ['github.com', 'gitlab.com', 'bitbucket.org', 'dev.azure.com'];
  function cloneHostAllowed(host) {
    const name = String(host ?? '').toLowerCase();
    if (PUBLIC_SCM_HOSTS.includes(name) || name.endsWith('.visualstudio.com')) return true;
    const settings = settingsStore.get();
    const scm = scmConfigs(settings);
    const hostname = (value) => String(value ?? '').toLowerCase().replace(/:\d+$/, '');
    const known = [gitHostOf(githubConfig(settings).apiUrl), scm.gitlab.host, scm.azure.host, scm.bitbucket.host, ...gitSets(settings).slice(1).flatMap((set) => set.hosts.map((h) => h.host))].map(hostname);
    const extra = String(process.env.SCM_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
    return known.includes(name) || extra.includes(name);
  }

  /** GitLab, Azure DevOps and Bitbucket: their connections and API clients (built per use: settings may change). */
  function scmHosts(settings = settingsStore.get()) {
    const configs = scmConfigs(settings);
    return { configs, clients: scmClients(configs) };
  }

  function githubClient(settings = settingsStore.get()) {
    const github = githubConfig(settings);
    return new GitHubClient({ token: github.token, apiUrl: github.apiUrl });
  }

  const urlPath = (url) => {
    try {
      return new URL(url).pathname.split('/').filter(Boolean);
    } catch {
      return [];
    }
  };

  /**
   * Every set of git connections: the first (Beta page, plain variables), then
   * the numbered ones (GITHUB_TOKEN_2 …, src/scm/instances.js). Each set: its
   * GitHub and other hosts' connections, and the hosts it holds a token for.
   */
  function gitSets(settings = settingsStore.get()) {
    const describe = (n, github, scm, named) => {
      const owner = (value) => String(value ?? '').toLowerCase();
      const hosts = [];
      if (github.token) hosts.push({ provider: 'github', host: gitHostOf(github.apiUrl), owner: owner(github.org) });
      if (scm.gitlab.token) hosts.push({ provider: 'gitlab', host: scm.gitlab.host, owner: owner(scm.gitlab.group).split('/')[0] });
      if (scm.azure.token && scm.azure.host) hosts.push({ provider: 'azure', host: scm.azure.host, owner: owner(urlPath(scm.azure.orgUrl)[0]) });
      if (scm.bitbucket.token) hosts.push({ provider: 'bitbucket', host: scm.bitbucket.host, owner: owner(scm.bitbucket.workspace) });
      return { n, github, scm, hosts, named };
    };
    const sets = [describe(1, githubConfig(settings), scmConfigs(settings), null)];
    for (const n of extraInstanceNumbers(settings)) {
      const source = instanceSource(settings, n);
      sets.push(describe(n, githubConfig({}, source), scmConfigs({}, source), new Set(providersIn(source))));
    }
    return sets;
  }

  /**
   * The connections the header shows, green or red, with a few details:
   * Checkmarx One (the server's integration), the mail server (passed its test
   * with the current settings), and every git host (each token answers).
   */
  async function connectionsStatus() {
    const settings = settingsStore.get();
    const cx = integrationStatus();
    const smtp = settings.smtp ?? {};
    const verified = isVerified(settings);
    const git = await gitConnections(settings);
    const gh = git.instances.find((i) => i.provider === 'github' && i.n === 1);
    return {
      cxone: {
        ok: cx.connected,
        tenant: cx.connection?.tenant ?? '',
        apiUrl: cx.connection?.baseUrl ?? '',
        iamUrl: cx.connection?.iamUrl ?? '',
        source: cx.source,
        pending: cx.pending,
        reason: cx.connected ? (cx.pending ? 'A changed connection is being checked; the last known good one is in use.' : '') : 'Not connected: an Admin connects it under Settings → Checkmarx One integration, or with CX_API_KEY.',
        help: (!cx.connected || cx.pending) ? tstate.connectionHelp?.cxone : undefined,
      },
      smtp: {
        ok: Boolean(smtp.host) && verified,
        host: smtp.host ?? '',
        port: smtp.port ?? null,
        tls: smtp.secure ? 'implicit TLS' : 'STARTTLS',
        from: smtp.fromAddress || smtp.user || '',
        verifiedAt: verified ? settings.verifiedAt ?? null : null,
        reason: !smtp.host ? 'No mail server: set it under Settings → Email server, or with SMTP_HOST in the .env file.' : verified ? '' : 'Not tested with these settings: Settings → Email server → Test connection.',
        help: verified ? undefined : tstate.connectionHelp?.smtp,
      },
      // Every git host and instance, for the header's Git chip (one logo each).
      git,
      // The first GitHub connection, as before (kept for callers of this shape).
      github: gh
        ? { ok: gh.ok, login: gh.who, apiUrl: gh.url, org: gh.owner, source: gh.source, checkedAt: gh.checkedAt, reason: gh.reason }
        : { ok: false, login: '', apiUrl: githubConfig(settings).apiUrl, org: '', source: 'none', checkedAt: null, reason: 'No GitHub token: add GITHUB_TOKEN to the .env file, or set it on the Beta page.' },
    };
  }

  /** Results of checking each git connection: at most every 5 minutes, and again when its settings change. */
  const gitChecks = scoped(tenancy, 'gitChecks');
  const GIT_CHECK_MS = 5 * 60_000;

  /** Ask one host who its token belongs to. */
  async function checkGitInstance(provider, set) {
    if (provider === 'github') {
      const user = await new GitHubClient({ token: set.github.token, apiUrl: set.github.apiUrl }).rest('/user');
      return user?.login ?? '';
    }
    const result = (await checkScmConnections(scmClients(set.scm), set.scm, [provider]))[provider];
    if (!result) throw new Error(provider === 'azure' ? 'set the organisation address (AZURE_DEVOPS_ORG_URL) too' : 'no answer');
    if (!result.ok) throw Object.assign(new Error(result.reason.replace(/^[^:]*refused: /, '')), { help: result.help });
    return result.who ?? '';
  }

  /**
   * Every git connection: GitHub, GitLab, Azure DevOps and Bitbucket, the first of
   * each and the numbered ones (GITHUB_TOKEN_2 …), each checked with its host.
   * Hosts with no connection are listed too, with what to add.
   */
  async function gitConnections(settings = settingsStore.get()) {
    const instances = [];
    const checks = [];
    for (const set of gitSets(settings)) {
      for (const provider of SCM_PROVIDERS) {
        const cfg = provider === 'github' ? set.github : set.scm[provider];
        const token = cfg.token;
        // The first set lists a host once it has a token; a numbered set, once its variables name the host.
        if (!token && !(set.named?.has(provider))) continue;
        const url = provider === 'github' ? cfg.apiUrl : provider === 'azure' ? cfg.orgUrl : cfg.apiUrl;
        const owner = provider === 'github' ? cfg.org : provider === 'gitlab' ? cfg.group : provider === 'azure' ? urlPath(cfg.orgUrl)[0] ?? '' : cfg.workspace;
        const vars = INSTANCE_VARS[provider];
        const suffix = set.n === 1 ? '' : `_${set.n}`;
        const entry = { provider, n: set.n, label: SCM_LABELS[provider], url: url ?? '', host: url ? hostOfUrl(url) : '', owner: owner ?? '', source: set.n === 1 ? cfg.tokenSource : 'environment', variables: `${vars.token}${suffix}`, ok: false, who: '', checkedAt: null, reason: '' };
        instances.push(entry);
        if (!token) {
          entry.reason = `No token: add ${vars.token}${suffix} to the .env file.`;
          continue;
        }
        const key = createHash('sha256').update(`${provider}|${url}|${token}`).digest('hex');
        const cached = gitChecks.get(key);
        if (cached && Date.now() - cached.at < GIT_CHECK_MS) {
          Object.assign(entry, cached.result, { checkedAt: new Date(cached.at).toISOString() });
          continue;
        }
        checks.push(
          checkGitInstance(provider, set)
            .then((who) => ({ ok: true, who: String(who ?? ''), reason: '' }))
            .catch((error) => ({ ok: false, who: '', reason: `${SCM_LABELS[provider]} refused the token: ${error.message}`, help: error.help ?? explainGit(provider, error, { url, variable: entry.variables }) }))
            .then((result) => {
              const at = Date.now();
              gitChecks.set(key, { at, result });
              Object.assign(entry, result, { checkedAt: new Date(at).toISOString() });
            }),
        );
      }
    }
    await Promise.all(checks);
    // Grouped by host, so two GitHub connections sit side by side.
    instances.sort((a, b) => SCM_PROVIDERS.indexOf(a.provider) - SCM_PROVIDERS.indexOf(b.provider) || a.n - b.n);
    if (gitChecks.size > 64) for (const [key, value] of gitChecks) if (Date.now() - value.at > GIT_CHECK_MS) gitChecks.delete(key);
    const missing = SCM_PROVIDERS.filter((p) => !instances.some((i) => i.provider === p)).map((p) => ({ provider: p, label: SCM_LABELS[p], variables: INSTANCE_VARS[p].token }));
    const connected = instances.filter((i) => i.ok).length;
    return {
      ok: instances.length > 0 && connected === instances.length,
      connected,
      total: instances.length,
      instances,
      missing,
      reason: instances.length ? (connected === instances.length ? '' : `${instances.length - connected} of ${instances.length} git connection(s) not working.`) : 'No git host connected: add GITHUB_TOKEN, GITLAB_TOKEN, AZURE_DEVOPS_TOKEN or BITBUCKET_TOKEN to the .env file.',
    };
  }

  return { gitCacheDir, githubConfig, cloneHostAllowed, scmHosts, githubClient, gitSets, connectionsStatus };
}

/**
 * GET /api/connections.
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerGitConnectionRoutes(app, d) {
  const { asyncRoute, requireSession, connectionsStatus } = d;

  app.get('/api/connections', requireSession, asyncRoute(async (req, res) => res.json(await connectionsStatus())));
}
