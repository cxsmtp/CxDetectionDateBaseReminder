import { CxApiError, mapWithConcurrency } from './client.js';
import { RISK_PATH_CANDIDATES, isProbeMiss } from './discovery.js';
import { getLastScans } from './projects.js';
import { withinWindow } from '../window.js';

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

  return {
    id: String(pick(raw, ['id', 'riskId', 'similarityId', 'resultId']) ?? cryptoId()),
    projectId: project.id,
    projectName: project.name,
    title: String(pick(raw, ['riskName', 'title', 'name', 'queryName', 'cveId']) ?? 'Untitled risk'),
    severity: String(pick(raw, ['severity', 'riskSeverity', 'severityLevel']) ?? 'UNKNOWN').toUpperCase(),
    state: String(pick(raw, ['state', 'resultState']) ?? '').toUpperCase(),
    status: String(pick(raw, ['status', 'resultStatus']) ?? '').toUpperCase(),
    scanner: String(pick(raw, ['engine', 'scannerType', 'sourceEngine', 'scanType']) ?? '').toUpperCase(),
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
  };
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
export async function collectProjectRisks(
  client,
  config,
  projects,
  { now = new Date(), detectionWindow = null } = {},
) {
  const source = createRiskSource(client, config);
  await source.prime?.(projects);

  const rows = await mapWithConcurrency(projects, config.concurrency, async (project) => {
    try {
      const raw = await source.fetchForProject(project, { detectionWindow });
      const risks = raw
        .map((item) => normalizeRisk(item, project, now))
        // The server already applied the window where it could; this also
        // covers the fallback source and any record with an unusable date.
        .filter((risk) => withinWindow(detectionWindow, risk.firstDetectedAt));
      return { project, risks, error: null };
    } catch (error) {
      return { project, risks: [], error: error.message ?? String(error) };
    }
  });

  return {
    source: source.name,
    resolvedPath: source.resolvedPath,
    stats: source.stats ?? null,
    generatedAt: now.toISOString(),
    projects: rows.map(({ project, risks, error }) => summariseProject(project, risks, error)),
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
