import { useState, useEffect, useCallback, useMemo, memo } from "react";
import { useApp } from "../../context/AppContext";
import { supabase } from "../../lib/supabase";
import EmptyState from "../shared/EmptyState";
import { FileIcon } from "../shared/Icons";
import { docMime } from "../../utils/inboxDocs";
import { docBytes, fmtBytes } from "../../utils/docLabel";
import { noteForSelection } from "../../utils/requestPacket";
import EmailPacketModal, { PACKET_FROM_ADDRESS, REQUEST_REPLIED_EVENT } from "./EmailPacketModal";
import { ProposalChecklist, ApproveSendButton, proposalSummary, requesterMissing, unwrapInvoke } from "./RequestPacket";
import { REQUESTS_CHANGED_EVENT } from "../../hooks/useNewRequestCount";
import { useRequestProposals } from "../../hooks/useRequestProposals";
import { useForwardingAddresses } from "../../hooks/useForwardingAddresses";
import { forwardingSenders, joinAddresses } from "../../utils/forwardingAddresses";

// Where physicians forward credentialer emails. The inbound edge function
// also accepts requests@ and packets@; docs@ is the one we print.
export const REQUESTS_ADDRESS = PACKET_FROM_ADDRESS;
// Attachments the inbound function pulled off a forwarded request land in
// documents with this type (unlinked, like emailed CME certificates). The
// matcher never sees them; utils/requestProposals.js keeps that exclusion.
export const REQUEST_ATTACHMENT_TYPE = "request-attachment-inbox";
// The More-menu badge count lives in hooks/useNewRequestCount.js; it listens
// for REQUESTS_CHANGED_EVENT (dispatched here on dismiss/restore and by
// useRequestProposals after it saves a client-built proposal) and for
// REQUEST_REPLIED_EVENT (dispatched by EmailPacketModal and by the Approve
// button's onSent).

const NO_DOCS = [];
// The shape send-packet-email accepts for a recipient, so the typed address
// is refused here, under the field, rather than by the function after a tap.
const EMAIL_RE = /^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']{2,}$/;

const TABS = [
  { key: "new", label: "New" },
  { key: "replied", label: "Replied" },
  { key: "dismissed", label: "Dismissed" },
];

function relTime(iso) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} day${d === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: d > 300 ? "numeric" : undefined });
}

const snippet = (s, n = 140) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** Attachments that came in with this request. Matched by an explicit reference first, then by arrival time (same 15-minute window as the email). */
function attachmentsFor(req, documents) {
  if (!req) return [];
  const list = (documents || []).filter((d) => d?.type === REQUEST_ATTACHMENT_TYPE);
  if (!list.length) return [];
  const byRef = list.filter((d) =>
    (d.linkedTo && String(d.linkedTo).includes(req.id))
    || d.requestId === req.id
    || (req.inbound_ledger_id && d.inboundLedgerId === req.inbound_ledger_id));
  if (byRef.length) return byRef;
  const t0 = new Date(req.received_at || req.created_at || 0).getTime();
  if (!t0) return [];
  return list.filter((d) => {
    const t = new Date(d.uploadedAt || d.createdAt || 0).getTime();
    return t && Math.abs(t - t0) <= 15 * 60 * 1000;
  });
}

/** The same set of document ids, in any order. */
const sameIds = (selected, ids) => {
  const want = Array.isArray(ids) ? ids : [];
  if (!selected || selected.size !== new Set(want).size) return false;
  return want.every((id) => selected.has(id));
};

/**
 * Document requests forwarded to docs@credentialdomd.com. Each card is one
 * credentialer email with the packet the app proposes for it: the asks
 * matched against the file and a cover note. One tap approves and sends.
 * Review (untick a document, edit the note) is available, not required.
 *
 * onReplyEmail({ request, docIds, note }) lets the owner host
 * EmailPacketModal; when it is not passed the inbox opens its own.
 * initialOpenId opens that request as soon as it is set (Home's Review link
 * lands on the request, not the list); onOpened is called once it has, so
 * the owner can clear it and a later visit starts on the list.
 */
