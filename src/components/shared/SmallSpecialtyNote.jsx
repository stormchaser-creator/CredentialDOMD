import { memo } from "react";
import { useApp } from "../../context/AppContext";
import { smallSpecialtyNote } from "../../constants/creditEquivalence";

/**
 * The AOA's fewer-than-300-certificate-holders exception, surfaced as a note
 * the physician can act on. NEVER auto-applied: eligibility depends on AOA
 * membership, on board certification, and on the AOA's own qualifying-specialty
 * list, and it has to be requested through the certifying board.
 *
 * Shown only on AOA membership and board-certification cards. It is deliberately
 * absent from state license cards, because it does not reach state licensure:
 * OMBC accepts CME as reported on the certificate, so credit that still reads
 * "AMA" still counts as AOA Category 2 in California no matter what the AOA
 * allowed against its own membership requirement.
 */
function SmallSpecialtyNote({ degreeType }) {
  const { theme: T } = useApp();
  const note = smallSpecialtyNote(degreeType);
  if (!note) return null;

  return (
    <div style={{
      marginTop: 8, padding: "9px 11px", borderRadius: 9,
      backgroundColor: T.accentGlow, fontSize: 12, color: T.textMuted, lineHeight: 1.5,
    }}>
      <div style={{ fontWeight: 800, color: T.accent, marginBottom: 2 }}>{note.title}</div>
      <div>{note.body}</div>
      {note.caveats.map((c, i) => (
        <div key={i} style={{ marginTop: 4 }}>{c}</div>
      ))}
      <div style={{ marginTop: 4, fontWeight: 700, color: T.text }}>
        Not applied automatically. Confirm eligibility with your certifying board before counting on it.
      </div>
      {note.url && (
        <a href={note.url} target="_blank" rel="noreferrer" style={{ color: T.accent, fontWeight: 700, textDecoration: "underline" }}>
          {note.linkLabel}
        </a>
      )}
    </div>
  );
}

export default memo(SmallSpecialtyNote);
