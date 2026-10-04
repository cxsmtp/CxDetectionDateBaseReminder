/**
 * Configure the utility from a .env file an administrator uploads on the
 * Settings page: the same variables the server reads from its environment at
 * start-up, turned into settings that take effect at once.
 *
 * Only the variables listed in ENV_SETTINGS are applied; anything else (PORT,
 * DATA_DIR, ...) only means something at start-up and is reported as such.
 */

import { TOKEN_NAMES, numberedVariable } from './scm/instances.js';

const MAX_BYTES = 64 * 1024;

/** Parse dotenv text: KEY=VALUE lines, # comments, optional `export`, quoted values. */
export function parseEnvText(text) {
  const source = String(text ?? '');
  if (Buffer.byteLength(source) > MAX_BYTES) {
    throw Object.assign(new Error('That file is too large for a .env file (64 KB at most).'), { status: 400 });
  }
  const vars = {};
  const lines = source.replace(/^﻿/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, name] = match;
    let value = match[2];
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      // A quoted value may run over several lines (a PEM, a long key).
      let rest = value.slice(1);
      while (!rest.includes(quote) && i + 1 < lines.length) rest += `\n${lines[++i]}`;
      const end = rest.indexOf(quote);
      value = end >= 0 ? rest.slice(0, end) : rest;
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    vars[name] = value;
  }
  return vars;
}

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v).trim());

/**
 * The variables applied, which part of the settings each lands in, and the
 * permission needed to change it. A value of '' is skipped (an empty line in a
 * template must not wipe a working setting).
 */
export const ENV_SETTINGS = {
  CX_API_KEY: { part: 'cxone', permission: 'integration.cxone', apply: (s, v) => (s.cxone.apiKey = v) },
  CX_BASE_URL: { part: 'cxone', permission: 'integration.cxone', apply: (s, v) => (s.cxone.baseUrl = v) },
  CX_IAM_URL: { part: 'cxone', permission: 'integration.cxone', apply: (s, v) => (s.cxone.iamUrl = v) },
  CX_TENANT: { part: 'cxone', permission: 'integration.cxone', apply: (s, v) => (s.cxone.tenant = v) },
  SMTP_HOST: { part: 'smtp', permission: 'integration.smtp', apply: (s, v) => (s.smtp.host = v) },
  SMTP_PORT: { part: 'smtp', permission: 'integration.smtp', apply: (s, v) => (s.smtp.port = Number(v)) },
  SMTP_SECURE: { part: 'smtp', permission: 'integration.smtp', apply: (s, v) => (s.smtp.secure = truthy(v)) },
  SMTP_REQUIRE_AUTH: { part: 'smtp', permission: 'integration.smtp', apply: (s, v) => (s.smtp.requireAuth = truthy(v)) },
  SMTP_REJECT_UNAUTHORIZED: { part: 'smtp', permission: 'integration.smtp', apply: (s, v) => (s.smtp.rejectUnauthorized = truthy(v)) },
  SMTP_USER: { part: 'smtp', permission: 'integration.smtp', apply: (s, v) => (s.smtp.user = v) },
  SMTP_PASS: { part: 'smtp', permission: 'integration.smtp', apply: (s, v) => (s.smtp.password = v) },
  SMTP_PASSWORD: { part: 'smtp', permission: 'integration.smtp', apply: (s, v) => (s.smtp.password = v) },
  SMTP_FROM: { part: 'smtp', permission: 'integration.smtp', apply: (s, v) => (s.smtp.fromAddress = v) },
  SMTP_FROM_ADDRESS: { part: 'smtp', permission: 'integration.smtp', apply: (s, v) => (s.smtp.fromAddress = v) },
  SMTP_FROM_NAME: { part: 'smtp', permission: 'integration.smtp', apply: (s, v) => (s.smtp.fromName = v) },
  REPORT_SERVER_URL: { part: 'links', permission: 'settings.links', apply: (s, v) => (s.links.reportServerUrl = v) },
  PUBLIC_URL: { part: 'links', permission: 'settings.links', apply: (s, v) => (s.links.reportServerUrl ||= v) },
  // Beta: the GitHub connection (blame, username matching).
  GITHUB_TOKEN: { part: 'github', permission: 'beta.use', apply: (s, v) => (s.github.token = v) },
  GITHUB_API_URL: { part: 'github', permission: 'beta.use', apply: (s, v) => (s.github.apiUrl = v) },
  GITHUB_ORG: { part: 'github', permission: 'beta.use', apply: (s, v) => (s.github.org = v) },
  // Beta: GitLab, Azure DevOps and Bitbucket (blame, username matching).
  GITLAB_URL: { part: 'gitlab', permission: 'beta.use', apply: (s, v) => (s.gitlab.apiUrl = v) },
  GITLAB_TOKEN: { part: 'gitlab', permission: 'beta.use', apply: (s, v) => (s.gitlab.token = v) },
  GITLAB_GROUP: { part: 'gitlab', permission: 'beta.use', apply: (s, v) => (s.gitlab.group = v) },
  AZURE_DEVOPS_ORG_URL: { part: 'azure', permission: 'beta.use', apply: (s, v) => (s.azure.orgUrl = v) },
  AZURE_DEVOPS_TOKEN: { part: 'azure', permission: 'beta.use', apply: (s, v) => (s.azure.token = v) },
  BITBUCKET_URL: { part: 'bitbucket', permission: 'beta.use', apply: (s, v) => Object.assign(s.bitbucket, { apiUrl: v, kind: /bitbucket\.org/.test(v) ? 'cloud' : 'server' }) },
  BITBUCKET_USERNAME: { part: 'bitbucket', permission: 'beta.use', apply: (s, v) => (s.bitbucket.username = v) },
  BITBUCKET_TOKEN: { part: 'bitbucket', permission: 'beta.use', apply: (s, v) => (s.bitbucket.token = v) },
  BITBUCKET_WORKSPACE: { part: 'bitbucket', permission: 'beta.use', apply: (s, v) => (s.bitbucket.workspace = v) },
};

