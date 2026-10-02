import { useEffect, useRef } from "react";
import { REVEAL_MARGINS, revealInView } from "../../utils/revealInView";

/**
 * A div that scrolls itself into view, buttons and all, when it first shows
 * and again whenever `revealKey` changes (a different invoice asking). A
 * re-render with the same key moves nothing, so a physician who scrolled away
 * is not pulled back. No key: an ordinary div.
 *
 * Why (iOS 26 pass, 2026-10-02): after a share sheet closed unanswered, "Did
 * INV-… go out?" appeared at the bottom of the invoice preview with Yes and
 * No below the fold of a 402x874 screen, and nothing said to scroll.
 *
 * Its own component (not a hook in InvoiceMarkSent or UnrecordedNotes, which
 * are called as functions and return early), so its effect belongs to it.
 * Waits one frame, after the dialog and its viewport bounds have settled.
 */
export default function RevealOnShow({ revealKey = null, margins = "dialog", style, children, ...rest }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!revealKey) return undefined;
    const el = ref.current;
    const win = el?.ownerDocument?.defaultView || globalThis.window;
    if (!el || !win) return undefined;
    if (typeof win.requestAnimationFrame !== "function") { revealInView(el, win); return undefined; }
    const id = win.requestAnimationFrame(() => revealInView(el, win));
    return () => win.cancelAnimationFrame?.(id);
  }, [revealKey]);
  return (
    <div ref={ref} style={{ ...(REVEAL_MARGINS[margins] || REVEAL_MARGINS.dialog), ...style }} {...rest}>
      {children}
    </div>
  );
}
