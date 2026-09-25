import { useEffect, useRef, useState } from "react";
import { edgeErrorMessage } from "../../utils/edgeError";
import { useApp } from "../../context/AppContext";
import { supabase } from "../../lib/supabase";
import { useIsAdmin } from "../../lib/admin";
import { ADMIN_SOURCES, adminTabSources, readAdminSource, readAdminAttention, filterAdminTickets, filterAdminUsers } from "../../utils/adminData";
import AdminOperationsReport from "./AdminOperationsReport";
import AdminErrorReports from "./AdminErrorReports";
import AdminAccessChange from "./AdminAccessChange";
import AdminControlHistory from "./AdminControlHistory";
import { AdminPreviewPicker } from "./AdminPreview";
import { Modal, ScreenshotAttach } from "../shared";
import { foundingText } from "../../utils/founding";
import { setupProgressSummary } from "../../utils/setupTasks";
import { leadNoteLabel } from "../../utils/adminLabels";
import { waitlistView, leadState } from "../../utils/adminWaitlist";
import { attachmentsPayload, linksFor } from "../../utils/ticketAttachments";
import TicketAttachments from "../shared/TicketAttachments";
import { loadAdminSupportThread } from "../../utils/adminSupportThread";
import { ADMIN_TICKET_CATEGORIES, adminTicketDraftProblem } from "../../utils/adminTicketDraft";
import AdminLifetimeAccess from "./AdminLifetimeAccess";
import AdminLifetimeGift from "./AdminLifetimeGift";

/**
 * AdminDashboard — displayed for server-verified administrators only.
 * Reads from `admin_feedback_recent`, `admin_tickets_open`, `admin_signups_daily`
 * views (created in supabase-tracking-migration.sql).
 */
export default function AdminDashboard() {
  const { user } = useApp();
  return <AdminDashboardContent key={user?.id || "signed-out"} />;
}

