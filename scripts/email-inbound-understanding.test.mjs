// End to end through supabase/functions/email-inbound/index.ts: every docs@
// and cme@ message is READ first (one model call on the shared Anthropic key,
// checked by the host), and the rules only stand in when that call fails.
//
// The case that started it, on 2026-09-28: an agency consultant's letter
// explaining how the agency's malpractice policy covers emergency care, with
// the physician's signed master services agreement attached. It asked for
// nothing. It became a request, two of its statements became asks, the
// agreement was parked as a request attachment, and the reply to the agency
// went out on one tap saying "I could not tell from your email what you
// meant by: <a sentence of his own letter>".
//
// Every email, name and address here is synthetic and paraphrased
// (scripts/fixtures/intake/understanding/). The function runs under node with
// its network edges replaced by scripts/email-inbound-harness.mjs: the
// Anthropic SDK is the real one, talking to a fake API.
// Run: node --test scripts/email-inbound-understanding.test.mjs
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadFunction, resetWorld, deliver, harness } from "./email-inbound-harness.mjs";
import { composeForward } from "./intake-eval.mjs";

const PROFILE = "0b7f1c2e-5a44-4d7e-9b1a-3c2d1e0f9a88";
const OTHER = "9e1d2c3b-4a59-4687-8b7c-6d5e4f3a2b10";
const CLERK = "user_synthetic01";
const ME = "rowan.testa@clinic.example";
const EM_DASH = String.fromCodePoint(0x2014);
const AUTH_PASS = "mx.resend.com; dmarc=pass header.from=clinic.example";
const AUTH_NONE = "mx.resend.com; spf=pass smtp.mailfrom=bounce.clinic.example; dkim=none; dmarc=none header.from=clinic.example";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/intake/understanding/${name}.json`, import.meta.url), "utf8"));
const INFO = fixture("informational-agreement");
const DELIVERY = fixture("delivery-approval");
const WITH_FORM = fixture("request-with-form");
const NO_ATTACHMENT = fixture("request-no-attachment");
const MIXED = fixture("mixed-approval-and-form");

const pdf = (s) => new TextEncoder().encode(`%PDF-1.4 ${s}`);
const db = () => harness.db;
const rows = (t) => db().rows(t);
const toPhysician = () => harness.sent.filter((m) => m.to?.[0] === ME);
const toOthers = () => harness.sent.filter((m) => m.to?.[0] !== ME);
const usage = (provider) => rows("ai_usage").filter((r) => r.provider === provider);
const ledger = (name) => harness.ledger.calls.filter((c) => c.name === name);

let n = 0;
/** Deliver a fixture as the physician's forward, its attachments scanned as the fixture says. */
function sendCase(c, over = {}) {
  const scans = new Map(c.attachments.map((a) => [a.name, a.scan]));
  const bytes = new Map(c.attachments.map((a, i) => [a.name, pdf(`${c.id}-${i}`)]));
  harness.geminiReply = (body) => {
    const data = body.contents?.[0]?.parts?.[0]?.inlineData?.data;
    const text = data ? Buffer.from(data, "base64").toString("utf8") : "";
    for (const [name, b] of bytes) if (text === Buffer.from(b).toString("utf8")) return scans.get(name);
    return null;
  };
  if (!("anthropicReply" in over)) harness.anthropicReply = () => c.modelReply;
  const { anthropicReply, ...rest } = over;
  if (anthropicReply) harness.anthropicReply = anthropicReply;
  return deliver({
    id: `u${++n}`, from: `Rowan Testa <${ME}>`, to: "docs@credentialdomd.com", subject: `Fwd: ${c.subject}`, text: composeForward(c),
    attachments: c.attachments.map((a) => ({ filename: a.name, contentType: "application/pdf", bytes: bytes.get(a.name) })),
    ...rest,
  });
}

function seed({ access = "active", anthropic = true, admin = false } = {}) {
  rows("mailbox_claims").push({ address: ME, profile_id: PROFILE, proof: "verified", terminal_at: null });
  rows("profiles").push({ id: PROFILE, auth_user_id: CLERK, email: ME, access_status: access, verified_email: ME, deleted_at: null, name: "Rowan Testa", degree_type: "MD", ack_requests: true });
  rows("app_secrets").push({ name: "gemini_shared_key", value: "AIza-test" });
  if (anthropic) rows("app_secrets").push({ name: "anthropic_shared_key", value: "sk-ant-test" });
  if (admin) rows("app_admins").push({ profile_id: PROFILE });
}

/** Two contracts with the agency: the one in force and an older one. */
function seedContracts() {
  rows("locum_contracts").push(
    { id: "contract-now", user_id: PROFILE, facility: "Fernwick Example Hospital", agency: "Quillfeather Staffing", start_date: "2026-09-01", end_date: "2026-12-31", hourly_rate: 250 },
    { id: "contract-old", user_id: PROFILE, facility: "Osterly Example Clinic", agency: "Quillfeather Staffing, Inc.", start_date: "2026-03-01", end_date: "2026-05-31", hourly_rate: 240 },
  );
}

/** A board certificate and a BLS card on file, so a request has something to match. */
function seedCredentials() {
  rows("licenses").push(
    { id: "lic-board", user_id: PROFILE, type: "Board Certification", name: "Board Certification (ABMS)", expiration_date: "2031-12-31" },
    { id: "lic-bls", user_id: PROFILE, type: "BLS", name: "BLS Certification", expiration_date: "2027-06-30" },
  );
  rows("documents").push(
    { id: "doc-board", user_id: PROFILE, name: "board.pdf", mime_type: null, type: "application/pdf", linked_to: "licenses:lic-board", uploaded_at: "2026-01-02T10:00:00Z", size_bytes: 11 },
    { id: "doc-bls", user_id: PROFILE, name: "bls.pdf", mime_type: null, type: "application/pdf", linked_to: "licenses:lic-bls", uploaded_at: "2026-01-02T10:00:00Z", size_bytes: 12 },
  );
}

before(async () => { await loadFunction(); });
beforeEach(() => { resetWorld(); harness.rawAuth = AUTH_PASS; seed(); });

// ── The incident ─────────────────────────────────────────────────────────────

test("an informational letter with an agreement attached: no request, the agreement attached to the agency's contract, a short note to the physician", async () => {
  seedContracts();
  const r = await sendCase(INFO);
  assert.equal(r.status, 200);
  assert.equal(r.body.intent, "informational");
  assert.equal(r.body.read, "model");
  assert.equal(rows("document_requests").length, 0, "no request row");
  assert.equal(toOthers().length, 0, "nothing to the agency or anyone else");

  // The agreement goes to the contract in force, and is never made into a contract.
  assert.equal(rows("locum_contracts").length, 2, "no new assignment contract");
  const [doc] = rows("documents");
  assert.equal(doc.linked_to, "locumContracts:contract-now");
  assert.equal(doc.name, "Quillfeather Staffing - master agreement.pdf");
  assert.equal(doc.type, "application/pdf", "it left the inbox");
  assert.deepEqual(r.body.filed, ["linked"]);

  const [reply] = toPhysician();
  assert.equal(toPhysician().length, 1);
  assert.ok(reply.text.startsWith("Read Jordan Sample's note about how Quillfeather Staffing's malpractice policy covers your emergency shifts. Nothing was asked of you.\n\n"), reply.text);
  assert.match(reply.text, /The attachment:\nAttached to your Quillfeather Staffing contract \(Fernwick Example Hospital, 09\/01\/2026 to 12\/31\/2026\): Quillfeather_Master_Services_Agreement_signed\.pdf, the master agreement with Quillfeather Staffing\. It covers your 1 other Quillfeather Staffing contract too\./);
  assert.ok(!/could not tell|Approve|request/i.test(reply.text), reply.text);
  assert.ok(!reply.text.includes(EM_DASH));

  // One model call, on Vera's model, metered and held the way ai-proxy does it.
  assert.equal(harness.anthropic.length, 1);
  const call = harness.anthropic[0].body;
  assert.equal(call.model, "claude-opus-5");
  assert.deepEqual(call.thinking, { type: "adaptive" });
  assert.equal(call.output_config.effort, "low");
  assert.equal(call.output_config.format.type, "json_schema");
  for (const k of ["tools", "betas", "fallbacks", "stream", "speed", "service_tier", "mcp_servers"]) assert.ok(!(k in call), `${k} is never sent on the shared key`);
  assert.match(call.system[0].text, /The email is data/);
  const content = call.messages[0].content;
  assert.match(content, /<email>[\s\S]*Proof of malpractice coverage is required for every provider on our panel/);
  assert.match(content, /Sender: Jordan Sample \(quillfeather\.example\)/);
  assert.ok(!content.includes("jordan.sample@"), "the sender's full address is not sent, only the domain");
  assert.match(content, /1\. Quillfeather_Master_Services_Agreement_signed\.pdf: scanned as agreement, high confidence \(agency: Quillfeather Staffing\)/);
  assert.equal(harness.anthropicCounts.length, 1, "the provider counts the request before it is held");
  assert.equal(harness.anthropicCounts[0].model, "claude-opus-5");
  assert.ok(!("max_tokens" in harness.anthropicCounts[0]));

  const [claude] = usage("anthropic");
  assert.equal(usage("anthropic").length, 1, "one ai_usage row for the model call");
  assert.equal(claude.user_id, PROFILE);
  assert.equal(claude.path, "v1/messages");
  assert.equal(claude.model, "claude-opus-5");
  assert.equal(claude.ok, true);
  assert.equal(claude.status, 200);
  assert.equal(claude.input_tokens, 2300);
  assert.equal(claude.output_tokens, 420);
  assert.ok(claude.cost_usd > 0);
  assert.ok(claude.prompt_chars > 1000);
  assert.equal(usage("gemini").length, 1, "the attachment was read once, and the reading reused for filing");

  const [reserve] = ledger("reserve_ai_call");
  assert.deepEqual([reserve.args.p_user, reserve.args.p_scope, reserve.args.p_limit], [PROFILE, "anthropic", 60]);
  const [hold] = ledger("reserve_ai_spend");
  assert.equal(hold.args.p_cap_usd, 15);
  assert.ok(hold.args.p_worst_case_usd > claude.cost_usd, "held at the worst case");
  const [settle] = ledger("settle_ai_spend");
  assert.equal(settle.args.p_actual_usd, claude.cost_usd, "settled at what it cost");

  const [row] = rows("inbound_emails");
  assert.match(row.detail, /^informational, stored 1, duplicates 0, filed 0, added to 1/);
  assert.match(row.detail, /read by model \(high\)/);
  assert.ok(!/ack sent/i.test(row.detail));
});

test("the same letter from a domain that cannot be verified: nothing filed, and the reply says where the agreement belongs", async () => {
  seedContracts();
  harness.rawAuth = AUTH_NONE;
  const r = await sendCase(INFO);
  assert.equal(r.body.intent, "informational");
  assert.equal(r.body.verified, false);
  assert.equal(rows("document_requests").length, 0);
  const [doc] = rows("documents");
  assert.equal(doc.linked_to, null);
  assert.equal(doc.type, "email-inbox");
  const text = toPhysician()[0].text;
  assert.match(text, /^Read Jordan Sample's note about .*\. Nothing was asked of you\./);
  assert.match(text, /Saved, not filed yet: Quillfeather_Master_Services_Agreement_signed\.pdf, which reads as the master agreement with Quillfeather Staffing -> your Quillfeather Staffing contract \(Fernwick Example Hospital, 09\/01\/2026 to 12\/31\/2026\)\. This message could not be verified as coming from you/);
  assert.match(text, /Mail from clinic\.example arrives without a DMARC pass/);
});

test("an agreement with no contract for its agency on file is kept unfiled, never made into a contract", async () => {
  const r = await sendCase(INFO);
  assert.deepEqual(r.body.filed, ["unfiled"]);
  assert.equal(rows("locum_contracts").length, 0);
  assert.equal(rows("documents")[0].linked_to, null);
  assert.match(toPhysician()[0].text, /Saved, not filed yet: Quillfeather_Master_Services_Agreement_signed\.pdf reads as the master agreement with Quillfeather Staffing, and no contract with Quillfeather Staffing is on file \(open the app > Documents to file it\)\. It was not made into a new contract, since it names no facility or dates\./);
});

// ── Delivery, request, mixed ─────────────────────────────────────────────────

test("a delivery ('please see the attached approval letter') is filed, with no request and the filing reply", async () => {
  const r = await sendCase(DELIVERY);
  assert.equal(r.body.intent, "delivery");
  assert.equal(r.body.read, "model");
  assert.equal(rows("document_requests").length, 0);
  assert.equal(toOthers().length, 0);
  const [priv] = rows("privileges");
  assert.equal(priv.facility, "Fernwick Example Hospital");
  assert.equal(rows("documents")[0].linked_to, `privileges:${priv.id}`);
  const text = toPhysician()[0].text;
  assert.match(text, /^Got it\. Here is where it went:\n\nFiled: Fernwick Example Hospital courtesy privileges -> Privileges/);
  assert.ok(!text.includes("Nothing was asked"), "a delivery keeps the filing reply");
});

test("a real request with a form: the request is made from the quoted asks, the form stays with it, and an unrecognised ask means Review, not one tap", async () => {
  seedCredentials();
  const r = await sendCase(WITH_FORM);
  assert.equal(r.body.intent, "request");
  assert.equal(r.body.read, "model");
  assert.equal(r.body.one_tap, false);
  const [req] = rows("document_requests");
  assert.equal(rows("document_requests").length, 1);
  assert.equal(req.from_addr, "casey.example@osterly-health.example");
  const p = req.proposal;
  assert.equal(p.source, "model");
  assert.equal(p.confidence, "high");
  assert.deepEqual(p.items.map((i) => [i.kind, i.status, i.docIds]), [["board_cert", "found", ["doc-board"]], ["bls", "found", ["doc-bls"]], ["unknown", "missing", []]]);
  assert.equal(p.items[0].quote, "a copy of your current board certificate");
  // The form is the requester's, not the physician's: kept with the request, never filed.
  const form = rows("documents").find((d) => d.name === "Reappointment_Attestation.pdf");
  assert.equal(form.type, "request-attachment-inbox");
  assert.equal(form.linked_to, null);
  assert.equal(rows("custom_categories").length, 0, "a blank form never creates a category");
  // The note to the requester attaches and says nothing about what it could not name.
  assert.equal(p.coverNote, "Hello Casey,\n\nAttached are the documents you asked for:\n- Board Certification\n- BLS\n\nRegards,\nRowan Testa, MD");
  assert.ok(!/could not tell|attestation|Not on file/i.test(p.coverNote), p.coverNote);
  // The physician is sent to Review, with the question.
  const summary = toPhysician()[0].text;
  assert.match(summary, /Draft ready: 2 documents\. Open the app and tap Review\. Nothing goes to Casey Example until you send it\./);
  assert.match(summary, /To check: Not recognised: ".*attestation form.*"\. What did they mean\?/);
  assert.ok(!summary.includes("Approve and send"));
  // The acknowledgement promises nothing and carries no ask.
  const [ack] = toOthers();
  assert.equal(ack.to[0], "casey.example@osterly-health.example");
  assert.ok(!/attestation|board certificate/i.test(ack.text));
});

test("a request with no attachment, every ask matched with high confidence: one tap", async () => {
  seedCredentials();
  const r = await sendCase(NO_ATTACHMENT);
  assert.equal(r.body.intent, "request");
  assert.equal(r.body.one_tap, true);
  const p = rows("document_requests")[0].proposal;
  assert.deepEqual(p.docIds, ["doc-board", "doc-bls"]);
  assert.match(toPhysician()[0].text, /Packet ready: 2 documents\. Open the app and tap Approve and send\./);
  assert.equal(harness.gemini.length, 0, "nothing to scan");
});

test("a medium-confidence reading of the same request is never one tap", async () => {
  seedCredentials();
  const r = await sendCase(NO_ATTACHMENT, { anthropicReply: () => ({ ...NO_ATTACHMENT.modelReply, confidence: "medium" }) });
  assert.equal(r.body.one_tap, false);
  assert.match(toPhysician()[0].text, /To check: The reading of this email is not certain, so check the draft before it goes\./);
});

test("a mixed email: the approval is filed, the form stays with the request, and the request is made", async () => {
  const r = await sendCase(MIXED);
  assert.equal(r.body.intent, "mixed");
  assert.equal(rows("document_requests").length, 1);
  const [priv] = rows("privileges");
  assert.equal(priv.facility, "Tallowmere Example Clinic");
  const docs = rows("documents");
  assert.equal(docs.find((d) => d.name === "Code_of_Conduct_Acknowledgement.pdf").type, "request-attachment-inbox");
  assert.ok(docs.some((d) => d.linked_to === `privileges:${priv.id}`));
  const p = rows("document_requests")[0].proposal;
  assert.ok(!p.docIds.some((id) => docs.find((d) => d.id === id)?.linked_to === `privileges:${priv.id}`), "the approval is never proposed back to its sender");
  assert.equal(r.body.one_tap, false);
  assert.match(toPhysician()[0].text, /From the same email:\nFiled: Tallowmere Example Clinic active privileges -> Privileges/);
});

test("a request's attachment that reads as a patient record is never kept, and nothing it says reaches the model", async () => {
  seedCredentials();
  const chart = { documentType: "unknown", confidence: "low", extracted: { note: "Operative note. Patient name: J. Doe. MRN 00481234. Date of birth 03/14/1961." } };
  const c = { ...WITH_FORM, attachments: [{ name: "Reappointment_Attestation.pdf", scan: chart }] };
  const r = await sendCase(c);
  assert.equal(r.body.intent, "request");
  assert.equal(rows("documents").filter((d) => d.name === "Reappointment_Attestation.pdf").length, 0, "not stored");
  assert.match(toPhysician()[0].text, /Not kept: Reappointment_Attestation\.pdf reads like a patient record/);
  const content = harness.anthropic[0].body.messages[0].content;
  assert.match(content, /1\. Reappointment_Attestation\.pdf: reads like a patient record \(not kept, not described\)/);
  assert.ok(!/00481234|J\. Doe|1961/.test(content));
});

// ── The host's check ─────────────────────────────────────────────────────────

test("an ask that is not the email's own words is dropped, and with none left the email is not a request", async () => {
  seedContracts();
  const r = await sendCase(INFO, {
    anthropicReply: () => ({
      ...INFO.modelReply, intent: "request",
      asks: [
        { quote: "Please send your current malpractice certificate", kind: "coi_malpractice", who: "physician" },
        { quote: "proof of malpractice coverage for every provider", kind: "coi_malpractice", who: "physician" },
      ],
    }),
  });
  assert.equal(r.body.intent, "informational", "the first quote is invented, the second is not in the email as quoted");
  assert.equal(rows("document_requests").length, 0);
  assert.equal(toOthers().length, 0);
  assert.match(rows("inbound_emails")[0].detail, /read by model \(medium, 2 ask\(s\) dropped\)/);
});

test("a quote that is in the email but asked of someone else is not the physician's ask", async () => {
  seedContracts();
  const r = await sendCase(INFO, {
    anthropicReply: () => ({ ...INFO.modelReply, intent: "request", asks: [{ quote: "Proof of malpractice coverage is required for every provider on our panel", kind: "coi_malpractice", who: "someone_else" }] }),
  });
  assert.equal(r.body.intent, "informational");
  assert.equal(rows("document_requests").length, 0);
});

test("a quote survives the mail client's wrapping, curly quotes and dashes", async () => {
  seedCredentials();
  const c = { ...NO_ATTACHMENT, body: "Good morning Dr. Testa,\n\nBefore your October assignment we still need a copy of\nyour current board certificate \u2013 and your \u201cBLS card\u201d. Can you send those over this week?\n\nThanks so much,\nMorgan" };
  const r = await sendCase(c, { anthropicReply: () => ({ ...NO_ATTACHMENT.modelReply, asks: [
    { quote: "a copy of your current board certificate - and your \"BLS card\"", kind: "board_cert", who: "physician" },
  ] }) });
  assert.equal(r.body.intent, "request");
  assert.equal(rows("document_requests")[0].proposal.items.length, 1);
});

// ── When the model cannot answer ────────────────────────────────────────────

// A letter the old rules called a request ("required documents"), with two
// statements the old matcher read as asks. Synthetic.
const REQUIRED_WORDS = {
  id: "required-words", subject: "Your credentialing file", from: { name: "Jordan Sample", address: "jordan.sample@quillfeather.example" },
  body: "Dr. Testa,\n\nThe credentialing committee reviewed the required documents for your file last week. Your malpractice coverage is provided through the group policy, and the certificate of insurance is kept on file by our office.\n\nRegards,\nJordan Sample",
  attachments: [], modelReply: { intent: "informational", asks: [], attachments: [], summary: "your credentialing file", confidence: "high" },
};

for (const [name, reply] of [
  ["answers 500", () => ({ status: 500 })],
  ["never answers", () => ({ hang: true })],
  ["answers with text that is not JSON", () => ({ message: { id: "m", type: "message", role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: "I think this is informational." }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } } })],
  ["declines", () => ({ message: { id: "m", type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: "refusal", usage: { input_tokens: 10, output_tokens: 0 } } })],
  ["answers outside the schema", () => ({ intent: "request", asks: "the malpractice certificate", attachments: [], summary: "x", confidence: "high" })],
]) {
  test(`the model ${name}: the rules stand in, and a statement is still never an ask`, async () => {
    const r = await sendCase(REQUIRED_WORDS, { anthropicReply: reply });
    assert.equal(r.body.read, "rules");
    assert.notEqual(r.body.intent, "request");
    assert.equal(rows("document_requests").length, 0, "no request, so nothing can be sent to the agency");
    assert.equal(toOthers().length, 0);
    assert.match(toPhysician()[0].text, /^Read Jordan Sample's note about "Your credentialing file"\. Nothing was asked of you\./);
    assert.ok(!/could not tell/i.test(toPhysician()[0].text));
    assert.match(rows("inbound_emails")[0].detail, /read by rules \(/);
  });
}

test("a failed call is metered and its hold settled: an answered error at zero, a timeout at its worst case", async () => {
  await sendCase(REQUIRED_WORDS, { anthropicReply: () => ({ status: 500 }) });
  let [row] = usage("anthropic");
  assert.deepEqual([row.ok, row.status, row.model], [false, 500, "claude-opus-5"]);
  assert.equal(ledger("settle_ai_spend")[0].args.p_actual_usd, 0);

  resetWorld(); harness.rawAuth = AUTH_PASS; seed();
  await sendCase(REQUIRED_WORDS, { anthropicReply: () => ({ hang: true }) });
  [row] = usage("anthropic");
  assert.deepEqual([row.ok, row.status], [false, null]);
  assert.equal(ledger("settle_ai_spend")[0].args.p_actual_usd, null, "unknown is expensive: the hold stays at its worst case");
});

test("over the day's limit or the month's budget, or with the ledger down, no call is made and the rules read the email", async () => {
  for (const [name, answer] of [
    ["reserve_ai_call", () => ({ data: [], error: null })],
    ["reserve_ai_spend", () => ({ data: { outcome: "over", spent_usd: 15 }, error: null })],
    ["reserve_ai_call", () => ({ data: null, error: { message: "ledger down" } })],
  ]) {
    resetWorld(); harness.rawAuth = AUTH_PASS; seed();
    harness.ledger[name] = answer;
    const r = await sendCase(REQUIRED_WORDS);
    assert.equal(r.body.read, "rules", name);
    assert.equal(harness.anthropic.length, 0, `${name}: no paid call`);
    assert.equal(usage("anthropic").length, 0);
    assert.equal(rows("document_requests").length, 0);
  }
});

test("an account that is not active, or a deployment with no Anthropic key, never makes the call", async () => {
  resetWorld(); harness.rawAuth = AUTH_PASS; seed({ access: "revoked_billing" });
  let r = await sendCase(REQUIRED_WORDS);
  assert.equal(r.body.read, "rules");
  assert.equal(harness.anthropic.length, 0);

  resetWorld(); harness.rawAuth = AUTH_PASS; seed({ anthropic: false });
  r = await sendCase(REQUIRED_WORDS);
  assert.equal(r.body.read, "rules");
  assert.equal(harness.anthropic.length, 0);
});

test("an admin's call is not held against a budget, as in ai-proxy, and is still metered", async () => {
  resetWorld(); harness.rawAuth = AUTH_PASS; seed({ admin: true });
  await sendCase(REQUIRED_WORDS);
  assert.equal(harness.anthropic.length, 1);
  assert.equal(harness.ledger.calls.length, 0);
  assert.equal(harness.anthropicCounts.length, 0);
  assert.equal(usage("anthropic").length, 1);
});

// ── Learning from corrections ────────────────────────────────────────────────

test("this account's last corrections go into the prompt, newest first and at most ten, and no one else's", async () => {
  for (let i = 0; i < 12; i++) {
    rows("intake_corrections").push({ id: `c${i}`, user_id: PROFILE, action: "relink_document", before: { section: "inbox", scanType: `type${i}` }, after: { section: "locumContracts" }, created_at: `2026-09-${String(10 + i).padStart(2, "0")}T10:00:00Z` });
  }
  rows("intake_corrections").push(
    { id: "d1", user_id: PROFILE, action: "dismiss_request", before: { intent: "request", asks: ["malpractice certificate"] }, after: { status: "dismissed" }, created_at: "2026-09-27T10:00:00Z" },
    { id: "x1", user_id: OTHER, action: "dismiss_request", before: { intent: "request", asks: ["someone else's DEA"] }, after: { status: "dismissed" }, created_at: "2026-09-28T10:00:00Z" },
  );
  await sendCase(REQUIRED_WORDS);
  const content = harness.anthropic[0].body.messages[0].content;
  const block = content.match(/<corrections>\n([\s\S]*?)\n<\/corrections>/)?.[1] ?? "";
  const lines = block.split("\n");
  assert.equal(lines.length, 10);
  assert.equal(lines[0], "- Dismissed an email that was read as a request for malpractice certificate (read as request): it asked for nothing they would answer.");
  assert.equal(lines[1], "- Moved a forwarded type11 from inbox to locumContracts.");
  assert.ok(!content.includes("someone else"), "another account's corrections never reach this prompt");
  assert.ok(content.indexOf("<corrections>") < content.indexOf("<email>"));
});

// ── cme@ ─────────────────────────────────────────────────────────────────────

test("cme@: a form that rides along with a certificate is not filed, and an ask in the email is pointed to docs@", async () => {
  const c = {
    id: "cme-with-form", subject: "Your certificate", from: { name: "CME Office", address: "cme@neuro-society.example" },
    body: "Dr. Testa,\n\nThank you for attending. Your certificate is attached.\n\nPlease complete the attached course evaluation form.\n\nCME Office",
    attachments: [
      { name: "certificate.pdf", scan: { documentType: "cme", confidence: "high", extracted: { title: "Spine Update 2026", hours: 6, date: "2026-09-12", provider: "Example Neuro Society" } } },
      { name: "evaluation.pdf", scan: { documentType: "other", confidence: "medium", extracted: { name: "Course evaluation", issuer: "Example Neuro Society" } } },
    ],
    modelReply: {
      intent: "mixed",
      asks: [{ quote: "Please complete the attached course evaluation form", kind: "unknown", who: "physician" }],
      attachments: [{ index: 1, role: "credential_for_physician", filing: "CME" }, { index: 2, role: "form_to_complete", filing: "Documents, not filed" }],
      summary: "your CME certificate and a course evaluation", confidence: "high",
    },
  };
  const r = await sendCase(c, { to: "cme@credentialdomd.com" });
  assert.deepEqual(r.body.filed, ["created", "unfiled"]);
  assert.equal(rows("cme").length, 1);
  assert.equal(rows("custom_categories").length, 0, "the evaluation form never becomes a category");
  assert.equal(rows("document_requests").length, 0, "cme@ does not answer requests");
  const text = toPhysician()[0].text;
  assert.match(text, /Filed: Spine Update 2026 -> CME/);
  assert.match(text, /Saved, not filed yet: evaluation\.pdf is a form to fill in, not one of your credentials/);
  assert.match(text, /This email also asks you for something \("Please complete the attached course evaluation form"\)\. Forward it to docs@credentialdomd\.com to answer it from the app\./);
});

test("cme@ with no model reading behaves exactly as it did", async () => {
  resetWorld(); harness.rawAuth = AUTH_PASS; seed({ anthropic: false });
  harness.geminiReply = () => ({ documentType: "other", confidence: "medium", extracted: { name: "Course evaluation", issuer: "Example Neuro Society", suggestedCategory: { name: "Evaluations" } } });
  const r = await deliver({ id: `u${++n}`, from: `Rowan Testa <${ME}>`, to: "cme@credentialdomd.com", subject: "Fwd: eval", text: "Here", attachments: [{ filename: "evaluation.pdf", contentType: "application/pdf", bytes: pdf("eval") }] });
  assert.deepEqual(r.body.filed, ["created"], "the scanner decides, as before");
  assert.equal(harness.anthropic.length, 0);
});

test("nothing the physician is sent carries an em dash, even when the model's summary does", async () => {
  seedContracts();
  await sendCase(INFO, { anthropicReply: () => ({ ...INFO.modelReply, summary: `the agency policy ${EM_DASH} emergency care, see https://phish.example/x` }) });
  const text = toPhysician()[0].text;
  assert.ok(!text.includes(EM_DASH), text);
  assert.ok(!text.includes("phish.example"), "a link in the model's summary is never repeated");
  assert.match(text, /^Read Jordan Sample's note about the agency policy, emergency care, see\. Nothing was asked of you\./);
});
