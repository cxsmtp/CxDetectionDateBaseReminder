// Labs → Fusion: the figures the page shows from what the server read (src/fusion-ai.js: the Risk Hub list of
// each project whose latest scan ran the AI engine, a Fusion or a LAST scan), and the HTML report it downloads.
// Pure, so the tests check them without a browser.
//
// Each risk is LAST's (everything a LAST scan found; in a Fusion scan, what the AI engine found in a language only
// it covers) or else Fusion's. Everything here takes the ones the page shows, `engines` (['FUSION', 'LAST'] by
// default): both, every risk; one, only that one's. New, Recurrent and Fixed, and the states, are Risk Hub's own;
// fixed ones are not counted as open. `filter` ({ status, state, aiTriaged }) narrows to the risks that match.

export const FUSION_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
export const FUSION_ENGINES = ['FUSION', 'LAST'];
const RANK = { CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 };
/** Risk Hub's states, in the order the page offers them. */
export const FUSION_STATES = ['TO_VERIFY', 'CONFIRMED', 'PROPOSED_NOT_EXPLOITABLE', 'NOT_EXPLOITABLE', 'URGENT'];
export const STATE_LABEL = { TO_VERIFY: 'To verify', CONFIRMED: 'Confirmed', PROPOSED_NOT_EXPLOITABLE: 'Proposed not exploitable', NOT_EXPLOITABLE: 'Not exploitable', URGENT: 'Urgent' };
export const FUSION_STATUSES = ['NEW', 'RECURRENT', 'FIXED'];
const COUNTED = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO', 'total', 'NEW', 'RECURRENT', 'FIXED', ...FUSION_STATES, 'aiFound', 'aiTriaged'];
/** What a project's latest scan was: Fusion (gold), LAST (pink), or no AI. */
export const SCAN_TYPE_LABEL = { fusion: 'Fusion', last: 'LAST', none: 'No AI' };

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

/** Whether a filter ({ status, state, aiTriaged }) narrows anything. */
export const filtering = (filter) => Boolean(filter && (filter.status || filter.state || filter.aiTriaged));
/** Whether a risk (as the server lists it) matches the filter: its status, its state, set by AI Triage. */
export const matchesFilter = (r, filter) => !filter || ((!filter.status || r.status === filter.status) && (!filter.state || (r.state || 'TO_VERIFY') === filter.state) && (!filter.aiTriaged || r.aiTriaged === true));

/** A project's counts made from its listed risks that match the filter (the open ones by severity and state). */
function countsFromResults(results) {
  const out = Object.fromEntries(COUNTED.map((k) => [k, 0]));
  for (const r of results) {
    if (r.status === 'FIXED') {
      out.FIXED += 1;
      continue;
    }
    if (r.severity in out) out[r.severity] += 1;
    if (r.status === 'NEW' || r.status === 'RECURRENT') out[r.status] += 1;
    out[FUSION_STATES.includes(r.state) ? r.state : 'TO_VERIFY'] += 1;
    if (r.ai) out.aiFound += 1;
    if (r.aiTriaged) out.aiTriaged += 1;
  }
  out.total = out.CRITICAL + out.HIGH + out.MEDIUM + out.LOW + out.INFO;
  return { ...out, fixedKnown: true };
}

/**
 * The line of figures across the top: the projects with results, the results by severity, and new and fixed
 * since the scans before; for the engines shown.
 */
