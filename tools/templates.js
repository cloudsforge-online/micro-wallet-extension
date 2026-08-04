/* Take micro-mint's token catalogue, verbatim, and write it where the worker can reach it.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS COPIES RATHER THAN IMPORTS.
 *
 * 25-wallet-clients.md §5: "the templates come from micro-mint's catalogue so there is ONE AUDITED
 * SET rather than two." The obvious way to honour that is to import `../mint/src/catalogue.ts`, and
 * it does not work: mint's encoder is `Buffer`-based (`mint/src/evm.ts`), mint's catalogue throws
 * `ChainError` from `mint/src/chains.ts`, and tools/build.js FAILS the build over a Node built-in
 * reaching the extension bundle — correctly, because `Buffer` is not defined in an MV3 service
 * worker. Adding micro-mint as a dependency would also put a service's entire dependency tree
 * behind a wallet that has three.
 *
 * So the BYTECODE and the ABI are copied — the artefacts, which are inert data — and the RULES are
 * restated in src/shared/templates.ts against the copied ABI. What makes that safe rather than a
 * second source of truth is that both halves are checked:
 *
 *   1. test/templates.test.ts re-runs THIS SCRIPT against the sibling micro-mint checkout and
 *      asserts the output is byte-identical to the committed file. mint is public, so CI checks it
 *      out with no secret, and the test FAILS rather than skipping when it is absent — a guard that
 *      goes green because its subject is missing is the defect this estate has spent a night
 *      unpicking.
 *   2. The same test asserts the constructor argument list src/shared/templates.ts builds matches
 *      the TYPES in the copied ABI, position by position. That is mint's own invariant
 *      (`mint/src/catalogue.ts:126-131`: "the order is load-bearing and unchecked by the compiler")
 *      and it holds here without micro-mint present at all.
 *
 * Run: node tools/templates.js [--check]
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

export const MINT_GENERATED = process.env['MINT_SRC'] === undefined
  ? resolve(root, '..', 'mint', 'src', 'contracts', 'generated.ts')
  : join(process.env['MINT_SRC'], 'contracts', 'generated.ts');

export const OUTPUT = join(root, 'src', 'background', 'templates.generated.ts');

/** The three variants of `mint/src/catalogue.ts:33` — a closed union, and not ours to extend. */
const CONTRACTS = ['FixedSupplyToken', 'MintableToken', 'FoundryToken'];

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Pull one `export const NAME = …` out of mint's generated file.
 *
 * A regex rather than an import, because importing it would execute mint's module graph in a
 * process that has no business running a service's code. The generated file is machine-written with
 * a fixed shape (`mint/scripts/compile-contracts.mjs`), so the shapes below are exact: an ABI is a
 * single-line JSON array, and a bytecode is a quoted hex string on the following line.
 */
function extract(source, name) {
  const abi = new RegExp(`^export const ${name}_ABI = (\\[.*\\]) as const$`, 'm').exec(source);
  const bytecode = new RegExp(`^export const ${name}_BYTECODE =\\s*\\n\\s*'(0x[0-9a-fA-F]+)'$`, 'm').exec(source);
  if (abi === null) throw new Error(`templates: ${name}_ABI is not in ${MINT_GENERATED} in the shape this script reads`);
  if (bytecode === null) throw new Error(`templates: ${name}_BYTECODE is not in ${MINT_GENERATED} in the shape this script reads`);
  return { abi: JSON.parse(abi[1]), bytecode: bytecode[1] };
}

