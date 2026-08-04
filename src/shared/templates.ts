/* The token templates, and the rules about which arguments each constructor takes.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * THESE ARE MICRO-MINT'S CONTRACTS, NOT THE WALLET'S.
 *
 * §5: "the templates come from micro-mint's catalogue so there is ONE AUDITED SET rather than two;
 * the signature is the user's, so the platform is not in the custody path of a contract the user
 * owns." `mint/src/catalogue.ts:33` is a closed union — `'fixed' | 'mintable' | 'foundry'` — and
 * the union below is that one. There is no fourth, this file compiles no Solidity, and the bytecode
 * lives in background/templates.generated.ts, copied verbatim by tools/templates.js.
 *
 * WHAT IS RESTATED HERE AND WHY THAT IS SAFE. mint's `constructorArgs` (`catalogue.ts:131`) cannot
 * be imported — it is `Buffer`-based and throws mint's own error class, and tools/build.js fails
 * the build over a Node built-in in the bundle. So the argument ORDER and the cap rule are written
 * out again, and test/templates.test.ts asserts them against the constructor input types copied out
 * of mint's own ABI, position by position. mint says of that order: "load-bearing and unchecked by
 * the compiler — swapping `decimals_` and `initialSupply_` would produce a token with 10^18
 * decimals and a supply of 18". The test is what catches it, in both repositories, from one source.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */

import type { AbiValue } from './abi.ts';

/** `mint/src/catalogue.ts:20` — the features a customer may ask for. */
export type Feature = 'mintable' | 'burnable' | 'pausable';

/** `mint/src/catalogue.ts:33`. A closed union. Adding to it here without adding a contract to
 * micro-mint would be exactly the second audited set §5 forbids. */
export type Variant = 'fixed' | 'mintable' | 'foundry';

export interface Template {
  readonly variant: Variant;
  /** The contract name, which is the key into background/templates.generated.ts. */
  readonly contract: string;
  readonly title: string;
  /** What this costs the holder in trust, said plainly. Shown on the confirmation. */
  readonly blurb: string;
  readonly features: readonly Feature[];
  readonly cap: 'required' | 'forbidden';
  /**
   * The name of the constructor's last parameter.
   *
   * `FixedSupplyToken` calls it `recipient_` and `MintableToken`/`FoundryToken` call it `owner_`,
   * and the difference is not cosmetic: the fixed-supply contract has NO OWNER AT ALL, so that
   * address receives the supply and gains nothing else. Saying "owner" on the confirmation for the
   * fixed variant would promise a power that contract does not have.
   */
  readonly lastArgName: 'recipient_' | 'owner_';
}

export const TEMPLATES: readonly Template[] = Object.freeze([
  Object.freeze({
    variant: 'fixed',
    contract: 'FixedSupplyToken',
    title: 'Fixed supply',
    blurb:
      'The whole supply is minted once, to you, and there is no owner and no privileged role. '
      + 'Nothing can ever mint more, freeze a holder or pause a transfer — including you. That is '
      + 'the strongest promise of the three and it cannot be taken back.',
    features: Object.freeze([]),
    // `catalogue.ts:46` — "No owner at all, so a cap would be a promise nothing can enforce."
    cap: 'forbidden',
    lastArgName: 'recipient_',
  }),
  Object.freeze({
    variant: 'mintable',
    contract: 'MintableToken',
    title: 'Mintable and burnable',
    blurb:
      'You keep an owner key that can mint more at any time, with no ceiling. Anyone deciding what '
      + 'this token is worth is entitled to know that, and the chain shows it — `owner()` is public. '
      + 'micro-mint leaves this uncapped by design rather than papering over it with a nominal one.',
    features: Object.freeze(['mintable', 'burnable'] as Feature[]),
    cap: 'forbidden',
    lastArgName: 'owner_',
  }),
  Object.freeze({
    variant: 'foundry',
    contract: 'FoundryToken',
    title: 'Capped, mintable, burnable, pausable',
    blurb:
      'A hard ceiling nothing can raise, plus an owner key that can mint up to it, burn, and PAUSE '
      + 'every transfer for every holder. The pause is the one worth thinking about twice: while it '
      + 'is on, nobody can move this token, and only your key can turn it off.',
    features: Object.freeze(['mintable', 'burnable', 'pausable'] as Feature[]),
    cap: 'required',
    lastArgName: 'owner_',
  }),
]);

export function templateFor(variant: Variant): Template {
  const found = TEMPLATES.find((t) => t.variant === variant);
  if (found === undefined) {
    throw new UnbuildableTokenError('variant', `${String(variant)} is not one of micro-mint's templates`);
  }
  return found;
}

