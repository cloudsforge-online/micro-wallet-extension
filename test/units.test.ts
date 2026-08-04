/* Money arithmetic. Every one of these is a bug that has shipped in a real wallet.
 *
 * The whole file is about ONE claim: no value that represents money ever passes through a double.
 * `Number(wei) / 1e18` is correct up to about 9007 EMBER and silently wrong above it, and "silently
 * wrong above a threshold" is the worst shape a money bug can have — it works in every test written
 * with small numbers and fails for exactly the users who have the most to lose.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { formatGwei, formatUnits, fromQuantity, parseUnits, shortAddress, toQuantity } from '../src/shared/units.ts';

test('a balance beyond a double\'s precision is exact', () => {
  // 12,345,678.901234567890123456 EMBER. A double loses the tail entirely.
  const wei = 12_345_678_901234567890123456n;
  assert.equal(formatUnits(wei, 18), '12,345,678.901234567890123456');
  // The proof that this could not have gone through a float: the naive route disagrees.
  assert.notEqual(String(Number(wei) / 1e18), '12345678.901234567890123456');
});

test('a balance is exact IN THE FORM THE POPUP ACTUALLY USES', () => {
  // The balance on screen is `formatUnits(wei, 18, 6)` — with a precision limit. An earlier version
  // of this file only checked the unlimited form, so a deliberate mutation that routed the LIMITED
  // form through `Number(value) / 1e18` was caught by exactly one assertion, and none of them was
  // about a large balance. That is the gap the mutation found: the guard was on a code path the
  // product does not take.
  const wei = 12_345_678_901234567890123456n;
  assert.equal(formatUnits(wei, 18, 6), '12,345,678.901234');
  // The integer part must be exact no matter how many digits it has — this is the part a double
  // silently rounds, and the part that is the user's money.
  assert.equal(formatUnits(98_765_432_109_876_543_210n * 10n ** 18n, 18, 6), '98,765,432,109,876,543,210');
});

test('truncation goes down, never up', () => {
  // 0.999999999999999999 shown to 6 places must be 0.999999, not 1. A balance rounded up shows a
  // user money they do not have, and they find out when a send fails.
  assert.equal(formatUnits(999_999_999_999_999_999n, 18, 6), '0.999999');
  assert.equal(formatUnits(1n, 18, 6), '0');
});

test('trailing zeros are dropped but the integer part is grouped', () => {
  assert.equal(formatUnits(10n ** 18n, 18), '1');
  assert.equal(formatUnits(1_500_000n * 10n ** 18n, 18), '1,500,000');
  assert.equal(formatUnits(0n, 18), '0');
});

test('parseUnits refuses more precision than the currency has', () => {
  // Truncating here would mean the user is told they sent what they typed while sending less.
  assert.throws(() => parseUnits('1.0000000000000000001', 18), /too many decimal places/);
  assert.equal(parseUnits('1.5', 18), 1_500_000_000_000_000_000n);
  assert.equal(parseUnits('0.000000000000000001', 18), 1n);
});

test('parseUnits refuses anything that is not a plain decimal', () => {
  for (const bad of ['1e18', '-1', '1,000', '0x10', '', ' ', 'Infinity', 'NaN', '1.2.3']) {
    assert.throws(() => parseUnits(bad, 18), new RegExp('is not an amount'), `"${bad}" was accepted`);
  }
});

test('formatUnits output can be fed straight back into parseUnits', () => {
  // The send screen displays a balance and then lets the user paste it into the amount field. If
  // the two disagreed on grouping or trailing zeros, "send my whole balance" would be rejected as
  // an invalid amount — which is the shape of a bug users report as "the wallet is broken".
  for (const wei of [0n, 1n, 10n ** 18n, 1_906_014_473_496_000_000_000n, 12_345_678_901234567890123456n]) {
    const shown = formatUnits(wei, 18).replace(/,/g, '');
    assert.equal(parseUnits(shown, 18), wei, `${wei} did not survive the round trip`);
  }
});

test('an RPC quantity is validated rather than coerced', () => {
  assert.equal(fromQuantity('0x675343b125aa44f000', 'balance'), 1_906_014_473_496_000_000_000n);
  assert.equal(fromQuantity('0x', 'empty'), 0n);
  for (const hostile of [null, undefined, 42, '', 'abc', '0xzz', {}, ['0x1']]) {
    assert.throws(() => fromQuantity(hostile, 'balance'), /expected a 0x quantity/);
  }
});

test('toQuantity produces the minimal form every eth_ method requires', () => {
  assert.equal(toQuantity(0n), '0x0');
  assert.equal(toQuantity(21_000n), '0x5208');
  assert.throws(() => toQuantity(-1n), /never negative/);
});

test('gwei formatting is exact for the node\'s own gas price', () => {
  // 0x3b9aca00 is what the live testnet returns for eth_gasPrice: one gwei.
  assert.equal(formatGwei(fromQuantity('0x3b9aca00', 'gasPrice')), '1');
});

test('shortAddress never shortens something too short to shorten', () => {
  assert.equal(shortAddress('0x35D7600Ad32DBFdb197841B4733eE6ad8E38e3b9'), '0x35D7…e3b9');
  assert.equal(shortAddress('0x1234'), '0x1234');
});
