/* The end-to-end harness: a real Chromium, the real extension, a real Hearth node.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * THERE IS NO `page.route` IN THIS DIRECTORY, AND THERE MUST NEVER BE ONE.
 *
 * This estate shipped 314 specified browser scenarios and a full CI suite while sign-in was broken
 * for every user, because every frontend harness called `page.route('**\/*', …)` and answered its
 * own requests from fixtures. The suite tested the fixtures. It could not have failed.
 *
 * So: the JSON-RPC below goes to a Hearth node over TCP. The balances asserted are balances a
 * miner actually mined. If the node is not running, these tests FAIL — they do not skip, and they
 * do not fall back to a stub, because a suite that goes green when its subject is absent is the
 * exact defect this rule exists to prevent.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * `chromium.launchPersistentContext` with `--load-extension` is the only way to drive an unpacked
 * MV3 extension. It needs a real user-data directory (the extension's chrome.storage.local lives in
 * it), which is created per test file and removed afterwards so no test can see another's vault.
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright-core';

import { BUILTIN_CHAINS } from '../../src/background/storage.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, '..', '..');
export const EXTENSION = join(REPO, 'dist', 'chrome');
export const RIVAL = join(here, 'fixtures', 'rival-wallet');

/** The live testnet. Overridable so CI can point at the node it started itself. */
export const RPC_URL = process.env['HEARTH_RPC_URL'] ?? 'http://127.0.0.1:8545';
export const CHAIN_ID = Number(process.env['HEARTH_CHAIN_ID'] ?? 7412);

/* --------------------------------------------------------------------------- the node, direct - */

let rpcId = 0;

/**
 * A JSON-RPC call made by the TEST, not by the extension.
 *
 * This is the independent witness. When a test asserts that the wallet showed a balance, it
 * compares against this — a separate HTTP request, made by a different process, to the same node.
 * If the extension's number and this number agree, the extension really did read the chain.
 */
export async function nodeRpc(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (!response.ok) throw new Error(`${RPC_URL} answered HTTP ${response.status} for ${method}`);
  const payload = await response.json() as { result?: unknown; error?: { message: string } };
  if (payload.error) throw new Error(`${method}: ${payload.error.message}`);
  return payload.result;
}

/**
 * Fail loudly and immediately if the chain is not there.
 *
 * Called at the top of every e2e file. The message names what to start, because the alternative —
 * fourteen assertion failures with no obvious cause — is how a suite gets marked flaky and skipped.
 */
export async function requireLiveChain(): Promise<{ chainId: number; blockNumber: number }> {
  let chainIdHex: unknown;
  try {
    chainIdHex = await nodeRpc('eth_chainId');
  } catch (cause) {
    throw new Error(
      `The end-to-end suite needs a Hearth node at ${RPC_URL} and could not reach one (${cause instanceof Error ? cause.message : cause}). `
      + 'These tests do not mock the chain and do not skip when it is absent. Start a node, or set HEARTH_RPC_URL.',
    );
  }
  const chainId = Number(BigInt(String(chainIdHex)));
  if (chainId !== CHAIN_ID) {
    throw new Error(`${RPC_URL} is chain ${chainId}, not ${CHAIN_ID}. Signing against the wrong chain is exactly what chain ids exist to prevent.`);
  }
  const blockNumber = Number(BigInt(String(await nodeRpc('eth_blockNumber'))));
  return { chainId, blockNumber };
}

/**
 * An address with a non-zero balance on the live chain: the miner of a recent block.
 *
 * RETURNS THE BLOCK IT READ AT, and the caller must read at the same one.
 *
 * `latest` is a moving target on a chain that is being mined — which is the whole point of using a
 * live chain, and it is also a race. The first version of this compared the witness's `latest`
 * against the extension's `latest` a second later; on a laptop the local testnet was slow enough
 * that they always agreed, and in CI, where a fresh node mines every two seconds, a block landed
 * between the two reads and credited the same coinbase. The test failed with two balances that were
 * both correct.
 *
 * Pinning the block makes the comparison exact without weakening it: it is still a real balance,
 * still read from a real node over TCP, still mined by a real miner. It is simply the SAME real
 * balance on both sides of the assertion.
 */
