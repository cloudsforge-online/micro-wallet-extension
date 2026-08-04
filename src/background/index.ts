/* The service worker entry point.
 *
 * EVERY LISTENER IS REGISTERED SYNCHRONOUSLY, AT THE TOP LEVEL, BEFORE THE FIRST `await`.
 *
 * That is not style. When Chrome wakes a terminated worker to deliver an event, it runs the module
 * to completion and then dispatches — but only to listeners that were registered during that
 * synchronous run. A listener added inside `chrome.storage.local.get().then(...)` is registered one
 * microtask too late, the event that woke the worker is dropped, and the bug reproduces only after
 * an idle period. It is the single most common MV3 defect and it is invisible in development,
 * where the worker never sleeps because devtools is attached.
 *
 * So: `chrome.runtime.onConnect`, `onMessage`, `chrome.alarms.onAlarm` and `chrome.windows.onRemoved`
 * are all attached below with no `await` above them, and each handler does its async work inside.
 */

import {
  PORT_NAME_CONTENT, type Decision, type WorkerMessage, type WorkerReply,
} from '../shared/protocol.ts';
import { DISCONNECTED, INVALID_PARAMS, ProviderError, toProviderError, userRejected } from '../shared/errors.ts';
import { fromQuantity, toQuantity } from '../shared/units.ts';
import {
  BUILTIN_CHAINS, getLocal, setLocal, type ChainRecord,
} from './storage.ts';
import { AUTO_LOCK_ALARM, isUnlocked, lock, requireUnlocked, touchSession } from './session.ts';
import {
  allPending, failAll, forgetPort, noteWindowId, pendingRequest, poll, registerPort, rejectAbandoned,
  settle,
} from './requests.ts';
import { dispatch, grantAccounts, previewTransaction, revokeOrigin, selectedChain } from './handlers.ts';
import {
  addWatchOnly, createVault, deriveNextAccount, fromHex, importKeystore, importPrivateKey,
  newMnemonic, revealMnemonic, signMessage, signTx, signTyped, unlockVault,
} from './vault.ts';
import { getBalance, getBlockNumber, getGasPrice, recentHistory, sendRaw } from './rpc.ts';
import * as features from './features.ts';

/* --------------------------------------------------------------------------- live connections -- */

const contentPorts = new Set<chrome.runtime.Port>();

/** Push an EIP-1193 event to every page. Best effort by construction — see requests.ts on `live`. */
function broadcast(event: 'accountsChanged' | 'chainChanged', payload: unknown): void {
  const message: WorkerReply = { kind: 'event', event, payload };
  for (const port of contentPorts) {
    try { port.postMessage(message); } catch { contentPorts.delete(port); }
  }
}

async function updateBadge(): Promise<void> {
  const pending = await allPending();
  // The badge is §6's "badge overlay for a pending request". Text rather than an icon swap so it
  // works before micro-wallet-assets lands.
  await chrome.action.setBadgeText({ text: pending.length === 0 ? '' : String(pending.length) });
  await chrome.action.setBadgeBackgroundColor({ color: '#e8622c' });
}

/* ------------------------------------------------------------------------------ dapp requests -- */

async function handleRpc(port: chrome.runtime.Port, message: Extract<WorkerMessage, { kind: 'rpc' }>): Promise<void> {
  // THE ORIGIN COMES FROM THE BROWSER, NOT THE PAGE. `port.sender` is filled in by Chrome and
  // cannot be spoofed by the content script's page. See shared/protocol.ts.
  const origin = port.sender?.origin ?? port.sender?.url ?? null;
  if (origin === null) {
    port.postMessage({ kind: 'error', id: message.id, error: { code: DISCONNECTED, message: 'This request had no origin the browser could vouch for.' } } satisfies WorkerReply);
    return;
  }
  registerPort(message.id, port);
  try {
    const outcome = await dispatch(
      { origin, tabId: port.sender?.tab?.id ?? null, id: message.id },
      message.method,
      message.params,
    );
    if (outcome.kind === 'result') {
      port.postMessage({ kind: 'result', id: message.id, result: outcome.result } satisfies WorkerReply);
    } else {
      port.postMessage({ kind: 'pending', id: message.id } satisfies WorkerReply);
      await updateBadge();
    }
  } catch (cause) {
    const error = toProviderError(cause);
    port.postMessage({ kind: 'error', id: message.id, error: { code: error.code, message: error.message } } satisfies WorkerReply);
  }
}

