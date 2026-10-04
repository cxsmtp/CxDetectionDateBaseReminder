import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_AUTOMATION, mergeAutomation } from './automation-config.js';
import { mergeFeatures } from './features.js';
import { DEFAULT_LINK_TEMPLATES, PREVIOUS_LINK_DEFAULTS } from './links.js';
import { DEFAULT_TEMPLATE } from './template.js';
import { TOKEN_NAMES, cleanStoredInstances, mergeStoredInstances } from './scm/instances.js';
import { DEFAULT_SLA, mergeSla } from './sla.js';

/**
 * Administrator settings: SMTP, recipients and the mail template.
 *
 * Unlike the Checkmarx API key (which is per-session and memory-only), these
 * are deployment-wide and must survive a restart, so they are persisted to a
 * JSON file with owner-only permissions.
 */

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const EMAIL_RE = /^(?=[^]{3,254}$)[^\s@]+@[^\s@]+\.[^\s@]+$/;

const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

function getDefaultSmtp() {
  return {
    host: '',
    port: 587,
    secure: false,
    requireAuth: true,
    user: '',
    password: '',
    fromName: 'Checkmarx Reminders',
    fromAddress: '',
    rejectUnauthorized: true,
  };
}

export const DEFAULT_SETTINGS = {
  smtp: getDefaultSmtp(),
  recipients: { to: [], cc: [], bcc: [] },
  /**
   * How a scan initiator's username becomes an email address, and who else is
   * copied when a reminder is addressed to the initiator.
   */
  initiators: {
    useDirectory: true,
    defaultDomain: '',
    overrides: {},
    copyConfiguredRecipients: false,
  },
  template: DEFAULT_TEMPLATE,
  // Deep links into the Checkmarx One UI, so each finding in the mail is
  // clickable. Editable because the web app's routes are not part of the
  // published API reference.
  links: { ...DEFAULT_LINK_TEMPLATES },
  /** Customer branding shown in the mail header. */
  branding: {
    appName: 'CxMissionZero',
    companyName: '',
    logoUrl: '',
    // The browser tab's icon: empty is CxMissionZero's own (MZ0, public/favicon.svg).
    iconUrl: '',
    logoHeight: 40,
    accentColor: '#1d4ed8',
    callToAction: 'Please review and remediate these findings, oldest first.',
  },
  automation: { ...DEFAULT_AUTOMATION },
  /** SLAs (Beta, src/sla.js): days to fix each severity, and escalation of overdue findings. */
  sla: structuredClone(DEFAULT_SLA),
  /**
   * A credential for unattended runs. Automation has no human to paste a key,
   * so it needs one that outlives the session -- see the README. Written only
   * when the administrator explicitly arms it, and never sent to the browser.
   */
  automationApiKey: '',
  endpoints: { risksPath: '' },
  /**
   * AI Triage started from emailed reports runs on this server's Checkmarx
   * One connection and spends credits, so an administrator must allow it.
   * monthlyCreditLimit 0 means no limit.
   */
  aiTriage: {
    enabled: false,
    remediationEnabled: false,
    // The credit pool: the most this utility may spend, triage + remediation
    // together (0 = no limit). Every project allocation is given out of it.
    monthlyCreditLimit: 0,
    // 'month': the pool refills on the 1st of each month (UTC); 'all': one pool that does not refill.
    poolPeriod: 'month',
    skipNotExploitable: true,
    // Triage again a finding that already has a verdict (spends credits again).
    allowRetriage: false,
    // Run AI Remediation again for a finding already remediated (spends 3 credits again).
    allowReremediation: false,
    // Who report readers write to for more credits; empty = the sender address.
    adminContact: '',
  },
  /**
   * Beta features. GitHub: identity matching and code-author lookup.
   * `token` is a secret like the SMTP password: stored, never sent back.
   */
  beta: {
    github: {
      apiUrl: 'https://api.github.com',
      org: '',
      repos: [],
      localRepos: [],
      token: '',
    },
    // The other hosts, for code authors and username matching. Tokens are secrets too.
    gitlab: { apiUrl: '', token: '', group: '', projects: [] },
    azure: { orgUrl: '', token: '', repos: [] },
    bitbucket: { kind: '', apiUrl: '', username: '', token: '', workspace: '', repos: [] },
    authors: { useGithubBlame: true, useLocalBlame: true },
    // More connections to the same kind of host, from numbered .env variables
    // (GITHUB_TOKEN_2 …): {"2": {GITHUB_TOKEN, GITHUB_API_URL, …}}. Tokens are secrets.
    instances: {},
  },
  // Set when an SMTP connection test last succeeded, together with a
  // fingerprint of the settings that were tested.
  verifiedAt: null,
  verifiedFingerprint: null,
};

