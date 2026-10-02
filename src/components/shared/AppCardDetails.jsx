import { useApp } from "../../context/AppContext";
import { QUESTION_FIELDS, renewalAnswerPatch } from "../../constants/recordQuestions";
import { inlineLinkTap } from "./actionButton";
import { unverifiedLines } from "../../utils/recordAnswers";

// What a PA or NP state card shows beyond the hour bar (DESIGN 3.1, 4.2):
// the items not yet verified, the minimum by category, pharmacology hours,
// the credential checks (current certification, practice hours) with the
// practice hours question, and a board's CE options with the confirmation
// for this renewal. Physician cards carry no `profession` and render nothing.

const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

export default function AppCardDetails({ comp, lic }) {
  const { editItem, theme: T } = useApp();
  if (!comp?.profession) return null;
  const unit = comp.unit || "hours";
  const unverified = comp.rulesVerified ? unverifiedLines(comp) : [];
  const checks = comp.credentialChecks || [];
  const pharm = comp.pharmacology?.required ? comp.pharmacology : null;
  const options = comp.options;
  const exemption = comp.exemption;
  const expiration = lic?.expirationDate || "";
  if (!unverified.length && !checks.length && !pharm && !options && !exemption && !(comp.cat1Required > 0 && comp.cat1Note)) return null;

  const box = { marginTop: 8, padding: "10px 12px", backgroundColor: T.input, border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 12.5, color: T.textMuted, lineHeight: 1.5 };
  const control = { display: "block", width: "100%", padding: "9px 10px", marginTop: 6, border: `1px solid ${T.border}`, borderRadius: 7, backgroundColor: T.card, color: T.text, fontSize: 16, boxSizing: "border-box" };
  const mark = (met) => (met === true ? "✓" : met === false ? "Needed:" : "To confirm:");
  const answerPracticeHours = (value) => lic && editItem("licenses", { ...lic, customFields: renewalAnswerPatch(lic, QUESTION_FIELDS.practiceHours, value, expiration) });
  const answerExemption = (value) => lic && exemption && editItem("licenses", { ...lic, customFields: exemption.perRenewal === false
    ? { ...(lic.customFields || {}), [exemption.field]: value }
    : renewalAnswerPatch(lic, exemption.field, value, expiration) });
  const confirmOption = (on) => {
    if (!lic) return;
    const customFields = { ...(lic.customFields || {}) };
    if (on) customFields[QUESTION_FIELDS.ceOption] = expiration; else delete customFields[QUESTION_FIELDS.ceOption];
    editItem("licenses", { ...lic, customFields });
  };

  return (
    <div onClick={e => e.stopPropagation()} style={{ marginBottom: 8 }}>
      {comp.cat1Required > 0 && comp.cat1Note && (
        <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 4 }}>
          At least {fmt(comp.cat1Required)} {unit}: {comp.cat1Note}. Recorded {fmt(comp.cat1Earned)}.
        </div>
      )}
      {pharm && (
        <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 4 }}>
          Pharmacology: {fmt(pharm.earned || 0)}/{fmt(pharm.required)} {unit} recorded
          <div style={{ height: 4, backgroundColor: T.input, borderRadius: 2, overflow: "hidden", marginTop: 4 }}>
            <div style={{ height: "100%", width: `${Math.min(100, ((pharm.earned || 0) / pharm.required) * 100)}%`, backgroundColor: (pharm.earned || 0) >= pharm.required ? T.success : T.accent }} />
          </div>
        </div>
      )}
      {checks.map(c => (
        <div key={c.id} style={box}>
          <div style={{ color: c.met === false ? T.warning : T.text, fontWeight: 600 }}>{mark(c.met)} {c.label}</div>
          {c.id === "practiceHours" && (lic && expiration
            ? <label style={{ display: "block", marginTop: 4 }}>
                Have you met this for the renewal due {expiration}?
                <select aria-label={`Practice hours for the renewal due ${expiration}`} value={comp.practiceHours?.answer || ""} onChange={e => answerPracticeHours(e.target.value)} style={control}>
                  <option value="">Not answered yet</option>
                  <option value="Yes">Yes</option>
                  <option value="No">No</option>
                </select>
              </label>
            : <div style={{ marginTop: 4 }}>Add this license with its expiration date to answer.</div>)}
          {c.url && <a href={c.url} target="_blank" rel="noopener noreferrer" style={{ color: T.accent, ...inlineLinkTap }}>{c.cite || "Source"}</a>}
        </div>
      ))}
      {exemption && (
        <div style={box}>
          <div style={{ color: T.text, fontWeight: 600 }}>{exemption.applies ? "✓ No hours due this renewal" : exemption.text}</div>
          {lic && expiration
            ? <label style={{ display: "block", marginTop: 4 }}>
                {exemption.question}
                <select aria-label={exemption.question} value={exemption.answer || ""} onChange={e => answerExemption(e.target.value)} style={control}>
                  <option value="">Not answered yet</option>
                  <option value="Yes">Yes</option>
                  <option value="No">No</option>
                </select>
              </label>
            : <div style={{ marginTop: 4 }}>Add this license with its expiration date to answer.</div>}
          {exemption.url && <a href={exemption.url} target="_blank" rel="noopener noreferrer" style={{ color: T.accent, ...inlineLinkTap }}>{exemption.cite || "Source"}</a>}
        </div>
      )}
      {options && (
        <div style={box}>
          <div style={{ color: T.text, fontWeight: 600, marginBottom: 2 }}>The board accepts any one of these each renewal:</div>
          <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
            {options.list.map((o, i) => (
              <li key={i}>{o.text}{o.url ? <> (<a href={o.url} target="_blank" rel="noopener noreferrer" style={{ color: T.accent, ...inlineLinkTap }}>{o.cite || "source"}</a>)</> : null}</li>
            ))}
          </ul>
          {lic && expiration
            ? <label style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 36, color: T.text }}>
                <input type="checkbox" checked={!!options.confirmed} onChange={e => confirmOption(e.target.checked)} style={{ width: 20, height: 20 }} />
                I met one of these for the renewal due {expiration}
              </label>
            : <div>Add this license with its expiration date to confirm an option.</div>}
        </div>
      )}
      {unverified.length > 0 && (
        <div style={{ fontSize: 12, color: T.textDim, marginTop: 6, lineHeight: 1.45 }}>
          Not yet verified: {unverified.join("; ")}.
        </div>
      )}
    </div>
  );
}
