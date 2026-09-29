import React, { useState } from "react";
import { oneTapReady, reviewReason } from "../../utils/requestPacket.js";

// The one-tap packet. A credentialer's email lands as a document_requests row
// with a `proposal` (built on the server at arrival, or on the client when the
// server had none): which documents answer which ask, and a cover note. These
// pieces show that proposal and send it. The Home banner and More > Requests
// both draw from here, so the count a physician reads on the board is the
// count the inbox sends; two renderings of "3 documents ready" that could
// drift apart is how the old flow grew to seven taps.
//
// Written with React.createElement rather than JSX and importing nothing from
// the app but the pure matcher, so scripts/request-packet-ui.test.mjs can
// render every state with react-dom/server in plain node against a fake theme.
//
// One tap is for a proposal that can go unread (requestPacket.js
// oneTapReady): a model read the email, every ask it read is the email's own
// words, and each is matched with high confidence. Anything else leads with
// Review, and the line under it says what is unclear. On 2026-09-28 a
// keyword proposal built from an agency's informational letter was offered
// on one tap, the owner tapped it, and the agency was told "Attached are the
// documents you asked for" about documents it had never asked for.

const h = React.createElement;

// The same shape send-packet-email refuses: our domain and its subdomains,
// not every address that happens to end in the letters.
const OUR_DOMAIN_RE = /@(?:[a-z0-9-]+\.)*credentialdomd\.com$/;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const low = (v) => String(v || "").trim().toLowerCase();

const uniq = (xs) => {
  const out = [];
  for (const x of xs) if (x && !out.includes(x)) out.push(x);
  return out;
};

/**
 * { ready, missing, report, unclear, line } for a proposal. `ready` is the
 * number of distinct documents that would be attached; `missing` the asks
 * nothing on file answers; `report` the asks that are not a file at all
 * (case logs, which the app exports); `unclear` the asks the matcher could
 * not name. The line is what both screens print: "1 document ready",
 * "3 documents ready, 1 follows separately", "Nothing on file for this
 * yet". Each count gets its own words because "1 not on file" for a case
 * log report, which the checklist itself calls "Follows separately", told
 * the physician a document was missing. A proposal with no items at all
 * says "Nothing could be read from this email", a statement about the
 * email, not about the physician's file; one saved as unclear (nothing in
 * the email read as an ask, requestPacket.js Proposal.unclear) says so. An
 * absent proposal yields an empty line, so a card without one prints
 * nothing rather than a false zero.
 */
export function proposalSummary(proposal) {
  if (!proposal || typeof proposal !== "object") return { ready: 0, missing: 0, report: 0, unclear: 0, line: "" };
  const hasItems = Array.isArray(proposal.items);
  const items = hasItems ? proposal.items : [];
  const ids = Array.isArray(proposal.docIds)
    ? proposal.docIds
    : items.flatMap((i) => (Array.isArray(i?.docIds) ? i.docIds : []));
  const ready = uniq(ids).length;
  const report = items.filter((i) => i?.status === "report").length;
  const unclear = items.filter((i) => i?.status === "missing" && i?.kind === "unknown").length;
  const missing = hasItems
    ? items.filter((i) => i?.status === "missing" && i?.kind !== "unknown").length
    : (Array.isArray(proposal.missing) ? proposal.missing.length : 0);
  const base = ready > 0
    ? `${plural(ready, "document")} ready`
    : proposal.unclear === true ? "Not clear that it asks for anything"
      : (hasItems && items.length === 0 ? "Nothing could be read from this email" : "Nothing on file for this yet");
  const parts = [base];
  if (ready > 0 && missing) parts.push(`${missing} not on file`);
  if (report) parts.push(`${report} ${report === 1 ? "follows" : "follow"} separately`);
  if (unclear) parts.push(`${unclear} not recognised`);
  return { ready, missing, report, unclear, line: parts.join(", ") };
}

/**
 * True when the row's from_addr is not a requester at all: empty, the address
 * the forward came from, or one of the physician's own addresses
 * (`ownAddresses`: the account email and every confirmed forwarding
 * address). email-inbound stores the forwarding sender as from_addr when the
 * forward carried no From: line, so a request that "came from" the
 * physician is one whose requester was never found.
 */
export function requesterMissing(request, ownAddresses) {
  const to = low(request?.from_addr);
  if (!to) return true;
  if (to === low(request?.forwarded_by)) return true;
  for (const a of ownAddresses || []) if (low(a) && low(a) === to) return true;
  return false;
}

