/* Zip each build for its store.
 *
 * Chrome, Opera and Edge all take a plain zip of the unpacked directory and sign it themselves;
 * Firefox takes the same shape as an .xpi and AMO signs it. So there is no packaging step that
 * differs per store beyond the manifest, which `tools/build.js` has already chosen.
 *
 * `zip -X` strips the extra file attributes macOS adds, because the Chrome Web Store rejects an
 * archive containing `__MACOSX` entries and the message it gives does not say so.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build');
mkdirSync(out, { recursive: true });

for (const [target, extension] of [['chrome', 'zip'], ['firefox', 'xpi']]) {
  const source = join(root, 'dist', target);
  if (!existsSync(join(source, 'manifest.json'))) {
    throw new Error(`dist/${target} has not been built — run \`pnpm build:all\` first`);
  }
  const archive = join(out, `cloudsforge-wallet-${target}.${extension}`);
  rmSync(archive, { force: true });
  execFileSync('zip', ['-r', '-X', '-q', archive, '.'], { cwd: source });
  console.log(`  ${archive}`);
}
