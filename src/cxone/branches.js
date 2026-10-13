import { mapWithConcurrency } from './client.js';
import { getLastScans } from './projects.js';

/**
 * Which branch counts for each project, and its latest completed scan there.
 *
 * Projects are usually scanned on several branches (main, release, feature branches), and the
 * latest scan of a project is often a feature branch's. Counting every branch's findings, or
 * whichever branch happened to be scanned last, counts the same vulnerability more than once
 * and mixes work in progress into the backlog. So, unless every branch is asked for, one branch
 * counts per project: its primary branch as set in Checkmarx One, else main, else master; with
 * none of those set or scanned, the branch of its latest scan.
 *
 * A tenant whose scans do not say their branch is read as before (the latest scan), and says so.
 */

/** How a project's branch was chosen. */
export const BRANCH_HOW = {
  primary: 'primary', // its primary branch, as set in Checkmarx One
  guessed: 'guessed', // no primary branch set: main or master
  latest: 'latest', // no primary branch set, and no main or master scanned: its latest scan's branch
  none: 'none', // its primary branch was never scanned (to completion): nothing of it counts
  unknown: 'unknown', // the tenant's scans do not say their branch: the latest scan, as before
  any: 'any', // every branch was asked for
};

const GUESSES = ['main', 'master'];
/** Scans looked through for a project whose latest scan is on another branch. */
const LOOKUP_PAGE = 50;

