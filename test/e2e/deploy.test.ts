/* Phase 6, on the live chain: deploy micro-mint's token from the wallet, and read it back.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * THE ONLY EVIDENCE ACCEPTED HERE IS CODE ON THE CHAIN AND A SYMBOL THE CHAIN RETURNS.
 *
 * A creation that runs out of gas, or reverts inside its constructor, still gets mined, still gets
 * a receipt, and still gets a `contractAddress` field in it. Nothing is deployed. Every subsequent
 * `eth_call` to that address answers `0x`, which a careless reader turns into a symbol of "" and a
 * supply of 0 rather than into "this did not deploy".
 *
 * So every test below ends at one of:
 *   - `eth_getCode` returning runtime bytecode, and
 *   - `symbol()`, `name()`, `decimals()`, `totalSupply()` and `balanceOf()` answering, and
 *   - a receipt whose `status` is 1 — checked in the harness, which THROWS on 0.
 *
 * And the address is checked against the one the wallet predicted before it sent anything, because
 * `keccak256(rlp([sender, nonce]))[12:]` is a total function of two values and a wallet that gets
 * it wrong points the user at an address the contract is not at.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';

import { encodeCall, Return } from '../../src/shared/abi.ts';
import { ARTEFACTS } from '../../src/background/templates.generated.ts';
import {
  CHAIN_ID, RPC_URL, callContract, createWallet, fundedSigner, launch, nodeRpc,
  nodeTransactionModule, openPopup, operatorSend, requireLiveChain, startRecordingProxy,
  useRpcUrl, waitForReceipt, type Harness,
} from './harness.ts';

const E = 10n ** 18n;

describe('token deployment, signed by the key on this device', () => {
  let harness: Harness;
  let wallet: string;

  before(async () => {
    const chain = await requireLiveChain();
    harness = await launch();
    const created = await createWallet(harness);
    wallet = created.address;
    await created.page.close();

    const operator = fundedSigner();
    const funding = await operatorSend(operator, { to: wallet, value: 10n * E, gas: 21_000n });
    await waitForReceipt(funding);
    console.log(`    chain ${chain.chainId} at block ${chain.blockNumber}; wallet ${wallet} funded with 10 EMBER`);
  });

  after(async () => { await harness?.close(); });

  test('the templates offered are micro-mint’s three, and no others', async () => {
    const popup = await openPopup(harness);
    await popup.getByTestId('tab-deploy').click();
    await popup.getByTestId('deploy-variant').waitFor({ timeout: 20_000 });

    const options = await popup.getByTestId('deploy-variant').locator('option').allInnerTexts();
    assert.equal(options.length, 3, `the wallet offers ${options.length} templates; micro-mint's catalogue has three`);
    const values = await popup.getByTestId('deploy-variant').locator('option').evaluateAll(
      (nodes) => nodes.map((n) => (n as HTMLOptionElement).value),
    );
    assert.deepEqual(values, ['fixed', 'mintable', 'foundry']);

    // The pausable one warns about the power it grants, in words rather than as a feature chip.
    await popup.getByTestId('deploy-variant').selectOption('foundry');
    const blurb = await popup.getByTestId('template-blurb').innerText();
    assert.match(blurb, /FoundryToken/);
    assert.match(blurb, /PAUSE every transfer for every holder/);
    await popup.close();
  });

  test('a real FixedSupplyToken is deployed, and the chain answers symbol()', async () => {
    const proxy = await startRecordingProxy();
    try {
      await useRpcUrl(harness, proxy.url);

      const popup = await openPopup(harness);
      await popup.getByTestId('tab-deploy').click();
      await popup.getByTestId('deploy-variant').waitFor({ timeout: 20_000 });

      await popup.getByTestId('deploy-variant').selectOption('fixed');
      await popup.getByTestId('deploy-name').fill('Ember Wallet Proof');
      await popup.getByTestId('deploy-symbol').fill('EWP');
      await popup.getByTestId('deploy-decimals').fill('18');
      await popup.getByTestId('deploy-supply').fill('1000000');

      // The supply is minted to the signing account and there is no field to change it.
      assert.equal((await popup.getByTestId('deploy-owner').innerText()).trim(), wallet);

      await popup.getByTestId('deploy-preview').click();
      await popup.getByTestId('constructor-args').waitFor({ timeout: 45_000 });

      /* -------------------------------------------------- what §5 asks the screen to show first */
      //
      // "see the CONSTRUCTOR ARGUMENTS and the DEPLOYMENT COST, sign, and watch it confirm."
      assert.equal((await popup.getByTestId('ctor-name_').innerText()).trim(), 'Ember Wallet Proof');
      assert.equal((await popup.getByTestId('ctor-symbol_').innerText()).trim(), 'EWP');
      assert.equal((await popup.getByTestId('ctor-decimals_').innerText()).trim(), '18');
      // The base-unit integer, beside the whole-token figure, so the conversion is checkable.
      assert.equal((await popup.getByTestId('ctor-initialSupply_').innerText()).trim(), (10n ** 24n).toString());
      assert.match(await popup.getByTestId('supply-restated').innerText(), /1000000 whole tokens/);

      const cost = (await popup.getByTestId('deploy-cost').innerText()).trim();
      assert.match(cost, /^[\d.,]+ EMBER$/, `the cost is not stated as an amount: ${cost}`);
      assert.notEqual(cost, '0 EMBER', 'the deployment cost was estimated as nothing');

      const predicted = (await popup.getByTestId('predicted-address').innerText()).trim();
      assert.match(predicted, /^0x[0-9a-fA-F]{40}$/);

      // The creation data really is micro-mint's bytecode with arguments appended.
      //
      // `textContent`, not `innerText`: the raw data sits inside a collapsed <details>, and
      // `innerText` is the RENDERED text, which is empty for a hidden element. The first version of
      // this compared micro-mint's bytecode against '' and failed with a message accusing the
      // wallet of deploying the wrong bytes.
      const data = (await popup.getByTestId('deploy-data').textContent() ?? '').trim();
      assert.ok(
        data.startsWith(ARTEFACTS['FixedSupplyToken']!.bytecode),
        'the creation data does not begin with micro-mint\'s committed FixedSupplyToken bytecode',
      );

      /* ---------------------------------------------------------------------------- the deploy */
      await popup.getByTestId('deploy-submit').click();
      await popup.getByTestId('deployed-address').waitFor({ timeout: 60_000 });
      const hash = (await popup.getByTestId('deploy-hash').innerText()).trim();
      const address = (await popup.getByTestId('deployed-address').innerText()).trim();

      assert.equal(address, predicted, 'the wallet predicted one address before sending and reported another after');

      const receipt = await waitForReceipt(hash);
      assert.equal(
        receipt.contractAddress?.toLowerCase(),
        address.toLowerCase(),
        'the chain put the contract somewhere other than where the wallet said it would land',
      );
      console.log(`    TOKEN DEPLOYED: ${address} in block ${receipt.blockNumber}, ${receipt.gasUsed} gas (tx ${hash})`);

      /* ------------------------------------------------------------------ verified positively -- */

      // 1. There is CODE there. This is the assertion a receipt cannot substitute for.
      const code = String(await nodeRpc('eth_getCode', [address, 'latest']));
      assert.ok(code.length > 1000, `no runtime code at ${address} — the constructor reverted or ran out of gas`);

      // 2. The chain answers the ERC-20 reads, checked by this process over TCP.
      const symbol = new Return(await callContract(address, encodeCall('symbol()')), 'symbol()').string('symbol()');
      const name = new Return(await callContract(address, encodeCall('name()')), 'name()').string('name()');
      const decimals = new Return(await callContract(address, encodeCall('decimals()')), 'decimals()').small(0, 8, 'decimals()');
      const supply = new Return(await callContract(address, encodeCall('totalSupply()')), 'totalSupply()').uint(0, 'totalSupply()');
      const balance = new Return(
        await callContract(address, encodeCall('balanceOf(address)', [{ type: 'address', value: wallet.toLowerCase() }])),
        'balanceOf()',
      ).uint(0, 'balanceOf()');

      assert.equal(symbol, 'EWP', `the chain says the symbol is ${JSON.stringify(symbol)}`);
      assert.equal(name, 'Ember Wallet Proof');
      assert.equal(decimals, 18);
      assert.equal(supply, 10n ** 24n, 'the supply on chain is not the one the constructor was given');
      assert.equal(balance, 10n ** 24n, 'the whole supply did not go to the deploying account');
      console.log(`    READ BACK FROM CHAIN ${CHAIN_ID}: symbol()=${symbol} name()=${name} decimals()=${decimals} totalSupply()=${supply}`);

      // 3. FixedSupplyToken has NO owner — the promise the template blurb makes. `owner()` is not
      //    in its ABI, so the call reverts and `eth_call` answers with an error or empty data.
      let ownerAnswered = true;
      try {
        new Return(await callContract(address, encodeCall('owner()')), 'owner()').address(0, 'owner()');
      } catch {
        ownerAnswered = false;
      }
      assert.equal(ownerAnswered, false, 'a FixedSupplyToken answered owner() — this is not the contract micro-mint committed');

      // 4. The wallet signed it: hearth/node's own decoder recovers this account from the bytes.
      const broadcast = proxy.seen.filter((c) => c.method === 'eth_sendRawTransaction');
      assert.equal(broadcast.length, 1, `expected one broadcast, saw ${broadcast.length}`);
      const raw = String(broadcast[0]!.params[0]);
      const { decode, recoverSender } = await nodeTransactionModule();
      const recovered = `0x${Buffer.from(recoverSender(decode(Buffer.from(raw.slice(2), 'hex'), { chainId: CHAIN_ID })) as unknown as Buffer).toString('hex')}`;
      assert.equal(recovered.toLowerCase(), wallet.toLowerCase(), 'hearth/node recovered a different sender from this deployment');
      console.log(`    hearth/node recovered ${recovered} from the deployment's signature`);

      // 5. And the wallet's own read-back screen says the same thing the witness does.
      await popup.getByTestId('deploy-confirmed').waitFor({ timeout: 60_000 });
      assert.equal((await popup.getByTestId('readback-symbol').innerText()).trim(), 'EWP');
      assert.equal((await popup.getByTestId('readback-name').innerText()).trim(), 'Ember Wallet Proof');
      assert.equal((await popup.getByTestId('readback-supply').innerText()).trim(), '1,000,000');
      assert.equal((await popup.getByTestId('readback-balance').innerText()).trim(), '1,000,000');

      await popup.close();
    } finally {
      await useRpcUrl(harness, RPC_URL);
      await proxy.close();
    }
  });

  test('a capped FoundryToken deploys with its cap, and the cap is on the chain', async () => {
    // The variant with the extra constructor argument — the one where a wrong argument ORDER would
    // produce a token whose numbers are not the ones asked for, and nothing would revert.
    const popup = await openPopup(harness);
    await popup.getByTestId('tab-deploy').click();
    await popup.getByTestId('deploy-variant').waitFor({ timeout: 20_000 });

    await popup.getByTestId('deploy-variant').selectOption('foundry');
    await popup.getByTestId('deploy-name').fill('Ember Foundry Proof');
    await popup.getByTestId('deploy-symbol').fill('EFP');
    await popup.getByTestId('deploy-decimals').fill('6');
    await popup.getByTestId('deploy-supply').fill('1000');
    await popup.getByTestId('deploy-cap').fill('5000');

    await popup.getByTestId('deploy-preview').click();
    await popup.getByTestId('constructor-args').waitFor({ timeout: 45_000 });

    // Six arguments, in micro-mint's declared order, with the cap in the fifth slot.
    assert.equal((await popup.getByTestId('ctor-decimals_').innerText()).trim(), '6');
    assert.equal((await popup.getByTestId('ctor-initialSupply_').innerText()).trim(), (1000n * 10n ** 6n).toString());
    assert.equal((await popup.getByTestId('ctor-cap_').innerText()).trim(), (5000n * 10n ** 6n).toString());

    await popup.getByTestId('deploy-submit').click();
    await popup.getByTestId('deployed-address').waitFor({ timeout: 60_000 });
    const hash = (await popup.getByTestId('deploy-hash').innerText()).trim();
    const address = (await popup.getByTestId('deployed-address').innerText()).trim();
    const receipt = await waitForReceipt(hash);

    const code = String(await nodeRpc('eth_getCode', [address, 'latest']));
    assert.ok(code.length > 1000, `no runtime code at ${address}`);

    const symbol = new Return(await callContract(address, encodeCall('symbol()')), 'symbol()').string('symbol()');
    const decimals = new Return(await callContract(address, encodeCall('decimals()')), 'decimals()').small(0, 8, 'decimals()');
    const supply = new Return(await callContract(address, encodeCall('totalSupply()')), 'totalSupply()').uint(0, 'totalSupply()');
    const cap = new Return(await callContract(address, encodeCall('cap()')), 'cap()').uint(0, 'cap()');
    const owner = new Return(await callContract(address, encodeCall('owner()')), 'owner()').address(0, 'owner()');

    assert.equal(symbol, 'EFP');
    // THE ORDER ASSERTION. Had `decimals_` and `initialSupply_` been swapped, this token would have
    // 18 decimals if it deployed at all — and mint says in terms that nothing in either language
    // catches it. The chain does.
    assert.equal(decimals, 6, 'decimals landed on the wrong constructor parameter');
    assert.equal(supply, 1000n * 10n ** 6n);
    assert.equal(cap, 5000n * 10n ** 6n, 'the cap on chain is not the one asked for');
    assert.equal(owner.toLowerCase(), wallet.toLowerCase(), 'the token is owned by somebody other than the signer');

    console.log(`    CAPPED TOKEN DEPLOYED: ${address} in block ${receipt.blockNumber} — symbol()=${symbol} decimals()=${decimals} cap()=${cap} owner()=${owner}`);
    await popup.close();
  });

  test('an order no committed contract can build is refused before anything is signed', async () => {
    const popup = await openPopup(harness);
    await popup.getByTestId('tab-deploy').click();
    await popup.getByTestId('deploy-variant').waitFor({ timeout: 20_000 });

    await popup.getByTestId('deploy-variant').selectOption('foundry');
    await popup.getByTestId('deploy-name').fill('Impossible');
    await popup.getByTestId('deploy-symbol').fill('IMP');
    await popup.getByTestId('deploy-decimals').fill('18');
    await popup.getByTestId('deploy-supply').fill('1000');
    // A cap below the supply: the constructor reverts on it, so the fee would be spent for nothing.
    await popup.getByTestId('deploy-cap').fill('1');

    await popup.getByTestId('deploy-preview').click();
    await popup.getByTestId('deploy-error').waitFor({ timeout: 30_000 });
    const message = await popup.getByTestId('deploy-error').innerText();
    assert.match(message, /cap must be at least the initial supply/);
    // Nothing was signed, so nothing was broadcast — the confirmation never appeared.
    assert.equal(await popup.getByTestId('deploy-hash').count(), 0);
    await popup.close();
  });
});
