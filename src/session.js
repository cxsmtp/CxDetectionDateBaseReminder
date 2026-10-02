import { randomUUID } from 'node:crypto';

import { sessionKey } from './handover.js';

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
  #adopted = new Map(); // sessionKey -> saved session from the previous server, until its browser calls
  #adoptLink = null;

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
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    this.#sessions.set(id, session);
    return session;
  }

  /**
   * A session for someone who signed in with a password: it has no key of its
   * own and uses the server's Checkmarx One integration — whatever `link()`
   * returns at the time of each call, so reconnecting the integration applies
   * to everyone at once.
   */
  createLinked(link, id = randomUUID()) {
    const integration = () => {
      const target = link();
      if (!target) {
        throw Object.assign(new Error('Checkmarx One is not connected on this server yet. An administrator connects it under Settings → Connection.'), { status: 503 });
      }
      return target;
    };
    const session = { id, linked: true, lastScan: null, createdAt: Date.now(), lastUsedAt: Date.now() };
    Object.defineProperties(session, {
      connection: { get: () => integration().connection },
      client: { get: () => integration().client },
    });
    this.#sessions.set(id, session);
    return session;
  }

  /** Sessions matching a test (e.g. every session of one user). */
  filter(test) {
    return [...this.#sessions.values()].filter(test);
  }

  get(id) {
    const session = id ? this.#sessions.get(id) ?? this.#takeAdopted(id) : undefined;
    if (!session) return null;
    // The server's own integration session never idles out.
    if (!session.pinned && Date.now() - session.lastUsedAt > this.#idleMs) {
      this.#sessions.delete(id);
      return null;
    }
    session.lastUsedAt = Date.now();
    return session;
  }

  /**
   * Password sign-ins handed over by the previous server (an update): each is
   * picked up, with its fetched data, when its browser next calls.
   */
  adopt(entries, link) {
    this.#adoptLink = link;
    for (const entry of entries) this.#adopted.set(entry.key, entry);
    return this.#adopted.size;
  }

  #takeAdopted(id) {
    if (!this.#adopted.size) return undefined;
    const key = sessionKey(id);
    const entry = this.#adopted.get(key);
    if (!entry) return undefined;
    this.#adopted.delete(key);
    const session = this.createLinked(this.#adoptLink, id);
    Object.assign(session, { userId: entry.userId, via: entry.via, createdAt: entry.createdAt, lastUsedAt: entry.lastUsedAt, lastScan: entry.lastScan ?? null });
    return session;
  }

  /** What to hand over to the next server: password sign-ins (never one holding a person's own API key) and their fetched data. */
  toHandover() {
    const live = [...this.#sessions.values()]
      .filter((s) => s.linked && s.userId && !s.pinned && Date.now() - s.lastUsedAt <= this.#idleMs)
      .map(({ id, userId, via, createdAt, lastUsedAt, lastScan }) => ({ id, userId, via, createdAt, lastUsedAt, lastScan }));
    // Saved ones nobody has come back for yet are passed on again, as they were.
    return { live, adopted: [...this.#adopted.values()].filter((e) => Date.now() - e.lastUsedAt <= this.#idleMs) };
  }

  destroy(id) {
    return this.#sessions.delete(id);
  }

  sweep() {
    const cutoff = Date.now() - this.#idleMs;
    for (const [id, session] of this.#sessions) {
      if (!session.pinned && session.lastUsedAt < cutoff) this.#sessions.delete(id);
    }
  }

  get size() {
    return this.#sessions.size;
  }
}

/** Session details the browser is allowed to see (never the API key). */
export function describeSession(session) {
  let connection = null;
  try {
    connection = publicConnection(session.connection);
  } catch {
    // Signed in, but the server's Checkmarx One integration is not connected.
  }
  return {
    connected: Boolean(connection),
    signedIn: true,
    connection,
    hasScan: Boolean(session.lastScan),
    connectedAt: new Date(session.createdAt).toISOString(),
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
