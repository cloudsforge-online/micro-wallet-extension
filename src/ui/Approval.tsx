/* The confirmation window — the screen where a wallet is either useful or complicit.
 *
 * FOUR RULES THIS SCREEN OBEYS.
 *
 * 1. THE ORIGIN IS NAMED, AT THE TOP, IN FULL. §5 asks for "a phishing warning that names the
 *    origin". Not a favicon, not a shortened host, not "a site is requesting" — the whole origin
 *    the browser reported, in a monospace face where `rn` cannot be mistaken for `m`. It comes from
 *    `port.sender.origin` (see background/handlers.ts) and never from anything the page said.
 *
 * 2. THE CALL IS DECODED, AND WHEN IT CANNOT BE, THIS SCREEN SAYS SO. A hex blob is not consent.
 *    An unrecognised call is drawn as an unrecognised call with a caution, not as a friendly
 *    "Contract interaction" — see shared/decode.ts.
 *
 * 3. WARNINGS COME BEFORE THE AMOUNT, not after it. A user who has already read the number has
 *    decided; anything below it is decoration.
 *
 * 4. THIS WINDOW MAY OUTLIVE THE WORKER THAT OPENED IT. It holds no state the worker gave it
 *    beyond the request id in the URL fragment, and it re-fetches the request on load. Closing it
 *    without deciding is a rejection, delivered as EIP-1193 4001 by windows.onRemoved.
 */

import { useCallback, useEffect, useState } from 'react';
import { call } from './client.ts';
import type { PendingRequest, RequestPreview, TransactionPreview } from '../shared/protocol.ts';
import { formatGwei, formatUnits } from '../shared/units.ts';
import { formatBps, outcomeName } from '../shared/foresight.ts';

export function Approval(): React.JSX.Element {
  const id = decodeURIComponent(window.location.hash.replace(/^#/, ''));
  const [request, setRequest] = useState<PendingRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void call<PendingRequest>('getRequest', { id })
      .then(setRequest)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [id]);

  const decide = useCallback((approved: boolean, extra: Record<string, unknown> = {}) => {
    setBusy(true);
    setError(null);
    void call('decide', { decision: { id, approved, ...extra } })
      .then(() => window.close())
      .catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false); });
  }, [id]);

  if (error !== null && request === null) {
    return (
      <main>
        <h1>This request is gone</h1>
        <p>{error}</p>
        <p className="muted">
          The wallet or the browser restarted while it was open. Nothing was signed. Ask the site to
          try again.
        </p>
        <button className="wide" onClick={() => window.close()}>Close</button>
      </main>
    );
  }
  if (request === null) return <main><p>Loading the request…</p></main>;

  const preview = request.preview;
  return (
    <main>
      <div className="chip" style={{ marginBottom: 8 }}>CloudsForge Wallet · self-custody</div>
      <h1>{titleFor(preview)}</h1>

      {/* Rule 1. */}
      <p className="muted" style={{ marginBottom: 4 }}>Requested by</p>
      <div className="origin" data-testid="origin">{request.origin}</div>
      <div className="warn" style={{ marginTop: 8 }}>
        <strong>Check that origin before you agree to anything</strong>
        <span>
          It is the exact address the request came from, as the browser reports it — not what the
          page claims to be. If it is not the site you meant to be on, reject this.
        </span>
      </div>

      {preview === null ? <p className="muted">No preview is available for {request.method}.</p> : null}
      {preview?.type === 'connect' ? <ConnectBody accounts={preview.accounts} busy={busy} onDecide={decide} /> : null}
      {preview?.type === 'signMessage' ? <SignMessageBody preview={preview} /> : null}
      {preview?.type === 'signTypedData' ? <SignTypedBody preview={preview} /> : null}
      {preview?.type === 'transaction' ? <TransactionBody tx={preview.tx} busy={busy} onDecide={decide} /> : null}
      {preview?.type === 'addChain' ? <AddChainBody preview={preview} /> : null}
      {preview?.type === 'switchChain' ? <SwitchChainBody preview={preview} /> : null}

      {error !== null ? <p className="error" data-testid="approval-error">{error}</p> : null}

      {preview?.type === 'connect' || preview?.type === 'transaction' ? null : (
        <div className="row" style={{ marginTop: 18 }}>
          <button className="wide" data-testid="reject" disabled={busy} onClick={() => decide(false)}>Reject</button>
          <button className="primary wide" data-testid="approve" disabled={busy} onClick={() => decide(true)}>Approve</button>
        </div>
      )}
    </main>
  );
}

