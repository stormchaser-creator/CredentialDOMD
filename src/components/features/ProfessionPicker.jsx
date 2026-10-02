// The one-tap profession choice: "Which license do you hold?" MD, DO, PA or
// NP. Home's empty card asks it (GetStartedCard), and so do the CV reader and
// Vera, inline, before they read a CV or answer a member who has not chosen:
// the licence types, rules and boards all follow the profession. The caller
// saves the choice to the profile (updateSettings({ degreeType })) and then
// carries on with what the member started.
export const PROFESSION_CHOICES = Object.freeze(["MD", "DO", "PA", "NP"]);

// Saves her choice, then carries on (next). A refused save (read-only
// membership, membership being re-checked, not connected) says so (refused)
// and goes no further: what follows the choice would run on the blank
// profession, e.g. the Add License form offering the physician list.
export function chooseProfessionThen(updateSettings, degreeType, next, refused) {
  if (updateSettings({ degreeType }) === false) { refused(); return false; }
  next();
  return true;
}

export default function ProfessionPicker({ id, why, onChoose, onDismiss, dismissLabel = "Not now", theme: T }) {
  return (
    <div>
      <div id={id} style={{ fontSize: 14, color: T.textMuted, marginBottom: 14 }}>Which license do you hold? {why}</div>
      <div role="group" aria-labelledby={id} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        {PROFESSION_CHOICES.map((d) => (
          <button key={d} type="button" onClick={() => onChoose(d)} style={{
            minHeight: 48, padding: "12px 0", borderRadius: 12,
            border: `2px solid ${T.border}`, backgroundColor: "transparent",
            color: T.text, fontSize: 16, fontWeight: 800, cursor: "pointer",
          }}>{d}</button>
        ))}
      </div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} style={{
          marginTop: 8, minHeight: 44, width: "100%", border: "none", background: "transparent",
          color: T.textDim || T.textMuted, fontSize: 13, fontWeight: 700, cursor: "pointer",
        }}>{dismissLabel}</button>
      )}
    </div>
  );
}
