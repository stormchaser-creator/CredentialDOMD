import { memo } from "react";
import { useApp } from "../../context/AppContext";

function StatCard({ label, value, sub, color }) {
  const { theme: T } = useApp();
  return (
    <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "14px 16px" }}>
      <div style={{
        fontSize: 10, fontWeight: 600, color: T.textDim,
        textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 3,
      }}>
        {label}
      </div>
      <div style={{ fontSize: 24, fontWeight: 800, color: color || T.text, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: T.textDim, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

export default memo(StatCard);
