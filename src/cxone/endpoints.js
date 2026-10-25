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
 * Checkmarx One addresses (from the API key's `iss` claim, or typed by an Admin) are only ever
 * hosts the key and its tokens may be sent to: https, a real host name or ordinary IP address,
 * no user name or password, no query. Never a link-local or cloud metadata address, and this
 * machine (plain http allowed, for a local mock) only outside production.
 */
const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const METADATA_HOSTS = new Set(['metadata', 'metadata.google.internal', 'metadata.goog', 'instance-data', 'instance-data.ec2.internal', 'metadata.azure.internal']);
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

function ipv4Parts(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return m ? m.slice(1).map(Number) : null;
}

/** The IPv4 address an IPv4-mapped or -compatible IPv6 literal carries (URL writes `::ffff:a9fe:a9fe`), if any. */
function embeddedIpv4(v6) {
  const m = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255];
}

function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (LOOPBACK_NAMES.has(host) || host.endsWith('.localhost')) return true;
  const v4 = ipv4Parts(host) ?? (host.includes(':') ? embeddedIpv4(host) : null);
  return Boolean(v4 && v4[0] === 127) || host === '::1';
}

/** Link-local, metadata, unspecified, multicast and reserved addresses: never a Checkmarx One host. */
function isForbiddenIp(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const v4 = ipv4Parts(host) ?? (host.includes(':') ? embeddedIpv4(host) : null);
  if (v4) {
    const [a, b] = v4;
    return a === 0 || (a === 169 && b === 254) || a >= 224 || v4.join('.') === '100.100.100.200' || v4.join('.') === '168.63.129.16';
  }
  if (!host.includes(':')) return false;
  return host === '::' || /^fe[89ab][0-9a-f]:/.test(host) || /^ff[0-9a-f]{2}:/.test(host) || host === 'fd00:ec2::254';
}

const isProduction = () => process.env.NODE_ENV === 'production';

/**
 * Check a Checkmarx One address before any request uses it, and return it normalised
 * (`https://host[:port][/path]`, no trailing slash). Throws a ConnectionError that names the
 * problem and only the host, never the rest of the address.
 *
 * @param {string} value
 * @param {string} [label]  "IAM URL" or "API URL", for the message.
 */
export function checkServiceUrl(value, label = 'address') {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw new ConnectionError(`The Checkmarx One ${label} is not a valid address.`);
  }
  const hostname = url.hostname.toLowerCase();
  const shown = `${url.protocol}//${url.host}`;
  if (url.username || url.password) throw new ConnectionError(`The Checkmarx One ${label} must not carry a user name or password.`);
  const loopback = isLoopbackHost(hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback && !isProduction()))) {
    throw new ConnectionError(`The Checkmarx One ${label} must be an https address: ${shown}`);
  }
  if (url.search || url.hash) throw new ConnectionError(`The Checkmarx One ${label} must be a plain address, without "?" or "#": ${shown}`);
  if (loopback) {
    if (isProduction()) throw new ConnectionError(`The Checkmarx One ${label} points at this machine (${hostname}), which is never Checkmarx One.`);
  } else if (isForbiddenIp(hostname) || METADATA_HOSTS.has(hostname)) {
    throw new ConnectionError(`The Checkmarx One ${label} points at a link-local or cloud metadata address (${hostname}), which is never Checkmarx One.`);
  } else if (!hostname.startsWith('[') && !ipv4Parts(hostname) && (!HOST_RE.test(hostname) || !hostname.includes('.'))) {
    throw new ConnectionError(`The Checkmarx One ${label} needs a full host name, such as eu.ast.checkmarx.net: ${shown}`);
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Remove credentials from text bound for an error message, a log or the browser: bearer
 * tokens, JWTs (access tokens and API keys alike), signed-address signatures and other
 * secret query parameters, and passwords in URLs.
 */
const MASKED_PARAMS = /([?&;](?:x-amz-signature|x-amz-credential|x-amz-security-token|sig|signature|token|access_token|refresh_token|id_token|api_?key|apikey|client_secret|password|code)=)[^&\s"'<>]+/gi;
export function scrubText(text) {
  if (text === undefined || text === null) return text;
  return String(text)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [hidden]')
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, '[hidden token]')
    .replace(/("(?:access_token|refresh_token|id_token|apiKey|api_key|client_secret|password)"\s*:\s*")[^"]*"/gi, '$1[hidden]"')
    .replace(MASKED_PARAMS, '$1[hidden]')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@:]+:[^/\s@]+@/gi, '$1[hidden]@');
}

/**
 * Build a connection descriptor from an API key, letting the caller override
 * any derived value for on-prem or single-tenant deployments. The key is only
 * decoded, not verified: its `iss` just says where to exchange it, and that
 * address is checked by checkServiceUrl() before anything is sent there.
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

  const rawIam = trimSlash(overrides.iamUrl) || (match ? match[1] : '');
  let tenant = String(overrides.tenant ?? '').trim();
  if (!tenant && match) {
    try {
      tenant = decodeURIComponent(match[2]);
    } catch {
      throw new ConnectionError('That API key carries a tenant name that cannot be read. Open "Advanced" and enter the tenant manually.');
    }
  }
  if (/[\u0000-\u001f\u007f]/.test(tenant) || tenant.length > 255) throw new ConnectionError('That tenant name is not valid.');

  if (!rawIam || !tenant) {
    throw new ConnectionError(
      claims
        ? 'That API key does not carry a tenant issuer claim. Open "Advanced" and enter the IAM URL and tenant manually.'
        : 'That does not look like a Checkmarx One API key (it should be a JWT with three dot-separated parts).',
    );
  }
  // The key and its tokens only travel to checked addresses: https, a real host, never a metadata
  // address (plain http only to this machine, for a local mock, outside production).
  const iamUrl = checkServiceUrl(rawIam, 'IAM URL');
  const rawBase = trimSlash(overrides.baseUrl) || deriveApiUrl(iamUrl);
  if (!rawBase) {
    throw new ConnectionError('Could not work out the API URL. Open "Advanced" and enter it manually.');
  }
  const baseUrl = checkServiceUrl(rawBase, 'API URL');

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
