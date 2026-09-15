import { randomUUID } from 'node:crypto';

import { CxClient } from './cxone/client.js';
import { deriveConnection, publicConnection } from './cxone/endpoints.js';

const DEFAULT_IDLE_MS = 8 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Holds one live Checkmarx One connection per browser session.
 *
 * The API key is pasted into the portal, verified once, and then kept **only**
 * in this process's memory — it is never written to disk and never sent back
 * to the browser.  The browser holds nothing but an opaque httpOnly session id.
 */
export class SessionStore {
  #sessions = new Map();
  #idleMs;

  constructor({ idleMs = DEFAULT_IDLE_MS } = {}) {
    this.#idleMs = idleMs;
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  /**
   * Verify an API key and open a session for it.  Verification does two
   * things: exchanges the key for a token (proves the key and IAM URL) and
   * makes one cheap API call (proves the derived API URL).
   */
  async create(apiKey, overrides = {}) {
    const connection = deriveConnection(apiKey, overrides);
    const client = new CxClient(connection);

    // Confirms the derived API host as well as the credential itself.
    await client.request('/api/projects', { query: { limit: 1, offset: 0 }, retries: 1 });

    const id = randomUUID();
    const session = {
      id,
      connection,
      client,
      lastScan: null,
      // Endpoint paths the operator pinned from the UI, layered over the
      // deployment defaults by effectiveConfig().
      paths: {},
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    this.#sessions.set(id, session);
    return session;
  }

  get(id) {
    const session = id ? this.#sessions.get(id) : undefined;
    if (!session) return null;
    if (Date.now() - session.lastUsedAt > this.#idleMs) {
      this.#sessions.delete(id);
      return null;
    }
    session.lastUsedAt = Date.now();
    return session;
  }

  destroy(id) {
    return this.#sessions.delete(id);
  }

  sweep() {
    const cutoff = Date.now() - this.#idleMs;
    for (const [id, session] of this.#sessions) {
      if (session.lastUsedAt < cutoff) this.#sessions.delete(id);
    }
  }

  get size() {
    return this.#sessions.size;
  }
}

/** Session details the browser is allowed to see (never the API key). */
export function describeSession(session, config) {
  return {
    connected: true,
    connection: publicConnection(session.connection),
    hasScan: Boolean(session.lastScan),
    connectedAt: new Date(session.createdAt).toISOString(),
    paths: config ? endpointPaths(effectiveConfig(session, config)) : undefined,
  };
}

/** Deployment config with this session's pinned endpoint paths layered on top. */
export function effectiveConfig(session, config) {
  const { risksPath, feedbackListPath, feedbackTriggerPath } = session.paths ?? {};
  if (!risksPath && !feedbackListPath && !feedbackTriggerPath) return config;

  return {
    ...config,
    risks: { ...config.risks, path: risksPath || config.risks.path },
    feedback: {
      listPath: feedbackListPath || config.feedback.listPath,
      triggerPath: feedbackTriggerPath || config.feedback.triggerPath,
    },
  };
}

export function endpointPaths(config) {
  return {
    risksPath: config.risks.path,
    feedbackListPath: config.feedback.listPath,
    feedbackTriggerPath: config.feedback.triggerPath,
  };
}

// ---------------------------------------------------------------------------
// Cookie handling (kept dependency-free: one name, one value)
// ---------------------------------------------------------------------------

export const SESSION_COOKIE = 'cxdr_sid';

export function readSessionCookie(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function setSessionCookie(req, res, id) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.append(
    'Set-Cookie',
    [
      `${SESSION_COOKIE}=${encodeURIComponent(id)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      secure ? 'Secure' : '',
    ]
      .filter(Boolean)
      .join('; '),
  );
}

export function clearSessionCookie(res) {
  res.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
