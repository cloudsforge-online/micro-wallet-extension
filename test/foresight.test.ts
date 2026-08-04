/* The parimutuel arithmetic, and the rules about what a screen may claim.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * THE PROJECTION IS CHECKED AGAINST A SECOND READING OF THE SOLIDITY, NOT AGAINST ITSELF.
 *
 * `payoutOf` below is transcribed from `foresight/src/contracts/ForesightMarket.sol` — :383
 * (`feeAmount`), :396 (`distributable`), :405 (`payoutOf`) — independently of
 * shared/foresight.ts's `projectStake`, and the two are compared over a grid of pools. That is the
 * only way a formula test is worth anything: asserting `projectStake(x) === 1234n` where 1234 came
 * from running `projectStake(x)` proves determinism and nothing else.
 *
 * The live contract is the final oracle and test/e2e/foresight.test.ts uses it — this file is the
 * fast one that runs without a chain.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  BPS, MARKET_SELECTORS, MARKET_SIGNATURES, PARIMUTUEL_CAVEAT, claimCallData, formatBps,
  isClaimable, isStakeable, outcomeName, projectStake, stakeCallData, statusFromCode,
  whyNotClaimable, type MarketObservation, type Outcome,
} from '../src/shared/foresight.ts';
import { selectorOf } from '../src/shared/abi.ts';

/* ------------------------------------------------------- the contract, transcribed separately -- */

/** `feeAmount()` — ForesightMarket.sol:383. Taken from the LOSING pool only, which is why the
 *  winning pool is not a parameter: a winner's principal is never charged. */
function feeAmount(poolLose: bigint, feeBps: bigint): bigint {
  return (poolLose * feeBps) / 10_000n;
}

/** `distributable()` — :396. Everything staked, less the fee. */
function distributable(poolWin: bigint, poolLose: bigint, feeBps: bigint): bigint {
  return poolWin + poolLose - feeAmount(poolLose, feeBps);
}

/** `payoutOf()` — :405. `backed * distributable / pool[winningOutcome]`, floored. */
function payoutOf(backed: bigint, poolWin: bigint, poolLose: bigint, feeBps: bigint): bigint {
  if (backed === 0n || poolWin === 0n) return 0n;
  return (backed * distributable(poolWin, poolLose, feeBps)) / poolWin;
}

const observation = (over: Partial<MarketObservation> = {}): MarketObservation => ({
  address: '0x34d47E92d6Da57Df96940dd62b496e2CEAcbF8E1',
  chainId: 7412,
  blockNumber: 1987,
  blockTimestamp: 1_785_803_925,
  observedAt: 1_785_803_925_000,
  status: 'open',
  questionHash: `0x${'ab'.repeat(32)}`,
  closeTime: 1_785_903_925,
  disputeWindowSeconds: 0,
  feeBps: 200,
  oracle: '0x9a2d854900Ba6294BD94854c0e82710E96CE2325',
  treasury: '0x9a2d854900Ba6294BD94854c0e82710E96CE2325',
  poolYesWei: '0',
  poolNoWei: '0',
  totalWei: '0',
  distributableWei: '0',
  feeAmountWei: '0',
  oddsYesBps: 0,
  oddsNoBps: 0,
  winningOutcome: null,
  resolvedAt: null,
  claimableFrom: null,
  viewer: '0x000000000000000000000000000000000000dEaD',
  myYesWei: '0',
  myNoWei: '0',
  myPayoutWei: '0',
  myClaimed: false,
  ...over,
});

const pooled = (yes: bigint, no: bigint, over: Partial<MarketObservation> = {}): MarketObservation => {
  const total = yes + no;
  return observation({
    poolYesWei: yes.toString(),
    poolNoWei: no.toString(),
    totalWei: total.toString(),
    oddsYesBps: total === 0n ? 0 : Number((yes * BPS) / total),
    oddsNoBps: total === 0n ? 0 : Number((no * BPS) / total),
    ...over,
  });
};

