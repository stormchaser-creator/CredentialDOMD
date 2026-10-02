import { useApp } from "../../context/AppContext";
import useUnrecordedInvoices from "./useUnrecordedInvoices";
import { shareInFlight } from "../../utils/invoiceHandoff";
import { unansweredTitle, unansweredLine, repeatTitle, repeatLine, partialRepeatLine, REPEAT_OK } from "../../utils/invoiceRecord";
import { TAP_MIN } from "./actionButton";

/**
 * Every invoice of the account that went to the share sheet (or went out)
 * and is not recorded, whichever screen it came from (2026-10-01: after iOS
 * dropped the app in Gmail, it reopened on Home, and Work log opened on the
 * agreement on today's schedule, so nothing on screen said the invoice sent
 * from another agreement went out). Shown on Home and the Invoices tab; its
 * button opens the screen that answers it: Work log on the agreement it came
 * from, or Expenses. `onOpen(note)` does the opening. Nothing when there is
 * none, or nowhere to open.
 */
export default function UnansweredInvoices({ onOpen }) {
  const { data, theme: T, user, isDesktop } = useApp();
  const { list, repeats, dismissRepeat } = useUnrecordedInvoices(data?.invoices, { account: user?.id || "", records: data || null });
  // A share sheet on this page that still has its file is not unanswered yet.
  const shown = list.filter(n => !shareInFlight(n.number));
  // A note another recorded invoice repeats (2026-10-02): said here too, and
  // gone in one tap, never "Did it go out?".
  const again = (repeats || []).filter(n => !shareInFlight(n.number));
  if ((!shown.length && !again.length) || typeof onOpen !== "function") return null;
  const contracts = data?.locumContracts || [];
  const whereOf = (n) => (n.kind === "EXP"
    ? "Expenses"
    : contracts.find(c => c.id === n.contractId)?.facility || "Work log");
  const itemsOf = (n) => (n.kind === "EXP" ? "expenses" : n.repeat?.collection === "workLog" || n.overlap?.collection === "workLog" ? "entries" : "days");
  return (
    <div role="region" aria-label="Invoices not recorded" style={{ marginBottom: 14 }}>
      {again.map(n => (
        <div key={`repeat-${n.number}`} role="status" style={{
          padding: "11px 13px", borderRadius: 12, marginBottom: 8, fontSize: 13, lineHeight: 1.45,
          backgroundColor: T.warningDim || T.card, border: `1px solid ${T.warning}`, color: T.text,
        }}>
          <div style={{ fontWeight: 800, marginBottom: 4 }}>{repeatTitle(n, n.repeat)}</div>
          <div style={{ color: T.textMuted, marginBottom: 8 }}>{repeatLine(n, n.repeat, itemsOf(n))}</div>
          <button onClick={() => dismissRepeat(n)} style={{
            padding: "7px 18px", minHeight: isDesktop ? undefined : TAP_MIN, borderRadius: 9, border: "none",
            background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff", fontSize: 12.5, fontWeight: 800, cursor: "pointer",
          }}>{REPEAT_OK}</button>
        </div>
      ))}
      {shown.map(n => {
        const where = whereOf(n);
        return (
          <div key={n.number} role="status" style={{
            padding: "11px 13px", borderRadius: 12, marginBottom: 8, fontSize: 13, lineHeight: 1.45,
            backgroundColor: T.warningDim || T.card, border: `1px solid ${T.warning}`, color: T.text,
          }}>
            <div style={{ fontWeight: 800, marginBottom: 4 }}>{n.overlap ? `${n.number} is not recorded` : unansweredTitle(n)}</div>
            <div style={{ color: T.textMuted, marginBottom: 8 }}>{n.overlap ? partialRepeatLine(n, n.overlap, itemsOf(n)) : unansweredLine(n, where)}</div>
            <button onClick={() => onOpen(n)} style={{
              padding: "7px 14px", minHeight: isDesktop ? undefined : TAP_MIN, borderRadius: 9, border: "none",
              background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff", fontSize: 12.5, fontWeight: 800, cursor: "pointer",
            }}>Open {where}</button>
          </div>
        );
      })}
    </div>
  );
}
