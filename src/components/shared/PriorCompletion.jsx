import { useState } from "react";
import { useApp } from "../../context/AppContext";
import { findStateLicense } from "../../utils/compliance";
import { priorCompletionField } from "../../utils/conditionalCme";
import { TAP_MIN } from "./actionButton";

const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayLabel = iso => new Date(`${iso}T12:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/**
 * A one-time state mandate done before the physician logged CME here (a
 * pain management course years ago): "I already completed this" records
 * their confirmation on the state license, which meets the topic. Undo
 * removes it. The logged hours are never changed.
 */
export default function PriorCompletion({ state, topic }) {
  const { data, editItem, theme: T } = useApp();
  const [asking, setAsking] = useState(false);
  const license = findStateLicense(data.licenses, state);
  if (!license) return null;
  const field = priorCompletionField(topic.topic);
  // Saved on the current licence; Undo clears it from every record in the
  // state, since the engine reads it from all of them (renewals included).
  const save = (value) => {
    if (value) {
      editItem("licenses", { ...license, customFields: { ...(license.customFields || {}), [field]: value } });
    } else {
      for (const l of data.licenses || []) {
        if (l?.state !== state || !l.customFields || !(field in l.customFields)) continue;
        const customFields = { ...l.customFields };
        delete customFields[field];
        editItem("licenses", { ...l, customFields });
      }
    }
    setAsking(false);
  };
  const btn = (primary) => ({
    padding: "3px 10px", minHeight: TAP_MIN, fontSize: 11, fontWeight: 700, borderRadius: 8, border: "none", cursor: "pointer",
    backgroundColor: primary ? T.accent : T.accentGlow, color: primary ? "#fff" : T.accent, marginTop: 2, marginBottom: 4, marginLeft: 2,
  });
  const text = { fontSize: 12, color: T.textMuted, lineHeight: 1.45, margin: "2px 2px 4px" };
  if (topic.priorCompletedOn) {
    return <div style={text} onClick={e => e.stopPropagation()}>
      Completed before you logged CME here (you confirmed on {dayLabel(topic.priorCompletedOn)}). Keep your certificate in case of an audit.{" "}
      <button style={btn(false)} onClick={() => save(null)}>Undo</button>
    </div>;
  }
  if (topic.met) return null;
  if (!asking) return <button style={btn(false)} onClick={e => { e.stopPropagation(); setAsking(true); }}>I already completed this</button>;
  return <div style={text} onClick={e => e.stopPropagation()}>
    Confirm you completed the one-time {topic.required ? `${topic.required}-hour ` : ""}{topic.topic} requirement for {state}.{" "}
    <button style={btn(true)} onClick={() => save(localDay())}>Yes, mark completed</button>
    <button style={btn(false)} onClick={() => setAsking(false)}>Cancel</button>
  </div>;
}
