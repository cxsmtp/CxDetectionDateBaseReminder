/**
 * Data a tenant read from the first tenant's Checkmarx One, set aside once (from MZ-01.01.21).
 *
 * Until MZ-01.01.20, the deployment's endpoints (CX_BASE_URL, CX_IAM_URL, CX_TENANT: the first tenant's) filled in
 * the endpoints of every tenant's key. A tenant added later and connected with a key alone read the first tenant's
 * Checkmarx One: its Workbench loads, the Impact page's history, the calculator's read and the rest. Now each tenant
 * reconnects where its own key says (src/routes/integration-session.js), and what such a tenant kept from the first
 * tenant must not stay there. This runs at start-up, before any tenant's stores are opened:
 *
 * - a tenant other than the first, with a stored key and no endpoints of its own, on a server started with
 *   endpoints in its environment, whose key goes somewhere else without them, read the first tenant's data;
 * - for such a tenant, every file made from Checkmarx One reads is moved to set-aside-<date>/ in its folder (never
 *   deleted), with its last good copy, and the last read is taken out of Fusion credits and Primary branches (their
 *   settings and allocations stay);
 * - from MZ-01.01.22, also a tenant whose own stored key is for the first tenant's Checkmarx One (connected with
 *   "the key you signed in with" by someone signed in with a key of the first tenant's): that key is no longer used
 *   in it (src/routes/integration-session.js), and what it read is set aside the same way;
 * - each tenant is looked at once for each check: cxone-origin.json in its folder says which were made (`checks`).
 *
 * What was done through that connection (triage, remediation, credit allocations, FAE Flush) happened in the first
 * tenant's Checkmarx One and cannot be undone here: the tenant's audit log names it, and the note says so.
 */
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_TENANT, ORIGIN_FILE } from './tenancy.js';
import { readState, writeState, lastGoodCopy } from './state-file.js';

/** Files made only from what was read from Checkmarx One: moved aside whole. */
export const READ_FILES = ['finding-journal.json', 'projection-read.json', 'known-initiators.json', 'scan-attribution.json', 'fae-flush.json', 'fae-flush-history.json'];
/** Files that also hold an Admin's own choices: only their last read (`read`) is taken out. */
export const READ_PARTS = ['fusion-credits.json', 'branch-settings.json'];
const MARKER = ORIGIN_FILE;

const same = (a, b) => a.tenant === b.tenant && a.baseUrl === b.baseUrl && a.iamUrl === b.iamUrl;

/** Two Checkmarx One connections to the same tenant: the same tenant name at the same IAM host. */
const sameTenant = (a, b) => {
  const host = (url) => {
    try {
      return new URL(url).host.toLowerCase();
    } catch {
      return '';
    }
  };
  return Boolean(a?.tenant && b?.tenant) && String(a.tenant).toLowerCase() === String(b.tenant).toLowerCase() && host(a.iamUrl) === host(b.iamUrl);
};
/** The checks made so far (MZ-01.01.21: the deployment's endpoints; MZ-01.01.22: the first tenant's own key too). */
const CHECKS = 2;

/** Move what a tenant read from Checkmarx One into set-aside-<date>/ in its folder; resolves what was moved and cleared. */
function setAside(dir, now) {
  const folder = path.join(dir, `set-aside-${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}`);
  const moved = [];
  const cleared = [];
  for (const name of READ_FILES) {
    for (const file of [path.join(dir, name), lastGoodCopy(path.join(dir, name))]) {
      if (!fs.existsSync(file)) continue;
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      fs.renameSync(file, path.join(folder, path.basename(file)));
      if (!file.endsWith('.bak')) moved.push(name);
    }
  }
  for (const name of READ_PARTS) {
    const file = path.join(dir, name);
    const data = fs.existsSync(file) || fs.existsSync(lastGoodCopy(file)) ? readState(file, { fallback: null }) : null;
    if (!data || typeof data !== 'object' || !data.read) continue;
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(folder, name), JSON.stringify(data), { mode: 0o600 });
    writeState(file, { ...data, read: null }, { keepLast: false });
    cleared.push(name);
  }
  return { moved, cleared, folder: path.basename(folder) };
}

/**
 * @param {object} o
 * @param {{ ids(): string[], dirOf(id: string): string }} o.tenancy
 * @param {{ baseUrl?: string, iamUrl?: string, tenant?: string }} o.environment  the deployment's endpoints
 * @param {(file: string) => object} o.readSettings  a tenant's settings (its stored key decrypted)
 * @param {(key: string, overrides: object) => { tenant: string, baseUrl: string, iamUrl: string }} o.connectionOf
 * @param {{ tenant: string, iamUrl: string } | null} o.first  the first tenant's Checkmarx One (null: not connected)
 * @returns {Array<{ id, from, to, why, moved: string[], cleared: string[], folder }>}  the tenants whose data was set aside
 */
export function setAsideFirstTenantReads({ tenancy, environment, readSettings, connectionOf, first = null, now = new Date() }) {
  const pinned = Boolean(environment?.baseUrl || environment?.iamUrl || environment?.tenant);
  const out = [];
  for (const id of tenancy.ids()) {
    if (id === DEFAULT_TENANT) continue;
    const dir = tenancy.dirOf(id);
    const marker = path.join(dir, MARKER);
    const before = fs.existsSync(marker) ? readState(marker, { fallback: {} }) ?? {} : null;
    if ((before?.checks ?? 1) >= CHECKS) continue;
    let note = { ...(before ?? {}), checkedAt: now.toISOString(), checks: CHECKS, setAside: Boolean(before?.setAside) };
    try {
      const settings = readSettings(path.join(dir, 'settings.json'));
      const key = settings?.automationApiKey;
      const own = settings?.integrationOverrides ?? {};
      if (key) {
        const connects = connectionOf(key, own);
        note.connects = { tenant: connects.tenant, baseUrl: connects.baseUrl };
        let from = null;
        let why = '';
        // Never checked (from before MZ-01.01.21): the first tenant's endpoints took its key there.
        if (!before && pinned) {
          const pinnedTo = connectionOf(key, { baseUrl: own.baseUrl || environment.baseUrl, iamUrl: own.iamUrl || environment.iamUrl, tenant: own.tenant || environment.tenant });
          if (!same(pinnedTo, connects)) [from, why] = [pinnedTo, 'endpoints'];
        }
        // Its own key is the first tenant's Checkmarx One's: everything it read came from there.
        if (!from && first && sameTenant(connects, first)) [from, why] = [connects, 'first-key'];
        if (from) {
          const done = setAside(dir, now);
          note = { ...note, setAside: true, from: { tenant: from.tenant, baseUrl: from.baseUrl }, why, folder: done.folder, moved: done.moved, cleared: done.cleared };
          out.push({ id, from, to: connects, why, ...done });
        }
      }
    } catch (error) {
      // Not readable now (a key that cannot be read, a damaged file): looked at again on the next start.
      console.warn(`! [tenants] ${id}: could not check where its Checkmarx One data came from: ${error.message}`);
      continue;
    }
    writeState(marker, note, { space: 2 });
  }
  return out;
}
