/* The three hops a dapp request makes, and the identifier that lets it survive a dead worker.
 *
 *   page (MAIN world)  --window.postMessage-->  content script (isolated world)
 *   content script     --chrome.runtime port-->  service worker
 *
 * Two boundaries, two different transports, and only one of them can be trusted:
 *
 *   - `window.postMessage` is shared with the page and with every other extension's content
 *     script, so every frame is tagged and every inbound frame is checked for `event.source ===
 *     window` before it is looked at. The page can forge anything on this channel, which is why
 *     the ORIGIN IS NEVER TAKEN FROM THE MESSAGE. The content script stamps `sender.origin` from
 *     the browser's own view of the tab, and the worker uses only that. A phishing warning that
 *     names an origin the page chose is worse than no warning at all.
 *
 *   - the `chrome.runtime` port is extension-private, and its `sender` is filled in by the
 *     browser.
 *
 * THE REQUEST ID IS THE MV3 DESIGN, NOT BOOKKEEPING.
 *
 * A service worker is killed after ~30s idle, and a user takes longer than that to read an
 * approval screen. So a request's identity cannot be "the closure that is waiting for it" — that
 * closure is gone. `id` is minted in the CONTENT SCRIPT, which lives as long as the page does, and
 * the request record is written to chrome.storage.session before anything else happens. When the
 * port drops, the content script reconnects and asks `poll` for the same id; the worker answers
 * from storage, whether it was the same worker or a fresh one. See background/requests.ts.
 */

import type { MarketObservation, StakeProjection } from './foresight.ts';

export const CHANNEL = 'cloudsforge-wallet';

/** rdns for EIP-6963. Must be stable forever: a dapp remembers the wallet the user picked by it. */
export const RDNS = 'online.cloudsforge.wallet';
export const WALLET_NAME = 'CloudsForge Wallet';

/* ---------------------------------------------------------------- page <-> content script ---- */

export interface PageRequest {
  readonly channel: typeof CHANNEL;
  readonly dir: 'page->content';
  readonly id: string;
  readonly method: string;
  readonly params: readonly unknown[];
}

