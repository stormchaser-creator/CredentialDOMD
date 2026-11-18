// The physician's own email to docs@ whose body is only a signature, with a
// CME certificate attached. Shaped like the email of 2026-11-17 (synthetic
// name and number): subject "OMED CME", body "Dr. <name>" over a phone
// number, one PDF named "<name>-Transcript-OMED26 CME Attestation and
// Evaluation.pdf". The signature line was read as the one item asked for,
// a request row was made, and the physician was emailed "<name>: not
// recognized. What did they mean?". It is a document to file: a CME entry,
// a plain confirmation, no request and no question.
// Run: node --test tests/docs-inbox-signature-only.test.mjs
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { parseAsks, signatureOnly, isSignatureText } from "../supabase/functions/_shared/requestPacket.ts";
import * as appPacket from "../src/utils/requestPacket.js";
import { rulesUnderstanding, verifyUnderstanding, DROP } from "../supabase/functions/_shared/intakeUnderstanding.mjs";
import { loadFunction, resetWorld, deliver, harness } from "../scripts/email-inbound-harness.mjs";

const NAME = "Rowan Testa";
const BODY = `Dr. ${NAME}\n555-010-0199`;
const SUBJECT = "OMED CME";
const FILE = `${NAME}-Transcript-OMED26 CME Attestation and Evaluation.pdf`;

// ── A signature is never an ask ──────────────────────────────────────────────

test("a signed name is never read as an ask, in either copy of the matcher", () => {
  for (const sig of [`Dr. ${NAME}`, `Doctor ${NAME}`, `${NAME} MD FACS`, `${NAME} DO`, `Dr. R. Testa, DO`]) {
    for (const parse of [parseAsks, appPacket.parseAsks]) {
      assert.ok(!parse(`Please send your DEA.\n\nThanks,\n${sig}`, "").some((a) => /Testa/.test(a)), sig);
      assert.ok(!parse(sig, "").some((a) => /Testa/.test(a)), sig);
    }
    assert.equal(isSignatureText(sig), true, sig);
  }
  // A name that is a kind the rules can name is still an ask.
  assert.deepEqual(parseAsks("State License MD", ""), ["State License MD"]);
  assert.equal(isSignatureText("State License MD"), false);
  assert.equal(isSignatureText("555-010-0199"), true);
});

test("signatureOnly: a name over contact lines is a signature; anything that asks or names a document is not", () => {
  for (const s of [BODY, NAME, `${NAME}\n555-010-0199`, `${NAME}, DO\nNeurosurgery\n(555) 010-0199`, `Thanks,\n${NAME}\nMedical Staff Office\n555-010-0100`]) {
    assert.equal(signatureOnly(s), true, s);
    assert.equal(appPacket.signatureOnly(s), true, s);
  }
  for (const s of ["", "Please send your DEA\nMorgan", "DEA and CSR please", "CV", "Board Certificate", "555-010-0199", `${NAME}\nCan you sign this?`, `${NAME}\nBLS card`]) {
    assert.equal(signatureOnly(s), false, JSON.stringify(s));
  }
});

// ── The rules (no model) ─────────────────────────────────────────────────────

const rules = (over = {}) => rulesUnderstanding({ subject: SUBJECT, body: BODY, attachmentNames: [FILE], attachmentCount: 1, forwarded: false, why: "the AI service answered 400", ...over });

test("rules: the physician's own signature-only email is a delivery with nothing asked, whatever the file is named", () => {
  for (const name of [FILE, "OMED26 CME Attestation and Evaluation.pdf", "CME Attestation.pdf", "scan001.pdf"]) {
    for (const body of [BODY, `${NAME} MD FACS`, `${NAME}, DO\nNeurosurgery\n555-010-0199`]) {
      const r = rules({ body, attachmentNames: [name] });
      assert.equal(r.intent, "delivery", `${name} / ${JSON.stringify(body)}: ${r.reasons.join(" | ")}`);
      assert.equal(r.unclear, false);
      assert.ok(!r.asks.some((a) => /Testa/.test(a.quote)), JSON.stringify(r.asks));
    }
  }
  // Before this fix the name came back as the ask, and a file named like a form made it a request.
  assert.deepEqual(rules({ attachmentNames: ["OMED26 CME Attestation and Evaluation.pdf"] }).asks, []);
});

test("rules: a third party's signature-only forward, an asking subject, or an attached letter that asks still go the request way", () => {
  assert.notEqual(rules({ forwarded: true, attachmentNames: ["Reappointment Application.pdf"] }).intent, "delivery");
  assert.notEqual(rules({ subject: "Missing items", attachmentNames: ["Reappointment Application.pdf"] }).intent, "delivery");
  const letter = "requestLeadIn: Please send the following documents\nrequestedItem: Current BLS card";
  const r = rules({ attachmentNames: ["letter.pdf"], attachmentWords: [letter], attachmentTypes: ["other"] });
  assert.notEqual(r.intent, "delivery");
  assert.deepEqual(r.asks.filter((a) => a.from === "attachment").map((a) => a.quote), ["Current BLS card"]);
  // An ask in the body is read as before.
  assert.equal(rules({ body: `Please send my DEA to the hospital.\n\n${BODY}` }).intent === "delivery", false);
});

