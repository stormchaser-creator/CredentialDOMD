import { useApp } from "../../context/AppContext";
import { professionMismatches, keepAsIsPatch, retypedRecord } from "../../utils/professionReview";
import { DEGREE_LABELS } from "../../constants/professions";

// Records filed under the other profession's types (DESIGN 1.8, 4.2): a PA
// who imported licences or logged CME before choosing PA has them filed as
// a medical license or an MD category. Each one is retyped here with one
// pick, or kept as it is ("Keep as is" is stored on the record so it is not
// asked again). Nothing changes until the member picks.

const SHOWN = 5;
const titleOf = (r) => r.name || r.title || r.type || r.category || "Record";

export default function ProfessionReviewCard() {
  const { data, editItem, theme: T } = useApp();
  const list = professionMismatches(data);
  if (!list.length) return null;
  const deg = data.settings.degreeType;
  const who = DEGREE_LABELS[deg] || deg;
  const retype = (m, value) => {
    if (!value) return;
    editItem(m.section, retypedRecord(m.section, m.record, value));
  };
  const keep = (m) => editItem(m.section, { ...m.record, customFields: keepAsIsPatch(m.record) });
  const control = { display: "block", width: "100%", padding: "9px 10px", marginTop: 6, border: `1px solid ${T.border}`, borderRadius: 7, backgroundColor: T.card, color: T.text, fontSize: 16, boxSizing: "border-box" };
  return (
    <div style={{ textAlign: "left", backgroundColor: T.warningDim, border: `1px solid ${T.warning}`, borderRadius: 14, padding: "12px 14px" }}>
      <div style={{ fontSize: 14, fontWeight: 700, color: T.warning }}>
        {list.length === 1 ? "1 record is" : `${list.length} records are`} filed for another profession
      </div>
      <div style={{ fontSize: 12, color: T.textMuted, marginTop: 3, lineHeight: 1.45 }}>
        Your profile says {who}. Change each one to the type that fits, or keep it as it is.
      </div>
      {list.slice(0, SHOWN).map(m => (
        <div key={`${m.section}:${m.id}`} style={{ marginTop: 10, padding: "10px 12px", backgroundColor: T.card, borderRadius: 10, border: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: T.text }}>{titleOf(m.record)}</div>
          <div style={{ fontSize: 12, color: T.textMuted }}>{m.reason}</div>
          {m.options && (
            <select aria-label={`Change ${titleOf(m.record)} to`} value="" onChange={e => retype(m, e.target.value)} style={control}>
              <option value="">{m.section === "cme" ? "Change category to..." : "Change type to..."}</option>
              {m.options.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          )}
          {!m.options && <div style={{ fontSize: 12, color: T.textMuted, marginTop: 4 }}>Edit it in Education to change its type.</div>}
          <button type="button" onClick={() => keep(m)} style={{ marginTop: 8, minHeight: 36, padding: "6px 12px", borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.text, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Keep as is</button>
        </div>
      ))}
      {list.length > SHOWN && <div style={{ fontSize: 12, color: T.textMuted, marginTop: 8 }}>{list.length - SHOWN} more after these.</div>}
    </div>
  );
}