/**
 * A logo is rendered into an <img src> in mail sent to other people, so only
 * https (and data: for a pasted inline image) is accepted -- never javascript:
 * or a plain-http URL that would trip mixed-content warnings.
 */
export function isSafeImageUrl(url) {
  const value = String(url ?? '').trim();
  if (/^data:image\/(png|jpeg|jpg|gif|svg\+xml|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(value)) return true;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** A browser icon: an uploaded image (data:, up to 100 KB) or an https address. */
export function isSafeIconUrl(url) {
  const value = String(url ?? '').trim();
  if (/^data:/i.test(value)) {
    return value.length <= 140_000 && /^data:image\/(png|jpeg|jpg|svg\+xml|webp|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/=]+$/i.test(value);
  }
  try {
    return new URL(value).protocol === 'https:' && value.length <= 2000;
  } catch {
    return false;
  }
}

/** Split a textarea/comma/semicolon list into unique valid addresses. */
export function parseAddressList(value) {
  const entries = Array.isArray(value) ? value : String(value ?? '').split(/[;,\s\n]+/);
  const seen = new Set();
  for (const entry of entries) {
    const address = String(entry ?? '').trim();
    if (EMAIL_RE.test(address)) seen.add(address);
  }
  return [...seen];
}

/**
 * Parse the override list the administrator types as "username = email" lines
 * (or as an object), keeping only entries whose right-hand side is an address.
 */
/** Names that would reach an object's prototype if used as keys: never accepted from input. */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function parseOverrides(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([name, email]) => [String(name).trim(), String(email).trim()])
        .filter(([name, email]) => name && !RESERVED_KEYS.has(name) && EMAIL_RE.test(email)),
    );
  }

  const out = {};
  for (const line of String(value ?? '').split(/[\n;]+/)) {
    const [name, email] = line.split(/[=,:]|\s+->\s+/).map((part) => (part ?? '').trim());
    if (name && !RESERVED_KEYS.has(name) && email && EMAIL_RE.test(email)) out[name] = email;
  }
  return out;
}

/**
 * Identifies the SMTP configuration that was tested, so that changing any
 * connection detail invalidates a previous successful test.
 */
