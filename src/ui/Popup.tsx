/* The wallet itself: balance, history, send, receive, accounts, connections, settings.
 *
 * Everything here reads through background/index.ts. There is no direct `fetch` in this file and
 * no key material ever reaches it: the popup is a view over the worker, and the worker is a view
 * over storage. That layering is what lets the popup be closed and reopened at any point — which
 * users do constantly, because clicking anything outside a browser popup closes it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { call, getState, type WalletState } from './client.ts';
import { formatGwei, formatUnits, parseUnits, shortAddress } from '../shared/units.ts';
import { encodeQr, qrToSvg } from '../shared/qr.ts';

type Tab = 'assets' | 'activity' | 'send' | 'receive' | 'connections' | 'settings';

export function Popup(): React.JSX.Element {
  const [state, setState] = useState<WalletState | null>(null);
  const [tab, setTab] = useState<Tab>('assets');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setState(await getState()); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  if (state === null) {
    return <main><p>{error ?? 'Opening…'}</p></main>;
  }
  if (!state.hasVault) {
    return (
      <main>
        <h1>No wallet yet</h1>
        <p>Set one up, then come back here.</p>
        <button className="primary wide" onClick={() => { void chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') }); }}>
          Set up CloudsForge Wallet
        </button>
      </main>
    );
  }
  if (!state.unlocked) return <Locked onUnlocked={refresh} />;

  const account = state.accounts.find((a) => a.address === state.settings.selectedAddress) ?? state.accounts[0];
  const chain = state.chains.find((c) => c.id === state.settings.selectedChainId) ?? state.chains[0];
  if (account === undefined || chain === undefined) return <main><p>This wallet has no accounts.</p></main>;

  return (
    <main>
      <div className="row between">
        <select
          aria-label="Account"
          data-testid="account-select"
          value={account.address}
          onChange={(e) => { void call('selectAccount', { address: e.target.value }).then(refresh); }}
        >
          {state.accounts.map((a) => (
            <option key={a.address} value={a.address}>{a.label} — {shortAddress(a.address)}</option>
          ))}
        </select>
        <select
          aria-label="Network"
          data-testid="chain-select"
          value={chain.id}
          onChange={(e) => { void call('selectChain', { chainId: Number(e.target.value) }).then(refresh); }}
        >
          {state.chains.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {state.pending.length > 0 ? (
        <div className="warn" style={{ marginTop: 10 }}>
          <strong>{state.pending.length} request{state.pending.length === 1 ? '' : 's'} waiting</strong>
          <span>{state.pending.map((p) => p.origin).join(', ')}</span>
        </div>
      ) : null}

      <div className="tabs" role="tablist" style={{ marginTop: 12 }}>
        {(['assets', 'activity', 'send', 'receive', 'connections', 'settings'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} data-testid={`tab-${t}`} onClick={() => setTab(t)}>
            {t === 'assets' ? 'Balance' : t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'assets' ? <Assets address={account.address} chain={chain} onChanged={refresh} accounts={state.accounts.length} /> : null}
      {tab === 'activity' ? <Activity address={account.address} chain={chain} /> : null}
      {tab === 'send' ? <Send from={account.address} chain={chain} /> : null}
      {tab === 'receive' ? <Receive address={account.address} chain={chain} /> : null}
      {tab === 'connections' ? <Connections state={state} onChanged={refresh} /> : null}
      {tab === 'settings' ? <SettingsPane state={state} onChanged={refresh} /> : null}
    </main>
  );
}

function Locked(props: { onUnlocked: () => Promise<void> }): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (): void => {
    setBusy(true);
    setError(null);
    void call('unlock', { password })
      .then(() => props.onUnlocked())
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  return (
    <main>
      <h1>Locked</h1>
      <p>Enter the password for this device.</p>
      <input
        type="password"
        data-testid="unlock-password"
        autoFocus
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && password.length > 0) submit(); }}
      />
      {error !== null ? <p className="error" data-testid="unlock-error">{error}</p> : null}
      <button className="primary wide" data-testid="unlock" style={{ marginTop: 12 }} disabled={busy || password.length === 0} onClick={submit}>
        {/* Two seconds of PBKDF2 at 600,000 iterations. Saying so beats a button that looks stuck. */}
        {busy ? 'Unlocking…' : 'Unlock'}
      </button>
    </main>
  );
}

