import { useState, useMemo, useCallback, memo } from "react";
import { useApp } from "../../context/AppContext";
import { useInputStyle } from "../shared/useInputStyle";
import Modal from "../shared/Modal";
import Field from "../shared/Field";
import EmptyState from "../shared/EmptyState";
import StatusDot from "../shared/StatusDot";
import { PlusIcon, SendIcon, EditIcon, TrashIcon } from "../shared/Icons";
import { HEALTH_RECORD_CATEGORIES, getHealthRecordTypes, TB_RESULTS } from "../../constants/credentialTypes";
import { generateId, getStatusColor, getStatusLabel, formatDate } from "../../utils/helpers";

function HealthRecordsSection({ onShare }) {
  const { data, addItem, editItem: editItemCtx, deleteItem, theme: T } = useApp();
  const iS = useInputStyle();
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [form, setForm] = useState({});
  const [filter, setFilter] = useState("all");

  const items = data.healthRecords || [];

  const filtered = useMemo(() => {
    if (filter === "all") return items;
    return items.filter(i => i.category === filter);
  }, [items, filter]);

  const counts = useMemo(() => {
    const c = { all: items.length };
    HEALTH_RECORD_CATEGORIES.forEach(cat => { c[cat] = items.filter(i => i.category === cat).length; });
    return c;
  }, [items]);

  const openAdd = useCallback(() => { setForm({ category: filter !== "all" ? filter : "" }); setEditItem(null); setShowForm(true); }, [filter]);
  const openEdit = useCallback((item) => { setForm({ ...item }); setEditItem(item); setShowForm(true); }, []);
  const closeForm = useCallback(() => { setShowForm(false); setEditItem(null); setForm({}); }, []);

  const handleSave = useCallback(() => {
    const entry = { ...form, id: editItem ? editItem.id : generateId() };
    if (editItem) editItemCtx("healthRecords", entry);
    else addItem("healthRecords", entry);
    closeForm();
  }, [form, editItem, editItemCtx, addItem, closeForm]);

  const handleDelete = useCallback((id) => deleteItem("healthRecords", id), [deleteItem]);

  const typeOptions = useMemo(() => getHealthRecordTypes(form.category), [form.category]);

  const catColors = { "Vaccination": "#8b5cf6", "TB Test": "#f59e0b", "Fit Test": "#06b6d4" };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text }}>Health Records</h2>
        <button onClick={openAdd} style={{
          display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 16px",
          borderRadius: 12, border: "none", fontSize: 14, fontWeight: 600,
          cursor: "pointer", backgroundColor: T.accent, color: "#fff",
        }}><PlusIcon /> Add</button>
      </div>

      <div style={{ fontSize: 14, color: T.textDim, marginBottom: 12 }}>
        {items.length} record{items.length !== 1 ? "s" : ""}
      </div>

      {/* Filter chips */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {[{ k: "all", l: "All" }, ...HEALTH_RECORD_CATEGORIES.map(c => ({ k: c, l: c }))].map(t => (
          <button key={t.k} onClick={() => setFilter(t.k)} style={{
            padding: "6px 14px", fontSize: 13, borderRadius: 22,
            border: `1px solid ${filter === t.k ? T.accent : T.border}`,
            backgroundColor: filter === t.k ? T.accent : "transparent",
            color: filter === t.k ? "#fff" : T.textMuted,
            cursor: "pointer", fontWeight: 600,
          }}>
            {t.l}{counts[t.k] > 0 ? ` (${counts[t.k]})` : ""}
          </button>
        ))}
      </div>

      {/* Add/Edit Modal */}
      <Modal open={showForm} onClose={closeForm} title={editItem ? "Edit Health Record" : "Add Health Record"}>
        <Field label="Category">
          <select value={form.category || ""} onChange={e => setForm(f => ({ ...f, category: e.target.value, type: "" }))} style={{ ...iS, appearance: "auto" }}>
            <option value="">Select category...</option>
            {HEALTH_RECORD_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        {form.category && (
          <Field label="Type">
            <select value={form.type || ""} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} style={{ ...iS, appearance: "auto" }}>
              <option value="">Select type...</option>
              {typeOptions.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </Field>
        )}
        <Field label="Display Name"><input value={form.name || ""} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={iS} placeholder="e.g. Annual Flu Shot 2024" /></Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label="Date Administered"><input type="date" value={form.dateAdministered || ""} onChange={e => setForm(f => ({ ...f, dateAdministered: e.target.value }))} style={iS} /></Field>
          <Field label="Expiration Date"><input type="date" value={form.expirationDate || ""} onChange={e => setForm(f => ({ ...f, expirationDate: e.target.value }))} style={iS} /></Field>
        </div>
        {form.category === "TB Test" && (
          <Field label="Result">
            <select value={form.result || ""} onChange={e => setForm(f => ({ ...f, result: e.target.value }))} style={{ ...iS, appearance: "auto" }}>
              <option value="">Select result...</option>
              {TB_RESULTS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
        )}
        <Field label="Lot / Batch #"><input value={form.lotNumber || ""} onChange={e => setForm(f => ({ ...f, lotNumber: e.target.value }))} style={iS} /></Field>
        <Field label="Administrator / Facility"><input value={form.facility || ""} onChange={e => setForm(f => ({ ...f, facility: e.target.value }))} style={iS} placeholder="e.g. Employee Health, Hospital Name" /></Field>
        <Field label="Notes"><textarea value={form.notes || ""} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={{ ...iS, minHeight: 50, resize: "vertical" }} /></Field>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={closeForm} style={{ padding: "12px 18px", borderRadius: 10, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
          <button onClick={handleSave} style={{ padding: "12px 18px", borderRadius: 10, border: "none", backgroundColor: T.accent, color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>{editItem ? "Save" : "Add"}</button>
        </div>
      </Modal>

      {/* List */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={"\ud83d\udc89"}
          title={filter === "all" ? "No health records" : `No ${filter.toLowerCase()}s`}
          subtitle="Track vaccinations, TB testing, and fit tests for credentialing compliance."
          onAction={openAdd}
          actionLabel="Add Record"
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map(item => {
            const color = getStatusColor(item.expirationDate);
            const catColor = catColors[item.category] || T.accent;
            return (
              <div key={item.id} style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "14px 16px", boxShadow: T.shadow1 }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
                    {item.expirationDate && <StatusDot color={color} />}
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 1 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 6, backgroundColor: catColor + "20", color: catColor, textTransform: "uppercase", letterSpacing: 0.5 }}>{item.category}</span>
                        {item.type && <span style={{ fontSize: 12, fontWeight: 600, color: T.accent }}>{item.type}</span>}
                      </div>
                      <div style={{ fontSize: 15, fontWeight: 600, color: T.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {item.name || item.type || item.category || "Health Record"}
                      </div>
                      <div style={{ fontSize: 13, color: T.textDim, marginTop: 1 }}>
                        {[
                          item.facility,
                          item.dateAdministered && `Given ${formatDate(item.dateAdministered)}`,
                          item.lotNumber && `Lot: ${item.lotNumber}`,
                          item.result && `Result: ${item.result}`,
                          item.expirationDate && getStatusLabel(item.expirationDate),
                        ].filter(Boolean).join(" \u00b7 ")}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 3, flexShrink: 0, paddingTop: 2 }}>
                    <button onClick={() => onShare(item, "healthRecords")} style={{ padding: "6px 8px", borderRadius: 8, border: "none", backgroundColor: T.shareGlow, color: T.share, cursor: "pointer", display: "flex" }}><SendIcon /></button>
                    <button onClick={() => openEdit(item)} style={{ padding: "6px 8px", borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, cursor: "pointer", display: "flex" }}><EditIcon /></button>
                    <button onClick={() => { if (window.confirm("Delete this record? This cannot be undone.")) handleDelete(item.id); }} style={{ padding: "6px 8px", borderRadius: 8, border: "none", backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", display: "flex" }}><TrashIcon /></button>
                  </div>
                </div>
                {/* Dose history for multi-dose vaccines */}
                {item.doses && item.doses.length > 0 && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: T.textDim, textTransform: "uppercase", marginBottom: 6 }}>
                      Dose History ({item.doses.length} dose{item.doses.length !== 1 ? "s" : ""})
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {item.doses.map((dose, i) => (
                        <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 10px", borderRadius: 8, backgroundColor: T.input, fontSize: 13 }}>
                          <span style={{ fontWeight: 700, color: catColor, minWidth: 18 }}>#{dose.doseNumber || i + 1}</span>
                          <span style={{ color: T.text, fontWeight: 600 }}>{dose.date ? formatDate(dose.date) : "\u2014"}</span>
                          {dose.manufacturer && <span style={{ color: T.textDim }}>{dose.manufacturer}</span>}
                          {dose.lotNumber && <span style={{ color: T.textDim }}>Lot: {dose.lotNumber}</span>}
                          {dose.facility && <span style={{ color: T.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dose.facility}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default memo(HealthRecordsSection);
