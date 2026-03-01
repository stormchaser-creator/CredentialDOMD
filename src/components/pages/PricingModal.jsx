import { useApp } from "../../context/AppContext";

const PLANS = [
  {
    key: "free",
    name: "Free",
    price: "$0",
    period: "forever",
    tagline: "Get started tracking your credentials",
    accent: "#64748b",
    accentDim: "rgba(100,116,139,0.12)",
    features: [
      "Medical license tracking",
      "CME credit logging",
      "State-specific CME requirements",
      "Local device storage",
      "Compliance dashboard",
    ],
    locked: [
      "Hospital privileges",
      "Insurance policies",
      "AI document scanning",
      "CV generator",
      "Multi-device sync",
    ],
    cta: "Current Plan",
    ctaKey: null,
  },
  {
    key: "pro",
    name: "Pro",
    price: "$29",
    period: "/ month",
    annual: "$199 / year  (save $149)",
    tagline: "Everything a solo physician needs",
    accent: "#10b981",
    accentDim: "rgba(16,185,129,0.12)",
    badge: "Most Popular",
    features: [
      "Everything in Free",
      "Hospital privileges tracking",
      "Insurance & malpractice records",
      "Health records & case logs",
      "Peer references & work history",
      "AI document scanning",
      "CV auto-generator",
      "Multi-device cloud sync",
      "Data export & backup",
      "Quick share credentials",
    ],
    cta: "Upgrade to Pro",
    ctaKey: "proMonthly",
    ctaAnnualKey: "proAnnual",
  },
  {
    key: "practice",
    name: "Practice",
    price: "Custom",
    period: "pricing",
    tagline: "For credentialing offices & group practices",
    accent: "#8b5cf6",
    accentDim: "rgba(139,92,246,0.12)",
    features: [
      "Everything in Pro",
      "Team provider dashboard",
      "Multi-provider compliance view",
      "Provider invite & management",
      "Aggregate compliance reports",
      "Audit logs",
      "Dedicated support",
    ],
    cta: "Contact Us",
    ctaKey: "practice",
    isEnterprise: true,
  },
];

