/**
 * The empty-state illustrations: import them from micro-wallet-assets, then regenerate
 * `src/art/catalogue.ts` from the copy that is committed here.
 *
 *   node tools/sync-art.mjs --import   copy the PNGs and the manifest slice out of ../wallet-assets
 *   node tools/sync-art.mjs            regenerate src/art/catalogue.ts from public/art/MANIFEST.json
 *   node tools/sync-art.mjs --check    exit 1 if the committed catalogue is stale
 *
 * ── WHY THE PICTURES ARE COMMITTED HERE AND THE TOOLBAR MARK IS NOT ─────────────────────────────
 *
 * `tools/build.js` reads the toolbar icons and the EIP-6963 mark out of the sibling
 * `../wallet-assets` checkout at build time, and CI now fails when that checkout is missing. That
 * is right for the mark: there is exactly one wallet mark in the estate and a second copy of it in
 * this repository is a second thing to forget to update.
 *
 * The empty-state art is the opposite case. It is loaded by the popup at RUNTIME, from
 * `chrome-extension://<id>/art/…`, so it has to be inside the packaged `dist/` no matter where it
 * came from — and an unpacked extension a reviewer loads from a checkout has no sibling directory
 * at all. `emberkin-web` made the same call for the same reason (`public/art/`). The provenance is
 * not lost: `public/art/MANIFEST.json` carries the FLUX model, the endpoint, the C2PA disclosure
 * and the licence for every file, and `test/art.test.ts` re-derives the catalogue from it.
 *
 * ── WHY ONLY EIGHT OF THE EIGHTEEN ─────────────────────────────────────────────────────────────
 *
 * micro-wallet-assets ships six slugs at three sizes. This client has four of those six states
 * (there is no positions list in the popup — see test/art.test.ts — and no offline screen), and a
 * 360px popup never needs the 768. `sizes="128px"` in `src/lib/art.ts` means a 1x or 2x display
 * picks the 384 and a 3x display picks the 576; nothing this client can render would ever select
 * the 768, so shipping it would be 2.3 MB of bytes no user downloads.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(root, 'public/art/MANIFEST.json');
const OUT = join(root, 'src/art/catalogue.ts');

/** The states this client actually has, and the pixel sizes its layout can select. */
export const WANTED = {
  'no-accounts': [384, 576],
  'no-activity': [384, 576],
  'no-dapps': [384, 576],
  'no-tokens': [384, 576],
};

/** `assets/empty/no-tokens-384x384.png` → `{ slug: 'no-tokens', px: 384 }`, or null. */
export function parseEmptyPath(path) {
  const m = /^assets\/empty\/(.+)-(\d+)x(\d+)\.png$/.exec(String(path));
  if (m === null || m[2] !== m[3]) return null;
  return { slug: m[1], px: Number(m[2]) };
}

/** Fields kept per asset. The FLUX prompt — 3 kB of prose each — stays out of the bundle. */
export function entryFrom(asset) {
  const parsed = parseEmptyPath(asset.path);
  if (parsed === null) throw new Error(`not an empty-state asset path: ${asset.path}`);
  return {
    slug: parsed.slug,
    px: parsed.px,
    name: asset.name,
    // Served from the extension origin's root, so the manifest's repo-relative `assets/` prefix is
    // swapped for the packaged one here rather than at every call site.
    path: `/art/${String(asset.path).replace(/^assets\//, '')}`,
  };
}

export function catalogueFrom(manifest) {
  return manifest.assets
    .map(entryFrom)
    .sort((a, b) => (a.slug === b.slug ? a.px - b.px : a.slug.localeCompare(b.slug)));
}

export function render(manifest) {
  const entries = catalogueFrom(manifest);
  const lines = entries.map((e) => `  ${JSON.stringify(e)},`).join('\n');
  return `/**
 * Every empty-state illustration this extension packages, and where it is served from.
 * GENERATED — do not edit.
 *
 * Written by \`tools/sync-art.mjs\` from \`public/art/MANIFEST.json\`, which came from
 * \`micro-wallet-assets\`. \`test/art.test.ts\` fails if this file, that manifest and the files on
 * disk disagree, so a stale catalogue fails CI rather than shipping a popup full of broken images.
 *
 * The provenance — the FLUX prompt, the model, the C2PA state, the licence and the AI disclosure —
 * is deliberately NOT copied here. It stays whole in \`public/art/MANIFEST.json\`, which is
 * packaged alongside the pictures.
 *
 * Generator: ${manifest.generator}
 * Assets: ${manifest.assetCount}
 * Updated: ${manifest.updatedAt}
 */

export interface ArtEntry {
  /** \`no-accounts\` | \`no-activity\` | \`no-dapps\` | \`no-tokens\`. */
  readonly slug: string;
  /** Width in pixels; every one of these is square. */
  readonly px: number;
  readonly name: string;
  /** Root-relative, resolved by the browser against \`chrome-extension://<id>/\`. */
  readonly path: string;
}

export const ART: readonly ArtEntry[] = [
${lines}
];
`;
}

/* ------------------------------------------------------------------------------------ --import - */

if (process.argv.includes('--import')) {
  const src = resolve(root, '..', 'wallet-assets');
  const upstream = JSON.parse(readFileSync(join(src, 'MANIFEST.json'), 'utf8'));

  const picked = upstream.assets.filter((a) => {
    if (a.group !== 'empty') return false;
    const parsed = parseEmptyPath(a.path);
    return parsed !== null && (WANTED[parsed.slug] ?? []).includes(parsed.px);
  });

  const expected = Object.values(WANTED).reduce((n, sizes) => n + sizes.length, 0);
  if (picked.length !== expected) {
    throw new Error(`sync-art: wanted ${expected} assets from micro-wallet-assets, matched ${picked.length}`);
  }

  mkdirSync(join(root, 'public/art/empty'), { recursive: true });
  for (const asset of picked) copyFileSync(join(src, asset.path), join(root, 'public', asset.path.replace(/^assets\//, 'art/')));

  // The provenance fields travel with the pictures. Only the assets array is narrowed.
  const slice = {
    $comment: 'The subset of micro-wallet-assets this extension packages. Regenerate with `node tools/sync-art.mjs --import` from a sibling ../wallet-assets checkout. Do not hand-edit.',
    source: 'cloudsforge-online/micro-wallet-assets',
    provider: upstream.provider,
    providerLabel: upstream.providerLabel,
    model: upstream.model,
    endpoint: upstream.endpoint,
    generator: upstream.generator,
    disclosure: upstream.disclosure,
    licence: upstream.licence,
    assetCount: picked.length,
    updatedAt: upstream.updatedAt,
    assets: picked.map((a) => ({ asset: a.asset, group: a.group, name: a.name, path: a.path, origin: a.origin, derivedFrom: a.derivedFrom, provider: a.provider, model: a.model, sha256: a.sha256, bytes: a.bytes, deliveredSize: a.deliveredSize ?? a.declaredSize })),
  };
  writeFileSync(MANIFEST, `${JSON.stringify(slice, null, 2)}\n`);
  console.log(`imported ${picked.length} empty-state assets from ${src}`);
}

/* ------------------------------------------------------------------------- catalogue / --check - */

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const rendered = render(manifest);

if (process.argv.includes('--check')) {
  if (readFileSync(OUT, 'utf8') !== rendered) {
    console.error('src/art/catalogue.ts is stale — run `pnpm sync-art`');
    process.exit(1);
  }
  console.log('ok: the art catalogue matches the manifest');
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, rendered);
  console.log(`wrote src/art/catalogue.ts — ${manifest.assetCount} assets`);
}
