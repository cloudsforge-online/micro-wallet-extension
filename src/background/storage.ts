/* The two stores, and the rule about which is which.
 *
 * THIS FILE IS THE ANSWER TO THE MV3 CONSTRAINT (25-wallet-clients.md §4.3).
 *
 * A manifest v3 service worker is terminated after about thirty seconds of inactivity, and again
 * whenever the browser feels like it. Every module-level variable in the worker dies with it —
 * silently, between two user actions, with no event the code can observe. So the rule this whole
 * repository is built around:
 *
 *     NO STATE THAT MATTERS MAY LIVE IN A MODULE VARIABLE.
 *
 * There is no `let unlockedWallet` anywhere in src/background. There is no cache. Every read goes
 * to one of the two stores below, every write goes through them, and the worker is a pure function
 * of storage plus the message it was woken by. That is what makes a restart invisible instead of a
 * bug that only reproduces after the user reads a long approval screen — which is precisely when
 * it hurts, because thirty seconds is shorter than a careful person takes to check an address.
 *
 * `local`   — survives a browser restart, is written to disk. The sealed vault, the account list,
 *             settings, the per-origin permissions. Nothing here is a secret in the clear.
 * `session` — survives a WORKER restart and nothing more: Chrome documents it as in-memory, it is
 *             cleared when the browser closes, and its default access level is TRUSTED_CONTEXTS,
 *             so a content script cannot read it even if a page compromises one. The unlocked
 *             mnemonic and the pending dapp requests live here.
 *
 * ON KEEPING THE MNEMONIC IN `session` AT ALL. The alternative is re-deriving from the password
 * for every operation, and the core's keystore is PBKDF2 at 600,000 iterations — measured at 2.1
 * seconds on the machine this was written on. A wallet that pauses two seconds before it can tell
 * you your balance is a wallet whose users set a short password. Holding the phrase for the
 * duration of an explicit, time-boxed unlock is the trade §7 already describes: "keys sit in
 * OS-provided secure storage and are decrypted for the duration of a signature", widened to the
 * session because the browser gives an extension no secure enclave to sign inside. It is written
 * down here rather than assumed.
 */

import type { PendingRequest } from '../shared/protocol.ts';

/** A sealed keystore record, opaque here — the core owns its shape. */
export interface VaultRecord {
  readonly format: string;
  readonly v: number;
  readonly address: string;
  readonly label: string | null;
  readonly created: number;
  readonly kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  readonly cipher: 'AES-256-GCM';
  readonly iv: string;
  readonly ct: string;
  readonly wordCount?: number;
}

export interface AccountRecord {
  readonly address: string;
  readonly label: string;
  /** The BIP-44 index for a derived account; null for one imported as a raw key or keystore. */
  readonly index: number | null;
  readonly source: 'derived' | 'imported' | 'watch-only';
  /** For an imported account: its own sealed record, under the same password as the vault. */
  readonly sealed?: VaultRecord;
}

export interface ChainRecord {
  readonly id: number;
  readonly name: string;
  readonly rpcUrl: string;
  readonly currency: { name: string; symbol: string; decimals: number };
  readonly explorerUrl: string | null;
  /** False for the three Hearth chains, which have no base fee. See the core's chains.ts. */
  readonly supportsEip1559: boolean;
  /** True for a chain a dapp added through EIP-3085, so the UI can say where it came from. */
  readonly addedByDapp: boolean;
}

export interface OriginPermission {
  readonly origin: string;
  readonly accounts: readonly string[];
  readonly grantedAt: number;
}

export interface Settings {
  readonly selectedChainId: number;
  readonly selectedAddress: string | null;
  /** Minutes of inactivity before the wallet locks itself. */
  readonly autoLockMinutes: number;
  /** Set once the user has confirmed they wrote the phrase down. */
  readonly seedBackedUp: boolean;
  readonly onboarded: boolean;
}

export interface LocalShape {
  vault: VaultRecord | null;
  accounts: AccountRecord[];
  chains: ChainRecord[];
  permissions: OriginPermission[];
  settings: Settings;
  addressBook: { address: string; label: string }[];
}

