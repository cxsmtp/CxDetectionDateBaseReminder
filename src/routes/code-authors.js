/**
 * Who wrote the code (Labs): matching Checkmarx One users to their git host accounts, and finding and emailing the
 * author of the vulnerable lines.
 *
 * - /api/beta/github/* and /api/beta/scm/*: identity matching (feature:identityMatching), for GitHub and for the
 *   other git hosts (GitLab, Azure DevOps, Bitbucket): the logins found, how well each method does, applying one.
 * - /api/beta/authors/*: the author of each finding's lines from git blame (feature:codeAuthors), and the email
 *   to them. Scheduled reminders use the same notifyCodeAuthors once the feature is final.
 */
import { selectRisks } from '../cxone/risks.js';
import { resultRowsFor } from '../cxone/ai-assist.js';
import { mapWithConcurrency } from '../cxone/client.js';
import { GitHubClient } from '../github/client.js';
import { METHODS as GITHUB_METHODS, ensureClone, evaluate as evaluateGithub, loginFromNoreply, resolveLogins, usableEmail, validLogin } from '../github/identity.js';
import { blameFindings, codeVersion, locationOf, onGitHub, parseRepoUrl } from '../github/blame.js';
import { SCM_LABELS, SCM_PROVIDERS, checkConnections as checkScmConnections, cloneAuthFor, methodsFor, providerOf, scmClients, scmConfigs } from '../scm/providers.js';
import { addressesAsThemselves, evaluateMethods, resolveWith, validUsername } from '../scm/identity.js';
import { addOwnership } from '../scm/ownership.js';
import { riskUrl } from '../links.js';
import { sendReminderMail } from '../mailer.js';
import { isVerified } from '../settings.js';
import { setForRepo } from '../scm/instances.js';
import { isFinal } from '../features.js';
import { escapeHtmlText, idList } from './shared.js';

/**
 * @param {import('express').Express} app
 * @param {object} d  what src/server.js hands over (listed where it calls this)
 */
