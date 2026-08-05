/**
 * The empty-state illustrations: that they exist, that they are the bytes micro-wallet-assets
 * produced, that they are real images, and that they reach the packaged extension.
 *
 * ── WHY THIS FILE DOES NOT ASSERT ON MARKUP ────────────────────────────────────────────────────
 *
 * The imagery audit that produced these assets (micro-org#175) found Tessera serving 392 sprites to
 * nobody: the `<img>` tags were perfectly well-formed, the pictures 404'd, and every check stayed
 * green — because every check looked at the tag. "There is an `<img>` with a src" is not evidence
 * that a user sees a picture.
 *
 * So the strongest thing here is `decodePng`, which does not read the IHDR header and stop. It
 * walks the chunk stream, concatenates every IDAT, runs the whole thing through zlib, and requires
 * the inflated output to be exactly `height * (1 + width * channels * depth/8)` bytes — the raw
 * scanline count a PNG of that geometry must produce. A truncated file, a file whose header lies
 * about its size, a git-lfs pointer with a .png extension, an HTML error page saved under the wrong
 * name: none of those survive it. And it runs on the files in `dist/`, not the ones in `public/`,
 * so it is testing the artefact rather than the source tree.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { ART } from '../src/art/catalogue.ts';
import { DISPLAY_PX, emptyStateArt, slugsWithArt, type EmptyStateSlug } from '../src/art/index.ts';
import { WANTED, catalogueFrom, parseEmptyPath, render } from '../tools/sync-art.mjs';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

interface ManifestAsset { asset: string; group: string; name: string; path: string; sha256: string; bytes: number; deliveredSize: string }
const manifest = JSON.parse(read('public/art/MANIFEST.json')) as {
  assetCount: number; disclosure: string; licence: string; provider: string; assets: ManifestAsset[];
};

/** The four states the popup renders. Every one must resolve; see `src/ui/Popup.tsx`. */
const ASKED_FOR: EmptyStateSlug[] = ['no-accounts', 'no-activity', 'no-dapps', 'no-tokens'];

/* ------------------------------------------------------------------------------- a real decode - */

/**
 * Decode a PNG far enough to prove it is one. Returns its true geometry.
 *
 * Not a header read: the pixel data is actually inflated and its length checked against what the
 * declared geometry demands. See the note at the top of this file for why that distinction is the
 * whole point of this suite.
 */
