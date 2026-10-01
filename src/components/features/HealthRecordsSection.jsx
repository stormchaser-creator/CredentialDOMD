import { useState, useMemo, useCallback, useEffect, memo } from "react";
import { useApp } from "../../context/AppContext";
import { useDeskAddShortcut } from "../../hooks/useDeskKeys";
import { pushModal, popModal } from "../../utils/deskKeys";
import { useInputStyle } from "../shared/useInputStyle";
import Modal from "../shared/Modal";
import Field from "../shared/Field";
import { TAP_MIN, CARD_ACTION_GAP, cardActionSize } from "../shared/actionButton.js";
import EmptyState from "../shared/EmptyState";
import StatusDot from "../shared/StatusDot";
import { PlusIcon, SendIcon, EditIcon, TrashIcon, StarIcon } from "../shared/Icons";
import { HEALTH_RECORD_CATEGORIES, getHealthRecordTypes, getHealthRecordResults, TB_RESULTS } from "../../constants/credentialTypes";
import { generateId, getStatusColor, getStatusLabel, formatDate, describeItem, deleteConfirmText, titleAfterType } from "../../utils/helpers";
import { reminderLeadDays } from "../../utils/reminderPreferences";
import { docMime } from "../../utils/inboxDocs";
import DocAttach from "./DocAttach";
import { SECTION_FIELDS } from "../../utils/sectionFields.js";

// health_records' columns. `doses` is one too (a vaccine series) and is not
// in SECTION_FIELDS, so it is named here or a scanned series would lose it.
const HEALTH_SCAN_KEYS = Object.freeze([...SECTION_FIELDS.healthRecords, "doses"]);
import { attachExistingDoc } from "../../utils/docPrefill";
import FollowUpHistory from "../shared/FollowUpHistory";

// A vaccine series by hand: a scan fills `doses`, and a member with AI off, or
// a dose the scan missed, is entered or corrected here. Saved as typed, minus
// rows left blank; a dose number is kept as a number, as a scan writes it.
const DOSE_TEXT_KEYS = ["date", "manufacturer", "lotNumber", "facility"];
function cleanDoses(doses) {
  return (Array.isArray(doses) ? doses : []).flatMap((d) => {
    if (!d || typeof d !== "object") return [];
    const out = { ...d };
    for (const k of DOSE_TEXT_KEYS) {
      const v = typeof out[k] === "string" ? out[k].trim() : out[k];
      if (v) out[k] = v; else delete out[k];
    }
    const n = parseInt(String(out.doseNumber ?? "").trim(), 10);
    if (Number.isFinite(n) && n > 0) out.doseNumber = n; else delete out.doseNumber;
    return DOSE_TEXT_KEYS.some((k) => out[k]) ? [out] : [];
  });
}

// Two fields side by side. A plain 1fr track cannot shrink below a date
// input's own minimum (about 189 px in Chrome), so on a phone the second date
// ran off the dialog's right edge; minmax(0, 1fr) splits the width.
const PAIR = "minmax(0, 1fr) minmax(0, 1fr)";