/** Secrets: reported by name only, never echoed back. */
export const SECRET_VARIABLES = new Set(['CX_API_KEY', 'SMTP_PASS', 'SMTP_PASSWORD', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'AZURE_DEVOPS_TOKEN', 'BITBUCKET_TOKEN']);
/** A secret, numbered ones included (GITLAB_TOKEN_2). */
export const isSecretVariable = (name) => SECRET_VARIABLES.has(name) || TOKEN_NAMES.has(numberedVariable(name)?.name);

/**
 * Turn parsed variables into setting changes this person may make.
 * Returns {changes: {cxone?, smtp?, links?}, applied: [names], refused: [names], ignored: [names]}.
 */
export function settingsFromEnv(vars, may = () => true) {
  const draft = { cxone: {}, smtp: {}, links: {}, github: {}, gitlab: {}, azure: {}, bitbucket: {}, instances: {} };
  const applied = [];
  const refused = [];
  const ignored = [];
  // SMTP_USER doubles as the From address when none is given (as at start-up).
  const order = Object.keys(vars).sort((a, b) => (a === 'SMTP_USER' ? -1 : b === 'SMTP_USER' ? 1 : 0));
  for (const name of order) {
    const value = String(vars[name] ?? '').trim();
    // A second (third …) connection to a git host: GITHUB_TOKEN_2, GITLAB_URL_2 … (src/scm/instances.js).
    const numbered = numberedVariable(name);
    const rule = Object.hasOwn(ENV_SETTINGS, name)
      ? ENV_SETTINGS[name]
      : numbered
        ? { part: 'instances', permission: 'beta.use', apply: (s, v) => ((s.instances[numbered.n] ??= {})[numbered.name] = v) }
        : undefined;
    if (!rule) {
      ignored.push(name);
      continue;
    }
    if (!value) continue;
    if (!may(rule.permission)) {
      refused.push(name);
      continue;
    }
    rule.apply(draft, value);
    if (name === 'SMTP_USER' && !vars.SMTP_FROM && !vars.SMTP_FROM_ADDRESS && value.includes('@')) draft.smtp.fromAddress = value;
    applied.push(name);
  }
  const changes = {};
  for (const [key, value] of Object.entries(draft)) if (Object.keys(value).length) changes[key] = value;
  return { changes, applied, refused, ignored };
}
