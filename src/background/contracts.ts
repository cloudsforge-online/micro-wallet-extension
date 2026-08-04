/* Reading contracts, and building the two transactions that talk to them.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * EVERY READ IN THIS FILE IS PINNED TO ONE BLOCK, AND THAT IS THE POINT OF THE FILE.
 *
 * `readMarket` makes fourteen `eth_call`s. At `latest` they would be fourteen reads of a chain that
 * mines every couple of seconds, and a stake landing between calls three and four produces a screen
 * where the pool totals do not add up to the total and the odds match neither. Worse, it produces a
 * CONFIRMATION whose odds were read at a different moment from its pool — which is precisely the
 * dishonesty §5.1 exists to forbid, arrived at by accident instead of on purpose.
 *
 * So: one `eth_blockNumber`, then every call tagged with that number, and the block's own timestamp
 * read from the same block. The observation that comes out describes one moment and says which.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * §7 applies throughout: the node is hostile input. Nothing here reaches into a response without
 * going through shared/abi.ts's `Return`, which refuses a short answer rather than reading it as a
 * zero — "there is no contract at that address" and "your stake is nothing" must never render the
 * same, because only one of them means stop worrying.
 */

import { contractAddress } from '@cloudsforge/hearth-wallet-core';

import { encodeCall, encodeDeployment, Return, type AbiValue } from '../shared/abi.ts';
import {
  MARKET_SIGNATURES, OUTCOME_NO, OUTCOME_YES, statusFromCode, type MarketObservation,
} from '../shared/foresight.ts';
import {
  constructorArgsFor, constructorTypesFor, templateFor, type TokenInput, type Variant,
} from '../shared/templates.ts';
import { INTERNAL_ERROR, INVALID_PARAMS, ProviderError } from '../shared/errors.ts';
import { fromQuantity, toQuantity } from '../shared/units.ts';
import { ARTEFACTS, MINT_SOURCE_SHA256 } from './templates.generated.ts';
import type { ChainRecord } from './storage.ts';
import { rpc } from './rpc.ts';

export { MINT_SOURCE_SHA256 };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function requireAddress(value: unknown, what: string): string {
  if (typeof value !== 'string' || !ADDRESS.test(value.trim())) {
    throw new ProviderError(INVALID_PARAMS, `${what} must be 0x followed by 40 hex characters.`);
  }
  return value.trim();
}

/** One `eth_call`, at a named block. `blockTag` is never `latest` from inside this file. */
export async function ethCall(chain: ChainRecord, to: string, data: string, blockTag: string): Promise<unknown> {
  return rpc(chain, 'eth_call', [{ to, data }, blockTag]);
}

/** The block to pin a whole read to, with its timestamp — the clock every contract runs on. */
export async function pinBlock(chain: ChainRecord): Promise<{ tag: string; number: number; timestamp: number }> {
  const number = fromQuantity(await rpc(chain, 'eth_blockNumber'), 'eth_blockNumber');
  const tag = toQuantity(number);
  const block = await rpc(chain, 'eth_getBlockByNumber', [tag, false]);
  if (typeof block !== 'object' || block === null) {
    throw new ProviderError(INTERNAL_ERROR, `${chain.name} has no block ${number}, which it had just named as its tip.`);
  }
  const timestamp = fromQuantity((block as Record<string, unknown>)['timestamp'], 'block.timestamp');
  return { tag, number: Number(number), timestamp: Number(timestamp) };
}

/* ------------------------------------------------------------------------------- the market --- */

/**
 * A ForesightMarket, read whole, from the chain and from nowhere else.
 *
 * The viewer's three position reads (`stakeOf`, `payoutOf`, `claimed`) are skipped when there is no
 * selected account rather than being answered with zeros — a wallet with no account has no position
 * to report, and reporting one of zero is a statement it has not earned.
 */
