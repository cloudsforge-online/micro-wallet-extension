/* EIP-1193 method dispatch, EIP-3085/3326 chain management, and the permission model.
 *
 * THE ORIGIN ARGUMENT IS NEVER TAKEN FROM THE PAGE. It arrives from `port.sender.origin`, which
 * the browser fills in. Everything in this file that names an origin — the connect prompt, the
 * phishing warning, the permission record — names that one. §5 asks for "a phishing warning that
 * NAMES THE ORIGIN", and a warning naming an origin the attacker supplied is a phishing aid.
 *
 * WHY THERE IS NO `eth_sign`. It signs 32 arbitrary bytes with no prefix and no structure, which
 * means a dapp can hand a user the hash of a transaction that drains them and the wallet has
 * nothing to display but hex. It is refused by name with a message saying what to use instead,
 * because a wallet that supports it has a hole no confirmation screen can close.
 */

import type { TypedDataPayload } from '@cloudsforge/hearth-wallet-core';
import { bytesToUtf8, fromHex, toChecksumAddress } from '@cloudsforge/hearth-wallet-core';

import {
  INVALID_PARAMS, ProviderError, UNAUTHORIZED, UNRECOGNISED_CHAIN, UNSUPPORTED_METHOD,
} from '../shared/errors.ts';
import type { PendingRequest, RequestPreview, TransactionPreview } from '../shared/protocol.ts';
import { decodeCall, warningsFor } from '../shared/decode.ts';
import { fromQuantity, toQuantity } from '../shared/units.ts';
import type { ChainRecord } from './storage.ts';
import { getLocal, setLocal } from './storage.ts';
import { isUnlocked, touchSession } from './session.ts';
import { enqueue } from './requests.ts';
import { estimateGas, getNonce, rpc } from './rpc.ts';

/**
 * Read methods forwarded verbatim to the node.
 *
 * AN ALLOWLIST, NOT A DENYLIST. A denylist means every method a future node gains is exposed to
 * every dapp by default, including any that turn out to be privileged. Everything here is a read
 * that a dapp could make itself by talking to the same public node, so forwarding it grants nothing
 * — it only saves the dapp from needing its own RPC URL.
 */
const PASSTHROUGH = new Set([
  'eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_feeHistory', 'eth_gasPrice',
  'eth_getBalance', 'eth_getBlockByHash', 'eth_getBlockByNumber', 'eth_getBlockReceipts',
  'eth_getBlockTransactionCountByHash', 'eth_getBlockTransactionCountByNumber', 'eth_getCode',
  'eth_getLogs', 'eth_getStorageAt', 'eth_getTransactionByHash', 'eth_getTransactionCount',
  'eth_getTransactionReceipt', 'eth_maxPriorityFeePerGas', 'eth_sendRawTransaction', 'eth_syncing',
  'web3_clientVersion',
]);

export type HandlerOutcome =
  | { readonly kind: 'result'; readonly result: unknown }
  /** An approval window is open. The answer arrives later through requests.settle. */
  | { readonly kind: 'deferred' };

export async function selectedChain(): Promise<ChainRecord> {
  const [chains, settings] = await Promise.all([getLocal('chains'), getLocal('settings')]);
  const chain = chains.find((c) => c.id === settings.selectedChainId);
  if (chain === undefined) {
    throw new ProviderError(UNRECOGNISED_CHAIN, `Chain ${settings.selectedChainId} is selected but is not configured.`);
  }
  return chain;
}

async function permittedAccounts(origin: string): Promise<readonly string[]> {
  const permissions = await getLocal('permissions');
  const granted = permissions.find((p) => p.origin === origin);
  if (granted === undefined) return [];
  // Intersect with the accounts that still exist: an account removed from the wallet must stop
  // being visible to a dapp that was connected to it, without needing the dapp to reconnect.
  const accounts = await getLocal('accounts');
  const held = new Set(accounts.map((a) => a.address.toLowerCase()));
  return granted.accounts.filter((a) => held.has(a.toLowerCase()));
}

export async function grantAccounts(origin: string, accounts: readonly string[]): Promise<void> {
  const permissions = await getLocal('permissions');
  const rest = permissions.filter((p) => p.origin !== origin);
  await setLocal('permissions', [...rest, { origin, accounts: [...accounts], grantedAt: Date.now() }]);
}

export async function revokeOrigin(origin: string): Promise<void> {
  const permissions = await getLocal('permissions');
  await setLocal('permissions', permissions.filter((p) => p.origin !== origin));
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new ProviderError(INVALID_PARAMS, `${what} must be a string.`);
  return value;
}

function requireObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProviderError(INVALID_PARAMS, `${what} must be an object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * A chain id from a dapp, which arrives as a hex string per EIP-3326 and as a number from our own
 * UI. Both are accepted; neither is trusted to be in range.
 */
function parseChainId(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(fromQuantity(requireString(value, 'chainId'), 'chainId'));
  if (!Number.isSafeInteger(n) || n <= 0) throw new ProviderError(INVALID_PARAMS, 'That is not a chain id.');
  return n;
}

/** Build the preview an approval window draws for a transaction, filling in what the dapp omitted. */
export async function previewTransaction(origin: string, raw: Record<string, unknown>, chain: ChainRecord): Promise<TransactionPreview> {
  void origin;
  const from = toChecksumAddress(requireString(raw['from'], 'from'));
  const to = raw['to'] == null ? null : toChecksumAddress(requireString(raw['to'], 'to'));
  const data = raw['data'] == null ? '0x' : requireString(raw['data'], 'data');
  const valueWei = raw['value'] == null ? 0n : fromQuantity(raw['value'], 'value');

  const [estimate, nonce] = await Promise.all([
    estimateGas(chain, { from, to, value: toQuantity(valueWei), data }),
    getNonce(chain, from),
  ]);

  const gas = raw['gas'] != null ? fromQuantity(raw['gas'], 'gas') : (estimate.gas * 12n) / 10n;
  const gasPrice = raw['gasPrice'] != null ? fromQuantity(raw['gasPrice'], 'gasPrice') : estimate.gasPrice;
  const decoded = decodeCall({ to, data, valueWei });
  const warnings = [...warningsFor(decoded, valueWei)];
  if (estimate.fellBack) {
    warnings.unshift({
      severity: 'danger',
      title: 'The node would not estimate this call',
      detail: `${chain.name} said: ${estimate.reason ?? 'no reason given'}. That usually means the call would fail. The gas figure below is a default, not an estimate.`,
    });
  }

  return {
    from,
    to,
    valueWei: valueWei.toString(),
    data,
    chainId: chain.id,
    gas: gas.toString(),
    gasPrice: gasPrice.toString(),
    nonce: (raw['nonce'] != null ? fromQuantity(raw['nonce'], 'nonce') : nonce).toString(),
    decoded,
    warnings,
  };
}

export interface DispatchContext {
  readonly origin: string;
  readonly tabId: number | null;
  readonly id: string;
}

export async function dispatch(ctx: DispatchContext, method: string, params: readonly unknown[]): Promise<HandlerOutcome> {
  const chain = await selectedChain();

  switch (method) {
    case 'eth_chainId':
      return { kind: 'result', result: toQuantity(BigInt(chain.id)) };

    case 'net_version':
      return { kind: 'result', result: String(chain.id) };

    /* EIP-1193: the non-prompting read. Returns [] when not connected — it must NEVER prompt, or
     * every page that probes for a wallet on load opens a window. */
    case 'eth_accounts':
      return { kind: 'result', result: await permittedAccounts(ctx.origin) };

    case 'eth_requestAccounts':
    case 'wallet_requestPermissions': {
      const already = await permittedAccounts(ctx.origin);
      if (already.length > 0) {
        return { kind: 'result', result: method === 'eth_requestAccounts' ? already : permissionsFor(ctx.origin, already) };
      }
      const accounts = await getLocal('accounts');
      if (accounts.length === 0) {
        throw new ProviderError(UNAUTHORIZED, 'This wallet has no accounts yet. Open it and create one.');
      }
      await defer(ctx, method, params, { type: 'connect', accounts: accounts.map((a) => a.address) });
      return { kind: 'deferred' };
    }

    case 'wallet_getPermissions':
      return { kind: 'result', result: permissionsFor(ctx.origin, await permittedAccounts(ctx.origin)) };

    case 'wallet_revokePermissions':
      await revokeOrigin(ctx.origin);
      return { kind: 'result', result: null };

    case 'personal_sign': {
      // EIP-191 argument order is (message, address) — the reverse of eth_sign, which is one of
      // the reasons eth_sign is refused rather than aliased.
      const from = await requireConnected(ctx.origin, params[1]);
      const messageHex = requireString(params[0], 'message');
      let text: string;
      let wasHex = false;
      try {
        text = bytesToUtf8(fromHex(messageHex));
        wasHex = true;
      } catch {
        text = messageHex;
      }
      await defer(ctx, method, params, { type: 'signMessage', from, text, wasHex });
      return { kind: 'deferred' };
    }

    case 'eth_signTypedData_v4':
    case 'eth_signTypedData': {
      const from = await requireConnected(ctx.origin, params[0]);
      const payloadRaw = typeof params[1] === 'string' ? JSON.parse(params[1]) as unknown : params[1];
      const payload = requireObject(payloadRaw, 'typed data');
      const domain = requireObject(payload['domain'] ?? {}, 'domain');
      await defer(ctx, method, params, {
        type: 'signTypedData',
        from,
        domain: typeof domain['name'] === 'string' ? domain['name'] : '(unnamed)',
        primaryType: typeof payload['primaryType'] === 'string' ? payload['primaryType'] : '(none)',
        json: JSON.stringify(payload, null, 2),
      });
      return { kind: 'deferred' };
    }

    case 'eth_sign':
      throw new ProviderError(
        UNSUPPORTED_METHOD,
        'This wallet does not implement eth_sign. It signs 32 arbitrary bytes with no prefix, so nothing can be shown to the user about what they are agreeing to — a signature obtained that way can authorise a transfer. Use personal_sign or eth_signTypedData_v4.',
      );

    case 'eth_sendTransaction': {
      const raw = requireObject(params[0], 'transaction');
      await requireConnected(ctx.origin, raw['from']);
      const preview = await previewTransaction(ctx.origin, raw, chain);
      await defer(ctx, method, params, { type: 'transaction', tx: preview });
      return { kind: 'deferred' };
    }

    /* EIP-3085 */
    case 'wallet_addEthereumChain': {
      const spec = requireObject(params[0], 'chain');
      const id = parseChainId(spec['chainId']);
      const chains = await getLocal('chains');
      const known = chains.some((c) => c.id === id);
      const urls = spec['rpcUrls'];
      const rpcUrl = Array.isArray(urls) && typeof urls[0] === 'string' ? urls[0] : '';
      if (!known && rpcUrl === '') {
        throw new ProviderError(INVALID_PARAMS, 'A new chain needs at least one rpcUrls entry.');
      }
      const currency = requireObject(spec['nativeCurrency'] ?? {}, 'nativeCurrency');
      await defer(ctx, method, params, {
        type: 'addChain',
        chainId: id,
        name: typeof spec['chainName'] === 'string' ? spec['chainName'] : `Chain ${id}`,
        rpcUrl,
        symbol: typeof currency['symbol'] === 'string' ? currency['symbol'] : '?',
        known,
      });
      return { kind: 'deferred' };
    }

    /* EIP-3326 */
    case 'wallet_switchEthereumChain': {
      const spec = requireObject(params[0], 'chain');
      const id = parseChainId(spec['chainId']);
      const chains = await getLocal('chains');
      const target = chains.find((c) => c.id === id);
      if (target === undefined) {
        // The code EIP-3326 specifies, and the one a dapp branches on to then call
        // wallet_addEthereumChain. Returning a generic error here breaks that handshake.
        throw new ProviderError(UNRECOGNISED_CHAIN, `This wallet does not know chain ${id}. Add it with wallet_addEthereumChain first.`);
      }
      if (target.id === chain.id) return { kind: 'result', result: null };
      await defer(ctx, method, params, { type: 'switchChain', chainId: id, name: target.name });
      return { kind: 'deferred' };
    }

    default:
      if (PASSTHROUGH.has(method)) {
        return { kind: 'result', result: await rpc(chain, method, params) };
      }
      throw new ProviderError(UNSUPPORTED_METHOD, `${method} is not supported by this wallet.`);
  }
}

function permissionsFor(origin: string, accounts: readonly string[]): unknown[] {
  if (accounts.length === 0) return [];
  return [{
    parentCapability: 'eth_accounts',
    invoker: origin,
    caveats: [{ type: 'restrictReturnedAccounts', value: [...accounts] }],
  }];
}

/**
 * The account this origin is allowed to act as, or a refusal that says which.
 *
 * A dapp naming an account the user never shared with it is either a bug or an attempt to make the
 * wallet sign as a different account than the one on screen, and both deserve the same answer.
 */
async function requireConnected(origin: string, from: unknown): Promise<string> {
  const accounts = await permittedAccounts(origin);
  if (accounts.length === 0) {
    throw new ProviderError(UNAUTHORIZED, `${origin} is not connected to this wallet. Call eth_requestAccounts first.`);
  }
  if (from == null) return accounts[0] as string;
  const wanted = requireString(from, 'from').toLowerCase();
  const match = accounts.find((a) => a.toLowerCase() === wanted);
  if (match === undefined) {
    throw new ProviderError(UNAUTHORIZED, `${origin} is not connected to ${from}.`);
  }
  return match;
}

async function defer(ctx: DispatchContext, method: string, params: readonly unknown[], preview: RequestPreview): Promise<void> {
  const request: PendingRequest = {
    id: ctx.id,
    origin: ctx.origin,
    tabId: ctx.tabId,
    method,
    params: [...params],
    createdAt: Date.now(),
    windowId: null,
    preview: null,
  };
  await enqueue(request, preview);
  if (await isUnlocked()) await touchSession();
}

export type { TypedDataPayload };