/**
 * Carry out what the user approved.
 *
 * This runs in whichever worker is alive when the Approve button is clicked — quite possibly not
 * the one that received the request. Everything it needs comes from storage; nothing is closed
 * over. That property is what makes the ninety-second read in requests.ts survivable.
 */
async function execute(decision: Decision): Promise<unknown> {
  const request = await pendingRequest(decision.id);
  if (request === null) {
    throw new ProviderError(DISCONNECTED, 'That request is no longer open — the wallet or the browser restarted while it was waiting.');
  }
  const chain = await selectedChain();
  const params = request.params;

  switch (request.method) {
    case 'eth_requestAccounts':
    case 'wallet_requestPermissions': {
      const accounts = decision.accounts ?? [];
      if (accounts.length === 0) throw new ProviderError(INVALID_PARAMS, 'No account was chosen.');
      await grantAccounts(request.origin, accounts);
      broadcast('accountsChanged', accounts);
      if (request.method === 'eth_requestAccounts') return accounts;
      return [{
        parentCapability: 'eth_accounts',
        invoker: request.origin,
        caveats: [{ type: 'restrictReturnedAccounts', value: [...accounts] }],
      }];
    }

    case 'personal_sign': {
      await requireUnlocked();
      const from = String(params[1]);
      const message = String(params[0]);
      let payload: Uint8Array | string = message;
      // A static import, not a dynamic one. The worker is bundled as a single classic script so
      // that it loads identically in Chrome's service worker and Firefox's event page; a dynamic
      // import would force code-splitting, and a service worker that fetches a second chunk at
      // signing time is a service worker that can fail to sign while offline.
      try { payload = fromHex(message); } catch { /* not hex: sign the literal string, per EIP-191 */ }
      return signMessage(from, payload);
    }

    case 'eth_signTypedData':
    case 'eth_signTypedData_v4': {
      await requireUnlocked();
      const from = String(params[0]);
      const raw = typeof params[1] === 'string' ? JSON.parse(params[1]) as unknown : params[1];
      return signTyped(from, raw as Parameters<typeof signTyped>[1]);
    }

    case 'eth_sendTransaction': {
      await requireUnlocked();
      const raw = params[0] as Record<string, unknown>;
      // Re-derive the preview rather than trusting the one stored with the request: the fee, the
      // nonce and the estimate may all be minutes old by now, and a nonce that has been used since
      // produces a transaction the mempool silently drops.
      const preview = await previewTransaction(request.origin, raw, chain);
      const gas = decision.overrides?.gas ?? preview.gas;
      const gasPrice = decision.overrides?.gasPrice ?? preview.gasPrice;
      const signed = await signTx(preview.from, {
        type: 0,
        nonce: BigInt(preview.nonce),
        gasPrice: BigInt(gasPrice),
        gasLimit: BigInt(gas),
        to: preview.to,
        value: BigInt(preview.valueWei),
        data: preview.data,
      }, chain);
      return sendRaw(chain, signed);
    }

    case 'wallet_addEthereumChain': {
      const spec = params[0] as Record<string, unknown>;
      const id = Number(fromQuantity(String(spec['chainId']), 'chainId'));
      const chains = await getLocal('chains');
      if (!chains.some((c) => c.id === id)) {
        const urls = spec['rpcUrls'];
        const currency = (spec['nativeCurrency'] ?? {}) as Record<string, unknown>;
        const explorers = spec['blockExplorerUrls'];
        const record: ChainRecord = {
          id,
          name: typeof spec['chainName'] === 'string' ? spec['chainName'] : `Chain ${id}`,
          rpcUrl: Array.isArray(urls) && typeof urls[0] === 'string' ? urls[0] : '',
          currency: {
            name: typeof currency['name'] === 'string' ? currency['name'] : 'Ether',
            symbol: typeof currency['symbol'] === 'string' ? currency['symbol'] : 'ETH',
            decimals: typeof currency['decimals'] === 'number' ? currency['decimals'] : 18,
          },
          explorerUrl: Array.isArray(explorers) && typeof explorers[0] === 'string' ? explorers[0] : null,
          // Unknown chains get 1559 by default, matching the core's chainSupportsEip1559: a custom
          // RPC is most likely a modern EVM chain, and Hearth's ids are the special case.
          supportsEip1559: !BUILTIN_CHAINS.some((c) => c.id === id),
          addedByDapp: true,
        };
        await setLocal('chains', [...chains, record]);
      }
      await switchTo(id);
      return null;
    }

    case 'wallet_switchEthereumChain': {
      const spec = params[0] as Record<string, unknown>;
      await switchTo(Number(fromQuantity(String(spec['chainId']), 'chainId')));
      return null;
    }

    default:
      throw new ProviderError(INVALID_PARAMS, `${request.method} cannot be approved.`);
  }
}

