import { useEffect, useState } from "react";
import { useApp } from "../../context/AppContext";
import { edgeErrorMessage } from "../../utils/edgeError";
import { supabase } from "../../lib/supabase";
import { ScreenshotAttach } from "../shared";

const CATEGORIES = [
  { id: "bug",             label: "Bug / something broken" },
  { id: "billing",         label: "Billing or subscription" },
  { id: "feature_request", label: "Feature request / idea" },
  { id: "data_issue",      label: "Data issue (lost, wrong, missing)" },
  { id: "compliance",      label: "Privacy / HIPAA / compliance" },
  { id: "feedback",        label: "General feedback" },
  { id: "other",           label: "Other" },
];

const PRIORITIES = [
  { id: "low",    label: "Low" },
  { id: "normal", label: "Normal" },
  { id: "high",   label: "High" },
  { id: "urgent", label: "Urgent (license expires soon)" },
];

const STATUS_LABEL = {
  open: "Open", in_progress: "In progress", waiting_user: "Waiting on you",
  resolved: "Resolved", closed: "Closed",
};

function statusColor(s) {
  if (s === "open")         return "#0ea5e9";
  if (s === "in_progress")  return "#eab308";
  if (s === "waiting_user") return "#a855f7";
  if (s === "resolved")     return "#10b981";
  return "#94a3b8";
}

function timeAgo(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Help & feedback sheet. Two tabs:
 *   New ticket   -> create-ticket edge function
 *   Your tickets -> the user's own support_tickets + ticket_thread (RLS scopes both
 *                   to owner-or-admin), reply box -> reply-ticket edge function
 *                   (owner-or-admin, verified in the function).
 * Admin replies also go out by email (trg_notify_ticket_reply -> send-ticket-reply).
 * Either side can attach one screenshot to a ticket or to a reply; the thread
 * renders them through signed links from ticket-attachment-url.
 */
