/**
 * Turning an empty state into a picture.
 *
 * Four states in this popup can be legitimately empty — no accounts, no tokens, no activity, no
 * connected sites — and until now each rendered as a sentence in a dashed box (`.placeholder-asset`
 * in `src/ui/app.css`, a class named after the gap it was standing in for). micro-wallet-assets
 * generated the illustrations for exactly these states; this module is the only thing in the
 * extension that turns a state name into a URL, so a missing picture is missing in one place rather
 * than in four `<img>` tags.
 *
 * ── NULL, NEVER A PLACEHOLDER PATH ─────────────────────────────────────────────────────────────
 *
 * `emptyStateArt` returns `null` when there is no art for a slug, and the callers then render the
 * sentence alone. It deliberately does not fall back to a stand-in image: a placeholder RENDERS as
 * art, so a state whose illustration was never packaged looks finished and nobody reports it.
 * `emberkin-web/src/lib/art.ts` made the same call for the same reason. `test/art.test.ts` asserts
 * that every slug the popup asks for resolves, so a `null` at runtime means a real regression.
 *
 * ── WHY `srcset` AND NOT A SINGLE FILE ─────────────────────────────────────────────────────────
 *
 * The asset set ships each illustration at 384, 576 and 768. This popup draws them at 128 CSS px,
 * so a 1x or 2x display needs at most 256 device pixels and a 3x display needs 384 — `sizes` tells
 * the browser that and it fetches ONE file, the smallest that covers the screen it is on. Hardcoding
 * the 768 would mean every user downloading 780 kB to fill a 128px box; hardcoding the 384 would
 * mean a soft picture on the 3x laptops most of this estate is developed on. Only the 384 and the
 * 576 are packaged, because nothing this popup renders could ever select the 768.
 *
 * ── WHY `alt` IS EMPTY ─────────────────────────────────────────────────────────────────────────
 *
 * Every one of these sits directly above a sentence that says the same thing in words ("No tokens
 * yet…"). An `alt` here would make a screen reader say it twice, so the image is marked decorative
 * and the sentence carries the meaning — which is the right way round, because the sentence also
 * carries the block range and the instructions the picture cannot.
 */
import { ART, type ArtEntry } from './catalogue.ts';

/** The states this client has art for. Adding one means importing it in `tools/sync-art.mjs`. */
export type EmptyStateSlug = 'no-accounts' | 'no-activity' | 'no-dapps' | 'no-tokens';

/**
 * The CSS width the popup draws these at. It is a constant rather than a per-call-site number
 * because it is the input to the `sizes` attribute, and a `sizes` that disagrees with the layout
 * makes the browser choose the wrong file — the one failure mode of responsive images that is
 * invisible in a screenshot.
 */
export const DISPLAY_PX = 128;

export interface EmptyStateArt {
  /** The smallest packaged file. Used for `src`, which is what a browser without `srcset` takes. */
  readonly src: string;
  /** `"<path> 384w, <path> 576w"` — the candidates, by their real pixel widths. */
  readonly srcSet: string;
  /** `"128px"`. See `DISPLAY_PX`. */
  readonly sizes: string;
  /** Decorative: the adjacent sentence carries the meaning. See the note above. */
  readonly alt: '';
}

/** Indexed once at module load. */
const bySlug = new Map<string, ArtEntry[]>();
for (const entry of ART) {
  const list = bySlug.get(entry.slug);
  if (list) list.push(entry);
  else bySlug.set(entry.slug, [entry]);
}

/**
 * The illustration for an empty state, or `null` when this build packages none.
 *
 * `null` rather than a placeholder path — see the module note. The callers render their sentence
 * either way, so a missing picture costs the user nothing and costs the next reader a visible gap.
 */
export function emptyStateArt(slug: EmptyStateSlug): EmptyStateArt | null {
  const entries = bySlug.get(slug);
  if (entries === undefined || entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => a.px - b.px);
  const smallest = sorted[0];
  if (smallest === undefined) return null;
  return {
    src: smallest.path,
    srcSet: sorted.map((e) => `${e.path} ${e.px}w`).join(', '),
    sizes: `${DISPLAY_PX}px`,
    alt: '',
  };
}

/** Every slug this build has art for. For `test/art.test.ts`. */
export function slugsWithArt(): string[] {
  return [...bySlug.keys()].sort();
}

export { ART };
