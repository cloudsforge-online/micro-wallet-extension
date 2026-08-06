/* Forge Foresight, as a contract rather than as a service.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * THERE IS NO CLOUDSFORGE URL IN THIS FILE, AND THERE MUST NEVER BE ONE.
 *
 * 25-wallet-clients.md §5.1: "positions survive the platform … it is only true if the wallet never
 * routes these calls through the platform. It must therefore be built to work with the Foresight
 * API entirely absent, and tested that way."
 *
 * Everything a user needs in order to SEE what they hold and to TAKE what they are owed is derived
 * here from public views on `ForesightMarket.sol` — `stakeOf` (:352), `payoutOf` (:405), `oddsBps`
 * (:362), `total`, `distributable`, `claimableFrom` — plus two calls, `stake(uint8)` (:197) and
 * `claim()` (:431), neither of which has an allowlist, an operator or a platform signature in it.
 * The one thing the chain cannot supply is DISCOVERY: which markets exist, and what each one asks
 * in words. That lives in background/discovery.ts, is off unless a user turns it on, and its
 * absence costs a user a paste of an address and nothing else.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * THE SIGNATURES ARE STRINGS AND THE SELECTORS ARE COMPUTED. Same rule as shared/decode.ts: a
 * hardcoded `0x6e553f65` is a magic number nobody can check by reading, and a wrong one here calls
 * a different function on a contract holding the user's stake.
 */

import { encodeCall, selectorOf, type AbiValue } from './abi.ts';
import { formatUnits } from './units.ts';

/* ------------------------------------------------------------------------------ the contract -- */

export const MARKET_SIGNATURES = {
  stake: 'stake(uint8)',
  claim: 'claim()',
  stakeOf: 'stakeOf(address)',
  payoutOf: 'payoutOf(address)',
  oddsBps: 'oddsBps(uint8)',
  total: 'total()',
  distributable: 'distributable()',
  claimableFrom: 'claimableFrom()',
  feeAmount: 'feeAmount()',
  feeBps: 'feeBps()',
  pool: 'pool(uint256)',
  status: 'status()',
  closeTime: 'closeTime()',
  questionHash: 'questionHash()',
  winningOutcome: 'winningOutcome()',
  resolvedAt: 'resolvedAt()',
  disputeWindowSeconds: 'disputeWindowSeconds()',
  claimed: 'claimed(address)',
  oracle: 'oracle()',
  treasury: 'treasury()',
} as const;

export const MARKET_SELECTORS: Readonly<Record<keyof typeof MARKET_SIGNATURES, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(MARKET_SIGNATURES).map(([name, signature]) => [name, selectorOf(signature)]),
  ) as Record<keyof typeof MARKET_SIGNATURES, string>,
);

/** `enum Status { Open, Resolved, Void }` — ForesightMarket.sol. */
export type MarketStatus = 'open' | 'resolved' | 'void';

export const OUTCOME_YES = 0;
export const OUTCOME_NO = 1;
export type Outcome = 0 | 1;

/** Basis points denominator, as the contract defines it. */
export const BPS = 10_000n;

export function statusFromCode(code: number): MarketStatus {
  switch (code) {
    case 0: return 'open';
    case 1: return 'resolved';
    case 2: return 'void';
    default: throw new Error(`this contract answered status() with ${code}, which ForesightMarket has no name for`);
  }
}

export function outcomeName(outcome: number): string {
  return outcome === OUTCOME_YES ? 'YES' : outcome === OUTCOME_NO ? 'NO' : `outcome ${outcome}`;
}

export const stakeCallData = (outcome: Outcome): string =>
  encodeCall(MARKET_SIGNATURES.stake, [{ type: 'uint8', value: BigInt(outcome) } satisfies AbiValue]);

export const claimCallData = (): string => encodeCall(MARKET_SIGNATURES.claim);

/* --------------------------------------------------------------------------- what was observed */

