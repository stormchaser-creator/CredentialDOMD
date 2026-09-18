import { useState } from "react";
import { buildReferenceDraft } from "../../utils/referenceDraft.js";
import { copyToClipboard, mailtoHref } from "../../utils/helpers.js";

export default function ReferenceDraftCard({ action, references, theme: T, onChange, onDismiss }) {
  const [notice, setNotice] = useState("");
  const draft = buildReferenceDraft(references, action);
  const selectedIds = new Set(draft.referenceIds);
  const toggle = id => {
    const selected = new Set(draft.referenceIds);
    const excluded = new Set(draft.excludedReferenceIds);
    if (selected.has(id)) { selected.delete(id); excluded.add(id); }
    else { selected.add(id); excluded.delete(id); }
    onChange({ referenceIds: [...selected], excludedReferenceIds: [...excluded] });
    setNotice("");
  };
  const button = { padding: "9px 12px", borderRadius: 9, border: `1px solid ${T.border}`, background: T.card, color: T.text, fontSize: 13, cursor: "pointer" };
  const blocked = !draft.selected.length || draft.unavailableIds.length > 0;
  return <section aria-label="Reference draft" style={{ marginTop: 6, padding: 12, borderRadius: 12, border: `1px solid ${T.accent}`, background: T.card, color: T.text }}>
    <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>Reference draft · {draft.selected.length} selected</h3>
    <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
      <legend style={{ fontSize: 12, color: T.textMuted, marginBottom: 6 }}>Choose who to include</legend>
      {(references || []).map(ref => <label key={ref.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", fontSize: 13 }}>
        <input type="checkbox" checked={selectedIds.has(ref.id)} onChange={() => toggle(ref.id)} />
        {ref.name || "Unnamed reference"}
      </label>)}
    </fieldset>
    {draft.unavailableIds.length > 0 && <p role="alert" style={{ color: T.danger, fontSize: 13 }}>Some selected records are no longer available. Ask Vera to prepare a fresh draft before sharing.</p>}
    {draft.missingContacts.length > 0 && <p style={{ color: T.textMuted, fontSize: 12 }}>
      Saved email or phone is incomplete for: {draft.missingContacts.map(ref => ref.name || "Unnamed reference").join(", ")}. Only saved details appear below.
    </p>}
    {draft.text ? <pre aria-label="Draft text" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "inherit", fontSize: 13, lineHeight: 1.6 }}>{draft.text}</pre>
      : <p style={{ fontSize: 13 }}>Select at least one reference to prepare a draft.</p>}
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <button disabled={blocked} style={button} onClick={async () => {
        try { const copied = await copyToClipboard(draft.text); setNotice(copied ? "Copied." : "Copy failed. Select and copy the draft text above."); }
        catch { setNotice("Copy failed. Select and copy the draft text above."); }
      }}>Copy draft</button>
      {!blocked && <a style={{ ...button, textDecoration: "none" }} href={mailtoHref("", "Professional references", draft.text)}>Open in email</a>}
      <button style={button} onClick={onDismiss}>Dismiss</button>
    </div>
    <p style={{ fontSize: 12, color: T.textMuted, margin: "8px 0 0" }}>Review the details, then send from your email app. Nothing has been sent.</p>
    <div role="status" style={{ fontSize: 12, marginTop: 4 }}>{notice}</div>
  </section>;
}
