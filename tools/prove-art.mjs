/**
 * Load the built extension into a REAL Chromium and prove the pictures decode.
 *
 *   pnpm build && node tools/prove-art.mjs dist/chrome
 *
 * ── WHY THIS EXISTS ALONGSIDE test/art.test.ts ─────────────────────────────────────────────────
 *
 * `test/art.test.ts` inflates the PNG pixel data in Node, which proves the bytes are a real image
 * and runs on every CI machine without a browser. It cannot prove the browser RESOLVES the URL —
 * that a `chrome-extension://` path in `ui.js` reaches the file the package actually contains, and
 * that `sizes="128px"` selects a candidate that exists. Those are the two failures micro-org#175
 * found in Tessera, where the markup was correct and the pictures 404'd.
 *
 * So this loads the unpacked extension, opens `popup.html` at its real origin, and reads
 * `naturalWidth` after `img.decode()` — the same measurement micro-beacon's browser smoke tier
 * takes of the web surfaces, applied to the one client beacon cannot reach.
 *
 * It also reads the EIP-6963 icon the way a dapp does: from a real http origin (a content script is
 * not injected into `data:` URLs, so a `data:` page silently sees no announcement at all), by
 * dispatching `eip6963:requestProvider` and decoding the `icon` off the announced provider info.
 *
 * Not part of `pnpm test`: it needs a browser binary, and `pnpm test` is the tier that must run
 * anywhere. `pnpm test:e2e` already owns the browser tier and needs a Hearth node; this needs
 * neither a node nor a chain, which is why it is a script you can run on its own.
 */
import { chromium } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dist = resolve(process.argv[2] ?? 'dist/chrome');
const SLUGS = ['no-accounts', 'no-activity', 'no-dapps', 'no-tokens'];
let failures = 0;
const fail = (message) => { console.error(`  FAIL ${message}`); failures += 1; };

const server = createServer((_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<title>dapp</title>'); }).listen(0);
const profile = mkdtempSync(join(tmpdir(), 'wallet-ext-prove-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});

let [worker] = ctx.serviceWorkers();
if (worker === undefined) worker = await ctx.waitForEvent('serviceworker');
const id = new URL(worker.url()).host;
console.log(`unpacked ${dist} as ${id}`);

const page = await ctx.newPage();
await page.goto(`chrome-extension://${id}/popup.html`);

for (const slug of SLUGS) {
  const measured = await page.evaluate(async (name) => {
    const bare = new Image();
    bare.src = `/art/empty/${name}-384x384.png`;
    await bare.decode();                                  // rejects unless the browser decoded it
    const responsive = new Image();
    responsive.srcset = `/art/empty/${name}-384x384.png 384w, /art/empty/${name}-576x576.png 576w`;
    responsive.sizes = '128px';
    responsive.src = `/art/empty/${name}-384x384.png`;
    document.body.appendChild(responsive);
    await responsive.decode();
    return { width: bare.naturalWidth, height: bare.naturalHeight, picked: responsive.currentSrc.split('/').pop() };
  }, slug).catch((cause) => { fail(`${slug}: ${cause.message}`); return null; });

  if (measured === null) continue;
  if (measured.width !== 384 || measured.height !== 384) fail(`${slug}: decoded ${measured.width}x${measured.height}, expected 384x384`);
  else console.log(`  ok   ${slug.padEnd(12)} naturalWidth=${measured.width}x${measured.height}, srcset picked ${measured.picked}`);
}

const dapp = await ctx.newPage();
await dapp.goto(`http://127.0.0.1:${server.address().port}/`);
const info = await dapp.evaluate(() => new Promise((done) => {
  window.addEventListener('eip6963:announceProvider', (event) => done(event.detail.info), { once: true });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  setTimeout(() => done(null), 5000);
}));

if (info === null) fail('EIP-6963: no provider was announced to the page');
else {
  const size = await dapp.evaluate(async (uri) => {
    const img = new Image();
    img.src = uri;
    await img.decode();
    return [img.naturalWidth, img.naturalHeight];
  }, info.icon).catch((cause) => { fail(`EIP-6963: the announced icon did not decode — ${cause.message}`); return null; });

  if (size !== null) {
    // micro-org#178: it was a 134,230-char data URI of a 1024x1024 plate, in a script injected into
    // every page. EIP-6963 asks for at least 96x96; anything over about 20 kB is a master again.
    if (size[0] < 96) fail(`EIP-6963: the icon is ${size[0]}px, below the 96px the spec asks for`);
    else if (info.icon.length > 20_000) fail(`EIP-6963: the icon is a ${info.icon.length}-char data URI — that is a master, not the derived icon-128`);
    else console.log(`  ok   6963 icon    ${info.rdns} announces a ${size[0]}x${size[1]} icon, ${info.icon.length} chars`);
  }
}

await ctx.close();
server.close();
rmSync(profile, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