export function fusionTiles(fusion, scope, engines, filter = null) {
  const rows = fusionRows(fusion, scope, engines, filter);
  const t = filtering(filter) ? Object.fromEntries(COUNTED.map((k) => [k, rows.reduce((a, r) => a + (Number(r[k]) || 0), 0)])) : countsFor(fusion?.totals ?? {}, engines) ?? {};
  const n = (k) => Number(t[k]) || 0;
  // The AI scans and credits of the projects shown, over the period read (null when Checkmarx One did not say).
  const sum = (k) => (rows.some((r) => r[k] !== null) ? Math.round(rows.reduce((a, r) => a + (r[k] ?? 0), 0) * 100) / 100 : null);
  return {
    found: { results: n('total'), CRITICAL: n('CRITICAL'), HIGH: n('HIGH'), MEDIUM: n('MEDIUM'), LOW: n('LOW'), aiFound: n('aiFound'), aiTriaged: n('aiTriaged'), projects: rows.length, of: Number(scope?.projects) || 0 },
    change: { NEW: n('NEW'), RECURRENT: n('RECURRENT'), FIXED: n('FIXED'), fixedKnown: t.fixedKnown !== false },
    states: Object.fromEntries(FUSION_STATES.map((k) => [k, n(k)])),
    // What the AI engine added in the latest scans shown (as their steps say), where they said.
    added: {
      found: rows.some((r) => r.aiFound !== null) ? rows.reduce((a, r) => a + (r.aiFound ?? 0), 0) : null,
      duplicates: rows.some((r) => r.aiDuplicates !== null) ? rows.reduce((a, r) => a + (r.aiDuplicates ?? 0), 0) : null,
      added: rows.some((r) => r.aiAdded !== null) ? rows.reduce((a, r) => a + (r.aiAdded ?? 0), 0) : null,
    },
    kinds: { fusion: rows.filter((r) => r.scanType === 'fusion').length, last: rows.filter((r) => r.scanType === 'last').length },
    models: Object.entries(rows.reduce((m, r) => (r.model ? { ...m, [r.model]: (m[r.model] ?? 0) + 1 } : m), {})).sort((a, b) => b[1] - a[1]),
    code: { loc: rows.some((r) => r.loc !== null) ? rows.reduce((a, r) => a + (r.loc ?? 0), 0) : null, files: rows.some((r) => r.files !== null) ? rows.reduce((a, r) => a + (r.files ?? 0), 0) : null },
    usage: { scans: sum('scans'), credits: sum('credits'), period: fusion?.usage?.period ?? null },
  };
}

/** "Last 30 days", for the period the AI scans and credits were read over. */
export const PERIOD_LABEL = { last_30_days: 'Last 30 days', last_90_days: 'Last 90 days', last_180_days: 'Last 180 days', last_year: 'Last year' };
/** Where a project's model was set, as Checkmarx One says for its latest scan. */
export const MODEL_FROM = { scan: 'set on this scan', project: 'project setting', tenant: 'tenant setting', environment: 'set by Checkmarx One' };

/** Which engine a scan type's projects show under: a Fusion scan's under Fusion, a LAST scan's under LAST. */
const ENGINE_OF = { fusion: 'FUSION', last: 'LAST' };

/**
 * One row per project whose latest scan ran the AI engine, shown when its scan type (or a result of it) is among
 * the engines shown, most critical first. With a filter, the counts are those of its matching risks, and only the
 * projects with one are shown.
 */
export function fusionRows(fusion, scope, engines, filter = null) {
  const shown = shownEngines(engines);
  const narrowed = filtering(filter);
  const byProject = new Map();
  if (narrowed) {
    for (const r of fusion?.results ?? []) {
      if (!inEngines(r, shown) || !matchesFilter(r, filter)) continue;
      if (!byProject.has(r.projectId)) byProject.set(r.projectId, []);
      byProject.get(r.projectId).push(r);
    }
  }
  return Object.entries(fusion?.projects ?? {})
    .map(([projectId, all]) => {
      const c = narrowed ? countsFromResults(byProject.get(projectId) ?? []) : countsFor(all, shown);
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
        ...Object.fromEntries(FUSION_STATES.map((k) => [k, c[k] ?? 0])),
        aiFound: all.aiReported ?? null,
        aiDuplicates: all.aiDuplicates ?? null,
        aiAdded: all.aiAdded ?? null,
        // How many of its listed risks the AI engine found, and how many AI Triage set the state of.
        aiResults: c.aiFound ?? 0,
        aiTriaged: c.aiTriaged ?? 0,
        fixedKnown: c.fixedKnown,
        scanType: all.scanType ?? 'fusion',
        scanAt: all.scanAt ?? null,
        scanId: all.scanId ?? '',
        url: all.url ?? '',
        model: all.model ?? '',
        modelFrom: all.modelFrom ?? '',
        loc: all.loc ?? null,
        files: all.files ?? null,
        engineVersion: all.engineVersion ?? '',
        fusionCreditsCharged: all.fusionCredits ?? '',
        scans: used?.scans ?? null,
        fusionScans: used?.fusionScans ?? null,
        lastScans: used?.lastScans ?? null,
        credits: used?.credits ?? null,
        fusionCredits: used?.fusion ?? null,
        actions: used?.actions ?? null,
        perScan: used?.perScan ?? null,
      };
    })
    .filter((r) => (narrowed ? r.total > 0 || r.FIXED > 0 : shown.includes(ENGINE_OF[r.scanType]) || r.total > 0 || r.FIXED > 0))
    .sort((a, b) => b.CRITICAL - a.CRITICAL || b.HIGH - a.HIGH || b.total - a.total || a.name.localeCompare(b.name));
}