/**
 * "Casey Example, osterly-health.example": the person, then where they write
 * from. "Requester not found" when the row holds no requester (see
 * requesterMissing), rather than the physician's own address in the bold
 * slot that says who asked.
 */
export function requesterLine(request, ownAddresses) {
  const name = String(request?.from_name || "").trim();
  const addr = String(request?.from_addr || "").trim();
  if (!name && requesterMissing(request, ownAddresses)) return "Requester not found";
  const at = addr.indexOf("@");
  const domain = at > 0 ? addr.slice(at + 1) : "";
  if (name && domain) return `${name}, ${domain}`;
  return name || addr || "Unknown sender";
}

/** The first two asks, then "and N more"; the subject when nothing was parsed. */
export function askLine(request) {
  const items = Array.isArray(request?.proposal?.items) ? request.proposal.items : [];
  const asks = items.map((i) => String(i?.ask || "").replace(/\s+/g, " ").trim()).filter(Boolean);
  if (!asks.length) return String(request?.subject || "").trim();
  const head = asks.slice(0, 2).join(", ");
  const rest = asks.length - 2;
  return rest > 0 ? `${head} and ${rest} more` : head;
}

// The reason a request without a requester prints. Exported so the detail
// view, which renders the address field right above the button, can swap in
// words that do not say "Open the request" on the request.
export const REQUESTER_NOT_FOUND_REASON = "Requester's address not found. Open the request and enter it.";
// The reason when the matcher read nothing it could attach. "Nothing
// proposed yet" was the code's word for the matcher's output and told the
// physician nothing about whether to wait, open the request, or reply by
// hand; the request's own screen offers Reply by email and Ask Vera.
export const NOTHING_MATCHED_REASON = "No documents could be matched from this email. Open the request to pick them.";
// Home's banner sits beside a Review link and no Open, so its reasons name
// Review. Defined here, not in App.jsx, so request-packet-ui.test.mjs can
// render the words Home actually shows.
export const HOME_NOT_FOUND_REASON = "Requester's address not found. Tap Review and enter it.";
export const HOME_NO_MATCH_REASON = "No documents could be matched from this email. Tap Review to pick them.";
// The reason a proposal that may not go on one tap prints under a button that
// was handed it without a review. Every screen that offers the button checks
// oneTapReady first and leads with Review; this is the backstop.
export const REVIEW_FIRST_REASON = "Tap Review and check the draft first.";

/** May this request's packet go on one tap, unread? (requestPacket.js oneTapReady) */
export const canSendOnOneTap = (request) => oneTapReady(request?.proposal);

/**
 * The line that says what to check before a packet goes, or "" when it may
 * go on one tap. Unrecognised and unanswered asks are named here, because
 * none of them is in the cover note (requestPacket.js reviewReason).
 */
export const reviewLine = (request) => (request?.proposal ? reviewReason(request.proposal) : "");

/**
 * Why the Approve button will not send, or null when it will. Each reason is
 * a next step, not a shrug: the physician can act on every one of them, and
 * "Open the request" names the screen that has the field (the earlier "Set
 * the requester's address first" named a field that does not exist, and
 * "Tap Review" named a link the inbox detail does not have). The address
 * checks mirror send-packet-email, which refuses a credentialdomd.com
 * recipient and the physician's own addresses (profile email, forwarding
 * sender, confirmed forwarding addresses); catching them here means the tap
 * never fails. `docIds` is the selection when the screen shows one;
 * otherwise the proposal's.
 *
 * An empty document list is not a block on its own. When the proposal has
 * items but nothing on file answers them (or the physician unticked every
 * document), the reply still goes: the cover note saying what is not on
 * file, and what the app will export, is the answer the credentialer is
 * waiting for. Only a request with no
 * proposal, or a proposal with no items and nothing to attach, has nothing
 * to send.
 */
export function approveBlockedReason(request, accountEmail, ownAddresses, docIds) {
  const me = low(accountEmail);
  if (!me) return "Add your email in Settings first";
  const to = low(request?.from_addr);
  if (OUR_DOMAIN_RE.test(to)) return "That is a CredentialDOMD address. Enter the requester's own.";
  if (!to || to === me || requesterMissing(request, ownAddresses)) return REQUESTER_NOT_FOUND_REASON;
  const proposal = request?.proposal;
  const items = Array.isArray(proposal?.items) ? proposal.items : [];
  const ids = Array.isArray(docIds) ? docIds : (Array.isArray(proposal?.docIds) ? proposal.docIds : []);
  if (!proposal || (items.length === 0 && ids.length === 0)) return NOTHING_MATCHED_REASON;
  return null;
}

