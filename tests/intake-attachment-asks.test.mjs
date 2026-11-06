// A documentation request that lives in an attachment, not in the email.
//
// On 2026-11-05 a physician forwarded docs@ an email whose only words were a
// pointer to its PDF: the PDF was a hospital's letter asking for documents.
// Nothing in it was read. Three defects stacked:
//   - the scanner's prompt knows credentials and receipts, so the letter
//     came back nearly empty, and the reading was shown nothing it asked;
//   - verifyUnderstanding checked an ask's quote against the subject, the
//     note, the message and the history, never the attachments, so an ask
//     taken from the letter was dropped and the rules read the email;
//   - the rules never read the attachments at all.
// And the model call itself had failed with a 400 whose reason was thrown
// away (intakeModelCall.ts kept only the status).
//
// Passing the scanner's free notes on (the first attempt) leaked whatever a
// letter said: a case list names patients with dates, and four rounds of
// review kept finding a name shape the guesses missed. So the scanner is now
// asked for the KIND of each document requested and for the asking sentence
// with its details left out (requested_items, request_lead_in), and the host
// keeps an entry only when it is plainly a document's name (intakeFacts.mjs
// requestWords). The scanner's free notes and facts are not passed on, as
// before the incident.
//
// Every email, name and address here is synthetic.
// Run: node --test tests/intake-attachment-asks.test.mjs
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as understanding from "../supabase/functions/_shared/intakeUnderstanding.mjs";
import * as intakeFacts from "../supabase/functions/_shared/intakeFacts.mjs";
import { loadFunction, resetWorld, deliver, harness } from "../scripts/email-inbound-harness.mjs";
import { composeForward } from "../scripts/intake-eval.mjs";

// Namespace imports, so each test (not the whole file) shows what the code
// before the fix lacked.
const { verifyUnderstanding, rulesUnderstanding, ackWarranted, attachmentAsks, buildUnderstandingRequest, DROP } = understanding;
const { attachmentText, corpusIndex, requestWords } = intakeFacts;

// What the scanner returns for the 11-05 kind of letter, asked for what it
// requests (email-inbound SCAN_REQUEST_WORDS).
const LETTER_SCAN = {
  documentType: "other",
  confidence: "medium",
  extracted: { name: "Reappointment request letter", issuer: "Osterly Example Health", facts: [{ label: "Policy Number", value: "PL-4471902" }], suggestedCategory: { name: "Letters" } },
  notes: "Dear Dr. Testa, the file for Pat Sample (DOB 03/14/1961) is incomplete.",
  request_lead_in: "Please send the following documents to complete your reappointment file",
  requested_items: ["Current DEA certificate", "Current BLS card"],
};
const LETTER = (over = {}) => ({ ...LETTER_SCAN, ...over });

const factsFor = (parts, subject, words) => ({
  corpus: corpusIndex([subject, parts.note, parts.message, parts.history, ...words]),
  email: [subject, parts.note, parts.message, parts.history].filter(Boolean).join("\n\n"),
  attachments: words,
  refs: new Map(),
  physicianName: "Rowan Testa",
});

const reading = (asks, role = "request_checklist", confidence = "high") => ({
  intent: "request",
  asks: asks.map((quote) => ({ quote, kind: "unknown", who: "physician" })),
  attachments: [{ index: 1, role, filing: "Keep with the request" }],
  summary: "items for your reappointment file",
  confidence,
  records: [],
});
const verify = (asks, { message = "See attached.", words = [attachmentText(LETTER_SCAN)], role = "request_checklist", intent = "request", subject = "Reappointment file" } = {}) => {
  const parts = { note: "", message, history: "" };
  return verifyUnderstanding({ ...reading(asks, role), intent }, { subject, parts, attachmentCount: words.length, facts: factsFor(parts, subject, words) });
};
const rules = (body, words, types = words.map(() => "other"), subject = "Reappointment file") =>
  rulesUnderstanding({ subject, body, attachmentNames: words.map((_, i) => `file${i}.pdf`), attachmentCount: words.length, forwarded: true, attachmentWords: words, attachmentTypes: types });
const fromFile = (r) => r.asks.filter((a) => a.from === "attachment").map((a) => a.quote);

// ── What the host keeps of an attachment ─────────────────────────────────────

