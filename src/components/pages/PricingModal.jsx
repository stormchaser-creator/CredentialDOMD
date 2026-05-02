import { useState, useEffect } from "react";
import { useApp } from "../../context/AppContext";
import {
  TIERS,
  getPublicTiers,
  priceFor,
  shouldShowFoundingCounter,
  ANNUAL_DISCOUNT_LABEL,
  FOUNDING_COHORT_CAP,
  calculatePracticeTotal,
} from "../../utils/pricingEngine";

/**
 * PricingModal — Architecture D (8-tier model).
 *
 * Spec: AutoAIBiz CredentialDoMD code agent specification, May 2026, §3.4.
 *
 * Layout:
 *  - Annual/Monthly toggle, annual pre-selected, label "Get 2 months free"
 *  - Tier cards in horizontal row (desktop) / stacked (mobile)
 *  - Locum is the recommended anchor (+8% scale, ribbon)
 *  - Founding tier hidden until ≥10 of 100 claimed
 *  - No charm pricing, no strikethrough, no fake testimonials
 */

export default function PricingModal({ open, onClose }) {
  const { theme: T, plan, checkout, isDevMode } = useApp();
  const [billing, setBilling] = useState("annual");  // annual pre-selected per spec 3.4
  const [foundingClaimed, setFoundingClaimed] = useState(0);
  const [mockMsg, setMockMsg] = useState(null);

  // TODO: Wire to Supabase Edge Function /api/founding/count once deployed.
  // For now, default to 0 (founding tier hidden) — switch to fetch when ready.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/founding/count")
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (!cancelled && typeof j?.claimed === "number") setFoundingClaimed(j.claimed); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (!open) return null;

  const visibleTiers = getPublicTiers(foundingClaimed, { includeResident: false });

  const handleCTA = async (tierId) => {
    const t = TIERS[tierId];
    if (!t) return;
    if (t.id === "practice" || t.id === "group" || t.id === "enterprise") {
      window.location.href = `mailto:hello@credentialdomd.com?subject=${encodeURIComponent(`${t.name} tier inquiry`)}`;
      return;
    }
    const result = await checkout(tierId, billing);
    if (result?.mock) {
      setMockMsg(`Switched to ${t.name}`);
      setTimeout(() => { setMockMsg(null); onClose(); }, 1200);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 200,
        backgroundColor: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(6px)",
        display: "flex", alignItems: "flex-end", justifyContent: "center",
        padding: 0,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 720,
          backgroundColor: T.card,
          borderRadius: "24px 24px 0 0",
          maxHeight: "95vh",
          overflowY: "auto",
          animation: "slideUp 0.3s cubic-bezier(0.34,1.56,0.64,1)",
        }}
      >
        {/* Handle bar */}
        <div style={{ display: "flex", justifyContent: "center", padding: "12px 0 0" }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: T.border }} />
        </div>

        {/* Header */}
        <div style={{ padding: "16px 20px 0", textAlign: "center" }}>
          <h2 style={{ fontSize: 22, fontWeight: 800, color: T.text, margin: "0 0 4px" }}>
            Choose your plan
          </h2>
          <p style={{ fontSize: 13, color: T.textMuted, margin: "0 0 14px" }}>
            14-day free trial on Solo and Locum. No credit card required.
          </p>

          {/* Annual / Monthly toggle — annual pre-selected */}
          <div
            style={{
              display: "inline-flex", borderRadius: 10,
              backgroundColor: T.input, padding: 3, gap: 2,
            }}
          >
            {["annual", "monthly"].map(b => (
              <button
                key={b}
                onClick={() => setBilling(b)}
                style={{
                  padding: "8px 18px", borderRadius: 8, border: "none", cursor: "pointer",
                  fontSize: 13, fontWeight: 700,
                  backgroundColor: billing === b ? T.card : "transparent",
                  color: billing === b ? T.text : T.textMuted,
                  boxShadow: billing === b ? "0 1px 4px rgba(0,0,0,0.1)" : "none",
                  transition: "all 0.15s",
                }}
              >
                {b === "annual" ? `Annual (${ANNUAL_DISCOUNT_LABEL})` : "Monthly"}
              </button>
            ))}
          </div>
        </div>

        {/* Dev mode banner */}
        {isDevMode && (
          <div
            style={{
              margin: "10px 16px 0", padding: "8px 12px", borderRadius: 10,
              backgroundColor: "rgba(251,146,60,0.12)",
              border: "1px solid rgba(251,146,60,0.3)",
              fontSize: 12, fontWeight: 600, color: "#fb923c", textAlign: "center",
            }}
          >
            Dev Mode — tiers switch instantly (no Stripe call)
          </div>
        )}

        {/* Mock confirmation */}
        {mockMsg && (
          <div
            style={{
              margin: "8px 16px 0", padding: "10px 12px", borderRadius: 10,
              backgroundColor: T.successDim || "rgba(5,150,105,0.12)",
              border: `1px solid ${T.success || "#059669"}30`,
              fontSize: 13, fontWeight: 700,
              color: T.success || "#059669", textAlign: "center",
            }}
          >
            {mockMsg}
          </div>
        )}

        {/* Founding cohort progress — only shown when threshold met */}
        {shouldShowFoundingCounter(foundingClaimed) && visibleTiers.some(t => t.id === "founding") && (
          <div
            style={{
              margin: "10px 16px 0", padding: "10px 14px", borderRadius: 10,
              backgroundColor: "rgba(16,185,129,0.08)",
              border: "1px solid rgba(16,185,129,0.25)",
              fontSize: 13, color: T.text, textAlign: "center",
            }}
          >
            <strong>Founding cohort:</strong> {foundingClaimed} of {FOUNDING_COHORT_CAP} claimed.
            Locked $12/mo for 24 months.
          </div>
        )}

        {/* Tier cards */}
        <div
          style={{
            padding: "16px 16px 8px",
            display: "flex", flexDirection: "column", gap: 12,
          }}
        >
          {visibleTiers.map(tier => {
            const isCurrent = plan === tier.id;
            const { display, perInterval, secondaryLine } = priceFor(tier.id, billing);
            const isRecommended = tier.recommended;
            const accent =
              tier.id === "free"     ? "#64748b"
            : tier.id === "founding" ? "#10b981"
            : tier.id === "solo"     ? "#0ea5e9"
            : tier.id === "locum"    ? "#10b981"
            : tier.id === "practice" ? "#2563eb"
            : tier.id === "group"    ? "#7c3aed"
            : tier.id === "enterprise" ? "#6b7280"
            : "#0ea5e9";
            const accentDim = `${accent}1f`;

            return (
              <div
                key={tier.id}
                style={{
                  borderRadius: 16,
                  border: `2px solid ${isCurrent ? accent : isRecommended ? accent : T.border}`,
                  backgroundColor: isCurrent ? accentDim : T.bg,
                  padding: "16px 18px",
                  position: "relative",
                  transform: isRecommended ? "scale(1.02)" : "none",
                  transition: "transform 0.15s",
                }}
              >
                {isRecommended && !isCurrent && (
                  <div
                    style={{
                      position: "absolute", top: -10, right: 16,
                      backgroundColor: accent, color: "#fff",
                      fontSize: 11, fontWeight: 700,
                      padding: "3px 10px", borderRadius: 20,
                      letterSpacing: 0.3,
                    }}
                  >
                    Recommended
                  </div>
                )}
                {isCurrent && (
                  <div
                    style={{
                      position: "absolute", top: -10, left: 16,
                      backgroundColor: accent, color: "#fff",
                      fontSize: 11, fontWeight: 700,
                      padding: "3px 10px", borderRadius: 20,
                    }}
                  >
                    Current Plan
                  </div>
                )}

                {/* Name + price */}
                <div
                  style={{
                    display: "flex", alignItems: "flex-start",
                    justifyContent: "space-between", marginBottom: 8,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 17, fontWeight: 800, color: isCurrent ? accent : T.text }}>
                      {tier.name}
                    </div>
                    <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>
                      {tier.audience}
                    </div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <span
                      style={{
                        fontSize: tier.id === "enterprise" ? 16 : 24,
                        fontWeight: 800,
                        color: isCurrent ? accent : T.text,
                      }}
                    >
                      {display}
                    </span>
                    {perInterval && (
                      <span style={{ fontSize: 12, color: T.textMuted, marginLeft: 2 }}>
                        {perInterval}
                      </span>
                    )}
                    {secondaryLine && (
                      <div
                        style={{
                          fontSize: 11, color: accent,
                          fontWeight: 600, marginTop: 2,
                        }}
                      >
                        {secondaryLine}
                      </div>
                    )}
                  </div>
                </div>

                {/* Bullets */}
                <div style={{ marginBottom: 14 }}>
                  {tier.bullets.map(bullet => (
                    <div
                      key={bullet}
                      style={{
                        display: "flex", alignItems: "center",
                        gap: 8, marginBottom: 4,
                      }}
                    >
                      <span
                        style={{
                          color: accent, fontSize: 12, fontWeight: 700,
                          flexShrink: 0,
                        }}
                      >
                        ✓
                      </span>
                      <span style={{ fontSize: 13, color: T.text }}>{bullet}</span>
                    </div>
                  ))}
                </div>

                {/* Practice tier: live total calculator */}
                {tier.id === "practice" && (
                  <PracticeTotalRow accent={accent} T={T} />
                )}

                {/* CTA */}
                {!isCurrent && (
                  <button
                    onClick={() => handleCTA(tier.id)}
                    style={{
                      width: "100%", padding: "12px", borderRadius: 12,
                      border: tier.id === "free" || tier.id === "practice" || tier.id === "group" || tier.id === "enterprise"
                        ? `2px solid ${accent}` : "none",
                      cursor: "pointer",
                      backgroundColor: tier.id === "free" || tier.id === "practice" || tier.id === "group" || tier.id === "enterprise"
                        ? "transparent" : accent,
                      color: tier.id === "free" || tier.id === "practice" || tier.id === "group" || tier.id === "enterprise"
                        ? accent : "#fff",
                      fontSize: 15, fontWeight: 700,
                      transition: "opacity 0.15s",
                    }}
                    onMouseOver={e => e.currentTarget.style.opacity = "0.9"}
                    onMouseOut={e => e.currentTarget.style.opacity = "1"}
                  >
                    {tier.cta} →
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* Tax-deductible footnote */}
        <div style={{ padding: "0 20px", textAlign: "center" }}>
          <p style={{ fontSize: 12, color: T.textMuted, margin: 0 }}>
            Every paid plan is fully tax-deductible for 1099 physicians.
          </p>
        </div>

        {/* Trust signals */}
        <div style={{ padding: "12px 20px 8px", textAlign: "center" }}>
          <div
            style={{
              padding: "12px 16px", borderRadius: 12,
              backgroundColor: T.input,
              fontSize: 12, color: T.textMuted, lineHeight: 1.6,
            }}
          >
            <div style={{ fontWeight: 700, color: T.text, marginBottom: 4, fontSize: 13 }}>
              HIPAA-aligned. Your data stays yours.
            </div>
            AES-256 at rest, TLS 1.3 in transit, US-region only. We sign BAAs on Practice and above.
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding: "8px 20px 32px", textAlign: "center" }}>
          <p style={{ fontSize: 12, color: T.textDim, margin: 0 }}>
            Secure checkout via Stripe · Cancel anytime · Built by a neurosurgeon
          </p>
        </div>
      </div>

      <style>{`
        @keyframes slideUp {
          from { transform: translateY(100%); opacity: 0; }
          to   { transform: translateY(0);    opacity: 1; }
        }
      `}</style>
    </div>
  );
}

/** Live total calculator for the Practice tier card. */
function PracticeTotalRow({ accent, T }) {
  const [n, setN] = useState(5);
  const { annualTotalDollars, monthlyEquivalent } = calculatePracticeTotal(n);
  return (
    <div
      style={{
        marginBottom: 14, padding: "10px 12px", borderRadius: 10,
        backgroundColor: `${accent}0d`,
        border: `1px solid ${accent}33`,
      }}
    >
      <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 6 }}>
        Total for {n} provider{n === 1 ? "" : "s"}:
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <input
          type="range"
          min={2} max={25}
          value={n}
          onChange={e => setN(Number(e.target.value))}
          style={{ flex: 1, accentColor: accent }}
        />
        <div style={{ minWidth: 90, textAlign: "right" }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: T.text }}>
            ${annualTotalDollars.toLocaleString()}/yr
          </div>
          <div style={{ fontSize: 11, color: T.textMuted }}>
            ≈ ${monthlyEquivalent}/mo
          </div>
        </div>
      </div>
    </div>
  );
}
