/* A second wallet, behaving the way MetaMask actually behaves.
 *
 * THIS FIXTURE IS THE POINT OF THE COEXISTENCE TEST. Asserting that our provider announces itself
 * proves nothing about coexistence — a wallet alone in a browser coexists with everything. The
 * question 25-wallet-clients.md §4.3 asks is what happens when another wallet is already there, and
 * the only honest way to answer it is to put another wallet there.
 *
 * What MetaMask does, and therefore what this does:
 *   - injects into the MAIN world at document_start;
 *   - defines `window.ethereum` and sets `isMetaMask`;
 *   - announces over EIP-6963, both unprompted and in response to eip6963:requestProvider.
 *
 * It signs nothing and talks to no chain. It is here to occupy the global and the event, which is
 * all that is needed to make the conflict real.
 */

const provider = {
  isMetaMask: true,
  _rival: true,
  request: async ({ method }) => {
    throw new Error(`rival-wallet fixture does not implement ${method} — it exists to occupy window.ethereum`);
  },
  on: () => provider,
  removeListener: () => provider,
};

const info = Object.freeze({
  uuid: crypto.randomUUID(),
  name: 'Rival Wallet',
  icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiPjwvc3ZnPg==',
  rdns: 'test.fixture.rivalwallet',
});

function announce() {
  window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {
    detail: Object.freeze({ info, provider }),
  }));
}

window.addEventListener('eip6963:requestProvider', announce);

// The legacy grab. Non-enumerable and configurable, exactly as MetaMask defines it.
Object.defineProperty(window, 'ethereum', {
  value: provider,
  writable: true,
  configurable: true,
  enumerable: false,
});

announce();
