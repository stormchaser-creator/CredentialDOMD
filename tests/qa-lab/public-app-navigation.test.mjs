import test from 'node:test';
import assert from 'node:assert/strict';
import { redirectsAppNavigation } from '../../qa-lab/e2e/support/bill-admin-support-public-helpers.mjs';

test('public fixture redirects app navigation but serves service-worker shell fetches on their own origin', () => {
  for (const pathname of ['/app', '/app/', '/app/index.html', '/app/deep/']) {
    assert.equal(redirectsAppNavigation(pathname, { 'sec-fetch-mode': 'navigate' }), true, pathname);
    for (const mode of ['cors', 'same-origin', 'no-cors']) {
      assert.equal(redirectsAppNavigation(pathname, { 'sec-fetch-mode': mode }), false, `${pathname}: ${mode}`);
    }
    assert.equal(redirectsAppNavigation(pathname), false, 'non-browser probes read the packaged shell');
  }
});

test('packaged legal pages, worker scripts and assets are never sent to the other app origin', () => {
  for (const pathname of ['/app/privacy.html', '/app/terms.html', '/app/sw.js', '/app/assets/index-hash.js', '/app/manifest.json', '/sw.js', '/']) {
    assert.equal(redirectsAppNavigation(pathname, { 'sec-fetch-mode': 'navigate' }), false, pathname);
  }
});
