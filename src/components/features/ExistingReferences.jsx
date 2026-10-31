import { useApp } from "../../context/AppContext";
import { formatDate } from "../../utils/helpers";
import { existingReferenceLines } from "../../utils/peerReferenceList";

// Top of the Peer References Add form: who is already on the list, so a
// member does not have to remember it (ticket 0b15a181).
export default function ExistingReferences({ items }) {
  const { theme: T } = useApp();
  const lines = existingReferenceLines(items);
  if (!lines.length) return null;
  return (
    <div style={{ marginBottom: 14, padding: "10px 12px", borderRadius: 10, border: `1px solid ${T.border}`, backgroundColor: T.input }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: T.textMuted, marginBottom: 6 }}>
        Your references ({lines.length})
      </div>
      <div style={{ maxHeight: 160, overflowY: "auto" }}>
        {lines.map(l => (
          <div key={l.id || l.name} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13, lineHeight: 1.6 }}>
            <span style={{ color: T.text, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {l.name}{l.credential ? `, ${l.credential}` : ""}
            </span>
            {l.added && <span style={{ color: T.textDim, flexShrink: 0 }}>{formatDate(l.added)}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
