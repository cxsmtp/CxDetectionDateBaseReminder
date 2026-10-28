// Vendored from cloc-fusion 1.3.2 (commit 1a320621d0f5), MIT licence: src/cloc-fusion/LICENSE. Do not edit here: scripts/sync-cloc-fusion.mjs copies it again.
// Reading repository archives without any external tool: a streaming .tar.gz reader (GitHub,
// GitLab, Bitbucket) and a .zip reader (Azure DevOps), both on Node's built-in zlib.
//
// Both are defensive about what they read: entry names are only used as text (never as file
// paths: nothing is extracted to disk), sizes are bounded, and decompression stops past a limit,
// so a hostile or corrupt archive cannot exhaust memory or disk.
import { createGunzip, inflateRawSync } from 'node:zlib';
import { open } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { TarParser } from './tar.js';

export { stripTop } from './tar.js';

/**
 * A Writable that parses a tar stream (src/tar.js does the parsing). For every regular file,
 * `onEntry({ path, size })` returns whether its content is wanted; wanted files are passed whole to
 * `onFile({ path, size }, Buffer)`. `maxFileBytes` bounds a wanted file's buffer.
 */
export class TarReader extends Writable {
  constructor({ onEntry, onFile, maxFileBytes = 2 * 1024 * 1024, maxMetaBytes = 1024 * 1024 }) {
    super();
    this.parser = new TarParser({ onEntry, onFile: (e, bytes) => onFile(e, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length)), maxFileBytes, maxMetaBytes });
  }

  get entries() {
    return this.parser.entries;
  }

  _write(chunk, _enc, cb) {
    try {
      this.parser.push(chunk);
      cb();
    } catch (err) {
      cb(err);
    }
  }
}

/** Counts bytes through a stream and fails past `limit` (a decompression bomb guard). */
function limiter(limit, what) {
  let seen = 0;
  return async function* (source) {
    for await (const chunk of source) {
      seen += chunk.length;
      if (seen > limit) throw new Error(`${what} is larger than ${Math.round(limit / 1048576)} MB uncompressed (raise maxArchiveBytes, or use the git engine)`);
      yield chunk;
    }
  };
}

/** Read a .tar.gz web stream / async iterable. See TarReader for the callbacks. */
export async function readTarGz(body, { onEntry, onFile, maxFileBytes, maxArchiveBytes = 4 * 1024 ** 3 }) {
  const reader = new TarReader({ onEntry, onFile, maxFileBytes });
  await pipeline(body, createGunzip(), limiter(maxArchiveBytes, 'the archive'), reader);
  return { entries: reader.entries };
}

/**
 * Read a .zip file on disk (random access: the central directory is at the end). Same callbacks.
 * Supports stored and deflated entries; zip64 archives are refused with a clear message.
 */
export async function readZipFile(path, { onEntry, onFile, maxFileBytes = 2 * 1024 * 1024, maxArchiveBytes = 4 * 1024 ** 3 }) {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('not a zip archive');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('zip64 archives are not supported: use the git engine for this repository');
    if (cdOffset + cdSize > size) throw new Error('corrupt zip archive');
    // The directory's size comes from the file itself: bound it before allocating (a million entries fit well within).
    if (cdSize > 256 * 1024 * 1024) throw new Error('zip central directory is too large: use the git engine for this repository');
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    let p = 0;
    let entries = 0;
    let inflated = 0; // all output so far, bounded like a tarball's
    const offsets = new Set(); // entries sharing data would multiply the work
    if (count > 1000000) throw new Error('zip archive has too many entries');
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
      const method = cd.readUInt16LE(p + 10);
      const csize = cd.readUInt32LE(p + 20);
      const usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const local = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nameLen).toString('utf8');
      p += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith('/')) continue;
      entries++;
      const e = { path: name, size: usize };
      if (usize > maxFileBytes || !onEntry(e)) continue;
      if (method !== 0 && method !== 8) continue;
      if (csize > maxFileBytes * 2 + 1024) continue;
      if (offsets.has(local)) continue;
      offsets.add(local);
      if (local + 30 > size || csize > size) throw new Error('corrupt zip entry');
      const lh = Buffer.alloc(30);
      await fh.read(lh, 0, 30, local);
      if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('corrupt zip entry');
      const dataStart = local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const data = Buffer.alloc(csize);
      await fh.read(data, 0, csize, dataStart);
      const content = method === 0 ? data : inflateRawSync(data, { maxOutputLength: maxFileBytes + 1 });
      inflated += content.length;
      if (inflated > maxArchiveBytes) throw new Error(`the archive is larger than ${Math.round(maxArchiveBytes / 1048576)} MB uncompressed (raise maxArchiveBytes, or use the git engine)`);
      if (content.length <= maxFileBytes) onFile(e, content);
    }
    return { entries };
  } finally {
    await fh.close();
  }
}
