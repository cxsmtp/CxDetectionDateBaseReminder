/*
 * Checkmarx One Report Connector — background service worker.
 *
 * Signs the reader in on their tenant's Checkmarx One login page (OAuth
 * authorization code + PKCE with the portal's public client), keeps the
 * session for as long as the browser is open, and makes the few AI Triage
 * calls a report needs. It never makes any other Checkmarx One call, so a
 * local file cannot use a signed-in session for anything else.
 */

const CLIENT_ID = 'ast-app';
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

const ALLOWED_CALLS = [
  { method: 'GET', path: /^\/api\/projects\?limit=1&offset=0$/ },
  { method: 'POST', path: /^\/api\/ai-triage\/triage$/ },
  { method: 'GET', path: /^\/api\/ai-triage\/triage\/[^/?#]+\/[^/?#]+$/ },
];

// ---------------------------------------------------------------------------
// Hosts: only the ones this extension has host permission for
// ---------------------------------------------------------------------------

function patternToRegExp(pattern) {
  const match = pattern.match(/^(\*|https?):\/\/([^/]+)(\/.*)$/);
  if (!match) return null;
  const [, scheme, host] = match;
  const hostPart = host === '*' ? '[^/:]+' : host.startsWith('*.')
    ? `(?:[^/:]+\\.)?${host.slice(2).replace(/[.]/g, '\\.')}`
    : host.replace(/[.]/g, '\\.');
  return new RegExp(`^${scheme === '*' ? 'https?' : scheme}://${hostPart}(?::\\d+)?/`, 'i');
}

const ALLOWED_HOSTS = (chrome.runtime.getManifest().host_permissions || []).map(patternToRegExp).filter(Boolean);
const hostAllowed = (url) => {
  try {
    const href = new URL(url).href;
    return ALLOWED_HOSTS.some((re) => re.test(href));
  } catch {
    return false;
  }
};

function checkTarget(target) {
  for (const field of ['iamUrl', 'apiBaseUrl', 'portalUrl']) {
    if (!hostAllowed(target[field])) {
      throw Object.assign(new Error(`The Report Connector does not work with ${target[field] || 'an empty address'}.`), { status: 0 });
    }
  }
  if (!target.tenant) throw new Error('The report does not name a Checkmarx One tenant.');
}

// ---------------------------------------------------------------------------
// Session storage (cleared when the browser closes)
// ---------------------------------------------------------------------------

const sessionKey = (t) => `session:${new URL(t.iamUrl).origin}|${t.tenant}`;

async function loadSession(t) {
  const key = sessionKey(t);
  return (await chrome.storage.session.get(key))[key] || null;
}

async function saveSession(t, tokens, fallbackRefresh = '') {
  await chrome.storage.session.set({
    [sessionKey(t)]: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || fallbackRefresh,
      expiresAt: Date.now() + Math.max(((Number(tokens.expires_in) || 300) - 30) * 1000, 5000),
    },
  });
}

const clearSession = (t) => chrome.storage.session.remove(sessionKey(t));

const tokenUrl = (t) => `${t.iamUrl}/auth/realms/${encodeURIComponent(t.tenant)}/protocol/openid-connect/token`;

async function tokenRequest(t, params) {
  const response = await fetch(tokenUrl(t), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }).toString(),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    const reason = body.error_description || body.error || `${response.status}`;
    throw Object.assign(new Error(`Checkmarx One did not accept the sign-in (${reason}).`), { status: 401 });
  }
  return body;
}

async function accessToken(t, force = false) {
  const session = await loadSession(t);
  if (!session) throw Object.assign(new Error('Not signed in to Checkmarx One.'), { status: 401 });
  if (!force && Date.now() < session.expiresAt) return session.accessToken;
  if (!session.refreshToken) {
    await clearSession(t);
    throw Object.assign(new Error('Your Checkmarx One session has ended. Connect again.'), { status: 401 });
  }
  try {
    await saveSession(t, await tokenRequest(t, { grant_type: 'refresh_token', refresh_token: session.refreshToken }), session.refreshToken);
  } catch (error) {
    await clearSession(t);
    throw Object.assign(new Error('Your Checkmarx One session has ended. Connect again.'), { status: 401 });
  }
  return (await loadSession(t)).accessToken;
}

// ---------------------------------------------------------------------------
// Sign-in on the Checkmarx One login page
// ---------------------------------------------------------------------------

const base64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = (length) => base64url(crypto.getRandomValues(new Uint8Array(length)));

