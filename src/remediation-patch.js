/**
 * An AI Remediation result as a patch `git apply` takes, and the signed link
 * that hands it out ("curl … -o mz-fix.patch && git apply mz-fix.patch").
 *
 * Checkmarx One gives one diff per changed file, with or without its own
 * headers. Each is rewritten with git's headers (a/ and b/ prefixes) for its
 * repository-relative path; a path that could leave the repository is dropped.
 */

import { timingSafeEqual } from 'node:crypto';

const PATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A repository-relative path, or '' when it is empty or could leave the repository. */
export function repoPath(path) {
  const parts = String(path ?? '').replace(/\\/g, '/').replace(/^\/+/, '').split('/');
  const bad = (part) => !part || part === '.' || part === '..' || part === '.git' || /[\0-\x1f:"]/.test(part);
  return parts.length && !parts.some(bad) ? parts.join('/') : '';
}

/** The file changes of a remediation-details body that carry a diff, on safe paths. */
export function fileChanges(body) {
  const changes = body?.results?.[0]?.data?.file_changes;
  if (!Array.isArray(changes)) return [];
  return changes
    .map((change) => ({ path: repoPath(change?.file_path), diff: typeof change?.diff === 'string' ? change.diff : '' }))
    .filter((change) => change.path && /^@@ /m.test(change.diff));
}

/** One file's diff with git headers; its own headers (if any) are replaced. */
function gitDiff({ path, diff }) {
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  const first = lines.findIndex((line) => line.startsWith('@@ '));
  const header = lines.slice(0, first);
  const created = header.some((line) => line.startsWith('--- /dev/null')) || /^@@ -0,0 /.test(lines[first]);
  const deleted = header.some((line) => line.startsWith('+++ /dev/null'));
  const body = lines.slice(first).join('\n').replace(/\n*$/, '\n');
  return [
    `diff --git a/${path} b/${path}`,
    ...(created ? ['new file mode 100644'] : deleted ? ['deleted file mode 100644'] : []),
    `--- ${created ? '/dev/null' : `a/${path}`}`,
    `+++ ${deleted ? '/dev/null' : `b/${path}`}`,
    body,
  ].join('\n');
}

/** The whole fix as one patch, or '' when it changes no file. */
export function gitPatch(body) {
  return fileChanges(body).map(gitDiff).join('');
}

/**
 * Signed, expiring links to one finding's fix. `mac(text)` is the server's
 * HMAC; the link names the scan and result, so it can only ever fetch the fix
 * of the finding it was made for.
 */
export function patchLinks(mac) {
  const sign = (payload) => mac(`patch\n${payload}`);
  return {
    issue({ scanId, alternateId }, now = Date.now()) {
      const payload = Buffer.from(JSON.stringify([String(scanId), String(alternateId), now + PATCH_TTL_MS])).toString('base64url');
      return `${payload}.${sign(payload)}`;
    },
    /** {scanId, alternateId} for a valid token, {expired:true}, or null. */
    verify(token, now = Date.now()) {
      const [payload, sig, extra] = String(token ?? '').split('.');
      if (!payload || !sig || extra !== undefined || payload.length > 600) return null;
      const given = Buffer.from(sig);
      const expected = Buffer.from(sign(payload));
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      let fields;
      try {
        fields = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      } catch {
        return null;
      }
      if (!Array.isArray(fields) || fields.length !== 3) return null;
      const [scanId, alternateId, exp] = fields;
      if (typeof scanId !== 'string' || typeof alternateId !== 'string' || !scanId || !alternateId) return null;
      if (!(Number(exp) > now)) return { expired: true };
      return { scanId, alternateId };
    },
  };
}
