/* Discovery — the one thing the chain cannot supply, and the only thing this file may fetch.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 * THE RULE, AND IT IS THE WHOLE FILE.
 *
 * §5.1: "The one thing the chain cannot supply is DISCOVERY: which markets exist and what question
 * each one asks. That comes from micro-foresight, and it degrades honestly — with the API reachable
 * the wallet browses and searches markets; without it, a user can still paste or scan a contract
 * address and interact fully. Discovery is a convenience; custody is not."
 *
 * So exactly two fields are taken from the API — the CONTRACT ADDRESS and the QUESTION TEXT — and
 * nothing else it says is ever shown or used. Not the pool, not the odds, not the status, not the
 * user's position, not the payout. Every one of those is available in the same response
 * (`foresight/src/server.ts:461` serves `pool` alongside the market), and every one of them is
 * dropped on the floor here, because a number that came from a server is a number a server can be
 * wrong or dishonest about, and the contract will answer the same question for free.
 *
 * `MARKET_FIELDS` below is that rule written as data, and test/discovery.test.ts feeds this a
 * response stuffed with plausible pools and payouts and asserts none of them survive.
 * ════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * IT IS OFF UNLESS A USER TURNS IT ON. `settings.foresightApiUrl` defaults to `null`, and the
 * shipped build therefore never contacts CloudsForge at all — the absent-API path is not a fallback
 * that gets exercised when something breaks, it is the DEFAULT path that every user is on. A
 * dependency whose absence is never exercised is a dependency you have.
 */

import { INVALID_PARAMS, ProviderError } from '../shared/errors.ts';

/** The only two fields taken from the directory. Everything else in the response is discarded. */
export const MARKET_FIELDS = Object.freeze(['contractAddress', 'question'] as const);

export interface DiscoveredMarket {
  readonly address: string;
  readonly question: string;
}

export interface DiscoveryResult {
  readonly configured: boolean;
  readonly reachable: boolean;
  readonly markets: readonly DiscoveredMarket[];
  /** Why there is nothing here, in words a user can act on. Never an exception. */
  readonly note: string;
}

export const DISCOVERY_OFF =
  'Market discovery is off, so this wallet is talking to nothing but the chain. Paste a market’s '
  + 'contract address below and everything works: your position, the pool, staking and claiming all '
  + 'come from the contract itself. Turn discovery on in Settings only if you want a list of what '
  + 'exists — it is a directory, and nothing it says is ever used for a number on these screens.';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Reject anything that is not a plain http(s) URL a user typed on purpose. */
export function normaliseApiUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ProviderError(INVALID_PARAMS, `"${raw}" is not a URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProviderError(INVALID_PARAMS, 'A discovery endpoint must be http or https.');
  }
  // No credentials in a URL the wallet will store and send on a timer.
  if (url.username !== '' || url.password !== '') {
    throw new ProviderError(INVALID_PARAMS, 'A discovery endpoint must not carry a username or password.');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * Ask a directory what markets exist. Never throws; a failure is a result with `reachable: false`.
 *
 * NOT THROWING IS THE DESIGN. An exception here would propagate into the markets screen and take
 * the paste-an-address path down with it — which would mean the platform being down stopped a user
 * claiming, which is the precise failure §5.1 is written to prevent. So the worst this can do is
 * return an empty list and a sentence saying why.
 */
export async function discoverMarkets(apiUrl: string | null, timeoutMs = 4000): Promise<DiscoveryResult> {
  if (apiUrl === null || apiUrl === '') {
    return { configured: false, reachable: false, markets: [], note: DISCOVERY_OFF };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let payload: unknown;
  try {
    const response = await fetch(`${apiUrl}/markets?limit=50`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        configured: true,
        reachable: false,
        markets: [],
        note: `The directory at ${apiUrl} answered HTTP ${response.status}. ${STILL_WORKS}`,
      };
    }
    payload = await response.json();
  } catch (cause) {
    return {
      configured: true,
      reachable: false,
      markets: [],
      note: `Could not reach the directory at ${apiUrl} (${cause instanceof Error ? cause.message : 'no reason given'}). ${STILL_WORKS}`,
    };
  } finally {
    clearTimeout(timer);
  }

  const list = (payload as { markets?: unknown } | null)?.markets;
  if (!Array.isArray(list)) {
    return { configured: true, reachable: false, markets: [], note: `${apiUrl} did not answer with a market list. ${STILL_WORKS}` };
  }

  const markets: DiscoveredMarket[] = [];
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const address = entry['contractAddress'];
    // A market row with no deployed contract is not discoverable — there is nothing to talk to. The
    // directory serves them (a market can be `approved` before its contract exists), and showing
    // one would be an entry that does nothing when tapped.
    if (typeof address !== 'string' || !ADDRESS.test(address)) continue;
    const question = typeof entry['question'] === 'string' ? entry['question'] : '(this directory gave no question text)';
    markets.push({ address, question });
  }

  return {
    configured: true,
    reachable: true,
    markets,
    note: markets.length === 0
      ? `${apiUrl} is reachable and lists no market with a deployed contract.`
      : `${markets.length} market${markets.length === 1 ? '' : 's'} listed by ${apiUrl}. `
        + 'The address and the question came from there; every number on the next screen comes from the contract.',
  };
}

const STILL_WORKS =
  'Nothing else is affected: paste a market’s contract address and your position, the pool, staking '
  + 'and claiming all still work, because they come from the chain.';
