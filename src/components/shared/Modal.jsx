import { memo, useEffect, useState } from "react";
import { useApp } from "../../context/AppContext";
import { CloseIcon } from "./Icons";

function Modal({ open, onClose, title, children, width = 520 }) {
  const { theme: T } = useApp();

  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    const handleKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

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
        padding: keyboardOpen ? "10px 0" : "20px 0",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="cmd-fade-in"
        style={{
          backgroundColor: T.modalBg, borderRadius: 16,
          width: "calc(100% - 24px)", maxWidth: width,
          maxHeight: vvh != null ? vvh - 24 : "calc(100vh - 40px)",
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
        <div style={{ padding: "16px 20px 24px", overflowY: "auto", flex: 1, WebkitOverflowScrolling: "touch" }}>{children}</div>
      </div>
    </div>
  );
}

export default memo(Modal);
