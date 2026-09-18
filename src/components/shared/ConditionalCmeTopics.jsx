import { useApp } from "../../context/AppContext";
import { findStateLicense } from "../../utils/compliance";

export default function ConditionalCmeTopics({ comp }) {
  const { data, editItem, theme: T } = useApp();
  if (!comp?.conditionalTopics?.length) return null;
  const license = findStateLicense(data.licenses, comp.state);
  return <div onClick={e => e.stopPropagation()} style={{ margin: "10px 0" }}>
    {comp.conditionalTopics.map(topic => {
      const value = topic.applicability === "applies" ? "Yes" : topic.applicability === "not-applicable" ? "No" : "";
      return <div key={topic.condition.field} style={{ backgroundColor: T.input, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 12px", fontSize: 12.5, color: T.textMuted, lineHeight: 1.5 }}>
        <div style={{ color: T.text, fontWeight: 700, marginBottom: 4 }}>{topic.topic}: {value === "Yes" ? "applies per your selection" : value === "No" ? "does not apply per your selection" : "confirm applicability"}</div>
        <p style={{ margin: "4px 0 8px" }}>{topic.condition.description}</p>
        {license ? <label style={{ display: "block", color: T.text }}>
          {topic.condition.question}
          <select aria-label={topic.condition.question} value={value} onChange={e => {
            const customFields = { ...(license.customFields || {}), [topic.condition.field]: e.target.value };
            editItem("licenses", { ...license, customFields });
          }} style={{ display: "block", width: "100%", padding: "9px 10px", marginTop: 6, border: `1px solid ${T.border}`, borderRadius: 7, backgroundColor: T.card, color: T.text, fontSize: 14 }}>
            <option value="">Not sure / not answered</option>
            <option value="Yes">Yes — this rule applies to me</option>
            <option value="No">No — this rule does not apply to me</option>
          </select>
        </label> : <p>Add your {comp.state} medical license with its expiration date to record your answer.</p>}
        {topic.applicability === "unknown" && <p style={{ margin: "8px 0 0" }}>The conditional {topic.required}-hour rule is awaiting confirmation. It is not counted as missing hours or assumed exempt.</p>}
        <p style={{ margin: "8px 0 0" }}><a href={topic.url} target="_blank" rel="noopener noreferrer" style={{ color: T.accent }}>{topic.cite}</a> · Checked {topic.checkedOn}</p>
      </div>;
    })}
  </div>;
}
