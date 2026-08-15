/* The MV3 constraint, tested by actually killing the service worker mid-approval.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * 25-wallet-clients.md §4.3:
 *
 *   "MV3 service worker, which TERMINATES WHEN IDLE — so no signing state may live in a module
 *    variable. Every unlock is explicit and every pending request survives a worker restart or is
 *    cleanly failed. This is the single most common source of extension bugs and it is a design
 *    constraint, not an implementation detail."
 *
 * The scenario this file reproduces, which is the one that ships broken:
 *
 *   1. a dapp asks the wallet to sign;
 *   2. the approval window opens;
 *   3. the user reads it carefully — ninety seconds, because this wallet told them to check the
 *      address character by character;
 *   4. Chrome kills the worker at thirty seconds, because nothing has happened in it;
 *   5. the user clicks Approve.
 *
 * With state in a module variable, step 5 wakes a worker that has never heard of this request, the
 * dapp's promise never settles, and the page spins forever. Every test below is a way of asking
 * whether that happens here.
 *
 * The worker is stopped with CDP `Target.closeTarget` rather than by waiting thirty seconds; the
 * first test proves that this is a real termination by showing the worker's global scope comes back
 * empty afterwards.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */

import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import {
  PASSWORD, beginRequest, createWallet, launch, markWorker, openConnectedDapp,
  readWorkerMarker, requireLiveChain, terminateWorker, waitForOutcome, withApproval,
  type Harness,
} from './harness.ts';

/* `beginRequest`, `outcomeOf`, `waitForOutcome`, `openConnectedDapp` and `withApproval` were written
 * here and now live in the harness, because `exchange.test.ts` drives the same two-page dance —
 * a request that cannot be awaited until the window it opens has been clicked. Their comments moved
 * with them; each one records a failure that cost time. */