function AdminDashboardContent() {
  const { theme: T, user, data, userIdRef, updateSettings } = useApp();
  const [tab, setTab] = useState("reports");
  const [coverage, setCoverage] = useState({});
  const [rowLimits, setRowLimits] = useState({});
  const [ticketPreset, setTicketPreset] = useState({});
  const [accountPreset, setAccountPreset] = useState("all");
  const [tickets, setTickets] = useState([]);   // unarchived tickets, all of them
  const [archivedRows, setArchivedRows] = useState([]); // archived tickets, loaded on demand
  const [feedback, setFeedback] = useState([]);
  const [signups, setSignups] = useState([]);
  const [visits, setVisits] = useState([]);
  const [waitlist, setWaitlist] = useState([]);
  const [attempts, setAttempts] = useState([]);
  const [fields, setFields] = useState([]);
  const [users, setUsers] = useState([]);       // profiles directory (admin read)
  const [invites, setInvites] = useState([]);   // beta_access allowlist
  const [errors, setErrors] = useState([]);     // client_errors (report-error sink)
  const [messages, setMessages] = useState([]); // admin_messages_overview (sent notes)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openTicket, setOpenTicket] = useState(null);
  const [thread, setThread] = useState([]);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [ticketMsg, setTicketMsg] = useState("");
  // Signed links from ticket-attachment-url: the ticket's own screenshot, and
  // one per reply keyed by message id. replyAttachment is the one going out
  // with the next reply.
  const [attachmentUrls, setAttachmentUrls] = useState([]);
  const [replyUrls, setReplyUrls] = useState({});
  const [replyAttachment, setReplyAttachment] = useState([]); // [{ data: dataURL, name }]
  // Manual ticket controls — the assistant sometimes fails to raise a card,
  // and resolved tickets pile up; both get first-class buttons here.
  const [showArchived, setShowArchived] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newSubject, setNewSubject] = useState("");
  const [newBody, setNewBody] = useState("");
  const [newCategory, setNewCategory] = useState("feature_request");
  const [creating, setCreating] = useState(false);
  const [newAttachment, setNewAttachment] = useState([]); // [{ data: dataURL, name }]
  const threadGeneration = useRef(0);
  const activeTicketId = useRef(null);
  // One request ID per composed reply, reused on every retry of that same
  // reply, so a reply whose response was lost is not saved (and emailed to
  // the physician) twice. A different body, status or file gets a new one.
  const replyRequest = useRef(null);
  // Tickets whose Resolve & archive saved its reply but failed to archive: a
  // retry with an empty box only archives, while the ticket is still resolved.
  const archivePending = useRef(new Set());
  useEffect(() => () => { threadGeneration.current += 1; activeTicketId.current = null; }, []);
  const currentThread = (ticketId) => {
    const generation = threadGeneration.current;
    return () => activeTicketId.current === ticketId && threadGeneration.current === generation;
  };
  const replyRequestId = (ticketId, body, status, files) => {
    const fingerprint = JSON.stringify([ticketId, body, status || null, files.map(f => [f.name || "", f.data?.length || 0, f.data?.slice(-64) || ""])]);
    if (replyRequest.current?.fingerprint !== fingerprint) replyRequest.current = { fingerprint, id: globalThis.crypto?.randomUUID?.() ?? null };
    return replyRequest.current.id;
  };
  const closeTicketDetail = () => {
    threadGeneration.current += 1; activeTicketId.current = null;
    setOpenTicket(null); setThread([]); setAttachmentUrls([]); setReplyUrls({}); setBusy(false);
  };

  const isAdmin = useIsAdmin();

  const refreshTickets = async () => { setReloadKey(k => k + 1); };

  // Signed links for every screenshot on the thread (the ticket's own plus one
  // per reply), one round trip through ticket-attachment-url.
  const loadAttachmentUrls = async (t, msgs, isCurrent) => {
    const onTicket = t.context_payload?.attachment_path || t.context_payload?.attachment_paths?.length;
    if (!onTicket && !msgs.some((m) => m.attachment_path || m.attachment_paths?.length)) return;
    const res = await supabase.functions.invoke("ticket-attachment-url", { body: { ticket_id: t.id } });
    if (!isCurrent()) return;
    if (res.error) {
      const message = await edgeErrorMessage(res.error, "Could not open the screenshot.");
      if (isCurrent()) setTicketMsg(message);
      return;
    }
    setAttachmentUrls(linksFor(res.data?.urls ?? res.data?.url));
    setReplyUrls(res.data?.replies || {});
  };

  // Tap a ticket → read it, see the whole thread, answer it, change its state.
  const openTicketDetail = async (t) => {
    threadGeneration.current += 1; activeTicketId.current = t.id;
    const isCurrent = currentThread(t.id);
    setOpenTicket(t); setReply(""); setReplyAttachment([]); setTicketMsg("");
    setThread([]); setBusy(false); setAttachmentUrls([]); setReplyUrls({});
    const { data, error: threadError } = await loadAdminSupportThread(supabase, t.id);
    if (!isCurrent()) return;
    setThread(data || []);
    if (threadError) { setTicketMsg("Could not load the conversation. Reopen this ticket to try again."); return; }
    await loadAttachmentUrls(t, data || [], isCurrent);
  };

  const createTicket = async () => {
    const subject = newSubject.trim();
    const body = newBody.trim();
    const problem = adminTicketDraftProblem({ subject, body, category: newCategory });
    if (problem) { setTicketMsg(problem); return; }
    setCreating(true); setTicketMsg("");
    try {
      const res = await supabase.functions.invoke("create-ticket", {
        body: {
          subject: subject.slice(0, 180), body, category: newCategory, priority: "normal", context_page: "admin",
          ...attachmentsPayload(newAttachment),
        },
      });
      if (res.error) throw new Error(await edgeErrorMessage(res.error, "That request failed."));
      setNewOpen(false); setNewSubject(""); setNewBody(""); setNewAttachment([]);
      await refreshTickets();
    } catch (e2) { setTicketMsg(e2.message); }
    setCreating(false);
  };

  // Release a physician's ticket to the unattended agent, or take it back.
  // Ticket 8e66cf06: a user's request has to come to Eric and be approved
  // before the agent works or answers it. The runner's queue asks the same
  // question (scripts/ticket-agent.sh APPROVED), so this button is the whole
  // gate. A ticket Eric filed himself needs no approval and shows no button:
  // filing it was the approval.
  const setAgentApproved = async (t, approved) => {
    const isCurrent = currentThread(t.id);
    const { error: e2 } = await supabase.from("support_tickets")
      .update({ agent_approved_at: approved ? new Date().toISOString() : null })
      .eq("id", t.id);
    if (!isCurrent()) { await refreshTickets(); return; }
    if (e2) { setTicketMsg(e2.message); return; }
    setTicketMsg(approved
      ? "Released to the agent. It will pick this up on its next run."
      : "Approval withdrawn. The agent will not touch this.");
    await refreshTickets();
    if (!isCurrent()) return;
    setOpenTicket((cur) => (cur && cur.id === t.id
      ? { ...cur, agent_approved_at: approved ? new Date().toISOString() : null }
      : cur));
  };

  const setArchived = async (t, archived) => {
    const isCurrent = currentThread(t.id);
    const { error: e2 } = await supabase.from("support_tickets")
      .update({ archived_at: archived ? new Date().toISOString() : null })
      .eq("id", t.id);
    if (e2) { if (isCurrent()) setTicketMsg(e2.message); return; }
    if (isCurrent()) closeTicketDetail();
    await refreshTickets();
  };

  // One tap: mark resolved and archive, instead of two separate trips into the ticket.
  const resolveAndArchive = async () => {
    if (!openTicket) return;
    const ticketId = openTicket.id;
    const isCurrent = currentThread(ticketId);
    const body = reply.trim();
    setBusy(true); setTicketMsg("");
    const archiveFailed = (message) => new Error(`Your reply was sent and the ticket marked resolved, but it could not be archived (${message}). Tap Resolve & archive again to archive it.`);
    try {
      // The reply already went out on an earlier tap and only the archive
      // failed: archive, do not answer the physician a second time. Only
      // while the ticket is still resolved, though. A physician reply reopens
      // it and a reply sent here since can move it, so the row itself is
      // checked; if it moved, it is resolved again below.
      let archived = false;
      if (archivePending.current.has(ticketId) && !body && !replyAttachment.length) {
        const { data: stillResolved, error: e2 } = await supabase.from("support_tickets")
          .update({ archived_at: new Date().toISOString() })
          .eq("id", ticketId).eq("status", "resolved").select("id");
        if (e2) throw archiveFailed(e2.message);
        archived = (stillResolved || []).length > 0;
        if (!archived) archivePending.current.delete(ticketId);
      }
      if (!archived) {
        const replyBody = body || "Status set to resolved.";
        const requestId = replyRequestId(ticketId, replyBody, "resolved", replyAttachment);
        const res = await supabase.functions.invoke("reply-ticket", {
          body: {
            ticket_id: ticketId, body: replyBody, status: "resolved",
            ...attachmentsPayload(replyAttachment),
            ...(requestId ? { client_request_id: requestId } : {}),
          },
        });
        if (res.error) throw new Error(await edgeErrorMessage(res.error, "That request failed."));
        replyRequest.current = null;
        archivePending.current.add(ticketId);
        if (isCurrent()) { setReply(""); setReplyAttachment([]); }
        const { error: e2 } = await supabase.from("support_tickets")
          .update({ archived_at: new Date().toISOString() })
          .eq("id", ticketId);
        if (e2) throw archiveFailed(e2.message);
      }
      archivePending.current.delete(ticketId);
      if (!isCurrent()) { await refreshTickets(); return; }
      setTicketMsg("Resolved and archived.");
      await refreshTickets();
      setTimeout(() => { if (isCurrent()) closeTicketDetail(); }, 900);
    } catch (e2) {
      if (isCurrent()) setTicketMsg(e2.message);
    }
    if (isCurrent()) setBusy(false);
  };

  const sendReply = async (newStatus) => {
    if (!openTicket) return;
    const isCurrent = currentThread(openTicket.id);
    const body = reply.trim();
    if (!body && !newStatus && !replyAttachment.length) { setTicketMsg("Write a reply first."); return; }
    setBusy(true); setTicketMsg("");
    try {
      // A screenshot alone is a valid reply; reply-ticket gives it a stock body.
      const replyBody = body || (newStatus ? `Status set to ${newStatus}.` : "");
      const requestId = replyRequestId(openTicket.id, replyBody, newStatus, replyAttachment);
      const res = await supabase.functions.invoke("reply-ticket", {
        body: {
          ticket_id: openTicket.id,
          body: replyBody,
          ...(newStatus ? { status: newStatus } : {}),
          ...attachmentsPayload(replyAttachment),
          ...(requestId ? { client_request_id: requestId } : {}),
        },
      });
      if (res.error) throw new Error(await edgeErrorMessage(res.error, "That request failed."));
      replyRequest.current = null;
      if (!isCurrent()) { await refreshTickets(); return; }
      const { data, error: threadError } = await loadAdminSupportThread(supabase, openTicket.id);
      if (!isCurrent()) return;
      setThread(data || []);
      setReply(""); setReplyAttachment([]);
      setTicketMsg(threadError ? "Your reply was saved, but the conversation could not refresh. Reopen this ticket to check it." : newStatus ? `Marked ${newStatus.replace("_", " ")}.` : "Reply sent.");
      await refreshTickets();
      if (!isCurrent()) return;
      await loadAttachmentUrls(openTicket, data || [], isCurrent);
      if (newStatus === "resolved" || newStatus === "closed") setTimeout(() => { if (isCurrent()) closeTicketDetail(); }, 900);
    } catch (e2) {
      if (isCurrent()) setTicketMsg(e2.message);
    }
    if (isCurrent()) setBusy(false);
  };

  // The panel loaded once per app session, so every number aged until the
  // whole app was reloaded. reloadKey re-runs the same fetch, and the tab
  // bar bumps it when a panel is opened.
  const [reloadKey, setReloadKey] = useState(0);
  const [reloadedAt, setReloadedAt] = useState(null);
  useEffect(() => {
    if (!isAdmin || !supabase) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const keys = adminTabSources(tab, { showArchived });
    const setters = { tickets: setTickets, archivedTickets: setArchivedRows, feedback: setFeedback, signups: setSignups, visits: setVisits,
      waitlist: setWaitlist, attempts: setAttempts, fields: setFields, users: setUsers,
      invites: setInvites, errors: setErrors, messages: setMessages };
    setLoading(keys.length > 0); setError("");
    Promise.all(keys.map(key => readAdminSource(supabase, key, rowLimits[key]))).then(results => {
      if (cancelled) return;
      for (const result of results) {
        if (!result.error) setters[result.key](result.rows);
      }
      setCoverage(previous => ({ ...previous, ...Object.fromEntries(results.map(result => [result.key, result])) }));
      const failures = results.filter(result => result.error);
      setError(failures.map(result => `${ADMIN_SOURCES[result.key].label}: ${result.error}`).join(" · "));
      if (!failures.length) setReloadedAt(new Date());
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [isAdmin, reloadKey, tab, rowLimits, showArchived]);

  // Counts for the tab labels: unread physician replies, new error reports,
  // people waiting on the waitlist and field proposals to review. Read on
  // mount and whenever a tab is opened, without loading any list, so a reply
  // to a direct message shows up here before its thread is opened.
  const [attention, setAttention] = useState(null);
  const messagesSeenAt = data?.settings?.adminInboxSeenAt || null;
  const errorsSeenAt = data?.settings?.adminErrorsSeenAt || null;
  // The stamp from before Messages was opened, so the rows that brought a new
  // reply can still be marked after opening the tab moves the stamp to now.
  const [repliesSince, setRepliesSince] = useState(null);
  useEffect(() => {
    if (!isAdmin || !supabase) return;
    let cancelled = false;
    readAdminAttention(supabase, { messagesSeenAt, errorsSeenAt }).then(result => { if (!cancelled) setAttention(result); });
    return () => { cancelled = true; };
  }, [isAdmin, reloadKey, messagesSeenAt, errorsSeenAt]);

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

  const sectionKeys = adminTabSources(tab, { showArchived });
  const hasSectionData = sectionKeys.every(key => coverage[key]?.rows && !coverage[key]?.error);
  // Opening a panel reads again (every number here used to age for the whole
  // app session), and opening Messages or Errors marks them seen.
  const openTab = (id) => {
    setTab(id);
    setReloadKey((k) => k + 1);
    if (id === "messages") { setRepliesSince(messagesSeenAt || ""); updateSettings({ adminInboxSeenAt: new Date().toISOString() }); }
    if (id === "errors") updateSettings({ adminErrorsSeenAt: new Date().toISOString() });
  };
  // Only an Overview card applies a filter, and only for that drill-down. A
  // plain tab tap opens the tab unfiltered, so "Accounts" never silently hides
  // pending accounts after an earlier "Active account profiles" card.
  const selectTab = (id) => { setTicketPreset({}); setAccountPreset("all"); setShowArchived(false); openTab(id); };
  const navigateReport = (nextTab, filters = {}) => { setTicketPreset(filters); setAccountPreset(filters.access || "all"); setShowArchived(false); openTab(nextTab); };
  const activeTickets = tickets.filter(t => !t.archived_at);
  const archivedTickets = archivedRows.filter(t => t.archived_at);
  const archivedCount = coverage.archivedTickets?.count;
  // A failed count read is marked "(?)", never shown as a plain label that
  // reads the same as zero (readAdminAttention). No function yet: plain.
  const counts = attention && !attention.error ? attention : null;
  const countFailed = (label, noun) => ({ label: `${label} (?)`, title: `${noun} unavailable, open to check` });
  const TABS = [
    { id: "reports", label: "Overview & reports" },
    { id: "tickets", label: "Tickets" },
    attention?.error ? { id: "messages", ...countFailed("Messages", "Unread count") }
      : { id: "messages", label: counts?.unread_replies > 0 ? `Messages (${counts.unread_replies})` : "Messages" },
    { id: "users", label: "Accounts" },
    attention?.error ? { id: "errors", ...countFailed("Errors", "New error count") }
      : { id: "errors", label: counts?.new_errors_since_seen > 0 ? `Errors (${counts.new_errors_since_seen})` : "Errors" },
    { id: "signups", label: "Traffic history" },
    attention?.error ? { id: "waitlist", ...countFailed("Waitlist", "Waiting count") }
      : { id: "waitlist", label: counts ? `Waitlist (${counts.waitlist_waiting})` : "Waitlist" },
    attention?.error ? { id: "fields", ...countFailed("Fields", "Pending field count") }
      : { id: "fields", label: counts?.fields_pending > 0 ? `Fields (${counts.fields_pending} pending)` : "Fields" },
    { id: "ai", label: "AI" },
    { id: "audit", label: "Control history" },
    { id: "preview", label: "Preview as" },
  ];

  return (
    <div>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 800, color: T.text }}>Admin</h2>
      <p style={{ margin: "0 0 14px", fontSize: 12, color: T.textMuted }}>
        Support, accounts, waitlist signups, and traffic for credentialdomd.com
      </p>

      <nav aria-label="Administration sections" style={{
        display: "flex", gap: 4, marginBottom: 14, overflowX: "auto", WebkitOverflowScrolling: "touch",
        backgroundColor: T.input, borderRadius: 10, padding: 3,
      }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            aria-current={tab === t.id ? "page" : undefined}
            title={t.title}
            onClick={() => selectTab(t.id)}
            style={{
              flex: "0 0 auto", whiteSpace: "nowrap", padding: "8px 12px", borderRadius: 8, border: "none",
              backgroundColor: tab === t.id ? T.card : "transparent",
              color: tab === t.id ? T.text : T.textMuted,
              fontSize: 13, fontWeight: 700, cursor: "pointer",
            }}
          >{t.label}</button>
        ))}
      </nav>

      {tab === "reports" && <AdminOperationsReport T={T} onNavigate={navigateReport} />}
      {tab === "audit" && <AdminControlHistory T={T} />}
      {tab === "preview" && <AdminPreviewPicker T={T} />}
      {loading && <div style={{ padding: 20, textAlign: "center", color: T.textMuted }}>{hasSectionData ? "Refreshing…" : "Loading…"}</div>}
      {error && (
        <div role="alert" style={{
          padding: "10px 12px", borderRadius: 8,
          backgroundColor: "rgba(239,68,68,0.1)", color: "#ef4444", fontSize: 12,
          marginBottom: 12,
        }}>
          {error}
          <div style={{ fontSize: 12, color: T.textMuted, marginTop: 4 }}>This section could not refresh. Its lists are hidden until the read succeeds.</div>
          <button onClick={() => setReloadKey(k => k + 1)}>Retry section</button>
        </div>
      )}

      {!loading && !error && sectionKeys.length > 0 && (
        <div aria-label="List coverage" style={{ padding: "10px 12px", marginBottom: 12, border: `1px solid ${T.border}`, borderRadius: 10, color: T.textMuted, fontSize: 12 }}>
          <div>List counts describe loaded records. Overview & reports contains full-database totals.</div>
          {sectionKeys.map(key => {
            const item = coverage[key]; if (!item || item.error) return null;
            return <div key={key} style={{ marginTop: 5 }}>
              {ADMIN_SOURCES[key].label}: {item.rows.length} loaded{item.count !== null ? ` of ${item.count}` : " (total unavailable)"}
              {(item.count === null ? item.rows.length >= item.limit : item.rows.length < item.count) && <button style={{ marginLeft: 8 }} onClick={() => setRowLimits(previous => ({ ...previous, [key]: (previous[key] || ADMIN_SOURCES[key].size) + ADMIN_SOURCES[key].size }))}>Load more {ADMIN_SOURCES[key].label.toLowerCase()}</button>}
            </div>;
          })}
          <button style={{ marginTop: 8 }} onClick={() => setReloadKey(k => k + 1)}>Refresh section</button>
          {reloadedAt && <span style={{ marginLeft: 8 }}>Read {reloadedAt.toLocaleTimeString()}</span>}
        </div>
      )}
      {tab === "tickets"  && (!loading || hasSectionData) && !error && (
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
            }}>{showArchived ? "Back to active" : Number.isSafeInteger(archivedCount) ? `Archived (${archivedCount})` : "Archived"}</button>
          </div>
          <TicketsList key={JSON.stringify(ticketPreset) + String(showArchived)} initialFilters={showArchived ? {} : ticketPreset} rows={showArchived ? archivedTickets : activeTickets} T={T} onOpen={openTicketDetail} />
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
      {tab === "messages" && (!loading || hasSectionData) && !error && (
        <MessagesPanel messages={messages} users={users} myProfileId={userIdRef.current} repliesSince={repliesSince} T={T} onRefresh={() => setReloadKey(k => k + 1)} />
      )}
      {tab === "signups"  && (!loading || hasSectionData) && !error && (
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
            New accounts
          </div>
          <SignupsList rows={signups} T={T} reloadedAt={reloadedAt} onReload={() => setReloadKey((k) => k + 1)} />
        </>
      )}
      {tab === "errors" && (!loading || hasSectionData) && !error && <AdminErrorReports rows={errors} users={users} T={T} onCleared={ids => { setErrors(rows => rows.filter(row => !ids.includes(row.id))); setCoverage(previous => { const old = previous.errors; return old ? { ...previous, errors: { ...old, rows: old.rows.filter(row => !ids.includes(row.id)), count: old.count === null ? null : Math.max(0, old.count - ids.length) } } : previous; }); }} />}
      {tab === "users" && (!loading || hasSectionData) && !error && <UsersPanel key={accountPreset} initialAccess={accountPreset} myProfileId={userIdRef.current} users={users} setUsers={setUsers} invites={invites} T={T} onRefresh={() => setReloadKey(k => k + 1)} />}
      {tab === "waitlist" && (!loading || hasSectionData) && !error && <WaitlistList rows={waitlist} setRows={setWaitlist} attempts={attempts} setAttempts={setAttempts} users={users} invites={invites} T={T} onInvite={async (r) => {
        const res = await sendInvite({ email: r.email, name: r.name, lead_id: r.id });
        if (res.ok) {
          setWaitlist(rs => rs.map(x => x.id === r.id ? { ...x, status: "invited", invited_at: new Date().toISOString() } : x));
          const { data } = await supabase.from("beta_access").select("*").order("created_at", { ascending: false }).limit(500);
          if (data) setInvites(data);
        }
        return res;
      }} />}
      {tab === "fields" && (!loading || hasSectionData) && !error && <FieldProposals rows={fields} setRows={setFields} T={T} />}
      {tab === "ai" && (!loading || hasSectionData) && !error && <AiPanel users={users} ownKey={data?.settings?.apiKey || ""} T={T} />}

      {/* Tap a ticket → read it, answer it, close it */}
      <Modal open={!!openTicket} onClose={closeTicketDetail} title={openTicket?.subject || "Ticket"}>
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
            <TicketAttachments urls={attachmentUrls} size={200} />

            {thread.length > 0 && (
              <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                {thread.map(m => (
                  <div key={m.id} style={{
                    padding: "9px 11px", borderRadius: 10,
                    backgroundColor: m.is_admin_reply ? (T.accentDim || "rgba(59,130,246,0.12)") : T.card,
                    border: `1px solid ${T.border}`,
                  }}>
                    <div style={{ fontSize: 10, fontWeight: 800, color: m.is_admin_reply ? T.accent : T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 }}>
                      {m.support_display_label || "Reply"} · {new Date(m.created_at).toLocaleString()}
                    </div>
                    <div style={{ fontSize: 13, color: T.text, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{m.body}</div>
                    {Boolean(m.attachment_path || m.attachment_paths?.length) && (linksFor(replyUrls[m.id]).length ? (
                      <TicketAttachments urls={linksFor(replyUrls[m.id])} size={200} />
                    ) : (
                      <div style={{ marginTop: 6, fontSize: 11.5, color: T.textDim }}>File attached</div>
                    ))}
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
            <ScreenshotAttach value={replyAttachment} onChange={setReplyAttachment} style={{ marginTop: 8 }} />

            {ticketMsg && <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 700, color: T.accent }}>{ticketMsg}</div>}

            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              <button onClick={() => sendReply(null)} disabled={busy} style={{
                flex: 1, minWidth: 120, padding: "12px", borderRadius: 10, border: "none",
                backgroundColor: busy ? T.textDim : T.accent, color: "#fff", fontSize: 14, fontWeight: 800,
                cursor: busy ? "wait" : "pointer",
              }}>{busy ? "Sending…" : "Send reply"}</button>
              <button onClick={() => sendReply("resolved")} disabled={busy} style={{
                padding: "12px 14px", borderRadius: 10, border: "none",
                backgroundColor: "#10b981", color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer",
              }}>Resolve</button>
              {!openTicket.archived_at && (
                <button onClick={resolveAndArchive} disabled={busy} style={{
                  padding: "12px 14px", borderRadius: 10, border: "none",
                  backgroundColor: "#0d9488", color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer",
                }}>Resolve &amp; archive</button>
              )}
              <button onClick={() => setArchived(openTicket, !openTicket.archived_at)} disabled={busy} style={{
                padding: "12px 14px", borderRadius: 10, border: `1px solid ${T.border}`,
                backgroundColor: "transparent", color: T.textMuted, fontSize: 13, fontWeight: 700, cursor: "pointer",
              }}>{openTicket.archived_at ? "Unarchive" : "Archive"}</button>
              {openTicket.from_admin === false && (
                <button onClick={() => setAgentApproved(openTicket, !openTicket.agent_approved_at)} disabled={busy} style={{
                  padding: "12px 14px", borderRadius: 10,
                  border: openTicket.agent_approved_at ? `1px solid ${T.border}` : "none",
                  backgroundColor: openTicket.agent_approved_at ? "transparent" : "#7c3aed",
                  color: openTicket.agent_approved_at ? T.textMuted : "#fff",
                  fontSize: 13, fontWeight: openTicket.agent_approved_at ? 700 : 800, cursor: "pointer",
                }}>{openTicket.agent_approved_at ? "Withdraw from agent" : "Approve for agent"}</button>
              )}
            </div>
          </>
        )}
      </Modal>

      {/* Manual ticket entry — the direct road when the assistant fumbles */}
      <Modal open={newOpen} onClose={() => { setNewOpen(false); setNewAttachment([]); }} title="New ticket">
        <input value={newSubject} onChange={(e) => setNewSubject(e.target.value)}
          placeholder="One-line summary"
          style={{
            width: "100%", boxSizing: "border-box", padding: "12px 14px", borderRadius: 10,
            backgroundColor: T.input, border: `1px solid ${T.border}`, color: T.text, fontSize: 16,
          }} />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
          {ADMIN_TICKET_CATEGORIES.map(({ value: v, label: l }) => (
            <button key={v} onClick={() => setNewCategory(v)} aria-pressed={newCategory === v} style={{
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
        <ScreenshotAttach value={newAttachment} onChange={setNewAttachment} style={{ marginTop: 10 }} />
        {(() => {
          // Create stays off until the server's own rules are met, and says why.
          const problem = adminTicketDraftProblem({ subject: newSubject, body: newBody, category: newCategory });
          return <>
            {(ticketMsg || problem) && <div role="status" style={{ marginTop: 8, fontSize: 12.5, fontWeight: 700, color: ticketMsg ? T.accent : T.textMuted }}>{ticketMsg || problem}</div>}
            <button onClick={createTicket} disabled={creating || !!problem} style={{
              width: "100%", marginTop: 12, padding: "13px", borderRadius: 10, border: "none",
              backgroundColor: creating || problem ? T.textDim : T.accent, color: "#fff", fontSize: 14.5, fontWeight: 800,
              cursor: creating ? "wait" : problem ? "not-allowed" : "pointer",
            }}>{creating ? "Creating…" : "Create ticket"}</button>
          </>;
        })()}
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

// 16px or larger: below that, iOS Safari zooms the page when a control gets
// focus and leaves it zoomed (the same rule as shared/useInputStyle.js).
const FORM_CONTROL = { fontSize: 16 };

function TicketsList({ rows, T, onOpen, initialFilters = {} }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState(initialFilters.status || "all");
  const [priority, setPriority] = useState(initialFilters.priority || "all");
  const [approval, setApproval] = useState(initialFilters.approval || "all");
  const filtered = filterAdminTickets(rows, { query, status, priority, approval });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", color: T.text }}>
        <label>Search loaded tickets <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Subject, email or details" style={FORM_CONTROL} /></label>
        <label>Status <select value={status} onChange={event => setStatus(event.target.value)} style={FORM_CONTROL}>{["all", "unresolved", "open", "in_progress", "waiting_user", "resolved", "closed"].map(value => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></label>
        <label>Priority <select value={priority} onChange={event => setPriority(event.target.value)} style={FORM_CONTROL}>{["all", "urgent", "high", "normal", "low"].map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Approval <select value={approval} onChange={event => setApproval(event.target.value)} style={FORM_CONTROL}><option value="all">All tickets</option><option value="needs_review">Needs owner approval</option></select></label>
      </div>
      <div style={{ color: T.textMuted, fontSize: 12 }}>{filtered.length} matching tickets in {rows.length} loaded records.</div>
      {!filtered.length && <Empty T={T} text="No loaded tickets match these filters." />}
      {filtered.map((r) => (
        <div key={r.id} role="button" tabIndex={0}
          onClick={() => onOpen?.(r)}
          onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); onOpen?.(r); } }}
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
            {/* A physician's ticket the agent has not been released to. This
                is the one badge worth scanning the list for: it is the only
                state where somebody is waiting on YOU rather than on the
                agent. Tickets you filed yourself never show it. */}
            {r.from_admin === false && !r.agent_approved_at && (
              <span style={{
                fontSize: 10, fontWeight: 800, padding: "2px 8px",
                borderRadius: 10, color: "#fff", backgroundColor: "#7c3aed",
              }}>NEEDS YOU</span>
            )}
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

function SignupsList({ rows, T, onReload, reloadedAt }) {
  // admin_signups_daily only ever returns the last 90 days (created_at >
  // now() - 90 days), so "Load more" cannot widen it; say so on the total.
  if (!rows.length) return <Empty T={T} text="No new accounts in the last 90 days." />;
  const total = rows.reduce((s, r) => s + (r.signups || 0), 0);
  // The old number added these three together and called the sum "signups",
  // which is how a panel showing four physicians read 8.
  const abandoned = rows.reduce((s, r) => s + (r.abandoned || 0), 0);
  const adminAccts = rows.reduce((s, r) => s + (r.admin_accounts || 0), 0);
  return (
    <div>
      <div style={{
        backgroundColor: T.card, border: `2px solid ${T.accent}`,
        borderRadius: 12, padding: "12px 16px", marginBottom: 12,
      }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
          <div>
            <div style={{ fontSize: 11, color: T.textMuted }}>Last 90 days (rolling; server view limit)</div>
            <div style={{ fontSize: 26, fontWeight: 800, color: T.accent }}>{total}</div>
            <div style={{ fontSize: 11, color: T.textMuted }}>account records with email on file, excluding administrators</div>
            <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4, lineHeight: 1.5 }}>Includes deleted and closed accounts. "New signup profiles" in Overview &amp; reports leaves those out and uses the window you pick there, so the two numbers can differ.</div>
          </div>
          {onReload && (
            <button onClick={onReload} style={{
              padding: "6px 10px", borderRadius: 8, border: `1px solid ${T.border}`,
              backgroundColor: "transparent", color: T.text, fontSize: 11.5, fontWeight: 700, cursor: "pointer",
            }}>Refresh</button>
          )}
        </div>
        {(abandoned > 0 || adminAccts > 0) && (
          <div style={{ fontSize: 11.5, color: T.textMuted, marginTop: 8, lineHeight: 1.5 }}>
            Not counted above: {[
              abandoned ? `${abandoned} profiles with no email on file` : "",
              adminAccts ? `${adminAccts} your own admin account` : "",
            ].filter(Boolean).join(" \u00b7 ")}.
          </div>
        )}
        {reloadedAt && (
          <div style={{ fontSize: 11, color: T.textDim, marginTop: 6 }}>Read {reloadedAt.toLocaleTimeString()}</div>
        )}
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

async function sendInvite(body) {
  try {
    const { data, error } = await supabase.functions.invoke("send-invite", { body });
    if (error) {
      let msg = error.message;
      let held = false;
      try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; held = j?.held === true; } catch { /* ignore */ }
      return { ok: false, held, error: msg };
    }
    if (data?.held || data?.ok !== true) return { ok: false, held: data?.held === true, error: data?.error || "The server did not confirm an invitation send." };
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
function UsersPanel({ initialAccess = "all", myProfileId, users, setUsers, invites, T, onRefresh }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [showTest, setShowTest] = useState(false);
  const [lifetimeTarget, setLifetimeTarget] = useState(null);
  const [accessChange, setAccessChange] = useState(null);
  const [search, setSearch] = useState("");
  const [accessFilter, setAccessFilter] = useState(initialAccess);

  const refresh = async () => { onRefresh(); };

  const invite = async () => {
    const e = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) { setMsg("Enter a valid email."); return; }
    setBusy(true); setMsg("");
    const r = await sendInvite({ email: e, name: name.trim() });
    setBusy(false);
    if (r.ok) { setMsg(`Invitation sent to ${e}.`); setEmail(""); setName(""); refresh(); }
    else setMsg(r.held ? r.error : `Could not invite: ${r.error}`);
  };

  const resend = async (inv) => {
    setBusy(true); setMsg("");
    const r = await sendInvite({ email: inv.email, name: inv.name, resend: true });
    setBusy(false);
    setMsg(r.ok ? `Re-sent to ${inv.email}.` : r.held ? r.error : `Could not re-send: ${r.error}`);
    if (r.ok) refresh();
  };

  const setInviteStatus = (inv, status) => setAccessChange({ kind: "invite", row: inv, action: "set_status", status });
  const removeInvite = inv => setAccessChange({ kind: "invite", row: inv, action: "remove" });
  const setAccess = (u, status) => setAccessChange({ kind: "profile", row: u, status });

  const isTest = (u) => !u.email && !u.name && !u.npi && !u.last_seen_at;
  const shown = filterAdminUsers(users, { query: search, access: accessFilter, showEmpty: showTest });
  // Founding members: numbered by Postgres when a physician signs up and
  // is activated (profiles.founding_number). An invitation alone never counts.
  const foundingCount = users.filter(u => u.founding_number != null && u.access_status === "active").length;
  const hiddenCount = users.filter(isTest).length;
  const inviteByEmail = Object.fromEntries(invites.map(i => [i.email.toLowerCase(), i]));
  const accountEmails = new Set(users.map(u => (u.email || "").toLowerCase()).filter(Boolean));
  // Still outstanding: never signed in (no account, not activated), or paused.
  const openInvites = invites.filter(i => i.status === "revoked" || (!i.activated_at && !accountEmails.has((i.email || "").toLowerCase())));

  const card = { backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: "12px 14px", marginBottom: 8 };
  const chip = (label, color, onClick, active) => (
    <button key={label} onClick={onClick} disabled={busy} style={{ fontSize: 11, fontWeight: 700, padding: "4px 9px", borderRadius: 10, cursor: "pointer", border: `1px solid ${active ? color : T.border}`, backgroundColor: active ? color : "transparent", color: active ? "#fff" : T.textDim }}>{label}</button>
  );

  return (
    <div>
      <div style={{ ...card, marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>Give someone free lifetime access</div>
        <p style={{ fontSize: 13, color: T.textMuted, margin: "6px 0 0" }}>Someone who already has an account: choose “Give free lifetime access” on their row below. It checks their billing first and records your reason. Someone who has not signed up yet: gift it to their email address here and it applies the moment they confirm that address. Neither sends an email.</p>
      </div>
      <AdminLifetimeGift />
      <div style={{ ...card, marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 6 }}>Invite a physician</div>
        <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 8 }}>Invitation emails are on hold for owner review of the exact message and recipient list. An invitation request will not send email or change access while held.</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Name (optional)" style={{ flex: "1 1 120px", padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: T.input, color: T.text, fontSize: 13 }} />
          <input value={email} onChange={e => setEmail(e.target.value)} placeholder="email@domain.com" type="email" autoCapitalize="none" style={{ flex: "2 1 180px", padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: T.input, color: T.text, fontSize: 13 }} />
          <button onClick={invite} disabled={busy} style={{ padding: "8px 14px", borderRadius: 8, border: "none", backgroundColor: T.accent, color: "#fff", fontWeight: 700, fontSize: 13, cursor: "pointer" }}>{busy ? "..." : "Send invite"}</button>
        </div>
        <div role="status" aria-live="polite" style={{ fontSize: 12, color: msg.startsWith("Could not") ? "#ef4444" : T.textMuted, marginTop: 6 }}>{msg}</div>
      </div>

      {/* Only invitations still waiting on someone. Once they sign in they
          are an account below, and listing them twice read as a duplicate. */}
      <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, margin: "8px 0 6px" }}>Waiting on an invitation ({openInvites.length})</div>
      {openInvites.length === 0 && (
        <div style={{ fontSize: 12, color: T.textDim, marginBottom: 8 }}>
          {invites.length ? "Everyone invited has signed in; they are listed under Accounts." : "No invitations yet."}
        </div>
      )}
      {openInvites.map(inv => (
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
            {!inv.profile_id && !inv.activated_at ? <>
              {inv.status === "revoked" ? chip("Restore invitation", "#10b981", () => setInviteStatus(inv, "invited"), false) : chip("Pause invitation", "#ef4444", () => setInviteStatus(inv, "revoked"), false)}
              {chip("Remove", T.textDim, () => removeInvite(inv), false)}
            </> : <span style={{ color: T.textMuted, fontSize: 12 }}>Manage this invitation through its linked account below.</span>}
          </div>
        </div>
      ))}

      <div style={{ fontSize: 12, color: T.textMuted, margin: "14px 0 0" }}>
        Legacy founding badges: {foundingCount} (separate from paid founding memberships)
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <label>Search loaded accounts <input aria-label="Search loaded accounts" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Name, email, NPI or state" style={FORM_CONTROL} /></label>
        <label>App access <select value={accessFilter} onChange={event => setAccessFilter(event.target.value)} style={FORM_CONTROL}><option value="all">All access states</option><option value="active">Active</option><option value="pending">Pending</option><option value="revoked">Paused</option></select></label>
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, margin: "8px 0 6px" }}>
        Accounts ({shown.length}){hiddenCount > 0 && <button onClick={() => setShowTest(v => !v)} style={{ marginLeft: 8, fontSize: 11, border: "none", background: "transparent", color: T.accent, cursor: "pointer" }}>{showTest ? "hide" : "show"} {hiddenCount} empty account record{hiddenCount === 1 ? "" : "s"}</button>}
      </div>
      {shown.map(u => {
        const inv = u.email ? inviteByEmail[u.email.toLowerCase()] : null;
        return (
          <div key={u.id} style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.name || u.email || "(no name yet)"}</div>
                <div style={{ fontSize: 12, color: T.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.name && u.email ? u.email : ""}{u.degree_type ? ` · ${u.degree_type}` : ""}{u.primary_state ? ` · ${u.primary_state}` : ""}</div>
                <div style={{ fontSize: 11, color: T.textDim, marginTop: 2 }}>joined {timeAgo(u.created_at)} · last seen {timeAgo(u.last_seen_at)}{inv ? " · invited " + timeAgo(inv.invited_at) : u.access_status === "active" ? "" : " · not on invite list"}</div>
                {/* Where they are in setup. Read from their own setup_state
                    stamps, which sync; the percentage itself is derived from
                    records RLS keeps owner-scoped, so it is not shown and not
                    guessed at. */}
                {(() => {
                  const p = setupProgressSummary(u.setup_state);
                  const tint = { complete: T.success, started: T.accent, none: T.textDim }[p.tone] || T.textDim;
                  return (
                    <div style={{ marginTop: 4 }}>
                      <div style={{ fontSize: 11, display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
                        <span style={{ fontWeight: 800, color: tint, whiteSpace: "nowrap" }}>{p.label}</span>
                        {p.detail && <span style={{ color: T.textDim }}>{p.detail}</span>}
                      </div>
                      {p.pct !== null && (
                        <div style={{ height: 4, borderRadius: 3, backgroundColor: T.neutralDim, marginTop: 4, maxWidth: 220, overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${p.pct}%`, backgroundColor: tint, borderRadius: 3 }} />
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                {u.founding_number != null && (
                  <span title="Signed up and activated" style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10, color: "#6ee7b7", backgroundColor: "#065f46", border: "1px solid #10b981", whiteSpace: "nowrap" }}>{foundingText(u.founding_number)}</span>
                )}
                <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 10, color: "#fff", backgroundColor: accessColor(u.access_status) }}>{u.access_status}</span>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              {!u.deleted_at && u.id !== myProfileId && u.access_status !== "active" && chip("Approve", "#10b981", () => setAccess(u, "active"), false)}
              {!u.deleted_at && u.id !== myProfileId && u.access_status === "active" && chip("Pause access", "#ef4444", () => setAccess(u, "revoked"), false)}
              {!u.deleted_at && ["active", "pending"].includes(u.access_status) && /^user_[A-Za-z0-9]+$/.test(u.auth_user_id || "")
                && chip("Give free lifetime access", T.accent, () => setLifetimeTarget(u), false)}
            </div>
          </div>
        );
      })}
      {!shown.length && <Empty T={T} text="No loaded accounts match these filters. Load more records above to widen the search." />}
      {accessChange && <AdminAccessChange key={`${accessChange.kind}:${accessChange.row.id}:${accessChange.status || accessChange.action}`} change={accessChange} T={T} onClose={() => setAccessChange(null)} onSaved={() => { setMsg("Access change saved in Control history."); refresh(); }} />}
      {lifetimeTarget && <AdminLifetimeAccess target={lifetimeTarget} onClose={() => setLifetimeTarget(null)} onGranted={result => {
        setUsers(rows => rows.map(row => row.id === result.target.profileId && row.auth_user_id === result.target.clerkSubject ? { ...row, access_status: "active" } : row));
      }} />}
    </div>
  );
}

// One badge shape for the whole waitlist row, so a badge can never win width
// from the email beside it.
const badge = (color, bg) => ({
  fontSize: 10, fontWeight: 800, color, backgroundColor: bg,
  padding: "2px 7px", borderRadius: 8, textTransform: "uppercase",
  whiteSpace: "nowrap", flexShrink: 0,
});

function WaitlistList({ rows, setRows, attempts, setAttempts, users, invites, T, onInvite }) {
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
      .insert({ name, email, source: "admin-manual", waitlist: true }).select().single();
    setBusy(false);
    if (!error && data) { setRows(rs => [data, ...rs]); setAddName(""); setAddEmail(""); }
  };
  const [inviting, setInviting] = useState(null);
  const [inviteMsg, setInviteMsg] = useState("");
  // Remove a row only once the server confirms exactly one row deleted. A
  // delete that RLS refuses returns success with zero rows, so the count is
  // the check, not just the error.
  const removeLead = async (r) => {
    const from = r.waitlist === false ? "the guide-request list" : "the waitlist";
    if (!window.confirm(`Remove ${r.email} from ${from}?`)) return;
    setInviteMsg("");
    const { data, error } = await supabase.from("early_access_leads").delete().eq("id", r.id).select("id");
    if (error || data?.length !== 1) { setInviteMsg(`Could not remove ${r.email}: ${error?.message || "the server did not confirm it"}. Refresh and try again.`); return; }
    setRows(rs => rs.filter(x => x.id !== r.id));
  };
  const removeAttempt = async (a) => {
    setInviteMsg("");
    const { data, error } = await supabase.from("waitlist_attempts").delete().eq("id", a.id).select("id");
    if (error || data?.length !== 1) { setInviteMsg(`Could not dismiss ${a.email}: ${error?.message || "the server did not confirm it"}. Refresh and try again.`); return; }
    setAttempts(as2 => as2.filter(x => x.id !== a.id));
  };
  const [showJoined, setShowJoined] = useState(false);
  const [showGuideOnly, setShowGuideOnly] = useState(false);
  const view = waitlistView(rows, users || [], invites || [], { showJoined, showGuideOnly });
  const { activeEmails, guideOnly, joined: alreadyJoined, waiting, visible: visibleRows } = view;
  const leadEmails = new Set(rows.map(r => (r.email || "").toLowerCase()));
  const orphanAttempts = attempts.filter(a => !leadEmails.has((a.email || "").toLowerCase()));
  const copyAll = () => {
    const text = view.contactable.map(r => `${r.name || ""} <${r.email}>`).join(", ");
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
          <div style={{ fontSize: 26, fontWeight: 800, color: T.accent }}>{waiting.length}</div>
          <div style={{ fontSize: 11, color: T.textMuted }}>
            waiting to join · {alreadyJoined.length} already have access · {guideOnly.length} guide-only requests
          </div>
          <div role="status" aria-live="polite" style={{ fontSize: 12, marginTop: 4, color: inviteMsg.startsWith("Could not") ? "#ef4444" : T.textMuted }}>{inviteMsg}</div>
        </div>
        <button onClick={copyAll} disabled={!view.contactable.length} style={{
          padding: "8px 14px", borderRadius: 8, border: `1px solid ${T.border}`,
          backgroundColor: "transparent", color: T.text, fontSize: 12, fontWeight: 700, cursor: "pointer",
        }}>Copy waiting emails</button>
      </div>

      {(alreadyJoined.length > 0 || guideOnly.length > 0) && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
          {alreadyJoined.length > 0 && (
            <button onClick={() => setShowJoined(s => !s)} style={{
              padding: "6px 10px", borderRadius: 8, border: `1px solid ${T.border}`,
              backgroundColor: "transparent", color: T.textMuted, fontSize: 11.5, fontWeight: 700, cursor: "pointer",
            }}>{showJoined ? "Hide" : "Show"} already-joined leads ({alreadyJoined.length})</button>
          )}
          {guideOnly.length > 0 && (
            <button onClick={() => setShowGuideOnly(s => !s)} style={{
              padding: "6px 10px", borderRadius: 8, border: `1px solid ${T.border}`,
              backgroundColor: "transparent", color: T.textMuted, fontSize: 11.5, fontWeight: 700, cursor: "pointer",
            }}>{showGuideOnly ? "Hide" : "Show"} guide-only requests ({guideOnly.length})</button>
          )}
        </div>
      )}

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

      {visibleRows.length === 0 && <Empty T={T} text="No pending waitlist signups in this view." />}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {visibleRows.map((r) => (
          <div key={r.id || r.email + r.created_at} style={{
            backgroundColor: T.card, border: `1px solid ${T.border}`,
            borderRadius: 10, padding: "10px 12px",
          }}>
            {/* The email is the row. It used to share one non-wrapping flex
                line with up to four uppercase badges, and since a guide
                request carries no name the email WAS the heading: flex gave
                the badges their width and squeezed the address down to a few
                characters. Now the address gets its own full-width line, and
                the badges wrap underneath it. */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
              <div style={{ minWidth: 0, flex: "1 1 240px" }}>
                {r.name && (
                  <div style={{ fontSize: 14, fontWeight: 700, color: T.text, overflowWrap: "anywhere" }}>{r.name}</div>
                )}
                <div style={{
                  fontSize: r.name ? 12.5 : 14,
                  fontWeight: r.name ? 500 : 700,
                  color: r.name ? T.textMuted : T.text,
                  marginTop: r.name ? 2 : 0,
                  overflowWrap: "anywhere",
                }}>{r.email}</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 5 }}>
                  {/* Provenance, not a problem: amber is reserved for failed
                      attempts, so a lead who came off a state guide page and
                      ticked "add me" reads as informational. */}
                  {r.note && <span style={badge(T.info, T.infoDim)}>{leadNoteLabel(r.note)}{/^guide(?:-email)?(?: |$)/.test(r.note) ? (r.guide_sent_at ? " · sent" : r.guide_attempts >= 5 ? " · delivery failed" : " · pending") : ""}</span>}
                  {r.source === "admin-manual" && <span style={badge(T.accent, T.accentGlow)}>added by you</span>}
                  {r.waitlist === false && <span style={badge(T.textMuted, T.neutralDim)}>guide only</span>}
                  {activeEmails.has((r.email || "").toLowerCase()) && (
                    <span style={badge("#10b981", "rgba(16,185,129,0.14)")}>already a user</span>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>
                {r.waitlist === true && <span style={badge(T.accent, T.accentGlow)}>{leadState(r, view)}</span>}
                <span style={{ fontSize: 11, color: T.textMuted }}>{new Date(r.created_at).toLocaleDateString()}</span>
                {onInvite && r.waitlist === true && !activeEmails.has((r.email || "").trim().toLowerCase()) && (
                  <button disabled={inviting === r.id} onClick={async () => {
                    if (!window.confirm(`Request an invitation for ${r.email}? Email and access changes are held until the exact message and recipient list receive owner approval.`)) return;
                    setInviting(r.id); setInviteMsg("");
                    const res = await onInvite(r);
                    setInviting(null);
                    setInviteMsg(res.ok ? `Invitation sent to ${r.email}.` : res.held ? res.error : `Could not invite ${r.email}: ${res.error}`);
                  }} style={{
                    padding: "5px 9px", borderRadius: 7, border: "none", backgroundColor: T.accent, color: "#fff", fontSize: 11, fontWeight: 800, cursor: "pointer",
                  }}>{inviting === r.id ? "..." : leadState(r, view) === "invited" ? "Re-invite" : "Invite"}</button>
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
            Requests that were not saved ({orphanAttempts.length})
          </div>
          <div style={{ fontSize: 11.5, color: T.textMuted, marginBottom: 6 }}>
            These submissions have no saved request. A guide-form attempt does not establish waitlist consent; do not invite or add it to the waitlist without an explicit signup.
          </div>
          {orphanAttempts.map(a => (
            <div key={a.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, flexWrap: "wrap", backgroundColor: T.card, border: `1px solid ${T.warning}`, borderRadius: 10, padding: "8px 12px", marginBottom: 5 }}>
              <div style={{ minWidth: 0, flex: "1 1 220px" }}>
                {a.name && <div style={{ fontSize: 13, fontWeight: 700, color: T.text, overflowWrap: "anywhere" }}>{a.name}</div>}
                <div style={{ fontSize: a.name ? 12 : 13, fontWeight: a.name ? 500 : 700, color: a.name ? T.textMuted : T.text, overflowWrap: "anywhere" }}>{a.email}</div>
                <span style={{ ...badge(T.warning, T.warningDim), display: "inline-block", marginTop: 4 }}>{a.stage === "guide" ? "guide request" : a.stage === "normal" ? "waitlist signup" : "request"}</span>
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
  const [msg, setMsg] = useState("");
  // The new status shows only once the server confirms one row changed.
  const setStatus = async (row, status) => {
    setMsg("");
    const { data, error } = await supabase.from("field_proposals").update({ status }).eq("id", row.id).select("id");
    if (error || data?.length !== 1) { setMsg(`Could not ${status === "approved" ? "approve" : "dismiss"} "${row.label}": ${error?.message || "the server did not confirm it"}. Refresh and try again.`); return; }
    setRows(rs => rs.map(r => r.id === row.id ? { ...r, status } : r));
  };
  if (!rows.length) return <Empty T={T} text="No new fields proposed yet. When the assistant invents a field to avoid dropping data, it lands here for your review." />;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {msg && <div role="alert" style={{ fontSize: 12.5, fontWeight: 700, color: T.danger || "#ef4444" }}>{msg}</div>}
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

/**
 * Calls an edge function with the admin's Clerk JWT and unwraps the JSON
 * whatever the status. supabase-js throws on non-2xx; the body is on
 * error.context. Returns { ok, status, data }.
 */
async function callFn(name, { method = "POST", body } = {}) {
  try {
    const { data, error } = await supabase.functions.invoke(name, { method, ...(body !== undefined ? { body } : {}) });
    if (error) {
      let j = null;
      try { j = await error.context?.json?.(); } catch { /* not JSON */ }
      return { ok: false, status: error.context?.status || 0, data: j || { error: error.message } };
    }
    return { ok: true, status: 200, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: e.message } };
  }
}

// Which shared key an ai_usage row rode: Gemini paths are models/<name>:...,
// Opus rows are the relayed Anthropic path (v1/messages).
const isOpusPath = (path) => !!path && !/^models\//.test(path);

/**
 * AI: the shared keys and who is using them. New accounts get AI with
 * zero setup because every call goes through ai-proxy with these keys; a
 * user's own key (Settings > AI, device-local) still bypasses them.
 * The Gemini key is pasted here; the Anthropic key is loaded server-side
 * by the operator (app_secrets.anthropic_shared_key), so this panel only
 * reports it.
 */
function AiPanel({ users, ownKey, T }) {
  const [status, setStatus] = useState(null);      // { configured, last4, updated_at }
  const [quota, setQuota] = useState(null);        // { shared, used_today, limit, anthropic_shared, anthropic_used_today, anthropic_limit } from ai-proxy GET
  const [usage, setUsage] = useState([]);          // today's ai_usage rows (UTC day)
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [loadErr, setLoadErr] = useState("");

  const dayStartIso = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.toISOString(); };

  const refresh = async () => {
    const [k, q, u] = await Promise.all([
      callFn("admin-shared-key", { method: "GET" }),
      callFn("ai-proxy", { method: "GET" }),
      supabase.from("ai_usage").select("user_id, path, ok, status, prompt_chars, created_at").gte("created_at", dayStartIso()).order("created_at", { ascending: false }).limit(5000),
    ]);
    const errs = [];
    if (k.ok) setStatus(k.data); else errs.push(`Key status: ${k.data?.error || `HTTP ${k.status}`} (is admin-shared-key deployed?)`);
    if (q.ok) setQuota(q.data); else errs.push(`Proxy: ${q.data?.error || `HTTP ${q.status}`} (is ai-proxy deployed?)`);
    if (u.error) errs.push(`Usage: ${u.error.message} (run 20260817_ai_proxy.sql)`);
    else setUsage(u.data || []);
    setLoadErr(errs.join(" | "));
  };

  // Load once on mount. Deferred to a microtask so nothing sets state
  // synchronously inside the effect body.
  useEffect(() => { Promise.resolve().then(refresh); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const saveKey = async (value, label) => {
    const v = (value || "").trim();
    // Google issues both "AIza..." and the current "AQ.Ab8..." keys, so only
    // obvious pastes are stopped here; Google itself is the real judge.
    if (!/^[A-Za-z0-9._~+/=-]{20,300}$/.test(v)) { setMsg("Could not save: that does not look like an API key. Copy it again from Google AI Studio, with no spaces or line breaks."); return; }
    setBusy(true); setMsg("");
    const r = await callFn("admin-shared-key", { method: "POST", body: { value: v } });
    setBusy(false);
    if (r.ok) { setMsg(`Shared key saved${label ? ` (${label})` : ""}. Every active account now has AI on.`); setKeyInput(""); refresh(); }
    else setMsg(`Could not save: ${r.data?.error || `HTTP ${r.status}`}`);
  };

  const removeKey = async () => {
    if (!window.confirm("Remove the shared key? AI features stop for everyone who has not added their own key.")) return;
    setBusy(true); setMsg("");
    const r = await callFn("admin-shared-key", { method: "DELETE" });
    setBusy(false);
    if (r.ok) { setMsg("Shared key removed."); refresh(); }
    else setMsg(`Could not remove: ${r.data?.error || `HTTP ${r.status}`}`);
  };

  // Today's usage rolled up per account and per provider, joined to the
  // profiles directory already loaded.
  const byUser = {};
  for (const r of usage) {
    const k = r.user_id || "unknown";
    const b = byUser[k] || (byUser[k] = { user_id: r.user_id, calls: 0, gemini: 0, opus: 0, ok: 0, failed: 0, chars: 0, last: null });
    b.calls += 1;
    if (isOpusPath(r.path)) b.opus += 1; else b.gemini += 1;
    if (r.ok) b.ok += 1; else b.failed += 1;
    b.chars += r.prompt_chars || 0;
    if (!b.last || r.created_at > b.last) b.last = r.created_at;
  }
  const rows = Object.values(byUser).sort((a, b) => b.calls - a.calls);
  const who = (id) => { const u = users.find(x => x.id === id); return u ? (u.name || u.email || "account") : (id ? "deleted account" : "unknown"); };
  const geminiRows = usage.filter(r => !isOpusPath(r.path));
  const opusRows = usage.filter(r => isOpusPath(r.path));
  const totalCalls = usage.length;
  const limit = quota?.limit ?? 200;
  // An older proxy deploy has no anthropic_* fields: read as "not reported".
  const opusReported = quota != null && "anthropic_shared" in quota;
  const opusOn = !!(quota?.anthropic_configured ?? quota?.anthropic_shared);
  const opusLimit = quota?.anthropic_limit ?? null;

  const card = { backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: "12px 14px", marginBottom: 10 };
  const btn = (label, onClick, { primary, danger, disabled } = {}) => (
    <button onClick={onClick} disabled={busy || disabled} style={{
      padding: "8px 14px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: busy || disabled ? "default" : "pointer",
      border: primary || danger ? "none" : `1px solid ${T.border}`,
      backgroundColor: primary ? T.accent : danger ? (T.dangerDim || "rgba(239,68,68,0.12)") : "transparent",
      color: primary ? "#fff" : danger ? (T.danger || "#ef4444") : T.text,
      opacity: busy || disabled ? 0.6 : 1,
    }}>{label}</button>
  );

  return (
    <div>
      {loadErr && (
        <div style={{ padding: "10px 12px", borderRadius: 8, backgroundColor: "rgba(239,68,68,0.1)", color: "#ef4444", fontSize: 12, marginBottom: 10 }}>{loadErr}</div>
      )}

      <div style={{ ...card, border: `2px solid ${status?.configured ? "#10b981" : T.accent}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <div>
            <div style={{ fontSize: 11, color: T.textMuted }}>Shared Gemini key</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: status?.configured ? "#10b981" : T.text }}>
              {status == null ? "Checking..." : status.configured ? `On (ends in ${status.last4})` : "Not set"}
            </div>
            <div style={{ fontSize: 11, color: T.textDim, marginTop: 2 }}>
              {status?.configured
                ? `Saved ${timeAgo(status.updated_at)}. Every active account has AI on with no setup. Users who add their own key in Settings > AI bypass this one.`
                : "Until a key is here, AI features only work for users who added their own key in Settings > AI."}
            </div>
          </div>
          {status?.configured && btn("Remove shared key", removeKey, { danger: true })}
        </div>
      </div>

      <div style={{ ...card, border: `2px solid ${opusOn ? "#10b981" : T.border}` }}>
        <div style={{ fontSize: 11, color: T.textMuted }}>Shared Anthropic key (Claude Opus)</div>
        <div style={{ fontSize: 20, fontWeight: 800, color: opusOn ? "#10b981" : T.text }}>
          {quota == null ? "Checking..." : !opusReported ? "Not reported" : opusOn ? "On" : "Not loaded"}
        </div>
        <div style={{ fontSize: 11, color: T.textDim, marginTop: 2, lineHeight: 1.5 }}>
          {quota == null
            ? "Asking ai-proxy."
            : !opusReported
              ? "This ai-proxy deploy predates the Opus relay; redeploy it to see the Anthropic key here."
              : opusOn
                ? `Every active account has Vera on Claude Opus with nothing pasted; the RVU coder uses it when a user picks Opus in Settings > AI. Loaded server-side by the operator (app_secrets.anthropic_shared_key); it is never sent to a browser and there is no paste box for it here. ${opusLimit ? `Per-user limit ${opusLimit} Opus calls per UTC day` : "No per-user Opus limit reported"}; your account has used ${quota.anthropic_used_today ?? 0} today. Users with their own Anthropic key bypass it.`
                : "Until the operator loads app_secrets.anthropic_shared_key on the server, Vera runs on Gemini for everyone without their own Anthropic key. There is no paste box for it here by design."}
        </div>
      </div>

      <div style={card}>
        <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 4 }}>{status?.configured ? "Replace the shared key" : "Set the shared key"}</div>
        <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 8 }}>
          Paste a Google AI Studio key. It is stored on the server only (app_secrets, service role) and is never sent to a browser. Google is asked to confirm the key before it is saved.
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <input value={keyInput} onChange={e => setKeyInput(e.target.value)} placeholder="AIza... or AQ...." type="password" autoComplete="off" autoCapitalize="none" spellCheck={false}
            style={{ flex: "1 1 220px", padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: T.input, color: T.text, fontSize: 13, fontFamily: "ui-monospace, monospace" }} />
          {btn(busy ? "..." : "Save shared key", () => saveKey(keyInput), { primary: true, disabled: !keyInput.trim() })}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
          {btn("Use my own key from this device", () => {
            if (!ownKey) { setMsg("No key on this device. Add one in Settings > AI first, then come back."); return; }
            if (!window.confirm(`Share the key on this device (ends in ${ownKey.slice(-4)}) with every active account?`)) return;
            saveKey(ownKey, `ends in ${ownKey.slice(-4)}`);
          })}
          <span style={{ fontSize: 11, color: T.textDim }}>{ownKey ? `This device has a key ending in ${ownKey.slice(-4)}.` : "This device has no key in Settings > AI."}</span>
        </div>
        {msg && <div style={{ fontSize: 12, color: msg.startsWith("Could not") || msg.startsWith("No key") ? "#ef4444" : "#10b981", marginTop: 8 }}>{msg}</div>}
      </div>

      <div style={card}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.text }}>Per-user daily limits</div>
          <div style={{ fontSize: 20, fontWeight: 800, color: T.accent }}>
            {limit} <span style={{ fontSize: 11, fontWeight: 700, color: T.textMuted }}>Gemini / day</span>
            {opusReported && <span style={{ marginLeft: 12 }}>{opusLimit ?? "no"} <span style={{ fontSize: 11, fontWeight: 700, color: T.textMuted }}>Opus / day</span></span>}
          </div>
        </div>
        <div style={{ fontSize: 11.5, color: T.textMuted, marginTop: 4, lineHeight: 1.5 }}>
          Counted per account per provider per UTC day; admins are unlimited. Past the cap the app tells the user to try tomorrow or add their own key. To change it: set the <code>AI_DAILY_LIMIT</code> secret on the ai-proxy function (Supabase dashboard, Edge Functions, Secrets) or edit <code>DEFAULT_DAILY_LIMIT</code> in <code>supabase/functions/ai-proxy/index.ts</code> and redeploy.
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", margin: "14px 0 6px" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5 }}>Today's usage (since midnight UTC)</div>
        <button onClick={refresh} style={{ fontSize: 11, border: "none", background: "transparent", color: T.accent, cursor: "pointer", fontWeight: 700 }}>refresh</button>
      </div>
      <div style={{ fontSize: 12, color: T.textMuted, marginBottom: 8 }}>
        {totalCalls} call{totalCalls === 1 ? "" : "s"} through the shared keys: {geminiRows.length} Gemini{geminiRows.some(r => !r.ok) ? ` (${geminiRows.filter(r => !r.ok).length} failed at Google)` : ""}, {opusRows.length} Opus{opusRows.some(r => !r.ok) ? ` (${opusRows.filter(r => !r.ok).length} failed at Anthropic)` : ""}. Calls made with a user's own key do not appear here.
      </div>
      {rows.length === 0 ? (
        <Empty T={T} text="No shared-key calls yet today." />
      ) : (
        <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 12px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 0.8fr 0.8fr 0.8fr 1fr 1fr", gap: 4, fontSize: 11, fontWeight: 800, color: T.textMuted, paddingBottom: 6, borderBottom: `1px solid ${T.border}` }}>
            <span>Account</span><span>Gemini</span><span>Opus</span><span>Failed</span><span>Text sent</span><span>Last call</span>
          </div>
          {rows.map(r => {
            const over = r.gemini >= limit;
            const overOpus = !!opusLimit && r.opus >= opusLimit;
            return (
              <div key={r.user_id || "unknown"} style={{ display: "grid", gridTemplateColumns: "2fr 0.8fr 0.8fr 0.8fr 1fr 1fr", gap: 4, fontSize: 12.5, color: T.text, padding: "6px 0", borderBottom: `1px solid ${T.border}`, alignItems: "center" }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{who(r.user_id)}</span>
                <span style={{ fontWeight: 800, color: over ? "#ef4444" : T.text }}>{r.gemini}{over ? " (cap)" : ""}</span>
                <span style={{ fontWeight: 800, color: overOpus ? "#ef4444" : T.text }}>{r.opus}{overOpus ? " (cap)" : ""}</span>
                <span style={{ color: r.failed ? "#f59e0b" : T.textDim }}>{r.failed}</span>
                <span>{r.chars >= 1000 ? `${Math.round(r.chars / 1000)}k` : r.chars} chars</span>
                <span style={{ color: T.textMuted }}>{timeAgo(r.last)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Messages: a private channel to one physician or a broadcast to everyone.
 * Broadcast replies fan out into one thread per physician (admin_message_
 * reply_threads) so nobody sees anyone else's reply.
 */
function MessagesPanel({ messages, users, myProfileId, repliesSince, T, onRefresh }) {
  const [composeOpen, setComposeOpen] = useState(false);
  const [recipient, setRecipient] = useState(""); // "" = broadcast
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [composeMsg, setComposeMsg] = useState("");

  const [openMsg, setOpenMsg] = useState(null);
  const [broadcastThreads, setBroadcastThreads] = useState([]); // who replied, for a broadcast
  const [viewingUser, setViewingUser] = useState(null);         // drilled-into broadcast replier
  const [directThread, setDirectThread] = useState([]);         // actual reply rows
  const [replyBody, setReplyBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [detailMsg, setDetailMsg] = useState("");
  // A failed thread read is not an empty thread: it hides "No one has
  // replied yet." and says the replies could not be loaded.
  const [threadError, setThreadError] = useState("");

  const activeUsers = users.filter(u => u.access_status === "active");

  // Re-read through the section loader, so a failed read shows the section's
  // error and Retry instead of "No messages sent yet.", and the coverage line
  // is recounted with the list.
  const refreshMessages = () => { onRefresh?.(); };
  const THREAD_READ_FAILED = "Could not load the replies. Close this message and open it again to retry.";

  const send = async () => {
    const text = body.trim();
    if (!text) { setComposeMsg("Write something first."); return; }
    setSending(true); setComposeMsg("");
    const { error } = await supabase.from("admin_messages").insert({
      sender_id: myProfileId,
      recipient_id: recipient || null,
      subject: subject.trim() || null,
      body: text,
    });
    setSending(false);
    if (error) { setComposeMsg(error.message); return; }
    setComposeOpen(false); setRecipient(""); setSubject(""); setBody("");
    refreshMessages();
  };

  const openDetail = async (m) => {
    setOpenMsg(m); setDetailMsg(""); setThreadError(""); setViewingUser(null); setBroadcastThreads([]); setDirectThread([]);
    if (m.recipient_id) {
      const { data, error } = await supabase.from("admin_message_replies").select("*")
        .eq("message_id", m.id).order("created_at");
      if (error) { setThreadError(THREAD_READ_FAILED); return; }
      setDirectThread(data || []);
    } else {
      const { data, error } = await supabase.from("admin_message_reply_threads").select("*")
        .eq("message_id", m.id).order("last_reply_at", { ascending: false });
      if (error) { setThreadError(THREAD_READ_FAILED); return; }
      setBroadcastThreads(data || []);
    }
  };

  const openBroadcastThread = async (row) => {
    setViewingUser(row); setDetailMsg(""); setThreadError(""); setDirectThread([]);
    const { data, error } = await supabase.from("admin_message_replies").select("*")
      .eq("message_id", openMsg.id).eq("user_id", row.user_id).order("created_at");
    if (error) { setThreadError(THREAD_READ_FAILED); return; }
    setDirectThread(data || []);
  };

  const sendReply = async () => {
    const text = replyBody.trim();
    if (!text || !openMsg) return;
    const targetUserId = openMsg.recipient_id || viewingUser?.user_id;
    if (!targetUserId) { setDetailMsg("Pick a physician's thread first — this is a broadcast."); return; }
    setBusy(true); setDetailMsg("");
    const { error } = await supabase.from("admin_message_replies").insert({
      message_id: openMsg.id, user_id: targetUserId, author_id: myProfileId, body: text, is_admin_reply: true,
    });
    setBusy(false);
    if (error) { setDetailMsg(error.message); return; }
    setReplyBody("");
    const { data, error: readError } = await supabase.from("admin_message_replies").select("*")
      .eq("message_id", openMsg.id).eq("user_id", targetUserId).order("created_at");
    if (readError) setDetailMsg("Reply sent. The conversation could not refresh; close this message and open it again to see it.");
    else setDirectThread(data || []);
    refreshMessages();
  };

  const inputStyle = {
    width: "100%", boxSizing: "border-box", padding: "10px 12px", borderRadius: 10,
    backgroundColor: T.input, border: `1px solid ${T.border}`, color: T.text, fontSize: 15,
  };

  const showingThread = openMsg && (openMsg.recipient_id ? true : !!viewingUser);

  return (
    <div>
      <button onClick={() => { setComposeOpen(true); setComposeMsg(""); }} style={{
        width: "100%", padding: "11px", borderRadius: 10, border: "none", marginBottom: 12,
        backgroundColor: T.accent, color: "#fff", fontSize: 13.5, fontWeight: 800, cursor: "pointer",
      }}>+ New message</button>

      {messages.length === 0 ? (
        <Empty T={T} text="No messages sent yet. Reach one physician or everyone at once." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {messages.map(m => (
            <div key={m.id} role="button" tabIndex={0} onClick={() => openDetail(m)}
              onKeyDown={(ev) => { if (ev.key === "Enter") openDetail(m); }}
              style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 12px", cursor: "pointer" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>
                  {m.subject || "(no subject)"}
                  {/* repliesSince: "" means never opened before, so every physician reply is new. */}
                  {repliesSince !== null && m.last_physician_reply_at && (!repliesSince || new Date(m.last_physician_reply_at) > new Date(repliesSince)) && (
                    <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 800, padding: "2px 7px", borderRadius: 10, color: "#fff", backgroundColor: "#7c3aed" }}>NEW REPLY</span>
                  )}
                </span>
                <span style={{
                  fontSize: 10, fontWeight: 800, padding: "2px 8px", borderRadius: 10, flexShrink: 0,
                  color: m.recipient_id ? T.accent : "#fff",
                  backgroundColor: m.recipient_id ? (T.accentDim || "rgba(59,130,246,0.12)") : T.accent,
                }}>{m.recipient_id ? (m.recipient_name || m.recipient_email || "one physician") : "EVERYONE"}</span>
              </div>
              <div style={{
                fontSize: 12, color: T.textMuted, marginTop: 3, lineHeight: 1.4,
                display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
              }}>{m.body}</div>
              <div style={{ fontSize: 11, color: T.textDim, marginTop: 4 }}>
                {new Date(m.created_at).toLocaleString()} · {m.reply_count} {m.reply_count === 1 ? "reply" : "replies"}
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={composeOpen} onClose={() => setComposeOpen(false)} title="New message">
        <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, marginBottom: 6 }}>Send to</div>
        <select value={recipient} onChange={e => setRecipient(e.target.value)} style={{ ...inputStyle, marginBottom: 10 }}>
          <option value="">Everyone (broadcast)</option>
          {activeUsers.map(u => (
            <option key={u.id} value={u.id}>{u.name || u.email}</option>
          ))}
        </select>
        <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Subject (optional)"
          style={{ ...inputStyle, marginBottom: 10 }} />
        <textarea value={body} onChange={e => setBody(e.target.value)} placeholder="What do you want to say?"
          style={{ ...inputStyle, minHeight: 110, fontFamily: "inherit", outline: "none", resize: "vertical" }} />
        {composeMsg && <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 700, color: T.accent }}>{composeMsg}</div>}
        <button onClick={send} disabled={sending} style={{
          width: "100%", marginTop: 12, padding: "13px", borderRadius: 10, border: "none",
          backgroundColor: sending ? T.textDim : T.accent, color: "#fff", fontSize: 14.5, fontWeight: 800,
          cursor: sending ? "wait" : "pointer",
        }}>{sending ? "Sending…" : "Send"}</button>
      </Modal>

      <Modal open={!!openMsg} onClose={() => setOpenMsg(null)} title={openMsg?.subject || "Message"}>
        {openMsg && (
          <>
            <div style={{ fontSize: 11.5, color: T.textDim, marginBottom: 10 }}>
              {openMsg.recipient_id ? (openMsg.recipient_name || openMsg.recipient_email) : "Everyone"} · {new Date(openMsg.created_at).toLocaleString()}
            </div>
            <div style={{ fontSize: 14, color: T.text, whiteSpace: "pre-wrap", lineHeight: 1.55, padding: "10px 12px", borderRadius: 10, backgroundColor: T.input, border: `1px solid ${T.border}` }}>
              {openMsg.body}
            </div>

            {!openMsg.recipient_id && !viewingUser && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                  Replies ({broadcastThreads.length})
                </div>
                {threadError ? (
                  <div role="alert" style={{ fontSize: 12.5, color: T.danger || "#ef4444" }}>{threadError}</div>
                ) : broadcastThreads.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: T.textDim }}>No one has replied yet.</div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {broadcastThreads.map(t => (
                      <div key={t.user_id} role="button" tabIndex={0} onClick={() => openBroadcastThread(t)}
                        style={{ padding: "8px 11px", borderRadius: 10, border: `1px solid ${T.border}`, backgroundColor: T.card, cursor: "pointer", display: "flex", justifyContent: "space-between" }}>
                        <span style={{ fontSize: 13, fontWeight: 700, color: T.text }}>{t.user_name || t.user_email}</span>
                        <span style={{ fontSize: 11, color: T.textMuted }}>{t.reply_count} {t.reply_count === 1 ? "reply" : "replies"} · {timeAgo(t.last_reply_at)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {!openMsg.recipient_id && viewingUser && (
              <button onClick={() => { setViewingUser(null); setDirectThread([]); }} style={{
                marginTop: 12, padding: "6px 10px", borderRadius: 8, border: `1px solid ${T.border}`,
                backgroundColor: "transparent", color: T.textMuted, fontSize: 12, fontWeight: 700, cursor: "pointer",
              }}>&larr; All replies</button>
            )}

            {showingThread && (
              <>
                {threadError && <div role="alert" style={{ marginTop: 12, fontSize: 12.5, color: T.danger || "#ef4444" }}>{threadError}</div>}
                {directThread.length > 0 && (
                  <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                    {directThread.map(r => (
                      <div key={r.id} style={{
                        padding: "9px 11px", borderRadius: 10,
                        backgroundColor: r.is_admin_reply ? (T.accentDim || "rgba(59,130,246,0.12)") : T.card,
                        border: `1px solid ${T.border}`,
                      }}>
                        <div style={{ fontSize: 10, fontWeight: 800, color: r.is_admin_reply ? T.accent : T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 3 }}>
                          {r.is_admin_reply ? "You" : (viewingUser?.user_name || viewingUser?.user_email || "Physician")} · {new Date(r.created_at).toLocaleString()}
                        </div>
                        <div style={{ fontSize: 13, color: T.text, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{r.body}</div>
                      </div>
                    ))}
                  </div>
                )}
                <textarea value={replyBody} onChange={e => setReplyBody(e.target.value)}
                  placeholder="Reply — they see this on their dashboard."
                  style={{ ...inputStyle, minHeight: 80, marginTop: 12, fontFamily: "inherit", outline: "none", resize: "vertical" }} />
                {detailMsg && <div style={{ marginTop: 8, fontSize: 12.5, fontWeight: 700, color: T.accent }}>{detailMsg}</div>}
                <button onClick={sendReply} disabled={busy} style={{
                  width: "100%", marginTop: 10, padding: "12px", borderRadius: 10, border: "none",
                  backgroundColor: busy ? T.textDim : T.accent, color: "#fff", fontSize: 14, fontWeight: 800,
                  cursor: busy ? "wait" : "pointer",
                }}>{busy ? "Sending…" : "Send reply"}</button>
              </>
            )}
          </>
        )}
      </Modal>
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
