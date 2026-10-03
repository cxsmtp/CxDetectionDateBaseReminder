/**
 * The interactive HTML report attached to reminder mails.
 *
 * It lists the top findings (worst severity first, then oldest) with their
 * current Checkmarx One state. Triage and Remediate run Checkmarx One AI
 * Triage and AI Remediation through this server's relay, which uses the
 * server's own connection and acts only on findings carrying a signed grant
 * (see report-grants.js). When the administrator has not allowed remediation,
 * Remediate opens the finding in Checkmarx One Risk Hub instead.
 */

import { readFileSync } from 'node:fs';

import { AI_SCANNERS } from './cxone/ai-assist.js';
import { fixAdvice } from './fix-advice.js';
import { SUPPORTING_NOTICE } from './terms.js';

/** One Checkmarx One result: rows with the same key are triaged together, and charged once. */
export const resultKey = (f) =>
  f.alternateId ? `${f.projectId}|a:${f.alternateId}` : f.groupId ? `${f.projectId}|g:${f.groupId}` : `${f.projectId}|r:${f.riskId}`;

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
 * @param {boolean} [options.remediationViaRelay]  Remediate runs AI Remediation through the relay
 * @param {(finding) => {exp, grant}} [options.sign]  signs a finding for the relay
 * @param {object} [options.branding]
 * @param {boolean} [options.allowRetriage]  findings with a verdict may be triaged again
 * @param {boolean} [options.allowReremediation]  remediated findings may be remediated again
 * @param {string} [options.adminContact]  who readers ask for more credits
 * @param {(projectId) => {exp, sig}} [options.signProjectReport]  signs "one project's report"
 *   links: the report asks this server for that project's own report (never Checkmarx One)
 * @param {object} [options.projectReportScope]  the scope those reports keep ({buckets, severities, detection})
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

  const ages = findings.map((f) => f.ageDays).filter((d) => Number.isFinite(d));
  const oldest = ages.length ? Math.max(...ages) : null;
  const counts = {};
  for (const project of projects) {
    for (const risk of project.risks ?? []) counts[risk.severity] = (counts[risk.severity] ?? 0) + 1;
  }

  const relayUrl = safeHttpUrl(options.relayUrl);
  // Each project's own report, made by this server on request (signed, so a
  // report can only ask for the projects and scope it was made with).
  const projectReports = options.signProjectReport && projects.length > 1
    ? projects
        .filter((p) => (p.risks?.length ?? 0) > 0)
        .map((p) => ({
          projectId: String(p.projectId),
          projectName: String(p.projectName ?? ''),
          count: p.risks.length,
          scope: options.projectReportScope ?? {},
          ...options.signProjectReport(String(p.projectId)),
        }))
    : [];
  // Signed and relay-ready even without an address: a reader can enter the
  // reminder server's address in the report and still triage.
  const remediateHere = Boolean(options.remediationViaRelay);
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
      ...(index < findings.length ? { advice: fixAdvice(f) } : {}),
    };
    return options.sign && !client.aiUnavailable ? { ...client, ...options.sign(client) } : client;
  });

  // Rows that are one Checkmarx One result: the risks API can list a result once
  // per code path, but AI Triage acts on (and charges) the result, once. Each
  // such result gets a label (R1, R2, …) and a colour, so its rows can be told
  // apart from another shared result's, and each row links to its twins.
  const shownAi = clientFindings.filter((c) => c.shown && !c.aiUnavailable);
  const rowsOf = new Map();
  for (const c of shownAi) {
    const k = resultKey(c);
    if (!rowsOf.has(k)) rowsOf.set(k, []);
    rowsOf.get(k).push(c);
  }
  const resultsShown = rowsOf.size;
  const labels = new Map();
  for (const [k, rows] of rowsOf) if (rows.length > 1) labels.set(k, labels.size);
  const sharedOf = (c) => {
    if (!c.shown || c.aiUnavailable || !labels.has(resultKey(c))) return null;
    const n = labels.get(resultKey(c));
    const rows = rowsOf.get(resultKey(c));
    const at = (r) => Number(r.key);
    return {
      label: `R${n + 1}`,
      color: n % SHARED_COLOURS,
      id: c.alternateId || c.groupId || c.riskId,
      idKind: c.alternateId ? 'result ID' : c.groupId ? 'group ID' : 'risk ID',
      locations: rows.map((r) => findings[at(r)]?.location ?? ''),
      location: findings[at(c)]?.location ?? '',
      twins: rows.filter((r) => r !== c).map((r) => ({ key: r.key, title: findings[at(r)]?.title ?? '', location: findings[at(r)]?.location ?? '', below: at(r) > at(c) })),
    };
  };

  const payload = {
    config: {
      tenant: connection.tenant ?? '',
      iamUrl: connection.iamUrl ?? '',
      apiBaseUrl: connection.baseUrl ?? '',
      portalUrl: safeHttpUrl(options.portalUrl) || connection.baseUrl || '',
      relayUrl,
      allowRetriage: options.allowRetriage === true,
      ...(options.reportToken ? { report: options.reportToken } : {}),
      allowReremediation: options.allowReremediation === true,
      remediateHere,
      adminContact: /^(?=[^]{3,254}$)[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(options.adminContact ?? '') ? options.adminContact : '',
    },
    findings: clientFindings,
    projectReports,
  };

  const title = projects.length === 1 ? `${projects[0].projectName} — vulnerability report` : 'Vulnerability report';
  const logoUrl = safeLogo(branding.logoUrl);
  const logo = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(branding.companyName || 'Logo')}" height="${Number(branding.logoHeight) || 32}">`
    : branding.companyName
      ? `<span class="brand-name">${escapeHtml(branding.companyName)}</span>`
      : '';


  // One project's full report: built by the reminder server and opened in a new tab.
  // There is no link to Checkmarx One here.
  const projectLinks = projectReports
    .map(
      (p, i) =>
        `<button type="button" class="btn btn-outline" data-project-report="${i}" title="Builds this project's own report and opens it in a new tab (also downloaded)">${escapeHtml(p.projectName)} (${p.count}) →</button>`,
    )
    .join('');
  const singleProject = projects.length === 1;
  const moreText = total > findings.length
    ? singleProject
      ? `Showing ${findings.length} of ${total} findings: the worst and oldest first.`
      : `Showing ${findings.length} of ${total} findings. Open one project's own report (built by the reminder server, opens in a new tab):`
    : projectReports.length
      ? `Open one project's own report (built by the reminder server, opens in a new tab):`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
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
    <button id="connect" class="btn btn-light" type="button">Connect to CxONE for action</button>
  </div>
  <div class="counts summary">
    <span class="count count-total"><b>${total}</b> open</span>
    ${['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
      .map((s) => `<span class="count count-${s.toLowerCase()}"><i aria-hidden="true"></i><b>${counts[s] ?? 0}</b> ${s.toLowerCase()}</span>`)
      .join('')}
    ${oldest !== null ? `<span class="count count-age"><b>${oldest}d</b> oldest</span>` : ''}
  </div>
  <ol class="lifecycle" aria-label="Detect, eliminate, govern">
    <li class="lc-detect"><b>Detect</b> Found by Checkmarx One</li>
    <li class="lc-eliminate"><b>Eliminate</b> Triage and remediate here</li>
    <li class="lc-govern"><b>Govern</b> Every credit is audited</li>
  </ol>
</header>

<main>
  <div id="banner" class="banner" hidden></div>

  <section class="server" id="server" aria-label="Reminder server">
    <div class="server-row">
      <span class="server-label">Reminder server</span>
      <code id="server-url" class="server-url">${relayUrl ? escapeHtml(relayUrl.replace(/\/+$/, '')) : 'not set'}</code>
      <span id="server-state" class="server-state"></span>
      <button id="server-change" class="btn btn-outline btn-small" type="button">${relayUrl ? 'Change' : 'Enter address'}</button>
    </div>
    <div id="server-prompt" class="server-prompt" hidden role="status">
      <p id="server-prompt-text"></p>
      <div class="server-form-row">
        <button id="server-connect" class="btn" type="button">Connect</button>
        <button id="server-fix" class="btn btn-outline" type="button">Change address</button>
      </div>
    </div>
    <form id="server-form" class="server-form" hidden>
      <label for="server-input" class="muted">Address of your reminder server — ask whoever sent this report if you do not know it.</label>
      <div class="server-form-row">
        <input id="server-input" type="text" inputmode="url" autocomplete="url" spellcheck="false" placeholder="https://cx-reminder.example.com" required />
        <button class="btn" type="submit">Check &amp; connect</button>
        <button id="server-reset" class="btn btn-outline" type="button"${relayUrl ? '' : ' hidden'}>Use the report's address</button>
        <button id="server-cancel" class="btn btn-outline" type="button">Cancel</button>
      </div>
      <p id="server-error" class="server-error" hidden></p>
    </form>
  </section>

  <section class="actions">
    <div class="bulk-row">
      ${BULK_SEVERITIES.map((severity) => {
        const label = severity.toLowerCase();
        const count = counts[severity] ?? 0;
        return `<button class="btn btn-primary bulk" type="button" data-severity="${severity}"${count ? '' : ' disabled'}>Triage all ${label} (${count})</button>`;
      }).join('\n      ')}
      <span id="bulk-progress" class="muted"></span>
      <span class="refresh-box"><span id="last-refresh" class="muted"></span> <button id="refresh-now" class="btn btn-outline btn-small" type="button">Refresh</button></span>
    </div>
    <div id="credit-balance" class="credit-balance" hidden>
      <div class="credit-balance-head"><strong>Your credits</strong> <span id="bulk-credits" class="muted"></span></div>
      <div id="credit-projects" class="credit-projects"></div>
    </div>
    <details class="how">
    <summary>How this report works</summary>
    <p class="muted">Triage runs Checkmarx One AI Triage and shows the verdict here; “Triage all” covers every critical or
      high finding in this report, across all its projects. ${remediateHere
        ? 'Remediate runs Checkmarx One AI Remediation and links to the suggested fix (or its pull request).'
        : 'Remediate opens the finding in Checkmarx One Risk Hub.'}
      ${remediateHere ? 'Triage and Remediate go' : 'Triage goes'} through the reminder server shown above, which must be reachable from this computer (company network or VPN).</p>
    </details>
    ${resultsShown < shownAi.length
      ? `<p class="shared-explainer"><strong>${shownAi.length} findings here are ${resultsShown} Checkmarx One results.</strong> Checkmarx One can list one result once per code path that reaches it; AI Triage works on the result, so those rows are triaged together and charged once. Rows that are the same result carry the same label and colour (${[...labels.values()].slice(0, 3).map((n) => `<span class="shared-chip shared-c${n % SHARED_COLOURS}">R${n + 1}</span>`).join(' ')}${labels.size > 3 ? ' …' : ''}), and each one links to the other rows of its result.</p>`
      : ''}
  </section>

  <div class="toolbar" id="report-filters" role="search" aria-label="Filter findings">
    <div class="seg" role="group" aria-label="Severity">
      <button type="button" class="seg-btn on" data-filter-sev="" aria-pressed="true">All <em>${findings.length}</em></button>
      ${['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
        .map((sev) => [sev, findings.filter((f) => String(f.severity || '').toUpperCase() === sev).length])
        .filter(([, n]) => n > 0)
        .map(([sev, n]) => `<button type="button" class="seg-btn" data-filter-sev="${sev}" aria-pressed="false"><i class="dot dot-${sev.toLowerCase()}" aria-hidden="true"></i>${sev[0]}${sev.slice(1).toLowerCase()} <em>${n}</em></button>`)
        .join('\n      ')}
    </div>
    <input type="search" id="report-search" placeholder="Search findings, projects, files" aria-label="Search findings" />
    <label class="check"><input type="checkbox" id="report-actionable" /> Only what AI can act on</label>
    <span id="filter-count" class="muted" role="status"></span>
  </div>

  <div class="table-wrap">
    <table id="findings">
      <thead>
        <tr><th>Severity</th><th>Finding</th><th>Engine</th><th>Age</th><th title="Checkmarx One state — updates once connected">State</th><th title="AI Triage verdict, or the finding\'s Checkmarx One state once triaged">Triage result</th><th>Actions</th></tr>
      </thead>
      <tbody>
${findings.map((f, index) => findingRow(f, clientFindings[index], remediateHere, sharedOf(clientFindings[index]))).join('\n')}
      </tbody>
    </table>
  </div>

  ${moreText
    ? `<section class="more">
    <p>${moreText}</p>
    ${projectLinks ? `<div class="more-links">${projectLinks}</div>` : ''}
    <p id="project-report-status" class="muted" role="status" hidden></p>
  </section>`
    : ''}

  <p id="hidden-note" class="muted hidden-note" hidden></p>

  <details id="activity" class="activity">
    <summary>Activity (<span id="activity-count">0</span>)</summary>
    <ul id="activity-list"></ul>
  </details>
  <p class="muted disclaimer">${escapeHtml(SUPPORTING_NOTICE)} Triaging or remediating from this report means accepting those terms.</p>
</main>
<dialog id="credit-dialog" class="dialog" aria-labelledby="credit-dialog-title">
  <form method="dialog">
    <h2 id="credit-dialog-title">No credits left</h2>
    <p id="credit-dialog-text"></p>
    <p class="dialog-hint">Your administrator allocates Checkmarx One credits for AI Triage and AI Remediation from reports. Send them a request and try again once they have added credits.</p>
    <p id="credit-dialog-to" class="dialog-hint"></p>
    <div class="dialog-actions">
      <button class="btn btn-outline" value="close" type="submit">Close</button>
      <a id="credit-dialog-mail" class="btn btn-primary" href="#">Ask the administrator</a>
    </div>
  </form>
</dialog>
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

/** AI Remediation only ever runs on a confirmed finding — never one proposed not exploitable. */
const NOT_CONFIRMED_TITLE = 'Remediate works once triage has confirmed this finding (state Confirmed).';

function findingRow(finding, client, remediateHere, shared = null) {
  const severity = String(finding.severity || 'UNKNOWN').toUpperCase();
  const url = safeHttpUrl(finding.url);
  const title = url
    ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(finding.title)}</a>`
    : escapeHtml(finding.title);
  const location = finding.location && finding.location !== '—' ? escapeHtml(finding.location) : '';
  const state = String(finding.state || '').toUpperCase();
  const stateLabel = STATE_LABELS[state] ?? (state ? state.replace(/_/g, ' ').toLowerCase() : '—');
  const age = finding.ageDays === null || finding.ageDays === undefined ? '—' : `${finding.ageDays}d`;

  return `<tr data-key="${client.key}" id="row-${client.key}" data-sev="${escapeHtml(severity)}"${shared ? ` class="shared-row shared-c${shared.color}" data-result="${shared.label}"` : ''}>
  <td class="sev-cell"><span class="sev sev-${escapeHtml(severity.toLowerCase())}">${escapeHtml(severity)}</span></td>
  <td class="finding"><div class="finding-title">${title}</div>
    <div class="sub">${escapeHtml(finding.projectName ?? '')}${location ? ` · ${location}` : ''}</div>${shared ? `\n    ${sharedNoteHtml(shared)}` : ''}</td>
  <td class="meta-cell" data-label="Engine">${escapeHtml(finding.scanner || '—')}</td>
  <td class="meta-cell" data-label="Age">${age}</td>
  <td class="state-cell" data-label="State"><span class="state-label">${escapeHtml(stateLabel)}</span><div class="state-why">${CONFIRMED_STATES.has(state) && !client.aiUnavailable ? confirmedWhyHtml(client.advice ?? fixAdvice(finding), { ...aiFromRisk(finding), scanner: finding.scanner, url, remediateHere }) : ''}</div></td>
  <td class="ai-cell" data-label="Triage result">${client.aiUnavailable ? manualCell(finding, client.aiUnavailable) : '—'}</td>
  <td class="actions-cell">
    ${client.aiUnavailable
      ? url
        ? `<a class="btn btn-small btn-outline" data-action="remediate-link" href="${escapeHtml(url)}" target="_blank" rel="noopener" title="AI Triage and Remediation are not available for this finding: fix it in Checkmarx One">Fix in Checkmarx One</a>`
        : ''
      : `<button class="btn btn-small" type="button" data-action="triage">Triage</button>
    ${remediateHere
      ? state === 'CONFIRMED'
        ? '<button class="btn btn-small btn-outline" type="button" data-action="remediate">Remediate</button>'
        : `<button class="btn btn-small btn-outline" type="button" data-action="remediate" disabled title="${escapeHtml(NOT_CONFIRMED_TITLE)}">Remediate</button>`
      : url
        ? `<a class="btn btn-small btn-outline" data-action="remediate-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">Remediate</a>`
        : ''}`}
    <div class="fix-cell"></div>
  </td>
</tr>`;
}

const SHARED_COLOURS = 6;
const CONFIRMED_STATES = new Set(['CONFIRMED', 'URGENT']);
const shortId = (id) => (String(id).length > 10 ? `${String(id).slice(0, 8)}…` : String(id));
const where = (location) => String(location ?? '').trim() || 'the same place';
/** "…/app/routes/session.js :: render" → "session.js :: render". */
const shortPlace = (location) => String(location ?? '').replace(/^.*[\\/]/, '');

/**
 * "Same result R1 — also <the other row>", and a "why?" saying why the rows
 * are one result: Checkmarx One gave them one result ID, one per code path.
 */
function sharedNoteHtml(shared) {
  const here = shared.location;
  const twins = shared.twins
    .map((t) => `<a class="shared-link" href="#row-${t.key}" data-twin="${t.key}">${t.below ? 'below ↓' : 'above ↑'}</a>${t.location && t.location !== here ? ` (${escapeHtml(shortPlace(t.location))})` : ''}`)
    .join(', ');
  const rows = shared.twins.length + 1;
  const places = [...new Set(shared.locations.map(where))];
  const paths = places.length === 1
    ? `Here every path ends at ${escapeHtml(places[0])}; the rows differ in the route the data takes to get there.`
    : `Here the paths are reported at ${places.map(escapeHtml).join(' and ')}: different routes into the same vulnerable code.`;
  return `<div class="shared-note"><span class="shared-chip shared-c${shared.color}">Same result ${shared.label}</span> also listed ${twins} · triaged together, 1 credit.
      <details class="why-more"><summary>why?</summary><p>Checkmarx One gave these ${rows} rows the same ${shared.idKind} (<code>${escapeHtml(shortId(shared.id))}</code>), so they are one result (${shared.label}). It lists a result once for each code path it found from the input to the vulnerable code. ${paths} AI Triage judges the result, so it is triaged once, charged 1 credit, and its verdict applies to all ${rows} rows; fixing it clears them all.</p></details></div>`;
}

/** AI Triage fields the risks API carried (the ai-insights source), for the first rendering. */
function aiFromRisk(finding) {
  return { reachability: finding.aiReachability ?? '', exploitability: finding.aiExploitability ?? '' };
}

/** The first sentence, cut at a word (or clause) boundary to fit `max`; the full text is under "why?". */
const firstSentence = (text, max = 120) => {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  const sentence = /^.+?[.!?](?=\s|$)/.exec(clean)?.[0] ?? clean;
  if (sentence.length <= max) return sentence;
  const cut = sentence.slice(0, max);
  const at = Math.max(cut.lastIndexOf(', '), cut.lastIndexOf('; '));
  return `${(at > max / 2 ? cut.slice(0, at) : cut.slice(0, cut.lastIndexOf(' '))).replace(/[,;:]$/, '')}…`;
};

/**
 * Under "Confirmed": why it is a real vulnerability and how to fix it, once,
 * in two short lines. "why?" adds only what those lines do not say: how
 * Checkmarx One knows, AI Triage's verdict and full explanation, and the next
 * step. AI Triage's own words come first when there are any; otherwise what
 * this kind of finding means (fix-advice.js). The report's script renders the
 * same thing when it learns more (report.client.js).
 */
export function howKnown(scanner) {
  const engine = String(scanner || '').toUpperCase();
  if (engine === 'SCA') return 'This project uses a version of the package with a published vulnerability that its code can reach; a fixed version removes it.';
  if (engine === 'SAST') return 'Checkmarx One followed the data from where it enters the application to this code, and nothing on the way makes it safe.';
  return 'Checkmarx One matched this code or configuration against a known vulnerable pattern.';
}

function confirmedWhyHtml(advice, { reason = '', recommendation = '', reachability = '', exploitability = '', confidence = '', scanner = '', url = '', remediateHere = false } = {}) {
  const verdict = [reachability, exploitability].filter(Boolean).map((v) => v.replace(/_/g, ' ').toLowerCase()).join(' and ');
  const whyFull = reason || advice.what;
  const fixFull = recommendation || advice.fix;
  const why = firstSentence(whyFull, 160);
  const fix = firstSentence(fixFull, 160);
  const more = [
    why !== whyFull ? whyFull : howKnown(scanner),
    verdict && `AI Triage judged it ${verdict}${confidence ? ` (confidence ${confidence})` : ''}.`,
    reason && advice.what !== reason ? `This kind of finding: ${advice.what}` : '',
    fix !== fixFull ? `Fix in full: ${fixFull}` : '',
  ].filter(Boolean);
  return `<p class="why-line"><b>Why:</b> ${escapeHtml(why)}</p><p class="why-line"><b>Fix:</b> ${escapeHtml(fix)}</p>
      <details class="why-more"><summary>why?</summary>
        ${more.map((text) => `<p>${escapeHtml(text)}</p>`).join('')}
        <p>${remediateHere ? 'Remediate asks Checkmarx One AI Remediation for the code change (a pull request when the project is connected to its repository).' : 'Checkmarx One shows the full data flow.'}${url ? ` <a href="${escapeHtml(url)}" target="_blank" rel="noopener">Open in Checkmarx One</a>` : ''}</p>
      </details>`;
}

/** Why AI cannot act on this finding, in a few words, with the full reason on hover. */
function manualCell(finding, reason) {
  const engine = String(finding.scanner || '').toUpperCase();
  const short = engine && !['SAST', 'SCA'].includes(engine) ? `No AI for ${['KICS', 'IAC'].includes(engine) ? 'IaC' : engine} findings` : 'AI not available';
  return `<span class="chip chip-muted" title="${escapeHtml(reason)}">Manual fix</span><div class="sub">${escapeHtml(short)} — fix it in Checkmarx One</div>`;
}

function styles(accent) {
  return `
:root {
  --accent: ${accent}; --ink: #1f2330; --muted: #667085; --line: #e6e8ef; --bg: #f6f7fb;
  --surface: #fff; --surface-2: #fafbfc; --focus: ${accent}55; --link: ${accent}; --outline-line: var(--line);
  --bad-bg: #fee4e2; --bad: #b42318; --good-bg: #d1fadf; --good: #067647;
  --warn-bg: #fef0c7; --warn: #93370d; --muted-bg: #f2f4f7; --muted-ink: #475467; --busy-bg: #ebe9fe; --busy: #5925dc;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --link: #a4bcfd; --outline-line: #3b4557;
    --ink: #e6e8ef; --muted: #98a2b3; --line: #2a3140; --bg: #0f131a; --surface: #161b24; --surface-2: #1b212c;
    --bad-bg: #55160c; --bad: #fda29b; --good-bg: #053321; --good: #75e0a7;
    --warn-bg: #4e1d09; --warn: #fec84b; --muted-bg: #222936; --muted-ink: #cfd4dc; --busy-bg: #27115f; --busy: #bdb4fe;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; color: var(--ink); background: var(--bg); }
a { color: var(--link); }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.top { background: linear-gradient(135deg, var(--accent), #7c3aed); color: #fff;
  padding: 20px max(24px, env(safe-area-inset-right)) 14px max(24px, env(safe-area-inset-left)); }
.top a { color: #fff; }
.top-inner { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; max-width: 1280px; margin: 0 auto; }
.top-inner > div { min-width: 0; }
.brand { margin-bottom: 6px; }
.brand img { display: block; max-width: 180px; height: auto; max-height: 40px; background: #fff; border-radius: 4px; padding: 2px 6px; }
.brand-name { font-weight: 600; opacity: .9; }
h1 { margin: 0; font-size: clamp(18px, 2.4vw, 24px); line-height: 1.25; overflow-wrap: anywhere; }
.meta { margin: 4px 0 0; opacity: .85; font-size: 13px; }
.counts { display: flex; gap: 8px; flex-wrap: wrap; max-width: 1280px; margin: 12px auto 0; }
.count { background: rgba(255,255,255,.16); border-radius: 999px; padding: 2px 12px; font-size: 13px; text-transform: capitalize; }
main { max-width: 1280px; margin: 0 auto; padding: 16px max(24px, env(safe-area-inset-right)) 40px max(24px, env(safe-area-inset-left)); }
.btn { font: inherit; font-weight: 600; border: 1px solid transparent; border-radius: 8px; padding: 8px 14px; cursor: pointer;
  background: var(--accent); color: #fff; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  line-height: 1.3; touch-action: manipulation; }
.btn:disabled { opacity: .45; cursor: not-allowed; }
.btn-light { background: #fff; color: var(--accent); white-space: nowrap; }
.btn-light.connected { background: #12b76a; color: #fff; }
[hidden] { display: none !important; }
.btn-outline { background: var(--surface); color: var(--link); border-color: var(--outline-line); }
.btn-small { padding: 4px 10px; font-size: 12px; border-radius: 6px; }
.muted { color: var(--muted); font-size: 13px; }
.actions { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 12px 16px; margin-bottom: 12px; }
.bulk-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
.actions p { margin: 8px 0 0; }
.server { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 10px 16px; margin-bottom: 12px; }
.server-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.server-label { font-weight: 600; }
.server-url { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--muted-bg); color: var(--muted-ink);
  padding: 2px 8px; border-radius: 6px; overflow-wrap: anywhere; user-select: all; }
.server-state { font-size: 12px; font-weight: 600; }
.server-state.good { color: var(--good); }
.server-state.bad { color: var(--bad); }
.server-state.warn { color: var(--warn); }
.server-form { margin-top: 10px; display: grid; gap: 6px; }
.refresh-box { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; }
.server-prompt { margin-top: 10px; padding: 10px 12px; border-radius: 8px; background: var(--warn-bg); color: var(--warn); display: grid; gap: 8px; }
.server-prompt p { margin: 0; overflow-wrap: anywhere; }
.server-form-row { display: flex; flex-wrap: wrap; gap: 8px; }
.server-form input { flex: 1 1 260px; min-width: 0; font: inherit; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--outline-line);
  background: var(--surface-2); color: var(--ink); }
.server-error { margin: 0; color: var(--bad); font-size: 13px; overflow-wrap: anywhere; }
.banner { border-radius: 8px; padding: 10px 14px; margin-bottom: 12px; overflow-wrap: anywhere; }
.banner-error { background: var(--bad-bg); color: var(--bad); border: 1px solid transparent; }
.banner-warn { background: var(--warn-bg); color: var(--warn); border: 1px solid transparent; }
.table-wrap { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; color: var(--muted); background: var(--surface-2);
  padding: 10px; border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 1; }
td { padding: 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
.finding { min-width: 240px; }
.finding-title { font-weight: 600; overflow-wrap: anywhere; }
.sub { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.shared-note { margin-top: 4px; font-size: 12px; color: var(--muted); }
.shared-chip { display: inline-block; margin-right: 6px; padding: 1px 7px; border-radius: 999px; background: var(--busy-bg); color: var(--busy); font-size: 11px; font-weight: 700; white-space: nowrap; }
.shared-c0 { --twin: #6941c6; } .shared-c1 { --twin: #0e7090; } .shared-c2 { --twin: #b54708; } .shared-c3 { --twin: #c11574; } .shared-c4 { --twin: #3e7d1e; } .shared-c5 { --twin: #155eef; }
.shared-chip[class*="shared-c"] { background: var(--twin); color: #fff; }
tr.shared-row > td:first-child { box-shadow: inset 4px 0 0 var(--twin); }
tr.shared-row.twin-hi > td, tr.shared-row:target > td { background: color-mix(in srgb, var(--twin) 14%, transparent); }
.shared-link { color: var(--link); }
.why-more { font-size: 12px; margin-top: 2px; } .why-more summary { cursor: pointer; color: var(--link); display: inline; text-decoration: underline; }
.why-more summary::-webkit-details-marker { display: none; } .why-more summary { list-style: none; }
.why-more p { margin: 6px 0 0; color: var(--muted); } .why-more code { font-size: 11px; }
.state-why { margin-top: 4px; max-width: 300px; } td.state-cell:has(.why-line) { min-width: 220px; } .state-why:empty { display: none; }
.why-line { margin: 2px 0 0; font-size: 12px; color: var(--muted); line-height: 1.35; } .why-line b { color: var(--ink); }
.shared-explainer { margin: 10px 0 0; padding: 10px 12px; border-radius: 10px; background: var(--busy-bg); color: var(--busy); font-size: 13px; }
.sev { display: inline-block; font-size: 11px; font-weight: 700; border-radius: 4px; padding: 2px 8px; color: #fff; background: #98a2b3; white-space: nowrap; }
.sev-critical { background: #b42318; } .sev-high { background: #e04f16; } .sev-medium { background: #b54708; } .sev-low { background: #1570ef; }
.chip { display: inline-block; border-radius: 999px; padding: 1px 10px; font-size: 12px; font-weight: 600; }
.chip-bad { background: var(--bad-bg); color: var(--bad); } .chip-good { background: var(--good-bg); color: var(--good); }
.chip-warn { background: var(--warn-bg); color: var(--warn); } .chip-muted { background: var(--muted-bg); color: var(--muted-ink); } .chip-busy { background: var(--busy-bg); color: var(--busy); }
.ai-cell details { font-size: 12px; } .ai-cell summary { cursor: pointer; color: var(--link); }
.actions-cell { white-space: nowrap; }
.actions-cell .btn + .btn { margin-left: 4px; }
.fix-cell { white-space: normal; font-size: 12px; max-width: 300px; overflow-wrap: anywhere; }
.fix-cell:not(:empty) { margin-top: 6px; }
.fix-cell a { display: block; } .fix-cell p { margin: 0 0 4px; }
.fix-failed { color: var(--bad); }
.fix-headline { font-weight: 600; color: var(--good); }
.more { margin-top: 16px; } .more p { margin: 0 0 8px; }
.more-links { display: flex; gap: 8px; flex-wrap: wrap; }
.more-links .btn { max-width: 100%; white-space: normal; text-align: left; overflow-wrap: anywhere; }
.disclaimer { margin: 18px 0 0; font-size: 12px; line-height: 1.5; }
.activity { margin-top: 16px; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 8px 14px; }
.activity summary { cursor: pointer; font-weight: 600; }
.activity ul { list-style: none; padding: 0; margin: 8px 0 0; font-size: 13px; max-height: 260px; overflow: auto; }
.activity li { padding: 3px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; } .activity time { color: var(--muted); margin-right: 6px; }
.log-error { color: var(--bad); } .log-success { color: var(--good); }
.hidden-note { display: block; margin: 12px 0 0; }
.credit-balance { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line); }
.credit-balance-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; margin-bottom: 8px; }
.credit-projects { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 8px; }
.credit-card { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; background: var(--surface-2); min-width: 0; }
.credit-card .name { font-weight: 600; font-size: 13px; overflow-wrap: anywhere; }
.credit-line { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; margin-top: 4px; }
.credit-line b { font-variant-numeric: tabular-nums; }
.credit-line .out { color: var(--bad); }
.credit-bar { height: 5px; border-radius: 3px; background: var(--line); overflow: hidden; margin-top: 3px; }
.credit-bar span { display: block; height: 100%; background: var(--accent); transition: width .3s; }
.credit-flash { animation: credit-flash 1.2s ease-out; }
@keyframes credit-flash { from { background: var(--busy-bg); } to { background: var(--surface-2); } }
.dialog { border: 0; border-radius: 12px; padding: 0; max-width: 440px; width: calc(100% - 32px); background: var(--surface); color: var(--ink);
  box-shadow: 0 20px 50px rgba(16,24,40,.25); }
.dialog::backdrop { background: rgba(16,24,40,.55); }
.dialog form { padding: 20px 22px 18px; }
.dialog h2 { margin: 0 0 8px; font-size: 18px; }
.dialog p { margin: 0 0 10px; overflow-wrap: anywhere; }
.dialog-hint { color: var(--muted); font-size: 13px; }
.dialog-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.dialog-actions .btn { white-space: nowrap; }

/* Tablets and small laptops: tighter table, actions stacked so nothing is cut off. */
@media (max-width: 1100px) {
  td, th { padding: 8px; }
  .finding { min-width: 180px; }
  .actions-cell { white-space: normal; width: 1%; }
  .actions-cell .btn { display: flex; width: 100%; min-width: 104px; }
  .actions-cell .btn + .btn { margin: 6px 0 0; }
  .fix-cell { max-width: 220px; }
  th { white-space: nowrap; }
}

/* Phones: every finding becomes a card, actions are full-width and easy to tap. */
@media (max-width: 760px) {
  body { font-size: 15px; }
  .top-inner { flex-direction: column; align-items: stretch; }
  #connect { width: 100%; }
  main { padding-top: 12px; padding-bottom: 28px; }
  .actions { padding: 12px; }
  .bulk-row > .btn { flex: 1 1 calc(50% - 10px); }
  .table-wrap { background: transparent; border: 0; overflow: visible; }
  #findings, #findings tbody { display: block; }
  #findings thead { display: none; }
  #findings tr { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 16px; background: var(--surface);
    border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; }
  #findings td { display: block; padding: 0; border: 0; min-width: 0; }
  #findings td.sev-cell, #findings td.finding, #findings td.ai-cell, #findings td.actions-cell { flex: 1 1 100%; }
  #findings td.finding { min-width: 0; }
  #findings td.meta-cell, #findings td.state-cell, #findings td.ai-cell { font-size: 13px; }
  #findings td[data-label]::before { content: attr(data-label) ' '; color: var(--muted); font-size: 12px; font-weight: 600; }
  #findings td.ai-cell { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
  #findings td.ai-cell details { flex-basis: 100%; }
  #findings td.actions-cell { white-space: normal; display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
  #findings td.actions-cell .btn { flex: 1 1 0; margin: 0; min-height: 40px; font-size: 14px; }
  #findings td.actions-cell .fix-cell { flex-basis: 100%; max-width: none; font-size: 13px; }
  .more-links .btn { flex: 1 1 100%; }
  .dialog-actions .btn { flex: 1 1 auto; }
}
@media (max-width: 380px) {
  .bulk-row > .btn { flex-basis: 100%; }
}

/* Touch screens: bigger targets. */
@media (pointer: coarse) {
  .btn-small { min-height: 36px; padding: 6px 12px; }
  .ai-cell summary { padding: 4px 0; }
}

@media print {
  body { background: #fff; color: #000; }
  .top { background: none; color: #000; border-bottom: 2px solid #000; padding: 0 0 8px; }
  .count { background: none; border: 1px solid #999; }
  #connect, .actions, .actions-cell, .activity, .banner, .dialog, .hidden-note { display: none !important; }
  .table-wrap { border: 0; overflow: visible; }
  th { position: static; background: none; }
  tr { break-inside: avoid; }
  a { color: #000; }
}
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition: none !important; } }

/* Detect · Eliminate · Govern: summary tiles, the lifecycle strip, filters, calmer rows. */
:root { --detect: #2a78d6; --eliminate: #d9480f; --govern: #0e9f6e; }
@media (prefers-color-scheme: dark) { :root { --detect: #5b9df0; --eliminate: #f08a5a; --govern: #34c79a; } }
.top { padding-bottom: 18px; background: radial-gradient(1200px 300px at 85% -40%, rgba(255,255,255,.18), transparent 60%), linear-gradient(135deg, var(--accent), #6d28d9); }
.summary { gap: 10px; }
.summary .count { display: inline-flex; align-items: baseline; gap: 6px; padding: 8px 14px; border-radius: 12px; background: rgba(255,255,255,.14);
  border: 1px solid rgba(255,255,255,.2); font-size: 12.5px; backdrop-filter: blur(6px); }
.summary .count b { font-size: 20px; letter-spacing: -.01em; }
.summary .count i { align-self: center; width: 8px; height: 8px; border-radius: 50%; background: #fff; }
.count-critical i { background: #ff8a80 !important; } .count-high i { background: #ffb26b !important; } .count-medium i { background: #ffd666 !important; } .count-low i { background: #9ec5ff !important; }
.lifecycle { list-style: none; display: flex; flex-wrap: wrap; gap: 6px; max-width: 1280px; margin: 12px auto 0; padding: 0; font-size: 12px; }
.lifecycle li { display: inline-flex; gap: 6px; align-items: center; padding: 3px 12px 3px 8px; border-radius: 999px; background: rgba(0,0,0,.14); color: rgba(255,255,255,.9); }
.lifecycle li::before { content: ""; width: 8px; height: 8px; border-radius: 3px; }
.lc-detect::before { background: #9ec5ff; } .lc-eliminate::before { background: #ffb26b; } .lc-govern::before { background: #7ee2b8; }
.lifecycle li + li { position: relative; }
main { padding-top: 18px; }
.server, .actions, .table-wrap, .activity { border-radius: 14px; box-shadow: 0 1px 2px rgba(16,24,40,.04); }
.how { margin-top: 10px; }
.how summary { cursor: pointer; color: var(--link); font-size: 13px; font-weight: 600; }
.how p { margin: 8px 0 0; }
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 0 0 10px; }
.seg { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 3px; border-radius: 10px; background: var(--muted-bg); border: 1px solid var(--line); }
.seg-btn { font: inherit; font-size: 13px; font-weight: 600; border: 0; background: transparent; color: var(--muted-ink); padding: 5px 12px; border-radius: 8px; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.seg-btn em { font-style: normal; font-size: 11px; color: var(--muted); }
.seg-btn.on { background: var(--surface); color: var(--ink); box-shadow: 0 1px 2px rgba(16,24,40,.12); }
.dot { width: 8px; height: 8px; border-radius: 50%; } .dot-critical { background: #b42318; } .dot-high { background: #e04f16; } .dot-medium { background: #b54708; } .dot-low { background: #1570ef; }
#report-search { flex: 1 1 220px; max-width: 360px; font: inherit; padding: 7px 11px; border-radius: 9px; border: 1px solid var(--outline-line); background: var(--surface); color: var(--ink); }
.check { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted-ink); cursor: pointer; }
tr.filtered-out { display: none; }
#findings tbody tr:hover > td { background: color-mix(in srgb, var(--accent) 4%, transparent); }
td { vertical-align: middle; }
td.state-cell, td.finding { vertical-align: top; }
.why-line { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.state-why { max-width: 320px; }
@media (max-width: 760px) {
  .summary .count { flex: 1 1 calc(33% - 10px); justify-content: center; padding: 6px 8px; }
  .lifecycle { display: none; }
  .toolbar { align-items: stretch; }
  .seg { width: 100%; } .seg-btn { flex: 1 1 auto; justify-content: center; }
  #report-search { max-width: none; flex-basis: 100%; }
  #findings tr.filtered-out { display: none; }
}
@media print { .toolbar, .lifecycle { display: none !important; } tr.filtered-out { display: table-row; } }
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
