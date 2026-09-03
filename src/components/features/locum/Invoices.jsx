import { memo, useMemo, useState } from "react";
import { useApp } from "../../../context/AppContext";
import EmptyState from "../../shared/EmptyState";
import Modal from "../../shared/Modal";
import DeskTable from "../../shared/DeskTable";
import { formatDate } from "../../../utils/helpers";
import { SendIcon, TrashIcon, ExternalLinkIcon, DollarIcon, UndoIcon } from "../../shared/Icons";
import { sortInvoiceLines, invoiceSubject, shareInvoiceText } from "../../../utils/invoicePdf";
import { exportInvoice } from "../../../utils/invoiceExport";
import InvoiceFormatChooser from "../../shared/InvoiceFormatChooser";
import { money } from "../../../utils/invoiceCover";

const daysSince = (iso) => Math.floor((Date.now() - new Date(iso)) / 86400000);

// Same 7am call-day boundary as the Work tab
const callDayOf = (e) => {
  if (e.startTime) {
    const x = new Date(new Date(e.startTime).getTime() - 7 * 3600 * 1000);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  }
  return e.date;
};

// Payments are a ledger, not a flag — agencies sometimes pay an invoice in
// pieces. Legacy invoices marked paid before the ledger existed count as
// paid in full.
const paidOf = (inv) => {
  const fromLedger = (inv.payments || []).reduce((s2, p) => s2 + (parseFloat(p.amount) || 0), 0);
  if (fromLedger > 0) return fromLedger;
  return inv.paidAt ? (parseFloat(inv.totalAmount) || 0) : 0;
};
// Written off = closed out without counting as money received, so tax
// estimates (which read paidOf/payments) never see a write-off as income.
const balanceOf = (inv) => inv.writeOffAt ? 0 : Math.max(0, (parseFloat(inv.totalAmount) || 0) - paidOf(inv));

/**
 * One invoice's standing, worked out in one place so the phone card and the
 * desk table read the same numbers and can never disagree. writtenOffAmt is
 * the remainder, not the amount collected (the Aug 26 headline fix).
 */
const standingOf = (inv) => {
  const total = parseFloat(inv.totalAmount) || 0;
  const paid = paidOf(inv);
  const writtenOff = !!inv.writeOffAt;
  const balance = balanceOf(inv);
  const isPaid = !writtenOff && balance <= 0.005;
  const isPartial = !writtenOff && !isPaid && paid > 0;
  const age = inv.sentAt ? daysSince(inv.sentAt) : 0;
  const overdue = !isPaid && !writtenOff && age > 30;
  return { total, paid, writtenOff, balance, isPaid, isPartial, age, overdue, writtenOffAmt: total - paid };
};

// Badge text and status tokens for a standing: the card's headline color and
// its badge share one tone, and the table's Status and Balance cells reuse it.
const toneOf = (st, T) => ({
  label: st.isPaid ? "paid" : st.writtenOff ? "written off" : st.isPartial ? "partial" : `owed · ${st.age}d`,
  color: st.isPaid ? T.success : st.writtenOff ? T.textMuted : st.overdue ? T.danger : T.warning,
  bg: st.isPaid ? T.successDim : st.writtenOff ? T.border + "55" : st.overdue ? T.dangerDim : T.warningDim,
});

