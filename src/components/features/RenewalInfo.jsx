import { memo } from "react";
import { useApp } from "../../context/AppContext";
import { RENEWAL_INFO } from "../../constants/renewalInfo";
import { getStatusColor } from "../../utils/helpers";

/**
 * The door out of a warning. A license that is due (or will be) shows how to
 * actually renew it: the board's own portal, the fee and cycle when we have
 * verified them, and our state guide for the full steps. Facts come from the
 * researched dataset behind /states/<slug>; anything unverified is simply
 * not shown rather than guessed.
 */
function RenewalInfo({ item }) {
  const { theme: T } = useApp();
  const st = item?.state;
  const info = st ? RENEWAL_INFO[st] : null;
  if (!info || !/license|dea/i.test(item?.type || "")) return null;

  const isDea = /dea/i.test(item.type || "");
  const color = getStatusColor(item.expirationDate);
  const urgent = color === "red" || color === "orange" || color === "amber";
  const portal = isDea ? "https://www.deadiversion.usdoj.gov/online_forms_apps.html" : info.portalUrl;
  const label = isDea ? "DEA Diversion Control portal" : (info.board || "State board");
  const facts = isDea ? ["3-year cycle", "$888 fee"] : [info.cycle, info.due && `due ${info.due}`, info.fee].filter(Boolean);

  return (
    <div style={{
      marginTop: 8, padding: "10px 12px", borderRadius: 10,
      backgroundColor: urgent ? (T.warningDim || "rgba(245,158,11,0.10)") : T.input,
      border: `1px solid ${urgent ? (T.warning || "#f59e0b") : T.border}`,
    }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }}>
        How to renew
      </div>
      {facts.length > 0 && (
        <div style={{ fontSize: 12.5, color: T.textMuted, marginBottom: 8 }}>{facts.join(" · ")}</div>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {portal && (
          <a href={portal} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{
            padding: "8px 12px", borderRadius: 9, textDecoration: "none",
            backgroundColor: T.accent, color: "#fff", fontSize: 12.5, fontWeight: 800,
          }}>Renew at {label}</a>
        )}
        {!isDea && (
          <a href={info.guideUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{
            padding: "8px 12px", borderRadius: 9, textDecoration: "none",
            border: `1px solid ${T.border}`, color: T.accent, fontSize: 12.5, fontWeight: 700,
          }}>Steps, fees and pitfalls</a>
        )}
      </div>
    </div>
  );
}

export default memo(RenewalInfo);