function useBalance(address: string, chainId: number): { wei: bigint | null; error: string | null; reload: () => void } {
  const [wei, setWei] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setWei(null);
    setError(null);
    void call<{ wei: string }>('balance', { address })
      .then((r) => { if (live) setWei(BigInt(r.wei)); })
      .catch((cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { live = false; };
  }, [address, chainId, tick]);

  return { wei, error, reload: () => setTick((t) => t + 1) };
}

function Assets(props: { address: string; chain: WalletState['chains'][number]; accounts: number; onChanged: () => Promise<void> }): React.JSX.Element {
  const { wei, error, reload } = useBalance(props.address, props.chain.id);

  return (
    <div>
      <div className="panel">
        {/* The label under this figure is generated by app.css and cannot be removed by markup —
            see the §1.1 note there. */}
        <div className="balance" data-testid="balance">
          {wei === null ? '—' : formatUnits(wei, props.chain.currency.decimals, 6)}{' '}
          <span className="symbol">{props.chain.currency.symbol}</span>
        </div>
        {wei !== null ? <div className="muted" data-testid="balance-wei" style={{ marginTop: 6 }}>{wei.toString()} wei</div> : null}
        {error !== null ? <p className="error" data-testid="balance-error">{error}</p> : null}
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <button className="ghost" onClick={reload}>Refresh</button>
        <div className="grow" />
        <button onClick={() => { void call('deriveAccount').then(props.onChanged); }} data-testid="derive-account">
          Add account {props.accounts + 1}
        </button>
      </div>

      <h2>Tokens</h2>
      <div className="placeholder-asset">
        No tokens yet. Add one by contract address when this account holds an ERC-20.
      </div>
    </div>
  );
}

function Activity(props: { address: string; chain: WalletState['chains'][number] }): React.JSX.Element {
  const [data, setData] = useState<{ entries: { hash: string; from: string; to: string | null; valueWei: string; blockNumber: number; direction: string }[]; scannedFrom: number; scannedTo: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setData(null);
    void call<typeof data>('history', { address: props.address, depth: 100 })
      .then((r) => { if (live) setData(r); })
      .catch((cause: unknown) => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { live = false; };
  }, [props.address, props.chain.id]);

  if (error !== null) return <p className="error">{error}</p>;
  if (data === null) return <p className="muted">Reading recent blocks…</p>;

  return (
    <div>
      {data.entries.length === 0 ? (
        <div className="placeholder-asset">Nothing in the last {data.scannedTo - data.scannedFrom} blocks.</div>
      ) : (
        <ul className="list">
          {data.entries.map((e) => (
            <li key={e.hash}>
              <div className="row between">
                <span>{e.direction === 'out' ? 'Sent' : e.direction === 'in' ? 'Received' : 'To self'}</span>
                <span>{formatUnits(BigInt(e.valueWei), props.chain.currency.decimals, 6)} {props.chain.currency.symbol}</span>
              </div>
              <div className="mono muted">{e.hash}</div>
            </li>
          ))}
        </ul>
      )}
      {/* This wallet walks blocks rather than asking micro-indexer, so the honest thing to say is
          how far back it looked — not "your history". See rpc.ts's recentHistory. */}
      <p className="muted" style={{ marginTop: 10 }}>
        Blocks {data.scannedFrom}–{data.scannedTo}, read straight from the node. This wallet does not
        use a CloudsForge indexer, so it sees exactly what the chain shows and nothing more.
      </p>
    </div>
  );
}

