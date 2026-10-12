/**
 * Is the code running here exactly what this repository's release workflow built?
 *
 *  - Files: every file of the running version against the file list the build wrote
 *    (integrity.json); a changed, missing or added file is found at once, with no network.
 *  - Origin: GitHub's build attestation of that file list (signed by the release workflow with
 *    Sigstore, recorded in its public log) is fetched from api.github.com and checked here
 *    (sigstore.js). Once confirmed for a file list, that answer is kept in the data folder, so a
 *    server without internet still knows after a restart.
 *
 * Checked at start and every 6 hours (INTEGRITY_CHECK_HOURS), and before an update is installed or
 * a version is switched to. States: genuine, tampered (files differ), not-genuine (no valid
 * signature for the file list), unconfirmed (files match; GitHub could not be asked yet), unsigned
 * (no file list: a development copy, or a version older than MZ-01.00.72).
 */
import fs from 'node:fs';
import path from 'node:path';

import { MANIFEST_FILE, TOP_FILES, TREES, compareFiles, readManifest, sha256 } from './manifest.js';
import { verifyBundle } from './sigstore.js';

export const SOURCE_REPOSITORY = 'cxsmtp/CxDetectionDateBaseReminder';
const TRUSTED_ROOT = JSON.parse(fs.readFileSync(new URL('./trusted-root.json', import.meta.url), 'utf8'));
// Tests only (never in the image, which runs with NODE_ENV=production): another attestations API and trust root.
const TESTING = process.env.NODE_ENV !== 'production';
const API = (TESTING && process.env.MZ_INTEGRITY_API) || 'https://api.github.com';
const testRoot = () => (TESTING && process.env.MZ_INTEGRITY_TRUST_ROOT ? JSON.parse(fs.readFileSync(process.env.MZ_INTEGRITY_TRUST_ROOT, 'utf8')) : null);
const FIRST = 20;

const trim = (r) => ({ ok: r.ok, checked: r.checked, changed: r.changed.slice(0, FIRST), missing: r.missing.slice(0, FIRST), extra: r.extra.slice(0, FIRST), counts: { changed: r.changed.length, missing: r.missing.length, extra: r.extra.length } });

/** The files of an update (Map of path → Buffer) against the file list among them. */
export function compareFileMap(files) {
  const text = files.get(MANIFEST_FILE);
  if (!text) return null;
  let manifest;
  try {
    manifest = JSON.parse(text.toString('utf8'));
  } catch {
    return { digest: sha256(text), error: 'The file list cannot be read.' };
  }
  const listed = manifest?.files ?? {};
  const changed = [];
  const missing = [];
  for (const [file, hash] of Object.entries(listed)) {
    const data = files.get(file);
    if (!data) missing.push(file);
    else if (sha256(data) !== hash) changed.push(file);
  }
  const covered = (file) => TOP_FILES.includes(file) || TREES.some((t) => file.startsWith(`${t}/`) && !file.startsWith('node_modules/.bin/') && file !== 'node_modules/.package-lock.json');
  const extra = [...files.keys()].filter((f) => covered(f) && !(f in listed));
  return { digest: sha256(text), manifest, ...trim({ ok: !changed.length && !missing.length && !extra.length, checked: Object.keys(listed).length, changed, missing, extra }) };
}

export class IntegrityService {
  #cacheFile;
  #timer = null;
  #last = null;
  #running = null;

  constructor({ appDir, dataDir, repository = process.env.MZ_SOURCE_REPOSITORY || SOURCE_REPOSITORY, fetch = globalThis.fetch, token = '', record = () => {}, trustedRoot = testRoot() ?? TRUSTED_ROOT, api = API, timeoutMs = 15_000 }) {
    this.api = api;
    this.appDir = appDir;
    this.repository = repository;
    this.fetch = fetch;
    this.token = token;
    this.record = record;
    this.trustedRoot = trustedRoot;
    this.timeoutMs = timeoutMs;
    this.#cacheFile = path.join(dataDir, 'integrity-origin.json');
  }

  get last() {
    return this.#last;
  }

