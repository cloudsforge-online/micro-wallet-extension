/* The QR encoder, checked by DECODING what it produced with somebody else's decoder.
 *
 * This is the oracle pattern the signing core uses against `hearth/node`, applied to the one piece
 * of non-trivial arithmetic this repository owns. `jsQR` is an independent implementation of the
 * standard, written by people who have never seen src/shared/qr.ts, and it either reads the exact
 * string back or it does not. A test that checked the matrix against a snapshot of the matrix would
 * pass forever while the code produced an unscannable code — that is the defect class this estate
 * keeps finding, and it is why jsQR is a devDependency.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { encodeQr, qrToSvg } from '../src/shared/qr.ts';

// jsqr ships CommonJS with a `default` export, which `import jsQR from 'jsqr'` cannot express under
// `moduleResolution: nodenext` without `esModuleInterop` — and turning that on for the whole
// repository to satisfy one test dependency would relax a setting that is otherwise doing its job.
const require = createRequire(import.meta.url);
const jsQR = require('jsqr') as (
  data: Uint8ClampedArray, width: number, height: number,
) => { data: string } | null;

/** Render the modules at 4x with the required 4-module quiet zone, as RGBA for jsQR. */
function rasterise(text: string): { data: Uint8ClampedArray; width: number; height: number } {
  const code = encodeQr(text);
  const scale = 4;
  const quiet = 4;
  const span = (code.size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(span * span * 4).fill(255);
  for (let y = 0; y < span; y += 1) {
    for (let x = 0; x < span; x += 1) {
      const row = Math.floor(y / scale) - quiet;
      const col = Math.floor(x / scale) - quiet;
      const dark = row >= 0 && col >= 0 && row < code.size && col < code.size && code.isDark(row, col);
      const at = (y * span + x) * 4;
      data[at] = dark ? 0 : 255;
      data[at + 1] = dark ? 0 : 255;
      data[at + 2] = dark ? 0 : 255;
      data[at + 3] = 255;
    }
  }
  return { data, width: span, height: span };
}

function roundTrip(text: string): string {
  const image = rasterise(text);
  const decoded = jsQR(image.data, image.width, image.height);
  assert.notEqual(decoded, null, `jsQR could not read the code this encoder produced for ${JSON.stringify(text.slice(0, 40))}`);
  return decoded!.data;
}

test('a checksummed address survives the round trip byte for byte', () => {
  // Real EIP-55 addresses, mixed case. The case matters: the checksum is the capitalisation, so a
  // QR that lowercased anything would be a QR that loses the check.
  const addresses = [
    '0x35D7600Ad32DBFdb197841B4733eE6ad8E38e3b9',
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
  ];
  for (const address of addresses) {
    assert.equal(roundTrip(address), address);
  }
});

test('an address encodes at version 3, which is the smallest that holds 42 bytes at level M', () => {
  const code = encodeQr('0x35D7600Ad32DBFdb197841B4733eE6ad8E38e3b9');
  assert.equal(code.version, 3);
  assert.equal(code.size, 3 * 4 + 17);
});

test('every supported version round-trips, so no row of the table is mistyped', () => {
  // One payload per version boundary. If a version's error-correction count, block layout or
  // alignment-pattern list were wrong, jsQR would fail to read that version and only that version —
  // which is exactly the bug a size-only assertion would miss.
  const seen = new Set<number>();
  for (let length = 10; length <= 210; length += 7) {
    const text = 'A'.repeat(length);
    const code = encodeQr(text);
    assert.equal(roundTrip(text), text, `version ${code.version} failed at ${length} bytes`);
    seen.add(code.version);
  }
  assert.ok(seen.size >= 8, `expected to exercise most versions, only saw ${[...seen].sort((a, b) => a - b).join(', ')}`);
});

test('a payload too large to encode is refused rather than truncated', () => {
  assert.throws(() => encodeQr('x'.repeat(400)), /does not fit in version 10/);
});

test('an ethereum: URI round-trips, because a receive screen may carry one', () => {
  const uri = 'ethereum:0x35D7600Ad32DBFdb197841B4733eE6ad8E38e3b9@7412';
  assert.equal(roundTrip(uri), uri);
});

test('the SVG carries the four-module quiet zone that makes a code scannable at all', () => {
  const code = encodeQr('0x35D7600Ad32DBFdb197841B4733eE6ad8E38e3b9');
  const svg = qrToSvg(code);
  assert.match(svg, new RegExp(`viewBox="0 0 ${code.size + 8} ${code.size + 8}"`));
  assert.match(svg, /<rect width="\d+" height="\d+" fill="#f5efe8"\/>/);
});

test('utf-8 text round-trips, so the encoder is not quietly ASCII-only', () => {
  const text = 'Hearth — ember · 7412';
  assert.equal(roundTrip(text), text);
});
