import { memo, useState } from "react";
import { useApp } from "../../context/AppContext";
import { renewalView } from "../../utils/renewalRoute";

/**
 * The door out of a warning, kept to one line on every licence card:
 * "How to renew", the short cycle, and the portal button only when the
 * licence is urgent. Tapping the line opens the board's portal and the state
 * guide, the full cycle, the due date and the stored fee, which is labelled
 * with when it was last researched because it is not live data.
 *
 * The board and portal follow the physician's degree (src/utils/renewalRoute.js),
 * the same selection Vera uses, so a DO is never sent to an MD-only page.
 */
function RenewalInfo({ item, defaultExpanded = false, alertable = true }) {
  const { theme: T, data } = useApp();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const view = renewalView(item, data?.settings?.degreeType, { alertable });
  if (!view) return null;

  const stop = (e) => e.stopPropagation();
  const linkStyle = (primary) => ({
    padding: "8px 12px", borderRadius: 9, textDecoration: "none", fontSize: 12.5,
    ...(primary
      ? { backgroundColor: T.accent, color: "#fff", fontWeight: 800 }
      : { border: `1px solid ${T.border}`, color: T.accent, fontWeight: 700 }),
  });
  const note = { fontSize: 12, color: T.textMuted, marginTop: 6, lineHeight: 1.45 };

  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={(e) => { stop(e); setExpanded(x => !x); }}
          style={{
            flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6,
            padding: "4px 0", border: "none", background: "none", cursor: "pointer",
            textAlign: "left", fontFamily: "inherit", fontSize: 12.5,
            color: view.urgent ? (T.warning || "#f59e0b") : T.textMuted,
          }}
        >
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            <span style={{ fontWeight: 700 }}>How to renew</span>
            {view.cycleShort ? ` \u{B7} ${view.cycleShort}` : ""}
          </span>
          <span aria-hidden="true" style={{
            color: T.accent, fontWeight: 800, flexShrink: 0, display: "inline-block",
            transform: expanded ? "rotate(90deg)" : "none", transition: "transform 0.15s",
          }}>{"\u{203A}"}</span>
        </button>
        {view.showPortalOnLine && !expanded && (
          <a href={view.portal} target="_blank" rel="noopener noreferrer" onClick={stop} style={{
            ...linkStyle(true), padding: "5px 10px", flexShrink: 0, whiteSpace: "nowrap",
          }}>Renew online</a>
        )}
      </div>
      {expanded && (
        <div style={{
          marginTop: 4, padding: "10px 12px", borderRadius: 10,
          backgroundColor: T.input, border: `1px solid ${T.border}`,
        }}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {view.portal && (
              <a href={view.portal} target="_blank" rel="noopener noreferrer" onClick={stop} style={linkStyle(true)}>{view.portalLabel}</a>
            )}
            {view.alternativeBoard && (
              <a href={view.alternativeBoard.url} target="_blank" rel="noopener noreferrer" onClick={stop} style={linkStyle(false)}>Osteopathic board</a>
            )}
            {view.guide && (
              <a href={view.guide} target="_blank" rel="noopener noreferrer" onClick={stop} style={linkStyle(false)}>Steps, fees and pitfalls</a>
            )}
          </div>
          {view.unknownDORoute && (
            <div style={note}>The osteopathic renewal route for this state is not on file. The state guide has the steps.</div>
          )}
          {view.board && view.portalLabel === "Renew online" && <div style={note}>Board: {view.board}</div>}
          {view.alternativeBoard && (
            <div style={note}>A DO licence here renews through {view.alternativeBoard.name}. Set MD or DO in Profile and this box shows only yours.</div>
          )}
          {view.cycleFull && <div style={note}>Cycle: {view.cycleFull}</div>}
          {view.due && <div style={note}>Due: {view.due}</div>}
          {view.fee && <div style={note}>Fee, {view.feeCaption}: {view.fee}</div>}
        </div>
      )}
    </div>
  );
}

export default memo(RenewalInfo);