/**
 * The one-tap call to send-packet-email: the request, and exactly what the
 * screen showed. doc_ids and text always travel, because the row can lag the
 * screen (the inbox rebuilds a stale proposal on the client and saves it
 * back without waiting); a tap that posted only the id once mailed a
 * three-document packet with a note saying the fourth was not on file while
 * the screen said it was attached. An empty note travels as "" and is sent
 * as no note.
 */
export function approveBody(request, { docIds, text } = {}) {
  const ids = Array.isArray(docIds) ? docIds : (Array.isArray(request?.proposal?.docIds) ? request.proposal.docIds : []);
  const note = typeof text === "string" ? text : String(request?.proposal?.coverNote ?? "");
  return { request_id: request?.id, approve: true, cc_self: true, doc_ids: ids.map(String), text: note };
}

/**
 * The send-packet-email response, unwrapped the way EmailPacketModal does it:
 * a non-2xx puts the function's own { error } text on res.error.context, and
 * the generic "Edge Function returned a non-2xx status code" is useless to
 * a physician standing at a nursing station.
 */
export async function unwrapInvoke(res) {
  if (res?.error) {
    let msg = res.error.message || "Could not send";
    try {
      const j = await res.error.context?.json?.();
      if (j?.error) msg = j.error;
    } catch { /* no JSON body */ }
    throw new Error(msg);
  }
  const out = res?.data || {};
  if (out.error) throw new Error(out.error);
  if (!out.ok) throw new Error("Could not send. Try again.");
  return out;
}

const WRAP = { minWidth: 0, overflowWrap: "anywhere" };

/**
 * Who asked, what they asked for, and what is ready. `compact` is the Home
 * banner: one size down, no breathing room, because it sits above the setup
 * card and must not push the ring off a phone screen.
 */
export function RequestPacketSummary({ request, T, compact, ownAddresses }) {
  const sum = proposalSummary(request?.proposal);
  const asks = askLine(request);
  return h("div", { style: { ...WRAP, display: "flex", flexDirection: "column", gap: compact ? 2 : 4 } },
    h("div", { style: { ...WRAP, fontSize: compact ? 13.5 : 15, fontWeight: 700, color: T.text } }, requesterLine(request, ownAddresses)),
    asks
      ? h("div", { style: { ...WRAP, fontSize: compact ? 12.5 : 13.5, color: T.textMuted, lineHeight: 1.4 } }, `Asked for: ${asks}`)
      : null,
    sum.line
      ? h("div", { style: { ...WRAP, fontSize: compact ? 12.5 : 13.5, fontWeight: 700, color: sum.ready ? T.success : T.warning } }, sum.line)
      : null,
  );
}

const isSelected = (selected, id) => {
  if (selected == null) return true;
  if (typeof selected.has === "function") return selected.has(id);
  if (Array.isArray(selected)) return selected.includes(id);
  return false;
};

/**
 * Every ask with what answers it. Found items list their documents with a
 * checkbox each (so a physician can drop one before sending); missing items
 * say "Not on file"; report items ("12 months of case logs") say "Follows
 * separately" because the app exports those on their own. An ask the rules
 * could not name says "Not recognised", muted rather than amber: "Not on
 * file" for a facility form the app could not even identify told the
 * physician their file was short of something. `selected` may be a Set, an
 * array, or absent (everything checked, read-only).
 */
export function ProposalChecklist({ proposal, T, selected, onToggle }) {
  const items = Array.isArray(proposal?.items) ? proposal.items : [];
  if (!items.length) return h("div", { style: { fontSize: 13, color: T.textDim } }, "No documents could be matched from this email.");
  return h("div", { style: { display: "flex", flexDirection: "column", gap: 8, minWidth: 0 } },
    ...items.map((item, idx) => {
      const ids = Array.isArray(item?.docIds) ? item.docIds : [];
      const labels = Array.isArray(item?.labels) ? item.labels : [];
      const status = item?.status === "report" ? "report" : ids.length ? "found" : "missing";
      const unclear = status === "missing" && item?.kind === "unknown";
      const rows = status === "found"
        ? ids.map((id, i) => h("label", {
          key: id,
          style: { display: "flex", alignItems: "flex-start", gap: 8, padding: "3px 0", fontSize: 13.5, color: T.text, minWidth: 0, cursor: onToggle ? "pointer" : "default" },
        },
        h("input", {
          type: "checkbox",
          checked: isSelected(selected, id),
          onChange: () => { if (onToggle) onToggle(id); },
          style: { marginTop: 2, flexShrink: 0 },
        }),
        h("span", { style: WRAP }, labels[i] || "Document")))
        : [h("div", {
          key: "status",
          style: { fontSize: 13, fontWeight: 600, padding: "2px 0", color: status === "report" || unclear ? T.textMuted : T.warning },
        }, status === "report" ? "Follows separately" : unclear ? "Not recognised" : "Not on file")];
      return h("div", { key: `${idx}-${item?.ask || ""}`, style: { minWidth: 0 } },
        h("div", { style: { ...WRAP, fontSize: 13.5, fontWeight: 700, color: T.text } }, String(item?.ask || "Request")),
        ...rows,
      );
    }),
  );
}

