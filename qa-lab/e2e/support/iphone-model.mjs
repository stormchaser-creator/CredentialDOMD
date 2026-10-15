// What iOS does to the owner's installed home-screen app, for journeys in
// Playwright's WebKit (iphone-owner-conditions.spec.mjs). Self-contained: one
// init script (iphoneInitScript) and the steps a journey calls. Namespaced
// window.__iphone, so it never collides with another model on the same page.
//
//   * the lab serves the app over plain http on 127.0.0.1, and the app's CSP
//     carries upgrade-insecure-requests: Chromium exempts loopback from it,
//     WebKit does not and sends every request to https://127.0.0.1, which
//     nothing answers. The init script drops that one directive from the CSP
//     <meta> main.jsx writes (live is https, where it changes nothing);
//   * navigator.standalone and (display-mode: standalone): the installed app;
//   * page visibility the journey drives (Playwright cannot background a
//     WebKit page): toBackground (blur, hidden, pagehide) and returnToApp
//     (visible and focus; pageshow persisted from the back-forward cache; or a
//     reload while hidden, iOS discarding the page);
//   * clerkReplacesSessionOnFocus: every return to the front replaces
//     window.Clerk.session with a new object of the same session (the QA
//     Clerk's replaceSessionObject), as Clerk's client refresh does;
//   * flakyLaunch: the first API requests after a launch hang, then time out;
//   * tightStorage: localStorage filled to WebKit's own quota but a few
//     thousand characters.

/** The init script (runs in the page before the app's code). */
export function iphoneInitScript() {
  if (window.__iphone) return;
  const meta = Object.getOwnPropertyDescriptor(HTMLMetaElement.prototype, 'content');
  Object.defineProperty(HTMLMetaElement.prototype, 'content', {
    configurable: true,
    get() { return meta.get.call(this); },
    set(v) {
      const csp = /content-security-policy/i.test(this.httpEquiv || this.getAttribute('http-equiv') || '');
      meta.set.call(this, csp ? String(v).replace(/;?\s*upgrade-insecure-requests/g, '') : v);
    },
  });
  try { Object.defineProperty(Navigator.prototype, 'standalone', { configurable: true, get: () => true }); } catch { /* read-only */ }
  const mm = window.matchMedia.bind(window);
  window.matchMedia = (q) => {
    const r = mm(q);
    if (!/display-mode:\s*standalone/.test(String(q))) return r;
    return { matches: true, media: r.media, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } };
  };
  const vis = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');
  const hid = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
  const hasFocus = Document.prototype.hasFocus;
  const m = { hidden: false, log: [] };
  Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get() { return m.hidden ? 'hidden' : vis.get.call(this); } });
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get() { return m.hidden ? true : hid.get.call(this); } });
  Document.prototype.hasFocus = function () { return m.hidden ? false : hasFocus.call(this); };
  m.toBackground = () => {
    if (m.hidden) return;
    m.log.push(['hidden', Date.now()]);
    window.dispatchEvent(new Event('blur'));
    m.hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  };
  m.toFront = ({ bfcache = false } = {}) => {
    if (!m.hidden) return;
    m.log.push(['visible', Date.now(), bfcache]);
    m.hidden = false;
    if (bfcache) window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  };
  m.replaceOnFocus = () => {
    if (m.replacing) return;
    m.replacing = true;
    const replace = () => setTimeout(() => { try { if (window.Clerk?.replaceSessionObject?.()) m.log.push(['session-replaced', Date.now()]); } catch { /* none */ } }, 30);
    window.addEventListener('focus', replace);
    document.addEventListener('visibilitychange', () => { if (!m.hidden) replace(); });
    window.addEventListener('pageshow', replace);
  };
  window.__iphone = m;
  try { if (JSON.parse(sessionStorage.getItem('__qa_iphone') || '{}').replaceOnFocus) m.replaceOnFocus(); } catch { /* none */ }
}

export async function toBackground(page) { await page.evaluate(() => window.__iphone.toBackground()); }

/** Back after `awayMs`: the same page (pageshow persisted with `bfcache`), or with `discard` a reload. */
export async function returnToApp(page, { awayMs = 1500, discard = false, bfcache = false } = {}) {
  await page.waitForTimeout(awayMs);
  if (discard) { await page.reload({ waitUntil: 'domcontentloaded' }); return 'reloaded'; }
  await page.evaluate((b) => window.__iphone.toFront({ bfcache: b }), bfcache);
  return 'resumed';
}

/** Every return to the front replaces window.Clerk.session (same session, new object); kept across reloads of this tab. */
export async function clerkReplacesSessionOnFocus(page) {
  await page.evaluate(() => {
    window.__iphone.replaceOnFocus();
    try { sessionStorage.setItem('__qa_iphone', JSON.stringify({ replaceOnFocus: true })); } catch { /* none */ }
  });
}
export async function sessionReplacements(page) { return page.evaluate(() => window.Clerk?.sessionObjectsReplaced || 0); }

/** The first `first` requests to `apiOrigin` (not preflights) hang `hangMs`, then fail as a timeout. Returns what was cut. */
export async function flakyLaunch(context, apiOrigin, { first = 4, hangMs = 8000 } = {}) {
  const cut = [];
  let seen = 0;
  const esc = apiOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await context.route(new RegExp(`^${esc}/`), async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS' || seen >= first) return route.fallback();
    seen += 1;
    cut.push(`${req.method()} ${new URL(req.url()).pathname}`);
    await new Promise((r) => setTimeout(r, hangMs));
    return route.abort('timedout').catch(() => {});
  });
  return cut;
}

/** localStorage filled ('qa-iphone-filler') to WebKit's quota but about `leave` characters. */
export async function tightStorage(page, { leave = 2000 } = {}) {
  return page.evaluate((spare) => {
    const KEY = 'qa-iphone-filler';
    localStorage.removeItem(KEY);
    let lo = 0, hi = 16 * 1024 * 1024;
    const fits = (n) => { try { localStorage.setItem(KEY, 'x'.repeat(n)); return true; } catch { return false; } };
    while (hi - lo > 256) { const mid = (lo + hi) >> 1; if (fits(mid)) lo = mid; else hi = mid; }
    localStorage.removeItem(KEY);
    const filler = Math.max(0, lo - spare);
    fits(filler);
    return { filler, left: spare };
  }, leave);
}
export async function releaseStorage(page) { await page.evaluate(() => localStorage.removeItem('qa-iphone-filler')); }
