/* ABI encoding and decoding, for the two calls this wallet makes into contracts.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * THIS IS NOT CRYPTOGRAPHY AND IT DOES NOT DO ANY.
 *
 * 25-wallet-clients.md §3 puts every cryptographic operation in @cloudsforge/hearth-wallet-core, and
 * this file obeys that: the only hashing here is `keccak256`, imported from the core, used to turn a
 * signature string into a four-byte selector. What is left is byte layout — left-pad a word,
 * right-pad a tail, write an offset — which is a data format, not a primitive. shared/decode.ts has
 * done the DECODE half of exactly this since phase 2; this file is its encode half plus the return
 * -value readers, in one place so there is one implementation rather than two.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * THE TYPE SET IS CLOSED, DELIBERATELY. Eight types, because eight is what the ForesightMarket
 * views and the three micro-mint constructors between them use. A general ABI coder would be a
 * large amount of surface — arrays, tuples, dynamic nesting, the packed/standard distinction —
 * serving call sites that can be counted on two hands, and every unused branch of it would be
 * untested code sitting on the path where a wrong answer sends money to the wrong place.
 * micro-mint's own encoder says the same thing about the same problem (`mint/src/evm.ts`)
 * and supports five types; this one supports eight because it also reads values back.
 *
 * NO `Buffer`, NO `node:` ANYTHING. mint's encoder is Buffer-based because it runs in Node; this
 * one runs in an MV3 service worker, and tools/build.js fails the build over a Node built-in
 * reaching the bundle. Uint8Array throughout.
 */

import { keccak256, toChecksumAddress, toHex } from '@cloudsforge/hearth-wallet-core';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

export const WORD = 32;

/** The first four bytes of keccak256 of the canonical signature, as `0x…`. */
export function selectorOf(signature: string): string {
  return toHex(keccak256(encoder.encode(signature)).subarray(0, 4));
}

export type AbiType =
  | 'string' | 'address' | 'bool' | 'bytes32'
  | 'uint8' | 'uint16' | 'uint64' | 'uint256';

export interface AbiValue {
  readonly type: AbiType;
  readonly value: string | bigint | boolean;
}

export class AbiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbiError';
  }
}

const UINT_BITS: Readonly<Record<string, bigint>> = Object.freeze({
  uint8: 8n, uint16: 16n, uint64: 64n, uint256: 256n,
});

const HEX_BODY = /^[0-9a-fA-F]*$/;

