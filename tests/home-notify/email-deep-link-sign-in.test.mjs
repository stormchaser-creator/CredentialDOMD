// NOTIFY-005: email links (/app/#requests, /app/#backups, /app/#support/<id>)
// were read only by AppInner's mount effect, and AppInner mounts only once the
// member is signed in. Signed out (a link tapped in Mail opens Safari, which
// does not share the home screen app's session), Clerk's hash-routed SignIn
// rewrote the hash and finished at /app/: the member landed on Home.
// The one implementation is utils/supportDeepLink.js (captureAppDeepLink /
// takeAppDeepLink, also covered by tests/support/deep-link-through-sign-in).
// Synthetic ids only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { captureAppDeepLink, takeAppDeepLink, isAppDeepLink } from '../../src/utils/supportDeepLink.js';

const TICKET = '#support/0f0f0f0f-1111-4222-8333-444444444444';
function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), size: () => m.size };
}
function address(hash) {
  const location = { pathname: '/app/', search: '', hash };
  const history = { state: null, replaceState: (_s, _t, href) => { location.hash = new URL(href, 'https://credentialdomd.com').hash; } };
  return { location, history };
}

for (const link of ['#requests', '#backups', '#support', TICKET]) {
  test(`${link} opened signed out still opens after the email code sign in`, () => {
    const storage = memoryStorage();
    const t0 = Date.parse('2026-10-01T15:00:00Z');
    const a = address(link);
    captureAppDeepLink({ ...a, storage, now: t0 });
    // Clerk walks its own steps in the hash, then lands on /app/ with none.
    const after = address('');
    assert.equal(takeAppDeepLink({ ...after, storage, now: t0 + 4 * 60 * 1000 }), link);
    assert.equal(takeAppDeepLink({ ...after, storage, now: t0 + 5 * 60 * 1000 }), '', 'it opens once');
  });
}

test('a signed in member\'s own link wins, and a later load does not reopen the kept one', () => {
  const storage = memoryStorage();
  const now = Date.parse('2026-10-01T15:00:00Z');
  captureAppDeepLink({ ...address('#backups'), storage, now });
  assert.equal(takeAppDeepLink({ ...address('#backups'), storage, now }), '#backups');
  assert.equal(storage.size(), 0);
});

test('only the app\'s own links are kept, and not for long', () => {
  const storage = memoryStorage();
  const now = Date.parse('2026-10-01T15:00:00Z');
  for (const hash of ['', '#/factor-one', '#sign-in', '#support/not-a-ticket', '#launch_invite=x']) {
    captureAppDeepLink({ ...address(hash), storage, now });
    assert.equal(storage.size(), 0, `${hash || 'no hash'} is not kept`);
    assert.equal(isAppDeepLink(hash), false);
  }
  captureAppDeepLink({ ...address('#requests'), storage, now });
  assert.equal(takeAppDeepLink({ ...address(''), storage, now: now + 61 * 60 * 1000 }), '', 'an old copy is dropped');
  assert.equal(takeAppDeepLink({ ...address(''), storage: { getItem() { throw new Error('blocked'); }, removeItem() {} }, now }), '', 'blocked storage is no link');
});

test('main.jsx keeps the link before anything renders, and App takes it back', () => {
  const main = readFileSync(new URL('../../src/main.jsx', import.meta.url), 'utf8');
  const stash = main.indexOf('captureAppDeepLink();');
  assert.ok(stash > 0, 'main.jsx keeps the link');
  assert.ok(stash < main.indexOf('createRoot('), 'before the first render, so Clerk has not rewritten the hash');
  const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  // Taken back in App, which outlives AppInner mounting again (tests/iphone/deep-link-held.test.mjs).
  assert.match(app, /const openedOnLink = \(\) => \(pageDeepLink \?\?= takeAppDeepLink\(\)\);/);
});
