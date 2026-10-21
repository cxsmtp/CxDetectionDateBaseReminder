// Labs → Fusion: the figures the page shows from what the server read (src/fusion.js) and the
// Workbench's last fetch (its scope). Pure, so the tests check them without a browser.

export const FUSION_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

/**
 * The three tiles across the top:
 * - share: how many of the open findings fetched Fusion re-scored;
 * - top: results Fusion raised to critical or high (from lower), and in how many projects;
 * - perCredit: results, and critical or high results, per Fusion credit used (credits as entered).
 */
export function fusionTiles(fusion, scope, credits) {
  const totals = fusion?.totals ?? {};
  const results = Number(totals.total) || 0;
  const open = Number(scope?.openFindings) || 0;
  const projects = Object.values(fusion?.projects ?? {});
  const top = (Number(totals.CRITICAL) || 0) + (Number(totals.HIGH) || 0);
  const used = Number(credits);
  const paid = Number.isFinite(used) && used > 0 ? used : null;
  return {
    share: { results, open, percent: open ? Math.round((results / open) * 1000) / 10 : null, projects: projects.filter((p) => p.total > 0).length, of: Number(scope?.projects) || 0 },
    // Raised or lowered needs each result's earlier score, which Application Risk Management does not give.
    top: { known: fusion?.source !== 'risk-management', raised: Number(totals.raisedToTop) || 0, projects: projects.filter((p) => p.raisedToTop > 0).length, lowered: Number(totals.lowered) || 0 },
    perCredit: { credits: paid, results: paid ? Math.round((results / paid) * 100) / 100 : null, top: paid ? Math.round((top / paid) * 100) / 100 : null, creditsPerTop: paid && top ? Math.round((paid / top) * 10) / 10 : null },
  };
}

/** One row per project with Fusion results, most critical first: its name, applications and counts. */
export function fusionRows(fusion, scope) {
  const appName = new Map((fusion?.applications ?? []).map((a) => [a.id, a.name]));
  const scanOf = new Map((fusion?.applications ?? []).map((a) => [a.id, a.scan]));
  return Object.entries(fusion?.projects ?? {})
    .map(([projectId, c]) => {
      const scans = (c.applications ?? []).map((id) => scanOf.get(id)).filter(Boolean);
      const latest = scans.filter((s) => s.at).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] ?? scans[0] ?? null;
      return {
        projectId,
        name: scope?.names?.[projectId] ?? fusion?.names?.[projectId] ?? projectId,
        applications: (c.applications ?? []).map((id) => appName.get(id) ?? id),
        CRITICAL: c.CRITICAL ?? 0,
        HIGH: c.HIGH ?? 0,
        MEDIUM: c.MEDIUM ?? 0,
        LOW: c.LOW ?? 0,
        total: c.total ?? 0,
        raisedToTop: c.raisedToTop ?? 0,
        lowered: c.lowered ?? 0,
        scan: latest,
      };
    })
    .sort((a, b) => b.CRITICAL - a.CRITICAL || b.HIGH - a.HIGH || b.total - a.total || a.name.localeCompare(b.name));
}

/** A project's Fusion results for the Workbench's Fusion column: null until Fusion has been read. */
export const fusionTotalOf = (fusion, projectId) => (fusion ? (fusion.projects?.[projectId]?.total ?? 0) : null);
