// A documentation request that lives in an attachment, not in the email.
//
// On 2026-11-05 a physician forwarded docs@ an email whose only words were a
// pointer to its PDF: the PDF was a hospital's letter asking for documents.
// Nothing in it was read. Three defects stacked:
//   - the scanner's prompt knows credentials and receipts, so the letter
//     came back nearly empty, and attachmentText read only the flat
//     extracted fields (never the scan's notes or an "other" document's
//     facts), so the letter's words reached neither the model nor the host;
//   - verifyUnderstanding checked an ask's quote against the subject, the
//     note, the message and the history, never the attachments' words, so an
//     ask quoted from the letter was dropped and the rules read the email;
//   - the rules never read the attachments at all.
// And the model call itself had failed with a 400 whose reason was thrown
// away (intakeModelCall.ts kept only the status).
//
// Every email, name and address here is synthetic.
// Run: node --test tests/intake-attachment-asks.test.mjs
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as understanding from "../supabase/functions/_shared/intakeUnderstanding.mjs";
import { attachmentText, corpusIndex } from "../supabase/functions/_shared/intakeFacts.mjs";
import { loadFunction, resetWorld, deliver, harness } from "../scripts/email-inbound-harness.mjs";
import { composeForward } from "../scripts/intake-eval.mjs";

// A namespace import, so each test (not the whole file) shows what the code
// before the fix lacked.
const { verifyUnderstanding, rulesUnderstanding, ackWarranted, attachmentAsks, DROP } = understanding;

const DEA_ASK = "Please send an updated copy of your current DEA registration by 12/15/2026 to complete the reappointment file.";

// What the scanner returns for a request letter once it is asked to copy the
// letter's asking words into notes (email-inbound SCAN_REQUEST_WORDS).
const LETTER_SCAN = {
  documentType: "other",
  confidence: "medium",
  extracted: {
    name: "Reappointment request letter",
    issuer: "Osterly Example Health",
    facts: [
      { label: "Letter date", value: "October 30, 2026" },
      { label: "Policy Number", value: "PL-4471902" },
    ],
    suggestedCategory: { name: "Letters" },
  },
  notes: `${DEA_ASK}\nThe following items are still outstanding:\n- Current CPR/BLS certification card\n- Copy of your state controlled-substance registration`,
};

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

// ── attachmentText ───────────────────────────────────────────────────────────

test("attachmentText: a scan's notes (line by line) and an other document's facts are read, identifying labels and numbers still left out", () => {
  const t = attachmentText(LETTER_SCAN);
  assert.ok(t.includes(DEA_ASK), "the letter's asking sentence, from the scan's notes");
  assert.ok(t.split("\n").includes("- Current CPR/BLS certification card"), "a listed item keeps its own line");
  assert.ok(t.includes("Letter date: October 30, 2026"), "a fact as label: value");
  assert.ok(!t.includes("PL-4471902") && !/Policy Number/.test(t), "a fact with a number-like label is still left out");

  // One line of the notes that names a date of birth goes; the rest stays.
  const mixed = attachmentText({ documentType: "unknown", extracted: {}, notes: "Please send your current DEA registration.\nDOB 03/14/1961" });
  assert.equal(mixed, "notes: Please send your current DEA registration.");
  // The extracted notes and the scan's notes saying the same thing are shown once.
  assert.equal(attachmentText({ documentType: "insurance", extracted: { notes: "Claims made." }, notes: "Claims made." }), "notes: Claims made.");
});

// ── verifyUnderstanding ──────────────────────────────────────────────────────

test("an ask quoted from the attachment's words is kept, marked as the attachment's, at medium confidence at most, and never acknowledged", () => {
  const words = [attachmentText(LETTER_SCAN)];
  const parts = { note: "", message: "See attached.", history: "" };
  const v = verifyUnderstanding(reading([DEA_ASK]), { subject: "Reappointment file", parts, attachmentCount: 1, facts: factsFor(parts, "Reappointment file", words) });
  assert.equal(v.asks.length, 1, "the ask in the letter survives");
  assert.equal(v.asks[0].from, "attachment");
  assert.equal(v.dropped.length, 0);
  assert.equal(v.unclear, false);
  assert.equal(v.needsRules, false, "the model's reading stands; the rules are not called in");
  assert.equal(v.confidence, "medium", "capped: the words rest on the scanner's reading of the file");
  assert.equal(ackWarranted(v).ok, false, "the sender is not told they asked on the attachment's words alone");

  // Words found in no attachment are still not the email's own words.
  const invented = verifyUnderstanding(reading(["Please send your passport photo page."]), { subject: "Reappointment file", parts, attachmentCount: 1, facts: factsFor(parts, "Reappointment file", words) });
  assert.equal(invented.asks.length, 0);
  assert.deepEqual(invented.dropped.map((d) => d.why), [DROP.notOwnWords]);
  assert.equal(invented.needsRules, true);
});