function Send(props: { from: string; chain: WalletState['chains'][number] }): React.JSX.Element {
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [preview, setPreview] = useState<{ gas: string; gasPrice: string; nonce: string } | null>(null);
  const [gas, setGas] = useState('');
  const [gasPrice, setGasPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);

  const valueWei = useMemo(() => {
    if (amount.trim() === '') return null;
    try { return parseUnits(amount, props.chain.currency.decimals); } catch { return null; }
  }, [amount, props.chain.currency.decimals]);

  const estimate = (): void => {
    setError(null);
    setBusy(true);
    void call<{ gas: string; gasPrice: string; nonce: string }>('previewSend', {
      tx: { from: props.from, to, value: `0x${(valueWei ?? 0n).toString(16)}` },
    })
      .then((p) => { setPreview(p); setGas(p.gas); setGasPrice(p.gasPrice); })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  const send = (): void => {
    setError(null);
    setBusy(true);
    void call<{ hash: string }>('send', {
      tx: { from: props.from, to, value: `0x${(valueWei ?? 0n).toString(16)}` },
      gas, gasPrice,
    })
      .then((r) => setHash(r.hash))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };

  if (hash !== null) {
    return (
      <div>
        <p className="ok">Broadcast.</p>
        <div className="mono" data-testid="send-hash">{hash}</div>
        {/* §7: "a confirmation is not final until the chain's own depth rule says so." */}
        <p className="muted" style={{ marginTop: 10 }}>
          The node accepted it. It is not confirmed until it is in a block and that block is deep
          enough that a reorganisation cannot remove it.
        </p>
      </div>
    );
  }

  return (
    <div>
      <label htmlFor="to">To</label>
      <input id="to" data-testid="send-to" className="mono" spellCheck={false} value={to} onChange={(e) => { setTo(e.target.value); setPreview(null); }} placeholder="0x…" />
      <label htmlFor="amt">Amount ({props.chain.currency.symbol})</label>
      <input id="amt" data-testid="send-amount" value={amount} onChange={(e) => { setAmount(e.target.value); setPreview(null); }} placeholder="0.0" />
      {amount.trim() !== '' && valueWei === null ? <p className="error">That is not an amount this currency can express.</p> : null}

      {preview === null ? (
        <button className="primary wide" style={{ marginTop: 14 }} data-testid="send-estimate" disabled={busy || valueWei === null || to.trim() === ''} onClick={estimate}>
          {busy ? 'Asking the node…' : 'Estimate the fee'}
        </button>
      ) : (
        <div style={{ marginTop: 14 }}>
          <div className="panel">
            {/* §5: "send with a fee estimate the user can override". Both fields are editable, and
                the total is recomputed from what is actually in them. */}
            <label htmlFor="gas">Gas limit</label>
            <input id="gas" data-testid="send-gas" value={gas} onChange={(e) => setGas(e.target.value)} />
            <label htmlFor="gp">Gas price (wei — {formatGwei(BigInt(gasPrice || '0'))} gwei)</label>
            <input id="gp" data-testid="send-gasprice" value={gasPrice} onChange={(e) => setGasPrice(e.target.value)} />
            <p className="muted" style={{ marginTop: 10 }}>
              Maximum fee {formatUnits(BigInt(gas || '0') * BigInt(gasPrice || '0'), 18, 8)} {props.chain.currency.symbol} · nonce {preview.nonce}
            </p>
            {props.chain.supportsEip1559 ? null : (
              <p className="muted">
                {props.chain.name} has no EIP-1559 base fee, so this is a legacy transaction with a
                flat gas price. There is no priority fee to set.
              </p>
            )}
          </div>
          <button className="primary wide" style={{ marginTop: 12 }} data-testid="send-submit" disabled={busy} onClick={send}>
            {busy ? 'Signing…' : `Send ${amount} ${props.chain.currency.symbol}`}
          </button>
        </div>
      )}
      {error !== null ? <p className="error" data-testid="send-error">{error}</p> : null}
    </div>
  );
}

function Receive(props: { address: string; chain: WalletState['chains'][number] }): React.JSX.Element {
  const svg = useMemo(() => qrToSvg(encodeQr(props.address)), [props.address]);
  const [copied, setCopied] = useState(false);

  return (
    <div>
      <div className="row" style={{ justifyContent: 'center', marginBottom: 12 }}>
        <div className="qr" data-testid="receive-qr" dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
      {/* The address in text is the source of truth; the QR is the convenience. See shared/qr.ts. */}
      <div className="panel">
        <div className="mono" data-testid="receive-address">{props.address}</div>
      </div>
      <button className="wide" style={{ marginTop: 10 }} onClick={() => { void navigator.clipboard.writeText(props.address); setCopied(true); }}>
        {copied ? 'Copied' : 'Copy address'}
      </button>
      <p className="muted" style={{ marginTop: 10 }}>
        {props.chain.name} only. Sending an asset from another chain to this address does not move it
        here — it stays on that chain, at this address, and needs a wallet pointed there to spend it.
      </p>
    </div>
  );
}

function Connections(props: { state: WalletState; onChanged: () => Promise<void> }): React.JSX.Element {
  if (props.state.permissions.length === 0) {
    return <div className="placeholder-asset">No sites are connected to this wallet.</div>;
  }
  return (
    <ul className="list">
      {props.state.permissions.map((p) => (
        <li key={p.origin}>
          <div className="row between">
            <span className="origin">{p.origin}</span>
            <button className="danger" onClick={() => { void call('revokeOrigin', { origin: p.origin }).then(props.onChanged); }}>
              Disconnect
            </button>
          </div>
          <div className="muted">{p.accounts.map(shortAddress).join(', ')}</div>
        </li>
      ))}
    </ul>
  );
}

function SettingsPane(props: { state: WalletState; onChanged: () => Promise<void> }): React.JSX.Element {
  const [minutes, setMinutes] = useState(String(props.state.settings.autoLockMinutes));
  const [password, setPassword] = useState('');
  const [phrase, setPhrase] = useState<string | null>(null);
  const [held, setHeld] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [privateKey, setPrivateKey] = useState('');

  return (
    <div>
      <h2>Auto-lock</h2>
      <div className="row">
        <input aria-label="Auto-lock minutes" data-testid="autolock" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        <button onClick={() => { void call('setAutoLock', { minutes: Number(minutes) }).then(props.onChanged).catch((c: unknown) => setError(String(c))); }}>Save</button>
      </div>
      <p className="muted">Minutes of inactivity before the wallet locks itself.</p>
      <button className="wide" data-testid="lock" style={{ marginTop: 8 }} onClick={() => { void call('lock').then(props.onChanged); }}>Lock now</button>

      <h2>Import an account</h2>
      <input className="mono" placeholder="private key, 0x…" data-testid="import-key" value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} />
      <input type="password" placeholder="this wallet's password" style={{ marginTop: 6 }} data-testid="import-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button className="wide" style={{ marginTop: 6 }} data-testid="import-submit" onClick={() => {
        setError(null);
        void call('importPrivateKey', { privateKey, password })
          .then(() => { setPrivateKey(''); return props.onChanged(); })
          .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
      }}>Import</button>

      <h2>Recovery phrase</h2>
      {/* Three deliberate steps, not one tap: the warning, the password, and a press-and-hold.
          §5's "duress-resistant reveal flow". An unlocked wallet on an unattended desk still does
          not give up the phrase to whoever picks up the mouse. */}
      <div className="warn danger">
        <strong>Nobody legitimate will ever ask to see this</strong>
        <span>Not CloudsForge support, not a moderator, not an airdrop checker. Revealing it to anyone is giving them the wallet.</span>
      </div>
      {phrase === null ? (
        <>
          <input type="password" placeholder="password" data-testid="reveal-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button
            className="wide"
            style={{ marginTop: 6 }}
            data-testid="reveal-hold"
            onMouseDown={() => setHeld(true)}
            onMouseUp={() => setHeld(false)}
            onMouseLeave={() => setHeld(false)}
            disabled={password.length === 0}
            onClick={() => {
              if (!held) { setError('Press and hold the button to reveal.'); return; }
              setError(null);
              void call<{ mnemonic: string }>('revealMnemonic', { password })
                .then((r) => setPhrase(r.mnemonic))
                .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
            }}
          >
            Press and hold to reveal
          </button>
        </>
      ) : (
        <>
          <div className="seed" style={{ marginTop: 8 }} data-testid="revealed-seed">
            {phrase.split(' ').map((w, i) => <div className="word" key={`${i}-${w}`}><b>{i + 1}</b>{w}</div>)}
          </div>
          <button className="wide" style={{ marginTop: 8 }} onClick={() => { setPhrase(null); setPassword(''); }}>Hide</button>
        </>
      )}
      {error !== null ? <p className="error">{error}</p> : null}

      <h2>About</h2>
      <p className="muted">
        Self-custody. CloudsForge holds no key for this wallet and cannot recover it. Your custodial
        Forge Hub balance is a different thing entirely and is never added to what you see here.
      </p>
    </div>
  );
}
