// supabase/functions/_shared/intakeUnderstanding.mjs, the filing rules it
// feeds (intakeFiling.mjs roleTarget, master agreements) and the evaluation
// harness (scripts/intake-eval.mjs), on plain objects. The end-to-end run
// through the edge function is scripts/email-inbound-understanding.test.mjs.
// Every email here is synthetic.
// Run: node --test scripts/intake-understanding.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildUnderstandingRequest, readModelReply, verifyUnderstanding, rulesUnderstanding, normalizeForQuote, quoteOccurs,
  finalIntent, informationalReplyText, correctionExamples, splitForward, scanForModel, plainModelText, asksElsewhereLine,
  UNDERSTANDING_SCHEMA, UNDERSTANDING_MODEL, INTENTS, ROLES, MAX_CORRECTIONS,
} from "../supabase/functions/_shared/intakeUnderstanding.mjs";
import { KINDS } from "../supabase/functions/_shared/requestPacket.ts";
import { planFiling, roleTarget, masterAgreement } from "../supabase/functions/_shared/intakeFiling.mjs";
import {
  loadCases, runEval, readerFor, formatReport, corpusAllowed, scoreCase, composeForward, requestFor, SYNTHETIC_DIR, DEFAULT_CORPUS,
} from "./intake-eval.mjs";

const EM_DASH = String.fromCodePoint(0x2014);
const reply = (value, stop = "end_turn") => ({ stop_reason: stop, content: [{ type: "text", text: JSON.stringify(value) }] });
const good = { intent: "request", asks: [{ quote: "your BLS card", kind: "bls", who: "physician" }], attachments: [], summary: "a request for your BLS card", confidence: "high" };

// ── The request ─────────────────────────────────────────────────────────────

test("the request: Vera's model, adaptive thinking at low effort, a strict schema, the system prompt cached, no tools", () => {
  const r = buildUnderstandingRequest({
    subject: "Documents", sender: { name: "Casey Example", address: "casey@osterly.example" },
    note: "fyi", message: "Please send your BLS card.", history: "> earlier",
    attachments: [{ name: "form.pdf", scan: { documentType: "license", confidence: "high", extracted: { type: "DEA Registration", licenseNumber: "FW1234567", state: "ND", expirationDate: "2027-01-31", facts: [{ label: "x", value: "y" }] } } }],
    corrections: ["Dismissed an email that was read as a request."],
  });
  assert.equal(r.model, UNDERSTANDING_MODEL);
  assert.equal(UNDERSTANDING_MODEL, "claude-opus-5");
  assert.deepEqual(r.thinking, { type: "adaptive" });
  assert.equal(r.output_config.effort, "low");
  assert.deepEqual(r.output_config.format, { type: "json_schema", schema: UNDERSTANDING_SCHEMA });
  assert.deepEqual(r.system[0].cache_control, { type: "ephemeral" });
  assert.ok(!("tools" in r) && !("betas" in r) && !("stream" in r));
  const text = r.messages[0].content;
  assert.match(text, /^<corrections>\n- Dismissed an email that was read as a request\.\n<\/corrections>/);
  assert.match(text, /Sender: Casey Example \(osterly\.example\)/);
  assert.ok(!text.includes("casey@"), "only the sender's domain");
  assert.match(text, /1\. form\.pdf: scanned as license, high confidence \(type: DEA Registration; state: ND; expirationDate: 2027-01-31\)/);
  assert.ok(!text.includes("FW1234567"), "numbers on a credential are never sent");
  assert.ok(!r.system[0].text.includes(EM_DASH) && !text.includes(EM_DASH));
});

test("the schema: every enum is the app's own list, and every object is closed", () => {
  const s = UNDERSTANDING_SCHEMA;
  assert.deepEqual(s.properties.intent.enum, [...INTENTS]);
  assert.deepEqual(s.properties.asks.items.properties.kind.enum, [...KINDS]);
  assert.deepEqual(s.properties.attachments.items.properties.role.enum, [...ROLES]);
  for (const o of [s, s.properties.asks.items, s.properties.attachments.items]) {
    assert.equal(o.additionalProperties, false);
    assert.deepEqual([...o.required].sort(), Object.keys(o.properties).sort());
  }
});

