/**
 * Updating without losing anyone's place.
 *
 * When the server is told to stop (a container update sends SIGTERM), it saves
 * who is signed in with a password, and the findings each of them fetched, to
 * one file in the state folder. The next server, the new version, reads it at
 * start-up, deletes it, and picks those people up where they were: still
 * signed in, Dashboard data still there.
 *
 * - Session ids are stored only as a SHA-256 hash: the file cannot be used to
 *   sign in. A restored session is matched when its browser next calls.
 * - Sessions opened with a person's own Checkmarx One API key are not saved:
 *   that key is never written to disk, so those people sign in again.
 * - The file is owner-only (0600), gzip-compressed, and ignored when older
 *   than MAX_AGE_MS (an old file from a crash long ago is not resurrected).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';

export const HANDOVER_FILE = 'handover.json.gz';
const MAX_AGE_MS = 60 * 60 * 1000;

export const sessionKey = (id) => createHash('sha256').update(`mz-session|${id}`).digest('hex');

/** Dates in the fetched data that JSON turns into strings. */
function reviveScan(scan) {
  const w = scan?.detectionWindow;
  if (w) for (const key of ['from', 'to']) if (typeof w[key] === 'string') w[key] = new Date(w[key]);
  return scan;
}

/** Save sessions for the next server: live ones ({id, userId, via, createdAt, lastUsedAt, lastScan}) and saved ones not yet picked up. Returns how many. */
export function saveHandover(dataDir, { live = [], adopted = [] }, now = Date.now()) {
  const file = path.join(dataDir, HANDOVER_FILE);
  const entries = [
    ...live.map(({ id, userId, via, createdAt, lastUsedAt, lastScan }) => ({ key: sessionKey(id), userId, via, createdAt, lastUsedAt, lastScan: lastScan ?? null })),
    ...adopted,
  ];
  const body = zlib.gzipSync(JSON.stringify({ version: 1, savedAt: now, sessions: entries }));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return entries.length;
}

/** Read and delete the handover file. Returns [] when there is none, it is stale, or it cannot be read. */
export function takeHandover(dataDir, now = Date.now()) {
  const file = path.join(dataDir, HANDOVER_FILE);
  if (!fs.existsSync(file)) return [];
  try {
    const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
    if (data?.version !== 1 || !Array.isArray(data.sessions) || now - Number(data.savedAt) > MAX_AGE_MS) return [];
    return data.sessions.filter((s) => s && typeof s.key === 'string' && s.userId).map((s) => ({ ...s, lastScan: reviveScan(s.lastScan) }));
  } catch {
    return [];
  } finally {
    fs.rmSync(file, { force: true });
  }
}