export default function SupportModal({ open, onClose, contextPage, initialTab = "new" }) {
  const { theme: T, user } = useApp();
  const [tab, setTab] = useState(initialTab);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [category, setCategory] = useState("other");
  const [priority, setPriority] = useState("normal");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [attachment, setAttachment] = useState(null); // { data: dataURL, name }

  // Owner-or-admin-only signed links from ticket-attachment-url: the ticket's
  // own screenshot, and one per reply keyed by message id.
  const [attachmentUrl, setAttachmentUrl] = useState(null);
  const [replyUrls, setReplyUrls] = useState({});

  // Your tickets
  const [tickets, setTickets] = useState([]);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [ticketsError, setTicketsError] = useState("");
  const [openTicket, setOpenTicket] = useState(null);
  const [thread, setThread] = useState([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [reply, setReply] = useState("");
  const [replyAttachment, setReplyAttachment] = useState(null); // { data: dataURL, name }
  const [replying, setReplying] = useState(false);
  const [replyMsg, setReplyMsg] = useState("");

  useEffect(() => { if (open) setTab(initialTab); }, [open, initialTab]);

  const loadTickets = async () => {
    if (!supabase || !user?.id) return;
    setTicketsLoading(true); setTicketsError("");
    try {
      // RLS on support_tickets is owner-or-admin; filter to this profile so an admin
      // sees only their own tickets here (the admin queue lives in Admin > Tickets).
      const { data: profile } = await supabase
        .from("profiles").select("id").eq("auth_user_id", user.id).maybeSingle();
      if (!profile) { setTickets([]); return; }
      const { data: rows, error: e1 } = await supabase
        .from("support_tickets")
        .select("id, subject, body, status, created_at, updated_at, context_payload")
        .eq("user_id", profile.id)
        .order("updated_at", { ascending: false })
        .limit(100);
      if (e1) throw e1;
      const ids = (rows || []).map((r) => r.id);
      let last = {};
      if (ids.length) {
        const { data: msgs } = await supabase
          .from("ticket_thread")
          .select("ticket_id, created_at, is_admin_reply")
          .in("ticket_id", ids)
          .order("created_at", { ascending: true });
        for (const m of msgs || []) last[m.ticket_id] = m; // last one wins (ascending)
      }
      setTickets((rows || []).map((r) => ({
        ...r,
        last_message_at: last[r.id]?.created_at || r.created_at,
        last_from_admin: !!last[r.id]?.is_admin_reply,
      })));
    } catch (e) {
      setTicketsError(e.message || "Could not load your tickets.");
    } finally {
      setTicketsLoading(false);
    }
  };

  useEffect(() => {
    if (open && tab === "tickets") loadTickets();
  }, [open, tab, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Signed links for every screenshot on the thread (the ticket's own plus one
  // per reply), one round trip through ticket-attachment-url. A failure here
  // used to leave the screenshot silently absent, which reads as "the upload
  // was lost" when the file is fine and the link call is what broke. Say so
  // instead.
  const loadAttachmentUrls = async (t, msgs) => {
    if (!t.context_payload?.attachment_path && !msgs.some((m) => m.attachment_path)) return;
    const res = await supabase.functions.invoke("ticket-attachment-url", { body: { ticket_id: t.id } });
    if (res.error) { setReplyMsg(await edgeErrorMessage(res.error, "Could not open the attachment.")); return; }
    setAttachmentUrl(res.data?.url || null);
    setReplyUrls(res.data?.replies || {});
  };

  const openThread = async (t) => {
    setOpenTicket(t); setThread([]); setReply(""); setReplyAttachment(null); setReplyMsg("");
    setAttachmentUrl(null); setReplyUrls({});
    setThreadLoading(true);
    const { data } = await supabase.from("ticket_thread").select("*").eq("ticket_id", t.id);
    setThread(data || []);
    setThreadLoading(false);
    await loadAttachmentUrls(t, data || []);
  };

  const sendReply = async () => {
    const text = reply.trim();
    if (!openTicket || (text.length < 1 && !replyAttachment)) return;
    setReplying(true); setReplyMsg("");
    try {
      const res = await supabase.functions.invoke("reply-ticket", {
        body: {
          ticket_id: openTicket.id, body: text,
          ...(replyAttachment ? { attachment: { data: replyAttachment.data } } : {}),
        },
      });
      if (res.error) throw new Error(await edgeErrorMessage(res.error, "Could not send the reply."));
      const { data } = await supabase.from("ticket_thread").select("*").eq("ticket_id", openTicket.id);
      setThread(data || []);
      setReply(""); setReplyAttachment(null);
      setReplyMsg("Sent.");
      loadTickets();
      await loadAttachmentUrls(openTicket, data || []);
    } catch (e) {
      setReplyMsg(e.message || "Failed to send");
    } finally {
      setReplying(false);
    }
  };

  if (!open) return null;

  const submit = async () => {
    // Feedback shouldn't demand a subject line, derive one from the message
    const subj = subject.trim() || body.trim().slice(0, 80);
    if (subj.length < 3) { setError("Tell us a bit more first."); return; }
    if (body.trim().length < 10)   { setError("Tell us a bit more, at least 10 characters."); return; }
    if (!supabase) { setError("App not connected to backend."); return; }

    setSubmitting(true); setError("");
    try {
      const res = await supabase.functions.invoke("create-ticket", {
        body: {
          subject: subj,
          body: body.trim(),
          category: category === "feedback" ? "other" : category,
          priority,
          context_page: contextPage || window.location.pathname,
          ...(attachment ? { attachment: { data: attachment.data } } : {}),
        },
      });
      if (res.error) throw new Error(await edgeErrorMessage(res.error, "Could not file the ticket."));
      setDone(true);
      setTimeout(() => { onClose(); reset(); }, 2600);
    } catch (e) {
      setError(e.message || "Failed to submit");
    } finally {
      setSubmitting(false);
    }
  };

  const reset = () => {
    setSubject(""); setBody(""); setCategory("other"); setPriority("normal");
    setDone(false); setError("");
    setOpenTicket(null); setThread([]); setReply(""); setReplyMsg("");
    setAttachment(null); setReplyAttachment(null); setAttachmentUrl(null); setReplyUrls({});
  };

  const close = () => { onClose(); reset(); };

  const inputStyle = {
    width: "100%", padding: "10px 12px", borderRadius: 10,
    backgroundColor: T.input, border: `1px solid ${T.inputBorder || T.border}`,
    color: T.text, fontSize: 16, outline: "none", boxSizing: "border-box",
  };

  const tabBtn = (id, label) => (
    <button key={id} onClick={() => { setTab(id); setOpenTicket(null); }} style={{
      flex: 1, padding: "8px 10px", borderRadius: 8, border: "none", cursor: "pointer",
      backgroundColor: tab === id ? T.card : "transparent",
      color: tab === id ? T.text : T.textMuted, fontSize: 13, fontWeight: 700,
      boxShadow: tab === id ? "0 1px 2px rgba(0,0,0,0.15)" : "none",
    }}>{label}</button>
  );

  const renderNew = () => (
    <>
      <h2 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 800, color: T.text }}>
        Help & feedback
      </h2>
      <p style={{ margin: "0 0 16px", fontSize: 13, color: T.textMuted }}>
        Bug, question, or just a thought. It goes to Eric Whitney, DO, and he answers personally.
        Replies arrive by email at {user?.email || "your account address"} and here under Your tickets.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label style={{ fontSize: 12, fontWeight: 700, color: T.textMuted }}>Category</label>
        <select value={category} onChange={(e) => setCategory(e.target.value)} style={inputStyle}>
          {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>

        <label style={{ fontSize: 12, fontWeight: 700, color: T.textMuted }}>Priority</label>
        <select value={priority} onChange={(e) => setPriority(e.target.value)} style={inputStyle}>
          {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>

        <label style={{ fontSize: 12, fontWeight: 700, color: T.textMuted }}>Subject</label>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Short summary (optional)"
          maxLength={200}
          style={inputStyle}
        />

        <label style={{ fontSize: 12, fontWeight: 700, color: T.textMuted }}>What happened</label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="As much detail as helps: steps, error messages, what you expected."
          style={{ ...inputStyle, minHeight: 120, resize: "vertical", fontFamily: "inherit" }}
        />

        <label style={{ fontSize: 12, fontWeight: 700, color: T.textMuted }}>Screenshot (optional)</label>
        <ScreenshotAttach value={attachment} onChange={setAttachment} />
      </div>

      {error && (
        <div style={{
          marginTop: 10, padding: "8px 10px", borderRadius: 8,
          backgroundColor: "rgba(239,68,68,0.1)",
          color: "#ef4444", fontSize: 12, fontWeight: 600,
        }}>{error}</div>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <button
          onClick={submit}
          disabled={submitting || body.trim().length < 10}
          style={{
            flex: 1, padding: "12px", borderRadius: 10, border: "none",
            backgroundColor: submitting || body.trim().length < 10 ? T.textDim : T.accent,
            color: "#fff", fontSize: 14, fontWeight: 700,
            cursor: submitting || body.trim().length < 10 ? "not-allowed" : "pointer",
          }}
        >
          {submitting ? "Sending..." : "Send ticket"}
        </button>
        <button
          onClick={close}
          style={{
            padding: "12px 18px", borderRadius: 10,
            border: `1px solid ${T.border}`, backgroundColor: "transparent",
            color: T.text, fontSize: 14, fontWeight: 600, cursor: "pointer",
          }}
        >
          Cancel
        </button>
      </div>

      <p style={{ marginTop: 10, fontSize: 11, color: T.textDim, textAlign: "center" }}>
        Submitted as <strong>{user?.email || "anonymous"}</strong>
      </p>
    </>
  );

  const renderTicketList = () => (
    <>
      <h2 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 800, color: T.text }}>Your tickets</h2>
      <p style={{ margin: "0 0 14px", fontSize: 13, color: T.textMuted }}>
        Everything you have sent, with Eric's replies. New replies also land in your email.
      </p>
      {ticketsLoading && <div style={{ fontSize: 13, color: T.textMuted, padding: "12px 0" }}>Loading...</div>}
      {ticketsError && <div style={{ fontSize: 12, color: "#ef4444", fontWeight: 600, padding: "8px 0" }}>{ticketsError}</div>}
      {!ticketsLoading && !ticketsError && tickets.length === 0 && (
        <div style={{ fontSize: 13, color: T.textMuted, padding: "16px 0", textAlign: "center" }}>
          No tickets yet. Anything you send from New ticket shows up here.
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {tickets.map((t) => (
          <button key={t.id} onClick={() => openThread(t)} style={{
            textAlign: "left", padding: "10px 12px", borderRadius: 10, cursor: "pointer",
            backgroundColor: T.input, border: `1px solid ${T.border}`, color: T.text,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ flex: 1, fontSize: 14, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {t.subject}
              </div>
              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10, color: "#fff", backgroundColor: statusColor(t.status), whiteSpace: "nowrap" }}>
                {STATUS_LABEL[t.status] || t.status}
              </span>
            </div>
            <div style={{ fontSize: 11.5, color: T.textDim, marginTop: 3 }}>
              {t.last_from_admin ? "Reply from Eric " : "Last message "}{timeAgo(t.last_message_at)}
            </div>
          </button>
        ))}
      </div>
      <button onClick={close} style={{
        width: "100%", marginTop: 14, padding: "12px", borderRadius: 10,
        border: `1px solid ${T.border}`, backgroundColor: "transparent",
        color: T.text, fontSize: 14, fontWeight: 600, cursor: "pointer",
      }}>Close</button>
    </>
  );

  // A reply can be text, a screenshot, or both.
  const canSend = !replying && (reply.trim().length > 0 || !!replyAttachment);

  const renderThread = () => (
    <>
      <button onClick={() => setOpenTicket(null)} style={{
        background: "none", border: "none", padding: 0, marginBottom: 8, cursor: "pointer",
        color: T.accent, fontSize: 13, fontWeight: 700,
      }}>{"←"} All tickets</button>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <h2 style={{ margin: 0, flex: 1, fontSize: 17, fontWeight: 800, color: T.text }}>{openTicket.subject}</h2>
        <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10, color: "#fff", backgroundColor: statusColor(openTicket.status), whiteSpace: "nowrap" }}>
          {STATUS_LABEL[openTicket.status] || openTicket.status}
        </span>
      </div>
      <div style={{ fontSize: 11.5, color: T.textDim, marginBottom: 10 }}>
        Opened {new Date(openTicket.created_at).toLocaleString()}
      </div>

      {threadLoading && <div style={{ fontSize: 13, color: T.textMuted }}>Loading...</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {openTicket.body && (
          <div style={{ padding: "9px 11px", borderRadius: 10, backgroundColor: T.input, border: `1px solid ${T.border}` }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 }}>
              You {"·"} {new Date(openTicket.created_at).toLocaleString()}
            </div>
            <div style={{ fontSize: 13, color: T.text, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{openTicket.body}</div>
            {attachmentUrl && (
              <a href={attachmentUrl} target="_blank" rel="noreferrer">
                <img src={attachmentUrl} alt="Attached screenshot" style={{ marginTop: 8, maxWidth: 160, maxHeight: 160, borderRadius: 8, border: `1px solid ${T.border}` }} />
              </a>
            )}
          </div>
        )}
        {thread.map((m) => (
          <div key={m.id} style={{
            padding: "9px 11px", borderRadius: 10,
            backgroundColor: m.is_admin_reply ? (T.accentDim || "rgba(59,130,246,0.12)") : T.input,
            border: `1px solid ${T.border}`,
          }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: m.is_admin_reply ? T.accent : T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 }}>
              {m.is_admin_reply ? "Eric" : "You"} {"·"} {new Date(m.created_at).toLocaleString()}
            </div>
            <div style={{ fontSize: 13, color: T.text, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{m.body}</div>
            {m.attachment_path && (replyUrls[m.id] ? (
              <a href={replyUrls[m.id]} target="_blank" rel="noreferrer">
                <img src={replyUrls[m.id]} alt="Attached screenshot" style={{ marginTop: 8, maxWidth: 160, maxHeight: 160, borderRadius: 8, border: `1px solid ${T.border}` }} />
              </a>
            ) : (
              <div style={{ marginTop: 6, fontSize: 11.5, color: T.textDim }}>Screenshot attached</div>
            ))}
          </div>
        ))}
        {!threadLoading && thread.length === 0 && (
          <div style={{ fontSize: 12.5, color: T.textMuted, padding: "6px 0" }}>
            No replies yet.
          </div>
        )}
      </div>

      <textarea
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        placeholder="Add to this ticket"
        style={{ ...inputStyle, minHeight: 80, marginTop: 12, resize: "vertical", fontFamily: "inherit" }}
      />
      <ScreenshotAttach value={replyAttachment} onChange={setReplyAttachment} style={{ marginTop: 8 }} />
      {replyMsg && <div style={{ marginTop: 6, fontSize: 12.5, fontWeight: 700, color: replyMsg === "Sent." ? T.accent : "#ef4444" }}>{replyMsg}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button onClick={sendReply} disabled={!canSend} style={{
          flex: 1, padding: "12px", borderRadius: 10, border: "none",
          backgroundColor: canSend ? T.accent : T.textDim,
          color: "#fff", fontSize: 14, fontWeight: 700,
          cursor: canSend ? "pointer" : "not-allowed",
        }}>{replying ? "Sending..." : "Send reply"}</button>
        <button onClick={close} style={{
          padding: "12px 18px", borderRadius: 10,
          border: `1px solid ${T.border}`, backgroundColor: "transparent",
          color: T.text, fontSize: 14, fontWeight: 600, cursor: "pointer",
        }}>Close</button>
      </div>
    </>
  );

  return (
    <div onClick={close} style={{
      position: "fixed", inset: 0, zIndex: 200,
      backgroundColor: "rgba(0,0,0,0.6)", backdropFilter: "blur(6px)",
      display: "flex", alignItems: "flex-end", justifyContent: "center",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "100%", maxWidth: 520, maxHeight: "90vh", overflowY: "auto",
        backgroundColor: T.card, borderRadius: "20px 20px 0 0",
        padding: "20px 18px",
        animation: "slideUp 0.3s cubic-bezier(0.34,1.56,0.64,1)",
      }}>
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
          <div style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: T.border }} />
        </div>

        {done ? (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>{"✓"}</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>
              Ticket received.
            </div>
            <div style={{ fontSize: 13, color: T.textMuted, marginTop: 4 }}>
              Replies arrive by email at {user?.email || "your account address"} and here under Your tickets.
            </div>
          </div>
        ) : (
          <>
            {!openTicket && (
              <div style={{ display: "flex", gap: 4, padding: 4, borderRadius: 10, backgroundColor: T.input, marginBottom: 14 }}>
                {tabBtn("new", "New ticket")}
                {tabBtn("tickets", "Your tickets")}
              </div>
            )}
            {tab === "new" && renderNew()}
            {tab === "tickets" && !openTicket && renderTicketList()}
            {tab === "tickets" && openTicket && renderThread()}
          </>
        )}
      </div>
      <style>{`@keyframes slideUp { from { transform: translateY(100%); opacity: 0; } to { transform: translateY(0); opacity: 1; } }`}</style>
    </div>
  );
}
