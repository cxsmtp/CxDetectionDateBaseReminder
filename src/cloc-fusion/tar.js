// Vendored from cloc-fusion 1.3.2 (commit 1a320621d0f5), MIT licence: src/cloc-fusion/LICENSE. Do not edit here: scripts/sync-cloc-fusion.mjs copies it again.
// A tar parser on plain byte arrays (Uint8Array), with no Node APIs, so the CLI (src/archive.js)
// and the standalone HTML page share it. Entry names are only text: nothing is ever written to
// disk. Wanted files are handed over whole, up to `maxFileBytes`; metadata entries are capped.

const BLOCK = 512;
const utf8 = new TextDecoder();

const text = (buf, start, len) => {
  const s = buf.subarray(start, start + len);
  const nul = s.indexOf(0);
  return utf8.decode(nul < 0 ? s : s.subarray(0, nul));
};

function octal(buf, start, len) {
  const s = buf.subarray(start, start + len);
  if (s[0] & 0x80) {
    // GNU base-256 for sizes over 8 GB.
    let n = 0;
    for (let i = 1; i < s.length; i++) n = n * 256 + s[i];
    return n;
  }
  const t = text(buf, start, len).trim();
  return t ? parseInt(t, 8) : 0;
}

/** pax extended header records ("len key=value\n") → { key: value }. */
function paxRecords(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(32, i);
    if (sp < 0) break;
    const len = parseInt(utf8.decode(buf.subarray(i, sp)), 10);
    if (!len || len < 0 || i + len > buf.length) break;
    const rec = utf8.decode(buf.subarray(sp + 1, i + len - 1));
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

export function concatBytes(parts) {
  if (parts.length === 1) return parts[0];
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const EMPTY = new Uint8Array(0);

/**
 * Feed it the tar stream with push(chunk). For every regular file, `onEntry({ path, size })`
 * returns whether its content is wanted; wanted files are passed whole to `onFile(entry, bytes)`.
 */
export class TarParser {
  constructor({ onEntry, onFile, maxFileBytes = 2 * 1024 * 1024, maxMetaBytes = 1024 * 1024 }) {
    this.onEntry = onEntry;
    this.onFile = onFile;
    this.maxFileBytes = maxFileBytes;
    this.maxMetaBytes = maxMetaBytes;
    this.buf = EMPTY;
    this.state = 'header';
    this.entry = null;
    this.remaining = 0; // content bytes of the current entry still to come
    this.padding = 0;
    this.chunks = null;
    this.nextPath = null; // from a pax 'x' or GNU 'L' entry
    this.done = false;
    this.entries = 0;
  }

  push(chunk) {
    if (this.done) return;
    this.buf = this.buf.length ? concatBytes([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.state === 'header') {
        if (this.buf.length < BLOCK) return;
        const h = this.buf.subarray(0, BLOCK);
        this.buf = this.buf.subarray(BLOCK);
        if (h.every((b) => b === 0)) {
          this.done = true; // end of archive
          return;
        }
        const size = octal(h, 124, 12);
        const type = String.fromCharCode(h[156] || 48);
        const prefix = text(h, 257, 5) === 'ustar' ? text(h, 345, 155) : '';
        const name = this.nextPath ?? (prefix ? `${prefix}/${text(h, 0, 100)}` : text(h, 0, 100));
        this.nextPath = null;
        this.remaining = size;
        this.padding = (BLOCK - (size % BLOCK)) % BLOCK;
        if (type === 'x' || type === 'L' || type === 'g') {
          if (size > this.maxMetaBytes) throw new Error('archive metadata entry too large');
          this.entry = { meta: type };
          this.chunks = [];
        } else if (type === '0' || type === '\0' || type === '7') {
          this.entries++;
          const e = { path: name, size };
          const want = size <= this.maxFileBytes && this.onEntry(e);
          this.entry = want ? e : null;
          this.chunks = want ? [] : null;
        } else {
          this.entry = null; // directories, links, devices: skipped
          this.chunks = null;
        }
        this.state = 'body';
      }
      if (this.state === 'body') {
        if (this.remaining > 0) {
          if (!this.buf.length) return;
          const take = Math.min(this.remaining, this.buf.length);
          if (this.chunks) this.chunks.push(this.buf.subarray(0, take));
          this.buf = this.buf.subarray(take);
          this.remaining -= take;
          if (this.remaining > 0) return;
        }
        if (this.chunks) {
          const content = this.chunks.length ? concatBytes(this.chunks) : EMPTY;
          if (this.entry.meta === 'x') this.nextPath = paxRecords(content).path ?? null;
          else if (this.entry.meta === 'L') this.nextPath = text(content, 0, content.length);
          else if (!this.entry.meta) this.onFile(this.entry, content);
        }
        this.chunks = null;
        this.entry = null;
        this.state = 'pad';
      }
      if (this.state === 'pad') {
        if (this.buf.length < this.padding) {
          this.padding -= this.buf.length;
          this.buf = EMPTY;
          return;
        }
        this.buf = this.buf.subarray(this.padding);
        this.padding = 0;
        this.state = 'header';
      }
    }
  }
}

/** Strip the archive's single top-level folder ("owner-repo-sha/src/a.js" → "src/a.js"). */
export function stripTop(path) {
  const i = path.indexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}