test("a listed item with no asking words counts only under an asking line of its attachment, or as a checklist the message points to", () => {
  const words = [attachmentText(LETTER_SCAN)];
  const item = "Current CPR/BLS certification card";
  const subject = "Reappointment file";
  // The message's own ask and the item named only in the attached checklist.
  const pointing = { note: "", message: "Please send the items listed in the attached checklist for my reappointment file.", history: "" };
  const v = verifyUnderstanding(reading(["Please send the items listed in the attached checklist for my reappointment file.", item]), { subject, parts: pointing, attachmentCount: 1, facts: factsFor(pointing, subject, words) });
  assert.equal(v.asks.length, 2);
  assert.deepEqual(v.asks.map((a) => a.from), ["message", "attachment"]);

  // A bare list (no line of the file asks): only as a checklist the message points to.
  const bare = [attachmentText({ documentType: "other", extracted: {}, notes: "Reappointment items\n- Current CPR/BLS certification card\n- Updated CV" })];
  const silent = { note: "", message: "Thank you for your time this week.", history: "" };
  const see = { note: "", message: "See attached.", history: "" };
  const at = (parts, role) => verifyUnderstanding(reading([item], role), { subject, parts, attachmentCount: 1, facts: factsFor(parts, subject, bare) });
  assert.deepEqual(at(see, "request_checklist").asks.map((a) => a.quote), [item], "a checklist the message points to");
  for (const [parts, role, why] of [[silent, "request_checklist", "a checklist the message never mentions"], [see, "informational", "a file the reading took for something to read"], [see, "credential_for_physician", "a credential"]]) {
    const r = at(parts, role);
    assert.equal(r.asks.length, 0, why);
    assert.deepEqual(r.dropped, [{ quote: item, why: DROP.notOwnWords }], `${why}: not the email's own asking words, so the rules read it`);
    assert.equal(r.needsRules, true, why);
  }
});

test("a delivered card and an informational certificate stay what they were: nothing in an attachment makes them a request", () => {
  // The reviewers' regression against the commit before: a renewed BLS card
  // forwarded for the file, read (wrongly) as a request quoting the issuer.
  const card = [attachmentText({ documentType: "license", extracted: { issuer: "Example Heart Association", name: "BLS Provider" } })];
  const delivered = { note: "", message: "Attached is your renewed BLS card for your records.", history: "" };
  const v = verifyUnderstanding({ ...reading(["Example Heart Association"], "credential_for_physician"), asks: [{ quote: "Example Heart Association", kind: "bls", who: "physician" }] },
    { subject: "BLS card", parts: delivered, attachmentCount: 1, facts: factsFor(delivered, "BLS card", card) });
  assert.equal(v.asks.length, 0);
  assert.equal(v.needsRules, true, "the rules read it, as before");
  const rules = rulesUnderstanding({ subject: "BLS card", body: delivered.message, attachmentNames: ["BLS card.pdf"], attachmentCount: 1, forwarded: true, attachmentWords: card, attachmentTypes: ["license"] });
  assert.equal(rules.intent, "delivery");

  // A certificate of insurance whose own small print asks for a copy, under
  // a reading that calls the email informational: entered, not answered.
  const coi = [attachmentText({ documentType: "insurance", extracted: { provider: "Example Mutual" }, notes: "Please provide a copy of this certificate to the credentialing office." })];
  const info = { note: "", message: "Here is my updated COI for my file.", history: "" };
  const quote = "Please provide a copy of this certificate to the credentialing office";
  const r = verifyUnderstanding({ ...reading([quote], "credential_for_physician"), intent: "informational" }, { subject: "COI", parts: info, attachmentCount: 1, facts: factsFor(info, "COI", coi) });
  assert.equal(r.intent, "informational");
  assert.equal(r.asks.length, 0);
  assert.equal(r.unclear, false);

  // The same certificate when the model call fails: the rules keep it a delivery.
  const email = { subject: "COI", body: "For my file.", attachmentNames: ["coi.pdf"], attachmentCount: 1 };
  const fallback = rulesUnderstanding({ ...email, attachmentWords: coi, attachmentTypes: ["insurance"] });
  assert.equal(fallback.rulesIntent, "delivery");
  assert.equal(fallback.intent, "delivery");
  // Only a letter's or a checklist's words are read for asks, and a
  // delivery turns mixed only when the message points to what is attached.
  const words = ["notes: Please send your current DEA registration."];
  assert.equal(rulesUnderstanding({ ...email, attachmentWords: words, attachmentTypes: ["license"] }).intent, "delivery");
  assert.equal(rulesUnderstanding({ ...email, attachmentWords: words, attachmentTypes: ["other"] }).intent, "delivery", "a message that does not point to the file");
  const pointed = { ...email, body: "Please see the attached letter regarding your reappointment.", attachmentNames: ["Reappointment letter.pdf"] };
  assert.equal(rulesUnderstanding(pointed).intent, "delivery");
  assert.equal(rulesUnderstanding({ ...pointed, attachmentWords: words, attachmentTypes: ["other"] }).intent, "mixed");
  assert.equal(fallback.asks.filter((a) => a.from === "attachment").length, 0);
});

