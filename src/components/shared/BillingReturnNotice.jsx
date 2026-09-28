import { useApp } from "../../context/AppContext";
import { BILLING_RETURN_COPY } from "../../utils/billingReturn.js";
import { actionButtonStyle } from "./actionButton.js";

/**
 * What a buyer back from Stripe sees: the payment is being confirmed, it is
 * confirmed, it is taking longer than usual, or Checkout was canceled and
 * nothing was charged. The state lives in useBillingReturn (AppContext), so
 * the line carries over when a confirmed purchase opens the app.
 */
export default function BillingReturnNotice({ onReviewOffers }) {
  const { limitedLaunch, theme: T, isDesktop } = useApp();
  const notice = limitedLaunch?.billingReturn;
  if (!limitedLaunch?.enabled || !notice) return null;
  const copy = notice.phase === "confirming"
    ? (notice.deferred ? BILLING_RETURN_COPY.confirmingDeferred : BILLING_RETURN_COPY.confirming)
    : BILLING_RETURN_COPY[notice.phase];
  if (!copy) return null;
  const button = primary => actionButtonStyle(T, { primary, isDesktop });
  return <aside role="status" aria-live="polite" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", padding: "12px 16px", marginBottom: 14,
    background: T.card, color: T.text, border: `1px solid ${notice.phase === "confirmed" ? T.success : T.border}`, borderRadius: 12 }}>
    <p style={{ margin: 0, flex: "1 1 220px", fontSize: isDesktop ? 14 : 16, lineHeight: 1.5 }}>{copy}</p>
    {notice.phase === "delayed" && <button type="button" style={button(true)} onClick={notice.retry}>Check again</button>}
    {notice.phase === "canceled" && onReviewOffers && <button type="button" style={button(true)} onClick={() => { notice.dismiss(); onReviewOffers(); }}>Review membership options</button>}
    {notice.phase !== "confirming" && <button type="button" style={button(false)} onClick={notice.dismiss}>Dismiss</button>}
  </aside>;
}
