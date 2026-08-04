/* Setup: create, back up, verify, or restore.
 *
 * THE SENTENCE ON THE FIRST SCREEN IS A REQUIREMENT, NOT COPY. §5:
 *
 *   "a hard rule — the wallet never asks for the seed phrase after setup. Anything that does is
 *    not this wallet, and the onboarding says so IN THOSE WORDS."
 *
 * It is rendered below verbatim, and test/e2e/onboarding.test.ts asserts the string is on screen.
 * A support impersonator's whole method is asking for the phrase, and a user who was told once, at
 * the only moment they were paying full attention, has a rule to check the request against.
 *
 * THE BACKUP IS VERIFIED, NOT ASSERTED. A checkbox saying "I have written it down" is a checkbox
 * everybody ticks. Three words are asked for by position, and the phrase cannot be gone past until
 * they are right — which also means the user has looked at the phrase closely enough to have
 * actually copied it.
 */

import { useCallback, useMemo, useState } from 'react';
import { call } from './client.ts';

type Step =
  | { name: 'welcome' }
  | { name: 'password'; mode: 'create' | 'restore' }
  | { name: 'phrase'; mnemonic: string; password: string }
  | { name: 'verify'; mnemonic: string; password: string }
  | { name: 'restore'; password: string }
  | { name: 'done'; address: string };

/** The one sentence §5 requires, kept in a constant so the test asserts the same string the user sees. */
export const NEVER_ASKS =
  'This wallet will never ask you for your recovery phrase after setup. Not by email, not in a support chat, not in a pop-up, and not on any website. Anyone who does is stealing from you.';

