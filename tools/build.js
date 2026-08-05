/* The build. esbuild, four entry points, two targets, no framework.
 *
 * WHY NOT VITE, WHICH THE REST OF THE ESTATE USES. Every other frontend here is one page served by
 * nginx, and Vite is exactly right for that. An extension is four separate programs with four
 * different module systems in one package:
 *
 *   background.js  a service worker (Chrome) / event page (Firefox) — classic script, no imports
 *   content.js     an isolated-world content script — classic script, no imports
 *   inpage.js      a MAIN-world script injected into every page — classic script, no imports
 *   ui.js          three extension pages — an ES module, with JSX and a stylesheet
 *
 * The first three MUST be single self-contained files: a content script cannot `import`, and a
 * service worker that code-splits fetches a chunk at signing time. Vite's Rollup pipeline emits
 * shared chunks by default and turning that off for three of four entries is more configuration
 * than this file is. esbuild does it directly.
 *
 * WHAT THE TWO TARGETS SHARE: everything except the manifest. §4.3 — "Firefox ships from the same
 * source with its own manifest and AMO signing. Opera and Edge take the Chrome build unchanged;
 * they are separate listings, not separate products." So there is no `--target=opera`, and adding
 * one would be the first step towards three products that drift.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, cpSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { placeholderIcon } from './png.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const target = (process.argv.find((a) => a.startsWith('--target=')) ?? '--target=chrome').split('=')[1];
if (target !== 'chrome' && target !== 'firefox') {
  throw new Error(`build: --target must be chrome or firefox, not ${target}. Opera and Edge take the Chrome build unchanged.`);
}
const dev = process.argv.includes('--dev');

/**
 * `--out=<dir>` builds somewhere other than `dist/<target>`.
 *
 * It exists because two test files need a real package to assert against and the build DELETES its
 * output directory before writing it. `test/bundle.test.ts` builds `dist/` in a `before` hook, and
 * node:test runs files concurrently — so `test/art.test.ts`, reading `dist/chrome/inpage.js` at the
 * same moment, intermittently got ENOENT from a directory that was mid-rebuild. Racing on a shared
 * output is a flake that would have been "fixed" by making one of the two suites weaker; this lets
 * each own its own artefact instead.
 */
const out = (process.argv.find((a) => a.startsWith('--out=')) ?? '').split('=')[1] || join(root, 'dist', target);

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'icons'), { recursive: true });

/* ------------------------------------------------------------------------------- the mark ----- */

/**
 * The EIP-6963 icon, which must be a data URI so a dapp can draw the wallet picker without a
 * network fetch that would tell somebody which dapps this wallet's users visit.
 *
 * Read from micro-wallet-assets if the sibling checkout has it; a plain lozenge otherwise. The
 * fallback is announced on stdout rather than being silent, because "the icon is a placeholder" is
 * exactly the kind of thing that ships.
 */
// 25-wallet-clients.md §6 puts the mark in micro-wallet-assets, in both polarities, with the icon
// sizes DERIVED by downscaling from a single master per polarity rather than generated per size —
// "a diffusion model asked for the same mark nine times returns nine different marks, and an app
// whose icon changes between sizes looks broken."
//
// ── THIS LIST USED TO NAME TWO FILES THAT CANNOT EXIST, AND ONE THAT WAS WRONG. micro-org#178. ──
//
// It began `assets/extension/mark-light.svg`, `assets/mark/mark-light.svg`, on the authority of a
// comment in src/inpage/index.ts claiming "§6 puts the real mark at assets/extension/mark-light.svg".
// §6 (docs/ecosystem/25-wallet-clients.md:262-296) names no path and no format; its Mark row reads
// only "The wallet mark, on light and dark, plus a monochrome cut for tray and favicon". And
// micro-wallet-assets contains no SVG at all — `find wallet-assets -name '*.svg'` returns nothing,
// because FLUX 2 Pro emits raster. Both entries were dead, and the list therefore fell through to
// `assets/mark/plate-light-1024x1024.png`: a 1024x1024 plate, 100 kB, which became a 134,230-char
// data URI compiled into inpage.js — the MAIN-world script injected into EVERY PAGE THE USER
// VISITS. 98% of that file was one picture of a logo.
//
// EIP-6963 asks for a square data URI legible at list density; the asset set derives exactly that
// at `assets/extension/icons/icon-128.png`, 4,852 bytes. PNG satisfies RFC 2397 as well as SVG
// does, so nothing about the spec required the file that did not exist. The 1024 masters stay at
// the end of the list as a genuine last resort for a checkout that has the mark but not the derived
// extension set; a build that reaches them is heavy but correct, and --require-assets refuses it.
const ASSET_PATHS = [
  ['assets/extension/icons/icon-128.png', 'image/png'],
  ['assets/mark/plate-light-1024x1024.png', 'image/png'],
  ['assets/mark/glyph-1024x1024.png', 'image/png'],
].map(([rel, mime]) => [resolve(root, '..', 'wallet-assets', rel), mime]);

