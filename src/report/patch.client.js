/*
 * Runs inside the emailed HTML report, before report.client.js.
 *
 * Applies an AI Remediation diff to a file's text in the browser, for "Apply
 * fix in my workspace". The code may have moved on since the scan, so each
 * change is looked for where the diff says first, then nearer lines outwards:
 * it applies where its old lines still read the same (trailing spaces aside),
 * and is never forced in where they do not.
 *
 * Kept as a plain file (inlined by html-report.js) so it can be syntax checked
 * and tested on its own.
 */
'use strict';

// eslint-disable-next-line no-unused-vars
const MZPatch = (() => {
  const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  /** The hunks of one file's unified diff, and whether it creates or deletes the file. */
  function parse(diff) {
    const lines = String(diff ?? '').replace(/\r\n/g, '\n').split('\n');
    const hunks = [];
    let created = false;
    let deleted = false;
    let hunk = null;
    for (const line of lines) {
      const head = line.match(HUNK);
      if (head) {
        hunk = { oldStart: Number(head[1]), oldLeft: head[2] === undefined ? 1 : Number(head[2]), newLeft: head[4] === undefined ? 1 : Number(head[4]), old: [], new: [] };
        if (hunk.oldStart === 0 && hunk.oldLeft === 0) created = true;
        hunks.push(hunk);
        continue;
      }
      if (!hunk || (hunk.oldLeft <= 0 && hunk.newLeft <= 0)) {
        if (/^--- \/dev\/null/.test(line)) created = true;
        if (/^\+\+\+ \/dev\/null/.test(line)) deleted = true;
        hunk = null;
        continue;
      }
      if (line.startsWith('\\')) continue; // "\ No newline at end of file"
      const tag = line[0];
      const text = line.slice(1);
      if (tag === ' ' || line === '') {
        // A blank context line whose leading space was trimmed on the way.
        hunk.old.push(text);
        hunk.new.push(text);
        hunk.oldLeft -= 1;
        hunk.newLeft -= 1;
      } else if (tag === '-') {
        hunk.old.push(text);
        hunk.oldLeft -= 1;
      } else if (tag === '+') {
        hunk.new.push(text);
        hunk.newLeft -= 1;
      }
    }
    return { hunks: hunks.map(({ oldStart, old, new: added }) => ({ oldStart, old, new: added })), created, deleted };
  }

  const same = (a, b) => a.trimEnd() === b.trimEnd();

  /** Where `block` sits in `lines`, nearest to `expected` first; -1 when nowhere. */
  function locate(lines, block, expected) {
    if (!block.length) return Math.max(0, Math.min(expected, lines.length));
    const fits = (at) => at >= 0 && at + block.length <= lines.length && block.every((line, k) => same(lines[at + k], line));
    for (let distance = 0; distance <= lines.length; distance += 1) {
      if (fits(expected - distance)) return expected - distance;
      if (distance && fits(expected + distance)) return expected + distance;
    }
    return -1;
  }

  /**
   * Apply `diff` to `text`. Resolves {ok, text, changes, moved} or {ok:false, error}.
   * Line endings and the final newline of the file are kept as they were.
   */
  function apply(text, diff) {
    const source = String(text ?? '');
    const { hunks, deleted } = parse(diff);
    if (deleted) return { ok: false, error: 'This fix deletes the file. Use the git command to apply it.' };
    if (!hunks.length) return { ok: false, error: 'The fix has no changes for this file.' };
    const eol = /\r\n/.test(source) ? '\r\n' : '\n';
    const finalNewline = source === '' || /\n$/.test(source);
    const lines = source === '' ? [] : source.replace(/\r\n/g, '\n').split('\n');
    if (finalNewline && lines.length) lines.pop();
    let drift = 0;
    let moved = 0;
    for (const [i, hunk] of hunks.entries()) {
      const expected = Math.max(0, hunk.oldStart - 1 + drift);
      const at = locate(lines, hunk.old, expected);
      if (at < 0) {
        return {
          ok: false,
          error: `Change ${i + 1} of ${hunks.length} no longer matches the file: the code there was changed since the scan.`,
        };
      }
      if (at !== expected) moved += 1;
      lines.splice(at, hunk.old.length, ...hunk.new);
      drift = at - (hunk.oldStart - 1) + hunk.new.length - hunk.old.length;
    }
    const body = lines.join(eol);
    return { ok: true, text: lines.length ? body + (finalNewline ? eol : '') : '', changes: hunks.length, moved };
  }

  /** A repository-relative path split into its folders and file, or null when it could leave the folder. */
  function segments(path) {
    const parts = String(path ?? '').replace(/\\/g, '/').replace(/^\/+/, '').split('/');
    const bad = (part) => !part || part === '.' || part === '..' || part === '.git' || /[:\0]/.test(part);
    return parts.length && !parts.some(bad) ? parts : null;
  }

  /** host/owner/name of a git remote, for comparing https and ssh forms of one repository. */
  function repoKey(url) {
    let text = String(url ?? '').trim();
    const scp = text.match(/^[\w.-]+@([^:/]+):(.+)$/);
    if (scp) text = `${scp[1]}/${scp[2]}`;
    else text = text.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]*@/, '');
    return text.replace(/:\d+(?=\/)/, '').replace(/\.git\/?$/i, '').replace(/\/+$/, '').toLowerCase();
  }

  /** The remote addresses in a .git/config file's text. */
  function remotes(config) {
    return [...String(config ?? '').matchAll(/^\s*url\s*=\s*(.+?)\s*$/gm)].map((m) => m[1]);
  }

  /**
   * Text that is safe inside double quotes in cmd, PowerShell and a POSIX shell
   * (a finding's title comes from Checkmarx One): letters, digits and plain
   * punctuation only, so nothing can expand, escape or end the quote.
   */
  function shellSafe(text) {
    return String(text ?? '').replace(/[^\w .,:;/()+#@=?-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1200);
  }

  return { parse, apply, segments, repoKey, remotes, shellSafe };
})();