/**
 * A market, as one node reported it at ONE block.
 *
 * `blockNumber` is not decoration. Every field below was read with that block as the tag, so the
 * whole record is internally consistent — the pools, the odds and the payout all describe the same
 * moment. Reading each view at `latest` instead would let a stake land between two of the calls and
 * produce a screen whose numbers do not add up, on a chain that mines every couple of seconds.
 *
 * `observedAt` is the wallet's own clock, and it is here so the UI can say how stale this is
 * without asking the node again. It is NEVER used for a decision — `closeTime` and `claimableFrom`
 * are compared against the BLOCK's timestamp, because that is the clock the contract runs on.
 */
export interface MarketObservation {
  readonly address: string;
  readonly chainId: number;
  readonly blockNumber: number;
  readonly blockTimestamp: number;
  readonly observedAt: number;

  readonly status: MarketStatus;
  readonly questionHash: string;
  readonly closeTime: number;
  readonly disputeWindowSeconds: number;
  readonly feeBps: number;
  readonly oracle: string;
  readonly treasury: string;

  readonly poolYesWei: string;
  readonly poolNoWei: string;
  readonly totalWei: string;
  readonly distributableWei: string;
  readonly feeAmountWei: string;
  /** As the contract computes it: the share of the pool on that outcome, in basis points. */
  readonly oddsYesBps: number;
  readonly oddsNoBps: number;

  readonly winningOutcome: number | null;
  readonly resolvedAt: number | null;
  readonly claimableFrom: number | null;

  /** The viewer's own position. Absent when the wallet has no account selected. */
  readonly viewer: string | null;
  readonly myYesWei: string;
  readonly myNoWei: string;
  readonly myPayoutWei: string;
  readonly myClaimed: boolean;
}

/** True when the CONTRACT's clock — the block timestamp — says staking is still possible. */
export function isStakeable(m: MarketObservation): boolean {
  return m.status === 'open' && m.blockTimestamp < m.closeTime;
}

/** True when `claim()` would not revert, by the same rules `_claim` applies. */
export function isClaimable(m: MarketObservation): boolean {
  if (m.status === 'open') return false;
  if (BigInt(m.myPayoutWei) === 0n) return false;
  if (m.myClaimed) return false;
  if (m.claimableFrom !== null && m.blockTimestamp < m.claimableFrom) return false;
  return true;
}

/**
 * Why `claim()` would fail, in the contract's own terms, so the button can say it rather than the
 * node saying `execution reverted` after the user has paid for the gas.
 */
export function whyNotClaimable(m: MarketObservation): string | null {
  if (isClaimable(m)) return null;
  if (m.status === 'open') return 'This market is still open. Nothing can be claimed until it is resolved or voided.';
  if (m.myClaimed) return 'This address has already claimed from this market. A second claim reverts — the contract allows exactly one, for ever.';
  if (m.claimableFrom !== null && m.blockTimestamp < m.claimableFrom) {
    const seconds = m.claimableFrom - m.blockTimestamp;
    return `The dispute window is still open for another ${seconds}s. The contract refuses a claim until it closes.`;
  }
  if (BigInt(m.myPayoutWei) === 0n) {
    return m.status === 'void'
      ? 'This address staked nothing in this market, so there is nothing to refund.'
      : `This market resolved ${m.winningOutcome === null ? '' : outcomeName(m.winningOutcome)} and this address has no stake on that outcome.`;
  }
  return 'The contract would refuse this claim.';
}

/* ---------------------------------------------------------------------------- honest odds ----- */

