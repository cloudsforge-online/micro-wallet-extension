/* Phases 5 and 6: prediction markets, and token deployment. Both locally signed.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IS NOT IN THIS FILE.
 *
 *   - No cryptography. Every signature is `vault.signTx`, which is `@cloudsforge/hearth-wallet-core`
 *     (§3). No keccak, no secp256k1, no RLP.
 *   - No CloudsForge API in any path that reads a position, stakes, claims, deploys or reads a
 *     token back. The only outbound call other than JSON-RPC in the whole feature is
 *     `discovery.discoverMarkets`, which is off by default, contributes two strings, and cannot
 *     throw. §5.1: "positions survive the platform."
 *   - No market creation. §5.1 excludes it deliberately: it needs the oracle role, category
 *     curation, the house seed and approval, and putting operator machinery behind a self-custody
 *     key would either duplicate it badly or grant powers the key was never meant to carry. There
 *     is no `createMarket` here and adding one is not a small change.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * EVERY PREVIEW IS RE-DERIVED BEFORE IT IS SIGNED. `previewStake` and `stake` both read the market
 * and both build the transaction; the second does not trust the first. On a chain that mines every
 * couple of seconds the nonce, the gas price and the pool can all have moved while the user read
 * the screen — and a nonce that has been used since produces a transaction the mempool drops with
 * no error anybody sees. background/index.ts's `execute` has done this for the dapp path since
 * phase 2, for the same reason.
 */

import { INVALID_PARAMS, ProviderError, UNAUTHORIZED } from '../shared/errors.ts';
import {
  claimCallData, isClaimable, isStakeable, projectStake, stakeCallData, whyNotClaimable,
  type MarketObservation, type Outcome, type StakeProjection,
} from '../shared/foresight.ts';
import {
  TEMPLATES, templateFor, type Template, type TokenInput, type Variant,
} from '../shared/templates.ts';
import { parseUnits } from '../shared/units.ts';
import type { TransactionPreview } from '../shared/protocol.ts';

import {
  buildDeployment, deployedAddress, readMarket, readToken, requireAddress,
  MINT_SOURCE_SHA256, type DeploymentPlan, type TokenFacts,
} from './contracts.ts';
import { discoverMarkets, normaliseApiUrl, type DiscoveryResult } from './discovery.ts';
import { previewTransaction, selectedChain } from './handlers.ts';
import { requireUnlocked, touchSession } from './session.ts';
import { getLocal, setLocal, type DeployedToken, type WatchedMarket } from './storage.ts';
import { ARTEFACTS } from './templates.generated.ts';
import { getNonce, sendRaw } from './rpc.ts';
import { signTx } from './vault.ts';

/* ------------------------------------------------------------------------------ the account --- */

/** The account these screens act as: the selected one, or the first, and never a watch-only. */
async function actingAccount(): Promise<string> {
  const [accounts, settings] = await Promise.all([getLocal('accounts'), getLocal('settings')]);
  const chosen = accounts.find((a) => a.address === settings.selectedAddress) ?? accounts[0];
  if (chosen === undefined) throw new ProviderError(UNAUTHORIZED, 'This wallet has no accounts.');
  if (chosen.source === 'watch-only') {
    // A watch-only address can be READ against a market — that is the whole point of it — but it
    // cannot sign, and finding that out at the moment of signing is worse than finding it out now.
    throw new ProviderError(
      UNAUTHORIZED,
      `${chosen.label} is a watch-only address. This wallet holds no key for it, so it can see a position and not act on one.`,
    );
  }
  return chosen.address;
}

/** The selected account for a READ. Watch-only is fine here, and so is having none at all. */
async function viewingAccount(): Promise<string | null> {
  const [accounts, settings] = await Promise.all([getLocal('accounts'), getLocal('settings')]);
  return (accounts.find((a) => a.address === settings.selectedAddress) ?? accounts[0])?.address ?? null;
}

/**
 * Sign and broadcast a transaction the wallet itself composed.
 *
 * The preview is built HERE, from the caller's fields, and the fee overrides are applied to it —
 * so the gas limit and price a user edited on screen are the ones signed, and everything else
 * (nonce, chain, estimate) is whatever the node says right now.
 */
