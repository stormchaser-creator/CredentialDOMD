import { memo, useMemo, useState } from "react";
import { useApp } from "../../context/AppContext";
import CrudSection from "./CrudSection";
import { useInputStyle } from "../shared/useInputStyle";
import {
  normalizeCategory, recordsIn, unsortedRecords, liveCategories, packRecord, moveRecord, updateRecord,
  buildCategory, fieldKey, sanitizeText, categoryKey, findCategory, ROLE_KEYS, LIMITS, FIELD_TYPES,
} from "../../utils/customCategories";

// One of the physician's own categories: the records Vera, the uploader or the
// physician filed there, shown and edited like any other section.
//
// The records live in the customRecords collection. Every category's own
// values are packed into the record's fieldValues before they are saved,
// because the sync layer writes each top-level key as a column and a key the
// table lacks rejects the whole record. CrudSection edits a flat form, so the
// values are unpacked for display and packed again on the way back.

const ROLE_FIELDS = [
  { key: "name", label: "Name", required: true },
  { key: "issuer", label: "Issued by" },
  { key: "number", label: "Number / ID" },
  { key: "issuedDate", label: "Issued", type: "date" },
  { key: "expirationDate", label: "Expires", type: "date" },
];

function CustomCategorySection({ categoryId, onShare, crudTargetProps = {}, onOpenCategory }) {
  const { data, addItem, editItem, deleteItem, theme: T, canWriteCredential } = useApp();
  const iS = useInputStyle();
  const unsorted = categoryId === "unsorted";
  const category = useMemo(() => {
    if (unsorted) return { id: "unsorted", name: "Unsorted records", icon: "\u{1F4E5}", fields: [] };
    return normalizeCategory((data.customCategories || []).find(c => c?.id === categoryId));
  }, [data.customCategories, categoryId, unsorted]);
  const records = useMemo(() => (unsorted ? unsortedRecords(data) : recordsIn(data, categoryId)), [data, categoryId, unsorted]);
  const others = useMemo(() => liveCategories(data).filter(c => c.id !== categoryId), [data, categoryId]);

  const [editing, setEditing] = useState(null); // "rename" | "field" | null
  const [draft, setDraft] = useState("");
  const [fieldType, setFieldType] = useState("text");
  const [msg, setMsg] = useState(null);
  const [moving, setMoving] = useState(null);   // record id being moved

  if (!category) {
    return <div style={{ padding: 20, color: T.textMuted, fontSize: 14 }}>This category no longer exists. Its records are under Unsorted records.</div>;
  }

  const liveFields = (category.fields || []).filter(f => !f.removedAt);
  const fields = [
    ...ROLE_FIELDS,
    ...liveFields.map(f => ({ key: f.key, label: f.label, type: f.type === "textarea" ? "textarea" : FIELD_TYPES.includes(f.type) ? f.type : "text" })),
    { key: "notes", label: "Notes", type: "textarea" },
  ];
  // Unpacked for the form: role columns plus this category's values.
  const items = records.map(r => ({ ...r, ...Object.fromEntries(liveFields.map(f => [f.key, r.fieldValues?.[f.key] ?? ""])) }));
  // For a record whose category is gone, its own labels still describe it.
  const catFor = (r) => unsorted ? { id: r.categoryId || "unsorted", name: r.categoryName || "Unsorted records", fields: Object.entries(r.fieldLabels || {}).map(([key, label]) => ({ key, label, type: "text" })) } : category;

  const pack = (form, existing) => {
    const cat = existing ? catFor(existing) : category;
    const values = {};
    for (const f of (cat.fields || [])) if (form[f.key] != null && form[f.key] !== "") values[f.key] = form[f.key];
    const { record, withheld } = packRecord(cat, {
      ...Object.fromEntries(ROLE_KEYS.map(k => [k, form[k]])),
      values,
      customFields: form.customFields,
      documentIds: existing?.documentIds || [],
    }, { id: form.id });
    if (withheld.length) setMsg("Patient identifiers, SSNs and full birth dates were left out. This app does not keep them.");
    return record;
  };

  const onAdd = (form) => {
    if (unsorted) { setMsg("Add records inside a category."); return false; }
    return addItem("customRecords", pack(form, null));
  };
  const onEdit = (form) => {
    const existing = records.find(r => r.id === form.id);
    if (!existing) return false;
    // Only the fields this screen shows are edited; every other value is kept.
    // Under Unsorted the form shows none of a record's category fields, which
    // is exactly why a hand-rolled merge here used to erase them.
    const shown = unsorted ? [] : liveFields;
    const { record, withheld } = updateRecord(unsorted ? null : category, existing, {
      ...Object.fromEntries(ROLE_KEYS.map(k => [k, form[k] ?? ""])),
      values: Object.fromEntries(shown.map(f => [f.key, form[f.key] ?? ""])),
      customFields: form.customFields,
    });
    if (withheld.length) setMsg("Patient identifiers, SSNs and full birth dates were left out. This app does not keep them.");
    return editItem("customRecords", record);
  };
  const onDelete = (id) => deleteItem("customRecords", id);

  const rename = () => {
    const name = sanitizeText(draft, LIMITS.name);
    if (!name) return;
    const clash = findCategory((data.customCategories || []).filter(c => c.id !== category.id), name);
    if (clash) { setMsg(`You already have "${clash.name}".`); return; }
    const raw = (data.customCategories || []).find(c => c.id === category.id);
    const aliases = [...new Set([...(raw.aliases || []), raw.name].filter(Boolean))].slice(0, LIMITS.aliases);
    if (editItem("customCategories", { ...raw, name, slug: categoryKey(name), aliases }) === false) { setMsg("Could not rename. Nothing was changed."); return; }
    setEditing(null); setMsg(null);
  };
  const addField = () => {
    const label = sanitizeText(draft, LIMITS.label);
    if (!label) return;
    const raw = (data.customCategories || []).find(c => c.id === category.id);
    const taken = new Set((raw.fields || []).map(f => f?.key));
    const built = buildCategory({ name: raw.name, fields: [{ label, type: fieldType }] });
    if (!built.fields.length) { setMsg("That field would hold an identifier this app does not keep."); return; }
    const key = fieldKey(label, taken);
    if (editItem("customCategories", { ...raw, fields: [...(raw.fields || []), { key, label, type: built.fields[0].type }] }) === false) { setMsg("Could not add the field."); return; }
    setEditing(null); setMsg(null);
  };
  const archive = () => {
    if (!window.confirm(`Hide "${category.name}"? Its ${records.length} record${records.length === 1 ? "" : "s"} and their files are kept, under Unsorted records.`)) return;
    const raw = (data.customCategories || []).find(c => c.id === category.id);
    if (editItem("customCategories", { ...raw, archivedAt: new Date().toISOString() }) === false) setMsg("Could not hide it.");
  };
  const move = (record, toId) => {
    const to = (data.customCategories || []).find(c => c.id === toId);
    if (!to) return;
    const moved = moveRecord(record, to);
    if (editItem("customRecords", moved) === false) { setMsg("Could not move it."); return; }
    setMoving(null);
    setMsg(`Moved to ${to.name}.`);
  };

  const btn = { padding: "6px 10px", borderRadius: 8, border: `1px solid ${T.border}`, background: "transparent", color: T.textMuted, fontSize: 12.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" };
  return (
    <div>
      {!unsorted && canWriteCredential !== false && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          <button style={btn} onClick={() => { setEditing("rename"); setDraft(category.name); }}>Rename</button>
          <button style={btn} onClick={() => { setEditing("field"); setDraft(""); setFieldType("text"); }}>Add a field</button>
          <button style={btn} onClick={archive}>Hide category</button>
        </div>
      )}
      {editing && (
        <div style={{ display: "flex", gap: 6, marginBottom: 10, alignItems: "center" }}>
          <input autoFocus value={draft} maxLength={editing === "rename" ? LIMITS.name : LIMITS.label} onChange={e => setDraft(e.target.value)}
            placeholder={editing === "rename" ? "Category name" : "Field name, e.g. Badge number"} style={{ ...iS, flex: 1 }} />
          {editing === "field" && (
            <select value={fieldType} onChange={e => setFieldType(e.target.value)} style={{ ...iS, width: 110 }}>
              {FIELD_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          )}
          <button style={{ ...btn, color: T.accent, borderColor: T.accent }} onClick={editing === "rename" ? rename : addField}>Save</button>
          <button style={btn} onClick={() => setEditing(null)}>Cancel</button>
        </div>
      )}
      {msg && <div style={{ fontSize: 12.5, color: T.textMuted, marginBottom: 10 }}>{msg}</div>}
      <CrudSection
        title={`${category.icon} ${category.name}`}
        sectionKey="customRecords"
        favoritable
        items={items}
        fields={fields}
        onAdd={onAdd}
        onEdit={onEdit}
        onDelete={onDelete}
        onShare={onShare}
        emptyIcon={category.icon}
        emptyTitle={`Nothing in ${category.name} yet`}
        emptySub="Upload a document from Files, or ask Vera, and it can be filed here."
        renderExtra={(item) => others.length > 0 && canWriteCredential !== false ? (
          moving === item.id ? (
            <select autoFocus defaultValue="" onChange={e => e.target.value && move(item, e.target.value)} onBlur={() => setMoving(null)} style={{ ...iS, marginTop: 6 }}>
              <option value="" disabled>Move to...</option>
              {others.map(c => <option key={c.id} value={c.id}>{c.icon} {c.name}</option>)}
            </select>
          ) : (
            <button onClick={() => setMoving(item.id)} style={{ ...btn, marginTop: 6 }}>Move to another category</button>
          )
        ) : null}
        {...crudTargetProps}
      />
      {unsorted && records.length > 0 && onOpenCategory && (
        <div style={{ fontSize: 12.5, color: T.textDim, marginTop: 8 }}>These records belong to a category that was hidden or removed. Move each one to a category you keep.</div>
      )}
    </div>
  );
}

// Create a category by hand. Same rules as Vera and the uploader: a name that
// dedupes against what exists, and fields that never hold identifiers.
export function NewCategoryPanel({ onCreated }) {
  const { data, addItem, editItem, theme: T, canWriteCredential } = useApp();
  const iS = useInputStyle();
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("");
  const [fieldText, setFieldText] = useState("");
  const [msg, setMsg] = useState(null);
  const clash = name.trim() ? findCategory(data.customCategories, name) : null;
  const create = () => {
    if (clash) {
      if (clash.archivedAt) {
        const raw = (data.customCategories || []).find(c => c.id === clash.id);
        if (raw && editItem("customCategories", { ...raw, archivedAt: null }) === false) { setMsg("Could not bring it back."); return; }
      }
      onCreated?.(clash.id);
      return;
    }
    let category;
    try {
      category = buildCategory({ name, icon, fields: fieldText.split(/[,\n]/).map(x => x.trim()).filter(Boolean) },
        { id: crypto.randomUUID(), origin: "user", now: new Date().toISOString() });
    } catch (e) { setMsg(e.message); return; }
    if (addItem("customCategories", category) === false) { setMsg("Could not create it. Your records may be read-only right now."); return; }
    onCreated?.(category.id);
  };
  const label = { fontSize: 12, fontWeight: 700, color: T.textMuted, marginBottom: 4, display: "block" };
  return (
    <div style={{ maxWidth: 520 }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 700, color: T.text }}>New category</h2>
      <div style={{ fontSize: 13.5, color: T.textMuted, marginBottom: 14, lineHeight: 1.5 }}>
        For a kind of document none of the built-in sections holds. Vera and the uploader can also create these, and they reuse the ones you make.
      </div>
      <span style={label}>Name</span>
      <input value={name} maxLength={LIMITS.name} onChange={e => setName(e.target.value)} placeholder="e.g. Hospital ID Badges" style={{ ...iS, marginBottom: 4 }} />
      <div style={{ fontSize: 12, color: T.textDim, marginBottom: 12 }}>{clash ? `You already have "${clash.name}"${clash.archivedAt ? ", hidden" : ""}. This will open it${clash.archivedAt ? " and show it again" : ""}.` : "Plural and reusable, so the next one of these goes in the same place."}</div>
      <span style={label}>Icon (optional)</span>
      <input value={icon} maxLength={LIMITS.icon} onChange={e => setIcon(e.target.value)} placeholder="One emoji" style={{ ...iS, width: 120, marginBottom: 12 }} />
      <span style={label}>Fields (optional)</span>
      <textarea value={fieldText} onChange={e => setFieldText(e.target.value)} rows={3} placeholder="Badge number, Facility, Access level" style={{ ...iS, marginBottom: 4 }} />
      <div style={{ fontSize: 12, color: T.textDim, marginBottom: 14 }}>Separate with commas. Every record already has a name, issuer, number, issued and expiry date.</div>
      {msg && <div style={{ fontSize: 13, color: T.danger, marginBottom: 10 }}>{msg}</div>}
      <button type="button" disabled={!name.trim() || canWriteCredential === false} onClick={create} style={{
        padding: "12px 18px", borderRadius: 12, border: "none", backgroundColor: T.accent, color: "#fff", fontSize: 15, fontWeight: 700,
        cursor: "pointer", opacity: name.trim() && canWriteCredential !== false ? 1 : 0.5, fontFamily: "inherit",
      }}>{clash ? `Open ${clash.name}` : "Create category"}</button>
    </div>
  );
}

export default memo(CustomCategorySection);
