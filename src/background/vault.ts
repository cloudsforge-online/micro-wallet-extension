/* The vault: create, restore, derive, import, sign.
 *
 * EVERY CRYPTOGRAPHIC OPERATION IN THIS FILE IS A CALL INTO @cloudsforge/hearth-wallet-core.
 * There is no BIP-39 here, no secp256k1, no keccak, no RLP and no keystore format. 25-wallet-
 * clients.md §3 puts all of it in one library on purpose: three shells depending on divergent
 * copies of a signer is the worst failure this design can have, and the way that starts is one
 * client "just" reimplementing a small piece locally because the core was awkward. If something is
 * missing from the core, the fix is in the core.
 *
 * The one thing this file does own is ENTROPY, and it owns it because the core deliberately has
 * none: random.ts explains that a library guessing at `crypto ?? require('crypto') ?? Math.random`
 * fails silently into a 128-bit PRNG on whichever platform lacks the first two. Each shell passes
 * its own source. Ours is the service worker's `crypto.getRandomValues`, wrapped in the core's
 * `checkedRandomSource` so a broken one is caught on first use rather than at the moment funds move.
 */

import {
  accountFromMnemonic,
  addressFromPrivateKey,
  checkedRandomSource,
  fromHex,
  generateMnemonic,
  masterFromMnemonic,
  deriveAccount,
  open as openKeystore,
  openMnemonic,
  seal as sealKey,
  sealMnemonic,
  signPersonalMessage,
  signTransaction,
  signTypedData,
  toChecksumAddress,
  toHex,
  validateMnemonic,
  wipe,
  type Address,
  type KeystoreRecord,
  type MnemonicKeystoreRecord,
  type TransactionRequest,
  type TypedDataPayload,
} from '@cloudsforge/hearth-wallet-core';

import type { AccountRecord, ChainRecord, VaultRecord } from './storage.ts';
import { getLocal, setLocal } from './storage.ts';
import { beginSession, requireUnlocked } from './session.ts';
import { INVALID_PARAMS, ProviderError, UNAUTHORIZED } from '../shared/errors.ts';

/**
 * The extension's entropy source.
 *
 * `crypto.getRandomValues` is present in an MV3 service worker unconditionally — it is part of the
 * worker global scope, not a DOM API — so there is no fallback branch here and there must never be
 * one. If it were ever absent the right behaviour is to fail loudly, which is what the missing
 * `?.` produces.
 */
export const randomBytes = checkedRandomSource((length: number): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(length)));

const MIN_PASSWORD = 8;

function assertPassword(password: string): void {
  if (password.length < MIN_PASSWORD) {
    throw new ProviderError(INVALID_PARAMS, `The password must be at least ${MIN_PASSWORD} characters.`);
  }
}

/** A fresh 12-word phrase, never stored anywhere until the user has confirmed the backup. */
export function newMnemonic(words: 12 | 24 = 12): string {
  return generateMnemonic(words, randomBytes);
}

export interface CreatedVault {
  readonly address: string;
  readonly accounts: readonly AccountRecord[];
}

/**
 * Seal a phrase into the vault and derive the first account.
 *
 * Used by both "create" and "restore" — they differ only in where the phrase came from, and a
 * restore that took a different code path would be a restore that had never been exercised by the
 * create tests.
 */
export async function createVault(mnemonic: string, password: string): Promise<CreatedVault> {
  assertPassword(password);
  if (!validateMnemonic(mnemonic)) {
    throw new ProviderError(INVALID_PARAMS, 'That is not a valid recovery phrase — check the spelling and the word order.');
  }
  const normalised = mnemonic.trim().split(/\s+/).join(' ');
  const first = accountFromMnemonic(normalised, 0);
  const record = sealMnemonic(normalised, password, first.address, randomBytes, { created: Date.now() });
  wipe(first.privateKey);

  const accounts: AccountRecord[] = [{
    address: first.address,
    label: 'Account 1',
    index: 0,
    source: 'derived',
  }];
  await setLocal('vault', record as VaultRecord);
  await setLocal('accounts', accounts);
  const settings = await getLocal('settings');
  await setLocal('settings', { ...settings, selectedAddress: first.address, onboarded: true });
  await beginSession(normalised, {});
  return { address: first.address, accounts };
}