/**
 * What a stake would be worth IF the market resolved that way with the pool exactly as observed.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * THE THING THIS TYPE EXISTS TO PREVENT.
 *
 * §5.1: "A parimutuel's odds move with every stake including your own, so the confirmation screen
 * states the pool AS OBSERVED and does not imply the displayed odds are the settled ones. A wallet
 * that shows a fixed payout on a parimutuel is lying, cheerfully."
 *
 * So this is not called `payout`, and no field in it is. It is a projection, every field says so,
 * and it carries the block it was computed from so the screen can name it. The arithmetic is the
 * contract's own — `payoutOf` at :405, `distributable` at :396, `feeAmount` at :383 — applied to
 * the pool the user's own stake would create, which is the ONE number a stake screen can state
 * without lying: not "you will receive X" but "if it settled at this instant, this is the share the
 * contract's formula gives you".
 *
 * Every later stake by anybody changes it. `caveat` says that in words and the UI renders it; it is
 * a field rather than a comment so it cannot be dropped by a screen that forgot.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
export interface StakeProjection {
  readonly outcome: Outcome;
  readonly amountWei: string;
  /** The pool on the chosen outcome after this stake — pool + amount, exactly. */
  readonly poolAfterWei: string;
  readonly otherPoolWei: string;
  readonly totalAfterWei: string;
  /** The observed odds, before this stake. What `oddsBps` answered at `blockNumber`. */
  readonly oddsBeforeBps: number;
  /** What `oddsBps` would answer the instant after this stake, if nothing else changed. */
  readonly oddsAfterBps: number;
  /** The fee the contract would take from the losing pool, at this pool. */
  readonly feeIfResolvedWei: string;
  /**
   * `(myStake + amount) * distributable / winningPool`, floored — the contract's own formula, at
   * the pool this stake would create. NOT a payout, NOT a promise, NOT a quote.
   */
  readonly shareIfResolvedNowWei: string;
  /** `shareIfResolvedNow - amount - alreadyStaked`. Negative is possible and is shown as such. */
  readonly netIfResolvedNowWei: string;
  readonly blockNumber: number;
  readonly caveat: string;
}

export const PARIMUTUEL_CAVEAT =
  'These are the pool figures one node reported at the block named above, and the share is this '
  + 'contract’s own arithmetic applied to them. It is not a payout, a quote or a guarantee. '
  + 'Every stake after this one — including anybody else’s, at any time before the market '
  + 'closes — changes it, and it can go down as well as up.';

/**
 * Project a stake against an observation.
 *
 * INTEGER ARITHMETIC THROUGHOUT, floored where the contract floors. A projection computed in
 * doubles would disagree with the chain in the last few wei, and a user who compares the two finds
 * a wallet that cannot add up.
 */
export function projectStake(m: MarketObservation, outcome: Outcome, amountWei: bigint): StakeProjection {
  if (amountWei < 0n) throw new Error('a stake is never negative');
  const poolYes = BigInt(m.poolYesWei);
  const poolNo = BigInt(m.poolNoWei);
  const chosen = outcome === OUTCOME_YES ? poolYes : poolNo;
  const other = outcome === OUTCOME_YES ? poolNo : poolYes;
  const mine = BigInt(outcome === OUTCOME_YES ? m.myYesWei : m.myNoWei);

  const poolAfter = chosen + amountWei;
  const totalAfter = poolAfter + other;
  // `feeAmount()`: the fee is taken from the LOSING pool only, so a projection for "this outcome
  // wins" charges it against `other` and never against the user's own principal. Mirroring that
  // matters — a projection that took the fee off the top would understate every winning share and
  // the user would think the wallet had shortchanged them.
  const fee = (other * BigInt(m.feeBps)) / BPS;
  const distributable = totalAfter - fee;
  const share = poolAfter === 0n ? 0n : ((mine + amountWei) * distributable) / poolAfter;

  return {
    outcome,
    amountWei: amountWei.toString(),
    poolAfterWei: poolAfter.toString(),
    otherPoolWei: other.toString(),
    totalAfterWei: totalAfter.toString(),
    oddsBeforeBps: outcome === OUTCOME_YES ? m.oddsYesBps : m.oddsNoBps,
    oddsAfterBps: totalAfter === 0n ? 0 : Number((poolAfter * BPS) / totalAfter),
    feeIfResolvedWei: fee.toString(),
    shareIfResolvedNowWei: share.toString(),
    netIfResolvedNowWei: (share - amountWei - mine).toString(),
    blockNumber: m.blockNumber,
    caveat: PARIMUTUEL_CAVEAT,
  };
}

/** Basis points as a percentage string. 6250 -> "62.50%". */
export function formatBps(bps: number): string {
  return `${formatUnits(BigInt(bps), 2, 2)}%`;
}
