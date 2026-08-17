import { useEffect, useState } from "react";
import { useApp } from "../../context/AppContext";
import { supabase } from "../../lib/supabase";
import { isAdminUser } from "../../lib/admin";
import { Modal } from "../shared";

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
  const [visits, setVisits] = useState([]);
  const [waitlist, setWaitlist] = useState([]);
  const [attempts, setAttempts] = useState([]);
  const [fields, setFields] = useState([]);
  const [users, setUsers] = useState([]);       // profiles directory (admin read)
  const [invites, setInvites] = useState([]);   // beta_access allowlist
  const [errors, setErrors] = useState([]);     // client_errors (report-error sink)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openTicket, setOpenTicket] = useState(null);
  const [thread, setThread] = useState([]);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [ticketMsg, setTicketMsg] = useState("");
  // Manual ticket controls — the assistant sometimes fails to raise a card,
  // and resolved tickets pile up; both get first-class buttons here.
  const [showArchived, setShowArchived] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newSubject, setNewSubject] = useState("");
  const [newBody, setNewBody] = useState("");
  const [newCategory, setNewCategory] = useState("feature_request");
  const [creating, setCreating] = useState(false);

  const isAdmin = isAdminUser(user);

  const refreshTickets = async () => {
    const { data } = await supabase.from("admin_tickets_open").select("*").limit(200);
    setTickets(data || []);
  };

  // Tap a ticket → read it, see the whole thread, answer it, change its state.
  const openTicketDetail = async (t) => {
    setOpenTicket(t); setReply(""); setTicketMsg("");
    const { data } = await supabase.from("ticket_thread").select("*").eq("ticket_id", t.id);
    setThread(data || []);
  };

  const createTicket = async () => {
    const subject = newSubject.trim();
    const body = newBody.trim();
    if (!subject || !body) { setTicketMsg("Subject and details are both needed."); return; }
    setCreating(true); setTicketMsg("");
    try {
      const res = await supabase.functions.invoke("create-ticket", {
        body: { subject: subject.slice(0, 180), body, category: newCategory, priority: "normal", context_page: "admin" },
      });
      if (res.error) throw new Error(res.error.message);
      setNewOpen(false); setNewSubject(""); setNewBody("");
      await refreshTickets();
    } catch (e2) { setTicketMsg(e2.message); }
    setCreating(false);
  };

  const setArchived = async (t, archived) => {
    const { error: e2 } = await supabase.from("support_tickets")
      .update({ archived_at: archived ? new Date().toISOString() : null })
      .eq("id", t.id);
    if (e2) { setTicketMsg(e2.message); return; }
    setOpenTicket(null);
    await refreshTickets();
  };

  const sendReply = async (newStatus) => {
    if (!openTicket) return;
    const body = reply.trim();
    if (!body && !newStatus) { setTicketMsg("Write a reply first."); return; }
    setBusy(true); setTicketMsg("");
    try {
      const res = await supabase.functions.invoke("reply-ticket", {
        body: { ticket_id: openTicket.id, body: body || `Status set to ${newStatus}.`, ...(newStatus ? { status: newStatus } : {}) },
      });
      if (res.error) throw new Error(res.error.message);
      const { data } = await supabase.from("ticket_thread").select("*").eq("ticket_id", openTicket.id);
      setThread(data || []);
      setReply("");
      setTicketMsg(newStatus ? `Marked ${newStatus.replace("_", " ")}.` : "Reply sent.");
      await refreshTickets();
      if (newStatus === "resolved" || newStatus === "closed") setTimeout(() => setOpenTicket(null), 900);
    } catch (e2) {
      setTicketMsg(e2.message);
    }
    setBusy(false);
  };

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
      supabase.from("admin_visits_daily").select("*").limit(30),
      supabase.from("early_access_leads").select("id,name,email,source,note,status,invited_at,created_at").order("created_at", { ascending: false }).limit(500),
      supabase.from("waitlist_attempts").select("id,name,email,stage,created_at").order("created_at", { ascending: false }).limit(200),
      supabase.from("field_proposals").select("*").order("created_at", { ascending: false }).limit(200),
      supabase.from("profiles").select("id,name,email,auth_user_id,access_status,last_seen_at,created_at,degree_type,primary_state,npi").order("created_at", { ascending: false }).limit(500),
      supabase.from("beta_access").select("*").order("created_at", { ascending: false }).limit(500),
      supabase.from("client_errors").select("id, created_at, kind, message, stack, url, user_agent, build, auth_user_id, profile_id, extra").order("created_at", { ascending: false }).limit(50),
    ]).then(([t, f, s, v, w, wa, fp, pr, ba, ce]) => {
      if (cancelled) return;
      if (t.error) setError(`Tickets: ${t.error.message}`);
      else setTickets(t.data || []);
      if (f.error) setError((prev) => prev || `Feedback: ${f.error.message}`);
      else setFeedback(f.data || []);
      if (s.error) setError((prev) => prev || `Signups: ${s.error.message}`);
      else setSignups(s.data || []);
      if (!v.error) setVisits(v.data || []);
      if (w.error) setError((prev) => prev || `Waitlist: ${w.error.message}`);
      else setWaitlist(w.data || []);
      if (!wa.error) setAttempts(wa.data || []);
      if (fp.error) setError((prev) => prev || `Fields: ${fp.error.message}`);
      else setFields(fp.data || []);
      if (pr.error) setError((prev) => prev || `Users: ${pr.error.message}`);
      else setUsers(pr.data || []);
      if (!ba.error) setInvites(ba.data || []);
      if (!ce.error) setErrors(ce.data || []);
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

  const activeTickets = tickets.filter(t => !t.archived_at);
  const archivedTickets = tickets.filter(t => t.archived_at);
  const TABS = [
    { id: "tickets",   label: `Tickets (${activeTickets.length})` },
    { id: "users",     label: `Users (${users.filter(u => u.access_status === "active").length})` },
    { id: "errors",    label: `Errors (${errors.filter(e => Date.now() - new Date(e.created_at).getTime() < 7 * 86400000).length})` },
    { id: "signups",   label: "Signups" },
    { id: "waitlist",  label: `Waitlist (${waitlist.length})` },
    { id: "fields",    label: `Fields (${fields.filter(x => x.status === "pending").length})` },
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

      {tab === "tickets"  && !loading && (
        <>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <button onClick={() => { setNewOpen(true); setTicketMsg(""); }} style={{
              flex: 1, padding: "11px", borderRadius: 10, border: "none",
              backgroundColor: T.accent, color: "#fff", fontSize: 13.5, fontWeight: 800, cursor: "pointer",
            }}>+ New ticket</button>
            <button onClick={() => setShowArchived(a => !a)} style={{
              padding: "11px 16px", borderRadius: 10, border: `1px solid ${T.border}`,
              backgroundColor: showArchived ? T.card : "transparent", color: showArchived ? T.text : T.textMuted,
              fontSize: 13, fontWeight: 700, cursor: "pointer",
            }}>{showArchived ? "Back to active" : `Archived (${archivedTickets.length})`}</button>
          </div>
          <TicketsList rows={showArchived ? archivedTickets : activeTickets} T={T} onOpen={openTicketDetail} />
          {feedback.length > 0 && (
            <>
              <div style={{ fontSize: 11, fontWeight: 800, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, margin: "18px 0 8px" }}>
                Legacy feedback (pre-merge)
              </div>
              <FeedbackList rows={feedback} T={T} />
            </>
          )}
        </>
      )}
      {tab === "signups"  && !loading && (
        <>
          <div style={{ fontSize: 11, fontWeight: 800, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, margin: "0 0 8px" }}>
            Webpage visits
          </div>
          {visits.length === 0 ? (
            <div style={{ padding: "12px 14px", borderRadius: 10, backgroundColor: T.card, border: `1px solid ${T.border}`, fontSize: 13, color: T.textMuted, marginBottom: 16 }}>
              No visits recorded yet — first-party tracking went live Aug 10, 2026. Every landing-page load (home + all 50 state pages) now logs here.
            </div>
          ) : (
            <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 12px", marginBottom: 16 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr 1fr 1fr 1fr", gap: 4, fontSize: 11, fontWeight: 800, color: T.textMuted, paddingBottom: 6, borderBottom: `1px solid ${T.border}` }}>
                <span>Day</span><span>Page loads</span><span>Homepage</span><span>State pages</span><span>Via links</span>
              </div>
              {visits.map(v => (
                <div key={v.day} style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr 1fr 1fr 1fr", gap: 4, fontSize: 12.5, color: T.text, padding: "5px 0", borderBottom: `1px solid ${T.border}` }}>
                  <span>{v.day}</span><span style={{ fontWeight: 800 }}>{v.visits}</span><span>{v.home}</span><span>{v.state_pages}</span><span>{v.referred}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ fontSize: 11, color: T.textDim, marginTop: 6, lineHeight: 1.5 }}>
            Page loads = every landing-page view that day. Homepage = loads of credentialdomd.com itself. State pages = loads across the 50 state SEO pages (views, not states). Via links = arrived from another site (search, forum, shared link) instead of typing the address.
          </div>
          <div style={{ fontSize: 11, fontWeight: 800, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, margin: "0 0 8px" }}>
            Signups
          </div>
          <SignupsList rows={signups} T={T} />
        </>
      )}
      {tab === "errors" && !loading && <ErrorsList rows={errors} users={users} T={T} />}
      {tab === "users" && !loading && <UsersPanel users={users} setUsers={setUsers} invites={invites} setInvites={setInvites} T={T} />}
      {tab === "waitlist" && !loading && <WaitlistList rows={waitlist} setRows={setWaitlist} attempts={attempts} setAttempts={setAttempts} T={T} onInvite={async (r) => {
        const res = await sendInvite({ email: r.email, name: r.name, lead_id: r.id });
        if (res.ok) {
          setWaitlist(rs => rs.map(x => x.id === r.id ? { ...x, status: "invited", invited_at: new Date().toISOString() } : x));
          const { data } = await supabase.from("beta_access").select("*").order("created_at", { ascending: false }).limit(500);
          if (data) setInvites(data);
        }
        return res;
      }} />}
      {tab === "fields" && !loading && <FieldProposals rows={fields} setRows={setFields} T={T} />}

      {/* Tap a ticket → read it, answer it, close it */}
      <Modal open={!!openTicket} onClose={() => setOpenTicket(null)} title={openTicket?.subject || "Ticket"}>
        {openTicket && (
          <>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10, color: "#fff", backgroundColor: priorityColor(openTicket.priority) }}>{openTicket.priority?.toUpperCase()}</span>
              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10, color: "#fff", backgroundColor: statusColor(openTicket.status) }}>{openTicket.status}</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: T.textMuted }}>{openTicket.category}</span>
              {openTicket.context_page === "assistant" && (
                <span style={{ fontSize: 10, fontWeight: 800, color: "#a78bfa" }}>VIA VERA</span>
              )}
            </div>
            <div style={{ fontSize: 11.5, color: T.textDim, marginBottom: 10 }}>
              {openTicket.user_email} · {new Date(openTicket.created_at).toLocaleString()}
              {openTicket.context_page ? ` · from ${openTicket.context_page}` : ""}
            </div>
            <div style={{ fontSize: 14, color: T.text, whiteSpace: "pre-wrap", lineHeight: 1.55, padding: "10px 12px", borderRadius: 10, backgroundColor: T.input, border: `1px solid ${T.border}` }}>
              {openTicket.body}
            </div>

            {thread.length > 0 && (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                {thread.map(m => (
                  <div key={m.id} style={{
                    padding: "9px 11px", borderRadius: 10,
                    backgroundColor: m.is_admin_reply ? (T.accentDim || "rgba(59,130,246,0.12)") : T.card,
                    border: `1px solid ${T.border}`,
                  }}>
                    <div style={{ fontSize: 10, fontWeight: 800, color: m.is_admin_reply ? T.accent : T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 }}>
                      {m.is_admin_reply ? "You" : m.author_email || "User"} · {new Date(m.created_at).toLocaleString()}
                    </div>
                    <div style={{ fontSize: 13, color: T.text, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{m.body}</div>
                  </div>
                ))}
              </div>
            )}

            <textarea value={reply} onChange={(e) => setReply(e.target.value)}
              placeholder="Reply to the physician — they see this in their ticket."
              style={{
                width: "100%", minHeight: 90, marginTop: 12, padding: "10px 12px", borderRadius: 10,
                backgroundColor: T.input, border: `1px solid ${T.border}`, color: T.text,
                fontSize: 16, fontFamily: "inherit", outline: "none", resize: "vertical", boxSizing: "border-box",
              }} />

            {ticketMsg && <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 700, color: T.accent }}>{ticketMsg}</div>}

            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              <button onClick={() => sendReply(null)} disabled={busy} style={{
                flex: 1, minWidth: 120, padding: "12px", borderRadius: 10, border: "none",
                backgroundColor: busy ? T.textDim : T.accent, color: "#fff", fontSize: 14, fontWeight: 800,
                cursor: busy ? "wait" : "pointer",
              }}>{busy ? "Sending…" : "Send reply"}</button>
              <button onClick={() => sendReply("in_progress")} disabled={busy} style={{
                padding: "12px 14px", borderRadius: 10, border: `1px solid ${T.border}`,
                backgroundColor: "transparent", color: T.text, fontSize: 13, fontWeight: 700, cursor: "pointer",
              }}>Working on it</button>
              <button onClick={() => sendReply("resolved")} disabled={busy} style={{
                padding: "12px 14px", borderRadius: 10, border: "none",
                backgroundColor: "#10b981", color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer",
              }}>Resolve</button>
              <button onClick={() => setArchived(openTicket, !openTicket.archived_at)} disabled={busy} style={{
                padding: "12px 14px", borderRadius: 10, border: `1px solid ${T.border}`,
                backgroundColor: "transparent", color: T.textMuted, fontSize: 13, fontWeight: 700, cursor: "pointer",
              }}>{openTicket.archived_at ? "Unarchive" : "Archive"}</button>
            </div>
          </>
        )}
      </Modal>

      {/* Manual ticket entry — the direct road when the assistant fumbles */}
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New ticket">
        <input value={newSubject} onChange={(e) => setNewSubject(e.target.value)}
          placeholder="One-line summary"
          style={{
            width: "100%", boxSizing: "border-box", padding: "12px 14px", borderRadius: 10,
            backgroundColor: T.input, border: `1px solid ${T.border}`, color: T.text, fontSize: 16,
          }} />
        <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
          {[["feature_request", "Feature"], ["bug", "Bug"], ["question", "Question"], ["other", "Other"]].map(([v, l]) => (
            <button key={v} onClick={() => setNewCategory(v)} style={{
              flex: 1, padding: "9px", borderRadius: 10, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
              border: `1px solid ${newCategory === v ? T.accent : T.border}`,
              backgroundColor: newCategory === v ? T.accent : "transparent",
              color: newCategory === v ? "#fff" : T.textMuted,
            }}>{l}</button>
          ))}
        </div>
        <textarea value={newBody} onChange={(e) => setNewBody(e.target.value)}
          placeholder="What should change, and why. The hourly agent reads this verbatim — the more concrete, the better."
          style={{
            width: "100%", minHeight: 110, marginTop: 10, padding: "12px 14px", borderRadius: 10,
            backgroundColor: T.input, border: `1px solid ${T.border}`, color: T.text,
            fontSize: 16, fontFamily: "inherit", outline: "none", resize: "vertical", boxSizing: "border-box",
          }} />
        {ticketMsg && <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 700, color: T.accent }}>{ticketMsg}</div>}
        <button onClick={createTicket} disabled={creating} style={{
          width: "100%", marginTop: 12, padding: "13px", borderRadius: 10, border: "none",
          backgroundColor: creating ? T.textDim : T.accent, color: "#fff", fontSize: 14.5, fontWeight: 800,
          cursor: creating ? "wait" : "pointer",
        }}>{creating ? "Creating…" : "Create ticket"}</button>
      </Modal>

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