export async function findFundedAddress(): Promise<{ address: string; wei: bigint; blockTag: string }> {
  const tip = Number(BigInt(String(await nodeRpc('eth_blockNumber'))));
  for (let n = tip; n >= Math.max(0, tip - 50); n -= 1) {
    const block = await nodeRpc('eth_getBlockByNumber', [`0x${n.toString(16)}`, false]) as { miner?: string } | null;
    const miner = block?.miner;
    if (typeof miner !== 'string') continue;
    // One block behind the tip, so a reorg of the very newest block cannot change the answer under
    // the test either.
    const blockTag = `0x${Math.max(0, n - 1).toString(16)}`;
    const wei = BigInt(String(await nodeRpc('eth_getBalance', [miner, blockTag])));
    if (wei > 0n) return { address: miner, wei, blockTag };
  }
  throw new Error('No address with a non-zero balance was found in the last 50 blocks — has this chain ever mined?');
}

/* --------------------------------------------------------------------------- the browser ------ */

export interface Harness {
  readonly context: BrowserContext;
  readonly extensionId: string;
  readonly worker: () => Promise<Worker>;
  readonly dappUrl: string;
  openDapp: () => Promise<Page>;
  close: () => Promise<void>;
}

/**
 * A page served over HTTP, because content scripts do not run on `file://`.
 *
 * The manifest matches `http://*` and `https://*` deliberately — an extension that injected into
 * `file://` would be reading the user's local documents for no benefit — so a dapp fixture must be
 * served. Port 0 lets the OS pick a free one: this machine is running 52 containers and hardcoding
 * a port is how a test suite starts failing for reasons that have nothing to do with the code.
 */
function serveDapp(): Promise<{ url: string; server: Server }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Test dapp</title></head>
<body><h1>Test dapp</h1><div id="out"></div></body></html>`);
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      done({ url: `http://127.0.0.1:${port}/`, server });
    });
  });
}

/* ------------------------------------------------------------------- observing the wire ------- */

export interface RecordingProxy {
  readonly url: string;
  /** Every JSON-RPC request the extension made, in order. */
  readonly seen: { method: string; params: unknown[] }[];
  close: () => Promise<void>;
}

/**
 * A pass-through JSON-RPC proxy that records what the extension sent.
 *
 * THIS IS NOT A MOCK, AND THE DISTINCTION IS THE WHOLE POINT OF THIS DIRECTORY. Every byte is
 * forwarded to the live Hearth node and the node's own answer comes back unaltered; nothing here
 * invents a response, and if the node is down the proxy fails exactly as the direct connection
 * would. It exists only so the test can SEE the raw signed transaction the extension produced —
 * which is otherwise invisible, because a wallet that exposed its signed bytes to its own UI would
 * be a wallet with an extra way to leak them.
 *
 * Pointing the wallet at it is a §5 feature being used, not a test hook: "add and switch networks;
 * a custom RPC" is what a user does when they run their own node.
 */
export async function startRecordingProxy(): Promise<RecordingProxy> {
  const seen: { method: string; params: unknown[] }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      void (async (): Promise<void> => {
        const body = Buffer.concat(chunks).toString('utf8');
        try {
          // BATCHES ARE UNROLLED, and this is not a detail. Once background/rpc.ts gained
          // `rpcBatch`, a market read went out as ONE request whose body is an array — and a
          // recorder that only reads a top-level `.method` saw a single call with `method:
          // undefined`. The assertions built on `proxy.seen` did not fail loudly; they quietly
          // stopped being able to observe anything, which is the exact shape of guard failure this
          // suite exists to avoid. The foresight suite's "the wallet never called the contract"
          // caught it, and this is the fix.
          const parsed = JSON.parse(body) as
            | { method: string; params?: unknown[] }
            | { method: string; params?: unknown[] }[];
          for (const call of Array.isArray(parsed) ? parsed : [parsed]) {
            seen.push({ method: call.method, params: call.params ?? [] });
          }
        } catch { /* not JSON — forward it anyway and let the node object */ }
        const upstream = await fetch(RPC_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        });
        const text = await upstream.text();
        response.writeHead(upstream.status, {
          'content-type': 'application/json',
          // The extension page's origin is chrome-extension://…; without this the browser blocks
          // the response before any of it reaches the worker.
          'access-control-allow-origin': '*',
        });
        response.end(text);
      })().catch(() => {
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"proxy could not reach the node"}}');
      });
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    seen,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/**
 * The Hearth node's OWN transaction decoder, loaded from a sibling checkout.
 *
 * This is the §3.1 oracle arrangement the signing core already uses, applied here for the one
 * question the live node cannot answer: which address a signature recovers to. Broadcasting an
 * unfunded transaction proves less than it looks — a DELIBERATELY CORRUPTED signature produces the
 * byte-identical "insufficient funds for gas * price + value" from this node, because it recovers
 * to a different address that is also empty. That was measured, not assumed. So the recovery is
 * checked against `hearth/node/src/chain/transaction.js`, which is the network's implementation and
 * not ours to adjust when it disagrees.
 */
