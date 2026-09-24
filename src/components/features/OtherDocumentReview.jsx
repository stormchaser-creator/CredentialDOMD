import { memo, useMemo, useState } from "react";
import { useApp } from "../../context/AppContext";
import { useInputStyle } from "../shared/useInputStyle";
import { liveCategories, findCategory, identifierReason, toOtherExtracted, LIMITS } from "../../utils/customCategories";

// A document that fits no built-in section: pick one of your own categories or
// create a new one, check what was read, and file it. Nothing the scan read is
// thrown away. Every fact is shown and kept unless you remove it, except
// patient identifiers, SSNs and full birth dates, which are listed and never
// saved (CredentialDOMD is built not to hold them).

const ROLE_FIELDS = [
  ["name", "Name", "text"], ["issuer", "Issued by", "text"], ["number", "Number / ID", "text"],
  ["issuedDate", "Issued", "date"], ["expirationDate", "Expires", "date"],
];

function OtherDocumentReview({ extracted, onFile, onDiscard }) {
  const { theme: T, data, canWriteCredential } = useApp();
  const iS = useInputStyle();
  const start = useMemo(() => toOtherExtracted(extracted), [extracted]);
  const categories = useMemo(() => liveCategories(data), [data]);
  const suggested = String(start.suggestedCategory?.name || "").slice(0, LIMITS.name);
  const match = useMemo(() => (suggested ? findCategory(data.customCategories, suggested) : null), [suggested, data.customCategories]);

  // A hidden category matches by name but is not in the list; the name box
  // then routes to it (and filing brings it back), instead of a blank picker.
  const liveMatch = match && categories.some(c => c.id === match.id) ? match : null;
  const [mode, setMode] = useState(liveMatch ? "existing" : suggested || !categories.length ? "new" : "existing");
  const [categoryId, setCategoryId] = useState(liveMatch?.id || categories[0]?.id || "");
  const [newName, setNewName] = useState(suggested);
  const [role, setRole] = useState({ name: start.name, issuer: start.issuer, number: start.number, issuedDate: start.issuedDate, expirationDate: start.expirationDate });
  const [facts, setFacts] = useState(start.facts);

  const withheld = facts.filter(f => identifierReason(f.label, f.value));
  const kept = facts.filter(f => !identifierReason(f.label, f.value));
  const chosen = mode === "existing" ? categories.find(c => c.id === categoryId) : null;
  const typedMatch = mode === "new" ? findCategory(data.customCategories, newName) : null;
  const ready = mode === "existing" ? !!chosen : newName.trim().length > 0;

  const file = () => onFile({
    mode: typedMatch ? "existing" : mode,
    categoryId: typedMatch ? typedMatch.id : categoryId,
    newCategory: { name: newName, icon: start.suggestedCategory?.icon || "", fields: start.suggestedCategory?.fields || [] },
    record: { ...role, facts: kept },
  });

  const label = { fontSize: 12, fontWeight: 700, color: T.textMuted, marginBottom: 4, display: "block" };
  return (
    <div style={{ padding: "14px 18px" }}>
      <div style={{ fontSize: 13.5, color: T.textMuted, lineHeight: 1.5, marginBottom: 12 }}>
        This isn&rsquo;t one of the built-in sections, so it goes in one of your own categories. Everything read from it is below.
      </div>

      <span style={label}>File it in</span>
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        {categories.length > 0 && (
          <button type="button" onClick={() => setMode("existing")} style={{ flex: 1, padding: "8px", borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700,
            border: `1px solid ${mode === "existing" ? T.accent : T.border}`, backgroundColor: mode === "existing" ? T.accentDim : "transparent", color: mode === "existing" ? T.accent : T.textMuted }}>
            One of your categories
          </button>
        )}
        <button type="button" onClick={() => setMode("new")} style={{ flex: 1, padding: "8px", borderRadius: 9, cursor: "pointer", fontFamily: "inherit", fontSize: 13, fontWeight: 700,
          border: `1px solid ${mode === "new" ? T.accent : T.border}`, backgroundColor: mode === "new" ? T.accentDim : "transparent", color: mode === "new" ? T.accent : T.textMuted }}>
          A new category
        </button>
      </div>
      {mode === "existing" ? (
        <select value={categoryId} onChange={e => setCategoryId(e.target.value)} style={{ ...iS, marginBottom: 12 }}>
          {categories.map(c => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
        </select>
      ) : (
        <>
          <input value={newName} maxLength={LIMITS.name} onChange={e => setNewName(e.target.value)} placeholder="e.g. Hospital ID Badges" style={{ ...iS, marginBottom: 4 }} />
          <div style={{ fontSize: 12, color: T.textDim, marginBottom: 12 }}>
            {typedMatch ? `You already have "${typedMatch.name}". This will go there instead of a duplicate.` : "A name for this kind of document, so the next one goes in the same place."}
          </div>
        </>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
        {ROLE_FIELDS.map(([k, l, type]) => (
          <div key={k} style={{ gridColumn: k === "name" ? "1 / -1" : undefined }}>
            <span style={label}>{l}</span>
            <input type={type} value={role[k] || ""} onChange={e => setRole(r => ({ ...r, [k]: e.target.value }))} style={iS} />
          </div>
        ))}
      </div>

      <span style={label}>Details read from the document</span>
      {facts.length === 0 && <div style={{ fontSize: 13, color: T.textDim, marginBottom: 8 }}>No other details were read.</div>}
      {facts.map((f, i) => {
        const why = identifierReason(f.label, f.value);
        return (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6, opacity: why ? 0.55 : 1 }}>
            <input value={f.label} onChange={e => setFacts(fs => fs.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} style={{ ...iS, flex: "0 0 38%" }} />
            <input value={f.value} onChange={e => setFacts(fs => fs.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} style={{ ...iS, flex: 1 }} />
            <button type="button" aria-label="Remove this detail" onClick={() => setFacts(fs => fs.filter((_, j) => j !== i))}
              style={{ border: "none", background: "none", color: T.danger, fontWeight: 800, cursor: "pointer", padding: "0 6px" }}>&times;</button>
          </div>
        );
      })}
      <button type="button" onClick={() => setFacts(fs => [...fs, { label: "", value: "" }])}
        style={{ border: "none", background: "none", color: T.accent, fontWeight: 700, cursor: "pointer", padding: "4px 0", fontSize: 13, fontFamily: "inherit" }}>
        + Add a detail
      </button>
      {withheld.length > 0 && (
        <div style={{ fontSize: 12.5, color: T.warning, marginTop: 8, lineHeight: 1.5 }}>
          Not saved: {[...new Set(withheld.map(f => identifierReason(f.label, f.value)))].join(", ")}. CredentialDOMD doesn&rsquo;t keep patient identifiers, Social Security numbers or full dates of birth.
        </div>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
        <button type="button" disabled={!ready || canWriteCredential === false} onClick={file} style={{
          flex: 1, padding: "12px", borderRadius: 12, border: "none", backgroundColor: T.accent, color: "#fff",
          fontSize: 15, fontWeight: 700, cursor: ready ? "pointer" : "default", opacity: ready && canWriteCredential !== false ? 1 : 0.5, fontFamily: "inherit",
        }}>
          {typedMatch || mode === "existing" ? `File in ${(typedMatch || chosen)?.name || "category"}` : `Create "${newName.trim() || "category"}" and file it`}
        </button>
        <button type="button" onClick={onDiscard} style={{
          padding: "12px 16px", borderRadius: 12, border: `1px solid ${T.border}`, backgroundColor: "transparent",
          color: T.textMuted, fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
        }}>Keep as plain document</button>
      </div>
      {canWriteCredential === false && (
        <div style={{ fontSize: 12.5, color: T.textDim, marginTop: 8 }}>Your records are read-only right now, so this can&rsquo;t be filed. The file stays in Documents.</div>
      )}
    </div>
  );
}

export default memo(OtherDocumentReview);
