// Email links into the app (/app/#support/<id>, #requests, #backups) on the
// owner's iPhone, 2026-10-01 link audit:
//  - a first load that failed on a flaky network offered Reload, and after
//    the reload the app opened on Home: the link had been taken at mount;
//  - the app first rendered in its offline fallback (Clerk late), took the
//    link, then mounted again under Clerk with fresh state, so the Support
//    sheet never opened.
// The link is now held by App (it outlives AppInner mounting again) until its
// screen is on view, and a Reload a screen asks for keeps it for the next page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountComponent } from '../component-harness.mjs';
import * as deepLinks from '../../src/utils/supportDeepLink.js';

const TICKET = '0b7f3c2e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

function memoryStorage() {
  const store = new Map();
  return { store, getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
}
function tab(url) {
  const u = new URL(url, 'https://credentialdomd.com');
  const location = { pathname: u.pathname, search: u.search, hash: u.hash };
  const history = { state: null, replaceState: (_s, _t, to) => { const n = new URL(to, 'https://credentialdomd.com'); location.pathname = n.pathname; location.search = n.search; location.hash = n.hash; } };
  return { location, history, storage: memoryStorage() };
}

test('a link taken at mount and kept again before a Reload opens on the page that loads next', () => {
  for (const hash of [`#support/${TICKET}`, '#requests', '#backups']) {
    const t = tab(`/app/${hash}`);
    deepLinks.captureAppDeepLink(t);
    assert.equal(deepLinks.takeAppDeepLink(t), hash, 'taken by the first page');
    // The records load fails; the screen's Reload keeps the link first.
    assert.equal(deepLinks.stashAppDeepLink(hash, { storage: t.storage }), true);
    assert.equal(deepLinks.takeAppDeepLink(t), hash, `the reloaded page opens ${hash}`);
    assert.equal(deepLinks.takeAppDeepLink(t), '', 'once');
  }
  assert.equal(deepLinks.stashAppDeepLink('#settings', { storage: memoryStorage() }), false, 'only the links emails carry');
});

async function mountApp({ hash, offline, signedIn = true, storage = null }) {
  const t = tab(`/app/${hash}`);
  if (storage) t.storage = storage;
  deepLinks.captureAppDeepLink(t);
  const window = { location: t.location, history: t.history, sessionStorage: t.storage, addEventListener() {}, removeEventListener() {}, navigator: {}, matchMedia: () => ({ matches: false }) };
  // supportDeepLink.js is this realm's module: it reads this realm's window.
  globalThis.window = window;
  const app = await mountComponent('src/App.jsx', {
    modules: {
      'clerk-react': { useUser: () => ({ isLoaded: !offline }), useAuth: () => ({ userId: offline || !signedIn ? null : 'user_syntheticLink' }) },
      supportDeepLink: deepLinks,
    },
    globals: { window, navigator: { onLine: true } },
  });
  return { app, t };
}
const innerOf = (app) => app.nodes().filter(n => n.type?.name === 'AppInner');

test('App holds the link and hands it to AppInner, and a second mount of AppInner gets it too', async () => {
  const { app } = await mountApp({ hash: `#support/${TICKET}`, offline: false });
  const [inner] = innerOf(app);
  assert.equal(inner.props.deepLink, `#support/${TICKET}`);
  // A later render (AppInner mounted again under Clerk) still carries it.
  const [again] = innerOf(app);
  assert.equal(again.props.deepLink, `#support/${TICKET}`, 'still there for a second mount');
  inner.props.settleDeepLink();
  assert.equal(innerOf(app)[0].props.deepLink, '', 'until the sheet it opened is closed');
});

test('#requests and #backups set the tab in App, where a second mount of AppInner keeps it', async () => {
  for (const [hash, sub] of [['#requests', 'requests'], ['#backups', 'export']]) {
    const { app } = await mountApp({ hash, offline: false });
    const [inner] = innerOf(app);
    assert.equal(inner.props.tab, 'more');
    assert.equal(inner.props.subPage, sub);
    assert.equal(inner.props.deepLink, hash);
  }
});

test('AppInner opens the sheet from the held link, settles it on view, and every Reload it offers keeps the link', () => {
  const src = readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  const inner = src.slice(src.indexOf('function AppInner('));
  assert.match(inner, /const supportLink = supportDeepLink\(deepLink\);[\s\S]{0,80}setSupportTab\("tickets"\);\s+setSupportTicketId\(supportLink\.ticketId\);\s+setShowSupport\(true\);\s+\}, \[deepLink\]\);/);
  assert.match(inner, /if \(deepLink && !supportDeepLink\(deepLink\) && loaded && !recordsLoadIssue\) settleDeepLink\(\);/);
  // reloadPage (utils/pageLeave.js) saves what the device copy still owes, then reloads.
  assert.match(inner, /if \(deepLink\) stashAppDeepLink\(deepLink\);\s+reloadPage\(\);/);
  assert.match(inner, /<AccountRecordsLoadError theme=\{T\} onRetry=\{reloadKeepingLink\} \/>/);
  assert.match(inner, /gate\.action === "refresh" \? limitedLaunch\.refresh\(\) : reloadKeepingLink\(\)/);
  assert.doesNotMatch(inner, /takeAppDeepLink\(\)/, 'AppInner no longer takes the link itself');
  const early = inner.indexOf('if (!authChecked) return');
  assert.ok(inner.indexOf('const reloadKeepingLink') < early, 'hooks before the first early return');
});

// Link audit, 2026-10-01: App renders the sign-in screen too, so taking the
// link from storage at App's first render emptied the stash while he was
// still signed out. Clerk's email-code sign-in then lands on /app/ with a new
// page load (or Safari discards the tab while he is in Mail for the code),
// and that page found nothing: Home, not the ticket.
test('a link opened signed out survives the page load that sign-in ends in, and is dropped once on view', async () => {
  for (const hash of [`#support/${TICKET}`, '#requests', '#backups']) {
    const signedOut = await mountApp({ hash, signedIn: false });
    assert.ok(signedOut.t.storage.store.size > 0, `${hash}: still kept for this tab on the sign-in screen`);
    // The page after sign-in: /app/ with no hash, the same tab's storage.
    const { app, t } = await mountApp({ hash: '', storage: signedOut.t.storage });
    const [inner] = innerOf(app);
    assert.equal(inner.props.deepLink, hash, `${hash} opens after sign-in`);
    inner.props.settleDeepLink();
    innerOf(app);
    assert.equal(t.storage.store.size, 0, 'dropped once its screen is on view');
  }
});