/**
 * An order no committed contract can build, and the FIELD that made it so.
 *
 * Carries `field` for the same reason mint's `UnbuildableOrderError` does (`catalogue.ts:78-88`):
 * "Your order is invalid" and "`cap` is the word that made this impossible" are not the same
 * answer, and only the second one can be put next to the input that caused it.
 */
export class UnbuildableTokenError extends Error {
  readonly field: 'variant' | 'cap' | 'name' | 'symbol' | 'decimals' | 'supply' | 'owner';

  constructor(field: UnbuildableTokenError['field'], message: string) {
    super(message);
    this.name = 'UnbuildableTokenError';
    this.field = field;
  }
}

export interface TokenInput {
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  /** In the token's SMALLEST unit, exactly as the constructor takes it. */
  readonly supply: bigint;
  readonly cap: bigint | null;
  /**
   * The account that receives the supply and, where the contract has one, owns it.
   *
   * THE WALLET FIXES THIS TO THE SIGNING ACCOUNT and does not offer a field for it. That is the
   * decision this whole feature exists to make: §5 says "the signature is the user's, so the
   * platform is not in the custody path of a contract the user owns", and an owner box is a way to
   * end up not owning it — by a typo, or by a page that helpfully pre-filled somebody else's
   * address. micro-mint needs the field because the deployer and the customer are different
   * parties there; here they are the same party by construction.
   */
  readonly owner: string;
}

export const MAX_DECIMALS = 18;
export const MAX_NAME_LENGTH = 64;
export const MAX_SYMBOL_LENGTH = 11;

/**
 * The constructor arguments for a template, in the order its constructor declares them.
 *
 * `(string name_, string symbol_, uint8 decimals_, uint256 initialSupply_, [uint256 cap_,] address
 * recipient_|owner_)` — mint's `constructorArgs` at `catalogue.ts:131`, with the cap present only
 * for the variant that requires one.
 */
export function constructorArgsFor(template: Template, input: TokenInput): readonly AbiValue[] {
  if (input.name.trim() === '') throw new UnbuildableTokenError('name', 'a token needs a name');
  if (input.name.length > MAX_NAME_LENGTH) {
    throw new UnbuildableTokenError('name', `a name longer than ${MAX_NAME_LENGTH} characters costs gas to store and is truncated by most wallets`);
  }
  if (!/^[A-Za-z0-9.\-]{1,11}$/.test(input.symbol)) {
    throw new UnbuildableTokenError('symbol', `a symbol is 1 to ${MAX_SYMBOL_LENGTH} letters, digits, dots or hyphens — "${input.symbol}" is not`);
  }
  if (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > MAX_DECIMALS) {
    throw new UnbuildableTokenError('decimals', `decimals is a whole number from 0 to ${MAX_DECIMALS}, not ${input.decimals}`);
  }
  if (input.supply <= 0n) throw new UnbuildableTokenError('supply', 'the initial supply must be more than zero');
  if (input.supply >= 1n << 256n) throw new UnbuildableTokenError('supply', 'the initial supply does not fit in a uint256');
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.owner)) {
    throw new UnbuildableTokenError('owner', 'the owner must be an EVM address');
  }
  if (/^0x0{40}$/.test(input.owner)) {
    // mint refuses this too (`evm.ts:82`): a token owned by the zero address is a token with no
    // owner and a supply nobody can ever move.
    throw new UnbuildableTokenError('owner', 'the zero address cannot hold this supply');
  }

  const args: AbiValue[] = [
    { type: 'string', value: input.name },
    { type: 'string', value: input.symbol },
    { type: 'uint8', value: BigInt(input.decimals) },
    { type: 'uint256', value: input.supply },
  ];

  if (template.cap === 'required') {
    if (input.cap === null) {
      throw new UnbuildableTokenError('cap', `${template.contract} requires a cap — the ceiling is the point of it`);
    }
    if (input.cap < input.supply) {
      throw new UnbuildableTokenError('cap', 'the cap must be at least the initial supply, or the constructor reverts');
    }
    if (input.cap >= 1n << 256n) throw new UnbuildableTokenError('cap', 'the cap does not fit in a uint256');
    args.push({ type: 'uint256', value: input.cap });
  } else if (input.cap !== null) {
    throw new UnbuildableTokenError('cap', `${template.contract} takes no cap`);
  }

  args.push({ type: 'address', value: input.owner });
  return Object.freeze(args);
}

/** The types `constructorArgsFor` produces, for a template — what the ABI is checked against. */
export function constructorTypesFor(template: Template): readonly string[] {
  return template.cap === 'required'
    ? ['string', 'string', 'uint8', 'uint256', 'uint256', 'address']
    : ['string', 'string', 'uint8', 'uint256', 'address'];
}