function TicketsList({ rows, T, onOpen }) {
  if (!rows.length) return <Empty T={T} text="No open tickets. Quiet day." />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {rows.map((r) => (
        <div key={r.id} role="button" tabIndex={0}
          onClick={() => onOpen?.(r)}
          onKeyDown={(ev) => { if (ev.key === "Enter") onOpen?.(r); }}
          style={{
          backgroundColor: T.card, border: `1px solid ${T.border}`,
          borderRadius: 10, padding: "10px 12px", cursor: "pointer", textAlign: "left",
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
          {r.last_message && (() => {
            // The agent stamps agent_last_reply_at when it posts; if the
            // newest thread message is at (or before) that stamp, the agent
            // spoke last and the ball is in the admin's court.
            const agentSpokeLast = r.agent_last_reply_at
              && new Date(r.last_message_at) <= new Date(new Date(r.agent_last_reply_at).getTime() + 5000);
            return (
              <div style={{ marginTop: 4 }}>
                {agentSpokeLast && (
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10,
                    color: "#fff", backgroundColor: "#7C3AED", marginRight: 6,
                  }}>AGENT REPLIED — NEEDS YOUR ANSWER</span>
                )}
                <div style={{
                  fontSize: 12, color: T.textMuted, marginTop: 3, lineHeight: 1.4,
                  display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
                }}>{r.last_message}</div>
              </div>
            );
          })()}
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

/** Client-side crashes reported by report-error. Last 50, newest first. */
function ErrorsList({ rows, users, T }) {
  const [openId, setOpenId] = useState(null);
  const who = (e) => {
    const u = users.find(x => x.auth_user_id && x.auth_user_id === e.auth_user_id) || users.find(x => x.id === e.profile_id);
    return u ? (u.name || u.email || "account") : (e.auth_user_id ? "signed-in user" : "signed-out visitor");
  };
  if (!rows.length) return <div style={{ fontSize: 13, color: T.textMuted, padding: "20px 0", textAlign: "center" }}>No client errors reported.</div>;
  return (
    <div>
      {rows.map(e => (
        <div key={e.id} onClick={() => setOpenId(openId === e.id ? null : e.id)} style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: "10px 12px", marginBottom: 8, cursor: "pointer" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontSize: 10, fontWeight: 800, textTransform: "uppercase", color: e.kind === "react" ? "#ef4444" : "#f59e0b" }}>{e.kind}</span>
            <span style={{ fontSize: 11, color: T.textDim }}>{timeAgo(e.created_at)} · {who(e)}{e.build ? ` · ${String(e.build).slice(-7)}` : ""}</span>
          </div>
          <div style={{ fontSize: 13, color: T.text, marginTop: 4, wordBreak: "break-word" }}>{e.message}</div>
          {openId === e.id && (
            <div style={{ marginTop: 8, fontSize: 11, color: T.textMuted, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "ui-monospace, monospace" }}>
              {e.url && <div>{e.url}</div>}
              {e.user_agent && <div style={{ marginTop: 4 }}>{e.user_agent}</div>}
              {e.stack && <div style={{ marginTop: 6 }}>{e.stack}</div>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Calls the admin-only send-invite function. Returns { ok, error }. */
async function sendInvite(body) {
  try {
    const { data, error } = await supabase.functions.invoke("send-invite", { body });
    if (error) {
      let msg = error.message;
      try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch { /* ignore */ }
      return { ok: false, error: msg };
    }
    if (data?.error) return { ok: false, error: data.error };
    return { ok: true, data };
  } catch (e) { return { ok: false, error: e.message }; }
}

function timeAgo(iso) {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 2) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function accessColor(st) {
  return st === "active" ? "#10b981" : st === "revoked" ? "#ef4444" : "#f59e0b";
}

/**
 * Users: the account directory plus the invite allowlist. Two people can be
 * approved today; this is where that happens and where it can be undone.
 */
function UsersPanel({ users, setUsers, invites, setInvites, T }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [showTest, setShowTest] = useState(false);

  const refresh = async () => {
    const [pr, ba] = await Promise.all([
      supabase.from("profiles").select("id,name,email,auth_user_id,access_status,last_seen_at,created_at,degree_type,primary_state,npi").order("created_at", { ascending: false }).limit(500),
      supabase.from("beta_access").select("*").order("created_at", { ascending: false }).limit(500),
    ]);
    if (pr.data) setUsers(pr.data);
    if (ba.data) setInvites(ba.data);
  };

  const invite = async () => {
    const e = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { setMsg("Enter a valid email."); return; }
    setBusy(true); setMsg("");
    const r = await sendInvite({ email: e, name: name.trim() });
    setBusy(false);
    if (r.ok) { setMsg(`Invitation sent to ${e}.`); setEmail(""); setName(""); refresh(); }
    else setMsg(`Could not invite: ${r.error}`);
  };

  const resend = async (inv) => {
    setBusy(true); setMsg("");
    const r = await sendInvite({ email: inv.email, name: inv.name, resend: true });
    setBusy(false);
    setMsg(r.ok ? `Re-sent to ${inv.email}.` : `Could not re-send: ${r.error}`);
    if (r.ok) refresh();
  };

  const setInviteStatus = async (inv, status) => {
    setInvites(rs => rs.map(x => x.id === inv.id ? { ...x, status } : x));
    await supabase.from("beta_access").update({ status, updated_at: new Date().toISOString() }).eq("id", inv.id);
    if (inv.profile_id) {
      await supabase.rpc("admin_set_access", { p_profile: inv.profile_id, p_status: status === "active" ? "active" : status === "revoked" ? "revoked" : "pending" });
    }
    refresh();
  };

  const removeInvite = async (inv) => {
    if (!confirm(`Remove ${inv.email} from the invite list?`)) return;
    setInvites(rs => rs.filter(x => x.id !== inv.id));
    await supabase.from("beta_access").delete().eq("id", inv.id);
    if (inv.profile_id) await supabase.rpc("admin_set_access", { p_profile: inv.profile_id, p_status: "pending" });
    refresh();
  };

  const setAccess = async (u, status) => {
    setUsers(rs => rs.map(x => x.id === u.id ? { ...x, access_status: status } : x));
    const { error } = await supabase.rpc("admin_set_access", { p_profile: u.id, p_status: status });
    if (error) setMsg(`Could not update: ${error.message}`);
    refresh();
  };

  const isTest = (u) => !u.email && !u.name && !u.npi && !u.last_seen_at;
  const shown = users.filter(u => showTest || !isTest(u));
  const hiddenCount = users.length - shown.length;
  const inviteByEmail = Object.fromEntries(invites.map(i => [i.email.toLowerCase(), i]));

  const card = { backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: "12px 14px", marginBottom: 8 };
  const chip = (label, color, onClick, active) => (
    <button key={label} onClick={onClick} disabled={busy} style={{ fontSize: 11, fontWeight: 700, padding: "4px 9px", borderRadius: 10, cursor: "pointer", border: `1px solid ${active ? color : T.border}`, backgroundColor: active ? color : "transparent", color: active ? "#fff" : T.textDim }}>{label}</button>
  );

  return (
    <div>
      <div style={{ ...card, marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 6 }}>Invite a physician</div>
        <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 8 }}>They get an email from whit@credentialdomd.com and can sign up with that exact address. Nobody else gets past the sign-in screen.</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Name (optional)" style={{ flex: "1 1 120px", padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: T.input, color: T.text, fontSize: 13 }} />
          <input value={email} onChange={e => setEmail(e.target.value)} placeholder="email@domain.com" type="email" autoCapitalize="none" style={{ flex: "2 1 180px", padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: T.input, color: T.text, fontSize: 13 }} />
          <button onClick={invite} disabled={busy} style={{ padding: "8px 14px", borderRadius: 8, border: "none", backgroundColor: T.accent, color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>{busy ? "..." : "Send invite"}</button>
        </div>
        {msg && <div style={{ fontSize: 12, color: msg.startsWith("Could not") ? "#ef4444" : "#10b981", marginTop: 6 }}>{msg}</div>}
      </div>

      <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, margin: "8px 0 6px" }}>Invited ({invites.length})</div>
      {invites.length === 0 && <div style={{ fontSize: 12, color: T.textDim, marginBottom: 8 }}>No invitations yet.</div>}
      {invites.map(inv => (
        <div key={inv.id} style={card}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{inv.name || inv.email}</div>
              <div style={{ fontSize: 12, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{inv.name ? inv.email : ""}</div>
              <div style={{ fontSize: 11, color: T.textDim, marginTop: 2 }}>
                invited {timeAgo(inv.invited_at)}{inv.invite_sent_at ? ` · email sent ${timeAgo(inv.invite_sent_at)}` : " · email not sent"}{inv.activated_at ? ` · joined ${timeAgo(inv.activated_at)}` : " · not joined yet"}
              </div>
            </div>
            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10, color: "#fff", backgroundColor: accessColor(inv.status === "invited" ? "pending" : inv.status), flexShrink: 0 }}>{inv.status}</span>
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            {inv.status !== "revoked" && chip("Re-send email", T.accent, () => resend(inv), false)}
            {inv.status === "revoked"
              ? chip("Restore access", "#10b981", () => setInviteStatus(inv, inv.profile_id ? "active" : "invited"), false)
              : chip("Pause access", "#ef4444", () => setInviteStatus(inv, "revoked"), false)}
            {chip("Remove", T.textDim, () => removeInvite(inv), false)}
          </div>
        </div>
      ))}

      <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, margin: "14px 0 6px" }}>
        Accounts ({shown.length}){hiddenCount > 0 && <button onClick={() => setShowTest(v => !v)} style={{ marginLeft: 8, fontSize: 11, border: "none", background: "transparent", color: T.accent, cursor: "pointer" }}>{showTest ? "hide" : "show"} {hiddenCount} empty test account{hiddenCount === 1 ? "" : "s"}</button>}
      </div>
      {shown.map(u => {
        const inv = u.email ? inviteByEmail[u.email.toLowerCase()] : null;
        return (
          <div key={u.id} style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.name || u.email || "(no name yet)"}</div>
                <div style={{ fontSize: 12, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.name && u.email ? u.email : ""}{u.degree_type ? ` · ${u.degree_type}` : ""}{u.primary_state ? ` · ${u.primary_state}` : ""}</div>
                <div style={{ fontSize: 11, color: T.textDim, marginTop: 2 }}>joined {timeAgo(u.created_at)} · last seen {timeAgo(u.last_seen_at)}{inv ? "" : u.access_status === "active" ? "" : " · not on invite list"}</div>
              </div>
              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10, color: "#fff", backgroundColor: accessColor(u.access_status), flexShrink: 0 }}>{u.access_status}</span>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              {u.access_status !== "active" && chip("Approve", "#10b981", () => setAccess(u, "active"), false)}
              {u.access_status === "active" && chip("Pause access", "#ef4444", () => setAccess(u, "revoked"), false)}
              {u.access_status === "revoked" && chip("Back to pending", T.textDim, () => setAccess(u, "pending"), false)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function WaitlistList({ rows, setRows, attempts, setAttempts, T, onInvite }) {
  // Full back-end control: see everyone, add someone by hand (a physician
  // whose network ate the form), remove test rows, and review attempts
  // that never became signups.
  const [addName, setAddName] = useState("");
  const [addEmail, setAddEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const addLead = async () => {
    const email = addEmail.trim(), name = addName.trim();
    if (!email || !name) return;
    setBusy(true);
    const { data, error } = await supabase.from("early_access_leads")
      .insert({ name, email, source: "admin-manual" }).select().single();
    setBusy(false);
    if (!error && data) { setRows(rs => [data, ...rs]); setAddName(""); setAddEmail(""); }
  };
  // Conversion funnel: tap the chip to advance waiting → invited → joined → paying
  const [inviting, setInviting] = useState(null);
  const [inviteMsg, setInviteMsg] = useState("");
  const STATUSES = [null, "invited", "joined", "paying"];
  const cycleStatus = async (r) => {
    const next = STATUSES[(STATUSES.indexOf(r.status || null) + 1) % STATUSES.length];
    const patch = { status: next, invited_at: next === "invited" ? new Date().toISOString() : r.invited_at };
    setRows(rs => rs.map(x => x.id === r.id ? { ...x, ...patch } : x));
    await supabase.from("early_access_leads").update(patch).eq("id", r.id);
  };
  const removeLead = async (r) => {
    if (!window.confirm(`Remove ${r.email} from the waitlist?`)) return;
    setRows(rs => rs.filter(x => x.id !== r.id));
    await supabase.from("early_access_leads").delete().eq("id", r.id);
  };
  const removeAttempt = async (a) => {
    setAttempts(as2 => as2.filter(x => x.id !== a.id));
    await supabase.from("waitlist_attempts").delete().eq("id", a.id);
  };
  const leadEmails = new Set(rows.map(r => (r.email || "").toLowerCase()));
  const orphanAttempts = attempts.filter(a => !leadEmails.has((a.email || "").toLowerCase()));
  const copyAll = () => {
    const text = rows.map((r) => `${r.name || ""} <${r.email}>`).join(", ");
    try { navigator.clipboard.writeText(text); } catch { /* older browser */ }
  };
  return (
    <div>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        backgroundColor: T.card, border: `2px solid ${T.accent}`,
        borderRadius: 12, padding: "12px 16px", marginBottom: 12,
      }}>
        <div>
          <div style={{ fontSize: 26, fontWeight: 800, color: T.accent }}>{rows.length}</div>
          <div style={{ fontSize: 11, color: T.textMuted }}>
            on the list · {rows.filter(r => r.status === "invited").length} invited · {rows.filter(r => r.status === "joined").length} joined · {rows.filter(r => r.status === "paying").length} paying
          </div>
          {inviteMsg && <div style={{ fontSize: 12, marginTop: 4, color: inviteMsg.startsWith("Could not") ? "#ef4444" : "#10b981" }}>{inviteMsg}</div>}
        </div>
        <button onClick={copyAll} style={{
          padding: "8px 14px", borderRadius: 8, border: `1px solid ${T.border}`,
          backgroundColor: "transparent", color: T.text, fontSize: 12, fontWeight: 700, cursor: "pointer",
        }}>Copy all emails</button>
      </div>

      {/* Manual add — for signups that arrive by text, call, or hallway */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        <input value={addName} onChange={e => setAddName(e.target.value)} placeholder="Name"
          style={{ flex: 1, minWidth: 0, padding: "9px 11px", borderRadius: 9, border: `1px solid ${T.border}`, backgroundColor: T.input, color: T.text, fontSize: 13 }} />
        <input value={addEmail} onChange={e => setAddEmail(e.target.value)} placeholder="email@domain.com" type="email"
          style={{ flex: 1.2, minWidth: 0, padding: "9px 11px", borderRadius: 9, border: `1px solid ${T.border}`, backgroundColor: T.input, color: T.text, fontSize: 13 }} />
        <button onClick={addLead} disabled={busy || !addName.trim() || !addEmail.trim()} style={{
          padding: "9px 14px", borderRadius: 9, border: "none", backgroundColor: T.accent, color: "#fff",
          fontSize: 13, fontWeight: 800, cursor: "pointer", opacity: busy ? 0.6 : 1, flexShrink: 0,
        }}>Add</button>
      </div>

      {rows.length === 0 && <Empty T={T} text="No early-access signups yet. Share the site!" />}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map((r) => (
          <div key={r.id || r.email + r.created_at} style={{
            backgroundColor: T.card, border: `1px solid ${T.border}`,
            borderRadius: 10, padding: "10px 12px",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{r.name || "(no name)"}</span>
                  {r.note && <span style={{ fontSize: 10, fontWeight: 800, color: T.warning, textTransform: "uppercase" }}>{r.note}</span>}
                  {r.source === "admin-manual" && <span style={{ fontSize: 10, fontWeight: 800, color: T.accent, textTransform: "uppercase" }}>added by you</span>}
                </div>
                <div style={{ fontSize: 12.5, color: T.textMuted, marginTop: 2, overflowWrap: "anywhere" }}>{r.email}</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                <button onClick={() => cycleStatus(r)} title="Tap to advance: waiting → invited → joined → paying" style={{
                  padding: "3px 9px", borderRadius: 999, fontSize: 10, fontWeight: 800, textTransform: "uppercase", cursor: "pointer",
                  border: `1px solid ${r.status ? T.accent : T.border}`,
                  backgroundColor: r.status === "paying" ? T.accent : "transparent",
                  color: r.status === "paying" ? "#fff" : r.status ? T.accent : T.textDim,
                }}>{r.status || "waiting"}</button>
                <span style={{ fontSize: 11, color: T.textMuted }}>{new Date(r.created_at).toLocaleDateString()}</span>
                {onInvite && r.status !== "joined" && r.status !== "paying" && (
                  <button disabled={inviting === r.id} onClick={async () => {
                    if (!window.confirm(`Send ${r.email} a beta invitation? They will be able to sign up with that address.`)) return;
                    setInviting(r.id); setInviteMsg("");
                    const res = await onInvite(r);
                    setInviting(null);
                    setInviteMsg(res.ok ? `Invitation sent to ${r.email}.` : `Could not invite ${r.email}: ${res.error}`);
                  }} style={{
                    padding: "5px 9px", borderRadius: 7, border: "none", backgroundColor: T.accent, color: "#fff", fontSize: 11, fontWeight: 800, cursor: "pointer",
                  }}>{inviting === r.id ? "..." : r.status === "invited" ? "Re-invite" : "Invite"}</button>
                )}
                <button onClick={() => removeLead(r)} style={{
                  padding: "5px 9px", borderRadius: 7, border: "none", backgroundColor: T.dangerDim || "rgba(239,68,68,0.12)",
                  color: T.danger || "#ef4444", fontSize: 11, fontWeight: 800, cursor: "pointer",
                }}>Remove</button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {orphanAttempts.length > 0 && (
        <>
          <div style={{ fontSize: 12, fontWeight: 800, color: T.warning, textTransform: "uppercase", letterSpacing: 0.5, margin: "16px 0 6px" }}>
            Attempts that never became signups ({orphanAttempts.length})
          </div>
          <div style={{ fontSize: 11.5, color: T.textMuted, marginBottom: 6 }}>
            These people hit Join but the signup itself did not land — reach out or add them manually above.
          </div>
          {orphanAttempts.map(a => (
            <div key={a.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, backgroundColor: T.card, border: `1px solid ${T.warning}`, borderRadius: 10, padding: "8px 12px", marginBottom: 5 }}>
              <div style={{ minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{a.name || "(no name)"}</span>
                <span style={{ fontSize: 12, color: T.textMuted, marginLeft: 8, overflowWrap: "anywhere" }}>{a.email}</span>
                <span style={{ fontSize: 10, fontWeight: 800, color: T.warning, marginLeft: 8, textTransform: "uppercase" }}>{a.stage}</span>
              </div>
              <button onClick={() => removeAttempt(a)} style={{ padding: "4px 8px", borderRadius: 7, border: "none", backgroundColor: "transparent", color: T.textDim, fontSize: 11, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>dismiss</button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function FieldProposals({ rows, setRows, T }) {
  // New fields/categories the assistant created on the fly — the schema
  // evolves under founder review. Approve = keep an eye on it as a candidate
  // for a first-class field; dismiss = noise.
  const setStatus = async (row, status) => {
    setRows(rs => rs.map(r => r.id === row.id ? { ...r, status } : r));
    await supabase.from("field_proposals").update({ status }).eq("id", row.id);
  };
  if (!rows.length) return <Empty T={T} text="No new fields proposed yet. When the assistant invents a field to avoid dropping data, it lands here for your review." />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {rows.map(r => (
        <div key={r.id} style={{
          backgroundColor: T.card, border: `1px solid ${T.border}`,
          borderRadius: 10, padding: "10px 12px",
          opacity: r.status === "dismissed" ? 0.55 : 1,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{r.label}</span>
            <span style={{
              fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10, alignSelf: "center",
              backgroundColor: r.status === "approved" ? "rgba(16,185,129,0.15)" : r.status === "dismissed" ? T.input : "rgba(245,158,11,0.15)",
              color: r.status === "approved" ? "#10b981" : r.status === "dismissed" ? T.textMuted : "#f59e0b",
            }}>{r.status.toUpperCase()}</span>
          </div>
          <div style={{ fontSize: 11.5, color: T.textMuted, marginTop: 2 }}>
            in {r.section} · e.g. "{r.sample}" · {new Date(r.created_at).toLocaleDateString()}
          </div>
          {r.status === "pending" && (
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              <button onClick={() => setStatus(r, "approved")} style={{
                flex: 1, padding: "7px", borderRadius: 8, border: "none",
                backgroundColor: "#10b981", color: "#fff", fontSize: 12, fontWeight: 800, cursor: "pointer",
              }}>Approve</button>
              <button onClick={() => setStatus(r, "dismissed")} style={{
                padding: "7px 14px", borderRadius: 8, border: `1px solid ${T.border}`,
                backgroundColor: "transparent", color: T.textMuted, fontSize: 12, fontWeight: 700, cursor: "pointer",
              }}>Dismiss</button>
            </div>
          )}
        </div>
      ))}
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
