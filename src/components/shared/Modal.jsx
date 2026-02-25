import { memo, useEffect } from "react";
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

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, backgroundColor: T.overlay,
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
        padding: "20px 0",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className="cmd-fade-in"
        style={{
          backgroundColor: T.modalBg, borderRadius: 16,
          width: "calc(100% - 24px)", maxWidth: width, maxHeight: "calc(100vh - 40px)",
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
        <div style={{ padding: "16px 20px 24px", overflowY: "auto", flex: 1 }}>{children}</div>
      </div>
    </div>
  );
}

export default memo(Modal);
