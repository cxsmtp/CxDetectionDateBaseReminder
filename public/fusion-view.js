// Labs → Fusion: the figures the page shows from what the server read (src/fusion-ai.js: the AI-generated
// SAST results of each project's latest scan), and the HTML report it downloads. Pure, so the tests check
// them without a browser.

export const FUSION_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const RANK = { CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 };

/** NEW → New, TO_VERIFY → To verify, as Checkmarx One writes them. */
export const wordsLabel = (v) => {
  const t = String(v ?? '').trim().replace(/[_-]+/g, ' ').toLowerCase();
  return t ? t[0].toUpperCase() + t.slice(1) : '—';
};

/**
 * The three tiles across the top:
 * - found: the AI-generated results, by severity, in how many projects of those loaded;
 * - change: new and recurrent in the latest scans, and fixed since the scans before;
 * - perCredit: results, and critical or high results, per Fusion credit used (credits as entered).
 */
export function fusionTiles(fusion, scope, credits) {
  const t = fusion?.totals ?? {};
  const n = (k) => Number(t[k]) || 0;
  const results = n('total');
  const top = n('CRITICAL') + n('HIGH');
  const used = Number(credits);
  const paid = Number.isFinite(used) && used > 0 ? used : null;
  return {
    found: { results, CRITICAL: n('CRITICAL'), HIGH: n('HIGH'), MEDIUM: n('MEDIUM'), LOW: n('LOW'), projects: Object.values(fusion?.projects ?? {}).filter((p) => p.total > 0).length, of: Number(scope?.projects) || 0 },
    change: { NEW: n('NEW'), RECURRENT: n('RECURRENT'), FIXED: n('FIXED') },
    perCredit: { credits: paid, results: paid ? Math.round((results / paid) * 100) / 100 : null, top: paid ? Math.round((top / paid) * 100) / 100 : null, creditsPerTop: paid && top ? Math.round((paid / top) * 10) / 10 : null },
  };
}

/** One row per project with AI-generated results (or some fixed), most critical first. */
export function fusionRows(fusion, scope) {
  return Object.entries(fusion?.projects ?? {})
    .map(([projectId, c]) => ({
      projectId,
      name: scope?.names?.[projectId] ?? c.projectName ?? projectId,
      CRITICAL: c.CRITICAL ?? 0,
      HIGH: c.HIGH ?? 0,
      MEDIUM: c.MEDIUM ?? 0,
      LOW: c.LOW ?? 0,
      total: c.total ?? 0,
      NEW: c.NEW ?? 0,
      RECURRENT: c.RECURRENT ?? 0,
      FIXED: c.FIXED ?? 0,
      fixedKnown: c.fixedKnown !== false,
      scanAt: c.scanAt ?? null,
      scanId: c.scanId ?? '',
      url: c.url ?? '',
    }))
    .sort((a, b) => b.CRITICAL - a.CRITICAL || b.HIGH - a.HIGH || b.total - a.total || a.name.localeCompare(b.name));
}

/** Every result, as the Checkmarx One results page lists them: most severe first, then the most recently found. */
export function fusionResultRows(fusion, scope) {
  return (fusion?.results ?? [])
    .map((r) => ({
      id: r.resultId,
      hash: r.hash ?? '',
      severity: r.severity ?? 'INFO',
      name: r.name || r.resultId,
      status: r.status ? wordsLabel(r.status) : '',
      state: r.state ? wordsLabel(r.state) : '',
      language: r.language ?? '',
      cwe: r.cwe ?? null,
      source: r.sourceFile ? `${r.sourceFile}${r.sourceLine ? `:${r.sourceLine}` : ''}` : '',
      sink: r.sinkFile ? `${r.sinkFile}${r.sinkLine ? `:${r.sinkLine}` : ''}` : '',
      sourceNode: r.sourceNode ?? '',
      sinkNode: r.sinkNode ?? '',
      firstFoundAt: r.firstFoundAt ?? null,
      foundAt: r.foundAt ?? null,
      projectId: r.projectId,
      project: scope?.names?.[r.projectId] ?? r.projectName ?? r.projectId,
      projectUrl: fusion?.projects?.[r.projectId]?.url ?? '',
      url: r.url ?? '',
    }))
    .sort((a, b) => (RANK[b.severity] ?? 0) - (RANK[a.severity] ?? 0) || String(b.firstFoundAt ?? '').localeCompare(String(a.firstFoundAt ?? '')) || a.name.localeCompare(b.name));
}

/** A project's Fusion results for the Workbench's Fusion column: null until Fusion has been read. */
export const fusionTotalOf = (fusion, projectId) => (fusion ? (fusion.projects?.[projectId]?.total ?? 0) : null);

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LABEL = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low', INFO: 'Info' };
const COLOUR = { CRITICAL: '#b42318', HIGH: '#c2410c', MEDIUM: '#b7791f', LOW: '#2563eb', INFO: '#64748b' };

/**
 * The HTML report: one self-contained file (no script, nothing loaded from elsewhere) with the totals, every
 * project with its counts, and every result with its details and its link to Checkmarx One.
 * `opts`: { appName, organisation, generatedAt, fmtDate(iso) }.
 */
