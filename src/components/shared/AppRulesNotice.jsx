import { useApp } from "../../context/AppContext";
import { appRulesWaitingLine } from "../../utils/appRules.js";
import { TAP_MIN } from "./actionButton";

// While a screen already showing the account waits for the PA and NP rule
// data (AppContext appRulesWaiting: a change that needs it came in after
// launch), what needs the data is off the screen. This line says so, and
// offers to try again when the data could not be loaded (appRulesWaitingLine).
export default function AppRulesNotice() {
  const { appRulesWaiting, retryAppRules, theme: T } = useApp();
  if (!appRulesWaiting || !T) return null;
  const failed = appRulesWaiting.failed === true;
  return (
    <div role="status" style={{
      position: "fixed", left: 12, right: 12, top: "calc(12px + env(safe-area-inset-top, 0px))", zIndex: 9998,
      display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderRadius: 12,
      backgroundColor: T.card, border: `1px solid ${failed ? T.warning || T.border : T.border}`, color: T.text,
      fontSize: 13, lineHeight: 1.45, boxShadow: "0 6px 24px rgba(0,0,0,0.25)",
    }}>
      <span style={{ flex: 1 }}>{appRulesWaitingLine(appRulesWaiting)}</span>
      {failed && (
        <button type="button" onClick={retryAppRules} style={{
          flexShrink: 0, minHeight: TAP_MIN, padding: "7px 14px", borderRadius: 9, border: "none",
          backgroundColor: T.accent, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer",
        }}>Try again</button>
      )}
    </div>
  );
}