  /** GitHub's attestations of a file list (by its SHA-256), each checked; the first good one wins. */
  async verifyOrigin(digest) {
    const cached = this.#cached(digest);
    if (cached) return { ...cached, cached: true };
    const url = `${this.api}/repos/${this.repository}/attestations/sha256:${digest}`;
    let response;
    try {
      response = await this.fetch(url, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'cxmissionzero-integrity', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return { ok: false, reachable: false, reason: `GitHub could not be reached (${error.cause?.code ?? error.message})` };
    }
    if (response.status === 404) return { ok: false, reachable: true, reason: 'GitHub has no build attestation for this file list' };
    if (!response.ok) return { ok: false, reachable: false, reason: `GitHub answered ${response.status}` };
    const body = await response.json().catch(() => ({}));
    let firstReason = '';
    for (const item of body.attestations ?? []) {
      let bundle = item.bundle;
      if (!bundle && item.bundle_url) bundle = await this.#download(item.bundle_url);
      if (!bundle) continue;
      const result = verifyBundle(bundle, { digest, trustedRoot: this.trustedRoot, repository: this.repository });
      if (result.ok) {
        this.#remember(digest, result);
        return result;
      }
      firstReason ||= result.reason;
    }
    return { ok: false, reachable: true, reason: firstReason || 'GitHub has no build attestation for this file list' };
  }

  async #download(url) {
    try {
      const response = await this.fetch(url, { headers: { 'User-Agent': 'cxmissionzero-integrity' }, signal: AbortSignal.timeout(this.timeoutMs) });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  }

  #cached(digest) {
    try {
      const all = JSON.parse(fs.readFileSync(this.#cacheFile, 'utf8'));
      return all?.[digest]?.ok ? all[digest] : null;
    } catch {
      return null;
    }
  }

  #remember(digest, result) {
    let all = {};
    try {
      all = JSON.parse(fs.readFileSync(this.#cacheFile, 'utf8')) ?? {};
    } catch {}
    all[digest] = result;
    const keep = Object.fromEntries(Object.entries(all).slice(-20));
    try {
      fs.writeFileSync(this.#cacheFile, JSON.stringify(keep), { mode: 0o600 });
    } catch {}
  }

  /** Files and origin of the running version. One check at a time; callers share it. */
  check({ reason = 'scheduled' } = {}) {
    this.#running ??= this.#check(reason).finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #check(reason) {
    const at = new Date().toISOString();
    const read = readManifest(this.appDir);
    let result;
    if (!read) {
      result = { at, state: 'unsigned', summary: 'No signed file list: this copy was not built by the release workflow (a development copy, or a version older than MZ-01.00.72).' };
    } else if (read.error) {
      result = { at, state: 'tampered', digest: read.digest, summary: read.error };
    } else {
      const files = trim(compareFiles(this.appDir, read.manifest));
      const origin = await this.verifyOrigin(read.digest);
      const version = read.manifest.version;
      const base = { at, version, commit: read.manifest.commit, digest: read.digest, files, origin };
      if (!files.ok) {
        const n = files.counts.changed + files.counts.missing + files.counts.extra;
        result = { ...base, state: 'tampered', summary: `${n} file${n === 1 ? '' : 's'} differ from what the release workflow built (${files.counts.changed} changed, ${files.counts.missing} missing, ${files.counts.extra} added).` };
      } else if (origin.ok) {
        result = { ...base, state: 'genuine', summary: `Genuine: all ${files.checked} files are exactly what ${origin.repository}'s release workflow built from ${origin.ref.replace(/^refs\/(heads|tags)\//, '')} (commit ${origin.commit.slice(0, 12)}), signed ${origin.signedAt.slice(0, 16).replace('T', ' ')} UTC and recorded in Sigstore's public log.` };
      } else if (origin.reachable === false) {
        result = { ...base, state: 'unconfirmed', summary: `All ${files.checked} files match their list; who built it is not confirmed yet: ${origin.reason}.` };
      } else {
        result = { ...base, state: 'not-genuine', summary: `The files match their list, but the list is not signed by ${this.repository}'s release workflow: ${origin.reason}.` };
      }
    }
    const before = this.#last?.state;
    this.#last = { ...result, reason };
    if (result.state !== before && ['tampered', 'not-genuine'].includes(result.state)) this.record({ outcome: 'failure', reason: `Software integrity: ${result.summary}`, details: { state: result.state, digest: result.digest, files: result.files } });
    else if (result.state === 'genuine' && before !== 'genuine') this.record({ outcome: 'info', reason: `Software integrity: ${result.summary}`, details: { state: result.state, digest: result.digest, commit: result.origin?.commit } });
    return this.#last;
  }

  start(hours = Number(process.env.INTEGRITY_CHECK_HOURS) || 6) {
    setTimeout(() => this.check({ reason: 'start' }).catch(() => {}), 5_000).unref?.();
    this.#timer = setInterval(() => this.check().catch(() => {}), Math.max(0.1, hours) * 3_600_000);
    this.#timer.unref?.();
  }
}
