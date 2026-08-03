import { memo, useMemo, useState } from "react";
import { useApp } from "../../../context/AppContext";
import EmptyState from "../../shared/EmptyState";
import Modal from "../../shared/Modal";
import { formatDate } from "../../../utils/helpers";
import { SendIcon, TrashIcon } from "../../shared/Icons";
import { shareInvoicePdf, sortInvoiceLines } from "../../../utils/invoicePdf";

const money = (n) => `$${(parseFloat(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const daysSince = (iso) => Math.floor((Date.now() - new Date(iso)) / 86400000);

// Same 7am call-day boundary as the Work tab
const callDayOf = (e) => {
  if (e.startTime) {
    const x = new Date(new Date(e.startTime).getTime() - 7 * 3600 * 1000);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  }
  return e.date;
};

/**
 * Invoices — every invoice sent from the Work tab, tracked sent → paid.
 * Mark paid when the money lands; unpaid invoices age visibly so nothing
 * slips. Deleting an invoice releases its work entries back to unbilled.
 */
function Invoices() {
  const { data, editItem, deleteItem, theme: T } = useApp();
  const [viewInv, setViewInv] = useState(null);
  const [notice, setNotice] = useState(null);
  const contracts = data.locumContracts || [];
  const facilityOf = (cid) => contracts.find(c => c.id === cid)?.facility || "Contract";

  const invoices = useMemo(
    () => [...(data.invoices || [])].sort((a, b) => (b.sentAt || "").localeCompare(a.sentAt || "")),
    [data.invoices]
  );
  // Payments are a ledger, not a flag — agencies sometimes pay an invoice in
  // pieces. Legacy invoices marked paid before the ledger existed count as
  // paid in full.
  const paidOf = (inv) => {
    const fromLedger = (inv.payments || []).reduce((s2, p) => s2 + (parseFloat(p.amount) || 0), 0);
    if (fromLedger > 0) return fromLedger;
    return inv.paidAt ? (parseFloat(inv.totalAmount) || 0) : 0;
  };
  const balanceOf = (inv) => Math.max(0, (parseFloat(inv.totalAmount) || 0) - paidOf(inv));

  const outstanding = invoices.filter(i => balanceOf(i) > 0.005);
  const paidList = invoices.filter(i => balanceOf(i) <= 0.005);
  const sumOut = outstanding.reduce((s, i) => s + balanceOf(i), 0);
  const sumPaid = invoices.reduce((s, i) => s + paidOf(i), 0);
  const sumBilled = invoices.reduce((s, i) => s + (parseFloat(i.totalAmount) || 0), 0);

  // Billed by SERVICE month (the invoice period), not the month it was sent
  // — a July invoice sent August 3rd is July earnings.
  const [showMonths, setShowMonths] = useState(false);
  const byMonth = useMemo(() => {
    const m = new Map();
    for (const inv of invoices) {
      const k = String(inv.periodStart || inv.sentAt || "").slice(0, 7);
      if (!k) continue;
      const cur = m.get(k) || { billed: 0, paid: 0, count: 0 };
      cur.billed += parseFloat(inv.totalAmount) || 0;
      cur.paid += paidOf(inv);
      cur.count += 1;
      m.set(k, cur);
    }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [invoices]);
  const monthName = (k) => {
    const [y, mo] = k.split("-").map(Number);
    const d = new Date(y, (mo || 1) - 1, 1);
    return isNaN(d) ? k : d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  };

  const [payFor, setPayFor] = useState(null);
  const [payAmt, setPayAmt] = useState("");
  const [payDate, setPayDate] = useState("");
  const [payNote, setPayNote] = useState("");
  const openPayment = (inv) => {
    setPayFor(inv);
    setPayAmt(String(balanceOf(inv).toFixed(2)));
    const now = new Date();
    setPayDate(new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10));
    setPayNote("");
  };
  const savePayment = () => {
    const amt = parseFloat(payAmt);
    if (!payFor || !amt || amt <= 0) return;
    const payments = [...(payFor.payments || []), { amount: amt, date: payDate, note: payNote.trim() }];
    const total = parseFloat(payFor.totalAmount) || 0;
    const paid = payments.reduce((s2, p2) => s2 + (parseFloat(p2.amount) || 0), 0);
    editItem("invoices", {
      ...payFor,
      payments,
      // paidAt = settled in full; a partial payment leaves it open
      paidAt: paid >= total - 0.005 ? (payFor.paidAt || new Date().toISOString()) : null,
    });
    setPayFor(null);
  };
  const markUnpaid = (inv) => editItem("invoices", { ...inv, paidAt: null, payments: [] });

  const resend = async (inv) => {
    // Rebuild the PDF from the stored line items when we have them
    if (inv.lines?.length) {
      const c = contracts.find(x => x.id === inv.contractId);
      const s = data.settings || {};
      const how = await shareInvoicePdf({
        number: inv.number,
        physician: s.name ? `${s.name}, ${s.degreeType || "MD"}` : "Physician",
        npi: s.npi, email: s.email,
        facility: c?.facility, agency: c?.agency, location: c?.location, billTo: c?.billTo,
        periodStart: inv.periodStart, periodEnd: inv.periodEnd,
        terms: inv.terms, lines: inv.lines,
        totalMin: inv.totalMinutes, total: inv.totalAmount,
        issuedDate: inv.sentAt?.slice(0, 10),
      }, `Invoice ${inv.number}`, inv.text);
      if (how && how.includes("+cover")) {
        setNotice("The cover email is on your clipboard — if Mail squashed the message body into one line, select it and paste to get the proper letter.");
        setTimeout(() => setNotice(null), 9000);
      }
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
    const mine = (data.workLog || []).filter(x => x.invoiceId === inv.id);
    // A day-rate invoice bills duty days, not time entries — release those too
    const mineDuty = (data.dutyDays || []).filter(x => x.invoiceId === inv.id);
    const n = mine.length + mineDuty.length;
    // Two invoices can share a call day (stipend billed on one, late-logged
    // work on the other). Deleting only one of them makes the stipend math
    // unrecoverable — the fix is always to delete both and regenerate.
    const myDays = new Set(mine.map(callDayOf));
    const shared = (data.workLog || []).some(x =>
      x.invoiceId && x.invoiceId !== inv.id && x.contractId === inv.contractId && myDays.has(callDayOf(x)));
    const warn = shared
      ? `Careful: another invoice also bills work on the same call day(s). Deleting just this one breaks the stipend math for those days — delete BOTH invoices and regenerate one invoice instead. Delete anyway?`
      : `Delete invoice ${inv.number}? Its ${n} ${mineDuty.length ? `day${n === 1 ? "" : "s"}` : `work entr${n === 1 ? "y" : "ies"}`} become unbilled again.`;
    if (!window.confirm(warn)) return;
    for (const e of (data.workLog || []).filter(x => x.invoiceId === inv.id)) {
      // Zero-minute markers exist only as this invoice's billing record —
      // remove them; real work entries just become unbilled again.
      if (e.type === "CallDay" && !e.billedMin) deleteItem("workLog", e.id);
      else editItem("workLog", { ...e, invoiceId: null });
    }
    for (const d of mineDuty) editItem("dutyDays", { ...d, invoiceId: null });
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
      {notice && (
        <div style={{
          padding: "12px 14px", borderRadius: 12, marginBottom: 10,
          backgroundColor: T.accent + "18", border: `1px solid ${T.accent}55`,
          fontSize: 13, fontWeight: 600, color: T.text, lineHeight: 1.45,
        }}>{notice}</div>
      )}
      {/* Total earnings bubble — tap for the month-by-month. Sits above the
          heading per Eric; every information bubble in this app pops up. */}
      <div role="button" tabIndex={0}
        onClick={() => setShowMonths(true)}
        onKeyDown={(e) => { if (e.key === "Enter") setShowMonths(true); }}
        style={{
          backgroundColor: T.card, border: `2px solid ${T.accent}`, borderRadius: 14,
          padding: "14px 16px", marginBottom: 12, cursor: "pointer", boxShadow: T.shadow1,
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10,
        }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>
            Total billed
          </div>
          <div style={{ fontSize: 26, fontWeight: 800, color: T.text, fontVariantNumeric: "tabular-nums" }}>
            {money(sumBilled)}
          </div>
          <div style={{ fontSize: 11.5, color: T.textDim }}>
            paid {money(sumPaid)} · awaiting {money(sumOut)}
          </div>
        </div>
        <div style={{ fontSize: 12, fontWeight: 700, color: T.accent, flexShrink: 0 }}>by month ›</div>
      </div>

      <Modal open={showMonths} onClose={() => setShowMonths(false)} title="Billed by month">
        <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 10 }}>
          Grouped by the month the work was done (the invoice period), not the day it was sent.
        </div>
        {byMonth.map(([k, v]) => (
          <div key={k} style={{
            display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10,
            padding: "10px 2px", borderBottom: `1px solid ${T.border}`,
          }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 800, color: T.text }}>{monthName(k)}</div>
              <div style={{ fontSize: 11.5, color: T.textDim }}>
                {v.count} invoice{v.count === 1 ? "" : "s"}
                {v.paid > 0.005 && v.paid < v.billed - 0.005 && ` · paid ${money(v.paid)}`}
                {v.paid >= v.billed - 0.005 && " · paid in full"}
                {v.paid <= 0.005 && " · unpaid"}
              </div>
            </div>
            <div style={{ fontSize: 16, fontWeight: 800, color: T.text, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
              {money(v.billed)}
            </div>
          </div>
        ))}
        <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 2px 2px", fontSize: 15, fontWeight: 800, color: T.text }}>
          <span>Total</span>
          <span style={{ color: T.accent, fontVariantNumeric: "tabular-nums" }}>{money(sumBilled)}</span>
        </div>
      </Modal>

      <div style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: T.text }}>Invoices</h3>
        <div style={{ fontSize: 12, color: T.textMuted }}>Record each payment as it lands — partials count too.</div>
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
            {(viewInv.payments || []).length > 0 && (
              <div style={{ marginBottom: 10, padding: "10px 12px", borderRadius: 10, backgroundColor: T.input, border: `1px solid ${T.border}` }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>Payments received</div>
                {(viewInv.payments || []).map((p2, i2) => (
                  <div key={i2} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: T.text, marginBottom: 2 }}>
                    <span>{p2.date ? formatDate(p2.date) : "—"}{p2.note ? ` · ${p2.note}` : ""}</span>
                    <span style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{money(p2.amount)}</span>
                  </div>
                ))}
                {balanceOf(viewInv) > 0.005 && (
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 800, color: T.warning, marginTop: 6, paddingTop: 6, borderTop: `1px solid ${T.border}` }}>
                    <span>Still owed</span><span>{money(balanceOf(viewInv))}</span>
                  </div>
                )}
              </div>
            )}
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
                  {sortInvoiceLines(viewInv.lines).map((l, i) => (
                    <tr key={i}>
                      <td style={{ padding: "6px 6px", borderBottom: `1px solid ${T.border}`, color: T.textDim, whiteSpace: "nowrap", verticalAlign: "top" }}>
                        {l.date ? formatDate(l.date) : ""}
                      </td>
                      <td style={{ padding: "6px 6px", borderBottom: `1px solid ${T.border}`, color: T.text, verticalAlign: "top" }}>
                        <div style={{ fontWeight: l.amount == null ? 500 : 700, paddingLeft: l.amount == null ? 10 : 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{l.label}</div>
                        {l.detail && <div style={{ fontSize: 11, color: T.textMuted, whiteSpace: "pre-line", paddingLeft: l.amount == null ? 10 : 0 }}>{l.detail}</div>}
                      </td>
                      <td style={{ padding: "6px 6px", borderBottom: `1px solid ${T.border}`, textAlign: "right", fontWeight: 700, whiteSpace: "nowrap", verticalAlign: "top", color: l.amount ? T.text : l.flag === "included" ? (T.success || T.accent) : T.textDim, fontSize: l.amount == null ? 11 : undefined }}>
                        {l.amount == null ? (l.flag || "") : money(l.amount)}
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

      {/* Record a payment — full or partial */}
      <Modal open={!!payFor} onClose={() => setPayFor(null)} title={payFor ? `Payment on ${payFor.number}` : "Payment"}>
        {payFor && (
          <>
            <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 10 }}>
              Invoice total {money(payFor.totalAmount)}
              {paidOf(payFor) > 0 && ` · ${money(paidOf(payFor))} already received`}
              {` · ${money(balanceOf(payFor))} open`}
            </div>
            <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, marginBottom: 4 }}>Amount received</div>
            <input type="number" inputMode="decimal" value={payAmt} onChange={e => setPayAmt(e.target.value)}
              style={{ width: "100%", padding: "12px", borderRadius: 10, backgroundColor: T.input, border: `1px solid ${T.border}`, color: T.text, fontSize: 16, boxSizing: "border-box", marginBottom: 10 }} />
            <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, marginBottom: 4 }}>Date received</div>
            <input type="date" value={payDate} onChange={e => setPayDate(e.target.value)}
              style={{ width: "100%", padding: "12px", borderRadius: 10, backgroundColor: T.input, border: `1px solid ${T.border}`, color: T.text, fontSize: 16, boxSizing: "border-box", marginBottom: 10 }} />
            <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, marginBottom: 4 }}>Note (check #, remittance, what it covered)</div>
            <input value={payNote} onChange={e => setPayNote(e.target.value)} placeholder="optional"
              style={{ width: "100%", padding: "12px", borderRadius: 10, backgroundColor: T.input, border: `1px solid ${T.border}`, color: T.text, fontSize: 16, boxSizing: "border-box", marginBottom: 12 }} />
            {parseFloat(payAmt) > balanceOf(payFor) + 0.005 && (
              <div style={{ fontSize: 12, fontWeight: 700, color: T.warning, marginBottom: 10 }}>
                That's more than the open balance — double-check the amount.
              </div>
            )}
            <button onClick={savePayment} disabled={!(parseFloat(payAmt) > 0)} style={{
              width: "100%", padding: "13px", borderRadius: 12, border: "none",
              backgroundColor: parseFloat(payAmt) > 0 ? (T.success || "#22c55e") : T.border,
              color: "#fff", fontSize: 15, fontWeight: 800, cursor: parseFloat(payAmt) > 0 ? "pointer" : "default",
            }}>
              {payFor && parseFloat(payAmt) >= balanceOf(payFor) - 0.005 ? "Record — settles the invoice" : "Record partial payment"}
            </button>
          </>
        )}
      </Modal>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {invoices.map(inv => {
          const paid = paidOf(inv);
          const balance = balanceOf(inv);
          const isPaid = balance <= 0.005;
          const isPartial = !isPaid && paid > 0;
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
                      {isPaid ? "paid" : isPartial ? `partial · ${money(balance)} owed` : `owed · ${age}d`}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: T.textDim, marginTop: 2 }}>
                    {facilityOf(inv.contractId)}
                  </div>
                  <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>
                    Sent {inv.sentAt ? formatDate(inv.sentAt.slice(0, 10)) : "—"}
                    {inv.periodStart && ` · work ${formatDate(inv.periodStart)}${inv.periodEnd && inv.periodEnd !== inv.periodStart ? "–" + formatDate(inv.periodEnd) : ""}`}
                    {isPaid && inv.paidAt && ` · paid ${formatDate(inv.paidAt.slice(0, 10))}`}
                  </div>
                  {isPartial && (
                    <div style={{ fontSize: 12, fontWeight: 700, color: T.warning, marginTop: 2 }}>
                      {money(paid)} received · {money(balance)} still owed
                    </div>
                  )}
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
                  }}>Reopen</button>
                ) : (
                  <button onClick={(ev) => { ev.stopPropagation(); openPayment(inv); }} style={{
                    flex: 1, padding: "8px 12px", borderRadius: 10, border: "none",
                    backgroundColor: T.success || "#22c55e", color: "#fff", fontSize: 12, fontWeight: 800, cursor: "pointer",
                  }}>{isPartial ? "＄ Record another payment" : "＄ Record payment"}</button>
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