function decodePng(bytes: Buffer): { width: number; height: number } {
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'not a PNG signature');
  assert.equal(bytes.readUInt32BE(8), 13, 'the first chunk is not a 13-byte IHDR');
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR');

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const depth = bytes[24] as number;
  const colourType = bytes[25] as number;
  assert.equal(bytes[28], 0, 'interlaced PNGs would need a different scanline arithmetic below');

  const idat: Buffer[] = [];
  let seenEnd = false;
  for (let at = 8; at + 12 <= bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString('ascii');
    if (type === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + length));
    if (type === 'IEND') { seenEnd = true; break; }
    at += 12 + length;
  }
  assert.ok(seenEnd, 'the file has no IEND chunk — it is truncated');
  assert.ok(idat.length > 0, 'the file has no IDAT chunk — it carries no pixels');

  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colourType];
  assert.ok(channels !== undefined, `unknown PNG colour type ${colourType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const perRow = 1 + Math.ceil((width * channels * depth) / 8);
  assert.equal(raw.length, height * perRow, 'the inflated pixel data is not the size this geometry demands');

  return { width, height };
}

/* -------------------------------------------------------------------------------- the manifest - */

describe('the committed manifest slice', () => {
  it('has one entry per file this client packages', () => {
    const expected = (Object.values(WANTED) as number[][]).reduce((n, sizes) => n + sizes.length, 0);
    assert.equal(manifest.assets.length, expected);
    assert.equal(manifest.assets.length, manifest.assetCount);
  });

  it('is the FLUX 2 Pro set and says so', () => {
    assert.equal(manifest.provider, 'flux-2-pro');
  });

  it('carries the AI disclosure and the licence forward from micro-wallet-assets', () => {
    // The pictures are copied into this repository; the thing that must travel with them is the
    // statement that they are machine-generated. A copy without it is a licence problem, not a
    // tidiness one.
    assert.match(manifest.disclosure, /AI-generated/i);
    assert.ok(manifest.licence.length > 0);
  });

  it('describes only empty-state art', () => {
    for (const asset of manifest.assets) {
      assert.equal(asset.group, 'empty');
      assert.notEqual(parseEmptyPath(asset.path), null, `${asset.path} is not an empty/<slug>-<n>x<n>.png`);
    }
  });
});

/* ------------------------------------------------------------------------- the generated file -- */

describe('the generated catalogue', () => {
  it('is exactly what tools/sync-art.mjs would write today', () => {
    // A stale catalogue points at pictures that moved. This fails CI rather than letting it ship.
    assert.equal(read('src/art/catalogue.ts'), render(manifest));
  });

  it('has one entry per manifest asset', () => {
    assert.equal(ART.length, manifest.assets.length);
    assert.equal(catalogueFrom(manifest).length, manifest.assets.length);
  });

  it('serves every path from /art/, never from the repository-relative assets/', () => {
    for (const entry of ART) {
      assert.ok(entry.path.startsWith('/art/empty/'), `${entry.path} is not served from /art/empty/`);
      assert.ok(!entry.path.includes('/assets/'), `${entry.path} kept the manifest prefix`);
    }
  });

  it('carries no FLUX prompt — 3 kB of prose per asset stays out of the bundle', () => {
    const source = read('src/art/catalogue.ts');
    assert.ok(!source.includes('Flat geometric vector artwork'), 'a prompt leaked into the catalogue');
    assert.ok(source.length < 8_000, `the catalogue is ${source.length} bytes; it should be a couple of kB`);
  });
});

/* -------------------------------------------------------------------------- the files on disk -- */

describe('every file the catalogue names is on disk, unmodified, and is a real image', () => {
  it('resolves all of them', () => {
    const missing = ART.filter((e) => !existsSync(join(root, 'public', e.path))).map((e) => e.path);
    assert.deepEqual(missing, [], `catalogued but not on disk: ${missing.join(', ')}`);
    assert.equal(ART.length, 8);
  });

  it('is byte-identical to what micro-wallet-assets generated', () => {
    // The assets are permanent FLUX 2 Pro output and this repository holds a copy. The sha256 in
    // the manifest is the upstream one, so this is the check that the copy was a copy — that
    // nothing here re-encoded, cropped or "optimised" a generated asset on its way in.
    const wrong: string[] = [];
    for (const asset of manifest.assets) {
      const bytes = readFileSync(join(root, 'public', asset.path.replace(/^assets\//, 'art/')));
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== asset.sha256 || bytes.length !== asset.bytes) wrong.push(asset.path);
    }
    assert.deepEqual(wrong, [], `re-encoded or corrupted on the way into this repository: ${wrong.join(', ')}`);
  });

  it('decodes, at the geometry its filename claims', () => {
    for (const entry of ART) {
      const { width, height } = decodePng(readFileSync(join(root, 'public', entry.path)));
      assert.equal(width, entry.px, `${entry.path} decodes ${width}px wide, not ${entry.px}`);
      assert.equal(height, entry.px, `${entry.path} decodes ${height}px tall, not ${entry.px}`);
    }
  });
});

/* ------------------------------------------------------------------------------- the resolver -- */

describe('the resolver', () => {
  it('answers for every state the popup renders', () => {
    const missing = ASKED_FOR.filter((slug) => emptyStateArt(slug) === null);
    assert.deepEqual(missing, [], `asked for by src/ui/Popup.tsx, not in the art set: ${missing.join(', ')}`);
  });

  it('has art for exactly those states — no orphans either way', () => {
    assert.deepEqual(slugsWithArt(), [...ASKED_FOR].sort());
  });

  it('returns null for a state with no art, rather than a placeholder path', () => {
    // The one that matters: `no-positions` and `offline` exist in micro-wallet-assets and this
    // client packages neither, because it has no positions list and no offline screen. A resolver
    // that answered anyway would render the wrong picture, and a wrong picture is worse than none —
    // nobody reports it. See micro-org#177.
    assert.equal(emptyStateArt('no-positions' as EmptyStateSlug), null);
    assert.equal(emptyStateArt('offline' as EmptyStateSlug), null);
    assert.equal(emptyStateArt('not-a-state' as EmptyStateSlug), null);
  });

  it('offers the smallest file as src and every size as srcSet candidates', () => {
    const art = emptyStateArt('no-tokens');
    assert.ok(art !== null);
    assert.match(art.src, /-384x384\.png$/);
    assert.equal(art.srcSet, '/art/empty/no-tokens-384x384.png 384w, /art/empty/no-tokens-576x576.png 576w');
  });

  it('marks the illustration decorative, because the sentence beside it says the same thing', () => {
    assert.equal(emptyStateArt('no-dapps')?.alt, '');
  });

  it('declares a `sizes` that matches what the stylesheet actually draws', () => {
    /* THE SUBTLE ONE. `sizes` is how the browser picks between the 384 and the 576. If the CSS says
     * 128px and `sizes` says something else, the browser fetches the wrong file — and the page
     * looks completely correct, because the wrong file is still a picture of the right thing. No
     * screenshot, no markup assertion and no smoke test would ever catch it. */
    assert.equal(emptyStateArt('no-accounts')?.sizes, `${DISPLAY_PX}px`);
    assert.match(read('src/ui/app.css'), new RegExp(`\\.empty-art\\s*\\{[^}]*width:\\s*${DISPLAY_PX}px`));
  });
});

/* -------------------------------------------------------------------- the artefact, not the src - */

describe('the packaged extension', () => {
  /**
   * This suite BUILDS rather than assuming a build exists — `test/bundle.test.ts` takes the same
   * position, for the same reason: an assertion about the artefact that silently skips when there
   * is no artefact is an assertion nobody is running.
   *
   * It builds into a temporary directory rather than into `dist/`, because bundle.test.ts also
   * builds and `tools/build.js` deletes its output first; node:test runs the two files
   * concurrently, so sharing `dist/` made this file fail with ENOENT roughly one run in three.
   *
   * `--require-assets` is passed, so this is the CI path exactly: the build refuses to fall back to
   * the placeholder lozenge or to tools/png.js's toolbar icons, and a missing ../wallet-assets
   * checkout fails the suite here rather than shipping quietly. micro-org#178.
   */
  const targets = ['chrome', 'firefox'];
  let built = '';

  before(() => {
    built = mkdtempSync(join(tmpdir(), 'wallet-ext-art-'));
    for (const target of targets) {
      execFileSync('node', [join(root, 'tools/build.js'), `--target=${target}`, '--require-assets', `--out=${join(built, target)}`], { cwd: root, stdio: 'pipe' });
    }
  });

  after(() => { if (built !== '') rmSync(built, { recursive: true, force: true }); });

  for (const target of targets) {
    const dist = (): string => join(built, target);

    it(`${target}: packages every catalogued picture, decodable, at full size`, () => {
      for (const entry of ART) {
        const file = join(dist(), entry.path.replace(/^\//, ''));
        assert.ok(existsSync(file), `${entry.path} is in the catalogue and not in dist/${target}`);
        const bytes = readFileSync(file);
        assert.ok(bytes.length > 100_000, `dist/${target}${entry.path} is only ${bytes.length} bytes`);
        assert.equal(decodePng(bytes).width, entry.px);
      }
    });

    it(`${target}: packages nothing in art/ the catalogue does not name`, () => {
      const packaged = readdirSync(join(dist(), 'art', 'empty')).sort();
      assert.deepEqual(packaged, ART.map((e) => e.path.split('/').pop()).sort());
    });

    it(`${target}: the popup asks for paths that exist in the package`, () => {
      // The Tessera failure in one assertion: the bundle names a URL, and the URL resolves inside
      // the packaged extension.
      const ui = readFileSync(join(dist(), 'ui.js'), 'utf8');
      for (const entry of ART) {
        assert.ok(ui.includes(entry.path), `${entry.path} is catalogued but does not appear in dist/${target}/ui.js`);
        assert.ok(existsSync(join(dist(), entry.path.replace(/^\//, ''))));
      }
    });

    it(`${target}: ships the real EIP-6963 mark, not the lozenge and not a 1024 plate`, () => {
      /* micro-org#178. Three separate failures are excluded here:
       *   - the placeholder lozenge (an SVG data URI), which is what CI shipped;
       *   - `assets/mark/plate-light-1024x1024.png`, the 1024 master the build fell through to
       *     locally, which put a 134,230-character data URI into a script injected into every page;
       *   - a mark that is not a decodable image at all.
       * The icon is extracted from the BUILT inpage.js and decoded. */
      const inpage = readFileSync(join(dist(), 'inpage.js'), 'utf8');
      const found = inpage.match(/data:image\/([a-z+]+);base64,([A-Za-z0-9+/=]+)/);
      assert.ok(found !== null, 'no data URI in the built inpage.js — the 6963 icon is missing');

      assert.equal(found[1], 'png', 'the 6963 icon is an SVG — that is the placeholder lozenge');
      const { width, height } = decodePng(Buffer.from(found[2] as string, 'base64'));
      assert.equal(width, 128, `the 6963 icon decodes at ${width}px; icon-128.png is the intended asset`);
      assert.equal(height, 128);

      // EIP-6963: "SHOULD be a square with 96x96px minimum resolution", and it must be a data URI
      // so the dapp draws the picker without a network fetch that would leak which dapps this
      // wallet's users visit.
      assert.ok(width >= 96);

      assert.ok(
        inpage.length < 20_000,
        `inpage.js is ${inpage.length} bytes and is injected into every page the user visits; `
        + 'that is the 1024 plate being inlined again',
      );
    });
  }
});