test("attachmentText passes on what a letter requests, as document kinds, and never the scan's free notes or facts", () => {
  const t = attachmentText(LETTER_SCAN);
  assert.equal(t, "requestLeadIn: Please send the following documents to complete your reappointment file\nrequestedItem: Current DEA certificate\nrequestedItem: Current BLS card\nname: Reappointment request letter\nissuer: Osterly Example Health");
  assert.ok(!/Sample|03\/14|PL-4471902/.test(t), "the notes and facts stay behind, as before the incident");
  assert.equal(attachmentText({ patientRecord: true, requested_items: ["Current BLS card"] }), "");
});

test("requestWords keeps a document's name and drops anything that could be a person, a place, a date or a number", () => {
  for (const kept of [
    "Current DEA certificate", "Current BLS card", "operative notes for the listed cases", "case log for the past 24 months",
    "DEA Registration", "State License", "Board Certificate", "CV", "Patient Logs for the past 24 months", "Patient Case List",
    "Patient Volume Attestation", "Patient Encounter Log", "Pt Log for reappointment", "Patient Contact Hours form",
    "Malpractice face sheet", "TB test results", "Please provide the operative notes for the listed cases",
  ]) assert.equal(requestWords(kept), kept, kept);
  for (const dropped of [
    // The fourth review's leaks, and every earlier round's.
    "1. Roe, Mary - craniotomy - 03/02/2026", "Mary Roe craniotomy on 03/02/2026", "Roe M 03/02/2026", "MARY ROE 03/02/2026", "Op note: Mary Board 03/02/2026",
    "Case 1: Roe, Lee - craniotomy", "Discharge summary for Staff, Pat", "Records for Jane Day", "Mary Roe", "Roe M", "MARY ROE",
    "Operative note for patient Pat Sample", "Patient Name - Pat Sample", "born March 14, 1961", "DEA registration QX1234563",
    "NPI 1234567893", "License MD 48213", "copy to casey.example@osterly-health.example", "records from Osterly Hospital",
    "Doctor of Medicine, Example State University", "a very long description of the requested document that goes on past ten words",
  ]) assert.equal(requestWords(dropped), "", dropped);
});

test("the scanner's own fields keep the identifier check, and whole lines are kept up to the cap", () => {
  const t = attachmentText({ documentType: "other", extracted: { name: "DEA Registration QX1234563", issuer: "Example Clinic NPI 1234567893", type: "License MD 48213", facility: "Example Hospital, patient Pat Sample", title: "Reappointment checklist", coveragePerClaim: "1000000" } });
  assert.equal(t, "title: Reappointment checklist\ncoveragePerClaim: 1000000");
  const many = attachmentText({ documentType: "other", extracted: { description: "x ".repeat(340).trim() }, requested_items: Array.from({ length: 25 }, () => "Current BLS card"), request_lead_in: "Please send the following" });
  assert.ok(many.split("\n").every((l) => /^(requestLeadIn|requestedItem|description): /.test(l)), "every line whole");
  assert.equal(many.split("\n").filter((l) => l.startsWith("requestedItem")).length, 1, "an item once");
});

// ── The model's reading ──────────────────────────────────────────────────────

test("the 11-05 case: an ask quoted from what the attachment requests is kept, from the attachment, medium at most, never acknowledged", () => {
  const v = verify(["Current DEA certificate", "Current BLS card"]);
  assert.deepEqual(v.asks.map((a) => [a.quote, a.from]), [["Current DEA certificate", "attachment"], ["Current BLS card", "attachment"]]);
  assert.equal(v.dropped.length, 0);
  assert.equal(v.unclear, false);
  assert.equal(v.needsRules, false);
  assert.equal(v.confidence, "medium");
  assert.equal(ackWarranted(v).ok, false);
  // Words in no attachment are still not the email's own.
  const invented = verify(["Please send your passport photo page."]);
  assert.deepEqual(invented.dropped.map((d) => d.why), [DROP.notOwnWords]);
  assert.equal(invented.needsRules, true);
});

