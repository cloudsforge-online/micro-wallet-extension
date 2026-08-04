/* A QR encoder, in the wallet, offline.
 *
 * WHY THIS IS NOT A DEPENDENCY. A receive screen renders the address the user is about to be paid
 * at. A supply-chain compromise of a QR package is an address-swap attack with a perfect user
 * interface in front of it: the text says one address, the scanner reads another, and the user has
 * no way to notice. This is ~200 lines of finite-field arithmetic with no network access and no
 * configuration, and owning it removes a package from the trust boundary of the one screen where
 * being wrong costs money.
 *
 * WHY IT IS STILL NOT THE SOURCE OF TRUTH. The receive screen shows the full EIP-55 address in
 * text beside the code, always, and that text is what a user is told to check. The QR is a
 * convenience; the string is the truth. §5's wording is "receive with a QR code AND a checksummed
 * address", and the conjunction is doing work.
 *
 * WHAT KEEPS IT HONEST. test/qr.test.ts encodes and then DECODES with jsQR — a separate,
 * independent implementation — and asserts the decoded text is byte-identical to the input, across
 * every version this file supports and for real checksummed addresses. A self-check ("the matrix
 * has the right dimensions") is a check that cannot fail, which is the defect class this estate
 * keeps finding.
 *
 * Scope: byte mode, error-correction level M, versions 1–10 (up to 216 data codewords). An address
 * is 42 bytes and fits in version 3 exactly. Level M rather than L because a phone camera reads a
 * code off a screen at an angle, and rather than Q/H because those grow the module count and a
 * denser code is harder to scan, not easier.
 */

/* --------------------------------------------------------------- GF(256), the Reed–Solomon field */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // the QR generator polynomial for GF(2^8)
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255] as number;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[(LOG[a] as number) + (LOG[b] as number)] as number;
}

/**
 * The generator polynomial for `degree` error-correction codewords: (x−α⁰)(x−α¹)…(x−α^(degree−1)).
 *
 * COEFFICIENTS ARE HIGHEST DEGREE FIRST, and getting that backwards is the bug that cost the most
 * time in this file. The reversed polynomial is a perfectly valid polynomial, `rsEncode` runs
 * happily on it, and the result is a QR code that is structurally flawless — correct finders,
 * correct timing, correct format information, correct module count — and carries error-correction
 * bytes for a different message. Nothing about it looks wrong. Only a decoder says so, which is why
 * test/qr.test.ts decodes with jsQR instead of comparing matrices.
 *
 * The check that pins it down: for degree 2 the polynomial is x² + 3x + 2, so this must return
 * [1, 3, 2] and not [2, 3, 1].
 */
function rsGenerator(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j += 1) {
      // multiply by x: the coefficient keeps its index, the polynomial grows by one
      next[j] = (next[j] as number) ^ (poly[j] as number);
      // multiply by α^i: the coefficient moves one place down in degree
      next[j + 1] = (next[j + 1] as number) ^ gfMul(poly[j] as number, EXP[i] as number);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGenerator(ecCount);
  const remainder = new Uint8Array(ecCount);
  for (const byte of data) {
    const factor = byte ^ (remainder[0] as number);
    remainder.copyWithin(0, 1);
    remainder[ecCount - 1] = 0;
    for (let i = 0; i < ecCount; i += 1) {
      remainder[i] = (remainder[i] as number) ^ gfMul(gen[i + 1] as number, factor);
    }
  }
  return remainder;
}

/* ------------------------------------------------------------------------------ version tables */

interface VersionSpec {
  /** Error-correction codewords per block. */
  readonly ec: number;
  /** [blockCount, dataCodewordsPerBlock] for each of the one or two groups. */
  readonly groups: readonly (readonly [number, number])[];
  /** Alignment-pattern centre coordinates. */
  readonly align: readonly number[];
}

/**
 * Level M, versions 1–10, from ISO/IEC 18004 tables 9 and E.1.
 *
 * The suite cross-checks every row: total codewords must equal `4*v^2 + 16*v + 26 - remainderBits`
 * as computed from the module grid, and the round-trip through jsQR fails outright if a row is
 * wrong. A mistyped table is the likeliest defect in a file like this and it cannot survive either
 * check.
 */