export async function nodeTransactionModule(): Promise<{
  decode: (raw: Buffer | Uint8Array, options?: { chainId?: number }) => unknown;
  recoverSender: (tx: unknown) => string;
}> {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const candidates = [
    process.env['HEARTH_NODE_SRC'] === undefined ? null : join(process.env['HEARTH_NODE_SRC'], 'chain', 'transaction.js'),
    resolve(REPO, '..', 'hearth', 'node', 'src', 'chain', 'transaction.js'),
  ].filter((p): p is string => p !== null);
  const found = candidates.find((p) => existsSync(p));
  if (found === undefined) {
    // FAILS rather than skips, for the reason the core's suite gives: a guard that goes green when
    // it cannot find its oracle is a guard that has never checked anything.
    throw new Error(
      `The signing check needs hearth/node/src beside this checkout, or HEARTH_NODE_SRC set. Looked in:\n  ${candidates.join('\n  ')}`,
    );
  }
  return require(found) as Awaited<ReturnType<typeof nodeTransactionModule>>;
}

export interface LaunchOptions {
  /** Load a second, MetaMask-shaped extension alongside this one. */
  readonly withRival?: boolean;
}

export async function launch(options: LaunchOptions = {}): Promise<Harness> {
  if (!existsSync(join(EXTENSION, 'manifest.json'))) {
    throw new Error(`${EXTENSION} has no manifest.json — run \`pnpm build\` before the end-to-end suite.`);
  }
  const profile = mkdtempSync(join(tmpdir(), 'cf-wallet-e2e-'));
  const extensions = options.withRival === true ? `${EXTENSION},${RIVAL}` : EXTENSION;
  const { url: dappUrl, server } = await serveDapp();

  const context = await chromium.launchPersistentContext(profile, {
    // `channel: 'chromium'` selects the full browser rather than the headless shell. The shell has
    // no extension support at all, and the failure mode is an empty `serviceWorkers()` list with no
    // error — which reads as "my extension is broken" rather than "this binary cannot load one".
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extensions}`,
      `--load-extension=${extensions}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const worker = async (): Promise<Worker> => {
    const existing = context.serviceWorkers()[0];
    if (existing !== undefined) return existing;
    return context.waitForEvent('serviceworker', { timeout: 20_000 });
  };

  const sw = await worker();
  const extensionId = new URL(sw.url()).host;

  const harness: Harness = {
    context,
    extensionId,
    worker,
    dappUrl,
    openDapp: async (): Promise<Page> => {
      const page = await context.newPage();
      await page.goto(dappUrl, { waitUntil: 'domcontentloaded' });
      return page;
    },
    close: async (): Promise<void> => {
      await context.close();
      await new Promise<void>((done) => server.close(() => done()));
      rmSync(profile, { recursive: true, force: true });
    },
  };

  /* ──────────────────────────────────────────────────────────────────────────────────────────────
   * POINT THE EXTENSION AT THE SAME NODE THE TEST IS TALKING TO.
   *
   * `HEARTH_RPC_URL` is documented as "overridable so CI can point at the node it started itself",
   * and until now it only redirected `nodeRpc` — the test's own witness. The EXTENSION went on
   * using the URL baked into BUILTIN_CHAINS, `http://127.0.0.1:8545`. That happened to be right
   * everywhere it had been run, because CI starts its node on 8545 and this laptop has one there
   * too, so the two were the same node by coincidence of the port rather than by construction.
   *
   * The moment they are not — which is exactly what happens when somebody reproduces a CI failure
   * against a second node on another port — the suite silently drives the wallet against one chain
   * and asserts against another, and every failure it reports is a lie about the wallet. Making the
   * override apply to both is what lets `HEARTH_RPC_URL` be used to reproduce anything at all.
   * ────────────────────────────────────────────────────────────────────────────────────────────── */
  const builtin = BUILTIN_CHAINS.find((c) => c.id === CHAIN_ID);
  if (builtin !== undefined && builtin.rpcUrl !== RPC_URL) {
    await useRpcUrl(harness, RPC_URL);
  }

  return harness;
}

/**
 * Kill the MV3 service worker, for real.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * THIS IS THE MOST IMPORTANT FUNCTION IN THE SUITE, because §4.3's central constraint — "the
 * service worker terminates when idle, so no signing state may live in a module variable" — is
 * otherwise untestable, and an untested constraint is a constraint that gets violated by the next
 * person in a hurry.
 *
 * Chrome evicts an idle MV3 worker after roughly thirty seconds. Waiting for that is unreliable
 * under automation (an attached debugger keeps workers alive) and adds thirty seconds to a suite.
 * `Target.closeTarget` on the `service_worker` target does it immediately, and Chrome restarts the
 * worker on the next event exactly as it would after a natural eviction.
 *
 * That this is a genuine termination and not a Playwright bookkeeping change was verified rather
 * than assumed: a marker written to the worker's `globalThis` before the call is ABSENT afterwards,
 * and the old worker handle stops answering. `assertRestarted` below is that check, kept in the
 * suite so it goes on being true.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
export async function terminateWorker(harness: Harness): Promise<void> {
  const browser = harness.context.browser();
  if (browser === null) throw new Error('no browser handle — cannot reach the CDP session that stops the worker');
  const session = await browser.newBrowserCDPSession();
  const { targetInfos } = await session.send('Target.getTargets');
  const worker = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(harness.extensionId));
  if (worker === undefined) throw new Error('the extension has no running service worker to stop');
  await session.send('Target.closeTarget', { targetId: worker.targetId });
  await session.detach().catch(() => undefined);
  // Chrome tears the worker down asynchronously; without this the next message can still reach it.
  await new Promise((done) => setTimeout(done, 750));
}

/** Write a marker into the worker's global scope, so a restart can be proved rather than assumed. */
export async function markWorker(harness: Harness, value: string): Promise<void> {
  const worker = await harness.worker();
  await worker.evaluate((mark: string) => {
    (globalThis as unknown as Record<string, string>)['__e2eMarker'] = mark;
  }, value);
}

/** Read the marker back. `null` means this is a different worker from the one that was marked. */
export async function readWorkerMarker(harness: Harness): Promise<string | null> {
  const worker = await harness.worker();
  return worker.evaluate(() => (globalThis as unknown as Record<string, string>)['__e2eMarker'] ?? null);
}

/* ------------------------------------------------------------------------- driving the wallet - */

export const PASSWORD = 'a-long-enough-test-password';

/**
 * Walk the real onboarding UI: password, reveal, read the phrase, answer the three verification
 * questions, land on the address.
 *
 * Deliberately NOT a shortcut through `chrome.storage`. The point of an end-to-end test is that
 * the flow a person takes is the flow that runs; seeding storage directly would leave the
 * onboarding screens untested while appearing to test them.
 */
export async function createWallet(harness: Harness): Promise<{ address: string; mnemonic: string; page: Page }> {
  const page = await harness.context.newPage();
  await page.goto(`chrome-extension://${harness.extensionId}/onboarding.html`);

  await page.getByRole('button', { name: 'Create a new wallet' }).click();
  await page.getByTestId('password').fill(PASSWORD);
  await page.getByTestId('password-again').fill(PASSWORD);
  await page.getByTestId('password-continue').click();

  await page.getByTestId('reveal').click();
  const words = await page.getByTestId('seed-grid').locator('.word').allInnerTexts();
  // Each cell renders as "<n><word>"; the number is a <b> with no separator.
  const mnemonic = words.map((cell) => cell.replace(/^\d+/, '').trim()).join(' ');
  await page.getByTestId('phrase-continue').click();

  // Three questions, each "Word N" followed by four buttons. Answer from the phrase just read.
  for (const label of await page.locator('label').allInnerTexts()) {
    const match = /^Word (\d+)$/.exec(label.trim());
    if (match === null) continue;
    const index = Number(match[1]) - 1;
    await page.getByTestId(`verify-${index}-${mnemonic.split(' ')[index]}`).click();
  }
  await page.getByTestId('verify-done').click();

  const address = (await page.getByTestId('first-address').innerText()).trim();
  return { address, mnemonic, page };
}

/**
 * Point the selected chain at a different RPC URL — the "custom RPC" a user sets to run their own
 * node. Written through the worker so it goes into the same chrome.storage.local the wallet reads.
 */
export async function useRpcUrl(harness: Harness, url: string): Promise<void> {
  const worker = await harness.worker();
  await worker.evaluate(async ([rpcUrl, defaults]: [string, unknown]) => {
    // `chains` is ABSENT from storage until something writes it — background/storage.ts serves
    // BUILTIN_CHAINS as the default rather than seeding the store on install. So this seeds from
    // the same constant the wallet uses; the first version of this helper wrote `[]` over the
    // absent key, and the popup then correctly reported that it had no configured network. The
    // test looked like a wallet bug and was a harness bug.
    const got = await chrome.storage.local.get('chains') as { chains?: { id: number; rpcUrl: string }[] };
    const base = got.chains !== undefined && got.chains.length > 0
      ? got.chains
      : defaults as { id: number; rpcUrl: string }[];
    await chrome.storage.local.set({ chains: base.map((c) => (c.id === 7412 ? { ...c, rpcUrl } : c)) });
  }, [url, BUILTIN_CHAINS] as [string, unknown]);
}

export async function openPopup(harness: Harness): Promise<Page> {
  const page = await harness.context.newPage();
  await page.goto(`chrome-extension://${harness.extensionId}/popup.html`);
  return page;
}

/**
 * Install an EIP-6963 collector on a page BEFORE any wallet announces.
 *
 * `addInitScript` runs before the page's own scripts and before any content script in the MAIN
 * world at `document_start`, so nothing can be announced without this seeing it. Collecting after
 * load would miss the unprompted announcement every wallet makes on injection, and the test would
 * then "prove" that a wallet is undiscoverable when in fact the listener was late.
 */
export async function collectAnnouncements(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const found: { uuid: string; name: string; rdns: string; icon: string }[] = [];
    (window as unknown as { __announced: typeof found }).__announced = found;
    window.addEventListener('eip6963:announceProvider', (event) => {
      const detail = (event as CustomEvent<{ info: { uuid: string; name: string; rdns: string; icon: string } }>).detail;
      found.push({ ...detail.info });
      (window as unknown as { __providers: Record<string, unknown> }).__providers ??= {};
      (window as unknown as { __providers: Record<string, unknown> }).__providers[detail.info.rdns] =
        (detail as unknown as { provider: unknown }).provider;
    });
  });
}

