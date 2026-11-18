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

const NAMES = [NAME];

test("signatureOnly: the signer's own name over contact lines is a signature; anything that asks or names a document is not", () => {
  for (const s of [BODY, NAME, `${NAME}\n555-010-0199`, `${NAME}, DO\n(555) 010-0199`, `Thanks,\n${NAME}\n555-010-0100`, `Dr. ${NAME}, M.D.\nrowan.testa@clinic.example`, "Dr. Rowan Testa"]) {
    assert.equal(signatureOnly(s, NAMES), true, s);
    assert.equal(appPacket.signatureOnly(s, NAMES), true, s);
  }
  for (const s of ["", "Please send your DEA\nMorgan", "DEA and CSR please", "CV", "Board Certificate", "555-010-0199", `${NAME}\nCan you sign this?`, `${NAME}\nBLS card`]) {
    assert.equal(signatureOnly(s, NAMES), false, JSON.stringify(s));
  }
  // No names to compare with: never a signature.
  assert.equal(signatureOnly(BODY), false);
  assert.equal(appPacket.signatureOnly(BODY), false);
});

test("signatureOnly: a short phrase is not a signature, however it is shaped (review M1)", () => {
  const phrases = ["Urgent", "Due Friday", "Hospital Application", "Attestation Form", "Mercy Hospital", "Medical Staff Office",
    "Dr. Smith", "Morgan Smith, MD"];
  for (const p of phrases) {
    for (const fn of [signatureOnly, appPacket.signatureOnly]) {
      assert.equal(fn(p, NAMES), false, p);
      // Under the physician's own name too: the phrase is something written, not a signature.
      assert.equal(fn(`${NAME}\n${p}`, NAMES), false, `${NAME} / ${p}`);
      assert.equal(fn(`${p}\n${NAME}`, NAMES), false, `${p} / ${NAME}`);
    }
  }
  // A surname alone, or another person's name, is not the signer's.
  assert.equal(signatureOnly("Dr. Testa", NAMES), false);
  assert.equal(signatureOnly("Dr. Morgan Smith\n555-010-0100", NAMES), false);
  // A link is somewhere to go, not a contact line.
  assert.equal(signatureOnly(`${NAME}\nhttps://portal.example/apply`, NAMES), false);
});

// ── The rules (no model) ─────────────────────────────────────────────────────

const CME_WORDS = "title: OMED 2026\ncategory: AOA Category 1-A\nhours: 20";
const rules = (over = {}) => rulesUnderstanding({
  subject: SUBJECT, body: BODY, attachmentNames: [FILE], attachmentCount: 1, forwarded: false, why: "the AI service answered 400",
  ownSender: true, signerNames: NAMES, attachmentWords: [CME_WORDS], attachmentTypes: ["cme"], ...over,
});

test("rules: the physician's own signature-only email over a scanned credential is a delivery with nothing asked", () => {
  for (const name of [FILE, "OMED26 CME Certificate of Completion.pdf", "scan001.pdf"]) {
    for (const body of [BODY, `${NAME} MD FACS`, `${NAME}, DO\n555-010-0199`]) {
      const r = rules({ body, attachmentNames: [name] });
      assert.equal(r.intent, "delivery", `${name} / ${JSON.stringify(body)}: ${r.reasons.join(" | ")}`);
      assert.equal(r.unclear, false);
      assert.ok(!r.asks.some((a) => /Testa/.test(a.quote)), JSON.stringify(r.asks));
    }
  }
  assert.deepEqual(rules().asks, []);
  for (const type of ["license", "privilege", "insurance", "education", "healthRecord"]) {
    assert.equal(rules({ attachmentTypes: [type], attachmentNames: ["scan001.pdf"] }).intent, "delivery", type);
  }
});

