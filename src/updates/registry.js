/**
 * Reading CxMissionZero's own container image from its registry, for updates
 * from the Settings page: the same image `podman pull` would fetch, but only
 * the layers that hold the app's files (about 1.5 MB of a 40 MB image).
 *
 * Everything is content-addressed: each blob is checked against its sha256
 * digest before it is used, so what is installed is exactly what was
 * published under that tag.
 */

import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export const DEFAULT_IMAGE = 'ghcr.io/cxsmtp/cxdetectiondatebasereminder';
const MAX_LAYER = 64 * 1024 * 1024;
const MAX_FILES = 20_000;
const ACCEPT_INDEX = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

export class UpdateError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'UpdateError';
    this.status = status;
  }
}

/** ghcr.io/owner/name (a tag or digest after it is ignored) → {registry, repository}. */
export function parseImage(image) {
  let text = String(image ?? '').trim().replace(/^https?:\/\//, '').replace(/@sha256:[0-9a-f]+$/i, '');
  if (text.lastIndexOf(':') > text.lastIndexOf('/')) text = text.slice(0, text.lastIndexOf(':'));
  const parts = text.split('/');
  const host = parts[0] ?? '';
  if (parts.length < 2 || !/^[a-z0-9.-]+(:\d+)?$/i.test(host) || !(host.includes('.') || host.includes(':') || host === 'localhost')) {
    throw new UpdateError(`Not an image name with its registry (like ghcr.io/owner/name): ${image}`, 400);
  }
  const repository = parts.slice(1).join('/').toLowerCase();
  if (!/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(repository)) throw new UpdateError(`Not an image name: ${image}`, 400);
  return { registry: host.toLowerCase(), repository };
}

const TAG = /^[\w][\w.-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PLATFORM_ARCH = { x64: 'amd64', arm64: 'arm64' };

/**
 * A registry reader for one image. `fetch` is injectable for tests; `token`
 * is only for a private registry (a public image needs none).
 */
export class ImageRegistry {
  #token;
  #bearer = '';

  constructor({ image = DEFAULT_IMAGE, token = '', fetch: fetchImpl = globalThis.fetch, arch = process.arch, timeoutMs = 60_000 } = {}) {
    Object.assign(this, parseImage(image));
    this.name = `${this.registry}/${this.repository}`;
    this.#token = token;
    this.fetch = fetchImpl;
    this.arch = PLATFORM_ARCH[arch] ?? arch;
    this.timeoutMs = timeoutMs;
    this.downloaded = 0;
  }

  get base() {
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(this.registry);
    return `${local ? 'http' : 'https'}://${this.registry}/v2/${this.repository}`;
  }

  /** One registry request, with the anonymous (or given) token the registry asks for. */
  async #get(path, { accept = '', retried = false } = {}) {
    const headers = { 'User-Agent': 'cxmissionzero-update' };
    if (accept) headers.Accept = accept;
    if (this.#bearer) headers.Authorization = `Bearer ${this.#bearer}`;
    let response;
    try {
      response = await this.fetch(`${this.base}${path}`, { headers, redirect: 'follow', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new UpdateError(`Could not reach ${this.registry}: ${error.cause?.code || error.message}. The server needs to reach ${this.registry} (and, for GitHub, pkg-containers.githubusercontent.com) over HTTPS.`);
    }
    if (response.status === 401 && !retried) {
      await this.#authenticate(response.headers.get('www-authenticate') || '');
      return this.#get(path, { accept, retried: true });
    }
    if (response.status === 404) throw new UpdateError(`${this.name}: not found (${path.split('/').pop()}).`, 404);
    if (!response.ok) {
      // Image files are often served from another host (ghcr.io sends them to pkg-containers.githubusercontent.com): name the one that refused.
      let host = this.registry;
      try {
        host = new URL(response.url).host || host;
      } catch {}
      const elsewhere = host !== this.registry ? ` (${this.registry} sends image files there; a proxy or firewall in between may block it: allow ${host} over HTTPS)` : '';
      throw new UpdateError(`${host} answered ${response.status} for ${path.split('/').pop().slice(0, 19)}${elsewhere}.`);
    }
    return response;
  }

  async #authenticate(challenge) {
    const params = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    if (!/^bearer/i.test(challenge) || !params.realm) throw new UpdateError(`${this.registry} refused the request and did not say how to sign in.`, 401);
    const realm = new URL(params.realm);
    if (realm.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(realm.hostname)) throw new UpdateError(`${this.registry} asked to sign in over plain http.`, 401);
    realm.searchParams.set('scope', params.scope || `repository:${this.repository}:pull`);
    if (params.service) realm.searchParams.set('service', params.service);
    const headers = { 'User-Agent': 'cxmissionzero-update' };
    if (this.#token) headers.Authorization = `Basic ${Buffer.from(`token:${this.#token}`).toString('base64')}`;
    let response;
    try {
      response = await this.fetch(realm, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new UpdateError(`Could not sign in to ${this.registry}: ${error.message}`);
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !(body.token || body.access_token)) {
      throw new UpdateError(`${this.registry} did not allow reading ${this.repository}${this.#token ? ' with the token given' : ' without a token (is the image private? set UPDATE_REGISTRY_TOKEN)'}.`, 401);
    }
    this.#bearer = body.token || body.access_token;
  }

  async #json(path, accept) {
    const response = await this.#get(path, { accept });
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024) throw new UpdateError('The registry answer is too large.');
    try {
      return { body: JSON.parse(text), digest: response.headers.get('docker-content-digest') || '', text };
    } catch {
      throw new UpdateError('The registry sent something that is not JSON.');
    }
  }

  /** A blob, checked against its digest. */
  async blob(digest, maxBytes = MAX_LAYER) {
    if (!DIGEST.test(digest)) throw new UpdateError(`Not a sha256 digest: ${digest}`);
    const response = await this.#get(`/blobs/${digest}`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new UpdateError(`A layer is larger than expected (${declared} bytes).`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new UpdateError(`A layer is larger than expected (${buffer.length} bytes).`);
    const actual = `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
    if (actual !== digest) throw new UpdateError(`A layer did not match its digest (expected ${digest.slice(0, 19)}…, got ${actual.slice(0, 19)}…): not installed.`);
    this.downloaded += buffer.length;
    return buffer;
  }

  /** The tags published for this image, newest builds last as the registry lists them. */
  async tags() {
    const { body } = await this.#json('/tags/list?n=1000', 'application/json');
    return Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === 'string' && TAG.test(t)) : [];
  }

  /**
   * The digest of `ref`'s image for this server's architecture, from the
   * registry itself (no image files are read): enough to list versions.
   */
  async manifest(ref = 'latest') {
    if (!TAG.test(ref) && !DIGEST.test(ref)) throw new UpdateError(`Not a tag: ${ref}`, 400);
    const { body, digest } = await this.#json(`/manifests/${ref}`, ACCEPT_INDEX);
    if (!Array.isArray(body.manifests)) return { digest };
    const match = body.manifests.find((m) => m.platform?.os === 'linux' && m.platform?.architecture === this.arch);
    if (!match || !DIGEST.test(match.digest)) throw new UpdateError(`${ref} has no build for linux/${this.arch}.`, 404);
    return { digest: match.digest };
  }

  /**
   * The image for `ref` (a tag or digest) on this server's architecture:
   * {digest, config, layers: [{digest, size, createdBy}]}.
   */
  async image(ref = 'latest') {
    if (!TAG.test(ref) && !DIGEST.test(ref)) throw new UpdateError(`Not a tag: ${ref}`, 400);
    let { body, digest } = await this.#json(`/manifests/${ref}`, ACCEPT_INDEX);
    if (Array.isArray(body.manifests)) {
      const match = body.manifests.find((m) => m.platform?.os === 'linux' && m.platform?.architecture === this.arch);
      if (!match || !DIGEST.test(match.digest)) throw new UpdateError(`${ref} has no build for linux/${this.arch}.`, 404);
      ({ body, digest } = await this.#json(`/manifests/${match.digest}`, ACCEPT_INDEX));
      digest = match.digest;
    }
    if (!body.config?.digest || !Array.isArray(body.layers)) throw new UpdateError(`${ref} is not an image manifest.`);
    const config = JSON.parse((await this.blob(body.config.digest, 2 * 1024 * 1024)).toString('utf8'));
    // Layers line up with the history entries that are not empty.
    const history = (Array.isArray(config.history) ? config.history : []).filter((h) => !h.empty_layer);
    const layers = body.layers.map((layer, i) => ({ digest: layer.digest, size: Number(layer.size) || 0, createdBy: String(history[i]?.created_by ?? '') }));
    return { digest, config, layers, labels: config.config?.Labels ?? {}, created: config.created ?? '' };
  }
}

/** The layers that carry the app's own files: everything COPYed into /app (not the OS or Node.js). */
export function appLayers(layers) {
  return layers.filter((layer) => {
    const step = layer.createdBy.replace(/^\/bin\/sh -c #\(nop\)\s*/, '');
    return (/^COPY\b/.test(step) || /# mz-runtime/.test(step)) && layer.size < MAX_LAYER;
  });
}

/**
 * Files under `prefix` (default "app/") in a gzipped tar layer: Map(relative path → Buffer).
 * Only regular files; links, devices and anything that could leave the folder are skipped.
 */
export function untarLayer(gz, { prefix = 'app/', files = new Map(), deleted = new Set() } = {}) {
  let tar;
  try {
    tar = gunzipSync(gz, { maxOutputLength: 256 * 1024 * 1024 });
  } catch (error) {
    throw new UpdateError(`A layer could not be unpacked: ${error.message}`);
  }
  let offset = 0;
  let longName = '';
  let paxPath = '';
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (!Number.isFinite(size) || size < 0) throw new UpdateError('A layer has a damaged file entry.');
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/s, '');
      continue;
    }
    if (type === 'x') {
      const match = body.toString('utf8').match(/\d+ path=([^\n]*)\n/);
      paxPath = match ? match[1] : '';
      continue;
    }
    const prefixField = field(345, 155);
    let name = paxPath || longName || (prefixField ? `${prefixField}/${field(0, 100)}` : field(0, 100));
    longName = '';
    paxPath = '';
    name = name.replace(/^\.\//, '');
    if (!name.startsWith(prefix)) continue;
    const rel = name.slice(prefix.length);
    const parts = rel.split('/');
    // Whiteouts: a later layer removing a file an earlier one added.
    const base = parts.at(-1);
    if (base?.startsWith('.wh.')) {
      const gone = [...parts.slice(0, -1), base.slice(4)].join('/');
      for (const key of [...files.keys()]) if (key === gone || key.startsWith(`${gone}/`)) files.delete(key);
      deleted.add(gone);
      continue;
    }
    if (type !== '0' && type !== '\0' && type !== '7') continue;
    if (!rel || parts.some((p) => !p || p === '.' || p === '..')) continue;
    if (files.size >= MAX_FILES) throw new UpdateError('The update has more files than expected.');
    files.set(rel, Buffer.from(body));
  }
  return { files, deleted };
}