/** `0x…` or bare hex to bytes. Throws rather than returning a short read. */
export function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (body.length % 2 !== 0 || !HEX_BODY.test(body)) {
    throw new AbiError(`not a hex string: ${JSON.stringify(hex.slice(0, 24))}`);
  }
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function wordOf(value: bigint): Uint8Array {
  const word = new Uint8Array(WORD);
  let rest = value;
  for (let i = WORD - 1; i >= 0 && rest > 0n; i -= 1) {
    word[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  if (rest !== 0n) throw new AbiError('abi word overflow');
  return word;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/**
 * Encode a positional argument list, head-and-tail.
 *
 * Static types occupy one word in the head. `string` is dynamic: its head slot holds the offset —
 * measured from the START OF THE ARGUMENT BLOCK, not from the start of the transaction data — to a
 * tail of one length word followed by the UTF-8 bytes padded up to a word boundary. Getting that
 * base wrong is the classic ABI bug and it produces a constructor that reads a name out of the
 * middle of a number.
 */
export function encodeArgs(args: readonly AbiValue[]): Uint8Array {
  const heads: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  let tailOffset = args.length * WORD;

  for (const arg of args) {
    switch (arg.type) {
      case 'string': {
        if (typeof arg.value !== 'string') throw new AbiError('a string argument must be a string');
        const bytes = encoder.encode(arg.value);
        const padded = new Uint8Array(Math.ceil(bytes.length / WORD) * WORD);
        padded.set(bytes);
        const tail = concat([wordOf(BigInt(bytes.length)), padded]);
        heads.push(wordOf(BigInt(tailOffset)));
        tails.push(tail);
        tailOffset += tail.length;
        break;
      }
      case 'address': {
        if (typeof arg.value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(arg.value)) {
          throw new AbiError('an address argument must be 0x followed by 40 hex characters');
        }
        const word = new Uint8Array(WORD);
        word.set(hexToBytes(arg.value), 12);
        heads.push(word);
        break;
      }
      case 'bytes32': {
        if (typeof arg.value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(arg.value)) {
          throw new AbiError('a bytes32 argument must be 0x followed by 64 hex characters');
        }
        heads.push(hexToBytes(arg.value));
        break;
      }
      case 'bool': {
        if (typeof arg.value !== 'boolean') throw new AbiError('a bool argument must be a boolean');
        heads.push(wordOf(arg.value ? 1n : 0n));
        break;
      }
      default: {
        // The unsigned integers. THE BOUND IS CHECKED RATHER THAN TRUNCATED — a supply silently
        // reduced mod 2^256, or a `decimals` of 258 arriving as 2, is a token whose numbers are not
        // the ones the user asked for and nothing downstream can tell.
        if (typeof arg.value !== 'bigint') throw new AbiError(`a ${arg.type} argument must be a bigint`);
        if (arg.value < 0n) throw new AbiError(`a ${arg.type} argument must not be negative`);
        const bits = UINT_BITS[arg.type];
        if (bits === undefined) throw new AbiError(`unsupported abi type ${String(arg.type)}`);
        if (arg.value >= 1n << bits) throw new AbiError(`${arg.type} argument ${arg.value} is out of range`);
        heads.push(wordOf(arg.value));
      }
    }
  }
  return concat([...heads, ...tails]);
}

/** `0x` + selector + encoded arguments: the `data` field of a call. */
export function encodeCall(signature: string, args: readonly AbiValue[] = []): string {
  return `${selectorOf(signature)}${toHex(encodeArgs(args)).slice(2)}`;
}

/** Creation bytecode with the constructor arguments appended: the `data` field of a deployment. */
export function encodeDeployment(bytecode: string, args: readonly AbiValue[]): string {
  const code = hexToBytes(bytecode);
  if (code.length === 0) throw new AbiError('the creation bytecode is empty');
  return toHex(concat([code, encodeArgs(args)]));
}

/* ------------------------------------------------------------------------------ reading back -- */

/**
 * A node's `eth_call` return value, split into 32-byte words.
 *
 * §7: RPC responses are hostile input. A short return is an error here rather than a zero — a node
 * that answers `stakeOf` with `0x` must not produce "you have no position" on a screen somebody is
 * about to act on. That is exactly the difference between "the chain says you hold nothing" and
 * "this endpoint did not answer", and only one of them means stop worrying.
 */
export class Return {
  readonly words: readonly Uint8Array[];
  readonly bytes: Uint8Array;

  constructor(hex: unknown, what: string) {
    if (typeof hex !== 'string') throw new AbiError(`${what}: the node returned ${JSON.stringify(hex)}, not hex`);
    let bytes: Uint8Array;
    try {
      bytes = hexToBytes(hex);
    } catch {
      throw new AbiError(`${what}: the node returned ${JSON.stringify(hex.slice(0, 32))}, which is not hex`);
    }
    if (bytes.length === 0) {
      // The single most common way this happens: the address holds no code at all, so the EVM
      // returns success with an empty buffer and every naive reader shows zero.
      throw new AbiError(`${what}: the call returned nothing. There is probably no contract at that address on this chain.`);
    }
    this.bytes = bytes;
    const words: Uint8Array[] = [];
    for (let i = 0; i + WORD <= bytes.length; i += WORD) words.push(bytes.subarray(i, i + WORD));
    this.words = words;
  }

  private word(index: number, what: string): Uint8Array {
    const word = this.words[index];
    if (word === undefined) {
      throw new AbiError(`${what}: the node returned ${this.words.length} word(s), and word ${index} was wanted`);
    }
    return word;
  }

  uint(index: number, what: string): bigint {
    let value = 0n;
    for (const byte of this.word(index, what)) value = (value << 8n) | BigInt(byte);
    return value;
  }

  /** A `uintN` return, checked against N. A node claiming `status() == 900` is not answering. */
  small(index: number, bits: 8 | 16 | 64, what: string): number {
    const value = this.uint(index, what);
    if (value >= 1n << BigInt(bits)) {
      throw new AbiError(`${what}: ${value} does not fit in uint${bits}, so this is not that contract`);
    }
    return Number(value);
  }

  bool(index: number, what: string): boolean {
    const value = this.uint(index, what);
    if (value > 1n) throw new AbiError(`${what}: a bool came back as ${value}`);
    return value === 1n;
  }

  address(index: number, what: string): string {
    const word = this.word(index, what);
    // The high 12 bytes MUST be zero — the same rule shared/decode.ts applies to arguments, for the
    // same reason: a reader that masks silently shows a different address from the one the EVM used.
    for (let i = 0; i < 12; i += 1) {
      if (word[i] !== 0) throw new AbiError(`${what}: an address came back with dirty high bytes`);
    }
    return toChecksumAddress(toHex(word.subarray(12)));
  }

  bytes32(index: number, what: string): string {
    return toHex(this.word(index, what));
  }

  /**
   * A `string` return — with the bytes32 case handled, because it is not hypothetical.
   *
   * ERC-20 predates the final standard's `string` return by long enough that a large population of
   * live tokens — MKR is the famous one — declare `symbol()` as `bytes32`. Those return exactly one
   * word with no offset and no length, and a reader that assumes the dynamic layout reads the
   * symbol's own bytes as an offset and lands somewhere absurd. So: exactly 32 bytes is read as a
   * NUL-padded bytes32, and anything else as the standard offset/length/body.
   */
  string(what: string): string {
    if (this.bytes.length === WORD) {
      let end = WORD;
      while (end > 0 && this.bytes[end - 1] === 0) end -= 1;
      return decoder.decode(this.bytes.subarray(0, end));
    }
    const offset = Number(this.uint(0, what));
    if (!Number.isSafeInteger(offset) || offset + WORD > this.bytes.length) {
      throw new AbiError(`${what}: the string offset ${offset} points outside a ${this.bytes.length}-byte answer`);
    }
    let length = 0n;
    for (const byte of this.bytes.subarray(offset, offset + WORD)) length = (length << 8n) | BigInt(byte);
    const end = offset + WORD + Number(length);
    if (!Number.isSafeInteger(Number(length)) || end > this.bytes.length) {
      throw new AbiError(`${what}: the string claims ${length} bytes but only ${this.bytes.length - offset - WORD} follow`);
    }
    return decoder.decode(this.bytes.subarray(offset + WORD, end));
  }
}