/* ════════════════════════════════════════════════════════════════════════ the operator's side ═╗
 *
 * PHASES 5 AND 6 NEED A COUNTERPARTY, AND IT MUST NOT BE THE WALLET.
 *
 * §5.1 excludes market creation from this wallet deliberately — it is oracle role, category
 * curation, house seed and approval, and "putting it behind a self-custody key would either
 * duplicate it badly or grant powers the key was never meant to carry". So the tests need somebody
 * ELSE to deploy a market and to resolve it, and that somebody is this section: a plain signer
 * driven by the test, playing the operator that micro-foresight plays in production.
 *
 * Everything below therefore signs with the NODE'S OWN COINBASE KEY, read off disk, and none of it
 * runs inside the extension. The wallet's part of every test is only ever: read, stake, claim,
 * deploy a token. If a helper here ever grows into something the extension calls, the exclusion has
 * been broken.
 *
 * The key is read, never written, never logged and never committed — `coinbase-key.json` lives in
 * the node's data directory and this is a local testnet whose coins have no price.
 * ╚═══════════════════════════════════════════════════════════════════════════════════════════════*/

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import {
  fromHex, signTransaction, toChecksumAddress, keccak256, toHex as coreToHex,
} from '@cloudsforge/hearth-wallet-core';

const CHAIN: { id: number; name: string; network: string; currency: { name: string; symbol: string; decimals: number }; supportsEip1559: boolean } = {
  id: CHAIN_ID,
  name: 'Hearth Testnet',
  network: 'hearth-testnet',
  currency: { name: 'Ember', symbol: 'EMBER', decimals: 18 },
  // Hearth v1 has no base fee. The core derives this from three assertions in the node's source.
  supportsEip1559: false,
};

