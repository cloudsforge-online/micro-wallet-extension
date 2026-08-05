/* The token templates are micro-mint's, and this is what keeps that true.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * §5: "the templates come from micro-mint's catalogue so there is ONE AUDITED SET rather than two."
 *
 * That sentence is a claim about two repositories, so a test of one repository cannot check it.
 * This file therefore reads the sibling micro-mint checkout — a PUBLIC repository, so CI clones it
 * with no secret — and asserts three separate things:
 *
 *   1. src/background/templates.generated.ts is EXACTLY what the generator produces from mint's
 *      committed artefacts. A hand edit here, and a change in micro-mint without a regeneration,
 *      are the same red build.
 *   2. Every bytecode still hashes to the digest recorded beside it, so a corrupted copy is caught
 *      even in the shape of the file rather than only by a diff.
 *   3. The argument order src/shared/templates.ts builds matches the constructor's DECLARED types,
 *      position by position — mint's own invariant (`catalogue.ts:126`: "the order is load-bearing
 *      and unchecked by the compiler"), enforced here against mint's own ABI.
 *
 * IT FAILS WHEN MICRO-MINT IS ABSENT. It does not skip. A drift guard that goes green because the
 * thing it compares against is missing has never compared anything, and this estate spent a night
 * unpicking exactly that class of defect.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test, { describe } from 'node:test';

// Importing the generator rather than shelling out to it means the test compares against the SAME
// function the committed file was produced by.
//
// This import carried a `@ts-expect-error` reading "tools/templates.js is untyped ESM". It is no
// longer suppressed: tsconfig.test.json turned on `allowJs` (for tools/sync-art.mjs, which
// test/art.test.ts imports for the same reason), so tsc now INFERS these three bindings from the
// generator's own source and a rename over there fails the type-check here rather than at runtime.
import { MINT_GENERATED, OUTPUT, render } from '../tools/templates.js';
import { ARTEFACTS, MINT_SOURCE_SHA256 } from '../src/background/templates.generated.ts';
import {
  TEMPLATES, UnbuildableTokenError, constructorArgsFor, constructorTypesFor, templateFor,
} from '../src/shared/templates.ts';
import { buildDeployment } from '../src/background/contracts.ts';

const MINT_CATALOGUE = join(dirname(MINT_GENERATED as string), '..', 'catalogue.ts');

if (!existsSync(MINT_GENERATED)) {
  throw new Error(
    `The template guard compares this wallet against micro-mint and cannot find it at ${MINT_GENERATED}.\n`
    + 'micro-mint is a PUBLIC repository — clone it beside this checkout as `mint`, or set MINT_SRC.\n'
    + 'This suite FAILS rather than skipping: §5 says there is one audited set of contracts, and that '
    + 'is a claim about two repositories which cannot be checked from one.',
  );
}

const OWNER = '0x9a2d854900ba6294bd94854c0e82710e96ce2325';

describe('the committed artefacts are micro-mint’s, unaltered', () => {
  test('the generated file is byte-identical to what micro-mint produces right now', () => {
    const committed = readFileSync(OUTPUT, 'utf8');
    assert.equal(
      committed,
      render(),
      `${OUTPUT} is not what tools/templates.js produces from ${MINT_GENERATED}. `
      + 'Either micro-mint changed and this was not regenerated, or this file was edited by hand. '
      + 'Run `node tools/templates.js`.',
    );
  });

  test('micro-mint’s ForgeTokens.sol digest travelled with the bytecode', () => {
    const source = readFileSync(MINT_GENERATED, 'utf8');
    const theirs = /^export const SOURCE_SHA256 = '([0-9a-f]{64})'$/m.exec(source);
    assert.notEqual(theirs, null);
    assert.equal(MINT_SOURCE_SHA256, theirs![1]);
  });

  test('every bytecode still hashes to the digest recorded beside it', () => {
    for (const [name, artefact] of Object.entries(ARTEFACTS)) {
      assert.equal(
        createHash('sha256').update(artefact.bytecode, 'utf8').digest('hex'),
        artefact.bytecodeSha256,
        `${name}'s bytecode does not match its own digest`,
      );
    }
  });

  test('the bytecode really is micro-mint’s, read out of micro-mint', () => {
    // Not via the generator — straight out of the other repository's file, so this would catch a
    // generator that transformed what it copied.
    const source = readFileSync(MINT_GENERATED, 'utf8');
    for (const [name, artefact] of Object.entries(ARTEFACTS)) {
      const found = new RegExp(`^export const ${name.toUpperCase()}_BYTECODE =\\s*\\n\\s*'(0x[0-9a-f]+)'$`, 'm').exec(source);
      assert.notEqual(found, null, `${name} is not in micro-mint's generated.ts`);
      assert.equal(artefact.bytecode, found![1], `${name}'s bytecode differs from micro-mint's`);
    }
  });

  test('every bytecode is real creation code, not a placeholder', () => {
    for (const [name, artefact] of Object.entries(ARTEFACTS)) {
      assert.match(artefact.bytecode, /^0x[0-9a-f]{2000,}$/, `${name} is too short to be a compiled contract`);
      // Solidity's own metadata trailer. Its absence would mean this is not solc output at all.
      assert.match(artefact.bytecode, /a264697066735822/, `${name} has no Solidity metadata trailer`);
    }
  });
});

describe('the variants are micro-mint’s closed union and nothing more', () => {
  test('exactly three, named as mint names them', () => {
    // `mint/src/catalogue.ts:33` — `'fixed' | 'mintable' | 'foundry'`. A fourth here would be the
    // second audited set §5 forbids.
    assert.deepEqual(TEMPLATES.map((t) => t.variant), ['fixed', 'mintable', 'foundry']);
    assert.deepEqual(
      TEMPLATES.map((t) => t.contract).sort(),
      Object.keys(ARTEFACTS).sort(),
    );
  });

  test('the union in micro-mint’s source still says the same three words', () => {
    const catalogue = readFileSync(MINT_CATALOGUE, 'utf8');
    const union = /export type Variant = (.+)$/m.exec(catalogue);
    assert.notEqual(union, null, 'micro-mint no longer declares `export type Variant`');
    const names = (union![1] ?? '').split('|').map((part) => part.trim().replace(/'/g, '').replace(/;$/, ''));
    assert.deepEqual(names.sort(), ['fixed', 'foundry', 'mintable']);
  });

  test('the features and cap rules match micro-mint’s, variant by variant', () => {
    // Transcribed from `catalogue.ts:39-63`. A cap rule that drifted would be an order this wallet
    // accepts and the chain reverts, after the fee has been spent.
    const expected = {
      fixed: { features: [] as string[], cap: 'forbidden' },
      mintable: { features: ['mintable', 'burnable'], cap: 'forbidden' },
      foundry: { features: ['mintable', 'burnable', 'pausable'], cap: 'required' },
    };
    for (const template of TEMPLATES) {
      assert.deepEqual([...template.features], expected[template.variant].features);
      assert.equal(template.cap, expected[template.variant].cap);
    }
  });
});

describe('the constructor argument order, which the compiler does not check', () => {
  test('what this wallet encodes matches the declared parameter types, position by position', () => {
    // THE DEFECT: "swapping `decimals_` and `initialSupply_` would produce a token with 10^18
    // decimals and a supply of 18" — mint's own words. Nothing in either language catches it; this
    // does, from the ABI the bytecode was compiled with.
    for (const template of TEMPLATES) {
      const artefact = ARTEFACTS[template.contract]!;
      assert.deepEqual(
        artefact.constructorInputs.map((i) => i.type),
        [...constructorTypesFor(template)],
        `${template.contract}'s constructor is (${artefact.constructorInputs.map((i) => i.type).join(', ')}) `
        + `but this wallet encodes (${constructorTypesFor(template).join(', ')})`,
      );
    }
  });

  test('the values land under the parameter names micro-mint declared', () => {
    for (const template of TEMPLATES) {
      const plan = buildDeployment(template.variant, {
        name: 'Ember Test Token',
        symbol: 'ETT',
        decimals: 18,
        supply: 10n ** 24n,
        cap: template.cap === 'required' ? 10n ** 26n : null,
        owner: OWNER,
      });
      const named = Object.fromEntries(plan.arguments.map((a) => [a.name, a.value]));
      assert.equal(named['name_'], 'Ember Test Token');
      assert.equal(named['symbol_'], 'ETT');
      assert.equal(named['decimals_'], '18', `${template.contract}: decimals landed on the wrong parameter`);
      assert.equal(named['initialSupply_'], (10n ** 24n).toString());
      assert.equal(named[template.lastArgName], OWNER);
      if (template.cap === 'required') assert.equal(named['cap_'], (10n ** 26n).toString());
    }
  });

  test('the last parameter is named for what it is: no owner on the fixed-supply contract', () => {
    // `FixedSupplyToken` has no owner at all, so calling that argument "owner" on a confirmation
    // would promise a power the contract does not have.
    assert.equal(templateFor('fixed').lastArgName, 'recipient_');
    assert.equal(ARTEFACTS['FixedSupplyToken']!.constructorInputs.at(-1)!.name, 'recipient_');
    assert.equal(templateFor('mintable').lastArgName, 'owner_');
    assert.equal(templateFor('foundry').lastArgName, 'owner_');
    // And the fixed contract genuinely has no owner() to call.
    assert.ok(!ARTEFACTS['FixedSupplyToken']!.functions.includes('owner()'));
    assert.ok(ARTEFACTS['MintableToken']!.functions.includes('owner()'));
    assert.ok(ARTEFACTS['FoundryToken']!.functions.includes('pause()'));
    assert.ok(!ARTEFACTS['MintableToken']!.functions.includes('pause()'));
  });

  test('the creation data is the bytecode followed by the arguments, unmodified', () => {
    const plan = buildDeployment('fixed', {
      name: 'A', symbol: 'A', decimals: 0, supply: 1n, cap: null, owner: OWNER,
    });
    assert.ok(plan.data.startsWith(ARTEFACTS['FixedSupplyToken']!.bytecode));
    assert.equal(plan.argumentBytes % 32, 0);
    assert.equal(plan.bytecodeBytes, (ARTEFACTS['FixedSupplyToken']!.bytecode.length - 2) / 2);
  });
});

describe('an order no contract can build is refused, naming the field', () => {
  const base = { name: 'Ember Test Token', symbol: 'ETT', decimals: 18, supply: 10n ** 24n, owner: OWNER };

  /**
   * Run something that must refuse, and hand back the refusal.
   *
   * `assert.throws` returns `undefined`, so `assert.throws(fn).field` is `undefined.field` — which
   * throws a TypeError and fails the test for a reason that has nothing to do with the subject.
   * This asserts the refusal happened AND that it is the typed one, so a plain `Error` escaping
   * from a validator is caught rather than counted as a pass.
   */
  const refusal = (fn: () => unknown): UnbuildableTokenError => {
    try {
      fn();
    } catch (cause) {
      assert.ok(cause instanceof UnbuildableTokenError, `refused with ${String(cause)}, which is not an UnbuildableTokenError`);
      return cause;
    }
    throw new assert.AssertionError({ message: 'this was accepted, and it should have been refused' });
  };

  test('the foundry variant without a cap', () => {
    assert.equal(refusal(() => constructorArgsFor(templateFor('foundry'), { ...base, cap: null })).field, 'cap');
  });

  test('a cap below the initial supply — which the constructor would revert on', () => {
    const thrown = refusal(() => constructorArgsFor(templateFor('foundry'), { ...base, cap: 1n }));
    assert.equal(thrown.field, 'cap');
    assert.match(thrown.message, /at least the initial supply/);
  });

  test('a cap on a contract that takes none', () => {
    for (const variant of ['fixed', 'mintable'] as const) {
      assert.equal(refusal(() => constructorArgsFor(templateFor(variant), { ...base, cap: 1n })).field, 'cap');
    }
  });

  test('the zero address cannot hold the supply', () => {
    assert.equal(
      refusal(() => constructorArgsFor(templateFor('fixed'), { ...base, cap: null, owner: `0x${'0'.repeat(40)}` })).field,
      'owner',
    );
  });

  test('a supply of zero is refused rather than deploying a token nobody holds', () => {
    assert.equal(refusal(() => constructorArgsFor(templateFor('fixed'), { ...base, supply: 0n, cap: null })).field, 'supply');
  });

  test('decimals outside 0–18 is refused rather than encoded and reverted', () => {
    for (const decimals of [-1, 19, 255, 1.5]) {
      assert.equal(refusal(() => constructorArgsFor(templateFor('fixed'), { ...base, decimals, cap: null })).field, 'decimals');
    }
  });

  test('a symbol that is not one', () => {
    for (const symbol of ['', 'way too long a symbol', 'E T T', 'ETT!']) {
      assert.equal(refusal(() => constructorArgsFor(templateFor('fixed'), { ...base, symbol, cap: null })).field, 'symbol');
    }
  });

  test('a variant micro-mint does not have', () => {
    assert.equal(refusal(() => templateFor('rebasing' as never)).field, 'variant');
  });
});
