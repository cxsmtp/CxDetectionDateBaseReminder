import { AGE_BUCKETS } from './cxone/risks.js';
import { DEFAULT_LINK_TEMPLATES, projectUrl, riskUrl } from './links.js';
import { render } from './template.js';

/**
 * Turns a selection of findings into the data an administrator's template is
 * rendered against, then into a finished message.
 */

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO', 'UNKNOWN'];

const bucketLabel = (id) => AGE_BUCKETS.find((bucket) => bucket.id === id)?.label ?? id;

const formatDate = (iso) => (iso ? String(iso).slice(0, 10) : 'unknown');

function sortRisks(risks) {
  return [...risks].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    if (bySeverity !== 0) return bySeverity;
    return (b.ageDays ?? -1) - (a.ageDays ?? -1);
  });
}

/** Group the selected risks per project, largest first. */
export function groupByProject(risks, { maxRowsPerProject = 25, links = null, connection = null, initiatorsByProject = {} } = {}) {
  const groups = new Map();

  for (const risk of risks) {
    if (!groups.has(risk.projectId)) {
      groups.set(risk.projectId, { projectId: risk.projectId, projectName: risk.projectName, all: [] });
    }
    groups.get(risk.projectId).all.push(risk);
  }

  return [...groups.values()]
    .sort((a, b) => b.all.length - a.all.length)
    .map((group) => {
      const sorted = sortRisks(group.all);
      const shown = sorted.slice(0, maxRowsPerProject);
      return {
        projectId: group.projectId,
        projectName: group.projectName,
        riskCount: sorted.length,
        hiddenCount: sorted.length - shown.length,
        oldestFirstDetected: formatDate(
          sorted.map((r) => r.firstDetectedAt).filter(Boolean).sort()[0] ?? null,
        ),
        risks: shown.map((risk) => ({
          title: risk.title,
          severity: risk.severity,
          location: risk.location || '—',
          firstDetectedAt: formatDate(risk.firstDetectedAt),
          ageDays: risk.ageDays ?? '—',
          state: risk.state || '',
          scanner: risk.scanner || '',
          // Straight to this finding in the Checkmarx One UI.
          url: links
            ? riskUrl(risk, connection, links, initiatorsByProject[risk.projectId]?.scanId ?? '')
            : '',
        })),
      };
    });
}

/**
 * The variables a template can reference. Keep in step with
 * TEMPLATE_VARIABLES in template.js, which documents these in the editor.
 */
export function buildTemplateData(
  risks,
  {
    buckets = [],
    tenant = '',
    now = new Date(),
    initiator = null,
    initiatorsByProject = {},
    links = DEFAULT_LINK_TEMPLATES,
    connection = null,
    branding = {},
  } = {},
) {
  const projects = groupByProject(risks, { links, connection, initiatorsByProject }).map((project) => {
    const info = initiatorsByProject[project.projectId];
    return {
      ...project,
      initiator: info?.initiator ?? '',
      initiatorEmail: info?.email ?? '',
      lastScanDate: formatDate(info?.scanDate ?? null),
      url: links ? projectUrl(project, connection, links) : '',
    };
  });

  const counts = {};
  for (const risk of risks) counts[risk.severity] = (counts[risk.severity] ?? 0) + 1;

  const severities = SEVERITY_ORDER.filter((key) => counts[key]).map((key) => ({
    label: key,
    count: counts[key],
  }));

  // A named count per severity, so a template can show the roll-up without
  // hunting through a loop.
  const bySeverity = Object.fromEntries(
    SEVERITY_ORDER.map((key) => [`${key.toLowerCase()}Count`, counts[key] ?? 0]),
  );

  const oldest = projects
    .map((project) => project.oldestFirstDetected)
    .filter((date) => date && date !== 'unknown')
    .sort()[0] ?? '';

  const maxAge = risks.reduce((max, risk) => Math.max(max, risk.ageDays ?? 0), 0);

  return {
    tenant,
    companyName: branding.companyName ?? '',
    logoUrl: branding.logoUrl ?? '',
    logoHeight: branding.logoHeight ?? 40,
    accentColor: branding.accentColor ?? '#1d4ed8',
    callToAction: branding.callToAction ?? '',
    ...bySeverity,
    oldestFirstDetected: oldest,
    maxAgeDays: maxAge,
    // Blank unless the reminder covers exactly one project, which is what the
    // per-project mode produces.
    projectName: projects.length === 1 ? projects[0].projectName : '',
    // Lets a template say "across 4 projects" only when that is true, rather
    // than "across 1 project(s)" in a per-project mail.
    multipleProjects: projects.length > 1,
    projectUrl: projects.length === 1 ? projects[0].url : '',
    // Set when the reminder is addressed to one scan initiator, so a template
    // can greet them by name; empty for a broadcast to the configured list.
    initiator: initiator?.initiator ?? '',
    initiatorEmail: initiator?.email ?? '',
    generatedAt: now.toISOString().slice(0, 16).replace('T', ' '),
    scope: buckets.length ? buckets.map(bucketLabel).join(', ').toLowerCase() : 'any time',
    totalRisks: risks.length,
    projectCount: projects.length,
    severitySummary: severities.map((s) => `${s.count} ${s.label.toLowerCase()}`).join(', '),
    severities,
    projects,
  };
}