const VERSIONS: readonly VersionSpec[] = [
  { ec: 10, groups: [[1, 16]], align: [] },
  { ec: 16, groups: [[1, 28]], align: [6, 18] },
  { ec: 26, groups: [[1, 44]], align: [6, 22] },
  { ec: 18, groups: [[2, 32]], align: [6, 26] },
  { ec: 24, groups: [[2, 43]], align: [6, 30] },
  { ec: 16, groups: [[4, 27]], align: [6, 34] },
  { ec: 18, groups: [[4, 31]], align: [6, 22, 38] },
  { ec: 22, groups: [[2, 38], [2, 39]], align: [6, 24, 42] },
  { ec: 22, groups: [[3, 36], [2, 37]], align: [6, 26, 46] },
  { ec: 26, groups: [[4, 43], [1, 44]], align: [6, 28, 50] },
];

function specFor(version: number): VersionSpec {
  const spec = VERSIONS[version - 1];
  if (spec === undefined) throw new Error(`qr: version ${version} is outside 1–10`);
  return spec;
}

function dataCapacity(version: number): number {
  return specFor(version).groups.reduce((sum, [count, size]) => sum + count * size, 0);
}

/* ------------------------------------------------------------------------------- the bit stream */

class BitBuffer {
  private readonly bits: number[] = [];

  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }

  get length(): number { return this.bits.length; }

  toCodewords(count: number): Uint8Array {
    const out = new Uint8Array(count);
    for (let i = 0; i < this.bits.length; i += 1) {
      if (this.bits[i] === 1) out[i >> 3] = (out[i >> 3] as number) | (0x80 >> (i & 7));
    }
    return out;
  }
}

/* ------------------------------------------------------------------------------- the matrix ---- */

const FUNCTION = 2; // a third state: "this module is structural and must never be masked"

function placeFinder(m: Int8Array, size: number, row: number, col: number): void {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const y = row + r;
      const x = col + c;
      if (y < 0 || y >= size || x < 0 || x >= size) continue;
      const onRing = (r >= 0 && r <= 6 && (c === 0 || c === 6))
        || (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      m[y * size + x] = (onRing || inCore ? 1 : 0) | FUNCTION;
    }
  }
}

function placeAlignment(m: Int8Array, size: number, centres: readonly number[]): void {
  for (const cy of centres) {
    for (const cx of centres) {
      // The three corners already hold finder patterns.
      const atFinder = (cy <= 8 && cx <= 8) || (cy <= 8 && cx >= size - 9) || (cy >= size - 9 && cx <= 8);
      if (atFinder) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          const on = Math.max(Math.abs(r), Math.abs(c)) !== 1;
          m[(cy + r) * size + (cx + c)] = (on ? 1 : 0) | FUNCTION;
        }
      }
    }
  }
}

function placeTiming(m: Int8Array, size: number): void {
  for (let i = 8; i < size - 8; i += 1) {
    const bit = i % 2 === 0 ? 1 : 0;
    if ((m[6 * size + i] as number) === -1) m[6 * size + i] = bit | FUNCTION;
    if ((m[i * size + 6] as number) === -1) m[i * size + 6] = bit | FUNCTION;
  }
}

/** BCH(15,5) format information for level M and the chosen mask. */
function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask; // 00 = error-correction level M
  let bch = data << 10;
  for (let i = 4; i >= 0; i -= 1) {
    if (bch & (1 << (i + 10))) bch ^= 0b10100110111 << i;
  }
  return ((data << 10) | bch) ^ 0b101010000010010;
}

/**
 * BCH(18,6) version information, present only from version 7.
 *
 * The generator is x¹²+x¹¹+x¹⁰+x⁹+x⁸+x⁵+x²+1 — THIRTEEN bits, 0b1111100100101. It was written with
 * three bits missing the first time, which is invisible below version 7 because versions 1–6 carry
 * no version block at all: the encoder was correct for every size an address fits in and wrong for
 * every size above it. The check that pins it: version 7's information word is 0x07C94.
 */
const VERSION_GENERATOR = 0b1111100100101;

function versionBits(version: number): number {
  let bch = version << 12;
  for (let i = 5; i >= 0; i -= 1) {
    if (bch & (1 << (i + 12))) bch ^= VERSION_GENERATOR << i;
  }
  return (version << 12) | bch;
}

/**
 * The two copies of the format information, at the coordinates ISO/IEC 18004 §8.9 gives them.
 *
 * THESE COORDINATES WERE WRONG THE FIRST TIME — transposed, row for column — and every version
 * this encoder produces was unreadable as a result. Nothing about the output looked wrong: the
 * finder patterns were in place, the module count was right, the SVG rendered a convincing QR
 * code. It took the jsQR round-trip in test/qr.test.ts to say so, which is exactly the argument
 * for having an independent decoder as the oracle rather than asserting against our own matrix.
 */
