// The phone shell never scrolls the document: content scrolls in its own div
// and the bottom bar is position: fixed (App.jsx). When the iOS keyboard opens
// for a text field (Vera's composer, a form), iOS scrolls the DOCUMENT to keep
// the field in view and, in the home-screen app, often leaves it scrolled
// after the keyboard closes. Every fixed element then sits that far up: the
// bottom menu "shifts upward and stays stuck", with the page's own background
// showing as a band beneath it (owner ticket 23920b06, 2026-10-30).
//
// Two things put it right:
//   - paintPageBackground: html and body carry the app's background, so a
//     moment of gap is never a white band;
//   - installPhoneViewportReset: once no text field has focus and the visual
//     viewport is back to (near) full height, a document left scrolled is
//     returned to the top. Pure apart from the window/document it is given,
//     so it is tested with fakes.

const FIELD = /^(INPUT|TEXTAREA|SELECT)$/;

export function isEditing(doc) {
  const el = doc?.activeElement;
  return !!el && (FIELD.test(el.tagName || "") || el.isContentEditable === true);
}

/** The document's own scroll, wherever the browser keeps it. */
export function documentScroll(win, doc) {
  return Math.max(win?.scrollY || 0, win?.pageYOffset || 0, doc?.documentElement?.scrollTop || 0, doc?.body?.scrollTop || 0);
}

/** Put the document back at the top when nothing is being typed into. */
export function resetIfStranded(win, doc) {
  if (isEditing(doc)) return false;
  const vv = win?.visualViewport;
  // Keyboard still up (the visual viewport is well short of the window).
  if (vv && win.innerHeight && vv.height < win.innerHeight - 120) return false;
  if (documentScroll(win, doc) <= 0 && !(vv && vv.offsetTop > 0)) return false;
  win.scrollTo(0, 0);
  if (doc?.documentElement) doc.documentElement.scrollTop = 0;
  if (doc?.body) doc.body.scrollTop = 0;
  return true;
}

export function installPhoneViewportReset(win, doc, { delay = 250, schedule = (fn, ms) => win.setTimeout(fn, ms), cancel = (id) => win.clearTimeout(id) } = {}) {
  if (!win || !doc) return () => {};
  let timer = null;
  const later = () => {
    if (timer !== null) cancel(timer);
    // After the keyboard's own close animation and focus move have settled.
    timer = schedule(() => { timer = null; resetIfStranded(win, doc); }, delay);
  };
  const vv = win.visualViewport;
  doc.addEventListener("focusout", later, true);
  vv?.addEventListener("resize", later);
  win.addEventListener("orientationchange", later);
  win.addEventListener("pageshow", later);
  return () => {
    if (timer !== null) cancel(timer);
    doc.removeEventListener("focusout", later, true);
    vv?.removeEventListener("resize", later);
    win.removeEventListener("orientationchange", later);
    win.removeEventListener("pageshow", later);
  };
}

export function paintPageBackground(doc, color) {
  if (!doc || !color) return;
  if (doc.documentElement) doc.documentElement.style.backgroundColor = color;
  if (doc.body) doc.body.style.backgroundColor = color;
}

// The bar was still lifted on the owner's iPhone after the reset above
// shipped (2026-10-30, his photo): the top of the app in place, the whole
// app a band of about 62 pt short of the screen, the bar on that short
// edge. That is iOS, not a scroll: in a home-screen web app, after the
// keyboard has been up, iOS can leave the layout viewport shorter than the
// screen, and 100dvh and `position: fixed; bottom: 0` both follow it.
// So the phone shell takes its height from the screen itself when the app
// runs from the home screen (no browser bars: the app owns the whole
// screen), as --app-height, and the bar sits at the bottom of the shell,
// not of the viewport. Anywhere else (Safari's tab, Android, a window
// smaller than the screen) nothing is set and 100dvh applies as before.

/** Is this the installed (home-screen) app? */
export function isStandalone(win) {
  try { return win?.navigator?.standalone === true || !!win?.matchMedia?.("(display-mode: standalone)")?.matches; }
  catch { return false; }
}

/** The height the phone shell should take, in CSS px, or null for 100dvh. */
export function fullAppHeight(win) {
  if (!isStandalone(win)) return null;
  const sw = Number(win?.screen?.width) || 0, sh = Number(win?.screen?.height) || 0;
  const iw = Number(win?.innerWidth) || 0, ih = Number(win?.innerHeight) || 0;
  if (!sw || !sh || !iw || !ih) return null;
  const landscape = iw > ih;
  const full = landscape ? Math.min(sw, sh) : Math.max(sw, sh);
  const across = landscape ? Math.max(sw, sh) : Math.min(sw, sh);
  // Not the whole screen (an iPad in Split View or Stage Manager): leave it.
  if (Math.abs(iw - across) > 2) return null;
  // The bug takes a band, never most of the screen: a height far below the
  // screen's is a window, not the bug.
  if (ih < full * 0.75 || ih > full + 2) return null;
  return full;
}

export function installAppHeight(win, doc, { delay = 250, schedule = (fn, ms) => win.setTimeout(fn, ms), cancel = (id) => win.clearTimeout(id) } = {}) {
  const root = doc?.documentElement;
  if (!win || !root?.style) return () => {};
  let timer = null;
  const apply = () => {
    const h = fullAppHeight(win);
    if (h) root.style.setProperty("--app-height", `${h}px`);
    else root.style.removeProperty("--app-height");
  };
  const later = () => {
    apply();
    if (timer !== null) cancel(timer);
    timer = schedule(() => { timer = null; apply(); }, delay);
  };
  apply();
  const vv = win.visualViewport;
  win.addEventListener("resize", later);
  win.addEventListener("orientationchange", later);
  win.addEventListener("pageshow", later);
  vv?.addEventListener("resize", later);
  doc.addEventListener("focusout", later, true);
  return () => {
    if (timer !== null) cancel(timer);
    win.removeEventListener("resize", later);
    win.removeEventListener("orientationchange", later);
    win.removeEventListener("pageshow", later);
    vv?.removeEventListener("resize", later);
    doc.removeEventListener("focusout", later, true);
    root.style.removeProperty("--app-height");
  };
}
