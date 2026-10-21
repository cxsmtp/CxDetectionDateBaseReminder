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

const SCANNERS = { code: 'SAST', sast: 'SAST', sca: 'SCA', kics: 'IaC', iac: 'IaC', 'iac-security': 'IaC', secrets: 'Secrets', 'secret-detection': 'Secrets', sscs: 'Secrets', containers: 'Containers', container: 'Containers', apisec: 'API Security', 'api-security': 'API Security' };
/** A scanner as Checkmarx One names it: SAST, SCA, IaC… */
export const scannerLabel = (v) => (v ? SCANNERS[String(v).toLowerCase()] ?? String(v).toUpperCase() : '—');
/** NEW → New, TO_VERIFY → To verify, as the platform writes them. */
export const wordsLabel = (v) => {
  const t = String(v ?? '').trim().replace(/[_-]+/g, ' ').toLowerCase();
  return t ? t[0].toUpperCase() + t.slice(1) : '—';
};
const RANK = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, NONE: 0 };

/**
 * Every Fusion result once, as Fusion Hub lists them: severity, scanner, risk name, status, state, when it
 * was detected, its risk score, its projects and application, and its id to find it again; most severe
 * first, then the most recently detected.
 */
export function fusionResultRows(fusion, scope) {
  const appName = new Map((fusion?.applications ?? []).map((a) => [a.id, a.name]));
  const byKey = new Map();
  for (const r of fusion?.results ?? []) {
    const key = `${r.applicationId}\u0000${r.resultId || `${r.projectId}:${byKey.size}`}`;
    const name = scope?.names?.[r.projectId] ?? fusion?.names?.[r.projectId] ?? r.projectId;
    const row = byKey.get(key);
    if (row) {
      if (!row.projects.includes(name)) row.projects.push(name);
      row.url ||= r.url ?? '';
      continue;
    }
    byKey.set(key, {
      id: r.resultId,
      hash: r.hash ?? '',
      severity: r.newSeverity ?? 'NONE',
      score: r.newRisk,
      scanner: scannerLabel(r.scanner ?? r.vulnerabilityEngine),
      name: r.info || r.resultId,
      status: r.status ? wordsLabel(r.status) : '',
      state: r.state ? wordsLabel(r.state) : '',
      detectedAt: r.detectedAt ?? null,
      projects: [name],
      application: appName.get(r.applicationId) ?? r.applicationId,
      // Where it opens in Checkmarx One (Risk Hub, with the result open).
      url: r.url ?? '',
    });
  }
  return [...byKey.values()].sort((a, b) => (RANK[b.severity] ?? 0) - (RANK[a.severity] ?? 0) || String(b.detectedAt ?? '').localeCompare(String(a.detectedAt ?? '')) || String(a.name).localeCompare(String(b.name)));
}
