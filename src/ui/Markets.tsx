/* Prediction markets, read from the contract and signed by the key on this device.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * THE SCREEN'S JOB IS TO STATE WHAT WAS OBSERVED, AND TO SAY WHEN.
 *
 * §5.1: "Odds are read at signing time and shown as they were. A parimutuel's odds move with every
 * stake including your own, so the confirmation screen states the pool AS OBSERVED and does not
 * imply the displayed odds are the settled ones. A wallet that shows a fixed payout on a parimutuel
 * is lying, cheerfully."
 *
 * Three rules follow, and they are why this file is shaped the way it is:
 *
 *   1. EVERY NUMBER CARRIES ITS BLOCK. The pool, the odds and the position all come from one
 *      observation pinned to one block (background/contracts.ts), and the block number is on the
 *      screen next to them rather than in a tooltip.
 *   2. THE PROJECTION IS NEVER CALLED A PAYOUT. It is "if it settled at this instant", it is
 *      rendered in the same weight as the caveat that follows it, and the caveat is a field on the
 *      projection rather than a string in this file — so a screen cannot forget to draw it.
 *   3. THE QUESTION TEXT IS NOT THE CHAIN'S. The contract stores `questionHash` and nothing else,
 *      so with no directory configured this wallet knows the hash and does not know the words.
 *      It says so, rather than showing a blank where a question should be.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */

import { useCallback, useEffect, useState } from 'react';
import { call, type WalletState } from './client.ts';
import {
  formatBps, isClaimable, isStakeable, outcomeName, whyNotClaimable,
  type MarketObservation, type Outcome, type StakeProjection,
} from '../shared/foresight.ts';
import type { TransactionPreview } from '../shared/protocol.ts';
import { formatUnits, parseUnits, shortAddress } from '../shared/units.ts';