// ── The model's reading ──────────────────────────────────────────────────────

const parts = { note: "", message: BODY, history: "" };
const facts = { corpus: null, email: BODY, attachments: [""], refs: new Map(), physicianName: NAME };
const modelSaid = (asks, role, intent = "request") => verifyUnderstanding({
  intent,
  asks: asks.map((quote) => ({ quote, kind: "unknown", who: "physician" })),
  attachments: [{ index: 1, role, filing: "CME" }],
  summary: "a CME transcript", confidence: "high", records: [],
}, { subject: SUBJECT, parts, attachmentCount: 1, facts: { ...facts, corpus: undefined } });

test("model: a signature quoted as an ask is dropped as a signature, and a credential attached makes it a delivery", () => {
  for (const q of [`Dr. ${NAME}`, NAME, "555-010-0199"]) {
    const v = modelSaid([q], "credential_for_physician");
    assert.deepEqual(v.dropped.map((d) => d.why), [DROP.signature], q);
    assert.equal(v.intent, "delivery", q);
    assert.equal(v.unclear, false);
    assert.equal(v.needsRules, false);
    assert.equal(v.asks.length, 0);
  }
});

test("model: a signature-only 'request' without a credential to keep goes to the rules, never to a question", () => {
  const v = modelSaid([`Dr. ${NAME}`], "form_to_complete");
  assert.equal(v.needsRules, true);
  assert.equal(v.dropped[0].why, DROP.signature);
});

test("model: a real ask that carries a phone number or names a document is kept", () => {
  const message = "Please fax your DEA certificate to 555-010-0100.";
  const v = verifyUnderstanding({
    intent: "request", asks: [{ quote: message, kind: "dea", who: "physician" }], attachments: [], summary: "your DEA", confidence: "high", records: [],
  }, { subject: "DEA", parts: { note: "", message, history: "" }, attachmentCount: 0, facts: { ...facts, email: message, attachments: [] } });
  assert.equal(v.asks.length, 1);
  assert.equal(v.intent, "request");
});

// ── End to end through email-inbound ────────────────────────────────────────

const PROFILE = "0b7f1c2e-5a44-4d7e-9b1a-3c2d1e0f9a88";
const ME = "rowan.testa@clinic.example";
const rows = (t) => harness.db.rows(t);
const CME_SCAN = { documentType: "cme", confidence: "high", extracted: { title: "OMED 2026", category: "AOA Category 1-A", hours: "20", date: "2026-10-28", provider: "Synthetic Osteopathic Association" } };
const FAIL = () => ({ status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "Synthetic failure." } } });

function seed() {
  rows("mailbox_claims").push({ address: ME, profile_id: PROFILE, proof: "verified", terminal_at: null });
  rows("profiles").push({ id: PROFILE, auth_user_id: "user_synthetic01", email: ME, access_status: "active", verified_email: ME, deleted_at: null, name: NAME, degree_type: "DO", ack_requests: true });
  rows("app_secrets").push({ name: "gemini_shared_key", value: "AIza-test" }, { name: "anthropic_shared_key", value: "sk-ant-test" });
}

let n = 0;
const send = () => {
  harness.geminiReply = () => CME_SCAN;
  return deliver({
    id: `sig${++n}`, from: `${NAME} <${ME}>`, to: "docs@credentialdomd.com", subject: SUBJECT, text: BODY,
    attachments: [{ filename: FILE, contentType: "application/pdf", bytes: new TextEncoder().encode(`%PDF-1.4 ${n}`) }],
  });
};

function assertFiledAsCme(r) {
  assert.equal(r.status, 200);
  assert.equal(r.body.intent, "delivery", JSON.stringify(r.body));
  assert.equal(rows("document_requests").length, 0, "no request row");
  assert.equal(rows("cme").length, 1, "a CME entry");
  assert.equal(rows("documents")[0].linked_to, `cme:${rows("cme")[0].id}`);
  assert.equal(harness.sent.length, 1, "one email, to the physician only");
  const [reply] = harness.sent;
  assert.equal(reply.to[0], ME);
  assert.match(reply.text, /Filed: OMED 2026 -> CME/);
  assert.doesNotMatch(reply.text, /not recogni[sz]ed|What did they mean|request|Testa:/i);
}

before(async () => { await loadFunction(); });
beforeEach(() => { resetWorld(); harness.rawAuth = "mx.resend.com; dmarc=pass header.from=clinic.example"; seed(); });

test("end to end, rules: the 11-17 email files the CME certificate and confirms it, with no request and no question", async () => {
  harness.anthropicReply = FAIL;
  const r = await send();
  assert.equal(r.body.read, "rules");
  assertFiledAsCme(r);
});

test("end to end, model: a reading that took the signature for an ask still files the certificate", async () => {
  harness.anthropicReply = () => ({
    intent: "request",
    asks: [{ quote: `Dr. ${NAME}`, kind: "unknown", who: "physician" }],
    attachments: [{ index: 1, role: "credential_for_physician", filing: "CME" }],
    summary: "a CME transcript", confidence: "medium", records: [],
  });
  const r = await send();
  assert.equal(r.body.read, "model");
  assertFiledAsCme(r);
});
