/* EIP-1193 and EIP-1474 error codes, and the one rule about them.
 *
 * A dapp branches on `error.code`. If this wallet invents its own numbers, every dapp's "the user
 * rejected it" path stops firing and the dapp shows a spinner forever instead of a retry button —
 * which looks to the user like the WALLET hanging. So the codes below are the standard ones and
 * nothing else is ever thrown across the provider boundary.
 */

/** EIP-1193 provider errors. */
export const USER_REJECTED = 4001;
export const UNAUTHORIZED = 4100;
export const UNSUPPORTED_METHOD = 4200;
export const DISCONNECTED = 4900;
export const CHAIN_DISCONNECTED = 4901;

/** EIP-3085 / EIP-3326: the chain is not one this wallet knows. */
export const UNRECOGNISED_CHAIN = 4902;

/** EIP-1474 RPC errors. */
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const INVALID_INPUT = -32000;

export interface SerialisedProviderError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export class ProviderError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.data = data;
  }

  /**
   * Structured-clone-safe, because this crosses `postMessage` twice.
   *
   * An `Error` does NOT survive `postMessage` — the structured clone algorithm preserves the
   * message and drops every own property, so `code` arrives as `undefined` and the dapp's
   * `if (e.code === 4001)` silently stops matching. Everything on the wire is a plain object and
   * is rebuilt into an Error only at the very last step, inside the page.
   */
  toJSON(): SerialisedProviderError {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

export function userRejected(what: string): ProviderError {
  return new ProviderError(USER_REJECTED, `The user rejected the ${what}.`);
}

/** Rebuild an Error from the wire form, preserving `code` and `data` as own properties. */
export function reviveProviderError(e: SerialisedProviderError): Error & SerialisedProviderError {
  const err = new Error(e.message) as Error & { code: number; data?: unknown };
  err.code = e.code;
  if (e.data !== undefined) err.data = e.data;
  return err as Error & SerialisedProviderError;
}

export function isSerialisedProviderError(value: unknown): value is SerialisedProviderError {
  return typeof value === 'object' && value !== null
    && typeof (value as { code?: unknown }).code === 'number'
    && typeof (value as { message?: unknown }).message === 'string';
}

/** Anything thrown inside the worker, reduced to something a dapp can branch on. */
export function toProviderError(cause: unknown): SerialisedProviderError {
  if (cause instanceof ProviderError) return cause.toJSON();
  if (isSerialisedProviderError(cause)) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return { code: INTERNAL_ERROR, message };
}
