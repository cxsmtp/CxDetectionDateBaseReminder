/**
 * A QR code for a short text, made here: nothing is fetched and no library is used, so the page works
 * on a network with no way out. It is what Settings → Your profile → Two-step sign-in shows for an
 * authenticator app to scan.
 *
 * ISO/IEC 18004 (model 2): the text as bytes (UTF-8), error correction level M, versions 1 to 20
 * (up to 666 bytes), the mask with the lowest penalty. The tests compare every version and every mask
 * with matrices made by an independent encoder (test/fixtures/qr-reference.json).
 */

// Level M, by version: [error correction codewords per block, blocks in group 1, data codewords in each, blocks in group 2, data codewords in each].
const BLOCKS = [
  null,
  [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44],
  [30, 1, 50, 4, 51], [22, 6, 36, 2, 37], [22, 8, 37, 1, 38], [24, 4, 40, 5, 41], [24, 5, 41, 5, 42],
  [28, 7, 45, 3, 46], [28, 10, 46, 1, 47], [26, 9, 43, 4, 44], [26, 3, 44, 11, 45], [26, 3, 41, 13, 42],
];
// Where the alignment patterns' centres sit, by version.
const ALIGNMENT = [
  null,
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78],
  [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
];
export const QR_MAX_VERSION = BLOCKS.length - 1;

const dataCodewords = (version) => {
  const [, blocks1, data1, blocks2, data2] = BLOCKS[version];
  return blocks1 * data1 + blocks2 * data2;
};
/** How many bytes of text a version holds: its data codewords less the mode (4 bits) and the length (8 or 16 bits). */
const capacity = (version) => Math.floor((dataCodewords(version) * 8 - 4 - (version < 10 ? 8 : 16)) / 8);
/** The most bytes of text a code made here can hold. */
export const QR_MAX_BYTES = capacity(QR_MAX_VERSION);

// GF(256) with the polynomial x^8 + x^4 + x^3 + x^2 + 1, for the Reed-Solomon error correction.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i += 1) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
const multiply = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** The generator polynomial for `count` error correction codewords: its coefficients, highest first, without the leading 1. */
function generator(count) {
  const g = new Array(count).fill(0);
  g[count - 1] = 1;
  let root = 1;
  for (let i = 0; i < count; i += 1) {
    for (let j = 0; j < count; j += 1) {
      g[j] = multiply(g[j], root);
      if (j + 1 < count) g[j] ^= g[j + 1];
    }
    root = multiply(root, 2);
  }
  return g;
}

/** The error correction codewords of one block. */
function errorCorrection(data, count) {
  const g = generator(count);
  const rest = new Array(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ rest.shift();
    rest.push(0);
    for (let i = 0; i < count; i += 1) rest[i] ^= multiply(g[i], factor);
  }
  return rest;
}

/** The text as the codewords the code carries: mode, length, bytes, padding; split into blocks, each with its error correction; interleaved. */
function codewords(bytes, version) {
  const total = dataCodewords(version);
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, total * 8 - bits.length)); // the terminator, as much of it as fits
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  for (let pad = 0xec; data.length < total; pad ^= 0xec ^ 0x11) data.push(pad);

  const [ecCount, blocks1, data1, blocks2, data2] = BLOCKS[version];
  const blocks = [];
  let at = 0;
  for (let i = 0; i < blocks1 + blocks2; i += 1) {
    const size = i < blocks1 ? data1 : data2;
    const block = data.slice(at, at + size);
    at += size;
    blocks.push({ data: block, ec: errorCorrection(block, ecCount) });
  }
  const out = [];
  for (let i = 0; i < Math.max(data1, data2); i += 1) for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  for (let i = 0; i < ecCount; i += 1) for (const block of blocks) out.push(block.ec[i]);
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** The 15 format bits for level M and a mask: 5 bits of data, 10 of error correction (BCH), then the fixed pattern. */
function formatBits(mask) {
  const data = (0b00 << 3) | mask; // 00 is level M
  let rest = data;
  for (let i = 0; i < 10; i += 1) rest = (rest << 1) ^ ((rest >>> 9) * 0x537);
  return ((data << 10) | rest) ^ 0x5412;
}

/** The 18 version bits (versions 7 and up): 6 bits of data, 12 of error correction (BCH). */
function versionBits(version) {
  let rest = version;
  for (let i = 0; i < 12; i += 1) rest = (rest << 1) ^ ((rest >>> 11) * 0x1f25);
  return (version << 12) | rest;
}