test("a patient record is named as one and nothing it says is sent; a long message is cut and says so", () => {
  assert.equal(scanForModel({ patientRecord: true }), "reads like a patient record (not kept, not described)");
  assert.equal(scanForModel(null), "not read by the scanner");
  const r = buildUnderstandingRequest({ message: "x".repeat(20_000) });
  assert.match(r.messages[0].content, /\[cut here: the rest of this part is not shown\]/);
  assert.ok(r.messages[0].content.length < 30_000);
});

test("splitForward: the physician's note, the sender's message, and the history under it", () => {
  const raw = "Can you handle this?\n\n---------- Forwarded message ---------\nFrom: A <a@b.example>\nSubject: x\n\nPlease send your DEA.\n\nOn Mon, Sep 1, 2026, Rowan wrote:\n> old";
  const body = "Please send your DEA.\n\nOn Mon, Sep 1, 2026, Rowan wrote:\n> old";
  const p = splitForward(raw, body);
  assert.equal(p.note, "Can you handle this?");
  assert.equal(p.message.trim(), "Please send your DEA.");
  assert.match(p.history, /^On Mon, Sep 1, 2026, Rowan wrote:/);
  const bare = splitForward("Please send your DEA.\n> quoted", null);
  assert.equal(bare.note, "");
  assert.equal(bare.history, "> quoted");
});

// ── The reply ───────────────────────────────────────────────────────────────

test("readModelReply takes only a finished reply that matches the schema exactly", () => {
  assert.deepEqual(readModelReply(reply(good)), { ok: true, value: good });
  assert.equal(readModelReply(reply(good, "refusal")).ok, false);
  assert.equal(readModelReply(reply(good, "max_tokens")).why, "the reply was cut off");
  assert.equal(readModelReply({ stop_reason: "end_turn", content: [{ type: "text", text: "not json" }] }).why, "the reply is not JSON");
  assert.equal(readModelReply({ stop_reason: "end_turn", content: [] }).why, "no text in the reply");
  assert.equal(readModelReply(null).ok, false);
  for (const bad of [
    { ...good, extra: 1 },
    { ...good, intent: "both" },
    { ...good, confidence: "certain" },
    { ...good, asks: [{ quote: "x", kind: "bls", who: "physician", why: "y" }] },
    { ...good, asks: [{ quote: "x", kind: "bls", who: "the doctor" }] },
    { ...good, attachments: [{ index: "1", role: "informational", filing: "" }] },
    { ...good, attachments: [{ index: 1, role: "blank_form", filing: "" }] },
    { ...good, summary: 7 },
  ]) assert.equal(readModelReply(reply(bad)).ok, false, JSON.stringify(bad));
  // Thinking blocks come before the text and are ignored.
  assert.equal(readModelReply({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(good) }] }).ok, true);
});

// ── The host's check ─────────────────────────────────────────────────────────

test("a quote is the email's own words: spacing, quote marks, dashes, chevrons and case do not matter; anything else does", () => {
  const email = normalizeForQuote("Hi,\n\nPlease send your current\n> board certificate \u2013 and the \u201cBLS card\u201d.\n\nThanks");
  for (const q of ["Please send your current board certificate", "board certificate - and the \"BLS card\"", "  the BLS card.  ", "PLEASE SEND"]) assert.ok(quoteOccurs(q, email), q);
  for (const q of ["Please send your DEA", "board certificate and the BLS card", "Please send ... BLS card", "ok", "..", ""]) assert.ok(!quoteOccurs(q, email), q);
});