async function signAndSend(
  tx: Record<string, unknown>,
  overrides: { gas: string | undefined; gasPrice: string | undefined },
): Promise<{ hash: string; raw: string; preview: TransactionPreview }> {
  await requireUnlocked();
  const chain = await selectedChain();
  const preview = await previewTransaction('wallet', tx, chain);
  const signed = await signTx(preview.from, {
    type: 0,
    nonce: BigInt(preview.nonce),
    gasPrice: BigInt(overrides.gasPrice ?? preview.gasPrice),
    gasLimit: BigInt(overrides.gas ?? preview.gas),
    to: preview.to,
    value: BigInt(preview.valueWei),
    data: preview.data,
  }, chain);
  await touchSession();
  return { hash: await sendRaw(chain, signed), raw: signed, preview };
}

function requireOutcome(value: unknown): Outcome {
  if (value !== 0 && value !== 1 && value !== '0' && value !== '1') {
    throw new ProviderError(INVALID_PARAMS, 'An outcome is 0 (YES) or 1 (NO). This market has no others.');
  }
  return Number(value) as Outcome;
}

function requireWei(value: unknown, what: string): bigint {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new ProviderError(INVALID_PARAMS, `${what} must be an integer number of wei, as a string.`);
}

/* ---------------------------------------------------------------------------- market reading -- */

export async function market(address: unknown): Promise<MarketObservation> {
  const chain = await selectedChain();
  return readMarket(chain, requireAddress(address, 'The market address'), await viewingAccount());
}

export interface StakePlan {
  readonly observation: MarketObservation;
  readonly projection: StakeProjection;
  readonly tx: TransactionPreview;
  /** Why the contract would refuse this, or null. Checked before the user pays for the refusal. */
  readonly refusal: string | null;
}

/**
 * Everything the stake screen draws, computed in one pass so the pool, the odds, the projection and
 * the gas estimate all describe the same block.
 */
export async function previewStake(payload: Record<string, unknown>): Promise<StakePlan> {
  const chain = await selectedChain();
  const address = requireAddress(payload['address'], 'The market address');
  const outcome = requireOutcome(payload['outcome']);
  const amountWei = requireWei(payload['amountWei'], 'The stake');
  const from = await actingAccount();

  const observation = await readMarket(chain, address, from);
  const projection = projectStake(observation, outcome, amountWei);

  let refusal: string | null = null;
  if (amountWei === 0n) refusal = 'ForesightMarket refuses a zero stake. Nothing would be recorded and the fee would still be spent.';
  else if (!isStakeable(observation)) {
    refusal = observation.status !== 'open'
      ? `This market is ${observation.status}. Only an open market takes a stake.`
      : `This market closed at ${new Date(observation.closeTime * 1000).toISOString()}, and the chain’s clock at block ${observation.blockNumber} is already past it.`;
  }

  const tx = await previewTransaction('wallet', {
    from,
    to: address,
    value: `0x${amountWei.toString(16)}`,
    data: stakeCallData(outcome),
  }, chain);

  return { observation, projection, tx, refusal };
}

export async function stake(payload: Record<string, unknown>): Promise<{ hash: string; raw: string; observationBlock: number }> {
  const address = requireAddress(payload['address'], 'The market address');
  const outcome = requireOutcome(payload['outcome']);
  const amountWei = requireWei(payload['amountWei'], 'The stake');
  const from = await actingAccount();
  const chain = await selectedChain();

  // Read the market AGAIN, immediately before signing, and refuse on the contract's own rules. The
  // screen the user approved may be a minute old; a market that closed in that minute would take
  // the fee and record nothing. This is not a substitute for the contract's check — it is the same
  // check, made where it costs nothing.
  const observation = await readMarket(chain, address, from);
  if (!isStakeable(observation)) {
    throw new ProviderError(
      INVALID_PARAMS,
      observation.status !== 'open'
        ? `This market is ${observation.status} as of block ${observation.blockNumber}, so the contract would reject this stake and keep the fee.`
        : `This market closed at ${new Date(observation.closeTime * 1000).toISOString()}; block ${observation.blockNumber} is already past it, so the contract would reject this stake and keep the fee.`,
    );
  }
  if (amountWei === 0n) throw new ProviderError(INVALID_PARAMS, 'A stake of zero reverts. Nothing would be recorded.');

  const sent = await signAndSend({
    from,
    to: address,
    value: `0x${amountWei.toString(16)}`,
    data: stakeCallData(outcome),
  }, { gas: optionalString(payload['gas']), gasPrice: optionalString(payload['gasPrice']) });

  await remember(address, payload['label'], 'staked');
  return { hash: sent.hash, raw: sent.raw, observationBlock: observation.blockNumber };
}

export interface ClaimPlan {
  readonly observation: MarketObservation;
  readonly tx: TransactionPreview | null;
  readonly refusal: string | null;
}

