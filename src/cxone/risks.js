import { CxApiError, mapWithConcurrency } from './client.js';
import { RISK_PATH_CANDIDATES, isProbeMiss } from './discovery.js';
import { getLastScans } from './projects.js';
import { withinWindow } from '../window.js';
import { TtlCache } from '../ttl-cache.js';

export const AGE_BUCKETS = [
  { id: '0-30', label: 'Last 30 days', min: 0, max: 30 },
  { id: '31-60', label: '31 to 60 days', min: 31, max: 60 },
  { id: '60+', label: 'More than 60 days', min: 61, max: Infinity },
];

const MS_PER_DAY = 86_400_000;

/** GET /api/risks/ caps page size at 200. */
const RISKS_PAGE_SIZE = 200;

const pick = (source, keys) => {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
};

/**
 * Where the finding lives. The risks API splits this across assetName (the
 * file or package) and subAssetName (the function or sub-component).
 */
function buildLocation(raw) {
  const asset = pick(raw, ['assetName', 'fileName', 'filePath', 'packageName', 'location', 'packageIdentifier']);
  const sub = pick(raw, ['subAssetName']);
  if (!asset) return sub ? String(sub) : '';
  return sub ? `${asset} :: ${sub}` : String(asset);
}

/** Parse a date from any of the shapes CxONE uses, returning null if unusable. */
export function parseDate(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  // firstDetectionDate is documented as RFC3339 *or* a unix timestamp in seconds.
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    const date = new Date(numeric > 1e12 ? numeric : numeric * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function ageInDays(firstDetectedAt, now = new Date()) {
  const date = parseDate(firstDetectedAt);
  if (!date) return null;
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / MS_PER_DAY));
}

export function bucketForAge(days) {
  if (days === null || days === undefined) return 'unknown';
  return AGE_BUCKETS.find((bucket) => days >= bucket.min && days <= bucket.max)?.id ?? 'unknown';
}

/**
 * Flatten one risk record into the shape the dashboard and the mail template
 * use. Field names are resolved from a candidate list so that the documented
 * `/api/risks/` schema, the AI-insights variant and the older results API all
 * normalise to the same object.
 */
export function normalizeRisk(raw, project, now = new Date()) {
  const firstDetectedAt = pick(raw, [
    'firstDetectionDate', // documented field on GET /api/risks/
    'firstFoundAt',
    'firstDetectedAt',
    'firstFoundDate',
    'firstSeenAt',
    'firstScanDate',
    'introducedAt',
    'discoveredAt',
    'detectedAt',
    'foundAt',
    'createdAt',
  ]);

  const parsed = parseDate(firstDetectedAt);
  const days = parsed ? ageInDays(parsed, now) : null;
  const aiTriage = raw?.aiTriage ?? null;

  const id = String(pick(raw, ['id', 'riskId', 'similarityId', 'resultId']) ?? cryptoId());

  return {
    id,
    riskId: id,
    scanId: String(pick(raw, ['scanId', 'scan_id']) ?? ''),
    projectId: project.id,
    projectName: project.name,
    title: String(pick(raw, ['riskName', 'title', 'name', 'queryName', 'cveId']) ?? 'Untitled risk'),
    severity: String(pick(raw, ['severity', 'riskSeverity', 'severityLevel']) ?? 'UNKNOWN').toUpperCase(),
    state: String(pick(raw, ['state', 'resultState']) ?? '').toUpperCase(),
    status: String(pick(raw, ['status', 'resultStatus']) ?? '').toUpperCase(),
    scanner: String(pick(raw, ['engine', 'scannerType', 'sourceEngine', 'scanType', 'type']) ?? '').toUpperCase(),
    location: buildLocation(raw),
    assetType: String(pick(raw, ['assetType']) ?? ''),
    origin: String(pick(raw, ['origin']) ?? ''),
    source: String(pick(raw, ['source']) ?? ''),
    firstDetectedAt: parsed ? parsed.toISOString() : null,
    ageDays: days,
    bucket: bucketForAge(days),
    // Present only on the ai-insights endpoint.
    aiTriageStatus: aiTriage?.triageStatus ?? '',
    aiExploitability: aiTriage?.exploitability ?? '',
    aiReachability: aiTriage?.reachability ?? '',
    remediationStatus: raw?.remediation?.status ?? '',
    // Identifiers the AI Triage / AI Remediation APIs key on.
    groupId: String(pick(raw, ['groupId']) ?? ''),
    similarityId: String(pick(raw, ['similarityId']) ?? ''),
    alternateId: String(pick(raw, ['alternateId']) ?? ''),
    packageIdentifier: String(raw?.data?.packageIdentifier ?? pick(raw, ['packageIdentifier']) ?? ''),
    // Open-source packages: the version Checkmarx One recommends upgrading to, when it gives one.
    fixVersion: fixVersionOf(raw),
  };
}

