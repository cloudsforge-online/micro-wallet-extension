/* Deploying a token, with micro-mint's contracts and this device's key.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * §5: "micro-mint already deploys real OpenZeppelin contracts, testnet by default. The wallet gets
 * the same capability SIGNED LOCALLY: pick a template, set name, symbol, supply and decimals, see
 * the CONSTRUCTOR ARGUMENTS and the DEPLOYMENT COST, sign, and watch it confirm. The templates come
 * from micro-mint's catalogue so there is one audited set rather than two; the signature is the
 * user's, so the platform is not in the custody path of a contract the user owns."
 *
 * Four things this screen shows that a "deploy" button would not, and each is in the sentence above:
 *
 *   - THE CONSTRUCTOR ARGUMENTS, by the parameter names from micro-mint's own ABI, with the base
 *     -unit integer beside the whole-token figure the user typed. A supply of "1,000,000" and an
 *     `initialSupply_` of 10^24 are the same fact, and a user who can see both can check the
 *     conversion instead of trusting it.
 *   - THE COST, as gas × price, before signing.
 *   - WHERE IT WILL LAND. `keccak256(rlp([sender, nonce]))[12:]` is a total function of two values
 *     the wallet already holds, so the address is on screen before the transaction is sent.
 *   - WHAT THE TEMPLATE COSTS IN TRUST. A pausable token is an owner key that can freeze every
 *     holder; the confirmation says so in those words rather than listing "pausable" as a feature.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useState } from 'react';
import { call, type WalletState } from './client.ts';
import type { TransactionPreview } from '../shared/protocol.ts';
import type { Feature, Variant } from '../shared/templates.ts';
import { formatUnits, shortAddress } from '../shared/units.ts';

interface TemplateView {
  variant: Variant;
  contract: string;
  title: string;
  blurb: string;
  features: Feature[];
  cap: 'required' | 'forbidden';
  lastArgName: string;
  bytecodeSha256: string;
  bytecodeBytes: number;
  constructorInputs: { name: string; type: string }[];
}

interface DeployPlan {
  plan: {
    variant: Variant;
    contract: string;
    data: string;
    bytecodeSha256: string;
    bytecodeBytes: number;
    argumentBytes: number;
    arguments: { name: string; type: string; value: string }[];
    mintSourceSha256: string;
  };
  tx: TransactionPreview;
  predictedAddress: string;
  nonce: string;
  supplyTokens: string;
  capTokens: string | null;
}

interface TokenFacts {
  address: string;
  blockNumber: number;
  name: string;
  symbol: string;
  decimals: number;
  totalSupplyWei: string;
  holderBalanceWei: string | null;
  codeBytes: number;
}

interface DeployedToken {
  address: string; chainId: number; contract: string; symbol: string; name: string;
  decimals: number; deployedBy: string; txHash: string; at: number;
}

const errorText = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export function Deploy(props: { chain: WalletState['chains'][number]; address: string }): React.JSX.Element {
  const [catalogue, setCatalogue] = useState<{ templates: TemplateView[]; mintSourceSha256: string } | null>(null);
  const [variant, setVariant] = useState<Variant>('fixed');
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [decimals, setDecimals] = useState('18');
  const [supply, setSupply] = useState('');
  const [cap, setCap] = useState('');
  const [plan, setPlan] = useState<DeployPlan | null>(null);
  const [gas, setGas] = useState('');
  const [gasPrice, setGasPrice] = useState('');
  const [sent, setSent] = useState<{ hash: string; address: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState<DeployedToken[]>([]);

  useEffect(() => {
    void call<typeof catalogue>('tokenTemplates').then(setCatalogue).catch((cause: unknown) => setError(errorText(cause)));
    void call<DeployedToken[]>('deployedTokens').then(setMine).catch(() => undefined);
  }, []);

  const template = catalogue?.templates.find((t) => t.variant === variant);
  const form = { variant, name, symbol, decimals: Number(decimals), supply, cap: template?.cap === 'required' ? cap : '' };

  if (sent !== null) {
    return <Deployed sent={sent} chain={props.chain} onBack={() => { setSent(null); setPlan(null); void call<DeployedToken[]>('deployedTokens').then(setMine); }} />;
  }

  return (
    <div>
      <h2>Deploy a token</h2>
      <p className="muted">
        These are micro-mint’s contracts — the same audited OpenZeppelin bytecode the platform
        deploys — signed by the key on this device instead of by CloudsForge. Nobody else is in the
        custody path of a contract you own.
      </p>

      {catalogue === null ? <p className="muted">Loading the templates…</p> : (
        <>
          <label htmlFor="variant">Template</label>
          <select id="variant" data-testid="deploy-variant" value={variant} onChange={(e) => { setVariant(e.target.value as Variant); setPlan(null); }}>
            {catalogue.templates.map((t) => <option key={t.variant} value={t.variant}>{t.title}</option>)}
          </select>
          {template !== undefined ? (
            <div className={template.features.includes('pausable') ? 'warn' : 'panel'} style={{ marginTop: 8 }} data-testid="template-blurb">
              <strong>{template.contract}</strong>
              <span>{template.blurb}</span>
            </div>
          ) : null}

          <label htmlFor="tname">Name</label>
          <input id="tname" data-testid="deploy-name" value={name} onChange={(e) => { setName(e.target.value); setPlan(null); }} placeholder="Ember Test Token" />
          <label htmlFor="tsym">Symbol</label>
          <input id="tsym" data-testid="deploy-symbol" value={symbol} onChange={(e) => { setSymbol(e.target.value); setPlan(null); }} placeholder="ETT" />
          <label htmlFor="tdec">Decimals</label>
          <input id="tdec" data-testid="deploy-decimals" value={decimals} onChange={(e) => { setDecimals(e.target.value); setPlan(null); }} />
          <label htmlFor="tsup">Initial supply, in whole tokens</label>
          <input id="tsup" data-testid="deploy-supply" value={supply} onChange={(e) => { setSupply(e.target.value); setPlan(null); }} placeholder="1000000" />
          {template?.cap === 'required' ? (
            <>
              <label htmlFor="tcap">Cap, in whole tokens — nothing can ever raise it</label>
              <input id="tcap" data-testid="deploy-cap" value={cap} onChange={(e) => { setCap(e.target.value); setPlan(null); }} placeholder="10000000" />
            </>
          ) : null}

          <div className="panel" style={{ marginTop: 8 }}>
            <div className="muted">{template?.lastArgName === 'recipient_' ? 'The whole supply is minted to' : 'Owner, and the account the supply is minted to'}</div>
            <div className="mono" data-testid="deploy-owner">{props.address}</div>
            <p className="muted" style={{ marginTop: 6 }}>
              The account signing this, and there is deliberately no field to change it. A box for
              somebody else’s address is a way to deploy a token you do not own — by a typo, or by a
              page that helpfully filled it in.
            </p>
          </div>

          {plan === null ? (
            <button
              className="primary wide"
              style={{ marginTop: 10 }}
              data-testid="deploy-preview"
              disabled={busy || name.trim() === '' || symbol.trim() === '' || supply.trim() === ''}
              onClick={() => {
                setBusy(true);
                setError(null);
                void call<DeployPlan>('previewDeploy', form)
                  .then((p) => { setPlan(p); setGas(p.tx.gas); setGasPrice(p.tx.gasPrice); })
                  .catch((cause: unknown) => setError(errorText(cause)))
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? 'Estimating…' : 'Show the constructor and the cost'}
            </button>
          ) : (
            <Confirm
              plan={plan}
              chain={props.chain}
              gas={gas}
              gasPrice={gasPrice}
              busy={busy}
              onGas={setGas}
              onGasPrice={setGasPrice}
              onDeploy={() => {
                setBusy(true);
                setError(null);
                void call<{ hash: string; address: string }>('deployToken', { ...form, gas, gasPrice })
                  .then(setSent)
                  .catch((cause: unknown) => setError(errorText(cause)))
                  .finally(() => setBusy(false));
              }}
            />
          )}
          {error !== null ? <p className="error" data-testid="deploy-error">{error}</p> : null}
          <p className="muted" style={{ marginTop: 10 }}>
            Bytecode from micro-mint, ForgeTokens.sol sha256 {catalogue.mintSourceSha256.slice(0, 16)}…
          </p>
        </>
      )}

      {mine.length > 0 ? (
        <>
          <h2>Tokens you have deployed</h2>
          <ul className="list" data-testid="deployed-list">
            {mine.map((t) => (
              <li key={t.address}>
                <div className="row between">
                  <span>{t.name} · {t.symbol}</span>
                  <span className="muted">{t.contract}</span>
                </div>
                <div className="mono muted">{t.address}</div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function Confirm(props: {
  plan: DeployPlan; chain: WalletState['chains'][number]; gas: string; gasPrice: string; busy: boolean;
  onGas: (v: string) => void; onGasPrice: (v: string) => void; onDeploy: () => void;
}): React.JSX.Element {
  const { plan } = props;
  const symbol = props.chain.currency.symbol;
  const maxFee = BigInt(props.gas || '0') * BigInt(props.gasPrice || '0');

  return (
    <div style={{ marginTop: 10 }}>
      {plan.tx.warnings.map((w) => (
        <div className={w.severity === 'danger' ? 'warn danger' : 'warn'} key={w.title} data-testid={`deploy-warning-${w.severity}`}>
          <strong>{w.title}</strong><span>{w.detail}</span>
        </div>
      ))}

      <div className="panel" data-testid="constructor-args">
        <strong>{plan.plan.contract}’s constructor</strong>
        {plan.plan.arguments.map((a) => (
          <div className="row between" style={{ marginTop: 6 }} key={a.name}>
            <span className="muted">{a.name} <span className="chip">{a.type}</span></span>
            <span className="mono" data-testid={`ctor-${a.name}`} style={{ textAlign: 'right', wordBreak: 'break-all' }}>
              {a.type === 'address' ? shortAddress(a.value) : a.value}
            </span>
          </div>
        ))}
        <hr />
        {/* Both figures, so the base-unit conversion can be checked rather than trusted. */}
        <p className="muted" data-testid="supply-restated">
          {plan.supplyTokens} whole tokens, which at {plan.plan.arguments.find((a) => a.name === 'decimals_')?.value ?? '?'} decimals is{' '}
          {plan.plan.arguments.find((a) => a.name === 'initialSupply_')?.value ?? '?'} of the smallest unit — the number the constructor mints.
          {plan.capTokens === null ? '' : ` The cap is ${plan.capTokens} whole tokens.`}
        </p>
      </div>

      <div className="panel" style={{ marginTop: 8 }}>
        <div className="muted">This contract will land at</div>
        <div className="mono" data-testid="predicted-address">{plan.predictedAddress}</div>
        <p className="muted" style={{ marginTop: 6 }}>
          Derived from your address and nonce {plan.nonce}, not read from a receipt. Only this
          account can ever create a contract there.
        </p>
      </div>

      <div className="panel" style={{ marginTop: 8 }}>
        <label htmlFor="dgas">Gas limit</label>
        <input id="dgas" data-testid="deploy-gas" value={props.gas} onChange={(e) => props.onGas(e.target.value)} />
        <label htmlFor="dgp">Gas price (wei)</label>
        <input id="dgp" data-testid="deploy-gasprice" value={props.gasPrice} onChange={(e) => props.onGasPrice(e.target.value)} />
        <div className="row between" style={{ marginTop: 8 }}>
          <span className="muted">Deployment cost, at most</span>
          <strong data-testid="deploy-cost">{formatUnits(maxFee, 18, 8)} {symbol}</strong>
        </div>
        <p className="muted" style={{ marginTop: 6 }}>
          {plan.plan.bytecodeBytes} bytes of micro-mint’s bytecode (sha256 {plan.plan.bytecodeSha256.slice(0, 16)}…)
          plus {plan.plan.argumentBytes} bytes of constructor arguments. Nonce {plan.tx.nonce}, chain {plan.tx.chainId}.
        </p>
      </div>

      <details style={{ marginTop: 8 }}>
        <summary className="muted">Raw creation data ({(plan.plan.data.length - 2) / 2} bytes)</summary>
        <div className="mono" data-testid="deploy-data" style={{ marginTop: 6, wordBreak: 'break-all', maxHeight: 160, overflow: 'auto' }}>{plan.plan.data}</div>
      </details>

      <button className="primary wide" style={{ marginTop: 10 }} data-testid="deploy-submit" disabled={props.busy} onClick={props.onDeploy}>
        {props.busy ? 'Signing…' : 'Sign and deploy'}
      </button>
    </div>
  );
}

