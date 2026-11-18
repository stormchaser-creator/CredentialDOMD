import { useApp } from "../../context/AppContext";
import { TAP_MIN } from "./actionButton";
import { sessionTopicSuggestions, hoursLabel, cmeSessionsOf } from "../../utils/topicSuggest";

/**
 * "Suggested topics" for a CME record read from a transcript with many
 * sessions: each topic a session title names, with the sessions that
 * triggered it, as a toggle. Nothing is tagged until the physician taps it;
 * a tapped topic goes into the record's topics, and tapping again takes it
 * off. The list of every session read sits underneath.
 *
 * Accepting a topic accepts every session listed under it: the sessions stay
 * in the record's session list with the topic, and the engine
 * (compliance.js sessionTopicHours) counts only those sessions' printed hours
 * toward the topic, not the whole activity's credit.
 *
 * sessions: the normalized list (topicSuggest.js). topics: the form's current
 * topics. onToggle(topic): add or remove one. onAcceptAll(topics): add these.
 */
export default function SessionTopicSuggestions({ sessions, topics, onToggle, onAcceptAll }) {
  const { theme: T, isDesktop } = useApp();
  const list = Array.isArray(sessions) ? sessions : [];
  if (!list.length) return null;
  const suggestions = sessionTopicSuggestions(list);
  const current = Array.isArray(topics) ? topics : [];
  const open = suggestions.filter(s => !current.includes(s.topic)).map(s => s.topic);
  const head = { fontSize: 12, fontWeight: 700, color: T.textDim, textTransform: "uppercase", marginBottom: 4 };
  const small = { fontSize: 12, color: T.textMuted, lineHeight: 1.45 };
  return (
    <div aria-label="Suggested topics" style={{ border: `1px solid ${T.border}`, borderRadius: 12, padding: "10px 12px", marginBottom: 10 }}>
      <div style={head}>Suggested topics</div>
      {suggestions.length ? (
        <>
          <div style={{ ...small, marginBottom: 8 }}>
            Read from {list.length} session{list.length === 1 ? "" : "s"}. Tap a topic to add it. Nothing is added until you do.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {suggestions.map(s => {
              const on = current.includes(s.topic);
              return (
                <div key={s.topic}>
                  <button type="button" aria-pressed={on} onClick={() => onToggle(s.topic)} style={{
                    padding: "6px 12px", fontSize: 13, fontWeight: 700, borderRadius: 18, cursor: "pointer",
                    minHeight: isDesktop ? undefined : TAP_MIN,
                    border: `1px solid ${T.accent}`,
                    backgroundColor: on ? T.accent : "transparent",
                    color: on ? "#fff" : T.accent,
                  }}>{on ? "✓ " : "+ "}{s.topic}{s.hours != null ? `: ${hoursLabel(s.hours)}` : ""}</button>
                  {on && s.hours != null && (
                    <div style={{ ...small, marginTop: 3, marginLeft: 4, color: T.textDim }}>
                      Counts {hoursLabel(s.hours)} toward {s.topic}, from {s.sessions.length === 1 ? "this session" : "these sessions"}, not the activity&rsquo;s full credit.
                    </div>
                  )}
                  {on && s.hours == null && (
                    <div style={{ ...small, marginTop: 3, marginLeft: 4, color: T.textDim }}>
                      The transcript prints no credit for {s.sessions.length === 1 ? "this session" : "these sessions"}, so {s.topic} counts 0 h from it. Log the session&rsquo;s hours as its own entry to count it.
                    </div>
                  )}
                  {s.sessions.map((x, i) => (
                    <div key={i} style={{ ...small, marginTop: 3, marginLeft: 4 }}>
                      {x.hours != null ? `${hoursLabel(x.hours)} from ` : "From "}&ldquo;{x.title}&rdquo;
                      {x.reason ? <span style={{ color: T.textDim }}>{` (${x.reason})`}</span> : null}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          {onAcceptAll && open.length > 1 && (
            <button type="button" onClick={() => onAcceptAll(open)} style={{
              marginTop: 8, padding: "6px 12px", fontSize: 12, fontWeight: 700, borderRadius: 10, cursor: "pointer",
              minHeight: isDesktop ? undefined : TAP_MIN, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.accent,
            }}>Add all {open.length}</button>
          )}
        </>
      ) : (
        <div style={small}>Read {list.length} session{list.length === 1 ? "" : "s"}. None of their titles names a tracked topic.</div>
      )}
      <details style={{ marginTop: 8 }}>
        <summary style={{ ...small, cursor: "pointer", fontWeight: 600, padding: "7px 0", minHeight: isDesktop ? undefined : TAP_MIN }}>All {list.length} session{list.length === 1 ? "" : "s"}</summary>
        <ol style={{ ...small, margin: "6px 0 0", paddingLeft: 20 }}>
          {list.map((x, i) => (
            <li key={i}>{x.title}{x.hours != null ? ` (${hoursLabel(x.hours)})` : ""}</li>
          ))}
        </ol>
      </details>
    </div>
  );
}

/**
 * On a saved CME card: the topics its sessions name that are not on it yet
 * (a transcript emailed to docs@ is filed without review). Tapping opens the
 * entry, where SessionTopicSuggestions offers each one.
 */
export function PendingSessionTopics({ record, topics, onReview }) {
  const { theme: T, isDesktop } = useApp();
  const current = Array.isArray(topics) ? topics : [];
  const open = sessionTopicSuggestions(cmeSessionsOf(record)).filter(s => !current.includes(s.topic));
  if (!open.length) return null;
  return (
    <button type="button" onClick={onReview} style={{
      display: "block", marginTop: 6, padding: "7px 0", minHeight: isDesktop ? undefined : TAP_MIN, border: "none", background: "none",
      color: T.accent, fontSize: 12, fontWeight: 700, cursor: "pointer", textAlign: "left",
    }}>
      {open.length} suggested topic{open.length === 1 ? "" : "s"} from its sessions: {open.map(s => s.topic).join(", ")}. Review
    </button>
  );
}