async function switchTo(chainId: number): Promise<void> {
  const settings = await getLocal('settings');
  await setLocal('settings', { ...settings, selectedChainId: chainId });
  broadcast('chainChanged', toQuantity(BigInt(chainId)));
}

/* ---------------------------------------------------------------------------- the UI surface --- */

async function uiState(): Promise<unknown> {
  const [accounts, settings, chains, permissions, vault] = await Promise.all([
    getLocal('accounts'), getLocal('settings'), getLocal('chains'), getLocal('permissions'), getLocal('vault'),
  ]);
  return {
    hasVault: vault !== null,
    unlocked: await isUnlocked(),
    accounts,
    settings,
    chains,
    permissions,
    pending: await allPending(),
  };
}

async function handleUi(action: string, payload: unknown, sender?: chrome.runtime.MessageSender): Promise<unknown> {
  const p = (payload ?? {}) as Record<string, unknown>;
  switch (action) {
    case 'state': return uiState();
    case 'newMnemonic': return newMnemonic(p['words'] === 24 ? 24 : 12);

    case 'createWallet': {
      const result = await createVault(String(p['mnemonic']), String(p['password']));
      await updateBadge();
      return result;
    }
    case 'unlock': {
      await unlockVault(String(p['password']));
      return uiState();
    }
    case 'lock': {
      await lock();
      // A locked wallet holding a dapp's half-approved transaction is a trap: the user comes back,
      // unlocks, and approves something they have forgotten the context of.
      await failAll('The wallet was locked while this request was waiting.');
      await updateBadge();
      return { ok: true };
    }
    case 'touch': { await touchSession(); return { ok: true }; }

    case 'confirmBackup': {
      const settings = await getLocal('settings');
      await setLocal('settings', { ...settings, seedBackedUp: true });
      return { ok: true };
    }
    case 'revealMnemonic': return { mnemonic: await revealMnemonic(String(p['password'])) };

    case 'deriveAccount': return deriveNextAccount(p['label'] === undefined ? undefined : String(p['label']));
    case 'importPrivateKey': return importPrivateKey(String(p['privateKey']), String(p['password']));
    case 'importKeystore': return importKeystore(String(p['json']), String(p['keystorePassword']), String(p['password']));
    case 'addWatchOnly': return addWatchOnly(String(p['address']));

    case 'selectAccount': {
      const settings = await getLocal('settings');
      await setLocal('settings', { ...settings, selectedAddress: String(p['address']) });
      return { ok: true };
    }
    case 'selectChain': {
      await switchTo(Number(p['chainId']));
      return { ok: true };
    }
    case 'setAutoLock': {
      const settings = await getLocal('settings');
      const minutes = Number(p['minutes']);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 240) {
        throw new ProviderError(INVALID_PARAMS, 'Auto-lock must be between 1 and 240 minutes.');
      }
      await setLocal('settings', { ...settings, autoLockMinutes: minutes });
      await touchSession();
      return { ok: true };
    }
    case 'revokeOrigin': { await revokeOrigin(String(p['origin'])); return { ok: true }; }

    case 'balance': {
      const chain = await selectedChain();
      return { wei: (await getBalance(chain, String(p['address']))).toString(), chainId: chain.id };
    }
    case 'blockNumber': {
      const chain = await selectedChain();
      return { number: (await getBlockNumber(chain)).toString() };
    }
    case 'gasPrice': {
      const chain = await selectedChain();
      return { wei: (await getGasPrice(chain)).toString() };
    }
    case 'history': {
      const chain = await selectedChain();
      const depth = Number(p['depth'] ?? 200);
      return recentHistory(chain, String(p['address']), Number.isFinite(depth) ? depth : 200);
    }
    case 'previewSend': {
      const chain = await selectedChain();
      return previewTransaction('wallet', p['tx'] as Record<string, unknown>, chain);
    }
    case 'send': {
      await requireUnlocked();
      const chain = await selectedChain();
      const preview = await previewTransaction('wallet', p['tx'] as Record<string, unknown>, chain);
      const gas = p['gas'] === undefined ? preview.gas : String(p['gas']);
      const gasPrice = p['gasPrice'] === undefined ? preview.gasPrice : String(p['gasPrice']);
      const signed = await signTx(preview.from, {
        type: 0,
        nonce: BigInt(preview.nonce),
        gasPrice: BigInt(gasPrice),
        gasLimit: BigInt(gas),
        to: preview.to,
        value: BigInt(preview.valueWei),
        data: preview.data,
      }, chain);
      await touchSession();
      return { hash: await sendRaw(chain, signed), raw: signed };
    }

    /* ---------------------------------------------------- phase 5: Foresight, from the chain -- */
    //
    // Not one of these reaches a CloudsForge service except `discoverMarkets`, which is off unless
    // the user turns it on and contributes an address and a question and nothing else. §5.1: if
    // every service here were switched off, every action below still works.
    case 'market': return features.market(p['address']);
    case 'previewStake': return features.previewStake(p);
    case 'stake': return features.stake(p);
    case 'previewClaim': return features.previewClaim(p);
    case 'claim': return features.claim(p);
    case 'watchedMarkets': return getLocal('markets');
    case 'watchMarket': return features.watchMarket(p);
    case 'unwatchMarket': return features.unwatchMarket(p);
    case 'discoverMarkets': return features.discovery();
    case 'setDiscovery': return features.setDiscovery(p);

    /* ------------------------------------------- phase 6: token deployment, signed locally ---- */
    case 'tokenTemplates': return features.templates();
    case 'previewDeploy': return features.previewDeploy(p);
    case 'deployToken': return features.deployToken(p);
    case 'readToken': return features.token(p);
    case 'deployedTokens': return getLocal('tokens');

    case 'getRequest': {
      const id = String(p['id']);
      const request = await pendingRequest(id);
      if (request === null) throw new ProviderError(DISCONNECTED, 'That request is no longer open.');
      // THE APPROVAL WINDOW REPORTS ITS OWN WINDOW ID, every time it loads.
      //
      // `enqueue` writes it too, from the result of chrome.windows.create — but that write can be
      // lost, because the worker can be stopped in the gap between creating the window and
      // recording it. A request stuck with `windowId: null` would then never be swept when the user
      // closed its window, and the dapp would hang. Having the window itself supply the id closes
      // that gap: the page cannot be showing a request without having loaded, and it cannot load
      // without calling this.
      const windowId = sender?.tab?.windowId;
      if (typeof windowId === 'number' && request.windowId !== windowId) {
        await noteWindowId(id, windowId);
      }
      return request;
    }
    case 'decide': {
      const decision = p['decision'] as Decision;
      if (!decision.approved) {
        await settle(decision.id, { error: userRejected('request') });
        await updateBadge();
        return { ok: true };
      }
      try {
        const result = await execute(decision);
        await settle(decision.id, { result });
      } catch (cause) {
        await settle(decision.id, { error: cause });
        await updateBadge();
        throw cause;
      }
      await updateBadge();
      return { ok: true };
    }

    default:
      throw new ProviderError(INVALID_PARAMS, `Unknown action ${action}.`);
  }
}