export async function readMarket(
  chain: ChainRecord,
  address: string,
  viewer: string | null,
): Promise<MarketObservation> {
  const market = requireAddress(address, 'The market address');
  const block = await pinBlock(chain);

  const read = async (signature: string, args: readonly AbiValue[] = []): Promise<Return> => {
    const data = encodeCall(signature, args);
    return new Return(await ethCall(chain, market, data, block.tag), `${signature} on ${market}`);
  };

  // Sequential rather than Promise.all: Hearth's JSON-RPC is a single node on a laptop or in a
  // container, and fourteen simultaneous eth_calls is how a read starts intermittently timing out
  // for reasons that look like a wallet bug. They are all at the same pinned block, so the order
  // they arrive in changes nothing.
  const statusCode = (await read(MARKET_SIGNATURES.status)).small(0, 8, 'status()');
  const status = statusFromCode(statusCode);

  const poolYes = (await read(MARKET_SIGNATURES.pool, [{ type: 'uint256', value: BigInt(OUTCOME_YES) }])).uint(0, 'pool(0)');
  const poolNo = (await read(MARKET_SIGNATURES.pool, [{ type: 'uint256', value: BigInt(OUTCOME_NO) }])).uint(0, 'pool(1)');
  const total = (await read(MARKET_SIGNATURES.total)).uint(0, 'total()');
  if (poolYes + poolNo !== total) {
    // Two reads at the same block that do not agree means this is not a ForesightMarket, or the
    // node is not answering from one state. Either way the numbers on a stake screen would be
    // fiction, so this refuses rather than picking one.
    throw new ProviderError(
      INTERNAL_ERROR,
      `${market} answered pool(0)+pool(1) = ${poolYes + poolNo} but total() = ${total} at block ${block.number}. `
      + 'Those cannot both be true of one contract at one block, so this wallet will not draw a screen from them.',
    );
  }

  const oddsYes = (await read(MARKET_SIGNATURES.oddsBps, [{ type: 'uint8', value: BigInt(OUTCOME_YES) }])).small(0, 16, 'oddsBps(0)');
  const oddsNo = (await read(MARKET_SIGNATURES.oddsBps, [{ type: 'uint8', value: BigInt(OUTCOME_NO) }])).small(0, 16, 'oddsBps(1)');
  const distributable = (await read(MARKET_SIGNATURES.distributable)).uint(0, 'distributable()');
  const feeAmount = (await read(MARKET_SIGNATURES.feeAmount)).uint(0, 'feeAmount()');
  const feeBps = (await read(MARKET_SIGNATURES.feeBps)).small(0, 16, 'feeBps()');
  const closeTime = (await read(MARKET_SIGNATURES.closeTime)).small(0, 64, 'closeTime()');
  const disputeWindowSeconds = (await read(MARKET_SIGNATURES.disputeWindowSeconds)).small(0, 64, 'disputeWindowSeconds()');
  const questionHash = (await read(MARKET_SIGNATURES.questionHash)).bytes32(0, 'questionHash()');
  const oracle = (await read(MARKET_SIGNATURES.oracle)).address(0, 'oracle()');
  const treasury = (await read(MARKET_SIGNATURES.treasury)).address(0, 'treasury()');
  const claimableFromRaw = (await read(MARKET_SIGNATURES.claimableFrom)).small(0, 64, 'claimableFrom()');

  let winningOutcome: number | null = null;
  let resolvedAt: number | null = null;
  if (status === 'resolved') {
    winningOutcome = (await read(MARKET_SIGNATURES.winningOutcome)).small(0, 8, 'winningOutcome()');
    resolvedAt = (await read(MARKET_SIGNATURES.resolvedAt)).small(0, 64, 'resolvedAt()');
  }

  let myYes = 0n;
  let myNo = 0n;
  let myPayout = 0n;
  let myClaimed = false;
  if (viewer !== null) {
    const stakes = await read(MARKET_SIGNATURES.stakeOf, [{ type: 'address', value: viewer }]);
    myYes = stakes.uint(0, 'stakeOf().yes');
    myNo = stakes.uint(1, 'stakeOf().no');
    myPayout = (await read(MARKET_SIGNATURES.payoutOf, [{ type: 'address', value: viewer }])).uint(0, 'payoutOf()');
    myClaimed = (await read(MARKET_SIGNATURES.claimed, [{ type: 'address', value: viewer }])).bool(0, 'claimed()');
  }

  return {
    address: market,
    chainId: chain.id,
    blockNumber: block.number,
    blockTimestamp: block.timestamp,
    observedAt: Date.now(),
    status,
    questionHash,
    closeTime,
    disputeWindowSeconds,
    feeBps,
    oracle,
    treasury,
    poolYesWei: poolYes.toString(),
    poolNoWei: poolNo.toString(),
    totalWei: total.toString(),
    distributableWei: distributable.toString(),
    feeAmountWei: feeAmount.toString(),
    oddsYesBps: oddsYes,
    oddsNoBps: oddsNo,
    winningOutcome,
    resolvedAt,
    // `claimableFrom()` answers 0 while the market is open — a sentinel, not a date, and rendering
    // it as one would put "1 January 1970" on a screen.
    claimableFrom: claimableFromRaw === 0 && status === 'open' ? null : claimableFromRaw,
    viewer,
    myYesWei: myYes.toString(),
    myNoWei: myNo.toString(),
    myPayoutWei: myPayout.toString(),
    myClaimed,
  };
}

/* -------------------------------------------------------------------------------- the token --- */

