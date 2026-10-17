// The owner's iPhone in the lab: what Playwright's WebKit needs to run the
// app at all, and a model of what iOS does to an installed home-screen app
// that a desk Chromium never shows.
//
// webkitLabInitScript: fixtures.mjs guardContext adds it to every context of
// a WebKit run (webkit.config.mjs); Chromium runs are untouched.
//
// The behaviour model (iosModelInitScript, window.__ios; ios-practice.spec.mjs
// adds it), each a step a journey calls:
//   * hangingShare(page): navigator.share records what it was handed and never
//     settles, and the page goes to the background a moment later (the share
//     sheet hands over to Mail);
//   * toBackground / returnToApp({ discard, bfcache }): hidden, pagehide, then
//     visible again (pageshow persisted when from the back-forward cache), or a
//     reload while hidden (the page discarded);
//   * clerkReplacesSessionOnFocus(page): every focus or return to the front
//     replaces window.Clerk.session with a new object of the same session, as
//     Clerk's client refresh does;
//   * flakyLaunch(context, origin, { first, hangMs }): the first API requests
//     after it hang and then fail as a timeout does on a weak mobile network;
//   * tightStorage(page, { leave }): this origin's localStorage filled with
//     another key until only `leave` characters fit, by WebKit's own quota;
//   * rotate(page): an iPad turned, crossing the app's 1024 px desk breakpoint.

/**
 * What every WebKit page of the lab needs (fixtures.mjs guardContext adds it in a WebKit run only):
 * no service worker (below), the app's CSP without upgrade-insecure-requests (the lab is plain http on loopback, which
 * Chromium exempts and WebKit upgrades to an https that nothing answers; live is https, where
 * the directive changes nothing), and, under an iPhone or iPad user agent with touch, the
 * installed home-screen app (navigator.standalone, display-mode standalone), as the owner opens it.
 */
export function webkitLabInitScript() {
  // No service worker. Playwright's WebKit routes intercept nothing from a page a service
  // worker controls (measured 2026-10-01 with 1.63 / WebKit 2359: a POST to callsync-feed from
  // a controlled page reached the lab function, which fetched the real CallSync host; the same
  // POST with workers blocked was routed). So guardContext's refusal of every host but this
  // machine, and every route stand-in, would be off. The installed app's offline shell is not
  // exercised in WebKit runs because of it.
  try {
    // In an opaque sandbox (the invoice email preview), even reading this
    // property throws. Such a frame cannot register a worker in the first
    // place; do not introduce a harness exception into its page.
    if (navigator.serviceWorker) {
      Object.defineProperty(ServiceWorkerContainer.prototype, 'register', { configurable: true,
        value() { return Promise.reject(new DOMException('QA lab: no service worker in WebKit runs (Playwright cannot route a controlled page)', 'SecurityError')); } });
    }
  } catch { /* unavailable in this context, or not replaceable */ }
  const meta = Object.getOwnPropertyDescriptor(HTMLMetaElement.prototype, 'content');
  Object.defineProperty(HTMLMetaElement.prototype, 'content', {
    configurable: true,
    get() { return meta.get.call(this); },
    set(v) {
      const csp = /content-security-policy/i.test(this.httpEquiv || this.getAttribute('http-equiv') || '');
      meta.set.call(this, csp ? String(v).replace(/;\s*upgrade-insecure-requests/g, '') : v);
    },
  });
  // WebKit reports zero maxTouchPoints, and its pointer media query can
  // become coarse only after document start. Apply the installed-app model
  // when the document is ready as well as immediately where supported.
  if (!/iPhone|iPad/.test(navigator.userAgent)) return;
  let modeled = false;
  const modelInstalled = () => {
    if (modeled || !(navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches)) return;
    modeled = true;
    try { Object.defineProperty(Navigator.prototype, 'standalone', { configurable: true, get: () => true }); } catch { /* read-only */ }
    const mm = window.matchMedia.bind(window);
    window.matchMedia = (q) => {
      const r = mm(q);
      if (!/display-mode:\s*standalone/.test(String(q))) return r;
      return { matches: true, media: r.media, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } };
    };
  };
  modelInstalled();
  document.addEventListener('DOMContentLoaded', modelInstalled, { once: true });
}

