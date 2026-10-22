// Labs → Fusion: the figures the page shows from what the server read (src/fusion-ai.js: the AI-generated
// SAST results of each project's latest scan), and the HTML report it downloads. Pure, so the tests check
// them without a browser.
//
// Each result is Fusion's (the traditional SAST engine supports its language or framework too) or LAST's
// (language-agnostic static testing: the AI engine alone covers it). Everything here takes the ones the page
// shows, `engines` (['FUSION', 'LAST'] by default): both, every AI-generated result; one, only that one's.

export const FUSION_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
export const FUSION_ENGINES = ['FUSION', 'LAST'];
const RANK = { CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 };
const COUNTED = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO', 'total', 'NEW', 'RECURRENT', 'FIXED'];

/** NEW → New, TO_VERIFY → To verify, as Checkmarx One writes them. */
export const wordsLabel = (v) => {
  const t = String(v ?? '').trim().replace(/[_-]+/g, ' ').toLowerCase();
  return t ? t[0].toUpperCase() + t.slice(1) : '—';
};

/** The ones shown, in order; none (or nothing known) is both. */
export const shownEngines = (engines) => {
  const list = FUSION_ENGINES.filter((e) => (engines ?? FUSION_ENGINES).includes(e));
  return list.length ? list : [...FUSION_ENGINES];
};
/** "Fusion", "LAST" or "Fusion and LAST": what the page, its exports and its credits are about. */
export const engineLabel = (engines) => {
  const list = shownEngines(engines);
  return list.length === 2 ? 'Fusion and LAST' : list[0] === 'FUSION' ? 'Fusion' : 'LAST';
};
export const ENGINE_LABEL = { FUSION: 'Fusion', LAST: 'LAST' };

/**
 * A project's (or the totals') counts for the engines shown: the sum of each one's, with Fixed known only when
 * each one's is. A read without them apart (before Fusion and LAST were told apart) counts as it is.
 */
export function countsFor(c, engines) {
  if (!c) return null;
  if (!c.engines) return { ...c, fixedKnown: c.fixedKnown !== false };
  const out = Object.fromEntries(COUNTED.map((k) => [k, 0]));
  let fixedKnown = true;
  for (const e of shownEngines(engines)) {
    const one = c.engines[e] ?? {};
    for (const k of COUNTED) out[k] += Number(one[k]) || 0;
    if (one.fixedKnown === false) fixedKnown = false;
  }
  return { ...out, fixedKnown };
}

const inEngines = (r, engines) => !r.engine || shownEngines(engines).includes(r.engine);

/**
 * The line of figures across the top: the projects with results, the results by severity, and new and fixed
 * since the scans before; for the engines shown.
 */
export function fusionTiles(fusion, scope, engines) {
  const t = countsFor(fusion?.totals ?? {}, engines) ?? {};
  const n = (k) => Number(t[k]) || 0;
  const rows = fusionRows(fusion, scope, engines);
  // The AI scans and credits of the projects shown, over the period read (null when Checkmarx One did not say).
  const sum = (k) => (rows.some((r) => r[k] !== null) ? Math.round(rows.reduce((a, r) => a + (r[k] ?? 0), 0) * 100) / 100 : null);
  return {
    found: { results: n('total'), CRITICAL: n('CRITICAL'), HIGH: n('HIGH'), MEDIUM: n('MEDIUM'), LOW: n('LOW'), projects: rows.length, of: Number(scope?.projects) || 0 },
    change: { NEW: n('NEW'), RECURRENT: n('RECURRENT'), FIXED: n('FIXED'), fixedKnown: t.fixedKnown !== false },
    usage: { scans: sum('scans'), credits: sum('credits'), period: fusion?.usage?.period ?? null },
  };
}

/** "Last 30 days", for the period the AI scans and credits were read over. */
export const PERIOD_LABEL = { last_30_days: 'Last 30 days', last_90_days: 'Last 90 days', last_180_days: 'Last 180 days', last_year: 'Last year' };
/** Where a project's model was read: its latest scan, its settings, or the tenant's. */
export const MODEL_FROM = { scan: 'its latest scan', project: 'the project’s settings', tenant: 'the tenant’s settings' };