export async function unlockVault(password: string): Promise<void> {
  const vault = await getLocal('vault');
  if (vault === null) throw new ProviderError(UNAUTHORIZED, 'There is no wallet on this device yet.');
  let mnemonic: string;
  try {
    mnemonic = openMnemonic(vault as unknown as MnemonicKeystoreRecord, password);
  } catch {
    // Deliberately does not distinguish "wrong password" from "corrupt vault": the two are
    // indistinguishable to AES-GCM anyway, and a message that told them apart would be an oracle.
    throw new ProviderError(UNAUTHORIZED, 'Wrong password.');
  }
  // Imported raw keys are sealed under the same password. They are opened once, here, so that
  // signing with one costs no second 600,000-iteration derivation.
  const accounts = await getLocal('accounts');
  const importedKeys: Record<string, string> = {};
  for (const account of accounts) {
    if (account.source !== 'imported' || account.sealed === undefined) continue;
    const key = openKeystore(account.sealed as unknown as KeystoreRecord, password);
    importedKeys[account.address.toLowerCase()] = toHex(key);
    wipe(key);
  }
  await beginSession(mnemonic, importedKeys);
}

/** The next account on the same seed. §5: "derive multiple accounts from one seed". */
export async function deriveNextAccount(label?: string): Promise<AccountRecord> {
  const { mnemonic } = await requireUnlocked();
  const accounts = await getLocal('accounts');
  const used = accounts.filter((a) => a.index !== null).map((a) => a.index as number);
  const index = used.length === 0 ? 0 : Math.max(...used) + 1;
  const master = masterFromMnemonic(mnemonic);
  const derived = deriveAccount(master, index);
  wipe(derived.privateKey);
  const record: AccountRecord = {
    address: derived.address,
    label: label ?? `Account ${index + 1}`,
    index,
    source: 'derived',
  };
  await setLocal('accounts', [...accounts, record]);
  return record;
}

/** §5: "import a raw key or a keystore file". */
export async function importPrivateKey(hex: string, password: string, label?: string): Promise<AccountRecord> {
  await requireUnlocked();
  let key: Uint8Array;
  try {
    key = fromHex(hex.trim().startsWith('0x') ? hex.trim() : `0x${hex.trim()}`);
  } catch {
    throw new ProviderError(INVALID_PARAMS, 'That is not a private key — it should be 64 hexadecimal characters.');
  }
  if (key.length !== 32) {
    wipe(key);
    throw new ProviderError(INVALID_PARAMS, 'That is not a private key — it should be 64 hexadecimal characters.');
  }
  const address = addressFromPrivateKey(key);
  const accounts = await getLocal('accounts');
  if (accounts.some((a) => a.address.toLowerCase() === address.toLowerCase())) {
    wipe(key);
    throw new ProviderError(INVALID_PARAMS, 'This wallet already holds that account.');
  }
  const sealed = sealKey(key, password, randomBytes, { created: Date.now() });
  wipe(key);
  const record: AccountRecord = {
    address,
    label: label ?? `Imported ${accounts.filter((a) => a.source === 'imported').length + 1}`,
    index: null,
    source: 'imported',
    sealed: sealed as VaultRecord,
  };
  await setLocal('accounts', [...accounts, record]);
  // Re-unlock so the new key joins the session without asking for the password twice.
  await unlockVault(password);
  return record;
}

export async function importKeystore(json: string, keystorePassword: string, walletPassword: string, label?: string): Promise<AccountRecord> {
  let record: KeystoreRecord;
  try {
    record = JSON.parse(json) as KeystoreRecord;
  } catch {
    throw new ProviderError(INVALID_PARAMS, 'That file is not JSON.');
  }
  let key: Uint8Array;
  try {
    key = openKeystore(record, keystorePassword);
  } catch (cause) {
    throw new ProviderError(INVALID_PARAMS, cause instanceof Error ? cause.message : 'That keystore could not be opened.');
  }
  const hex = toHex(key);
  wipe(key);
  return importPrivateKey(hex, walletPassword, label);
}

