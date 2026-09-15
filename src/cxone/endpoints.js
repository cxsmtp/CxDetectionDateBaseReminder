/**
 * Endpoint derivation.
 *
 * A Checkmarx One API key is a JWT whose `iss` claim points at the tenant's
 * realm, e.g. https://eu.iam.checkmarx.net/auth/realms/acme.  That single
 * claim gives us the IAM host, the tenant and (by regional convention) the
 * API host, so the operator only ever has to paste the key itself.
 */

/** Decode a JWT payload without verifying it — we only read routing claims. */
export function decodeApiKey(apiKey) {
  const payload = String(apiKey ?? '').trim().split('.')[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

const REGION_LABELS = {
  us: 'US',
  us2: 'US 2',
  eu: 'EU',
  eu2: 'EU 2',
  deu: 'Germany',
  anz: 'Australia / NZ',
  ind: 'India',
  sng: 'Singapore',
  uae: 'UAE',
  mea: 'Middle East',
};

/** Region slug from an IAM/API host, e.g. eu.iam.checkmarx.net -> "eu". */
export function regionFromHost(host) {
  const match = String(host).match(/^([a-z0-9-]+)\.(?:iam|ast)\./i);
  if (match) return match[1].toLowerCase();
  // The original US environment has no prefix: iam.checkmarx.net.
  return /^(?:iam|ast)\./i.test(host) ? 'us' : '';
}

export function regionLabel(region) {
  return REGION_LABELS[region] ?? (region ? region.toUpperCase() : 'Custom / single-tenant');
}

/**
 * The API host mirrors the IAM host with `iam` swapped for `ast`.  Newer
 * tenants serve both from the `ast` host, and single-tenant deployments use
 * neither name — both are left untouched.
 */
export function deriveApiUrl(iamUrl) {
  let url;
  try {
    url = new URL(iamUrl);
  } catch {
    return '';
  }

  const host = url.host.replace(/^iam\./i, 'ast.').replace(/\.iam\./i, '.ast.');
  return `${url.protocol}//${host}`;
}

const trimSlash = (value) => (value ? String(value).replace(/\/+$/, '') : '');

export class ConnectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConnectionError';
    this.status = 400;
  }
}

/**
 * Build a connection descriptor from an API key, letting the caller override
 * any derived value for on-prem or single-tenant deployments.
 *
 * @param {string} apiKey
 * @param {{baseUrl?: string, iamUrl?: string, tenant?: string}} [overrides]
 */
export function deriveConnection(apiKey, overrides = {}) {
  const key = String(apiKey ?? '').trim();
  if (!key) throw new ConnectionError('Paste your Checkmarx One API key to connect.');

  const claims = decodeApiKey(key);
  const issuer = typeof claims?.iss === 'string' ? claims.iss : '';
  const match = issuer.match(/^(https?:\/\/[^/]+)\/auth\/realms\/([^/?#]+)/);

  const iamUrl = trimSlash(overrides.iamUrl) || (match ? match[1] : '');
  const tenant = String(overrides.tenant ?? '').trim() || (match ? decodeURIComponent(match[2]) : '');
  const baseUrl = trimSlash(overrides.baseUrl) || deriveApiUrl(iamUrl);

  if (!iamUrl || !tenant) {
    throw new ConnectionError(
      claims
        ? 'That API key does not carry a tenant issuer claim. Open "Advanced" and enter the IAM URL and tenant manually.'
        : 'That does not look like a Checkmarx One API key (it should be a JWT with three dot-separated parts).',
    );
  }
  if (!baseUrl) {
    throw new ConnectionError('Could not work out the API URL. Open "Advanced" and enter it manually.');
  }

  const region = regionFromHost(new URL(iamUrl).host);

  return {
    apiKey: key,
    iamUrl,
    tenant,
    baseUrl,
    region,
    regionLabel: regionLabel(region),
    tokenUrl: `${iamUrl}/auth/realms/${encodeURIComponent(tenant)}/protocol/openid-connect/token`,
    expiresAt: typeof claims?.exp === 'number' ? new Date(claims.exp * 1000).toISOString() : null,
  };
}

/** The connection fields that are safe to hand back to the browser. */
export function publicConnection(connection) {
  const { apiKey, ...safe } = connection;
  return safe;
}