/** One row per project with results (or some fixed) for the engines shown, most critical first. */
export function fusionRows(fusion, scope, engines) {
  return Object.entries(fusion?.projects ?? {})
    .map(([projectId, all]) => {
      const c = countsFor(all, engines);
      const used = fusion?.usage?.projects?.[projectId] ?? null;
      return {
        projectId,
        name: scope?.names?.[projectId] ?? all.projectName ?? projectId,
        CRITICAL: c.CRITICAL ?? 0,
        HIGH: c.HIGH ?? 0,
        MEDIUM: c.MEDIUM ?? 0,
        LOW: c.LOW ?? 0,
        total: c.total ?? 0,
        NEW: c.NEW ?? 0,
        RECURRENT: c.RECURRENT ?? 0,
        FIXED: c.FIXED ?? 0,
        fixedKnown: c.fixedKnown,
        scanAt: all.scanAt ?? null,
        scanId: all.scanId ?? '',
        url: all.url ?? '',
        model: all.model ?? '',
        modelFrom: all.modelFrom ?? '',
        loc: all.loc ?? null,
        scans: used?.scans ?? null,
        credits: used?.credits ?? null,
        fusionCredits: used?.fusion ?? null,
        actions: used?.actions ?? null,
        perScan: used?.perScan ?? null,
      };
    })
    .filter((r) => r.total > 0 || r.FIXED > 0)
    .sort((a, b) => b.CRITICAL - a.CRITICAL || b.HIGH - a.HIGH || b.total - a.total || a.name.localeCompare(b.name));
}

/**
 * Every result of the engines shown (of one project, with `projectId`), as the Checkmarx One results page lists
 * them: most severe first, then the most recently found.
 */