test("verifyUnderstanding keeps only quoted asks of the physician, and the asks decide the intent", () => {
  const emailText = "Subject\nPlease send your BLS card. We will send you the schedule.";
  const v = verifyUnderstanding({
    intent: "request",
    asks: [
      { quote: "your BLS card", kind: "bls", who: "physician" },
      { quote: "your bls card", kind: "bls", who: "physician" },
      { quote: "the schedule", kind: "unknown", who: "sender" },
      { quote: "your DEA", kind: "dea", who: "physician" },
      { quote: "Please send", kind: "not-a-kind", who: "physician" },
    ],
    attachments: [{ index: 1, role: "form_to_complete", filing: "Keep with the request \u2014 see https://x.example" }, { index: 1, role: "informational", filing: "dup" }, { index: 3, role: "informational", filing: "out of range" }, { index: 0, role: "informational", filing: "zero" }],
    summary: "a request \u2014 for your BLS card.", confidence: "high",
  }, { emailText, attachmentCount: 2 });
  assert.equal(v.method, "model");
  assert.equal(v.intent, "request");
  assert.deepEqual(v.asks, [{ quote: "your BLS card", kind: "bls" }, { quote: "Please send", kind: "unknown" }]);
  assert.deepEqual(v.dropped.map((d) => d.why), ["not asked of the physician", "not the email's own words"]);
  assert.deepEqual(v.attachments, [{ index: 0, role: "form_to_complete", filing: "Keep with the request, see" }]);
  assert.equal(v.summary, "a request, for your BLS card");
  assert.equal(v.confidence, "medium", "a reading the host had to correct is not a confident one");
});

test("finalIntent: an email with no verified ask is never a request", () => {
  assert.deepEqual(INTENTS.map((i) => [finalIntent(i, true), finalIntent(i, false)]), [
    ["request", "informational"], ["mixed", "delivery"], ["request", "informational"], ["mixed", "delivery"],
  ]);
});

test("plainModelText: one line, no em dash, no link or address a crafted email could plant", () => {
  assert.equal(plainModelText(`x ${EM_DASH} y\nz www.evil.example a@b.example http://c.example/d`), "x, y z");
  assert.equal(plainModelText("a".repeat(500)).length, 200);
});

// ── The fallback ─────────────────────────────────────────────────────────────

test("rulesUnderstanding: a letter of statements is not a request, even when the old rules said so", () => {
  const body = "Dr. Testa,\n\nThe credentialing committee reviewed the required documents for your file last week. Your malpractice coverage is provided through the group policy.\n\nRegards,\nJordan";
  const r = rulesUnderstanding({ subject: "Your credentialing file", body, attachmentCount: 0, forwarded: true, why: "test" });
  assert.equal(r.rulesIntent, "request", "the keyword rules still say request (\"required documents\")");
  assert.equal(r.intent, "informational");
  assert.deepEqual(r.asks, []);
  assert.equal(r.method, "rules");
  assert.equal(r.why, "test");
  assert.equal(r.summary, "\"Your credentialing file\"");
});

test("rulesUnderstanding: a real ask the rules cannot name still keeps it a request; a delivery stays a delivery", () => {
  const mixed = rulesUnderstanding({ subject: "Welcome", body: "Welcome aboard! Attached is your initial appointment packet. Please complete and return both documents by 10/15.", attachmentNames: ["a.pdf", "b.pdf"], forwarded: true });
  assert.equal(mixed.intent, "mixed");
  const req = rulesUnderstanding({ subject: "DEA", body: "Can you please send me a copy of your DEA?", attachmentCount: 0, forwarded: true });
  assert.equal(req.intent, "request");
  assert.deepEqual(req.asks.map((a) => a.quote), ["DEA"]);
  const del = rulesUnderstanding({ subject: "Approval", body: "Attached is your approval letter for your records.", attachmentNames: ["Approval_Letter.pdf"], forwarded: true });
  assert.equal(del.intent, "delivery");
});

// ── What the physician reads ─────────────────────────────────────────────────

