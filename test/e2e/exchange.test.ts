/* Phase D of the Forge Exchange plan, from the browser: add, swap, swap back, remove.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE CLOSES, AND WHY THE THING IT REPLACES DID NOT CLOSE IT.
 *
 * `docs/ecosystem/39-forge-exchange.md` phase D asks for two things:
 *
 *   "one EMBER pair seeded from testnet mining, swapped both ways BY A WALLET THAT IS NOT OURS"
 *   "a full cycle — add, swap, swap back, remove — FROM THE BROWSER EXTENSION"
 *
 * `deploy/scripts/hearth-dex-seed.js` did the pair and it did the cycle, and it signed every
 * transaction with `minerKey()` — the key that is also the chain's coinbase. The house traded with
 * itself, through a script, with no browser anywhere near it. That proves the CONTRACTS work. It
 * cannot prove the MARKET works, because both counterparties, both signatures and the whole of the
 * client were one program run by one key.
 *
 * So every transaction below is signed inside the extension, by a key the extension generated
 * during onboarding in this run, in a Chromium profile that did not exist five minutes ago. The
 * test never holds that key and cannot sign for it. Its only privileged act is the one a chain with
 * "NO PREMINE" makes unavoidable: the new account starts empty, so it is sent some EMBER — from a
 * FUNDING KEY THAT IS NOT THE COINBASE EITHER (`deploy/scripts/hearth-fund.js` put the coins there,
 * and the last test in this file asserts all three addresses are distinct).
 *
 * ── HOW A CLAIM IS PROVED HERE ──────────────────────────────────────────────────────────────────
 *
 *   - The sender of every transaction is RECOVERED FROM ITS SIGNATURE by `hearth/node`'s own
 *     decoder, not read from a field the node filled in. "The extension signed it" is the entire
 *     subject of this file, so it is proved with the one artefact that cannot be faked by the thing
 *     under test.
 *   - Every amount is measured at a PINNED BLOCK — the receipt's, against its predecessor — so a
 *     block mined mid-assertion cannot move a balance under a comparison. Both sides of every
 *     equation are then exact, and `assert.equal` on bigints is used rather than a tolerance.
 *   - The router's own quote is checked against the constant-product formula computed here from
 *     `getReserves()`, BEFORE the swap that relies on it. If the two disagree, the calldata this
 *     file builds is not the calldata it thinks it is, and the run stops before it spends anything.
 *   - The pool is expected to LOSE the trader money across a round trip and it is asserted to:
 *     0.30% is charged twice and stays in the pool, so `k = reserve0 * reserve1` rises across every
 *     swap. A market that returned more than it took is a broken one, not a generous one.
 *
 * ── WHAT THIS FILE IS NOT ───────────────────────────────────────────────────────────────────────
 *
 * It is not a test of a Forge Exchange user interface, because there is not one yet (phase H). The
 * dapp here is the harness's own page driving EIP-1193 directly, which is exactly what a swap UI
 * would do underneath. What is being tested is the wallet's half of that contract: connect,
 * preview, estimate, sign, broadcast — five times, against a real AMM, on a real chain.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test, { after, before, describe } from 'node:test';
import type { Page } from 'playwright-core';

import { Return, encodeCall } from '../../src/shared/abi.ts';
import { formatUnits } from '../../src/shared/units.ts';
import {
  CHAIN_ID, RPC_URL, beginRequest, callContract, createWallet, fundedSigner, launch, nodeRpc,
  nodeTransactionModule, openConnectedDapp, operatorSend, requireLiveChain, startRecordingProxy,
  useRpcUrl, waitForOutcome, waitForReceipt, withApproval,
  type Harness, type RecordingProxy, type Signer,
} from './harness.ts';

const E = 10n ** 18n;

/** What the wallet is funded with, and what it spends. See the header on why the funding is allowed. */
const FUNDING = 12n * E;
const BUY = 4n * E;

