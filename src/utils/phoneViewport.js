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
//     viewport is back to (near) full height, a document left scrolled under
//     the phone shell is returned to the top. Pure apart from the window/document it is given,
//     so it is tested with fakes.

const FIELD = /^(INPUT|TEXTAREA|SELECT)$/;
// The phone shell (App.jsx) marks itself. Only while it is on screen is a
// scrolled document a stranded one: every other screen (the membership page,
// an error screen) scrolls the document itself, and putting it back to the
// top after each toolbar resize made the membership page jump to the top
// while it was being scrolled, so "Continue to secure payment" could not be
// reached on a phone in Safari (simulator, 2026-10-31).
export const PHONE_SHELL = "[data-phone-shell]";

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
  // Below zero is the launch offset: the page shown scrolled to -62, where
  // every tap lands 62 pt above the finger (simulator, 2026-10-30).
  const below = (Number(win?.scrollY) || 0) < 0 || !!(vv && vv.offsetTop < 0);
  if (!below && !doc?.querySelector?.(PHONE_SHELL)) return false;
  if (!below && documentScroll(win, doc) <= 0 && !(vv && vv.offsetTop > 0)) return false;
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
  later();
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
// shipped (2026-10-30, his photo), and cut off after a screen-height shell
// shipped. Reproduced on the iOS 27 simulator as a home-screen app
// (black-translucent status bar, viewport-fit=cover): the layout viewport is
// the screen minus the top inset (874 - 62 = 812 on a 402x874 phone). At
// launch WebKit shows the page scrolled to -62, so it looks full; once the
// document sits at 0 (the keyboard closing, a scrollTo(0, 0)) the page is
// 812 tall and iOS draws its own backdrop under it, which no page colour
// reaches. Nothing is painted past 812, so a taller shell is clipped there
// (the cut-off bar). This is WebKit bug 301994, open on iOS 27.
//
// What held on the simulator, through keyboard cycles and leaving and
// returning to the app: a floor on the document's height in the home-screen
// app, html[data-standalone] { min-height: min(100lvh, calc(100% +
// env(safe-area-inset-top))) } (styles/base.css). With the document at least
// the screen's height iOS gives the page the whole screen, and a shell that
// is simply fixed to the viewport's top and bottom fills it. The attribute,
// not a display-mode media query: the media query read false in the probe.

/** Is this the installed (home-screen) app? */
export function isStandalone(win) {
  try { return win?.navigator?.standalone === true || !!win?.matchMedia?.("(display-mode: standalone)")?.matches; }
  catch { return false; }
}

/** Mark the root so the home-screen height floor in base.css applies. */
export function markStandalone(win, doc) {
  const root = doc?.documentElement;
  if (!root?.dataset) return false;
  if (isStandalone(win)) { root.dataset.standalone = "true"; return true; }
  delete root.dataset.standalone;
  return false;
}