test("identifying numbers, names and addresses in a scan's notes and facts never reach the model or a stored ask", () => {
  const t = attachmentText({
    documentType: "other",
    extracted: { facts: [{ label: "Registration", value: "QX1234563" }, { label: "License", value: "MD 12345" }, { label: "Requested by", value: "Medical Staff Office" }] },
    notes: [
      "Please send your DEA registration QX1234563.",
      "NPI 1234567893",
      "Patient: Pat Q Sample",
      "Date of Birth: March 14, 1961",
      "Contact: casey.example@osterly-health.example",
      "Please send a copy of your current BLS card.",
    ].join("\n"),
  });
  assert.equal(t, "notes: Please send a copy of your current BLS card.\nRequested by: Medical Staff Office");

  // An ask quoted with a number in it is dropped, by the model's check and the rules'.
  const words = ["notes:\nPlease send your DEA registration QX1234563 (exp 2027-03-31).\nPlease send a copy of your current BLS card."];
  const parts = { note: "", message: "See attached.", history: "" };
  const v = verifyUnderstanding(reading(["Please send your DEA registration QX1234563 (exp 2027-03-31).", "Please send a copy of your current BLS card."]), { subject: "Reappointment file", parts, attachmentCount: 1, facts: factsFor(parts, "Reappointment file", words) });
  assert.deepEqual(v.asks.map((a) => a.quote), ["Please send a copy of your current BLS card."]);
  assert.deepEqual(v.dropped.map((d) => d.why), [DROP.identifier]);
  const fromFile = attachmentAsks(words);
  assert.ok(fromFile.length >= 1 && fromFile.every((a) => !/QX1234563/.test(a)), JSON.stringify(fromFile));
});

test("attachmentText checks whole lines before it cuts: a cut never leaves part of a number behind", () => {
  const pad = `${"x ".repeat(993)}`.trim();
  const t = attachmentText({ documentType: "other", extracted: {}, notes: `${pad}\nSSN 123-45-6789\nPlease send a copy of your current BLS card.` });
  assert.ok(!/123-45/.test(t), "no part of the SSN");
  const long = attachmentText({ documentType: "other", extracted: {}, notes: `${"y ".repeat(999).trim()}\nSSN 123-45-6789` });
  assert.ok(!/\b123\b/.test(long));
  // A line that does not fit is left out whole, never cut.
  const many = attachmentText({ documentType: "other", extracted: {}, notes: Array.from({ length: 80 }, (_, i) => `Please send item number ${"z".repeat(30)} ${i}.`).join("\n") });
  assert.ok(many.split("\n").every((l) => l === "notes:" || /^Please send item number z+ \d+\.$/.test(l)), "every kept line whole");
});