export interface PageResponse {
  readonly channel: typeof CHANNEL;
  readonly dir: 'content->page';
  readonly id: string;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

/** EIP-1193 events, pushed rather than requested: accountsChanged, chainChanged, disconnect. */
export interface PageEvent {
  readonly channel: typeof CHANNEL;
  readonly dir: 'content->page';
  readonly event: 'accountsChanged' | 'chainChanged' | 'connect' | 'disconnect';
  readonly payload: unknown;
}

/* ------------------------------------------------------------- content script <-> worker ----- */

export type WorkerMessage =
  /** A dapp call. `origin` is NOT here — the worker reads it from the port's sender. */
  | { readonly kind: 'rpc'; readonly id: string; readonly method: string; readonly params: readonly unknown[] }
  /** "I reconnected after the worker died; what happened to this one?" */
  | { readonly kind: 'poll'; readonly id: string }
  /** From the extension's own pages (popup, onboarding, approval window). */
  | { readonly kind: 'ui'; readonly id: string; readonly action: string; readonly payload: unknown };

export type WorkerReply =
  | { readonly kind: 'result'; readonly id: string; readonly result: unknown }
  | { readonly kind: 'error'; readonly id: string; readonly error: { code: number; message: string; data?: unknown } }
  /** The request is still open — the approval window is up. Keep waiting, do not retry. */
  | { readonly kind: 'pending'; readonly id: string }
  | { readonly kind: 'event'; readonly event: PageEvent['event']; readonly payload: unknown };

export const PORT_NAME_CONTENT = 'cf-wallet-content';

/**
 * How long a request may stay open before the wallet gives up on it.
 *
 * Shared between the worker (which fails stale records) and the CONTENT SCRIPT (which arms its own
 * timer for the same span). Both, because they fail differently: the worker's rule handles a
 * request nobody ever decided, and the content script's handles the case where the worker cannot
 * answer at all — it was stopped, `chrome.storage.session` was cleared, the extension was updated.
 * §4.3 requires that every pending request "survives a worker restart or is cleanly failed", and a
 * promise that hangs is neither. The content script's timer is the guarantee, because it is the
 * only participant whose lifetime is the same as the page that is waiting.
 */
export const REQUEST_TTL_MS = 10 * 60_000;

/* ---------------------------------------------------------------------------- the requests --- */

/** What a dapp is asking for, as it is written to chrome.storage.session. */
export interface PendingRequest {
  readonly id: string;
  readonly origin: string;
  /** The tab, so the answer can be routed back after a worker restart. */
  readonly tabId: number | null;
  readonly method: string;
  readonly params: readonly unknown[];
  readonly createdAt: number;
  /**
   * The approval window's id, filled in once `chrome.windows.create` has resolved.
   *
   * `null` means the window is still being created. The sweep that turns a closed window into a
   * 4001 rejection skips records in that state — it is the only way to tell "no window is open for
   * this request because the user closed it" from "no window is open for this request YET".
   * Guessing at that difference with a timeout was tried, and it produced a request that could
   * never be rejected at all: closing the window inside the guard's grace period skipped the sweep,
   * and nothing ever ran a second one.
   */
  readonly windowId: number | null;
  /** What the approval window needs to draw, computed once by the worker. */
  readonly preview: RequestPreview | null;
}

export type RequestPreview =
  | { readonly type: 'connect'; readonly accounts: readonly string[] }
  | { readonly type: 'signMessage'; readonly from: string; readonly text: string; readonly wasHex: boolean }
  | { readonly type: 'signTypedData'; readonly from: string; readonly domain: string; readonly primaryType: string; readonly json: string }
  | { readonly type: 'transaction'; readonly tx: TransactionPreview }
  | { readonly type: 'addChain'; readonly chainId: number; readonly name: string; readonly rpcUrl: string; readonly symbol: string; readonly known: boolean }
  | { readonly type: 'switchChain'; readonly chainId: number; readonly name: string };

export interface TransactionPreview {
  readonly from: string;
  readonly to: string | null;
  readonly valueWei: string;
  readonly data: string;
  readonly chainId: number;
  /**
   * The chain's name and currency, taken from the wallet's record for `chainId`.
   *
   * CARRIED RATHER THAN ASSUMED. The confirmation window used to print "EMBER" over every amount,
   * which is a hard-coded currency name on a screen whose whole job is to state what is about to
   * happen. On any chain a user added themselves that was simply wrong.
   */
  readonly chainName: string;
  readonly currencySymbol: string;
  /** What the NODE answered to `eth_chainId` when this preview was built. */
  readonly reportedChainId: number;
  readonly gas: string;
  readonly gasPrice: string;
  readonly nonce: string;
  /** The decoded call — never null in the UI's eyes; an unrecognised call decodes to 'unknown'. */
  readonly decoded: DecodedCall;
  readonly warnings: readonly Warning[];
  /**
   * For a `stake(uint8)` call: the market as one node reported it at the block named inside, read
   * AT PREVIEW TIME — §5.1's "odds are read at signing time and shown as they were".
   *
   * `null` for every other call, and also for a stake whose market could not be read: a
   * confirmation screen that silently omits the pool is better than one that invents it, and the
   * UI says which of the two happened. It is deliberately not a number pair — the whole
   * observation travels, so the screen can name the block it came from.
   */
  readonly foresight: ForesightPreview | null;
}

/** The parimutuel facts a confirmation screen needs, and the projection it may show beside them. */
export interface ForesightPreview {
  readonly observation: MarketObservation;
  readonly projection: StakeProjection;
}

export interface Warning {
  readonly severity: 'danger' | 'caution';
  readonly title: string;
  readonly detail: string;
}

export type DecodedCall =
  | { readonly kind: 'transfer-native'; readonly to: string; readonly amountWei: string }
  | { readonly kind: 'erc20-transfer'; readonly token: string; readonly to: string; readonly amount: string }
  | { readonly kind: 'erc20-approve'; readonly token: string; readonly spender: string; readonly amount: string; readonly unlimited: boolean }
  | { readonly kind: 'erc721-approve-all'; readonly token: string; readonly operator: string; readonly approved: boolean }
  | { readonly kind: 'deploy'; readonly bytes: number }
  | { readonly kind: 'known'; readonly signature: string; readonly args: readonly { name: string; type: string; value: string }[] }
  | { readonly kind: 'unknown'; readonly selector: string; readonly bytes: number };

/** The decision the approval window writes back. */
export interface Decision {
  readonly id: string;
  readonly approved: boolean;
  /** Overrides the user typed into the fee editor, if any. */
  readonly overrides?: { readonly gas?: string; readonly gasPrice?: string };
  /** For a connect: which accounts the user chose to share. */
  readonly accounts?: readonly string[];
}