/** §5: watch-only addresses. No key, and every signing path refuses them by name. */
export async function addWatchOnly(address: string, label?: string): Promise<AccountRecord> {
  let checksummed: Address;
  try {
    checksummed = toChecksumAddress(address.trim());
  } catch {
    throw new ProviderError(INVALID_PARAMS, 'That is not an address.');
  }
  const accounts = await getLocal('accounts');
  if (accounts.some((a) => a.address.toLowerCase() === checksummed.toLowerCase())) {
    throw new ProviderError(INVALID_PARAMS, 'This wallet already holds that account.');
  }
  const record: AccountRecord = { address: checksummed, label: label ?? 'Watching', index: null, source: 'watch-only' };
  await setLocal('accounts', [...accounts, record]);
  return record;
}

/**
 * The private key for an address, for the duration of one signature.
 *
 * Returns a fresh Uint8Array the caller must `wipe()`. It is not cached, not memoised and not
 * returned inside a signer object — deriving it costs one BIP-32 walk, and the alternative is a key
 * living somewhere no caller can clear (the core's bip44.ts makes the same argument).
 */
async function privateKeyFor(address: string): Promise<Uint8Array> {
  const session = await requireUnlocked();
  const accounts = await getLocal('accounts');
  const account = accounts.find((a) => a.address.toLowerCase() === address.toLowerCase());
  if (account === undefined) {
    throw new ProviderError(UNAUTHORIZED, `This wallet does not hold ${address}.`);
  }
  if (account.source === 'watch-only') {
    throw new ProviderError(UNAUTHORIZED, `${account.label} is a watch-only account — this wallet has no key for it and cannot sign.`);
  }
  if (account.source === 'imported') {
    const hex = session.importedKeys[address.toLowerCase()];
    if (hex === undefined) throw new ProviderError(UNAUTHORIZED, 'That imported key is not in this session — lock and unlock the wallet.');
    return fromHex(hex);
  }
  const master = masterFromMnemonic(session.mnemonic);
  const derived = deriveAccount(master, account.index ?? 0);
  return derived.privateKey;
}

export async function signTx(from: string, request: TransactionRequest, chain: ChainRecord): Promise<string> {
  const key = await privateKeyFor(from);
  try {
    const signed = signTransaction(request, key, {
      id: chain.id,
      name: chain.name,
      network: chain.name,
      currency: chain.currency,
      supportsEip1559: chain.supportsEip1559,
    });
    return signed.raw;
  } finally {
    wipe(key);
  }
}

export async function signMessage(from: string, message: Uint8Array | string): Promise<string> {
  const key = await privateKeyFor(from);
  try {
    return signPersonalMessage(message, key);
  } finally {
    wipe(key);
  }
}

export async function signTyped(from: string, payload: TypedDataPayload): Promise<string> {
  const key = await privateKeyFor(from);
  try {
    return signTypedData(payload, key);
  } finally {
    wipe(key);
  }
}

/**
 * The phrase, for the reveal flow.
 *
 * Takes the password AGAIN even though the wallet is already unlocked, and that is the whole point
 * of §5's "duress-resistant reveal flow that does not put the phrase on screen in one tap". An
 * unlocked wallet left on a desk must not surrender its seed to whoever walks past it, and the UI
 * adds the second and third steps: a warning that has to be read, and a hold-to-reveal.
 */
export async function revealMnemonic(password: string): Promise<string> {
  const vault = await getLocal('vault');
  if (vault === null) throw new ProviderError(UNAUTHORIZED, 'There is no wallet on this device yet.');
  try {
    return openMnemonic(vault as unknown as MnemonicKeystoreRecord, password);
  } catch {
    throw new ProviderError(UNAUTHORIZED, 'Wrong password.');
  }
}

export { toHex, fromHex };
