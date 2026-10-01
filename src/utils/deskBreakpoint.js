/**
 * The one desk/phone layout flag (>= 1024 CSS px is desk).
 *
 * The flag decides which tree a screen renders, so a change unmounts and
 * remounts whatever sits at a different position in the other layout, and
 * an open form, panel or editor loses what the member typed. A change must
 * therefore be real, not a passing reading:
 *
 *  - Chromium's full-page capture briefly resizes the page, and one resize
 *    event can read innerWidth 1 (and innerHeight 1) for about 15 ms before
 *    the real width returns. Acting on it flipped desk to phone and back and
 *    closed an open Add form (QA CRED-024) and reset the NPI panel
 *    (CRED-014).
 *  - A window drag fires a stream of resize events; only where it ends
 *    matters.
 *
 * So the width is read only once resizing has been quiet for `settleMs`, a
 * width below MIN_REAL_WIDTH is ignored as degenerate (no phone is that
 * narrow; a hidden or collapsing frame reads 0), and onChange is called only
 * when the settled answer differs from the current one.
 */
export const DESK_MIN_WIDTH = 1024;
export const MIN_REAL_WIDTH = 120;
export const DESK_SETTLE_MS = 150;

/** true at desk width, false at phone width, null for a degenerate reading. */
export function deskFromWidth(width) {
  if (!(Number(width) >= MIN_REAL_WIDTH)) return null;
  return width >= DESK_MIN_WIDTH;
}

/** The first answer, before any resize: a degenerate reading means phone (SSR-safe). */
export function initialDesk(win) {
  return !!(win && deskFromWidth(win.innerWidth));
}

/**
 * Watch `win` for a settled crossing of the desk breakpoint. `current` is the
 * flag the screen is showing now. Returns the cleanup.
 */
export function watchDeskBreakpoint(win, current, onChange, { settleMs = DESK_SETTLE_MS } = {}) {
  let shown = !!current;
  let timer = null;
  const settle = () => {
    timer = null;
    const next = deskFromWidth(win.innerWidth);
    if (next === null || next === shown) return;
    shown = next;
    onChange(next);
  };
  const onResize = () => {
    if (timer !== null) win.clearTimeout(timer);
    timer = win.setTimeout(settle, settleMs);
  };
  win.addEventListener("resize", onResize);
  return () => {
    win.removeEventListener("resize", onResize);
    if (timer !== null) win.clearTimeout(timer);
    timer = null;
  };
}