const E = 10n ** 18n;

describe('the projection is the contract’s own arithmetic', () => {
  test('it matches a separate transcription of payoutOf over a grid of pools', () => {
    const amounts = [1n, 1000n, E / 100n, E, 7n * E, 1234567890123456789n];
    const pools = [0n, 1n, E, 3n * E, 250n * E, 10n ** 24n];
    const fees = [0, 200, 1000];
    let checked = 0;

    for (const feeBps of fees) {
      for (const yes of pools) {
        for (const no of pools) {
          for (const amount of amounts) {
            for (const outcome of [0, 1] as Outcome[]) {
              const m = pooled(yes, no, { feeBps });
              const p = projectStake(m, outcome, amount);

              const poolWin = (outcome === 0 ? yes : no) + amount;
              const poolLose = outcome === 0 ? no : yes;

              assert.equal(BigInt(p.poolAfterWei), poolWin);
              assert.equal(BigInt(p.otherPoolWei), poolLose);
              assert.equal(BigInt(p.totalAfterWei), poolWin + poolLose);
              assert.equal(BigInt(p.feeIfResolvedWei), feeAmount(poolLose, BigInt(feeBps)));
              assert.equal(
                BigInt(p.shareIfResolvedNowWei),
                payoutOf(amount, poolWin, poolLose, BigInt(feeBps)),
                `disagreed at yes=${yes} no=${no} fee=${feeBps} amount=${amount} outcome=${outcome}`,
              );
              checked += 1;
            }
          }
        }
      }
    }
    assert.ok(checked >= 400, `only ${checked} combinations were checked`);
  });

  test('an existing stake on the same outcome is included, as the contract includes it', () => {
    // `payoutOf` reads `_stakes[staker][winningOutcome]` — the WHOLE position, not just the new
    // money. A projection that ignored what the user already holds would understate every top-up.
    const m = pooled(10n * E, 10n * E, { myYesWei: (4n * E).toString() });
    const p = projectStake(m, 0, E);
    assert.equal(BigInt(p.shareIfResolvedNowWei), payoutOf(5n * E, 11n * E, 10n * E, 200n));
  });

  test('a winner never receives less than they staked — the fee comes from the losing pool', () => {
    // ForesightMarket.sol:383 makes this a promise rather than a coincidence: "a winner always
    // receives at least their own stake back, because the fee is charged against other people's
    // losses and never against their principal." A projection that took the fee off the top would
    // break it, and every winner would read the screen as a bug.
    for (const yes of [0n, E, 100n * E]) {
      for (const no of [0n, E, 5000n * E]) {
        for (const feeBps of [0, 200, 1000]) {
          const p = projectStake(pooled(yes, no, { feeBps }), 0, 3n * E);
          assert.ok(
            BigInt(p.shareIfResolvedNowWei) >= 3n * E,
            `a winner would receive ${p.shareIfResolvedNowWei} on a stake of ${3n * E} (yes=${yes} no=${no} fee=${feeBps})`,
          );
        }
      }
    }
  });

  test('the odds after a stake are the pool ratio the contract would then report', () => {
    const p = projectStake(pooled(3n * E, E), 0, E);
    // 4 of 5.
    assert.equal(p.oddsAfterBps, 8000);
    assert.equal(p.oddsBeforeBps, 7500);
    assert.equal(formatBps(p.oddsAfterBps), '80%');
    assert.equal(formatBps(6250), '62.5%');
    assert.equal(formatBps(1), '0.01%');
  });

  test('staking into an empty market gives back the whole pool and nothing more', () => {
    const p = projectStake(pooled(0n, 0n), 0, E);
    assert.equal(BigInt(p.shareIfResolvedNowWei), E);
    assert.equal(BigInt(p.netIfResolvedNowWei), 0n);
    assert.equal(p.oddsBeforeBps, 0);
    assert.equal(p.oddsAfterBps, 10_000);
  });

  test('the net figure is the share less everything staked on that outcome', () => {
    const m = pooled(E, 9n * E, { myYesWei: E.toString() });
    const p = projectStake(m, 0, E);
    assert.equal(
      BigInt(p.netIfResolvedNowWei),
      BigInt(p.shareIfResolvedNowWei) - E - E,
    );
  });

  test('a negative stake is refused rather than producing a credit', () => {
    assert.throws(() => projectStake(pooled(E, E), 0, -1n), /never negative/);
  });
});