function placeFormat(m: Int8Array, size: number, mask: number): void {
  const bits = formatBits(mask);
  const put = (row: number, col: number, bit: number): void => { m[row * size + col] = bit | FUNCTION; };

  for (let i = 0; i < 15; i += 1) {
    const bit = (bits >> i) & 1;

    // Copy one, wrapped around the top-left finder: down column 8, then left along row 8.
    if (i <= 5) put(i, 8, bit);
    else if (i === 6) put(7, 8, bit);
    else if (i === 7) put(8, 8, bit);
    else if (i === 8) put(8, 7, bit);
    else put(8, 14 - i, bit);

    // Copy two, split between the other two finders, so damage to one corner is survivable.
    if (i < 8) put(8, size - 1 - i, bit);
    else put(size - 15 + i, 8, bit);
  }
  put(size - 8, 8, 1); // the always-dark module
}

function placeVersion(m: Int8Array, size: number, version: number): void {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i += 1) {
    const bit = (bits >> i) & 1;
    const row = Math.floor(i / 3);
    const col = size - 11 + (i % 3);
    m[row * size + col] = bit | FUNCTION;
    m[col * size + row] = bit | FUNCTION;
  }
}

function maskAt(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

/** ISO/IEC 18004 §8.8.2 penalty rules, used to pick the mask that scans most reliably. */
function penalty(bits: Uint8Array, size: number): number {
  let score = 0;
  const at = (r: number, c: number): number => bits[r * size + c] as number;

  for (let axis = 0; axis < 2; axis += 1) {
    for (let a = 0; a < size; a += 1) {
      let run = 1;
      let previous = axis === 0 ? at(a, 0) : at(0, a);
      for (let b = 1; b < size; b += 1) {
        const value = axis === 0 ? at(a, b) : at(b, a);
        if (value === previous) {
          run += 1;
        } else {
          if (run >= 5) score += run - 2;
          run = 1;
          previous = value;
        }
      }
      if (run >= 5) score += run - 2;
    }
  }

  for (let r = 0; r + 1 < size; r += 1) {
    for (let c = 0; c + 1 < size; c += 1) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
    }
  }

  const pattern = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const reversed = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let axis = 0; axis < 2; axis += 1) {
    for (let a = 0; a < size; a += 1) {
      for (let b = 0; b + 11 <= size; b += 1) {
        let forward = true;
        let backward = true;
        for (let k = 0; k < 11; k += 1) {
          const value = axis === 0 ? at(a, b + k) : at(b + k, a);
          if (value !== pattern[k]) forward = false;
          if (value !== reversed[k]) backward = false;
        }
        if (forward || backward) score += 40;
      }
    }
  }

  let dark = 0;
  for (const bit of bits) dark += bit;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

export interface QrCode {
  readonly size: number;
  readonly version: number;
  /** Row-major, 1 = dark. */
  readonly modules: Uint8Array;
  isDark(row: number, col: number): boolean;
}

/**
 * Encode `text` as a QR code.
 *
 * `text` is encoded as UTF-8 bytes in byte mode. Addresses are ASCII, so this is exact for them and
 * correct for anything else a receive screen might carry (an `ethereum:` URI, a memo).
 */
