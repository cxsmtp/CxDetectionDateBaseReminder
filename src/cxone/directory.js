import { extractItems } from './client.js';

/**
 * Turning a Checkmarx username into an email address.
 *
 * Scan initiators arrive as two shapes in the same tenant: some are already
 * addresses (`avery.speller@checkmarx.com`), others are usernames
 * (`cx-julian-chuan`). The second kind is what makes reminders unsendable, so
 * this module resolves them three ways, strongest first:
 *
 *   1. the tenant's IAM directory, fetched once and matched locally
 *   2. the naming pattern the *already-resolved* initiators reveal, which
 *      gives a high-confidence suggestion without any directory access
 *   3. an explicit default domain the administrator configured
 *
 * (2) is the important one: a suggestion the operator only has to confirm is
 * far less work than typing every address, and the pattern is right there in
 * the data.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Service-account and tooling prefixes that are not part of a person's name. */
const NOISE_PREFIXES = ['cx-', 'cx_', 'svc-', 'svc_', 'sa-', 'sa_', 'ast-'];

/**
 * `cx-julian-chuan` -> `julian.chuan`, which is the local part the same tenant
 * uses for people whose address is already known.
 */
export function normalizeUsername(username) {
  let name = String(username ?? '').trim().toLowerCase();
  if (!name) return '';
  if (name.includes('@')) name = name.split('@')[0];

  for (const prefix of NOISE_PREFIXES) {
    if (name.startsWith(prefix)) {
      name = name.slice(prefix.length);
      break;
    }
  }

  return name
    .replace(/[\s_-]+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.|\.$/g, '');
}

/** The domain most of the known addresses use, which new ones likely share. */
export function dominantDomain(emails) {
  const counts = new Map();
  for (const email of emails) {
    const domain = String(email ?? '').split('@')[1]?.toLowerCase();
    if (domain) counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  if (counts.size === 0) return '';
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// ---------------------------------------------------------------------------

/**
 * Every user in the tenant's IAM realm, fetched once.
 *
 * This is the Keycloak admin API behind Checkmarx One. It needs an API key
 * with IAM read access, so being refused is an ordinary outcome: the caller
 * falls back to pattern matching, which needs no extra permission.
 */
export async function fetchDirectory(client, connection, { max = 2000 } = {}) {
  if (!connection?.iamUrl || !connection?.tenant) {
    return { users: [], note: 'No IAM URL for this connection, so the user directory was not read.' };
  }

  const base = `${connection.iamUrl}/auth/admin/realms/${encodeURIComponent(connection.tenant)}/users`;
  const users = [];
  const pageSize = 200;

  try {
    for (let first = 0; first < max; first += pageSize) {
      const page = await client.request(`${base}?first=${first}&max=${pageSize}&briefRepresentation=true`, {
        retries: 0,
      });
      const batch = extractItems(page);
      if (batch.length === 0) break;

      for (const user of batch) {
        const email = String(user?.email ?? '').trim().toLowerCase();
        users.push({
          username: String(user?.username ?? '').trim().toLowerCase(),
          email: EMAIL_RE.test(email) ? email : '',
          firstName: String(user?.firstName ?? '').trim(),
          lastName: String(user?.lastName ?? '').trim(),
        });
      }
      if (batch.length < pageSize) break;
    }
    return { users, note: null };
  } catch (error) {
    const reason =
      error.status === 401 || error.status === 403
        ? 'The API key does not have IAM read access, so usernames were matched by pattern instead.'
        : `The IAM user directory could not be read (${error.message}), so usernames were matched by pattern instead.`;
    return { users, note: reason };
  }
}

/** Index a directory for the lookups below. */
export function indexDirectory(users) {
  const byUsername = new Map();
  const byLocalPart = new Map();
  const byFullName = new Map();

  for (const user of users) {
    if (!user.email) continue;
    if (user.username) byUsername.set(user.username, user);
    byLocalPart.set(user.email.split('@')[0], user);

    const full = `${user.firstName}.${user.lastName}`.toLowerCase().replace(/\s+/g, '.');
    if (full.length > 1) byFullName.set(full, user);

    // Usernames often carry a prefix the directory entry does not.
    const normalized = normalizeUsername(user.username || user.email);
    if (normalized) byUsername.set(normalized, user);
  }

  return { byUsername, byLocalPart, byFullName, size: users.length };
}

/**
 * Best address for one initiator.
 *
 * @returns {{email: string, via: string, confidence: 'exact'|'likely'|'guess'|'none'}}
 *   `exact` came from the directory and can be used unattended; `likely` and
 *   `guess` are suggestions the operator should confirm.
 */
export function suggestEmail(initiator, { index = null, domain = '', overrides = {} } = {}) {
  const raw = String(initiator ?? '').trim();
  if (!raw) return { email: '', via: 'none', confidence: 'none' };

  const override = overrides[raw] ?? overrides[raw.toLowerCase()];
  if (override && EMAIL_RE.test(override)) return { email: override, via: 'override', confidence: 'exact' };

  if (EMAIL_RE.test(raw)) return { email: raw.toLowerCase(), via: 'username', confidence: 'exact' };

  const normalized = normalizeUsername(raw);

  if (index) {
    const hit =
      index.byUsername.get(raw.toLowerCase()) ??
      index.byUsername.get(normalized) ??
      index.byLocalPart.get(normalized) ??
      index.byFullName.get(normalized);
    if (hit?.email) return { email: hit.email, via: 'directory', confidence: 'exact' };
  }

  // No directory hit: follow the naming pattern the tenant's known addresses
  // already demonstrate. Only offered when the username looks like a person's
  // name, so a service account does not silently become someone's address.
  if (domain && normalized.includes('.')) {
    const candidate = `${normalized}@${domain}`;
    if (EMAIL_RE.test(candidate)) return { email: candidate, via: 'pattern', confidence: 'likely' };
  }

  if (domain && normalized) {
    const candidate = `${normalized}@${domain}`;
    if (EMAIL_RE.test(candidate)) return { email: candidate, via: 'pattern', confidence: 'guess' };
  }

  return { email: '', via: 'unresolved', confidence: 'none' };
}
