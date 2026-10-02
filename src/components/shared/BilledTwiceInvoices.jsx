import { useMemo } from "react";
import { useApp } from "../../context/AppContext";
import { invoicesBilledTwice, billedTwiceTitle, billedTwiceLine } from "../../utils/invoiceRecord";
import { TAP_MIN } from "./actionButton";

/**
 * Recorded invoices that bill items another recorded invoice holds
 * (invoiceRecord.invoicesBilledTwice; review of release/goal2, 2026-10-01):
 * INV-C sent and recorded on a phone with no signal for days the Mac had
 * recorded on INV-A. The server keeps the days on INV-A and the sync goes
 * on, so this card is what tells the physician INV-C asks for them twice.
 * Shown on Home and the Invoices tab, on every device, until the duplicate
 * is deleted or written off. `onDelete(invoice)` (the Invoices tab) deletes
 * it after its own question; `onOpen()` (Home) opens the Invoices tab.
 * Nothing when there is none, or nothing to do.
 */
export default function BilledTwiceInvoices({ onOpen, onDelete }) {
  const { data, theme: T, isDesktop } = useApp();
  const twice = useMemo(() => invoicesBilledTwice(data || {}), [data]);
  if (!twice.length || (typeof onOpen !== "function" && typeof onDelete !== "function")) return null;
  return (
    <div role="region" aria-label="Invoices that bill the same work twice" style={{ marginBottom: 14 }}>
      {twice.map(b => (
        <div key={b.invoice.id} role="status" style={{
          padding: "11px 13px", borderRadius: 12, marginBottom: 8, fontSize: 13, lineHeight: 1.45,
          backgroundColor: T.dangerDim || T.card, border: `1px solid ${T.danger}`, color: T.text,
        }}>
          <div style={{ fontWeight: 800, marginBottom: 4 }}>{billedTwiceTitle(b)}</div>
          <div style={{ color: T.textMuted, marginBottom: 8 }}>{billedTwiceLine(b)}</div>
          <button onClick={() => (typeof onDelete === "function" ? onDelete(b.invoice) : onOpen())} style={{
            padding: "7px 14px", minHeight: isDesktop ? undefined : TAP_MIN, borderRadius: 9, border: "none",
            backgroundColor: typeof onDelete === "function" ? T.danger : T.accent, color: "#fff", fontSize: 12.5, fontWeight: 800, cursor: "pointer",
          }}>{typeof onDelete === "function" ? `Delete ${b.invoice.number}` : "Open Invoices"}</button>
        </div>
      ))}
    </div>
  );
}
