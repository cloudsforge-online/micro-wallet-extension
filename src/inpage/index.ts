/* The provider the page sees: EIP-1193 over EIP-6963, and the fight this file refuses to have.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * THE `window.ethereum` PROBLEM, AND WHY THIS WALLET LOSES ON PURPOSE
 *
 * Before EIP-6963 there was one global, and every wallet wrote to it at `document_start`. The
 * winner was whichever extension the browser happened to inject last, which is not a decision the
 * user made and is not stable between page loads. Wallets escalated: overwriting a non-configurable
 * property, redefining it after a timeout, wrapping a rival's provider and proxying to their own.
 * Users could not tell which wallet was about to sign, and the ones that fought hardest were the
 * ones that got uninstalled. 25-wallet-clients.md §4.3 states the rule in one sentence — "a wallet
 * that wins that fight by force is a wallet users uninstall" — and this file implements it:
 *
 *   1. EIP-6963 is the real interface. The provider is ANNOUNCED, not installed. Any number of
 *      wallets can announce; the dapp lists them; the user picks. There is no conflict to have.
 *   2. `window.ethereum` is set ONLY IF IT IS ABSENT, and only ever with `configurable: true`, so a
 *      wallet that loads after this one can still take it. That is the legacy compatibility path
 *      for dapps that predate 6963 and nothing more.
 *   3. If `window.ethereum` already exists, this file does not touch it. Not to wrap it, not to
 *      add itself to a `providers` array, not to "helpfully" proxy. Whatever is there was put there
 *      by another wallet and belongs to it.
 *
 * test/e2e/coexistence.test.ts loads a SECOND extension that behaves exactly like MetaMask does —
 * sets `window.ethereum` at document_start and announces over 6963 — and asserts that after both
 * have loaded, `window.ethereum` is still the rival's and both wallets are discoverable.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * This script runs in the page's MAIN world. It has no extension privileges, it cannot read
 * storage, and everything it says is checked again on the other side of the content script.
 */

import {
  CHANNEL, RDNS, WALLET_NAME, type PageEvent, type PageRequest, type PageResponse,
} from '../shared/protocol.ts';
import { DISCONNECTED, reviveProviderError } from '../shared/errors.ts';

/* The toolbar mark as a data URI, which EIP-6963 requires (`icon` must be an RFC 2397 URI so a
 * dapp can render it without a network fetch that would leak which dapps a wallet's users visit).
 *
 * A LAST RESORT, NO LONGER THE THING THAT SHIPS. micro-org#178.
 *
 * This comment used to read "PLACEHOLDER … 25-wallet-clients.md §6 puts the real mark at
 * `assets/extension/mark-light.svg`". That citation was wrong: §6 (lines 262-296) names no path and
 * no file format, and micro-wallet-assets contains no SVG at all — FLUX 2 Pro emits raster. The two
 * `.svg` entries in tools/build.js were therefore unmatchable, and the real mark went unused while
 * the build fell through to a 1024x1024 plate that compiled a 134 kB data URI into this file, which
 * is injected into every page the user visits.
 *
 * The build now takes `assets/extension/icons/icon-128.png` — 128x128, 4,852 bytes, the size
 * EIP-6963 wants, and a PNG data URI is as valid under RFC 2397 as an SVG one. `pnpm build
 * --require-assets`, which CI passes, FAILS rather than reaching this constant, so the lozenge below
 * can only be seen by a developer building without a sibling ../wallet-assets checkout. */
const FALLBACK_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA5NiA5NiI+PHJlY3Qgd2lkdGg9Ijk2IiBoZWlnaHQ9Ijk2IiByeD0iMjAiIGZpbGw9IiMxNDExMTAiLz48cGF0aCBkPSJNNDggMjBjLTEwIDEyLTE4IDIwLTE4IDMwYTE4IDE4IDAgMCAwIDM2IDBjMC0xMC04LTE4LTE4LTMweiIgZmlsbD0iI2U4NjIyYyIvPjwvc3ZnPg==';

declare const __WALLET_ICON__: string | undefined;
const ICON = typeof __WALLET_ICON__ === 'string' && __WALLET_ICON__.length > 0 ? __WALLET_ICON__ : FALLBACK_ICON;

type Listener = (payload: never) => void;

interface RequestArgs {
  readonly method: string;
  readonly params?: readonly unknown[] | Record<string, unknown>;
}

let sequence = 0;
const inflight = new Map<string, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();

/**
 * The EIP-1193 provider.
 *
 * `request()` returns a promise that settles exactly once, ALWAYS. A provider whose promise can
 * hang is worse than one that errors: a dapp shows a spinner with no cancel, and the user's only
 * recourse is to reload and lose whatever they had typed. The content script guarantees settlement
 * on its side — including when the service worker dies mid-approval — and the disconnect path here
 * is the last resort for the case where the whole extension is unloaded.
 */
class CloudsForgeProvider extends EventTarget {
  /** Legacy flags. `isMetaMask` is deliberately absent: claiming to be another wallet is how
   *  detection code ends up talking to the wrong signer, and it is a lie told to software that
   *  believed it. */
  readonly isCloudsForge = true;
  readonly rdns = RDNS;