function RequestsInbox({ onAskVera, onReplyEmail, initialOpenId, onOpened }) {
  const { data, loaded, user, theme: T, navigate } = useApp();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState("new");
  const [openId, setOpenId] = useState(initialOpenId || null);
  // The id the prop last opened. When the prop changes to a new id while
  // this is mounted, the open is adjusted here, during render, rather than
  // in the effect below: a setState in an effect body is an error under this
  // repo's lint (react-hooks/set-state-in-effect) and would also paint the
  // list for one frame before the request. The effect keyed on the prop
  // then tells the owner, who clears it so the same id does not reopen
  // after the physician taps back to the list; once cleared, the memory is
  // dropped too, so the owner can open that same request again later.
  const [openedFor, setOpenedFor] = useState(initialOpenId || null);
  if (initialOpenId && initialOpenId !== openedFor) {
    setOpenedFor(initialOpenId);
    setOpenId(initialOpenId);
  } else if (!initialOpenId && openedFor) {
    setOpenedFor(null);
  }
  useEffect(() => {
    if (initialOpenId && onOpened) onOpened();
  }, [initialOpenId, onOpened]);
  const [busyId, setBusyId] = useState(null);
  const [emailPrefill, setEmailPrefill] = useState(null); // { request, docIds, note } for the hosted EmailPacketModal
  // The physician's edits to the open request's packet, keyed to that
  // request so opening another one starts from its own proposal again.
  // noteEdited flips once the physician types in the note; until then the
  // note is regenerated from the ticks on every toggle.
  const [draft, setDraft] = useState(null); // { key, selected: Set, note, noteEdited }
  // The last one-tap send, so "Sent to" survives the row flipping to replied.
  const [sentInfo, setSentInfo] = useState(null); // { id, to, attached }
  // The requester's address typed on a request whose forward carried no
  // From: line, keyed to that request. It is saved to the row inside the
  // send (see sendWithAddress below), not on blur.
  const [addrDraft, setAddrDraft] = useState(null); // { id, value }

  const realEmail = data.settings?.email || user?.email || "";
  const accountEmail = realEmail || "your account email";
  // Inbound mail is matched by SENDER, and the account address is no longer
  // the only one that matches: a confirmed forwarding address does too. Naming
  // only the account address here told a physician who registered their
  // hospital email that it would not work.
  const { rows: forwarding } = useForwardingAddresses();
  const senders = useMemo(() => forwardingSenders(accountEmail, forwarding), [accountEmail, forwarding]);
  const sendersText = joinAddresses(senders) || accountEmail;

  const load = useCallback(async ({ quiet } = {}) => {
    if (!supabase) { setErr("Not connected to your account."); setLoading(false); return; }
    if (!quiet) setLoading(true);
    setErr(null);
    try {
      const { data: list, error } = await supabase
        .from("document_requests")
        .select("*")
        .order("received_at", { ascending: false });
      if (error) throw error;
      setRows(list || []);
    } catch (e) {
      // A missing table means the backend half is not deployed yet; say so plainly.
      setErr(/relation|does not exist|schema cache/i.test(e.message || "")
        ? "Requests are not switched on for your account yet."
        : (e.message || "Could not load requests"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onFocus = () => load({ quiet: true });
    const onReplied = (e) => {
      const id = e?.detail?.id;
      if (id) setRows((rs) => rs.map((r) => r.id === id ? { ...r, status: "replied", replied_at: r.replied_at || new Date().toISOString() } : r));
      load({ quiet: true });
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener(REQUEST_REPLIED_EVENT, onReplied);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(REQUEST_REPLIED_EVENT, onReplied);
    };
  }, [load]);

  // Proposals the server did not make, or made against a file that has since
  // changed, are rebuilt on the client and written back once; the Home
  // banner mounts the same hook over its own rows, so the count it prints
  // is the count this inbox sends. See hooks/useRequestProposals.js. The
  // Approve button sends what is on screen either way (doc_ids and text
  // travel with the tap), so that write can lag or fail without the email
  // differing from the screen.
  const viewRows = useRequestProposals(rows);

  const counts = useMemo(() => {
    const c = { new: 0, replied: 0, dismissed: 0 };
    for (const r of rows) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [rows]);
  const visible = viewRows.filter((r) => r.status === tab);
  const open = openId ? viewRows.find((r) => r.id === openId) : null;

  // The open request's packet as the physician has it right now: the
  // proposal's documents and cover note until edited, then the edits.
  const openKey = open ? `${open.id}|${open.proposal_at || ""}` : null;
  const live = draft && draft.key === openKey ? draft : null;
  const selected = live ? live.selected : new Set(open?.proposal?.docIds || []);
  const note = live ? live.note : (open?.proposal?.coverNote || "");
  const noteEdited = !!live?.noteEdited;
  const physician = { name: data.settings?.name || "", degree: data.settings?.degreeType || "" };
  // Unticking a document rewrites the note to match, until the physician
  // has typed in it. The flag, not a comparison with the stored coverNote,
  // decides: after the first untick the note already differs from the
  // stored one, and a comparison would have stopped following on the
  // second. An untick that left "Attached are the documents you asked for:
  // - DEA Registration" in the note while the DEA was no longer attached
  // is the email this prevents.
  const toggleDoc = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    let nextNote = note;
    if (!noteEdited && open?.proposal) {
      const regenerated = noteForSelection(open.proposal, [...next], physician, open.from_name);
      if (typeof regenerated === "string") nextNote = regenerated;
    }
    setDraft({ key: openKey, selected: next, note: nextNote, noteEdited });
  };
  const setNote = (v) => setDraft({ key: openKey, selected, note: v, noteEdited: true });

  const setStatus = async (req, status) => {
    if (!supabase || !req) return;
    setBusyId(req.id);
    const prev = rows;
    setRows((rs) => rs.map((r) => r.id === req.id ? { ...r, status, updated_at: new Date().toISOString() } : r));
    try {
      const { error } = await supabase.from("document_requests")
        .update({ status, updated_at: new Date().toISOString() })
        .eq("id", req.id);
      if (error) throw error;
      try { window.dispatchEvent(new CustomEvent(REQUESTS_CHANGED_EVENT, { detail: { id: req.id, status } })); } catch { /* no window */ }
      if (status === "dismissed") setOpenId(null);
    } catch (e) {
      setRows(prev);
      setErr(e.message || "Could not update the request");
    } finally {
      setBusyId(null);
    }
  };

  // One-tap send. `approve: true` tells send-packet-email to take the
  // recipient from the row; the attachments and the note travel with the
  // call (ApproveSendButton builds the body from what it shows), so the
  // email is the screen, not the row. The response is unwrapped the way
  // EmailPacketModal unwraps it, so the function's own error text reaches
  // the physician.
  const sendPacket = async (body) => {
    if (!supabase) throw new Error("Not connected to your account.");
    return unwrapInvoke(await supabase.functions.invoke("send-packet-email", { body }));
  };
  const onPacketSent = (req) => (result) => {
    setSentInfo({ id: req.id, to: result?.to || req.from_addr, attached: result?.attached ?? req.proposal?.docIds?.length ?? 0 });
    try { window.dispatchEvent(new CustomEvent(REQUEST_REPLIED_EVENT, { detail: { id: req.id, email_id: result?.email_id } })); } catch { /* no window */ }
  };

  // The bold who-asked slot on a card. For a request whose forward carried
  // no From: line, from_addr is the physician's own forwarding address
  // (email-inbound stores it as the placeholder), and the card once printed
  // the physician's own email in bold as the credentialer. Home and the
  // detail header already say "Requester not found"; so does the list now.
  const fromLabel = (r) => r.from_name || (requesterMissing(r, senders) ? "Requester not found" : (r.from_addr || "Unknown sender"));
  const askVera = (r) => {
    const from = r.from_name ? `${r.from_name} <${r.from_addr}>` : (r.from_addr || "an unknown sender");
    const q = `Build the document packet for this request from ${from} (${r.subject || "no subject"}):\n\n${r.body_text || ""}`;
    onAskVera?.(q, r);
  };
  // The modal opens with the packet already built: the proposal's documents
  // ticked and its cover note in the box, or the physician's edits to them.
  const replyByEmail = (r, docIds, noteText) => {
    const ids = docIds || r.proposal?.docIds || [];
    const text = noteText ?? (r.proposal?.coverNote || "");
    if (onReplyEmail) onReplyEmail({ request: r, docIds: ids, note: text });
    else setEmailPrefill({ request: r, docIds: ids, note: text });
  };
  const openDoc = (doc) => {
    if (!doc?.data) return;
    try {
      const byteStr = atob(doc.data.split(",")[1]);
      const arr = new Uint8Array(byteStr.length);
      for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([arr], { type: docMime(doc) || "application/octet-stream" }));
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch { /* unreadable */ }
  };

  const btn = (primary) => ({
    padding: "10px 12px", borderRadius: 10, fontSize: 13, fontWeight: 800, cursor: "pointer",
    border: primary ? "none" : `1px solid ${T.border}`,
    background: primary ? "linear-gradient(135deg, #10b981, #059669)" : "transparent",
    color: primary ? "#fff" : T.text,
  });
  const linkBtn = {
    padding: "6px 0", border: "none", background: "none", color: T.accent,
    font: "inherit", fontSize: 13, fontWeight: 700, cursor: "pointer", textDecoration: "underline",
  };
  const sectionLabel = { fontSize: 12, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 };

  const modal = (
    <EmailPacketModal open={!!emailPrefill} onClose={() => setEmailPrefill(null)} request={emailPrefill?.request || null}
      initialDocIds={emailPrefill?.docIds || NO_DOCS} initialNote={emailPrefill?.note || undefined} />
  );

  // ── Detail view ──
  if (open) {
    const atts = attachmentsFor(open, data.documents);
    const proposal = open.proposal || null;
    // The one tap sends exactly what is ticked and the note as it reads in
    // the box, edited or not. An emptied selection still sends: the button
    // relabels itself "Send reply (nothing to attach)" and the note goes
    // alone. With no proposal (or none with items) Reply by email stands
    // where the button would. A request with no requester keeps the same
    // button and gains a field above it (see below).
    const selectedIds = [...selected];
    const edited = proposal ? !sameIds(selected, proposal.docIds) : false;
    const sent = sentInfo && sentInfo.id === open.id ? sentInfo : null;
    // Replies land where the request was forwarded from when that is a
    // confirmed address other than the account email (send-packet-email's
    // rule), so the hint names the mailbox the credentialer will reach.
    const fwd = String(open.forwarded_by || "").trim().toLowerCase();
    const replyTo = fwd && fwd !== realEmail.toLowerCase() && senders.includes(fwd) ? fwd : (realEmail || "your account email");
    const requesterGone = requesterMissing(open, senders);
    // A request whose forward carried no From: line gets a "Requester's
    // email" field above the same green button, so the path is open, type,
    // one tap. It used to be a separate button that opened the hand-built
    // modal with To cleared: open plus three taps and typing, a second screen
    // re-asking subject and cc, no claim on the row (a slow double tap could
    // send twice), and Send that never enabled when nothing was on file, so
    // the reply the summary email promised could not be sent from the app.
    // The typed address is applied to the row (from_addr; owners may update
    // any column) INSIDE the send, so the tap that approves is the tap that
    // saves it and send-packet-email reads the row it just wrote. Saving on
    // blur raced the tap: the UPDATE was still in flight when the function
    // read from_addr and refused the physician's own address.
    const typedAddr = addrDraft && addrDraft.id === open.id ? addrDraft.value : "";
    const cleanAddr = typedAddr.trim().toLowerCase();
    const typedOk = EMAIL_RE.test(cleanAddr);
    // What the button and the modal see: the row with the typed address in
    // place of the placeholder once it is a real address, the placeholder
    // cleared for the modal otherwise (its To field falls back to
    // request.from_addr, and that fallback is the one address
    // send-packet-email is certain to refuse).
    const viewReq = requesterGone && typedOk ? { ...open, from_addr: cleanAddr } : open;
    const modalReq = requesterGone ? { ...open, from_addr: typedOk ? cleanAddr : "" } : open;
    const sendWithAddress = async (body) => {
      if (!requesterGone) return sendPacket(body);
      if (!supabase) throw new Error("Not connected to your account.");
      const { data: moved, error } = await supabase.from("document_requests")
        .update({ from_addr: cleanAddr, updated_at: new Date().toISOString() })
        .eq("id", open.id).eq("status", "new").select("id");
      if (error) throw new Error(error.message || "Could not save the requester's address");
      if (!moved || !moved.length) throw new Error("This request was already answered or dismissed. Refresh the list.");
      setRows((rs) => rs.map((r) => r.id === open.id ? { ...r, from_addr: cleanAddr } : r));
      return sendPacket(body);
    };
    // With no proposal, or one with no items, the green button has nothing
    // to send and would only print a reason; Reply by email, the control
    // that does work, takes its place. The no-match wording in the packet
    // box above names it.
    const matchable = !!proposal && Array.isArray(proposal.items) && proposal.items.length > 0;
    return (
      <div>
        <button onClick={() => setOpenId(null)} style={{ ...btn(false), padding: "7px 12px", fontSize: 12.5, marginBottom: 12 }}>‹ All requests</button>
        <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "14px 16px", boxShadow: T.shadow1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "flex-start" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: T.text, overflowWrap: "anywhere" }}>{open.subject || "(no subject)"}</div>
              <div style={{ fontSize: 13, color: T.textMuted, marginTop: 2, overflowWrap: "anywhere" }}>
                {open.from_name ? <><b style={{ color: T.text }}>{open.from_name}</b> · </> : null}
                {requesterGone && !open.from_name
                  ? <span style={{ color: T.warning, fontWeight: 600 }}>Requester not found in the forwarded email</span>
                  : open.from_addr}
              </div>
              <div style={{ fontSize: 12, color: T.textDim, marginTop: 2 }}>
                Received {relTime(open.received_at)}
                {open.forwarded_by ? ` · forwarded from ${open.forwarded_by}` : ""}
                {open.status === "replied" && open.replied_at ? ` · replied ${relTime(open.replied_at)}` : ""}
              </div>
            </div>
            <span style={{
              flexShrink: 0, fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5,
              padding: "3px 8px", borderRadius: 8,
              backgroundColor: open.status === "new" ? T.accentDim : open.status === "replied" ? T.successDim : T.neutralDim,
              color: open.status === "new" ? T.accent : open.status === "replied" ? T.success : T.neutral,
            }}>{open.status}</span>
          </div>

          {/* The packet: what was asked, what answers it, and the note it goes out with. */}
          <div style={{ marginTop: 14, padding: "12px 12px 10px", borderRadius: 12, border: `1px solid ${proposal ? T.accent : T.border}`, backgroundColor: proposal ? T.accentDim : "transparent" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <div style={sectionLabel}>Packet</div>
              {proposal && (
                <div style={{ fontSize: 12.5, fontWeight: 700, color: proposalSummary(proposal).ready ? T.success : T.warning, marginBottom: 6 }}>
                  {proposalSummary(proposal).line}
                </div>
              )}
            </div>
            {proposal ? (
              <ProposalChecklist proposal={proposal} T={T} selected={selected} onToggle={open.status === "new" ? toggleDoc : undefined} />
            ) : (
              <div style={{ fontSize: 13, color: T.textDim, lineHeight: 1.5 }}>
                {loaded ? "No documents could be matched from this email. Reply by email and pick them, or ask Vera." : "Reading your file..."}
              </div>
            )}
            {proposal && open.status === "new" && (
              <div style={{ marginTop: 10 }}>
                <div style={sectionLabel}>Cover note</div>
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={5} style={{
                  width: "100%", boxSizing: "border-box", minHeight: 96, resize: "vertical", padding: "9px 11px", borderRadius: 10,
                  border: `1px solid ${T.inputBorder}`, backgroundColor: T.input, color: T.text, fontSize: 13.5, lineHeight: 1.5, fontFamily: "inherit",
                }} />
                <div style={{ fontSize: 11.5, color: T.textDim, marginTop: 4, lineHeight: 1.45 }}>
                  Goes out from {PACKET_FROM_ADDRESS} with replies to {replyTo}. A line naming you as the sender is added at the end. The note follows the ticks until you edit it. Clear the box to send the documents with no note.
                </div>
              </div>
            )}
            {sent && (
              <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 10, backgroundColor: T.successDim, color: T.success, fontSize: 13.5, fontWeight: 600, lineHeight: 1.5, overflowWrap: "anywhere" }}>
                Sent to {sent.to} with {sent.attached} attachment{sent.attached === 1 ? "" : "s"}.
              </div>
            )}
            {requesterGone && open.status === "new" && !sent && (
              <div style={{ marginTop: 10, minWidth: 0 }}>
                <div style={sectionLabel}>Requester's email</div>
                <input type="email" value={typedAddr} onChange={(e) => setAddrDraft({ id: open.id, value: e.target.value })}
                  placeholder="credentialing@hospital.org" autoCapitalize="off" autoCorrect="off" spellCheck={false} inputMode="email"
                  style={{
                    width: "100%", boxSizing: "border-box", padding: "9px 11px", borderRadius: 10,
                    border: `1px solid ${T.inputBorder}`, backgroundColor: T.input, color: T.text, fontSize: 14, fontFamily: "inherit",
                  }} />
                <div style={{ fontSize: 11.5, color: T.textDim, marginTop: 4, lineHeight: 1.45, overflowWrap: "anywhere" }}>
                  The forwarded text had no From: line, so the app could not tell who asked. Type their address; the button below sends to it.
                </div>
              </div>
            )}
            {open.status === "new" && !sent && (
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 14px", marginTop: 12, minWidth: 0 }}>
                {matchable ? (
                  <>
                    <ApproveSendButton key={open.id} request={viewReq} T={T} accountEmail={realEmail} ownAddresses={senders}
                      docIds={selectedIds} text={note}
                      label={edited && selectedIds.length > 0 ? `Approve and send ${selectedIds.length} selected` : undefined}
                      notFoundReason={requesterGone ? "Type the requester's email above to send." : undefined}
                      send={sendWithAddress} onSent={onPacketSent(viewReq)} />
                    <button onClick={() => replyByEmail(modalReq, selectedIds, note)} style={linkBtn}>Review in full</button>
                  </>
                ) : (
                  // A proposal with no items stores the note "I did not find
                  // a list of documents in your request. Reply with what you
                  // need", and that note once prefilled the modal over three
                  // ticked documents. The modal gets a note only when the
                  // physician typed one in the box above; otherwise "" lets
                  // it fall back to its own default.
                  <button onClick={() => replyByEmail(modalReq, selectedIds, noteEdited ? note : "")} style={{ ...btn(true), maxWidth: "100%", whiteSpace: "normal", overflowWrap: "anywhere" }}>
                    Reply by email
                  </button>
                )}
              </div>
            )}
          </div>

          <div style={{ ...sectionLabel, marginTop: 14 }}>Their email</div>
          <div style={{
            padding: "10px 12px", borderRadius: 10,
            backgroundColor: T.input, border: `1px solid ${T.inputBorder}`,
            fontSize: 14, lineHeight: 1.55, color: T.text, whiteSpace: "pre-wrap", overflowWrap: "anywhere",
            maxHeight: "45vh", overflowY: "auto", WebkitOverflowScrolling: "touch",
          }}>
            {open.body_text?.trim() || <span style={{ color: T.textDim }}>No text in this email.</span>}
          </div>

          {atts.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={sectionLabel}>
                Attachments ({atts.length})
              </div>
              {atts.map((d) => (
                <div key={d.id} role={d.data ? "button" : undefined} onClick={() => openDoc(d)} style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", marginBottom: 4,
                  border: `1px solid ${T.border}`, borderRadius: 8, fontSize: 13.5, color: T.text,
                  cursor: d.data ? "pointer" : "default",
                }}>
                  <FileIcon />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</span>
                  <span style={{ color: T.textDim, fontSize: 12, flexShrink: 0 }}>{d.data ? fmtBytes(docBytes(d)) : "syncing"}</span>
                </div>
              ))}
              <div style={{ fontSize: 12, color: T.textDim }}>Also saved under Files, not linked to a record yet.</div>
            </div>
          )}

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14 }}>
            {open.status !== "new" && (
              <button onClick={() => replyByEmail(open)} style={{ ...btn(false), flex: 1, minWidth: 140, borderColor: T.accent, color: T.accent }}>
                {open.status === "replied" ? "Reply again by email" : "Reply by email"}
              </button>
            )}
            {open.status === "dismissed" ? (
              <button onClick={() => setStatus(open, "new")} disabled={busyId === open.id} style={btn(false)}>Move back to New</button>
            ) : (
              <button onClick={() => setStatus(open, "dismissed")} disabled={busyId === open.id} style={{ ...btn(false), color: T.textMuted }}>Dismiss</button>
            )}
          </div>
          <div style={{ marginTop: 6 }}>
            <button onClick={() => askVera(open)} style={linkBtn}>Ask Vera to build the packet instead</button>
          </div>
          {err && <div style={{ fontSize: 13, color: T.danger, fontWeight: 600, marginTop: 8 }}>{err}</div>}
        </div>

        {modal}
      </div>
    );
  }

  // ── List view ──
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: T.text }}>Requests</h2>
        <button onClick={() => load()} disabled={loading} style={{
          padding: "7px 12px", borderRadius: 10, border: `1px solid ${T.border}`,
          backgroundColor: "transparent", color: T.textMuted, fontSize: 12, fontWeight: 700,
          cursor: loading ? "default" : "pointer", opacity: loading ? 0.5 : 1,
        }}>{loading ? "Refreshing…" : "Refresh"}</button>
      </div>
      <div style={{ fontSize: 12.5, color: T.textMuted, marginBottom: 12, lineHeight: 1.5 }}>
        Forward a credentialer's email from{" "}
        {senders.map((e, i) => (
          <span key={e}>
            {i > 0 ? (i === senders.length - 1 ? " or " : ", ") : ""}
            <b style={{ color: T.text }}>{e}</b>
          </span>
        ))}
        {" "}to <b style={{ color: T.text }}>{REQUESTS_ADDRESS}</b> and that is the last thing you type. The app reads what was asked for,
        matches it against your file and writes the reply; one tap here or on Home sends it. Or{" "}
        <button onClick={() => navigate("more", "settings")} style={{
          padding: 0, border: "none", background: "none", color: T.accent,
          font: "inherit", fontWeight: 700, cursor: "pointer", textDecoration: "underline",
        }}>add another address in Settings</button>.
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {TABS.map((t) => {
          const on = tab === t.key;
          return (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              flex: 1, padding: "8px 6px", borderRadius: 10, fontSize: 13, fontWeight: 700, cursor: "pointer",
              border: `1px solid ${on ? T.accent : T.border}`,
              backgroundColor: on ? T.accentDim : "transparent", color: on ? T.accent : T.textMuted,
            }}>
              {t.label}{counts[t.key] ? ` (${counts[t.key]})` : ""}
            </button>
          );
        })}
      </div>

      {err && <div style={{ fontSize: 13, color: T.danger, fontWeight: 600, marginBottom: 10 }}>{err}</div>}

      {/* The card that was just sent leaves the New tab in the same render
          as its button would have said "Sent to", because the replied event
          flips the row at once. This strip is where that confirmation lives
          instead, until the physician clears it. */}
      {sentInfo && tab === "new" && (
        <div style={{
          display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 12px", marginBottom: 10, padding: "10px 12px",
          borderRadius: 10, backgroundColor: T.successDim, color: T.success, fontSize: 13.5, fontWeight: 600, lineHeight: 1.5, minWidth: 0,
        }}>
          <div style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
            Sent to {sentInfo.to} with {sentInfo.attached} attachment{sentInfo.attached === 1 ? "" : "s"}.
          </div>
          <button onClick={() => setSentInfo(null)} style={{ ...linkBtn, color: T.success, padding: 0, flexShrink: 0 }}>Dismiss</button>
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div style={{ fontSize: 13.5, color: T.textDim, padding: "24px 0", textAlign: "center" }}>Loading…</div>
      ) : visible.length === 0 ? (
        tab === "new" ? (
          <EmptyState icon={"📨"} title="No document requests"
            subtitle={`Forward a credentialer's request from ${sendersText} to ${REQUESTS_ADDRESS}. That is the last step: the app matches the ask against your file, writes the reply, and one tap sends it with the documents attached.`} />
        ) : (
          <div style={{ fontSize: 13.5, color: T.textDim, padding: "24px 0", textAlign: "center" }}>
            {tab === "replied" ? "Nothing replied to yet." : "Nothing dismissed."}
          </div>
        )
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {visible.map((r) => {
            const sum = proposalSummary(r.proposal);
            return (
              <div key={r.id} role="button" tabIndex={0} onClick={() => setOpenId(r.id)}
                onKeyDown={(e) => { if (e.key === "Enter") setOpenId(r.id); }}
                className="cmd-card-hover"
                style={{
                  backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14,
                  padding: "12px 14px", boxShadow: T.shadow1, cursor: "pointer",
                }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: T.text, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {fromLabel(r)}
                  </div>
                  <div style={{ fontSize: 12, color: T.textDim, flexShrink: 0 }}>{relTime(r.received_at)}</div>
                </div>
                {r.from_name && r.from_addr && !requesterMissing(r, senders) && (
                  <div style={{ fontSize: 12, color: T.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.from_addr}</div>
                )}
                <div style={{ fontSize: 14, color: T.text, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.subject || "(no subject)"}
                </div>
                <div style={{ fontSize: 13, color: T.textMuted, marginTop: 2, lineHeight: 1.4 }}>{snippet(r.body_text)}</div>
                {r.proposal && (
                  // The button's own click stops propagation; the wrapper also
                  // stops the keyboard, because Enter on the button would
                  // otherwise bubble to the card's Enter handler and open it.
                  <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}
                    style={{ marginTop: 10, display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 12px", minWidth: 0, cursor: "default" }}>
                    <div style={{ fontSize: 12.5, fontWeight: 700, color: sum.ready ? T.success : T.warning, overflowWrap: "anywhere" }}>{sum.line}</div>
                    {r.status === "new" && (
                      <ApproveSendButton key={r.id} request={r} T={T} accountEmail={realEmail} ownAddresses={senders} send={sendPacket} onSent={onPacketSent(r)} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {modal}
    </div>
  );
}

export default memo(RequestsInbox);