/**
 * `--require-assets` turns every fallback below from a line on stdout into a failed build.
 *
 * CI passes it. A developer without a sibling ../wallet-assets checkout does not, and still gets a
 * working unpacked extension with a lozenge in it. The point is that the placeholder can never
 * reach a store listing without somebody deliberately removing this flag from the workflow — which
 * is a diff a reviewer sees, unlike a `::warning::` in a green run, which is what shipped before.
 */
const requireAssets = process.argv.includes('--require-assets');
const degraded = [];

let icon = '';
const foundMark = ASSET_PATHS.find(([p]) => existsSync(p));
if (foundMark !== undefined) {
  icon = `data:${foundMark[1]};base64,${readFileSync(foundMark[0]).toString('base64')}`;
  console.log(`  mark:    ${foundMark[0]} (${icon.length.toLocaleString('en-GB')}-char data URI)`);
  // Reaching a 1024 master is not a failure, but it is a hundred kilobytes on every page load and
  // it means the derived extension set is missing. It is not allowed to pass silently either.
  if (foundMark[0] !== ASSET_PATHS[0][0]) degraded.push(`the EIP-6963 icon came from a 1024 master (${foundMark[0]}), not assets/extension/icons/icon-128.png`);
} else {
  console.log('  mark:    PLACEHOLDER — micro-wallet-assets has published no mark yet.');
  console.log('           The EIP-6963 icon falls back to the lozenge in src/inpage/index.ts.');
  degraded.push('the EIP-6963 icon is the placeholder lozenge in src/inpage/index.ts');
}

// `assets/extension/icons/`, not `assets/extension/`. The old path was one directory short of where
// micro-wallet-assets actually derives these (MANIFEST.json: `extension/icon-16` … `icon-128` all
// live under `assets/extension/icons/`), so `haveRaster` was never true and every build in the
// repository's history shipped the generated placeholders from tools/png.js. micro-org#178.
const rasterDir = resolve(root, '..', 'wallet-assets', 'assets', 'extension', 'icons');
const sizes = [16, 32, 48, 128];
const haveRaster = sizes.every((s) => existsSync(join(rasterDir, `icon-${s}.png`)));
if (haveRaster) {
  for (const size of sizes) cpSync(join(rasterDir, `icon-${size}.png`), join(out, 'icons', `icon-${size}.png`));
  console.log(`  icons:   ${rasterDir}`);
} else {
  for (const size of sizes) writeFileSync(join(out, 'icons', `icon-${size}.png`), placeholderIcon(size));
  console.log(`  icons:   PLACEHOLDER — ${rasterDir} has no icon-{16,32,48,128}.png.`);
  degraded.push('the toolbar icons are the generated placeholders from tools/png.js');
}

if (requireAssets && degraded.length > 0) {
  throw new Error(
    `build --require-assets: this build would ship placeholder art.\n  - ${degraded.join('\n  - ')}\n`
    + '  Check out cloudsforge-online/micro-wallet-assets as a sibling directory (../wallet-assets).',
  );
}

