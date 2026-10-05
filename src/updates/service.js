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
/** Registry reads a check may make for tags it has not seen before; the rest follow on the next check. */
const NEW_READS_PER_CHECK = 150;

/** Run `worker` over `items`, at most `limit` at a time. */
async function mapLimit(items, limit, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  }));
}

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
      lastCheck: this.lastCheck ? { at: this.lastCheck.at, error: this.lastCheck.error ?? '', warning: this.lastCheck.warning ?? '', versions: this.lastCheck.versions ?? [] } : null,
      updateAvailable: Boolean(latest && compareVersions(latest.version, this.runningVersion) > 0),
      latest,
      settings: this.settings(),
      failed: [...this.failedVersions()],
      job: this.#job,
      node: process.versions.node,
      // The hour auto-update waits for is the server's: say which zone that is, and its time now.
      serverTime: { zone: Intl.DateTimeFormat().resolvedOptions().timeZone || '', hour: new Date().getHours(), minute: new Date().getMinutes() },
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
      // Every tag, newest first: version tags (they name their version), latest, then commit builds.
      const versionTags = tags.filter((t) => VERSION.test(t)).sort((a, b) => compareVersions(b, a));
      const wanted = [...new Set([...versionTags, 'latest', ...tags.filter((t) => /^sha-/.test(t)).reverse()])];
      // Version and commit tags never move: what was read once is kept, so a check only reads what is new.
      // Only "latest" is read every time. (Never a cap on how many are listed: every release adds two tags.)
      const remembered = this.lastCheck?.byTag ?? {};
      const known = new Map((this.lastCheck?.versions ?? []).flatMap((v) => (v.digest ? [[v.digest, v]] : [])));
      const byTag = {};
      const problems = [];
      let filesError = '';
      let reads = 0;
      const read = async (tag) => {
        const kept = tag !== 'latest' ? remembered[tag] : null;
        if (kept?.digest && (kept.version || !VERSION.test(tag))) return kept;
        if (reads >= NEW_READS_PER_CHECK) return null;
        reads += 1;
        const { digest } = await registry.manifest(tag);
        const cached = known.get(digest);
        const entry = { digest, version: VERSION.test(tag) ? tag : cached?.version || '', created: cached?.created || '', revision: cached?.revision || '' };
        return entry;
      };
      // The registry's own answers (no image files): a few at a time.
      await mapLimit(wanted, 6, async (tag) => {
        try {
          const entry = await read(tag);
          if (entry) byTag[tag] = entry;
        } catch (error) {
          problems.push(error.message);
        }
      });
      // Version tags first, so latest and commit builds of a release are matched to it by digest.
      const versionOf = new Map();
      for (const tag of versionTags) if (byTag[tag]) versionOf.set(byTag[tag].digest, tag);
      // The build date and commit (and, for an unmatched commit build, the version) are in the image files.
      // One failed read is enough: the rest would fail the same way.
      for (const tag of wanted) {
        const entry = byTag[tag];
        if (!entry || filesError) continue;
        entry.version ||= versionOf.get(entry.digest) || '';
        if (entry.version && entry.created) continue;
        if (reads >= NEW_READS_PER_CHECK && !remembered[tag]) continue;
        reads += 1;
        try {
          const image = await registry.image(entry.digest);
          if (!VERSION.test(entry.version)) entry.version = String(image.labels?.[VERSION_LABEL] ?? '');
          if (!VERSION.test(entry.version)) entry.version = await this.#versionFromLayers(registry, image).catch(() => '');
          entry.created = image.created;
          entry.revision = String(image.labels?.['org.opencontainers.image.revision'] ?? '').slice(0, 12);
        } catch (error) {
          filesError = error.message;
        }
      }
      const byVersion = new Map();
      for (const tag of wanted) {
        const entry = byTag[tag];
        if (!entry) continue;
        entry.version ||= versionOf.get(entry.digest) || '';
        if (!VERSION.test(entry.version)) continue;
        const row = byVersion.get(entry.version) ?? { version: entry.version, digest: entry.digest, created: entry.created, tags: [], revision: entry.revision };
        row.created ||= entry.created;
        row.revision ||= entry.revision;
        row.tags.push(tag);
        byVersion.set(entry.version, row);
      }
      const versions = [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version));
      const unread = wanted.filter((t) => !byTag[t]).length;
      // Builds with only a commit tag (every release before MZ-01.00.30) are named from their image files.
      const unnamed = filesError ? wanted.filter((t) => byTag[t] && !VERSION.test(byTag[t].version)).length : 0;
      this.lastCheck = {
        at: new Date().toISOString(),
        versions,
        byTag: Object.fromEntries(Object.entries(byTag).filter(([tag, e]) => tag !== 'latest' && e.version)),
        // Installing needs the image files: auto-update waits while they cannot be read.
        filesError,
        // Nothing found is never "up to date": it says why.
        error: versions.length ? '' : filesError || problems[0] || (tags.length ? 'No published version could be read.' : 'No versions are published for this image.'),
        warning: [
          versions.length && filesError ? `The versions are listed, but this server could not read the image files: ${filesError} Installing from this page needs that; until then, update with podman pull.` : '',
          unnamed ? `${unnamed} older build(s) have only a commit tag, and their version is in those image files, so they are not listed.` : '',
          versions.length && unread ? `${unread} older build(s) are still to be read: Check for updates again to list them.` : '',
        ].filter(Boolean).join(' '),
      };
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

  /**
   * Auto-update: install the newest published version when it is newer, in the chosen hour,
   * never one that failed. Every look leaves a line on the Update page saying what it found
   * and, when it waits, what for and until when.
   */
  async autoUpdate(now = new Date()) {
    const settings = this.settings();
    if (!settings.auto) return null;
    const say = (lastAutoResult) => this.saveSettings({ lastAutoAt: now.toISOString(), lastAutoResult });
    if (!this.supervised) {
      say('Cannot install: this server was started with a custom command, so it cannot switch versions itself. Start the image with its own start command, or update with podman pull');
      return null;
    }
    // A job that never finished (the server was stopped part-way) does not block auto-update for ever.
    if (this.#job?.state === 'running' && now - new Date(this.#job.startedAt) < 30 * 60_000) return null;
    const inWindow = settings.windowHour === null || now.getHours() === settings.windowHour;
    // Outside its hour it still looks, at most once an hour, so the page can say what is waiting.
    if (!inWindow && settings.lastAutoAt && now - new Date(settings.lastAutoAt) < 55 * 60_000) return null;
    await this.check();
    const failed = this.failedVersions();
    const candidate = (this.lastCheck?.versions ?? []).find((v) => compareVersions(v.version, this.runningVersion) > 0 && !failed.has(v.version));
    if (!candidate) {
      say(this.lastCheck?.error ? `Check failed: ${this.lastCheck.error}` : 'Up to date');
      return null;
    }
    if (this.lastCheck?.filesError) {
      // It would fail the same way every 15 minutes: wait, and say why.
      say(`MZ-${candidate.version} is published, but this server cannot download it: ${this.lastCheck.filesError}`);
      return null;
    }
    if (!inWindow) {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'server time';
      say(`MZ-${candidate.version} is ready: it installs at ${String(settings.windowHour).padStart(2, '0')}:00 (${zone}), or use Install now`);
      return null;
    }
    say(`Installing MZ-${candidate.version}`);
    return this.install(candidate.tags.find((t) => VERSION.test(t)) ?? candidate.digest, { by: 'auto-update', automatic: true });
  }
}
