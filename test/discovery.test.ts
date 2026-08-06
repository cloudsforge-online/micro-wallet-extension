/* Discovery: the only thing in this feature that may touch a CloudsForge service, and the leash.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * THERE IS NO `fetch` STUB IN THIS FILE.
 *
 * The subject is "what does this code do with what a server says", so a test that replaces `fetch`
 * with a function returning a literal is testing the literal. Every case below starts a REAL HTTP
 * server on a real port and lets the real `fetch` talk to it. The unreachable case shuts the server
 * down first, so the failure is a genuine connection refusal rather than a rejected promise
 * somebody wrote.
 *
 * What is being guarded: §5.1's "positions survive the platform". The directory may contribute an
 * ADDRESS and a QUESTION. Every number — pool, odds, position, payout — must come from the
 * contract, and the response below is deliberately stuffed with plausible ones to prove they do
 * not survive the trip.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test, { describe } from 'node:test';

import { DISCOVERY_OFF, MARKET_FIELDS, discoverMarkets, normaliseApiUrl } from '../src/background/discovery.ts';
import { ProviderError } from '../src/shared/errors.ts';

/** A real server answering a fixed body, on a port the OS picks. */
async function serve(status: number, body: string): Promise<{ url: string; close: () => Promise<void>; hits: string[] }> {
  const hits: string[] = [];
  const server: Server = createServer((request, response) => {
    hits.push(request.url ?? '');
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(body);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

/**
 * A response shaped exactly like micro-foresight's, with every number a wallet might be tempted to
 * believe. `foresight/src/server.ts` really does serve `pool` beside the market.
 */
const RICH = JSON.stringify({
  markets: [
    {
      id: 'f5707f8f-a6c6-4e30-b62b-ba3be5a4583b',
      contractAddress: '0x34d47E92d6Da57Df96940dd62b496e2CEAcbF8E1',
      question: 'Will the EMBER testnet be above block 1791 at 23:50?',
      status: 'open',
      // Everything below this line is a lie the wallet must not repeat.
      pool: { yes: '999999000000000000000000', no: '1', total: '999999000000000000000001' },
      oddsBps: 9999,
      payout: '123456789000000000000',
      yourStake: '500000000000000000000',
      feeBps: 0,
      closeTime: '2099-01-01T00:00:00.000Z',
      winningOutcome: 0,
    },
    // No contract deployed yet: not discoverable, because there is nothing to talk to.
    { id: 'x', contractAddress: null, question: 'Approved but never deployed' },
    { id: 'y', contractAddress: 'not-an-address', question: 'Nonsense address' },
    { id: 'z', contractAddress: '0x84624406b3b57E8FB548a5e9DBa9d912667fd495' },
  ],
});

describe('discovery is off by default, and off means no network at all', () => {
  test('a null endpoint returns the paste-an-address path with no fetch', async () => {
    const result = await discoverMarkets(null);
    assert.equal(result.configured, false);
    assert.equal(result.reachable, false);
    assert.deepEqual(result.markets, []);
    assert.equal(result.note, DISCOVERY_OFF);
    assert.match(result.note, /Paste a market’s\s+contract address below and everything works/);
  });

  test('an empty endpoint is the same as none', async () => {
    assert.equal((await discoverMarkets('')).configured, false);
  });
});

describe('only the address and the question survive the trip', () => {
  test('a response full of pools, odds and payouts contributes two strings per market', async () => {
    const server = await serve(200, RICH);
    try {
      const result = await discoverMarkets(server.url);
      assert.equal(result.reachable, true);
      assert.deepEqual(result.markets, [
        {
          address: '0x34d47E92d6Da57Df96940dd62b496e2CEAcbF8E1',
          question: 'Will the EMBER testnet be above block 1791 at 23:50?',
        },
        {
          address: '0x84624406b3b57E8FB548a5e9DBa9d912667fd495',
          question: '(this directory gave no question text)',
        },
      ]);

      // The proof, stated over the whole serialised result rather than field by field: not one of
      // the numbers the server offered appears anywhere in what the wallet came away with.
      const carried = JSON.stringify(result);
      for (const lie of ['999999000000000000000000', '9999', '123456789000000000000', '500000000000000000000', 'winningOutcome']) {
        assert.ok(!carried.includes(lie), `the directory's "${lie}" survived into the wallet's result`);
      }

      // And the shape is the declared one — two keys, no more.
      for (const market of result.markets) {
        assert.deepEqual(Object.keys(market).sort(), ['address', 'question']);
      }
      assert.deepEqual([...MARKET_FIELDS], ['contractAddress', 'question']);
    } finally {
      await server.close();
    }
  });

  test('a market with no deployed contract is not listed, because there is nothing to open', async () => {
    const server = await serve(200, RICH);
    try {
      const result = await discoverMarkets(server.url);
      assert.equal(result.markets.length, 2, 'a market with a null or malformed address was listed');
      for (const m of result.markets) assert.match(m.address, /^0x[0-9a-fA-F]{40}$/);
    } finally {
      await server.close();
    }
  });
});

describe('a directory that is down cannot take custody down with it', () => {
  test('a refused connection is a result, never an exception', async () => {
    // A REAL closed port: the server is started to reserve one, then shut down. This is a genuine
    // ECONNREFUSED, not a rejected promise a test wrote.
    const server = await serve(200, RICH);
    const url = server.url;
    await server.close();

    const result = await discoverMarkets(url, 1500);
    assert.equal(result.configured, true);
    assert.equal(result.reachable, false);
    assert.deepEqual(result.markets, []);
    assert.match(result.note, /Could not reach the directory/);
    // The sentence that makes the failure survivable rather than frightening.
    assert.match(result.note, /paste a market’s contract address and your position, the pool, staking\s+and claiming all still work/);
  });

  test('an HTTP error is a result, never an exception', async () => {
    const server = await serve(503, '{"error":"down"}');
    try {
      const result = await discoverMarkets(server.url);
      assert.equal(result.reachable, false);
      assert.match(result.note, /answered HTTP 503/);
      assert.match(result.note, /still work/);
    } finally {
      await server.close();
    }
  });

  test('a 200 that is not a market list is a result, never an exception', async () => {
    const server = await serve(200, '{"surprise":true}');
    try {
      const result = await discoverMarkets(server.url);
      assert.equal(result.reachable, false);
      assert.deepEqual(result.markets, []);
    } finally {
      await server.close();
    }
  });

  test('a body that is not JSON at all is a result, never an exception', async () => {
    const server = await serve(200, '<!doctype html><h1>captive portal</h1>');
    try {
      const result = await discoverMarkets(server.url);
      assert.equal(result.reachable, false);
    } finally {
      await server.close();
    }
  });

  test('a server that never answers is abandoned rather than hanging the screen', async () => {
    // A wallet whose markets tab waits for ever on a hung endpoint has made discovery a dependency
    // after all.
    const server = createServer(() => { /* accept, and never respond */ });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
    const port = (server.address() as { port: number }).port;
    try {
      const began = Date.now();
      const result = await discoverMarkets(`http://127.0.0.1:${port}`, 700);
      assert.equal(result.reachable, false);
      assert.ok(Date.now() - began < 5000, 'the timeout did not fire');
    } finally {
      await new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); });
    }
  });
});

describe('the endpoint a user types is checked before it is stored', () => {
  test('a trailing slash and a path are normalised', () => {
    assert.equal(normaliseApiUrl('https://foresight.example.com/'), 'https://foresight.example.com');
    assert.equal(normaliseApiUrl('  http://127.0.0.1:4123/  '), 'http://127.0.0.1:4123');
  });

  test('a non-http scheme is refused', () => {
    // `file:` and `javascript:` are the two that matter, and both would be stored and used.
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://example.com']) {
      assert.throws(() => normaliseApiUrl(url), ProviderError);
    }
  });

  test('credentials in the URL are refused rather than stored and replayed', () => {
    assert.throws(() => normaliseApiUrl('https://user:secret@example.com'), /username or password/);
  });

  test('something that is not a URL is refused', () => {
    assert.throws(() => normaliseApiUrl('not a url'), ProviderError);
  });
});