/** How hard a finished code is to read (the four rules of the standard): the mask with the lowest score is used. */
function penalty(modules) {
  const size = modules.length;
  let score = 0;
  let dark = 0;
  const line = (get) => {
    // Rule 1: five or more of one colour in a row. Rule 3: what looks like a finder pattern (1:1:3:1:1 with four light beside it).
    let run = 1;
    for (let i = 1; i <= size; i += 1) {
      if (i < size && get(i) === get(i - 1)) run += 1;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    for (let i = 0; i + 10 < size; i += 1) {
      const at = (k) => get(i + k);
      const core = (o) => at(o) && !at(o + 1) && at(o + 2) && at(o + 3) && at(o + 4) && !at(o + 5) && at(o + 6);
      const light = (o) => !at(o) && !at(o + 1) && !at(o + 2) && !at(o + 3);
      if ((core(0) && light(7)) || (light(0) && core(4))) score += 40;
    }
  };
  for (let y = 0; y < size; y += 1) {
    line((x) => modules[y][x]);
    for (let x = 0; x < size; x += 1) {
      if (modules[y][x]) dark += 1;
      // Rule 2: a 2 by 2 square of one colour.
      if (x + 1 < size && y + 1 < size && modules[y][x] === modules[y][x + 1] && modules[y][x] === modules[y + 1][x] && modules[y][x] === modules[y + 1][x + 1]) score += 3;
    }
  }
  for (let x = 0; x < size; x += 1) line((y) => modules[y][x]);
  // Rule 4: far from half dark.
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/**
 * The QR code of `text`: { version, size, mask, modules } where modules[y][x] is true for a dark square.
 * `mask` (0 to 7) forces a mask; left out, the one with the lowest penalty is used. Throws a RangeError
 * when the text is longer than a version 20 code holds (QR_MAX_BYTES).
 */
export function qrMatrix(text, { mask = null } = {}) {
  const bytes = [...new TextEncoder().encode(String(text ?? ''))];
  let version = 1;
  while (version <= QR_MAX_VERSION && capacity(version) < bytes.length) version += 1;
  if (version > QR_MAX_VERSION) throw new RangeError(`Too long for a QR code made here: ${bytes.length} bytes, at most ${QR_MAX_BYTES}.`);
  const size = 17 + 4 * version;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => {
    modules[y][x] = Boolean(dark);
    fixed[y][x] = true;
  };

  // Timing patterns, then the three finder patterns with their separators, then the alignment patterns.
  for (let i = 0; i < size; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const [x, y] = [cx + dx, cy + dy];
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, ring !== 2 && ring !== 4);
      }
    }
  }
  const centres = ALIGNMENT[version];
  const last = centres.length - 1;
  centres.forEach((cy, i) =>
    centres.forEach((cx, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return; // a finder pattern is there
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }),
  );

  /** The format bits, twice: around the top-left finder, and split between the other two. With the dark module. */
  const drawFormat = (bits) => {
    const bit = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0); // reserves the squares; the real bits follow once the mask is known
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >>> i) & 1) === 1;
      const [a, b] = [size - 11 + (i % 3), Math.floor(i / 3)];
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  // The codewords, in a zigzag of two-square columns from the bottom right, going up then down, around what is fixed.
  const data = codewords(bytes, version);
  let at = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing pattern's column is skipped
    for (let step = 0; step < size; step += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - step : step;
        if (fixed[y][x] || at >= data.length * 8) continue;
        modules[y][x] = ((data[at >>> 3] >>> (7 - (at & 7))) & 1) === 1;
        at += 1;
      }
    }
  }

  const applyMask = (index) => {
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (!fixed[y][x] && MASKS[index](x, y)) modules[y][x] = !modules[y][x];
  };
  let chosen = Number.isInteger(mask) && mask >= 0 && mask <= 7 ? mask : -1;
  if (chosen < 0) {
    let best = Infinity;
    for (let index = 0; index < 8; index += 1) {
      applyMask(index);
      drawFormat(formatBits(index));
      const score = penalty(modules);
      if (score < best) {
        best = score;
        chosen = index;
      }
      applyMask(index); // masking twice puts the squares back
    }
  }
  applyMask(chosen);
  drawFormat(formatBits(chosen));
  return { version, size, mask: chosen, modules };
}

/**
 * The code as one SVG path (dark squares, each row's runs joined), with the quiet border the standard
 * asks for around it: { viewBox, d }. The page draws it black on white whatever the theme, so a phone reads it.
 */
export function qrSvgPath(text, { quiet = 4 } = {}) {
  const { size, modules } = qrMatrix(text);
  const parts = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!modules[y][x]) continue;
      let end = x;
      while (end + 1 < size && modules[y][end + 1]) end += 1;
      parts.push(`M${x + quiet} ${y + quiet}h${end - x + 1}v1h-${end - x + 1}z`);
      x = end;
    }
  }
  const side = size + quiet * 2;
  return { side, viewBox: `0 0 ${side} ${side}`, d: parts.join('') };
}