test("a requested item counts under an asking lead-in, as a checklist, or when the message mentions what is attached", () => {
  const bare = [attachmentText(LETTER({ request_lead_in: undefined }))];
  for (const message of ["Attached are the items we need from you.", "Please find attached the items needed for reappointment.", "Attached please find our request.", "We need the attached items by Friday.", "Please see attached."]) {
    const v = verify(["Current DEA certificate", "Current BLS card"], { message, words: bare, role: "informational" });
    assert.equal(v.asks.length, 2, message);
  }
  assert.equal(verify(["Current BLS card"], { message: "Thank you for your time this week.", words: bare, role: "request_checklist" }).asks.length, 1, "a checklist");
  const neither = verify(["Current BLS card"], { message: "Thank you for your time this week.", words: bare, role: "informational" });
  assert.deepEqual(neither.dropped, [{ quote: "Current BLS card", why: DROP.notOwnWords }]);
  assert.equal(neither.needsRules, true);
  // The lead-in counts when it names what it asks for; a lead-in to a list does not.
  const fppe = [attachmentText(LETTER({ request_lead_in: "Please provide the operative notes for the listed cases", requested_items: [] }))];
  assert.equal(verify(["Please provide the operative notes for the listed cases"], { words: fppe }).asks.length, 1);
  assert.equal(verify(["Please send the following documents to complete your reappointment file"], { words: [attachmentText(LETTER({ request_lead_in: "Please send the following documents" }))] }).asks.length, 0);
});

test("a delivered card and an informational certificate stay what they were: nothing in an attachment makes them a request", () => {
  const card = [attachmentText({ documentType: "license", extracted: { issuer: "Example Heart Association", name: "BLS Provider" }, requested_items: ["Current BLS card"] })];
  const v = verify(["Current BLS card"], { message: "Attached is your renewed BLS card for your records.", words: card, role: "credential_for_physician", subject: "BLS card" });
  assert.equal(v.asks.length, 0);
  assert.equal(v.needsRules, true);
  assert.equal(rules("Attached is your renewed BLS card for your records.", card, ["license"], "BLS card").intent, rulesUnderstanding({ subject: "BLS card", body: "Attached is your renewed BLS card for your records.", attachmentNames: ["file0.pdf"], attachmentCount: 1, forwarded: true }).intent);
  const coi = [attachmentText({ documentType: "insurance", extracted: { provider: "Example Mutual" }, requested_items: ["certificate of insurance copy"] })];
  const info = verify(["certificate of insurance copy"], { message: "Here is my updated COI for my file.", words: coi, role: "informational", intent: "informational", subject: "COI" });
  assert.equal(info.intent, "informational");
  assert.equal(info.asks.length, 0);
});

test("an ask whose quote carries an identifier is dropped, even from words that did not come through attachmentText", () => {
  const v = verify(["DEA registration QX1234563", "Current BLS card"], { words: ["requestLeadIn: Please send the following\nrequestedItem: DEA registration QX1234563\nrequestedItem: Current BLS card"] });
  assert.deepEqual(v.asks.map((a) => a.quote), ["Current BLS card"]);
  assert.deepEqual(v.dropped.map((d) => d.why), [DROP.identifier]);
  assert.deepEqual(attachmentAsks(["requestedItem: DEA registration QX1234563\nrequestedItem: Current BLS card"]), ["Current BLS card"]);
});

test("the model is told an ask written in an attachment may be quoted from what it requests", () => {
  const text = buildUnderstandingRequest({ message: "See attached." }).system[0].text;
  assert.match(text, /written inside an attachment/);
  assert.match(text, /requestedItem and requestLeadIn/);
});

// ── The rules ────────────────────────────────────────────────────────────────

test("the rules read what a letter requests: the 11-05 asks, and the bare pointer gives way to them", () => {
  const r = rules("See attached.", [attachmentText(LETTER_SCAN)]);
  assert.deepEqual(fromFile(r), ["Current DEA certificate", "Current BLS card"]);
  assert.ok(!r.asks.some((a) => /^see attached$/i.test(a.quote)));
  assert.equal(r.unclear, false);
  assert.equal(ackWarranted(r).ok, false, "never acknowledged on the attachment's asks alone");
  // A credential's file is not read for asks.
  assert.deepEqual(fromFile(rules("See attached.", [attachmentText(LETTER_SCAN)], ["license"])), []);
});