export function smtpFingerprint(smtp) {
  const material = [
    smtp.host,
    smtp.port,
    smtp.secure,
    smtp.requireAuth,
    smtp.user,
    smtp.password,
    smtp.rejectUnauthorized,
  ].join('\u0000');
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/** The host (and port) of an address, lower-cased; '' when it is not one. */
export function hostOfUrl(value) {
  try {
    return new URL(String(value ?? '').trim()).host.toLowerCase();
  } catch {
    return '';
  }
}

/** Mail server names compared without case or surrounding spaces. */
const sameHostName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

/** Merge untrusted input over the current settings, coercing every field. */
export function mergeSettings(current, incoming = {}) {
  const smtp = { ...current.smtp };
  const input = incoming.smtp ?? {};

  if ('host' in input) smtp.host = String(input.host ?? '').trim();
  if ('port' in input) smtp.port = Math.min(65535, Math.max(1, int(input.port, smtp.port)));
  if ('secure' in input) smtp.secure = bool(input.secure, smtp.secure);
  if ('requireAuth' in input) smtp.requireAuth = bool(input.requireAuth, smtp.requireAuth);
  if ('user' in input) smtp.user = String(input.user ?? '').trim();
  if ('fromName' in input) smtp.fromName = String(input.fromName ?? '').trim();
  if ('fromAddress' in input) smtp.fromAddress = String(input.fromAddress ?? '').trim();
  if ('rejectUnauthorized' in input) {
    smtp.rejectUnauthorized = bool(input.rejectUnauthorized, smtp.rejectUnauthorized);
  }
  // An omitted password keeps the stored one, so the UI never has to echo it
  // back to the browser just to save an unrelated field.
  if (typeof input.password === 'string' && input.password !== '') smtp.password = input.password;
  // The stored password is never sent to a different mail server: a new host needs it typed again
  // (a password saved before any host was set is not tied to one yet).
  else if (current.smtp.host && !sameHostName(smtp.host, current.smtp.host)) smtp.password = '';
  if (input.password === null) smtp.password = '';

  const recipients = { ...current.recipients };
  for (const field of ['to', 'cc', 'bcc']) {
    if (incoming.recipients && field in incoming.recipients) {
      recipients[field] = parseAddressList(incoming.recipients[field]);
    }
  }

  const initiators = { ...current.initiators };
  if (incoming.initiators) {
    const input = incoming.initiators;
    if ('useDirectory' in input) initiators.useDirectory = bool(input.useDirectory, initiators.useDirectory);
    if ('copyConfiguredRecipients' in input) {
      initiators.copyConfiguredRecipients = bool(input.copyConfiguredRecipients, initiators.copyConfiguredRecipients);
    }
    if ('defaultDomain' in input) {
      initiators.defaultDomain = String(input.defaultDomain ?? '').trim().replace(/^@/, '');
    }
    if ('overrides' in input) initiators.overrides = parseOverrides(input.overrides);
  }

  const template = { ...current.template };
  if (incoming.template) {
    if ('subject' in incoming.template) template.subject = String(incoming.template.subject ?? '');
    if ('html' in incoming.template) template.html = String(incoming.template.html ?? '');
  }

  const branding = { ...current.branding };
  if (incoming.branding) {
    const input = incoming.branding;
    if ('companyName' in input) branding.companyName = String(input.companyName ?? '').trim().slice(0, 120);
    if ('appName' in input) branding.appName = String(input.appName ?? '').trim().slice(0, 60) || 'CxMissionZero';
    if ('callToAction' in input) branding.callToAction = String(input.callToAction ?? '').trim().slice(0, 500);
    if ('logoHeight' in input) {
      const height = int(input.logoHeight, branding.logoHeight);
      branding.logoHeight = Math.min(200, Math.max(16, height));
    }
    if ('accentColor' in input) {
      const colour = String(input.accentColor ?? '').trim();
      // Only a literal hex colour, since this lands inside a style attribute.
      branding.accentColor = /^#[0-9a-f]{3,8}$/i.test(colour) ? colour : branding.accentColor;
    }
    if ('logoUrl' in input) {
      const url = String(input.logoUrl ?? '').trim();
      branding.logoUrl = url === '' || isSafeImageUrl(url) ? url : branding.logoUrl;
    }
    if ('iconUrl' in input) {
      const url = String(input.iconUrl ?? '').trim();
      if (url && !isSafeIconUrl(url)) throw Object.assign(new Error('The browser icon must be an image (PNG, SVG, ICO, WebP or JPG) of up to 100 KB, or an https address.'), { status: 400 });
      branding.iconUrl = url;
    }
  }

  const links = { ...current.links };
  if (incoming.links) {
    if ('reportServerUrl' in incoming.links) {
      const value = String(incoming.links.reportServerUrl ?? '').trim().replace(/\/+$/, '');
      links.reportServerUrl = value === '' || /^https?:\/\/[^\s/]+(\/\S*)?$/i.test(value) ? value : links.reportServerUrl;
    }
    for (const field of ['baseUrl', 'project', 'risk']) {
      if (field in incoming.links) {
        const value = String(incoming.links[field] ?? '').trim();
        // An empty template falls back to the built-in default rather than
        // silently producing no link at all.
        links[field] = value || (field === 'baseUrl' ? '' : DEFAULT_LINK_TEMPLATES[field]);
      }
    }
  }

  const automation = mergeAutomation(current.automation, incoming.automation ?? {});

  const endpoints = { ...current.endpoints };
  if (incoming.endpoints && 'risksPath' in incoming.endpoints) {
    const value = String(incoming.endpoints.risksPath ?? '').trim();
    endpoints.risksPath = value.startsWith('/') ? value : '';
  }

  const aiTriage = { ...current.aiTriage };
  if (incoming.aiTriage) {
    if ('enabled' in incoming.aiTriage) aiTriage.enabled = incoming.aiTriage.enabled === true;
    if ('remediationEnabled' in incoming.aiTriage) aiTriage.remediationEnabled = incoming.aiTriage.remediationEnabled === true;
    if ('skipNotExploitable' in incoming.aiTriage) aiTriage.skipNotExploitable = incoming.aiTriage.skipNotExploitable !== false;
    if ('allowRetriage' in incoming.aiTriage) aiTriage.allowRetriage = incoming.aiTriage.allowRetriage === true;
    if ('allowReremediation' in incoming.aiTriage) aiTriage.allowReremediation = incoming.aiTriage.allowReremediation === true;
    if ('adminContact' in incoming.aiTriage) {
      const contact = String(incoming.aiTriage.adminContact ?? '').trim();
      if (contact && !/^(?=[^]{3,254}$)[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(contact)) {
        throw Object.assign(new Error('The administrator contact must be one email address.'), { status: 400 });
      }
      aiTriage.adminContact = contact;
    }
    if ('poolPeriod' in incoming.aiTriage) aiTriage.poolPeriod = incoming.aiTriage.poolPeriod === 'all' ? 'all' : 'month';
    if ('monthlyCreditLimit' in incoming.aiTriage) {
      const limit = Math.floor(Number(incoming.aiTriage.monthlyCreditLimit));
      aiTriage.monthlyCreditLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1_000_000) : 0;
    }
  }

  const beta = mergeBeta(current.beta, incoming.beta);

  // Beta or final: set only through its own route (the Admin's), never by the settings form.
  const features = mergeFeatures(current.features, incoming.features);

  const sla = mergeSla(current.sla, incoming.sla ?? null);

  const next = { ...current, smtp, recipients, initiators, template, links, branding, automation, endpoints, aiTriage, beta, features, sla };

  // The automation credential is set through its own route, not this form.
  if (typeof incoming.automationApiKey === 'string') next.automationApiKey = incoming.automationApiKey.trim();
  // Where the stored key connects, when the key alone does not say (single-tenant / on-prem).
  if (incoming.integrationOverrides && typeof incoming.integrationOverrides === 'object') {
    const clean = (v) => String(v ?? '').trim().replace(/\/+$/, '');
    next.integrationOverrides = {
      baseUrl: clean(incoming.integrationOverrides.baseUrl),
      iamUrl: clean(incoming.integrationOverrides.iamUrl),
      tenant: String(incoming.integrationOverrides.tenant ?? '').trim(),
    };
  }

  // Any change to how we connect invalidates the previous successful test.
  if (smtpFingerprint(smtp) !== current.verifiedFingerprint) {
    next.verifiedAt = null;
    next.verifiedFingerprint = null;
  }
  return next;
}

/** True when the current SMTP settings are the ones that passed the test. */
export function isVerified(settings) {
  return Boolean(
    settings.verifiedAt && settings.verifiedFingerprint === smtpFingerprint(settings.smtp),
  );
}

/** Lines or commas → trimmed, de-duplicated list. */
const listOf = (value, max = 50) =>
  [...new Set((Array.isArray(value) ? value : String(value ?? '').split(/[\n,]+/)).map((v) => String(v).trim()).filter(Boolean))].slice(0, max);

/** The product's earlier default names, saved by auto-save as if chosen: they become today's default. */
const LEGACY_APP_NAMES = new Set(['Mission Zero', 'Detection Date Reminder', 'Checkmarx detection-date reminder']);
function migrateBranding(branding) {
  return LEGACY_APP_NAMES.has(String(branding.appName ?? '').trim()) ? { ...branding, appName: DEFAULT_SETTINGS.branding.appName } : branding;
}

function mergeBeta(current = DEFAULT_SETTINGS.beta, incoming) {
  const github = { ...DEFAULT_SETTINGS.beta.github, ...(current.github ?? {}) };
  const authors = { ...DEFAULT_SETTINGS.beta.authors, ...(current.authors ?? {}) };
  const input = incoming?.github;
  if (input) {
    if ('apiUrl' in input) {
      const url = String(input.apiUrl ?? '').trim().replace(/\/+$/, '');
      // https only; plain http just for a GitHub mock on this machine.
      if (url && !/^https:\/\/[\w.-]+(:\d+)?(\/[\w./-]*)?$/.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/[\w./-]*)?$/.test(url)) {
        throw Object.assign(new Error('The GitHub API URL must be an https address.'), { status: 400 });
      }
      github.apiUrl = url || DEFAULT_SETTINGS.beta.github.apiUrl;
    }
    if ('org' in input) github.org = String(input.org ?? '').trim().replace(/^@/, '');
    if ('repos' in input) github.repos = listOf(input.repos).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r));
    if ('localRepos' in input) github.localRepos = listOf(input.localRepos);
    // Like the SMTP password: an omitted token keeps the stored one; null clears it.
    if (typeof input.token === 'string' && input.token.trim()) github.token = input.token.trim();
    // A token is never sent to another host: pointing the API address elsewhere drops it, unless a new one comes with it.
    else if (hostOfUrl(github.apiUrl) !== hostOfUrl(current.github?.apiUrl || DEFAULT_SETTINGS.beta.github.apiUrl)) github.token = '';
    if (input.token === null) github.token = '';
  }
  if (incoming?.authors) {
    for (const key of ['useGithubBlame', 'useLocalBlame']) if (key in incoming.authors) authors[key] = incoming.authors[key] !== false;
  }
  const hosts = {};
  for (const id of ['gitlab', 'azure', 'bitbucket']) hosts[id] = mergeHost(id, { ...DEFAULT_SETTINGS.beta[id], ...(current[id] ?? {}) }, incoming?.[id]);
  for (const vars of Object.values(incoming?.instances ?? {})) {
    for (const [name, value] of Object.entries(vars ?? {})) if (/_URL$/.test(name) && value) hostUrl(value, name);
  }
  const instances = incoming?.instances ? mergeStoredInstances(current.instances, incoming.instances) : cleanStoredInstances(current.instances);
  return { github, ...hosts, authors, instances };
}

