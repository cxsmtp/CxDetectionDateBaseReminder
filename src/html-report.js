/**
 * The interactive HTML report attached to reminder mails.
 *
 * It lists the top findings (worst severity first, then oldest) with their
 * current Checkmarx One state. Remediate opens the finding in Checkmarx One
 * Risk Hub. Triage runs Checkmarx One AI Triage from the report through this
 * server's relay, which uses the server's own connection and acts only on
 * findings carrying a signed grant (see report-grants.js).
 */

import { readFileSync } from 'node:fs';

import { AI_SCANNERS } from './cxone/ai-assist.js';

export const REPORT_TOP_N = 50;
/** Severities that get a "triage all" action covering every finding, not just the top ones. */
export const BULK_SEVERITIES = ['CRITICAL', 'HIGH'];

const CLIENT_SCRIPT = readFileSync(new URL('./report/report.client.js', import.meta.url), 'utf8');

const SEVERITY_RANK = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO', 'UNKNOWN'];
const rank = (severity) => {
  const index = SEVERITY_RANK.indexOf(String(severity).toUpperCase());
  return index === -1 ? SEVERITY_RANK.length : index;
};

const STATE_LABELS = {
  TO_VERIFY: 'To verify',
  CONFIRMED: 'Confirmed',
  URGENT: 'Urgent',
  NOT_EXPLOITABLE: 'Not exploitable',
  PROPOSED_NOT_EXPLOITABLE: 'Proposed not exploitable',
};

/**
 * The findings the report shows: worst severity first, then oldest.
 * Returned objects are copies carrying their project's id and name, so the
 * caller can enrich them (AI ids) without touching the report data.
 */
export function selectTopFindings(reportData, limit = REPORT_TOP_N) {
  const all = [];
  for (const project of reportData.projects ?? []) {
    for (const risk of project.risks ?? []) {
      all.push({
        ...risk,
        projectId: risk.projectId || project.projectId,
        projectName: risk.projectName || project.projectName,
      });
    }
  }
  all.sort((a, b) => rank(a.severity) - rank(b.severity) || (b.ageDays ?? -1) - (a.ageDays ?? -1));
  return all.slice(0, limit);
}

/**
 * @param {object} reportData  from buildReportData()
 * @param {object} options
 * @param {Array}  [options.findings]    top findings, already enriched by resolveAiIds()
 * @param {Array}  [options.bulkFindings] critical/high findings beyond the top ones, for "triage all"
 * @param {object} [options.connection]  {baseUrl, iamUrl, tenant} — never the API key
 * @param {string} [options.portalUrl]   Checkmarx One web UI host, if not the API host
 * @param {string} [options.relayUrl]    where the report reaches this server's relay
 * @param {(finding) => {exp, grant}} [options.sign]  signs a finding for the relay
 * @param {object} [options.branding]
 */
