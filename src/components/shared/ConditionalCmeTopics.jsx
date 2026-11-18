import { useApp } from "../../context/AppContext";
import { findStateLicense } from "../../utils/compliance";
import { inlineLinkTap } from "./actionButton";
import { specialtyPrefill, specialtyNames, conditionDescription, NOT_SURE } from "../../utils/conditionalCme";

// A PA or NP card answers on its own licence (pa, rn or aprn), and one
// question asked by several topics (Florida's "Do you hold prescriptive
// authority?") is shown once. Physician cards are unchanged.
//
// A physician question that their board specialties settle as No (the
// California geriatric rule for a neurosurgeon) starts on "No (from your
// specialty: ...)". It stays editable: Yes, No and "Not sure" are stored on
// the license and always win over the prefill.
const LICENSE_NOUN = { pa: "physician assistant license", rn: "RN license", aprn: "APRN license" };

export default function ConditionalCmeTopics({ comp }) {
  const { data, editItem, theme: T } = useApp();
  if (!comp?.conditionalTopics?.length && !comp?.informationalTopics?.length) return null;
  const appKind = comp.profession && LICENSE_NOUN[comp.kind] ? comp.kind : null;
  const license = appKind ? findStateLicense(data.licenses, comp.state, appKind) : findStateLicense(data.licenses, comp.state);
  const seen = new Set();
  const topics = appKind
    ? (comp.conditionalTopics || []).filter(t => t?.condition?.field && !seen.has(t.condition.field) && seen.add(t.condition.field))
    : (comp.conditionalTopics || []);
  return <div onClick={e => e.stopPropagation()} style={{ margin: "10px 0" }}>
    {topics.map(topic => {
      const prefill = appKind ? null : specialtyPrefill(topic.condition, data.settings?.specialties);
      const from = prefill ? `from your specialty: ${specialtyNames(prefill)}` : "";
      const stored = license?.customFields?.[topic.condition.field];
      const value = prefill
        ? (stored === true || stored === "Yes" ? "Yes" : stored === false || stored === "No" ? "No" : stored === NOT_SURE ? NOT_SURE : "")
        : topic.applicability === "applies" ? "Yes" : topic.applicability === "not-applicable" ? "No" : "";
      const prefilled = topic.applicabilitySource === "specialty";
      return <div key={topic.condition.field} style={{ backgroundColor: T.input, border: `1px solid ${T.border}`, borderRadius: 8, padding: "10px 12px", fontSize: 12.5, color: T.textMuted, lineHeight: 1.5 }}>
        <div style={{ color: T.text, fontWeight: 700, marginBottom: 4 }}>{topic.topic}: {prefilled ? `does not apply (${from})` : value === "Yes" ? "applies per your selection" : value === "No" ? "does not apply per your selection" : "confirm applicability"}</div>
        <p style={{ margin: "4px 0 8px" }}>{conditionDescription(topic)}</p>
        {prefilled && <p style={{ margin: "4px 0 8px" }}>Answered No {from}. The rule covers only general internists and family physicians. Change it below if that is wrong.</p>}
        {license ? <label style={{ display: "block", color: T.text }}>
          {topic.condition.question}
          <select aria-label={topic.condition.question} value={value} onChange={e => {
            const customFields = { ...(license.customFields || {}), [topic.condition.field]: e.target.value };
            editItem("licenses", { ...license, customFields });
          }} style={{ display: "block", width: "100%", padding: "9px 10px", marginTop: 6, border: `1px solid ${T.border}`, borderRadius: 7, backgroundColor: T.card, color: T.text, fontSize: 14 }}>
            {prefill ? <>
              <option value="">No ({from})</option>
              <option value={NOT_SURE}>Not sure</option>
            </> : <option value="">Not sure / not answered</option>}
            <option value="Yes">Yes, this rule applies to me</option>
            <option value="No">No, this rule does not apply to me</option>
          </select>
        </label> : <p>Add your {comp.state} {appKind ? LICENSE_NOUN[appKind] : "medical license"} with its expiration date to record your answer.</p>}
        {topic.applicability === "unknown" && (appKind
          ? <p style={{ margin: "8px 0 0" }}>This rule is awaiting your answer. It is not counted as missing hours or assumed exempt.</p>
          : <p style={{ margin: "8px 0 0" }}>The conditional {topic.required}-hour rule is awaiting confirmation. It is not counted as missing hours or assumed exempt.</p>)}
        <p style={{ margin: "8px 0 0" }}><a href={topic.url} target="_blank" rel="noopener noreferrer" style={{ color: T.accent, ...inlineLinkTap }}>{topic.cite}</a>{appKind && !topic.checkedOn ? null : <> · Checked {topic.checkedOn}</>}</p>
      </div>;
    })}
    {(comp.informationalTopics || []).map(topic => <details key={topic.topic} style={{ marginTop: 8, padding: "8px 10px", backgroundColor: T.input, borderRadius: 8, fontSize: 12, color: T.textMuted, lineHeight: 1.5 }}>
      <summary style={{ cursor: "pointer", position: "relative", padding: "8px 0", margin: "-8px 0" }}>{topic.topic}: provider / course guidance</summary>
      <p>{topic.note}</p>
      <a href={topic.url} target="_blank" rel="noopener noreferrer" style={{ color: T.accent, ...inlineLinkTap }}>{topic.cite}</a>
    </details>)}
  </div>;
}
