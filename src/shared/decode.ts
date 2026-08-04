/* Decoding the call, because "0xa9059cbb000000…" is not consent.
 *
 * 25-wallet-clients.md §5: "a transaction preview that DECODES THE CALL rather than showing a hex
 * blob. Unlimited-approval warnings … because approvals are how people actually lose money."
 *
 * TWO THINGS THIS FILE REFUSES TO DO.
 *
 * 1. It does not hardcode selectors. Every four-byte selector below is computed at module load
 *    from its signature with the core's own keccak256. A hardcoded `0xa9059cbb` is a magic number
 *    nobody can check by reading, and a typo in one produces a screen that confidently decodes a
 *    transfer as something else. Computing it means the signature string IS the check.
 *
 * 2. It does not guess. A selector that is not in the table decodes to `unknown` and the UI says
 *    so, showing the raw bytes and a caution. A decoder that renders an unrecognised call as
 *    "Contract interaction" with a friendly icon has told the user it understood something it did
 *    not, which is the failure mode the whole feature exists to prevent.
 *
 * There is no ABI fetching and no 4byte.directory lookup. Both are network calls that leak the
 * contract a user is about to interact with to a third party, and §7 says analytics see nothing.
 */

import { toChecksumAddress, toHex } from '@cloudsforge/hearth-wallet-core';
import type { DecodedCall, Warning } from './protocol.ts';
import { formatUnits } from './units.ts';
// One implementation of selector derivation, in shared/abi.ts, which is also the encode half of the
// byte layout this file decodes. Two copies of "the first four bytes of keccak256 of the signature"
// is two chances to get one of them subtly wrong, and the symptom would be a screen that decodes
// a call the wallet then encodes differently.
import { selectorOf } from './abi.ts';

export { selectorOf };

/**
 * The maximum uint256.
 *
 * An approval of this value is the "unlimited approval" every drainer asks for: it lets the spender
 * move the user's entire balance of that token, now and for every token they ever acquire, until
 * it is revoked. It is also what most dapps request by default, which is why the warning has to be
 * loud rather than merely present.
 */
const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * The threshold at or above which an approval is treated as unlimited.
 *
 * NOT `=== MAX_UINT256`, and the reason is concrete rather than defensive. Tokens that store
 * allowances in a `uint96` — COMP and UNI are the well-known ones — cannot represent `2**256 - 1`
 * at all; for them the unlimited sentinel IS `type(uint96).max`, and a wallet checking for equality
 * with `MAX_UINT256` shows no warning whatsoever on the approval that gives away everything. Other
 * contracts use `2**255`. So the test is a threshold, and it is set at `2**96 - 1`.
 *
 * THIS ERRS TOWARDS WARNING, DELIBERATELY. `2**96 - 1` wei of an 18-decimal token is about 7.9e10
 * tokens, so an approval of more than seventy-nine billion units of a genuinely high-supply token
 * is called unlimited when it is technically bounded. That is the right direction for this
 * particular error to point: the cost of the false positive is a user reading one more warning,
 * and the cost of the false negative is the wallet.
 */
const EFFECTIVELY_UNLIMITED = (1n << 96n) - 1n;

const SIGNATURES = {
  erc20Transfer: 'transfer(address,uint256)',
  erc20TransferFrom: 'transferFrom(address,address,uint256)',
  erc20Approve: 'approve(address,uint256)',
  erc721SetApprovalForAll: 'setApprovalForAll(address,bool)',
  erc721SafeTransferFrom: 'safeTransferFrom(address,address,uint256)',
  erc1155SetApprovalForAll: 'setApprovalForAll(address,bool)',
  foresightStake: 'stake(uint8)',
  foresightClaim: 'claim()',
} as const;

/** signature -> selector, computed once. Exported so a test can assert the known values. */
export const SELECTORS: Readonly<Record<keyof typeof SIGNATURES, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(SIGNATURES).map(([name, sig]) => [name, selectorOf(sig)]),
  ) as Record<keyof typeof SIGNATURES, string>,
);

function words(data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 4; i + 32 <= data.length; i += 32) out.push(data.subarray(i, i + 32));
  return out;
}

function wordToBigInt(word: Uint8Array | undefined): bigint {
  if (word === undefined) throw new Error('decode: the call data ends before this argument');
  let value = 0n;
  for (const byte of word) value = (value << 8n) | BigInt(byte);
  return value;
}

/**
 * The address in an ABI word.
 *
 * The high 12 bytes MUST be zero. A non-zero prefix means either the caller mis-encoded, or
 * somebody is relying on the reader to ignore the top of the word while the EVM masks it — and a
 * preview that silently masks would show a different address from the one that ends up in the log.
 */
function wordToAddress(word: Uint8Array | undefined): string {
  if (word === undefined) throw new Error('decode: the call data ends before this address');
  for (let i = 0; i < 12; i += 1) {
    if (word[i] !== 0) throw new Error('decode: an address argument has dirty high bytes');
  }
  return toChecksumAddress(toHex(word.subarray(12)));
}

