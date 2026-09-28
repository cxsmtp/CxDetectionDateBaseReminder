import { withinWindow } from '../window.js';

/** Projects API: GET /api/projects (offset/limit paginated). */
export async function listProjects(client, { maxItems = 5000 } = {}) {
  const projects = [];
  for await (const project of client.paginate('/api/projects', {
    itemsKey: 'projects',
    limit: 100,
    maxItems,
  })) {
    projects.push({
      id: project.id,
      name: project.name ?? project.id,
      createdAt: project.createdAt ?? null,
      updatedAt: project.updatedAt ?? null,
      tags: project.tags ?? {},
      groups: project.groups ?? [],
      repoUrl: project.repoUrl ?? '',
      mainBranch: project.mainBranch ?? '',
      criticality: project.criticality ?? null,
    });
  }
  return projects;
}

// A long list of project ids in the query string will trip request-line limits,
// so last-scan lookups go out in chunks.
const LAST_SCAN_CHUNK = 50;

const chunk = (items, size) => {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/**
 * Latest completed scan per project, keyed by project id.  Used both by the
 * scan-results risk fallback and by the project activity window.
 */
export async function getLastScans(client, projectIds) {
  if (projectIds.length === 0) return {};

  const merged = {};
  for (const ids of chunk(projectIds, LAST_SCAN_CHUNK)) {
    const response = await client.request('/api/projects/last-scan', {
      query: { 'project-ids': ids, 'scan-status': 'Completed' },
    });
    if (response && typeof response === 'object') Object.assign(merged, response);
  }
  return merged;
}

/** The date a project was last scanned, from whichever field the tenant uses. */
export function lastScanDate(scan) {
  for (const key of ['updatedAt', 'createdAt', 'scanDate', 'completedAt', 'finishedAt']) {
    if (scan?.[key]) return scan[key];
  }
  return null;
}

/**
 * Narrow the project list to those scanned inside `window`, so the (expensive)
 * per-project risk fetch only runs for projects that have recent activity.
 *
 * Returns the kept projects plus the counts needed to explain the filtering,
 * and degrades to "keep everything" if the last-scan lookup is unavailable.
 */
export async function filterProjectsByActivity(client, projects, window) {
  if (!window) return { projects, lastScans: {}, skipped: 0, warning: null };


  let lastScans;
  try {
    lastScans = await getLastScans(
      client,
      projects.map((project) => project.id),
    );
  } catch (error) {
    return {
      projects,
      lastScans: {},
      skipped: 0,
      warning: `Could not read last-scan dates, so the project activity window was not applied: ${error.message}`,
    };
  }

  const kept = projects.filter((project) =>
    withinWindow(window, lastScanDate(lastScans[project.id])),
  );

  return { projects: kept, lastScans, skipped: projects.length - kept.length, warning: null };
}
