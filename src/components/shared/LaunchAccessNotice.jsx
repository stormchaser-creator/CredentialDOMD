import { useApp } from "../../context/AppContext";
import { canReviewBillingOffer } from "../../utils/limitedLaunchAccess.js";
import { scheduledMembershipCopy } from "../../utils/membershipTiming.js";
import { actionButtonStyle } from "./actionButton.js";

const until = value => new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export default function LaunchAccessNotice({ onReviewOffers }) {
  const { limitedLaunch, data, theme: T, isDesktop } = useApp();
  if (!limitedLaunch.enabled) return null;
  const access = limitedLaunch.access;
  const hasSavedRecords = Object.values(data || {}).some(value => Array.isArray(value) && value.length > 0);
  const button = primary => actionButtonStyle(T, { primary, isDesktop });
  const box = { padding: "12px 16px", marginBottom: 14, background: T.card, color: T.text, border: `1px solid ${T.border}`, borderRadius: 12 };
  // A check that has not answered yet is not a membership decision. Only a
  // run of failed checks says anything, and it says the records are safe.
  if (!access || limitedLaunch.error || access.needsRefresh) {
    if (!limitedLaunch.reconnecting) return null;
    return <aside role="status" style={{ ...box, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <p style={{ margin: 0, flex: "1 1 220px", color: T.textMuted, fontSize: 14, lineHeight: 1.5 }}>
        <strong style={{ color: T.text }}>Reconnecting to your account.</strong> Your records are safe; changes will save once connected.
      </p>
      <button type="button" style={button(true)} onClick={() => { void limitedLaunch.refresh(); }}>Try again</button>
    </aside>;
  }
  let title, copy;
  if (access.accessStatus === "pending" && !hasSavedRecords) {
    title = "Choose your membership";
    copy = "Review your eligible offer and its renewal terms before choosing to pay. Creating an account does not charge you.";
  } else if (access.lifetime.credential && access.lifetime.practice) {
    title = "Free for life"; copy = "Your lifetime membership includes Credential and Practice.";
  } else if (access.scheduledMembership) {
    title = access.scheduledMembership.status === "payment_pending" ? "Payment confirmation pending" : "Your scheduled membership";
    copy = scheduledMembershipCopy(access.scheduledMembership);
  } else if (access.freeBeta?.state === "active") {
    title = "Your free beta";
    copy = `Full access until ${until(access.freeBeta.endsAt)}. No card is required, there is no automatic charge, and you do not need to cancel. ${canReviewBillingOffer(access, "core") || canReviewBillingOffer(access, "core_locum") ? "You can opt in now for your first annual charge and paid year to start at the original beta end, using this same account." : "Your original beta end date has not changed."}`;
  } else if (access.practiceTrial.state === "active") {
    title = "Your Practice trial";
    copy = `Practice access until ${until(access.practiceTrial.endsAt)}. Practice does not charge automatically. Your Credential membership continues separately.`;
  } else if (access.purchasedOfferId === "core" && !access.capabilities.practice.write) {
    title = access.practiceTrial.state === "expired" ? "Your Practice trial has ended" : "Your Credential membership continues";
    copy = "Your Credential membership continues. Saved Practice records remain available to read and export. Contact support about adding Practice; we will review the available options and charges with you before any billing change.";
  } else if (!access.capabilities.credential.write || !access.capabilities.practice.write) {
    title = access.freeBeta?.state === "expired" ? "Your free beta has ended" : "Saved records are available";
    copy = "You can keep viewing and exporting saved records. To make changes to features outside your membership, review an offer and choose whether to purchase.";
  } else return null;
  const canOffer = !access.lifetime.credential && !access.lifetime.practice && !access.purchasedOfferId && !access.scheduledMembership
    && (access.freeBeta?.state !== "active" || canReviewBillingOffer(access, "core") || canReviewBillingOffer(access, "core_locum"));
  const actions = [
    access.scheduledMembership && onReviewOffers && <button key="scheduled" type="button" style={button(true)} onClick={onReviewOffers}>Review scheduled membership</button>,
    canOffer && onReviewOffers && <button key="offers" type="button" style={button(true)} onClick={onReviewOffers}>Review membership options</button>,
    access.purchasedOfferId === "core" && !access.capabilities.practice.write && <a key="support" href="mailto:support@credentialdomd.com" style={{ ...button(false), display: "inline-flex", alignItems: "center", textDecoration: "none", color: T.accent }}>Contact support about Practice</a>,
  ].filter(Boolean);
  return <aside style={box}>
    <strong>{title}</strong><p style={{ margin: "6px 0", color: T.textMuted, fontSize: 13, lineHeight: 1.5 }}>{copy}</p>
    {actions.length > 0 && <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>{actions}</div>}
  </aside>;
}