function hexToBytes(data: string): Uint8Array {
  const body = data.startsWith('0x') ? data.slice(2) : data;
  if (body.length % 2 !== 0 || /[^0-9a-fA-F]/.test(body)) throw new Error('decode: data is not hex');
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export interface DecodeInput {
  readonly to: string | null;
  readonly data: string;
  readonly valueWei: bigint;
  /** Decimals to render a token amount with. 18 unless the token has been looked up. */
  readonly tokenDecimals?: number;
}

/**
 * Decode a transaction into something a confirmation screen can state as a sentence.
 *
 * NOTHING HERE THROWS OUT TO THE CALLER. A malformed call is a decode of `unknown`, not an
 * exception — because the alternative is an approval window that fails to open, leaving the dapp
 * hanging and the user with no way to reject. Refusing to render is not safer than rendering "this
 * wallet could not read this call".
 */
export function decodeCall(input: DecodeInput): DecodedCall {
  const decimals = input.tokenDecimals ?? 18;

  if (input.to === null) {
    return { kind: 'deploy', bytes: Math.max(0, (input.data.length - 2) / 2) };
  }
  if (input.data === '' || input.data === '0x') {
    return { kind: 'transfer-native', to: toChecksumAddress(input.to), amountWei: input.valueWei.toString() };
  }

  let data: Uint8Array;
  try {
    data = hexToBytes(input.data);
  } catch {
    return { kind: 'unknown', selector: '0x', bytes: 0 };
  }
  if (data.length < 4) return { kind: 'unknown', selector: toHex(data), bytes: data.length };

  const selector = toHex(data.subarray(0, 4));
  const token = toChecksumAddress(input.to);
  const argv = words(data);

  try {
    if (selector === SELECTORS.erc20Transfer) {
      return {
        kind: 'erc20-transfer',
        token,
        to: wordToAddress(argv[0]),
        amount: formatUnits(wordToBigInt(argv[1]), decimals),
      };
    }
    if (selector === SELECTORS.erc20Approve) {
      const raw = wordToBigInt(argv[1]);
      return {
        kind: 'erc20-approve',
        token,
        spender: wordToAddress(argv[0]),
        amount: raw >= EFFECTIVELY_UNLIMITED ? raw.toString() : formatUnits(raw, decimals),
        unlimited: raw >= EFFECTIVELY_UNLIMITED,
      };
    }
    // ERC-721 and ERC-1155 share this selector exactly — same name, same argument types — so the
    // decode cannot and does not claim which standard the contract implements.
    if (selector === SELECTORS.erc721SetApprovalForAll) {
      return {
        kind: 'erc721-approve-all',
        token,
        operator: wordToAddress(argv[0]),
        approved: wordToBigInt(argv[1]) !== 0n,
      };
    }
    if (selector === SELECTORS.erc20TransferFrom) {
      return {
        kind: 'known',
        signature: SIGNATURES.erc20TransferFrom,
        args: [
          { name: 'from', type: 'address', value: wordToAddress(argv[0]) },
          { name: 'to', type: 'address', value: wordToAddress(argv[1]) },
          { name: 'amount', type: 'uint256', value: formatUnits(wordToBigInt(argv[2]), decimals) },
        ],
      };
    }
    if (selector === SELECTORS.foresightStake) {
      return {
        kind: 'known',
        signature: SIGNATURES.foresightStake,
        args: [{ name: 'outcome', type: 'uint8', value: wordToBigInt(argv[0]).toString() }],
      };
    }
    if (selector === SELECTORS.foresightClaim) {
      return { kind: 'known', signature: SIGNATURES.foresightClaim, args: [] };
    }
  } catch {
    // Fall through to `unknown`: the selector matched but the arguments did not parse, which is
    // more suspicious than an unrecognised call, not less. The caller's warning rules see this.
    return { kind: 'unknown', selector, bytes: data.length };
  }

  return { kind: 'unknown', selector, bytes: data.length };
}

/**
 * The warnings that belong on the confirmation screen.
 *
 * Ordered danger-first, and the caller renders them ABOVE the amount rather than below it. A
 * warning under the fold is a warning that was not shown.
 */
export function warningsFor(decoded: DecodedCall, valueWei: bigint): readonly Warning[] {
  const out: Warning[] = [];

  if (decoded.kind === 'erc20-approve' && decoded.unlimited) {
    out.push({
      severity: 'danger',
      title: 'Unlimited spending approval',
      detail: `${decoded.spender} would be able to move this token out of your account, in any amount, at any time in the future, until you revoke it. Approve a specific amount instead unless you know exactly why this is needed.`,
    });
  }
  if (decoded.kind === 'erc20-approve' && !decoded.unlimited && decoded.amount !== '0') {
    out.push({
      severity: 'caution',
      title: 'Spending approval',
      detail: `${decoded.spender} would be able to move up to ${decoded.amount} of this token without asking again.`,
    });
  }
  if (decoded.kind === 'erc721-approve-all' && decoded.approved) {
    out.push({
      severity: 'danger',
      title: 'Approval for every item in this collection',
      detail: `${decoded.operator} would be able to transfer any item you hold in this collection, including ones you buy later.`,
    });
  }
  if (decoded.kind === 'deploy') {
    out.push({
      severity: 'caution',
      title: 'This deploys a contract',
      detail: `${decoded.bytes} bytes of code, to an address that does not exist yet. Nothing here can tell you what that code does.`,
    });
  }
  if (decoded.kind === 'unknown') {
    out.push({
      severity: 'caution',
      title: 'This wallet could not read this call',
      detail: `The selector is ${decoded.selector} and the call is ${decoded.bytes} bytes. This wallet is not guessing at what it does — if you did not expect this, reject it.`,
    });
  }
  if (valueWei > 0n && decoded.kind !== 'transfer-native') {
    out.push({
      severity: 'caution',
      title: 'This call also sends EMBER',
      detail: `${formatUnits(valueWei, 18)} EMBER leaves your account on top of whatever the call itself does.`,
    });
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'danger' ? -1 : 1));
}

export { MAX_UINT256, EFFECTIVELY_UNLIMITED };