test("the model is told an ask written in an attachment may be quoted from its words", () => {
  const r = understanding.buildUnderstandingRequest({ message: "See attached." });
  assert.match(r.system[0].text, /written inside an attachment/);
  assert.match(r.system[0].text, /quote the ask from that attachment's words/);
});

// ── The rules ────────────────────────────────────────────────────────────────

test("the rules read the attachments' words apart: an asking sentence or a listed item under an asking line counts, a statement does not", () => {
  const r = rulesUnderstanding({ subject: "Reappointment file", body: "See attached.", attachmentNames: ["letter.pdf"], attachmentCount: 1, forwarded: true, attachmentWords: ["notes: Please send your current DEA registration."] });
  const fromFile = r.asks.filter((a) => a.from === "attachment");
  assert.equal(fromFile.length, 1);
  assert.match(fromFile[0].quote, /DEA registration/);
  assert.equal(r.unclear, false);

  const stated = rulesUnderstanding({ subject: "Reappointment file", body: "See attached.", attachmentNames: ["letter.pdf"], attachmentCount: 1, forwarded: true, attachmentWords: ["notes: Your DEA registration was verified on 10/01/2026."] });
  assert.equal(stated.asks.filter((a) => a.from === "attachment").length, 0, "a statement in the letter is no ask");

  const listed = attachmentAsks(["notes:\nPlease provide the following:\n- Current BLS card\n- Updated CV"]);
  assert.ok(listed.some((a) => /BLS card/.test(a)) && listed.some((a) => /CV/.test(a)), `listed: ${JSON.stringify(listed)}`);
  // A lead-in is not an ask of its own, and the email's bare pointer gives way to the letter's asks.
  const lines = rulesUnderstanding({ subject: "Fwd: request", body: "See attached.", attachmentNames: ["letter.pdf"], attachmentCount: 1, attachmentWords: ["notes:\nPlease provide the following:\nCurrent DEA certificate\nCurrent BLS card"] });
  assert.deepEqual(lines.asks.map((a) => [a.quote, a.from]), [["DEA certificate", "attachment"], ["BLS card", "attachment"]]);
  assert.deepEqual(attachmentAsks(["notes:\n- Current BLS card\n- Updated CV"]), [], "a bare list under nothing that asks");
});

test("the rules never acknowledge on the attachment's asks alone, and a delivery with an ask in its attachment is mixed", () => {
  const r = rulesUnderstanding({ subject: "Reappointment", body: "Please see the attached letter regarding your reappointment.", attachmentNames: ["Reappointment letter.pdf"], attachmentCount: 1, forwarded: true, attachmentWords: ["notes: Please send your current DEA registration."], attachmentTypes: ["other"] });
  assert.equal(r.intent, "mixed", "the rules took it for a delivery; the message points to the letter, and the letter asks");
  assert.deepEqual(r.asks.filter((a) => a.from === "attachment").map((a) => a.quote), ["DEA registration"]);
  // The email's own ask names no document; the attachment's does, and does not count.
  const own = { method: "rules", askForm: true, asks: [{ quote: "See attached", kind: null }, { quote: "DEA registration", kind: null, from: "attachment" }] };
  assert.equal(ackWarranted(own).why, "no ask names a document", "only the email's own asks name a document for the acknowledgement");
  assert.equal(ackWarranted({ ...own, asks: [{ quote: "DEA registration", kind: null }] }).ok, true, "the same ask in the email itself does");
  assert.equal(ackWarranted({ method: "rules", asks: [{ quote: "your current DEA registration", from: "attachment" }], askForm: true }).why, "the asks were read only in an attachment");
});

// ── The second review ────────────────────────────────────────────────────────

test("a patient named, or a birth date in words, never reaches the model or a stored ask", () => {
  for (const line of [
    "Operative note for patient Pat Sample",
    "Patient Name - Pat Sample",
    "Discharge summary for Lee Roe, born March 14, 1961",
    "Born March 14, 1961",
    "Case: Sample, Pat 03/14/1961",
    "Name: Pat Q Sample",
  ]) {
    const t = attachmentText({ documentType: "other", extracted: {}, notes: `Please provide the following:\n${line}` });
    assert.ok(!t.includes(line.slice(-10)), `${line}: ${JSON.stringify(t)}`);
  }
  assert.equal(attachmentText({ documentType: "other", extracted: { facts: [{ label: "Name", value: "Pat Sample" }] } }), "");
  // The committee and an ordinary due date are not people or birth dates.
  const kept = attachmentText({ documentType: "other", extracted: {}, notes: "Please send the Patient Safety Committee attestation.\nPlease return it by December 1, 2026." });
  assert.equal(kept, "notes:\nPlease send the Patient Safety Committee attestation.\nPlease return it by December 1, 2026.");

  // A quote naming a patient is dropped by the model's check and the rules'.
  const words = ["notes:\nPlease provide the following:\nOperative note for patient Pat Sample\nCurrent BLS card"];
  const parts = { note: "", message: "See attached.", history: "" };
  const v = verifyUnderstanding(reading(["Operative note for patient Pat Sample"]), { subject: "FPPE", parts, attachmentCount: 1, facts: factsFor(parts, "FPPE", words) });
  assert.deepEqual(v.asks, []);
  assert.deepEqual(v.dropped.map((d) => d.why), [DROP.identifier]);
  assert.ok(!attachmentAsks(words).some((a) => /Sample/.test(a)));
});

test("a hospital ID badge delivered for the file stays a delivery when the rules read it", () => {
  const badge = (notes) => [attachmentText({ documentType: "other", extracted: { name: "Hospital ID Badge", issuer: "Osterly Example Health" }, notes })];
  for (const notes of ["Please present this badge at the security desk upon arrival.", "Please return this badge when your assignment ends.", "Please notify us of any change of address."]) {
    for (const body of ["For my file.", "Attached is my new hospital ID badge."]) {
      const r = rulesUnderstanding({ subject: "badge", body, attachmentNames: ["badge.pdf"], attachmentCount: 1, attachmentWords: badge(notes), attachmentTypes: ["other"] });
      assert.equal(r.intent, rulesUnderstanding({ subject: "badge", body, attachmentNames: ["badge.pdf"], attachmentCount: 1 }).intent, `${notes} / ${body}`);
      assert.equal(r.asks.filter((a) => a.from === "attachment").length, 0, `${notes} / ${body}`);
    }
  }
  // The scanner's own fields are never read for asks.
  assert.deepEqual(attachmentAsks(["name: Hospital ID Badge\nissuer: Osterly Example Health"]), []);
});

test("a checklist's own items and a coverage letter's limits are kept: a label alone drops nothing", () => {
  const notes = "Please provide the following documents:\nDEA Registration: current copy\nState License: current copy\nBoard Certificate: current copy\nBLS Card: current copy\nCV: updated";
  const w = attachmentText({ documentType: "other", extracted: {}, notes });
  assert.equal(w, `notes:\n${notes}`);
  const r = rulesUnderstanding({ subject: "Fwd: reappointment", body: "See attached.", attachmentNames: ["letter.pdf"], attachmentCount: 1, attachmentWords: [w], attachmentTypes: ["other"] });
  const fromFile = r.asks.filter((a) => a.from === "attachment").map((a) => a.quote);
  for (const k of [/DEA Registration/, /State License/, /Board Certificate/, /BLS Card/, /CV/]) assert.ok(fromFile.some((q) => k.test(q)), `${k}: ${JSON.stringify(fromFile)}`);

  const facts = attachmentText({ documentType: "other", extracted: { facts: [{ label: "DEA Registration", value: "Copy required" }, { label: "Medical License", value: "Copy required" }, { label: "Professional Liability Policy Limits", value: "$1,000,000 / $3,000,000" }, { label: "Policy Number", value: "PL-4471902" }, { label: "Email", value: "office at example" }] } });
  assert.equal(facts, "DEA Registration: Copy required\nMedical License: Copy required\nProfessional Liability Policy Limits: $1,000,000 / $3,000,000");
  const limits = attachmentText({ documentType: "other", extracted: {}, notes: "Policy limits: $1,000,000 per claim / $3,000,000 aggregate" });
  assert.equal(limits, "notes: Policy limits: $1,000,000 per claim / $3,000,000 aggregate");
});

test("long notes keep what fits: an oversize paragraph is read by sentence, and nothing after it is lost", () => {
  const filler = "The committee reviews every file before the reappointment meeting and needs complete records. ".repeat(25);
  const one = attachmentText({ documentType: "other", extracted: {}, notes: `Please send your current DEA certificate and BLS card by December 1. ${filler}` });
  assert.ok(one.includes("Please send your current DEA certificate and BLS card by December 1."), one.slice(0, 120));
  const after = attachmentText({ documentType: "other", extracted: {}, notes: `Please send your current BLS card.\n${"y ".repeat(1100)}\nPlease send your current DEA certificate.` });
  assert.ok(after.includes("Please send your current DEA certificate."), after.slice(0, 200));
});

test("the scanner's own fields are held to the same identifier check as the notes", () => {
  const t = attachmentText({ documentType: "other", extracted: { name: "DEA Registration QX1234563", issuer: "Example Clinic NPI 1234567893", description: "Please send DEA QX1234563", type: "License MD 48213", facility: "Example Hospital, patient Pat Sample", title: "Reappointment checklist", coveragePerClaim: "1000000" } });
  assert.equal(t, "title: Reappointment checklist\ncoveragePerClaim: 1000000");
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
const send = () => {
  harness.geminiReply = () => LETTER_SCAN;
  return deliver({
    id: `att${++n}`, from: `Rowan Testa <${ME}>`, to: "docs@credentialdomd.com", subject: `Fwd: ${CASE.subject}`, text: composeForward(CASE),
    attachments: [{ filename: "Reappointment_Request.pdf", contentType: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.4 letter") }],
  });
};

before(async () => { await loadFunction(); });
beforeEach(() => { resetWorld(); harness.rawAuth = "mx.resend.com; dmarc=pass header.from=clinic.example"; seed(); });

test("end to end: the scanner is asked for a request letter's words, and the model's ask quoted from them is kept, not one tap, no acknowledgement", async () => {
  harness.anthropicReply = () => reading([DEA_ASK]);
  const r = await send();
  assert.equal(r.status, 200);
  assert.equal(r.body.read, "model");
  assert.equal(r.body.intent, "request");
  assert.equal(r.body.one_tap, false);
  assert.match(r.body.ack, /^ack skipped: the asks were read only in an attachment/);
  const instruction = harness.gemini[0].body.contents[0].parts.at(-1).text;
  assert.match(instruction, /letter, memo, checklist or form that asks the physician for documents/);
  assert.match(instruction, /word for word/);
  assert.ok(harness.anthropic[0].body.messages[0].content.includes(DEA_ASK), "the letter's words reach the model");
  const [req] = rows("document_requests");
  assert.ok(req.proposal.items.some((i) => /DEA registration/.test(i.ask)), "the ask is in the packet proposal");
  assert.equal(harness.sent.filter((m) => m.to?.[0] !== ME).length, 0, "nothing goes to the hospital");
  assert.match(rows("inbound_emails")[0].detail, /read by model \(medium\)/);
});

test("end to end: a 400 from the AI service says why in the ledger, and nothing is sent to the requester", async () => {
  harness.anthropicReply = () => ({ status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "Synthetic   failure:\n the request was refused." } } });
  const r = await send();
  assert.equal(r.status, 200);
  assert.equal(r.body.read, "rules");
  const [row] = rows("inbound_emails");
  assert.match(row.detail, /read by rules \(the AI service answered 400 \(invalid_request_error: Synthetic failure: the request was refused\.\)\)/);
  assert.ok(!row.detail.includes("sk-ant-test"), "never the key");
  assert.ok(!/ack sent/i.test(row.detail));
  assert.equal(harness.sent.filter((m) => m.to?.[0] !== ME).length, 0, "nothing goes to the hospital");
  // The letter's asks, read by the rules, are what the request holds.
  const [req] = rows("document_requests");
  const asks = req.proposal.items.map((i) => i.ask);
  assert.ok(asks.some((a) => /DEA registration/.test(a)), JSON.stringify(asks));
  assert.ok(asks.some((a) => /BLS certification card/.test(a)), JSON.stringify(asks));
  assert.ok(!asks.some((a) => /^see attached$/i.test(a)), "the bare pointer is not an ask");
  assert.equal(req.proposal.source, "rules", "still read by keywords");
  assert.equal(r.body.one_tap, false);
});
