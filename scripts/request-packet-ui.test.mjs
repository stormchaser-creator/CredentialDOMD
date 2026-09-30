// The one-tap packet UI (src/components/features/RequestPacket.js), rendered
// with react-dom/server against a fake theme. These pieces are shared by the
// Home banner and More > Requests, and they are written with createElement
// and no app imports precisely so this file can render every state in plain
// node: the ready/missing line, each reason the Approve button refuses, the
// label that says what goes where, and the wrapping styles that keep a
// 375px screen from scrolling sideways.
//
// The fixtures are shaped on the two real requests on file, with every name
// and address invented: one ask for a board certificate, and a four-item
// list whose last item is a case log report the app exports separately.
//
// The second half covers src/utils/requestProposals.js, the client-side
// rebuild of a proposal the server did not make or that the file has since
// outgrown, against the owner's-file fixture from request-packet.test.mjs.
// Run: node scripts/request-packet-ui.test.mjs   (pure node, no runner)
import React from "react";
import { renderToString } from "react-dom/server";
import {
  proposalSummary, requesterLine, requesterMissing, askLine, approveBlockedReason, approveBody, unwrapInvoke,
  RequestPacketSummary, ProposalChecklist, ApproveSendButton, REQUESTER_NOT_FOUND_REASON, NOTHING_MATCHED_REASON,
  HOME_NOT_FOUND_REASON, HOME_NO_MATCH_REASON, REVIEW_FIRST_REASON, ReviewButton, UnclearNote, canSendOnOneTap, reviewLine,
} from "../src/components/features/RequestPacket.js";
import { staleRequests, buildClientProposals, withProposals, documentSetKey, modelReading } from "../src/utils/requestProposals.js";
import { DOCS, RECORDS, PHYSICIAN, NOW, REQUEST_1 } from "./request-packet.test.mjs";
import * as requestPacketModule from "../src/utils/requestPacket.js";
import { mountComponent, settle } from "../tests/component-harness.mjs";

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${n}\n   got  ${g}\n   want ${w}`); }
};
const ok = (n, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${n} ${extra}`); } };

const T = {
  text: "#0F172A", textMuted: "#374151", textDim: "#6B7280",
  accent: "#10b981", accentDim: "rgba(16,185,129,0.08)", border: "#D1FAE5",
  success: "#059669", successDim: "#ECFDF5", warning: "#D97706", danger: "#DC2626",
  card: "#FFFFFF", input: "#F0FDF8", inputBorder: "#D1FAE5",
};

const h = React.createElement;
const render = (type, props) => renderToString(h(type, props));

// ── Fixtures ────────────────────────────────────────────────────────────
const boardCert = {
  id: "11111111-1111-4111-8111-111111111111",
  from_name: "Casey Example", from_addr: "casey.example@osterly-health.example", subject: "BOARD CERTIFICATE",
  proposal: {
    v: 2, method: "rules", source: "model", confidence: "high", verified: true,
    items: [{ ask: "a copy of your board certificate", kind: "board_cert", status: "found", docIds: ["d1"], labels: ["Board Certification (AOA)"], confidence: "high", ruleKind: "board_cert" }],
    docIds: ["d1"], missing: [],
    coverNote: "Hello Casey,\n\nAttached are the documents you asked for:\n- Board Certification (AOA)\n\nRegards,\nRowan Testa, DO",
  },
};
const fourItems = {
  id: "22222222-2222-4222-8222-222222222222",
  from_name: "Jordan Sample", from_addr: "jordan.sample@quillfeather.example", subject: "RE: Requested docs",
  proposal: {
    v: 2, method: "rules", source: "model", confidence: "high", verified: true,
    items: [
      { ask: "Ridgeway COI", kind: "coi_malpractice", status: "found", docIds: ["d2"], labels: ["Professional Liability COI, Harborline Specialty Insurance"], confidence: "high", ruleKind: "coi_malpractice" },
      { ask: "MMR dose #2", kind: "mmr", status: "found", docIds: ["d3", "d4"], labels: ["MMR (Measles, Mumps, Rubella) vaccination", "MMR (Measles, Mumps, Rubella) vaccination"], confidence: "high", ruleKind: "mmr" },
      { ask: "TB form", kind: "tb", status: "found", docIds: ["d5"], labels: ["QuantiFERON-TB Gold, Negative"], confidence: "high", ruleKind: "tb" },
      { ask: "Logs 12-months", kind: "case_logs", status: "report", docIds: [], labels: [], confidence: "high", ruleKind: "case_logs" },
    ],
    docIds: ["d2", "d3", "d4", "d5"], missing: ["Logs 12-months"],
    coverNote: "Hello Jordan,\n\nAttached are the documents you asked for:\n- Professional Liability COI\n\nThese will follow separately:\n- Logs 12-months\n\nRegards,\nRowan Testa, DO",
  },
};
const nothingFound = {
  id: "33333333-3333-4333-8333-333333333333",
  from_name: "Sam Example", from_addr: "sam.example@clinic.example", subject: "Fingerprints",
  proposal: {
    v: 1, method: "rules",
    items: [{ ask: "Livescan fingerprint receipt", kind: "background", status: "missing", docIds: [], labels: [] }],
    docIds: [], missing: ["Livescan fingerprint receipt"],
    coverNote: "Hello Sam,\n\nI do not have these on file:\n- Livescan fingerprint receipt\n\nRegards,\nRowan Testa, DO",
  },
};
const twoDocs = {
  id: "44444444-4444-4444-8444-444444444444",
  from_name: "Jordan Sample", from_addr: "jordan.sample@brackwater.example", subject: "DEA and license",
  proposal: {
    v: 2, method: "rules", source: "model", confidence: "high", verified: true,
    items: [
      { ask: "DEA", kind: "dea", status: "found", docIds: ["d6"], labels: ["DEA Registration, CO"], confidence: "high", ruleKind: "dea" },
      { ask: "Colorado license", kind: "state_license", status: "found", docIds: ["d7"], labels: ["State Medical License (DO), CO"], confidence: "high", ruleKind: "state_license" },
    ],
    docIds: ["d6", "d7"], missing: [],
    coverNote: "Hello Jordan,\n\nAttached are the documents you asked for:\n- DEA Registration, CO\n- State Medical License (DO), CO\n\nRegards,\nRowan Testa, DO",
  },
};
const noProposal = { id: "55555555-5555-4555-8555-555555555555", from_name: null, from_addr: "cred@somewhere.org", subject: "Docs please", proposal: null };
const ME = "rowan.testa@clinic.example";