/* --------------------------------------------------------------- listeners, registered eagerly - */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === PORT_NAME_CONTENT) contentPorts.add(port);

  port.onDisconnect.addListener(() => {
    contentPorts.delete(port);
    forgetPort(port);
  });

  port.onMessage.addListener((raw: unknown) => {
    const message = raw as WorkerMessage;
    if (message.kind === 'rpc') {
      void handleRpc(port, message);
      return;
    }
    if (message.kind === 'poll') {
      registerPort(message.id, port);
      void poll(message.id).then((state) => {
        if (state.state === 'pending') {
          port.postMessage({ kind: 'pending', id: message.id } satisfies WorkerReply);
        } else if (state.state === 'gone') {
          port.postMessage({
            kind: 'error',
            id: message.id,
            error: { code: DISCONNECTED, message: 'The wallet restarted while this request was open, and the request did not survive. Try again.' },
          } satisfies WorkerReply);
        } else if (state.error !== undefined) {
          port.postMessage({ kind: 'error', id: message.id, error: state.error } satisfies WorkerReply);
        } else {
          port.postMessage({ kind: 'result', id: message.id, result: state.result } satisfies WorkerReply);
        }
      });
      return;
    }
    if (message.kind === 'ui') {
      void handleUi(message.action, message.payload)
        .then((result) => port.postMessage({ kind: 'result', id: message.id, result } satisfies WorkerReply))
        .catch((cause: unknown) => {
          const error = toProviderError(cause);
          port.postMessage({ kind: 'error', id: message.id, error: { code: error.code, message: error.message } } satisfies WorkerReply);
        });
    }
  });
});

