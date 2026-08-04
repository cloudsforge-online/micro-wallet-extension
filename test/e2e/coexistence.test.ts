/* EIP-6963, with another wallet actually installed.
 *
 * §4.3: "EIP-6963 for multi-wallet discovery, so installing this does not fight MetaMask over
 * `window.ethereum`. A wallet that wins that fight by force is a wallet users uninstall."
 *
 * A test that loads only this extension and finds it announced proves nothing — a wallet alone in
 * a browser coexists with everything. So Chromium is launched with TWO unpacked extensions: this
 * one, and test/e2e/fixtures/rival-wallet, which does what MetaMask does (MAIN world at
 * document_start, defines `window.ethereum`, announces over 6963). The assertions below are about
 * what happens when they meet.
 */

import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';

import { CHAIN_ID, collectAnnouncements, launch, requireLiveChain, type Harness } from './harness.ts';

interface Announced { uuid: string; name: string; rdns: string; icon: string }

const OURS = 'online.cloudsforge.wallet';
const RIVAL = 'test.fixture.rivalwallet';

describe('EIP-6963 coexistence with a second wallet installed', () => {
  let harness: Harness;

  before(async () => {
    await requireLiveChain();
    harness = await launch({ withRival: true });
  });

  after(async () => { await harness?.close(); });

  test('both wallets are discoverable, and neither is hidden by the other', async () => {
    const page = await harness.context.newPage();
    await collectAnnouncements(page);
    await page.goto(harness.dappUrl, { waitUntil: 'domcontentloaded' });

    // A dapp asks; every wallet answers. This is the discovery path a real connect button uses.
    const announced = await page.evaluate(async (): Promise<Announced[]> => {
      window.dispatchEvent(new Event('eip6963:requestProvider'));
      await new Promise((done) => setTimeout(done, 300));
      return (window as unknown as { __announced: Announced[] }).__announced;
    });

    const rdns = announced.map((a) => a.rdns);
    assert.ok(rdns.includes(OURS), `CloudsForge did not announce itself. Saw: ${rdns.join(', ') || '(nothing)'}`);
    assert.ok(rdns.includes(RIVAL), `the rival wallet did not announce itself. Saw: ${rdns.join(', ')}`);
    await page.close();
  });

  test('the announcement carries a name, a stable rdns and a data-URI icon', async () => {
    const page = await harness.context.newPage();
    await collectAnnouncements(page);
    await page.goto(harness.dappUrl, { waitUntil: 'domcontentloaded' });
    const ours = (await page.evaluate((): Announced[] =>
      (window as unknown as { __announced: Announced[] }).__announced)).find((a) => a.rdns === OURS);

    assert.notEqual(ours, undefined);
    assert.equal(ours!.name, 'CloudsForge Wallet');
    // The EIP requires a data URI: a remote icon URL would tell whoever hosts it which dapps this
    // wallet's users visit, every time a wallet picker is drawn.
    assert.match(ours!.icon, /^data:image\//);
    assert.match(ours!.uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    await page.close();
  });

  test('the uuid is per page load, not a stable identifier for this profile', async () => {
    // EIP-6963 requires this and the reason is privacy: a persistent uuid would be a cross-site
    // identifier any page could read with no permission and no way for the user to clear it.
    const read = async (): Promise<string> => {
      const page = await harness.context.newPage();
      await collectAnnouncements(page);
      await page.goto(harness.dappUrl, { waitUntil: 'domcontentloaded' });
      const uuid = (await page.evaluate((): Announced[] =>
        (window as unknown as { __announced: Announced[] }).__announced)).find((a) => a.rdns === OURS)!.uuid;
      await page.close();
      return uuid;
    };
    assert.notEqual(await read(), await read());
  });

  test('window.ethereum is left to the other wallet — this one does not take it by force', async () => {
    const page = await harness.context.newPage();
    await page.goto(harness.dappUrl, { waitUntil: 'domcontentloaded' });
    const who = await page.evaluate(() => {
      const e = (window as unknown as { ethereum?: Record<string, unknown> }).ethereum;
      return { present: e !== undefined, isMetaMask: e?.['isMetaMask'] === true, isCloudsForge: e?.['isCloudsForge'] === true };
    });
    assert.equal(who.present, true, 'window.ethereum vanished — one wallet deleted the other\'s');
    assert.equal(who.isMetaMask, true, 'CloudsForge took window.ethereum from the wallet that was already there');
    assert.equal(who.isCloudsForge, false);
    await page.close();
  });

  test('being second is not being broken: the provider still works over EIP-6963', async () => {
    // This is the assertion that makes the one above safe to ship. Conceding `window.ethereum` is
    // only acceptable because the 6963 path is fully functional — otherwise "we do not fight" would
    // just mean "we do not work when another wallet is installed".
    const page = await harness.context.newPage();
    await collectAnnouncements(page);
    await page.goto(harness.dappUrl, { waitUntil: 'domcontentloaded' });

    const chainId = await page.evaluate(async (rdns: string) => {
      window.dispatchEvent(new Event('eip6963:requestProvider'));
      await new Promise((done) => setTimeout(done, 300));
      const providers = (window as unknown as { __providers: Record<string, { request(a: unknown): Promise<unknown> }> }).__providers;
      return providers[rdns]!.request({ method: 'eth_chainId' });
    }, OURS);

    assert.equal(Number(BigInt(String(chainId))), CHAIN_ID);
    await page.close();
  });

  test('a real chain read goes through our provider while the rival holds the global', async () => {
    const page = await harness.context.newPage();
    await collectAnnouncements(page);
    await page.goto(harness.dappUrl, { waitUntil: 'domcontentloaded' });

    const result = await page.evaluate(async (rdns: string) => {
      window.dispatchEvent(new Event('eip6963:requestProvider'));
      await new Promise((done) => setTimeout(done, 300));
      const providers = (window as unknown as { __providers: Record<string, { request(a: unknown): Promise<unknown> }> }).__providers;
      const block = await providers[rdns]!.request({ method: 'eth_blockNumber' });
      // And prove the rival really is the one on window.ethereum, by watching it refuse.
      let rivalSaid = '';
      try {
        await (window as unknown as { ethereum: { request(a: unknown): Promise<unknown> } }).ethereum.request({ method: 'eth_blockNumber' });
      } catch (cause) {
        rivalSaid = (cause as Error).message;
      }
      return { block, rivalSaid };
    }, OURS);

    assert.ok(BigInt(String(result.block)) > 0n, 'our provider read no block from the live chain');
    assert.match(result.rivalSaid, /rival-wallet fixture/, 'window.ethereum did not behave like the rival');
    await page.close();
  });

  test('with no rival installed, the legacy global is ours — the compatibility path still exists', async () => {
    // The concession above must not become "this wallet never provides window.ethereum", or every
    // dapp written before 6963 stops seeing it.
    const alone = await launch();
    try {
      const page = await alone.context.newPage();
      await page.goto(alone.dappUrl, { waitUntil: 'domcontentloaded' });
      const who = await page.evaluate(() => {
        const e = (window as unknown as { ethereum?: Record<string, unknown> }).ethereum;
        return { isCloudsForge: e?.['isCloudsForge'] === true, rdns: e?.['rdns'] };
      });
      assert.equal(who.isCloudsForge, true);
      assert.equal(who.rdns, OURS);
    } finally {
      await alone.close();
    }
  });

  test('window.ethereum stays configurable, so a wallet installed later can still take it', async () => {
    const alone = await launch();
    try {
      const page = await alone.context.newPage();
      await page.goto(alone.dappUrl, { waitUntil: 'domcontentloaded' });
      const descriptor = await page.evaluate(() => {
        const d = Object.getOwnPropertyDescriptor(window, 'ethereum');
        return { configurable: d?.configurable, writable: d?.writable };
      });
      assert.equal(descriptor.configurable, true, 'the global was locked — that is the escalation this design refuses');
      assert.equal(descriptor.writable, true);
    } finally {
      await alone.close();
    }
  });
});