// ── proposalSummary: the line both screens print ─────────────────────────
eq("one document ready", proposalSummary(boardCert.proposal), { ready: 1, missing: 0, report: 0, unclear: 0, line: "1 document ready" });
eq("four ready, one follows separately (a report is not a missing file)", proposalSummary(fourItems.proposal), { ready: 4, missing: 0, report: 1, unclear: 0, line: "4 documents ready, 1 follows separately" });
eq("nothing found says so", proposalSummary(nothingFound.proposal).line, "Nothing on file for this yet");
eq("no proposal prints nothing rather than a false zero", proposalSummary(null), { ready: 0, missing: 0, report: 0, unclear: 0, line: "" });
eq("ready counts distinct documents, from the items when docIds is absent",
  proposalSummary({ items: [{ status: "found", docIds: ["a", "b"] }, { status: "found", docIds: ["b"] }, { status: "missing", docIds: [] }] }),
  { ready: 2, missing: 1, report: 0, unclear: 0, line: "2 documents ready, 1 not on file" });
eq("no items at all is a statement about the email, not the file", proposalSummary({ v: 1, items: [], docIds: [], missing: [] }).line, "Nothing could be read from this email");
eq("an unnamed ask is 'not recognised', and the counts are separate words",
  proposalSummary({ items: [
    { status: "found", docIds: ["a"] }, { status: "missing", kind: "tb", docIds: [] }, { status: "report", kind: "case_logs", docIds: [] },
    { status: "report", kind: "npi", docIds: [] }, { status: "missing", kind: "unknown", docIds: [] },
  ] }),
  { ready: 1, missing: 1, report: 2, unclear: 1, line: "1 document ready, 1 not on file, 2 follow separately, 1 not recognised" });
eq("nothing on file does not repeat itself as 'N not on file'", proposalSummary({ items: [{ status: "missing", kind: "tb", docIds: [] }], docIds: [] }).line, "Nothing on file for this yet");

// ── requester and ask lines ──────────────────────────────────────────────
eq("requester is the name and the domain", requesterLine(boardCert), "Casey Example, osterly-health.example");
eq("no name falls back to the address", requesterLine(noProposal), "cred@somewhere.org");
// A row whose from_addr is the physician's own address has no requester:
// email-inbound stores the forwarding sender there when the forward carried
// no From: line. The bold "who asked" slot must not show the physician.
const ME_FWD = { id: "66666666-6666-4666-8666-666666666666", from_name: null, from_addr: "rowan@hospital.example", forwarded_by: "rowan@hospital.example", subject: "docs", proposal: boardCert.proposal };
eq("requester equal to the forwarding sender is 'Requester not found'", requesterLine(ME_FWD), "Requester not found");
eq("requester equal to a confirmed address is 'Requester not found'", requesterLine({ ...ME_FWD, forwarded_by: null }, ["rowan.testa@clinic.example", "Rowan@Hospital.example"]), "Requester not found");
eq("a real requester with no name is still their address", requesterLine({ ...ME_FWD, from_addr: "cred@x.org" }, ["rowan@hospital.example"]), "cred@x.org");
// A forward of the physician's own message (or a thread whose top message is
// their own reply): the first From: line is "Their Name <their address>", so
// from_name is the physician's. It must not print as who asked (INTAKE-004).
const SELF_NAMED = { ...ME_FWD, from_name: "Rowan Testa", forwarded_by: "rowan@hospital.example" };
eq("the physician's own name on their own address is 'Requester not found'", requesterLine(SELF_NAMED), "Requester not found");
eq("...also when the address is a confirmed one and not the forwarder", requesterLine({ ...SELF_NAMED, forwarded_by: "rowan.testa@clinic.example" }, ["Rowan@Hospital.example"]), "Requester not found");
eq("...and the Approve reason agrees", approveBlockedReason(SELF_NAMED, "rowan@hospital.example", ["rowan@hospital.example"], ["d1"]), REQUESTER_NOT_FOUND_REASON);
eq("a real requester's name still prints", requesterLine({ ...SELF_NAMED, from_addr: "casey@osterly-health.example", from_name: "Casey Example" }, ["rowan@hospital.example"]), "Casey Example, osterly-health.example");
eq("a name with no address is still the requester's name", requesterLine({ ...SELF_NAMED, from_addr: "", from_name: "Casey Example" }), "Casey Example");
ok("the Home banner summary never names the physician as the requester", (() => {
  const html = render(RequestPacketSummary, { request: SELF_NAMED, T, compact: true, ownAddresses: ["rowan@hospital.example"] });
  return html.includes("Requester not found") && !html.includes("Rowan Testa");
})());
eq("requesterMissing: empty, forwarder, own address, or neither", [
  requesterMissing({ from_addr: "" }), requesterMissing(ME_FWD), requesterMissing({ from_addr: "a@b.c" }, ["A@B.C"]), requesterMissing({ from_addr: "a@b.c" }, ["x@y.z"]),
], [true, true, true, false]);
eq("first two asks, then how many more", askLine(fourItems), "Ridgeway COI, MMR dose #2 and 2 more");
eq("two asks need no 'more'", askLine(twoDocs), "DEA, Colorado license");
eq("no proposal falls back to the subject", askLine(noProposal), "Docs please");