/** https only (http just for a test double on this machine). */
function hostUrl(value, label) {
  const url = String(value ?? '').trim().replace(/\/+$/, '');
  if (url && !/^https:\/\/[\w.-]+(:\d+)?(\/[\w./~-]*)?$/.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/[\w./~-]*)?$/.test(url)) {
    throw Object.assign(new Error(`The ${label} address must be an https address.`), { status: 400 });
  }
  return url;
}

/** GitLab, Azure DevOps or Bitbucket connection: an omitted token keeps the stored one; null clears it. */
function mergeHost(id, host, input) {
  if (!input) return host;
  const next = { ...host };
  if (id === 'gitlab') {
    if ('apiUrl' in input) next.apiUrl = hostUrl(input.apiUrl, 'GitLab');
    if ('group' in input) next.group = String(input.group ?? '').trim();
    if ('projects' in input) next.projects = listOf(input.projects).filter((r) => /^[\w.-]+(\/[\w.-]+)+$/.test(r));
  }
  if (id === 'azure') {
    if ('orgUrl' in input) next.orgUrl = hostUrl(input.orgUrl, 'Azure DevOps organisation');
    if ('repos' in input) next.repos = listOf(input.repos).filter((r) => /^[^/\s]+\/[^/\s]+$/.test(r));
  }
  if (id === 'bitbucket') {
    if ('kind' in input) next.kind = input.kind === 'server' ? 'server' : input.kind === 'cloud' ? 'cloud' : '';
    if ('apiUrl' in input) next.apiUrl = hostUrl(input.apiUrl, 'Bitbucket');
    if ('username' in input) next.username = String(input.username ?? '').trim();
    if ('workspace' in input) next.workspace = String(input.workspace ?? '').trim();
    if ('repos' in input) next.repos = listOf(input.repos).filter((r) => /^[\w.~-]+\/[\w.-]+$/.test(r));
  }
  if (typeof input.token === 'string' && input.token.trim()) next.token = input.token.trim();
  // A token is never sent to another host: a new address drops it, unless a new token comes with it.
  else if (hostKey(id, host) && hostKey(id, next) !== hostKey(id, host)) next.token = '';
  if (input.token === null) next.token = '';
  return next;
}

