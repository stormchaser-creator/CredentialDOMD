import { useState, useEffect, useCallback } from "react";
import { useApp } from "../../context/AppContext";
import { supabase } from "../../lib/supabase";

const STATUS_COLORS = {
  active:  { bg: "rgba(16,185,129,0.12)", text: "#10b981" },
  invited: { bg: "rgba(245,158,11,0.12)", text: "#f59e0b" },
  removed: { bg: "rgba(100,116,139,0.12)", text: "#64748b" },
};

const SAMPLE_MEMBERS = [
  { id: "s1", member_email: "dr.smith@hospital.com", role: "provider", status: "active", invited_at: "2025-11-15T00:00:00Z", compliance: 92 },
  { id: "s2", member_email: "dr.jones@hospital.com", role: "provider", status: "active", invited_at: "2025-12-01T00:00:00Z", compliance: 78 },
  { id: "s3", member_email: "dr.patel@hospital.com", role: "provider", status: "invited", invited_at: "2026-01-20T00:00:00Z", compliance: 0 },
];

function MiniRing({ percent = 0, size = 40, stroke = 4 }) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (Math.min(100, Math.max(0, percent)) / 100) * circumference;
  const color = percent >= 80 ? "#10b981" : percent >= 50 ? "#f59e0b" : "#ef4444";

  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)", flexShrink: 0 }}>
      <circle cx={size/2} cy={size/2} r={radius} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={stroke} />
      <circle
        cx={size/2} cy={size/2} r={radius}
        fill="none" stroke={color} strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        style={{ transition: "stroke-dashoffset 0.8s cubic-bezier(0,0,0.2,1)" }}
      />
    </svg>
  );
}