// ── RequestPacketSummary ─────────────────────────────────────────────────
{
  const html = render(RequestPacketSummary, { request: boardCert, T });
  ok("summary names the requester", html.includes("Casey Example, osterly-health.example"));
  ok("summary lists the ask", html.includes("Asked for: a copy of your board certificate"));
  ok("summary carries the ready line", html.includes("1 document ready"));
  const compact = render(RequestPacketSummary, { request: fourItems, T, compact: true });
  ok("compact renders the same facts smaller", compact.includes("4 documents ready, 1 follows separately") && compact.includes("font-size:13.5px") && !compact.includes("font-size:15px") && html.includes("font-size:15px"));
  ok("nothing found is coloured as a warning, not a success", render(RequestPacketSummary, { request: nothingFound, T }).includes(T.warning));
  ok("the banner says 'Requester not found' rather than showing the physician's own address as the asker",
    render(RequestPacketSummary, { request: ME_FWD, T, compact: true, ownAddresses: ["rowan@hospital.example"] }).includes("Requester not found"));
}

// ── ProposalChecklist ────────────────────────────────────────────────────
{
  const all = new Set(fourItems.proposal.docIds);
  const html = render(ProposalChecklist, { proposal: fourItems.proposal, T, selected: all, onToggle: () => {} });
  ok("every ask is listed", ["Ridgeway COI", "MMR dose #2", "TB form", "Logs 12-months"].every((a) => html.includes(a)));
  ok("every found document gets a checkbox", (html.match(/type="checkbox"/g) || []).length === 4);
  ok("all four are checked when all are selected", (html.match(/checked=""/g) || []).length === 4);
  ok("labels are printed beside the boxes", html.includes("QuantiFERON-TB Gold, Negative") && html.includes("Professional Liability COI, Harborline Specialty Insurance"));
  ok("a report item says it follows separately", html.includes("Follows separately"));
  const one = render(ProposalChecklist, { proposal: fourItems.proposal, T, selected: new Set(["d2"]), onToggle: () => {} });
  ok("only the selected box is checked", (one.match(/checked=""/g) || []).length === 1);
  ok("a missing item says not on file", render(ProposalChecklist, { proposal: nothingFound.proposal, T, selected: new Set() }).includes("Not on file"));
  ok("an array works as the selection too", (render(ProposalChecklist, { proposal: twoDocs.proposal, T, selected: ["d7"] }).match(/checked=""/g) || []).length === 1);
  // "Nothing proposed yet" was the matcher's word for its own output; the
  // placeholder now says what happened to the email.
  ok("no proposal renders a placeholder, not a crash", render(ProposalChecklist, { proposal: null, T }).includes("No documents could be matched from this email."));
  ok("the placeholder no longer speaks matcher jargon", !render(ProposalChecklist, { proposal: null, T }).includes("proposed"));
}