export default function PricingModal({ open, onClose }) {
  const { theme: T, plan, checkout, isPro, isPractice } = useApp();

  if (!open) return null;

  const currentKey = isPractice ? "practice" : isPro ? "pro" : "free";

  const handleCTA = async (p) => {
    if (p.isEnterprise) {
      window.open("mailto:hello@credentialdomd.com?subject=Practice%20Plan%20Inquiry", "_blank");
      return;
    }
    if (!p.ctaKey) return;
    await checkout(p.ctaKey);
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 200,
        backgroundColor: "rgba(0,0,0,0.6)",
        backdropFilter: "blur(6px)",
        display: "flex", alignItems: "flex-end", justifyContent: "center",
        padding: "0",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 480,
          backgroundColor: T.card,
          borderRadius: "24px 24px 0 0",
          maxHeight: "90vh",
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
          <h2 style={{ fontSize: 22, fontWeight: 800, color: T.text, margin: "0 0 6px" }}>
            Choose Your Plan
          </h2>
          <p style={{ fontSize: 14, color: T.textMuted, margin: 0 }}>
            Upgrade anytime. Cancel anytime.
          </p>
        </div>

        {/* Plan Cards */}
        <div style={{ padding: "16px 16px 24px", display: "flex", flexDirection: "column", gap: 12 }}>
          {PLANS.map(p => {
            const isCurrent = p.key === currentKey;
            const isHighlighted = p.key === "pro";

            return (
              <div
                key={p.key}
                style={{
                  borderRadius: 16,
                  border: `2px solid ${isCurrent ? p.accent : isHighlighted ? p.accent + "60" : T.border}`,
                  backgroundColor: isCurrent ? p.accentDim : T.bg,
                  padding: "16px 18px",
                  position: "relative",
                  transition: "transform 0.15s, box-shadow 0.15s",
                }}
              >
                {/* Badge */}
                {p.badge && !isCurrent && (
                  <div style={{
                    position: "absolute", top: -10, right: 16,
                    backgroundColor: p.accent, color: "#fff",
                    fontSize: 11, fontWeight: 700,
                    padding: "3px 10px", borderRadius: 20,
                    letterSpacing: 0.5,
                  }}>
                    {p.badge}
                  </div>
                )}
                {isCurrent && (
                  <div style={{
                    position: "absolute", top: -10, left: 16,
                    backgroundColor: p.accent, color: "#fff",
                    fontSize: 11, fontWeight: 700,
                    padding: "3px 10px", borderRadius: 20,
                  }}>
                    Current Plan
                  </div>
                )}

                {/* Plan name + price */}
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 8 }}>
                  <div>
                    <div style={{ fontSize: 17, fontWeight: 800, color: isCurrent ? p.accent : T.text }}>{p.name}</div>
                    <div style={{ fontSize: 13, color: T.textMuted, marginTop: 2 }}>{p.tagline}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <span style={{ fontSize: 22, fontWeight: 800, color: isCurrent ? p.accent : T.text }}>{p.price}</span>
                    <span style={{ fontSize: 12, color: T.textMuted, marginLeft: 2 }}>{p.period}</span>
                    {p.annual && (
                      <div style={{ fontSize: 11, color: p.accent, fontWeight: 600, marginTop: 2 }}>{p.annual}</div>
                    )}
                  </div>
                </div>

                {/* Features */}
                <div style={{ marginBottom: 14 }}>
                  {p.features.map(f => (
                    <div key={f} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                      <span style={{ color: p.accent, fontSize: 13, fontWeight: 700, flexShrink: 0 }}>✓</span>
                      <span style={{ fontSize: 13, color: T.text }}>{f}</span>
                    </div>
                  ))}
                  {p.locked && p.locked.map(f => (
                    <div key={f} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
                      <span style={{ color: T.textDim, fontSize: 13, flexShrink: 0 }}>🔒</span>
                      <span style={{ fontSize: 13, color: T.textDim }}>{f}</span>
                    </div>
                  ))}
                </div>

                {/* CTA */}
                {!isCurrent && p.ctaKey && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <button
                      onClick={() => handleCTA(p)}
                      style={{
                        width: "100%", padding: "12px", borderRadius: 12,
                        border: "none", cursor: "pointer",
                        backgroundColor: p.accent, color: "#fff",
                        fontSize: 15, fontWeight: 700,
                        transition: "opacity 0.15s",
                      }}
                      onMouseOver={e => e.currentTarget.style.opacity = "0.9"}
                      onMouseOut={e => e.currentTarget.style.opacity = "1"}
                    >
                      {p.isEnterprise ? p.cta : p.cta} →
                    </button>
                    {p.ctaAnnualKey && (
                      <button
                        onClick={() => checkout(p.ctaAnnualKey)}
                        style={{
                          width: "100%", padding: "10px", borderRadius: 12,
                          border: `1px solid ${p.accent}60`, cursor: "pointer",
                          backgroundColor: p.accentDim, color: p.accent,
                          fontSize: 13, fontWeight: 700,
                          transition: "opacity 0.15s",
                        }}
                      >
                        Save 43% — Pay Annually ($199/yr)
                      </button>
                    )}
                  </div>
                )}
                {!isCurrent && !p.ctaKey && (
                  <div style={{
                    width: "100%", padding: "10px", borderRadius: 12,
                    backgroundColor: T.input, color: T.textDim,
                    fontSize: 14, fontWeight: 600, textAlign: "center",
                  }}>
                    Free Forever
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div style={{ padding: "0 20px 32px", textAlign: "center" }}>
          <p style={{ fontSize: 12, color: T.textDim, margin: 0 }}>
            Secure checkout via Stripe · Cancel anytime · HIPAA-conscious design
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