/** The iOS behaviour model's page side (window.__ios); a journey adds it with context.addInitScript. */
export function iosModelInitScript() {
  // Page visibility the journey controls (Playwright cannot background a WebKit page).
  const vis = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
  const hid = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
  const hasFocus = Document.prototype.hasFocus;
  const ios = { hidden: false, log: [], shared: [], sharePending: 0 };
  Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get() { return ios.hidden ? 'hidden' : vis.get.call(this); } });
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get() { return ios.hidden ? true : hid.get.call(this); } });
  Document.prototype.hasFocus = function () { return ios.hidden ? false : hasFocus.call(this); };
  ios.toBackground = () => {
    if (ios.hidden) return;
    ios.log.push(['hidden', Date.now()]);
    window.dispatchEvent(new Event('blur'));
    ios.hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  };
  ios.toFront = ({ bfcache = false } = {}) => {
    if (!ios.hidden) return;
    ios.log.push(['visible', Date.now(), bfcache]);
    ios.hidden = false;
    if (bfcache) window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  };
  ios.replaceSessionOnFocus = () => {
    if (ios.replacing) return;
    ios.replacing = true;
    const replace = () => setTimeout(() => {
      try { const r = window.Clerk?.replaceSessionObject?.(); if (r) ios.log.push(['session-replaced', Date.now()]); } catch { /* none */ }
    }, 30);
    window.addEventListener('focus', replace);
    document.addEventListener('visibilitychange', () => { if (!ios.hidden) replace(); });
    window.addEventListener('pageshow', replace);
  };
  ios.hangShare = ({ backgroundAfterMs = 400 } = {}) => {
    navigator.canShare = () => true;
    navigator.share = async (data) => {
      const files = [];
      for (const f of data?.files || []) files.push({ name: f.name, type: f.type, size: f.size });
      ios.shared.push({ title: data?.title || '', text: data?.text || '', url: data?.url || '', files, at: Date.now() });
      ios.sharePending += 1;
      setTimeout(() => ios.toBackground(), backgroundAfterMs);
      return new Promise(() => {}); // the sheet never answers (iOS standalone, handed to Mail)
    };
  };
  window.__ios = ios;
  // A reload in the same journey keeps the switches the journey asked for.
  try {
    const keep = JSON.parse(sessionStorage.getItem('__qa_ios') || '{}');
    if (keep.replaceSession) ios.replaceSessionOnFocus();
    if (keep.hangShare) ios.hangShare(keep.hangShare);
  } catch { /* no sessionStorage */ }
}

const keep = (page, patch) => page.evaluate((p) => {
  try { sessionStorage.setItem('__qa_ios', JSON.stringify({ ...JSON.parse(sessionStorage.getItem('__qa_ios') || '{}'), ...p })); } catch { /* none */ }
}, patch);

/** navigator.share never settles and the page goes to the background (the share sheet, then Mail). */
export async function hangingShare(page, { backgroundAfterMs = 400, persist = true } = {}) {
  await page.evaluate((o) => window.__ios.hangShare(o), { backgroundAfterMs });
  if (persist) await keep(page, { hangShare: { backgroundAfterMs } });
}
/** What the hanging share sheet was handed: [{ title, text, files: [{ name, type, size }] }]. */
export async function sharedOnIos(page) { return page.evaluate(() => window.__ios?.shared || []); }

/** The installed app goes to the background (another app, the home screen, Mail). */
export async function toBackground(page) { await page.evaluate(() => window.__ios.toBackground()); }

/**
 * Back to the app after `awayMs`: to the same page (bfcache: pageshow persisted),
 * or, with `discard`, a page iOS discarded while it was hidden, reloaded on return.
 */
export async function returnToApp(page, { awayMs = 1500, discard = false, bfcache = false } = {}) {
  await page.waitForTimeout(awayMs);
  if (discard) {
    await page.reload({ waitUntil: 'domcontentloaded' });
    return 'reloaded';
  }
  await page.evaluate((b) => window.__ios.toFront({ bfcache: b }), bfcache);
  return 'resumed';
}

/** Every focus / return to the front replaces window.Clerk.session (same session, new object). */
export async function clerkReplacesSessionOnFocus(page) {
  await page.evaluate(() => window.__ios.replaceSessionOnFocus());
  await keep(page, { replaceSession: true });
}
export async function sessionReplacements(page) { return page.evaluate(() => window.Clerk?.sessionObjectsReplaced || 0); }

/**
 * A weak mobile network at launch: the first `first` requests to the lab's API
 * (PostgREST, functions) after this call hang `hangMs` and then fail as a
 * timeout does. Requests after them pass. Returns a log of what was cut.
 */
export async function flakyLaunch(context, apiOrigin, { first = 4, hangMs = 8000 } = {}) {
  const cut = [];
  let seen = 0;
  const esc = apiOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await context.route(new RegExp(`^${esc}/`), async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS' || seen >= first) return route.fallback();
    seen += 1;
    const u = new URL(req.url());
    cut.push(`${req.method()} ${u.pathname}`);
    await new Promise((r) => setTimeout(r, hangMs));
    return route.abort('timedout').catch(() => {});
  });
  return cut;
}

/**
 * Fills this origin's localStorage with another key ('qa-ios-filler') until only
 * about `leave` more characters fit, measured against WebKit's own quota.
 * Returns { filler, left } (characters).
 */
export async function tightStorage(page, { leave = 2000 } = {}) {
  return page.evaluate((spare) => {
    const KEY = 'qa-ios-filler';
    localStorage.removeItem(KEY);
    let lo = 0, hi = 16 * 1024 * 1024;
    const fits = (n) => { try { localStorage.setItem(KEY, 'x'.repeat(n)); return true; } catch { return false; } };
    while (hi - lo > 256) { const mid = (lo + hi) >> 1; if (fits(mid)) lo = mid; else hi = mid; }
    localStorage.removeItem(KEY);
    let used = 0;
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); used += k.length + (localStorage.getItem(k) || '').length; }
    const filler = Math.max(0, lo - spare);
    fits(filler);
    return { filler, left: spare, quotaChars: lo + used };
  }, leave);
}
export async function releaseStorage(page) { await page.evaluate(() => localStorage.removeItem('qa-ios-filler')); }

/** An iPad turned: portrait 1024 x 1366 <-> landscape 1366 x 1024 (crossing the app's 1024 px desk breakpoint). */
export async function rotate(page) {
  const vp = page.viewportSize();
  const next = { width: vp.height, height: vp.width };
  await page.setViewportSize(next);
  await page.evaluate(() => { window.dispatchEvent(new Event('orientationchange')); });
  await page.waitForTimeout(800);
  return next;
}