interface WatchedMarket { address: string; label: string; addedAt: number; source: string }
interface DiscoveryResult {
  configured: boolean;
  reachable: boolean;
  markets: { address: string; question: string }[];
  note: string;
}
interface StakePlan {
  observation: MarketObservation;
  projection: StakeProjection;
  tx: TransactionPreview;
  refusal: string | null;
}
interface ClaimPlan { observation: MarketObservation; tx: TransactionPreview | null; refusal: string | null }
interface WatchResult { markets: WatchedMarket[]; observation: MarketObservation }

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export function Markets(props: { chain: WalletState['chains'][number]; address: string }): React.JSX.Element {
  const [watched, setWatched] = useState<WatchedMarket[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  // The observation the worker already made while validating a pasted address, handed to the
  // market view so opening a market costs one read rather than two.
  const [opened, setOpened] = useState<MarketObservation | null>(null);
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);

  const reload = useCallback(async () => {
    setWatched(await call<WatchedMarket[]>('watchedMarkets'));
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    // Asked once, on open, and never on a timer: a wallet polling a CloudsForge endpoint in the
    // background is a wallet telling CloudsForge when its user is awake. With discovery off — the
    // default — this resolves without touching the network at all.
    void call<DiscoveryResult>('discoverMarkets').then(setDiscovery).catch(() => setDiscovery(null));
  }, []);

  if (selected !== null) {
    return (
      <Market
        address={selected}
        chain={props.chain}
        viewer={props.address}
        initial={opened !== null && opened.address.toLowerCase() === selected.toLowerCase() ? opened : null}
        onBack={() => { setSelected(null); setOpened(null); void reload(); }}
      />
    );
  }

  const add = (address: string, label: string, source: string): void => {
    setBusy(true);
    setError(null);
    void call<WatchResult>('watchMarket', { address, label, source })
      .then((result) => {
        setWatched(result.markets);
        setPaste('');
        setOpened(result.observation);
        setSelected(result.observation.address);
      })
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <div>
      <h2>Open a market by address</h2>
      <p className="muted">
        Everything on the next screen — the pool, the odds, your stake and what you are owed — is
        read from the contract at this address on {props.chain.name}. No CloudsForge service is
        involved, and none has to be running.
      </p>
      <input
        className="mono"
        data-testid="market-address"
        spellCheck={false}
        placeholder="0x… the market contract"
        value={paste}
        onChange={(e) => setPaste(e.target.value)}
      />
      <button
        className="primary wide"
        style={{ marginTop: 6 }}
        data-testid="market-open"
        disabled={busy || paste.trim() === ''}
        onClick={() => add(paste.trim(), paste.trim(), 'pasted')}
      >
        {busy ? 'Reading the contract…' : 'Open this market'}
      </button>
      {error !== null ? <p className="error" data-testid="market-error">{error}</p> : null}

      {watched.length > 0 ? (
        <>
          <h2>Markets you have opened</h2>
          <ul className="list" data-testid="market-list">
            {watched.map((m) => (
              <li key={m.address}>
                <div className="row between">
                  <button className="ghost grow" style={{ textAlign: 'left' }} data-testid={`market-${m.address}`} onClick={() => setSelected(m.address)}>
                    <span className="mono">{shortAddress(m.address)}</span>
                    {m.label !== m.address ? <span className="muted"> · {m.label}</span> : null}
                  </button>
                  <button className="danger" onClick={() => { void call<WatchedMarket[]>('unwatchMarket', { address: m.address }).then(setWatched); }}>
                    Forget
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h2>Discovery</h2>
      {/* The honest degradation, stated on the screen rather than in a release note.
       *
       * THE LOADING STATE HAS A DIFFERENT `data-testid` FROM THE LOADED ONE, deliberately. An
       * earlier version rendered both through `discovery-note` and switched the text between them,
       * which meant a test waiting for that element got it immediately — while it still said
       * "Checking…" — and then asserted against the wrong string. Locally the worker answered in
       * milliseconds so it never raced; in CI, where the service worker starts cold, it did. An
       * element that is present in two states cannot be waited on, so there are two elements. */}
      {discovery === null ? (
        <div className="warn" data-testid="discovery-checking">
          <strong>Checking…</strong>
          <span>Asking the worker whether a directory is configured. Nothing on the screens below depends on the answer.</span>
        </div>
      ) : (
        <div className={discovery.reachable ? 'panel' : 'warn'} data-testid="discovery-note">
          <strong>
            {discovery.configured
              ? (discovery.reachable ? 'A directory is configured' : 'The directory is not answering')
              : 'Off — this wallet is talking only to the chain'}
          </strong>
          <span>{discovery.note}</span>
        </div>
      )}
      {discovery !== null && discovery.markets.length > 0 ? (
        <ul className="list" data-testid="discovered-list">
          {discovery.markets.map((m) => (
            <li key={m.address}>
              <div>{m.question}</div>
              <div className="row between" style={{ marginTop: 6 }}>
                <span className="mono muted">{shortAddress(m.address)}</span>
                <button onClick={() => add(m.address, m.question, 'directory')}>Open</button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="muted">
        A directory can tell you which markets exist and what each one asks in words. It is never
        asked for a pool, a price, a position or a payout — those come from the contract, so a
        directory that is down, wrong or hostile cannot change what this wallet shows you or stop
        you claiming.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------------------- one market --- */

function Market(props: {
  address: string; chain: WalletState['chains'][number]; viewer: string;
  initial: MarketObservation | null; onBack: () => void;
}): React.JSX.Element {
  const [observation, setObservation] = useState<MarketObservation | null>(props.initial);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    // `tick === 0` and an observation already in hand means the worker read this market a moment
    // ago while validating the address. Reading it again immediately would show the same numbers
    // from a block one or two later, at the cost of doubling the wait on a slow node.
    if (tick === 0 && props.initial !== null) return undefined;
    let live = true;
    setObservation(null);
    setError(null);
    void call<MarketObservation>('market', { address: props.address })
      .then((m) => { if (live) setObservation(m); })
      .catch((cause: unknown) => { if (live) setError(errorText(cause)); });
    return () => { live = false; };
  }, [props.address, props.chain.id, props.viewer, tick]);

  const refresh = (): void => setTick((t) => t + 1);

  return (
    <div>
      <button className="ghost" data-testid="market-back" onClick={props.onBack}>← All markets</button>
      <div className="mono" style={{ marginTop: 6 }} data-testid="market-shown-address">{props.address}</div>

      {error !== null ? <p className="error" data-testid="market-read-error">{error}</p> : null}
      {observation === null && error === null ? <p className="muted">Reading the contract…</p> : null}

      {observation !== null ? (
        <>
          <Observed m={observation} chain={props.chain} />
          <StakeForm m={observation} chain={props.chain} onDone={refresh} />
          <ClaimPanel m={observation} chain={props.chain} onDone={refresh} />
          <button className="wide" style={{ marginTop: 12 }} data-testid="market-refresh" onClick={refresh}>Read the contract again</button>
        </>
      ) : null}
    </div>
  );
}

function Observed(props: { m: MarketObservation; chain: WalletState['chains'][number] }): React.JSX.Element {
  const { m } = props;
  const symbol = props.chain.currency.symbol;
  const stale = Math.max(0, Math.round((Date.now() - m.observedAt) / 1000));

  return (
    <div>
      <div className="row between" style={{ marginTop: 10 }}>
        <span className="chip" data-testid="market-status">{m.status}</span>
        <span className="muted" data-testid="market-block">read at block {m.blockNumber}{stale > 4 ? `, ${stale}s ago` : ''}</span>
      </div>

      {/* The chain stores a HASH of the question, not the question. Saying so is the difference
          between a wallet that does not know and a wallet that pretends the market has no subject. */}
      <div className="panel" style={{ marginTop: 8 }}>
        <div className="muted">Question hash, as the contract holds it</div>
        <div className="mono" data-testid="market-question-hash">{m.questionHash}</div>
        <p className="muted" style={{ marginTop: 6 }}>
          The contract stores only this hash. The words of the question live off-chain, so this
          wallet cannot show them to you from the chain alone — and will not invent them.
        </p>
      </div>

      <div className="panel" style={{ marginTop: 8 }}>
        <div className="row between">
          <strong>YES</strong>
          <span data-testid="pool-yes">{formatUnits(BigInt(m.poolYesWei), 18, 6)} {symbol} · <span data-testid="odds-yes">{formatBps(m.oddsYesBps)}</span></span>
        </div>
        <div className="row between" style={{ marginTop: 6 }}>
          <strong>NO</strong>
          <span data-testid="pool-no">{formatUnits(BigInt(m.poolNoWei), 18, 6)} {symbol} · <span data-testid="odds-no">{formatBps(m.oddsNoBps)}</span></span>
        </div>
        <hr />
        <div className="row between">
          <span className="muted">Whole pool</span>
          <span data-testid="pool-total">{formatUnits(BigInt(m.totalWei), 18, 6)} {symbol}</span>
        </div>
        <div className="row between" style={{ marginTop: 4 }}>
          <span className="muted">Settlement fee, taken from the losing pool only</span>
          <span>{formatBps(m.feeBps)}</span>
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          These are the pool figures {props.chain.name} reported at block {m.blockNumber}. They are a
          share of a pot, not a price: the odds move with every stake, including yours.
        </p>
      </div>

      <div className="panel" style={{ marginTop: 8 }}>
        <div className="muted">Your position, for {shortAddress(m.viewer ?? '—')}</div>
        <div className="row between" style={{ marginTop: 4 }}>
          <span>on YES</span><span data-testid="my-yes">{formatUnits(BigInt(m.myYesWei), 18, 6)} {symbol}</span>
        </div>
        <div className="row between" style={{ marginTop: 4 }}>
          <span>on NO</span><span data-testid="my-no">{formatUnits(BigInt(m.myNoWei), 18, 6)} {symbol}</span>
        </div>
        <div className="row between" style={{ marginTop: 4 }}>
          <span className="muted">payoutOf() says you are owed</span>
          <span data-testid="my-payout">{formatUnits(BigInt(m.myPayoutWei), 18, 6)} {symbol}</span>
        </div>
        {m.myClaimed ? <p className="muted" style={{ marginTop: 6 }} data-testid="already-claimed">This address has already claimed.</p> : null}
      </div>

      {m.status === 'resolved' ? (
        <p className="muted" style={{ marginTop: 8 }} data-testid="market-outcome">
          Resolved {outcomeName(m.winningOutcome ?? -1)}
          {m.claimableFrom === null ? '' : `, claimable from ${new Date(m.claimableFrom * 1000).toISOString()}`}.
          The oracle is {m.oracle} — it can set an outcome and it can do nothing else. It cannot move
          your stake, and it never held it.
        </p>
      ) : null}
      {m.status === 'void' ? (
        <p className="muted" style={{ marginTop: 8 }} data-testid="market-outcome">
          Voided. Everybody is refunded in full — the contract charges no fee on a void.
        </p>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------------------------- staking --- */

function StakeForm(props: { m: MarketObservation; chain: WalletState['chains'][number]; onDone: () => void }): React.JSX.Element | null {
  const [outcome, setOutcome] = useState<Outcome>(0);
  const [amount, setAmount] = useState('');
  const [plan, setPlan] = useState<StakePlan | null>(null);
  const [gas, setGas] = useState('');
  const [gasPrice, setGasPrice] = useState('');
  const [hash, setHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const symbol = props.chain.currency.symbol;

  if (!isStakeable(props.m)) {
    return (
      <p className="muted" style={{ marginTop: 12 }} data-testid="stake-closed">
        This market is not taking stakes: it is {props.m.status}
        {props.m.status === 'open' ? `, and closed at ${new Date(props.m.closeTime * 1000).toISOString()}` : ''}.
      </p>
    );
  }

  let amountWei: bigint | null = null;
  try { amountWei = amount.trim() === '' ? null : parseUnits(amount, 18); } catch { amountWei = null; }

  if (hash !== null) {
    return (
      <div style={{ marginTop: 12 }}>
        <p className="ok">Stake broadcast.</p>
        <div className="mono" data-testid="stake-hash">{hash}</div>
        <p className="muted" style={{ marginTop: 8 }}>
          The node accepted it. Your stake is not in the pool until it is in a block — and the odds
          you saw will have moved by then, including because of this.
        </p>
        <button className="wide" style={{ marginTop: 8 }} data-testid="stake-again" onClick={() => { setHash(null); setPlan(null); setAmount(''); props.onDone(); }}>
          Read the contract again
        </button>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 14 }}>
      <h2>Stake</h2>
      <div className="row">
        <button aria-pressed={outcome === 0} className={outcome === 0 ? 'primary grow' : 'grow'} data-testid="stake-yes" onClick={() => { setOutcome(0); setPlan(null); }}>YES</button>
        <button aria-pressed={outcome === 1} className={outcome === 1 ? 'primary grow' : 'grow'} data-testid="stake-no" onClick={() => { setOutcome(1); setPlan(null); }}>NO</button>
      </div>
      <label htmlFor="stake-amount">Amount ({symbol})</label>
      <input id="stake-amount" data-testid="stake-amount" value={amount} onChange={(e) => { setAmount(e.target.value); setPlan(null); }} placeholder="0.0" />

      {plan === null ? (
        <button
          className="primary wide"
          style={{ marginTop: 10 }}
          data-testid="stake-preview"
          disabled={busy || amountWei === null || amountWei === 0n}
          onClick={() => {
            setBusy(true);
            setError(null);
            void call<StakePlan>('previewStake', { address: props.m.address, outcome, amountWei: (amountWei ?? 0n).toString() })
              .then((p) => { setPlan(p); setGas(p.tx.gas); setGasPrice(p.tx.gasPrice); })
              .catch((cause: unknown) => setError(errorText(cause)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Reading the pool…' : 'Check this stake'}
        </button>
      ) : (
        <div style={{ marginTop: 10 }}>
          <Projection plan={plan} symbol={symbol} />
          {plan.refusal !== null ? <div className="warn danger" data-testid="stake-refusal"><strong>The contract would refuse this</strong><span>{plan.refusal}</span></div> : null}

          <div className="panel">
            <label htmlFor="stake-gas">Gas limit</label>
            <input id="stake-gas" data-testid="stake-gas" value={gas} onChange={(e) => setGas(e.target.value)} />
            <label htmlFor="stake-gp">Gas price (wei)</label>
            <input id="stake-gp" data-testid="stake-gasprice" value={gasPrice} onChange={(e) => setGasPrice(e.target.value)} />
            <p className="muted" style={{ marginTop: 6 }}>
              Maximum fee {formatUnits(BigInt(gas || '0') * BigInt(gasPrice || '0'), 18, 8)} {symbol} · nonce {plan.tx.nonce}.
              The fee is spent whether the call succeeds or reverts.
            </p>
          </div>

          <button
            className="primary wide"
            style={{ marginTop: 10 }}
            data-testid="stake-submit"
            disabled={busy || plan.refusal !== null}
            onClick={() => {
              setBusy(true);
              setError(null);
              void call<{ hash: string }>('stake', {
                address: props.m.address, outcome, amountWei: (amountWei ?? 0n).toString(), gas, gasPrice,
              })
                .then((r) => setHash(r.hash))
                .catch((cause: unknown) => setError(errorText(cause)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? 'Signing…' : `Stake ${amount} ${symbol} on ${outcomeName(outcome)}`}
          </button>
        </div>
      )}
      {error !== null ? <p className="error" data-testid="stake-error">{error}</p> : null}
    </div>
  );
}

/**
 * The projection, and the sentence that stops it being a lie.
 *
 * The caveat is `plan.projection.caveat` — a field computed with the numbers, not a string typed
 * here — so a screen physically cannot render the figure without it. That is on purpose: the one
 * failure mode §5.1 names is a wallet that shows a fixed payout on a parimutuel, and the way that
 * happens is somebody tidying a paragraph away from beside a number.
 */
function Projection(props: { plan: StakePlan; symbol: string }): React.JSX.Element {
  const p = props.plan.projection;
  const net = BigInt(p.netIfResolvedNowWei);
  return (
    <div className="panel" data-testid="stake-projection">
      <div className="row between">
        <span className="muted">Pool on {outcomeName(p.outcome)} as observed</span>
        <span data-testid="projection-odds-before">{formatBps(p.oddsBeforeBps)}</span>
      </div>
      <div className="row between" style={{ marginTop: 4 }}>
        <span className="muted">…the instant after this stake, if nothing else changed</span>
        <span data-testid="projection-odds-after">{formatBps(p.oddsAfterBps)}</span>
      </div>
      <hr />
      <div className="row between">
        <span className="muted">If it settled {outcomeName(p.outcome)} at this exact pool, your share would be</span>
        <strong data-testid="projection-share">{formatUnits(BigInt(p.shareIfResolvedNowWei), 18, 6)} {props.symbol}</strong>
      </div>
      <div className="row between" style={{ marginTop: 4 }}>
        <span className="muted">…which is {net < 0n ? 'less than' : 'more than'} what you would have staked, by</span>
        <span data-testid="projection-net">{formatUnits(net < 0n ? -net : net, 18, 6)} {props.symbol}</span>
      </div>
      {/* Rendered from the projection, never typed here. */}
      <div className="warn" style={{ marginTop: 10 }} data-testid="projection-caveat">
        <strong>This is not a payout</strong>
        <span>{p.caveat}</span>
      </div>
      <p className="muted" style={{ marginTop: 6 }} data-testid="projection-block">
        Every figure above was read at block {p.blockNumber}.
      </p>
    </div>
  );
}

/* --------------------------------------------------------------------------------- claiming --- */

function ClaimPanel(props: { m: MarketObservation; chain: WalletState['chains'][number]; onDone: () => void }): React.JSX.Element | null {
  const [plan, setPlan] = useState<ClaimPlan | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const symbol = props.chain.currency.symbol;

  if (props.m.status === 'open' && BigInt(props.m.myYesWei) + BigInt(props.m.myNoWei) === 0n) return null;

  const why = whyNotClaimable(props.m);

  if (hash !== null) {
    return (
      <div style={{ marginTop: 14 }}>
        <p className="ok">Claim broadcast.</p>
        <div className="mono" data-testid="claim-hash">{hash}</div>
        <button className="wide" style={{ marginTop: 8 }} data-testid="claim-done" onClick={() => { setHash(null); props.onDone(); }}>Read the contract again</button>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 14 }}>
      <h2>Claim</h2>
      {why !== null ? (
        <p className="muted" data-testid="claim-refusal">{why}</p>
      ) : (
        <p className="muted" data-testid="claim-available">
          The contract owes this address {formatUnits(BigInt(props.m.myPayoutWei), 18, 6)} {symbol}, as
          `payoutOf` reported at block {props.m.blockNumber}. Calling `claim()` pays it to you and
          needs nobody’s permission — if every CloudsForge service were switched off right now, this
          button would still work.
        </p>
      )}
      {plan === null ? (
        <button
          className="wide"
          style={{ marginTop: 8 }}
          data-testid="claim-preview"
          disabled={busy || !isClaimable(props.m)}
          onClick={() => {
            setBusy(true);
            setError(null);
            void call<ClaimPlan>('previewClaim', { address: props.m.address })
              .then(setPlan)
              .catch((cause: unknown) => setError(errorText(cause)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Checking…' : 'Check the claim'}
        </button>
      ) : (
        <div>
          {plan.tx !== null ? (
            <p className="muted" data-testid="claim-fee">
              Maximum fee {formatUnits(BigInt(plan.tx.gas) * BigInt(plan.tx.gasPrice), 18, 8)} {symbol} · nonce {plan.tx.nonce}.
            </p>
          ) : null}
          <button
            className="primary wide"
            style={{ marginTop: 8 }}
            data-testid="claim-submit"
            disabled={busy || plan.refusal !== null}
            onClick={() => {
              setBusy(true);
              setError(null);
              void call<{ hash: string }>('claim', { address: props.m.address })
                .then((r) => setHash(r.hash))
                .catch((cause: unknown) => setError(errorText(cause)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? 'Signing…' : 'Claim'}
          </button>
        </div>
      )}
      {error !== null ? <p className="error" data-testid="claim-error">{error}</p> : null}
    </div>
  );
}