test("rules: the own-file path needs every condition (review M1)", () => {
  const notOwn = (over, label) => {
    const r = rules(over);
    assert.ok(!r.reasons.some((x) => /physician's own email/.test(x)), `${label}: ${r.reasons.join(" | ")}`);
  };
  notOwn({ ownSender: false }, "not the physician's authenticated address");
  notOwn({ forwarded: true }, "a forward");
  notOwn({ attachmentNames: ["CME Attestation.pdf"] }, "a file named like a form");
  notOwn({ attachmentNames: ["OMED26 CME Attestation and Evaluation.pdf"] }, "an attestation with no transcript in its name");
  notOwn({ attachmentTypes: [] }, "the file was not scanned");
  notOwn({ attachmentTypes: ["unknown"] }, "the scan read nothing it could name");
  notOwn({ attachmentTypes: ["other"] }, "a letter");
  notOwn({ attachmentTypes: ["agreement"] }, "an agreement (could be one to sign)");
  notOwn({ attachmentWords: [""] }, "an empty scan");
  notOwn({ attachmentCount: 2, attachmentNames: [FILE, "scan002.pdf"] }, "a second file not scanned");
  notOwn({ signerNames: [] }, "no name to compare the signature with");
  notOwn({ signerNames: ["Morgan Smith"] }, "signed by someone else");
  notOwn({ subject: "Please complete" }, "an asking subject");
  notOwn({ body: `${NAME}\nUrgent` }, "a short phrase under the name");
});

// The four emails the M1 review found filed silently. Each was a request on
// origin/main and must be one again: a short body, a form attached.
const M1 = [
  { label: "Dr. Smith, no subject, Reappointment_Application.pdf", subject: "", body: "Dr. Smith", file: "Reappointment_Application.pdf" },
  { label: "Dr. Smith and a phone, Credentialing Request Form.pdf", subject: "", body: "Dr. Smith\n555-010-0142", file: "Credentialing Request Form.pdf" },
  { label: "Morgan Smith, MD under Mercy, Attestation_to_sign.pdf", subject: "Mercy", body: "Morgan Smith, MD", file: "Attestation_to_sign.pdf" },
  { label: "Mercy Hospital under Credentialing, form.pdf", subject: "Credentialing", body: "Mercy Hospital", file: "form.pdf" },
];

test("rules: the four M1 emails are requests again, whatever the scan or the names say", () => {
  for (const c of M1) {
    for (const extra of [
      { attachmentTypes: [], attachmentWords: [] },
      { attachmentTypes: ["cme"], attachmentWords: [CME_WORDS] },
      { signerNames: ["Morgan Smith"], attachmentTypes: ["license"], attachmentWords: ["state: Synthetic"] },
    ]) {
      const r = rules({ subject: c.subject, body: c.body, attachmentNames: [c.file], ...extra });
      assert.equal(r.intent, "request", `${c.label} ${JSON.stringify(extra)}: ${r.intent} / ${r.reasons.join(" | ")}`);
    }
  }
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
const modelSaid = (asks, role, intent = "request", over = {}) => verifyUnderstanding({
  intent,
  asks: asks.map((quote) => ({ quote, kind: "unknown", who: "physician" })),
  attachments: [{ index: 1, role, filing: "CME" }],
  summary: "a CME transcript", confidence: "high", records: [],
}, { subject: SUBJECT, parts, attachmentCount: 1, facts: { ...facts, corpus: undefined }, ownSender: true, attachmentNames: [FILE], ...over });

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

test("model: a signature-only reading is never a delivery when anything else asks or the file may be a form (review M1)", () => {
  const notDelivered = (v, label) => {
    assert.notEqual(v.intent, "delivery", label);
    assert.equal(v.unclear, true, label);
  };
  notDelivered(modelSaid([`Dr. ${NAME}`], "credential_for_physician", "request", { ownSender: false }), "not the physician's own address");
  notDelivered(modelSaid([`Dr. ${NAME}`], "credential_for_physician", "request", { attachmentNames: ["Attestation_to_sign.pdf"] }), "a form-named file");
  notDelivered(modelSaid([`Dr. ${NAME}`], "credential_for_physician", "request", { attachmentCount: 2 }), "a file the reading gave no role");
  // An ask in the forwarded history.
  notDelivered(modelSaid([`Dr. ${NAME}`], "credential_for_physician", "request", {
    parts: { note: "", message: BODY, history: "Please complete the attached reappointment application by Friday." },
  }), "an ask in the history");
  // An ask in the attached letter.
  notDelivered(modelSaid([`Dr. ${NAME}`], "credential_for_physician", "request", {
    facts: { ...facts, corpus: undefined, attachments: ["requestLeadIn: Please send the following\nrequestedItem: Current BLS card"] },
  }), "an ask in the attachment");
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

test("end to end, rules: a signature-short email from the physician with a form attached stays a request (review M1)", async () => {
  harness.anthropicReply = FAIL;
  harness.geminiReply = () => ({ documentType: "other", confidence: "medium", extracted: { title: "Medical staff form" } });
  const r = await deliver({
    id: `m1-${++n}`, from: `${NAME} <${ME}>`, to: "docs@credentialdomd.com", subject: "Credentialing", text: "Mercy Hospital",
    attachments: [{ filename: "form.pdf", contentType: "application/pdf", bytes: new TextEncoder().encode(`%PDF-1.4 m1 ${n}`) }],
  });
  assert.equal(r.status, 200);
  assert.notEqual(r.body.intent, "delivery", JSON.stringify(r.body));
  assert.equal(rows("document_requests").length, 1, "a request row");
  assert.equal(rows("cme").length, 0);
});
