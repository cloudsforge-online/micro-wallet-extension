/* An empty state, with its illustration.
 *
 * This replaces four hand-rolled `<div className="placeholder-asset">` blocks — a dashed box with a
 * sentence in it, named after the art that had not been generated when it was written. The art has
 * been generated (micro-wallet-assets, `assets/empty/`), and `src/art/index.ts` resolves a state
 * name to it.
 *
 * THE PICTURE IS OPTIONAL AND THE SENTENCE IS NOT. `emptyStateArt` returns `null` for a slug this
 * build packages no art for, and this component then renders exactly what it rendered before: the
 * words, in the box. That ordering is deliberate — the sentence carries the block range, the
 * instruction and the reason, and a user who cannot see images has lost nothing.
 */
import { emptyStateArt, type EmptyStateSlug } from '../art/index.ts';

export function EmptyState(props: { slug: EmptyStateSlug; children: React.ReactNode }): React.JSX.Element {
  const art = emptyStateArt(props.slug);
  return (
    <div className="empty-state" data-testid={`empty-${props.slug}`}>
      {art !== null ? (
        <img
          className="empty-art"
          data-testid={`empty-art-${props.slug}`}
          src={art.src}
          srcSet={art.srcSet}
          sizes={art.sizes}
          alt={art.alt}
          // Four of these can exist in one popup session and only one is ever on screen. `async`
          // keeps the decode off the thread that is rendering the balance.
          decoding="async"
        />
      ) : null}
      <p className="empty-words">{props.children}</p>
    </div>
  );
}