test("the FPPE case list gives the generic ask with no names, on both paths", () => {
  // The scanner's reading of a case list, as it is asked to give it, and a
  // scanner that copied the cases anyway: the host keeps only the kind.
  const scan = LETTER({
    notes: "Please provide the operative notes for the following cases:\nCase 1: Roe, Lee - craniotomy 03/02/2026\nCase 2: Pat Sample, lumbar fusion, 04/11/2026",
    request_lead_in: "Please provide the operative notes for the listed cases",
    requested_items: ["operative notes for the listed cases", "Roe, Lee - craniotomy - 03/02/2026", "Pat Sample lumbar fusion"],
  });
  const words = [attachmentText(scan)];
  assert.ok(!/Roe|Sample|\d{2}\/\d{2}/.test(words[0]), words[0]);
  assert.deepEqual(fromFile(rules("See attached.", words, ["other"], "FPPE")), ["operative notes for the listed cases"]);
  const v = verify(["operative notes for the listed cases", "Roe, Lee - craniotomy - 03/02/2026"], { words, subject: "FPPE" });
  assert.deepEqual(v.asks.map((a) => a.quote), ["operative notes for the listed cases"]);
  // With only the lead-in, the rules still read the kind of document asked.
  const lead = [attachmentText(LETTER({ request_lead_in: "Please provide the operative notes for the listed cases", requested_items: [] }))];
  assert.equal(fromFile(rules("See attached.", lead, ["other"], "FPPE")).length, 1);
});

test("a delivery whose message only says what is attached stays a delivery, with no asks", () => {
  // A scanner that wrongly listed a badge's boilerplate as requested items.
  const badge = (type) => [attachmentText({ documentType: type, extracted: { name: "Hospital ID Badge", issuer: "Osterly Example Health" }, request_lead_in: "Please present a photo ID to obtain a replacement", requested_items: ["photo ID", "Current BLS card"] })];
  for (const type of ["other", "unknown"]) {
    for (const body of ["For my file.", "Attached is my new hospital ID badge.", "Attached is my updated vendor registration for my records."]) {
      const r = rules(body, badge(type), [type], "badge");
      const plain = rulesUnderstanding({ subject: "badge", body, attachmentNames: ["file0.pdf"], attachmentCount: 1, forwarded: true });
      if (plain.intent !== "delivery") continue;
      assert.equal(r.intent, "delivery", `${type} / ${body}`);
      assert.deepEqual(fromFile(r), [], `${type} / ${body}`);
    }
  }
  const pointed = rulesUnderstanding({ subject: "Reappointment", body: "Please see the attached letter regarding your reappointment.", attachmentNames: ["Reappointment letter.pdf"], attachmentCount: 1, attachmentWords: [attachmentText(LETTER_SCAN)], attachmentTypes: ["other"] });
  assert.equal(pointed.intent, "mixed", "a message that points to the letter as what it asks");
});

// ── End to end ───────────────────────────────────────────────────────────────

const PROFILE = "0b7f1c2e-5a44-4d7e-9b1a-3c2d1e0f9a88";
const ME = "rowan.testa@clinic.example";
const rows = (t) => harness.db.rows(t);
const CASE = {
  subject: "Reappointment file",
  from: { name: "Casey Example", address: "casey.example@osterly-health.example" },
  body: "Hi Dr. Testa,\n\nSee attached.\n\nCasey Example\nMedical Staff Office",
};

function seed() {
  rows("mailbox_claims").push({ address: ME, profile_id: PROFILE, proof: "verified", terminal_at: null });
  rows("profiles").push({ id: PROFILE, auth_user_id: "user_synthetic01", email: ME, access_status: "active", verified_email: ME, deleted_at: null, name: "Rowan Testa", degree_type: "MD", ack_requests: true });
  rows("app_secrets").push({ name: "gemini_shared_key", value: "AIza-test" }, { name: "anthropic_shared_key", value: "sk-ant-test" });
}

let n = 0;
const send = (scan = LETTER_SCAN, c = CASE, filename = "Reappointment_Request.pdf") => {
  harness.geminiReply = () => scan;
  return deliver({
    id: `att${++n}`, from: `Rowan Testa <${ME}>`, to: "docs@credentialdomd.com", subject: `Fwd: ${c.subject}`, text: composeForward(c),
    attachments: [{ filename, contentType: "application/pdf", bytes: new TextEncoder().encode(`%PDF-1.4 ${n}`) }],
  });
};
const toHospital = () => harness.sent.filter((m) => m.to?.[0] !== ME);
const FAIL = () => ({ status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "Synthetic   failure:\n the request was refused." } } });

before(async () => { await loadFunction(); });
beforeEach(() => { resetWorld(); harness.rawAuth = "mx.resend.com; dmarc=pass header.from=clinic.example"; seed(); });