export function registerCodeAuthorRoutes(app, d) {
  const {
    settingsStore, asyncRoute, requirePermission, requireFeature, sendingSettings, NOT_EXPLOITABLE_STATES,
    LOCATABLE_SCANNERS, gitCacheDir, githubConfig, scmHosts, githubClient, gitSets, initiatorLogins,
  } = d;

  app.get('/api/beta/github/logins', requireFeature('identityMatching'), (req, res) => {
    const lastScan = req.session.lastScan;
    const unresolved = new Set(
      Object.values(lastScan?.initiators ?? {})
        .filter((info) => info?.initiator && !info.email)
        .map((info) => info.initiator),
    );
    res.json({ logins: initiatorLogins(lastScan).map((login) => ({ login, unresolved: unresolved.has(login) })) });
  });

  /** Run the identity methods side by side on real logins and compare them. */
  app.post(
    '/api/beta/github/evaluate',
    requireFeature('identityMatching'),
    asyncRoute(async (req, res) => {
      const settings = settingsStore.get();
      const github = settings.beta?.github ?? {};
      const body = req.body ?? {};
      const logins = (Array.isArray(body.logins) && body.logins.length ? body.logins : initiatorLogins(req.session.lastScan))
        .map((l) => String(l).trim())
        .filter(validLogin)
        .slice(0, 500);
      if (!logins.length) return res.status(400).json({ error: 'No GitHub usernames to match. Fetch projects first, or enter usernames.' });
      const methods = (Array.isArray(body.methods) ? body.methods : GITHUB_METHODS).filter((m) => GITHUB_METHODS.includes(m));
      const report = await evaluateGithub(githubClient(settings), logins, {
        methods,
        org: github.org,
        repos: github.repos ?? [],
        localSources: github.localRepos ?? [],
        cacheDir: gitCacheDir,
      });
      res.json(report);
    }),
  );

  /** Save chosen matches as initiator overrides (username = email), used from the next fetch. */
  app.post('/api/beta/github/apply', requireFeature('identityMatching'), (req, res) => {
    const mappings = (Array.isArray(req.body?.mappings) ? req.body.mappings : [])
      .map((m) => ({ login: String(m?.login ?? '').trim(), email: String(m?.email ?? '').trim().toLowerCase() }))
      .filter((m) => validLogin(m.login) && usableEmail(m.email));
    if (!mappings.length) return res.status(400).json({ error: 'Pick at least one match to use.' });
    const current = settingsStore.get().initiators;
    const overrides = { ...(current.overrides ?? {}) };
    for (const { login, email } of mappings) overrides[login] = email;
    const saved = settingsStore.save({ initiators: { ...current, overrides } });
    res.json({ applied: mappings.length, overrides: Object.keys(saved.initiators.overrides ?? {}).length });
  });

  /**
   * Usernames → addresses on any host. GitHub keeps its own four methods (above); GitLab,
   * Azure DevOps and Bitbucket have theirs (src/scm). Scan initiators are offered for the
   * host their project's repository is on (all of them when that is not known).
   */
  app.get('/api/beta/scm/logins', requireFeature('identityMatching'), (req, res) => {
    const provider = SCM_PROVIDERS.includes(req.query.provider) ? req.query.provider : 'github';
    const lastScan = req.session.lastScan;
    const settings = settingsStore.get();
    const configs = scmConfigs(settings);
    const projects = new Map((lastScan?.projects ?? []).map((p) => [p.projectId, p]));
    const out = new Map();
    for (const [projectId, info] of Object.entries(lastScan?.initiators ?? {})) {
      const name = String(info?.initiator ?? '').trim();
      if (!name || name.includes('@') || !validUsername(provider, name)) continue;
      const on = providerOf(parseRepoUrl(projects.get(projectId)?.repoUrl ?? ''), configs, githubConfig(settings).apiUrl);
      if (on && on !== provider) continue;
      const entry = out.get(name) ?? { login: name, unresolved: false, onHost: false };
      entry.unresolved ||= !info.email;
      entry.onHost ||= on === provider;
      out.set(name, entry);
    }
    res.json({ logins: [...out.values()] });
  });

  app.post(
    '/api/beta/scm/evaluate',
    requireFeature('identityMatching'),
    asyncRoute(async (req, res) => {
      const provider = String(req.body?.provider ?? '');
      if (!SCM_PROVIDERS.includes(provider) || provider === 'github') return res.status(400).json({ error: 'Choose GitLab, Azure DevOps or Bitbucket (GitHub has its own comparison).' });
      const settings = settingsStore.get();
      const logins = [...new Set((Array.isArray(req.body?.logins) ? req.body.logins : []).map((l) => String(l).trim()).filter((l) => validUsername(provider, l) || usableEmail(l)))].slice(0, 500);
      if (!logins.length) return res.status(400).json({ error: `No ${SCM_LABELS[provider]} usernames to match. Load the scan initiators, or type them in.` });
      const { configs, clients } = scmHosts(settings);
      const methods = methodsFor(provider, clients, configs, { localSources: settingsStore.get().beta?.github?.localRepos ?? [], cacheDir: gitCacheDir });
      const chosen = Array.isArray(req.body?.methods) && req.body.methods.length ? req.body.methods.map(String) : null;
      const report = await evaluateMethods({ methods, logins, client: clients[provider], chosen });
      // Usernames that are already addresses need no method.
      for (const [login, hit] of Object.entries(addressesAsThemselves(logins))) report.combined[login] ??= { ...hit, method: 'address' };
      report.resolved = Object.keys(report.combined).length;
      report.provider = provider;
      res.json(report);
    }),
  );

  app.post('/api/beta/scm/apply', requireFeature('identityMatching'), (req, res) => {
    const provider = SCM_PROVIDERS.includes(req.body?.provider) ? req.body.provider : 'github';
    const mappings = (Array.isArray(req.body?.mappings) ? req.body.mappings : [])
      .map((m) => ({ login: String(m?.login ?? '').trim(), email: String(m?.email ?? '').trim().toLowerCase() }))
      .filter((m) => validUsername(provider, m.login) && usableEmail(m.email));
    if (!mappings.length) return res.status(400).json({ error: 'Pick at least one match to use.' });
    const current = settingsStore.get().initiators;
    const overrides = { ...(current.overrides ?? {}) };
    for (const { login, email } of mappings) overrides[login] = email;
    const saved = settingsStore.save({ initiators: { ...current, overrides } });
    res.json({ applied: mappings.length, overrides: Object.keys(saved.initiators.overrides ?? {}).length });
  });

  /** Are the GitLab, Azure DevOps and Bitbucket tokens accepted? */
  app.post(
    '/api/beta/scm/check',
    requirePermission('beta.use'),
    asyncRoute(async (req, res) => {
      const { configs, clients } = scmHosts();
      const only = SCM_PROVIDERS.includes(req.body?.provider) ? [req.body.provider] : SCM_PROVIDERS;
      const results = await checkScmConnections(clients, configs, only);
      for (const id of only) if (id !== 'github' && !results[id]) results[id] = { ok: false, reason: `No ${SCM_LABELS[id]} token set.` };
      res.json(results);
    }),
  );

  const AUTHOR_LIMIT_MAX = 300;

  /**
   * Find who wrote the vulnerable code of the fetched findings: exact file and
   * line from the scan results, blame at the scanned commit, and the author's
   * real address (noreply addresses resolved through the identity methods).
   */
  app.post(
    '/api/beta/authors/find',
    requireFeature('codeAuthors'),
    asyncRoute(async (req, res) => {
      const { lastScan, client, connection } = req.session;
      if (!lastScan) return res.status(409).json({ error: 'Load findings on the Workbench first.' });
      const settings = settingsStore.get();
      const { severities = null } = req.body ?? {};
      const projectIds = idList(req.body?.projectIds);
      const limit = Math.min(AUTHOR_LIMIT_MAX, Math.max(1, Number(req.body?.limit) || 50));

      const rank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
      const risks = selectRisks(lastScan.projects, {
        projectIds: projectIds?.length ? projectIds : null,
        buckets: [],
        severities: severities?.length ? severities : null,
      })
        .filter((r) => !NOT_EXPLOITABLE_STATES.has(r.state))
        .sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || (b.ageDays ?? 0) - (a.ageDays ?? 0))
        .slice(0, limit)
        .map((r) => ({ ...r }));
      if (!risks.length) return res.status(400).json({ error: 'No findings match that selection.' });

      const { items: result, summary } = await findCodeAuthors(risks, { client, connection, settings, projects: lastScan.projects, initiators: lastScan.initiators });
      req.session.lastAuthors = result;
      res.json({ items: result, summary });
    }),
  );

  /**
   * Who last changed the line of each finding (SAST and KICS), at the scanned commit, and
   * their real address: [{key, finding fields, location, commit, author: {name, login, email}}]
   * with a summary. Used by the Code authors page and by scheduled reminders.
   */
  async function findCodeAuthors(risks, { client, connection, settings, projects: projectList, initiators = {} }) {
    const github = settings.beta?.github ?? {};
    const projects = new Map(projectList.map((p) => [p.projectId, p]));
    const scanIdOf = (f) => f.scanId || initiators?.[f.projectId]?.scanId || '';
    const locatable = risks.filter((r) => r.scanner === 'SAST' || r.scanner === 'KICS' || r.scanner === 'IAC');
    const rows = await resultRowsFor(client, locatable, scanIdOf);

    const scans = new Map();
    await mapWithConcurrency([...new Set(locatable.map(scanIdOf).filter(Boolean))], 4, async (scanId) => {
      try {
        scans.set(scanId, await client.request(`/api/scans/${encodeURIComponent(scanId)}`, { retries: 1 }));
      } catch {
        scans.set(scanId, null);
      }
    });

    const items = risks.map((finding) => {
      const project = projects.get(finding.projectId) ?? {};
      const item = {
        finding,
        url: riskUrl(finding, connection, settings.links, scanIdOf(finding)),
      };
      if (!locatable.includes(finding)) {
        item.problem = finding.scanner === 'SCA' ? 'Open-source package: no line of your code to blame.' : `${finding.scanner} findings have no code line.`;
        return item;
      }
      const row = rows.get(finding);
      item.location = row ? locationOf(row) : null;
      if (!item.location?.path || !item.location.line) {
        item.problem = 'Checkmarx One gave no file and line for this finding.';
        return item;
      }
      item.version = codeVersion(scans.get(scanIdOf(finding)), project);
      item.repo = parseRepoUrl(item.version.repoUrl);
      if (!item.repo) item.problem = 'No repository is linked to this project in Checkmarx One (scan uploaded without a repository URL).';
      return item;
    });

    const gh = githubClient(settings);
    const hosts = scmHosts(settings);
    // Each repository is blamed with the connection that fits it: the first set, or a numbered one (GITHUB_TOKEN_2 …).
    const sets = gitSets(settings);
    const bySet = new Map(sets.map((set) => [set, []]));
    for (const item of items) bySet.get(setForRepo(sets, item.repo)).push(item);
    for (const [set, group] of bySet) {
      if (!group.length) continue;
      const first = set.n === 1;
      const setGh = first ? gh : new GitHubClient({ token: set.github.token, apiUrl: set.github.apiUrl });
      const setScm = first ? hosts : { configs: set.scm, clients: scmClients(set.scm) };
      await blameFindings(group, {
        gh: setGh,
        apiUrl: set.github.apiUrl,
        cacheDir: gitCacheDir,
        token: set.github.token,
        useGithub: settings.beta?.authors?.useGithubBlame !== false,
        useLocal: settings.beta?.authors?.useLocalBlame !== false,
        scm: setScm,
      });
      // Read-only extras: the file's code owners (CODEOWNERS), and the pull or merge request the
      // blamed commit came in through, with who approved it. Missing ones are simply left out.
      await addOwnership(group.filter((i) => i.blame), {
        github: (repo) => (setGh.hasToken && onGitHub(repo, set.github.apiUrl) ? setGh : null),
        gitlab: (repo) => (setScm.configs.gitlab?.token && repo.host === setScm.configs.gitlab.host ? setScm.clients.gitlab : null),
        // Only a clone git blame already made is read: never a new clone just for this.
        clone: (item) =>
          item.blame?.via === 'git blame' && item.repo?.cloneUrl
            ? ensureClone(item.repo.cloneUrl, {
                cacheDir: gitCacheDir,
                blobs: true,
                token: onGitHub(item.repo, set.github.apiUrl) ? set.github.token : '',
                authHeader: item.provider && item.provider !== 'github' ? cloneAuthFor(item.repo.cloneUrl, setScm.configs) : '',
              })
            : null,
      }).catch(() => {});
    }

    // Authors who hid their address behind GitHub's noreply one: resolve the
    // login, starting with the history of the repositories just cloned.
    const logins = new Set();
    for (const item of items) {
      if (!item.blame || (item.provider && item.provider !== 'github')) continue;
      const login = item.blame.login || loginFromNoreply(item.blame.authorEmail);
      if (login && !usableEmail(item.blame.authorEmail)) logins.add(login);
    }
    // On GitLab, Azure DevOps or Bitbucket: that host's own methods, cheapest first.
    const elsewhere = new Map(); // provider -> Set of usernames
    for (const item of items) {
      if (!item.blame || !item.provider || item.provider === 'github' || usableEmail(item.blame.authorEmail)) continue;
      const login = item.blame.login || loginFromNoreply(item.blame.authorEmail) || item.blame.authorName;
      if (!login) continue;
      if (!elsewhere.has(item.provider)) elsewhere.set(item.provider, new Set());
      elsewhere.get(item.provider).add(login);
    }
    const resolvedElsewhere = {};
    for (const [provider, names] of elsewhere) {
      const clones = [...new Set(items.filter((i) => i.provider === provider && i.repo).map((i) => i.repo.cloneUrl))];
      const methods = methodsFor(provider, hosts.clients, hosts.configs, { localSources: [...clones, ...(github.localRepos ?? [])], cacheDir: gitCacheDir });
      const found = await resolveWith(methods, [...names]);
      for (const [login, hit] of Object.entries(found)) resolvedElsewhere[`${provider}|${login}`] = hit;
    }
    let resolved = {};
    if (logins.size) {
      const clones = [];
      for (const url of new Set(items.filter((i) => i.repo).map((i) => i.repo.cloneUrl))) {
        try {
          clones.push((await ensureClone(url, { cacheDir: gitCacheDir, blobs: true })).dir);
        } catch {}
      }
      resolved = await resolveLogins(gh, [...logins], {
        org: github.org,
        repos: github.repos ?? [],
        localSources: [...clones, ...(github.localRepos ?? [])],
        cacheDir: gitCacheDir,
      });
    }

    const result = items.map((item) => {
      const f = item.finding;
      const out = {
        key: `${f.projectId}|${f.riskId}`,
        projectId: f.projectId,
        projectName: f.projectName,
        title: f.title,
        severity: f.severity,
        scanner: f.scanner,
        ageDays: f.ageDays,
        url: item.url,
        location: item.location ?? null,
        problem: item.problem ?? '',
      };
      if (item.blame) {
        const onGithub = !item.provider || item.provider === 'github';
        const login = item.blame.login || loginFromNoreply(item.blame.authorEmail);
        const found = onGithub ? resolved[login] : resolvedElsewhere[`${item.provider}|${login || item.blame.authorName}`];
        const email = usableEmail(item.blame.authorEmail) ? item.blame.authorEmail : found?.email ?? '';
        Object.assign(out, {
          commit: item.blame.commit,
          commitUrl: item.blame.url || (item.repo?.host === 'github.com' ? `https://github.com/${item.repo.owner}/${item.repo.repo}/commit/${item.blame.commit}` : ''),
          committedAt: item.blame.date,
          via: item.blame.via,
          ref: item.blame.ref,
          author: {
            name: item.blame.authorName,
            login,
            email,
            emailVia: usableEmail(item.blame.authorEmail) ? 'commit' : found ? `${onGithub ? '' : `${SCM_LABELS[item.provider]}: `}${found.method}` : '',
          },
          host: SCM_LABELS[item.provider] ?? item.repo?.host ?? '',
          // How sure the answer is (src/github/blame.js, confidenceOf): only 'high' is emailed without someone choosing it.
          confidence: item.confidence?.level ?? 'low',
          confidenceReason: item.confidence?.reason ?? '',
          skippedBots: item.blame.skippedBots?.length ?? 0,
          owners: item.owners ?? null,
          change: item.change ?? null,
        });
        if (!email) out.problem = `Author ${item.blame.authorName || login} hides their email address and it could not be resolved.`;
      }
      return out;
    });

    const withEmail = result.filter((r) => r.author?.email);
    return {
      items: result,
      summary: {
        findings: result.length,
        blamed: result.filter((r) => r.commit).length,
        sure: result.filter((r) => r.commit && r.confidence === 'high').length,
        unsure: result.filter((r) => r.commit && r.confidence !== 'high').length,
        withEmail: withEmail.length,
        authors: new Set(withEmail.map((r) => r.author.email)).size,
        githubRequests: gh.totalRequests,
        hostRequests: Object.fromEntries(Object.entries(hosts.clients).filter(([, c]) => c?.totalRequests).map(([id, c]) => [id, c.totalRequests])),
      },
    };
  }

  const AUTOMATION_AUTHOR_LIMIT = 200;

  /**
   * Scheduled reminders, the code authors' part: the developer who last changed the line of
   * each finding that just crossed a threshold gets one email with theirs. Only once "Code
   * authors" is final; the most severe first, up to 200 findings a run.
   */
  async function notifyCodeAuthors(crossed, { client, connection, projects, initiators, dryRun }) {
    const settings = sendingSettings();
    if (!isFinal(settings, 'codeAuthors')) return { skipped: 'Code authors is still a Beta feature.' };
    const rank = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    const risks = crossed
      .filter((r) => LOCATABLE_SCANNERS.has(r.scanner))
      .sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || (b.ageDays ?? 0) - (a.ageDays ?? 0))
      .slice(0, AUTOMATION_AUTHOR_LIMIT);
    if (!risks.length) return { findings: 0, authors: 0, emailed: 0 };
    const { items } = await findCodeAuthors(risks, { client, connection, settings, projects, initiators });
    // Unattended: only answers git blame is sure of. An unsure one waits for someone to look at it.
    const byAuthor = new Map();
    for (const item of items) {
      if (!item.author?.email || item.confidence !== 'high') continue;
      if (!byAuthor.has(item.author.email)) byAuthor.set(item.author.email, { author: item.author, items: [] });
      byAuthor.get(item.author.email).items.push(item);
    }
    const failures = [];
    let emailed = 0;
    for (const { author, items: list } of byAuthor.values()) {
      if (dryRun) {
        emailed += 1;
        continue;
      }
      try {
        await sendReminderMail(settings, authorMessage(author, list, settings), { exact: true, to: [author.email] });
        emailed += 1;
      } catch (error) {
        failures.push({ to: author.email, error: error.message });
      }
    }
    return { findings: risks.length, blamed: items.filter((i) => i.commit).length, unsure: items.filter((i) => i.commit && i.confidence !== 'high').length, authors: byAuthor.size, emailed, failures };
  }

  /** Email each code author the vulnerable code they wrote (or preview it). */
  app.post(
    '/api/beta/authors/notify',
    requireFeature('codeAuthors'),
    asyncRoute(async (req, res) => {
      const items = req.session.lastAuthors;
      if (!items?.length) return res.status(409).json({ error: 'Find the code authors first.' });
      const settings = sendingSettings();
      const dryRun = req.body?.dryRun === true;
      if (!dryRun && !isVerified(settings)) return res.status(400).json({ error: 'Test the SMTP connection on the Settings page before sending.' });
      const chosen = Array.isArray(req.body?.keys) && req.body.keys.length ? new Set(req.body.keys) : null;

      const byAuthor = new Map();
      for (const item of items) {
        if (!item.author?.email || (chosen && !chosen.has(item.key))) continue;
        if (!byAuthor.has(item.author.email)) byAuthor.set(item.author.email, { author: item.author, items: [] });
        byAuthor.get(item.author.email).items.push(item);
      }
      if (!byAuthor.size) return res.status(400).json({ error: 'None of the chosen findings has an author with an email address.' });

      const messages = [...byAuthor.values()].map(({ author, items: list }) => authorMessage(author, list, settings));
      if (dryRun) {
        return res.json({ dryRun: true, recipients: messages.map((m) => ({ to: m.to, findings: m.count })), subject: messages[0].subject, html: messages[0].html });
      }
      const sent = [];
      const failed = [];
      for (const message of messages) {
        try {
          const result = await sendReminderMail(settings, message, { exact: true, to: [message.to] });
          sent.push({ to: message.to, findings: message.count, messageId: result.messageId });
        } catch (error) {
          failed.push({ to: message.to, error: error.message });
        }
      }
      res.json({ sent, failed });
    }),
  );

  /** One author's email: the vulnerable code they wrote, with links to the finding and the commit. */
  function authorMessage(author, items, settings) {
    const brand = settings.branding?.companyName || settings.branding?.appName || 'Application security';
    const accent = /^#[0-9a-f]{6}$/i.test(settings.branding?.accentColor ?? '') ? settings.branding.accentColor : '#2856c9';
    const rows = items
      .map((i) => {
        const where = i.location ? `${i.location.path}:${i.location.line}` : '';
        const commit = i.commit ? i.commit.slice(0, 8) : '';
        return `<tr>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb"><strong>${escapeHtmlText(i.severity)}</strong></td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb">${i.url ? `<a href="${escapeHtmlText(i.url)}" style="color:${accent}">${escapeHtmlText(i.title)}</a>` : escapeHtmlText(i.title)}<br><span style="color:#6b7280;font-size:12px">${escapeHtmlText(i.projectName)}</span></td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;font-family:monospace;font-size:12px">${escapeHtmlText(where)}${i.owners?.list?.length ? `<br><span style="color:#6b7280;font-family:system-ui,sans-serif">Code owners: ${escapeHtmlText(i.owners.list.join(', '))}</span>` : ''}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e7eb;font-family:monospace;font-size:12px">${i.commitUrl ? `<a href="${escapeHtmlText(i.commitUrl)}" style="color:${accent}">${escapeHtmlText(commit)}</a>` : escapeHtmlText(commit)}<br><span style="color:#6b7280">${escapeHtmlText((i.committedAt || '').slice(0, 10))}</span>${i.change?.number ? `<br><span style="font-family:system-ui,sans-serif">${i.change.url ? `<a href="${escapeHtmlText(i.change.url)}" style="color:${accent}">${i.change.kind === 'merge request' ? '!' : '#'}${escapeHtmlText(i.change.number)}</a>` : `${i.change.kind === 'merge request' ? '!' : '#'}${escapeHtmlText(i.change.number)}`}</span>` : ''}</td>
      </tr>`;
      })
      .join('');
    const name = author.name || author.login || 'there';
    const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827;max-width:760px">
    <p style="font-size:13px;color:#6b7280;margin:0 0 4px">${escapeHtmlText(brand)}</p>
    <h2 style="margin:0 0 12px;font-size:18px">Code you wrote has ${items.length} open vulnerabilit${items.length === 1 ? 'y' : 'ies'}</h2>
    <p>Hi ${escapeHtmlText(name)},</p>
    <p>Checkmarx One found the issues below on lines you last changed. You know this code best — please take a look, fix what is real, and mark what is not exploitable in Checkmarx One.</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      <thead><tr style="text-align:left;color:#6b7280;font-size:12px"><th style="padding:8px">Severity</th><th style="padding:8px">Finding</th><th style="padding:8px">Where</th><th style="padding:8px">Your commit</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#6b7280;font-size:12px;margin-top:16px">You received this because git history shows you last changed these lines. If that is wrong, reply and let us know.</p>
  </div>`;
    const text = `Hi ${name},\n\nCheckmarx One found ${items.length} issue(s) on lines you last changed:\n\n${items
      .map((i) => `- [${i.severity}] ${i.title} — ${i.location ? `${i.location.path}:${i.location.line}` : ''} (commit ${String(i.commit || '').slice(0, 8)})${i.url ? `\n  ${i.url}` : ''}`)
      .join('\n')}\n`;
    return { to: author.email, count: items.length, subject: `${items.length} vulnerabilit${items.length === 1 ? 'y' : 'ies'} in code you wrote`, html, text };
  }

  return { notifyCodeAuthors };
}
