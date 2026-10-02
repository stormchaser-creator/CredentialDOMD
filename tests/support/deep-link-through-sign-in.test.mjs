// SUPPORT-006: a reply email links to /app/#support/<ticket id>. A member who
// opens it signed out (Mail opens Safari, which has no app sign-in) meets
// Clerk's <SignIn routing="hash">: the code step rewrites the hash to
// #/factor-one and, once signed in, Clerk goes to /app/ with no hash. The
// link must survive that trip to AppInner. Synthetic ids only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as deepLink from '../../src/utils/supportDeepLink.js';

const TICKET = '11111111-2222-4333-8444-555555555555';

function tab(url) {
  const store = new Map();
  const storage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
  };
  const location = { pathname: '', search: '', hash: '' };
  const go = href => { const u = new URL(href, 'https://credentialdomd.com'); Object.assign(location, { pathname: u.pathname, search: u.search, hash: u.hash }); };
  go(url);
  const history = { state: null, replaceState: (_s, _t, href) => go(href) };
  return { storage, location, history, go, store };
}

test('a signed-out tab keeps the email link through Clerk sign-in and AppInner opens it', () => {
  const { capture, take } = { capture: deepLink.captureAppDeepLink, take: deepLink.takeAppDeepLink };
  assert.equal(typeof capture, 'function', 'main.jsx has a capture for the email link');
  const t = tab(`/app/#support/${TICKET}`);
  const opts = { storage: t.storage, location: t.location, history: t.history, now: 1_000 };
  assert.equal(capture(opts), `#support/${TICKET}`);
  assert.equal(t.location.hash, '', 'Clerk mounts on a clean address');
  // Clerk's email code step, then its redirect to fallbackRedirectUrl "/app/" (a new page load).
  t.go('/app/#/factor-one');
  t.go('/app/');
  assert.equal(capture({ ...opts, now: 60_000 }), null, 'the reload after sign-in leaves the kept link alone');
  const hash = take({ ...opts, now: 61_000 });
  assert.deepEqual(deepLink.supportDeepLink(hash), { ticketId: TICKET }, 'AppInner opens Your tickets on that ticket');
  assert.equal(take({ ...opts, now: 62_000 }), '', 'the link opens once');
});

test('the #backups and #requests email links survive sign-in the same way', () => {
  for (const link of ['#backups', '#requests', '#support']) {
    const t = tab(`/app/${link}`);
    const opts = { storage: t.storage, location: t.location, history: t.history, now: 5 };
    deepLink.captureAppDeepLink(opts);
    t.go('/app/');
    assert.equal(deepLink.takeAppDeepLink({ ...opts, now: 10 }), link);
  }
});

test('a signed-in visitor still opens the link, and Clerk routes and other hashes are left alone', () => {
  const t = tab(`/app/#support/${TICKET}`);
  const opts = { storage: t.storage, location: t.location, history: t.history, now: 1 };
  deepLink.captureAppDeepLink(opts);
  assert.equal(deepLink.takeAppDeepLink(opts), `#support/${TICKET}`);
  for (const other of ['#/factor-one', '#sign-in', '#launch_invite=x', '#support/not-a-uuid', '']) {
    const o = tab(`/app/${other}`);
    assert.equal(deepLink.captureAppDeepLink({ storage: o.storage, location: o.location, history: o.history }), null, other);
    assert.equal(o.location.hash, other, `${other} stays in the address`);
    assert.equal(o.store.size, 0);
  }
});

test('a kept link older than an hour, or unreadable, opens nothing', () => {
  const t = tab('/app/#backups');
  const opts = { storage: t.storage, location: t.location, history: t.history, now: 0 };
  deepLink.captureAppDeepLink(opts);
  t.go('/app/');
  assert.equal(deepLink.takeAppDeepLink({ ...opts, now: 60 * 60 * 1000 + 1 }), '');
  t.storage.setItem('credentialdomd.app_deep_link', '{not json');
  assert.equal(deepLink.takeAppDeepLink(opts), '');
  assert.equal(t.store.size, 0, 'a damaged entry is removed');
});

test('without storage the hash stays in the address, as before', () => {
  const t = tab(`/app/#support/${TICKET}`);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(deepLink.captureAppDeepLink({ storage: broken, location: t.location, history: t.history }), null);
  assert.equal(t.location.hash, `#support/${TICKET}`);
  assert.equal(deepLink.takeAppDeepLink({ storage: broken, location: t.location, history: t.history }), `#support/${TICKET}`);
  assert.equal(t.location.hash, '', 'AppInner clears the address once it opens the link');
});

test('main.jsx keeps the link before Clerk mounts and App takes it back', () => {
  const main = readFileSync(new URL('../../src/main.jsx', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  const captureAt = main.indexOf('captureAppDeepLink();');
  assert.ok(captureAt > 0 && captureAt < main.indexOf('<ClerkProvider'), 'captured at module load, before ClerkProvider renders');
  // Taken back in App, which outlives AppInner mounting again (tests/iphone/deep-link-held.test.mjs).
  assert.match(app, /const openedOnLink = \(\) => \(pageDeepLink \?\?= takeAppDeepLink\(\)\);/);
  assert.match(app, /const \[deepLink, setDeepLink\] = useState\(openedOnLink\);/);
  assert.doesNotMatch(app, /const hash = window\.location\.hash;\n\s+const supportLink/);
});
