/* Transaction decoding — the screen that stands between a user and an approval drainer.
 *
 * The selectors are asserted against their PUBLISHED values here. src/shared/decode.ts computes
 * them from the signature strings with the core's keccak256 rather than hardcoding them, so this
 * test is the other half of that arrangement: the source proves the derivation is mechanical, and
 * this proves the derivation lands on the four bytes the whole ecosystem already agrees on. Neither
 * check is sufficient alone — a typo in a signature string would produce a self-consistent wrong
 * selector, and this file is what catches it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { EFFECTIVELY_UNLIMITED, MAX_UINT256, SELECTORS, decodeCall, selectorOf, warningsFor } from '../src/shared/decode.ts';

const TOKEN = '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB';
const SPENDER = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

function word(value: bigint | string): string {
  if (typeof value === 'string') return value.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  return value.toString(16).padStart(64, '0');
}

test('the computed selectors are the ones the ecosystem publishes', () => {
  // These four are in every block explorer and every ABI database. If keccak256, the UTF-8
  // encoding, or a signature string were wrong, they would not match.
  assert.equal(SELECTORS.erc20Transfer, '0xa9059cbb');
  assert.equal(SELECTORS.erc20Approve, '0x095ea7b3');
  assert.equal(SELECTORS.erc20TransferFrom, '0x23b872dd');
  assert.equal(SELECTORS.erc721SetApprovalForAll, '0xa22cb465');
  assert.equal(selectorOf('claim()'), '0x4e71d92d');
});

test('a bare value transfer decodes as a native send', () => {
  const decoded = decodeCall({ to: SPENDER, data: '0x', valueWei: 10n ** 18n });
  assert.equal(decoded.kind, 'transfer-native');
  assert.equal(decoded.kind === 'transfer-native' && decoded.amountWei, '1000000000000000000');
});

test('an ERC-20 transfer names the recipient and the amount, not the bytes', () => {
  const data = `${SELECTORS.erc20Transfer}${word(SPENDER)}${word(1_500_000n * 10n ** 18n)}`;
  const decoded = decodeCall({ to: TOKEN, data, valueWei: 0n });
  assert.equal(decoded.kind, 'erc20-transfer');
  if (decoded.kind !== 'erc20-transfer') return;
  assert.equal(decoded.to, SPENDER);
  assert.equal(decoded.amount, '1,500,000');
});

test('an unlimited approval is flagged as danger, in those words', () => {
  const data = `${SELECTORS.erc20Approve}${word(SPENDER)}${word(MAX_UINT256)}`;
  const decoded = decodeCall({ to: TOKEN, data, valueWei: 0n });
  assert.equal(decoded.kind, 'erc20-approve');
  assert.equal(decoded.kind === 'erc20-approve' && decoded.unlimited, true);

  const warnings = warningsFor(decoded, 0n);
  assert.equal(warnings[0]?.severity, 'danger');
  assert.match(warnings[0]?.title ?? '', /Unlimited spending approval/);
  assert.ok(warnings[0]?.detail.includes(SPENDER), 'the warning must name the spender');
});

test('an approval that is merely astronomical is treated as unlimited too', () => {
  // 2**255 and 2**96-1 are what several well-known routers actually request. An `=== MAX_UINT256`
  // check would let both through with no warning, which is the bug this threshold exists for.
  for (const amount of [1n << 255n, (1n << 96n) - 1n, EFFECTIVELY_UNLIMITED]) {
    const data = `${SELECTORS.erc20Approve}${word(SPENDER)}${word(amount)}`;
    const decoded = decodeCall({ to: TOKEN, data, valueWei: 0n });
    assert.equal(decoded.kind === 'erc20-approve' && decoded.unlimited, true, `${amount} was not treated as unlimited`);
  }
});

test('a bounded approval is a caution, not a danger, and states the amount', () => {
  const data = `${SELECTORS.erc20Approve}${word(SPENDER)}${word(50n * 10n ** 18n)}`;
  const decoded = decodeCall({ to: TOKEN, data, valueWei: 0n });
  assert.equal(decoded.kind === 'erc20-approve' && decoded.unlimited, false);
  const warnings = warningsFor(decoded, 0n);
  assert.equal(warnings[0]?.severity, 'caution');
  assert.match(warnings[0]?.detail ?? '', /up to 50/);
});

test('setApprovalForAll(true) is a danger and says "every item"', () => {
  const data = `${SELECTORS.erc721SetApprovalForAll}${word(SPENDER)}${word(1n)}`;
  const decoded = decodeCall({ to: TOKEN, data, valueWei: 0n });
  assert.equal(decoded.kind, 'erc721-approve-all');
  const warnings = warningsFor(decoded, 0n);
  assert.equal(warnings[0]?.severity, 'danger');
  assert.match(warnings[0]?.title ?? '', /every item/);
});

test('an unrecognised call is admitted to rather than dressed up', () => {
  const decoded = decodeCall({ to: TOKEN, data: '0xdeadbeef0011', valueWei: 0n });
  assert.equal(decoded.kind, 'unknown');
  assert.equal(decoded.kind === 'unknown' && decoded.selector, '0xdeadbeef');
  const warnings = warningsFor(decoded, 0n);
  assert.match(warnings[0]?.title ?? '', /could not read this call/);
  assert.match(warnings[0]?.detail ?? '', /not guessing/);
});

test('an address argument with dirty high bytes is refused, not masked', () => {
  // The EVM would mask these bytes away. A preview that masked them would show an address the
  // transaction's logs will not contain, which is a way to make a confirmation screen lie.
  const dirty = `ff${'0'.repeat(22)}${SPENDER.slice(2).toLowerCase()}`;
  const data = `${SELECTORS.erc20Transfer}${dirty}${word(1n)}`;
  const decoded = decodeCall({ to: TOKEN, data, valueWei: 0n });
  assert.equal(decoded.kind, 'unknown');
});

test('a contract deployment is named and its size stated', () => {
  const decoded = decodeCall({ to: null, data: '0x60806040', valueWei: 0n });
  assert.equal(decoded.kind, 'deploy');
  assert.equal(decoded.kind === 'deploy' && decoded.bytes, 4);
});

test('value riding along with a contract call gets its own warning', () => {
  const data = `${SELECTORS.foresightStake}${word(1n)}`;
  const decoded = decodeCall({ to: TOKEN, data, valueWei: 5n * 10n ** 18n });
  assert.equal(decoded.kind, 'known');
  const warnings = warningsFor(decoded, 5n * 10n ** 18n);
  assert.ok(warnings.some((w) => w.title.includes('also sends EMBER')));
});

test('malformed data never throws — the approval window must always be able to open', () => {
  // Refusing to render is not safer than rendering "could not read this": a window that fails to
  // open leaves the dapp hanging with no way for the user to reject.
  for (const data of ['0xzz', '0x1', '', '0x' + 'a'.repeat(9)]) {
    assert.doesNotThrow(() => decodeCall({ to: TOKEN, data, valueWei: 0n }));
  }
});
