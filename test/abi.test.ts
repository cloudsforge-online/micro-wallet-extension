/* The ABI coder, held against micro-mint's own encoder rather than against my arithmetic.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * THIS SUITE HAS AN ORACLE, AND THAT IS THE ONLY REASON IT IS WORTH ANYTHING.
 *
 * A test that asserts `encodeArgs(x) === '0x0000…'` against a literal I produced by running
 * `encodeArgs(x)` proves that the function is deterministic and nothing else. It would go green on
 * an encoder that pads on the wrong side, as long as it did so consistently.
 *
 * So the head-and-tail vectors below are checked against `mint/src/evm.ts`'s
 * `encodeConstructorArgs` — a SEPARATE implementation, written for Node against `Buffer`, which is
 * the one that has been deploying real tokens on this chain. Two independent implementations
 * agreeing byte for byte is evidence; one implementation agreeing with itself is not. It is the
 * same arrangement the signing core has with `hearth/node` (§3.1) and the same reason.
 *
 * micro-mint is PUBLIC, so CI checks it out with no secret. When it is absent this FAILS with a
 * message naming what to clone; it does not skip. A guard that goes green because its oracle is
 * missing has never checked anything.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { describe } from 'node:test';

import { keccak256, toHex, utf8ToBytes } from '@cloudsforge/hearth-wallet-core';

import {
  AbiError, encodeArgs, encodeCall, encodeDeployment, hexToBytes, Return, selectorOf, type AbiValue,
} from '../src/shared/abi.ts';

const here = dirname(fileURLToPath(import.meta.url));
const MINT_SRC = process.env['MINT_SRC'] ?? resolve(here, '..', '..', 'mint', 'src');
const MINT_EVM = join(MINT_SRC, 'evm.ts');

if (!existsSync(MINT_EVM)) {
  throw new Error(
    `The ABI suite is checked against micro-mint's own encoder and cannot find it at ${MINT_EVM}.\n`
    + 'micro-mint is a PUBLIC repository — clone it beside this checkout as `mint`, or set MINT_SRC.\n'
    + 'This suite does not skip when its oracle is absent: a differential test with one side missing is not a test.',
  );
}

/**
 * Load micro-mint's encoder with its two imports shimmed, and PROVE nothing else was touched.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY A SHIM AT ALL. `mint/src/evm.ts` imports exactly two things: `keccak256` from a self-contained
 * `./keccak.ts`, and `ChainError` from `./chains.ts` — and `chains.ts` pulls
 * `@cloudsforge/contracts-chain`, a package that lives in micro-mint's node_modules. On this laptop
 * that resolves, because the sibling checkout has its dependencies installed. IN CI IT DOES NOT,
 * and the first run of this suite failed with ERR_MODULE_NOT_FOUND on a package that has nothing to
 * do with ABI encoding. Installing micro-mint's tree to get it would need a registry token, and
 * this repository is deliberately public and secret-free.
 *
 * So the two import lines are rewritten — `keccak256` to an absolute path into micro-mint's own
 * file, `ChainError` to the six-line class copied from micro-mint's own `chains.ts` — and NOTHING
 * ELSE IS. The assertion below is what makes that a fact rather than an intention: the shimmed text
 * with the substitution reversed must be byte-identical to the file on disk. If a future edit here
 * ever touched the encoder itself, the oracle would have become a copy of the thing it checks, and
 * this stops that silently happening.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
function loadMintEncoder(): Promise<{
  encodeConstructorArgs: (args: readonly { type: string; value: unknown }[]) => Buffer;
  creationData: (bytecode: string, args: readonly { type: string; value: unknown }[]) => string;
}> {
  const original = readFileSync(MINT_EVM, 'utf8');

  const keccakFrom = "import { keccak256 } from './keccak.ts'";
  const chainFrom = "import { ChainError } from './chains.ts'";
  for (const line of [keccakFrom, chainFrom]) {
    assert.ok(original.includes(line), `micro-mint's evm.ts no longer contains \`${line}\`; the shim is stale`);
  }

  const keccakTo = `import { keccak256 } from ${JSON.stringify(pathToFileURL(join(MINT_SRC, 'keccak.ts')).href)}`;
  // Copied verbatim from mint/src/chains.ts.
  const chainTo = 'class ChainError extends Error {\n  constructor(message: string) {\n    super(message)\n    this.name = \'ChainError\'\n  }\n}';

  const shimmed = original.replace(keccakFrom, keccakTo).replace(chainFrom, chainTo);

  // THE PROOF: undo the substitution and the file must come back exactly.
  assert.equal(
    shimmed.replace(keccakTo, keccakFrom).replace(chainTo, chainFrom),
    original,
    'the shim changed something other than the two import lines — this oracle is no longer micro-mint\'s encoder',
  );

  const directory = mkdtempSync(join(tmpdir(), 'cf-mint-oracle-'));
  const file = join(directory, 'evm.ts');
  writeFileSync(file, shimmed);
  return import(pathToFileURL(file).href) as never;
}

const mint = await loadMintEncoder();

/** The types both encoders support. `uint16`, `uint64` and `bytes32` are ours alone and are
 *  checked against hand-derived layouts below instead. */
