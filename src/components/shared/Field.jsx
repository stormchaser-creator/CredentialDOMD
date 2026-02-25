import { memo } from "react";
import { useApp } from "../../context/AppContext";

function Field({ label, children, hint }) {
  const { theme: T } = useApp();
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{
        display: "block", fontSize: 12, fontWeight: 600, color: T.textMuted,
        marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em",
      }}>
        {label}
      </label>
      {children}
      {hint && <div style={{ fontSize: 12, color: T.textDim, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

export default memo(Field);
