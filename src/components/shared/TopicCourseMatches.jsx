import { useState } from "react";
import { useApp } from "../../context/AppContext";
import { coursesThatMayCount, matchReasonText, topicCountingPool, withTopicAdded } from "../../utils/topicMatch";
import { TAP_MIN } from "./actionButton";
import { formatDate } from "../../utils/helpers";

/**
 * Under an unmet state CME topic: the physician's logged courses in the
 * topic's counting period whose title, notes or session list name it, each
 * with why it matched. "Count this course" adds the topic to that record's
 * topics; Undo puts its topics back exactly as they were. Nothing is tagged
 * without the tap.
 */
export default function TopicCourseMatches({ comp, topic, acceptedCategories }) {
  const { data, editItem, theme: T } = useApp();
  const [counted, setCounted] = useState(null); // { id, title, before }
  const rule = { ...topic, ...(acceptedCategories ? { acceptedCategories } : {}) };
  const matches = topic.met ? [] : coursesThatMayCount(rule, topicCountingPool(comp, topic, data.cme));
  if (!matches.length && !counted) return null;

  const count = (entry) => {
    editItem("cme", withTopicAdded(entry, topic.topic));
    setCounted({ id: entry.id, title: entry.title || "This course", before: entry.topics });
  };
  const undo = () => {
    const current = (data.cme || []).find(c => c.id === counted.id);
    if (current) {
      const restored = { ...current };
      if (counted.before === undefined) delete restored.topics; else restored.topics = counted.before;
      editItem("cme", restored);
    }
    setCounted(null);
  };
  const btn = (primary) => ({
    padding: "3px 10px", minHeight: TAP_MIN, fontSize: 11, fontWeight: 700, borderRadius: 8, border: "none", cursor: "pointer",
    backgroundColor: primary ? T.accent : T.accentGlow, color: primary ? "#fff" : T.accent, marginTop: 2, marginLeft: 2,
  });
  const text = { fontSize: 12, color: T.textMuted, lineHeight: 1.45, margin: "2px 2px 4px" };

  return <div onClick={e => e.stopPropagation()} style={{ margin: "4px 0 6px" }}>
    {counted && <div style={text}>
      Counted {counted.title} toward {topic.topic}.{" "}
      <button type="button" style={btn(false)} onClick={undo}>Undo</button>
    </div>}
    {matches.length > 0 && <>
      <div style={{ ...text, fontWeight: 700, color: T.text }}>Logged courses that may count</div>
      {matches.map(({ entry, reasons }) => <div key={entry.id} style={{ ...text, backgroundColor: T.input, borderRadius: 8, padding: "6px 8px" }}>
        <div style={{ color: T.text }}>{entry.title || "Untitled course"}{entry.hours ? `, ${entry.hours} hrs` : ""}{entry.date ? `, ${formatDate(entry.date)}` : ""}</div>
        <div>Why: {matchReasonText(reasons)}.</div>
        <button type="button" style={btn(true)} onClick={() => count(entry)}>Count this course</button>
      </div>)}
    </>}
  </div>;
}
