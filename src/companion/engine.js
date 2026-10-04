/**
 * The container engine's API (Podman's Docker-compatible API, or Docker's), over its
 * Unix socket. Only what a full image update needs: inspect, pull, create, start, stop,
 * rename and remove one container.
 */

import http from 'node:http';

export class EngineError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'EngineError';
    this.status = status;
  }
}

const API = '/v1.41';

export class EngineClient {
  #token;

  /** @param {{socketPath: string, registryToken?: string, timeoutMs?: number}} options */
  constructor({ socketPath, registryToken = '', timeoutMs = 120_000 }) {
    this.socketPath = socketPath;
    this.#token = registryToken;
    this.timeoutMs = timeoutMs;
  }

  /** One request; resolves the parsed JSON (or text), rejects with the engine's message. */
  request(method, path, { body, headers = {}, timeoutMs = this.timeoutMs, raw = false } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          socketPath: this.socketPath,
          method,
          path: API + path,
          headers: { Host: 'engine', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}), ...headers },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed = text;
            if (!raw) {
              try {
                parsed = text ? JSON.parse(text) : null;
              } catch {
                parsed = text;
              }
            }
            if (res.statusCode >= 400) {
              let detail = parsed;
              try {
                detail = JSON.parse(text);
              } catch {}
              const message = String((detail && typeof detail === 'object' && (detail.message || detail.cause)) || text.trim() || `The engine answered ${res.statusCode}.`).slice(0, 300);
              return reject(new EngineError(message, res.statusCode));
            }
            resolve(parsed);
          });
        },
      );
      req.on('timeout', () => req.destroy(new EngineError(`No answer from the container engine within ${Math.round(timeoutMs / 1000)} s.`)));
      req.on('error', (error) => reject(error instanceof EngineError ? error : new EngineError(`Cannot reach the container engine at ${this.socketPath}: ${error.code || error.message}`)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  ping() {
    return this.request('GET', '/_ping', { timeoutMs: 10_000, raw: true });
  }

  inspect(nameOrId) {
    return this.request('GET', `/containers/${encodeURIComponent(nameOrId)}/json`);
  }

  inspectImage(ref) {
    return this.request('GET', `/images/${encodeURIComponent(ref)}/json`);
  }

  /** Pull image:tag; the answer streams progress lines, any of which may carry the error. */
  async pull(image, tag) {
    const host = image.split('/')[0];
    const auth = this.#token ? { 'X-Registry-Auth': Buffer.from(JSON.stringify({ username: 'token', password: this.#token, serveraddress: host })).toString('base64url') } : {};
    const text = await this.request('POST', `/images/create?fromImage=${encodeURIComponent(image)}&tag=${encodeURIComponent(tag)}`, { headers: auth, timeoutMs: 15 * 60_000, raw: true });
    for (const line of String(text).split('\n')) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.error || event.errorDetail) throw new EngineError(`Pulling ${image}:${tag} failed: ${event.errorDetail?.message || event.error}`);
    }
  }

  create(name, spec) {
    return this.request('POST', `/containers/create?name=${encodeURIComponent(name)}`, { body: spec });
  }

  start(id) {
    return this.request('POST', `/containers/${encodeURIComponent(id)}/start`);
  }

  /** Stop, giving the server `seconds` to finish its work and save (a 304 means already stopped). */
  async stop(id, seconds = 30) {
    try {
      await this.request('POST', `/containers/${encodeURIComponent(id)}/stop?t=${seconds}`, { timeoutMs: (seconds + 30) * 1000 });
    } catch (error) {
      if (error.status !== 304) throw error;
    }
  }

  rename(id, name) {
    return this.request('POST', `/containers/${encodeURIComponent(id)}/rename?name=${encodeURIComponent(name)}`);
  }

  remove(id) {
    return this.request('DELETE', `/containers/${encodeURIComponent(id)}?force=true`);
  }
}