export async function previewClaim(payload: Record<string, unknown>): Promise<ClaimPlan> {
  const chain = await selectedChain();
  const address = requireAddress(payload['address'], 'The market address');
  const from = await actingAccount();
  const observation = await readMarket(chain, address, from);
  const refusal = whyNotClaimable(observation);
  // No gas estimate for a call the contract would revert: `eth_estimateGas` would fail, the
  // preview would fall back to 21,000 with a danger warning, and the screen would be arguing with
  // itself. The refusal already says what is wrong in the contract's own words.
  const tx = refusal === null
    ? await previewTransaction('wallet', { from, to: address, data: claimCallData() }, chain)
    : null;
  return { observation, tx, refusal };
}

export async function claim(payload: Record<string, unknown>): Promise<{ hash: string; raw: string; expectedWei: string }> {
  const address = requireAddress(payload['address'], 'The market address');
  const from = await actingAccount();
  const chain = await selectedChain();

  const observation = await readMarket(chain, address, from);
  if (!isClaimable(observation)) {
    throw new ProviderError(INVALID_PARAMS, whyNotClaimable(observation) ?? 'The contract would refuse this claim.');
  }

  const sent = await signAndSend(
    { from, to: address, data: claimCallData() },
    { gas: optionalString(payload['gas']), gasPrice: optionalString(payload['gasPrice']) },
  );
  // The amount `payoutOf` said at the block just read. NOT a promise — the claim is not mined yet,
  // and `_claim` recomputes it. The UI labels it as what was owed when the wallet looked.
  return { hash: sent.hash, raw: sent.raw, expectedWei: observation.myPayoutWei };
}

/* -------------------------------------------------------------------------- the watch list ---- */

async function remember(address: string, label: unknown, source: string): Promise<WatchedMarket[]> {
  const markets = await getLocal('markets');
  const already = markets.find((m) => m.address.toLowerCase() === address.toLowerCase());
  if (already !== undefined) return markets;
  const next: WatchedMarket[] = [...markets, {
    address,
    label: typeof label === 'string' && label.trim() !== '' ? label.trim().slice(0, 200) : address,
    addedAt: Date.now(),
    source,
  }];
  await setLocal('markets', next);
  return next;
}

export async function watchMarket(payload: Record<string, unknown>): Promise<WatchedMarket[]> {
  const address = requireAddress(payload['address'], 'The market address');
  const chain = await selectedChain();
  // Read it before remembering it. A typo saved into the list is a row that fails every time it is
  // opened, and the user has no way to tell that from a market that has gone away.
  const observation = await readMarket(chain, address, null);
  return remember(observation.address, payload['label'], typeof payload['source'] === 'string' ? payload['source'] : 'pasted');
}

export async function unwatchMarket(payload: Record<string, unknown>): Promise<WatchedMarket[]> {
  const address = requireAddress(payload['address'], 'The market address');
  const markets = await getLocal('markets');
  const next = markets.filter((m) => m.address.toLowerCase() !== address.toLowerCase());
  await setLocal('markets', next);
  return next;
}

export async function discovery(): Promise<DiscoveryResult> {
  const settings = await getLocal('settings');
  return discoverMarkets(settings.foresightApiUrl);
}

export async function setDiscovery(payload: Record<string, unknown>): Promise<{ url: string | null }> {
  const raw = payload['url'];
  const url = raw === null || raw === undefined || raw === '' ? null : normaliseApiUrl(String(raw));
  const settings = await getLocal('settings');
  await setLocal('settings', { ...settings, foresightApiUrl: url });
  return { url };
}

/* ------------------------------------------------------------------------ token deployment ---- */

export interface TemplateView extends Template {
  readonly bytecodeSha256: string;
  readonly bytecodeBytes: number;
  readonly constructorInputs: readonly { readonly name: string; readonly type: string }[];
}

export function templates(): { templates: TemplateView[]; mintSourceSha256: string } {
  return {
    templates: TEMPLATES.map((template) => {
      const artefact = ARTEFACTS[template.contract];
      if (artefact === undefined) throw new ProviderError(INVALID_PARAMS, `no artefact for ${template.contract}`);
      return {
        ...template,
        bytecodeSha256: artefact.bytecodeSha256,
        bytecodeBytes: (artefact.bytecode.length - 2) / 2,
        constructorInputs: artefact.constructorInputs,
      };
    }),
    mintSourceSha256: MINT_SOURCE_SHA256,
  };
}