// ── ApproveSendButton: the reasons, then the label ───────────────────────
{
  const send = async () => ({ ok: true });
  const noEmail = render(ApproveSendButton, { request: boardCert, T, accountEmail: "", send });
  ok("no account email: disabled with the reason", noEmail.includes("Add your email in Settings first") && noEmail.includes("disabled"));
  // Each reason names a screen the physician can reach, not a field it
  // does not have ("Set the requester's address first" once pointed
  // nowhere, and "Tap Review" named a link the inbox detail lacks).
  const NOT_FOUND = "Requester&#x27;s address not found. Open the request and enter it.";
  eq("the not-found reason is exported for the detail view to replace", REQUESTER_NOT_FOUND_REASON, "Requester's address not found. Open the request and enter it.");
  eq("the no-match reason is exported too", NOTHING_MATCHED_REASON, "No documents could be matched from this email. Open the request to pick them.");
  const ours = render(ApproveSendButton, { request: { ...boardCert, from_addr: "docs@credentialdomd.com" }, T, accountEmail: ME, send });
  ok("a credentialdomd.com requester: disabled, and the reason does not say 'Tap Review'", ours.includes("That is a CredentialDOMD address. Enter the requester&#x27;s own.") && ours.includes("disabled") && !ours.includes("Review"));
  const self = render(ApproveSendButton, { request: { ...boardCert, from_addr: ME.toUpperCase() }, T, accountEmail: ME, send });
  ok("the physician's own address as requester: not found, tap Review (case-insensitive)", self.includes(NOT_FOUND) && self.includes("disabled"));
  const fwd = render(ApproveSendButton, { request: ME_FWD, T, accountEmail: ME, send });
  ok("the forwarding sender as requester (no From: line in the forward): not found, disabled", fwd.includes(NOT_FOUND) && fwd.includes("disabled"));
  const own = render(ApproveSendButton, { request: { ...ME_FWD, forwarded_by: null }, T, accountEmail: ME, ownAddresses: ["rowan@hospital.example"], send });
  ok("a confirmed forwarding address as requester: not found, disabled", own.includes(NOT_FOUND) && own.includes("disabled"));
  ok("a lookalike domain is not ours", !render(ApproveSendButton, { request: { ...boardCert, from_addr: "a@notcredentialdomd.com" }, T, accountEmail: ME, send }).includes("disabled"));
  // A grey button over "Nothing proposed yet" left the physician not knowing
  // whether to wait, open the request, or reply by hand; the reason now
  // says what happened and names the next step.
  const none = render(ApproveSendButton, { request: noProposal, T, accountEmail: ME, send });
  ok("no proposal: no documents could be matched, open the request", none.includes("No documents could be matched from this email. Open the request to pick them.") && none.includes("disabled"));
  ok("no proposal: the old jargon is gone", !none.includes("Nothing proposed"));
  // Items but nothing on file is a reply, not a block: the note saying what
  // follows is what the credentialer is waiting for (C4, below).
  // Since 2026-09-28 it is never one tap, since nothing on file answers the
  // ask; on the request's own screen, where the draft is in view, it sends.
  const empty = render(ApproveSendButton, { request: nothingFound, T, accountEmail: ME, send, reviewed: true });
  ok("a proposal with items and no documents: enabled in review, and says nothing is attached", empty.includes("Send reply (nothing to attach)") && !empty.includes("disabled") && !empty.includes("could be matched"));
  const emptyAway = render(ApproveSendButton, { request: nothingFound, T, accountEmail: ME, send });
  ok("and away from the request it waits for a review", emptyAway.includes("disabled") && emptyAway.includes(REVIEW_FIRST_REASON));
  eq("the reason function agrees with the render", [
    approveBlockedReason(boardCert, ""), approveBlockedReason(noProposal, ME), approveBlockedReason(boardCert, ME),
    approveBlockedReason(ME_FWD, ME), approveBlockedReason({ ...ME_FWD, forwarded_by: null }, ME, ["rowan@hospital.example"]), approveBlockedReason(twoDocs, ME, [], []),
  ], ["Add your email in Settings first", NOTHING_MATCHED_REASON, null, REQUESTER_NOT_FOUND_REASON, REQUESTER_NOT_FOUND_REASON, null]);
  // The detail view renders the address field above the button and hands in
  // words that fit; every other reason keeps its own text.
  const inline = render(ApproveSendButton, { request: ME_FWD, T, accountEmail: ME, send, notFoundReason: "Type the requester's email above to send." });
  ok("notFoundReason replaces the not-found reason on the request's own screen", inline.includes("Type the requester&#x27;s email above to send.") && !inline.includes("Open the request") && inline.includes("disabled"));
  ok("notFoundReason does not touch the other reasons", render(ApproveSendButton, { request: noProposal, T, accountEmail: ME, send, notFoundReason: "Type it above." }).includes("No documents could be matched")
    && render(ApproveSendButton, { request: boardCert, T, accountEmail: "", send, notFoundReason: "Type it above." }).includes("Add your email in Settings first"));
  ok("a typed address on the row clears the block and the button goes live", !render(ApproveSendButton, { request: { ...ME_FWD, from_addr: "cred@hospital.org" }, T, accountEmail: ME, send, notFoundReason: "Type it above." }).includes("disabled"));

  // Home's banner has a Review link and no Open, so it hands in reasons that
  // say "Tap Review"; the default "Open the request" sent a physician on a
  // phone looking for a control that was not there. The words live in
  // RequestPacket.js so this test renders what Home actually shows.
  eq("Home's reasons name Review", [HOME_NOT_FOUND_REASON, HOME_NO_MATCH_REASON],
    ["Requester's address not found. Tap Review and enter it.", "No documents could be matched from this email. Tap Review to pick them."]);
  const homeProps = { T, accountEmail: ME, send, notFoundReason: HOME_NOT_FOUND_REASON, noMatchReason: HOME_NO_MATCH_REASON };
  const homeFwd = render(ApproveSendButton, { ...homeProps, request: ME_FWD });
  ok("Home, requester not found: 'Tap Review and enter it', never 'Open the request'", homeFwd.includes("Tap Review and enter it.") && !homeFwd.includes("Open the request") && homeFwd.includes("disabled"));
  const homeNoItems = render(ApproveSendButton, { ...homeProps, request: { ...noProposal, proposal: { v: 1, method: "rules", items: [], docIds: [], missing: [], coverNote: "" } } });
  ok("Home, nothing matched: 'Tap Review to pick them', never 'Open the request'", homeNoItems.includes("Tap Review to pick them.") && !homeNoItems.includes("Open the request") && homeNoItems.includes("disabled"));
  ok("noMatchReason leaves the not-found reason alone, and the other way round",
    render(ApproveSendButton, { request: ME_FWD, T, accountEmail: ME, send, noMatchReason: HOME_NO_MATCH_REASON }).includes(NOT_FOUND)
    && render(ApproveSendButton, { request: noProposal, T, accountEmail: ME, send, notFoundReason: HOME_NOT_FOUND_REASON }).includes("Open the request to pick them."));
  ok("Home's reasons do not touch a ready packet or the other reasons", !render(ApproveSendButton, { ...homeProps, request: twoDocs }).includes("Review")
    && render(ApproveSendButton, { ...homeProps, request: boardCert, accountEmail: "" }).includes("Add your email in Settings first"));

  // What the tap sends: the request, and exactly what the screen showed.
  eq("approveBody carries the proposal's documents and note by default", approveBody(fourItems),
    { request_id: fourItems.id, approve: true, cc_self: true, doc_ids: ["d2", "d3", "d4", "d5"], text: fourItems.proposal.coverNote });
  eq("approveBody carries the screen's selection and note when given", approveBody(fourItems, { docIds: ["d5"], text: "Hi" }),
    { request_id: fourItems.id, approve: true, cc_self: true, doc_ids: ["d5"], text: "Hi" });
  eq("approveBody sends an emptied note as an empty string, not the stored note", approveBody(fourItems, { text: "" }).text, "");
  eq("approveBody with no proposal sends no documents", approveBody(noProposal).doc_ids, []);
  ok("the selection sets the count on the button", render(ApproveSendButton, { request: fourItems, T, accountEmail: ME, send, docIds: ["d2", "d3"] }).includes("Approve and send 2 documents"));

  const two = render(ApproveSendButton, { request: twoDocs, T, accountEmail: ME, send });
  ok("ready: Approve and send 2 documents", two.includes("Approve and send 2 documents"));
  ok("ready: the button is enabled and no reason is printed", !two.includes("disabled") && !two.includes("Settings first") && !two.includes("could be matched"));
  ok("one document is singular", render(ApproveSendButton, { request: boardCert, T, accountEmail: ME, send }).includes("Approve and send 1 document<"));
  ok("four documents is plural", render(ApproveSendButton, { request: fourItems, T, accountEmail: ME, send }).includes("Approve and send 4 documents"));
  ok("the label prop replaces the text", render(ApproveSendButton, { request: twoDocs, T, accountEmail: ME, send, label: "Approve and send" }).includes(">Approve and send<"));
  ok("no send function: not clickable", render(ApproveSendButton, { request: twoDocs, T, accountEmail: ME }).includes("disabled"));
}