/** A branch name as scans and projects give it ("refs/heads/main" is "main"). */
export const branchName = (value) => String(value ?? '').trim().replace(/^refs\/heads\//, '');

/** The branch a scan (or a finding) names, from whichever field the tenant uses. */
export function branchOf(record) {
  if (!record || typeof record !== 'object') return '';
  const direct = record.branch ?? record.branchName ?? record.metadata?.Handler?.GitHandler?.branch;
  return branchName(direct);
}

/** Every branch asked for ("all"), or one branch per project (the default). */
export const branchScopeOf = (value) => (String(value ?? '').toLowerCase() === 'all' ? 'all' : 'primary');

// What scans and lines of code are already known: a scan never changes branch or lines once completed.
// Kept per Checkmarx One key (`identity`), never shared between keys.
const MAX_KNOWN = 200_000;
const scanBranches = new Map(); // `${identity}\u0000${scanId}` -> branch
const scanLines = new Map(); // `${identity}\u0000${scanId}` -> {loc}
// A project's branch scan, looked up: still right while its latest scan (of any branch) is the same one.
const lookedUp = new Map(); // `${identity}\u0000${projectId}\u0000${latest scan id}\u0000${primary}` -> {scan, branch, how}
const remember = (map, key, value) => {
  map.set(key, value);
  if (map.size > MAX_KNOWN) map.delete(map.keys().next().value);
};
let anonymous = 0;
const clientKeys = new WeakMap();
/** The cache key for this Checkmarx One key: the caller's identity, else this client alone. */
function keyOf(client, identity) {
  if (identity) return identity;
  if (!clientKeys.has(client)) clientKeys.set(client, `client-${(anonymous += 1)}`);
  return clientKeys.get(client);
}

const scanIdOf = (scan) => String(scan?.id ?? scan?.scanId ?? '');
const at = (scan) => Date.parse(scan?.createdAt ?? scan?.updatedAt ?? '') || 0;

/** Note the branch of every scan in a list, for the findings that name them later. */
function learn(owner, scans) {
  for (const scan of scans) {
    const id = scanIdOf(scan);
    const branch = branchOf(scan);
    if (id && branch) remember(scanBranches, `${owner}\u0000${id}`, branch);
  }
}

/** A project's latest completed scans, newest first (on `branch` when given; the tenant may ignore it, so it is checked). */
async function recentScans(client, projectId, branch, gate, background = false) {
  const query = { 'project-id': projectId, statuses: 'Completed', sort: '-created_at', limit: LOOKUP_PAGE, offset: 0 };
  if (branch) query.branch = branch;
  const call = () => client.request('/api/scans', { query, retries: 1, background });
  const page = await (gate ? gate.run(call) : call());
  return (Array.isArray(page?.scans) ? page.scans : []).filter((x) => scanIdOf(x) && (!x.projectId || String(x.projectId) === String(projectId))).sort((a, b) => at(b) - at(a));
}

/**
 * Each project's latest completed scan on the branch that counts (see the top of this file):
 * { scans: {projectId: scan}, branches: {projectId: {branch, how}}, counts: {how: n}, anyBranch: {projectId: scan} }.
 * `scans` has no entry for a project whose primary branch was never scanned. `anyBranch` is the
 * latest scan of any branch (who ran it is who a reminder goes to, as before).
 * With `all`, every project's latest scan of any branch, as before.
 */
export async function primaryScans(client, projects, { all = false, identity = '', gate = null, concurrency = 8, lastScans = null, background = false } = {}) {
  const owner = keyOf(client, identity);
  const anyBranch = lastScans ?? (await getLastScans(client, projects.map((p) => p.id)));
  const scans = Object.create(null);
  const branches = Object.create(null);
  const counts = Object.fromEntries(Object.values(BRANCH_HOW).map((how) => [how, 0]));
  const set = (project, scan, branch, how) => {
    if (scan) scans[project.id] = scan;
    branches[project.id] = { branch, how };
    counts[how] += 1;
  };
  learn(owner, Object.values(anyBranch));

  const toLookUp = [];
  for (const project of projects) {
    const latest = anyBranch[project.id] ?? null;
    const latestBranch = branchOf(latest);
    const primary = branchName(project.mainBranch);
    if (all) set(project, latest, latestBranch, BRANCH_HOW.any);
    // The tenant does not say which branch a scan was on: as before.
    else if (latest && !latestBranch) set(project, latest, '', BRANCH_HOW.unknown);
    else if (!latest) set(project, null, primary, primary ? BRANCH_HOW.none : BRANCH_HOW.latest);
    else if (primary && latestBranch === primary) set(project, latest, primary, BRANCH_HOW.primary);
    else if (!primary && GUESSES.includes(latestBranch)) set(project, latest, latestBranch, BRANCH_HOW.guessed);
    else toLookUp.push({ project, latest, primary });
  }

  // The latest scan is on another branch: look for the primary (or main, or master) among the project's recent scans.
  await mapWithConcurrency(toLookUp, concurrency, async ({ project, latest, primary }) => {
    const key = `${owner}\u0000${project.id}\u0000${scanIdOf(latest)}\u0000${primary}`;
    const known = lookedUp.get(key);
    if (known) return set(project, known.scan, known.branch, known.how);
    const found = await lookUp(project, latest, primary);
    if (found.how !== BRANCH_HOW.latest || found.read) remember(lookedUp, key, found);
    return set(project, found.scan, found.branch, found.how);
  });

  async function lookUp(project, latest, primary) {
    let recent = [];
    try {
      recent = await recentScans(client, project.id, primary || '', gate, background);
      learn(owner, recent);
    } catch {
      // Not readable now: the latest scan stands in, and says it is not the primary branch's (not remembered).
      return { scan: latest, branch: branchOf(latest), how: BRANCH_HOW.latest, read: false };
    }
    if (primary) {
      const found = recent.find((x) => branchOf(x) === primary);
      return found ? { scan: found, branch: primary, how: BRANCH_HOW.primary } : { scan: null, branch: primary, how: BRANCH_HOW.none };
    }
    for (const guess of GUESSES) {
      const found = recent.find((x) => branchOf(x) === guess);
      if (found) return { scan: found, branch: guess, how: BRANCH_HOW.guessed };
    }
    return { scan: latest, branch: branchOf(latest), how: BRANCH_HOW.latest, read: true };
  }

  return { scans, branches, counts, anyBranch, all };
}

/** The branch each of these scans was on, from what is known, else read from Checkmarx One (50 at a time). */
export async function branchesOfScans(client, scanIds, { identity = '', gate = null } = {}) {
  const owner = keyOf(client, identity);
  const out = new Map();
  const unknown = [];
  for (const id of new Set(scanIds.filter(Boolean).map(String))) {
    const known = scanBranches.get(`${owner}\u0000${id}`);
    if (known !== undefined) out.set(id, known);
    else unknown.push(id);
  }
  for (let i = 0; i < unknown.length; i += LOOKUP_PAGE) {
    const ids = unknown.slice(i, i + LOOKUP_PAGE);
    const call = () => client.request('/api/scans', { query: { 'scan-ids': ids, limit: ids.length, offset: 0 }, retries: 1 });
    try {
      const page = await (gate ? gate.run(call) : call());
      const listed = (Array.isArray(page?.scans) ? page.scans : []).filter((x) => ids.includes(scanIdOf(x)));
      learn(owner, listed);
      for (const scan of listed) if (branchOf(scan)) out.set(scanIdOf(scan), branchOf(scan));
    } catch {}
    // A scan the tenant would not say: unknown, and its findings kept.
    for (const id of ids) if (!out.has(id)) remember(scanBranches, `${owner}\u0000${id}`, ''), out.set(id, '');
  }
  return out;
}

/**
 * Keep only a project's findings from the branch that counts for it. A finding that names no scan
 * or branch, or a scan whose branch cannot be told, is kept; a project whose primary branch was
 * never scanned keeps none.
 */
export async function onBranch(client, choice, projectId, risks, { identity = '', gate = null } = {}) {
  const want = choice?.branches?.[projectId];
  if (!want || want.how === BRANCH_HOW.any || want.how === BRANCH_HOW.unknown) return risks;
  if (want.how === BRANCH_HOW.none) return [];
  const named = risks.filter((r) => !branchName(r.branch) && r.scanId).map((r) => r.scanId);
  const known = named.length ? await branchesOfScans(client, named, { identity, gate }) : new Map();
  return risks.filter((r) => {
    const branch = branchName(r.branch) || known.get(String(r.scanId)) || '';
    return !branch || branch === want.branch;
  });
}

/** A scan's lines of code: its own SAST details, else its SAST scan metadata; null when it says none. */
export async function linesOfCode(client, scan, { identity = '', gate = null } = {}) {
  const id = scanIdOf(scan);
  if (!id) return null;
  const fromScan = (record) => {
    const sast = (Array.isArray(record?.statusDetails) ? record.statusDetails : []).find((d) => String(d?.name).toLowerCase() === 'sast');
    const loc = Number(sast?.loc);
    return Number.isFinite(loc) && loc >= 0 ? Math.floor(loc) : null;
  };
  const inHand = fromScan(scan);
  if (inHand !== null) return inHand;
  const owner = keyOf(client, identity);
  const key = `${owner}\u0000${id}`;
  if (scanLines.has(key)) return scanLines.get(key).loc;
  let loc = null;
  try {
    const call = () => client.request(`/api/sast-metadata/${encodeURIComponent(id)}`, { retries: 1 });
    const meta = await (gate ? gate.run(call) : call());
    const n = Number(meta?.loc);
    if (Number.isFinite(n) && n >= 0) loc = Math.floor(n);
  } catch {}
  remember(scanLines, key, { loc });
  return loc;
}

/** Forget what is known (tests). */
export function forgetBranches() {
  scanBranches.clear();
  scanLines.clear();
  lookedUp.clear();
}

/**
 * The projects whose scan (`scans`: the one that counts for each) counted lines of code: those whose
 * scan counted none are left out. A project with no scan, or whose lines of code cannot be told, is kept.
 * Resolves { kept, noCode } (noCode: the projects left out).
 */
export async function withCode(client, projects, scans, { identity = '', gate = null, concurrency = 8 } = {}) {
  const lines = await mapWithConcurrency(projects, concurrency, (p) => (scans?.[p.id] ? linesOfCode(client, scans[p.id], { identity, gate }) : null));
  return { kept: projects.filter((_, i) => lines[i] !== 0), noCode: projects.filter((_, i) => lines[i] === 0) };
}
