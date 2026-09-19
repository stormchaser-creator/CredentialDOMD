import { useState, useEffect, useRef } from "react";
import { useApp } from "../../context/AppContext";
import { pushModal, popModal, isTopModal } from "../../utils/deskKeys";
import { FREE_BETA_LABEL, FREE_BETA_BLURB } from "../../constants/beta";
import { getPublicTiers, priceFor, PUBLIC_BILLING_ENABLED } from "../../utils/pricingEngine";
import { MEMBERSHIP_COPY } from "../../content/membershipCopy";

/** Public founding offers; checkout stays hidden until both billing gates open. */
export default function PricingModal({ open, onClose }) {
  const { theme: T, plan, checkout, isFreeBeta, isDesktop } = useApp();
  const billingAvailable = PUBLIC_BILLING_ENABLED && !isFreeBeta;
  const [message, setMessage] = useState(null);
  const [startingCheckout, setStartingCheckout] = useState(false);

  // Join the shared modal stack so Escape closes only the top sheet.
  const token = useRef({});
  useEffect(() => {
    if (!open) return;
    const t = token.current;
    pushModal(t);
    return () => popModal(t);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const handleKey = (e) => {
      if (e.key !== "Escape") return;
      if (isDesktop && !isTopModal(token.current)) return;
      onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose, isDesktop]);

  if (!open) return null;

  const handleCheckout = async (offerId) => {
    if (!billingAvailable || startingCheckout) return;
    setStartingCheckout(true);
    setMessage(null);
    try {
      const result = await checkout(offerId, "annual");
      if (result?.mock) setMessage("Plan preview updated.");
      else if (result?.ok === false) setMessage("Payments are not available right now. Please try again later.");
    } catch {
      setMessage("Checkout could not start. Please try again later.");
    } finally {
      setStartingCheckout(false);
    }
  };

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, zIndex: 200, backgroundColor: "rgba(0,0,0,0.6)",
      backdropFilter: "blur(6px)", display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div role="dialog" aria-modal="true" aria-labelledby="founding-pricing-title"
        onClick={e => e.stopPropagation()} style={{
          position: "relative", width: "100%", maxWidth: 720, backgroundColor: T.card,
          borderRadius: "24px 24px 0 0", maxHeight: "95vh", overflowY: "auto",
          animation: "slideUp 0.3s cubic-bezier(0.34,1.56,0.64,1)",
        }}>
        <div style={{ display: "flex", justifyContent: "center", padding: "12px 0 0" }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: T.border }} />
        </div>
        <button onClick={onClose} aria-label="Close" style={{
          position: "absolute", top: 10, right: 12, width: 36, height: 36, borderRadius: 18,
          border: "none", cursor: "pointer", backgroundColor: T.input, color: T.textMuted,
          fontSize: 18, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center",
        }}>✕</button>
        <div style={{ padding: "20px 48px 0", textAlign: "center" }}>
          <h2 id="founding-pricing-title" style={{ fontSize: 22, fontWeight: 800, color: T.text, margin: "0 0 6px" }}>
            Credential and Practice
          </h2>
          <p style={{ fontSize: 13, color: T.textMuted, margin: "0 0 12px", lineHeight: 1.6 }}>
            {isFreeBeta ? `${FREE_BETA_LABEL}: ${FREE_BETA_BLURB} ` : ""}
            {billingAvailable
              ? "Choose an annual plan for your work."
              : "These are the planned annual prices. Billing is off; no payment is collected."}
          </p>
        </div>
        {!billingAvailable && <div style={{ padding: "0 20px", color: T.text, fontSize: 13, lineHeight: 1.6 }}>
          <p style={{ fontWeight: 700, margin: "0 0 6px" }}>{MEMBERSHIP_COPY.foundingHeadline}</p>
          <p style={{ margin: "0 0 6px" }}>{MEMBERSHIP_COPY.credentialPrices} {MEMBERSHIP_COPY.foundingChange}</p>
          <p style={{ margin: 0 }}>{MEMBERSHIP_COPY.rateLock}</p>
        </div>}
        {message && <p role="status" style={{ padding: "0 20px", color: T.text, textAlign: "center" }}>{message}</p>}
        <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
          {getPublicTiers().map(offer => {
            const current = billingAvailable && plan === offer.tier;
            const price = priceFor(offer.id);
            return (
              <section key={offer.id} aria-label={offer.name} style={{
                borderRadius: 16, border: `1px solid ${T.border}`, backgroundColor: T.bg, padding: "18px",
              }}>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                  <h3 style={{ margin: 0, fontSize: 18, color: T.text }}>{offer.name}</h3>
                  <div style={{ color: T.text, whiteSpace: "nowrap" }}>
                    <strong style={{ fontSize: 24 }}>{price.display}</strong>
                    <span style={{ fontSize: 13 }}>{price.perInterval}</span>
                  </div>
                </div>
                <p style={{ color: T.textMuted, fontSize: 13, margin: "6px 0 12px" }}>{offer.audience}</p>
                {offer.eligibilityLabel && <p style={{ color: T.textMuted, fontSize: 12, margin: "0 0 10px" }}>{offer.eligibilityLabel}</p>}
                <ul style={{ margin: "0 0 12px", paddingLeft: 20, color: T.text, fontSize: 13, lineHeight: 1.9 }}>
                  {offer.bullets.map(bullet => <li key={bullet}>{bullet}</li>)}
                </ul>
                {offer.id === "core" && <p style={{ color: T.textMuted, fontSize: 13, lineHeight: 1.6 }}>{MEMBERSHIP_COPY.practiceTrial}</p>}
                {offer.id === "core_locum" && <p style={{ color: T.textMuted, fontSize: 13, lineHeight: 1.6 }}>{MEMBERSHIP_COPY.fullPackage}</p>}
                {!billingAvailable && <p style={{ fontSize: 12, margin: 0, color: T.textMuted }}>Planned annual price · Billing is off</p>}
                {current && <p style={{ fontSize: 13, margin: 0, color: T.text }}>Current plan</p>}
                {billingAvailable && !current && <button onClick={() => handleCheckout(offer.id)} disabled={startingCheckout}
                  style={{ width: "100%", padding: 12, borderRadius: 12, border: "none", cursor: "pointer",
                    backgroundColor: "#0f766e", color: "#fff", fontSize: 15, fontWeight: 700 }}>
                  {startingCheckout ? "Opening checkout…" : offer.cta}
                </button>}
              </section>
            );
          })}
        </div>
        <div style={{ padding: "4px 20px 28px", textAlign: "center", fontSize: 12, lineHeight: 1.7, color: T.textMuted }}>
          {!billingAvailable && <p style={{ margin: "0 0 12px" }}>{MEMBERSHIP_COPY.lifetimePolicy}</p>}
          <p style={{ margin: "0 0 6px" }}>For physician credential records. Do not upload patient information.</p>
          <a href="https://credentialdomd.com/security.html" target="_blank" rel="noopener noreferrer" style={{ color: T.text }}>
            Security and data handling
          </a>
          <p style={{ margin: "8px 0 0", color: T.textDim }}>
            {billingAvailable ? "Annual membership" : "No card required while billing is off"} · Built by a neurosurgeon
          </p>
        </div>
      </div>
      <style>{`@keyframes slideUp { from { transform: translateY(100%); opacity: 0; } to { transform: translateY(0); opacity: 1; } }`}</style>
    </div>
  );
}
