import { memo } from "react";
import { useApp } from "../../context/AppContext";
import { formatDate } from "../../utils/helpers";
import { followUpsFor } from "../../utils/followUps";

/**
 * The follow-up history block every record screen shows: CrudSection, and the
 * sections with their own screens (Health Records, CME). An alert's "Follow
 * up" says the same history shows on the record; for a health record it
 * never did. Renders nothing when there are no entries.
 */
function FollowUpHistory({ item }) {
  const { data, theme: T } = useApp();
  const history = followUpsFor(data.followUps, item);
  if (!history.length) return null;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
        Follow-up history
      </div>
      {history.map(f => (
        <div key={f.id} style={{ padding: "8px 10px", borderRadius: 8, border: `1px dashed ${T.border}`, marginBottom: 6 }}>
          <div style={{ fontSize: 12.5, color: T.text, fontWeight: 600 }}>
            {f.emailed ? "Emailed" : "Note"}{f.recipient ? ` · ${f.recipient}` : ""} · {formatDate(f.createdAt)}
          </div>
          {f.note && <div style={{ fontSize: 12, color: T.textDim, marginTop: 2 }}>{f.note}</div>}
        </div>
      ))}
    </div>
  );
}

export default memo(FollowUpHistory);