/**
 * The one button. Disabled with the reason printed under it when the send
 * cannot work; otherwise "Approve and send N documents", which calls
 * send(approveBody(request, { docIds, text })) and reports "Sent to <addr>".
 * With items but nothing to attach (nothing on file, or every document
 * unticked) it reads "Send reply (nothing to attach)" and sends the note
 * with doc_ids: []; the label changes because "Approve and send 0
 * documents" reads as a bug, and the send goes because the note saying
 * what is not on file is the reply. `docIds` and `text` are what this screen shows
 * (the detail view's ticked set and edited note); without them the
 * proposal's own are sent. No confirm dialog: the label already says what
 * goes where, and a second tap to confirm the first is the friction this
 * replaces. `send` is injected so the same button works from the board and
 * from the inbox, and so the test can hand it a fake. `notFoundReason` and
 * `noMatchReason` replace those two reasons alone, for a screen whose way
 * into the request is not "Open the request": the detail view renders the
 * address field right above this button, and "Open the request and enter
 * it" there pointed at the screen already open; Home has a Review link and
 * no Open, and "Open the request" there sent a physician on a phone to
 * More > Requests past the link that lands on it.
 */
export function ApproveSendButton({ request, T, accountEmail, ownAddresses, docIds, text: noteText, send, onSent, label, notFoundReason, noMatchReason, reviewed }) {
  const [phase, setPhase] = useState("idle"); // idle | sending | sent
  const [error, setError] = useState(null);
  const [sentTo, setSentTo] = useState("");
  // `reviewed` is the detail view, where the physician is looking at the
  // draft: the button sends what the screen shows and says so ("Send"). Away
  // from it, only a one-tap proposal may send at all.
  const computed = approveBlockedReason(request, accountEmail, ownAddresses, docIds)
    || (!reviewed && !oneTapReady(request?.proposal) ? REVIEW_FIRST_REASON : null);
  const reason = computed === REQUESTER_NOT_FOUND_REASON && notFoundReason ? notFoundReason
    : computed === NOTHING_MATCHED_REASON && noMatchReason ? noMatchReason
    : computed;
  const ids = Array.isArray(docIds) ? docIds : (Array.isArray(request?.proposal?.docIds) ? request.proposal.docIds : []);
  const n = ids.length;
  const items = Array.isArray(request?.proposal?.items) ? request.proposal.items : [];
  const nothingToAttach = n === 0 && items.length > 0;
  const ready = !reason && phase === "idle" && typeof send === "function";
  const text = phase === "sending" ? "Sending..."
    : phase === "sent" ? `Sent to ${sentTo}`
    : (label || (nothingToAttach ? "Send reply (nothing to attach)" : reviewed ? `Send ${plural(n, "document")}` : `Approve and send ${plural(n, "document")}`));

  const onClick = async (e) => {
    // The list card that holds this button opens on click; the tap that
    // approves must not also open it.
    if (e && typeof e.stopPropagation === "function") e.stopPropagation();
    if (!ready) return;
    setPhase("sending");
    setError(null);
    try {
      const result = await send(approveBody(request, { docIds: ids, text: noteText }));
      setSentTo(String(result?.to || request?.from_addr || ""));
      setPhase("sent");
      if (onSent) onSent(result);
    } catch (err) {
      setError((err && err.message) || "Could not send");
      setPhase("idle");
    }
  };

  const live = ready || phase === "sending";
  const btnStyle = {
    padding: "11px 14px", borderRadius: 10, border: "none", fontSize: 14, fontWeight: 800, fontFamily: "inherit",
    cursor: ready ? "pointer" : "default", maxWidth: "100%", minWidth: 0, whiteSpace: "normal", overflowWrap: "anywhere", textAlign: "center",
    background: phase === "sent" ? T.successDim : live ? "linear-gradient(135deg, #10b981, #059669)" : T.border,
    color: phase === "sent" ? T.success : live ? "#fff" : T.textDim,
    opacity: phase === "sending" ? 0.7 : 1,
  };

  return h("div", { style: { display: "flex", flexDirection: "column", gap: 6, minWidth: 0, maxWidth: "100%" } },
    h("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, minWidth: 0 } },
      h("button", { type: "button", onClick, disabled: !ready, style: btnStyle }, text),
    ),
    reason ? h("div", { style: { ...WRAP, fontSize: 12.5, color: T.textMuted } }, reason) : null,
    error ? h("div", { style: { ...WRAP, fontSize: 13, fontWeight: 600, color: T.danger } }, error) : null,
  );
}

