// The one-tap profession choice: "Which license do you hold?" MD, DO, PA or
// NP. Home's empty card asks it (GetStartedCard), and so do the CV reader and
// Vera, inline, before they read a CV or answer a member who has not chosen:
// the licence types, rules and boards all follow the profession. The caller
// saves the choice to the profile (updateSettings({ degreeType })) and then
// carries on with what the member started.
import { useEffect, useRef, useState } from "react";
import { afterAppRules, degreeNeedsAppRules, preloadAppRules, APP_RULES_UNAVAILABLE } from "../../utils/appRules.js";

export const PROFESSION_CHOICES = Object.freeze(["MD", "DO", "PA", "NP"]);

// A finger on PA or NP starts loading their rule data (utils/appRules.js), so
// it is usually in by the time the choice is saved.
const warmRules = (d) => { if (degreeNeedsAppRules(d)) preloadAppRules(); };

// Saves her choice, then carries on (next). A refused save (read-only
// membership, membership being re-checked, not connected) says so (refused)
// and goes no further: what follows the choice would run on the blank
// profession, e.g. the Add License form offering the physician list. A PA or
// NP choice is saved once their rule data is in (utils/appRules.js
// afterAppRules; the picker below waits for it first, so this is the
// backstop): saved before, the app had nothing to show her records with.
export function chooseProfessionThen(updateSettings, degreeType, next, refused, unavailable = () => {}) {
  return afterAppRules(degreeType, () => {
    if (updateSettings({ degreeType }) === false) { refused(); return false; }
    next();
    return true;
  }, { unavailable });
}

// A PA or NP tap waits here until their rule data is in, then hands the
// choice on (onChoose): what the caller does next (Vera answering her
// question, the CV reader reading her CV) reads those rules at once, and a
// choice saved before the data was in sent the app back to its loading
// screen, which unmounted the caller (review of e1f4b4c9). The data could
// not be loaded (no connection): she is told, and nothing is chosen.
export default function ProfessionPicker({ id, why, onChoose, onDismiss, dismissLabel = "Not now", theme: T }) {
  const [waiting, setWaiting] = useState(null);
  const [unavailable, setUnavailable] = useState(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const choose = (d) => {
    if (waiting) return;
    setUnavailable(false);
    afterAppRules(d, () => { if (live.current) onChoose(d); }, {
      waiting: (on) => { if (live.current) setWaiting(on ? d : null); },
      unavailable: () => { if (live.current) setUnavailable(true); },
    });
  };
  return (
    <div>
      <div id={id} style={{ fontSize: 14, color: T.textMuted, marginBottom: 14 }}>Which license do you hold? {why}</div>
      <div role="group" aria-labelledby={id} aria-busy={waiting ? true : undefined} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {PROFESSION_CHOICES.map((d) => (
          <button key={d} type="button" disabled={!!waiting} onPointerDown={() => warmRules(d)} onFocus={() => warmRules(d)} onClick={() => { warmRules(d); choose(d); }} style={{
            minHeight: 48, padding: "12px 0", borderRadius: 12,
            border: `2px solid ${T.border}`, backgroundColor: "transparent",
            color: T.text, fontSize: 16, fontWeight: 800, cursor: "pointer",
            opacity: waiting && waiting !== d ? 0.5 : 1,
          }}>{waiting === d ? "Loading..." : d}</button>
        ))}
      </div>
      {unavailable && <div role="alert" style={{ marginTop: 8, fontSize: 13, color: T.textMuted, lineHeight: 1.45 }}>{APP_RULES_UNAVAILABLE}</div>}
      {onDismiss && (
        <button type="button" onClick={onDismiss} style={{
          marginTop: 8, minHeight: 44, width: "100%", border: "none", background: "transparent",
          color: T.textDim || T.textMuted, fontSize: 13, fontWeight: 700, cursor: "pointer",
        }}>{dismissLabel}</button>
      )}
    </div>
  );
}