test("end to end: the scanner is asked for document kinds only, the model's ask is kept, not one tap, no acknowledgement, and no letter text reaches the model", async () => {
  harness.anthropicReply = () => reading(["Current DEA certificate", "Current BLS card"]);
  const r = await send();
  assert.equal(r.status, 200);
  assert.equal(r.body.read, "model");
  assert.equal(r.body.intent, "request");
  assert.equal(r.body.one_tap, false);
  assert.match(r.body.ack, /^ack skipped: the asks were read only in an attachment/);
  const instruction = harness.gemini[0].body.contents[0].parts.at(-1).text;
  assert.match(instruction, /requested_items/);
  assert.match(instruction, /generic kind of document only/);
  assert.match(instruction, /never a patient, a case, a person's name/);
  assert.doesNotMatch(instruction, /word for word/);
  const prompt = harness.anthropic[0].body.messages[0].content;
  assert.ok(prompt.includes("requestedItem: Current DEA certificate"));
  assert.ok(!/Pat Sample|03\/14\/1961|PL-4471902/.test(prompt), "nothing from the letter's own notes or facts");
  const [req] = rows("document_requests");
  assert.ok(req.proposal.items.some((i) => /DEA certificate/.test(i.ask)));
  assert.equal(toHospital().length, 0);
  assert.match(rows("inbound_emails")[0].detail, /read by model \(medium\)/);
});

test("end to end: a 400 says why in the ledger, and the rules put the letter's asks in the request, read by keywords", async () => {
  harness.anthropicReply = FAIL;
  const r = await send();
  assert.equal(r.status, 200);
  assert.equal(r.body.read, "rules");
  const [row] = rows("inbound_emails");
  assert.match(row.detail, /read by rules \(the AI service answered 400 \(invalid_request_error: Synthetic failure: the request was refused\.\)\)/);
  assert.ok(!row.detail.includes("sk-ant-test"), "never the key");
  assert.ok(!/ack sent/i.test(row.detail));
  assert.equal(toHospital().length, 0);
  const [req] = rows("document_requests");
  const asks = req.proposal.items.map((i) => i.ask);
  assert.ok(asks.some((a) => /DEA certificate/.test(a)), JSON.stringify(asks));
  assert.ok(asks.some((a) => /BLS card/.test(a)), JSON.stringify(asks));
  assert.ok(!asks.some((a) => /^see attached$/i.test(a)));
  assert.equal(req.proposal.source, "rules");
  assert.equal(r.body.one_tap, false);
});

test("end to end: an FPPE case list stores the generic ask and no patient, on the rules path", async () => {
  harness.anthropicReply = FAIL;
  await send(LETTER({ request_lead_in: "Please provide the operative notes for the listed cases", requested_items: ["operative notes for the listed cases", "Roe, Lee - craniotomy - 03/02/2026"], notes: "Case 1: Roe, Lee - craniotomy 03/02/2026" }), { ...CASE, subject: "FPPE" }, "FPPE.pdf");
  const [req] = rows("document_requests");
  const stored = JSON.stringify(req.proposal);
  assert.ok(/operative notes for the listed cases/.test(stored), stored);
  assert.ok(!/Roe|03\/02\/2026/.test(stored), stored);
});

test("end to end: a hospital ID badge forwarded as \"Attached is my new hospital ID badge.\" is delivered and filed, not made a request, when the rules read it", async () => {
  harness.anthropicReply = FAIL;
  const r = await send({ documentType: "other", confidence: "high", extracted: { name: "Hospital ID Badge", issuer: "Osterly Example Health", facts: [{ label: "Valid through", value: "2027-06-30" }], suggestedCategory: { name: "Hospital ID Badges" } }, request_lead_in: "Please present a photo ID to obtain a replacement", requested_items: ["photo ID"] },
    { subject: "badge", from: CASE.from, body: "Attached is my new hospital ID badge." }, "badge.pdf");
  assert.equal(r.status, 200);
  assert.equal(r.body.read, "rules");
  assert.equal(r.body.intent, "delivery");
  assert.equal(rows("document_requests").length, 0, "no request row");
  assert.equal(rows("documents").length, 1);
  assert.notEqual(rows("documents")[0].type, "request-attachment-inbox", "not held with a request");
  assert.equal(toHospital().length, 0);
});