/**
 * Data for the interactive HTML report: the same roll-up numbers the mail
 * uses, but with every finding kept (the mail caps each project's list).
 */
export function buildReportData(risks, options = {}) {
  const { links = null, connection = null, initiatorsByProject = {} } = options;
  const data = buildTemplateData(risks, options);

  const groups = new Map();
  for (const risk of risks) {
    if (!groups.has(risk.projectId)) {
      groups.set(risk.projectId, { projectId: risk.projectId, projectName: risk.projectName, risks: [] });
    }
    groups.get(risk.projectId).risks.push({
      ...risk,
      url: links ? riskUrl(risk, connection, links, initiatorsByProject[risk.projectId]?.scanId ?? '') : '',
    });
  }

  const projects = [...groups.values()]
    .map((group) => ({ ...group, risks: sortRisks(group.risks) }))
    .sort((a, b) => b.risks.length - a.risks.length);

  return { ...data, projects };
}

/** Plain-text alternative, derived from the same data as the HTML part. */
function buildText(data) {
  const lines = [
    `${data.totalRisks} open finding(s) across ${data.projectCount} project(s), first detected ${data.scope}.`,
  ];
  if (data.severitySummary) lines.push(`Severity breakdown: ${data.severitySummary}.`);
  lines.push('');

  for (const project of data.projects) {
    lines.push(`${project.projectName} (${project.riskCount})`);
    if (project.url) lines.push(`  ${project.url}`);
    for (const risk of project.risks) {
      lines.push(
        `  - [${risk.severity}] ${risk.title}` +
          `${risk.location && risk.location !== '—' ? ` (${risk.location})` : ''}` +
          ` | first detected ${risk.firstDetectedAt} | ${risk.ageDays} days old`,
      );
      if (risk.url) lines.push(`      ${risk.url}`);
    }
    if (project.hiddenCount > 0) lines.push(`  ... and ${project.hiddenCount} more`);
    lines.push('');
  }

  lines.push(`Generated ${data.generatedAt} UTC for tenant ${data.tenant}.`);
  return lines.join('\n');
}

/**
 * Render the administrator's template into a finished message.
 *
 * @param {Array} risks     Selected findings.
 * @param {object} template {subject, html}
 */
export function buildReminder(risks, template, options = {}) {
  const data = buildTemplateData(risks, options);

  // The subject is plain text, so escaping it would only corrupt characters
  // like & in a project name.
  const subject = render(template.subject, data, { escape: false }).trim();
  const html = render(template.html, { ...data, subject });

  return { subject, html, text: buildText(data), data, projects: data.projects };
}