/* -------------------------------------------------------------------------------- the bundles - */

const shared = {
  bundle: true,
  target: ['chrome111', 'firefox128'],
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  legalComments: 'none',
  logLevel: 'warning',
  define: {
    __WALLET_ICON__: JSON.stringify(icon),
    // React reads this. Without it, esbuild leaves `process.env.NODE_ENV` in the bundle and the
    // extension page throws ReferenceError: process is not defined on first render — a failure
    // that looks like a blank popup with no console output the user will ever see.
    'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
  },
};

await Promise.all([
  // Classic scripts: no `format: esm`, no splitting, nothing to fetch at runtime.
  build({ ...shared, entryPoints: [join(root, 'src/background/index.ts')], outfile: join(out, 'background.js'), format: 'iife', platform: 'browser' }),
  build({ ...shared, entryPoints: [join(root, 'src/content/index.ts')], outfile: join(out, 'content.js'), format: 'iife', platform: 'browser' }),
  build({ ...shared, entryPoints: [join(root, 'src/inpage/index.ts')], outfile: join(out, 'inpage.js'), format: 'iife', platform: 'browser' }),
  // The pages, as a module, with the stylesheet emitted beside it as ui.css.
  build({ ...shared, entryPoints: [join(root, 'src/ui/main.tsx')], outfile: join(out, 'ui.js'), format: 'esm', platform: 'browser', jsx: 'automatic' }),
]);

// `recursive` because public/ is no longer three flat HTML files: public/art/ holds the empty-state
// illustrations and their MANIFEST.json, and cpSync throws EISDIR on a directory without it.
for (const page of readdirSync(join(root, 'public'))) {
  cpSync(join(root, 'public', page), join(out, page), { recursive: true });
}

/* -------------------------------------------------------------------------------- the manifest */

const manifest = JSON.parse(readFileSync(join(root, `manifest.${target}.json`), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  // A store listing is keyed on the manifest version and a mismatch is discovered at submission.
  throw new Error(`build: manifest.${target}.json says ${manifest.version}, package.json says ${pkg.version}`);
}
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

/* --------------------------------------------------------------------------- the two assertions */

// THESE RUN ON EVERY BUILD AND THEY HAVE BOTH FAILED DURING DEVELOPMENT.
//
// 1. A content script or a service worker containing `import` or `export` is a file the browser
//    refuses to load, and the symptom is silence: no error in any console the developer looks at,
//    the extension simply does nothing. esbuild emits it whenever `format` is wrong or an entry
//    accidentally becomes a chunk.
for (const file of ['background.js', 'content.js', 'inpage.js']) {
  const body = readFileSync(join(out, file), 'utf8');
  if (/^\s*(import|export)\s/m.test(body) || /\bimport\s*\(/.test(body)) {
    throw new Error(`build: ${file} contains a module statement — it must be a self-contained classic script`);
  }
}

// 2. Nothing in the shipped package may reference a Node built-in. The signing core is written to
//    have none (its own suite greps for them), but a transitive dependency or a stray `Buffer`
//    would only surface as a runtime ReferenceError inside the worker, where nobody is watching.
for (const file of ['background.js', 'content.js', 'inpage.js', 'ui.js']) {
  const body = readFileSync(join(out, file), 'utf8');
  for (const forbidden of ['require("node:', 'from"node:', "from'node:", 'process.versions.node']) {
    if (body.includes(forbidden)) throw new Error(`build: ${file} reaches for a Node built-in (${forbidden})`);
  }
}

const bytes = readdirSync(out, { recursive: true })
  .map((f) => join(out, String(f)))
  .filter((f) => existsSync(f) && !readdirSync(root).includes(f))
  .reduce((sum, f) => { try { return sum + readFileSync(f).length; } catch { return sum; } }, 0);

console.log(`  built:   dist/${target}  (${(bytes / 1024).toFixed(0)} kB)`);