// ─── Preview for non-Practice users ──────────────────────────
function TeamPreview({ T, onUpgrade }) {
  return (
    <div className="cmd-fade-in">
      <p style={{ fontSize: 14, color: T.textMuted, margin: "0 0 20px" }}>
        Manage provider credentials across your practice.
      </p>

      {/* Preview stats (dimmed) */}
      <div style={{ display: "flex", gap: 10, marginBottom: 20, opacity: 0.6 }}>
        {[
          { label: "Active", value: 2, color: "#10b981" },
          { label: "Invited", value: 1, color: "#f59e0b" },
          { label: "Total", value: 3, color: T.accent },
        ].map(s => (
          <div key={s.label} style={{
            flex: 1, backgroundColor: T.card, borderRadius: 12,
            padding: "14px 12px", textAlign: "center", border: `1px solid ${T.border}`,
          }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 12, color: T.textMuted, fontWeight: 600 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Sample member list (read-only preview) */}
      <div style={{ position: "relative" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {SAMPLE_MEMBERS.map(m => {
            const sc = STATUS_COLORS[m.status] || STATUS_COLORS.invited;
            const nameInitials = m.member_email.slice(0, 2).toUpperCase();
            return (
              <div key={m.id} style={{
                backgroundColor: T.card, borderRadius: 14,
                border: `1px solid ${T.border}`, padding: "14px 16px",
                display: "flex", alignItems: "center", gap: 12,
                opacity: 0.55, pointerEvents: "none",
              }}>
                <div style={{
                  width: 40, height: 40, borderRadius: 20,
                  background: T.pillGradient,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 13, fontWeight: 700, color: "#fff", flexShrink: 0,
                }}>{nameInitials}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {m.member_email}
                  </div>
                  <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>
                    {m.role} · Invited {new Date(m.invited_at).toLocaleDateString()}
                  </div>
                </div>
                {m.compliance > 0 && <MiniRing percent={m.compliance} size={36} stroke={3} />}
                <span style={{
                  padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700,
                  backgroundColor: sc.bg, color: sc.text, flexShrink: 0, textTransform: "capitalize",
                }}>{m.status}</span>
              </div>
            );
          })}
        </div>

        {/* Overlay with CTA */}
        <div style={{
          position: "absolute", inset: 0,
          background: `linear-gradient(to bottom, transparent 0%, ${T.bg}dd 50%, ${T.bg} 100%)`,
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end",
          paddingBottom: 16, borderRadius: 14,
        }}>
          <div style={{
            backgroundColor: T.card, borderRadius: 16, padding: "24px 20px",
            border: `1px solid ${T.border}`, textAlign: "center",
            boxShadow: "0 8px 32px rgba(0,0,0,0.12)", maxWidth: 320, width: "100%",
          }}>
            <div style={{ fontSize: 28, marginBottom: 12 }}>👥</div>
            <div style={{ fontSize: 17, fontWeight: 800, color: T.text, marginBottom: 6 }}>
              Team Dashboard
            </div>
            <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 16, lineHeight: 1.5 }}>
              Invite colleagues, view team compliance at a glance, and manage provider credentials from one dashboard.
            </div>
            <button
              onClick={onUpgrade}
              style={{
                width: "100%", padding: "13px 24px", borderRadius: 12, border: "none",
                background: "linear-gradient(135deg, #8b5cf6, #6d28d9)",
                color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer",
                boxShadow: "0 4px 16px rgba(139,92,246,0.3)",
                transition: "opacity 0.15s, transform 0.15s",
              }}
              onMouseOver={e => { e.currentTarget.style.opacity = "0.9"; e.currentTarget.style.transform = "scale(0.98)"; }}
              onMouseOut={e => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.transform = "scale(1)"; }}
            >
              Unlock Team Dashboard
            </button>
            <div style={{ fontSize: 12, color: T.textDim, marginTop: 10 }}>
              Available on Practice plan
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Full Team Dashboard (Practice plan) ─────────────────────
export default function TeamSection() {
  const { theme: T, user, isPractice, plan, checkout } = useApp();
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteMsg, setInviteMsg] = useState(null);
  const [filter, setFilter] = useState("all");
  const [showPricing, setShowPricing] = useState(false);

  const loadMembers = useCallback(async () => {
    if (!supabase || !user) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("team_members")
      .select("*")
      .eq("practice_admin_id", user.id)
      .neq("status", "removed")
      .order("invited_at", { ascending: false });

    if (!error && data) setMembers(data);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    if (isPractice) loadMembers();
    else setLoading(false);
  }, [isPractice, loadMembers]);

  const handleInvite = async () => {
    if (!inviteEmail.trim() || !supabase) return;
    setInviting(true);
    setInviteMsg(null);

    const { error } = await supabase.from("team_members").insert({
      practice_admin_id: user.id,
      member_email: inviteEmail.trim().toLowerCase(),
      role: "provider",
      status: "invited",
    });

    if (error) {
      setInviteMsg({ type: "error", text: error.message || "Failed to invite" });
    } else {
      setInviteMsg({ type: "success", text: `Invite sent to ${inviteEmail.trim()}` });
      setInviteEmail("");
      loadMembers();
    }
    setInviting(false);
    setTimeout(() => setInviteMsg(null), 5000);
  };

  const handleRemove = async (id) => {
    if (!supabase) return;
    await supabase.from("team_members").update({ status: "removed" }).eq("id", id);
    setMembers(m => m.filter(x => x.id !== id));
  };

  // ─── Non-Practice users get the preview ──────────────────────
  if (!isPractice) {
    return (
      <>
        <TeamPreview T={T} onUpgrade={() => setShowPricing(true)} />
        {showPricing && (
          <PricingModalInline open={showPricing} onClose={() => setShowPricing(false)} />
        )}
      </>
    );
  }

  // ─── Practice Dashboard ──────────────────────────────────────
  const activeCount  = members.filter(m => m.status === "active").length;
  const invitedCount = members.filter(m => m.status === "invited").length;
  const filtered = filter === "all" ? members : members.filter(m => m.status === filter);

  return (
    <div className="cmd-fade-in">
      <p style={{ fontSize: 14, color: T.textMuted, margin: "0 0 20px" }}>
        Manage provider credentials across your practice.
      </p>

      {/* Stats row */}
      <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
        {[
          { label: "Active", value: activeCount, color: "#10b981" },
          { label: "Invited", value: invitedCount, color: "#f59e0b" },
          { label: "Total", value: members.length, color: T.accent },
        ].map(s => (
          <div key={s.label} style={{
            flex: 1, backgroundColor: T.card, borderRadius: 12,
            padding: "14px 12px", textAlign: "center", border: `1px solid ${T.border}`,
          }}>
            <div style={{ fontSize: 24, fontWeight: 800, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 12, color: T.textMuted, fontWeight: 600 }}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Invite form */}
      <div style={{
        backgroundColor: T.card, borderRadius: 14, padding: "16px",
        border: `1px solid ${T.border}`, marginBottom: 16,
      }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 10 }}>
          Invite Provider
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="email"
            value={inviteEmail}
            onChange={e => setInviteEmail(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleInvite()}
            placeholder="provider@hospital.com"
            className="cmd-input"
            style={{
              flex: 1, backgroundColor: T.input, color: T.text,
              border: `1.5px solid ${T.border}`,
            }}
          />
          <button
            onClick={handleInvite}
            disabled={!inviteEmail.trim() || inviting}
            style={{
              padding: "11px 18px", borderRadius: 10, border: "none",
              backgroundColor: T.accent, color: "#fff",
              fontSize: 14, fontWeight: 700, cursor: inviting ? "wait" : "pointer",
              opacity: (!inviteEmail.trim() || inviting) ? 0.6 : 1,
              flexShrink: 0,
            }}
          >
            {inviting ? "Sending…" : "Invite"}
          </button>
        </div>
        {inviteMsg && (
          <div style={{
            marginTop: 10, padding: "8px 12px", borderRadius: 8, fontSize: 13, fontWeight: 600,
            backgroundColor: inviteMsg.type === "success" ? "rgba(16,185,129,0.12)" : "rgba(239,68,68,0.12)",
            color: inviteMsg.type === "success" ? "#10b981" : "#ef4444",
          }}>
            {inviteMsg.text}
          </div>
        )}
      </div>

      {/* Filter tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        {[["all", "All"], ["active", "Active"], ["invited", "Invited"]].map(([k, l]) => (
          <button
            key={k}
            onClick={() => setFilter(k)}
            style={{
              padding: "6px 14px", borderRadius: 20, border: "none",
              backgroundColor: filter === k ? T.accent : T.input,
              color: filter === k ? "#fff" : T.textMuted,
              fontSize: 13, fontWeight: 600, cursor: "pointer",
              transition: "all 0.15s",
            }}
          >
            {l}
          </button>
        ))}
      </div>

      {/* Member list */}
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {[1,2,3].map(i => (
            <div key={i} className="cmd-skeleton" style={{ height: 72, borderRadius: 12 }} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div style={{
          textAlign: "center", padding: "40px 20px",
          backgroundColor: T.card, borderRadius: 14,
          border: `1px dashed ${T.border}`, color: T.textMuted,
        }}>
          <div style={{ fontSize: 24, marginBottom: 10 }}>👥</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: T.text, marginBottom: 4 }}>No providers yet</div>
          <div style={{ fontSize: 13 }}>Invite your first provider above.</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map(m => {
            const sc = STATUS_COLORS[m.status] || STATUS_COLORS.invited;
            const nameInitials = m.member_email.slice(0, 2).toUpperCase();
            return (
              <div key={m.id} style={{
                backgroundColor: T.card, borderRadius: 14,
                border: `1px solid ${T.border}`, padding: "14px 16px",
                display: "flex", alignItems: "center", gap: 12,
              }}>
                {/* Avatar */}
                <div style={{
                  width: 40, height: 40, borderRadius: 20,
                  background: T.pillGradient,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 13, fontWeight: 700, color: "#fff", flexShrink: 0,
                }}>
                  {nameInitials}
                </div>

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {m.member_email}
                  </div>
                  <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>
                    {m.role} · Invited {new Date(m.invited_at).toLocaleDateString()}
                  </div>
                </div>

                {/* Status badge */}
                <span style={{
                  padding: "3px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700,
                  backgroundColor: sc.bg, color: sc.text, flexShrink: 0,
                  textTransform: "capitalize",
                }}>
                  {m.status}
                </span>

                {/* Remove */}
                <button
                  onClick={() => handleRemove(m.id)}
                  style={{
                    width: 28, height: 28, borderRadius: 8, border: "none",
                    backgroundColor: "rgba(239,68,68,0.1)", color: "#ef4444",
                    fontSize: 14, cursor: "pointer", display: "flex",
                    alignItems: "center", justifyContent: "center", flexShrink: 0,
                  }}
                  title="Remove member"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Lightweight wrapper to lazy-import PricingModal when needed
function PricingModalInline({ open, onClose }) {
  const { theme: T, plan, checkout, isPro, isPractice, isDevMode } = useApp();
  const [mockMsg, setMockMsg] = useState(null);
  if (!open) return null;

  const PLANS = [
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
      cta: isDevMode ? "Activate Practice" : "Contact Us",
      ctaKey: "practice",
      isEnterprise: !isDevMode,
    },
  ];

  const handleCTA = async (p) => {
    if (p.isEnterprise) {
      window.open("mailto:hello@credentialdomd.com?subject=Practice%20Plan%20Inquiry", "_blank");
      return;
    }
    if (!p.ctaKey) return;
    const result = await checkout(p.ctaKey);
    if (result?.mock) {
      setMockMsg(`Switched to ${result.plan} plan`);
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
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          maxWidth: 400, width: "100%",
          backgroundColor: T.card, borderRadius: 20,
          padding: "24px 20px",
          animation: "popIn 0.28s cubic-bezier(0.34,1.56,0.64,1)",
        }}
      >
        <h3 style={{ fontSize: 20, fontWeight: 800, color: T.text, margin: "0 0 4px", textAlign: "center" }}>
          Upgrade to Practice
        </h3>
        <p style={{ fontSize: 13, color: T.textMuted, margin: "0 0 16px", textAlign: "center" }}>
          Everything your credentialing office needs.
        </p>

        {isDevMode && (
          <div style={{
            marginBottom: 12, padding: "8px 12px", borderRadius: 10,
            backgroundColor: "rgba(251,146,60,0.12)", border: "1px solid rgba(251,146,60,0.3)",
            fontSize: 12, fontWeight: 600, color: "#fb923c", textAlign: "center",
          }}>
            Dev Mode — instant plan switch
          </div>
        )}

        {mockMsg && (
          <div style={{
            marginBottom: 12, padding: "10px 12px", borderRadius: 10,
            backgroundColor: "rgba(16,185,129,0.12)", border: "1px solid rgba(16,185,129,0.3)",
            fontSize: 13, fontWeight: 700, color: "#10b981", textAlign: "center",
          }}>
            ✓ {mockMsg}
          </div>
        )}

        {PLANS[0].features.map(f => (
          <div key={f} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
            <span style={{ color: "#8b5cf6", fontSize: 13, fontWeight: 700, flexShrink: 0 }}>✓</span>
            <span style={{ fontSize: 13, color: T.text }}>{f}</span>
          </div>
        ))}

        <button
          onClick={() => handleCTA(PLANS[0])}
          style={{
            width: "100%", padding: "13px", borderRadius: 12, border: "none",
            background: "linear-gradient(135deg, #8b5cf6, #6d28d9)",
            color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer",
            marginTop: 16, boxShadow: "0 4px 16px rgba(139,92,246,0.3)",
            transition: "opacity 0.15s",
          }}
          onMouseOver={e => e.currentTarget.style.opacity = "0.9"}
          onMouseOut={e => e.currentTarget.style.opacity = "1"}
        >
          {PLANS[0].cta} →
        </button>

        <button
          onClick={onClose}
          style={{
            width: "100%", padding: "10px", border: "none",
            backgroundColor: "transparent", color: T.textDim,
            fontSize: 13, cursor: "pointer", marginTop: 8,
          }}
        >
          Maybe later
        </button>
      </div>
    </div>
  );
}