const SHARED: readonly AbiValue[][] = [
  [{ type: 'string', value: 'Ember Test Token' }],
  [{ type: 'string', value: '' }],
  // Exactly one word of UTF-8, which is the boundary where the padding branch changes behaviour.
  [{ type: 'string', value: 'x'.repeat(32) }],
  [{ type: 'string', value: 'x'.repeat(33) }],
  // Multi-byte UTF-8: the length is in BYTES, not characters, and an encoder that writes the
  // character count produces a string the EVM reads short.
  [{ type: 'string', value: 'Ember — Ember ✦ Ember' }],
  [{ type: 'uint8', value: 0n }],
  [{ type: 'uint8', value: 255n }],
  [{ type: 'uint256', value: 0n }],
  [{ type: 'uint256', value: (1n << 256n) - 1n }],
  [{ type: 'bool', value: true }],
  [{ type: 'bool', value: false }],
  [{ type: 'address', value: '0x9a2d854900ba6294bd94854c0e82710e96ce2325' }],
  // The real shapes: micro-mint's three constructors.
  [
    { type: 'string', value: 'Ember Test Token' },
    { type: 'string', value: 'ETT' },
    { type: 'uint8', value: 18n },
    { type: 'uint256', value: 1_000_000n * 10n ** 18n },
    { type: 'address', value: '0x9a2d854900ba6294bd94854c0e82710e96ce2325' },
  ],
  [
    { type: 'string', value: 'Foundry' },
    { type: 'string', value: 'FND' },
    { type: 'uint8', value: 6n },
    { type: 'uint256', value: 42n },
    { type: 'uint256', value: 10n ** 30n },
    { type: 'address', value: '0x000000000000000000000000000000000000dEaD' },
  ],
  // TWO dynamic arguments with static ones between them — the case where a wrong offset base
  // silently reads the second string out of the middle of the first.
  [
    { type: 'string', value: 'first' },
    { type: 'uint256', value: 7n },
    { type: 'string', value: 'second' },
  ],
];

describe('the ABI encoder agrees with micro-mint, byte for byte', () => {
  for (const [index, args] of SHARED.entries()) {
    test(`vector ${index}: (${args.map((a) => a.type).join(', ')})`, () => {
      const ours = toHex(encodeArgs(args));
      const theirs = `0x${mint.encodeConstructorArgs(args as never).toString('hex')}`;
      assert.equal(ours, theirs, `vector ${index} disagrees with mint/src/evm.ts`);
      // And the length is always a whole number of words. An encoder that is wrong by a nibble
      // produces call data the EVM reads shifted by four bits from that point on.
      assert.equal((ours.length - 2) % 64, 0, 'the encoding is not a whole number of 32-byte words');
    });
  }

  test('a whole creation payload matches mint, bytecode and arguments together', () => {
    const bytecode = '0x60806040523480156100';
    const args: AbiValue[] = [
      { type: 'string', value: 'Ember Test Token' },
      { type: 'string', value: 'ETT' },
      { type: 'uint8', value: 18n },
      { type: 'uint256', value: 10n ** 24n },
      { type: 'address', value: '0x9a2d854900ba6294bd94854c0e82710e96ce2325' },
    ];
    assert.equal(encodeDeployment(bytecode, args), mint.creationData(bytecode, args as never));
  });
});

describe('the selector is derived, never remembered', () => {
  test('it is the first four bytes of keccak256 of the signature', () => {
    // Recomputed here from the core's primitives rather than copied, so this asserts the DEFINITION
    // rather than agreeing with the implementation about a constant.
    for (const signature of ['transfer(address,uint256)', 'stake(uint8)', 'claim()', 'symbol()']) {
      assert.equal(selectorOf(signature), toHex(keccak256(utf8ToBytes(signature)).subarray(0, 4)));
    }
  });

  test('the well-known ERC-20 selectors come out right', () => {
    // The three every block explorer shows. If the derivation were wrong these would not match, and
    // they are the only values in this file worth hardcoding because the whole world publishes them.
    assert.equal(selectorOf('transfer(address,uint256)'), '0xa9059cbb');
    assert.equal(selectorOf('approve(address,uint256)'), '0x095ea7b3');
    assert.equal(selectorOf('balanceOf(address)'), '0x70a08231');
    assert.equal(selectorOf('totalSupply()'), '0x18160ddd');
  });

  test('encodeCall is the selector followed by the arguments and nothing else', () => {
    const data = encodeCall('stake(uint8)', [{ type: 'uint8', value: 1n }]);
    assert.equal(data.slice(0, 10), selectorOf('stake(uint8)'));
    assert.equal(data.length, 2 + 8 + 64);
    assert.equal(BigInt(`0x${data.slice(10)}`), 1n);
  });
});