/**
 * The primary action for a packet that may not go on one tap: Review, which
 * opens the request with its draft editable, and under it the line that says
 * what is unclear.
 */
export function ReviewButton({ request, T, onReview, reason }) {
  const why = reason === undefined ? reviewLine(request) : reason;
  const btnStyle = {
    padding: "11px 14px", borderRadius: 10, border: "none", fontSize: 14, fontWeight: 800, fontFamily: "inherit",
    cursor: "pointer", maxWidth: "100%", minWidth: 0, whiteSpace: "normal", overflowWrap: "anywhere", textAlign: "center",
    background: T.accent, color: "#fff",
  };
  const onClick = (e) => {
    if (e && typeof e.stopPropagation === "function") e.stopPropagation();
    if (onReview) onReview(request);
  };
  return h("div", { style: { display: "flex", flexDirection: "column", gap: 6, minWidth: 0, maxWidth: "100%" } },
    h("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, minWidth: 0 } },
      h("button", { type: "button", onClick, style: btnStyle }, "Review"),
    ),
    why ? h("div", { style: { ...WRAP, fontSize: 12.5, color: T.warning, lineHeight: 1.45 } }, why) : null,
  );
}

/**
 * On the request itself: each ask the draft says nothing about, as a
 * question for the physician. An unrecognised ask asks what they meant; an
 * ask nothing on file answers offers to say so in the draft
 * (onSayNotOnFile, which adds the "Not on file" lines). Nothing is shown for
 * a proposal that may go on one tap.
 */
export function UnclearNote({ request, T, onSayNotOnFile, canEdit = true }) {
  const proposal = request?.proposal;
  if (!proposal || oneTapReady(proposal)) return null;
  const items = Array.isArray(proposal.items) ? proposal.items.filter((i) => i && typeof i === "object") : [];
  const unclear = items.filter((i) => i.status !== "found" && i.status !== "report" && i.kind === "unknown");
  const missing = items.filter((i) => i.status !== "found" && i.status !== "report" && i.kind !== "unknown");
  const keyword = proposal.source !== "model";
  const line = (text, key, extra = null) => h("div", { key, style: { ...WRAP, fontSize: 13, color: T.text, lineHeight: 1.45 } }, text, extra);
  // Saved as unclear: there are no asks to go through, only the email to read.
  const unclearEmail = proposal.unclear === true;
  const link = (label, onClick) => h("button", {
    type: "button", onClick,
    style: { marginLeft: 6, padding: 0, border: "none", background: "none", color: T.accent, font: "inherit", fontWeight: 700, cursor: "pointer", textDecoration: "underline" },
  }, label);
  return h("div", { style: { marginTop: 10, padding: "10px 12px", borderRadius: 10, border: `1px solid ${T.warning}`, display: "flex", flexDirection: "column", gap: 6, minWidth: 0 } },
    h("div", { style: { fontSize: 12, fontWeight: 700, color: T.warning, textTransform: "uppercase", letterSpacing: 0.4 } }, "Check before sending"),
    unclearEmail ? line(reviewReason(proposal), "x") : null,
    ...unclear.map((i, n) => line(`"${String(i.ask || "")}": not recognised. What did they mean? The draft says nothing about it.`, `u${n}`)),
    missing.length ? line(`Not on file: ${missing.map((i) => `"${String(i.ask || "")}"`).join(", ")}. The draft says nothing about ${missing.length === 1 ? "it" : "them"}.`, "m",
      canEdit && onSayNotOnFile ? link("Say so in the draft", () => onSayNotOnFile()) : null) : null,
    unclearEmail ? null
      : keyword ? line("These asks were read by keyword matching, so check that each one is really something they asked for.", "k")
      : proposal.confidence !== "high" ? line("The reading of this email is not certain, so check the draft before it goes.", "c") : null,
  );
}