/**
 * After the broadcast: read the contract back off the chain, and say nothing until it answers.
 *
 * A RECEIPT NAMING AN ADDRESS IS NOT PROOF OF A CONTRACT. A creation that runs out of gas or
 * reverts in its constructor still produces a receipt with a `contractAddress` field and leaves no
 * code at it. So the only claim this screen makes is one it has verified positively: `eth_getCode`
 * is non-empty and `symbol()` answered — read back through background/contracts.ts, which refuses
 * an empty return rather than rendering it as an empty symbol.
 */
function Deployed(props: { sent: { hash: string; address: string }; chain: WalletState['chains'][number]; onBack: () => void }): React.JSX.Element {
  const [facts, setFacts] = useState<TokenFacts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tries, setTries] = useState(0);

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      void call<TokenFacts>('readToken', { address: props.sent.address })
        .then((f) => { if (live) { setFacts(f); setError(null); } })
        .catch((cause: unknown) => {
          if (!live) return;
          setError(errorText(cause));
          // Poll rather than declare failure: the transaction was accepted a moment ago and is
          // waiting for a block. Bounded, so a deployment that genuinely failed stops claiming to
          // be "confirming" for ever.
          if (tries < 40) setTries((t) => t + 1);
        });
    }, tries === 0 ? 500 : 3000);
    return () => { live = false; clearTimeout(timer); };
  }, [props.sent.address, tries]);

  return (
    <div>
      <p className="ok">Deployment broadcast.</p>
      <div className="mono" data-testid="deploy-hash">{props.sent.hash}</div>
      <div className="panel" style={{ marginTop: 10 }}>
        <div className="muted">Address</div>
        <div className="mono" data-testid="deployed-address">{props.sent.address}</div>
      </div>

      {facts === null ? (
        <p className="muted" style={{ marginTop: 10 }} data-testid="deploy-waiting">
          Waiting for a block, then reading the contract back. Until `eth_getCode` returns something
          and `symbol()` answers, this wallet has no evidence a contract exists there — a receipt
          naming an address is not that evidence.
          {tries >= 40 ? ' It has been asking for two minutes. Something went wrong; check the hash above on the chain.' : ''}
          {error !== null && tries >= 40 ? ` Last answer: ${error}` : ''}
        </p>
      ) : (
        <div className="panel" style={{ marginTop: 10 }} data-testid="deploy-confirmed">
          <strong>Confirmed on chain {props.chain.id}, at block {facts.blockNumber}</strong>
          <div className="row between" style={{ marginTop: 6 }}><span className="muted">symbol()</span><span data-testid="readback-symbol">{facts.symbol}</span></div>
          <div className="row between" style={{ marginTop: 4 }}><span className="muted">name()</span><span data-testid="readback-name">{facts.name}</span></div>
          <div className="row between" style={{ marginTop: 4 }}><span className="muted">decimals()</span><span data-testid="readback-decimals">{facts.decimals}</span></div>
          <div className="row between" style={{ marginTop: 4 }}>
            <span className="muted">totalSupply()</span>
            <span data-testid="readback-supply">{formatUnits(BigInt(facts.totalSupplyWei), facts.decimals)}</span>
          </div>
          <div className="row between" style={{ marginTop: 4 }}>
            <span className="muted">your balance</span>
            <span data-testid="readback-balance">{facts.holderBalanceWei === null ? '—' : formatUnits(BigInt(facts.holderBalanceWei), facts.decimals)}</span>
          </div>
          <p className="muted" style={{ marginTop: 6 }}>{facts.codeBytes} bytes of runtime code are at that address.</p>
        </div>
      )}

      <button className="wide" style={{ marginTop: 10 }} data-testid="deploy-back" onClick={props.onBack}>Deploy another</button>
    </div>
  );
}
