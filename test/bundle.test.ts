/* Guards on the shipped package, run against the real build output.
 *
 * These check the things that are invisible until an extension is loaded into a browser and then
 * silently does nothing — the class of failure where there is no console anybody looks at. Each one
 * has fired during development.
 *
 * The suite BUILDS rather than assuming a build exists, for the reason the signing core's no-leak
 * test gives: a guard that inspects a stale artefact is a guard that passes while the source it
 * claims to be checking has changed underneath it.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test, { before, describe } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = join(REPO, 'dist', 'chrome');
const FIREFOX = join(REPO, 'dist', 'firefox');

const read = (target: string, file: string): string => readFileSync(join(target, file), 'utf8');

describe('the shipped package', () => {
  before(() => {
    execFileSync('node', [join(REPO, 'tools', 'build.js')], { cwd: REPO, stdio: 'pipe' });
    execFileSync('node', [join(REPO, 'tools', 'build.js'), '--target=firefox'], { cwd: REPO, stdio: 'pipe' });
  });

  test('every file the manifests reference actually exists', () => {
    // A manifest naming a missing file is refused at load with an error in a dialog most developers
    // never see, because they load the extension once and then never again.
    for (const target of [CHROME, FIREFOX]) {
      const manifest = JSON.parse(read(target, 'manifest.json')) as Record<string, unknown>;
      const referenced = new Set<string>();
      const collect = (value: unknown): void => {
        if (typeof value === 'string' && /\.(js|html|png|css)$/.test(value)) referenced.add(value);
        else if (Array.isArray(value)) value.forEach(collect);
        else if (typeof value === 'object' && value !== null) Object.values(value).forEach(collect);
      };
      collect(manifest);
      assert.ok(referenced.size >= 8, `only ${referenced.size} files referenced — did the manifest lose a section?`);
      for (const file of referenced) {
        assert.ok(existsSync(join(target, file)), `${target}/manifest.json names ${file}, which was not built`);
      }
    }
  });

  test('the content script, the injected script and the worker are self-contained classic scripts', () => {
    // A content script containing `import` is refused by the browser SILENTLY: no error anywhere a
    // developer looks, the extension simply has no effect on any page.
    for (const target of [CHROME, FIREFOX]) {
      for (const file of ['background.js', 'content.js', 'inpage.js']) {
        const body = read(target, file);
        assert.ok(!/^\s*(import|export)\s/m.test(body), `${file} has a top-level module statement`);
        assert.ok(!/\bimport\s*\(/.test(body), `${file} has a dynamic import, so it can fail to load a chunk at signing time`);
      }
    }
  });

  test('nothing shipped reaches for a Node built-in or a bundler placeholder', () => {
    for (const target of [CHROME, FIREFOX]) {
      for (const file of ['background.js', 'content.js', 'inpage.js', 'ui.js']) {
        const body = read(target, file);
        for (const forbidden of ['node:crypto', 'node:buffer', 'require("fs")', 'process.env.NODE_ENV']) {
          assert.ok(!body.includes(forbidden), `${target}/${file} contains ${forbidden}`);
        }
      }
    }
  });

  test('no test hook, debug flag or console.log survives into the worker', () => {
    // §3.2 of the design authority forbids the signing core from logging anything derived from a
    // key, and the same rule has to hold at the layer that HAS the keys. A console.log in the
    // worker writes to a log the user cannot see and a support agent can ask them to paste.
    const body = read(CHROME, 'background.js');
    assert.ok(!/console\.(log|debug|info|warn)\(/.test(body), 'the service worker logs');
  });

  test('the extension asks for the narrowest permissions that work', () => {
    const manifest = JSON.parse(read(CHROME, 'manifest.json')) as {
      permissions: string[]; host_permissions: string[]; content_scripts: { matches: string[] }[];
    };
    // `<all_urls>` as a host permission would let the worker read any site's cookies and make
    // credentialed requests anywhere. This wallet needs to reach RPC endpoints and nothing else,
    // and a custom RPC is an OPTIONAL permission the user grants when they add one.
    assert.ok(!manifest.host_permissions.includes('<all_urls>'), 'host_permissions includes <all_urls>');
    for (const forbidden of ['cookies', 'webRequest', 'history', 'downloads', 'management', 'debugger']) {
      assert.ok(!manifest.permissions.includes(forbidden), `the manifest asks for "${forbidden}"`);
    }
    // The content scripts must not run on file:// — an extension that injects there is reading the
    // user's local documents for no benefit.
    for (const script of manifest.content_scripts) {
      for (const match of script.matches) assert.ok(!match.startsWith('file://'), `a content script matches ${match}`);
    }
  });

  test('the two manifests differ only where the browsers differ', () => {
    const chrome = JSON.parse(read(CHROME, 'manifest.json')) as Record<string, unknown>;
    const firefox = JSON.parse(read(FIREFOX, 'manifest.json')) as Record<string, unknown>;

    // §4.3: "Firefox ships from the same source with its own manifest and AMO signing." Same
    // source means the same content scripts, the same permissions and the same pages — drift here
    // is how one browser's listing quietly becomes a different product.
    assert.deepEqual(firefox['content_scripts'], chrome['content_scripts']);
    assert.deepEqual(firefox['permissions'], chrome['permissions']);
    assert.deepEqual(firefox['host_permissions'], chrome['host_permissions']);
    assert.deepEqual(firefox['web_accessible_resources'], chrome['web_accessible_resources']);
    assert.equal(firefox['version'], chrome['version']);

    // And where they must differ: Chrome runs a service worker, Firefox an event page.
    assert.deepEqual(chrome['background'], { service_worker: 'background.js' });
    assert.deepEqual(firefox['background'], { scripts: ['background.js'] });
    assert.ok('browser_specific_settings' in firefox, 'Firefox needs a gecko id for AMO');
    assert.ok(!('browser_specific_settings' in chrome));
  });

  test('the built bundles are byte-identical between the two targets', () => {
    // The manifest is the only thing that differs. If the code differed, "Opera and Edge take the
    // Chrome build unchanged; they are separate listings, not separate products" would stop being
    // true the first time somebody added a browser check.
    for (const file of ['background.js', 'content.js', 'inpage.js', 'ui.js', 'ui.css']) {
      assert.equal(read(CHROME, file), read(FIREFOX, file), `${file} differs between the Chrome and Firefox builds`);
    }
  });

  test('MV3\'s default page CSP is not relaxed', () => {
    const manifest = JSON.parse(read(CHROME, 'manifest.json')) as { content_security_policy: { extension_pages: string } };
    const csp = manifest.content_security_policy.extension_pages;
    assert.match(csp, /script-src 'self'/);
    for (const escape of ["'unsafe-eval'", "'unsafe-inline'", 'https://', 'http://']) {
      assert.ok(!csp.includes(escape), `the page CSP allows ${escape}`);
    }
    // And no inline script in any page, which that CSP would refuse anyway — better to find out here.
    for (const page of ['popup.html', 'onboarding.html', 'approval.html']) {
      const html = read(CHROME, page);
      assert.ok(!/<script(?![^>]*\bsrc=)/.test(html), `${page} has an inline script`);
    }
  });
});