// ── One tap is for a packet a model read with high confidence (2026-09-28) ─
{
  const send = async () => ({ ok: true });
  const keyword = { ...boardCert, id: "77777777-7777-4777-8777-777777777777", proposal: { ...boardCert.proposal, source: "rules", confidence: "keyword", items: boardCert.proposal.items.map(({ confidence: _c, ...i }) => i) } };
  ok("a model-read packet with every ask matched may go on one tap", canSendOnOneTap(boardCert) && canSendOnOneTap(fourItems) && canSendOnOneTap(twoDocs));
  ok("a keyword packet may not, however well it matched", !canSendOnOneTap(keyword) && !canSendOnOneTap(nothingFound) && !canSendOnOneTap(noProposal));
  const away = render(ApproveSendButton, { request: keyword, T, accountEmail: ME, send });
  ok("away from the request, a keyword packet's button is disabled and says to review first", away.includes("disabled") && away.includes(REVIEW_FIRST_REASON));
  const inReview = render(ApproveSendButton, { request: keyword, T, accountEmail: ME, send, reviewed: true });
  ok("on the request, with the draft in view, it sends and says Send, not Approve and send", !inReview.includes("disabled") && inReview.includes("Send 1 document<") && !inReview.includes("Approve"));
  ok("an address problem still blocks in review", render(ApproveSendButton, { request: { ...keyword, from_addr: "docs@credentialdomd.com" }, T, accountEmail: ME, send, reviewed: true }).includes("disabled"));
  eq("reviewLine is empty for a one-tap packet", reviewLine(boardCert), "");
  eq("and names what to check otherwise", reviewLine(keyword), "The asks were read by keyword matching, so check the draft before it goes.");
  const review = render(ReviewButton, { request: keyword, T, onReview: () => {} });
  ok("ReviewButton: Review, with what is unclear under it", review.includes(">Review<") && review.includes("keyword matching") && review.includes(T.warning));
  const unclear = { ...keyword, proposal: { ...keyword.proposal, items: [...keyword.proposal.items,
    { ask: "attestation form", kind: "unknown", status: "missing", docIds: [], labels: [] },
    { ask: "Colorado DEA", kind: "dea", status: "missing", docIds: [], labels: [] }] } };
  const note = render(UnclearNote, { request: unclear, T, onSayNotOnFile: () => {} });
  ok("UnclearNote asks the physician what an unrecognised ask meant", note.includes("&quot;attestation form&quot;: not recognised. What did they mean? The draft says nothing about it."));
  ok("UnclearNote names what is not on file and offers to say so", note.includes("Not on file: &quot;Colorado DEA&quot;. The draft says nothing about it.") && note.includes("Say so in the draft"));
  ok("UnclearNote says the reading was by keyword", note.includes("read by keyword matching"));
  eq("UnclearNote shows nothing for a one-tap packet", render(UnclearNote, { request: boardCert, T }), "");
  ok("UnclearNote offers no edit on a request that is not open", !render(UnclearNote, { request: unclear, T, onSayNotOnFile: () => {}, canEdit: false }).includes("Say so in the draft"));
  ok("no em dash in any of it", ![away, inReview, review, note].some((x) => x.includes("\u2014")));
}

// ── An unverified forward always leads with Review (INTAKE-004) ─────────
{
  const send = async () => ({ ok: true });
  const unverified = { ...boardCert, id: "88888888-8888-4888-8888-888888888888", proposal: { ...boardCert.proposal, verified: false } };
  ok("an unverified forward's model/high packet may not go on one tap", !canSendOnOneTap(unverified));
  const away = render(ApproveSendButton, { request: unverified, T, accountEmail: ME, send });
  ok("away from the request its button is disabled and says to review first", away.includes("disabled") && away.includes(REVIEW_FIRST_REASON));
  const note = render(UnclearNote, { request: unverified, T });
  ok("UnclearNote says the forward could not be verified", note.includes("This forward could not be verified as coming from you. Check who is asking before you send anything."), note);
  ok("ReviewButton says it too", render(ReviewButton, { request: unverified, T, onReview: () => {} }).includes("could not be verified"));
  eq("approveBody marks a send made with the draft in view", approveBody(unverified, { reviewed: true }).reviewed, true);
  ok("approveBody leaves reviewed off otherwise", !("reviewed" in approveBody(unverified)));
  // The detail view's button tells send-packet-email the draft was in view,
  // which is what lets the server refuse an unreviewed approve of an
  // unverified forward from an older installed app.
  const bodies = [];
  for (const reviewed of [true, false]) {
    const request = reviewed ? unverified : { ...unverified, proposal: { ...unverified.proposal, verified: true } };
    const ui = await mountComponent("src/components/features/RequestPacket.js", {
      exportName: "ApproveSendButton", modules: { requestPacket: requestPacketModule },
      props: { request, T, accountEmail: ME, reviewed, send: async (b) => { bodies.push(b); return { ok: true, to: "x" }; } },
    });
    const button = ui.nodes().find((n) => n.type === "button");
    await button.props.onClick({ stopPropagation() {} });
    await settle();
  }
  eq("the reviewed send carries reviewed: true; the one-tap send does not", bodies.map((b) => b.reviewed === true), [true, false]);
}

