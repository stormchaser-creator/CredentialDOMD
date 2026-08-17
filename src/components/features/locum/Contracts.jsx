import { useState, useCallback, memo } from "react";
import { useApp } from "../../../context/AppContext";
import { useInputStyle } from "../../shared/useInputStyle";
import Modal from "../../shared/Modal";
import Field from "../../shared/Field";
import EmptyState from "../../shared/EmptyState";
import { PlusIcon, EditIcon, TrashIcon, FileIcon } from "../../shared/Icons";
import { generateId, formatDate } from "../../../utils/helpers";
import DocAttach from "../DocAttach";
import ContractSummary from "./ContractSummary";
import { analyzeAgreement, analyzeAgreementText } from "../../../utils/documentScanner";
import { TAX_STATES, MODELED_STATES, NO_INCOME_TAX_STATES } from "../../../utils/taxConstants";
import { STATE_NAMES } from "../../../constants/states";

// Work-state hint reads from the tax engine's own list so it never promises a
// state the estimator cannot model.
const WORK_STATE_HINT = `Where the work physically happens. Tax Prep allocates this contract's income here; state tax is modeled today for ${MODELED_STATES.join(", ")} and the no-income-tax states (${NO_INCOME_TAX_STATES.join(", ")}). Other states show income only, no state tax estimate yet.`;

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
    setForm({ incrementMinutes: 15, minCallMinutes: 15, coveragePeriods: [] });
    setEditItem(null); setAttachedDocs([]); setShowForm(true);
  }, []);
  const openEdit = useCallback((item) => {
    setForm({
      ...item,
      // Older contracts stored one start/end pair — surface it as the first period
      coveragePeriods: item.coveragePeriods?.length
        ? item.coveragePeriods
        : (item.startDate ? [{ start: item.startDate, end: item.endDate || "" }] : []),
    });
    setEditItem(item); setAttachedDocs([]); setShowForm(true);
  }, []);
  const closeForm = useCallback(() => { setShowForm(false); setEditItem(null); setForm({}); setAttachedDocs([]); }, []);

  const handleSave = useCallback(() => {
    // Don't let an empty agreement slip through silently — that's how a
    // blocked upload turned into a blank contract.
    if (!form.facility && !parseFloat(form.callStipend) && !parseFloat(form.hourlyRate) && !parseFloat(form.dayRate)) {
      setFormError("Nothing is filled in yet — upload the agreement (AI fills the form) or enter the facility and rates.");
      return;
    }
    setFormError(null);
    const itemId = editItem ? editItem.id : generateId();
    // startDate/endDate = the span of all coverage periods (oldest → newest)
    const periods = (form.coveragePeriods || []).filter(p => p.start || p.end);
    const starts = periods.map(p => p.start).filter(Boolean).sort();
    const ends = periods.map(p => p.end || p.start).filter(Boolean).sort();
    const entry = {
      ...form,
      coveragePeriods: periods,
      startDate: starts[0] || form.startDate || "",
      endDate: ends[ends.length - 1] || form.endDate || "",
      id: itemId,
      hourlyRate: parseFloat(form.hourlyRate) || 0,
      dayRate: parseFloat(form.dayRate) || 0,
      payModel: form.payModel || (parseFloat(form.dayRate) ? "daily" : parseFloat(form.callStipend) ? "stipend" : "hourly"),
      callRateGrid: form.callRateGrid || null,
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

  const linkedDocsFor = useCallback(
    (id) => (data.documents || []).filter(d => d.linkedTo === `locumContracts:${id}`),
    [data.documents]
  );

  // Tap the contract name → everything it produced (invoices, cases, RVUs)
  const [summaryFor, setSummaryFor] = useState(null);

  // View the original agreement: images full-screen, PDFs in a viewer sheet
  const [lightbox, setLightbox] = useState(null);
  const openPdfDoc = useCallback((doc) => {
    if (!doc.data) return;
    const byteStr = atob(doc.data.split(",")[1]);
    const arr = new Uint8Array(byteStr.length);
    for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([arr], { type: doc.type || "application/pdf" }));
    window.open(url, "_blank");
  }, []);

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
        <Field label="Work state (for taxes)" hint={WORK_STATE_HINT}>
          <select value={form.workState || ""} onChange={e => setForm(f => ({ ...f, workState: e.target.value }))} style={{ ...iS, appearance: "auto" }}>
            <option value="">Pick a state</option>
            {TAX_STATES.map(st => <option key={st} value={st}>{st}, {STATE_NAMES[st] || st}</option>)}
          </select>
        </Field>
        <Field label="Location" hint="City / state of the facility"><input value={form.location || ""} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} style={iS} placeholder="e.g. Colorado Springs, CO" /></Field>
        <Field label="Invoice recipient email" hint="Where invoices get sent"><input type="email" value={form.billTo || ""} onChange={e => setForm(f => ({ ...f, billTo: e.target.value }))} style={iS} placeholder="billing@hospital.org" /></Field>
        <Field label="Coverage dates" hint="Every scheduled block. The END date is your LAST call day — the 24-hr call that ends the next morning. A contract reading 'through Aug 10, 7 AM' ends Aug 9; work after that final 7 AM bills hourly with no stipend.">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {(form.coveragePeriods || []).map((p, i) => (
              <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="date" value={p.start || ""} onChange={e => setForm(f => ({ ...f, coveragePeriods: f.coveragePeriods.map((x, j) => j === i ? { ...x, start: e.target.value } : x) }))} style={{ ...iS, minWidth: 0 }} />
                <span style={{ color: T.textDim, flexShrink: 0 }}>–</span>
                <input type="date" value={p.end || ""} onChange={e => setForm(f => ({ ...f, coveragePeriods: f.coveragePeriods.map((x, j) => j === i ? { ...x, end: e.target.value } : x) }))} style={{ ...iS, minWidth: 0 }} />
                <button onClick={() => setForm(f => ({ ...f, coveragePeriods: f.coveragePeriods.filter((_, j) => j !== i) }))} style={{ padding: "6px 10px", borderRadius: 8, border: "none", backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", fontSize: 14, fontWeight: 700, flexShrink: 0 }}>&times;</button>
              </div>
            ))}
            <button onClick={() => setForm(f => ({ ...f, coveragePeriods: [...(f.coveragePeriods || []), { start: "", end: "" }] }))} style={{
              padding: "10px", borderRadius: 10, border: `1px dashed ${T.border}`, backgroundColor: "transparent",
              color: T.accent, fontSize: 13, fontWeight: 700, cursor: "pointer",
            }}>+ Add a date block</button>
          </div>
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label="Day rate ($/day worked)" hint="Flat amount per day worked — leave blank if paid hourly"><input type="number" inputMode="decimal" value={form.dayRate ?? ""} onChange={e => setForm(f => ({ ...f, dayRate: e.target.value }))} style={iS} placeholder="2016.10" /></Field>
          <Field label="Call stipend ($/day)" hint="Flat amount per on-call day"><input type="number" inputMode="decimal" value={form.callStipend ?? ""} onChange={e => setForm(f => ({ ...f, callStipend: e.target.value }))} style={iS} placeholder="3000" /></Field>
          <Field label="Stipend covers (hours)" hint="Worked hours included before overage — 0 if the call rate includes none"><input type="number" inputMode="decimal" value={form.stipendHours ?? ""} onChange={e => setForm(f => ({ ...f, stipendHours: e.target.value }))} style={iS} placeholder="4" /></Field>
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
        <DocAttach setForm={setForm} attachedDocs={attachedDocs} setAttachedDocs={setAttachedDocs} analyzer={analyzeAgreement} textAnalyzer={analyzeAgreementText} />
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
                  <div onClick={() => setSummaryFor(item)} style={{ fontSize: 15, fontWeight: 700, color: T.text, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{item.facility || "Facility"}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: T.accent, flexShrink: 0 }}>summary ›</span>
                  </div>
                  {/* Identity + dates here — rate terms, docs, and notes
                      live on the summary page one tap away. */}
                  <div style={{ fontSize: 13, color: T.textDim, marginTop: 2 }}>
                    {[
                      item.agency,
                      item.location,
                      item.coveragePeriods?.length
                        ? item.coveragePeriods.map(p => `${formatDate(p.start)}${p.end && p.end !== p.start ? " – " + formatDate(p.end) : ""}`).join(", ")
                        : item.startDate && `${formatDate(item.startDate)}${item.endDate ? " – " + formatDate(item.endDate) : ""}`,
                    ].filter(Boolean).join(" · ")}
                  </div>
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

      {summaryFor && (
        <ContractSummary
          contract={summaryFor}
          onClose={() => setSummaryFor(null)}
          docs={linkedDocsFor(summaryFor.id)}
          onOpenDoc={(doc) => { if (!doc.data) return; if (doc.type?.startsWith("image/")) setLightbox(doc); else openPdfDoc(doc); }}
        />
      )}

      {/* Full-screen picture viewer for uploaded agreements */}
      {lightbox && (
        <div onClick={() => setLightbox(null)} style={{
          position: "fixed", inset: 0, zIndex: 100000, backgroundColor: "rgba(0,0,0,0.93)",
          display: "flex", alignItems: "center", justifyContent: "center", padding: 12,
        }}>
          <img src={lightbox.data} alt={lightbox.name} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
        </div>
      )}
    </div>
  );
}

export default memo(Contracts);
