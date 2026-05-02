import { useEffect, useState } from "react";
import { useApp } from "../../context/AppContext";
import { supabase } from "../../lib/supabase";
import { isAdminUser } from "../../lib/admin";

/**
 * AdminDashboard — gated to admin emails only.
 * Reads from `admin_feedback_recent`, `admin_tickets_open`, `admin_signups_daily`
 * views (created in supabase-tracking-migration.sql).
 */
export default function AdminDashboard() {
  const { theme: T, user } = useApp();
  const [tab, setTab] = useState("tickets");
  const [tickets, setTickets] = useState([]);
  const [feedback, setFeedback] = useState([]);
  const [signups, setSignups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const isAdmin = isAdminUser(user);

  useEffect(() => {
    if (!isAdmin || !supabase) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    Promise.all([
      supabase.from("admin_tickets_open").select("*").limit(50),
      supabase.from("admin_feedback_recent").select("*").limit(50),
      supabase.from("admin_signups_daily").select("*").limit(30),
    ]).then(([t, f, s]) => {
      if (cancelled) return;
      if (t.error) setError(`Tickets: ${t.error.message}`);
      else setTickets(t.data || []);
      if (f.error) setError((prev) => prev || `Feedback: ${f.error.message}`);
      else setFeedback(f.data || []);
      if (s.error) setError((prev) => prev || `Signups: ${s.error.message}`);
      else setSignups(s.data || []);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [isAdmin]);

  if (!isAdmin) {
    return (
      <div style={{ textAlign: "center", padding: "60px 20px" }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>Admin only.</div>
        <div style={{ fontSize: 13, color: T.textMuted, marginTop: 4 }}>
          {user?.email ? `${user.email} is not on the admin list.` : "Sign in first."}
        </div>
      </div>
    );
  }

  const TABS = [
    { id: "tickets",   label: `Tickets (${tickets.length})` },
    { id: "feedback",  label: `Feedback (${feedback.length})` },
    { id: "signups",   label: "Signups" },
  ];

  return (
    <div>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 800, color: T.text }}>Admin</h2>
      <p style={{ margin: "0 0 14px", fontSize: 12, color: T.textMuted }}>
        Tickets, feedback, and signups for credentialdomd.com
      </p>

      <div style={{
        display: "flex", gap: 4, marginBottom: 14,
        backgroundColor: T.input, borderRadius: 10, padding: 3,
      }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              flex: 1, padding: "8px", borderRadius: 8, border: "none",
              backgroundColor: tab === t.id ? T.card : "transparent",
              color: tab === t.id ? T.text : T.textMuted,
              fontSize: 13, fontWeight: 700, cursor: "pointer",
            }}
          >{t.label}</button>
        ))}
      </div>

      {loading && <div style={{ padding: 20, textAlign: "center", color: T.textMuted }}>Loading…</div>}
      {error && (
        <div style={{
          padding: "10px 12px", borderRadius: 8,
          backgroundColor: "rgba(239,68,68,0.1)", color: "#ef4444", fontSize: 12,
          marginBottom: 12,
        }}>
          {error}
          <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>
            (If "relation does not exist": run supabase-tracking-migration.sql.)
          </div>
        </div>
      )}

      {tab === "tickets"  && !loading && <TicketsList rows={tickets} T={T} />}
      {tab === "feedback" && !loading && <FeedbackList rows={feedback} T={T} />}
      {tab === "signups"  && !loading && <SignupsList rows={signups} T={T} />}
    </div>
  );
}

function priorityColor(p) {
  if (p === "urgent") return "#ef4444";
  if (p === "high")   return "#f97316";
  if (p === "low")    return "#94a3b8";
  return "#0ea5e9";
}

function statusColor(s) {
  if (s === "open")           return "#0ea5e9";
  if (s === "in_progress")    return "#eab308";
  if (s === "waiting_user")   return "#a855f7";
  if (s === "resolved")       return "#10b981";
  return "#94a3b8";
}

function TicketsList({ rows, T }) {
  if (!rows.length) return <Empty T={T} text="No open tickets. Quiet day." />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {rows.map((r) => (
        <div key={r.id} style={{
          backgroundColor: T.card, border: `1px solid ${T.border}`,
          borderRadius: 10, padding: "10px 12px",
        }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 4 }}>
            <span style={{
              fontSize: 10, fontWeight: 700, padding: "2px 8px",
              borderRadius: 10, color: "#fff",
              backgroundColor: priorityColor(r.priority),
            }}>{r.priority?.toUpperCase()}</span>
            <span style={{
              fontSize: 10, fontWeight: 700, padding: "2px 8px",
              borderRadius: 10, color: "#fff",
              backgroundColor: statusColor(r.status),
            }}>{r.status}</span>
            <span style={{ fontSize: 10, fontWeight: 700, color: T.textMuted }}>
              {r.category}
            </span>
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{r.subject}</div>
          <div style={{ fontSize: 11, color: T.textMuted, marginTop: 3 }}>
            {r.user_email} ·{" "}
            {new Date(r.updated_at).toLocaleString()} ·{" "}
            {r.message_count} {r.message_count === 1 ? "message" : "messages"}
          </div>
        </div>
      ))}
    </div>
  );
}

function FeedbackList({ rows, T }) {
  if (!rows.length) return <Empty T={T} text="No feedback yet." />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {rows.map((r) => (
        <div key={r.id} style={{
          backgroundColor: T.card, border: `1px solid ${T.border}`,
          borderRadius: 10, padding: "10px 12px",
          opacity: r.resolved_at ? 0.6 : 1,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: T.text }}>
              {r.rating ? "★".repeat(r.rating) + "☆".repeat(5 - r.rating) : "(no rating)"}
            </span>
            <span style={{ fontSize: 11, color: T.textMuted }}>
              {new Date(r.created_at).toLocaleString()}
            </span>
          </div>
          <div style={{ fontSize: 13, color: T.text, lineHeight: 1.4 }}>{r.message}</div>
          <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>
            {r.user_email}{r.context_page ? ` · ${r.context_page}` : ""}
          </div>
        </div>
      ))}
    </div>
  );
}

function SignupsList({ rows, T }) {
  if (!rows.length) return <Empty T={T} text="No signups in last 90 days." />;
  const total = rows.reduce((s, r) => s + (r.signups || 0), 0);
  return (
    <div>
      <div style={{
        backgroundColor: T.card, border: `2px solid ${T.accent}`,
        borderRadius: 12, padding: "12px 16px", marginBottom: 12,
      }}>
        <div style={{ fontSize: 11, color: T.textMuted }}>Last 90 days</div>
        <div style={{ fontSize: 26, fontWeight: 800, color: T.accent }}>{total}</div>
        <div style={{ fontSize: 11, color: T.textMuted }}>total signups</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {rows.map((r) => (
          <div key={r.day} style={{
            display: "flex", justifyContent: "space-between",
            padding: "6px 12px", backgroundColor: T.card,
            border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 13,
          }}>
            <span style={{ color: T.text }}>{r.day?.slice(0, 10)}</span>
            <span style={{ color: T.text, fontWeight: 700 }}>{r.signups}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Empty({ T, text }) {
  return (
    <div style={{
      textAlign: "center", padding: "30px 20px",
      backgroundColor: T.card, borderRadius: 12, border: `1px dashed ${T.border}`,
      color: T.textMuted, fontSize: 13,
    }}>{text}</div>
  );
}
