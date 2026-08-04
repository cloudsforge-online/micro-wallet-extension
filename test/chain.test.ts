/* The wallet must OBSERVE which chain it is on, not repeat what it was told.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS.
 *
 * `getChainId` was written in phase 2 and had NO CALLERS. The wallet knew its chain the way a person
 * knows what they were told: `settings.selectedChainId` was remembered, matched against a stored
 * record, and printed as fact. The popup then fell back to `chains[0]` — Hearth MAINNET — whenever
 * the selected id had no record, so a wallet in that state confidently relabelled everything on
 * screen, currency symbol included.
 *
 * 25-wallet-clients.md §1.1 forbids summing custodial and self-custody balances "because that total
 * is a lie about who can take it away from you". A chain name is the same class of claim: it is what
 * tells a user whether the money is real. And it is not only a label — EIP-155 puts the chain id
 * INSIDE the signature, so signing for an unverified chain produces bytes that are invalid where
 * they were sent and replayable where they were really meant for.
 *
 * There is no `fetch` stub here. Every case runs against a real HTTP server on a real port, for the
 * same reason test/discovery.test.ts does: a test that replaces `fetch` with a function returning a
 * literal is testing the literal.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test, { describe } from 'node:test';

import { assertChainId, getChainId } from '../src/background/rpc.ts';
import { BUILTIN_CHAINS, type ChainRecord } from '../src/background/storage.ts';
import { ProviderError } from '../src/shared/errors.ts';

/** A node that answers `eth_chainId` with whatever it is told to. */
async function nodeAnswering(chainIdHex: string | null): Promise<{ chain: ChainRecord; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (c: Buffer) => chunks.push(c));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id: number; method: string };
      response.writeHead(200, { 'content-type': 'application/json' });
      if (chainIdHex === null) {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found' } }));
        return;
      }
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: chainIdHex }));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  const port = (server.address() as { port: number }).port;
  return {
    chain: {
      id: 7412,
      name: 'Hearth Testnet',
      rpcUrl: `http://127.0.0.1:${port}`,
      currency: { name: 'Ember', symbol: 'EMBER', decimals: 18 },
      explorerUrl: null,
      supportsEip1559: false,
      addedByDapp: false,
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

describe('the chain id is read from the node', () => {
  test('a node that agrees is accepted, and its answer is returned', async () => {
    const node = await nodeAnswering('0x1cf4'); // 7412
    try {
      assert.equal(await getChainId(node.chain), 7412n);
      assert.equal(await assertChainId(node.chain), 7412n);
    } finally {
      await node.close();
    }
  });

  test('a node on a DIFFERENT chain is refused, and both numbers are named', async () => {
    // The scenario: a custom RPC repointed at another network, or a user's own node syncing
    // something else. Previously nothing asked, so the wallet went on calling it Hearth Testnet.
    const node = await nodeAnswering('0x1cf3'); // 7411 — Hearth MAINNET
    try {
      const thrown = await assertChainId(node.chain).then(() => null, (cause: unknown) => cause);
      assert.ok(thrown instanceof ProviderError, `refused with ${String(thrown)}`);
      assert.match(thrown.message, /says it is chain 7411/);
      assert.match(thrown.message, /configured as 7412/);
      assert.match(thrown.message, /Nothing has been signed/);
      // The reason, in the message, because "wrong chain" does not convey the danger.
      assert.match(thrown.message, /part of the signature itself/);
      assert.match(thrown.message, /replayable/);
    } finally {
      await node.close();
    }
  });

  test('a node that will not answer at all is refused rather than assumed', async () => {
    const node = await nodeAnswering(null);
    try {
      await assert.rejects(() => assertChainId(node.chain));
    } finally {
      await node.close();
    }
  });

  test('an unreachable endpoint is refused rather than assumed', async () => {
    const node = await nodeAnswering('0x1cf4');
    const chain = node.chain;
    await node.close(); // the port is now dead
    await assert.rejects(() => assertChainId(chain));
  });
});

describe('the shipped chain records', () => {
  test('chains[0] is MAINNET, which is why falling back to it was dangerous', () => {
    // This is the fact that made `?? state.chains[0]` a fabrication rather than a default: a
    // selected id with no record silently became Hearth mainnet on every label on screen.
    const first = BUILTIN_CHAINS[0];
    assert.equal(first?.id, 7411);
    assert.equal(first?.name, 'Hearth');
  });

  test('every shipped chain names its own currency, so nothing has to hardcode one', () => {
    // src/ui/Approval.tsx printed "EMBER" over every amount regardless of chain. The symbol now
    // travels on the transaction preview, and it can only do that if every record carries one.
    for (const chain of BUILTIN_CHAINS) {
      assert.ok(chain.currency.symbol.length > 0, `chain ${chain.id} has no currency symbol`);
      assert.equal(typeof chain.currency.decimals, 'number');
    }
  });
});
