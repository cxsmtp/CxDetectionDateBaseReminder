/**
 * Checkmarx One authentication.
 *
 * An API key is exchanged for a short-lived access token using the OIDC
 * refresh-token grant against the tenant's realm, with the well-known
 * `ast-app` public client.  Tokens are cached until shortly before expiry.
 */

export { decodeApiKey } from './endpoints.js';

const EXPIRY_SKEW_MS = 30_000;

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
  }
}

export class TokenProvider {
  #connection;
  #token = null;
  #expiresAt = 0;
  #inFlight = null;

  /** @param {{tokenUrl: string, apiKey: string}} connection */
  constructor(connection) {
    this.#connection = connection;
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
    const { tokenUrl, apiKey } = this.#connection;
    if (!tokenUrl) throw new AuthError('No Checkmarx One IAM URL is configured for this session.');
    if (!apiKey) throw new AuthError('No Checkmarx One API key is configured for this session.');

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: 'ast-app',
      refresh_token: apiKey,
    });

    let response;
    try {
      response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
    } catch (error) {
      throw new AuthError(`Could not reach the Checkmarx One IAM host at ${tokenUrl}: ${error.message}`, 502);
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      const hint =
        response.status === 400 || response.status === 401
          ? 'The API key is invalid, revoked or expired.'
          : detail;
      throw new AuthError(
        `Checkmarx One rejected the API key (${response.status} ${response.statusText}). ${hint}`.trim(),
      );
    }

    const data = await response.json();
    if (!data.access_token) throw new AuthError('Authentication response did not contain an access_token.');

    this.#token = data.access_token;
    const lifetimeMs = (Number(data.expires_in) || 600) * 1000;
    this.#expiresAt = Date.now() + Math.max(lifetimeMs - EXPIRY_SKEW_MS, 5_000);
    return this.#token;
  }
}