/**
 * Turn the form into a `TokenInput`.
 *
 * SUPPLY AND CAP ARRIVE AS WHOLE TOKENS AND LEAVE AS BASE UNITS. The constructor takes
 * `initialSupply_` in the token's smallest unit (`ForgeTokens.sol:38` mints exactly that number),
 * and a user typing "1000000" means a million tokens, not a millionth of one. `parseUnits` refuses
 * more fraction digits than the token has rather than truncating — a supply quietly rounded is a
 * supply that is not the one somebody asked for, and the confirmation screen shows BOTH figures so
 * the conversion is checkable rather than trusted.
 */
function tokenInputFrom(payload: Record<string, unknown>, template: Template, owner: string): TokenInput {
  const decimals = Number(payload['decimals']);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new ProviderError(INVALID_PARAMS, 'decimals is a whole number from 0 to 18.');
  }
  const supplyText = String(payload['supply'] ?? '').trim();
  const capText = String(payload['cap'] ?? '').trim();
  let supply: bigint;
  try {
    supply = parseUnits(supplyText, decimals);
  } catch (cause) {
    throw new ProviderError(INVALID_PARAMS, `Supply: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  let cap: bigint | null = null;
  if (template.cap === 'required') {
    try {
      cap = parseUnits(capText, decimals);
    } catch (cause) {
      throw new ProviderError(INVALID_PARAMS, `Cap: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return {
    name: String(payload['name'] ?? ''),
    symbol: String(payload['symbol'] ?? ''),
    decimals,
    supply,
    cap,
    owner,
  };
}

export interface DeployPlan {
  readonly plan: DeploymentPlan;
  readonly tx: TransactionPreview;
  /** `keccak256(rlp([sender, nonce]))[12:]` — where this lands, known before it is sent. */
  readonly predictedAddress: string;
  readonly nonce: string;
  /** The whole-token figures, beside the base-unit integers, so the conversion is checkable. */
  readonly supplyTokens: string;
  readonly capTokens: string | null;
}

export async function previewDeploy(payload: Record<string, unknown>): Promise<DeployPlan> {
  const chain = await selectedChain();
  const from = await actingAccount();
  const template = templateFor(String(payload['variant']) as Variant);
  const input = tokenInputFrom(payload, template, from);
  const plan = buildDeployment(template.variant, input);

  const tx = await previewTransaction('wallet', { from, to: null, value: '0x0', data: plan.data }, chain);
  const nonce = BigInt(tx.nonce);
  return {
    plan,
    tx,
    predictedAddress: deployedAddress(from, nonce),
    nonce: nonce.toString(),
    supplyTokens: String(payload['supply'] ?? ''),
    capTokens: template.cap === 'required' ? String(payload['cap'] ?? '') : null,
  };
}

export async function deployToken(payload: Record<string, unknown>): Promise<{
  hash: string; raw: string; address: string; nonce: string; contract: string;
}> {
  const chain = await selectedChain();
  const from = await actingAccount();
  const template = templateFor(String(payload['variant']) as Variant);
  const input = tokenInputFrom(payload, template, from);
  const plan = buildDeployment(template.variant, input);

  // The nonce is read here and the address derived from it, and then the SAME nonce is what the
  // signed transaction carries — `signAndSend` re-previews and could otherwise pick up a different
  // one, leaving the wallet remembering an address the contract is not at. `contractAddress` is a
  // total function of (sender, nonce) and disagreeing about either half is silent.
  const nonce = await getNonce(chain, from);
  const address = deployedAddress(from, nonce);

  const sent = await signAndSend({
    from,
    to: null,
    value: '0x0',
    data: plan.data,
    nonce: `0x${nonce.toString(16)}`,
  }, { gas: optionalString(payload['gas']), gasPrice: optionalString(payload['gasPrice']) });

  const tokens = await getLocal('tokens');
  const record: DeployedToken = {
    address,
    chainId: chain.id,
    contract: plan.contract,
    symbol: input.symbol,
    name: input.name,
    decimals: input.decimals,
    deployedBy: from,
    txHash: sent.hash,
    at: Date.now(),
  };
  await setLocal('tokens', [record, ...tokens.filter((t) => t.address !== address)]);

  return { hash: sent.hash, raw: sent.raw, address, nonce: nonce.toString(), contract: plan.contract };
}

/** Read a deployed token back off the chain. The only proof that a deployment worked. */
export async function token(payload: Record<string, unknown>): Promise<TokenFacts> {
  const chain = await selectedChain();
  return readToken(chain, requireAddress(payload['address'], 'The token address'), await viewingAccount());
}

function optionalString(value: unknown): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : String(value);
}