describe('the encoder refuses rather than truncating', () => {
  test('a uint8 above 255 is refused, not masked', () => {
    // The failure this prevents: `decimals: 258` arriving as 2, producing a token whose every
    // balance is off by a factor of 10^16 and whose constructor did not revert.
    assert.throws(() => encodeArgs([{ type: 'uint8', value: 256n }]), AbiError);
    assert.throws(() => encodeArgs([{ type: 'uint16', value: 65_536n }]), AbiError);
    assert.throws(() => encodeArgs([{ type: 'uint256', value: 1n << 256n }]), AbiError);
  });

  test('a negative quantity is refused rather than wrapping to a huge one', () => {
    assert.throws(() => encodeArgs([{ type: 'uint256', value: -1n }]), AbiError);
  });

  test('a number where a bigint belongs is refused', () => {
    // Passing `18` instead of `18n` is the easiest mistake in this file's call sites, and a coder
    // that coerced would encode a float's rounding as a supply.
    assert.throws(() => encodeArgs([{ type: 'uint256', value: 18 as unknown as bigint }]), AbiError);
  });

  test('an address that is not one is refused', () => {
    assert.throws(() => encodeArgs([{ type: 'address', value: '0x1234' }]), AbiError);
    assert.throws(() => encodeArgs([{ type: 'address', value: 'not an address' }]), AbiError);
  });

  test('odd-length and non-hex input is refused', () => {
    assert.throws(() => hexToBytes('0xabc'), AbiError);
    assert.throws(() => hexToBytes('0xzz'), AbiError);
  });
});

describe('reading a return value treats the node as hostile', () => {
  const word = (value: bigint): string => value.toString(16).padStart(64, '0');

  test('an EMPTY answer is an error, not a zero', () => {
    // THE DEFECT THIS EXISTS TO PREVENT. `eth_call` to an address with no code succeeds and returns
    // `0x`. A reader that treats that as zero shows "your stake: 0 EMBER" for a market that is not
    // there — and "the chain says you hold nothing" and "this address is not a contract" must never
    // render the same, because only one of them means stop worrying.
    assert.throws(() => new Return('0x', 'stakeOf()'), /returned nothing/);
  });

  test('a short answer is an error rather than a silent zero', () => {
    assert.throws(() => new Return(`0x${word(5n)}`, 'stakeOf()').uint(1, 'stakeOf().no'), /word 1 was wanted/);
  });

  test('a non-string answer is refused', () => {
    assert.throws(() => new Return(null, 'total()'), AbiError);
    assert.throws(() => new Return({ balance: 5 }, 'total()'), AbiError);
    assert.throws(() => new Return('surely not', 'total()'), AbiError);
  });

  test('a uint8 that does not fit in a uint8 means this is not that contract', () => {
    assert.throws(() => new Return(`0x${word(900n)}`, 'status()').small(0, 8, 'status()'), /does not fit in uint8/);
  });

  test('an address with dirty high bytes is refused rather than masked', () => {
    // A reader that masks shows a different address from the one the EVM will use, and the two
    // disagree only in the bytes nobody prints.
    const dirty = `0x${'ff'.repeat(12)}${'11'.repeat(20)}`;
    assert.throws(() => new Return(dirty, 'oracle()').address(0, 'oracle()'), /dirty high bytes/);
  });

  test('a bool that is neither 0 nor 1 is refused', () => {
    assert.throws(() => new Return(`0x${word(2n)}`, 'claimed()').bool(0, 'claimed()'), /came back as 2/);
  });

  test('a standard dynamic string decodes', () => {
    const bytes = Buffer.from('ETT', 'utf8');
    const hex = `0x${word(32n)}${word(BigInt(bytes.length))}${bytes.toString('hex').padEnd(64, '0')}`;
    assert.equal(new Return(hex, 'symbol()').string('symbol()'), 'ETT');
  });

  test('a bytes32 symbol decodes too, because a large population of live tokens returns one', () => {
    // MKR is the well-known one. A reader that assumes the dynamic layout reads the symbol's own
    // bytes as an offset and lands somewhere absurd.
    const hex = `0x${Buffer.from('MKR', 'utf8').toString('hex').padEnd(64, '0')}`;
    assert.equal(new Return(hex, 'symbol()').string('symbol()'), 'MKR');
  });

  test('a string claiming more bytes than it has is refused', () => {
    const hex = `0x${word(32n)}${word(9999n)}${'41'.repeat(32)}`;
    assert.throws(() => new Return(hex, 'symbol()').string('symbol()'), /only \d+ follow/);
  });
});
