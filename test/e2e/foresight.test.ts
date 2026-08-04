/* Phase 5, on the live chain: read a position, stake, claim — with no CloudsForge service involved.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS FILE PROVES, AND HOW IT AVOIDS PROVING IT BY ACCIDENT.
 *
 * §5.1's property is "positions survive the platform": if every CloudsForge service were switched
 * off, a user could still see their stake and still claim. So:
 *
 *   - The market is a REAL ForesightMarket, deployed to chain 7412 from micro-foresight's own
 *     committed bytecode. Not a mock, not a stub, not a fixture.
 *   - The wallet is never told what it holds. It reads `stakeOf`, `payoutOf`, `oddsBps`, `pool`,
 *     `total` and the rest off the contract, and this test checks each number against a direct
 *     JSON-RPC call it makes itself.
 *   - The Foresight API is NEVER CONFIGURED for the read-and-stake path — `foresightApiUrl`
 *     defaults to null, which is the shipped default, so the absent-API path is the one every user
 *     is on. One test then points discovery at a genuinely dead port and drives the same flow to
 *     completion, so the absence is exercised rather than assumed.
 *   - EVERY CLAIM IS VERIFIED POSITIVELY. A receipt with `status: 1`; `stakeOf` read back off the
 *     chain; the sender recovered from the signed bytes by `hearth/node`'s own decoder; a balance
 *     that moved by exactly the arithmetic the contract specifies. The phase-2 agent measured that
 *     this node's refusals are byte-identical for different causes, so an absence of error on a
 *     screen is not evidence of anything and is never used as evidence here.
 *
 * MARKET CREATION AND RESOLUTION ARE DONE BY THE TEST, NOT BY THE WALLET. §5.1 excludes both from
 * the wallet deliberately, so the test plays the operator with the node's own coinbase key. If a
 * line below ever drives market creation through the extension, that exclusion has been broken.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import type { Page } from 'playwright-core';

import { encodeArgs, encodeCall, Return } from '../../src/shared/abi.ts';
import { MARKET_SIGNATURES } from '../../src/shared/foresight.ts';
import {
  CHAIN_ID, RPC_URL, callContract, createWallet, foresightMarketBytecode, fundedSigner, launch,
  nodeRpc, nodeTransactionModule, openPopup, operatorSend, requireLiveChain, startRecordingProxy,
  useRpcUrl, waitForReceipt, type Harness, type Signer,
} from './harness.ts';

const E = 10n ** 18n;
const STAKE = E; // 1 EMBER
const FEE_BPS = 200n;

/**
 * How long the market stays open, measured in the CHAIN'S seconds.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * THIS NUMBER AND ITS CLOCK MADE CI RED, AND THEN MADE THE LOCAL RUN RED THE OTHER WAY.
 *
 * `ForesightMarket` compares `closeTime` against `block.timestamp`, so the deadline is in CHAIN
 * time — but every wait the suite performs is in WALL time, and on Hearth the two do not run at the
 * same speed. Measured on the estate node over a minute: the chain clock advanced 53 seconds while
 * 60 passed, a rate of 0.88x, and the tip sat 5–28 seconds behind the wall clock as blocks were
 * sealed. On CI's node, which mines at HEARTH_THROTTLE=0.9, the tip was about 59 seconds behind.
 *
 * Both failures came from that gap, from opposite directions:
 *
 *   - Anchoring to the tip alone gave a 100-second window that was only 41 real seconds on CI,
 *     because the tip started 59 seconds in the past. The market expired mid-suite.
 *   - Anchoring to wall time instead made the deadline one the chain reaches LATE — 300 wall
 *     seconds is about 264 chain seconds — so the claim test waited out its whole budget and the
 *     chain still had not got there.
 *
 * What is correct is what the contract itself uses: chain time, with the tip as the floor the
 * constructor demands (`closeTime_ <= block.timestamp` reverts) and wall time as a second floor so
 * a tip briefly ahead of the clock cannot shorten the window. The SIZE is then chosen in chain
 * seconds against the wall-clock work it has to cover, converted at the observed rate:
 *
 *     tests 1 and 2 cost at most 169s of wall time (measured against a throttled node)
 *     169s of wall time is about 149 chain seconds at 0.88x
 *     240 chain seconds leaves roughly 60% margin over that
 *
 * Sizing it larger is not free: the claim test spends whatever is left of the window waiting, so
 * every extra second here is a second the suite sits idle on a fast machine.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */
const OPEN_FOR_SECONDS = 240;

describe('Foresight: a position that survives the platform', () => {
  let harness: Harness;
  let operator: Signer;
  let wallet: string;
  let market: string;
  let closeTime: number;

  before(async () => {
    const chain = await requireLiveChain();
    operator = fundedSigner();

    const operatorWei = BigInt(String(await nodeRpc('eth_getBalance', [operator.address, 'latest'])));
    assert.ok(operatorWei > 10n * E, `the operator account ${operator.address} holds ${operatorWei} wei — too little to run this suite`);
    console.log(`    chain ${chain.chainId} at block ${chain.blockNumber}; operator ${operator.address} holds ${operatorWei / E} EMBER`);

    harness = await launch();

    // A wallet created through the REAL onboarding, then funded. The funding is an ordinary
    // transfer from the operator — the wallet signs everything it does itself from here on.
    const created = await createWallet(harness);
    wallet = created.address;
    await created.page.close();

    const funding = await operatorSend(operator, { to: wallet, value: 5n * E, gas: 21_000n });
    await waitForReceipt(funding);
    const walletWei = BigInt(String(await nodeRpc('eth_getBalance', [wallet, 'latest'])));
    assert.equal(walletWei, 5n * E, 'the funding transfer did not arrive');
    console.log(`    wallet ${wallet} funded with 5 EMBER (tx ${funding})`);

    /* ------------------------------------------------------------------ the operator's market -- */
    //
    // `constructor(address oracle_, address treasury_, bytes32 questionHash_, uint64 closeTime_,
    //  uint64 disputeWindowSeconds_, uint16 feeBps_)`. The dispute window is zero so the suite can
    // claim as soon as the market resolves; micro-foresight's own live markets use zero too.
    //
    // Incidentally this exercises `bytes32`, `uint64` and `uint16` in the wallet's ABI encoder
    // against a REAL Solidity constructor — the three types micro-mint's encoder does not have, so
    // test/abi.test.ts's differential cannot cover them. A wrong layout here reverts the creation.
    const tip = await nodeRpc('eth_getBlockByNumber', ['latest', false]) as { timestamp: string };
    const tipSeconds = Number(BigInt(tip.timestamp));
    const nowSeconds = Math.floor(Date.now() / 1000);
    // See OPEN_FOR_SECONDS. The tip is the floor the constructor demands; wall time is what the
    // suite actually spends. Whichever is later wins.
    closeTime = Math.max(tipSeconds, nowSeconds) + OPEN_FOR_SECONDS;
    console.log(`    chain tip is ${nowSeconds - tipSeconds}s behind the wall clock; the market will be open for ${closeTime - nowSeconds}s of real time`);
    const questionHash = `0x${'7c'.repeat(32)}`;

    const creation = foresightMarketBytecode() + Buffer.from(encodeArgs([
      { type: 'address', value: operator.address.toLowerCase() },
      { type: 'address', value: operator.address.toLowerCase() },
      { type: 'bytes32', value: questionHash },
      { type: 'uint64', value: BigInt(closeTime) },
      { type: 'uint64', value: 0n },
      { type: 'uint16', value: FEE_BPS },
    ])).toString('hex');

    const deployHash = await operatorSend(operator, { to: null, data: creation, gas: 4_000_000n });
    const receipt = await waitForReceipt(deployHash);
    assert.notEqual(receipt.contractAddress, null, 'the market creation produced no contract address');
    market = receipt.contractAddress!;

    // Verify positively: there is CODE there, and it answers a ForesightMarket view.
    const code = String(await nodeRpc('eth_getCode', [market, 'latest']));
    assert.ok(code.length > 1000, `no contract code at ${market}`);
    const status = new Return(await callContract(market, encodeCall(MARKET_SIGNATURES.status)), 'status()').small(0, 8, 'status()');
    assert.equal(status, 0, 'the freshly deployed market is not Open');
    console.log(`    MARKET DEPLOYED: ${market} on chain ${CHAIN_ID}, closes at ${new Date(closeTime * 1000).toISOString()} (tx ${deployHash})`);
  });

  after(async () => { await harness?.close(); });

  /**
   * The fixture is still what the next assertions assume it is.
   *
   * ──────────────────────────────────────────────────────────────────────────────────────────────
   * WHY THIS EXISTS. When the market expired mid-suite, it presented as `locator.waitFor: Timeout
   * 45000ms exceeded waiting for market-status` and, one test later, as a position reading
   * `0 EMBER`. Both look exactly like a broken contract call, and neither says the one thing that
   * was actually true: the market had closed. Three rounds of diagnosis went into a fact this
   * single call would have named in one line.
   *
   * It reads `status()` and `closeTime()` DIRECTLY — the test's own witness over TCP, not through
   * the extension — so it is checking the fixture rather than the subject. A failure here means the
   * test setup is wrong; a failure after it means the wallet is.
   * ────────────────────────────────────────────────────────────────────────────────────────────── */

  /**
   * Wait for the market view to finish reading, and report a READ ERROR as itself.
   *
   * The view renders `market-status` on success and `market-read-error` on failure, and waiting
   * only for the first means any failure presents as a 45-second timeout with nothing to read. CI
   * spent two rounds on exactly that. Racing the two turns "the wallet could not read the contract,
   * and here is what it said" into a first-class outcome.
   *
   * The bound is generous because it covers a cold MV3 worker, a 600,000-iteration unlock and a
   * node mining at HEARTH_THROTTLE=0.9 — the first read was measured at 31s in that shape.
   */
  async function awaitMarketRead(popup: Page, timeout = 120_000): Promise<void> {
    const ok = popup.getByTestId('market-status').waitFor({ timeout }).then(() => 'ok' as const);
    const bad = popup.getByTestId('market-read-error').waitFor({ timeout }).then(() => 'error' as const);
    const which = await Promise.race([ok, bad]).catch((cause: unknown) => {
      throw new Error(`the market view neither read the contract nor reported an error within ${timeout}ms: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
    if (which === 'error') {
      throw new Error(`the wallet could not read ${market}: ${(await popup.getByTestId('market-read-error').innerText()).trim()}`);
    }
  }

  async function assertMarketStillOpen(what: string): Promise<void> {
    const status = new Return(
      await callContract(market, encodeCall(MARKET_SIGNATURES.status)), 'status()',
    ).small(0, 8, 'status()');
    const block = await nodeRpc('eth_getBlockByNumber', ['latest', false]) as { timestamp: string };
    const chainNow = Number(BigInt(block.timestamp));
    if (status !== 0 || chainNow >= closeTime) {
      throw new Error(
        `THE FIXTURE EXPIRED BEFORE "${what}" COULD RUN — this is a defect in the test setup, not in the wallet.\n`
        + `  market ${market} status()=${status} (0=Open 1=Resolved 2=Void)\n`
        + `  closeTime=${closeTime} (${new Date(closeTime * 1000).toISOString()})\n`
        + `  chain clock=${chainNow} (${new Date(chainNow * 1000).toISOString()}), ${chainNow - closeTime}s past close\n`
        + `  wall clock=${Math.floor(Date.now() / 1000)}\n`
        + 'Raise OPEN_FOR_SECONDS: the suite spent longer before this point than the market was open for.',
      );
    }
  }

  /* ---------------------------------------------------------------------------------- reading - */

  test('the wallet reads the market off the chain, with no Foresight API configured', async () => {
    await assertMarketStillOpen('the wallet reads the market off the chain');
    const popup = await openPopup(harness);

    // The shipped default. Asserting it rather than setting it: if this ever ships as anything
    // else, every claim in this file about the absent-API path is void.
    const configured = await popup.evaluate(async () => {
      const got = await chrome.storage.local.get('settings') as { settings?: { foresightApiUrl?: unknown } };
      return got.settings?.foresightApiUrl ?? null;
    });
    assert.equal(configured, null, 'this build ships with a Foresight endpoint configured by default');

    await popup.getByTestId('tab-markets').click();
    await popup.getByTestId('discovery-note').waitFor({ timeout: 15_000 });
    const note = await popup.getByTestId('discovery-note').innerText();
    assert.match(note, /Off — this wallet is talking only to the chain/);
    assert.match(note, /Paste a market’s contract address below and everything works/);

    await popup.getByTestId('market-address').fill(market);
    await popup.getByTestId('market-open').click();
    await awaitMarketRead(popup);

    assert.equal((await popup.getByTestId('market-shown-address').innerText()).trim().toLowerCase(), market.toLowerCase());
    assert.equal((await popup.getByTestId('market-status').innerText()).trim(), 'open');

    // The independent witness: the same views, read by this process over TCP.
    const total = new Return(await callContract(market, encodeCall(MARKET_SIGNATURES.total)), 'total()').uint(0, 'total()');
    assert.equal(total, 0n, 'a fresh market already has a pool');
    assert.match(await popup.getByTestId('pool-total').innerText(), /^0 EMBER$/);
    assert.match(await popup.getByTestId('my-yes').innerText(), /^0 EMBER$/);

    // The chain holds a HASH, not a question, and the screen says so rather than showing a blank.
    const shownHash = (await popup.getByTestId('market-question-hash').innerText()).trim();
    assert.equal(shownHash, `0x${'7c'.repeat(32)}`);
    const body = await popup.locator('main').innerText();
    assert.match(body, /The contract stores only this hash/);
    assert.match(body, /will not invent them/);

    await popup.close();
  });

  /* ----------------------------------------------------------------------------------- staking */

  test('a stake is signed locally, lands on chain, and stakeOf says so afterwards', async () => {
    await assertMarketStillOpen('a stake is signed locally');
    const proxy = await startRecordingProxy();
    try {
      // The user's "custom RPC" (§5), used here so the test can see the raw signed bytes. Every
      // byte is still forwarded to the live node; nothing is answered locally.
      await useRpcUrl(harness, proxy.url);

      const popup = await openPopup(harness);
      await popup.getByTestId('tab-markets').click();
      await popup.getByTestId(`market-${market}`).click();
      await awaitMarketRead(popup);

      await popup.getByTestId('stake-yes').click();
      await popup.getByTestId('stake-amount').fill('1');
      await popup.getByTestId('stake-preview').click();
      await popup.getByTestId('stake-projection').waitFor({ timeout: 120_000 });

      /* -------------------------------------------------------- the confirmation states honestly */
      //
      // §5.1: "the confirmation screen states the pool as observed and does not imply the displayed
      // odds are the settled ones. A wallet that shows a fixed payout on a parimutuel is lying,
      // cheerfully." These assertions are the wording being load-bearing.
      const caveat = await popup.getByTestId('projection-caveat').innerText();
      assert.match(caveat, /This is not a payout/);
      assert.match(caveat, /not a payout, a quote or a guarantee/);
      assert.match(caveat, /Every stake after this one/);
      assert.match(caveat, /can go down as well as up/);

      const projectionPanel = await popup.getByTestId('stake-projection').innerText();
      assert.match(projectionPanel, /If it settled YES at this exact pool/);
      assert.doesNotMatch(projectionPanel, /you will receive|payout of|guaranteed/i);

      // The block is named, and it is a real recent block rather than a placeholder.
      const blockLine = await popup.getByTestId('projection-block').innerText();
      const blockMatch = /read at block (\d+)/.exec(blockLine);
      assert.notEqual(blockMatch, null, `the projection did not name its block: ${blockLine}`);
      const tip = Number(BigInt(String(await nodeRpc('eth_blockNumber'))));
      assert.ok(tip - Number(blockMatch![1]) <= 20, `the projection quotes block ${blockMatch![1]} but the chain is at ${tip}`);

      // Staking into an empty market: the odds go from 0% to 100%, and the share is the stake.
      assert.equal((await popup.getByTestId('projection-odds-before').innerText()).trim(), '0%');
      assert.equal((await popup.getByTestId('projection-odds-after').innerText()).trim(), '100%');
      assert.match(await popup.getByTestId('projection-share').innerText(), /^1 EMBER$/);

      /* ------------------------------------------------------------------------------ the stake */
      const balanceBefore = BigInt(String(await nodeRpc('eth_getBalance', [wallet, 'latest'])));
      await popup.getByTestId('stake-submit').click();
      await popup.getByTestId('stake-hash').waitFor({ timeout: 120_000 });
      const hash = (await popup.getByTestId('stake-hash').innerText()).trim();
      assert.match(hash, /^0x[0-9a-f]{64}$/);

      const receipt = await waitForReceipt(hash);
      console.log(`    STAKE MINED: ${hash} in block ${receipt.blockNumber}, ${receipt.gasUsed} gas`);

      /* -------------------------------------------------------------------- verified positively */

      // 1. The Hearth node's OWN decoder recovers this wallet's address from the signature. A
      //    corrupted signature would recover to a different address, and the node's refusal for
      //    that is byte-identical to several others — so this is checked rather than inferred.
      const broadcast = proxy.seen.filter((c) => c.method === 'eth_sendRawTransaction');
      assert.equal(broadcast.length, 1, `expected one broadcast, saw ${broadcast.length}`);
      const raw = String(broadcast[0]!.params[0]);
      const { decode, recoverSender } = await nodeTransactionModule();
      const recovered = `0x${Buffer.from(recoverSender(decode(Buffer.from(raw.slice(2), 'hex'), { chainId: CHAIN_ID })) as unknown as Buffer).toString('hex')}`;
      assert.equal(recovered.toLowerCase(), wallet.toLowerCase(), 'hearth/node recovered a different sender from this signature');
      console.log(`    hearth/node recovered ${recovered} from the stake's signature`);

      // 2. The contract's own storage. This is the position, and it is the whole point.
      const stakes = new Return(
        await callContract(market, encodeCall(MARKET_SIGNATURES.stakeOf, [{ type: 'address', value: wallet.toLowerCase() }])),
        'stakeOf()',
      );
      assert.equal(stakes.uint(0, 'yes'), STAKE, 'the contract does not hold this wallet\'s stake on YES');
      assert.equal(stakes.uint(1, 'no'), 0n);
      const poolYes = new Return(await callContract(market, encodeCall(MARKET_SIGNATURES.pool, [{ type: 'uint256', value: 0n }])), 'pool(0)').uint(0, 'pool');
      assert.equal(poolYes, STAKE);
      console.log(`    stakeOf(${wallet}) = ${STAKE} wei on YES, read from ${market}`);

      // 3. The money left the account: exactly the stake plus the fee actually charged.
      const balanceAfter = BigInt(String(await nodeRpc('eth_getBalance', [wallet, 'latest'])));
      const gasPrice = BigInt(String((await nodeRpc('eth_getTransactionByHash', [hash]) as { gasPrice: string }).gasPrice));
      assert.equal(balanceAfter, balanceBefore - STAKE - receipt.gasUsed * gasPrice, 'the balance did not move by exactly stake + fee');

      // 4. Nothing but JSON-RPC left the extension. Every call the wallet made went through the
      //    proxy, and the methods are all reads plus one broadcast — no CloudsForge endpoint.
      const methods = new Set(proxy.seen.map((c) => c.method));
      assert.ok(methods.has('eth_call'), 'the wallet never called the contract');
      for (const method of methods) {
        assert.match(method, /^(eth_|web3_|net_)/, `the wallet made a non-JSON-RPC call: ${method}`);
      }

      // 5. And the screen now shows the position the chain holds.
      await popup.getByTestId('stake-again').click();
      // WAIT FOR THE VALUE, NOT THE ELEMENT. `my-yes` is already on screen showing the PRE-stake
      // position, so `waitFor` on it returns instantly and reads 0 EMBER — the same "present in two
      // states" race that the discovery panel had, caught here on a fast node where the test
      // outruns the re-read. Polling the text is the only wait that means what it says.
      await popup.waitForFunction(
        () => document.querySelector('[data-testid="my-yes"]')?.textContent?.trim() === '1 EMBER',
        undefined,
        { timeout: 120_000 },
      );
      assert.match(await popup.getByTestId('my-yes').innerText(), /^1 EMBER$/);
      assert.equal((await popup.getByTestId('odds-yes').innerText()).trim(), '100%');

      await popup.close();
    } finally {
      await useRpcUrl(harness, RPC_URL);
      await proxy.close();
    }
  });

  /* --------------------------------------------------- the API's absence, actually exercised --- */

  test('with the directory pointed at a dead endpoint, the position still reads in full', async () => {
    // NO `assertMarketStillOpen` HERE, deliberately. This test's subject is that a POSITION reads
    // when the directory is down, and a position does not stop existing when a market closes —
    // that is the whole point of §5.1. Requiring the market to still be open coupled this test to
    // the fixture's timer for no reason, and it duly failed on a throttled node after the two tests
    // before it had spent the window. What replaces the coupling is stronger, not weaker: the
    // status the wallet shows is compared against the status the CHAIN reports at that moment,
    // whatever it happens to be.
    // A REAL dead port: bound to reserve it, then released. `discoverMarkets` will get an actual
    // connection refusal, not a rejection a test wrote.
    const { createServer } = await import('node:http');
    const server = createServer(() => undefined);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
    const deadPort = (server.address() as { port: number }).port;
    await new Promise<void>((done) => server.close(() => done()));
    const deadUrl = `http://127.0.0.1:${deadPort}`;

    const popup = await openPopup(harness);
    await popup.getByTestId('tab-settings').click();
    await popup.getByTestId('discovery-url').fill(deadUrl);
    await popup.getByTestId('discovery-save').click();

    await popup.getByTestId('tab-markets').click();
    await popup.getByTestId('discovery-note').waitFor({ timeout: 20_000 });
    const note = await popup.getByTestId('discovery-note').innerText();
    assert.match(note, /The directory is not answering/);
    assert.match(note, /Could not reach the directory/);
    // The sentence that makes it survivable, and the claim this whole test exists to check.
    assert.match(note, /paste a market’s contract address and your position, the pool, staking and claiming all still work/);

    // …and it does. The full position, read with the directory down.
    await popup.getByTestId(`market-${market}`).click();
    await awaitMarketRead(popup);
    assert.match(await popup.getByTestId('my-yes').innerText(), /^1 EMBER$/);
    assert.match(await popup.getByTestId('pool-total').innerText(), /^1 EMBER$/);

    // The wallet's status against the chain's, read independently over TCP. Hardcoding 'open' here
    // asserted the fixture; this asserts the wallet.
    const chainStatus = new Return(
      await callContract(market, encodeCall(MARKET_SIGNATURES.status)), 'status()',
    ).small(0, 8, 'status()');
    assert.equal(
      (await popup.getByTestId('market-status').innerText()).trim(),
      (['open', 'resolved', 'void'] as const)[chainStatus],
      'the wallet and the chain disagree about this market\'s status while the directory is down',
    );

    const witness = new Return(
      await callContract(market, encodeCall(MARKET_SIGNATURES.stakeOf, [{ type: 'address', value: wallet.toLowerCase() }])),
      'stakeOf()',
    ).uint(0, 'yes');
    assert.equal(witness, STAKE, 'the wallet and the chain disagree while the directory is down');
    console.log(`    directory at ${deadUrl} is dead; the wallet read ${witness} wei of position anyway`);

    // Put it back to the shipped default so no later test inherits a configured endpoint.
    await popup.getByTestId('tab-settings').click();
    await popup.getByTestId('discovery-url').fill('');
    await popup.getByTestId('discovery-save').click();
    await popup.close();
  });

  /* ---------------------------------------------------------------------------------- claiming */

  test('after the oracle resolves, the wallet claims — and the money arrives', async () => {
    // Wait for the contract's own clock to pass close. `oracleAct` refuses to resolve an open
    // market (:239), which is the rule that stops a resolver staking on the answer.
    // The budget is the window divided by the SLOWEST rate worth tolerating, not the window itself:
    // the chain clock runs behind wall time, so waiting `OPEN_FOR_SECONDS` of wall time is never
    // enough. 0.5x is half the measured 0.88x, which is generous without being unbounded.
    const until = Date.now() + ((OPEN_FOR_SECONDS / 0.5) + 120) * 1000;
    const startedAt = Date.now();
    const firstTs = Number(BigInt((await nodeRpc('eth_getBlockByNumber', ['latest', false]) as { timestamp: string }).timestamp));
    for (;;) {
      const block = await nodeRpc('eth_getBlockByNumber', ['latest', false]) as { timestamp: string; number: string };
      const chainNow = Number(BigInt(block.timestamp));
      if (chainNow >= closeTime) break;
      if (Date.now() > until) {
        // Legible rather than "it did not happen": the rate is the fact that explains it.
        const wallElapsed = (Date.now() - startedAt) / 1000;
        throw new Error(
          `The chain never reached the market's close time.\n`
          + `  closeTime      ${closeTime} (${new Date(closeTime * 1000).toISOString()})\n`
          + `  chain clock    ${chainNow}, still ${closeTime - chainNow}s short\n`
          + `  waited         ${wallElapsed.toFixed(0)}s of wall time, in which the chain clock advanced ${chainNow - firstTs}s\n`
          + `  observed rate  ${((chainNow - firstTs) / wallElapsed).toFixed(2)}x wall time\n`
          + 'The chain is running slower than this budget assumes. Lower OPEN_FOR_SECONDS or raise the divisor.',
        );
      }
      await new Promise((done) => setTimeout(done, 2000));
    }

    // The OPERATOR resolves, not the wallet. Action 0 is ACTION_RESOLVE_YES.
    const resolveHash = await operatorSend(operator, {
      to: market,
      data: encodeCall('oracleAct(uint8,uint64)', [{ type: 'uint8', value: 0n }, { type: 'uint64', value: 0n }]),
      gas: 300_000n,
    });
    await waitForReceipt(resolveHash);
    const status = new Return(await callContract(market, encodeCall(MARKET_SIGNATURES.status)), 'status()').small(0, 8, 'status()');
    assert.equal(status, 1, 'the market did not reach Resolved');
    console.log(`    market resolved YES by the operator (tx ${resolveHash})`);

    // What the contract says it owes, before the wallet is asked.
    const owed = new Return(
      await callContract(market, encodeCall(MARKET_SIGNATURES.payoutOf, [{ type: 'address', value: wallet.toLowerCase() }])),
      'payoutOf()',
    ).uint(0, 'payoutOf');
    // Only staker, empty losing pool: the fee is 2% of nothing, so the whole stake comes back.
    assert.equal(owed, STAKE, `the contract owes ${owed}, not the ${STAKE} staked`);

    const popup = await openPopup(harness);
    await popup.getByTestId('tab-markets').click();
    await popup.getByTestId(`market-${market}`).click();
    await awaitMarketRead(popup);
    assert.equal((await popup.getByTestId('market-status').innerText()).trim(), 'resolved');
    assert.match(await popup.getByTestId('market-outcome').innerText(), /Resolved YES/);
    assert.match(await popup.getByTestId('my-payout').innerText(), /^1 EMBER$/);

    // The sentence that is the whole point of the phase.
    assert.match(
      await popup.getByTestId('claim-available').innerText(),
      /if every CloudsForge service were switched off right now, this\s+button would still work/,
    );

    const before = BigInt(String(await nodeRpc('eth_getBalance', [wallet, 'latest'])));
    await popup.getByTestId('claim-preview').click();
    await popup.getByTestId('claim-submit').waitFor({ timeout: 120_000 });
    await popup.getByTestId('claim-submit').click();
    await popup.getByTestId('claim-hash').waitFor({ timeout: 120_000 });
    const hash = (await popup.getByTestId('claim-hash').innerText()).trim();

    const receipt = await waitForReceipt(hash);
    const gasPrice = BigInt(String((await nodeRpc('eth_getTransactionByHash', [hash]) as { gasPrice: string }).gasPrice));
    const after = BigInt(String(await nodeRpc('eth_getBalance', [wallet, 'latest'])));

    // VERIFIED POSITIVELY, three ways.
    assert.equal(after, before + owed - receipt.gasUsed * gasPrice, 'the balance did not move by exactly the payout less the fee');
    const claimed = new Return(
      await callContract(market, encodeCall(MARKET_SIGNATURES.claimed, [{ type: 'address', value: wallet.toLowerCase() }])),
      'claimed()',
    ).bool(0, 'claimed()');
    assert.equal(claimed, true, 'the contract does not record this address as having claimed');
    const stillOwed = new Return(
      await callContract(market, encodeCall(MARKET_SIGNATURES.payoutOf, [{ type: 'address', value: wallet.toLowerCase() }])),
      'payoutOf()',
    ).uint(0, 'payoutOf');
    assert.equal(stillOwed, 0n, 'the contract still thinks it owes this address something');

    console.log(`    CLAIM MINED: ${hash} in block ${receipt.blockNumber} — ${owed} wei paid to ${wallet} from ${market}`);

    // And a second claim is refused by name rather than by a revert the user paid for.
    await popup.getByTestId('claim-done').click();
    await awaitMarketRead(popup);
    assert.match(await popup.getByTestId('claim-refusal').innerText(), /already claimed/);
    assert.equal(await popup.getByTestId('claim-submit').count(), 0, 'the claim button is still offered after claiming');
    await popup.close();
  });
});