/** Where a host's token would be sent: its address's host (and, for Bitbucket, cloud or server). */
function hostKey(id, host) {
  if (id === 'gitlab') return hostOfUrl(host.apiUrl || 'https://gitlab.com');
  if (id === 'azure') return hostOfUrl(host.orgUrl);
  return `${host.kind || ''} ${hostOfUrl(host.apiUrl || 'https://api.bitbucket.org')}`;
}

/** Settings shaped for the browser: the password is replaced by a flag. */
export function publicSettings(settings) {
  const { password, ...smtp } = settings.smtp;
  return {
    smtp: { ...smtp, passwordSet: Boolean(password) },
    recipients: settings.recipients,
    initiators: settings.initiators,
    template: settings.template,
    links: settings.links,
    branding: settings.branding,
    automation: settings.automation,
    automationKeyStored: Boolean(settings.automationApiKey),
    endpoints: settings.endpoints,
    aiTriage: settings.aiTriage,
    beta: (() => {
      const { token, ...github } = settings.beta?.github ?? DEFAULT_SETTINGS.beta.github;
      // GITHUB_TOKEN in the environment counts when none is stored here.
      const environment = !token && Boolean(String(process.env.GITHUB_TOKEN ?? '').trim());
      const host = (id, envName) => {
        const { token: secret, ...rest } = { ...DEFAULT_SETTINGS.beta[id], ...(settings.beta?.[id] ?? {}) };
        const fromEnv = !secret && Boolean(String(process.env[envName] ?? '').trim());
        return { ...rest, tokenSet: Boolean(secret) || fromEnv, tokenFromEnvironment: fromEnv };
      };
      return {
        github: { ...github, tokenSet: Boolean(token) || environment, tokenFromEnvironment: environment },
        gitlab: host('gitlab', 'GITLAB_TOKEN'),
        azure: host('azure', 'AZURE_DEVOPS_TOKEN'),
        bitbucket: host('bitbucket', 'BITBUCKET_TOKEN'),
        authors: settings.beta?.authors ?? DEFAULT_SETTINGS.beta.authors,
        // Numbered connections: addresses and names only, never the tokens.
        instances: Object.fromEntries(
          Object.entries(cleanStoredInstances(settings.beta?.instances)).map(([n, vars]) => [
            n,
            Object.fromEntries(Object.entries(vars).map(([name, value]) => (TOKEN_NAMES.has(name) ? [name, '(set)'] : [name, value]))),
          ]),
        ),
      };
    })(),
    features: mergeFeatures(settings.features),
    sla: mergeSla(settings.sla),
    verifiedAt: settings.verifiedAt,
    verified: isVerified(settings),
  };
}