test("informationalReplyText: what it was about, that nothing was asked, and each attachment", () => {
  const t = informationalReplyText({
    senderName: "Jordan Sample", summary: "how the policy covers emergency care.", appUrl: "https://app.example/",
    results: [{ lines: ["Attached to your X contract: a.pdf"] }], notes: ["A note."],
  });
  assert.equal(t, "Read Jordan Sample's note about how the policy covers emergency care. Nothing was asked of you.\n\nThe attachment:\nAttached to your X contract: a.pdf\n\nA note.\n\nOpen the app: https://app.example/ (Documents)\n\nCredentialDOMD\nhttps://credentialdomd.com");
  assert.equal(informationalReplyText({ summary: "", appUrl: "u" }), "Read the forwarded note about an email. Nothing was asked of you.\n\nCredentialDOMD\nhttps://credentialdomd.com");
});

test("asksElsewhereLine names at most three asks", () => {
  assert.equal(asksElsewhereLine([], "docs@x"), "");
  assert.equal(asksElsewhereLine([{ quote: "a" }, { quote: "b" }, { quote: "c" }, { quote: "d" }], "docs@x"),
    "This email also asks you for something (\"a\", \"b\", \"c\", and more). Forward it to docs@x to answer it from the app.");
});

// ── Corrections ─────────────────────────────────────────────────────────────

test("correctionExamples: one plain line per correction, nothing that identifies a person, at most ten", () => {
  const lines = correctionExamples([
    { action: "dismiss_request", before: { intent: "request", asks: ["Dr. Jane Roe's malpractice certificate", "call 555-123-4567", "a@b.example"] }, after: { status: "dismissed" } },
    { action: "edit_cover_note", before: {}, after: { removedAsks: ["Colorado DEA"], addedAsks: [] } },
    { action: "edit_cover_note", before: {}, after: { cleared: true } },
    { action: "edit_cover_note", before: {}, after: {} },
    { action: "move_document", before: { section: "inbox", scanType: "agreement" }, after: { section: "locumContracts" } },
    { action: "relink_document", before: { section: "licenses" }, after: { section: "licenses" } },
    { action: "keep_as_document", before: { scanType: "other", suggested: "Attestations" }, after: {} },
    { action: "something_new", before: {}, after: {} },
    null,
  ]);
  assert.deepEqual(lines, [
    "Dismissed an email that was read as a request for the person malpractice certificate, call # (read as request): it asked for nothing they would answer.",
    "Edited the drafted reply before sending: took out Colorado DEA.",
    "Cleared the drafted reply before sending: the draft said the wrong things.",
    "Moved a forwarded agreement from inbox to locumContracts.",
    "Kept a forwarded other as a plain document rather than filing it as Attestations.",
  ]);
  assert.ok(!lines.join("\n").match(/Jane|Roe|555|@/));
  const many = correctionExamples(Array.from({ length: 30 }, () => ({ action: "keep_as_document", before: { scanType: "cme" } })));
  assert.equal(many.length, MAX_CORRECTIONS);
});

// ── Filing: roles and master agreements ─────────────────────────────────────

const NOW = "2026-09-28T16:00:00.000Z";
const plan = (scan, over = {}) => { let i = 0; return planFiling({ scan, docId: "doc-1", fileName: "MSA.pdf", mimeType: "application/pdf", userId: "u1", rows: [], categories: [], now: NOW, newId: () => `id-${++i}`, ...over }); };
const agreement = (extracted) => ({ documentType: "agreement", confidence: "high", extracted });
const CONTRACTS = [
  { id: "c-old", agency: "Quillfeather Staffing, Inc.", facility: "Osterly", start_date: "2026-03-01", end_date: "2026-05-31" },
  { id: "c-now", agency: "Quillfeather Staffing", facility: "Fernwick", start_date: "2026-09-01", end_date: "2026-12-31" },
  { id: "c-next", agency: "Quillfeather Staffing", facility: "Brackwater", start_date: "2027-01-01", end_date: "2027-02-28" },
  { id: "c-other", agency: "Ridgeway Example Locums", facility: "Hollin", start_date: "2026-09-01", end_date: "2026-12-31" },
];

