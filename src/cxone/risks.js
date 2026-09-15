import { CxApiError, extractItems, mapWithConcurrency } from './client.js';
import { getLastScans } from './projects.js';

export const AGE_BUCKETS = [
  { id: '0-30', label: 'Last 30 days', min: 0, max: 30 },
  { id: '31-60', label: '31 to 60 days', min: 31, max: 60 },
  { id: '60+', label: 'More than 60 days', min: 61, max: Infinity },
];

const MS_PER_DAY = 86_400_000;

/**
 * Alternative Risk Insights paths tried when the configured one 404s.  The
 * Risk Management service has moved between these during its rollout, so we
 * probe once and then remember whichever answers.
 */
const RISK_PATH_CANDIDATES = [
  '/api/risk-management/risks/{projectId}',
  '/api/risk-management/projects/{projectId}/risks',
  '/api/risk-management/risks',
];

const pick = (source, keys) => {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
};

/** Parse a date from any of the shapes CxONE uses, returning null if unusable. */
export function parseDate(value) {
  if (value === undefined || value === null || value === '') return null;
  // Epoch seconds or milliseconds.
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
 * Flatten one risk record from the Risk Insights API into the shape the UI and
 * the reminder email use.  Field names vary between scanners (and between API
 * versions), so every attribute is resolved from a list of candidates.
 */
export function normalizeRisk(raw, project, now = new Date()) {
  const firstDetectedAt = pick(raw, [
    'firstFoundAt',
    'firstDetectionDate',
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

  return {
    id: String(pick(raw, ['id', 'riskId', 'similarityId', 'resultId', 'vulnerabilityId']) ?? cryptoId()),
    projectId: project.id,
    projectName: project.name,
    title: String(
      pick(raw, ['title', 'name', 'queryName', 'vulnerabilityId', 'cveId', 'cveName', 'description']) ??
        'Untitled risk',
    ),
    severity: String(pick(raw, ['severity', 'riskSeverity', 'severityLevel']) ?? 'UNKNOWN').toUpperCase(),
    state: String(pick(raw, ['state', 'resultState']) ?? '').toUpperCase(),
    status: String(pick(raw, ['status', 'resultStatus']) ?? '').toUpperCase(),
    scanner: String(pick(raw, ['scannerType', 'engine', 'sourceEngine', 'scanType', 'type']) ?? '').toUpperCase(),
    location: String(pick(raw, ['fileName', 'filePath', 'packageName', 'location', 'packageIdentifier']) ?? ''),
    firstDetectedAt: parsed ? parsed.toISOString() : null,
    ageDays: days,
    bucket: bucketForAge(days),
    riskScore: pick(raw, ['riskScore', 'score', 'cvssScore']) ?? null,
    insights: pick(raw, ['aiInsights', 'insights', 'aiInsight', 'aiDescription']) ?? null,
  };
}

let counter = 0;
const cryptoId = () => `risk-${Date.now().toString(36)}-${(counter += 1)}`;

// ---------------------------------------------------------------------------
// Risk sources
// ---------------------------------------------------------------------------

/** Risk Insights API, with one-time path discovery when the default 404s. */
class RiskInsightsSource {
  #client;
  #config;
  #resolvedPath;

  constructor(client, config) {
    this.#client = client;
    this.#config = config;
    this.#resolvedPath = config.risks.path;
  }

  get name() {
    return 'risk-insights';
  }

  get resolvedPath() {
    return this.#resolvedPath;
  }

  #candidates() {
    if (!this.#config.risks.autodiscover) return [this.#resolvedPath];
    return [this.#resolvedPath, ...RISK_PATH_CANDIDATES.filter((path) => path !== this.#resolvedPath)];
  }

  async fetchForProject(project) {
    const method = this.#config.risks.method;
    let lastNotFound;

    for (const candidate of this.#candidates()) {
      const path = candidate.replace('{projectId}', encodeURIComponent(project.id));
      const usesPathParam = candidate.includes('{projectId}');

      try {
        const items = [];
        for await (const item of this.#client.paginate(path, {
          itemsKey: 'risks',
          query: usesPathParam ? {} : { 'project-id': project.id, projectId: project.id },
          limit: 100,
          maxItems: 5000,
        })) {
          items.push(item);
        }
        this.#resolvedPath = candidate;
        return items;
      } catch (error) {
        if (error instanceof CxApiError && (error.status === 404 || error.status === 405)) {
          // POST-style endpoints reject GET with 405; try the body form once.
          if (error.status === 405 && method !== 'POST') {
            const page = await this.#client
              .request(path, { method: 'POST', body: { projectId: project.id } })
              .catch(() => null);
            if (page) {
              this.#resolvedPath = candidate;
              return extractItems(page, 'risks');
            }
          }
          lastNotFound = error;
          continue;
        }
        throw error;
      }
    }

    throw (
      lastNotFound ??
      new CxApiError(`No Risk Insights endpoint responded for project ${project.id}.`, { status: 404 })
    );
  }
}

/**
 * Fallback for tenants without the Risk Management service: read the latest
 * completed scan's results, which carry `firstFoundAt` directly.
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
    return '/api/results';
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
      maxItems: 5000,
    })) {
      items.push(item);
    }
    return items;
  }
}

export function createRiskSource(client, config) {
  return config.risks.source === 'scan-results'
    ? new ScanResultsSource(client)
    : new RiskInsightsSource(client, config);
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
export async function collectProjectRisks(client, config, projects, { now = new Date() } = {}) {
  const source = createRiskSource(client, config);
  await source.prime?.(projects);

  const rows = await mapWithConcurrency(projects, config.concurrency, async (project) => {
    try {
      const raw = await source.fetchForProject(project);
      const risks = raw.map((item) => normalizeRisk(item, project, now));
      return { project, risks, error: null };
    } catch (error) {
      return { project, risks: [], error: error.message ?? String(error) };
    }
  });

  return {
    source: source.name,
    resolvedPath: source.resolvedPath,
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