/** Trim whitespace/CR and matching surrounding quotes from an env value. */
function envValue(name) {
  const raw = process.env[name];
  if (raw === undefined) return '';
  return String(raw).replace(/[\r\n]+/g, '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();
}

/** True when the environment supplies a usable SMTP login. */
export function hasEnvironmentSmtp() {
  return Boolean(envValue('SMTP_HOST') && envValue('SMTP_USER') && envValue('SMTP_PASS'));
}

/** Apply SMTP settings from environment variables if present. */
export function applyEnvironmentSmtp(settings) {
  const smtp = { ...settings.smtp };
  const host = envValue('SMTP_HOST');
  const port = envValue('SMTP_PORT');
  const secure = envValue('SMTP_SECURE');
  const user = envValue('SMTP_USER');
  const pass = envValue('SMTP_PASS');
  if (host) smtp.host = host;
  if (port) smtp.port = int(port, smtp.port);
  if (secure) smtp.secure = secure.toLowerCase() === 'true';
  if (user) {
    smtp.user = user;
    smtp.fromAddress = user;
  }
  if (pass) smtp.password = pass;
  return { ...settings, smtp };
}

export class SettingsStore {
  #file;
  #settings;

  constructor({ file } = {}) {
    this.#file = file ?? path.join(process.cwd(), 'data', 'settings.json');
    this.#settings = this.#load();
  }

  get file() {
    return this.#file;
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.#file, 'utf8'));
      // Merge over the defaults so a settings file written by an older
      // version still loads with every newer field present.
      return {
        ...DEFAULT_SETTINGS,
        ...raw,
        smtp: { ...DEFAULT_SETTINGS.smtp, ...(raw.smtp ?? {}) },
        recipients: { ...DEFAULT_SETTINGS.recipients, ...(raw.recipients ?? {}) },
        initiators: { ...DEFAULT_SETTINGS.initiators, ...(raw.initiators ?? {}) },
        template: { ...DEFAULT_SETTINGS.template, ...(raw.template ?? {}) },
        links: migrateLinks({ ...DEFAULT_SETTINGS.links, ...(raw.links ?? {}) }),
        branding: migrateBranding({ ...DEFAULT_SETTINGS.branding, ...(raw.branding ?? {}) }),
        automation: { ...DEFAULT_SETTINGS.automation, ...(raw.automation ?? {}) },
        endpoints: { ...DEFAULT_SETTINGS.endpoints, ...(raw.endpoints ?? {}) },
        aiTriage: { ...DEFAULT_SETTINGS.aiTriage, ...(raw.aiTriage ?? {}) },
        beta: mergeBeta(raw.beta, null),
        features: mergeFeatures(raw.features),
        sla: mergeSla(raw.sla),
      };
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  get() {
    return this.#settings;
  }

  /** Apply SMTP settings from environment variables (not persisted). */
  applyEnvironment() {
    this.#settings = applyEnvironmentSmtp(this.#settings);
    return this.#settings;
  }

  /** Apply an update and persist it atomically. */
  save(incoming) {
    this.#settings = mergeSettings(this.#settings, incoming);
    this.#persist();
    return this.#settings;
  }

  /** Put back SMTP settings known to work (the last known good ones), already verified. */
  restoreSmtp(smtp) {
    const { at, ...restored } = smtp;
    this.#settings = { ...this.#settings, smtp: { ...getDefaultSmtp(), ...restored } };
    this.#settings.verifiedAt = new Date().toISOString();
    this.#settings.verifiedFingerprint = smtpFingerprint(this.#settings.smtp);
    this.#persist();
    return this.#settings;
  }

  /** Record a successful connection test against the current SMTP settings. */
  markVerified() {
    this.#settings = {
      ...this.#settings,
      verifiedAt: new Date().toISOString(),
      verifiedFingerprint: smtpFingerprint(this.#settings.smtp),
    };
    this.#persist();
    return this.#settings;
  }

  #persist() {
    const dir = path.dirname(this.#file);
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    // Write-then-rename so a crash cannot leave a half-written settings file.
    const temp = `${this.#file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.#settings, null, 2), { mode: FILE_MODE });
    fs.renameSync(temp, this.#file);
    fs.chmodSync(this.#file, FILE_MODE);
  }
}

/** A saved link that is just an earlier default moves to the current default; a customised one is kept. */
export function migrateLinks(links) {
  const next = { ...links };
  for (const [field, previous] of Object.entries(PREVIOUS_LINK_DEFAULTS)) {
    if (previous.includes(next[field])) next[field] = DEFAULT_LINK_TEMPLATES[field];
  }
  return next;
}