// ── A client rebuild keeps a model's reading (2026-09-28) ────────────────
{
  const data = { documents: DOCS, ...RECORDS, settings: { name: "Rowan Testa", degreeType: "DO" } };
  const modelRow = {
    id: "r-model", status: "new", subject: "Docs", from_name: "Sam", from_addr: "s@x.example", proposal_at: "2020-01-01T00:00:00Z",
    body_text: "Proof of malpractice coverage is required for every provider. Please send your board certificate.",
    proposal: { v: 2, method: "rules", source: "model", confidence: "high", verified: true, docIds: [], missing: [], coverNote: "",
      items: [{ ask: "board certificate", quote: "your board certificate", kind: "board_cert", status: "missing", docIds: [], labels: [], confidence: "high" }] },
  };
  const built = buildClientProposals([modelRow], data, { now: NOW });
  const p = built["r-model"];
  eq("a stale model proposal is rebuilt from the model's asks, not the email's words", [p.method, p.source, p.confidence, p.items.map((i) => [i.ask, i.kind, i.status, i.quote])],
    ["rules-client", "model", "high", [["board certificate", "board_cert", "found", "your board certificate"]]]);
  ok("and, every ask now matched, it may go on one tap", canSendOnOneTap({ proposal: p }));
  // INTAKE-004: the rebuild keeps what the server recorded about the forward.
  eq("the rebuild keeps the forward's verification", p.verified, true);
  const unverifiedRow = { ...modelRow, id: "r-unverified", proposal: { ...modelRow.proposal, verified: false } };
  const rebuiltUnverified = buildClientProposals([unverifiedRow], data, { now: NOW })["r-unverified"];
  ok("a rebuilt unverified proposal stays unverified and is never one tap", rebuiltUnverified.verified === false && !canSendOnOneTap({ proposal: rebuiltUnverified }), JSON.stringify(rebuiltUnverified));
  const legacyRow = { ...modelRow, id: "r-legacy", proposal: (({ verified: _v, ...rest }) => rest)(modelRow.proposal) };
  const rebuiltLegacy = buildClientProposals([legacyRow], data, { now: NOW })["r-legacy"];
  ok("a rebuilt row with no verification recorded does not gain one", !("verified" in rebuiltLegacy) && !canSendOnOneTap({ proposal: rebuiltLegacy }));
  eq("modelReading is null for a rules proposal", modelReading(boardCert.proposal === null ? null : { ...boardCert.proposal, source: "rules" }), null);
  // The rebuild disagrees where the server did (the model's kind, not the
  // words' kind, goes back in), and an unclear email stays unclear.
  eq("modelReading hands back the model's kind", modelReading({ source: "model", confidence: "high", items: [{ ask: "BLS card", quote: "your BLS card", kind: "bls", modelKind: "coi_malpractice" }] }).asks,
    [{ quote: "your BLS card", kind: "coi_malpractice" }]);
  eq("an unclear rules proposal stays unclear", modelReading({ source: "rules", items: [], unclear: true }), { unclear: true });
  const unclearRow = { ...modelRow, id: "r-unclear", body_text: "The credentialing committee reviewed your file last week, and your coverage is provided through the group policy.",
    proposal: { v: 2, method: "rules", source: "rules", confidence: "keyword", items: [], docIds: [], missing: [], coverNote: "", unclear: true } };
  const rebuilt = buildClientProposals([unclearRow], data, { now: NOW })["r-unclear"];
  ok("a rebuilt unclear proposal is still unclear and never one tap", rebuilt.unclear === true && !canSendOnOneTap({ proposal: rebuilt }), JSON.stringify(rebuilt));
  eq("an unclear proposal's line says so", proposalSummary(rebuilt).line, "Not clear that it asks for anything");
  const note = render(UnclearNote, { request: { ...unclearRow, proposal: rebuilt }, T });
  ok("the note asks the physician to read it, and says nothing about keyword asks", note.includes("It is not clear whether this email asks you for anything") && !note.includes("keyword"), note);
}

// ── unwrapInvoke: the response the way EmailPacketModal reads it ─────────
{
  const out = await unwrapInvoke({ data: { ok: true, email_id: "e1", attached: 2, skipped: [] } });
  eq("a good response comes back whole", out.email_id, "e1");
  let msg = "";
  try { await unwrapInvoke({ error: { message: "Edge Function returned a non-2xx status code", context: { json: async () => ({ error: "Add your email in Settings first" }) } } }); }
  catch (e) { msg = e.message; }
  eq("a non-2xx surfaces the function's own error text", msg, "Add your email in Settings first");
  try { await unwrapInvoke({ error: { message: "Failed to fetch" } }); } catch (e) { msg = e.message; }
  eq("a transport error keeps its message", msg, "Failed to fetch");
  try { await unwrapInvoke({ data: { error: "That request is not in your account" } }); } catch (e) { msg = e.message; }
  eq("an error inside a 200 is still an error", msg, "That request is not in your account");
  try { await unwrapInvoke({ data: {} }); } catch (e) { msg = e.message; }
  eq("a response with no ok is refused", msg, "Could not send. Try again.");
}

// ── C3: the requester-not-found copy points at the screen with the field ─
{
  const send = async () => ({ ok: true });
  const reason = approveBlockedReason(ME_FWD, ME);
  eq("requester not found: open the request and enter it", reason, "Requester's address not found. Open the request and enter it.");
  ok("the old 'Tap Review' copy is gone for the missing requester", !reason.includes("Tap Review"));
  const html = render(ApproveSendButton, { request: ME_FWD, T, accountEmail: ME, send });
  ok("the rendered reason carries the same words", html.includes("Open the request and enter it.") && html.includes("disabled"));
  ok("a confirmed forwarding address as requester gets the same next step",
    approveBlockedReason({ ...ME_FWD, forwarded_by: null }, ME, ["rowan@hospital.example"]) === "Requester's address not found. Open the request and enter it.");
}

