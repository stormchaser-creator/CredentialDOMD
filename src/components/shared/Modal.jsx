import { memo, useEffect, useRef, useState } from "react";
import { useApp } from "../../context/AppContext";
import { CloseIcon } from "./Icons";
import { pushModal, popModal, isTopModal } from "../../utils/deskKeys";

function Modal({ open, onClose, title, children, width }) {
  const { theme: T, isDesktop } = useApp();
  // Record forms and every other default-width modal widen at desk width;
  // a modal that names its own width (a compact chooser, the wide importer)
  // keeps it. Phone stays at 520.
  const maxWidth = width ?? (isDesktop ? 720 : 520);

  // Open modals stack (a payment form over an invoice detail). Each one
  // registers itself while open so Escape can tell which is on top.
  const token = useRef({});
  useEffect(() => {
    if (!open) return;
    const t = token.current;
    pushModal(t);
    return () => popModal(t);
  }, [open]);

  // Close on Escape key. At desk width only the topmost modal answers, so
  // Escape peels one layer at a time; phone keeps its existing behavior.
  useEffect(() => {
    if (!open) return;
    const handleKey = (e) => {
      if (e.key !== "Escape") return;
      if (isDesktop && !isTopModal(token.current)) return;
      onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose, isDesktop]);

  // When the iOS keyboard opens over a field, the field can end up buried —
  // scroll whatever gets focus to the center of what's still visible.
  useEffect(() => {
    if (!open) return;
    const onFocus = (e) => {
      const el = e.target;
      if (!el || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      setTimeout(() => {
        try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { /* older browser */ }
      }, 300); // give the keyboard time to resize the viewport first
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, [open]);

  // iOS: the on-screen keyboard shrinks the VISUAL viewport but not 100vh,
  // so a full-height modal gets half-buried with no way to scroll. Track the
  // visual viewport and cap the card to it.
  const [vvh, setVvh] = useState(null);
  useEffect(() => {
    if (!open || typeof window === "undefined" || !window.visualViewport) return;
    const vv = window.visualViewport;
    const update = () => setVvh(vv.height);
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      setVvh(null);
    };
  }, [open]);

  if (!open) return null;

  const keyboardOpen = vvh != null && typeof window !== "undefined" && vvh < window.innerHeight - 120;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, backgroundColor: T.overlay,
        display: "flex", alignItems: keyboardOpen ? "flex-start" : "center",
        justifyContent: "center", zIndex: 1000,
        // Installed-PWA pages draw under the iPhone status bar — keep the
        // card (and its ✕) below the clock/battery via the safe-area inset
        padding: keyboardOpen
          ? "calc(env(safe-area-inset-top, 0px) + 8px) 0 8px"
          : "calc(env(safe-area-inset-top, 0px) + 16px) 0 calc(env(safe-area-inset-bottom, 0px) + 16px)",
        // Backstop: if the card + padding above ever add up to more than the
        // visible viewport, let the overlay itself scroll instead of
        // silently clipping whatever sits at the bottom of the card.
        overflowY: "auto",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="cmd-fade-in"
        style={{
          backgroundColor: T.modalBg, borderRadius: 16,
          width: "calc(100% - 24px)", maxWidth,
          // Must mirror the overlay padding above (16+16 with no keyboard,
          // 8+8 with one) or the card can run taller than what's actually
          // visible with no way to reach the rest — this is what silently
          // clipped the bottom of the card (often the primary button) when
          // no keyboard was open.
          maxHeight: vvh != null
            ? (keyboardOpen
                ? `calc(${vvh}px - env(safe-area-inset-top, 0px) - 16px)`
                : `calc(${vvh}px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 32px)`)
            : "100%",
          display: "flex", flexDirection: "column",
          boxShadow: T.shadow3 || "0 12px 24px rgba(0,0,0,0.06), 0 4px 8px rgba(0,0,0,0.04)",
          border: `1px solid ${T.border}`,
        }}
      >
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "16px 20px", borderBottom: `1px solid ${T.border}`,
          flexShrink: 0, borderRadius: "16px 16px 0 0",
        }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: T.text }}>{title}</h2>
          <button
            onClick={onClose}
            style={{
              background: T.input, border: `1px solid ${T.border}`,
              borderRadius: 8, width: 32, height: 32,
              display: "flex", alignItems: "center", justifyContent: "center",
              color: T.textMuted, cursor: "pointer",
            }}
          >
            <CloseIcon />
          </button>
        </div>
        {/* minHeight: 0 overrides the flex item's default min-height:auto,
            which otherwise sizes this div to its content instead of the
            available space — the card would grow past maxHeight with no
            internal scrollbar, leaving only the flaky overlay-level backstop
            (unreliable with the centered, no-keyboard layout above). */}
        <div style={{ padding: "16px 20px 24px", overflowY: "auto", overflowX: "hidden", flex: 1, minHeight: 0, WebkitOverflowScrolling: "touch" }}>{children}</div>
      </div>
    </div>
  );
}

export default memo(Modal);