  private chainIdHex: string | null = null;
  private accounts: readonly string[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  async request(args: RequestArgs): Promise<unknown> {
    if (typeof args !== 'object' || args === null || typeof args.method !== 'string') {
      throw reviveProviderError({ code: -32602, message: 'request() takes { method, params }.' });
    }
    const params = Array.isArray(args.params) ? args.params : args.params === undefined ? [] : [args.params];
    const id = `${Date.now().toString(36)}-${(sequence += 1).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((resolve, reject) => {
      inflight.set(id, { resolve, reject });
      const frame: PageRequest = { channel: CHANNEL, dir: 'page->content', id, method: args.method, params };
      window.postMessage(frame, window.location.origin);
    });
  }

  /* The EventEmitter surface EIP-1193 specifies. It is not Node's EventEmitter and dapps only ever
   * use these four methods, so they are implemented directly rather than pulled in as a shim. */
  on(event: string, listener: Listener): this {
    let set = this.listeners.get(event);
    if (set === undefined) { set = new Set(); this.listeners.set(event, set); }
    set.add(listener);
    return this;
  }

  removeListener(event: string, listener: Listener): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  once(event: string, listener: Listener): this {
    const wrapper = ((payload: never): void => { this.removeListener(event, wrapper); listener(payload); }) as Listener;
    return this.on(event, wrapper);
  }

  removeAllListeners(event?: string): this {
    if (event === undefined) this.listeners.clear();
    else this.listeners.delete(event);
    return this;
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try { (listener as (value: unknown) => void)(payload); } catch { /* a dapp's handler threw; not ours to report */ }
    }
    this.dispatchEvent(new CustomEvent(event, { detail: payload }));
  }

  /** Deprecated but still probed by older libraries; answering honestly is cheaper than a break. */
  isConnected(): boolean { return true; }

  ingest(event: PageEvent): void {
    if (event.event === 'chainChanged') {
      const next = String(event.payload);
      if (next === this.chainIdHex) return;
      this.chainIdHex = next;
      this.emit('chainChanged', next);
      return;
    }
    if (event.event === 'accountsChanged') {
      const next = (event.payload as string[]) ?? [];
      const same = next.length === this.accounts.length && next.every((a, i) => a === this.accounts[i]);
      if (same) return;
      this.accounts = next;
      this.emit('accountsChanged', next);
      return;
    }
    if (event.event === 'disconnect') {
      this.emit('disconnect', reviveProviderError({ code: DISCONNECTED, message: String(event.payload) }));
    }
  }
}

const provider = new CloudsForgeProvider();

window.addEventListener('message', (event: MessageEvent) => {
  // Only frames this window posted to itself. Without this check, any embedded iframe or any other
  // extension's content script could resolve one of our promises with a value of its choosing.
  if (event.source !== window) return;
  const data = event.data as Partial<PageResponse & PageEvent>;
  if (data?.channel !== CHANNEL || data.dir !== 'content->page') return;

  if (typeof data.event === 'string') {
    provider.ingest(data as PageEvent);
    return;
  }
  const id = (data as PageResponse).id;
  if (typeof id !== 'string') return;
  const pending = inflight.get(id);
  if (pending === undefined) return;
  inflight.delete(id);
  const response = data as PageResponse;
  if (response.error !== undefined) pending.reject(reviveProviderError(response.error));
  else pending.resolve(response.result);
});

/* ------------------------------------------------------------------------------- EIP-6963 ----- */

/**
 * The uuid is per PAGE LOAD, not per install.
 *
 * EIP-6963 says so, and the reason is privacy: a uuid that persisted would be a stable identifier
 * for this browser profile that every dapp could read without permission and correlate across
 * sites. `crypto.randomUUID()` here means it identifies this announcement and nothing else.
 */
const info = Object.freeze({
  uuid: crypto.randomUUID(),
  name: WALLET_NAME,
  icon: ICON,
  rdns: RDNS,
});

function announce(): void {
  window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
    detail: Object.freeze({ info, provider }),
  }));
}

// Announce on request, and once unprompted — a dapp that loaded before this script needs the
// former, and one that loaded after needs the latter. Both are required by the EIP; implementing
// only the second is why some wallets are invisible to dapps that mount their connect button early.
window.addEventListener('eip6963:requestProvider', announce);
announce();

/* ------------------------------------------------------------ legacy window.ethereum, politely - */

if (!('ethereum' in window)) {
  Object.defineProperty(window, 'ethereum', {
    value: provider,
    // WRITABLE AND CONFIGURABLE, BOTH TRUE, DELIBERATELY. A wallet installed after this one must be
    // able to take the global if the user prefers it. Locking the property is the escalation this
    // file exists not to perform, and it also breaks dapps that assign their own test double.
    writable: true,
    configurable: true,
    enumerable: false,
  });
} else {
  // Another wallet is already here. Nothing happens. This branch exists so that the decision is
  // visible in the source rather than being an absence somebody later "fixes".
}

export {};
