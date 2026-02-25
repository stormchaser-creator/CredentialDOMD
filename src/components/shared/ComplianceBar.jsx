import { memo } from "react";
import { useApp } from "../../context/AppContext";

function ComplianceBar({ label, earned, required, met, note }) {
  const { theme: T } = useApp();
  const pct = required > 0 ? Math.min(100, (earned / required) * 100) : 100;
  const barColor = met ? T.success : pct > 50 ? T.warning : T.danger;

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{label}</div>
        <div style={{ fontSize: 13, fontWeight: 700, color: met ? T.success : T.danger }}>
          {earned}/{required} hrs {met ? "\u2713" : ""}
        </div>
      </div>
      <div style={{ height: 8, backgroundColor: T.input, borderRadius: 4, overflow: "hidden" }}>
        <div style={{
          height: "100%", width: pct + "%", backgroundColor: barColor,
          borderRadius: 4, transition: "width 0.5s ease",
        }} />
      </div>
      {note && <div style={{ fontSize: 12, color: T.textDim, marginTop: 3 }}>{note}</div>}
    </div>
  );
}

export default memo(ComplianceBar);