function HealthRecordsSection({ onShare, autoEditId, onAutoEditDone, autoFocusField, autoViewId, onAutoViewDone }) {
  const { data, setData, addItem, editItem: editItemCtx, deleteItem, theme: T, toggleFavorite, navigate } = useApp();
  const starButton = (item) => {
    const on = item?.favorite === true;
    return (
      <button type="button" aria-pressed={on} title={on ? "Remove from Favorites" : "Add to Favorites"}
        aria-label={on ? "Remove from Favorites" : "Add to Favorites"}
        onClick={(e) => { e.stopPropagation(); toggleFavorite("healthRecords", item.id); }}
        style={{ padding: "6px 8px", borderRadius: 8, border: "none", cursor: "pointer", ...cardActionSize,
          backgroundColor: on ? T.accentDim : "transparent", color: on ? T.accent : T.textDim }}>
        <StarIcon filled={on} />
      </button>
    );
  };
  const iS = useInputStyle();
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [form, setForm] = useState({});
  const [attachedDocs, setAttachedDocs] = useState([]);
  const [filter, setFilter] = useState("all");
  // Tap-anywhere detail view — shows every field AND the source document
  // (the lab report or card the data came from); agencies want the paper,
  // not a statement.
  const [viewItem, setViewItem] = useState(null);
  const [lightbox, setLightbox] = useState(null);

  // Escape must close the lightbox, not the modal underneath it
  // The lightbox is a modal layer too, so it joins the stack while up and
  // the desk keys stay quiet beneath it.
  useEffect(() => {
    if (!lightbox) return;
    const layer = {};
    pushModal(layer);
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); setLightbox(null); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); popModal(layer); };
  }, [lightbox]);

  const linkedDocs = useCallback(
    (item) => (data.documents || []).filter(d => d.linkedTo === `healthRecords:${item.id}`),
    [data.documents]
  );

  // Data URLs don't open directly in iOS Safari — convert to a blob URL
  const openPdfDoc = useCallback((doc) => {
    if (!doc.data) return;
    const byteStr = atob(doc.data.split(",")[1]);
    const arr = new Uint8Array(byteStr.length);
    for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([arr], { type: docMime(doc) || "application/pdf" }));
    window.open(url, "_blank");
  }, []);

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

  const openAdd = useCallback(() => { setForm({ category: filter !== "all" ? filter : "" }); setEditItem(null); setAttachedDocs([]); setShowForm(true); }, [filter]);
  const openEdit = useCallback((item) => { setForm({ ...item }); setEditItem(item); setAttachedDocs([]); setShowForm(true); }, []);
  useDeskAddShortcut(openAdd);
  const closeForm = useCallback(() => { setShowForm(false); setEditItem(null); setForm({}); setAttachedDocs([]); }, []);

  const [reqError, setReqError] = useState(null);

  const handleSave = useCallback(() => {
    // health_records.category is NOT NULL in the database: a record added
    // from the All tab on "Select category..." was refused whole and lived
    // on this device only. Checked on an edit too, where the blank option is
    // just as easy to pick.
    if (!String(form.category || "").trim()) {
      setReqError("Choose a category so this record can be saved to your account.");
      return;
    }
    // TB tests and fit tests expire — the date is the whole point.
    if ((form.category === "TB Test" || form.category === "Fit Test") && !form.expirationDate) {
      setReqError(`${form.category}s expire. Enter the expiration date so the app can warn you before it lapses.`);
      return;
    }
    setReqError(null);
    const itemId = editItem ? editItem.id : generateId();
    const entry = { ...form, id: itemId };
    if (Array.isArray(form.doses)) entry.doses = cleanDoses(form.doses);
    // Refused (membership being re-checked): the form stays open with what
    // was typed and attached, to save again; addItem has said why.
    if ((editItem ? editItemCtx("healthRecords", entry) : addItem("healthRecords", entry)) === false) return;

    // Same behavior as every other credential form: attached files are
    // saved to Documents and linked to this record.
    for (const doc of attachedDocs) {
      if (doc.existingId) {
        // Already in Files: link the stored copy, never insert a second one.
        const linked = attachExistingDoc((data.documents || []).find(d => d.id === doc.existingId), `healthRecords:${itemId}`);
        if (linked) editItemCtx("documents", linked);
        continue;
      }
      addItem("documents", {
        id: generateId(),
        name: doc.name, type: doc.type, size: doc.size, data: doc.data,
        uploadedAt: new Date().toISOString(),
        linkedTo: `healthRecords:${itemId}`,
      });
    }
    closeForm();
  }, [form, editItem, editItemCtx, addItem, closeForm, attachedDocs, data.documents]);

  const handleDelete = useCallback((id) => deleteItem("healthRecords", id), [deleteItem]);

  useEffect(() => {
    if (!autoEditId) return;
    const it = items.find(x => x.id === autoEditId);
    if (it) {
      openEdit(it); onAutoEditDone?.();
      // "Add date" links land on the exact field they came for, as they do
      // in every CrudSection form.
      if (autoFocusField) {
        setTimeout(() => {
          const el = document.querySelector(`[data-fkey="${autoFocusField}"]`);
          try { el?.focus(); el?.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { /* older browser */ }
        }, 400);
      }
    }
  }, [autoEditId, items, openEdit, onAutoEditDone, autoFocusField]);

  // Opened from the dashboard list or search: show the record's details.
  useEffect(() => {
    if (!autoViewId) return;
    const it = items.find(x => x.id === autoViewId);
    if (it) { setViewItem(it); onAutoViewDone?.(); }
  }, [autoViewId, items, onAutoViewDone]);

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
          <button key={t.k} aria-pressed={filter === t.k} onClick={() => setFilter(t.k)} style={{
            padding: "6px 14px", fontSize: 13, borderRadius: 22, minHeight: TAP_MIN,
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
        {editItem && <FollowUpHistory item={editItem} />}
        <Field label="Category *">
          <select required aria-required="true" value={form.category || ""} onChange={e => { setReqError(null); setForm(f => ({ ...f, category: e.target.value, type: "" })); }} style={{ ...iS, appearance: "auto" }}>
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
        <div style={{ display: "grid", gridTemplateColumns: PAIR, gap: 8 }}>
          <Field label="Date Administered"><input type="date" value={form.dateAdministered || ""} onChange={e => setForm(f => ({ ...f, dateAdministered: e.target.value }))} style={iS} /></Field>
          <Field label="Expiration Date"><input type="date" data-fkey="expirationDate" value={form.expirationDate || ""} onChange={e => setForm(f => ({ ...f, expirationDate: e.target.value }))} style={iS} /></Field>
        </div>
        {(form.category === "TB Test" || form.category === "Titer / Immunity" || form.category === "Drug Screen") && (
          <Field label="Result">
            <select value={form.result || ""} onChange={e => setForm(f => ({ ...f, result: e.target.value }))} style={{ ...iS, appearance: "auto" }}>
              <option value="">Select result...</option>
              {(form.category === "TB Test" ? TB_RESULTS : getHealthRecordResults(form.category)).map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
        )}
        {/* Lab detail — quantitative titers, drug screens, TB blood tests */}
        {(form.category === "Titer / Immunity" || form.category === "Drug Screen" || form.category === "TB Test") && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: PAIR, gap: 8 }}>
              <Field label="Value"><input value={form.resultValue || ""} onChange={e => setForm(f => ({ ...f, resultValue: e.target.value }))} style={iS} placeholder="e.g. 165" /></Field>
              <Field label="Units"><input value={form.resultUnits || ""} onChange={e => setForm(f => ({ ...f, resultUnits: e.target.value }))} style={iS} placeholder="e.g. mIU/mL" /></Field>
            </div>
            <Field label="Reference range"><input value={form.referenceRange || ""} onChange={e => setForm(f => ({ ...f, referenceRange: e.target.value }))} style={iS} placeholder="e.g. ≥ 10 mIU/mL = immune" /></Field>
            <div style={{ display: "grid", gridTemplateColumns: PAIR, gap: 8 }}>
              <Field label="Collected"><input type="date" value={form.collectedDate || ""} onChange={e => setForm(f => ({ ...f, collectedDate: e.target.value }))} style={iS} /></Field>
              <Field label="Reported"><input type="date" value={form.reportedDate || ""} onChange={e => setForm(f => ({ ...f, reportedDate: e.target.value }))} style={iS} /></Field>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: PAIR, gap: 8 }}>
              <Field label="Laboratory"><input value={form.lab || ""} onChange={e => setForm(f => ({ ...f, lab: e.target.value }))} style={iS} placeholder="e.g. Quest Diagnostics" /></Field>
              <Field label="Specimen #"><input value={form.specimenId || ""} onChange={e => setForm(f => ({ ...f, specimenId: e.target.value }))} style={iS} /></Field>
            </div>
            <Field label="Ordered by / for"><input value={form.orderedBy || ""} onChange={e => setForm(f => ({ ...f, orderedBy: e.target.value }))} style={iS} placeholder="e.g. the agency, and the assignment it is for" /></Field>
          </>
        )}
        <Field label="Lot / Batch #"><input value={form.lotNumber || ""} onChange={e => setForm(f => ({ ...f, lotNumber: e.target.value }))} style={iS} /></Field>
        <Field label="Administrator / Facility"><input value={form.facility || ""} onChange={e => setForm(f => ({ ...f, facility: e.target.value }))} style={iS} placeholder="e.g. Employee Health, Hospital Name" /></Field>
        {(form.category === "Vaccination" || (Array.isArray(form.doses) && form.doses.length > 0)) && (() => {
          const doses = Array.isArray(form.doses) ? form.doses : [];
          const setDose = (i, key, value) => setForm(f => ({ ...f, doses: (Array.isArray(f.doses) ? f.doses : []).map((d, j) => (j === i ? { ...d, [key]: value } : d)) }));
          const addDose = () => setForm(f => {
            const list = Array.isArray(f.doses) ? f.doses : [];
            const last = Math.max(list.length, ...list.map(d => parseInt(d?.doseNumber, 10)).filter(Number.isFinite));
            return { ...f, doses: [...list, { doseNumber: last + 1, date: "", manufacturer: "", lotNumber: "", facility: "" }] };
          });
          const removeDose = (i) => setForm(f => ({ ...f, doses: (Array.isArray(f.doses) ? f.doses : []).filter((_, j) => j !== i) }));
          const small = { fontSize: 12, fontWeight: 600, color: T.textMuted, marginBottom: 2, display: "block" };
          return (
            <div role="group" aria-labelledby="health-doses-heading" style={{ marginBottom: 12 }}>
              <div id="health-doses-heading" style={{ fontSize: 13, fontWeight: 600, color: T.textMuted, marginBottom: 6 }}>Doses</div>
              {doses.map((dose, i) => (
                <div key={i} style={{ padding: 10, borderRadius: 10, border: `1px solid ${T.border}`, marginBottom: 8 }}>
                  <div style={{ display: "grid", gridTemplateColumns: PAIR, gap: 8 }}>
                    <label><span style={small}>Dose number</span><input aria-label={`Dose ${i + 1} number`} inputMode="numeric" value={dose?.doseNumber ?? ""} onChange={e => setDose(i, "doseNumber", e.target.value)} style={iS} /></label>
                    <label><span style={small}>Date given</span><input aria-label={`Dose ${i + 1} date`} type="date" value={dose?.date || ""} onChange={e => setDose(i, "date", e.target.value)} style={iS} /></label>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: PAIR, gap: 8, marginTop: 6 }}>
                    <label><span style={small}>Manufacturer</span><input aria-label={`Dose ${i + 1} manufacturer`} value={dose?.manufacturer || ""} onChange={e => setDose(i, "manufacturer", e.target.value)} style={iS} /></label>
                    <label><span style={small}>Lot</span><input aria-label={`Dose ${i + 1} lot`} value={dose?.lotNumber || ""} onChange={e => setDose(i, "lotNumber", e.target.value)} style={iS} /></label>
                  </div>
                  <label style={{ display: "block", marginTop: 6 }}><span style={small}>Given at</span><input aria-label={`Dose ${i + 1} facility`} value={dose?.facility || ""} onChange={e => setDose(i, "facility", e.target.value)} style={iS} /></label>
                  <button type="button" onClick={() => removeDose(i)} style={{ marginTop: 6, padding: "6px 12px", minHeight: TAP_MIN, borderRadius: 8, border: "none", backgroundColor: T.dangerDim, color: T.danger, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Remove dose {dose?.doseNumber || i + 1}</button>
                </div>
              ))}
              <button type="button" onClick={addDose} style={{ padding: "6px 12px", minHeight: TAP_MIN, borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.accent, fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Add a dose</button>
            </div>
          );
        })()}
        <Field label="Notes"><textarea value={form.notes || ""} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={{ ...iS, minHeight: 50, resize: "vertical" }} /></Field>
        <DocAttach setForm={setForm} attachedDocs={attachedDocs} setAttachedDocs={setAttachedDocs} allowedKeys={HEALTH_SCAN_KEYS} />
        {reqError && (
          <div style={{ fontSize: 13, fontWeight: 600, color: T.danger, marginTop: 10 }}>{reqError}</div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={closeForm} style={{ padding: "12px 18px", borderRadius: 10, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
          <button onClick={handleSave} style={{ padding: "12px 18px", borderRadius: 10, border: "none", backgroundColor: T.accent, color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>{editItem ? "Save" : "Add"}</button>
        </div>
      </Modal>

      {/* Tap-to-view detail — fields plus the source document(s) */}
      <Modal open={!!viewItem} onClose={() => setViewItem(null)} title={viewItem ? (viewItem.name || viewItem.type || viewItem.category || "Health Record") : "Health Record"}>
        {viewItem && (() => {
          const rows = [
            ["Category", viewItem.category],
            ["Type", viewItem.type],
            ["Date administered", viewItem.dateAdministered && formatDate(viewItem.dateAdministered)],
            ["Expires", viewItem.expirationDate && formatDate(viewItem.expirationDate)],
            ["Result", viewItem.result],
            ["Value", viewItem.resultValue && `${viewItem.resultValue}${viewItem.resultUnits ? " " + viewItem.resultUnits : ""}`],
            ["Reference range", viewItem.referenceRange],
            ["Collected", viewItem.collectedDate && formatDate(viewItem.collectedDate)],
            ["Reported", viewItem.reportedDate && formatDate(viewItem.reportedDate)],
            ["Laboratory", viewItem.lab],
            ["Specimen #", viewItem.specimenId],
            ["Ordered by / for", viewItem.orderedBy],
            ["Lot / Batch #", viewItem.lotNumber],
            ["Facility", viewItem.facility],
            ["Notes", viewItem.notes],
          ].filter(([, v]) => v);
          const docs = linkedDocs(viewItem);
          return (
            <>
              <FollowUpHistory item={viewItem} />
              {rows.map(([k, v]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "9px 0", borderBottom: `1px solid ${T.border}` }}>
                  <span style={{ fontSize: 13, color: T.textMuted, flexShrink: 0 }}>{k}</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: T.text, textAlign: "right", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{String(v)}</span>
                </div>
              ))}
              {viewItem.customFields && Object.keys(viewItem.customFields).length > 0 && (
                <>
                  <div style={{ fontSize: 12, fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: 0.5, margin: "12px 0 2px" }}>
                    Additional details
                  </div>
                  {Object.entries(viewItem.customFields).map(([k, v]) => (
                    <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "9px 0", borderBottom: `1px solid ${T.border}` }}>
                      <span style={{ fontSize: 13, color: T.textMuted, flexShrink: 0 }}>{k}</span>
                      <span style={{ fontSize: 14, fontWeight: 600, color: T.text, textAlign: "right", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{String(v)}</span>
                    </div>
                  ))}
                </>
              )}
              {docs.length > 0 ? (
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: T.textMuted, marginBottom: 8 }}>Source documents (tap to view)</div>
                  {docs.map(doc => (
                    doc.fileMissing && !doc.data ? (
                      // Storage has no file behind this row (AppContext reconcileDocumentFiles
                      // marked it and stops asking), so it is never "downloading". Said as the
                      // Documents tab says it, where it can be uploaded again.
                      <div key={doc.id} role="status" style={{
                        display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", width: "100%", padding: "10px 12px",
                        borderRadius: 10, border: `1px dashed ${T.border}`, backgroundColor: T.input,
                        fontSize: 13, fontWeight: 600, marginBottom: 8, boxSizing: "border-box",
                      }}>
                        <span style={{ color: T.danger, flex: "1 1 200px", overflowWrap: "anywhere" }}>{doc.name} is missing from your account. Upload it again in Documents.</span>
                        <button onClick={() => { setViewItem(null); navigate("documents"); }} style={{
                          padding: "8px 12px", borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: T.input,
                          color: T.text, fontSize: 16, fontWeight: 600, cursor: "pointer",
                        }}>Open Documents</button>
                      </div>
                    ) : !doc.data ? (
                      <div key={doc.id} style={{
                        display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "10px 12px",
                        borderRadius: 10, border: `1px dashed ${T.border}`, backgroundColor: T.input,
                        color: T.textMuted, fontSize: 13, fontWeight: 600, marginBottom: 8,
                      }}>
                        <span style={{ fontSize: 16 }}>{"⏳"}</span>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{doc.name} is downloading from the cloud; check back shortly</span>
                      </div>
                    ) : docMime(doc).startsWith("image/") ? (
                      <img key={doc.id} src={doc.data} alt={doc.name} onClick={() => setLightbox(doc)}
                        style={{ width: "100%", borderRadius: 12, border: `1px solid ${T.border}`, marginBottom: 8, cursor: "zoom-in", display: "block" }} />
                    ) : (
                      <button key={doc.id} onClick={() => openPdfDoc(doc)} style={{
                        display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "10px 12px",
                        borderRadius: 10, border: `1px solid ${T.border}`, backgroundColor: T.input,
                        color: T.text, fontSize: 13, fontWeight: 600, cursor: "pointer", marginBottom: 8, textAlign: "left",
                      }}>
                        <span style={{ fontSize: 16 }}>{"📕"}</span>
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{doc.name}</span>
                      </button>
                    )
                  ))}
                </div>
              ) : (
                <div style={{ marginTop: 14, padding: "10px 12px", borderRadius: 10, border: `1px dashed ${T.warning}`, fontSize: 12.5, color: T.textMuted, lineHeight: 1.45 }}>
                  No source document attached yet. Agencies usually need the actual report or card. Tap Edit and attach it so it rides along when you send this record.
                </div>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
                <button onClick={() => { const it = viewItem; setViewItem(null); onShare(it, "healthRecords"); }} style={{
                  padding: "12px 18px", borderRadius: 10, border: "none",
                  backgroundColor: T.shareGlow, color: T.share, fontSize: 15, fontWeight: 600, cursor: "pointer",
                }}>Send</button>
                <button onClick={() => { const it = viewItem; setViewItem(null); openEdit(it); }} style={{
                  padding: "12px 18px", borderRadius: 10, border: "none",
                  backgroundColor: T.accent, color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer",
                }}>Edit</button>
              </div>
            </>
          );
        })()}
      </Modal>

      {/* Full-screen picture viewer */}
      {lightbox && (
        <div role="dialog" aria-modal="true" aria-label={lightbox.name || "Picture"} onClick={() => setLightbox(null)} style={{
          position: "fixed", inset: 0, zIndex: 100000, backgroundColor: "rgba(0,0,0,0.93)",
          display: "flex", alignItems: "center", justifyContent: "center", padding: 12,
        }}>
          <img src={lightbox.data} alt={lightbox.name} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
        </div>
      )}

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
            const color = getStatusColor(item.expirationDate, reminderLeadDays(data.settings.reminderLeadDays));
            const catColor = catColors[item.category] || T.accent;
            return (
              <div key={item.id} onClick={() => setViewItem(item)} style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "14px 16px", boxShadow: T.shadow1, cursor: "pointer" }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: 1 }}>
                    {item.expirationDate && <StatusDot color={color} />}
                    <div style={{ minWidth: 0 }}>
                      {/* Category pill + green type stay as the header; the
                          white line carries only the specifics (never a
                          repeat of the type), the dim line the rest. */}
                      {(() => {
                        const cardTitle = describeItem(item, data.settings?.name, "healthRecords");
                        const mainLine = titleAfterType(cardTitle, item.type);
                        const said = (v) => v != null && (
                          cardTitle.toLowerCase().includes(String(v).toLowerCase())
                          || String(item.type || "").toLowerCase() === String(v).toLowerCase()
                        );
                        return (
                          <>
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 1 }}>
                              <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 6, backgroundColor: catColor + "20", color: catColor, textTransform: "uppercase", letterSpacing: 0.5 }}>{item.category}</span>
                              {item.type && String(item.type) !== String(item.category) && <span style={{ fontSize: 12, fontWeight: 600, color: T.accent }}>{item.type}</span>}
                            </div>
                            {mainLine && (
                              <div style={{ fontSize: 15, fontWeight: 600, color: T.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {mainLine}
                              </div>
                            )}
                            <div style={{ fontSize: 13, color: T.textDim, marginTop: 1 }}>
                              {[
                                item.facility,
                                item.dateAdministered && `Given ${formatDate(item.dateAdministered)}`,
                                item.lotNumber && `Lot: ${item.lotNumber}`,
                                item.result && `Result: ${item.result}${item.resultValue ? ` (${item.resultValue}${item.resultUnits ? " " + item.resultUnits : ""})` : ""}`,
                                item.lab,
                                item.expirationDate && getStatusLabel(item.expirationDate),
                              ].filter(Boolean).filter(v => !said(v)).join(" \u00b7 ")}
                            </div>
                          </>
                        );
                      })()}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: CARD_ACTION_GAP, flexShrink: 0, paddingTop: 2 }}>
                    {starButton(item)}
                  <button aria-label="Share" onClick={(ev) => { ev.stopPropagation(); onShare(item, "healthRecords"); }} style={{ padding: "6px 8px", borderRadius: 8, border: "none", backgroundColor: T.shareGlow, color: T.share, cursor: "pointer", ...cardActionSize }}><SendIcon /></button>
                    <button aria-label="Edit" onClick={(ev) => { ev.stopPropagation(); openEdit(item); }} style={{ padding: "6px 8px", borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, cursor: "pointer", ...cardActionSize }}><EditIcon /></button>
                    <button aria-label="Delete" onClick={(ev) => { ev.stopPropagation(); if (window.confirm(deleteConfirmText("record", linkedDocs(item).length, { names: linkedDocs(item).map(d => d.name || "file") }))) handleDelete(item.id); }} style={{ padding: "6px 8px", borderRadius: 8, border: "none", backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", ...cardActionSize }}><TrashIcon /></button>
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
