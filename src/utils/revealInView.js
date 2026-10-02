/**
 * Room kept around a revealed element. In a dialog only a little air. On the
 * page the sticky top bar (56px plus the notch) and the phone's fixed tab bar
 * (64px plus the home indicator) cover the edges of the scroller, so the
 * margins clear them: scrollIntoView counts scroll-margin as part of the box.
 */
export const REVEAL_MARGINS = {
  dialog: { scrollMarginTop: 12, scrollMarginBottom: 12 },
  page: {
    scrollMarginTop: "calc(env(safe-area-inset-top, 0px) + 68px)",
    scrollMarginBottom: "calc(env(safe-area-inset-bottom, 0px) + 84px)",
  },
};

/**
 * Brings `el` fully into view in every scroller that holds it, and moves
 * nothing when it is already in view (block "nearest"). Smooth unless the
 * physician asked for reduced motion. Never throws: an older browser without
 * the options object still gets the plain call.
 */
export function revealInView(el, win) {
  if (!el?.scrollIntoView) return false;
  const still = !!win?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
  try {
    el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: still ? "auto" : "smooth" });
  } catch {
    try { el.scrollIntoView(false); } catch { /* nothing to scroll */ }
  }
  return true;
}