export interface DeploymentPlan {
  readonly variant: Variant;
  readonly contract: string;
  /** The creation data: micro-mint's bytecode with the constructor arguments appended. */
  readonly data: string;
  readonly bytecodeSha256: string;
  readonly bytecodeBytes: number;
  readonly argumentBytes: number;
  /** What each argument is, in the constructor's own order, for the confirmation screen. */
  readonly arguments: readonly { readonly name: string; readonly type: string; readonly value: string }[];
  readonly mintSourceSha256: string;
}

/**
 * Build a deployment, checking the argument list against micro-mint's own ABI before encoding.
 *
 * THE ABI CHECK IS NOT DECORATION. `constructorArgsFor` restates an order that mint says is
 * "load-bearing and unchecked by the compiler". test/templates.test.ts checks it at build time; this
 * checks it again with the artefact that is actually about to be deployed, because a regenerated
 * templates.generated.ts and a stale shared/templates.ts is exactly the state in which the test
 * passed yesterday and the token deployed today has 10^18 decimals.
 */
export function buildDeployment(variant: Variant, input: TokenInput): DeploymentPlan {
  const template = templateFor(variant);
  const artefact = ARTEFACTS[template.contract];
  if (artefact === undefined) {
    throw new ProviderError(INTERNAL_ERROR, `No committed bytecode for ${template.contract}. Run tools/templates.js.`);
  }
  const args = constructorArgsFor(template, input);
  const wanted = constructorTypesFor(template);
  const declared = artefact.constructorInputs.map((i) => i.type);
  if (declared.length !== wanted.length || declared.some((type, i) => type !== wanted[i])) {
    throw new ProviderError(
      INTERNAL_ERROR,
      `${template.contract}'s constructor takes (${declared.join(', ')}) but this wallet would encode (${wanted.join(', ')}). `
      + 'Refusing to deploy: an argument list in the wrong order produces a token whose numbers are not the ones asked for.',
    );
  }

  const data = encodeDeployment(artefact.bytecode, args);
  const bytecodeBytes = (artefact.bytecode.length - 2) / 2;
  return {
    variant,
    contract: template.contract,
    data,
    bytecodeSha256: artefact.bytecodeSha256,
    bytecodeBytes,
    argumentBytes: (data.length - 2) / 2 - bytecodeBytes,
    arguments: artefact.constructorInputs.map((input_, i) => ({
      name: input_.name,
      type: input_.type,
      value: String(args[i]?.value ?? ''),
    })),
    mintSourceSha256: MINT_SOURCE_SHA256,
  };
}

/** Where a creation from `sender` at `nonce` lands — known before the transaction is sent. */
export function deployedAddress(sender: string, nonce: bigint): string {
  return contractAddress(requireAddress(sender, 'The deployer'), nonce);
}

export interface TokenFacts {
  readonly address: string;
  readonly blockNumber: number;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly totalSupplyWei: string;
  readonly holderBalanceWei: string | null;
  readonly codeBytes: number;
}

/**
 * Read a deployed token back off the chain.
 *
 * `eth_getCode` FIRST, and it is the assertion that matters. A deployment that ran out of gas, or
 * reverted in its constructor, leaves a transaction receipt with a `contractAddress` field and NO
 * CODE at it — and every subsequent `eth_call` to that address returns `0x`, which a careless
 * reader turns into a symbol of "" and a supply of 0 rather than into "this did not deploy".
 * That is the trap this phase was warned about in the wallet's own terms: verify positively.
 */
export async function readToken(chain: ChainRecord, address: string, holder: string | null): Promise<TokenFacts> {
  const token = requireAddress(address, 'The token address');
  const block = await pinBlock(chain);

  const code = await rpc(chain, 'eth_getCode', [token, block.tag]);
  if (typeof code !== 'string' || code === '0x' || code === '0x0') {
    throw new ProviderError(
      INTERNAL_ERROR,
      `There is no code at ${token} on ${chain.name} at block ${block.number}. `
      + 'Nothing was deployed there, or the constructor reverted — a receipt naming an address is not proof of a contract.',
    );
  }

  const read = async (signature: string, args: readonly AbiValue[] = []): Promise<Return> =>
    new Return(await ethCall(chain, token, encodeCall(signature, args), block.tag), `${signature} on ${token}`);

  const name = (await read('name()')).string('name()');
  const symbol = (await read('symbol()')).string('symbol()');
  const decimals = (await read('decimals()')).small(0, 8, 'decimals()');
  const totalSupply = (await read('totalSupply()')).uint(0, 'totalSupply()');
  const holderBalance = holder === null
    ? null
    : (await read('balanceOf(address)', [{ type: 'address', value: holder }])).uint(0, 'balanceOf()');

  return {
    address: token,
    blockNumber: block.number,
    name,
    symbol,
    decimals,
    totalSupplyWei: totalSupply.toString(),
    holderBalanceWei: holderBalance === null ? null : holderBalance.toString(),
    codeBytes: (code.length - 2) / 2,
  };
}