export function render() {
  if (!existsSync(MINT_GENERATED)) {
    throw new Error(
      `templates: micro-mint is not beside this checkout. Looked for ${MINT_GENERATED}.\n`
      + 'It is a PUBLIC repository — `git clone https://github.com/cloudsforge-online/micro-mint mint`\n'
      + 'beside this one, or set MINT_SRC. This wallet does not invent its own token bytecode.',
    );
  }
  const source = readFileSync(MINT_GENERATED, 'utf8');
  const mintSha = /^export const SOURCE_SHA256 = '([0-9a-f]{64})'$/m.exec(source);
  if (mintSha === null) throw new Error(`templates: ${MINT_GENERATED} carries no SOURCE_SHA256`);

  const entries = CONTRACTS.map((contract) => {
    const upper = contract.toUpperCase();
    const { abi, bytecode } = extract(source, upper);
    const ctor = abi.find((item) => item.type === 'constructor');
    if (ctor === undefined) throw new Error(`templates: ${contract} has no constructor in its ABI`);
    return {
      contract,
      constructorInputs: ctor.inputs.map((input) => ({ name: input.name, type: input.type })),
      bytecode,
      bytecodeSha256: sha256(bytecode),
      // Every function this wallet could ever want to read off a deployed token, kept so the
      // symbol the deploy screen reads back is checked against the ABI it deployed rather than
      // against a signature somebody typed.
      functions: abi
        .filter((item) => item.type === 'function')
        .map((item) => `${item.name}(${item.inputs.map((i) => i.type).join(',')})`)
        .sort(),
    };
  });

  const body = entries.map((entry) => `  ${JSON.stringify(entry.contract)}: Object.freeze({
    contract: ${JSON.stringify(entry.contract)},
    constructorInputs: Object.freeze([
${entry.constructorInputs.map((i) => `      Object.freeze({ name: ${JSON.stringify(i.name)}, type: ${JSON.stringify(i.type)} }),`).join('\n')}
    ]),
    functions: Object.freeze(${JSON.stringify(entry.functions)}),
    bytecodeSha256: ${JSON.stringify(entry.bytecodeSha256)},
    bytecode: ${JSON.stringify(entry.bytecode)},
  }),`).join('\n');

  return `/**
 * GENERATED by tools/templates.js from micro-mint's src/contracts/generated.ts. Do not edit.
 *
 * This is micro-mint's committed OpenZeppelin bytecode, byte for byte — §5's "one audited set
 * rather than two". The wallet compiles no Solidity and invents no bytecode; it deploys what the
 * service already deploys, signed by the user's own key instead of by micro-custody.
 *
 * test/templates.test.ts re-runs the generator against the sibling micro-mint checkout and diffs
 * this file. A hand edit here and a change in micro-mint without a regeneration are the same red
 * build, which is the whole point of committing it.
 */

/** micro-mint's own SOURCE_SHA256: the sha256 of the ForgeTokens.sol these were compiled from. */
export const MINT_SOURCE_SHA256 = '${mintSha[1]}';

export interface TemplateArtefact {
  readonly contract: string;
  /** The constructor's parameters, in declaration order. The order is load-bearing. */
  readonly constructorInputs: readonly { readonly name: string; readonly type: string }[];
  /** Every function in the ABI, as \`name(types)\`. Used to check a read-back against the artefact. */
  readonly functions: readonly string[];
  readonly bytecodeSha256: string;
  readonly bytecode: string;
}

export const ARTEFACTS: Readonly<Record<string, TemplateArtefact>> = Object.freeze({
${body}
});
`;
}

// Only when RUN, never when imported. test/templates.test.ts imports `render` to compare its
// output against the committed file, and a module that wrote to disk on import would make that
// test pass by overwriting its own subject — a guard that repairs what it is meant to detect.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const out = render();
  if (process.argv.includes('--check')) {
    const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
    if (current !== out) {
      console.error(`templates: ${OUTPUT} is not what micro-mint says it should be. Run \`node tools/templates.js\`.`);
      process.exit(1);
    }
    console.log(`templates: ${OUTPUT} matches micro-mint (${MINT_GENERATED})`);
  } else {
    writeFileSync(OUTPUT, out);
    console.log(`templates: wrote ${OUTPUT} from ${MINT_GENERATED}`);
  }
}
