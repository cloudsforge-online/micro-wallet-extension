/* The bridge — and the component that makes a dead service worker survivable.
 *
 * THIS SCRIPT IS THE ONLY PARTICIPANT THAT IS GUARANTEED TO STILL BE THERE.
 *
 *   the page          can navigate away, but if it does nobody is waiting for the answer;
 *   the worker        is killed after ~30 seconds idle, taking every promise and every Map with it;
 *   the approval page is a separate window the user may leave open for minutes;
 *   THIS SCRIPT       lives exactly as long as the document that is waiting on the request.
 *
 * So the request id is minted here, the outstanding set is held here, and when the port to the
 * worker drops this script reconnects and asks — for each id it is still waiting on — "what
 * happened to that one?". The worker answers from `chrome.storage.session`, which outlived it.
 *
 * The failure this replaces: a port disconnect with no reconnect leaves every in-flight promise
 * unsettled, so the dapp spins forever. `port.onDisconnect` firing is NOT an error condition in
 * MV3 — it is the normal, expected, several-times-an-hour behaviour of an idle worker — and code
 * that treats it as an error is code that has only ever been run with devtools open, where the
 * worker never sleeps.
 *
 * The content script runs in an ISOLATED world. It can reach `chrome.runtime`; the page cannot.
 * That boundary is why the origin the worker sees comes from `port.sender` and never from a frame
 * the page constructed.
 */

import {
  CHANNEL, PORT_NAME_CONTENT, REQUEST_TTL_MS, type PageEvent, type PageRequest, type PageResponse,
  type WorkerMessage, type WorkerReply,
} from '../shared/protocol.ts';
import { DISCONNECTED } from '../shared/errors.ts';

/** Ids this document is still waiting on, with what the worker was asked and its deadline timer. */
const outstanding = new Map<string, { method: string; params: readonly unknown[]; watchdog: ReturnType<typeof setTimeout> }>();

let port: chrome.runtime.Port | null = null;
let reconnectDelay = 50;

function reply(response: PageResponse | PageEvent): void {
  window.postMessage(response, window.location.origin);
}

function settle(id: string, payload: { result: unknown } | { error: { code: number; message: string; data?: unknown } }): void {
  const record = outstanding.get(id);
  if (record === undefined) return;
  clearTimeout(record.watchdog);
  outstanding.delete(id);
  reply({ channel: CHANNEL, dir: 'content->page', id, ...payload } as PageResponse);
}

function connect(): chrome.runtime.Port {
  const opened = chrome.runtime.connect({ name: PORT_NAME_CONTENT });

  opened.onMessage.addListener((raw: unknown) => {
    const message = raw as WorkerReply;
    if (message.kind === 'event') {
      reply({ channel: CHANNEL, dir: 'content->page', event: message.event, payload: message.payload });
      return;
    }
    if (message.kind === 'pending') return; // still open; keep waiting, do not retry
    if (message.kind === 'result') { settle(message.id, { result: message.result }); return; }
    settle(message.id, { error: message.error });
  });

  opened.onDisconnect.addListener(() => {
    port = null;
    // chrome.runtime.lastError is read to stop Chrome logging "Unchecked runtime.lastError" for a
    // disconnect that is entirely expected.
    void chrome.runtime.lastError;
    if (outstanding.size === 0) return;
    // Something is still in flight. Reconnect and ask what became of it. Backoff is bounded and
    // short: the worker restarts in milliseconds, and the user is looking at an approval window.
    setTimeout(() => {
      try {
        const revived = ensurePort();
        for (const id of outstanding.keys()) {
          revived.postMessage({ kind: 'poll', id } satisfies WorkerMessage);
        }
        reconnectDelay = 50;
      } catch {
        // The extension itself is gone — updated, disabled or uninstalled. There is nothing to
        // reconnect to, so every waiting promise is failed with 4900 rather than left hanging.
        for (const id of [...outstanding.keys()]) {
          settle(id, { error: { code: DISCONNECTED, message: 'The CloudsForge wallet was disabled or updated while this request was open.' } });
        }
      }
      reconnectDelay = Math.min(reconnectDelay * 2, 2_000);
    }, reconnectDelay);
  });

  return opened;
}

function ensurePort(): chrome.runtime.Port {
  if (port === null) port = connect();
  return port;
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as Partial<PageRequest>;
  if (data?.channel !== CHANNEL || data.dir !== 'page->content') return;
  const { id, method, params } = data;
  if (typeof id !== 'string' || typeof method !== 'string' || !Array.isArray(params)) return;

  // THE WATCHDOG IS THE ONLY UNCONDITIONAL GUARANTEE IN THE WHOLE CHAIN.
  //
  // Every other path to settling this promise runs in the service worker, and the service worker
  // can be stopped, updated, or have its session storage cleared out from under it. This timer runs
  // here, in the page's own content script, which lives exactly as long as the caller does — so
  // there is no state anywhere whose loss can leave a dapp's `await provider.request(...)` hanging.
  // It fires long after any legitimate approval, and it is the difference between "the wallet
  // failed" (a dapp can show a retry) and "the wallet is thinking" (a spinner with no way out).
  const watchdog = setTimeout(() => {
    settle(id, {
      error: {
        code: DISCONNECTED,
        message: 'The CloudsForge wallet did not answer this request within ten minutes. Nothing was signed. Try again.',
      },
    });
  }, REQUEST_TTL_MS + 5_000);

  outstanding.set(id, { method, params, watchdog });
  try {
    ensurePort().postMessage({ kind: 'rpc', id, method, params } satisfies WorkerMessage);
  } catch {
    settle(id, { error: { code: DISCONNECTED, message: 'The CloudsForge wallet is not available in this browser session.' } });
  }
});

// Open the port eagerly so the worker is warm and so the provider learns the current chain id
// before a dapp asks for it.
ensurePort();

export {};