function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0]! % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export function Onboarding(): React.JSX.Element {
  const [step, setStep] = useState<Step>({ name: 'welcome' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const guard = useCallback(async (work: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  if (step.name === 'welcome') {
    return (
      <main>
        <h1>CloudsForge Wallet</h1>
        <p className="lede">
          A self-custody wallet for Hearth. You hold the key; CloudsForge cannot move your funds,
          sign for you, freeze you, or lose you.
        </p>

        <div className="warn danger" role="note">
          <strong>Read this once and remember it</strong>
          <span>{NEVER_ASKS}</span>
        </div>

        <div className="warn">
          <strong>This is not your Forge Hub balance</strong>
          <span>
            CloudsForge also keeps a custodial wallet for you, and that one the platform can help
            with. This one it cannot. The two are never added together, because a total that spans
            them would be a lie about who can take it away from you.
          </span>
        </div>

        <hr />
        <div className="stack">
          <button className="primary wide" onClick={() => setStep({ name: 'password', mode: 'create' })}>
            Create a new wallet
          </button>
          <button className="wide" onClick={() => setStep({ name: 'password', mode: 'restore' })}>
            I already have a recovery phrase
          </button>
        </div>
        <p className="muted" style={{ marginTop: 18 }}>
          CloudsForge cannot recover this wallet for you. There is no social recovery and no reset —
          the recovery phrase is the only way back in.
        </p>
      </main>
    );
  }

  if (step.name === 'password') {
    return <PasswordStep mode={step.mode} busy={busy} error={error} onBack={() => setStep({ name: 'welcome' })} onSubmit={(password) => {
      void guard(async () => {
        if (step.mode === 'restore') { setStep({ name: 'restore', password }); return; }
        const mnemonic = await call<string>('newMnemonic', { words: 12 });
        setStep({ name: 'phrase', mnemonic, password });
      });
    }} />;
  }

  if (step.name === 'phrase') {
    return <PhraseStep mnemonic={step.mnemonic} onNext={() => setStep({ name: 'verify', mnemonic: step.mnemonic, password: step.password })} />;
  }

  if (step.name === 'verify') {
    return <VerifyStep mnemonic={step.mnemonic} error={error} busy={busy} onBack={() => setStep({ name: 'phrase', mnemonic: step.mnemonic, password: step.password })} onDone={() => {
      void guard(async () => {
        const created = await call<{ address: string }>('createWallet', { mnemonic: step.mnemonic, password: step.password });
        await call('confirmBackup');
        setStep({ name: 'done', address: created.address });
      });
    }} />;
  }

  if (step.name === 'restore') {
    return <RestoreStep busy={busy} error={error} onBack={() => setStep({ name: 'welcome' })} onSubmit={(mnemonic) => {
      void guard(async () => {
        const created = await call<{ address: string }>('createWallet', { mnemonic, password: step.password });
        // A restored phrase is one the user already holds, so the backup is already done. Making
        // them write it out again would teach them that this screen is a formality.
        await call('confirmBackup');
        setStep({ name: 'done', address: created.address });
      });
    }} />;
  }

  return (
    <main>
      <h1>Your wallet is ready</h1>
      <p>The first account on this phrase is:</p>
      <div className="panel">
        <div className="mono" data-testid="first-address">{step.address}</div>
      </div>
      <p className="muted" style={{ marginTop: 12 }}>
        This address is checksummed (EIP-55): the pattern of capitals is a checksum, so a wallet that
        rejects a mistyped address is doing its job.
      </p>
      <hr />
      <p>Open the wallet from the toolbar. It is on Hearth Testnet (chain 7412) to begin with.</p>
      <button className="primary" onClick={() => window.close()}>Close this tab</button>
    </main>
  );
}

function PasswordStep(props: {
  mode: 'create' | 'restore';
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onSubmit: (password: string) => void;
}): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = again.length > 0 && again !== password;
  const ready = password.length >= 8 && again === password;

  return (
    <main>
      <h1>Choose a password</h1>
      <p>
        This password encrypts the wallet on this device. It is not your recovery phrase and it is
        not sent anywhere — CloudsForge never sees it and cannot reset it.
      </p>
      <label htmlFor="pw">Password (at least 8 characters)</label>
      <input id="pw" data-testid="password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <label htmlFor="pw2">Password again</label>
      <input id="pw2" data-testid="password-again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      {tooShort ? <p className="error">Eight characters minimum.</p> : null}
      {mismatch ? <p className="error">Those do not match.</p> : null}
      {props.error !== null ? <p className="error">{props.error}</p> : null}
      <hr />
      <div className="row">
        <button className="ghost" onClick={props.onBack}>Back</button>
        <div className="grow" />
        <button className="primary" data-testid="password-continue" disabled={!ready || props.busy} onClick={() => props.onSubmit(password)}>
          {props.mode === 'create' ? 'Create wallet' : 'Continue'}
        </button>
      </div>
    </main>
  );
}

function PhraseStep(props: { mnemonic: string; onNext: () => void }): React.JSX.Element {
  // The phrase starts COVERED. §5 asks for "a duress-resistant reveal flow that does not put the
  // phrase on screen in one tap" — one tap opens this page, so the phrase must take a second,
  // deliberate action, taken when the user has decided nobody is behind them.
  const [revealed, setRevealed] = useState(false);
  const [copiedOnce, setCopiedOnce] = useState(false);
  const words = props.mnemonic.split(' ');

  return (
    <main>
      <h1>Write this down</h1>
      <div className="warn danger" role="note">
        <strong>These twelve words are the wallet</strong>
        <span>
          Anyone who reads them can spend everything in it, on any device, forever. Write them on
          paper. Do not photograph them, do not put them in a password manager's note field, and do
          not type them into anything that is not this wallet being restored.
        </span>
      </div>

      <div className={revealed ? 'seed' : 'seed hidden'} data-testid="seed-grid" aria-hidden={!revealed}>
        {words.map((word, i) => (
          <div className="word" key={`${i}-${word}`}><b>{i + 1}</b>{word}</div>
        ))}
      </div>

      {!revealed ? (
        <div style={{ marginTop: 12 }}>
          <button className="wide" data-testid="reveal" onClick={() => setRevealed(true)}>
            Nobody is looking — show the phrase
          </button>
          <p className="muted" style={{ marginTop: 8 }}>
            Check your screen is not being shared or recorded first.
          </p>
        </div>
      ) : (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="ghost" onClick={() => { void navigator.clipboard.writeText(props.mnemonic); setCopiedOnce(true); }}>
            {copiedOnce ? 'Copied — clear your clipboard afterwards' : 'Copy'}
          </button>
          <div className="grow" />
          <button className="primary" data-testid="phrase-continue" onClick={props.onNext}>I have written it down</button>
        </div>
      )}
    </main>
  );
}

function VerifyStep(props: {
  mnemonic: string;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const words = useMemo(() => props.mnemonic.split(' '), [props.mnemonic]);
  // Three positions, chosen once. Three rather than all twelve because twelve is a transcription
  // exercise people solve by leaving the previous screen open in another tab; three spot-checks
  // cannot be passed without having the words to hand.
  const questions = useMemo(() => {
    const positions = shuffled(words.map((_, i) => i)).slice(0, 3).sort((a, b) => a - b);
    return positions.map((position) => {
      const right = words[position] as string;
      const decoys = shuffled(words.filter((w) => w !== right)).slice(0, 3);
      return { position, right, options: shuffled([right, ...decoys]) };
    });
  }, [words]);

  const [picked, setPicked] = useState<Record<number, string>>({});
  const allRight = questions.every((q) => picked[q.position] === q.right);
  const anyWrong = questions.some((q) => picked[q.position] !== undefined && picked[q.position] !== q.right);

  return (
    <main>
      <h1>Check you have it</h1>
      <p>Pick the right word for each position. This is the only way to know the backup works.</p>
      {questions.map((q) => (
        <div key={q.position} style={{ marginTop: 14 }}>
          <label>Word {q.position + 1}</label>
          <div className="row" style={{ flexWrap: 'wrap' }}>
            {q.options.map((option) => (
              <button
                key={option}
                data-testid={`verify-${q.position}-${option}`}
                className={picked[q.position] === option ? 'primary' : ''}
                onClick={() => setPicked((prev) => ({ ...prev, [q.position]: option }))}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      ))}
      {anyWrong ? <p className="error">That is not the word at that position. Go back and read the phrase again.</p> : null}
      {props.error !== null ? <p className="error">{props.error}</p> : null}
      <hr />
      <div className="row">
        <button className="ghost" onClick={props.onBack}>Show me the phrase again</button>
        <div className="grow" />
        <button className="primary" data-testid="verify-done" disabled={!allRight || props.busy} onClick={props.onDone}>
          {props.busy ? 'Sealing the vault…' : 'Done'}
        </button>
      </div>
    </main>
  );
}

function RestoreStep(props: {
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onSubmit: (mnemonic: string) => void;
}): React.JSX.Element {
  const [phrase, setPhrase] = useState('');
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  const plausible = [12, 15, 18, 21, 24].includes(words.length);

  return (
    <main>
      <h1>Restore from a recovery phrase</h1>
      <p>
        Twelve or twenty-four words, in order, separated by spaces. This is the only screen in this
        wallet that will ever ask for them.
      </p>
      <textarea
        rows={4}
        data-testid="restore-phrase"
        spellCheck={false}
        autoComplete="off"
        value={phrase}
        onChange={(e) => setPhrase(e.target.value)}
        placeholder="word word word…"
      />
      <p className="muted">{words.length} word{words.length === 1 ? '' : 's'}</p>
      {props.error !== null ? <p className="error">{props.error}</p> : null}
      <hr />
      <div className="row">
        <button className="ghost" onClick={props.onBack}>Back</button>
        <div className="grow" />
        <button className="primary" data-testid="restore-submit" disabled={!plausible || props.busy} onClick={() => props.onSubmit(phrase.trim().split(/\s+/).join(' '))}>
          {props.busy ? 'Restoring…' : 'Restore'}
        </button>
      </div>
    </main>
  );
}
