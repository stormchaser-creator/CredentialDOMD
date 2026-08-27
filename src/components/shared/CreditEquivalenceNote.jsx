import { memo } from "react";
import { useApp } from "../../context/AppContext";
import { logNoteFor } from "../../constants/creditEquivalence";

/**
 * What the selected credit category actually counts as, shown at the moment of
 * logging rather than discovered at renewal.
 *
 * The case this exists for: a DO logs OpenEvidence CME, which is accredited
 * through AKH Inc. (ACCME) and awards AMA PRA Category 1. Nothing in the app
 * told him that for a DO this is AOA Category 2 and can never satisfy
 * California's 20-hour AOA Category 1-A/1-B minimum. Every claim rendered here
 * is data from src/constants/creditEquivalence.js.
 *
 * Renders nothing for MDs, and nothing for categories where the AOA publishes
 * no equivalence, rather than guessing one.
 */
function CreditEquivalenceNote({ category, degreeType }) {
  const { theme: T } = useApp();
  const note = logNoteFor(category, degreeType);
  if (!note) return null;

  const warn = note.tone === "warn";
  const edge = warn ? T.warning : T.accent;

  return (
    <div style={{
      marginTop: -8, marginBottom: 14, padding: "10px 12px", borderRadius: 10,
      border: `1px solid ${edge}`,
      backgroundColor: warn ? T.warningDim : T.accentGlow,
    }}>
      <div style={{ fontSize: 13.5, fontWeight: 800, color: edge }}>{note.headline}</div>
      {note.detail && (
        <div style={{ fontSize: 12.5, fontWeight: 700, color: T.text, marginTop: 3, lineHeight: 1.45 }}>
          {note.detail}
        </div>
      )}
      {note.lines.map((line, i) => (
        <div key={i} style={{ fontSize: 12, color: T.textMuted, marginTop: 5, lineHeight: 1.5 }}>{line}</div>
      ))}
    </div>
  );
}

export default memo(CreditEquivalenceNote);