test("a master agreement is attached to the agency's contract in force, and never made into a contract", () => {
  const p = plan(agreement({ agency: "Quillfeather Staffing" }), { rows: CONTRACTS });
  assert.equal(p.outcome, "linked");
  assert.equal(p.recordId, "c-now");
  assert.deepEqual(p.writes, [], "no write to any contract");
  assert.deepEqual(p.document, { linked_to: "locumContracts:c-now", name: "Quillfeather Staffing - master agreement.pdf", type: "application/pdf" });
  assert.equal(p.lines[0], "Attached to your Quillfeather Staffing contract (Fernwick, 09/01/2026 to 12/31/2026): MSA.pdf, the master agreement with Quillfeather Staffing. It covers your 2 other Quillfeather Staffing contracts too.");
  // None in force: the one that starts latest.
  assert.equal(plan(agreement({ agency: "Quillfeather Staffing" }), { rows: CONTRACTS.filter((c) => c.id !== "c-now") }).recordId, "c-next");
});

test("an agreement with the agency's own name where the facility goes is still a master agreement; one with a facility and dates is an assignment", () => {
  assert.equal(masterAgreement({ agency: "Quillfeather Staffing", facility: "Quillfeather Staffing, LLC" }), true);
  assert.equal(masterAgreement({ agency: "Quillfeather Staffing" }), true);
  assert.equal(masterAgreement({ agency: "Quillfeather Staffing", facility: "Fernwick" }), false);
  assert.equal(masterAgreement({ agency: "Quillfeather Staffing", startDate: "2026-10-01" }), false);
  assert.equal(masterAgreement({ agency: "Quillfeather Staffing", coveragePeriods: [{ start: "2026-10-01", end: "2026-10-02" }] }), false);
  const assignment = plan(agreement({ agency: "Quillfeather Staffing", facility: "Fernwick", startDate: "2026-10-01", endDate: "2026-10-14" }), { rows: CONTRACTS });
  assert.equal(assignment.outcome, "created");
});

test("a master agreement with no contract for its agency, or no agency at all, stays unfiled and says why", () => {
  const none = plan(agreement({ agency: "Northwind Locums" }), { rows: CONTRACTS });
  assert.equal(none.outcome, "unfiled");
  assert.equal(none.lines[0], "Saved, not filed yet: MSA.pdf reads as the master agreement with Northwind Locums, and no contract with Northwind Locums is on file (open the app > Documents to file it). It was not made into a new contract, since it names no facility or dates.");
  assert.equal(none.readsAs, "the master agreement with Northwind Locums -> your Northwind Locums contract, once one is on file");
  const nameless = plan(agreement({ notes: "terms" }), { rows: CONTRACTS });
  assert.match(nameless.lines[0], /reads as a master agreement, and it names no agency to match it to/);
});

test("roles narrow the scanner's answer and never invent a credential", () => {
  const dea = { documentType: "license", confidence: "high", extracted: { type: "DEA Registration", expirationDate: "2027-01-31" } };
  const other = { documentType: "other", confidence: "medium", extracted: { name: "Attestation", issuer: "Osterly", suggestedCategory: { name: "Attestations" } } };
  assert.deepEqual(roleTarget(dea, null), { kind: "section", section: "licenses" });
  assert.deepEqual(roleTarget(dea, "credential_for_physician"), { kind: "section", section: "licenses" });
  assert.deepEqual(roleTarget(dea, "form_to_complete"), { kind: "unfiled", reason: "form" });
  assert.deepEqual(roleTarget(dea, "request_checklist"), { kind: "unfiled", reason: "checklist" });
  assert.deepEqual(roleTarget(dea, "informational"), { kind: "section", section: "licenses" }, "a real credential is still filed");
  assert.deepEqual(roleTarget(other, "informational"), { kind: "unfiled", reason: "informational" }, "never a new category from something to read");
  assert.deepEqual(roleTarget(other, "agreement_or_contract"), { kind: "section", section: "locumContracts" });
  assert.equal(plan(other, { role: "form_to_complete" }).lines[0], "Saved, not filed yet: MSA.pdf is a form to fill in, not one of your credentials (open the app > Documents to file it).");
  const otherAgreement = plan({ documentType: "other", confidence: "high", extracted: { name: "Master Services Agreement", issuer: "Quillfeather Staffing" } }, { role: "agreement_or_contract", rows: CONTRACTS });
  assert.equal(otherAgreement.outcome, "linked", "an agreement the scanner called 'other' goes to the agency's contract by its issuer");
  assert.equal(otherAgreement.recordId, "c-now");
});

