import { useState, useCallback, useEffect, memo } from "react";
import { useApp } from "../../context/AppContext";
import { useDeskAddShortcut } from "../../hooks/useDeskKeys";
import { pushModal, popModal } from "../../utils/deskKeys";
import { useInputStyle } from "../shared/useInputStyle";
import Modal from "../shared/Modal";
import Field from "../shared/Field";
import EmptyState from "../shared/EmptyState";
import StatusDot from "../shared/StatusDot";
import { PlusIcon, SendIcon, EditIcon, TrashIcon, FileIcon } from "../shared/Icons";
import { SCREENING_TYPES, SCREENING_RESULTS } from "../../constants/credentialTypes";
import { generateId, getStatusColor, getStatusLabel, formatDate } from "../../utils/helpers";
import DocAttach from "./DocAttach";
import { attachExistingDoc } from "../../utils/docPrefill";

/**
 * Screenings — background checks, exclusion/sanction searches, and the
 * component-by-component results agencies send with them. Facilities ask
 * for these constantly and they expire, so each report carries its own
 * checklist of searches plus the usual expiration tracking.
 */
function ScreeningsSection({ onShare }) {
  const { data, addItem, editItem: editCtx, deleteItem, theme: T } = useApp();
  const iS = useInputStyle();
  const items = data.screenings || [];

  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [form, setForm] = useState({});
  const [attachedDocs, setAttachedDocs] = useState([]);
  const [viewItem, setViewItem] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  // Escape must close the lightbox, not the modal underneath it: capture
  // phase so this runs before Modal's own document-level Escape handler.
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
  // Data URLs don't open directly in iOS Safari — convert to a blob URL
  const openPdfDoc = (doc) => {
    if (!doc.data) return;
    const byteStr = atob(doc.data.split(",")[1]);
    const arr = new Uint8Array(byteStr.length);
    for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i);
    window.open(URL.createObjectURL(new Blob([arr], { type: doc.type || "application/pdf" })), "_blank");
  };

  const openAdd = useCallback(() => { setForm({ components: [] }); setEditItem(null); setAttachedDocs([]); setShowForm(true); }, []);
  const openEdit = useCallback((item) => { setForm({ ...item, components: item.components || [] }); setEditItem(item); setAttachedDocs([]); setShowForm(true); }, []);
  useDeskAddShortcut(openAdd);
  const closeForm = useCallback(() => { setShowForm(false); setEditItem(null); setForm({}); setAttachedDocs([]); }, []);

  const handleSave = useCallback(() => {
    const itemId = editItem ? editItem.id : generateId();
    const entry = { ...form, id: itemId, components: (form.components || []).filter(c => c.name) };
    if (editItem) editCtx("screenings", entry);
    else addItem("screenings", entry);
    for (const doc of attachedDocs) {
      if (doc.existingId) {
        // Already in Files: link the stored copy, never insert a second one.
        const linked = attachExistingDoc((data.documents || []).find(d => d.id === doc.existingId), `screenings:${itemId}`);
        if (linked) editCtx("documents", linked);
        continue;
      }
      addItem("documents", {
        id: generateId(), name: doc.name, type: doc.type, size: doc.size, data: doc.data,
        uploadedAt: new Date().toISOString(), linkedTo: `screenings:${itemId}`,
      });
    }
    closeForm();
  }, [form, editItem, editCtx, addItem, attachedDocs, closeForm, data.documents]);

  const setComp = (i, key, val) => setForm(f => ({
    ...f, components: f.components.map((c, j) => j === i ? { ...c, [key]: val } : c),
  }));
  const addComp = () => setForm(f => ({ ...f, components: [...(f.components || []), { name: "", scope: "", status: "Complete", date: "" }] }));
  const removeComp = (i) => setForm(f => ({ ...f, components: f.components.filter((_, j) => j !== i) }));

  const docsFor = (id) => (data.documents || []).filter(d => d.linkedTo === `screenings:${id}`);
  const statusColor = (s) => /review|flag/i.test(s || "") ? T.warning : /clear|complete|negative/i.test(s || "") ? (T.success || "#22c55e") : T.textDim;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text }}>Screenings</h2>
          <div style={{ fontSize: 12, color: T.textMuted }}>Background checks, exclusions, drug &amp; occupational health reports.</div>
        </div>
        <button onClick={openAdd} style={{
          display: "inline-flex", alignItems: "center", gap: 6, padding: "10px 16px",
          borderRadius: 12, border: "none", fontSize: 14, fontWeight: 600,
          cursor: "pointer", backgroundColor: T.accent, color: "#fff",
        }}><PlusIcon /> Add</button>
      </div>

      {/* Detail view */}
      <Modal open={!!viewItem} onClose={() => setViewItem(null)} title={viewItem?.name || "Screening"}>
        {viewItem && (
          <>
            {[
              ["Type", viewItem.type], ["Agency", viewItem.agency], ["Requested by", viewItem.requestedBy],
              ["Assignment", viewItem.assignment], ["File #", viewItem.fileNumber],
              ["Ordered", viewItem.orderDate && formatDate(viewItem.orderDate)],
              ["Reported", viewItem.reportDate && formatDate(viewItem.reportDate)],
              ["Expires", viewItem.expirationDate && formatDate(viewItem.expirationDate)],
              ["Overall result", viewItem.result],
            ].filter(([, v]) => v).map(([k, v]) => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 0", borderBottom: `1px solid ${T.border}` }}>
                <span style={{ fontSize: 13, color: T.textMuted }}>{k}</span>
                <span style={{ fontSize: 14, fontWeight: 600, color: T.text, textAlign: "right" }}>{v}</span>
              </div>
            ))}
            {viewItem.components?.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", marginBottom: 6 }}>
                  Searches ({viewItem.components.length})
                </div>
                {viewItem.components.map((c, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 10, padding: "7px 0", borderBottom: `1px solid ${T.border}` }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{c.name}</div>
                      {(c.scope || c.date) && <div style={{ fontSize: 11, color: T.textDim }}>{[c.scope, c.date && formatDate(c.date)].filter(Boolean).join(" · ")}</div>}
                      {c.note && <div style={{ fontSize: 11, color: T.textMuted, fontStyle: "italic" }}>{c.note}</div>}
                    </div>
                    <span style={{ fontSize: 11, fontWeight: 800, color: statusColor(c.status), textTransform: "uppercase", flexShrink: 0 }}>{c.status}</span>
                  </div>
                ))}
              </div>
            )}
            {viewItem.notes && <div style={{ fontSize: 13, color: T.textMuted, marginTop: 12, whiteSpace: "pre-wrap" }}>{viewItem.notes}</div>}
            {docsFor(viewItem.id).length > 0 ? (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.textMuted, marginBottom: 8 }}>Source documents — tap to view</div>
                {docsFor(viewItem.id).map(doc => (
                  !doc.data ? (
                    <div key={doc.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderRadius: 10, border: `1px dashed ${T.border}`, backgroundColor: T.input, color: T.textMuted, fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                      <span style={{ fontSize: 16 }}>{"⏳"}</span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{doc.name} — downloading from cloud, check back shortly</span>
                    </div>
                  ) : doc.type?.startsWith("image/") ? (
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
                No source report attached yet — tap Edit and attach the screening report so it rides along when you send this.
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button onClick={() => { const it = viewItem; setViewItem(null); onShare?.(it, "screenings"); }} style={{
                padding: "12px 18px", borderRadius: 10, border: "none", backgroundColor: T.shareGlow, color: T.share, fontSize: 15, fontWeight: 600, cursor: "pointer",
              }}>Send</button>
              <button onClick={() => { const it = viewItem; setViewItem(null); openEdit(it); }} style={{
                padding: "12px 18px", borderRadius: 10, border: "none", backgroundColor: T.accent, color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer",
              }}>Edit</button>
            </div>
          </>
        )}
      </Modal>

      {/* Full-screen picture viewer */}
      {lightbox && (
        <div onClick={() => setLightbox(null)} style={{
          position: "fixed", inset: 0, zIndex: 100000, backgroundColor: "rgba(0,0,0,0.93)",
          display: "flex", alignItems: "center", justifyContent: "center", padding: 12,
        }}>
          <img src={lightbox.data} alt={lightbox.name} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
        </div>
      )}

      {/* Add / Edit */}
      <Modal open={showForm} onClose={closeForm} title={editItem ? "Edit Screening" : "Add Screening"}>
        <Field label="Type">
          <select value={form.type || ""} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} style={{ ...iS, appearance: "auto" }}>
            <option value="">Select type...</option>
            {SCREENING_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Display name"><input value={form.name || ""} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={iS} placeholder="e.g. ScoutLogic Background Screening 2026" /></Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label="Screening agency"><input value={form.agency || ""} onChange={e => setForm(f => ({ ...f, agency: e.target.value }))} style={iS} placeholder="e.g. ScoutLogic" /></Field>
          <Field label="File / report #"><input value={form.fileNumber || ""} onChange={e => setForm(f => ({ ...f, fileNumber: e.target.value }))} style={iS} /></Field>
        </div>
        <Field label="Requested by"><input value={form.requestedBy || ""} onChange={e => setForm(f => ({ ...f, requestedBy: e.target.value }))} style={iS} placeholder="e.g. MPLT Healthcare, LLC" /></Field>
        <Field label="Assignment / facility"><input value={form.assignment || ""} onChange={e => setForm(f => ({ ...f, assignment: e.target.value }))} style={iS} placeholder="e.g. Intermountain Health — Peaks Locum Tenens" /></Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label="Ordered"><input type="date" value={form.orderDate || ""} onChange={e => setForm(f => ({ ...f, orderDate: e.target.value }))} style={iS} /></Field>
          <Field label="Reported"><input type="date" value={form.reportDate || ""} onChange={e => setForm(f => ({ ...f, reportDate: e.target.value }))} style={iS} /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label="Overall result">
            <select value={form.result || ""} onChange={e => setForm(f => ({ ...f, result: e.target.value }))} style={{ ...iS, appearance: "auto" }}>
              <option value="">Select...</option>
              {SCREENING_RESULTS.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
          <Field label="Expires / re-screen by" hint="Most facilities re-screen annually"><input type="date" value={form.expirationDate || ""} onChange={e => setForm(f => ({ ...f, expirationDate: e.target.value }))} style={iS} /></Field>
        </div>

        <Field label="Searches performed" hint="Each component search and its result">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {(form.components || []).map((c, i) => (
              <div key={i} style={{ border: `1px solid ${T.border}`, borderRadius: 10, padding: 8 }}>
                <div style={{ display: "flex", gap: 6 }}>
                  <input value={c.name} onChange={e => setComp(i, "name", e.target.value)} placeholder="Search name" style={{ ...iS, minWidth: 0, flex: 2 }} />
                  <button onClick={() => removeComp(i)} style={{ padding: "6px 10px", borderRadius: 8, border: "none", backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", fontWeight: 700, flexShrink: 0 }}>&times;</button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginTop: 6 }}>
                  <input value={c.scope || ""} onChange={e => setComp(i, "scope", e.target.value)} placeholder="Scope (e.g. CA-Riverside)" style={{ ...iS, minWidth: 0 }} />
                  <input value={c.status || ""} onChange={e => setComp(i, "status", e.target.value)} placeholder="Status" style={{ ...iS, minWidth: 0 }} />
                </div>
                <input type="date" value={c.date || ""} onChange={e => setComp(i, "date", e.target.value)} style={{ ...iS, marginTop: 6 }} />
              </div>
            ))}
            <button onClick={addComp} style={{
              padding: "10px", borderRadius: 10, border: `1px dashed ${T.border}`, backgroundColor: "transparent",
              color: T.accent, fontSize: 13, fontWeight: 700, cursor: "pointer",
            }}>+ Add a search</button>
          </div>
        </Field>

        <Field label="Notes"><textarea value={form.notes || ""} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={{ ...iS, minHeight: 60, resize: "vertical" }} /></Field>
        <DocAttach setForm={setForm} attachedDocs={attachedDocs} setAttachedDocs={setAttachedDocs} />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={closeForm} style={{ padding: "12px 18px", borderRadius: 10, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
          <button onClick={handleSave} style={{ padding: "12px 18px", borderRadius: 10, border: "none", backgroundColor: T.accent, color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>{editItem ? "Save" : "Add"}</button>
        </div>
      </Modal>

      {/* List */}
      {items.length === 0 ? (
        <EmptyState icon={"🔎"} title="No screenings yet"
          subtitle="Background checks, exclusion searches, drug screens — with every component search and its result."
          onAction={openAdd} actionLabel="Add Screening" />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {items.map(item => {
            const nDocs = docsFor(item.id).length;
            return (
              <div key={item.id} onClick={() => setViewItem(item)} style={{
                backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14,
                padding: "14px 16px", boxShadow: T.shadow1, cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
              }}>
                <div style={{ minWidth: 0, flex: 1, display: "flex", alignItems: "center", gap: 10 }}>
                  {item.expirationDate && <StatusDot color={getStatusColor(item.expirationDate)} />}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: 0.5 }}>{item.type}</div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: T.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.name}</div>
                    <div style={{ fontSize: 13, color: T.textDim, marginTop: 1 }}>
                      {[item.agency, item.reportDate && formatDate(item.reportDate),
                        item.components?.length && `${item.components.length} searches`,
                        item.expirationDate && getStatusLabel(item.expirationDate)].filter(Boolean).join(" · ")}
                    </div>
                    {nDocs > 0 && (
                      <div style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: T.accent, marginTop: 4, fontWeight: 600 }}>
                        <FileIcon /> {nDocs} document{nDocs > 1 ? "s" : ""}
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
                  {item.result && (
                    <span style={{ fontSize: 11, fontWeight: 800, color: statusColor(item.result), textTransform: "uppercase", marginRight: 4 }}>{item.result}</span>
                  )}
                  <button onClick={(e) => { e.stopPropagation(); onShare?.(item, "screenings"); }} style={{ padding: "6px 8px", borderRadius: 8, border: "none", backgroundColor: T.shareGlow, color: T.share, cursor: "pointer", display: "flex" }}><SendIcon /></button>
                  <button onClick={(e) => { e.stopPropagation(); openEdit(item); }} style={{ padding: "6px 8px", borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, cursor: "pointer", display: "flex" }}><EditIcon /></button>
                  <button onClick={(e) => { e.stopPropagation(); if (window.confirm("Delete this screening?")) deleteItem("screenings", item.id); }} style={{ padding: "6px 8px", borderRadius: 8, border: "none", backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", display: "flex" }}><TrashIcon /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default memo(ScreeningsSection);
