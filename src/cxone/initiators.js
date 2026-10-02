import { CxApiError, extractItems, mapWithConcurrency } from './client.js';
import { getLastScans, lastScanDate } from './projects.js';
import { isProbeMiss } from './discovery.js';
import { dominantDomain, fetchDirectory, indexDirectory, suggestEmail } from './directory.js';

/**
 * Who triggered a project's most recent scan, and how to reach them.
 *
 * "Most recent" is the point: after a rescan it is the latest scan that counts,
 * so the reminder goes to whoever ran it now, not whoever ran it first. Every
 * source below is therefore a latest-scan lookup.
 *
 * Sources, in order:
 *   1. /api/projects/last-scan  — the latest completed scan per project, in one
 *      call per 50 projects. Already used for the activity window.
 *   2. /api/scans?project-id=…  — per project, newest first, when a project has
 *      no completed scan in (1).
 *   3. /projects overview       — the endpoint documented as "Get overview for
 *      the tenant projects". It is DEPRECATED and answers 410 Gone on current
 *      tenants, so it is tried only if the first two yield nothing.
 */

const EMAIL_RE = /^(?=[^]{3,254}$)[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_TARGETED_LOOKUPS = 200;

const pick = (source, keys) => {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
};

/** The initiator identity recorded on a scan, whatever the tenant calls it. */
export function scanInitiator(scan) {
  const initiator = pick(scan, ['initiator', 'initiatorName', 'createdBy', 'userName', 'username', 'owner']);
  return initiator === undefined ? '' : String(initiator).trim();
}

/** An email carried directly on the scan record, if the tenant records one. */
export function scanInitiatorEmail(scan) {
  const email = pick(scan, ['initiatorEmail', 'userEmail', 'email', 'createdByEmail']);
  const value = email === undefined ? '' : String(email).trim();
  return EMAIL_RE.test(value) ? value : '';
}

/**
 * Turn an initiator identity into an email address.
 *
 * Checkmarx records the initiator as a username, which is often but not always
 * an address, so resolution is layered and every layer is optional:
 *   - the scan already carried an email
 *   - the username *is* an address
 *   - an explicit override the administrator configured
 *   - the tenant's IAM directory
 *   - a default domain appended to the username
 */
export function resolveFromRules(initiator, scanEmail, rules = {}) {
  if (scanEmail) return { email: scanEmail, via: 'scan' };

  const name = String(initiator ?? '').trim();
  if (!name) return { email: '', via: 'none' };

  const override = rules.overrides?.[name] ?? rules.overrides?.[name.toLowerCase()];
  if (override && EMAIL_RE.test(override)) return { email: override, via: 'override' };

  if (EMAIL_RE.test(name)) return { email: name, via: 'username' };
  return { email: '', via: 'unresolved' };
}

/** Last resort: username@defaultDomain, only when the admin configured one. */
export function applyDefaultDomain(initiator, rules = {}) {
  const domain = String(rules.defaultDomain ?? '').trim().replace(/^@/, '');
  if (!domain) return '';
  const local = String(initiator ?? '').trim();
  if (!local || local.includes('@')) return '';
  const candidate = `${local}@${domain}`;
  return EMAIL_RE.test(candidate) ? candidate : '';
}

/**
 * Look a username up in the tenant's IAM directory.
 *
 * This is the Keycloak admin endpoint behind Checkmarx One's IAM. It needs an
 * API key with IAM read access, so a 401/403 is an ordinary outcome, not a
 * failure worth aborting the whole fetch for.
 */
export async function lookupDirectoryEmail(client, connection, username, { retries = 0 } = {}) {
  if (!connection?.iamUrl || !connection?.tenant || !username) return '';

  const url =
    `${connection.iamUrl}/auth/admin/realms/${encodeURIComponent(connection.tenant)}/users` +
    `?username=${encodeURIComponent(username)}&exact=true&briefRepresentation=true&max=1`;

  try {
    const response = await client.request(url, { retries });
    const [user] = extractItems(response);
    const email = String(user?.email ?? '').trim();
    return EMAIL_RE.test(email) ? email : '';
  } catch (error) {
    if (error instanceof CxApiError || isProbeMiss(error)) return '';
    return '';
  }
}

/** Newest scan for one project, for projects absent from /last-scan. */
async function latestScanForProject(client, projectId) {
  try {
    const response = await client.request('/api/scans', {
      query: { 'project-id': projectId, limit: 1, offset: 0, sort: '-created_at' },
      retries: 1,
    });
    return extractItems(response, 'scans')[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * The deprecated tenant overview. Documented to return 410 Gone, so this is
 * only consulted when nothing else produced an initiator, and a 410 is
 * reported as a plain reason rather than an error.
 */
export async function overviewInitiators(client, projectIds) {
  if (projectIds.length === 0) return { byProject: {}, note: null };

  try {
    const response = await client.request('/projects', {
      query: { projectIds, includeGroups: false, includeApplications: false },
      retries: 0,
    });

    const byProject = {};
    for (const row of extractItems(response)) {
      if (!row?.projectId) continue;
      byProject[row.projectId] = {
        initiator: String(row.initiator ?? '').trim(),
        lastScanDate: row.lastScanDate ?? null,
      };
    }
    return { byProject, note: null };
  } catch (error) {
    const note =
      error.status === 410
        ? 'The /projects overview endpoint is deprecated and returned 410 Gone, as its documentation says it now does.'
        : `The /projects overview endpoint could not be used: ${error.message}`;
    return { byProject: {}, note };
  }
}

/**
 * Resolve the latest-scan initiator for every project.
 *
 * @returns {{byProject: Object, notes: string[], unresolved: string[]}}
 *   byProject maps project id -> {initiator, email, via, scanId, scanDate}.
 */
export async function collectInitiators(client, connection, projects, options = {}) {
  // `memory` remembers addresses resolved before ({get(username), remember(username, email)}),
  // so a directory that cannot be read right now does not lose anyone.
  const { rules = {}, useDirectory = true, concurrency = 5, memory = null } = options;
  const notes = [];
  const byProject = {};
  const projectIds = projects.map((project) => project.id);

  // 1. Latest completed scan per project, in bulk.
  let lastScans = {};
  try {
    lastScans = options.lastScans ?? (await getLastScans(client, projectIds));
  } catch (error) {
    notes.push(`Could not read last-scan data: ${error.message}`);
  }

  // 2. Per-project lookup for anything the bulk call did not cover.
  const missing = projects.filter((project) => !scanInitiator(lastScans[project.id]));
  const fallbackScans = await mapWithConcurrency(missing, concurrency, async (project) => ({
    projectId: project.id,
    scan: await latestScanForProject(client, project.id),
  }));
  for (const { projectId, scan } of fallbackScans) {
    if (scan && !lastScans[projectId]) lastScans[projectId] = scan;
    else if (scan && scanInitiator(scan)) lastScans[projectId] = scan;
  }

  for (const project of projects) {
    const scan = lastScans[project.id];
    byProject[project.id] = {
      initiator: scanInitiator(scan),
      email: '',
      via: 'none',
      confidence: 'none',
      suggestedEmail: '',
      suggestionVia: '',
      scanId: scan?.id ?? scan?.scanId ?? '',
      scanDate: lastScanDate(scan),
    };
  }

  // 3. The deprecated overview, only for projects still without an initiator.
  const stillMissing = projects.filter((project) => !byProject[project.id].initiator);
  if (stillMissing.length > 0) {
    const { byProject: overview, note } = await overviewInitiators(
      client,
      stillMissing.map((project) => project.id),
    );
    if (note) notes.push(note);
    for (const [projectId, row] of Object.entries(overview)) {
      if (row.initiator) {
        byProject[projectId].initiator = row.initiator;
        byProject[projectId].scanDate ??= row.lastScanDate;
      }
    }
  }

  // ---- Resolve identities to addresses ------------------------------------
  // Anything already carrying an address (scan record, override, or a username
  // that is itself an address) is settled first, and the domains they use tell
  // us the tenant's naming convention for everyone else.
  for (const [projectId, entry] of Object.entries(byProject)) {
    if (!entry.initiator) continue;
    const direct = resolveFromRules(entry.initiator, scanInitiatorEmail(lastScans[projectId]), rules);
    if (direct.email) {
      entry.email = direct.email;
      entry.via = direct.via;
      entry.confidence = 'exact';
    }
  }

  // A domain the administrator typed is an instruction, so a match against it
  // resolves outright. One merely inferred from other addresses is a guess, so
  // it only ever produces a suggestion to confirm.
  const configuredDomain = String(rules.defaultDomain ?? '').trim().replace(/^@/, '');
  const domain =
    configuredDomain ||
    dominantDomain(Object.values(byProject).map((entry) => entry.email).filter(Boolean));

  // One directory fetch for the whole tenant, rather than a call per username.
  let index = null;
  let directoryDenied = false;
  if (useDirectory && Object.values(byProject).some((entry) => entry.initiator && !entry.email)) {
    const { users, note, denied } = await fetchDirectory(client, connection);
    if (note) notes.push(note);
    directoryDenied = Boolean(denied);
    if (users.length > 0) index = indexDirectory(users);
  }

  const cache = new Map();
  for (const entry of Object.values(byProject)) {
    if (!entry.initiator || entry.email) continue;

    if (!cache.has(entry.initiator)) {
      cache.set(entry.initiator, suggestEmail(entry.initiator, { index, domain, overrides: rules.overrides ?? {} }));
    }
    const hit = cache.get(entry.initiator);

    const trusted = hit.confidence === 'exact' || (configuredDomain && hit.via === 'pattern');

    if (trusted && hit.email) {
      entry.email = hit.email;
      entry.via = hit.via === 'pattern' ? 'default-domain' : hit.via;
      entry.confidence = 'exact';
      continue;
    }

    // A pattern match is offered, not applied: the operator confirms it with
    // one click, so nobody is mailed at an address the tool invented.
    entry.suggestedEmail = hit.email;
    entry.suggestionVia = hit.via;
    entry.confidence = hit.confidence;
    entry.via = 'unresolved';
  }

  // Anyone still without an address: ask the directory for that exact
  // username (the full listing may have been cut short, or be older than the user).
  if (useDirectory && connection?.iamUrl && !directoryDenied) {
    const pending = [...new Set(Object.values(byProject).filter((e) => e.initiator && !e.email).map((e) => e.initiator))];
    const found = new Map();
    await mapWithConcurrency(pending.slice(0, MAX_TARGETED_LOOKUPS), 4, async (name) => {
      const email = await lookupDirectoryEmail(client, connection, name, { retries: 2 });
      if (email) found.set(name, email);
    });
    for (const entry of Object.values(byProject)) {
      const email = !entry.email && found.get(entry.initiator);
      if (!email) continue;
      Object.assign(entry, { email, via: 'directory', confidence: 'exact', suggestedEmail: '', suggestionVia: '' });
    }
  }

  // Last resort: the address this username resolved to before.
  if (memory) {
    for (const entry of Object.values(byProject)) {
      if (!entry.initiator) continue;
      if (entry.email) {
        if (['directory', 'scan', 'username', 'override', 'default-domain'].includes(entry.via)) memory.remember(entry.initiator, entry.email);
        continue;
      }
      const email = memory.get(entry.initiator);
      if (email) Object.assign(entry, { email, via: 'remembered', confidence: 'exact', suggestedEmail: '', suggestionVia: '' });
    }
  }

  const unresolved = [...new Set(
    Object.values(byProject).filter((e) => e.initiator && !e.email).map((e) => e.initiator),
  )];

  const suggested = [...new Set(
    Object.values(byProject).filter((e) => !e.email && e.suggestedEmail).map((e) => e.initiator),
  )];

  return { byProject, notes, unresolved, suggested, domain, directorySize: index?.size ?? 0 };
}

/**
 * Group findings per project, so someone with four projects gets four
 * messages -- one per project, each naming that project and its own counts.
 * The recipient is still whoever ran that project's latest scan.
 */
export function groupRisksByProject(risks, byProject) {
  const groups = new Map();

  for (const risk of risks) {
    if (!groups.has(risk.projectId)) {
      const info = byProject[risk.projectId] ?? {};
      groups.set(risk.projectId, {
        key: risk.projectId,
        projectId: risk.projectId,
        projectName: risk.projectName,
        initiator: info.initiator ?? '',
        email: info.email ?? '',
        via: info.via ?? 'none',
        projectIds: [risk.projectId],
        projectCount: 1,
        risks: [],
      });
    }
    groups.get(risk.projectId).risks.push(risk);
  }

  return [...groups.values()].sort((a, b) => b.risks.length - a.risks.length);
}

/**
 * Group findings by the person who ran the latest scan, so one person with
 * several projects receives a single email covering all of them.
 */
export function groupRisksByInitiator(risks, byProject) {
  const groups = new Map();

  for (const risk of risks) {
    const info = byProject[risk.projectId] ?? {};
    const key = info.email || info.initiator || '';
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        initiator: info.initiator ?? '',
        email: info.email ?? '',
        via: info.via ?? 'none',
        projectIds: new Set(),
        risks: [],
      });
    }
    const group = groups.get(key);
    group.projectIds.add(risk.projectId);
    group.risks.push(risk);
  }

  return [...groups.values()]
    .map((group) => ({ ...group, projectIds: [...group.projectIds], projectCount: group.projectIds.size }))
    .sort((a, b) => b.risks.length - a.risks.length);
}

const normIdentity = (value) => String(value ?? '').trim().toLowerCase();

/**
 * The projects someone asked for by hand: by id (picked by name), or by who
 * ran their latest scan. `initiators` may be usernames or email addresses: a
 * name matches the scan's initiator, its email (from the scan, or `emailOf`,
 * e.g. an override or a remembered address), or an address whose local part
 * is that username. Either list may be empty; a project in either is kept.
 */
export function projectsInScope(projects, { projectIds = [], initiators = [] } = {}, lastScans = {}, emailOf = () => '') {
  const ids = new Set(projectIds.map(String));
  const wanted = [...new Set(initiators.map(normIdentity).filter(Boolean))];
  const local = (value) => value.split('@')[0];
  const ranBy = (scan) => {
    if (!wanted.length || !scan) return false;
    const who = normIdentity(scanInitiator(scan));
    if (!who) return false;
    const emails = [scanInitiatorEmail(scan), emailOf(scanInitiator(scan))].map(normIdentity).filter(Boolean);
    return wanted.some(
      (w) => w === who || emails.includes(w) || (w.includes('@') && !who.includes('@') && local(w) === who) || (who.includes('@') && !w.includes('@') && local(who) === w),
    );
  };
  return projects.filter((project) => ids.has(String(project.id)) || ranBy(lastScans[project.id]));
}
