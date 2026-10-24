// What Labs → Status board and Labs → Consolidated view share: how long ago, the severity chips, the scan tag, the
// tenant chip, a project's bar, CSV and the standalone HTML report of what a table shows.
import { TENANT_HEX, tenantColour } from './tenant-colour.js';

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
export const num = (n) => (n === null || n === undefined || n === '' ? '—' : Number(n).toLocaleString());

/** "just now", "6 min ago", "2 h ago", "3 d ago" (numbers apart, so the words are translated once). */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso ?? '');
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** A scan's age on its bar: "6 h", "3 d". */
export function ageLabel(days) {
  if (days === null || days === undefined) return '';
  return days < 1 ? `${Math.max(1, Math.round(days * 24))} h` : `${Math.round(days)} d`;
}

export const SEVERITY_HEX = { critical: '#dc2626', high: '#ea580c', medium: '#d97706', low: '#2563eb' };
const SEV_KEYS = [['critical', 'C'], ['high', 'H'], ['medium', 'M'], ['low', 'L']];

/** "4 C 31 H 77 M 40 L": the chips Fusion results uses, only for severities with results. */
export function sevChips(sev) {
  const chips = SEV_KEYS.filter(([k]) => sev?.[k]).map(([k, letter]) => `<span class="fusion-sev fusion-sev-${k}" title="${esc(`${num(sev[k])} ${k}`)}">${num(sev[k])} ${letter}</span>`);
  return `<span class="fusion-sevs" translate="no">${chips.join('') || '<span class="hint">0</span>'}</span>`;
}

export const SCAN_TYPE = { fusion: 'Fusion', last: 'LAST', '': 'Standard' };
export const scanTag = (type) => `<span class="scan-tag scan-tag-${type === 'fusion' || type === 'last' ? type : 'none'}">${SCAN_TYPE[type] ?? 'Standard'}</span>`;
export const rowScanClass = (type) => (type === 'fusion' || type === 'last' ? `scan-row-${type}` : '');

/** A tenant's chip, in its own colour. */
export const tenantChip = (id, name, colour = tenantColour(id)) => `<span class="tenant-chip tc-${colour}" translate="no">${esc(name || id)}</span>`;

/**
 * A project's results bar, from the left: critical, high, medium, low, each segment as wide as its share of the
 * biggest project shown (`max`), its number inside when it fits; the total and critical + high at its end. Outlined in
 * Fusion's or LAST's colour when the latest scan was one.
 */
export function resultsBar(row, max) {
  const scale = max > 0 ? 86 / max : 0;
  const seg = (k) => {
    const v = row.sev[k];
    if (!v) return '';
    const share = (v / Math.max(1, max)) * 100;
    return `<i class="${k[0]}" style="flex:${v}" title="${esc(`${num(v)} ${k}`)}">${share >= 3.2 ? num(v) : ''}</i>`;
  };
  const outline = row.scanType === 'fusion' ? ' is-fusion' : row.scanType === 'last' ? ' is-last' : '';
  const width = row.total ? Math.max(1.2, row.total * scale).toFixed(1) : 0;
  const stack = row.total ? `<div class="sb-stack${outline}" style="width:${width}%">${seg('critical')}${seg('high')}${seg('medium')}${seg('low')}</div>` : '<div class="sb-stack sb-empty"></div>';
  return `<div class="sb-bar" translate="no">${stack}<span class="sb-total">${num(row.total)}<small>${num(row.ch)} C+H</small></span></div>`;
}

/** How long ago the last scan ran, as a bar (green, amber, red, striped when a newer scan failed), up to 60 days. */
export function healthBar(row) {
  if (row.health === 'never') return '<div class="sb-bar"><div class="sb-age never">Never scanned</div></div>';
  const days = row.ageDays ?? 0;
  if (row.failed) {
    const failedDays = (Date.now() - Date.parse(row.failed.at)) / 86_400_000;
    const width = Math.max(30, Math.min(100, (days / 60) * 100));
    return `<div class="sb-bar"><div class="sb-age failed" style="width:${width.toFixed(1)}%"><span>Failed</span>&nbsp;<span translate="no">${esc(ageLabel(failedDays))}</span>&nbsp;<span>ago</span></div></div>`;
  }
  const width = Math.max(6, Math.min(100, (days / 60) * 100));
  return `<div class="sb-bar"><div class="sb-age ${row.health}" style="width:${width.toFixed(1)}%" translate="no">${esc(ageLabel(days))}</div></div>`;
}

const ENGINE_LABEL = { sast: 'SAST', sca: 'SCA', kics: 'KICS', containers: 'Containers', apisec: 'API Security', 'api-security': 'API Security', microengines: 'Secrets', ai: 'AI' };
export const engineLabel = (e) => ENGINE_LABEL[e] ?? String(e).toUpperCase();
/** The four main engines (run, not run, failed), then any other the scan ran. */
export function engineChips(row) {
  const ran = new Set(row.engines ?? []);
  const failed = new Set(row.failed?.engines ?? []);
  const list = ['sast', 'sca', 'kics', 'containers', ...[...ran].filter((e) => !['sast', 'sca', 'kics', 'containers', 'ai'].includes(e))];
  return `<span class="sb-eng" translate="no">${list.map((e) => `<span class="${failed.has(e) ? 'bad' : ran.has(e) ? '' : 'off'}" title="${esc(failed.has(e) ? `${engineLabel(e)}: failed` : ran.has(e) ? `${engineLabel(e)}: ran` : `${engineLabel(e)}: not run`)}">${esc(engineLabel(e))}</span>`).join('')}</span>`;
}