/** Open the login page in a small window and wait for it to come back with a code. */
function waitForCode(windowId, tabId, redirectUri, state) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.windows.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
    };
    const finish = (fn, value) => {
      cleanup();
      chrome.windows.remove(windowId).catch(() => {});
      fn(value);
    };
    const onUpdated = (id, change) => {
      if (id !== tabId || !change.url) return;
      const url = new URL(change.url);
      // Only the exact return address counts, never the login pages on the way.
      if (url.origin + url.pathname !== redirectUri) return;
      const params = url.searchParams.get('state') ? url.searchParams : new URLSearchParams(url.hash.slice(1));
      if (params.get('state') !== state) return;
      if (params.get('code')) finish(resolve, params.get('code'));
      else finish(reject, new Error(`Sign-in was not completed (${params.get('error_description') || params.get('error') || 'no code'}).`));
    };
    const onRemoved = (id) => {
      if (id !== windowId) return;
      cleanup();
      reject(new Error(
        'The sign-in window was closed before sign-in finished. If it showed "Invalid parameter: redirect_uri", ' +
          'this tenant does not allow the connector to sign in — use an API key or the reminder server instead.',
      ));
    };
    const timer = setTimeout(() => finish(reject, new Error('Sign-in timed out.')), SIGN_IN_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.windows.onRemoved.addListener(onRemoved);
  });
}

async function signIn(t) {
  checkTarget(t);
  const verifier = randomString(48);
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = randomString(16);
  const redirectUri = new URL('/', t.portalUrl).href;

  const authUrl = new URL(`${t.iamUrl}/auth/realms/${encodeURIComponent(t.tenant)}/protocol/openid-connect/auth`);
  authUrl.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: 'openid',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();

  const win = await chrome.windows.create({ url: authUrl.href, type: 'popup', width: 520, height: 720, focused: true });
  const code = await waitForCode(win.id, win.tabs[0].id, redirectUri, state);
  const tokens = await tokenRequest(t, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
  await saveSession(t, tokens);
  return { ok: true, tenant: t.tenant };
}

async function signInWithKey(t, apiKey) {
  checkTarget(t);
  if (!apiKey) throw new Error('Paste an API key first.');
  // An API key is an offline refresh token for the same client.
  await saveSession(t, await tokenRequest(t, { grant_type: 'refresh_token', refresh_token: apiKey }), apiKey);
  return { ok: true, tenant: t.tenant };
}

// ---------------------------------------------------------------------------
// The allowed Checkmarx One calls
// ---------------------------------------------------------------------------

function cleanBody(method, path, body) {
  if (method !== 'POST') return undefined;
  // POST /api/ai-triage/triage: forward exactly the documented fields.
  const buckets = Array.isArray(body?.buckets) ? body.buckets : [];
  return {
    scanID: String(body?.scanID ?? ''),
    buckets: buckets.map((b) => ({
      scannerType: /^(sast|sca)$/i.test(b?.scannerType) ? String(b.scannerType).toLowerCase() : 'sast',
      resultIDs: (Array.isArray(b?.resultIDs) ? b.resultIDs : []).map(String).slice(0, 500),
    })),
  };
}

async function callApi(t, { method, path, body }) {
  checkTarget(t);
  if (!ALLOWED_CALLS.some((call) => call.method === method && call.path.test(String(path)))) {
    return { error: 'The Report Connector only makes the AI Triage calls a report needs.' };
  }
  const url = new URL(path, t.apiBaseUrl);
  if (!hostAllowed(url.href)) return { error: 'That Checkmarx One address is not allowed.' };
  const payload = cleanBody(method, path, body);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(url.href, {
      method,
      headers: {
        Authorization: `Bearer ${await accessToken(t, attempt > 0)}`,
        Accept: 'application/json; version=1.0',
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
    });
    if (response.status === 401 && attempt === 0) continue;
    return { status: response.status, text: await response.text() };
  }
  return { status: 401, text: '' };
}

// ---------------------------------------------------------------------------
// Messages from report pages (via content.js)
// ---------------------------------------------------------------------------

async function handle(request) {
  const target = {
    iamUrl: String(request.iamUrl || ''),
    tenant: String(request.tenant || ''),
    apiBaseUrl: String(request.apiBaseUrl || ''),
    portalUrl: String(request.portalUrl || request.apiBaseUrl || ''),
  };
  switch (request.op) {
    case 'status': {
      checkTarget(target);
      return { ok: true, signedIn: Boolean(await loadSession(target)), tenant: target.tenant };
    }
    case 'signin':
      return signIn(target);
    case 'signin-key':
      return signInWithKey(target, String(request.apiKey || '').trim());
    case 'signout':
      await clearSession(target);
      return { ok: true };
    case 'api':
      return callApi(target, request);
    default:
      return { error: 'Unknown request.' };
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !sender.tab) return false;
  handle(request)
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error.message, status: error.status || 0 }));
  return true;
});
