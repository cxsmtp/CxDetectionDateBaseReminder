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

/** Latest scan per project, used by the scan-results risk fallback. */
export async function getLastScans(client, projectIds) {
  if (projectIds.length === 0) return {};
  const response = await client.request('/api/projects/last-scan', {
    query: { 'project-ids': projectIds, 'scan-status': 'Completed' },
  });
  return response && typeof response === 'object' ? response : {};
}
