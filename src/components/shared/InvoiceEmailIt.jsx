import { TAP_MIN } from "./actionButton";
import { EMAIL_IT, EMAIL_IT_HINT, emailItOffline } from "../../utils/invoiceEmailDraft";

/**
 * The "Email it for me" button of an invoice preview (utils/invoiceEmailDraft.js),
 * with the line under it: what it does, or why it is off while offline
 * (`other` names what still works). `checking`: the check that the invoice
 * is not recorded elsewhere is running. Called as a function, so its button
 * sits in the preview's own element tree.
 */
export default function InvoiceEmailIt({ T, onClick, disabled = false, checking = false, online = true, other = "", primary = false }) {
  const off = disabled || checking || !online;
  // `primary`: the first way to send (on a phone, where the share sheet's
  // answer cannot be trusted and a trip to Mail can lose the page).
  const filled = primary && !off;
  return (
    <div style={{ marginTop: 8 }}>
      <button data-email-it="" disabled={off} aria-busy={checking ? "true" : undefined} onClick={() => { if (!off) onClick(); }} style={{
        width: "100%", minHeight: TAP_MIN, padding: "12px", borderRadius: 12,
        border: filled ? "none" : `1px solid ${off ? T.border : T.accent}`,
        background: filled ? "linear-gradient(135deg, #10b981, #059669)" : "transparent",
        color: filled ? "#fff" : off ? T.textMuted : T.accent, fontSize: 14.5, fontWeight: 800,
        cursor: checking ? "wait" : off ? "default" : "pointer",
      }}>{checking ? "Checking…" : EMAIL_IT}</button>
      <div role={online ? undefined : "status"} style={{ fontSize: 12, color: T.textMuted, marginTop: 6, textAlign: "center", lineHeight: 1.45 }}>
        {online ? EMAIL_IT_HINT : emailItOffline(other)}
      </div>
    </div>
  );
}