export interface Signer {
  readonly address: string;
  readonly key: Uint8Array;
}

/**
 * The funded account these tests spend from: the mining node's coinbase, read from its data
 * directory.
 *
 * WHY NOT A FAUCET OR A PREMINE. Hearth's genesis says "NO PREMINE" in terms, so on any Hearth
 * chain — this laptop's or CI's fresh one — the only account with a balance is a coinbase. Asking
 * micro-faucet would put a CloudsForge service in the path of a suite whose entire subject is that
 * no CloudsForge service is in the path.
 *
 * FAILS with a message naming what to start rather than skipping. A phase-5 suite that cannot spend
 * cannot prove anything, and one that quietly passes without spending is worse than none.
 */
export function fundedSigner(): Signer {
  const candidates = [
    process.env['HEARTH_COINBASE_KEY'],
    process.env['HEARTH_DATA'] === undefined ? undefined : join(process.env['HEARTH_DATA'], 'coinbase-key.json'),
    join(homedir(), '.cloudsforge', 'ember-testnet', 'miner', 'coinbase-key.json'),
  ].filter((p): p is string => p !== undefined);

  const found = candidates.find((p) => existsSync(p));
  if (found === undefined) {
    throw new Error(
      'These tests stake and deploy, so they need an account with a balance, and on a Hearth chain '
      + '(genesis.js: "NO PREMINE") that is a miner\'s coinbase. Looked for its key in:\n  '
      + `${candidates.join('\n  ')}\n`
      + 'Set HEARTH_DATA to the node\'s data directory, or HEARTH_COINBASE_KEY to the file.',
    );
  }
  const parsed = JSON.parse(readFileSync(found, 'utf8')) as { address?: string; privateKey?: string };
  if (typeof parsed.privateKey !== 'string' || typeof parsed.address !== 'string') {
    throw new Error(`${found} is not a Hearth coinbase key file`);
  }
  return { address: toChecksumAddress(parsed.address), key: fromHex(parsed.privateKey) };
}