export function encodeQr(text: string): QrCode {
  const payload = new TextEncoder().encode(text);

  let version = 0;
  for (let v = 1; v <= 10; v += 1) {
    // 4 bits of mode + 8 (v1–9) or 16 (v10+) bits of length + the payload.
    const headerBits = 4 + (v < 10 ? 8 : 16);
    if (headerBits + payload.length * 8 <= dataCapacity(v) * 8) { version = v; break; }
  }
  if (version === 0) {
    throw new Error(`qr: ${payload.length} bytes does not fit in version 10 at level M — this encoder covers addresses and URIs, not documents`);
  }

  const spec = specFor(version);
  const totalData = dataCapacity(version);
  const buffer = new BitBuffer();
  buffer.push(0b0100, 4); // byte mode
  buffer.push(payload.length, version < 10 ? 8 : 16);
  for (const byte of payload) buffer.push(byte, 8);
  // Terminator, then pad to a codeword boundary, then the two alternating pad codewords.
  buffer.push(0, Math.min(4, totalData * 8 - buffer.length));
  if (buffer.length % 8 !== 0) buffer.push(0, 8 - (buffer.length % 8));
  const codewords = buffer.toCodewords(totalData);
  for (let i = buffer.length / 8, alternate = 0; i < totalData; i += 1, alternate += 1) {
    codewords[i] = alternate % 2 === 0 ? 0xec : 0x11;
  }

  // Split into blocks, compute error correction per block, then INTERLEAVE. Interleaving is what
  // makes a QR code survive a thumb over one corner: a burst of damage is spread across every
  // block instead of destroying one block entirely.
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const [count, size] of spec.groups) {
    for (let i = 0; i < count; i += 1) {
      const block = codewords.subarray(offset, offset + size);
      offset += size;
      dataBlocks.push(block);
      ecBlocks.push(rsEncode(block, spec.ec));
    }
  }
  const interleaved: number[] = [];
  const longestData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < longestData; i += 1) {
    for (const block of dataBlocks) if (i < block.length) interleaved.push(block[i] as number);
  }
  for (let i = 0; i < spec.ec; i += 1) {
    for (const block of ecBlocks) interleaved.push(block[i] as number);
  }

  const size = version * 4 + 17;
  const template = new Int8Array(size * size).fill(-1);
  placeFinder(template, size, 0, 0);
  placeFinder(template, size, 0, size - 7);
  placeFinder(template, size, size - 7, 0);
  placeAlignment(template, size, spec.align);
  placeTiming(template, size);
  placeVersion(template, size, version);
  placeFormat(template, size, 0); // reserved now; rewritten per mask below

  // Zig-zag placement: two-column strips walked right to left, alternating up and down.
  //
  // THE TIMING COLUMN IS SKIPPED BY MOVING THE STRIP, NOT BY SKIPPING A CELL. Column 6 is the
  // vertical timing pattern; when the walk reaches it the strip becomes columns 5 and 4, and the
  // remaining strips are 3/2 and 1/0. The first attempt here simply decremented the column, which
  // produced the pair (0, -1) at the last strip — and `template[row * size - 1]` is not out of
  // bounds, it is the LAST CELL OF THE PREVIOUS ROW. So data was written over a module that had
  // already been written, silently, and only the final columns of the code were corrupt. An index
  // that wraps instead of throwing is why this needed a decoder to find.
  const positions: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if ((template[row * size + col] as number) === -1) positions.push(row * size + col);
      }
    }
  }

  let best: Uint8Array | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestMask = 0;
  for (let mask = 0; mask < 8; mask += 1) {
    const grid = new Int8Array(template);
    placeFormat(grid, size, mask);
    for (let i = 0; i < positions.length; i += 1) {
      const index = positions[i] as number;
      const bit = i < interleaved.length * 8
        ? ((interleaved[i >> 3] as number) >> (7 - (i & 7))) & 1
        : 0; // the remainder bits, which are always zero before masking
      const row = Math.floor(index / size);
      const col = index % size;
      grid[index] = bit ^ (maskAt(mask, row, col) ? 1 : 0);
    }
    const flat = new Uint8Array(size * size);
    for (let i = 0; i < flat.length; i += 1) flat[i] = (grid[i] as number) & 1;
    const score = penalty(flat, size);
    if (score < bestScore) { bestScore = score; best = flat; bestMask = mask; }
  }
  if (best === null) throw new Error('qr: no mask was selected');
  void bestMask;

  const modules = best;
  return {
    size,
    version,
    modules,
    isDark: (row: number, col: number): boolean => modules[row * size + col] === 1,
  };
}

/**
 * The code as an SVG string.
 *
 * SVG rather than a canvas because the popup renders at whatever the user's zoom is, and a scaled
 * bitmap QR gains interpolation blur between modules that a phone camera reads as noise. `quiet` is
 * four modules, which is the specified minimum — a code flush against a coloured panel does not
 * scan at all, and this is the single most common way a working encoder produces an unreadable code.
 */
export function qrToSvg(code: QrCode, options: { dark?: string; light?: string; quiet?: number } = {}): string {
  const quiet = options.quiet ?? 4;
  const dark = options.dark ?? '#0d0b0a';
  const light = options.light ?? '#f5efe8';
  const span = code.size + quiet * 2;
  let path = '';
  for (let row = 0; row < code.size; row += 1) {
    for (let col = 0; col < code.size; col += 1) {
      if (code.isDark(row, col)) path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${span}" height="${span}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
}