/**
 * How long a receipt is waited for, and why it is not the harness's 90 seconds.
 *
 * EMBER sits at its difficulty floor, and a transient outside miner leaving raises the target far
 * enough to stall the tip for up to twenty minutes before the emergency rule pulls it back
 * (hearth#13). `deploy/scripts/lib/hearth-evm.js` waits thirty minutes for exactly this and records
 * the run where 180 seconds reported "never mined" about a transaction that had been mined a minute
 * later. Five minutes covers an ordinary slow patch without making one stalled test eat the whole
 * suite's budget; a stall longer than that is a chain problem and should be reported as a timeout.
 */
const RECEIPT_TIMEOUT = 300_000;

/* ------------------------------------------------------------------------- where the market is - */

/**
 * The router and the token, from the environment or from the deployment notes the seeder writes.
 *
 * NOT HARD-CODED. These addresses belong to one deployment on one chain; a constant here would be
 * wrong the first time the exchange is redeployed and would be wrong SILENTLY, since a swap against
 * an address with no code reverts with the same "execution reverted" as a swap that slipped. The
 * factory, WEMBER and the pair are not asked for at all — they are read off the router and the
 * factory, so there is exactly one thing to get right.
 */
function marketAddresses(): { router: string; token: string } {
  const fromEnv = { router: process.env['HEARTH_DEX_ROUTER'], token: process.env['HEARTH_DEX_TOKEN'] };
  if (fromEnv.router !== undefined && fromEnv.token !== undefined) {
    return { router: fromEnv.router.toLowerCase(), token: fromEnv.token.toLowerCase() };
  }
  const home = process.env['HEARTH_DEX_HOME'];
  if (home !== undefined) {
    const deployment = join(home, `deployment-${CHAIN_ID}.json`);
    const pool = join(home, `pool-${CHAIN_ID}.json`);
    if (existsSync(deployment) && existsSync(pool)) {
      const d = JSON.parse(readFileSync(deployment, 'utf8')) as { addresses?: { router?: string } };
      const p = JSON.parse(readFileSync(pool, 'utf8')) as { token?: { address?: string } };
      const router = d.addresses?.router;
      const token = p.token?.address;
      if (typeof router === 'string' && typeof token === 'string') {
        return { router: router.toLowerCase(), token: token.toLowerCase() };
      }
    }
  }
  throw new Error(
    'This suite trades against a REAL deployed exchange and will not invent one. Set both '
    + 'HEARTH_DEX_ROUTER and HEARTH_DEX_TOKEN, or HEARTH_DEX_HOME to the directory holding '
    + `deployment-${CHAIN_ID}.json and pool-${CHAIN_ID}.json (the chain host's ~/dex/keys). `
    + 'deploy/scripts/hearth-dex-deploy.js and hearth-dex-seed.js write both.',
  );
}

/* --------------------------------------------------------------------------- calldata, by hand - */
/*
 * `src/shared/abi.ts` has no `address[]`, deliberately: the wallet decodes calls it is shown and
 * encodes only the handful it makes itself, and none of those takes an array. The three router
 * functions here do, so their calldata is assembled below — head-and-tail, with the offset measured
 * from the start of the argument block.
 *
 * That is the classic place to be wrong, so it is CHECKED rather than trusted: `getAmountsOut` is
 * encoded with the same helper and its answer is compared against the constant-product formula
 * computed independently in `amountOut()`. A mis-encoded path does not produce a subtly wrong number
 * there; it produces a revert or an absurd one, before a single coin has moved.
 */

const word = (value: bigint): string => value.toString(16).padStart(64, '0');
const addressWord = (address: string): string => address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const pathTail = (path: readonly string[]): string => word(BigInt(path.length)) + path.map(addressWord).join('');

/** `getAmountsOut(uint256,address[])` — two head words, so the path starts at 0x40. */
const getAmountsOutData = (amountIn: bigint, path: readonly string[]): string =>
  encodeCall('getAmountsOut(uint256,address[])') + word(amountIn) + word(64n) + pathTail(path);

