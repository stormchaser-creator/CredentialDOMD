import { useState } from "react";
import Field from "./Field";
import { parseTimeText, fmt12 } from "../../utils/timeText";

// ── Fast exact-time entry — type it, no wheels ──
// Accepts "808", "8:08", "8:08p", "808p", or 24-hour "2008". A typed a/p
// suffix wins over the AM/PM chips; hours above 12 are taken as 24-hour.
export default function SmartTimeField({ label, value, onCommit, iS, T }) {
  const [raw, setRaw] = useState(() => (value ? fmt12(value).replace(" ", "") : ""));
  const [ap, setAp] = useState(() => (value ? (parseInt(value, 10) >= 12 ? "p" : "a") : null));
  const parsed = parseTimeText(raw, ap);
  const commit = (nextRaw, nextAp) => onCommit(parseTimeText(nextRaw, nextAp));
  return (
    <Field label={label}>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          value={raw}
          inputMode="numeric"
          placeholder="8:08"
          onChange={(e) => { setRaw(e.target.value); commit(e.target.value, ap); }}
          style={{ ...iS, minWidth: 0, flex: 1 }}
        />
        {["a", "p"].map(mer => (
          <button key={mer} onClick={() => { setAp(mer); commit(raw, mer); }} style={{
            padding: "10px 12px", borderRadius: 10, fontSize: 13, fontWeight: 800, cursor: "pointer",
            border: `1px solid ${ap === mer ? T.accent : T.border}`,
            backgroundColor: ap === mer ? T.accent : "transparent",
            color: ap === mer ? "#fff" : T.textMuted, flexShrink: 0,
          }}>{mer === "a" ? "AM" : "PM"}</button>
        ))}
      </div>
      <div style={{ fontSize: 11, marginTop: 3, fontWeight: 600, color: parsed ? (T.success || T.accent) : raw ? T.warning : T.textDim }}>
        {parsed ? `= ${fmt12(parsed)}` : raw ? "Add AM or PM (or type 8:08p / 20:08)" : "Type it — 808 + AM/PM, 8:08p, or 24-hour 2008"}
      </div>
    </Field>
  );
}

