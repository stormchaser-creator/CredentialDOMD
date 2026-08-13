import { memo, useMemo, useRef, useState } from "react";
import { useApp } from "../../../context/AppContext";
import EmptyState from "../../shared/EmptyState";
import Modal from "../../shared/Modal";
import { useInputStyle } from "../../shared/useInputStyle";
import { generateId, formatDate, nextInvoiceNumber } from "../../../utils/helpers";
import { invoicePdfFile, invoiceCoverBlurb, invoiceCoverEmail } from "../../../utils/invoicePdf";
import { TrashIcon, SendIcon, CameraIcon, UploadIcon } from "../../shared/Icons";

const money = (n) => `$${(parseFloat(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const CATEGORIES = ["Airfare", "Baggage", "Hotel", "Rental car", "Gas", "Rideshare / Taxi", "Parking", "Mileage", "Meals", "Other"];

/**
 * Travel expenses — billed to the LOCUMS AGENCY, not the hospital. Each
 * expense carries receipt photos/PDFs (stored as linked documents), and
 * "Invoice expenses" builds an expense invoice per agency and shares it
 * WITH every receipt attached, so proof travels with the bill.
 */
function Expenses() {
  const { data, addItem, editItem, deleteItem, theme: T } = useApp();
  const iS = useInputStyle();
  const expenses = useMemo(
    () => [...(data.travelExpenses || [])].sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))),
    [data.travelExpenses]
  );
  const contracts = data.locumContracts || [];
  const agencies = useMemo(
    () => [...new Set(contracts.map(c => c.agency).filter(Boolean))],
    [contracts]
  );

  const receiptsOf = (exp) => (data.documents || []).filter(d => d.linkedTo === `travelExpenses:${exp.id}`);

  // ── add / edit ──
  const [editing, setEditing] = useState(null); // "new" | expense id
  const [form, setForm] = useState({});
  const [pendingFiles, setPendingFiles] = useState([]); // receipts staged before save
  const [notice, setNotice] = useState(null);
  const cameraRef = useRef(null);
  const uploadRef = useRef(null);
  const showNotice = (t) => { setNotice(t); setTimeout(() => setNotice(null), 6000); };

  const openNew = () => {
    setEditing("new");
    setPendingFiles([]);
    setForm({ date: new Date().toISOString().slice(0, 10), category: "Airfare", agency: agencies[0] || "" });
  };
  const openEdit = (exp) => { setEditing(exp.id); setPendingFiles([]); setForm({ ...exp }); };

  const stageFiles = async (files) => {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith("image/") && f.type !== "application/pdf") continue;
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = rej; r.readAsDataURL(f);
      });
      setPendingFiles(p => [...p, { name: f.name || "receipt", type: f.type, dataUrl }]);
    }
  };

  const saveExpense = () => {
    const amount = parseFloat(form.amount);
    if (!form.date || !amount || amount <= 0) { showNotice("Date and a dollar amount are the minimum."); return; }
    const id = editing === "new" ? generateId() : editing;
    const rec = {
      ...form, id, amount: Math.round(amount * 100) / 100,
      vendor: (form.vendor || "").trim(), agency: (form.agency || "").trim(),
    };
    if (editing === "new") addItem("travelExpenses", rec);
    else editItem("travelExpenses", rec);
    for (const f of pendingFiles) {
      addItem("documents", {
        id: generateId(), name: f.name, type: f.type,
        size: Math.round((f.dataUrl.split(",")[1] || "").length * 0.75),
        data: f.dataUrl, uploadedAt: new Date().toISOString(),
        linkedTo: `travelExpenses:${id}`,
      });
    }
    setEditing(null); setPendingFiles([]);
  };

  const removeExpense = (exp) => {
    if (exp.invoiceId) { showNotice("This expense is on an invoice — delete the invoice first (Invoices tab) to release it."); return; }
    if (!window.confirm("Delete this expense? Its receipts stay in Files.")) return;
    deleteItem("travelExpenses", exp.id);
  };

  // ── invoicing ──
  const unbilled = expenses.filter(e => !e.invoiceId);
  const unbilledTotal = unbilled.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  const [invOpen, setInvOpen] = useState(false);
  const [invAgency, setInvAgency] = useState("");
  const [checked, setChecked] = useState({});
  const openInvoice = () => {
    const ag = unbilled[0]?.agency || agencies[0] || "";
    setInvAgency(ag);
    setChecked(Object.fromEntries(unbilled.map(e => [e.id, (e.agency || "") === ag])));
    setInvOpen(true);
  };
  const pickAgency = (ag) => {
    setInvAgency(ag);
    setChecked(Object.fromEntries(unbilled.map(e => [e.id, (e.agency || "") === ag])));
  };

  const [busy, setBusy] = useState(false);
  const sendExpenseInvoice = async () => {
    const sel = unbilled.filter(e => checked[e.id]);
    if (!sel.length) { showNotice("Nothing selected."); return; }
    setBusy(true);
    try {
      const s = data.settings || {};
      const number = nextInvoiceNumber(data.invoices).replace("INV-", "EXP-");
      const lines = [...sel].sort((a, b) => String(a.date).localeCompare(String(b.date))).map(e => ({
        date: e.date,
        label: `${e.category || "Expense"}${e.vendor ? ` — ${e.vendor}` : ""}`,
        detail: [e.notes, receiptsOf(e).length ? `receipt${receiptsOf(e).length > 1 ? "s" : ""} attached` : "no receipt"].filter(Boolean).join(" · "),
        amount: e.amount,
      }));
      const total = sel.reduce((t, e) => t + (parseFloat(e.amount) || 0), 0);
      const dates = sel.map(e => e.date).sort();
      const inv = {
        number,
        physician: s.name ? `${s.name}, ${s.degreeType || "MD"}` : "Physician",
        npi: s.npi, email: s.email,
        facility: invAgency || "Locums agency", // BILL TO: the agency itself
        periodStart: dates[0], periodEnd: dates[dates.length - 1],
        terms: "Reimbursable travel expenses per agreement — receipts attached.",
        lines, totalMin: 0, total,
      };
      const pdf = invoicePdfFile(inv);
      // Receipts ride along in the same share — proof travels with the bill.
      const receiptFiles = [];
      let missing = 0;
      for (const e of sel) {
        for (const d of receiptsOf(e)) {
          if (!d.data) { missing += 1; continue; }
          const byteStr = atob(d.data.split(",")[1]);
          const arr = new Uint8Array(byteStr.length);
          for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i);
          receiptFiles.push(new File([arr], d.name || "receipt", { type: d.type || "application/octet-stream" }));
        }
      }
      const files = [pdf, ...receiptFiles];
      // Cover letter to clipboard, flowing blurb as share text — otherwise
      // iOS Mail sends the attachments with an empty body.
      try { await navigator.clipboard.writeText(invoiceCoverEmail(inv)); } catch { /* clipboard unavailable */ }
      let how = null;
      if (navigator.canShare && navigator.canShare({ files })) {
        try { await navigator.share({ title: `Expense invoice ${number}`, text: invoiceCoverBlurb(inv), files }); how = "share"; }
        catch (err) { if (err?.name === "AbortError") { setBusy(false); return; } }
      }
      if (!how) {
        for (const f of files) {
          const url = URL.createObjectURL(f);
          const a = document.createElement("a");
          a.href = url; a.download = f.name; a.click();
          setTimeout(() => URL.revokeObjectURL(url), 15000);
        }
        how = "download";
      }
      const invoiceId = generateId();
      addItem("invoices", {
        id: invoiceId, number, contractId: null, kind: "expenses",
        billToLabel: invAgency || "Locums agency",
        periodStart: dates[0], periodEnd: dates[dates.length - 1],
        lines, totalAmount: total, totalMinutes: 0,
        entryIds: sel.map(e => e.id),
        sentAt: new Date().toISOString(),
        text: `Expense invoice ${number} — ${invAgency} — ${money(total)} (${sel.length} item${sel.length > 1 ? "s" : ""})`,
      });
      for (const e of sel) editItem("travelExpenses", { ...e, invoiceId });
      setInvOpen(false);
      showNotice(missing
        ? `Sent — but ${missing} receipt file${missing > 1 ? "s weren't" : " wasn't"} downloaded on this device and didn't attach.`
        : `Invoice ${number} sent with ${receiptFiles.length} receipt${receiptFiles.length === 1 ? "" : "s"} attached — tracked on the Invoices tab.`);
    } finally { setBusy(false); }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800, color: T.text }}>Travel expenses</div>
          <div style={{ fontSize: 12, color: T.textMuted }}>Billed to the locums agency, receipts attached.</div>
        </div>
        <button onClick={openNew} style={{
          padding: "10px 16px", borderRadius: 12, border: "none",
          backgroundColor: T.accent, color: "#fff", fontSize: 13.5, fontWeight: 800, cursor: "pointer",
        }}>+ Expense</button>
      </div>

      {notice && (
        <div style={{ padding: "11px 14px", borderRadius: 12, marginBottom: 10, backgroundColor: T.accent + "18", border: `1px solid ${T.accent}55`, fontSize: 13, color: T.text }}>{notice}</div>
      )}

      {unbilled.length > 0 && (
        <button onClick={openInvoice} style={{
          width: "100%", padding: "13px", borderRadius: 12, border: "none", marginBottom: 12,
          background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff",
          fontSize: 14.5, fontWeight: 800, cursor: "pointer",
        }}>Invoice {unbilled.length} expense{unbilled.length > 1 ? "s" : ""} — {money(unbilledTotal)}</button>
      )}

      {expenses.length === 0 ? (
        <EmptyState icon={"🧾"} title="No expenses yet"
          subtitle="Flights, hotels, rental cars — log each with a photo of the receipt, then invoice the agency in one tap." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {expenses.map(exp => {
            const rc = receiptsOf(exp).length;
            return (
              <div key={exp.id} onClick={() => openEdit(exp)} style={{
                backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 12,
                padding: "12px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 12,
              }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 700, color: T.text }}>
                    {exp.category}{exp.vendor ? ` — ${exp.vendor}` : ""}
                  </div>
                  <div style={{ fontSize: 12.5, color: T.textMuted, marginTop: 2 }}>
                    {formatDate(exp.date)}{exp.agency ? ` · ${exp.agency}` : ""}
                    {rc ? ` · 📎 ${rc}` : " · no receipt"}
                  </div>
                  {exp.invoiceId && (() => {
                    const inv = (data.invoices || []).find(i => i.id === exp.invoiceId);
                    if (!inv) return <div style={{ fontSize: 11.5, fontWeight: 800, marginTop: 3, color: T.textDim }}>billed</div>;
                    const total = parseFloat(inv.totalAmount) || 0;
                    const led = (inv.payments || []).reduce((t, p) => t + (parseFloat(p.amount) || 0), 0);
                    const paid = led > 0 ? led : (inv.paidAt ? total : 0);
                    const isPaid = paid >= total - 0.005;
                    return (
                      <div style={{ fontSize: 11.5, fontWeight: 800, marginTop: 3, color: isPaid ? (T.success || "#22c55e") : T.warning }}>
                        {inv.number} · {isPaid ? "PAID" : "owed"}{inv.sentAt ? ` · sent ${formatDate(String(inv.sentAt).slice(0, 10))}` : ""}
                      </div>
                    );
                  })()}
                </div>
                <div style={{ fontSize: 15, fontWeight: 800, color: exp.invoiceId ? T.textMuted : T.text }}>{money(exp.amount)}</div>
                {!exp.invoiceId && (
                  <button onClick={(ev) => { ev.stopPropagation(); removeExpense(exp); }} style={{
                    padding: "7px 9px", borderRadius: 10, border: "none",
                    backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", display: "flex",
                  }}><TrashIcon /></button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add / edit */}
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing === "new" ? "New expense" : "Expense"}>
        <div style={{ display: "flex", gap: 8 }}>
          <input type="date" value={form.date || ""} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} style={{ ...iS, flex: 1 }} />
          <input type="number" inputMode="decimal" placeholder="$ amount" value={form.amount ?? ""} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} style={{ ...iS, flex: 1 }} />
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "10px 0" }}>
          {CATEGORIES.map(c => (
            <button key={c} onClick={() => setForm(f => ({ ...f, category: c }))} style={{
              padding: "8px 12px", borderRadius: 14, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
              border: `1px solid ${form.category === c ? T.accent : T.border}`,
              backgroundColor: form.category === c ? T.accent : "transparent",
              color: form.category === c ? "#fff" : T.textMuted,
            }}>{c}</button>
          ))}
        </div>
        <input placeholder="Vendor (e.g. United, Marriott, Hertz)" value={form.vendor || ""} onChange={e => setForm(f => ({ ...f, vendor: e.target.value }))} style={{ ...iS, width: "100%", boxSizing: "border-box", marginBottom: 10 }} />
        <input list="expense-agencies" placeholder="Bill to agency (e.g. MPLT Healthcare)" value={form.agency || ""} onChange={e => setForm(f => ({ ...f, agency: e.target.value }))} style={{ ...iS, width: "100%", boxSizing: "border-box", marginBottom: 10 }} />
        <datalist id="expense-agencies">{agencies.map(a => <option key={a} value={a} />)}</datalist>
        <textarea placeholder="Notes (trip, assignment, confirmation #)" value={form.notes || ""} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={{ ...iS, width: "100%", boxSizing: "border-box", minHeight: 60, fontFamily: "inherit", marginBottom: 10 }} />

        {/* receipts */}
        <div style={{ fontSize: 12, fontWeight: 800, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Receipts</div>
        {editing !== "new" && receiptsOf({ id: editing }).map(d => (
          <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: `1px solid ${T.border}` }}>
            {d.type?.startsWith("image/") && d.data
              ? <img src={d.data} alt="" style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 8 }} />
              : <span style={{ fontSize: 20 }}>📄</span>}
            <span style={{ flex: 1, fontSize: 13, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</span>
          </div>
        ))}
        {pendingFiles.map((f, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: `1px solid ${T.border}` }}>
            {f.type.startsWith("image/")
              ? <img src={f.dataUrl} alt="" style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 8 }} />
              : <span style={{ fontSize: 20 }}>📄</span>}
            <span style={{ flex: 1, fontSize: 13, color: T.text }}>{f.name}</span>
            <button onClick={() => setPendingFiles(p => p.filter((_, j) => j !== i))} style={{ border: "none", background: "none", color: T.danger, cursor: "pointer", fontWeight: 800 }}>✕</button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button onClick={() => cameraRef.current?.click()} style={{
            flex: 1, padding: "11px", borderRadius: 10, border: `1px solid ${T.border}`,
            backgroundColor: "transparent", color: T.text, fontSize: 13, fontWeight: 700, cursor: "pointer",
            display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
          }}><CameraIcon /> Photo</button>
          <button onClick={() => uploadRef.current?.click()} style={{
            flex: 1, padding: "11px", borderRadius: 10, border: `1px solid ${T.border}`,
            backgroundColor: "transparent", color: T.text, fontSize: 13, fontWeight: 700, cursor: "pointer",
            display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
          }}><UploadIcon /> Upload</button>
        </div>
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={e => { stageFiles(e.target.files); e.target.value = ""; }} />
        <input ref={uploadRef} type="file" accept="image/*,application/pdf" multiple style={{ display: "none" }} onChange={e => { stageFiles(e.target.files); e.target.value = ""; }} />

        <button onClick={saveExpense} style={{
          width: "100%", marginTop: 14, padding: "13px", borderRadius: 12, border: "none",
          backgroundColor: T.accent, color: "#fff", fontSize: 14.5, fontWeight: 800, cursor: "pointer",
        }}>{editing === "new" ? "Add expense" : "Save"}</button>
      </Modal>

      {/* Invoice picker */}
      <Modal open={invOpen} onClose={() => !busy && setInvOpen(false)} title="Invoice expenses">
        <div style={{ fontSize: 12, fontWeight: 800, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Bill to</div>
        <input list="expense-agencies" value={invAgency} onChange={e => pickAgency(e.target.value)} style={{ ...iS, width: "100%", boxSizing: "border-box", marginBottom: 10 }} placeholder="Agency name" />
        {unbilled.map(e => (
          <label key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: `1px solid ${T.border}`, cursor: "pointer" }}>
            <input type="checkbox" checked={!!checked[e.id]} onChange={ev => setChecked(c => ({ ...c, [e.id]: ev.target.checked }))} />
            <span style={{ flex: 1, fontSize: 13.5, color: T.text }}>
              {formatDate(e.date)} · {e.category}{e.vendor ? ` — ${e.vendor}` : ""}
              {(e.agency || "") !== invAgency && e.agency ? ` (${e.agency})` : ""}
            </span>
            <span style={{ fontSize: 13.5, fontWeight: 800, color: T.text }}>{money(e.amount)}</span>
          </label>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", fontSize: 14, fontWeight: 800, color: T.text }}>
          <span>Total</span>
          <span>{money(unbilled.filter(e => checked[e.id]).reduce((s, e) => s + (parseFloat(e.amount) || 0), 0))}</span>
        </div>
        <button onClick={sendExpenseInvoice} disabled={busy} style={{
          width: "100%", marginTop: 6, padding: "13px", borderRadius: 12, border: "none",
          background: busy ? T.textDim : "linear-gradient(135deg, #10b981, #059669)", color: "#fff",
          fontSize: 14.5, fontWeight: 800, cursor: busy ? "wait" : "pointer",
        }}>{busy ? "Building…" : "Create & send with receipts"}</button>
        <div style={{ fontSize: 11.5, color: T.textMuted, marginTop: 8, textAlign: "center" }}>
          The share includes the invoice PDF plus every attached receipt.
        </div>
      </Modal>
    </div>
  );
}

export default memo(Expenses);