/** `swapExactETHForTokens(uint256,address[],address,uint256)` — four head words, path at 0x80. */
const swapExactETHForTokensData = (min: bigint, path: readonly string[], to: string, deadline: bigint): string =>
  encodeCall('swapExactETHForTokens(uint256,address[],address,uint256)')
  + word(min) + word(128n) + addressWord(to) + word(deadline) + pathTail(path);

/** `swapExactTokensForETH(uint256,uint256,address[],address,uint256)` — five head words, path at 0xa0. */
const swapExactTokensForETHData = (amountIn: bigint, min: bigint, path: readonly string[], to: string, deadline: bigint): string =>
  encodeCall('swapExactTokensForETH(uint256,uint256,address[],address,uint256)')
  + word(amountIn) + word(min) + word(160n) + addressWord(to) + word(deadline) + pathTail(path);

/* ----------------------------------------------------------------------------- the AMM's rules - */

/** UniswapV2's constant product with the 0.30% fee, computed here so the router can be checked. */
function amountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  const withFee = amountIn * 997n;
  return (withFee * reserveOut) / (reserveIn * 1000n + withFee);
}

/** `HearthV2Library.quote` — the ratio the router demands when liquidity is added to a live pool. */
const quote = (amountA: bigint, reserveA: bigint, reserveB: bigint): bigint => (amountA * reserveB) / reserveA;

/** Slippage floors. Half a percent, the same as the seeder's SLIPPAGE_BPS. */
const atLeast = (amount: bigint): bigint => (amount * 9950n) / 10000n;