/**
 * Every result of the engines shown (of one project, with `projectId`), as the Checkmarx One results page lists
 * them: most severe first, then the most recently found.
 */
export function fusionResultRows(fusion, scope, engines, projectId = null, filter = null) {
  return (fusion?.results ?? [])
    .filter((r) => inEngines(r, engines) && (!projectId || r.projectId === projectId) && matchesFilter(r, filter))
    .map((r) => ({
      id: r.resultId,
      hash: r.hash ?? '',
      severity: r.severity ?? 'INFO',
      scanner: r.scanner ?? '',
      fixed: r.status === 'FIXED',
      engine: r.engine ?? '',
      coveredAs: r.coveredAs ?? '',
      name: r.name || r.resultId,
      status: r.status ? wordsLabel(r.status) : '',
      state: r.state ? wordsLabel(r.state) : '',
      statusKey: r.status ?? '',
      stateKey: r.state || 'TO_VERIFY',
      ai: r.ai === true,
      aiTriaged: r.aiTriaged === true,
      language: r.language ?? '',
      cwe: r.cwe ?? null,
      source: r.sourceFile ? `${r.sourceFile}${r.sourceLine ? `:${r.sourceLine}` : ''}` : '',
      // Where Risk Hub says it is (a file and function, a package, an API…).
      location: r.location ?? '',
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
    // Open ones first, most severe first, then the most recently found; the fixed ones last.
    .sort((a, b) => a.fixed - b.fixed || (RANK[b.severity] ?? 0) - (RANK[a.severity] ?? 0) || String(b.firstFoundAt ?? '').localeCompare(String(a.firstFoundAt ?? '')) || a.name.localeCompare(b.name));
}

/** "SAST", "SCA", "IaC", "API Security"…: a scanner as Checkmarx One names it. */
export const SCANNER_LABEL = { SAST: 'SAST', SCA: 'SCA', KICS: 'IaC', IAC: 'IaC', CONTAINERS: 'Containers', APISEC: 'API Security', API_SECURITY: 'API Security', SECRETS: 'Secrets', SSCS: 'Secrets', MICROENGINES: 'Scorecard', '': '—' };
export const scannerLabel = (v) => SCANNER_LABEL[String(v ?? '').toUpperCase()] ?? String(v ?? '');

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
 * `opts`: { appName, organisation, generatedAt, fmtDate(iso), engines, projectId, filter, colours: { fusion, last } }.
 */
export function fusionReportHtml(fusion, scope, opts = {}) {
  const engines = shownEngines(opts.engines);
  const fmt = (n) => Number(n || 0).toLocaleString('en');
  const date = (iso) => (iso ? (opts.fmtDate ? opts.fmtDate(iso) : new Date(iso).toISOString().slice(0, 16).replace('T', ' ')) : '—');
  const filter = filtering(opts.filter) ? opts.filter : null;
  const projects = fusionRows(fusion, scope, engines, filter).filter((p) => !opts.projectId || p.projectId === opts.projectId);
  const results = fusionResultRows(fusion, scope, engines, opts.projectId ?? null, filter);
  // Fusion's and LAST's colours: the reader's own, else gold and pink.
  const colour = (v, fallback) => (/^#[0-9a-f]{6}$/i.test(String(v ?? '')) ? v : fallback);
  const fusionColour = colour(opts.colours?.fusion, '#b8860b');
  const lastColour = colour(opts.colours?.last, '#d6337a');
  const narrowed = filter ? [filter.status && wordsLabel(filter.status), filter.state && (STATE_LABEL[filter.state] ?? wordsLabel(filter.state)), filter.aiTriaged && 'AI-triaged only'].filter(Boolean).join(', ') : '';
  const one = opts.projectId ? projects[0] : null;
  const sum = (k) => projects.reduce((n, p) => n + p[k], 0);
  const usage = fusion?.usage ? { scans: sum('scans'), credits: fusion.usage.creditsKnown ? sum('credits') : null } : null;
  const t = { results: sum('total'), CRITICAL: sum('CRITICAL'), HIGH: sum('HIGH'), MEDIUM: sum('MEDIUM'), LOW: sum('LOW'), NEW: sum('NEW'), RECURRENT: sum('RECURRENT'), FIXED: sum('FIXED'), TO_VERIFY: sum('TO_VERIFY'), CONFIRMED: sum('CONFIRMED') };
  const kind = (p) => (p.scanType === 'last' || p.scanType === 'fusion' ? `<span class="tag ${p.scanType}">${esc(SCAN_TYPE_LABEL[p.scanType])}</span>` : '—');
  const added = (p) => (p.aiFound !== null ? `${fmt(p.aiFound)} → ${fmt(p.aiAdded)}` : fmt(p.aiResults));
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
  const meaning = [engines.includes('FUSION') ? '<b>Fusion</b>: what the Fusion scan reported in Risk Hub' : '', engines.includes('LAST') ? '<b>LAST</b> (language-agnostic static testing): what its AI engine found in a language only it covers' : ''].filter(Boolean).join('; ');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root { color-scheme: light dark; --ink: #14171c; --muted: #5c636e; --line: #e2e5e9; --soft: #f4f6fb; --bg: #fff; --fusion: ${fusionColour}; --last: ${lastColour}; }
@media (prefers-color-scheme: dark) { :root { --ink: #e8eaee; --muted: #a2a9b4; --line: #2c323b; --soft: #1b2028; --bg: #12161c; } }
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
tr.fusion td:first-child { box-shadow: inset 4px 0 0 var(--fusion); } tr.last td:first-child { box-shadow: inset 4px 0 0 var(--last); }
tr.fusion td { background: color-mix(in srgb, var(--fusion) 8%, transparent); } tr.last td { background: color-mix(in srgb, var(--last) 8%, transparent); }
a { color: #2563eb; } small { color: var(--muted); display: block; }
footer { margin-top: 40px; color: var(--muted); font-size: 12px; }
@media print { body { padding: 0; } a { color: inherit; } }
</style></head>
<body><main>
<h1>${esc(title)}</h1>
<p class="sub">The Risk Hub list of each project whose latest scan ran the AI engine (a Fusion or a LAST scan) · ${esc(scopeLine)}${narrowed ? ` · ${esc(narrowed)}` : ''} · read ${esc(date(fusion?.readAt))}</p>
<p class="sub">${meaning}.</p>
<div class="strip">
<div><b>${fmt(projects.length)}</b><span>Projects</span></div>${usage ? `<div><b>${fmt(usage.scans)}</b><span>AI scans · ${esc(PERIOD_LABEL[fusion.usage.period] ?? '')}</span></div><div><b>${usage.credits === null ? '—' : fmt(usage.credits)}</b><span>Credits spent</span></div>` : ''}<div><b>${fmt(t.results)}</b><span>${esc(label)} results</span></div><div><b>${fmt(t.CRITICAL)}</b><span>Critical</span></div><div><b>${fmt(t.HIGH)}</b><span>High</span></div><div><b>${fmt(t.MEDIUM)}</b><span>Medium</span></div><div><b>${fmt(t.LOW)}</b><span>Low</span></div><div><b>${fmt(t.NEW)}</b><span>New</span></div><div><b>${fmt(t.FIXED)}</b><span>Fixed</span></div><div><b>${fmt(t.TO_VERIFY)}</b><span>To verify</span></div><div><b>${fmt(t.CONFIRMED)}</b><span>Confirmed</span></div>
</div>
<h2>Projects</h2>
<table><thead><tr><th>Project</th><th>Scan</th><th>Model</th><th class="num">LOC</th><th class="num">AI found → added</th><th class="num">AI scans</th><th class="num">Credits</th><th class="num">Critical</th><th class="num">High</th><th class="num">Medium</th><th class="num">Low</th><th class="num">Total</th><th class="num">To verify</th><th class="num">Confirmed</th><th class="num">New</th><th class="num">Recurrent</th><th class="num">Fixed</th><th>Latest scan</th></tr></thead><tbody>
${projects.map((p) => `<tr class="${esc(p.scanType)}"><td>${link(p.url, p.name)}</td><td>${kind(p)}</td><td>${esc(p.model || '—')}${p.model && MODEL_FROM[p.modelFrom] ? `<small>${esc(MODEL_FROM[p.modelFrom])}</small>` : ''}</td><td class="num">${p.loc === null ? '—' : fmt(p.loc)}</td><td class="num">${added(p)}</td><td class="num">${p.scans === null ? '—' : fmt(p.scans)}</td><td class="num">${p.credits === null ? '—' : fmt(p.credits)}</td><td class="num">${fmt(p.CRITICAL)}</td><td class="num">${fmt(p.HIGH)}</td><td class="num">${fmt(p.MEDIUM)}</td><td class="num">${fmt(p.LOW)}</td><td class="num">${fmt(p.total)}</td><td class="num">${fmt(p.TO_VERIFY)}</td><td class="num">${fmt(p.CONFIRMED)}</td><td class="num">${fmt(p.NEW)}</td><td class="num">${fmt(p.RECURRENT)}</td><td class="num">${p.fixedKnown ? fmt(p.FIXED) : '—'}</td><td>${esc(date(p.scanAt))}</td></tr>`).join('\n') || `<tr><td colspan="18">No ${esc(label)} results.</td></tr>`}
</tbody></table>
<h2>Results</h2>
${projects.filter((p) => byProject.has(p.projectId)).map((p) => `<h3>${link(p.url, p.name)} <small>${fmt(byProject.get(p.projectId).length)} result(s)</small></h3>
<table><thead><tr><th>Severity</th><th>Scanner</th><th>Engine</th><th>Vulnerability</th><th>Status</th><th>State</th><th>Language</th><th>CWE</th><th>Where</th><th>First found</th><th>Last found</th></tr></thead><tbody>
${byProject.get(p.projectId).map((r) => `<tr><td>${sev(r.severity)}</td><td>${esc(scannerLabel(r.scanner))}</td><td>${tag(r.engine)}</td><td>${link(r.url, r.name)}<small>${esc(r.id)}</small></td><td>${esc(r.status || '—')}</td><td>${esc(r.state || '—')}${r.aiTriaged ? '<small>set by AI Triage</small>' : ''}</td><td>${esc(r.language || '—')}${r.coveredAs && r.coveredAs !== r.language ? `<small>SAST: ${esc(r.coveredAs)}</small>` : ''}</td><td>${r.cwe ? `CWE-${esc(r.cwe)}` : '—'}</td><td>${r.source ? `${esc(r.source)}${r.sourceNode ? ` <small>${esc(r.sourceNode)}</small>` : ''}${r.sink && r.sink !== r.source ? `→ ${esc(r.sink)}` : ''}${r.sinkNode ? ` <small>${esc(r.sinkNode)}</small>` : ''}` : esc(r.location || '—')}</td><td>${esc(date(r.firstFoundAt))}</td><td>${esc(date(r.foundAt))}</td></tr>`).join('\n')}
</tbody></table>`).join('\n') || `<p>No ${esc(label)} results.</p>`}
<footer>${esc(opts.appName || 'CxMissionZero')} · Labs → Fusion results · generated ${esc(date(opts.generatedAt ?? new Date().toISOString()))}. Each vulnerability opens the result in Checkmarx One; each project, its page there.</footer>
</main></body></html>
`;
}
