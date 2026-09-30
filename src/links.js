/**
 * Deep links into the Checkmarx One web UI.
 *
 * The reminder is only a ready reckoner if each row is clickable, so every
 * finding carries a link straight to it in the platform.
 *
 * The UI route is built from a template rather than hard-coded: the published
 * API reference documents the REST endpoints, not the web app's routes, so the
 * defaults below are best-effort and a tenant may differ. The Settings page
 * shows a live example built from real data, so a wrong shape is a one-field
 * correction rather than a code change.
 */

export const DEFAULT_LINK_TEMPLATES = {
  // Blank means "use the API host the API key resolved to", which is also the
  // web UI host on multi-tenant Checkmarx One.
  baseUrl: '',
  // How emailed reports reach this server's relay. Blank uses the address the
  // dashboard is opened on, which only works if recipients can reach it too.
  reportServerUrl: '',
  // Risk Hub: the project's risks, where findings are triaged and remediated.
  project: '{baseUrl}/riskhub/{projectId}',
  // Opens Risk Hub with the finding's details panel (triage / remediate) open.
  risk:
    '{baseUrl}/riskhub/{projectId}' +
    '?pagination=%7B%22pageSize%22%3A50%2C%22currentPage%22%3A1%7D' +
    '&grouping=%7B%22groups%22%3A%5B%22severity%22%5D%7D' +
    '&resultId={riskId}',
};

/** Earlier defaults, so settings saved with them can move to the current ones. */
export const PREVIOUS_LINK_DEFAULTS = {
  project: ['{baseUrl}/projects/{projectId}/overview'],
  risk: ['{baseUrl}/results/{scanId}/{projectId}/{engine}?result-id={riskId}'],
};

/** Engine names as the API reports them, mapped to the UI's tab slugs. */
const ENGINE_SLUGS = {
  SAST: 'sast',
  SCA: 'sca',
  IAC: 'kics',
  KICS: 'kics',
  CONTAINERS: 'containers',
  APISEC: 'apisec',
};

export function engineSlug(engine) {
  const key = String(engine ?? '').trim().toUpperCase();
  return ENGINE_SLUGS[key] ?? (key ? key.toLowerCase() : 'sast');
}

const trimSlash = (value) => String(value ?? '').replace(/\/+$/, '');

/**
 * Substitute `{placeholder}` tokens, URL-encoding every value.
 *
 * Encoding matters: a risk id such as `cye0DZkmtm6xwMN4J1Td3BKw03o=` contains
 * `/`, `+` and `=`, which would otherwise corrupt the path or the query.
 * `{baseUrl}` is the one exception, since it is a URL already.
 */
export function fillTemplate(template, values) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (match, name) => {
    if (!(name in values)) return match;
    const value = values[name];
    if (value === undefined || value === null || value === '') return '';
    return name === 'baseUrl' ? trimSlash(value) : encodeURIComponent(value);
  });
}

/** Only http(s) links are ever emitted, so a template cannot smuggle a script URL. */
export function safeUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function resolveBase(templates, connection) {
  return trimSlash(templates?.baseUrl || connection?.baseUrl || '');
}

/** Link to a project's overview in the Checkmarx One UI. */
export function projectUrl(project, connection, templates = DEFAULT_LINK_TEMPLATES) {
  const baseUrl = resolveBase(templates, connection);
  if (!baseUrl || !project?.projectId) return '';

  return safeUrl(
    fillTemplate(templates.project || DEFAULT_LINK_TEMPLATES.project, {
      baseUrl,
      projectId: project.projectId,
      projectName: project.projectName ?? '',
    }),
  );
}

/**
 * Link to a single finding. Needs the scan it was last seen in, which comes
 * from the risk record itself or from the project's latest scan.
 */
export function riskUrl(risk, connection, templates = DEFAULT_LINK_TEMPLATES, fallbackScanId = '') {
  const baseUrl = resolveBase(templates, connection);
  const scanId = risk?.scanId || fallbackScanId;
  if (!baseUrl || !risk?.projectId) return '';

  // A template that routes by scan has nowhere to point without one; the
  // project page is still better than nothing.
  const template = templates.risk || DEFAULT_LINK_TEMPLATES.risk;
  if (!scanId && template.includes('{scanId}')) return projectUrl({ projectId: risk.projectId }, connection, templates);

  return safeUrl(
    fillTemplate(template, {
      baseUrl,
      projectId: risk.projectId,
      scanId,
      engine: engineSlug(risk.scanner),
      riskId: risk.id ?? '',
      similarityId: risk.similarityId ?? risk.id ?? '',
    }),
  );
}

/** A worked example for the Settings page, so a wrong shape is obvious. */
export function exampleLinks(connection, templates = DEFAULT_LINK_TEMPLATES) {
  const sample = {
    projectId: '2c7007de-1c72-42bf-80db-97967a6e3e29',
    scanId: '80f5a95a-ba0e-43d9-9486-d26ac4d82a0b',
    id: 'cye0DZkmtm6xwMN4J1Td3BKw03o=',
    scanner: 'SAST',
  };

  return {
    project: projectUrl({ projectId: sample.projectId }, connection, templates),
    risk: riskUrl(sample, connection, templates),
  };
}