/** The recommended (fixed) package version, from whichever field this API variant uses; '' if none. */
function fixVersionOf(raw) {
  const value =
    raw?.data?.recommendedVersion ?? raw?.recommendedVersion ?? raw?.data?.fixedVersion ?? raw?.fixedVersion ?? raw?.fixVersion ?? raw?.recommendation?.recommendedVersion ?? raw?.packageData?.recommendedVersion ?? '';
  const text = String(value ?? '').trim();
  return /^[\w.+:~^-]{1,64}$/.test(text) ? text : '';
}

let counter = 0;
const cryptoId = () => `risk-${Date.now().toString(36)}-${(counter += 1)}`;

// ---------------------------------------------------------------------------
// Risk sources
// ---------------------------------------------------------------------------

/**
 * The documented risks API: GET /api/risks/ (or /api/risks/ai-insights).
 *
 * `projectId` is a required query parameter, so risks are fetched per project.
 * The first-detection window is pushed down to the server via fromDate/toDate
 * rather than filtered after the fact, which is what keeps a narrow scope
 * cheap on a large tenant.
 */
class RisksApiSource {
  #client;
  #config;
  #resolvedPath;
  #requests = 0;

  constructor(client, config) {
    this.#client = client;
    this.#config = config;
    this.#resolvedPath = config.risks.path;
  }

  get name() {
    return 'risks';
  }

  get resolvedPath() {
    return this.#resolvedPath;
  }

  get stats() {
    return { requests: this.#requests, pageSize: RISKS_PAGE_SIZE };
  }

  #candidates() {
    if (!this.#config.risks.autodiscover) return [this.#resolvedPath];
    return [this.#resolvedPath, ...RISK_PATH_CANDIDATES.filter((p) => p !== this.#resolvedPath)];
  }

  async fetchForProject(project, { detectionWindow = null } = {}) {
    let lastMiss;

    for (const candidate of this.#candidates()) {
      // A templated path carries the project in the URL; the documented
      // endpoints take it as a required query parameter.
      const usesPathParam = candidate.includes('{projectId}');
      const path = candidate.replace('{projectId}', encodeURIComponent(project.id));

      const query = {
        // Oldest first: the findings this tool exists to chase.
        sort: 'firstDetectionDate',
        order: 'ASC',
      };
      if (!usesPathParam) query.projectId = project.id;
      // Push the window server-side instead of downloading and discarding.
      if (detectionWindow?.from) query.fromDate = detectionWindow.from.toISOString();
      if (detectionWindow?.to) query.toDate = detectionWindow.to.toISOString();

      try {
        const items = [];
        for await (const item of this.#client.paginate(path, {
          itemsKey: 'risks',
          query,
          limit: RISKS_PAGE_SIZE,
          maxItems: 20_000,
        })) {
          items.push(item);
        }
        this.#requests += Math.max(1, Math.ceil(items.length / RISKS_PAGE_SIZE));
        this.#resolvedPath = candidate;
        return items;
      } catch (error) {
        if (isProbeMiss(error)) {
          lastMiss = error;
          continue;
        }
        throw error;
      }
    }

    throw (
      lastMiss ??
      new CxApiError(
        `No risks endpoint responded for project ${project.id}. ` +
          'Use "Detect endpoints" on the Settings page to find the right path.',
        { status: 404 },
      )
    );
  }
}

/**
 * Fallback for tenants without the risks service: read the latest completed
 * scan's results, which carry `firstFoundAt` directly.
 */
class ScanResultsSource {
  #client;
  #lastScans = null;

  constructor(client) {
    this.#client = client;
  }

  get name() {
    return 'scan-results';
  }

