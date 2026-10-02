import { useApp } from "../../context/AppContext";
import { recordQuestionsFor } from "../../constants/recordQuestions";
import { licenseKindOf } from "../../constants/professions";
import { questionValue, withAnswer, agreementShownFor } from "../../utils/recordAnswers";
import { inlineLinkTap } from "./actionButton";

// The questions a record asks a PA or NP (DESIGN 3.8), and the state's
// verified practice agreement text beside a practice licence or a practice
// agreement record (4.4, decision 14). Answers go to the record's
// customFields through editItem, the ConditionalCmeTopics mechanism. MD and
// DO records ask nothing and show nothing here.

const NOT_ANSWERED = "Not answered yet";

export default function RecordQuestions({ item }) {
  const { data, editItem, theme: T } = useApp();
  const deg = data?.settings?.degreeType || "";
  if (!item) return null;
  const kind = licenseKindOf(item.type);
  const agreement = agreementShownFor(item, deg);
  const questions = recordQuestionsFor(item, {
    degreeType: deg, licenses: data?.licenses || [],
    stateAgreement: agreement && (kind === "pa" || kind === "aprn") ? agreement : null,
  });
  // The agreement text sits on the agreement record always, and on a practice
  // licence only beside its question (a conditional agreement).
  const showAgreement = !!agreement && (kind === "agreement" || agreement.conditional);
  if (!questions.length && !showAgreement) return null;

  const save = (q, value) => editItem("licenses", withAnswer(item, q, value));
  const box = { marginTop: 8, padding: "10px 12px", backgroundColor: T.input, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 12.5, color: T.textMuted, lineHeight: 1.5 };
  const control = { display: "block", width: "100%", padding: "9px 10px", marginTop: 6, border: `1px solid ${T.border}`, borderRadius: 7, backgroundColor: T.card, color: T.text, fontSize: 16, boxSizing: "border-box" };

  return (
    <div onClick={e => e.stopPropagation()}>
      {showAgreement && (
        <div style={box}>
          <div style={{ color: T.text, fontWeight: 700, marginBottom: 2 }}>{agreement.stateName}: {agreement.kind}</div>
          <p style={{ margin: "2px 0 4px" }}>{agreement.text}</p>
          {agreement.cites.map((c, i) => (
            <a key={`${c.url}:${i}`} href={c.url} target="_blank" rel="noopener noreferrer" style={{ color: T.accent, marginRight: 10, ...inlineLinkTap }}>{c.cite || "Source"}</a>
          ))}
        </div>
      )}
      {questions.map(q => {
        const value = questionValue(item, q);
        const label = <span style={{ color: T.text, fontWeight: 600 }}>{q.question}</span>;
        if (q.type === "choice" || q.type === "yesno") {
          const choices = q.type === "yesno" ? ["Yes", "No"] : q.choices;
          return (
            <label key={q.field} style={{ ...box, display: "block" }}>
              {label}
              <select aria-label={q.question} value={value} onChange={e => save(q, e.target.value)} style={control}>
                <option value="">{NOT_ANSWERED}</option>
                {choices.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              {q.perRenewal && <span style={{ display: "block", marginTop: 4, fontSize: 11.5 }}>Asked again at each renewal.</span>}
            </label>
          );
        }
        // Number and date answers save when the field is left; the key
        // refreshes the field when the stored answer changes elsewhere.
        return (
          <label key={`${q.field}:${value}`} style={{ ...box, display: "block" }}>
            {label}
            <input aria-label={q.question} type={q.type === "date" ? "date" : "number"} inputMode={q.type === "number" ? "decimal" : undefined}
              defaultValue={value} onBlur={e => { if (e.target.value !== value) save(q, e.target.value); }} style={control} />
          </label>
        );
      })}
    </div>
  );
}
