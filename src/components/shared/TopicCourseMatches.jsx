import { useState } from "react";
import { useApp } from "../../context/AppContext";
import { coursesThatMayCount, matchReasonText, topicCountingPool, withTopicAdded, withTopicRemoved } from "../../utils/topicMatch";
import { sessionCountText } from "../../utils/compliance";
import { TAP_MIN } from "./actionButton";
import { formatDate } from "../../utils/helpers";

/**
 * Under a state CME topic: the physician's logged courses in the topic's
 * counting period whose title, notes or session list name it, each with why
 * it matched. "Count this course" adds the topic to that record's topics;
 * each counted course keeps its own Undo, which takes exactly that topic off
 * the record's current topics (later edits stay). Nothing is tagged without
 * the tap. Where the engine counted a course from its sessions rather than
 * its full credit, the row says so.
 */
export default function TopicCourseMatches({ comp, topic, acceptedCategories }) {
  const { data, editItem, theme: T } = useApp();
  const [counted, setCounted] = useState([]); // [{ id, title }]
  const rule = { ...topic, ...(acceptedCategories ? { acceptedCategories } : {}) };
  const matches = topic.met ? [] : coursesThatMayCount(rule, topicCountingPool(comp, topic, data.cme));
  const fromSessions = Array.isArray(topic.fromSessions) ? topic.fromSessions : [];
  if (!matches.length && !counted.length && !fromSessions.length) return null;

  const count = (entry) => {
    editItem("cme", withTopicAdded(entry, topic.topic));
    setCounted(list => [...list.filter(x => x.id !== entry.id), { id: entry.id, title: entry.title || "This course" }]);
  };
  const undo = (id) => {
    const current = (data.cme || []).find(c => c.id === id);
    if (current) {
      const next = withTopicRemoved(current, topic.topic);
      if (next !== current) editItem("cme", next);
    }
    setCounted(list => list.filter(x => x.id !== id));
  };
  const btn = (primary) => ({
    padding: "3px 10px", minHeight: TAP_MIN, fontSize: 11, fontWeight: 700, borderRadius: 8, border: "none", cursor: "pointer",
    backgroundColor: primary ? T.accent : T.accentGlow, color: primary ? "#fff" : T.accent, marginTop: 2, marginLeft: 2,
  });
  const text = { fontSize: 12, color: T.textMuted, lineHeight: 1.45, margin: "2px 2px 4px" };

  return <div onClick={e => e.stopPropagation()} style={{ margin: "4px 0 6px" }}>
    {fromSessions.map((f, i) => <div key={`s${i}`} style={text}>
      {sessionCountText(f)}{f.courseHours > f.hours ? ` (the course is ${f.courseHours} h; only these sessions count toward ${topic.topic})` : ""}.
    </div>)}
    {counted.map(c => <div key={c.id} style={text}>
      Counted {c.title} toward {topic.topic}.{" "}
      <button type="button" style={btn(false)} onClick={() => undo(c.id)}>Undo</button>
    </div>)}
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
