import { memo, useMemo, useState } from "react";
import { useApp } from "../../../context/AppContext";
import EmptyState from "../../shared/EmptyState";
import Modal from "../../shared/Modal";
import { formatDate } from "../../../utils/helpers";
import { SendIcon, TrashIcon } from "../../shared/Icons";
import { shareInvoicePdf } from "../../../utils/invoicePdf";

const money = (n) => `$${(parseFloat(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const daysSince = (iso) => Math.floor((Date.now() - new Date(iso)) / 86400000);

/**
 * Invoices — every invoice sent from the Work tab, tracked sent → paid.
 * Mark paid when the money lands; unpaid invoices age visibly so nothing
 * slips. Deleting an invoice releases its work entries back to unbilled.
 */
function Invoices() {
  const { data, editItem, deleteItem, theme: T } = useApp();
  const [viewInv, setViewInv] = useState(null);
  const contracts = data.locumContracts || [];
  const facilityOf = (cid) => contracts.find(c => c.id === cid)?.facility || "Contract";

  const invoices = useMemo(
    () => [...(data.invoices || [])].sort((a, b) => (b.sentAt || "").localeCompare(a.sentAt || "")),
    [data.invoices]
  );
  const outstanding = invoices.filter(i => !i.paidAt);
  const paidList = invoices.filter(i => i.paidAt);
  const sumOut = outstanding.reduce((s, i) => s + (parseFloat(i.totalAmount) || 0), 0);
  const sumPaid = paidList.reduce((s, i) => s + (parseFloat(i.totalAmount) || 0), 0);

  const markPaid = (inv) => editItem("invoices", { ...inv, paidAt: new Date().toISOString() });
  const markUnpaid = (inv) => editItem("invoices", { ...inv, paidAt: null });

  const resend = async (inv) => {
    // Rebuild the PDF from the stored line items when we have them
    if (inv.lines?.length) {
      const c = contracts.find(x => x.id === inv.contractId);
      const s = data.settings || {};
      await shareInvoicePdf({
        number: inv.number,
        physician: s.name ? `${s.name}, ${s.degreeType || "MD"}` : "Physician",
        npi: s.npi, email: s.email,
        facility: c?.facility, agency: c?.agency, location: c?.location, billTo: c?.billTo,
        periodStart: inv.periodStart, periodEnd: inv.periodEnd,
        terms: inv.terms, lines: inv.lines,
        totalMin: inv.totalMinutes, total: inv.totalAmount,
        issuedDate: inv.sentAt?.slice(0, 10),
      }, `Invoice ${inv.number}`);
      return;
    }
    const text = inv.text || `Invoice ${inv.number} — ${facilityOf(inv.contractId)} — ${money(inv.totalAmount)}`;
    if (navigator.share) {
      try { await navigator.share({ title: `Invoice ${inv.number}`, text }); } catch { /* user cancelled */ }
      return;
    }
    window.open(`mailto:?subject=${encodeURIComponent(`Invoice ${inv.number}`)}&body=${encodeURIComponent(text)}`, "_blank");
  };

  const removeInvoice = (inv) => {
    const n = (data.workLog || []).filter(x => x.invoiceId === inv.id).length;
    if (!window.confirm(`Delete invoice ${inv.number}? Its ${n} work entr${n === 1 ? "y" : "ies"} become unbilled again.`)) return;
    for (const e of (data.workLog || []).filter(x => x.invoiceId === inv.id)) {
      editItem("workLog", { ...e, invoiceId: null });
    }
    deleteItem("invoices", inv.id);
  };

  if (invoices.length === 0) {
    return (
      <EmptyState icon={"🧾"} title="No invoices yet"
        subtitle="Invoices you send from the Work tab land here, so you can track what's been sent and what's been paid." />
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: T.text }}>Invoices</h3>
        <div style={{ fontSize: 12, color: T.textMuted }}>Mark each one paid when the money lands.</div>
      </div>

      {/* Outstanding vs paid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
        <div style={{ backgroundColor: T.card, border: `2px solid ${outstanding.length ? T.warning : T.border}`, borderRadius: 12, padding: "12px 14px" }}>
          <div style={{ fontSize: 11, color: T.textMuted }}>Awaiting payment</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: outstanding.length ? T.warning : T.text }}>{money(sumOut)}</div>
          <div style={{ fontSize: 11, color: T.textDim }}>{outstanding.length} invoice{outstanding.length === 1 ? "" : "s"}</div>
        </div>
        <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: "12px 14px" }}>
          <div style={{ fontSize: 11, color: T.textMuted }}>Paid</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: T.success || "#22c55e" }}>{money(sumPaid)}</div>
          <div style={{ fontSize: 11, color: T.textDim }}>{paidList.length} invoice{paidList.length === 1 ? "" : "s"}</div>
        </div>
      </div>

      {/* Tap an invoice to view it */}
      <Modal open={!!viewInv} onClose={() => setViewInv(null)} title={viewInv?.number || "Invoice"}>
        {viewInv && (
          <>
            <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 10 }}>
              {facilityOf(viewInv.contractId)}
              {viewInv.sentAt && ` · sent ${formatDate(viewInv.sentAt.slice(0, 10))}`}
              {viewInv.paidAt && ` · paid ${formatDate(viewInv.paidAt.slice(0, 10))}`}
            </div>
            {viewInv.lines?.length ? (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr>
                    {["Date", "Item", "Amount"].map((h, i) => (
                      <th key={h} style={{
                        textAlign: i === 2 ? "right" : "left", padding: "6px 6px",
                        borderBottom: `2px solid ${T.accent}`, color: T.textMuted,
                        fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5,
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {viewInv.lines.map((l, i) => (
                    <tr key={i}>
                      <td style={{ padding: "6px 6px", borderBottom: `1px solid ${T.border}`, color: T.textDim, whiteSpace: "nowrap", verticalAlign: "top" }}>
                        {l.date ? formatDate(l.date) : ""}
                      </td>
                      <td style={{ padding: "6px 6px", borderBottom: `1px solid ${T.border}`, color: T.text, verticalAlign: "top" }}>
                        <div style={{ fontWeight: 700 }}>{l.label}</div>
                        {l.detail && <div style={{ fontSize: 11, color: T.textMuted }}>{l.detail}</div>}
                      </td>
                      <td style={{ padding: "6px 6px", borderBottom: `1px solid ${T.border}`, textAlign: "right", fontWeight: 700, whiteSpace: "nowrap", verticalAlign: "top", color: l.amount ? T.text : T.textDim }}>
                        {money(l.amount)}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={2} style={{ padding: "8px 6px", fontWeight: 800, color: T.text }}>TOTAL DUE</td>
                    <td style={{ padding: "8px 6px", textAlign: "right", fontWeight: 800, fontSize: 14, color: T.accent }}>
                      {money(viewInv.totalAmount)}
                    </td>
                  </tr>
                </tbody>
              </table>
            ) : (
              <div style={{
                backgroundColor: T.input, border: `1px solid ${T.border}`, borderRadius: 10,
                padding: 12, fontFamily: "monospace", fontSize: 12, color: T.text, whiteSpace: "pre-wrap",
              }}>
                {viewInv.text || `Invoice ${viewInv.number} — ${money(viewInv.totalAmount)}`}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
              <button onClick={() => resend(viewInv)} style={{
                padding: "12px 18px", borderRadius: 10, border: "none",
                backgroundColor: T.accent, color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer",
              }}>Share PDF</button>
            </div>
          </>
        )}
      </Modal>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {invoices.map(inv => {
          const isPaid = !!inv.paidAt;
          const age = inv.sentAt ? daysSince(inv.sentAt) : 0;
          const overdue = !isPaid && age > 30;
          return (
            <div key={inv.id} onClick={() => setViewInv(inv)} style={{
              backgroundColor: T.card, borderRadius: 14, padding: "13px 15px", boxShadow: T.shadow1,
              border: `1px solid ${overdue ? T.danger : isPaid ? T.border : T.warning}`,
              cursor: "pointer",
            }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: T.text }}>
                    {inv.number}
                    <span style={{
                      marginLeft: 8, padding: "2px 8px", borderRadius: 8, fontSize: 10, fontWeight: 800,
                      textTransform: "uppercase", letterSpacing: 0.5,
                      backgroundColor: isPaid ? (T.successDim || "rgba(34,197,94,0.15)") : overdue ? T.dangerDim : T.warningDim,
                      color: isPaid ? (T.success || "#22c55e") : overdue ? T.danger : T.warning,
                    }}>
                      {isPaid ? "paid" : `owed · ${age}d`}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: T.textDim, marginTop: 2 }}>
                    {facilityOf(inv.contractId)}
                  </div>
                  <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>
                    Sent {inv.sentAt ? formatDate(inv.sentAt.slice(0, 10)) : "—"}
                    {inv.periodStart && ` · work ${formatDate(inv.periodStart)}${inv.periodEnd && inv.periodEnd !== inv.periodStart ? "–" + formatDate(inv.periodEnd) : ""}`}
                    {isPaid && ` · paid ${formatDate(inv.paidAt.slice(0, 10))}`}
                  </div>
                </div>
                <div style={{ fontSize: 15, fontWeight: 800, color: T.text, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                  {money(inv.totalAmount)}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                {isPaid ? (
                  <button onClick={(ev) => { ev.stopPropagation(); markUnpaid(inv); }} style={{
                    padding: "8px 12px", borderRadius: 10, border: `1px solid ${T.border}`,
                    backgroundColor: "transparent", color: T.textMuted, fontSize: 12, fontWeight: 700, cursor: "pointer",
                  }}>Mark unpaid</button>
                ) : (
                  <button onClick={(ev) => { ev.stopPropagation(); markPaid(inv); }} style={{
                    flex: 1, padding: "8px 12px", borderRadius: 10, border: "none",
                    backgroundColor: T.success || "#22c55e", color: "#fff", fontSize: 12, fontWeight: 800, cursor: "pointer",
                  }}>✓ Mark paid</button>
                )}
                <button onClick={(ev) => { ev.stopPropagation(); resend(inv); }} style={{
                  padding: "8px 12px", borderRadius: 10, border: "none",
                  backgroundColor: T.shareGlow, color: T.share, fontSize: 12, fontWeight: 700, cursor: "pointer",
                  display: "inline-flex", alignItems: "center", gap: 5,
                }}><SendIcon /> Resend</button>
                <button onClick={(ev) => { ev.stopPropagation(); removeInvoice(inv); }} style={{
                  padding: "8px 10px", borderRadius: 10, border: "none",
                  backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", display: "flex", alignItems: "center",
                }}><TrashIcon /></button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default memo(Invoices);
