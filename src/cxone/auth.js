/**
 * Checkmarx One authentication.
 *
 * An API key is exchanged for a short-lived access token using the OIDC
 * refresh-token grant against the tenant's realm, with the well-known
 * `ast-app` public client.  Tokens are cached until shortly before expiry.
 */

/** Decode a JWT payload without verifying it (we only read routing claims). */
export function decodeApiKey(apiKey) {
  const payload = String(apiKey ?? '').split('.')[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

const EXPIRY_SKEW_MS = 30_000;

export class TokenProvider {
  #config;
  #token = null;
  #expiresAt = 0;
  #inFlight = null;

  constructor(config) {
    this.#config = config;
  }

  /** Drop the cached token; the next call re-authenticates. */
  reset() {
    this.#token = null;
    this.#expiresAt = 0;
    this.#inFlight = null;
  }

  async getToken() {
    if (this.#token && Date.now() < this.#expiresAt) return this.#token;
    // Collapse concurrent refreshes into a single token request.
    this.#inFlight ??= this.#fetchToken().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #fetchToken() {
    const { tokenUrl, apiKey } = this.#config;
    if (!tokenUrl) throw new Error('Checkmarx One IAM URL/tenant is not configured.');
    if (!apiKey) throw new Error('CX_API_KEY is not set.');

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: 'ast-app',
      refresh_token: apiKey,
    });

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 500);
      throw new Error(
        `Checkmarx One authentication failed (${response.status} ${response.statusText}). ${detail}`.trim(),
      );
    }

    const data = await response.json();
    if (!data.access_token) throw new Error('Authentication response did not contain an access_token.');

    this.#token = data.access_token;
    const lifetimeMs = (Number(data.expires_in) || 600) * 1000;
    this.#expiresAt = Date.now() + Math.max(lifetimeMs - EXPIRY_SKEW_MS, 5_000);
    return this.#token;
  }
}
