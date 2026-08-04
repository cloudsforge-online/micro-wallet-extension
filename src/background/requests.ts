/* The pending-request queue: the part that has to survive the worker dying mid-approval.
 *
 * THE SCENARIO THIS FILE IS WRITTEN FOR, stated concretely because it is the one that gets shipped
 * broken:
 *
 *   1. A dapp calls `eth_sendTransaction`.
 *   2. The wallet opens an approval window showing the decoded call.
 *   3. The user reads it. Carefully. They check the address, character by character, because this
 *      wallet told them to. That takes ninety seconds.
 *   4. Chrome kills the service worker at thirty, because nothing has happened in it.
 *   5. The user clicks Approve.
 *
 * In the naive implementation the request lived in a `Map` in the worker and the dapp's promise was
 * a closure waiting on it. Both are gone. The approval click wakes a FRESH worker that has never
 * heard of this request, the dapp's promise never settles, and the page spins forever. The user
 * blames the wallet, correctly.
 *
 * So: the request record is written to `chrome.storage.session` BEFORE the window opens, the
 * decision is written back to the same store, and the answer is delivered by whichever worker
 * happens to be alive — matched to the caller by an id the CONTENT SCRIPT minted, because the
 * content script lives as long as the page and is the only participant guaranteed not to have died.
 *
 * ABOUT THE ONE MODULE-LEVEL MAP BELOW. `live` maps a request id to an open port. That is module
 * state in a service worker, which this repository otherwise forbids — and it is allowed here for
 * exactly one reason: IT HOLDS NOTHING WHOSE LOSS CHANGES AN OUTCOME. A port cannot outlive the
 * worker anyway (it is severed when the worker stops), so the map is not caching state, it is
 * naming connections that exist right now. Every path that reads it tolerates a miss by falling
 * back to `outcomes` in session storage, which is where the answer actually lives. Delete the map
 * entirely and the wallet still works, one poll slower. Delete `outcomes` and it does not.
 */

import { REQUEST_TTL_MS, type Decision, type PendingRequest, type RequestPreview, type WorkerReply } from '../shared/protocol.ts';
import { DISCONNECTED, ProviderError, toProviderError, userRejected } from '../shared/errors.ts';
import { getSession, mutateSession, setSession } from './storage.ts';

export { REQUEST_TTL_MS };
/** How long a decided outcome is kept for a content script that has not collected it yet. */
export const OUTCOME_TTL_MS = 60_000;

const live = new Map<string, chrome.runtime.Port>();

export function registerPort(id: string, port: chrome.runtime.Port): void {
  live.set(id, port);
}

export function forgetPort(port: chrome.runtime.Port): void {
  for (const [id, candidate] of live) if (candidate === port) live.delete(id);
}

function post(port: chrome.runtime.Port, reply: WorkerReply): void {
  try {
    port.postMessage(reply);
  } catch {
    // The page navigated away between the decision and the delivery. The outcome is already in
    // session storage; there is nothing to recover and nothing to log.
  }
}

/**
 * Record a request and open the window that decides it.
 *
 * Returns nothing: the caller does NOT await a decision, because awaiting one means holding a
 * promise across a worker restart. The caller replies `pending` and the answer arrives later
 * through `settle`.
 */
export async function enqueue(request: PendingRequest, preview: RequestPreview | null): Promise<void> {
  // THE RECORD IS WRITTEN BEFORE THE WINDOW OPENS, and the order is the point: if the worker were
  // stopped between the two, the request is recoverable. The other order loses it.
  const record: PendingRequest = { ...request, preview, windowId: null };
  await mutateSession('requests', (current) => ({ ...current, [request.id]: record }));

  // A `popup` window rather than the toolbar popup. The toolbar popup closes whenever the user
  // clicks anything else — including the dapp they are reading the request against — and a
  // confirmation screen that vanishes when you look away from it is a confirmation screen people
  // learn to approve without reading.
  const window = await chrome.windows.create({
    url: chrome.runtime.getURL(`approval.html#${encodeURIComponent(request.id)}`),
    type: 'popup',
    width: 400,
    height: 640,
    focused: true,
  });

  await mutateSession('requests', (current) => {
    const existing = current[request.id];
    // Already decided while the window was opening — do not resurrect it.
    if (existing === undefined) return current;
    return { ...current, [request.id]: { ...existing, windowId: window.id ?? null } };
  });
}

