/* Wei in, a string a person can read out. No floating point anywhere in this file.
 *
 * `Number(wei) / 1e18` is the bug this file exists to prevent. A double has 53 bits of mantissa
 * and a wei value has up to 256, so the moment a balance passes ~9007 EMBER the displayed figure
 * stops matching the chain — and it does so silently, rounding rather than throwing. The estate's
 * ledger rules already say money is an integer in its smallest unit; this is the same rule at the
 * display edge.
 */

/** Parse a `0x…` QUANTITY from an RPC result. Hostile input: the network is not trusted (§7). */
export function fromQuantity(hex: unknown, what: string): bigint {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`${what}: expected a 0x quantity from the node, got ${JSON.stringify(hex)}`);
  }
  return hex === '0x' ? 0n : BigInt(hex);
}

/** A minimal-length `0x` QUANTITY, which is what every eth_* method requires (no leading zeros). */
export function toQuantity(value: bigint): string {
  if (value < 0n) throw new Error('toQuantity: a quantity is never negative');
  return `0x${value.toString(16)}`;
}

/**
 * Format an integer amount in its smallest unit as a decimal string.
 *
 * `maxFractionDigits` TRUNCATES rather than rounds, and that is deliberate: a balance rounded UP
 * shows a user more money than they have, and they discover the difference when a send fails. The
 * exact figure is always available — `formatUnits(v, d)` with no limit is exact.
 */
export function formatUnits(value: bigint, decimals: number, maxFractionDigits?: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let fraction = (abs % base).toString().padStart(decimals, '0');
  if (maxFractionDigits !== undefined) fraction = fraction.slice(0, maxFractionDigits);
  fraction = fraction.replace(/0+$/, '');
  const groupedWhole = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = fraction === '' ? groupedWhole : `${groupedWhole}.${fraction}`;
  return negative ? `-${body}` : body;
}

/**
 * Parse a decimal string into the smallest unit.
 *
 * Throws on more fraction digits than the currency has, rather than truncating. Truncation here
 * would mean a user typing 1.0000000000000000001 EMBER sends 1 EMBER and is told they sent what
 * they typed — small, silent, and wrong in the direction that loses money.
 */
export function parseUnits(input: string, decimals: number): bigint {
  const text = input.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`"${input}" is not an amount`);
  const dot = text.indexOf('.');
  const whole = dot === -1 ? text : text.slice(0, dot);
  const fraction = dot === -1 ? '' : text.slice(dot + 1);
  if (fraction.length > decimals) {
    throw new Error(`too many decimal places — this currency has ${decimals}`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

/** `0x1234…abcd`, for lists where the full 42 characters do not fit. Never used on a confirmation. */
export function shortAddress(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Gas price in gwei, for the fee editor. */
export function formatGwei(wei: bigint): string {
  return formatUnits(wei, 9, 4);
}