  get resolvedPath() {
    return '/api/results/';
  }

  async prime(projects) {
    this.#lastScans = await getLastScans(
      this.#client,
      projects.map((project) => project.id),
    );
  }

  async fetchForProject(project) {
    const scan = this.#lastScans?.[project.id];
    const scanId = scan?.id ?? scan?.scanId;
    if (!scanId) return [];

    const items = [];
    for await (const item of this.#client.paginate('/api/results/', {
      itemsKey: 'results',
      query: { 'scan-id': scanId },
      limit: 100,
      maxItems: 20_000,
      offsetIsPage: true,
    })) {
      items.push(item);
    }
    return items;
  }
}

export function createRiskSource(client, config) {
  return config.risks.source === 'scan-results'
    ? new ScanResultsSource(client)
    : new RisksApiSource(client, config);
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

const emptyCounts = () =>
  Object.fromEntries([...AGE_BUCKETS.map((bucket) => [bucket.id, 0]), ['unknown', 0]]);

/**
 * Fetch risks for every project and summarise them by first-detection age.
 * A project whose risks cannot be read is reported with an `error` rather than
 * failing the whole run.
 */
// ---------------------------------------------------------------------------
// Recent reads, shared
// ---------------------------------------------------------------------------

/**
 * How long a project's findings, once read, serve everyone else who fetches
 * the same project through the same Checkmarx One key (CX_FETCH_CACHE_SECONDS,
 * 0 switches it off). A read is reused only while the project's latest scan
 * is still the one it was read for. A project triaged or remediated from here
 * is read afresh every time for the next 30 minutes, while Checkmarx One works
 * through it and its states change. "fresh" skips the reuse altogether.
 */
const READ_TTL_MS = Math.max(0, Number(process.env.CX_FETCH_CACHE_SECONDS ?? 120) || 0) * 1000;
const reads = new TtlCache({ max: 20_000 });
const VOLATILE_MS = 30 * 60 * 1000;
const volatileUntil = new Map(); // projectId -> time
let reused = 0;
let read = 0;

export const projectReads = {
  get stats() {
    return { reused, read, ttlSeconds: READ_TTL_MS / 1000 };
  },
  /** Triage, remediation or a state change on this project: read it afresh next time. */
  forget(projectId, now = Date.now()) {
    reads.deletePrefix(`${projectId}\u0000`);
    volatileUntil.set(String(projectId), now + VOLATILE_MS);
    if (volatileUntil.size > 10_000) for (const [id, until] of volatileUntil) if (until <= now) volatileUntil.delete(id);
  },
  clear() {
    reads.deletePrefix('');
    volatileUntil.clear();
  },
};

/** The latest completed scan a last-scan record names. */
const scanIdOf = (scan) => String(scan?.id ?? scan?.scanId ?? '');

/**
 * A project's raw findings: a recent read by anyone on the same key when it is
 * still current, else one read from Checkmarx One (shared with anyone asking
 * for the same project at the same moment). Resolves {items, reused}.
 */
async function readProject(source, project, detectionWindow, shared) {
  const load = () => source.fetchForProject(project, { detectionWindow });
  const changing = (volatileUntil.get(String(project.id)) ?? 0) > Date.now();
  if (!shared?.identity || !(READ_TTL_MS > 0) || changing) {
    read += 1;
    return { items: await load(), reused: false };
  }
  const scanId = scanIdOf(shared.lastScans?.[project.id]);
  const key = [project.id, shared.identity, source.name, detectionWindow?.from?.toISOString?.() ?? '', detectionWindow?.to?.toISOString?.() ?? ''].join('\u0000');
  if (shared.fresh) reads.delete(key);
  const known = reads.get(key);
  if (known && scanId && known.scanId && known.scanId !== scanId) reads.delete(key); // rescanned since
  let loaded = false;
  const entry = await reads.wrap(
    key,
    async () => {
      loaded = true;
      return { scanId, items: await load() };
    },
    READ_TTL_MS,
  );
  if (loaded) read += 1;
  else reused += 1;
  return { items: entry.items, reused: !loaded };
}

/**
 * normalizeRisk for a raw record that recent reads share between people: worked out once
 * per record, project and day, then handed out as a copy (each session may change its
 * own, e.g. a state read again). Re-normalising every record on every fetch was a
 * measurable share of the server's time and of its garbage.
 */
const normalized = new WeakMap(); // raw record -> {stamp, risk}
function normalizeShared(item, project, now) {
  if (!item || typeof item !== 'object') return normalizeRisk(item, project, now);
  const stamp = `${project.id}\u0000${project.name}\u0000${Math.floor(now.getTime() / 86_400_000)}`;
  const known = normalized.get(item);
  if (known?.stamp === stamp) return { ...known.risk };
  const risk = normalizeRisk(item, project, now);
  normalized.set(item, { stamp, risk });
  return { ...risk };
}

/**
 * Read and summarise `projects`. With `shared` ({identity, lastScans, fresh}),
 * recent reads by others on the same Checkmarx One key are reused (see
 * projectReads); `reused` in the result counts them.
 */
export async function collectProjectRisks(
  client,
  config,
  projects,
  { now = new Date(), detectionWindow = null, onProject = null, shared = null, shouldStop = null } = {},
) {
  const source = createRiskSource(client, config);
  await source.prime?.(projects);
  let reusedHere = 0;
  let notRead = 0;

  // Each project's summary is handed to onProject as soon as it is read, so a
  // caller can show it straight away instead of waiting for every project.
  // Stopped (someone pressed Stop): projects already being read finish, the rest are not read.
  const summaries = await mapWithConcurrency(projects, config.concurrency, async (project) => {
    if (shouldStop?.()) {
      notRead += 1;
      return null;
    }
    let summary;
    try {
      const { items: raw, reused: wasReused } = await readProject(source, project, detectionWindow, shared);
      if (wasReused) reusedHere += 1;
      const risks = raw
        .map((item) => normalizeShared(item, project, now))
        // The server already applied the window where it could; this also
        // covers the fallback source and any record with an unusable date.
        .filter((risk) => withinWindow(detectionWindow, risk.firstDetectedAt));
      summary = summariseProject(project, risks, null);
    } catch (error) {
      summary = summariseProject(project, [], error.message ?? String(error));
    }
    onProject?.(summary);
    return summary;
  });

  return {
    source: source.name,
    resolvedPath: source.resolvedPath,
    stats: source.stats ?? null,
    reused: reusedHere,
    generatedAt: now.toISOString(),
    projects: summaries.filter(Boolean),
    notRead,
  };
}

export function summariseProject(project, risks, error = null) {
  const counts = emptyCounts();
  const bySeverity = {};
  let oldestFirstDetectedAt = null;
  let maxAgeDays = null;

  for (const risk of risks) {
    counts[risk.bucket] = (counts[risk.bucket] ?? 0) + 1;
    bySeverity[risk.severity] = (bySeverity[risk.severity] ?? 0) + 1;

    if (risk.firstDetectedAt && (!oldestFirstDetectedAt || risk.firstDetectedAt < oldestFirstDetectedAt)) {
      oldestFirstDetectedAt = risk.firstDetectedAt;
    }
    if (risk.ageDays !== null && (maxAgeDays === null || risk.ageDays > maxAgeDays)) {
      maxAgeDays = risk.ageDays;
    }
  }

  return {
    projectId: project.id,
    projectName: project.name,
    repoUrl: project.repoUrl,
    mainBranch: project.mainBranch ?? '',
    tags: project.tags,
    totalRisks: risks.length,
    counts,
    bySeverity,
    oldestFirstDetectedAt,
    maxAgeDays,
    error,
    risks,
  };
}

/** Select the risks in `buckets` across the given projects. */
export function selectRisks(summaries, { projectIds = null, buckets = [], severities = null } = {}) {
  const wantedBuckets = new Set(buckets);
  const wantedProjects = projectIds ? new Set(projectIds) : null;
  const wantedSeverities = severities?.length ? new Set(severities.map((s) => s.toUpperCase())) : null;

  return summaries
    .filter((summary) => !wantedProjects || wantedProjects.has(summary.projectId))
    .flatMap((summary) =>
      summary.risks.filter(
        (risk) =>
          (wantedBuckets.size === 0 || wantedBuckets.has(risk.bucket)) &&
          (!wantedSeverities || wantedSeverities.has(risk.severity)),
      ),
    );
}