// ── The evaluation harness ──────────────────────────────────────────────────

test("the synthetic corpus: recorded replies read right, and the rules alone never invent an ask or make a letter a request", async () => {
  const cases = loadCases(SYNTHETIC_DIR);
  assert.deepEqual(cases.map((c) => c.id), ["delivery-approval", "informational-agreement", "mixed-approval-and-form", "request-no-attachment", "request-with-form"]);
  const stub = await runEval(cases, readerFor("stub"));
  assert.deepEqual([stub.totals.intent, stub.totals.request, stub.totals.invented, stub.totals.asksHit, stub.totals.asksWanted, stub.totals.byModel], [5, 5, 0, 6, 6, 5]);
  assert.match(formatReport(stub, "stub"), /intent: 5\/5 \(100%\)\nrequest or not: 5\/5 \(100%\)/);
  const rules = await runEval(cases, readerFor("rules"));
  assert.equal(rules.totals.request, 5, "request or not is right even without the model");
  assert.equal(rules.totals.invented, 0, "no ask on an email that asked for nothing");
  const info = rules.rows.find((r) => r.id === "informational-agreement");
  assert.notEqual(info.reading.intent, "request");
  assert.deepEqual(info.reading.asks, []);
});

test("the harness sends the request production sends, and scores only labelled cases", async () => {
  const [c] = loadCases(SYNTHETIC_DIR).filter((x) => x.id === "informational-agreement");
  const r = requestFor(c);
  assert.equal(r.model, "claude-opus-5");
  assert.match(r.messages[0].content, /The sender's message:\nDr\. Testa,/);
  assert.match(composeForward(c), /^---------- Forwarded message ---------\nFrom: Jordan Sample <jordan\.sample@quillfeather\.example>/);
  assert.equal(scoreCase({ ...c, labelled: false }, { intent: "request", asks: [] }), null);
  assert.equal(scoreCase({ id: "x" }, { intent: "request", asks: [] }), null);
  const s = scoreCase({ expected: { intent: "request", asks: [{ kind: "dea" }, { kind: "bls" }] } }, { method: "rules", intent: "request", asks: [{ quote: "DEA" }, { quote: "CV" }] });
  assert.deepEqual([s.intent, s.asksHit, s.asksGot, s.asksWanted, s.invented], [true, 1, 2, 2, 0]);
});

test("a real corpus may not live in this repository; the synthetic cases and anywhere outside may", () => {
  assert.equal(corpusAllowed(SYNTHETIC_DIR), true);
  assert.equal(corpusAllowed(new URL("../scripts", import.meta.url).pathname), false);
  assert.equal(corpusAllowed(new URL("../", import.meta.url).pathname), false);
  assert.equal(corpusAllowed(DEFAULT_CORPUS), true);
  const dir = mkdtempSync(join(tmpdir(), "intake-eval-"));
  try {
    writeFileSync(join(dir, "a.json"), JSON.stringify({ id: "a", subject: "x", body: "Please send your DEA.", attachments: [], expected: { intent: "request", asks: [{ kind: "dea" }] } }));
    writeFileSync(join(dir, "notes.txt"), "ignored");
    assert.equal(corpusAllowed(dir), true);
    assert.deepEqual(loadCases(dir).map((c) => c.id), ["a"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