// ── C4: nothing to attach still sends the note ───────────────────────────
{
  const send = async () => ({ ok: true });
  eq("items with nothing on file: no block", approveBlockedReason(nothingFound, ME), null);
  eq("every document unticked: no block", approveBlockedReason(twoDocs, ME, [], []), null);
  eq("no proposal still blocks", approveBlockedReason(noProposal, ME), NOTHING_MATCHED_REASON);
  eq("a proposal with no items and nothing to attach still blocks",
    approveBlockedReason({ ...noProposal, proposal: { v: 1, method: "rules", items: [], docIds: [], missing: [], coverNote: "" } }, ME), NOTHING_MATCHED_REASON);
  const unticked = render(ApproveSendButton, { request: twoDocs, T, accountEmail: ME, send, docIds: [], text: "Hi Jordan" });
  ok("an emptied selection relabels the button and keeps it live", unticked.includes("Send reply (nothing to attach)") && !unticked.includes("disabled"));
  ok("the relabelled button is still the green one, not the grey", unticked.includes("linear-gradient(135deg, #10b981, #059669)"));
  ok("a caller's label still wins", render(ApproveSendButton, { request: twoDocs, T, accountEmail: ME, send, docIds: [], label: "Send it" }).includes(">Send it<"));
  eq("approveBody sends an empty doc list with the note", approveBody(nothingFound), { request_id: nothingFound.id, approve: true, cc_self: true, doc_ids: [], text: nothingFound.proposal.coverNote });
  eq("approveBody with an emptied selection sends [] and the edited note", approveBody(twoDocs, { docIds: [], text: "Hi Jordan" }).doc_ids.length === 0 && approveBody(twoDocs, { docIds: [], text: "Hi Jordan" }).text, "Hi Jordan");
  const noItems = render(ApproveSendButton, { request: { ...noProposal, proposal: { v: 1, items: [], docIds: [], missing: [] } }, T, accountEmail: ME, send });
  ok("no items renders disabled with the reason, not the nothing-to-attach label", noItems.includes("No documents could be matched from this email") && noItems.includes("disabled") && !noItems.includes("nothing to attach"));
  ok("a ready packet is unchanged by the rule", render(ApproveSendButton, { request: twoDocs, T, accountEmail: ME, send }).includes("Approve and send 2 documents"));
}

// ── C5: an unrecognised ask is not 'Not on file' ─────────────────────────
{
  const mixed = { items: [
    { ask: "TB form", kind: "tb", status: "missing", docIds: [], labels: [] },
    { ask: "Facility form 22-B", kind: "unknown", status: "missing", docIds: [], labels: [] },
  ] };
  const html = render(ProposalChecklist, { proposal: mixed, T, selected: new Set() });
  ok("an unknown missing ask prints 'Not recognised'", html.includes("Not recognised"));
  ok("a known missing ask still prints 'Not on file'", html.includes("Not on file"));
  const statusLine = (s, text) => { const i = s.indexOf(text); return s.slice(s.lastIndexOf("<div", i), i); };
  ok("'Not recognised' is muted, not amber", statusLine(html, "Not recognised").includes(T.textMuted) && !statusLine(html, "Not recognised").includes(T.warning));
  ok("'Not on file' stays amber", statusLine(html, "Not on file").includes(T.warning));
  const onlyUnknown = render(ProposalChecklist, { proposal: { items: [mixed.items[1]] }, T });
  ok("a proposal of only unrecognised asks shows no amber at all", !onlyUnknown.includes(T.warning) && !onlyUnknown.includes("Not on file"));
  ok("a found item with kind unknown is still a checkbox, not a status line",
    (render(ProposalChecklist, { proposal: { items: [{ ask: "x", kind: "unknown", status: "found", docIds: ["d9"], labels: ["Thing"] }] }, T }).match(/type="checkbox"/g) || []).length === 1);
}