export function fusionReportHtml(fusion, scope, opts = {}) {
  const fmt = (n) => Number(n || 0).toLocaleString('en');
  const date = (iso) => (iso ? (opts.fmtDate ? opts.fmtDate(iso) : new Date(iso).toISOString().slice(0, 16).replace('T', ' ')) : '—');
  const t = fusionTiles(fusion, scope, '');
  const projects = fusionRows(fusion, scope);
  const results = fusionResultRows(fusion, scope);
  const sev = (s) => `<span class="sev" style="--c:${COLOUR[s] ?? COLOUR.INFO}">${esc(LABEL[s] ?? s)}</span>`;
  const link = (url, text) => (url ? `<a href="${esc(url)}">${esc(text)}</a>` : esc(text));
  const byProject = new Map();
  for (const r of results) {
    if (!byProject.has(r.projectId)) byProject.set(r.projectId, []);
    byProject.get(r.projectId).push(r);
  }
  const scopeLine = [scope?.own?.applications?.length ? `Applications: ${scope.own.applications.join(', ')}` : '', scope?.own?.projects?.length ? `Projects: ${scope.own.projects.join(', ')}` : ''].filter(Boolean).join(' · ') || 'Every project';
  const title = `Fusion results${opts.organisation ? ` — ${opts.organisation}` : ''}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root { color-scheme: light dark; --ink: #14171c; --muted: #5c636e; --line: #e2e5e9; --soft: #f4f6fb; --bg: #fff; }
@media (prefers-color-scheme: dark) { :root { --ink: #e8eaee; --muted: #a2a9b4; --line: #2c323b; --soft: #1b2028; --bg: #12161c; } }
body { margin: 0; padding: 32px 24px 64px; background: var(--bg); color: var(--ink); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1200px; margin: 0 auto; }
h1 { margin: 0 0 4px; font-size: 26px; } h2 { margin: 32px 0 10px; font-size: 18px; } h3 { margin: 24px 0 8px; font-size: 15px; }
.sub { color: var(--muted); margin: 0; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 20px 0; }
.tile { border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; background: var(--soft); }
.tile b { display: block; font-size: 28px; font-variant-numeric: tabular-nums; } .tile span { color: var(--muted); font-size: 13px; }
table { width: 100%; border-collapse: collapse; margin: 6px 0 12px; font-size: 13px; }
th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
th { color: var(--muted); font-weight: 600; font-size: 12px; } td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.sev { display: inline-flex; align-items: center; gap: 6px; } .sev::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
a { color: #2563eb; } small { color: var(--muted); display: block; }
footer { margin-top: 40px; color: var(--muted); font-size: 12px; }
@media print { body { padding: 0; } a { color: inherit; } }
</style></head>
<body><main>
<h1>${esc(title)}</h1>
<p class="sub">What Checkmarx One's AI engine found in SAST (results marked AI-generated), from each project's latest scan · ${esc(scopeLine)} · read ${esc(date(fusion?.readAt))}</p>
<div class="tiles">
<div class="tile"><b>${fmt(t.found.results)}</b><span>AI-generated results in ${fmt(t.found.projects)} of ${fmt(t.found.of)} projects · ${fmt(t.found.CRITICAL)} critical, ${fmt(t.found.HIGH)} high, ${fmt(t.found.MEDIUM)} medium, ${fmt(t.found.LOW)} low</span></div>
<div class="tile"><b>${fmt(t.change.NEW)}</b><span>New in the latest scans · ${fmt(t.change.RECURRENT)} recurrent</span></div>
<div class="tile"><b>${fmt(t.change.FIXED)}</b><span>Fixed since the scans before</span></div>
</div>
<h2>Projects</h2>
<table><thead><tr><th>Project</th><th class="num">Critical</th><th class="num">High</th><th class="num">Medium</th><th class="num">Low</th><th class="num">Total</th><th class="num">New</th><th class="num">Recurrent</th><th class="num">Fixed</th><th>Latest scan</th></tr></thead><tbody>
${projects.map((p) => `<tr><td>${link(p.url, p.name)}</td><td class="num">${fmt(p.CRITICAL)}</td><td class="num">${fmt(p.HIGH)}</td><td class="num">${fmt(p.MEDIUM)}</td><td class="num">${fmt(p.LOW)}</td><td class="num">${fmt(p.total)}</td><td class="num">${fmt(p.NEW)}</td><td class="num">${fmt(p.RECURRENT)}</td><td class="num">${p.fixedKnown ? fmt(p.FIXED) : '—'}</td><td>${esc(date(p.scanAt))}</td></tr>`).join('\n') || '<tr><td colspan="10">No AI-generated results.</td></tr>'}
</tbody></table>
<h2>Results</h2>
${projects.filter((p) => byProject.has(p.projectId)).map((p) => `<h3>${link(p.url, p.name)} <small>${fmt(byProject.get(p.projectId).length)} result(s)</small></h3>
<table><thead><tr><th>Severity</th><th>Vulnerability</th><th>Status</th><th>State</th><th>Language</th><th>CWE</th><th>Source → sink</th><th>First found</th><th>Last found</th></tr></thead><tbody>
${byProject.get(p.projectId).map((r) => `<tr><td>${sev(r.severity)}</td><td>${link(r.url, r.name)}<small>${esc(r.id)}</small></td><td>${esc(r.status || '—')}</td><td>${esc(r.state || '—')}</td><td>${esc(r.language || '—')}</td><td>${r.cwe ? `CWE-${esc(r.cwe)}` : '—'}</td><td>${esc(r.source || '—')}${r.sourceNode ? ` <small>${esc(r.sourceNode)}</small>` : ''}${r.sink && r.sink !== r.source ? `→ ${esc(r.sink)}` : ''}${r.sinkNode ? ` <small>${esc(r.sinkNode)}</small>` : ''}</td><td>${esc(date(r.firstFoundAt))}</td><td>${esc(date(r.foundAt))}</td></tr>`).join('\n')}
</tbody></table>`).join('\n') || '<p>No AI-generated results.</p>'}
<footer>${esc(opts.appName || 'CxMissionZero')} · Labs → Fusion results · generated ${esc(date(opts.generatedAt ?? new Date().toISOString()))}. Each vulnerability opens the result in Checkmarx One; each project, its page there.</footer>
</main></body></html>
`;
}