/** Record which window is showing a request. Idempotent, and safe if the request has been decided. */
export async function noteWindowId(id: string, windowId: number): Promise<void> {
  await mutateSession('requests', (current) => {
    const existing = current[id];
    if (existing === undefined) return current;
    return { ...current, [id]: { ...existing, windowId } };
  });
}

export async function pendingRequest(id: string): Promise<PendingRequest | null> {
  const requests = await getSession('requests');
  return requests[id] ?? null;
}

export async function allPending(): Promise<readonly PendingRequest[]> {
  const requests = await getSession('requests');
  const now = Date.now();
  return Object.values(requests)
    .filter((r) => now - r.createdAt < REQUEST_TTL_MS)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Deliver an answer: to the live port if there is one, and to storage always. */
export async function settle(id: string, outcome: { result: unknown } | { error: unknown }): Promise<void> {
  const wire: { result?: unknown; error?: { code: number; message: string }; at: number } = { at: Date.now() };
  if ('error' in outcome) {
    const serialised = toProviderError(outcome.error);
    wire.error = { code: serialised.code, message: serialised.message };
  } else {
    wire.result = outcome.result;
  }

  await mutateSession('requests', (current) => {
    const next = { ...current };
    delete next[id];
    return next;
  });
  await mutateSession('outcomes', (current) => {
    const now = Date.now();
    const kept = Object.fromEntries(Object.entries(current).filter(([, v]) => now - v.at < OUTCOME_TTL_MS));
    return { ...kept, [id]: wire };
  });

  const port = live.get(id);
  if (port !== undefined) {
    post(port, wire.error === undefined
      ? { kind: 'result', id, result: wire.result }
      : { kind: 'error', id, error: wire.error });
    live.delete(id);
  }
}

/**
 * "What happened to this request?" — the path a content script takes after the worker restarted.
 *
 * Three answers, and the third is the one that matters. `gone` is returned when the id is in
 * neither store, which happens when the browser itself was restarted and session storage was
 * cleared. The provider turns that into an EIP-1193 `4900 disconnected` rather than leaving the
 * promise open: §4.3 requires that every pending request either survives a worker restart or is
 * CLEANLY FAILED, and a promise that never settles is neither.
 */
export async function poll(id: string): Promise<{ state: 'pending' } | { state: 'settled'; result?: unknown; error?: { code: number; message: string } } | { state: 'gone' }> {
  const outcomes = await getSession('outcomes');
  const outcome = outcomes[id];
  if (outcome !== undefined) {
    return outcome.error === undefined
      ? { state: 'settled', result: outcome.result }
      : { state: 'settled', error: outcome.error };
  }
  const request = await pendingRequest(id);
  if (request === null) return { state: 'gone' };
  if (Date.now() - request.createdAt >= REQUEST_TTL_MS) {
    await settle(id, { error: new ProviderError(DISCONNECTED, 'This request was left open too long and the wallet gave up on it.') });
    return { state: 'settled', error: { code: DISCONNECTED, message: 'This request was left open too long and the wallet gave up on it.' } };
  }
  return { state: 'pending' };
}

/**
 * Sweep requests whose approval window the user closed without deciding.
 *
 * Closing the window IS a rejection — it is how most people decline — and it must produce a 4001
 * so the dapp shows its "cancelled" state instead of a spinner. This runs on `windows.onRemoved`
 * and again from the alarm, because a window can also be closed by the browser shutting down.
 */
export async function rejectAbandoned(openWindowIds: ReadonlySet<number>): Promise<void> {
  const requests = await getSession('requests');
  for (const [id, request] of Object.entries(requests)) {
    const stale = Date.now() - request.createdAt >= REQUEST_TTL_MS;
    if (stale) {
      await settle(id, { error: new ProviderError(DISCONNECTED, 'This request was left open too long and the wallet gave up on it.') });
      continue;
    }
    // Still being created — see PendingRequest.windowId. Not abandoned, just not born yet.
    if (request.windowId === null) continue;
    if (openWindowIds.has(request.windowId)) continue;
    // The window is gone and the user did not decide. That IS a decision, and the dapp needs the
    // 4001 to show its cancelled state rather than a spinner with no way out.
    await settle(id, { error: userRejected('request') });
  }
}

/** Wipe everything: used by `lock` so a locked wallet is not holding a dapp's transaction. */
export async function failAll(reason: string): Promise<void> {
  const requests = await getSession('requests');
  for (const id of Object.keys(requests)) {
    await settle(id, { error: new ProviderError(DISCONNECTED, reason) });
  }
  await setSession('requests', {});
}

export function applyDecision(decision: Decision): Decision {
  return decision;
}
