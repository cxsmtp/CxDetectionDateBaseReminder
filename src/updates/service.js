/**
 * Settings → Update & recovery: everything an Admin needs after deployment
 * without signing in to the server.
 *
 *  - Check: the versions published for this image (every build, newest first).
 *  - Install any of them: only the app's own layers are downloaded and checked
 *    against their digests, kept in the data volume, then the launcher
 *    switches to it the way a container update would (a few seconds of
 *    "reconnecting…"), and rolls back by itself if it does not come up.
 *  - Roll back to any installed version, or the image's own, in one click.
 *  - Auto-update (off until an Admin turns it on): installs a newer release
 *    when it appears, in an optional hour of the day, never one that already
 *    failed to start.
 *  - Restart, and a troubleshooting summary.
 *
 * A new Node.js / OS base (rare) needs the image itself to be replaced: the
 * page says so and offers the full image update (companion) or the command.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ImageRegistry, UpdateError, appLayers, untarLayer } from './registry.js';
import { BUILT_IN, compareVersions } from './store.js';

const VERSION_LABEL = 'io.cxmissionzero.version';
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const LIST_LIMIT = 40;

const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};

/** The changelog entries newer than `current` (the "what's new" of an update). */
export function changesSince(changelog, current, limit = 8) {
  const out = [];
  for (const block of String(changelog ?? '').split(/^## /m).slice(1)) {
    const match = block.match(/^MZ-(\d+)\.(\d+)\.(\d+)/);
    if (!match) continue;
    const version = [match[1], match[2], match[3]].map(Number).join('.');
    if (compareVersions(version, current) <= 0) continue;
    const bullets = [...block.matchAll(/^- \*\*([^*]+)\*\*/gm)].map((m) => m[1].replace(/\.$/, '')).slice(0, 8);
    out.push({ version, highlights: bullets });
    if (out.length >= limit) break;
  }
  return out;
}

export class UpdateService {
  #registry;
  #settingsFile;
  #cacheFile;
  #job = null;

  constructor({ store, runningVersion, image, token = '', supervised = false, record = () => {}, beforeSwitch = async () => {}, switchTo = () => {}, fetch: fetchImpl, arch } = {}) {
    this.store = store;
    this.runningVersion = runningVersion;
    this.supervised = supervised;
    this.record = record;
    this.beforeSwitch = beforeSwitch;
    this.switchTo = switchTo;
    this.#registry = () => new ImageRegistry({ image, token, fetch: fetchImpl, arch });
    this.image = this.#registry().name;
    this.#settingsFile = path.join(store.root, 'update-settings.json');
    this.#cacheFile = path.join(store.root, 'published.json');
    this.lastCheck = readJson(this.#cacheFile, null);
  }

  settings() {
    const s = readJson(this.#settingsFile, {});
    return {
      auto: s.auto === true,
      windowHour: Number.isInteger(s.windowHour) && s.windowHour >= 0 && s.windowHour <= 23 ? s.windowHour : null,
      lastAutoAt: s.lastAutoAt ?? null,
      lastAutoResult: s.lastAutoResult ?? '',
    };
  }

  saveSettings(patch) {
    const next = { ...this.settings(), ...patch };
    fs.mkdirSync(this.store.root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.#settingsFile, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return next;
  }

  /** Versions that failed to come up (the launcher rolled them back): never installed automatically again. */
  failedVersions() {
    return new Set(this.store.events(500).filter((e) => e.type === 'rollback' && e.automatic).map((e) => e.from));
  }

  status() {
    const active = this.store.active();
    const installed = this.store.list().map(({ dir, ...v }) => v);
    const latest = this.lastCheck?.versions?.[0] ?? null;
    return {
      image: this.image,
      running: { version: this.runningVersion, source: active.source },
      builtIn: this.store.builtIn.version,
      supervised: this.supervised,
      choice: this.store.choice(),
      installed,
      events: this.store.events(30),
      lastCheck: this.lastCheck ? { at: this.lastCheck.at, error: this.lastCheck.error ?? '', versions: this.lastCheck.versions ?? [] } : null,
      updateAvailable: Boolean(latest && compareVersions(latest.version, this.runningVersion) > 0),
      latest,
      settings: this.settings(),
      failed: [...this.failedVersions()],
      job: this.#job,
      node: process.versions.node,
    };
  }

  /**
   * The versions published for this image: each tag's build, its version and
   * when it was built, newest first, one row per version. Images built before
   * the version label existed are read from their package.json layer.
   */
  async check() {
    const registry = this.#registry();
    try {
      const tags = await registry.tags();
      // Newest builds first: version tags, then commit tags, then latest.
      const wanted = [...new Set(['latest', ...tags.filter((t) => VERSION.test(t)).reverse(), ...tags.filter((t) => /^sha-/.test(t)).reverse()])].slice(0, LIST_LIMIT);
      const known = new Map((this.lastCheck?.versions ?? []).flatMap((v) => (v.digest ? [[v.digest, v]] : [])));
      const byVersion = new Map();
      for (const tag of wanted) {
        let image;
        try {
          image = await registry.image(tag);
        } catch {
          continue;
        }
        const cached = known.get(image.digest);
        let version = cached?.version || String(image.labels?.[VERSION_LABEL] ?? '');
        if (!VERSION.test(version)) version = await this.#versionFromLayers(registry, image).catch(() => '');
        if (!VERSION.test(version)) continue;
        const row = byVersion.get(version);
        const entry = row ?? { version, digest: image.digest, created: image.created, tags: [], revision: String(image.labels?.['org.opencontainers.image.revision'] ?? '').slice(0, 12) };
        entry.tags.push(tag);
        byVersion.set(version, entry);
      }
      const versions = [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version));
      this.lastCheck = { at: new Date().toISOString(), versions };
    } catch (error) {
      this.lastCheck = { ...(this.lastCheck ?? { versions: [] }), at: new Date().toISOString(), error: error.message };
    }
    this.#saveCache();
    return this.status();
  }

  #saveCache() {
    try {
      fs.mkdirSync(this.store.root, { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.#cacheFile, JSON.stringify(this.lastCheck), { mode: 0o600 });
    } catch {}
  }

  async #versionFromLayers(registry, image) {
    const layer = image.layers.find((l) => /COPY package\.json/.test(l.createdBy));
    if (!layer) return '';
    const { files } = untarLayer(await registry.blob(layer.digest, 4 * 1024 * 1024));
    return String(JSON.parse(files.get('package.json')?.toString('utf8') ?? '{}').version ?? '');
  }

  /** What is new in `version` compared with what runs, from its CHANGELOG. */
  whatsNew(files) {
    return changesSince(files.get('CHANGELOG.md')?.toString('utf8') ?? '', this.runningVersion);
  }

  /**
   * Download, check and install one published version, then switch to it.
   * Runs in the background; status().job follows it.
   */
  install(ref, { by = '', automatic = false, switchAfter = true } = {}) {
    if (this.#job?.state === 'running') throw new UpdateError('An update is already running.', 409);
    if (!this.supervised) throw new UpdateError('Updates from this page need the container to start with its own start command (the launcher). Run the image without a custom command, or update with podman pull.', 409);
    const job = { state: 'running', ref, by, automatic, startedAt: new Date().toISOString(), step: 'Reading the image', downloaded: 0, version: '' };
    this.#job = job;
    const registry = this.#registry();
    (async () => {
      const image = await registry.image(ref);
      const layers = appLayers(image.layers);
      if (!layers.length) throw new UpdateError('That image has no app layers this page can install.');
      const files = new Map();
      for (const [i, layer] of layers.entries()) {
        job.step = `Downloading ${i + 1} of ${layers.length} (${Math.round(layer.size / 1024)} KB), checking its digest`;
        untarLayer(await registry.blob(layer.digest), { files });
        job.downloaded = registry.downloaded;
      }
      const nodeNeeded = files.get('.node-version')?.toString('utf8').trim();
      if (nodeNeeded && nodeNeeded.split('.')[0] !== process.versions.node.split('.')[0]) {
        throw new UpdateError(`That version needs Node.js ${nodeNeeded} (this image has ${process.versions.node}): replace the image itself (full image update, or podman pull).`, 409);
      }
      job.step = 'Installing';
      const meta = { image: registry.name, tag: ref, digest: image.digest, revision: String(image.labels?.['org.opencontainers.image.revision'] ?? ''), created: image.created, by };
      const installed = this.store.install(files, meta);
      job.version = installed.version;
      job.whatsNew = this.whatsNew(files);
      this.record({ outcome: 'success', reason: `MZ-${installed.version} installed (${ref}, ${Math.round(registry.downloaded / 1024)} KB checked against its digests)${automatic ? ' automatically' : ''}.`, by, details: { version: installed.version, tag: ref, digest: image.digest } });
      if (switchAfter) await this.switch(installed.version, { by, automatic, job });
      else job.state = 'done';
    })().catch((error) => {
      job.state = 'failed';
      job.error = error.message;
      this.record({ outcome: 'failure', reason: `Update to ${ref} failed: ${error.message}`, by, details: { tag: ref } });
    });
    return job;
  }

  /** Run `version` (or the image's own) from now: a backup first, then the launcher switches. */
  async switch(version, { by = '', automatic = false, job = null } = {}) {
    if (!this.supervised) throw new UpdateError('Switching versions needs the launcher (the image’s own start command).', 409);
    if (version !== BUILT_IN && !this.store.list().some((v) => v.version === version)) throw new UpdateError(`MZ-${version} is not installed.`, 404);
    if (job) job.step = 'Backing up before the switch';
    await this.beforeSwitch(version);
    this.store.choose(version, { by: automatic ? 'auto-update' : by });
    const running = this.store.list().find((v) => v.version === this.runningVersion)?.version;
    this.store.prune({ keep: 4, protect: [version, running].filter(Boolean) });
    const target = version === BUILT_IN ? `the image’s own MZ-${this.store.builtIn.version}` : `MZ-${version}`;
    this.record({ outcome: 'changed', reason: `Switching from MZ-${this.runningVersion} to ${target}${automatic ? ' (auto-update)' : ''}.`, by, details: { from: this.runningVersion, to: version } });
    if (job) {
      job.step = `Switching to ${target}: the page reconnects in a few seconds`;
      job.state = 'switching';
    }
    // Let the answer reach the browser before this server stops.
    setTimeout(() => this.switchTo({ type: 'switch', by }), 600).unref?.();
    return { switching: true, to: version };
  }

  restart(by = '') {
    if (!this.supervised) throw new UpdateError('Restarting from this page needs the launcher (the image’s own start command).', 409);
    this.record({ outcome: 'changed', reason: `Server restarted from Settings → Update & recovery.`, by, details: {} });
    setTimeout(() => this.switchTo({ type: 'restart', by }), 600).unref?.();
    return { restarting: true };
  }

  /** Auto-update: install the newest published version when it is newer, in the chosen hour, never one that failed. */
  async autoUpdate(now = new Date()) {
    const settings = this.settings();
    if (!settings.auto || !this.supervised || this.#job?.state === 'running') return null;
    if (settings.windowHour !== null && now.getHours() !== settings.windowHour) return null;
    await this.check();
    const failed = this.failedVersions();
    const candidate = (this.lastCheck?.versions ?? []).find((v) => compareVersions(v.version, this.runningVersion) > 0 && !failed.has(v.version));
    if (!candidate) {
      this.saveSettings({ lastAutoAt: now.toISOString(), lastAutoResult: this.lastCheck?.error ? `Check failed: ${this.lastCheck.error}` : 'Up to date' });
      return null;
    }
    this.saveSettings({ lastAutoAt: now.toISOString(), lastAutoResult: `Installing MZ-${candidate.version}` });
    return this.install(candidate.tags.find((t) => VERSION.test(t)) ?? candidate.digest, { by: 'auto-update', automatic: true });
  }
}
