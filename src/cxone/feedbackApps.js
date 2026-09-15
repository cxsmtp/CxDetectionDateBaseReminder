import { CxApiError, extractItems } from './client.js';
import { FEEDBACK_LIST_CANDIDATES, isProbeMiss } from './discovery.js';

/**
 * Feedback Apps are the notification integrations configured under
 * Integrations -> Feedback Apps in Checkmarx One (Email, Slack, Teams, ...).
 * This module lists them and reuses their configured recipient list, so the
 * reminder goes to exactly the people already set up in CxONE.
 */

const RECIPIENT_KEYS = [
  'recipients',
  'emails',
  'emailAddresses',
  'to',
  'receivers',
  'recipientList',
  'addresses',
];

const asArray = (value) => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.split(/[;,\s]+/).filter(Boolean);
  return [];
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Pull email addresses out of a feedback-app record of unknown shape. */
export function extractRecipients(app) {
  const pools = [app, app?.config, app?.configuration, app?.settings, app?.properties].filter(Boolean);
  const found = new Set();

  for (const pool of pools) {
    for (const key of RECIPIENT_KEYS) {
      for (const entry of asArray(pool[key])) {
        const address = typeof entry === 'string' ? entry : entry?.email ?? entry?.address ?? '';
        const trimmed = String(address).trim();
        if (EMAIL_RE.test(trimmed)) found.add(trimmed);
      }
    }
  }
  return [...found];
}

function normalizeApp(raw) {
  const type = String(raw.type ?? raw.appType ?? raw.kind ?? raw.provider ?? '').toUpperCase();
  return {
    id: String(raw.id ?? raw.appId ?? raw.uuid ?? raw.name ?? ''),
    name: String(raw.name ?? raw.displayName ?? raw.title ?? raw.id ?? 'Unnamed feedback app'),
    type: type || 'UNKNOWN',
    enabled: raw.enabled ?? raw.active ?? raw.isEnabled ?? true,
    recipients: extractRecipients(raw),
    states: asArray(raw.states ?? raw.config?.states),
    scanners: asArray(raw.scanners ?? raw.engines ?? raw.config?.scanners),
    raw,
  };
}

/** List the feedback apps configured on the tenant. */
export async function listFeedbackApps(client, config) {
  const candidates = [
    config.feedback.listPath,
    ...FEEDBACK_LIST_CANDIDATES.filter((path) => path !== config.feedback.listPath),
  ];

  let lastError;
  for (const path of candidates) {
    try {
      const response = await client.request(path);
      const apps = extractItems(response, 'feedbackApps').map(normalizeApp).filter((app) => app.id);
      return { path, apps };
    } catch (error) {
      // An unknown path can come back as 400 or 403 just as easily as 404,
      // depending on how the tenant's gateway is fronted, so all of them
      // simply mean "try the next candidate".
      if (isProbeMiss(error)) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  const detail = lastError ? ` Last response: ${lastError.status} ${lastError.body ?? ''}`.trim() : '';
  throw new CxApiError(
    `No Feedback Apps endpoint responded on this tenant. Use "Detect endpoints" to find the right ` +
      `path, or set it under Endpoints.${detail ? ` ${detail}` : ''}`,
    { status: lastError?.status ?? 404, body: lastError?.body ?? '' },
  );
}

export async function getFeedbackApp(client, config, appId) {
  const { apps } = await listFeedbackApps(client, config);
  const app = apps.find((entry) => entry.id === appId);
  if (!app) throw new CxApiError(`Feedback app "${appId}" was not found.`, { status: 404 });
  return app;
}

/**
 * Ask CxONE to deliver a notification through the feedback app itself.
 * Returns null when the tenant does not expose a trigger endpoint, which lets
 * the caller fall back to SMTP with the app's recipient list.
 */
export async function triggerFeedbackApp(client, config, appId, payload) {
  const path = config.feedback.triggerPath.replace('{appId}', encodeURIComponent(appId));
  try {
    const response = await client.request(path, { method: 'POST', body: payload });
    return { delivered: true, path, response };
  } catch (error) {
    if (isProbeMiss(error)) return null;
    throw error;
  }
}
