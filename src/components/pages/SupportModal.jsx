import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../context/AppContext";
import { pushModal, popModal, isTopModal } from "../../utils/deskKeys";
import { edgeErrorMessage } from "../../utils/edgeError";
import { supabase } from "../../lib/supabase";
import { ScreenshotAttach } from "../shared";
import { attachmentsPayload, linksFor, ticketAttachmentShortfall } from "../../utils/ticketAttachments";
import { scrubSsn } from "../../utils/outgoingText.js";
import TicketAttachments from "../shared/TicketAttachments";
import { createSupportTextDrafts, supportReceiptConfirmed, supportSubmissionError } from "../../utils/supportTextDrafts";
import { SUPPORT_OPERATIONS_ENABLED, createSupportOperationsClient, supportActorLabel, supportMessageFromTeam } from "../../utils/supportOperationsClient";

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

function daysOpen(iso) {
  if (!iso) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
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
 * Either side can attach up to five files (screenshots, photos, PDFs, Office
 * documents, CSV or text) to a ticket or to a reply; the thread renders them
 * through signed links from ticket-attachment-url. create-ticket says how many
 * files it could not store, and the sender is told to add those as a reply.
 */
export default function SupportModal(props) {
  const { user } = useApp();
  // Remount the account's private conversation state on sign-in changes.
  return <SupportModalContent key={user?.id || "signed-out"} {...props} />;
}

export function SupportMessage({ message: m, theme: T, ownProfileId, urls }) {
  const fromTeam = supportMessageFromTeam(m);
  return <div style={{ padding: "9px 11px", borderRadius: 10, backgroundColor: fromTeam ? (T.accentDim || "rgba(59,130,246,0.12)") : T.input, border: `1px solid ${T.border}` }}>
    <div style={{ fontSize: 10, fontWeight: 800, color: fromTeam ? T.accent : T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 }}>
      {supportActorLabel(m, ownProfileId)} {"·"} {new Date(m.created_at).toLocaleString()}
    </div>
    <div style={{ fontSize: 13, color: T.text, whiteSpace: "pre-wrap", overflowWrap: "anywhere", lineHeight: 1.5 }}>{m.body}</div>
    {Boolean(m.has_attachments || m.attachment_path || m.attachment_paths?.length) && (linksFor(urls).length ? <TicketAttachments urls={linksFor(urls)} size={160} /> : <div style={{ marginTop: 6, fontSize: 11.5, color: T.textDim }}>File attached</div>)}
  </div>;
}

function SupportModalContent({ open, onClose, contextPage, initialTab = "new" }) {
  const { theme: T, user, isDesktop } = useApp();
  const operations = useMemo(() => createSupportOperationsClient({ accountId: user?.id }), [user?.id]);
  const drafts = useMemo(() => createSupportTextDrafts({ accountId: user?.id }), [user?.id]);
  const [createDraftSaved, setCreateDraftSaved] = useState(null);
  const [replyDraftSaved, setReplyDraftSaved] = useState(null);
  const listRequest = useRef(0);
  const threadRequest = useRef(0);
  const actionRequest = useRef(0);
  const closeTimer = useRef(null);
  const [ownProfileId, setOwnProfileId] = useState(null);
  const [tab, setTab] = useState(initialTab);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [category, setCategory] = useState("other");
  const [priority, setPriority] = useState("normal");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  // Set when the ticket was saved but create-ticket could not store every
  // file. Shown in place of the plain confirmation, and the sheet stays open
  // so it can be read.
  const [doneNote, setDoneNote] = useState("");
  const [error, setError] = useState("");
  const [attachment, setAttachment] = useState([]); // [{ data: dataURL, name }]

  // Owner-or-admin-only signed links from ticket-attachment-url: the ticket's
  // own screenshot, and one per reply keyed by message id.
  const [attachmentUrls, setAttachmentUrls] = useState([]);
  const [replyUrls, setReplyUrls] = useState({});

  // Your tickets
  const [tickets, setTickets] = useState([]);
  const [ticketsLoading, setTicketsLoading] = useState(false);
  const [ticketsError, setTicketsError] = useState("");
  const [openTicket, setOpenTicket] = useState(null);
  const [thread, setThread] = useState([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [beforeMessageId, setBeforeMessageId] = useState(null);
  const [earlierLoading, setEarlierLoading] = useState(false);
  const [reply, setReply] = useState("");
  const [replyAttachment, setReplyAttachment] = useState([]); // [{ data: dataURL, name }]
  const [replying, setReplying] = useState(false);
  const [replyMsg, setReplyMsg] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [resolving, setResolving] = useState(false);

  const restoreCreateDraft = useCallback(() => {
    const saved = SUPPORT_OPERATIONS_ENABLED ? operations.createDraft() : drafts.read();
    if (!saved && SUPPORT_OPERATIONS_ENABLED) return;
    setCreateDraftSaved(saved ? true : null);
    if (!saved) { setSubject(""); setBody(""); setCategory("other"); setPriority("normal"); return; }
    setSubject(saved.subject || ""); setBody(saved.body || "");
    setCategory(saved.category || "other"); setPriority(saved.priority || "normal");
  }, [operations, drafts]);
  useEffect(() => {
    if (open) { setTab(initialTab); restoreCreateDraft(); }
  }, [open, initialTab, restoreCreateDraft]);
  useEffect(() => () => {
    listRequest.current++; threadRequest.current++; actionRequest.current++;
    clearTimeout(closeTimer.current);
  }, [open]);

  // Save on edits, never on close/unmount: an old component must not restore
  // text after an explicit account purge or overwrite a newer draft.
  const saveCreateDraft = (patch = {}) => {
    if (SUPPORT_OPERATIONS_ENABLED) return null;
    const result = drafts.save({ subject, body, category, priority, ...patch });
    setCreateDraftSaved(result.saved ? (result.draft ? true : null) : false);
    return result.draft?.revision || null;
  };
  const saveReplyDraft = (text) => {
    if (SUPPORT_OPERATIONS_ENABLED || !openTicket) return null;
    const result = drafts.save({ body: text }, openTicket.id);
    setReplyDraftSaved(result.saved ? (result.draft ? true : null) : false);
    return result.draft?.revision || null;
  };
  const discardCreateDraft = () => {
    if (!drafts.clear()) { setCreateDraftSaved(false); return; }
    setCreateDraftSaved(null);
    setSubject(""); setBody(""); setCategory("other"); setPriority("normal"); setError("");
  };
  const discardReplyDraft = () => {
    if (!drafts.clear(openTicket.id)) { setReplyDraftSaved(false); return; }
    setReplyDraftSaved(null); setReply(""); setReplyMsg("");
  };

  const loadTickets = async () => {
    if (!supabase || !user?.id) return;
    const requestId = ++listRequest.current;
    const current = () => requestId === listRequest.current;
    setTicketsLoading(true); setTicketsError("");
    try {
      if (SUPPORT_OPERATIONS_ENABLED) {
        const pendingBefore = operations.createDraft();
        const rows = await operations.list();
        if (current()) {
          setTickets(rows);
          if (pendingBefore && !operations.createDraft()) { setSubject(""); setBody(""); setCategory("other"); setPriority("normal"); }
        }
        return;
      }
      // RLS on support_tickets is owner-or-admin; filter to this profile so an admin
      // sees only their own tickets here (the admin queue lives in Admin > Tickets).
      const { data: profile } = await supabase
        .from("profiles").select("id").eq("auth_user_id", user.id).maybeSingle();
      if (!current()) return;
      if (!profile) { setTickets([]); return; }
      setOwnProfileId(profile.id);
      const { data: rows, error: e1 } = await supabase
        .from("support_tickets")
        .select("id, subject, body, status, created_at, updated_at, archived_at, context_payload")
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
      // Open tickets first (grouped ahead of resolved/closed), most recent first within each group.
      const withMeta = (rows || []).map((r) => ({
        ...r,
        last_message_at: last[r.id]?.created_at || r.created_at,
        last_from_admin: !!last[r.id]?.is_admin_reply,
      }));
      const isSettled = (s) => s === "resolved" || s === "closed";
      withMeta.sort((a, b) => {
        const grp = Number(isSettled(a.status)) - Number(isSettled(b.status));
        if (grp) return grp;
        return new Date(b.last_message_at) - new Date(a.last_message_at);
      });
      if (current()) setTickets(withMeta);
    } catch (e) {
      if (current()) setTicketsError(e.message || "Could not load your tickets.");
    } finally {
      if (current()) setTicketsLoading(false);
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
  const loadAttachmentUrls = async (t, msgs, current = () => true) => {
    const onTicket = t.has_attachments || t.context_payload?.attachment_path || t.context_payload?.attachment_paths?.length;
    if (!onTicket && !msgs.some((m) => m.has_attachments || m.attachment_path || m.attachment_paths?.length)) return;
    const res = await supabase.functions.invoke("ticket-attachment-url", { body: { ticket_id: t.id } });
    if (!current()) return;
    if (res.error) { const message = await edgeErrorMessage(res.error, "Could not open the attachment."); if (current()) setReplyMsg(message); return; }
    setAttachmentUrls(linksFor(res.data?.urls ?? res.data?.url));
    setReplyUrls(res.data?.replies || {});
  };

  const openThread = async (t) => {
    const requestId = ++threadRequest.current;
    const current = () => requestId === threadRequest.current;
    const saved = SUPPORT_OPERATIONS_ENABLED ? operations.replyDraft(t.id) : drafts.read(t.id);
    setReplyDraftSaved(saved ? true : null);
    setOpenTicket(t); setThread([]); setReply(saved?.body || ""); setReplyAttachment([]); setReplyMsg("");
    setReplying(false); setResolving(false);
    setBeforeMessageId(null); setEarlierLoading(false);
    setAttachmentUrls([]); setReplyUrls({});
    setThreadLoading(true);
    try {
      if (SUPPORT_OPERATIONS_ENABLED) {
        const result = await operations.read(t.id);
        if (!current()) return;
        setOpenTicket(result.ticket); setThread(result.messages); setBeforeMessageId(result.before_message_id);
        setReply(operations.replyDraft(t.id)?.body || "");
        await loadAttachmentUrls(result.ticket, result.messages, current);
      } else {
        const { data, error } = await supabase.from("ticket_thread").select("*").eq("ticket_id", t.id);
        if (error) throw error;
        if (!current()) return;
        setThread(data || []);
        await loadAttachmentUrls(t, data || [], current);
      }
    } catch (e) { if (current()) setReplyMsg(e.message || "Could not load this ticket."); }
    finally { if (current()) setThreadLoading(false); }
  };

  const leaveThread = () => { threadRequest.current++; actionRequest.current++; setOpenTicket(null); };
  const loadEarlier = async () => {
    if (!openTicket || !beforeMessageId || earlierLoading) return;
    const requestId = threadRequest.current;
    const current = () => requestId === threadRequest.current;
    setEarlierLoading(true);
    try {
      const result = await operations.read(openTicket.id, beforeMessageId);
      if (!current()) return;
      setThread(existing => [...result.messages, ...existing].filter((m, i, rows) => rows.findIndex(row => row.id === m.id) === i));
      setBeforeMessageId(result.before_message_id);
      await loadAttachmentUrls(result.ticket, result.messages, current);
    } catch (e) { if (current()) setReplyMsg(e.message || "Could not load earlier replies."); }
    finally { if (current()) setEarlierLoading(false); }
  };

  const sendReply = async () => {
    const text = reply.trim();
    if (!openTicket || replying || threadLoading || (text.length < 1 && (SUPPORT_OPERATIONS_ENABLED || !replyAttachment.length))) return;
    const session = window.Clerk?.session;
    if (!SUPPORT_OPERATIONS_ENABLED && (!session || window.Clerk?.user?.id !== user?.id)) { setReplyMsg("Sign in to this account before sending. Your text has not been sent."); return; }
    const requestId = threadRequest.current;
    const current = () => requestId === threadRequest.current && (SUPPORT_OPERATIONS_ENABLED || (window.Clerk?.session === session && window.Clerk?.user?.id === user?.id));
    const savedRevision = saveReplyDraft(reply);
    setReplying(true); setReplyMsg("");
    try {
      if (SUPPORT_OPERATIONS_ENABLED) await operations.reply({ ticketId: openTicket.id, body: scrubSsn(text) });
      else {
        const res = await supabase.functions.invoke("reply-ticket", {
        body: {
          ticket_id: openTicket.id, body: scrubSsn(text),
          ...attachmentsPayload(replyAttachment),
        },
        });
        if (res.error) throw res.error;
        if (!supportReceiptConfirmed(res.data)) throw new Error("The server did not confirm this reply.");
        if (savedRevision) drafts.clear(openTicket.id, savedRevision);
      }
      if (!current()) return;
      setReply(""); setReplyAttachment([]); setReplyDraftSaved(null);
      setReplyMsg("Reply received.");
      loadTickets();
      try {
        if (SUPPORT_OPERATIONS_ENABLED) {
          const result = await operations.read(openTicket.id);
          if (!current()) return;
          setOpenTicket(result.ticket); setThread(result.messages); setBeforeMessageId(result.before_message_id);
          await loadAttachmentUrls(result.ticket, result.messages, current);
        } else {
          const { data, error } = await supabase.from("ticket_thread").select("*").eq("ticket_id", openTicket.id);
          if (error) throw error;
          if (!current()) return;
          setThread(data || []); await loadAttachmentUrls(openTicket, data || [], current);
        }
      } catch { if (current()) setReplyMsg("Reply received. Reopen the ticket to refresh the conversation."); }
    } catch (e) {
      const message = SUPPORT_OPERATIONS_ENABLED ? e.message || "Could not confirm your reply. Try again." : await supportSubmissionError(e);
      if (current()) setReplyMsg(message);
    } finally {
      if (current()) setReplying(false);
    }
  };

  // Owner can close out their own ticket once it's actually solved. RLS lets
  // the owner UPDATE their own support_tickets row (tickets_owner_or_admin_update),
  // so this is a direct client update, no edge function needed. Resolving also
  // archives it: it drops off the main list for both the owner and admin, and
  // moves to the Archived view on each side. Replying to it later still works
  // fine from that view -- archiving is a visibility flag, not a lock.
  const markResolved = async () => {
    if (!openTicket) return;
    if (!window.confirm("Mark this ticket resolved? You can still reply later if it comes back.")) return;
    const requestId = threadRequest.current;
    const current = () => requestId === threadRequest.current;
    setResolving(true); setReplyMsg("");
    try {
      const { error } = await supabase.from("support_tickets")
        .update({
          status: "resolved", resolved_at: new Date().toISOString(),
          archived_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        })
        .eq("id", openTicket.id);
      if (error) throw error;
      if (!current()) return;
      setOpenTicket((t) => (t ? { ...t, status: "resolved", archived_at: new Date().toISOString() } : t));
      loadTickets();
    } catch (e) {
      if (current()) setReplyMsg(e.message || "Could not mark this resolved.");
    } finally {
      if (current()) setResolving(false);
    }
  };

  // A ticket can be resolved without being archived: it was resolved before
  // resolving also archived, or an admin resolved it. "Mark as resolved" is
  // hidden once a ticket is resolved, so without this such a ticket could
  // never leave the active list. Archiving changes visibility only.
  const archiveResolved = async () => {
    if (!openTicket) return;
    const requestId = threadRequest.current;
    const current = () => requestId === threadRequest.current;
    setResolving(true); setReplyMsg("");
    try {
      const now = new Date().toISOString();
      const { error } = await supabase.from("support_tickets")
        .update({ archived_at: now, updated_at: now }).eq("id", openTicket.id);
      if (error) throw error;
      if (!current()) return;
      setOpenTicket((t) => (t ? { ...t, archived_at: now } : t));
      loadTickets();
    } catch (e) {
      if (current()) setReplyMsg(e.message || "Could not archive this ticket.");
    } finally {
      if (current()) setResolving(false);
    }
  };

  const reset = useCallback(() => {
    listRequest.current++; threadRequest.current++; actionRequest.current++;
    clearTimeout(closeTimer.current);
    setSubject(""); setBody(""); setCategory("other"); setPriority("normal");
    setDone(false); setDoneNote(""); setError("");
    setCreateDraftSaved(null); setReplyDraftSaved(null);
    setOpenTicket(null); setThread([]); setReply(""); setReplyMsg("");
    setAttachment([]); setReplyAttachment([]); setAttachmentUrls([]); setReplyUrls({});
    setShowArchived(false);
    setSubmitting(false); setReplying(false); setThreadLoading(false); setBeforeMessageId(null);
  }, []);

  const close = useCallback(() => { onClose(); reset(); }, [onClose, reset]);

  // This sheet is not built on shared/Modal, so it joins the modal stack
  // itself: the desk keys stay quiet beneath it, and Escape closes it one
  // layer at a time like every other modal.
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
      close();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, close, isDesktop]);

  if (!open) return null;

  const submit = async () => {
    if (submitting) return;
    // Feedback shouldn't demand a subject line, derive one from the message
    const subj = subject.trim() || body.trim().slice(0, 80);
    if (subj.length < 3) { setError("Tell us a bit more first."); return; }
    if (body.trim().length < 10)   { setError("Tell us a bit more, at least 10 characters."); return; }
    if (!supabase) { setError("App not connected to backend."); return; }

    const session = window.Clerk?.session;
    if (!SUPPORT_OPERATIONS_ENABLED && (!session || window.Clerk?.user?.id !== user?.id)) { setError("Sign in to this account before sending. Your text has not been sent."); return; }
    const savedRevision = saveCreateDraft();
    setSubmitting(true); setError("");
    const requestId = ++actionRequest.current;
    const current = () => requestId === actionRequest.current && (SUPPORT_OPERATIONS_ENABLED || (window.Clerk?.session === session && window.Clerk?.user?.id === user?.id));
    try {
      let shortfall = "";
      // A ticket is stored in the cloud and read by people, so an SSN-shaped
      // number typed into it is taken out on the way (outgoingText.js).
      if (SUPPORT_OPERATIONS_ENABLED) await operations.create({ subject: scrubSsn(subj), body: scrubSsn(body.trim()), category, priority });
      else {
        const res = await supabase.functions.invoke("create-ticket", {
        body: {
          subject: scrubSsn(subj),
          body: scrubSsn(body.trim()),
          category: category === "feedback" ? "other" : category,
          priority,
          context_page: contextPage || window.location.pathname,
          ...attachmentsPayload(attachment),
        },
        });
        if (res.error) throw res.error;
        if (!supportReceiptConfirmed(res.data)) throw new Error("The server did not confirm this ticket.");
        if (savedRevision) drafts.clear("create", savedRevision);
        shortfall = ticketAttachmentShortfall(res.data);
      }
      if (!current()) return;
      // The sheet may stay open to show what did not attach, so the sent
      // ticket must not stay in the form to be sent a second time.
      setSubject(""); setBody(""); setCategory("other"); setPriority("normal"); setAttachment([]); setCreateDraftSaved(null);
      setDoneNote(shortfall);
      setDone(true);
      if (!shortfall) closeTimer.current = setTimeout(() => { if (current()) { onClose(); reset(); } }, 2600);
    } catch (e) {
      const message = SUPPORT_OPERATIONS_ENABLED ? e.message || "Could not confirm receipt. Try again." : await supportSubmissionError(e);
      if (current()) setError(message);
    } finally {
      if (current()) setSubmitting(false);
    }
  };

  const inputStyle = {
    width: "100%", padding: "10px 12px", borderRadius: 10,
    backgroundColor: T.input, border: `1px solid ${T.inputBorder || T.border}`,
    color: T.text, fontSize: 16, outline: "none", boxSizing: "border-box",
  };
  const pendingCreate = SUPPORT_OPERATIONS_ENABLED && operations.createDraft();
  const pendingReply = SUPPORT_OPERATIONS_ENABLED && openTicket && operations.replyDraft(openTicket.id);

  const tabBtn = (id, label) => (
    <button key={id} disabled={submitting} onClick={() => { setTab(id); leaveThread(); if (SUPPORT_OPERATIONS_ENABLED && id === "new") restoreCreateDraft(); }} style={{
      flex: 1, padding: "8px 10px", borderRadius: 8, border: "none", cursor: "pointer",
      backgroundColor: tab === id ? T.card : "transparent",
      color: tab === id ? T.text : T.textMuted, fontSize: 13, fontWeight: 700,
      boxShadow: tab === id ? "0 1px 2px rgba(0,0,0,0.15)" : "none",
    }}>{label}</button>
  );

  const draftNotice = (saved, discard, busy) => <div style={{ marginTop: 8, fontSize: 12, color: T.textMuted }}>
    <p role="status" style={{ margin: "0 0 4px" }}>{saved === false
      ? "This tab could not save your draft. Copy your text before closing or signing in again."
      : saved ? "Text draft saved for this account in this tab for up to 24 hours. Closing this support window keeps it; explicit sign-out removes it. Reattach files after reopening."
        : "Text drafts stay in this tab for up to 24 hours. Attached files are not saved in drafts."}</p>
    {saved !== null && <button onClick={discard} disabled={busy} style={{ padding: "6px 0", border: "none", background: "none", color: T.accent, cursor: "pointer" }}>Discard text draft</button>}
  </div>;

  const renderNew = () => (
    <>
      <h2 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 800, color: T.text }}>
        Help & feedback
      </h2>
      <p style={{ margin: "0 0 16px", fontSize: 13, color: T.textMuted }}>
        Send a bug report, question, or suggestion. Follow the conversation under Your tickets.
        Automated replies are labeled. Email updates depend on a verified address and successful delivery.
      </p>
      {pendingCreate && <p role="status" style={{ fontSize: 12, color: T.textMuted }}>Your previous submission has not been confirmed. Its text is saved below so you can retry the same request. You can also check Your tickets.</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <label style={{ fontSize: 12, fontWeight: 700, color: T.textMuted }}>Category</label>
        <select value={category} disabled={submitting || !!pendingCreate} onChange={(e) => { setCategory(e.target.value); saveCreateDraft({ category: e.target.value }); }} style={inputStyle}>
          {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>

        <label style={{ fontSize: 12, fontWeight: 700, color: T.textMuted }}>Priority</label>
        <select value={priority} disabled={submitting || !!pendingCreate} onChange={(e) => { setPriority(e.target.value); saveCreateDraft({ priority: e.target.value }); }} style={inputStyle}>
          {PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>

        <label style={{ fontSize: 12, fontWeight: 700, color: T.textMuted }}>Subject</label>
        <input
          value={subject}
          disabled={submitting || !!pendingCreate}
          onChange={(e) => { setSubject(e.target.value); saveCreateDraft({ subject: e.target.value }); }}
          placeholder="Short summary (optional)"
          maxLength={200}
          style={inputStyle}
        />

        <label style={{ fontSize: 12, fontWeight: 700, color: T.textMuted }}>What happened</label>
        <textarea
          value={body}
          disabled={submitting || !!pendingCreate}
          maxLength={10000}
          onChange={(e) => { setBody(e.target.value); saveCreateDraft({ body: e.target.value }); }}
          placeholder="As much detail as helps: steps, error messages, what you expected."
          style={{ ...inputStyle, minHeight: 120, resize: "vertical", fontFamily: "inherit" }}
        />

        {!SUPPORT_OPERATIONS_ENABLED && <>
          <label style={{ fontSize: 12, fontWeight: 700, color: T.textMuted }}>Screenshot or file (optional)</label>
          <ScreenshotAttach value={attachment} onChange={setAttachment} />
        </>}
        {SUPPORT_OPERATIONS_ENABLED && <p style={{ margin: 0, fontSize: 12, color: T.textMuted }}>Please describe the issue in text. Attachments are not available here yet.</p>}
      </div>

      {!SUPPORT_OPERATIONS_ENABLED && draftNotice(createDraftSaved, discardCreateDraft, submitting)}
      {error && (
        <div role="alert" style={{
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
          {submitting ? "Sending..." : pendingCreate ? "Retry same ticket" : "Send ticket"}
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

  const renderTicketList = () => {
    const activeTickets = tickets.filter((t) => !t.archived_at);
    const archivedTickets = tickets.filter((t) => t.archived_at);
    const shownTickets = showArchived ? archivedTickets : activeTickets;
    return (
    <>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 4 }}>
        <h2 style={{ margin: "0 0 4px", flex: 1, fontSize: 18, fontWeight: 800, color: T.text }}>
          {showArchived ? "Archived tickets" : "Your tickets"}
        </h2>
        {archivedTickets.length > 0 && (
          <button onClick={() => setShowArchived((a) => !a)} style={{
            padding: "5px 10px", borderRadius: 8, border: `1px solid ${T.border}`,
            backgroundColor: showArchived ? T.card : "transparent", color: showArchived ? T.text : T.textMuted,
            fontSize: 11.5, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap",
          }}>{showArchived ? "Back to active" : `Archived (${archivedTickets.length})`}</button>
        )}
      </div>
      <p style={{ margin: "0 0 14px", fontSize: 13, color: T.textMuted }}>
        {showArchived
          ? "Resolved tickets you closed out. Still open for a reply if it comes back."
          : "Your requests and replies. Open a ticket to add details or check for an update."}
      </p>
      {ticketsLoading && <div style={{ fontSize: 13, color: T.textMuted, padding: "12px 0" }}>Loading...</div>}
      {ticketsError && <div style={{ fontSize: 12, color: "#ef4444", fontWeight: 600, padding: "8px 0" }}>{ticketsError}</div>}
      {!ticketsLoading && !ticketsError && shownTickets.length === 0 && (
        <div style={{ fontSize: 13, color: T.textMuted, padding: "16px 0", textAlign: "center" }}>
          {showArchived ? "No archived tickets." : "No tickets yet. Anything you send from New ticket shows up here."}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {shownTickets.map((t) => (
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
              {t.status !== "resolved" && t.status !== "closed" && (
                <span style={{ fontSize: 10, fontWeight: 700, color: T.textDim, whiteSpace: "nowrap" }}>
                  {daysOpen(t.created_at)}d open
                </span>
              )}
            </div>
            <div style={{ fontSize: 11.5, color: T.textDim, marginTop: 3 }}>
              Last message {timeAgo(t.last_message_at)}
            </div>
          </button>
        ))}
      </div>
      <button onClick={close} style={{
        width: "100%", marginTop: 14, padding: "12px", borderRadius: 10,
        border: `1px solid ${T.border}`, backgroundColor: "transparent",
        color: T.text, fontSize: 14, fontWeight: 600, cursor: "pointer",
      }}>Done</button>
    </>
    );
  };

  // A reply can be text, files, or both.
  const canSend = !replying && !threadLoading && (reply.trim().length > 0 || (!SUPPORT_OPERATIONS_ENABLED && replyAttachment.length > 0));

  const renderThread = () => (
    <>
      <button onClick={leaveThread} style={{
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
      {beforeMessageId && <button onClick={loadEarlier} disabled={earlierLoading} style={{ padding: "8px 0", background: "none", border: "none", color: T.accent, cursor: "pointer" }}>{earlierLoading ? "Loading earlier replies..." : "Show earlier replies"}</button>}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {openTicket.body && (
          <div style={{ padding: "9px 11px", borderRadius: 10, backgroundColor: T.input, border: `1px solid ${T.border}` }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 }}>
              You {"·"} {new Date(openTicket.created_at).toLocaleString()}
            </div>
            <div style={{ fontSize: 13, color: T.text, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{openTicket.body}</div>
            <TicketAttachments urls={attachmentUrls} size={160} />
          </div>
        )}
        {thread.map(m => <SupportMessage key={m.id} message={m} theme={T} ownProfileId={ownProfileId} urls={replyUrls[m.id]} />)}
        {!threadLoading && thread.length === 0 && (
          <div style={{ fontSize: 12.5, color: T.textMuted, padding: "6px 0" }}>
            No replies yet.
          </div>
        )}
      </div>

      <textarea
        value={reply}
        disabled={replying || threadLoading || !!pendingReply}
        maxLength={10000}
        onChange={(e) => { setReply(e.target.value); saveReplyDraft(e.target.value); }}
        placeholder="Add to this ticket"
        style={{ ...inputStyle, minHeight: 80, marginTop: 12, resize: "vertical", fontFamily: "inherit" }}
      />
      {!SUPPORT_OPERATIONS_ENABLED && draftNotice(replyDraftSaved, discardReplyDraft, replying)}
      {pendingReply && <p role="status" style={{ fontSize: 12, color: T.textMuted }}>Your previous reply has not been confirmed. Retry the saved reply using the same request.</p>}
      {!SUPPORT_OPERATIONS_ENABLED && <ScreenshotAttach value={replyAttachment} onChange={setReplyAttachment} style={{ marginTop: 8 }} />}
      {replyMsg && <div role="status" style={{ marginTop: 6, fontSize: 12.5, fontWeight: 700, color: replyMsg.startsWith("Reply received.") ? T.accent : "#ef4444" }}>{replyMsg}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button onClick={sendReply} disabled={!canSend} style={{
          flex: 1, padding: "12px", borderRadius: 10, border: "none",
          backgroundColor: canSend ? T.accent : T.textDim,
          color: "#fff", fontSize: 14, fontWeight: 700,
          cursor: canSend ? "pointer" : "not-allowed",
        }}>{replying ? "Sending..." : pendingReply ? "Retry same reply" : "Send reply"}</button>
        <button onClick={leaveThread} style={{
          padding: "12px 18px", borderRadius: 10,
          border: `1px solid ${T.border}`, backgroundColor: "transparent",
          color: T.text, fontSize: 14, fontWeight: 600, cursor: "pointer",
        }}>Back</button>
      </div>
      {openTicket.status !== "resolved" && openTicket.status !== "closed" && (
        <button onClick={markResolved} disabled={resolving} style={{
          width: "100%", marginTop: 10, padding: "12px", borderRadius: 10,
          border: `1px solid ${T.border}`, backgroundColor: "transparent",
          color: T.accent, fontSize: 14, fontWeight: 700,
          cursor: resolving ? "default" : "pointer",
        }}>
          {resolving ? "Marking resolved..." : "Mark as resolved"}
        </button>
      )}
      {(openTicket.status === "resolved" || openTicket.status === "closed") && !openTicket.archived_at && (
        <button onClick={archiveResolved} disabled={resolving} style={{
          width: "100%", marginTop: 10, padding: "12px", borderRadius: 10,
          border: `1px solid ${T.border}`, backgroundColor: "transparent",
          color: T.accent, fontSize: 14, fontWeight: 700,
          cursor: resolving ? "default" : "pointer",
        }}>
          {resolving ? "Archiving..." : "Move to archive"}
        </button>
      )}
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

        {done && doneNote ? (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <div role="status" style={{ fontSize: 15, fontWeight: 700, color: T.text, lineHeight: 1.5 }}>
              {doneNote}
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button onClick={() => { setDone(false); setDoneNote(""); setTab("tickets"); leaveThread(); }} style={{
                flex: 1, padding: "12px", borderRadius: 10, border: "none",
                backgroundColor: T.accent, color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer",
              }}>Open Your tickets</button>
              <button onClick={close} style={{
                padding: "12px 18px", borderRadius: 10, border: `1px solid ${T.border}`,
                backgroundColor: "transparent", color: T.text, fontSize: 14, fontWeight: 600, cursor: "pointer",
              }}>Done</button>
            </div>
          </div>
        ) : done ? (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>{"✓"}</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>
              Ticket received.
            </div>
            <div style={{ fontSize: 13, color: T.textMuted, marginTop: 4 }}>
              Your request is saved. Follow replies and add details under Your tickets.
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
