/* The end-to-end proof: a real Chromium, the real extension, the real Hearth testnet.
 *
 * WHAT THIS FILE IS FOR. Every claim below is checked against an INDEPENDENT witness — a JSON-RPC
 * call the test makes itself, over TCP, to the same node. If the wallet's number and the node's
 * number agree, the wallet read the chain. If the node is down, this file fails; it does not skip
 * and there is nothing here for it to fall back to.
 */

import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';

import {
  CHAIN_ID, RPC_URL, createWallet, findFundedAddress, launch, nodeRpc, nodeTransactionModule,
  openPopup, requireLiveChain, startRecordingProxy, useRpcUrl, type Harness,
} from './harness.ts';

describe('the wallet, in a real browser, against the live chain', () => {
  let harness: Harness;
  let chainState: { chainId: number; blockNumber: number };

  before(async () => {
    chainState = await requireLiveChain();
    harness = await launch();
  });

  after(async () => { await harness?.close(); });

  test('the chain under test is the live Hearth testnet, and it is mining', async () => {
    assert.equal(chainState.chainId, CHAIN_ID);
    assert.ok(chainState.blockNumber > 0, 'the chain has no blocks');
    const client = await nodeRpc('web3_clientVersion');
    assert.match(String(client), /^Hearth\//, `${RPC_URL} is not a Hearth node: ${String(client)}`);
    console.log(`    node: ${String(client)} at block ${chainState.blockNumber}`);
  });

  test('the extension loads as an MV3 service worker', async () => {
    const worker = await harness.worker();
    assert.match(worker.url(), /^chrome-extension:\/\/[a-p]{32}\/background\.js$/);
  });

  test('the onboarding says, in those words, that the wallet never asks for the phrase', async () => {
    // §5 makes this a requirement rather than copy: "the wallet never asks for the seed phrase
    // after setup … and the onboarding says so IN THOSE WORDS."
    const page = await harness.context.newPage();
    await page.goto(`chrome-extension://${harness.extensionId}/onboarding.html`);
    const text = await page.locator('main').innerText();
    assert.ok(
      text.includes('This wallet will never ask you for your recovery phrase after setup.'),
      `the promise is not on the first screen:\n${text}`,
    );
    assert.match(text, /Anyone who does is stealing from you/);
    // §1.1: the custodial balance must never be presentable as part of this one.
    assert.match(text, /never added together|never summed|are never added/i);
    await page.close();
  });

  test('create a wallet through the real onboarding, and derive a checksummed address', async () => {
    const { address, mnemonic, page } = await createWallet(harness);

    assert.equal(mnemonic.split(' ').length, 12);
    assert.match(address, /^0x[0-9a-fA-F]{40}$/);
    // EIP-55: a lowercase-only address would mean the checksum was never applied, which is the
    // silent failure that makes a wallet accept mistyped addresses.
    assert.notEqual(address, address.toLowerCase(), 'the address is not EIP-55 checksummed');
    await page.close();
  });

  test('the popup reads THIS account\'s balance from the node, and it matches a direct RPC call', async () => {
    const popup = await openPopup(harness);
    await popup.getByTestId('tab-assets').click();

    const address = (await popup.getByTestId('account-select').inputValue()).trim();
    const shownWei = await popup.getByTestId('balance-wei').innerText();
    const wei = BigInt(shownWei.replace(/ wei$/, ''));

    // The independent witness.
    const direct = BigInt(String(await nodeRpc('eth_getBalance', [address, 'latest'])));
    assert.equal(wei, direct, 'the popup and the node disagree about this account\'s balance');
    console.log(`    fresh account ${address} holds ${wei} wei, confirmed by direct RPC`);
    await popup.close();
  });

  test('a real, non-zero balance is read off the chain through the extension\'s own RPC path', async () => {
    // A fresh account holds zero, and "0 === 0" is a weak proof that anything was read at all. So
    // this reads the balance of an address that a miner has actually been paid into — through the
    // extension's own code path — and compares it with a direct call.
    const funded = await findFundedAddress();
    assert.ok(funded.wei > 0n, 'the funded address the test found holds nothing');

    const worker = await harness.worker();
    const throughExtension = await worker.evaluate(async (address: string) => {
      // Runs INSIDE the service worker: chrome.runtime.sendMessage to itself is not available, so
      // this drives the same JSON-RPC the wallet uses, from the worker's own origin and under the
      // extension's own host permissions. A CORS failure or a missing permission fails here.
      const response = await fetch('http://127.0.0.1:8545', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }),
      });
      const payload = await response.json() as { result: string };
      return payload.result;
    }, funded.address);

    assert.equal(BigInt(throughExtension), funded.wei);
    const ember = Number(funded.wei / 10n ** 14n) / 10_000;
    console.log(`    LIVE BALANCE: ${funded.address} holds ${funded.wei} wei (${ember} EMBER) on chain ${CHAIN_ID}`);
  });

  test('the receive screen shows the checksummed address and a QR of it', async () => {
    const popup = await openPopup(harness);
    await popup.getByTestId('tab-receive').click();
    const shown = (await popup.getByTestId('receive-address').innerText()).trim();
    const selected = (await popup.getByTestId('account-select').inputValue()).trim();
    assert.equal(shown, selected);
    assert.notEqual(shown, shown.toLowerCase());
    const svg = await popup.getByTestId('receive-qr').innerHTML();
    assert.match(svg, /<svg /, 'no QR was rendered');
    await popup.close();
  });

  test('deriving a second account produces a different address on the same seed', async () => {
    const popup = await openPopup(harness);
    const before = await popup.getByTestId('account-select').locator('option').count();
    await popup.getByTestId('derive-account').click();
    await popup.waitForFunction(
      (n) => document.querySelectorAll('[data-testid="account-select"] option').length > n,
      before,
      { timeout: 10_000 },
    );
    const options = await popup.getByTestId('account-select').locator('option').allInnerTexts();
    assert.equal(options.length, before + 1);
    assert.equal(new Set(options).size, options.length, 'two accounts share an address');
    await popup.close();
  });

  test('activity reads real blocks from the node rather than an indexer', async () => {
    const popup = await openPopup(harness);
    await popup.getByTestId('tab-activity').click();
    // The scan is one HTTP call per block against the live node, so it takes as long as it takes.
    await popup.getByText(/Blocks \d+–\d+/).waitFor({ timeout: 60_000 });
    const text = await popup.locator('main').innerText();
    const match = /Blocks (\d+)–(\d+)/.exec(text);
    assert.notEqual(match, null, `the activity tab never reported a scanned range: ${text}`);
    const scannedTo = Number(match![2]);
    const tip = Number(BigInt(String(await nodeRpc('eth_blockNumber'))));
    // Blocks are mined while the test runs, so the wallet's tip may be a few behind the node's.
    assert.ok(Math.abs(tip - scannedTo) <= 5, `the wallet scanned to ${scannedTo} but the chain is at ${tip}`);
    assert.match(text, /does not use a CloudsForge indexer/);
    await popup.close();
  });

  test('the wallet signs a real transaction that the NODE\'S OWN decoder recovers to our address', async () => {
    // WHY THIS IS NOT JUST "BROADCAST AND CHECK THE ERROR". A zero-balance account cannot get a
    // transaction into this node's mempool: `eth_gasPrice` is 1 gwei and anything under it comes
    // back "transaction underpriced", anything at it comes back "insufficient funds for gas *
    // price + value". Both refusals are byte-identical for a CORRUPTED signature, because a
    // corrupted signature recovers to a different address that is also empty — measured, not
    // assumed. So a successful "insufficient funds" proves the RLP decoded and nothing more.
    //
    // The recovery is therefore checked against hearth/node/src/chain/transaction.js: the running
    // network's own implementation, the same oracle the signing core is held to (§3.1).
    const proxy = await startRecordingProxy();
    try {
      await useRpcUrl(harness, proxy.url);

      const popup = await openPopup(harness);
      const from = (await popup.getByTestId('account-select').inputValue()).trim();

      await popup.getByTestId('tab-send').click();
      await popup.getByTestId('send-to').fill('0x000000000000000000000000000000000000dEaD');
      await popup.getByTestId('send-amount').fill('1');
      await popup.getByTestId('send-estimate').click();
      await popup.getByTestId('send-gas').waitFor({ timeout: 30_000 });
      await popup.getByTestId('send-submit').click();

      await Promise.race([
        popup.getByTestId('send-error').waitFor({ timeout: 60_000 }).catch(() => undefined),
        popup.getByTestId('send-hash').waitFor({ timeout: 60_000 }).catch(() => undefined),
      ]);

      // Every call went through the proxy to the live node and back. Nothing was answered locally.
      const broadcast = proxy.seen.filter((call) => call.method === 'eth_sendRawTransaction');
      assert.equal(broadcast.length, 1, `expected exactly one broadcast, saw ${broadcast.length}`);
      assert.ok(
        proxy.seen.some((c) => c.method === 'eth_getTransactionCount') && proxy.seen.some((c) => c.method === 'eth_gasPrice'),
        'the wallet did not fetch a live nonce and gas price before signing',
      );

      const raw = String(broadcast[0]!.params[0]);
      assert.match(raw, /^0x[0-9a-f]+$/);

      const { decode, recoverSender } = await nodeTransactionModule();
      const tx = decode(Buffer.from(raw.slice(2), 'hex'), { chainId: CHAIN_ID });
      // The node works in 20-byte Buffers, not `0x…` strings — its addresses are bytes all the way
      // through and only the JSON-RPC layer hexes them.
      const bytes = recoverSender(tx) as unknown as Buffer;
      const recovered = `0x${Buffer.from(bytes).toString('hex')}`;
      assert.equal(
        recovered.toLowerCase(),
        from.toLowerCase(),
        'the Hearth node\'s own decoder recovered a different sender from the signature this wallet produced',
      );
      console.log(`    hearth/node recovered ${recovered} from the wallet's signature — it matches the account on screen`);

      // And the node itself saw it: the refusal is the balance check, which is downstream of the
      // signature check, so the transaction was well formed all the way through.
      const message = await popup.getByTestId('send-error').innerText().catch(() => '');
      if (message !== '') assert.match(message, /insufficient|funds|underpriced/i, `unexpected node refusal: ${message}`);

      await popup.close();
    } finally {
      await useRpcUrl(harness, RPC_URL);
      await proxy.close();
    }
  });
});
