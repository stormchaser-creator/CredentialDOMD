import { memo, useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useApp } from "../../context/AppContext";
import { CloseIcon } from "./Icons";
import { pushModal, popModal, isTopModal } from "../../utils/deskKeys";
import { lockModalDocument, watchModalViewport } from "../../utils/modalViewport";

const FONT_ZOOM = { S: 0.88, M: 1, L: 1.1, XL: 1.2, XXL: 1.35 };

function Modal({ open, onClose, title, children, width, footer }) {
  const { theme: T, isDesktop, data } = useApp();
  const maxWidth = width ?? (isDesktop ? 720 : 520);
  const zoom = FONT_ZOOM[data?.settings?.fontSize] || 1;
  const token = useRef({});
  const overlayRef = useRef(null);
  const cardRef = useRef(null);
  const bodyRef = useRef(null);

  useLayoutEffect(() => {
    if (!open) return;
    const t = token.current;
    pushModal(t);
    const unlock = lockModalDocument(window, document);
    const unwatch = watchModalViewport({
      win: window, overlay: overlayRef.current, body: bodyRef.current, card: cardRef.current,
      isTop: () => isTopModal(t),
    });
    return () => { unwatch(); popModal(t); unlock(); };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e) => {
      if (e.key !== "Escape" || !isTopModal(token.current)) return;
      onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  if (!open) return null;

  const content = (
    <div
      ref={overlayRef}
      data-modal-overlay=""
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        // The visual viewport can pan as well as shrink for a keyboard.
        // watchModalViewport updates all four bounds, including offsetTop.
        position: "fixed", top: 0, left: 0, width: "100%", height: "100dvh",
        backgroundColor: T.overlay, boxSizing: "border-box",
        display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 1000,
        padding: "calc(env(safe-area-inset-top, 0px) + 16px) 0 calc(env(safe-area-inset-bottom, 0px) + 16px)",
        overflow: "hidden", overscrollBehavior: "none",
      }}
    >
      <div
        ref={cardRef}
        role="dialog" aria-modal="true" aria-label={title}
        onClick={e => e.stopPropagation()}
        className="cmd-fade-in"
        style={{
          backgroundColor: T.modalBg, borderRadius: 16, boxSizing: "border-box",
          // The portal sits outside the app's zoomed scroller. Preserve the
          // selected text size, with viewport bounds measured before zoom.
          zoom, width: `calc((var(--modal-viewport-width, 100vw) - 24px) / ${zoom})`, maxWidth,
          maxHeight: `calc((var(--modal-viewport-height, 100dvh) - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px) - 32px) / ${zoom})`,
          minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden",
          boxShadow: T.shadow3 || "0 12px 24px rgba(0,0,0,0.06), 0 4px 8px rgba(0,0,0,0.04)",
          border: `1px solid ${T.border}`,
        }}
      >
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
          padding: "16px 20px", borderBottom: `1px solid ${T.border}`,
          flexShrink: 0, borderRadius: "16px 16px 0 0",
        }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: T.text }}>{title}</h2>
          <button
            onClick={onClose} aria-label="Close dialog"
            style={{
              background: T.input, border: `1px solid ${T.border}`,
              borderRadius: 8, width: 32, height: 32, flexShrink: 0,
              display: "flex", alignItems: "center", justifyContent: "center",
              color: T.textMuted, cursor: "pointer",
            }}
          >
            <CloseIcon />
          </button>
        </div>
        <div ref={bodyRef} data-modal-body="" style={{
          overflowY: "auto", overflowX: "hidden",
          flex: "1 1 auto", minHeight: 0, overscrollBehavior: "contain", WebkitOverflowScrolling: "touch",
        }}><div style={{ padding: "16px 20px 24px" }}>{children}</div></div>
        {footer && <div data-modal-footer="" style={{
          flexShrink: 0, padding: "12px 20px", borderTop: `1px solid ${T.border}`, backgroundColor: T.modalBg,
        }}>{footer}</div>}
      </div>
    </div>
  );

  // Keep native focus/keyboard behavior away from the app's nested scroll
  // container and any zoom/transform that would redefine fixed positioning.
  return typeof document !== "undefined" ? createPortal(content, document.body) : content;
}

export default memo(Modal);