/**
 * One-shot messages, for the UI pages.
 *
 * `sendMessage` rather than a port is right for a page that asks one question and closes — an
 * approval window, for instance, whose port would disconnect mid-answer as it closes itself.
 * Returning `true` keeps the channel open for the async reply; forgetting it is the other classic
 * MV3 bug, and it presents as `sendMessage` resolving to `undefined` with no error anywhere.
 */
chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  const message = raw as WorkerMessage;
  if (message.kind !== 'ui') return false;
  void handleUi(message.action, message.payload, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((cause: unknown) => sendResponse({ ok: false, error: toProviderError(cause) }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTO_LOCK_ALARM) return;
  void (async (): Promise<void> => {
    await lock();
    await failAll('The wallet locked itself while this request was waiting.');
    await updateBadge();
  })();
});

/**
 * A closed approval window is a rejection.
 *
 * Chrome gives no "which request was that" on removal, so the open windows are re-derived from the
 * tab list and anything not represented is failed with 4001. This is also the path that cleans up
 * after a worker restart, because it runs whenever any window closes.
 */
chrome.windows.onRemoved.addListener(() => {
  void (async (): Promise<void> => {
    // The window ids that still exist, compared against the id stored on each pending request.
    // An earlier version matched on the approval page's URL fragment instead, which meant a window
    // that had been created but had not yet navigated looked closed.
    const windows = await chrome.windows.getAll();
    const open = new Set<number>();
    for (const window of windows) if (window.id !== undefined) open.add(window.id);
    await rejectAbandoned(open);
    await updateBadge();
  })();
});

/** First install: seed the chain list and open the onboarding tab. */
chrome.runtime.onInstalled.addListener((details) => {
  void (async (): Promise<void> => {
    const chains = await getLocal('chains');
    if (chains.length === 0) await setLocal('chains', [...BUILTIN_CHAINS]);
    await updateBadge();
    if (details.reason === 'install') {
      await chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
    }
  })();
});

/**
 * A worker that has just started may be holding requests decided by a previous one, or requests
 * whose windows the browser closed while it was asleep. Reconcile once, on startup.
 */
chrome.runtime.onStartup.addListener(() => {
  void (async (): Promise<void> => {
    await failAll('The browser restarted while this request was waiting.');
    await updateBadge();
  })();
});