export function fusionResultRows(fusion, scope, engines, projectId = null) {
  return (fusion?.results ?? [])
    .filter((r) => inEngines(r, engines) && (!projectId || r.projectId === projectId))
    .map((r) => ({
      id: r.resultId,
      hash: r.hash ?? '',
      severity: r.severity ?? 'INFO',
      engine: r.engine ?? '',
      coveredAs: r.coveredAs ?? '',
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

/** A project's results for the Workbench's Fusion column, for the engines shown: null until Fusion has been read. */
export const fusionTotalOf = (fusion, projectId, engines) => (fusion ? (countsFor(fusion.projects?.[projectId], engines)?.total ?? 0) : null);

/** "nftMint.ts:41" from "/juice-shop/routes/nftMint.ts:41". */
export const fileOf = (path) => String(path ?? '').split(/[\\/]/).pop();

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LABEL = { CRITICAL: 'Critical', HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low', INFO: 'Info' };
const COLOUR = { CRITICAL: '#b42318', HIGH: '#c2410c', MEDIUM: '#b7791f', LOW: '#2563eb', INFO: '#64748b' };

/**
 * The HTML report: one self-contained file (no script, nothing loaded from elsewhere) with the totals, every
 * project with its counts, and every result with its details and its link to Checkmarx One; for the engines
 * shown, and for one project with `opts.projectId`.
 * `opts`: { appName, organisation, generatedAt, fmtDate(iso), engines, projectId }.
 */
export function fusionReportHtml(fusion, scope, opts = {}) {
  const engines = shownEngines(opts.engines);
  const fmt = (n) => Number(n || 0).toLocaleString('en');
  const date = (iso) => (iso ? (opts.fmtDate ? opts.fmtDate(iso) : new Date(iso).toISOString().slice(0, 16).replace('T', ' ')) : '—');
  const projects = fusionRows(fusion, scope, engines).filter((p) => !opts.projectId || p.projectId === opts.projectId);
  const results = fusionResultRows(fusion, scope, engines, opts.projectId ?? null);
  const one = opts.projectId ? projects[0] : null;
  const sum = (k) => projects.reduce((n, p) => n + p[k], 0);
  const usage = fusion?.usage ? { scans: sum('scans'), credits: fusion.usage.creditsKnown ? sum('credits') : null } : null;
  const t = { results: sum('total'), CRITICAL: sum('CRITICAL'), HIGH: sum('HIGH'), MEDIUM: sum('MEDIUM'), LOW: sum('LOW'), NEW: sum('NEW'), RECURRENT: sum('RECURRENT'), FIXED: sum('FIXED') };
  const sev = (s) => `<span class="sev" style="--c:${COLOUR[s] ?? COLOUR.INFO}">${esc(LABEL[s] ?? s)}</span>`;
  const tag = (e) => (e ? `<span class="tag ${e === 'LAST' ? 'last' : ''}">${esc(ENGINE_LABEL[e] ?? e)}</span>` : '—');
  const link = (url, text) => (url ? `<a href="${esc(url)}">${esc(text)}</a>` : esc(text));
  const byProject = new Map();
  for (const r of results) {
    if (!byProject.has(r.projectId)) byProject.set(r.projectId, []);
    byProject.get(r.projectId).push(r);
  }
  const label = engineLabel(engines);
  const scopeLine = one
    ? `Project: ${one.name}`
    : [scope?.own?.applications?.length ? `Applications: ${scope.own.applications.join(', ')}` : '', scope?.own?.projects?.length ? `Projects: ${scope.own.projects.join(', ')}` : ''].filter(Boolean).join(' · ') || 'Every project';
  const title = `${label} results${one ? ` — ${one.name}` : ''}${opts.organisation ? ` — ${opts.organisation}` : ''}`;
  const meaning = [engines.includes('FUSION') ? '<b>Fusion</b>: in a language or framework the traditional SAST engine also supports' : '', engines.includes('LAST') ? '<b>LAST</b> (language-agnostic static testing): in a language only the AI engine covers' : ''].filter(Boolean).join('; ');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root { color-scheme: light dark; --ink: #14171c; --muted: #5c636e; --line: #e2e5e9; --soft: #f4f6fb; --bg: #fff; --fusion: #4f46e5; --last: #0f766e; }
@media (prefers-color-scheme: dark) { :root { --ink: #e8eaee; --muted: #a2a9b4; --line: #2c323b; --soft: #1b2028; --bg: #12161c; --fusion: #8b85ff; --last: #2dd4bf; } }
body { margin: 0; padding: 32px 24px 64px; background: var(--bg); color: var(--ink); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1200px; margin: 0 auto; }
h1 { margin: 0 0 4px; font-size: 26px; } h2 { margin: 32px 0 10px; font-size: 18px; } h3 { margin: 24px 0 8px; font-size: 15px; }
.sub { color: var(--muted); margin: 0 0 4px; }
.strip { display: flex; flex-wrap: wrap; margin: 20px 0; border: 1px solid var(--line); border-radius: 12px; background: var(--soft); }
.strip div { flex: 1 1 110px; padding: 12px 14px; } .strip div + div { border-inline-start: 1px solid var(--line); }
.strip b { display: block; font-size: 22px; font-variant-numeric: tabular-nums; } .strip span { color: var(--muted); font-size: 12.5px; }
table { width: 100%; border-collapse: collapse; margin: 6px 0 12px; font-size: 13px; }
th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
th { color: var(--muted); font-weight: 600; font-size: 12px; } td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.sev { display: inline-flex; align-items: center; gap: 6px; } .sev::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
.tag { display: inline-block; padding: 0 7px; border-radius: 99px; font-size: 11px; font-weight: 600; color: var(--fusion); border: 1px solid currentColor; } .tag.last { color: var(--last); }
a { color: #2563eb; } small { color: var(--muted); display: block; }
footer { margin-top: 40px; color: var(--muted); font-size: 12px; }
@media print { body { padding: 0; } a { color: inherit; } }
</style></head>
<body><main>
<h1>${esc(title)}</h1>
<p class="sub">What Checkmarx One's AI engine found in SAST (results marked AI-generated), from each project's latest scan · ${esc(scopeLine)} · read ${esc(date(fusion?.readAt))}</p>
<p class="sub">${meaning}.</p>
<div class="strip">
<div><b>${fmt(projects.length)}</b><span>Projects</span></div>${usage ? `<div><b>${fmt(usage.scans)}</b><span>AI scans · ${esc(PERIOD_LABEL[fusion.usage.period] ?? '')}</span></div><div><b>${usage.credits === null ? '—' : fmt(usage.credits)}</b><span>Credits spent</span></div>` : ''}<div><b>${fmt(t.results)}</b><span>${esc(label)} results</span></div><div><b>${fmt(t.CRITICAL)}</b><span>Critical</span></div><div><b>${fmt(t.HIGH)}</b><span>High</span></div><div><b>${fmt(t.MEDIUM)}</b><span>Medium</span></div><div><b>${fmt(t.LOW)}</b><span>Low</span></div><div><b>${fmt(t.NEW)}</b><span>New</span></div><div><b>${fmt(t.FIXED)}</b><span>Fixed</span></div>
</div>
<h2>Projects</h2>
<table><thead><tr><th>Project</th><th>Model</th><th class="num">LOC</th><th class="num">AI scans</th><th class="num">Credits</th><th class="num">Critical</th><th class="num">High</th><th class="num">Medium</th><th class="num">Low</th><th class="num">Total</th><th class="num">New</th><th class="num">Recurrent</th><th class="num">Fixed</th><th>Latest scan</th></tr></thead><tbody>
${projects.map((p) => `<tr><td>${link(p.url, p.name)}</td><td>${esc(p.model || '—')}</td><td class="num">${p.loc === null ? '—' : fmt(p.loc)}</td><td class="num">${p.scans === null ? '—' : fmt(p.scans)}</td><td class="num">${p.credits === null ? '—' : fmt(p.credits)}</td><td class="num">${fmt(p.CRITICAL)}</td><td class="num">${fmt(p.HIGH)}</td><td class="num">${fmt(p.MEDIUM)}</td><td class="num">${fmt(p.LOW)}</td><td class="num">${fmt(p.total)}</td><td class="num">${fmt(p.NEW)}</td><td class="num">${fmt(p.RECURRENT)}</td><td class="num">${p.fixedKnown ? fmt(p.FIXED) : '—'}</td><td>${esc(date(p.scanAt))}</td></tr>`).join('\n') || `<tr><td colspan="14">No ${esc(label)} results.</td></tr>`}
</tbody></table>
<h2>Results</h2>
${projects.filter((p) => byProject.has(p.projectId)).map((p) => `<h3>${link(p.url, p.name)} <small>${fmt(byProject.get(p.projectId).length)} result(s)</small></h3>
<table><thead><tr><th>Severity</th><th>Engine</th><th>Vulnerability</th><th>Status</th><th>State</th><th>Language</th><th>CWE</th><th>Source → sink</th><th>First found</th><th>Last found</th></tr></thead><tbody>
${byProject.get(p.projectId).map((r) => `<tr><td>${sev(r.severity)}</td><td>${tag(r.engine)}</td><td>${link(r.url, r.name)}<small>${esc(r.id)}</small></td><td>${esc(r.status || '—')}</td><td>${esc(r.state || '—')}</td><td>${esc(r.language || '—')}${r.coveredAs && r.coveredAs !== r.language ? `<small>SAST: ${esc(r.coveredAs)}</small>` : ''}</td><td>${r.cwe ? `CWE-${esc(r.cwe)}` : '—'}</td><td>${esc(r.source || '—')}${r.sourceNode ? ` <small>${esc(r.sourceNode)}</small>` : ''}${r.sink && r.sink !== r.source ? `→ ${esc(r.sink)}` : ''}${r.sinkNode ? ` <small>${esc(r.sinkNode)}</small>` : ''}</td><td>${esc(date(r.firstFoundAt))}</td><td>${esc(date(r.foundAt))}</td></tr>`).join('\n')}
</tbody></table>`).join('\n') || `<p>No ${esc(label)} results.</p>`}
<footer>${esc(opts.appName || 'CxMissionZero')} · Labs → Fusion results · generated ${esc(date(opts.generatedAt ?? new Date().toISOString()))}. Each vulnerability opens the result in Checkmarx One; each project, its page there.</footer>
</main></body></html>
`;
}