export function generateHtmlReport(reportData, options = {}) {
  const { connection = {}, branding = {} } = options;
  const findings = options.findings ?? selectTopFindings(reportData);
  const bulkFindings =
    options.bulkFindings ??
    selectTopFindings(reportData, Infinity)
      .slice(findings.length)
      .filter((f) => BULK_SEVERITIES.includes(f.severity));
  const projects = reportData.projects ?? [];
  const total = projects.reduce((sum, p) => sum + (p.risks?.length ?? 0), 0);
  const accent = /^#[0-9a-f]{3,8}$/i.test(branding.accentColor ?? '') ? branding.accentColor : '#5b4bdb';

  const counts = {};
  for (const project of projects) {
    for (const risk of project.risks ?? []) counts[risk.severity] = (counts[risk.severity] ?? 0) + 1;
  }

  const relayUrl = safeHttpUrl(options.relayUrl);
  const clientFindings = [...findings, ...bulkFindings].map((f, index) => {
    const client = {
      key: String(index),
      shown: index < findings.length,
      severity: String(f.severity || '').toUpperCase(),
      title: String(f.title ?? ''),
      projectId: String(f.projectId ?? ''),
      projectName: String(f.projectName ?? ''),
      riskId: String(f.riskId ?? f.id ?? ''),
      state: String(f.state || '').toUpperCase(),
      scanId: String(f.scanId || ''),
      scanner: String(f.scanner || '').toUpperCase(),
      alternateId: String(f.alternateId || ''),
      groupId: String(f.groupId || ''),
      url: safeHttpUrl(f.url),
      aiUnavailable: aiUnavailableReason(f),
    };
    return relayUrl && options.sign && !client.aiUnavailable ? { ...client, ...options.sign(client) } : client;
  });

  const payload = {
    config: {
      tenant: connection.tenant ?? '',
      iamUrl: connection.iamUrl ?? '',
      apiBaseUrl: connection.baseUrl ?? '',
      portalUrl: safeHttpUrl(options.portalUrl) || connection.baseUrl || '',
      relayUrl,
    },
    findings: clientFindings,
  };

  const title = projects.length === 1 ? `${projects[0].projectName} — vulnerability report` : 'Vulnerability report';
  const logoUrl = safeLogo(branding.logoUrl);
  const logo = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(branding.companyName || 'Logo')}" height="${Number(branding.logoHeight) || 32}">`
    : branding.companyName
      ? `<span class="brand-name">${escapeHtml(branding.companyName)}</span>`
      : '';


  const projectLinks = projects
    .map((p) => {
      const url = safeHttpUrl(p.url);
      return url
        ? `<a class="btn btn-outline" href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(p.projectName)} (${p.risks?.length ?? 0}) →</a>`
        : '';
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${styles(accent)}</style>
</head>
<body>
<header class="top">
  <div class="top-inner">
    <div>
      ${logo ? `<div class="brand">${logo}</div>` : ''}
      <h1>${escapeHtml(title)}</h1>
      <p class="meta">${total} open finding${total === 1 ? '' : 's'}${projects.length > 1 ? ` across ${projects.length} projects` : ''}
        · top ${findings.length} shown (worst severity, then oldest)
        · generated ${escapeHtml(reportData.generatedAt ?? '')} UTC${connection.tenant ? ` · tenant ${escapeHtml(connection.tenant)}` : ''}</p>
    </div>
    <button id="connect" class="btn btn-light" type="button"${relayUrl ? '' : ' disabled title="This report was generated without a reminder server address."'}>Connect to CxONE for action</button>
  </div>
  <div class="counts">
    ${['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
      .map((s) => `<span class="count"><b>${counts[s] ?? 0}</b> ${s.toLowerCase()}</span>`)
      .join('')}
  </div>
</header>

<main>
  <div id="banner" class="banner" hidden></div>

  <section class="actions">
    <div>
      ${BULK_SEVERITIES.map((severity) => {
        const label = severity.toLowerCase();
        const count = counts[severity] ?? 0;
        return `<button class="btn btn-primary bulk" type="button" data-severity="${severity}"${count ? '' : ' disabled'}>Triage all ${label} (${count})</button>`;
      }).join('\n      ')}
      <span id="bulk-credits" class="muted"></span>
      <span id="bulk-progress" class="muted"></span>
    </div>
    <p class="muted">Triage runs Checkmarx One AI Triage and shows the verdict here; “Triage all” covers every critical or
      high finding in this report, across all its projects. Remediate opens the finding in Checkmarx One Risk Hub.
      ${relayUrl ? `Triage goes through your reminder server (${escapeHtml(new URL(relayUrl).host)}), which must be reachable from this computer.` : ''}</p>
  </section>

  <div class="table-wrap">
    <table id="findings">
      <thead>
        <tr><th>Severity</th><th>Finding</th><th>Engine</th><th>Age</th><th title="Checkmarx One state — updates once connected">State</th><th title="AI Triage verdict, or the finding\'s Checkmarx One state once triaged">Triage result</th><th>Actions</th></tr>
      </thead>
      <tbody>
${findings.map((f, index) => findingRow(f, clientFindings[index])).join('\n')}
      </tbody>
    </table>
  </div>

  <section class="more">
    <p>${total > findings.length ? `Showing ${findings.length} of ${total} findings. See every finding in Checkmarx One:` : 'Open in Checkmarx One:'}</p>
    <div class="more-links">${projectLinks}</div>
  </section>

  <details id="activity" class="activity">
    <summary>Activity (<span id="activity-count">0</span>)</summary>
    <ul id="activity-list"></ul>
  </details>
</main>
<script type="application/json" id="report-data">${jsonForScript(payload)}</script>
<script>${CLIENT_SCRIPT.replace(/<\/script/gi, '<\\/script')}</script>
</body>
</html>`;
}

function aiUnavailableReason(finding) {
  if (finding.aiUnavailable) return finding.aiUnavailable;
  const scanner = String(finding.scanner || '').toUpperCase();
  if (!AI_SCANNERS.has(scanner)) {
    return `AI Triage and Remediation support SAST and SCA only (this is ${scanner || 'an unknown engine'}).`;
  }
  if (!finding.alternateId || !finding.groupId || !finding.scanId) {
    return 'Checkmarx One identifiers for this finding are not available.';
  }
  return '';
}

function findingRow(finding, client) {
  const severity = String(finding.severity || 'UNKNOWN').toUpperCase();
  const url = safeHttpUrl(finding.url);
  const title = url
    ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(finding.title)}</a>`
    : escapeHtml(finding.title);
  const location = finding.location && finding.location !== '—' ? escapeHtml(finding.location) : '';
  const state = String(finding.state || '').toUpperCase();
  const stateLabel = STATE_LABELS[state] ?? (state ? state.replace(/_/g, ' ').toLowerCase() : '—');
  const age = finding.ageDays === null || finding.ageDays === undefined ? '—' : `${finding.ageDays}d`;

  return `<tr data-key="${client.key}">
  <td><span class="sev sev-${escapeHtml(severity.toLowerCase())}">${escapeHtml(severity)}</span></td>
  <td class="finding"><div class="finding-title">${title}</div>
    <div class="sub">${escapeHtml(finding.projectName ?? '')}${location ? ` · ${location}` : ''}</div></td>
  <td>${escapeHtml(finding.scanner || '—')}</td>
  <td>${age}</td>
  <td class="state-cell">${escapeHtml(stateLabel)}</td>
  <td class="ai-cell">—</td>
  <td class="actions-cell">
    <button class="btn btn-small" type="button" data-action="triage"${client.aiUnavailable ? ` disabled title="${escapeHtml(client.aiUnavailable)}"` : ''}>Triage</button>
    ${url ? `<a class="btn btn-small btn-outline" data-action="remediate" href="${escapeHtml(url)}" target="_blank" rel="noopener">Remediate</a>` : ''}
  </td>
</tr>`;
}

function styles(accent) {
  return `
:root { --accent: ${accent}; --ink: #1f2330; --muted: #667085; --line: #e6e8ef; --bg: #f6f7fb; }
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; color: var(--ink); background: var(--bg); }
a { color: var(--accent); }
.top { background: linear-gradient(135deg, var(--accent), #7c3aed); color: #fff; padding: 20px 24px 14px; }
.top-inner { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; max-width: 1280px; margin: 0 auto; }
.brand { margin-bottom: 6px; }
.brand img { display: block; background: #fff; border-radius: 4px; padding: 2px 6px; }
.brand-name { font-weight: 600; opacity: .9; }
h1 { margin: 0; font-size: 22px; }
.meta { margin: 4px 0 0; opacity: .85; font-size: 13px; }
.counts { display: flex; gap: 8px; flex-wrap: wrap; max-width: 1280px; margin: 12px auto 0; }
.count { background: rgba(255,255,255,.16); border-radius: 999px; padding: 2px 12px; font-size: 13px; text-transform: capitalize; }
main { max-width: 1280px; margin: 0 auto; padding: 16px 24px 40px; }
.btn { font: inherit; font-weight: 600; border: 1px solid transparent; border-radius: 8px; padding: 8px 14px; cursor: pointer; background: var(--accent); color: #fff; text-decoration: none; display: inline-block; }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.btn-light { background: #fff; color: var(--accent); white-space: nowrap; }
.btn-light.connected { background: #12b76a; color: #fff; }
[hidden] { display: none !important; }
.btn-outline { background: #fff; color: var(--accent); border-color: var(--line); }
.btn-small { padding: 4px 10px; font-size: 12px; border-radius: 6px; }
.muted { color: var(--muted); font-size: 13px; margin-left: 8px; }
.actions { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px; margin-bottom: 12px; }
.actions p { margin: 8px 0 0; }
.actions .bulk + .bulk { margin-left: 8px; }
.banner { border-radius: 8px; padding: 10px 14px; margin-bottom: 12px; }
.banner-error { background: #fef3f2; color: #b42318; border: 1px solid #fecdca; }
.banner-warn { background: #fffaeb; color: #93370d; border: 1px solid #fedf89; }
.table-wrap { background: #fff; border: 1px solid var(--line); border-radius: 10px; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; color: var(--muted); background: #fafbfc; padding: 10px; border-bottom: 1px solid var(--line); }
td { padding: 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
.finding { min-width: 260px; }
.finding-title { font-weight: 600; }
.sub { color: var(--muted); font-size: 12px; word-break: break-word; }
.sev { display: inline-block; font-size: 11px; font-weight: 700; border-radius: 4px; padding: 2px 8px; color: #fff; background: #98a2b3; }
.sev-critical { background: #b42318; } .sev-high { background: #e04f16; } .sev-medium { background: #b54708; } .sev-low { background: #1570ef; }
.chip { display: inline-block; border-radius: 999px; padding: 1px 10px; font-size: 12px; font-weight: 600; }
.chip-bad { background: #fee4e2; color: #b42318; } .chip-good { background: #d1fadf; color: #067647; }
.chip-warn { background: #fef0c7; color: #93370d; } .chip-muted { background: #f2f4f7; color: #475467; } .chip-busy { background: #ebe9fe; color: #5925dc; }
.ai-cell details { font-size: 12px; } .ai-cell summary { cursor: pointer; color: var(--accent); }
.actions-cell { white-space: nowrap; } .actions-cell .btn + .btn { margin-left: 4px; }
.more { margin-top: 16px; } .more p { margin: 0 0 8px; }
.more-links { display: flex; gap: 8px; flex-wrap: wrap; }
.activity { margin-top: 16px; background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 8px 14px; }
.activity summary { cursor: pointer; font-weight: 600; }
.activity ul { list-style: none; padding: 0; margin: 8px 0 0; font-size: 13px; max-height: 260px; overflow: auto; }
.activity li { padding: 3px 0; border-top: 1px solid var(--line); } .activity time { color: var(--muted); margin-right: 6px; }
.log-error { color: #b42318; } .log-success { color: #067647; }
@media (max-width: 720px) { .top-inner { flex-direction: column; } main { padding: 12px; } }
`;
}

/** JSON for a <script type="application/json"> island: nothing in it can close the tag. */
function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function safeHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function safeLogo(url) {
  if (!url) return '';
  if (/^data:image\/(png|jpe?g|gif|webp);/i.test(url)) return url;
  return url.startsWith('https://') ? safeHttpUrl(url) : '';
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
