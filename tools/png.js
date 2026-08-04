/* A forty-line PNG writer, so that the placeholder icons are a build artefact rather than a
 * committed binary nobody can diff.
 *
 * Chrome's manifest accepts PNG, BMP, GIF, ICO and JPEG for `icons` — not SVG — so an extension
 * with no raster icons has no toolbar icon at all. micro-wallet-assets is being generated in
 * parallel (25-wallet-clients.md §6 lists the extension group: 16, 32, 48, 128, toolbar icons in
 * both polarities, a badge overlay), and until it lands the build draws these. `tools/build.js`
 * prints a loud line when it does, so this is visible rather than forgotten.
 *
 * Nothing here is art. It is a flat ash square with an ember lozenge, in the two brand colours, at
 * whatever size is asked for — deliberately plain so that nobody mistakes it for the real mark.
 */

import { deflateSync } from 'node:zlib';

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** `pixel(x, y)` returns [r, g, b, a]. Returns a complete PNG as a Buffer. */
export function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset++] = 0; // filter type 0 (none) — smallest code, and these images are tiny
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      raw[offset++] = r; raw[offset++] = g; raw[offset++] = b; raw[offset++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const ASH = [20, 17, 16, 255];
const EMBER = [232, 98, 44, 255];

/** The placeholder mark: an ash tile with a rounded corner radius and an ember flame lozenge. */
export function placeholderIcon(size) {
  const radius = size * 0.21;
  const cx = size / 2;
  return png(size, (x, y) => {
    // Rounded-rectangle mask.
    const dx = Math.max(radius - x - 0.5, 0, x + 0.5 - (size - radius));
    const dy = Math.max(radius - y - 0.5, 0, y + 0.5 - (size - radius));
    if (Math.hypot(dx, dy) > radius) return [0, 0, 0, 0];
    // A teardrop: a circle below, tapering to a point above.
    const top = size * 0.2;
    const bottom = size * 0.82;
    const t = (y + 0.5 - top) / (bottom - top);
    if (t >= 0 && t <= 1) {
      const halfWidth = size * 0.3 * Math.sin(Math.PI * Math.min(1, t * 0.82 + 0.02));
      if (Math.abs(x + 0.5 - cx) <= halfWidth) return EMBER;
    }
    return ASH;
  });
}