function titleFor(preview: RequestPreview | null): string {
  switch (preview?.type) {
    case 'connect': return 'Connect this wallet?';
    case 'signMessage': return 'Sign this message?';
    case 'signTypedData': return 'Sign this data?';
    case 'transaction': return 'Confirm this transaction';
    case 'addChain': return 'Add a network?';
    case 'switchChain': return 'Switch network?';
    default: return 'A site is asking for something';
  }
}

function ConnectBody(props: { accounts: readonly string[]; busy: boolean; onDecide: (approved: boolean, extra?: Record<string, unknown>) => void }): React.JSX.Element {
  const [chosen, setChosen] = useState<string[]>(props.accounts.length > 0 ? [props.accounts[0] as string] : []);

  return (
    <div>
      <p style={{ marginTop: 14 }}>
        This site will be able to see the addresses you tick and ask you to sign. It cannot move
        anything without a confirmation like this one.
      </p>
      <ul className="list">
        {props.accounts.map((address) => (
          <li key={address}>
            <label className="row" style={{ margin: 0, cursor: 'pointer' }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                data-testid={`connect-${address}`}
                checked={chosen.includes(address)}
                onChange={(e) => setChosen((prev) => e.target.checked ? [...prev, address] : prev.filter((a) => a !== address))}
              />
              <span className="mono grow">{address}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="row" style={{ marginTop: 18 }}>
        <button className="wide" data-testid="reject" disabled={props.busy} onClick={() => props.onDecide(false)}>Reject</button>
        <button className="primary wide" data-testid="approve" disabled={props.busy || chosen.length === 0} onClick={() => props.onDecide(true, { accounts: chosen })}>
          Connect {chosen.length} account{chosen.length === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  );
}

function SignMessageBody(props: { preview: Extract<RequestPreview, { type: 'signMessage' }> }): React.JSX.Element {
  return (
    <div>
      <p className="muted" style={{ marginTop: 14 }}>Signing as</p>
      <div className="mono">{props.preview.from}</div>
      <p className="muted" style={{ marginTop: 10 }}>Message</p>
      <div className="panel"><pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap' }} data-testid="message-text">{props.preview.text}</pre></div>
      <div className="warn" style={{ marginTop: 10 }}>
        <strong>A signature can be worth money</strong>
        <span>
          Some sites use a signed message as proof of ownership, and some use one as an off-chain
          order. Read it. If it mentions amounts, addresses or permissions you did not intend, reject it.
        </span>
      </div>
    </div>
  );
}

function SignTypedBody(props: { preview: Extract<RequestPreview, { type: 'signTypedData' }> }): React.JSX.Element {
  return (
    <div>
      <p className="muted" style={{ marginTop: 14 }}>Signing as</p>
      <div className="mono">{props.preview.from}</div>
      <div className="row between" style={{ marginTop: 10 }}>
        <span className="chip">domain: {props.preview.domain}</span>
        <span className="chip">type: {props.preview.primaryType}</span>
      </div>
      <div className="panel" style={{ marginTop: 8 }}>
        <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' }} data-testid="typed-json">{props.preview.json}</pre>
      </div>
    </div>
  );
}

function AddChainBody(props: { preview: Extract<RequestPreview, { type: 'addChain' }> }): React.JSX.Element {
  return (
    <div>
      <p style={{ marginTop: 14 }}>
        This site wants the wallet to know about <strong>{props.preview.name}</strong> (chain{' '}
        {props.preview.chainId}) and to switch to it.
      </p>
      <div className="panel">
        <div className="muted">RPC endpoint</div>
        <div className="mono" data-testid="add-chain-rpc">{props.preview.rpcUrl || '(already configured)'}</div>
        <div className="muted" style={{ marginTop: 8 }}>Currency</div>
        <div className="mono">{props.preview.symbol}</div>
      </div>
      {props.preview.known ? null : (
        <div className="warn danger" style={{ marginTop: 10 }}>
          <strong>This wallet has never seen this network</strong>
          <span>
            Everything the wallet shows you for it — balances, fees, whether a transaction went
            through — will come from that RPC endpoint. If you do not know who runs it, do not add it.
          </span>
        </div>
      )}
    </div>
  );
}

function SwitchChainBody(props: { preview: Extract<RequestPreview, { type: 'switchChain' }> }): React.JSX.Element {
  return (
    <p style={{ marginTop: 14 }}>
      Switch the wallet to <strong data-testid="switch-chain-name">{props.preview.name}</strong> (chain {props.preview.chainId})?
      Every site connected to this wallet is told about the change.
    </p>
  );
}

function TransactionBody(props: { tx: TransactionPreview; busy: boolean; onDecide: (approved: boolean, extra?: Record<string, unknown>) => void }): React.JSX.Element {
  const [gas, setGas] = useState(props.tx.gas);
  const [gasPrice, setGasPrice] = useState(props.tx.gasPrice);
  const [editing, setEditing] = useState(false);
  const maxFee = BigInt(gas || '0') * BigInt(gasPrice || '0');

  return (
    <div>
      {/* Rule 3: warnings first. */}
      {props.tx.warnings.map((w) => (
        <div className={w.severity === 'danger' ? 'warn danger' : 'warn'} key={w.title} data-testid={`warning-${w.severity}`} style={{ marginTop: 10 }}>
          <strong>{w.title}</strong>
          <span>{w.detail}</span>
        </div>
      ))}

      {/* §5.1's requirement, on the DAPP path. The pool was read by the worker when this window was
          built — signing time — and is stated as observed, with its block. A page can display
          whatever odds it likes; this panel is the wallet's own reading of the contract. */}
      {props.tx.foresight !== null ? <ForesightBody foresight={props.tx.foresight} symbol={props.tx.currencySymbol} /> : null}

      <div className="panel" style={{ marginTop: 10 }}>
        <Decoded tx={props.tx} />
        <hr />
        <div className="muted">From</div>
        <div className="mono">{props.tx.from}</div>
        <div className="muted" style={{ marginTop: 8 }}>To</div>
        <div className="mono" data-testid="tx-to">{props.tx.to ?? 'a new contract'}</div>
        <div className="muted" style={{ marginTop: 8 }}>Network</div>
        <div data-testid="tx-chain">{props.tx.chainName} · chain {props.tx.chainId}, confirmed by the node</div>
        <div className="muted" style={{ marginTop: 8 }}>Value</div>
        <div data-testid="tx-value">{formatUnits(BigInt(props.tx.valueWei), 18)} {props.tx.currencySymbol}</div>
      </div>

      <div className="row between" style={{ marginTop: 10 }}>
        <span className="muted">Maximum fee {formatUnits(maxFee, 18, 8)} {props.tx.currencySymbol}</span>
        <button className="ghost" data-testid="edit-fee" onClick={() => setEditing((v) => !v)}>{editing ? 'Done' : 'Edit fee'}</button>
      </div>
      {editing ? (
        <div className="panel">
          <label htmlFor="g">Gas limit</label>
          <input id="g" data-testid="approval-gas" value={gas} onChange={(e) => setGas(e.target.value)} />
          <label htmlFor="gp">Gas price (wei — {formatGwei(BigInt(gasPrice || '0'))} gwei)</label>
          <input id="gp" data-testid="approval-gasprice" value={gasPrice} onChange={(e) => setGasPrice(e.target.value)} />
          <p className="muted" style={{ marginTop: 8 }}>
            Nonce {props.tx.nonce}, chain {props.tx.chainId}. Lowering the gas limit below what the
            call needs makes it fail and still costs the fee.
          </p>
        </div>
      ) : null}

      {/* The raw bytes are always available, below the decode. Hiding them entirely would mean a
          user who knows how to read call data cannot check this screen's work. */}
      {props.tx.data !== '0x' ? (
        <details style={{ marginTop: 10 }}>
          <summary className="muted">Raw call data ({(props.tx.data.length - 2) / 2} bytes)</summary>
          <div className="mono" data-testid="tx-data" style={{ marginTop: 6 }}>{props.tx.data}</div>
        </details>
      ) : null}

      <div className="row" style={{ marginTop: 18 }}>
        <button className="wide" data-testid="reject" disabled={props.busy} onClick={() => props.onDecide(false)}>Reject</button>
        <button className="primary wide" data-testid="approve" disabled={props.busy} onClick={() => props.onDecide(true, { overrides: { gas, gasPrice } })}>
          {props.busy ? 'Signing…' : 'Confirm'}
        </button>
      </div>
    </div>
  );
}

/**
 * The parimutuel panel: what the pool was, at which block, and what the contract's own arithmetic
 * gives this stake IF it settled at that instant.
 *
 * THE CAVEAT IS DRAWN FROM THE DATA, NOT TYPED HERE — `projection.caveat` is computed alongside the
 * figure in shared/foresight.ts. A screen cannot render the number and forget the sentence, which
 * is exactly how "a wallet that shows a fixed payout on a parimutuel" happens: not by anybody
 * deciding to lie, but by somebody tidying a paragraph away from beside a number.
 */
function ForesightBody(props: { foresight: NonNullable<TransactionPreview['foresight']>; symbol: string }): React.JSX.Element {
  const { observation: m, projection: p } = props.foresight;
  return (
    <div className="panel" style={{ marginTop: 10 }} data-testid="approval-foresight">
      <strong>Staking on {outcomeName(p.outcome)} in a prediction market</strong>
      <div className="row between" style={{ marginTop: 8 }}>
        <span className="muted">Pool on YES</span>
        <span data-testid="approval-pool-yes">{formatUnits(BigInt(m.poolYesWei), 18, 6)} {props.symbol} · {formatBps(m.oddsYesBps)}</span>
      </div>
      <div className="row between" style={{ marginTop: 4 }}>
        <span className="muted">Pool on NO</span>
        <span data-testid="approval-pool-no">{formatUnits(BigInt(m.poolNoWei), 18, 6)} {props.symbol} · {formatBps(m.oddsNoBps)}</span>
      </div>
      <hr />
      <div className="row between">
        <span className="muted">If it settled {outcomeName(p.outcome)} at this exact pool, your share would be</span>
        <strong data-testid="approval-projection">{formatUnits(BigInt(p.shareIfResolvedNowWei), 18, 6)} {props.symbol}</strong>
      </div>
      <div className="warn" style={{ marginTop: 10 }} data-testid="approval-caveat">
        <strong>This is not a payout</strong>
        <span>{p.caveat}</span>
      </div>
      <p className="muted" style={{ marginTop: 6 }} data-testid="approval-observed-block">
        Read from {m.address} at block {m.blockNumber}, by this wallet, not by the page.
      </p>
    </div>
  );
}

function Decoded(props: { tx: TransactionPreview }): React.JSX.Element {
  const d = props.tx.decoded;
  switch (d.kind) {
    case 'transfer-native':
      return <div data-testid="decoded"><strong>Send {formatUnits(BigInt(d.amountWei), 18)} {props.tx.currencySymbol}</strong><div className="mono muted">to {d.to}</div></div>;
    case 'erc20-transfer':
      return <div data-testid="decoded"><strong>Transfer {d.amount} tokens</strong><div className="mono muted">token {d.token}</div><div className="mono muted">to {d.to}</div></div>;
    case 'erc20-approve':
      return (
        <div data-testid="decoded">
          <strong>{d.unlimited ? 'Allow unlimited spending' : `Allow spending up to ${d.amount}`}</strong>
          <div className="mono muted">token {d.token}</div>
          <div className="mono muted">spender {d.spender}</div>
        </div>
      );
    case 'erc721-approve-all':
      return <div data-testid="decoded"><strong>{d.approved ? 'Grant' : 'Revoke'} control of every item in a collection</strong><div className="mono muted">operator {d.operator}</div></div>;
    case 'deploy':
      return <div data-testid="decoded"><strong>Deploy a contract</strong><div className="muted">{d.bytes} bytes of code</div></div>;
    case 'known':
      return (
        <div data-testid="decoded">
          <strong>{d.signature}</strong>
          {d.args.map((a) => <div className="mono muted" key={a.name}>{a.name}: {a.value}</div>)}
        </div>
      );
    default:
      return (
        <div data-testid="decoded">
          <strong>This wallet could not read this call</strong>
          <div className="mono muted">selector {d.selector}, {d.bytes} bytes</div>
        </div>
      );
  }
}
