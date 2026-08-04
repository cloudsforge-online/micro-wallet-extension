/* How an extension page talks to the worker.
 *
 * `chrome.runtime.sendMessage` rather than a port, and the reason is the approval window: it asks
 * one question, gets one answer and then closes itself. A port would disconnect as the window
 * unloads, which races with the reply and produces the "the answer never arrived" bug in the one
 * flow where the answer is a signed transaction.
 *
 * Every call may wake a terminated worker. That is invisible here and it is meant to be — the
 * worker rebuilds its whole world from storage before it answers (background/storage.ts), so a
 * page never needs to know whether it was talking to a fresh one.
 */

import type { WorkerMessage } from '../shared/protocol.ts';
import { reviveProviderError, type SerialisedProviderError } from '../shared/errors.ts';

let sequence = 0;

export async function call<T = unknown>(action: string, payload: unknown = {}): Promise<T> {
  const message: WorkerMessage = { kind: 'ui', id: `ui-${(sequence += 1)}`, action, payload };
  const response = await chrome.runtime.sendMessage(message) as
    | { ok: true; result: T }
    | { ok: false; error: SerialisedProviderError }
    | undefined;
  if (response === undefined) {
    // The worker did not answer at all: it was stopped mid-flight, or a listener forgot to return
    // `true`. Surfaced rather than swallowed, because the alternative is a button that does nothing.
    throw new Error('The wallet did not answer. Close this window and try again.');
  }
  if (!response.ok) throw reviveProviderError(response.error);
  return response.result;
}

export interface AccountRecordView {
  address: string;
  label: string;
  index: number | null;
  source: 'derived' | 'imported' | 'watch-only';
}

export interface ChainRecordView {
  id: number;
  name: string;
  rpcUrl: string;
  currency: { name: string; symbol: string; decimals: number };
  explorerUrl: string | null;
  supportsEip1559: boolean;
  addedByDapp: boolean;
}

export interface WalletState {
  hasVault: boolean;
  unlocked: boolean;
  accounts: AccountRecordView[];
  settings: {
    selectedChainId: number;
    selectedAddress: string | null;
    autoLockMinutes: number;
    seedBackedUp: boolean;
    onboarded: boolean;
  };
  chains: ChainRecordView[];
  permissions: { origin: string; accounts: string[]; grantedAt: number }[];
  pending: { id: string; origin: string; method: string; createdAt: number }[];
}

export const getState = (): Promise<WalletState> => call<WalletState>('state');
