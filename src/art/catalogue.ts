/**
 * Every empty-state illustration this extension packages, and where it is served from.
 * GENERATED — do not edit.
 *
 * Written by `tools/sync-art.mjs` from `public/art/MANIFEST.json`, which came from
 * `micro-wallet-assets`. `test/art.test.ts` fails if this file, that manifest and the files on
 * disk disagree, so a stale catalogue fails CI rather than shipping a popup full of broken images.
 *
 * The provenance — the FLUX prompt, the model, the C2PA state, the licence and the AI disclosure —
 * is deliberately NOT copied here. It stays whole in `public/art/MANIFEST.json`, which is
 * packaged alongside the pictures.
 *
 * Generator: wallet-assets/generate.py and wallet-assets/derive.py
 * Assets: 8
 * Updated: 2026-08-04T01:52:59Z
 */

export interface ArtEntry {
  /** `no-accounts` | `no-activity` | `no-dapps` | `no-tokens`. */
  readonly slug: string;
  /** Width in pixels; every one of these is square. */
  readonly px: number;
  readonly name: string;
  /** Root-relative, resolved by the browser against `chrome-extension://<id>/`. */
  readonly path: string;
}

export const ART: readonly ArtEntry[] = [
  {"slug":"no-accounts","px":384,"name":"empty/no-accounts@0.5","path":"/art/empty/no-accounts-384x384.png"},
  {"slug":"no-accounts","px":576,"name":"empty/no-accounts@0.75","path":"/art/empty/no-accounts-576x576.png"},
  {"slug":"no-activity","px":384,"name":"empty/no-activity@0.5","path":"/art/empty/no-activity-384x384.png"},
  {"slug":"no-activity","px":576,"name":"empty/no-activity@0.75","path":"/art/empty/no-activity-576x576.png"},
  {"slug":"no-dapps","px":384,"name":"empty/no-dapps@0.5","path":"/art/empty/no-dapps-384x384.png"},
  {"slug":"no-dapps","px":576,"name":"empty/no-dapps@0.75","path":"/art/empty/no-dapps-576x576.png"},
  {"slug":"no-tokens","px":384,"name":"empty/no-tokens@0.5","path":"/art/empty/no-tokens-384x384.png"},
  {"slug":"no-tokens","px":576,"name":"empty/no-tokens@0.75","path":"/art/empty/no-tokens-576x576.png"},
];