describe('the caveat travels with the number', () => {
  test('every projection carries it, so a screen cannot render one without the other', () => {
    // §5.1's whole point. It is a FIELD rather than a string in a component, because the way "a
    // wallet that shows a fixed payout on a parimutuel" happens is somebody tidying a paragraph
    // away from beside a number.
    const p = projectStake(pooled(E, E), 0, E);
    assert.equal(p.caveat, PARIMUTUEL_CAVEAT);
    assert.match(p.caveat, /not a payout, a quote or a guarantee/);
    assert.match(p.caveat, /Every stake after this one/);
  });

  test('the projection has no field a screen could mistake for a payout', () => {
    const p = projectStake(pooled(E, E), 0, E);
    for (const key of Object.keys(p)) {
      assert.ok(
        !/^payout|^willReceive|^guaranteed/.test(key),
        `${key} reads as a promise; the type is deliberately named in conditionals`,
      );
    }
    assert.ok('shareIfResolvedNowWei' in p);
    assert.ok('blockNumber' in p, 'a projection with no block cannot be stated honestly');
  });
});

describe('the contract’s own refusal rules, stated before the user pays for them', () => {
  test('an open market past its close time does not take a stake', () => {
    assert.equal(isStakeable(observation({ closeTime: 1_785_803_925 })), false);
    assert.equal(isStakeable(observation({ closeTime: 1_785_803_926 })), true);
    // The comparison is against the BLOCK's clock, not the wallet's. A laptop with a wrong clock
    // must not decide whether a contract is open.
    assert.equal(isStakeable(observation({ closeTime: 1_785_803_926, observedAt: 0 })), true);
  });

  test('a resolved or void market takes no stake at all', () => {
    assert.equal(isStakeable(observation({ status: 'resolved' })), false);
    assert.equal(isStakeable(observation({ status: 'void' })), false);
  });

  test('an open market cannot be claimed from, and says why', () => {
    const m = observation({ myYesWei: E.toString() });
    assert.equal(isClaimable(m), false);
    assert.match(whyNotClaimable(m) ?? '', /still open/);
  });

  test('a second claim is refused by name rather than by a revert', () => {
    const m = observation({ status: 'resolved', winningOutcome: 0, myPayoutWei: '0', myClaimed: true, claimableFrom: 1 });
    assert.equal(isClaimable(m), false);
    assert.match(whyNotClaimable(m) ?? '', /already claimed/);
  });

  test('`claimed` alone refuses, even when payoutOf still reports a balance', () => {
    // ───────────────────────────────────────────────────────────────────────────────────────────
    // THIS TEST EXISTS BECAUSE THE ONE ABOVE PASSED FOR THE WRONG REASON.
    //
    // Deleting `if (m.myClaimed) return false;` from `isClaimable` left the whole suite green: the
    // case above also sets `myPayoutWei` to '0', so the payout check caught it and the flag was
    // never load-bearing. A mutation run found that, which is what mutation runs are for.
    //
    // The state below is not hypothetical. `payoutOf` returns 0 only once `claimed[staker]` is set,
    // and the two are read in one pinned block — but a claim mined BETWEEN the wallet's read and
    // the user's tap leaves exactly this: a stale non-zero payout beside a flag that has flipped.
    // With the guard gone the button is enabled, the user pays for the gas, and `_claim` reverts
    // with AlreadyClaimed. The flag is the cheaper answer, so it must be the one that decides.
    // ───────────────────────────────────────────────────────────────────────────────────────────
    const stale = observation({
      status: 'resolved',
      winningOutcome: 0,
      myYesWei: E.toString(),
      myPayoutWei: (2n * E).toString(),
      myClaimed: true,
      claimableFrom: 1,
    });
    assert.equal(isClaimable(stale), false, 'a claimed position is still offered a claim button');
    assert.match(whyNotClaimable(stale) ?? '', /already claimed/);
    assert.match(whyNotClaimable(stale) ?? '', /reverts/);
  });

  test('an open dispute window is counted down in seconds', () => {
    const m = observation({
      status: 'resolved', winningOutcome: 0, myPayoutWei: E.toString(),
      claimableFrom: 1_785_803_925 + 90, resolvedAt: 1_785_803_925,
    });
    assert.equal(isClaimable(m), false);
    assert.match(whyNotClaimable(m) ?? '', /another 90s/);
  });

  test('a resolved market with a winning stake and no window is claimable', () => {
    const m = observation({
      status: 'resolved', winningOutcome: 0, myYesWei: E.toString(),
      myPayoutWei: (2n * E).toString(), claimableFrom: 1_785_803_900,
    });
    assert.equal(isClaimable(m), true);
    assert.equal(whyNotClaimable(m), null);
  });

  test('a void market refunds, and having staked nothing is said as such', () => {
    const staked = observation({ status: 'void', myNoWei: E.toString(), myPayoutWei: E.toString(), claimableFrom: 1 });
    assert.equal(isClaimable(staked), true);
    const empty = observation({ status: 'void', claimableFrom: 1 });
    assert.match(whyNotClaimable(empty) ?? '', /staked nothing/);
  });
});