/** The next nonce for an address, from `pending` — the same tag the wallet uses, for the same reason. */
export async function nonceOf(address: string): Promise<bigint> {
  return BigInt(String(await nodeRpc('eth_getTransactionCount', [address, 'pending'])));
}

/**
 * Sign and broadcast, as the operator. Legacy type 0, because Hearth has no base fee.
 *
 * The hash is DERIVED from the signed bytes rather than taken from the node's answer, and then the
 * two are compared. A node that echoes a different hash from the one the bytes have is a node whose
 * answers cannot be used to poll for a receipt — micro-mint's `evmTxHash` exists for the same
 * reason (`mint/src/evm.ts`).
 */
export async function operatorSend(
  signer: Signer,
  tx: { to: string | null; value?: bigint; data?: string; gas?: bigint },
): Promise<string> {
  const [nonce, gasPriceHex] = await Promise.all([nonceOf(signer.address), nodeRpc('eth_gasPrice')]);
  const gasPrice = BigInt(String(gasPriceHex));
  const signed = signTransaction({
    type: 0,
    nonce,
    gasPrice,
    gasLimit: tx.gas ?? 3_000_000n,
    to: tx.to,
    value: tx.value ?? 0n,
    data: tx.data ?? '0x',
  }, signer.key, CHAIN);

  const derived = coreToHex(keccak256(fromHex(signed.raw)));
  const hash = String(await nodeRpc('eth_sendRawTransaction', [signed.raw]));
  if (hash.toLowerCase() !== derived.toLowerCase()) {
    throw new Error(`the node called this transaction ${hash} but its bytes hash to ${derived}`);
  }
  return hash;
}

