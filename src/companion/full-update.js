/**
 * A full image update: replace the CxMissionZero container with the same container on a new
 * image, keeping everything it was started with (ports, volume, environment, limits,
 * security options, restart policy, networks), and go back to the old one if the new one
 * does not come up.
 *
 *   1. Check the container is CxMissionZero's (its image is the configured one).
 *   2. Pull the new image while the old container keeps running.
 *   3. Stop the old container (the server finishes its work and saves, as for any update),
 *      and park it as "<name>-previous".
 *   4. Create and start the new one under the old name; wait for its server to say it
 *      started (src/updates/companion.js, ack.json) and still be running.
 *   5. If it does not: remove it, put the old one back under its name, and start it.
 *
 * Only the configured image, and only a version, `latest` or a commit tag: what is asked
 * for can never run another image or change how the container is started.
 */

export const TAG = /^(?:\d+\.\d+\.\d+|latest|sha-[0-9a-f]{7,40})$/;
export const VERSION_LABEL = 'io.cxmissionzero.version';
const DEFAULT_NETWORKS = new Set(['bridge', 'podman', 'default', 'host', 'none']);

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** "ghcr.io/org/app:1.2.3" or "…@sha256:…" → "ghcr.io/org/app" (lower case; docker.io and localhost prefixes kept as given). */
export function repositoryOf(ref) {
  const value = String(ref ?? '').trim().toLowerCase().split('@')[0];
  const slash = value.lastIndexOf('/');
  const colon = value.lastIndexOf(':');
  return colon > slash ? value.slice(0, colon) : value;
}

/**
 * The create request for the same container on `image`: what the person started it with,
 * not what the old image set (its environment, labels, command and so on come from the new
 * image instead).
 */
export function cloneSpec(container, oldImage, image) {
  const cfg = container?.Config ?? {};
  const img = oldImage?.Config ?? {};
  const imageEnv = new Set(img.Env ?? []);
  const spec = {
    Image: image,
    Env: (cfg.Env ?? []).filter((entry) => !imageEnv.has(entry)),
    Labels: Object.fromEntries(Object.entries(cfg.Labels ?? {}).filter(([key, value]) => img.Labels?.[key] !== value)),
    HostConfig: container?.HostConfig ?? {},
  };
  if (cfg.ExposedPorts && !same(cfg.ExposedPorts, img.ExposedPorts)) spec.ExposedPorts = cfg.ExposedPorts;
  if (cfg.Cmd && !same(cfg.Cmd, img.Cmd)) spec.Cmd = cfg.Cmd;
  if (cfg.Entrypoint && !same(cfg.Entrypoint, img.Entrypoint)) spec.Entrypoint = cfg.Entrypoint;
  if (cfg.User && cfg.User !== img.User) spec.User = cfg.User;
  if (cfg.WorkingDir && cfg.WorkingDir !== img.WorkingDir) spec.WorkingDir = cfg.WorkingDir;
  if (cfg.Healthcheck && !same(cfg.Healthcheck, img.Healthcheck)) spec.Healthcheck = cfg.Healthcheck;
  const networks = Object.entries(container?.NetworkSettings?.Networks ?? {}).filter(([name]) => !DEFAULT_NETWORKS.has(name));
  if (networks.length) {
    spec.NetworkingConfig = { EndpointsConfig: Object.fromEntries(networks.map(([name, n]) => [name, n?.Aliases?.length ? { Aliases: n.Aliases.filter((a) => !String(container.Id ?? '').startsWith(a)) } : {}])) };
  }
  return spec;
}

/**
 * Run a full image update. `engine`: src/companion/engine.js. `waitReady({since, version})`
 * resolves when the new server said it started, and rejects after the time it may take.
 * `step(text)` reports progress. Resolves {state: 'done'|'unchanged'|'rolled-back', …};
 * throws only when nothing was changed (the container could not be found, the pull failed).
 */
export async function fullUpdate({ engine, name, image, tag, waitReady, step = () => {}, now = () => Date.now(), stopSeconds = 30, settleMs = 15_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (!TAG.test(String(tag))) throw new Error(`"${tag}" is not a version, latest or a commit tag.`);
  const repository = repositoryOf(image);
  const ref = `${repository}:${tag}`;

  step(`Looking at the container "${name}"`);
  const old = await engine.inspect(name);
  if (repositoryOf(old.Config?.Image) !== repository) {
    throw new Error(`The container "${name}" runs ${old.Config?.Image || 'another image'}, not ${repository}: it is not replaced.`);
  }

  step(`Downloading ${ref} (the server keeps running)`);
  await engine.pull(repository, tag);
  const fresh = await engine.inspectImage(ref);
  if (fresh.Id && fresh.Id === old.Image) return { state: 'unchanged', reason: `The container already runs ${ref}.` };
  const version = /^\d+\.\d+\.\d+$/.test(tag) ? tag : String(fresh.Config?.Labels?.[VERSION_LABEL] ?? '');
  const oldImage = await engine.inspectImage(old.Image).catch(() => null);
  const spec = cloneSpec(old, oldImage, ref);
  const from = String(oldImage?.Config?.Labels?.[VERSION_LABEL] ?? old.Config?.Image ?? '');
  const parked = `${name}-previous`;

  // Only one parked container: the one from the update before this is no longer needed.
  await engine.remove(parked).catch(() => {});
  step('Stopping the server: it finishes its work and saves');
  await engine.stop(old.Id, stopSeconds);
  await engine.rename(old.Id, parked);

  let created = null;
  try {
    step(`Starting ${version ? `MZ-${version}` : ref} with the same settings`);
    created = await engine.create(name, spec);
    const since = now();
    await engine.start(created.Id);
    step('Waiting for the new server to start');
    await waitReady({ since, version });
    await sleep(settleMs);
    const state = await engine.inspect(created.Id);
    if (!state.State?.Running) throw new Error(`The new container stopped (exit code ${state.State?.ExitCode ?? '?'}).`);
    return { state: 'done', from, to: version || ref, previous: parked };
  } catch (error) {
    step('Going back to the previous container');
    if (created?.Id) {
      await engine.stop(created.Id, 10).catch(() => {});
      await engine.remove(created.Id).catch(() => {});
    }
    await engine.rename(old.Id, name);
    await engine.start(old.Id);
    return { state: 'rolled-back', from, to: version || ref, error: error.message };
  }
}