describe('the call data', () => {
  test('stake and claim are the selectors the contract exposes', () => {
    assert.equal(MARKET_SELECTORS.stake, selectorOf('stake(uint8)'));
    assert.equal(MARKET_SELECTORS.claim, selectorOf('claim()'));
    assert.equal(claimCallData(), MARKET_SELECTORS.claim);
    assert.equal(claimCallData().length, 10, 'claim() takes no arguments');
  });

  test('a stake encodes the outcome in one word', () => {
    assert.equal(BigInt(`0x${stakeCallData(0).slice(10)}`), 0n);
    assert.equal(BigInt(`0x${stakeCallData(1).slice(10)}`), 1n);
    assert.equal(stakeCallData(1).length, 2 + 8 + 64);
  });

  test('every signature in the table is a real ForesightMarket function', () => {
    // The names are checked against the contract's ABI by test/e2e/foresight.test.ts, which reads
    // foresight/src/contracts/generated.ts. Here: no duplicates, and every selector distinct.
    const selectors = Object.values(MARKET_SELECTORS);
    assert.equal(new Set(selectors).size, selectors.length, 'two functions share a selector');
    assert.equal(Object.keys(MARKET_SIGNATURES).length, selectors.length);
  });
});

describe('status decoding refuses a value the enum has no name for', () => {
  test('0, 1 and 2 are Open, Resolved and Void', () => {
    assert.equal(statusFromCode(0), 'open');
    assert.equal(statusFromCode(1), 'resolved');
    assert.equal(statusFromCode(2), 'void');
  });

  test('anything else throws rather than defaulting to open', () => {
    // Defaulting an unknown status to "open" would put a stake button on a market that cannot take
    // one, and the user would pay a fee to find out.
    assert.throws(() => statusFromCode(3), /no name for/);
    assert.throws(() => statusFromCode(255), /no name for/);
  });

  test('outcomes are named, not numbered, on screen', () => {
    assert.equal(outcomeName(0), 'YES');
    assert.equal(outcomeName(1), 'NO');
  });
});