const csvCell = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
export const csvText = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n');

export function save(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  Object.assign(document.createElement('a'), { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const stamp = () => new Date().toISOString().slice(0, 10);

/**
 * A standalone HTML report: a title, a line under it, the figures, then each table ({ title, head: [..], rows: [[html
 * cell], ..] }). Cells are HTML already escaped by the caller. Light and dark, printable.
 */
export function reportHtml({ title, sub, figures = [], tables = [], footer = '' }) {
  const fig = figures.map(([label, value]) => `<div><b>${esc(value)}</b><span>${esc(label)}</span></div>`).join('');
  const table = (t) => `${t.title ? `<h2>${esc(t.title)}</h2>` : ''}<table><thead><tr>${t.head.map((h) => `<th${h.num ? ' class="num"' : ''}>${esc(h.label ?? h)}</th>`).join('')}</tr></thead><tbody>${t.rows.map((r) => `<tr${r.cls ? ` class="${r.cls}"` : ''}>${r.cells.map((c, i) => `<td${t.head[i]?.num ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root { color-scheme: light dark; --ink: #14171c; --muted: #5c636e; --line: #e2e5e9; --soft: #f4f6fb; --bg: #fff; --fusion: #b8860b; --last: #d6337a; }
@media (prefers-color-scheme: dark) { :root { --ink: #e8eaee; --muted: #a2a9b4; --line: #2c323b; --soft: #1b2028; --bg: #12161c; } }
body { margin: 0; padding: 32px 24px 64px; background: var(--bg); color: var(--ink); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1200px; margin: 0 auto; }
h1 { margin: 0 0 4px; font-size: 26px; } h2 { margin: 28px 0 10px; font-size: 18px; }
.sub { color: var(--muted); margin: 0 0 4px; }
.strip { display: flex; flex-wrap: wrap; margin: 20px 0; border: 1px solid var(--line); border-radius: 12px; background: var(--soft); }
.strip div { flex: 1 1 120px; padding: 12px 14px; } .strip div + div { border-inline-start: 1px solid var(--line); }
.strip b { display: block; font-size: 22px; font-variant-numeric: tabular-nums; } .strip span { color: var(--muted); font-size: 12.5px; }
table { width: 100%; border-collapse: collapse; margin: 6px 0 12px; font-size: 13px; }
th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: middle; overflow-wrap: anywhere; }
th { color: var(--muted); font-weight: 600; font-size: 12px; } td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
.bar { display: flex; height: 16px; border-radius: 4px; overflow: hidden; min-width: 2px; }
.bar i { display: block; height: 100%; }
.tag { display: inline-block; padding: 0 7px; border-radius: 99px; font-size: 11px; font-weight: 600; border: 1px solid currentColor; color: var(--muted); }
.tag.fusion { color: var(--fusion); } .tag.last { color: var(--last); }
tr.fusion td:first-child { box-shadow: inset 4px 0 0 var(--fusion); } tr.last td:first-child { box-shadow: inset 4px 0 0 var(--last); }
tr.failed td:first-child { box-shadow: inset 4px 0 0 #dc2626; }
.tenant { display: inline-block; padding: 0 7px; border-radius: 6px; font-size: 12px; font-weight: 600; border: 1px solid currentColor; }
.bad { color: #dc2626; } small { color: var(--muted); display: block; }
footer { margin-top: 40px; color: var(--muted); font-size: 12px; }
@media print { body { padding: 0; } }
</style></head>
<body><main>
<h1>${esc(title)}</h1>
${sub ? `<p class="sub">${esc(sub)}</p>` : ''}
${fig ? `<div class="strip">${fig}</div>` : ''}
${tables.map(table).join('')}
<footer>${esc(footer || `Made with CxMissionZero on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.`)}</footer>
</main></body></html>`;
}

/** A results bar for the HTML report (fixed colours). */
export function reportBar(row, max) {
  const w = max ? Math.max(1, (row.total / max) * 100) : 0;
  return `<div class="bar" style="width:${w.toFixed(1)}%">${['critical', 'high', 'medium', 'low'].map((k) => (row.sev[k] ? `<i style="flex:${row.sev[k]};background:${SEVERITY_HEX[k]}"></i>` : '')).join('')}</div>`;
}

export const reportTenant = (id, name, colour = tenantColour(id)) => `<span class="tenant" style="color:${TENANT_HEX[colour] ?? TENANT_HEX[0]}">${esc(name || id)}</span>`;
export const reportScanTag = (type) => `<span class="tag ${type === 'fusion' || type === 'last' ? type : ''}">${SCAN_TYPE[type] ?? 'Standard'}</span>`;