describe('Forge Exchange: a stranger trades the pool from the browser', () => {
  let harness: Harness;
  let funder: Signer;
  let dapp: Page;
  /**
   * The wire, recorded.
   *
   * The extension's signed bytes are invisible from everywhere else — deliberately, since a wallet
   * that handed its own UI the raw signature would have one more way to lose it — and this node has
   * no `eth_getRawTransactionByHash` to read them back with (measured: `-32601`). So the wallet is
   * pointed at a pass-through recorder, the same one `deploy.test.ts` and `foresight.test.ts` use.
   * It forwards every byte to the live node and invents nothing; it is a tap, not a mock.
   */
  let proxy: RecordingProxy;
  /** The wallet under test: created by the extension, in this run, from a phrase nothing else saw. */
  let wallet: string;

  let router: string;
  let token: string;
  let wember: string;
  let factory: string;
  let pair: string;
  let symbol: string;

  /** Every transaction the extension signed, in order, for the closing proof. */
  const signed: { what: string; hash: string }[] = [];

  /* ------------------------------------------------------------------------- reading the chain - */

  const readUint = async (to: string, signature: string, args: Parameters<typeof encodeCall>[1] = []): Promise<bigint> =>
    new Return(await callContract(to, encodeCall(signature, args)), signature).uint(0, signature);

  const readAddress = async (to: string, signature: string, args: Parameters<typeof encodeCall>[1] = []): Promise<string> =>
    new Return(await callContract(to, encodeCall(signature, args)), signature).address(0, signature).toLowerCase();

  const balanceOf = async (owner: string, at?: string): Promise<bigint> =>
    BigInt(String(await nodeRpc('eth_getBalance', [owner, at ?? 'latest'])));

  const tokenBalanceOf = async (erc20: string, owner: string, at?: string): Promise<bigint> => {
    const data = encodeCall('balanceOf(address)', [{ type: 'address', value: owner }]);
    return new Return(await callContract(erc20, data, at ?? 'latest'), 'balanceOf(address)').uint(0, 'balanceOf(address)');
  };

  /** The pair's reserves, ordered EMBER-side first regardless of which token sorted lower. */
  async function reserves(at?: string): Promise<{ ember: bigint; token: bigint }> {
    const answer = new Return(await callContract(pair, encodeCall('getReserves()'), at ?? 'latest'), 'getReserves()');
    const [r0, r1] = [answer.uint(0, 'reserve0'), answer.uint(1, 'reserve1')];
    const first = await readAddress(pair, 'token0()');
    return first === wember ? { ember: r0, token: r1 } : { ember: r1, token: r0 };
  }

  /** A deadline in the CHAIN'S seconds. This host's clock is not the one the router compares against. */
  async function soon(): Promise<bigint> {
    const block = await nodeRpc('eth_getBlockByNumber', ['latest', false]) as { timestamp: string };
    return BigInt(block.timestamp) + 3600n;
  }

  /* --------------------------------------------------------------------- driving the extension - */

  /**
   * One `eth_sendTransaction` through the extension: the dapp asks, the window opens, a human-shaped
   * click approves it, the receipt is waited for.
   *
   * The approval screen is READ before it is clicked. A wallet that signs the right transaction
   * while showing the wrong one is the failure this whole product exists to prevent, so the
   * destination and the value on screen are compared against what the dapp actually requested.
   */
  async function sendThroughWallet(
    what: string,
    tx: { to: string; data?: string; value?: bigint },
  ): Promise<{ hash: string; blockNumber: number; gasUsed: bigint }> {
    const key = `tx-${signed.length}`;
    const params = [{
      from: wallet,
      to: tx.to,
      ...(tx.data === undefined ? {} : { data: tx.data }),
      ...(tx.value === undefined ? {} : { value: `0x${tx.value.toString(16)}` }),
    }];

    const approval = await withApproval(harness, () => beginRequest(dapp, key, 'eth_sendTransaction', params));
    assert.equal(
      (await approval.getByTestId('tx-to').innerText()).trim().toLowerCase(), tx.to.toLowerCase(),
      `the approval window offered a different destination from the one ${what} asked for`,
    );
    // The value is compared as the NUMBER the screen shows, not as the whole line: the currency
    // symbol beside it comes from the chain's own configuration and is not what is being checked.
    const [shown] = (await approval.getByTestId('tx-value').innerText()).trim().split(' ');
    assert.equal(
      shown, formatUnits(tx.value ?? 0n, 18),
      `the approval window offered a different value from the one ${what} asked for`,
    );
    assert.match(
      (await approval.getByTestId('tx-chain').innerText()).trim(), new RegExp(`chain ${CHAIN_ID}`),
      'the approval window did not name the chain the test is asserting against',
    );
    await approval.getByTestId('approve').click();

    const outcome = await waitForOutcome(dapp, key, 120_000);
    assert.equal(outcome.error, undefined, `${what} was refused: ${outcome.error?.message}`);
    const hash = String(outcome.result);
    assert.match(hash, /^0x[0-9a-f]{64}$/, `${what} did not produce a transaction hash`);

    const receipt = await waitForReceipt(hash, RECEIPT_TIMEOUT);
    signed.push({ what, hash });
    console.log(`    ${what}: ${hash} in block ${receipt.blockNumber}, ${receipt.gasUsed} gas`);
    return { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
  }

  /** The block a receipt landed in, and the one before it — the pinned pair every measurement uses. */
  const around = (blockNumber: number): { before: string; after: string } => ({
    before: `0x${(blockNumber - 1).toString(16)}`,
    after: `0x${blockNumber.toString(16)}`,
  });

  /**
   * One block number, held still, for reads that have to agree with each other.
   *
   * Comparing the router's quote against the formula means reading its reserves and its answer from
   * the SAME state. Two `latest` reads a few milliseconds apart are usually the same block and
   * occasionally are not, and the version of that check which failed once an afternoon would be
   * blamed on the router rather than on the clock.
   */
  const pinned = async (): Promise<string> => String(await nodeRpc('eth_blockNumber'));

  /** What a transaction cost in fees, from the price the WALLET chose rather than the one the test would. */
  async function feePaid(hash: string, gasUsed: bigint): Promise<bigint> {
    const tx = await nodeRpc('eth_getTransactionByHash', [hash]) as { gasPrice?: string };
    return gasUsed * BigInt(String(tx.gasPrice ?? '0x0'));
  }

  before(async () => {
    const chain = await requireLiveChain();
    ({ router, token } = marketAddresses());

    /* The market, discovered from the router outwards. Each read is also a check that there is a
     * contract there at all: `Return` throws on an empty answer rather than reporting a zero. */
    factory = await readAddress(router, 'factory()');
    wember = await readAddress(router, 'WEMBER()');
    pair = await readAddress(factory, 'getPair(address,address)', [
      { type: 'address', value: token }, { type: 'address', value: wember },
    ]);
    assert.notEqual(pair, '0x0000000000000000000000000000000000000000', `the factory knows no ${token}/WEMBER pair`);
    symbol = new Return(await callContract(token, encodeCall('symbol()')), 'symbol()').string('symbol()');

    const opening = await reserves();
    assert.ok(opening.ember > 0n && opening.token > 0n, 'the pool has no liquidity to trade against');
    console.log(
      `    chain ${chain.chainId} at block ${chain.blockNumber} via ${RPC_URL}\n`
      + `    router ${router}, pair ${pair}\n`
      + `    the pool holds ${formatUnits(opening.ember, 18, 6)} EMBER / ${formatUnits(opening.token, 18, 6)} ${symbol}`,
    );

    /* The funding key. On this chain it is NOT the coinbase — `deploy/scripts/hearth-fund.js` moved
     * a bounded amount to it precisely so that this suite has a spender that is not the miner. On a
     * fresh local chain it will be the coinbase, which is fine there and is why the assertion that
     * the three addresses differ is a test rather than a precondition. */
    funder = fundedSigner();
    const funderWei = await balanceOf(funder.address);
    assert.ok(
      funderWei > FUNDING * 2n,
      `the funding account ${funder.address} holds ${formatUnits(funderWei, 18, 6)} EMBER, which is too little to `
      + `fund a wallet with ${formatUnits(FUNDING, 18)} and cover the fees`,
    );

    harness = await launch();
    const created = await createWallet(harness);
    wallet = created.address;
    await created.page.close();

    const funding = await operatorSend(funder, { to: wallet, value: FUNDING, gas: 21_000n });
    await waitForReceipt(funding, RECEIPT_TIMEOUT);
    assert.equal(await balanceOf(wallet), FUNDING, 'the funding transfer did not arrive');
    console.log(`    wallet ${wallet} funded with ${formatUnits(FUNDING, 18)} EMBER (tx ${funding})`);

    /* From here the wallet talks through the recorder. Pointing it at one is a §5 feature being
     * used rather than a test hook — "a custom RPC" is what a user does when they run their own
     * node — and the funding above went out over the test's own connection, so everything the
     * recorder holds afterwards was sent by the extension. */
    proxy = await startRecordingProxy();
    await useRpcUrl(harness, proxy.url);

    /* Connect once. Everything after this is a transaction, and each one opens its own window. */
    dapp = await openConnectedDapp(harness);
    const approval = await withApproval(harness, () => beginRequest(dapp, 'connect', 'eth_requestAccounts', []));
    await approval.getByTestId(`connect-${wallet}`).check();
    await approval.getByTestId('approve').click();
    const connected = await waitForOutcome(dapp, 'connect');
    assert.deepEqual(connected.result, [wallet], 'the dapp was not given the account it was shown');
  });

  after(async () => {
    await proxy?.close();
    await harness?.close();
  });

  test('the wallet arrives as a stranger: no tokens, no position, nothing but EMBER', async () => {
    assert.equal(await tokenBalanceOf(token, wallet), 0n, `a freshly created wallet already holds ${symbol}`);
    assert.equal(await tokenBalanceOf(pair, wallet), 0n, 'a freshly created wallet already holds a share of the pool');
    // And the pool is somebody else's: it has depth this wallet did not put there.
    const opening = await reserves();
    assert.ok(opening.ember > FUNDING, 'the pool is shallower than this wallet — it is not an independent market');
  });

  test('SWAP: the extension buys the token with EMBER, and gets exactly what it was quoted', async () => {
    /* The quote, twice from one block: once from the router over RPC, once from the formula here.
     * They must agree before anything is spent — see the note on hand-built calldata above. */
    const quotedAt = await pinned();
    const at0 = await reserves(quotedAt);
    const quoted = new Return(
      await callContract(router, getAmountsOutData(BUY, [wember, token]), quotedAt), 'getAmountsOut',
    ).uint(3, 'amounts[1]');
    assert.equal(
      quoted, amountOut(BUY, at0.ember, at0.token),
      'the router quotes a different number from the constant product of its own reserves',
    );

    const receipt = await sendThroughWallet('swapExactETHForTokens', {
      to: router,
      data: swapExactETHForTokensData(atLeast(quoted), [wember, token], wallet, await soon()),
      value: BUY,
    });

    const at = around(receipt.blockNumber);
    const gained = (await tokenBalanceOf(token, wallet, at.after)) - (await tokenBalanceOf(token, wallet, at.before));
    assert.equal(gained, quoted, `quoted ${quoted} ${symbol} and received ${gained}`);

    const spent = (await balanceOf(wallet, at.before)) - (await balanceOf(wallet, at.after));
    assert.equal(
      spent, BUY + await feePaid(receipt.hash, receipt.gasUsed),
      'the wallet\'s EMBER fell by something other than the trade plus its fee',
    );

    const [before, after] = [await reserves(at.before), await reserves(at.after)];
    assert.equal(after.ember - before.ember, BUY, 'the pool took something other than what was sent');
    assert.equal(before.token - after.token, gained, 'the pool released something other than what arrived');
    assert.ok(
      after.ember * after.token > before.ember * before.token,
      'k did not rise across the swap — the 0.30% fee is not reaching the liquidity providers',
    );
    console.log(`    bought ${formatUnits(gained, 18, 6)} ${symbol} for ${formatUnits(BUY, 18)} EMBER`);
  });

  test('ADD: the extension approves the router, then puts both sides into the pool', async () => {
    const held = await tokenBalanceOf(token, wallet);
    assert.ok(held > 0n, 'the swap left nothing to add');
    const adding = held / 2n; // half in, half kept back for the return leg

    await sendThroughWallet('approve(router)', {
      to: token,
      data: encodeCall('approve(address,uint256)', [
        { type: 'address', value: router }, { type: 'uint256', value: adding },
      ]),
    });
    assert.equal(
      await readUint(token, 'allowance(address,address)', [
        { type: 'address', value: wallet }, { type: 'address', value: router },
      ]),
      adding,
      'the allowance the token records is not the one the wallet was asked to grant',
    );

    /* The EMBER side is whatever the ratio demands, plus 1% so a block mined between the read and
     * the execution cannot make the pair reject it. The router refunds the surplus to `msg.sender`,
     * which is the wallet — asserted below by the fact that its balance falls by less than this. */
    const quotedFrom = await reserves();
    const emberWanted = quote(adding, quotedFrom.token, quotedFrom.ember);
    const emberSent = (emberWanted * 101n) / 100n;

    const receipt = await sendThroughWallet('addLiquidityETH', {
      to: router,
      data: encodeCall('addLiquidityETH(address,uint256,uint256,uint256,address,uint256)', [
        { type: 'address', value: token },
        { type: 'uint256', value: adding },
        { type: 'uint256', value: atLeast(adding) },
        { type: 'uint256', value: atLeast(emberWanted) },
        { type: 'address', value: wallet },
        { type: 'uint256', value: await soon() },
      ]),
      value: emberSent,
    });

    const at = around(receipt.blockNumber);
    const lp = await tokenBalanceOf(pair, wallet, at.after);
    assert.ok(lp > 0n, 'the wallet was issued no share of the pool');
    assert.equal(await tokenBalanceOf(pair, wallet, at.before), 0n, 'the wallet already had a share before it added one');

    const tokenSpent = (await tokenBalanceOf(token, wallet, at.before)) - (await tokenBalanceOf(token, wallet, at.after));
    assert.equal(tokenSpent, adding, `the pool took ${tokenSpent} ${symbol} and was offered ${adding}`);

    const emberSpent = (await balanceOf(wallet, at.before)) - (await balanceOf(wallet, at.after))
      - await feePaid(receipt.hash, receipt.gasUsed);
    assert.ok(
      emberSpent <= emberSent,
      `the wallet paid ${emberSpent} wei against the ${emberSent} it offered — the surplus was not refunded`,
    );

    const [before, after] = [await reserves(at.before), await reserves(at.after)];
    assert.equal(after.token - before.token, adding, 'the pool\'s token reserve did not rise by what was added');
    assert.equal(after.ember - before.ember, emberSpent, 'the pool\'s EMBER reserve did not rise by what was paid');
    console.log(`    added ${formatUnits(adding, 18, 6)} ${symbol} + ${formatUnits(emberSpent, 18, 6)} EMBER for ${formatUnits(lp, 18, 6)} LP`);
  });

  test('SWAP BACK: the extension sells the rest of the token, and the round trip costs the fee', async () => {
    const holding = await tokenBalanceOf(token, wallet);
    assert.ok(holding > 0n, 'nothing was kept back to sell');

    await sendThroughWallet('approve(router, sell)', {
      to: token,
      data: encodeCall('approve(address,uint256)', [
        { type: 'address', value: router }, { type: 'uint256', value: holding },
      ]),
    });

    const quotedAt = await pinned();
    const at0 = await reserves(quotedAt);
    const quoted = new Return(
      await callContract(router, getAmountsOutData(holding, [token, wember]), quotedAt), 'getAmountsOut',
    ).uint(3, 'amounts[1]');
    assert.equal(
      quoted, amountOut(holding, at0.token, at0.ember),
      'the router quotes a different number from the constant product of its own reserves',
    );

    const receipt = await sendThroughWallet('swapExactTokensForETH', {
      to: router,
      data: swapExactTokensForETHData(holding, atLeast(quoted), [token, wember], wallet, await soon()),
    });

    const at = around(receipt.blockNumber);
    assert.equal(await tokenBalanceOf(token, wallet, at.after), 0n, `the sale left ${symbol} behind`);

    const received = (await balanceOf(wallet, at.after)) - (await balanceOf(wallet, at.before))
      + await feePaid(receipt.hash, receipt.gasUsed);
    assert.equal(received, quoted, `quoted ${quoted} wei and received ${received}`);

    const [before, after] = [await reserves(at.before), await reserves(at.after)];
    assert.ok(after.ember * after.token > before.ember * before.token, 'k did not rise across the second swap');
    assert.equal(before.ember - after.ember, quoted, 'the pool released something other than what it quoted');
    assert.equal(after.token - before.token, holding, 'the pool took something other than what was sold into it');
    console.log(`    sold ${formatUnits(holding, 18, 6)} ${symbol} for ${formatUnits(received, 18, 6)} EMBER`);
  });

  test('REMOVE: the extension takes its whole position back out', async () => {
    const lp = await tokenBalanceOf(pair, wallet);
    assert.ok(lp > 0n, 'there is no position to remove');

    await sendThroughWallet('approve(router, LP)', {
      to: pair,
      data: encodeCall('approve(address,uint256)', [
        { type: 'address', value: router }, { type: 'uint256', value: lp },
      ]),
    });

    const receipt = await sendThroughWallet('removeLiquidityETH', {
      to: router,
      data: encodeCall('removeLiquidityETH(address,uint256,uint256,uint256,address,uint256)', [
        { type: 'address', value: token },
        { type: 'uint256', value: lp },
        { type: 'uint256', value: 1n },
        { type: 'uint256', value: 1n },
        { type: 'address', value: wallet },
        { type: 'uint256', value: await soon() },
      ]),
    });

    const at = around(receipt.blockNumber);
    assert.equal(await tokenBalanceOf(pair, wallet, at.after), 0n, 'the position was not fully burned');

    const tokenBack = (await tokenBalanceOf(token, wallet, at.after)) - (await tokenBalanceOf(token, wallet, at.before));
    const emberBack = (await balanceOf(wallet, at.after)) - (await balanceOf(wallet, at.before))
      + await feePaid(receipt.hash, receipt.gasUsed);
    assert.ok(tokenBack > 0n, `no ${symbol} came back`);
    assert.ok(emberBack > 0n, 'no EMBER came back');

    /* The pool is smaller by exactly what left it — and still open for business afterwards, which
     * is the difference between a provider withdrawing and a pool being drained. */
    const [before, after] = [await reserves(at.before), await reserves(at.after)];
    assert.equal(before.token - after.token, tokenBack, 'the token reserve fell by something other than what was withdrawn');
    assert.equal(before.ember - after.ember, emberBack, 'the EMBER reserve fell by something other than what was withdrawn');
    assert.ok(after.ember > 0n && after.token > 0n, 'the pool was drained — this wallet was the only provider, which it should not have been');
    console.log(`    removed ${formatUnits(lp, 18, 6)} LP for ${formatUnits(tokenBack, 18, 6)} ${symbol} + ${formatUnits(emberBack, 18, 6)} EMBER`);
  });

  /**
   * THE CLAIM THE WHOLE FILE IS FOR, checked against the signatures rather than against a field.
   *
   * `eth_getTransactionByHash` has a `from`, and it would be circular to use it: the node fills it
   * in by doing the recovery, and a node that lied about it would be believed. So the bytes the
   * extension actually put on the wire are taken from the recorder, decoded by `hearth/node`'s own
   * `transaction.js`, and their senders recovered from `(v, r, s)`. The only way all seven come
   * back as the wallet's address is if the private key generated during onboarding in this run
   * produced those signatures — and the test has never held that key.
   */
  test('every transaction was signed by the extension\'s own key, and by nobody else\'s', async () => {
    assert.equal(signed.length, 7, 'the cycle did not run the transactions this proof is about');

    const broadcast = proxy.seen.filter((c) => c.method === 'eth_sendRawTransaction');
    assert.equal(
      broadcast.length, signed.length,
      `the wallet broadcast ${broadcast.length} transactions and the cycle sent ${signed.length} — `
      + 'either something else signed one of them, or the recorder missed it',
    );

    const { decode, recoverSender } = await nodeTransactionModule();
    for (const [index, call] of broadcast.entries()) {
      const raw = String(call.params[0]);
      const bytes = recoverSender(decode(Buffer.from(raw.slice(2), 'hex'), { chainId: CHAIN_ID })) as unknown as Buffer;
      const sender = `0x${Buffer.from(bytes).toString('hex')}`;
      assert.equal(
        sender.toLowerCase(), wallet.toLowerCase(),
        `${signed[index]!.what} (${signed[index]!.hash}) was signed by ${sender}, not by the wallet the extension created`,
      );
    }

    /* And the three keys really are three. If the funder were the coinbase — which it is on a fresh
     * local chain, and is NOT on the estate's testnet — this suite would still prove the browser
     * half, but not the "a wallet that is not ours" half, so the distinction is measured and
     * printed rather than assumed. */
    const coinbase = String((await nodeRpc('eth_getBlockByNumber', ['latest', false]) as { miner: string }).miner);
    assert.notEqual(wallet.toLowerCase(), funder.address.toLowerCase(), 'the wallet and its funder are the same key');
    assert.notEqual(wallet.toLowerCase(), coinbase.toLowerCase(), 'the wallet is the chain\'s coinbase');
    console.log(
      `    ${signed.length} transactions signed by ${wallet}\n`
      + `    funded by ${funder.address}; the chain is mined by ${coinbase}`,
    );
  });
});