// Compact service period for a table cell: "May 25–31, 2026", "May 25–Jun 3,
// 2026", or the full two-date form across a year boundary. Bad input falls
// back to formatDate's own handling.
const periodLabel = (start, end) => {
  if (!start) return "";
  if (!end || end === start) return formatDate(start);
  const a = new Date(`${start}T00:00:00`);
  const b = new Date(`${end}T00:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || a.getFullYear() !== b.getFullYear()) {
    return `${formatDate(start)}–${formatDate(end)}`;
  }
  const mo = (d) => d.toLocaleDateString("en-US", { month: "short" });
  const tail = `${b.getDate()}, ${b.getFullYear()}`;
  return a.getMonth() === b.getMonth()
    ? `${mo(a)} ${a.getDate()}–${tail}`
    : `${mo(a)} ${a.getDate()}–${mo(b)} ${tail}`;
};

function StandingBadge({ tone, style }) {
  return (
    <span style={{
      padding: "2px 8px", borderRadius: 8, fontSize: 10, fontWeight: 800,
      textTransform: "uppercase", letterSpacing: 0.5,
      backgroundColor: tone.bg, color: tone.color, ...style,
    }}>{tone.label}</span>
  );
}

/**
 * Invoices — every invoice sent from the Work tab, tracked sent → paid.
 * Mark paid when the money lands; unpaid invoices age visibly so nothing
 * slips. Deleting an invoice releases its work entries back to unbilled.
 */
function Invoices() {
  const { data, editItem, deleteItem, theme: T, isDesktop } = useApp();
  const [viewInv, setViewInv] = useState(null);
  const [notice, setNotice] = useState(null);
  const contracts = data.locumContracts || [];
  const facilityOf = (cid) => contracts.find(c => c.id === cid)?.facility || "Contract";
  const billNameOf = (inv) => inv.billToLabel || facilityOf(inv.contractId);

  // Newest SERVICE PERIOD first — sorting by sentAt put backfilled invoices
  // (entered later) above work that happened after them.
  const periodKey = (i) => String(i.periodEnd || i.periodStart || i.sentAt || "");
  const invoices = useMemo(
    () => [...(data.invoices || [])].sort((a, b) => periodKey(b).localeCompare(periodKey(a))),
    [data.invoices]
  );

  const outstanding = invoices.filter(i => balanceOf(i) > 0.005);
  // Written-off invoices have a zero balance but weren't actually paid —
  // keep them out of the "Paid" bucket so its total still means real income.
  const paidList = invoices.filter(i => !i.writeOffAt && balanceOf(i) <= 0.005);
  const sumOut = outstanding.reduce((s, i) => s + balanceOf(i), 0);
  const sumPaid = invoices.reduce((s, i) => s + paidOf(i), 0);
  const sumBilled = invoices.reduce((s, i) => s + (parseFloat(i.totalAmount) || 0), 0);

  // How much was billed each month, STRICTLY by the day the work was done:
  // every invoice line counts in the month its date falls in, an invoice
  // spanning two months splits between them, and nothing else — no invoice
  // counts, no payment math. Just the month and its number.
  const [showMonths, setShowMonths] = useState(false);
  const [showList, setShowList] = useState(null); // "outstanding" | "paid"
  const byMonth = useMemo(() => {
    const m = new Map();
    for (const inv of invoices) {
      const total = parseFloat(inv.totalAmount) || 0;
      const fallbackK = String(inv.periodStart || inv.sentAt || "").slice(0, 7);
      const moneyLines = (inv.lines || []).filter(l => l.amount != null);
      if (moneyLines.length) {
        const perMonth = new Map();
        for (const l of moneyLines) {
          const k = String(l.date || "").slice(0, 7) || fallbackK;
          if (!k) continue;
          perMonth.set(k, (perMonth.get(k) || 0) + (parseFloat(l.amount) || 0));
        }
        // Lines should sum to the invoice total; any rounding drift lands on
        // the largest month so the months always reconcile to the invoices.
        const lineSum = [...perMonth.values()].reduce((a, b) => a + b, 0);
        const drift = total - lineSum;
        if (Math.abs(drift) > 0.005 && perMonth.size) {
          const kMax = [...perMonth.entries()].sort((a, b) => b[1] - a[1])[0][0];
          perMonth.set(kMax, perMonth.get(kMax) + drift);
        }
        for (const [k, amt] of perMonth.entries()) m.set(k, (m.get(k) || 0) + amt);
      } else if (fallbackK) {
        m.set(fallbackK, (m.get(fallbackK) || 0) + total); // legacy invoice with no stored lines
      }
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
  const writeOffBalance = (inv) => editItem("invoices", { ...inv, writeOffAt: new Date().toISOString() });
  const undoWriteOff = (inv) => editItem("invoices", { ...inv, writeOffAt: null });

  // Format chooser state: which invoice is about to be sent, in what shape
  const [sendFor, setSendFor] = useState(null);
  const resend = async (inv, format = "pdf") => {
    const c = contracts.find(x => x.id === inv.contractId);
    const s = data.settings || {};
    const args = {
      number: inv.number,
      physician: s.name ? `${s.name}${s.degreeType ? `, ${s.degreeType}` : ""}` : "Physician",
      npi: s.npi, email: s.email,
      facility: c?.facility || billNameOf(inv), agency: c?.agency, location: c?.location, billTo: c?.billTo,
      periodStart: inv.periodStart, periodEnd: inv.periodEnd,
      terms: inv.terms, lines: inv.lines,
      totalMin: inv.totalMinutes, total: inv.totalAmount,
      // A resend can follow a payment — the document and cover must say so
      paid: paidOf(inv), balance: balanceOf(inv),
      issuedDate: inv.sentAt?.slice(0, 10),
    };
    const subject = invoiceSubject(args);
    // Rebuild the document from the stored line items when we have them
    if (inv.lines?.length) {
      const how = await exportInvoice(args, format, subject, inv.text);
      if (how && how.includes("+cover")) {
        setNotice("Sent with a short intro that reads correctly in Mail. The full cover letter is on your clipboard: paste it over the intro if you want the long form.");
        setTimeout(() => setNotice(null), 9000);
      }
      return;
    }
    // Legacy text-only invoice: short ones open a formatted CRLF mailto
    // composer; long ones (iOS Mail cuts a mailto body off) go out as a PDF
    // page through the share sheet. Either way the text is on the clipboard.
    const text = inv.text || `Invoice ${inv.number}: ${billNameOf(inv)}, ${money(inv.totalAmount)}`;
    const how = await shareInvoiceText(args, subject, text);
    if (how === "mailto-cover") {
      setNotice("This invoice is longer than Mail accepts from a link, so the composer opened with the cover letter. The full invoice is on your clipboard: paste it in below the letter.");
      setTimeout(() => setNotice(null), 12000);
    }
  };

  const removeInvoice = (inv) => {
    const mine = (data.workLog || []).filter(x => x.invoiceId === inv.id);
    // A day-rate invoice bills duty days, not time entries — release those too
    const mineDuty = (data.dutyDays || []).filter(x => x.invoiceId === inv.id);
    const mineExp = (data.travelExpenses || []).filter(x => x.invoiceId === inv.id);
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
    for (const x of mineExp) editItem("travelExpenses", { ...x, invoiceId: null });
    deleteItem("invoices", inv.id);
  };

  if (invoices.length === 0) {
    return (
      <EmptyState icon={"🧾"} title="No invoices yet"
        subtitle="Invoices you send from the Work tab land here, so you can track what's been sent and what's been paid." />
    );
  }

  // The three money tiles. Phone stacks Total billed above the heading and
  // the pair below it (Eric's placement); desk lines all three up as one
  // stat strip in the same spot. Same elements and handlers either way; the
  // desk flag only harmonizes their size so the strip reads as one row.
  const tileLabel = (desk) => desk
    ? { fontSize: 11, fontWeight: 800, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }
    : { fontSize: 11, color: T.textMuted };
  const totalTile = (desk) => (
    <div role="button" tabIndex={0}
      onClick={() => setShowMonths(true)}
      onKeyDown={(e) => { if (e.key === "Enter") setShowMonths(true); }}
      style={{
        backgroundColor: T.card, border: `2px solid ${T.accent}`, borderRadius: 14,
        padding: "14px 16px", marginBottom: desk ? 0 : 12, cursor: "pointer", boxShadow: T.shadow1,
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
  );
  const outstandingTile = (desk) => (
    <div role="button" tabIndex={0}
      onClick={() => setShowList("outstanding")}
      onKeyDown={(e) => { if (e.key === "Enter") setShowList("outstanding"); }}
      style={{ backgroundColor: T.card, border: `2px solid ${outstanding.length ? T.warning : T.border}`, borderRadius: desk ? 14 : 12, padding: desk ? "14px 16px" : "12px 14px", cursor: "pointer", boxShadow: desk ? T.shadow1 : undefined }}>
      <div style={tileLabel(desk)}>Awaiting payment</div>
      <div style={{ fontSize: desk ? 26 : 20, fontWeight: 800, color: outstanding.length ? T.warning : T.text, fontVariantNumeric: desk ? "tabular-nums" : undefined }}>{money(sumOut)}</div>
      <div style={{ fontSize: 11, color: T.textDim }}>{outstanding.length} invoice{outstanding.length === 1 ? "" : "s"} ›</div>
    </div>
  );
  const paidTile = (desk) => (
    <div role="button" tabIndex={0}
      onClick={() => setShowList("paid")}
      onKeyDown={(e) => { if (e.key === "Enter") setShowList("paid"); }}
      style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: desk ? 14 : 12, padding: desk ? "14px 16px" : "12px 14px", cursor: "pointer", boxShadow: desk ? T.shadow1 : undefined }}>
      <div style={tileLabel(desk)}>Paid</div>
      <div style={{ fontSize: desk ? 26 : 20, fontWeight: 800, color: T.success || "#22c55e", fontVariantNumeric: desk ? "tabular-nums" : undefined }}>{money(sumPaid)}</div>
      <div style={{ fontSize: 11, color: T.textDim }}>{paidList.length} invoice{paidList.length === 1 ? "" : "s"} ›</div>
    </div>
  );

  // Desk table cells: a main line and an optional muted sub-line, each
  // ellipsizing on its own inside the fixed-layout cell.
  const deskMain = { overflow: "hidden", textOverflow: "ellipsis" };
  const deskSub = { fontSize: 11, color: T.textDim, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis" };
  const deskBtn = {
    width: 26, height: 26, padding: 0, borderRadius: 8, border: "none", cursor: "pointer",
    display: "inline-flex", alignItems: "center", justifyContent: "center",
  };
  const deskGhostBtn = { ...deskBtn, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted };

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
          heading per Eric; every information bubble in this app pops up.
          At desk width it leads the three-tile stat strip in that same spot. */}
      {isDesktop ? (
        <div className="cmd-responsive-grid-3" style={{ marginBottom: 16 }}>
          {totalTile(true)}
          {outstandingTile(true)}
          {paidTile(true)}
        </div>
      ) : totalTile(false)}

      <Modal open={showMonths} onClose={() => setShowMonths(false)} title="Billed by month">
        <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 10 }}>
          Strictly by the day the work was done — an invoice spanning two months splits between them.
        </div>
        {byMonth.map(([k, amt]) => (
          <div key={k} style={{
            display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10,
            padding: "12px 2px", borderBottom: `1px solid ${T.border}`,
          }}>
            <div style={{ fontSize: 14.5, fontWeight: 800, color: T.text }}>{monthName(k)}</div>
            <div style={{ fontSize: 16, fontWeight: 800, color: T.text, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
              {money(amt)}
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

      {/* Outstanding vs paid — tappable, like every bubble in this app */}
      {!isDesktop && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
          {outstandingTile(false)}
          {paidTile(false)}
        </div>
      )}

      <Modal open={!!showList} onClose={() => setShowList(null)}
        title={showList === "outstanding" ? "Awaiting payment" : "Paid"}>
        {showList && (() => {
          const list = showList === "outstanding" ? outstanding : paidList;
          if (!list.length) {
            return <div style={{ fontSize: 13.5, color: T.textMuted, padding: "8px 0" }}>
              {showList === "outstanding" ? "Nothing outstanding — every invoice is settled." : "No invoices fully paid yet."}
            </div>;
          }
          return (
            <>
              <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 8 }}>Tap an invoice for its full detail.</div>
              {list.map(inv => {
                const age = inv.sentAt ? daysSince(inv.sentAt) : null;
                return (
                  <div key={inv.id} role="button" tabIndex={0}
                    onClick={() => { setShowList(null); setViewInv(inv); }}
                    onKeyDown={(e) => { if (e.key === "Enter") { setShowList(null); setViewInv(inv); } }}
                    style={{
                      display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10,
                      padding: "11px 2px", borderBottom: `1px solid ${T.border}`, cursor: "pointer",
                    }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 800, color: T.text }}>{inv.number}</div>
                      <div style={{ fontSize: 11.5, color: T.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {billNameOf(inv)}
                        {showList === "outstanding"
                          ? (inv.sentAt ? ` · sent ${formatDate(inv.sentAt.slice(0, 10))}${age >= 1 ? ` · ${age}d ago` : ""}` : "")
                          : (inv.paidAt ? ` · paid ${formatDate(inv.paidAt.slice(0, 10))}` : "")}
                        {showList === "outstanding" && paidOf(inv) > 0.005 && ` · ${money(paidOf(inv))} received`}
                      </div>
                    </div>
                    <div style={{
                      fontSize: 15, fontWeight: 800, flexShrink: 0, fontVariantNumeric: "tabular-nums",
                      color: showList === "outstanding" ? T.warning : (T.success || "#22c55e"),
                    }}>
                      {money(showList === "outstanding" ? balanceOf(inv) : paidOf(inv))}
                    </div>
                  </div>
                );
              })}
              <div style={{ display: "flex", justifyContent: "space-between", padding: "12px 2px 2px", fontSize: 15, fontWeight: 800, color: T.text }}>
                <span>Total</span>
                <span style={{ fontVariantNumeric: "tabular-nums", color: showList === "outstanding" ? T.warning : (T.success || "#22c55e") }}>
                  {money(showList === "outstanding" ? sumOut : sumPaid)}
                </span>
              </div>
            </>
          );
        })()}
      </Modal>

      {/* Tap an invoice to view it */}
      <Modal open={!!viewInv} onClose={() => setViewInv(null)} title={viewInv?.number || "Invoice"}>
        {viewInv && (
          <>
            <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 10 }}>
              {billNameOf(viewInv)}
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
              <button onClick={() => (viewInv.lines?.length ? setSendFor(viewInv) : resend(viewInv))} style={{
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
            <button onClick={() => {
              if (!payFor) return;
              if (window.confirm(`Write off the remaining ${money(balanceOf(payFor))} on ${payFor.number}? It closes the invoice without counting as money received — won't count toward income.`)) {
                writeOffBalance(payFor);
                setPayFor(null);
              }
            }} style={{
              width: "100%", padding: "11px", marginTop: 8, borderRadius: 12, border: `1px solid ${T.border}`,
              backgroundColor: "transparent", color: T.textMuted, fontSize: 13, fontWeight: 700, cursor: "pointer",
            }}>Write off remaining balance instead</button>
          </>
        )}
      </Modal>

      {isDesktop ? (
        /* Desk width: the same invoices as an AR table. Row click opens the
           existing detail modal (payment history + record-payment form); the
           quick actions are the card buttons' own handlers. Unpaid invoices
           lead, oldest first: a settled invoice has no receivable age, and a
           null sort value sinks it below every open one in either direction.
           Phone (the branch below) is untouched. */
        <DeskTable
          items={invoices}
          defaultSort={{ key: "age", dir: "desc" }}
          onRowClick={(inv) => setViewInv(inv)}
          actionsWidth={134}
          columns={[
            // Widths are percentages on purpose: pixel minimums would push the
            // Actions cell out of the clipped wrapper in a 1024px window.
            // Calibrated so every fixed-content column fits at a 1280px window
            // (966px table); Bill to takes the remainder and ellipsizes.
            { key: "number", label: "Number", width: "13.5%", render: inv => (
              <>
                <div style={{ ...deskMain, fontWeight: 700 }}>{inv.number}</div>
                {/* Total invoiced rides under the number, as it rides beside it on the card */}
                <div style={{ ...deskSub, fontVariantNumeric: "tabular-nums" }}>{money(inv.totalAmount)}</div>
              </>
            ) },
            { key: "billTo", label: "Bill to", value: inv => billNameOf(inv), render: inv => (
              <>
                <div style={deskMain} title={billNameOf(inv)}>{billNameOf(inv)}</div>
                {inv.periodStart && (
                  <div style={deskSub}>work {periodLabel(inv.periodStart, inv.periodEnd)}</div>
                )}
              </>
            ) },
            { key: "sentAt", label: "Sent", type: "date", width: "12%", render: inv => inv.sentAt ? formatDate(inv.sentAt.slice(0, 10)) : "\u2014" },
            { key: "age", label: "Age (days)", type: "number", width: "11.5%", align: "right",
              value: inv => { const st = standingOf(inv); return st.isPaid || st.writtenOff ? null : st.age; },
              render: inv => { const st = standingOf(inv); return st.isPaid || st.writtenOff ? "\u2014" : st.age; },
              color: inv => { const st = standingOf(inv); return st.overdue ? T.danger : (st.isPaid || st.writtenOff) ? T.textDim : T.text; } },
            { key: "paidAt", label: "Paid date", type: "date", width: "12%",
              value: inv => inv.paidAt || inv.writeOffAt || null,
              render: inv => inv.paidAt ? formatDate(inv.paidAt.slice(0, 10)) : inv.writeOffAt ? (
                <>
                  <div style={deskMain}>{formatDate(inv.writeOffAt.slice(0, 10))}</div>
                  <div style={deskSub}>written off</div>
                </>
              ) : "\u2014" },
            { key: "balance", label: "Balance", type: "number", width: "14%", align: "right",
              value: inv => balanceOf(inv),
              render: inv => {
                const st = standingOf(inv);
                const tone = toneOf(st, T);
                return (
                  <>
                    <div style={{ ...deskMain, fontWeight: 800, color: st.balance > 0.005 ? tone.color : T.textDim }}>{money(st.balance)}</div>
                    {(st.isPartial || (st.writtenOff && st.paid > 0.005)) && <div style={deskSub}>{money(st.paid)} received</div>}
                    {st.writtenOff && <div style={deskSub}>{money(st.writtenOffAmt)} written off</div>}
                  </>
                );
              } },
            { key: "status", label: "Status", type: "number", width: "12%",
              // Sorts by urgency rather than alphabet: overdue, owed, partial, paid, written off.
              value: inv => { const st = standingOf(inv); return st.isPaid ? 3 : st.writtenOff ? 4 : st.overdue ? 0 : st.isPartial ? 2 : 1; },
              render: inv => <StandingBadge tone={toneOf(standingOf(inv), T)} /> },
          ]}
          actions={(inv) => {
            const st = standingOf(inv);
            return (
              <div style={{ display: "inline-flex", gap: 2 }}>
                {st.writtenOff ? (
                  <button title="Undo write-off" aria-label="Undo write-off" onClick={(e) => { e.stopPropagation(); undoWriteOff(inv); }} style={deskGhostBtn}><UndoIcon /></button>
                ) : st.isPaid ? (
                  <button title="Reopen" aria-label="Reopen invoice" onClick={(e) => { e.stopPropagation(); markUnpaid(inv); }} style={deskGhostBtn}><UndoIcon /></button>
                ) : (
                  <button title={st.isPartial ? "Record another payment" : "Record payment"} aria-label="Record payment" onClick={(e) => { e.stopPropagation(); openPayment(inv); }} style={{ ...deskBtn, backgroundColor: T.successDim, color: T.success }}><DollarIcon /></button>
                )}
                <button title="Open" aria-label="Open invoice" onClick={(e) => { e.stopPropagation(); setViewInv(inv); }} style={deskGhostBtn}><ExternalLinkIcon /></button>
                <button title="Resend" aria-label="Resend invoice" onClick={(e) => { e.stopPropagation(); if (inv.lines?.length) setSendFor(inv); else resend(inv); }} style={{ ...deskBtn, backgroundColor: T.shareGlow, color: T.share }}><SendIcon /></button>
                <button title="Delete" aria-label="Delete invoice" onClick={(e) => { e.stopPropagation(); removeInvoice(inv); }} style={{ ...deskBtn, backgroundColor: T.dangerDim, color: T.danger }}><TrashIcon /></button>
              </div>
            );
          }}
        />
      ) : (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {invoices.map(inv => {
          const st = standingOf(inv);
          const { paid, writtenOff, balance, isPaid, isPartial, overdue } = st;
          const tone = toneOf(st, T);
          return (
            <div key={inv.id} onClick={() => setViewInv(inv)} style={{
              backgroundColor: T.card, borderRadius: 14, padding: "13px 15px", boxShadow: T.shadow1,
              border: `1px solid ${overdue ? T.danger : (isPaid || writtenOff) ? T.border : T.warning}`,
              cursor: "pointer",
            }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color: T.text }}>
                    {inv.number}
                    {/* Total invoiced rides next to the name — the loud number
                        on the right is what's still owed, the thing that
                        actually needs attention. */}
                    <span style={{ marginLeft: 8, fontSize: 12.5, fontWeight: 700, color: T.textMuted, fontVariantNumeric: "tabular-nums" }}>
                      {money(inv.totalAmount)}
                    </span>
                    <StandingBadge tone={tone} style={{ marginLeft: 8 }} />
                  </div>
                  <div style={{ fontSize: 13, color: T.textDim, marginTop: 2 }}>
                    {billNameOf(inv)}
                  </div>
                  <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>
                    Sent {inv.sentAt ? formatDate(inv.sentAt.slice(0, 10)) : "—"}
                    {inv.periodStart && ` · work ${formatDate(inv.periodStart)}${inv.periodEnd && inv.periodEnd !== inv.periodStart ? "–" + formatDate(inv.periodEnd) : ""}`}
                    {isPaid && inv.paidAt && ` · paid ${formatDate(inv.paidAt.slice(0, 10))}`}
                    {writtenOff && ` · written off ${formatDate(inv.writeOffAt.slice(0, 10))}`}
                  </div>
                  {isPartial && (
                    <div style={{ fontSize: 12, fontWeight: 700, color: T.warning, marginTop: 2 }}>
                      {money(paid)} received · {money(balance)} still owed
                    </div>
                  )}
                  {writtenOff && paid > 0.005 && (
                    <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, marginTop: 2 }}>
                      {money(paid)} received · {money(st.writtenOffAmt)} written off
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", flexShrink: 0 }}>
                  <div style={{ fontSize: 17, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: tone.color }}>
                    {isPaid ? money(inv.totalAmount) : writtenOff ? money(st.writtenOffAmt) : money(balance)}
                  </div>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.4 }}>
                    {isPaid ? "collected" : writtenOff ? "written off" : "owed to you"}
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                {writtenOff ? (
                  <button onClick={(ev) => { ev.stopPropagation(); undoWriteOff(inv); }} style={{
                    padding: "8px 12px", borderRadius: 10, border: `1px solid ${T.border}`,
                    backgroundColor: "transparent", color: T.textMuted, fontSize: 12, fontWeight: 700, cursor: "pointer",
                  }}>Undo write-off</button>
                ) : isPaid ? (
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
                <button onClick={(ev) => { ev.stopPropagation(); if (inv.lines?.length) setSendFor(inv); else resend(inv); }} style={{
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
      )}

      <InvoiceFormatChooser open={!!sendFor} onClose={() => setSendFor(null)}
        onPick={(f) => { const inv = sendFor; setSendFor(null); resend(inv, f); }} />
    </div>
  );
}

export default memo(Invoices);