// ── requestProposals: which rows are rebuilt, and with what ──────────────
{
  const data = { ...RECORDS, documents: DOCS, settings: { name: PHYSICIAN.name, degreeType: PHYSICIAN.degree } };
  const newest = Math.max(...DOCS.map((d) => new Date(d.uploadedAt).getTime()));
  const after = new Date(newest + 60_000).toISOString();
  const before = new Date(newest - 60_000).toISOString();
  const stored = { v: 2, method: "rules", source: "rules", confidence: "keyword", items: [{ ask: "board certificate", kind: "board_cert", status: "found", docIds: ["doc-board"], labels: ["Board Certification (AOA)"] }], docIds: ["doc-board"], missing: [], coverNote: "stored" };
  const req = { status: "new", subject: REQUEST_1.subject, body_text: REQUEST_1.body, from_name: REQUEST_1.fromName, from_addr: REQUEST_1.fromAddr };
  const fresh = { ...req, id: "r-fresh", proposal: stored, proposal_at: after };
  // A version-1 proposal was built by rules that could read a statement as an
  // ask and wrote "I could not tell" into its note: rebuilt once the file is
  // visible, and left alone on a device that cannot see it yet.
  const legacy = { ...req, id: "r-legacy", proposal: { ...stored, v: 1 }, proposal_at: after };
  eq("a version-1 proposal is stale once the file is visible", staleRequests([legacy], DOCS).map((r) => r.id), ["r-legacy"]);
  eq("but not on a device that cannot see the file", staleRequests([legacy], []).map((r) => r.id), []);
  const older = { ...req, id: "r-older", proposal: stored, proposal_at: before };
  const gone = { ...req, id: "r-gone", proposal: { ...stored, docIds: ["doc-deleted"], items: [{ ...stored.items[0], docIds: ["doc-deleted"] }] }, proposal_at: after };
  const absent = { ...req, id: "r-absent", proposal: null, proposal_at: null };
  const replied = { ...req, id: "r-replied", status: "replied", proposal: null };
  const homeRow = { ...req, id: "r-home", proposal: null }; delete homeRow.status;

  eq("a fresh proposal over the current file is left alone", staleRequests([fresh], DOCS).map((r) => r.id), []);
  eq("a proposal older than the newest upload is stale", staleRequests([older], DOCS).map((r) => r.id), ["r-older"]);
  eq("a proposal naming a deleted document is stale", staleRequests([gone], DOCS).map((r) => r.id), ["r-gone"]);
  eq("a row with no proposal is stale", staleRequests([absent], DOCS).map((r) => r.id), ["r-absent"]);
  eq("a replied row is never rebuilt, even without a proposal", staleRequests([replied], DOCS), []);
  eq("a row without a status column (the banner's query fixes it) counts as open", staleRequests([homeRow], DOCS).map((r) => r.id), ["r-home"]);
  eq("a proposal_at that does not parse is older than everything", staleRequests([{ ...fresh, proposal_at: "yesterday-ish" }], DOCS).map((r) => r.id), ["r-fresh"]);
  // No document list on this device is no evidence about the file. A fresh
  // laptop whose cloud load failed once rebuilt REQUEST_2's five-document
  // proposal as "nothing on file", wrote it back with a fresh proposal_at,
  // and every device then showed the request as unanswerable.
  eq("with no documents on this device, a stored proposal that names documents is NOT stale", staleRequests([fresh], []).map((r) => r.id), []);
  eq("nor with documents undefined", staleRequests([fresh], undefined), []);
  eq("nor one that names none", staleRequests([{ ...fresh, proposal: { ...stored, docIds: [] } }], []).length, 0);
  eq("a row with no proposal at all is still stale on an empty file (an account with no documents gets its honest proposal)", staleRequests([absent], []).map((r) => r.id), ["r-absent"]);
  eq("the gone-id rule still fires when the device can see a file", staleRequests([gone], DOCS).map((r) => r.id), ["r-gone"]);
  eq("and buildClientProposals builds nothing for the named proposal on an empty file", buildClientProposals([fresh], { ...data, documents: [] }, { now: NOW }), {});

  const built = buildClientProposals([fresh, older, absent, replied], data, { now: NOW });
  eq("only the stale open rows are rebuilt", Object.keys(built).sort(), ["r-absent", "r-older"]);
  eq("a rebuilt proposal is marked rules-client", built["r-older"].method, "rules-client");
  eq("and carries the matcher's result", [built["r-older"].v, built["r-older"].docIds, built["r-absent"].items[0].kind], [2, ["doc-board"], "board_cert"]);
  ok("the cover note greets the requester and signs as the physician", built["r-absent"].coverNote.startsWith("Hello Avery,") && built["r-absent"].coverNote.endsWith("Rowan Testa, DO"));
  eq("nothing stale, nothing built", buildClientProposals([fresh], data, { now: NOW }), {});
  eq("no rows, nothing built", buildClientProposals([], data, { now: NOW }), {});

  // The requester's own attachment must not be proposed back to them. A
  // CV request form that arrived with the request matches the CV rule by
  // name; only its inbox type keeps it out of the catalogue.
  const cvReq = { id: "r-cv", status: "new", subject: "CV", body_text: "Please send your CV.", from_name: "Sam", from_addr: "sam@x.example", proposal: null };
  const form = { id: "doc-cvform", name: "Provider_CV_Request_Form.pdf", type: "request-attachment-inbox", mimeType: "application/pdf", linkedTo: null, uploadedAt: "2026-09-01T10:00:00Z" };
  const noCv = DOCS.filter((d) => d.id !== "doc-cv");
  const withForm = buildClientProposals([cvReq], { ...data, documents: [...noCv, form] }, { now: NOW })["r-cv"];
  eq("a request attachment is never proposed as the CV", [withForm.items[0].kind, withForm.items[0].status, withForm.docIds], ["cv", "report", []]);
  const asPlainFile = buildClientProposals([cvReq], { ...data, documents: [...noCv, { ...form, type: "application/pdf" }] }, { now: NOW })["r-cv"];
  eq("the same file as an ordinary upload would be (so the exclusion is doing the work)", asPlainFile.docIds, ["doc-cvform"]);

  const rows = [fresh, older];
  const merged = withProposals(rows, built);
  eq("withProposals puts the built proposal on its row", merged[1].proposal.method, "rules-client");
  ok("and leaves the other rows as the same objects", merged[0] === fresh);
  ok("with nothing built it returns the same array", withProposals(rows, {}) === rows && withProposals(rows, null) === rows);
  ok("a document added or removed changes the persistence key", documentSetKey(DOCS) !== documentSetKey([...DOCS, form]) && documentSetKey(DOCS) !== documentSetKey(DOCS.slice(1)));
  ok("the key is stable for the same file", documentSetKey(DOCS) === documentSetKey([...DOCS]));
}

// ── House rules: wrapping and no em dashes, across every state ───────────
{
  const everything = [
    render(RequestPacketSummary, { request: fourItems, T }),
    render(RequestPacketSummary, { request: fourItems, T, compact: true }),
    render(ProposalChecklist, { proposal: fourItems.proposal, T, selected: new Set(fourItems.proposal.docIds) }),
    render(ApproveSendButton, { request: fourItems, T, accountEmail: ME, send: async () => ({}) }),
    render(ApproveSendButton, { request: boardCert, T, accountEmail: "", send: async () => ({}) }),
    render(ApproveSendButton, { request: nothingFound, T, accountEmail: ME, send: async () => ({}) }),
    render(ProposalChecklist, { proposal: { items: [{ ask: "Form 22-B", kind: "unknown", status: "missing", docIds: [], labels: [] }] }, T }),
  ];
  ok("nothing rendered carries an em dash", everything.every((s) => !s.includes("\u2014")));
  ok("long labels can break anywhere (overflow-wrap)", everything.every((s) => s.includes("overflow-wrap:anywhere")));
  ok("the button row wraps on a phone (flex-wrap)", everything[3].includes("flex-wrap:wrap") && everything[4].includes("flex-wrap:wrap"));
  ok("the button itself may wrap its label", everything[3].includes("white-space:normal") && everything[3].includes("max-width:100%"));
  ok("flex children can shrink (min-width:0)", everything.every((s) => s.includes("min-width:0")));
}

// ── Rendering is clean: no React warnings (a controlled box without onChange would print one) ──
{
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(" "));
  try {
    render(ProposalChecklist, { proposal: fourItems.proposal, T, selected: new Set(["d3"]) });
    render(ApproveSendButton, { request: twoDocs, T, accountEmail: ME, send: async () => ({}) });
    render(RequestPacketSummary, { request: noProposal, T });
  } finally {
    console.error = orig;
  }
  ok("no React warnings during render", errors.length === 0, errors.join(" | "));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