describe('the service worker terminating does not lose a request', () => {
  let harness: Harness;
  let address: string;

  before(async () => {
    await requireLiveChain();
    harness = await launch();
    const created = await createWallet(harness);
    address = created.address;
    await created.page.close();
  });

  after(async () => { await harness?.close(); });

  test('terminating the worker really terminates it — its global scope comes back empty', async () => {
    // The whole file rests on this. If `Target.closeTarget` only detached a debugger handle, every
    // assertion below would be vacuous, so the mechanism is checked before it is relied on.
    await markWorker(harness, 'before-termination');
    assert.equal(await readWorkerMarker(harness), 'before-termination');

    await terminateWorker(harness);

    // Wake a fresh worker with an ordinary message, the way any user action would.
    const waker = await harness.context.newPage();
    await waker.goto(`chrome-extension://${harness.extensionId}/popup.html`);
    await waker.getByTestId('account-select').waitFor({ timeout: 30_000 });

    assert.equal(
      await readWorkerMarker(harness),
      null,
      'the marker survived, so the worker was never actually stopped and this suite proves nothing',
    );
    await waker.close();
  });

  test('a dapp connects, and the wallet stays unlocked across a worker restart', async () => {
    const page = await openConnectedDapp(harness);
    const approval = await withApproval(harness, () => beginRequest(page, 'connect', 'eth_requestAccounts', []));
    assert.equal((await approval.getByTestId('origin').innerText()).trim(), new URL(harness.dappUrl).origin);
    await approval.getByTestId(`connect-${address}`).check();
    await approval.getByTestId('approve').click();

    const outcome = await waitForOutcome(page, 'connect');
    assert.equal(outcome.error, undefined, `connect failed: ${outcome.error?.message}`);
    assert.deepEqual(outcome.result, [address]);

    // The unlock lives in chrome.storage.session, not in a module variable, so it survives.
    await terminateWorker(harness);
    await beginRequest(page, 'accounts', 'eth_accounts', []);
    const after = await waitForOutcome(page, 'accounts');
    assert.deepEqual(after.result, [address], 'the wallet forgot which accounts this origin may see');
    await page.close();
  });

  test('THE SCENARIO: the worker dies while the approval window is open, and the signature still arrives', async () => {
    const page = await openConnectedDapp(harness);
    const message = '0x48656c6c6f2c204865617274682e'; // "Hello, Hearth."
    const approval = await withApproval(harness, () => beginRequest(page, 'sign', 'personal_sign', [message, address]));
    assert.equal((await approval.getByTestId('message-text').innerText()).trim(), 'Hello, Hearth.');

    // ── The user is reading. Chrome gets bored. ──────────────────────────────────────────────────
    await markWorker(harness, 'the-worker-that-took-the-request');
    await terminateWorker(harness);

    // The approval window is a separate page and is unaffected — it is still on screen, showing the
    // same request, and the user has no idea anything happened.
    assert.equal((await approval.getByTestId('message-text').innerText()).trim(), 'Hello, Hearth.');

    await approval.getByTestId('approve').click();

    const outcome = await waitForOutcome(page, 'sign');
    assert.equal(outcome.error, undefined, `the request was lost across the restart: ${outcome.error?.message}`);
    assert.match(String(outcome.result), /^0x[0-9a-f]{130}$/, 'that is not a 65-byte signature');

    // And prove it really was a different worker that finished the job.
    assert.equal(
      await readWorkerMarker(harness),
      null,
      'the same worker answered, so the restart never happened and this test proves nothing',
    );
    await page.close();
  });

  test('the pending request itself survives, because it is in storage rather than in the worker', async () => {
    const page = await openConnectedDapp(harness);
    const approval = await withApproval(harness, () => beginRequest(page, 'sign2', 'personal_sign', ['0x6162', address]));
    const id = decodeURIComponent(approval.url().split('#')[1] ?? '');
    assert.notEqual(id, '');

    await terminateWorker(harness);

    // A fresh worker, asked about a request it never received, answers from chrome.storage.session.
    const survived = await approval.evaluate(async (requestId: string) => {
      const response = await chrome.runtime.sendMessage({ kind: 'ui', id: 'probe', action: 'getRequest', payload: { id: requestId } }) as
        { ok: boolean; result?: { origin: string; method: string } };
      return response.ok ? response.result : null;
    }, id);

    assert.notEqual(survived, null, 'the request did not survive the restart');
    assert.equal(survived!.method, 'personal_sign');
    assert.equal(survived!.origin, new URL(harness.dappUrl).origin);

    // Tidy up: rejecting must settle the dapp's promise rather than leaving it open.
    await approval.getByTestId('reject').click();
    const outcome = await waitForOutcome(page, 'sign2');
    assert.equal(outcome.error?.code, 4001, `a rejection must be EIP-1193 4001, got ${JSON.stringify(outcome.error)}`);
    await page.close();
  });

  test('closing the approval window without deciding is a clean 4001, not a hang', async () => {
    // This is how most people decline. If it did not settle the promise, the dapp would spin.
    const page = await openConnectedDapp(harness);
    const approval = await withApproval(harness, () => beginRequest(page, 'sign3', 'personal_sign', ['0x6162', address]));
    await approval.close();

    const outcome = await waitForOutcome(page, 'sign3');
    assert.equal(outcome.error?.code, 4001);
    await page.close();
  });

  test('a request the wallet can no longer find fails cleanly rather than hanging', async () => {
    // The browser-restart case: session storage is gone but the page is still waiting. §4.3 gives
    // two acceptable outcomes — survive, or fail cleanly — and this is the second.
    const page = await openConnectedDapp(harness);
    const approval = await withApproval(harness, () => beginRequest(page, 'sign4', 'personal_sign', ['0x6162', address]));

    // Wipe what the worker would have answered from, exactly as a browser restart does.
    const worker = await harness.worker();
    await worker.evaluate(() => chrome.storage.session.clear());

    // Now stop the worker. The content script's port drops, it reconnects, it asks what became of
    // its request, and a worker with no record of it must say so rather than stay silent.
    await terminateWorker(harness);
    await approval.close();

    const outcome = await waitForOutcome(page, 'sign4');
    assert.notEqual(outcome.error, undefined, 'the request neither succeeded nor failed — it hung');
    assert.equal(outcome.error?.code, 4900, `expected EIP-1193 4900 disconnected, got ${JSON.stringify(outcome.error)}`);
    assert.match(outcome.error!.message, /restarted|did not survive|not available/i);
    await page.close();
  });

  test('locking the wallet fails an open request instead of leaving it to be approved later', async () => {
    // A locked wallet holding a half-read transaction is a trap: the user comes back, unlocks for
    // some unrelated reason, and approves something they have lost the context of.
    //
    // The previous test cleared chrome.storage.session, which is where the unlock lives — so the
    // wallet is legitimately locked when this one starts, and it has to be unlocked first. That is
    // the design working, not a fixture problem: wiping the session IS locking the wallet.
    const page = await openConnectedDapp(harness);
    await withApproval(harness, () => beginRequest(page, 'sign5', 'personal_sign', ['0x6162', address]));

    const popup = await harness.context.newPage();
    await popup.goto(`chrome-extension://${harness.extensionId}/popup.html`);
    if (await popup.getByTestId('unlock-password').isVisible().catch(() => false)) {
      await popup.getByTestId('unlock-password').fill(PASSWORD);
      await popup.getByTestId('unlock').click();
      await popup.getByTestId('tab-settings').waitFor({ timeout: 60_000 });
    }
    await popup.getByTestId('tab-settings').click();
    await popup.getByTestId('lock').click();

    const outcome = await waitForOutcome(page, 'sign5');
    assert.equal(outcome.error?.code, 4900);
    assert.match(outcome.error!.message, /locked/i);
    await popup.close();
    await page.close();
  });
});