export interface Receipt {
  readonly status: number;
  readonly contractAddress: string | null;
  readonly blockNumber: number;
  readonly gasUsed: bigint;
}

/**
 * Wait for a receipt, and INSIST ON `status === 1`.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * A MINED TRANSACTION IS NOT A SUCCESSFUL ONE. A call that reverts is mined, gets a receipt, gets a
 * block number, and burns the gas — with `status: 0`. Every "did it work" question in this suite
 * goes through here rather than through "did an error appear on screen", because the phase-2 agent
 * measured that this node's refusals are byte-identical for different causes. An absence of error
 * is not evidence; a status word is.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
export async function waitForReceipt(hash: string, timeoutMs = 90_000): Promise<Receipt> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const raw = await nodeRpc('eth_getTransactionReceipt', [hash]);
    if (raw !== null && typeof raw === 'object') {
      const r = raw as Record<string, unknown>;
      const status = Number(BigInt(String(r['status'] ?? '0x0')));
      const receipt: Receipt = {
        status,
        contractAddress: typeof r['contractAddress'] === 'string' ? r['contractAddress'] : null,
        blockNumber: Number(BigInt(String(r['blockNumber'] ?? '0x0'))),
        gasUsed: BigInt(String(r['gasUsed'] ?? '0x0')),
      };
      if (status !== 1) {
        throw new Error(
          `${hash} was mined in block ${receipt.blockNumber} with status ${status} — it REVERTED. `
          + `${receipt.gasUsed} gas was burned. A receipt is not a success.`,
        );
      }
      return receipt;
    }
    await new Promise((done) => setTimeout(done, 700));
  }
  throw new Error(`${hash} was not mined within ${timeoutMs}ms`);
}

/** Read a contract, as the TEST — the independent witness for everything the wallet claims. */
export async function callContract(to: string, data: string, blockTag = 'latest'): Promise<string> {
  return String(await nodeRpc('eth_call', [{ to, data }, blockTag]));
}

/* ------------------------------------------------------- micro-foresight's committed contract - */

/**
 * `ForesightMarket`'s creation bytecode, read out of the sibling micro-foresight checkout.
 *
 * NOT COPIED INTO THIS REPOSITORY. The wallet does not deploy markets and must not carry the
 * bytecode to do it with; only the test needs it, and only to create something to stake in. It is a
 * PUBLIC repository, so CI clones it without a secret, and this FAILS rather than skipping when it
 * is absent.
 */
export function foresightMarketBytecode(): string {
  const candidates = [
    process.env['FORESIGHT_SRC'] === undefined ? null : join(process.env['FORESIGHT_SRC'], 'contracts', 'generated.ts'),
    resolve(REPO, '..', 'foresight', 'src', 'contracts', 'generated.ts'),
  ].filter((p): p is string => p !== null);
  const found = candidates.find((p) => existsSync(p));
  if (found === undefined) {
    throw new Error(
      'The Foresight suite needs micro-foresight beside this checkout for ForesightMarket\'s committed '
      + `bytecode — it deploys a real market to stake in. Looked in:\n  ${candidates.join('\n  ')}\n`
      + 'micro-foresight is PUBLIC; clone it as `foresight`, or set FORESIGHT_SRC.',
    );
  }
  const source = readFileSync(found, 'utf8');
  const match = /^export const FORESIGHTMARKET_BYTECODE =\s*\n\s*'(0x[0-9a-fA-F]+)'$/m.exec(source);
  if (match === null) throw new Error(`${found} has no FORESIGHTMARKET_BYTECODE in the expected shape`);
  return match[1]!;
}
