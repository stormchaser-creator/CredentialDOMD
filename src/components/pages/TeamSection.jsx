import { useState, useEffect, useCallback } from "react";
import { useApp } from "../../context/AppContext";
import { supabase } from "../../lib/supabase";

const STATUS_COLORS = {
  active:  { bg: "rgba(16,185,129,0.12)", text: "#10b981" },
  invited: { bg: "rgba(245,158,11,0.12)", text: "#f59e0b" },
  removed: { bg: "rgba(100,116,139,0.12)", text: "#64748b" },
};

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

export default function TeamSection() {
  const { theme: T, user, isPractice, plan, checkout } = useApp();
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteMsg, setInviteMsg] = useState(null);
  const [filter, setFilter] = useState("all");

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

  // ─── Practice Gate ──────────────────────────────────────────────
  if (!isPractice) {
    return (
      <div style={{ padding: "24px 0" }}>
        <div style={{
          borderRadius: 20, padding: "40px 24px",
          background: "linear-gradient(135deg, #1e1b4b, #312e81)",
          textAlign: "center",
          boxShadow: "0 8px 32px rgba(139,92,246,0.2)",
        }}>
          <div style={{
            width: 64, height: 64, borderRadius: 32,
            background: "linear-gradient(135deg, #8b5cf6, #4f46e5)",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 28, margin: "0 auto 16px",
            boxShadow: "0 4px 16px rgba(139,92,246,0.4)",
          }}>👥</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: "#fff", marginBottom: 8 }}>
            Team Dashboard
          </div>
          <div style={{ fontSize: 15, color: "rgba(255,255,255,0.7)", marginBottom: 8, maxWidth: 300, margin: "0 auto 20px" }}>
            Manage multiple providers, view team compliance, and invite colleagues — all from one dashboard.
          </div>
          <div style={{ fontSize: 13, color: "#a78bfa", fontWeight: 600, marginBottom: 20 }}>
            Practice plan feature
          </div>
          <button
            onClick={() => checkout("practice")}
            style={{
              padding: "13px 28px", borderRadius: 14, border: "none",
              background: "linear-gradient(135deg, #8b5cf6, #4f46e5)",
              color: "#fff", fontSize: 15, fontWeight: 700, cursor: "pointer",
              boxShadow: "0 4px 16px rgba(139,92,246,0.4)",
            }}
          >
            Contact Us for Practice Plan →
          </button>
        </div>
      </div>
    );
  }

  // ─── Stats ──────────────────────────────────────────────────────
  const activeCount  = members.filter(m => m.status === "active").length;
  const invitedCount = members.filter(m => m.status === "invited").length;
  const filtered = filter === "all" ? members : members.filter(m => m.status === filter);

  return (
    <div className="cmd-fade-in">
      <h2 style={{ fontSize: 20, fontWeight: 800, color: T.text, margin: "0 0 4px" }}>Team</h2>
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
              backgroundColor: "#10b981", color: "#fff",
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
                  background: "linear-gradient(135deg, #10b981, #059669)",
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
