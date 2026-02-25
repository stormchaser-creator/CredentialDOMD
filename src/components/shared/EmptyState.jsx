import { memo } from "react";
import { useApp } from "../../context/AppContext";

function EmptyState({ icon, title, subtitle, onAction, actionLabel }) {
  const { theme: T } = useApp();
  return (
    <div style={{ textAlign: "center", padding: "40px 24px", color: T.textMuted }}>
      <div style={{ fontSize: 44, marginBottom: 14, opacity: 0.6 }}>{icon}</div>
      <div style={{ fontSize: 17, fontWeight: 700, color: T.text, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 14, color: T.textDim, maxWidth: 300, margin: "0 auto 20px", lineHeight: 1.5 }}>{subtitle}</div>
      {onAction && (
        <button
          onClick={onAction}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6, padding: "12px 24px",
            borderRadius: 10, border: "none", fontSize: 15, fontWeight: 600,
            cursor: "pointer", backgroundColor: T.accent, color: "#fff",
            boxShadow: "0 2px 8px rgba(26,115,232,0.25)",
          }}
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export default memo(EmptyState);
