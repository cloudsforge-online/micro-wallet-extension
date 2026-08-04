/* Talking to a Hearth node, treating everything it says as hostile.
 *
 * §7: "The network is not trusted. RPC responses are treated as hostile input. Balances shown are
 * those a node reported; a confirmation is not final until the chain's own depth rule says so."
 *
 * In practice that means: no `as` on a response, no `result.balance` reached for without checking
 * the shape, and no arithmetic on a value that has not been through `fromQuantity`. A node that
 * returns `{"result": {"toString": …}}` must produce an error here, not a balance of NaN on the
 * user's screen. This is not paranoia about our own node — an extension follows the user to
 * whatever custom RPC they add (§5), and one of those will eventually be someone else's.
 *
 * There is no retry loop and no fallback endpoint. A silent failover to a second node means the
 * balance on screen and the nonce in the transaction can come from two different chains' views,
 * and the resulting nonce collision is very hard to explain to the person it happened to.
 */

import { fromQuantity, toQuantity } from '../shared/units.ts';
import { INTERNAL_ERROR, ProviderError } from '../shared/errors.ts';
import type { ChainRecord } from './storage.ts';

let nextId = 1;

export interface RpcResult {
  readonly result: unknown;
}

/** One JSON-RPC call. Throws a ProviderError carrying the node's own code where there is one. */
export async function rpc(chain: ChainRecord, method: string, params: readonly unknown[] = []): Promise<unknown> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params });
  let response: Response;
  try {
    response = await fetch(chain.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      // No cookies, ever. A node that sets one and a wallet that returns it is an identifier
      // linking every request a user makes, which §7's "analytics see nothing" forbids in spirit
      // even though it is somebody else's analytics.
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (cause) {
    throw new ProviderError(
      -32603,
      `Could not reach ${chain.name} at ${chain.rpcUrl}. ${cause instanceof Error ? cause.message : ''}`.trim(),
    );
  }
  if (!response.ok) {
    throw new ProviderError(INTERNAL_ERROR, `${chain.name} answered HTTP ${response.status} for ${method}.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ProviderError(INTERNAL_ERROR, `${chain.name} answered ${method} with something that is not JSON.`);
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new ProviderError(INTERNAL_ERROR, `${chain.name} answered ${method} with ${JSON.stringify(payload)}.`);
  }
  const envelope = payload as { error?: unknown; result?: unknown };
  if (envelope.error !== undefined && envelope.error !== null) {
    const err = envelope.error as { code?: unknown; message?: unknown };
    throw new ProviderError(
      typeof err.code === 'number' ? err.code : INTERNAL_ERROR,
      typeof err.message === 'string' ? err.message : `${method} failed`,
    );
  }
  if (!('result' in envelope)) {
    throw new ProviderError(INTERNAL_ERROR, `${chain.name} answered ${method} with neither a result nor an error.`);
  }
  return envelope.result;
}

/**
 * Many calls, one HTTP request — and a fallback for nodes that will not.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, MEASURED RATHER THAN ASSUMED.
 *
 * Reading a ForesightMarket whole is nineteen `eth_call`s. Done one at a time they were nineteen
 * HTTP round trips, and the first CI run of the phase-5 suite TIMED OUT on them: the job's node
 * mines with `HEARTH_THROTTLE=0.9`, so its JSON-RPC server is starved most of the time and each
 * round trip cost seconds. contracts.ts had a comment claiming sequential was the safe choice
 * because concurrent calls make a single node flaky. That was speculation, and CI falsified it in
 * the opposite direction.
 *
 * Batching is the right fix rather than concurrency: it is ONE request, so it cannot contend with
 * itself, and every call in it is answered from the same node in one pass. The pinned-block
 * guarantee is untouched — the block tag is still in every element.
 *
 * THE FALLBACK IS NOT OPTIONAL. This wallet follows the user to whatever RPC they add (§5), and
 * batching is a part of JSON-RPC that a node may legitimately not implement. A node that answers a
 * batch with a single object, an error, or the wrong number of results gets the sequential path
 * instead — slower, and correct. Silently returning short would be far worse: it would present as
 * a market whose pools read zero.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
export async function rpcBatch(
  chain: ChainRecord,
  calls: readonly { method: string; params: readonly unknown[] }[],
): Promise<unknown[]> {
  if (calls.length === 0) return [];
  if (calls.length === 1) return [await rpc(chain, calls[0]!.method, calls[0]!.params)];

  const base = nextId;
  nextId += calls.length;
  const body = JSON.stringify(calls.map((call, i) => ({
    jsonrpc: '2.0', id: base + i, method: call.method, params: call.params,
  })));

  let payload: unknown;
  try {
    const response = await fetch(chain.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    payload = await response.json();
  } catch {
    return sequential(chain, calls);
  }

  if (!Array.isArray(payload) || payload.length !== calls.length) {
    // Not a batch answer. Rather than guess at which element is missing, ask again one at a time —
    // the answers must be right, and being slower is the acceptable cost of that.
    return sequential(chain, calls);
  }

  // The spec permits any order, so results are matched by id rather than by position. A node that
  // returns them shuffled and a reader that assumes position would put the YES pool in the NO slot.
  const byId = new Map<number, { error?: unknown; result?: unknown }>();
  for (const entry of payload) {
    if (typeof entry !== 'object' || entry === null) return sequential(chain, calls);
    const element = entry as { id?: unknown; error?: unknown; result?: unknown };
    if (typeof element.id !== 'number') return sequential(chain, calls);
    byId.set(element.id, element);
  }

  const out: unknown[] = [];
  for (let i = 0; i < calls.length; i += 1) {
    const element = byId.get(base + i);
    if (element === undefined) return sequential(chain, calls);
    if (element.error !== undefined && element.error !== null) {
      const err = element.error as { code?: unknown; message?: unknown };
      throw new ProviderError(
        typeof err.code === 'number' ? err.code : INTERNAL_ERROR,
        typeof err.message === 'string' ? err.message : `${calls[i]!.method} failed`,
      );
    }
    if (!('result' in element)) {
      throw new ProviderError(INTERNAL_ERROR, `${chain.name} answered ${calls[i]!.method} with neither a result nor an error.`);
    }
    out.push(element.result);
  }
  return out;
}

async function sequential(
  chain: ChainRecord,
  calls: readonly { method: string; params: readonly unknown[] }[],
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const call of calls) out.push(await rpc(chain, call.method, call.params));
  return out;
}

export async function getBalance(chain: ChainRecord, address: string): Promise<bigint> {
  return fromQuantity(await rpc(chain, 'eth_getBalance', [address, 'latest']), 'eth_getBalance');
}

export async function getChainId(chain: ChainRecord): Promise<bigint> {
  return fromQuantity(await rpc(chain, 'eth_chainId'), 'eth_chainId');
}

export async function getBlockNumber(chain: ChainRecord): Promise<bigint> {
  return fromQuantity(await rpc(chain, 'eth_blockNumber'), 'eth_blockNumber');
}

export async function getGasPrice(chain: ChainRecord): Promise<bigint> {
  return fromQuantity(await rpc(chain, 'eth_gasPrice'), 'eth_gasPrice');
}

/**
 * The nonce, from `pending` rather than `latest`.
 *
 * `latest` counts only mined transactions, so sending twice before a block is found reuses a nonce
 * and the second transaction is dropped with no error anyone sees. Hearth's node serves `pending`
 * as "mined plus the mempool's contiguous run" — jsonrpc/methods.js is explicit that a gap in the
 * mempool stops the count, which is the behaviour a wallet wants.
 */
export async function getNonce(chain: ChainRecord, address: string): Promise<bigint> {
  return fromQuantity(await rpc(chain, 'eth_getTransactionCount', [address, 'pending']), 'eth_getTransactionCount');
}

export interface GasEstimate {
  readonly gas: bigint;
  readonly gasPrice: bigint;
  /** True when the node refused to estimate and this is the 21000 floor instead. */
  readonly fellBack: boolean;
  readonly reason: string | null;
}

/**
 * Estimate, and say so honestly when the estimate failed.
 *
 * A node refuses `eth_estimateGas` when the call would revert — which is exactly the case where a
 * wallet must NOT quietly substitute a plausible number and let the user sign. The fallback is
 * returned with `fellBack: true` and the node's own reason, and the confirmation screen shows it.
 */
export async function estimateGas(
  chain: ChainRecord,
  call: { from: string; to?: string | null; value?: string; data?: string },
): Promise<GasEstimate> {
  const gasPrice = await getGasPrice(chain);
  const params: Record<string, string> = { from: call.from };
  if (call.to != null) params['to'] = call.to;
  if (call.value !== undefined && call.value !== '0x0') params['value'] = call.value;
  if (call.data !== undefined && call.data !== '0x') params['data'] = call.data;
  try {
    const gas = fromQuantity(await rpc(chain, 'eth_estimateGas', [params, 'latest']), 'eth_estimateGas');
    return { gas, gasPrice, fellBack: false, reason: null };
  } catch (cause) {
    return {
      gas: 21_000n,
      gasPrice,
      fellBack: true,
      reason: cause instanceof Error ? cause.message : 'the node would not estimate this call',
    };
  }
}

export async function sendRaw(chain: ChainRecord, raw: string): Promise<string> {
  const hash = await rpc(chain, 'eth_sendRawTransaction', [raw]);
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new ProviderError(INTERNAL_ERROR, `${chain.name} accepted the transaction but returned ${JSON.stringify(hash)} instead of a hash.`);
  }
  return hash;
}

export interface HistoryEntry {
  readonly hash: string;
  readonly from: string;
  readonly to: string | null;
  readonly valueWei: string;
  readonly blockNumber: number;
  readonly timestamp: number;
  readonly direction: 'in' | 'out' | 'self';
}

/**
 * History, by walking blocks — because there is no indexer in this path and there must not be.
 *
 * §5.1's property worth building for is that "positions survive the platform": if every CloudsForge
 * service were switched off, this wallet must still work against any Hearth node. micro-indexer
 * would give a far better history in one call, and using it would make the wallet's activity screen
 * depend on the platform being up. So the wallet walks the last `depth` blocks itself, which any
 * node can answer, and says plainly in the UI how far back it looked.
 *
 * `depth` is bounded because this is O(blocks) HTTP calls. The honest UI text is "the last N
 * blocks", not "your history" — a screen that implies completeness it does not have is the same
 * class of lie as summing a custodial and a self-custody balance.
 */
export async function recentHistory(chain: ChainRecord, address: string, depth = 200): Promise<{ entries: HistoryEntry[]; scannedFrom: number; scannedTo: number }> {
  const tip = await getBlockNumber(chain);
  const from = tip > BigInt(depth) ? tip - BigInt(depth) : 0n;
  const wanted = address.toLowerCase();
  const entries: HistoryEntry[] = [];

  // Batched, in windows, rather than one HTTP round trip per block. Walking 100 blocks one at a
  // time is 100 round trips, and on a node mining at HEARTH_THROTTLE=0.9 that is slow enough for
  // the activity screen to time out — which CI demonstrated. The window is bounded because a batch
  // of 100 blocks WITH FULL TRANSACTION BODIES is a large response to hold in a service worker,
  // and a worker that is killed for memory loses the whole read rather than one window of it.
  const WINDOW = 20;
  for (let n = tip; n >= from; n -= BigInt(WINDOW)) {
    const numbers: bigint[] = [];
    for (let i = 0; i < WINDOW; i += 1) {
      const at = n - BigInt(i);
      if (at < from) break;
      numbers.push(at);
    }
    if (numbers.length === 0) break;

    const blocks = await rpcBatch(chain, numbers.map((at) => ({
      method: 'eth_getBlockByNumber',
      params: [toQuantity(at), true],
    })));

    for (const [index, block] of blocks.entries()) {
      const at = numbers[index]!;
      if (typeof block !== 'object' || block === null) continue;
      const b = block as { transactions?: unknown; timestamp?: unknown; number?: unknown };
      if (!Array.isArray(b.transactions)) continue;
      const timestamp = typeof b.timestamp === 'string' ? Number(fromQuantity(b.timestamp, 'block.timestamp')) : 0;
      for (const raw of b.transactions) {
        if (typeof raw !== 'object' || raw === null) continue;
        const tx = raw as Record<string, unknown>;
        const txFrom = typeof tx['from'] === 'string' ? tx['from'].toLowerCase() : '';
        const txTo = typeof tx['to'] === 'string' ? tx['to'].toLowerCase() : null;
        if (txFrom !== wanted && txTo !== wanted) continue;
        entries.push({
          hash: typeof tx['hash'] === 'string' ? tx['hash'] : '0x',
          from: typeof tx['from'] === 'string' ? tx['from'] : '0x',
          to: typeof tx['to'] === 'string' ? tx['to'] : null,
          valueWei: fromQuantity(tx['value'] ?? '0x0', 'tx.value').toString(),
          blockNumber: Number(at),
          timestamp,
          direction: txFrom === wanted && txTo === wanted ? 'self' : txFrom === wanted ? 'out' : 'in',
        });
      }
    }
    if (numbers[numbers.length - 1] === 0n) break;
  }
  return { entries, scannedFrom: Number(from), scannedTo: Number(tip) };
}
