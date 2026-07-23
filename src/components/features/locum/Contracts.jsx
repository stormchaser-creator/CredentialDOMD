import { useState, useCallback, memo } from "react";
import { useApp } from "../../../context/AppContext";
import { useInputStyle } from "../../shared/useInputStyle";
import Modal from "../../shared/Modal";
import Field from "../../shared/Field";
import EmptyState from "../../shared/EmptyState";
import { PlusIcon, EditIcon, TrashIcon, FileIcon } from "../../shared/Icons";
import { generateId, formatDate } from "../../../utils/helpers";
import DocAttach from "../DocAttach";
import { analyzeAgreement } from "../../../utils/documentScanner";

/**
 * Contracts — locum agreements with the terms that drive billing.
 *
 * The rates and increment set here are what the Work Log uses to round
 * time and compute invoice amounts. Attach the signed agreement PDF so
 * the terms and the paper live together.
 */
function Contracts() {
  const { data, setData, addItem, editItem: editCtx, deleteItem, theme: T } = useApp();
  const iS = useInputStyle();
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [form, setForm] = useState({});
  const [attachedDocs, setAttachedDocs] = useState([]);
  const [formError, setFormError] = useState(null);

  const items = data.locumContracts || [];

  const openAdd = useCallback(() => {
    setForm({ incrementMinutes: 15, minCallMinutes: 15 });
    setEditItem(null); setAttachedDocs([]); setShowForm(true);
  }, []);
  const openEdit = useCallback((item) => { setForm({ ...item }); setEditItem(item); setAttachedDocs([]); setShowForm(true); }, []);
  const closeForm = useCallback(() => { setShowForm(false); setEditItem(null); setForm({}); setAttachedDocs([]); }, []);

  const handleSave = useCallback(() => {
    // Don't let an empty agreement slip through silently — that's how a
    // blocked upload turned into a blank contract.
    if (!form.facility && !parseFloat(form.callStipend) && !parseFloat(form.hourlyRate)) {
      setFormError("Nothing is filled in yet — upload the agreement (AI fills the form) or enter the facility and rates.");
      return;
    }
    setFormError(null);
    const itemId = editItem ? editItem.id : generateId();
    const entry = {
      ...form,
      id: itemId,
      hourlyRate: parseFloat(form.hourlyRate) || 0,
      callHourlyRate: parseFloat(form.callHourlyRate) || 0,
      callStipend: parseFloat(form.callStipend) || 0,
      stipendHours: parseFloat(form.stipendHours) || 0,
      overageHourlyRate: parseFloat(form.overageHourlyRate) || 0,
      orientationFee: parseFloat(form.orientationFee) || 0,
      orientationHourlyRate: parseFloat(form.orientationHourlyRate) || 0,
      incrementMinutes: parseInt(form.incrementMinutes, 10) || 15,
      minCallMinutes: parseInt(form.minCallMinutes, 10) || 15,
    };
    if (editItem) editCtx("locumContracts", entry);
    else addItem("locumContracts", entry);

    for (const doc of attachedDocs) {
      // addItem → immediate cloud insert + file upload to Storage
      addItem("documents", {
        id: generateId(),
        name: doc.name, type: doc.type, size: doc.size, data: doc.data,
        uploadedAt: new Date().toISOString(),
        linkedTo: `locumContracts:${itemId}`,
      });
    }
    closeForm();
  }, [form, editItem, editCtx, addItem, closeForm, attachedDocs]);

  const linkedDocCount = useCallback(
    (id) => (data.documents || []).filter(d => d.linkedTo === `locumContracts:${id}`).length,
    [data.documents]
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: T.text }}>Agreements</h3>
          <div style={{ fontSize: 12, color: T.textMuted }}>Rates set here drive the work log and invoices.</div>
        </div>
        <button onClick={openAdd} style={{
          display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 16px",
          borderRadius: 12, border: "none", fontSize: 14, fontWeight: 600,
          cursor: "pointer", backgroundColor: T.accent, color: "#fff",
        }}><PlusIcon /> Add</button>
      </div>

      <Modal open={showForm} onClose={closeForm} title={editItem ? "Edit Agreement" : "Add Agreement"}>
        <Field label="Hospital / Facility"><input value={form.facility || ""} onChange={e => setForm(f => ({ ...f, facility: e.target.value }))} style={iS} placeholder="e.g. Riverside Community Hospital" /></Field>
        <Field label="Agency (if any)"><input value={form.agency || ""} onChange={e => setForm(f => ({ ...f, agency: e.target.value }))} style={iS} placeholder="e.g. CompHealth" /></Field>
        <Field label="Invoice recipient email" hint="Where invoices get sent"><input type="email" value={form.billTo || ""} onChange={e => setForm(f => ({ ...f, billTo: e.target.value }))} style={iS} placeholder="billing@hospital.org" /></Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label="Start Date"><input type="date" value={form.startDate || ""} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} style={iS} /></Field>
          <Field label="End Date"><input type="date" value={form.endDate || ""} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))} style={iS} /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label="Call stipend ($/day)" hint="Flat amount per on-call day"><input type="number" inputMode="decimal" value={form.callStipend ?? ""} onChange={e => setForm(f => ({ ...f, callStipend: e.target.value }))} style={iS} placeholder="3000" /></Field>
          <Field label="Stipend covers (hours)"><input type="number" inputMode="decimal" value={form.stipendHours ?? ""} onChange={e => setForm(f => ({ ...f, stipendHours: e.target.value }))} style={iS} placeholder="4" /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label="After-stipend rate ($/hr)" hint="Hours beyond the stipend"><input type="number" inputMode="decimal" value={form.overageHourlyRate ?? ""} onChange={e => setForm(f => ({ ...f, overageHourlyRate: e.target.value }))} style={iS} placeholder="300" /></Field>
          <Field label="Orientation rate ($/hr)" hint="If orientation is paid hourly"><input type="number" inputMode="decimal" value={form.orientationHourlyRate ?? ""} onChange={e => setForm(f => ({ ...f, orientationHourlyRate: e.target.value }))} style={iS} placeholder="150" /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label="Orientation fee ($, one-time)" hint="If flat instead of hourly"><input type="number" inputMode="decimal" value={form.orientationFee ?? ""} onChange={e => setForm(f => ({ ...f, orientationFee: e.target.value }))} style={iS} placeholder="0" /></Field>
          <div />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label="Hourly rate ($/hr)" hint="Regular non-call work"><input type="number" inputMode="decimal" value={form.hourlyRate ?? ""} onChange={e => setForm(f => ({ ...f, hourlyRate: e.target.value }))} style={iS} placeholder="250" /></Field>
          <Field label="Flat call rate ($/hr)" hint="Only if no stipend model"><input type="number" inputMode="decimal" value={form.callHourlyRate ?? ""} onChange={e => setForm(f => ({ ...f, callHourlyRate: e.target.value }))} style={iS} placeholder="150" /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label="Billing increment (min)" hint="Time rounds UP to this"><input type="number" inputMode="numeric" value={form.incrementMinutes ?? 15} onChange={e => setForm(f => ({ ...f, incrementMinutes: e.target.value }))} style={iS} /></Field>
          <Field label="Minimum per call (min)"><input type="number" inputMode="numeric" value={form.minCallMinutes ?? 15} onChange={e => setForm(f => ({ ...f, minCallMinutes: e.target.value }))} style={iS} /></Field>
        </div>
        <Field label="Key terms / notes" hint="Cancellation clause, guaranteed hours, travel, etc."><textarea value={form.notes || ""} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={{ ...iS, minHeight: 60, resize: "vertical" }} /></Field>
        <DocAttach setForm={setForm} attachedDocs={attachedDocs} setAttachedDocs={setAttachedDocs} analyzer={analyzeAgreement} />
        {formError && (
          <div style={{ fontSize: 13, fontWeight: 600, color: T.danger, marginTop: 10 }}>{formError}</div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={closeForm} style={{ padding: "12px 18px", borderRadius: 10, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
          <button onClick={handleSave} style={{ padding: "12px 18px", borderRadius: 10, border: "none", backgroundColor: T.accent, color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>{editItem ? "Save" : "Add"}</button>
        </div>
      </Modal>

      {items.length === 0 ? (
        <EmptyState icon={"📝"} title="No agreements yet"
          subtitle="Add your locum contract — facility, rates, and billing increment — and attach the signed agreement."
          onAction={openAdd} actionLabel="Add Agreement" />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {items.map(item => (
            <div key={item.id} style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "14px 16px", boxShadow: T.shadow1 }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{item.facility || "Facility"}</div>
                  <div style={{ fontSize: 13, color: T.textDim, marginTop: 2 }}>
                    {[
                      item.agency,
                      item.startDate && `${formatDate(item.startDate)}${item.endDate ? " – " + formatDate(item.endDate) : ""}`,
                      item.callStipend ? `$${item.callStipend}/call day (first ${item.stipendHours || 0}h)` : null,
                      item.overageHourlyRate ? `then $${item.overageHourlyRate}/hr` : null,
                      item.hourlyRate ? `$${item.hourlyRate}/hr` : null,
                      !item.callStipend && item.callHourlyRate ? `call $${item.callHourlyRate}/hr` : null,
                      item.orientationHourlyRate ? `orientation $${item.orientationHourlyRate}/hr` : null,
                      item.orientationFee ? `orientation $${item.orientationFee}` : null,
                      `${item.incrementMinutes || 15}-min increments`,
                    ].filter(Boolean).join(" · ")}
                  </div>
                  {linkedDocCount(item.id) > 0 && (
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: T.accent, marginTop: 5, fontWeight: 600 }}>
                      <FileIcon /> {linkedDocCount(item.id)} document{linkedDocCount(item.id) > 1 ? "s" : ""} attached
                    </div>
                  )}
                  {item.notes && <div style={{ fontSize: 12, color: T.textMuted, marginTop: 5, whiteSpace: "pre-wrap" }}>{item.notes}</div>}
                </div>
                <div style={{ display: "flex", gap: 3, flexShrink: 0 }}>
                  <button onClick={() => openEdit(item)} style={{ padding: "6px 8px", borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, cursor: "pointer", display: "flex" }}><EditIcon /></button>
                  <button onClick={() => { if (window.confirm("Delete this agreement? Work log entries keep their data.")) deleteItem("locumContracts", item.id); }} style={{ padding: "6px 8px", borderRadius: 8, border: "none", backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", display: "flex" }}><TrashIcon /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default memo(Contracts);