/** What an unlock puts in `session`, and the only place a mnemonic ever is outside the vault. */
export interface UnlockSession {
  readonly mnemonic: string;
  /** Epoch milliseconds. Checked on every privileged read as well as by the alarm — see session.ts. */
  readonly expiresAt: number;
  /** Sealed records for imported keys, opened at unlock so signing needs no second PBKDF2. */
  readonly importedKeys: Readonly<Record<string, string>>;
}

export interface SessionShape {
  unlock: UnlockSession | null;
  requests: Record<string, PendingRequest>;
  /** Decided requests, kept briefly so a content script that reconnects can still collect. */
  outcomes: Record<string, { result?: unknown; error?: { code: number; message: string }; at: number }>;
}

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  selectedChainId: 7412,
  selectedAddress: null,
  autoLockMinutes: 15,
  seedBackedUp: false,
  onboarded: false,
});

/**
 * The chains the wallet ships knowing about.
 *
 * The RPC URL for the testnet is the public one; a user pointing at their own node is §5's "custom
 * RPC" and replaces this record rather than adding beside it. `supportsEip1559: false` is copied
 * from the core's chains.ts, where it is derived from three separate assertions in the node's own
 * source — it is a fact about Hearth v1, not a preference, and a fee editor that offered a
 * priority fee here would build a transaction the mempool refuses.
 */
export const BUILTIN_CHAINS: readonly ChainRecord[] = Object.freeze([
  {
    id: 7411,
    name: 'Hearth',
    rpcUrl: 'https://rpc.hearth.cloudsforge.online',
    currency: { name: 'Ember', symbol: 'EMBER', decimals: 18 },
    explorerUrl: 'https://explorer.cloudsforge.online',
    supportsEip1559: false,
    addedByDapp: false,
  },
  {
    id: 7412,
    name: 'Hearth Testnet',
    rpcUrl: 'http://127.0.0.1:8545',
    currency: { name: 'Ember', symbol: 'EMBER', decimals: 18 },
    explorerUrl: null,
    supportsEip1559: false,
    addedByDapp: false,
  },
]);

const LOCAL_DEFAULTS: LocalShape = {
  vault: null,
  accounts: [],
  chains: [...BUILTIN_CHAINS],
  permissions: [],
  settings: DEFAULT_SETTINGS,
  addressBook: [],
};

const SESSION_DEFAULTS: SessionShape = { unlock: null, requests: {}, outcomes: {} };

export async function getLocal<K extends keyof LocalShape>(key: K): Promise<LocalShape[K]> {
  const got = await chrome.storage.local.get(key);
  const value = (got as Partial<LocalShape>)[key];
  return value === undefined ? LOCAL_DEFAULTS[key] : value;
}

export async function setLocal<K extends keyof LocalShape>(key: K, value: LocalShape[K]): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function getSession<K extends keyof SessionShape>(key: K): Promise<SessionShape[K]> {
  const got = await chrome.storage.session.get(key);
  const value = (got as Partial<SessionShape>)[key];
  return value === undefined ? SESSION_DEFAULTS[key] : value;
}

export async function setSession<K extends keyof SessionShape>(key: K, value: SessionShape[K]): Promise<void> {
  await chrome.storage.session.set({ [key]: value });
}

export async function clearSessionKey(key: keyof SessionShape): Promise<void> {
  await chrome.storage.session.remove(key);
}

/**
 * Read-modify-write for a session key, serialised through a promise chain.
 *
 * `chrome.storage` has no compare-and-swap, and two requests arriving in the same worker tick would
 * otherwise each read the map, add their own entry, and write back — losing one. This chain is a
 * module variable and is therefore lost when the worker dies, which is exactly right: it holds no
 * state, only ordering, and there is nothing to order across a restart because the worker was not
 * running to receive anything.
 */
let queue: Promise<unknown> = Promise.resolve();

export function mutateSession<K extends keyof SessionShape>(
  key: K,
  update: (current: SessionShape[K]) => SessionShape[K],
): Promise<SessionShape[K]> {
  const next = queue.then(async () => {
    const current = await getSession(key);
    const updated = update(current);
    await setSession(key, updated);
    return updated;
  });
  queue = next.catch(() => undefined);
  return next;
}
