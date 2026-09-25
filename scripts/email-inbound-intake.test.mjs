// End to end through supabase/functions/email-inbound/index.ts: a forwarded
// document is recognised, read, filed and reported, and nothing is rejected.
//
// The function runs under node (types stripped) with its network edges
// replaced by scripts/email-inbound-harness.mjs: an in-memory database, a fake
// Resend and a fake Gemini. The first case is the email that started this, on
// 2026-09-25: Sanford Health Plan's credentialing approval letter, forwarded to
// docs@ to keep, which became a "request" asking the physician what
// "Whitney, DO" meant while the letter itself sat unfiled.
// Run: node --test scripts/email-inbound-intake.test.mjs
import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadFunction, resetWorld, deliver, harness } from "./email-inbound-harness.mjs";
import { makeDocx, makeXlsx } from "./fixtures/intake/zip.mjs";

const PROFILE = "a676337e-16be-44be-a4c3-9b28b16a3966";
const CLERK = "user_abc123";
const ME = "stormchaser@elryx.com";
const EM_DASH = String.fromCodePoint(0x2014);
const SANFORD_BODY = readFileSync(new URL("./fixtures/intake/sanford-approval-body.txt", import.meta.url), "utf8");
const SANFORD_SUBJECT = "Fwd: Sanford Health Plan Initial Application Approval Letter for Eric E. Whitney, DO";
const SANFORD_TEXT = `---------- Forwarded message ---------
From: Verification Services <verificationservices@sanfordhealth.org>
Date: Thu, Sep 25, 2026 at 9:02 AM
Subject: Sanford Health Plan Initial Application Approval Letter for Eric
${SANFORD_BODY}`;
const SANFORD_SCAN = {
  documentType: "privilege", confidence: "high",
  extracted: {
    type: "Credentialing Approval", name: "Sanford Health Plan Credentialing Approval", facility: "Sanford Health Plan",
    state: "ND", appointmentDate: "2026-09-24", expirationDate: "2027-09-30", providerNumber: "330567",
  },
};
const pdf = (s) => new TextEncoder().encode(`%PDF-1.4 ${s}`);
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const letter = () => ({ filename: "Letter330567.pdf", contentType: "application/pdf", bytes: pdf("sanford approval 330567") });

let n = 0;
const send = (over = {}) => deliver({
  id: `e${++n}`, from: `Eric Whitney <${ME}>`, to: "docs@credentialdomd.com", subject: SANFORD_SUBJECT, text: SANFORD_TEXT,
  attachments: [letter()], ...over,
});
const db = () => harness.db;
const rows = (t) => db().rows(t);
const toPhysician = () => harness.sent.filter((m) => m.to?.[0] === ME);
const toOthers = () => harness.sent.filter((m) => m.to?.[0] !== ME);

function seed({ access = "active", degree = "DO" } = {}) {
  rows("mailbox_claims").push({ address: ME, profile_id: PROFILE, proof: "verified", terminal_at: null });
  rows("profiles").push({ id: PROFILE, auth_user_id: CLERK, email: ME, access_status: access, verified_email: ME, deleted_at: null, name: "Eric Whitney", degree_type: degree, ack_requests: true });
  rows("app_secrets").push({ name: "gemini_shared_key", value: "AIza-test" });
}

before(async () => { await loadFunction(); });
beforeEach(() => { resetWorld(); seed(); });

test("Sanford: an approval letter forwarded to docs@ is filed under Privileges, not read as a request", async () => {
  harness.geminiReply = () => SANFORD_SCAN;
  const r = await send();
  assert.equal(r.status, 200);
  assert.equal(r.body.intent, "delivery");

  assert.equal(rows("document_requests").length, 0, "no request row");
  assert.equal(toOthers().length, 0, "nothing is sent to Sanford or anyone else");
  const [reply] = toPhysician();
  assert.equal(toPhysician().length, 1);
  assert.equal(reply.from, "CredentialDOMD <docs@credentialdomd.com>");
  assert.ok(reply.text.includes("Filed: Sanford Health Plan credentialing approval -> Privileges (approved 09/24/2026, expires 09/30/2027)"), reply.text);
  assert.ok(!/could not tell|Whitney, DO/.test(reply.text), reply.text);
  assert.ok(!reply.text.includes(EM_DASH));
  assert.ok(reply.text.includes("\n\n"), "real line breaks");

  const [priv] = rows("privileges");
  assert.equal(rows("privileges").length, 1);
  assert.equal(priv.user_id, PROFILE);
  assert.equal(priv.facility, "Sanford Health Plan");
  assert.equal(priv.appointment_date, "2026-09-24");
  assert.equal(priv.expiration_date, "2027-09-30");
  assert.equal(priv.favorite, false);
  assert.deepEqual(priv.custom_fields, { "Provider Number": "330567" }, "a field privileges has no column for is kept, not dropped");
  assert.ok(!("provider_number" in priv));

  const [doc] = rows("documents");
  assert.equal(doc.linked_to, `privileges:${priv.id}`);
  assert.equal(doc.name, "Sanford Health Plan - credentialing approval.pdf");
  assert.equal(doc.type, "application/pdf", "a filed document leaves the inbox");
  assert.equal(doc.storage_path, `${CLERK}/${doc.id}`);
  assert.ok(db().files.has(doc.storage_path), "the bytes are in Storage");

  // The scan used the app's prompt, with the physician's degree.
  assert.equal(harness.gemini.length, 1);
  const call = harness.gemini[0];
  assert.match(call.url, /models\/gemini-3\.8-flash:generateContent\?key=AIza-test$/);
  assert.match(call.body.systemInstruction.parts[0].text, /The physician is a DO/);
  assert.equal(call.body.contents[0].parts[0].inlineData.mimeType, "application/pdf");
  assert.equal(call.body.generationConfig.maxOutputTokens, 8192);

  const [usage] = rows("ai_usage");
  assert.equal(rows("ai_usage").length, 1, "one metered row per call");
  assert.equal(usage.user_id, PROFILE);
  assert.equal(usage.provider, "gemini");
  assert.equal(usage.model, "gemini-3.8-flash");
  assert.equal(usage.path, "models/gemini-3.8-flash:generateContent");
  assert.equal(usage.ok, true);
  assert.equal(usage.input_tokens, 1200);
  assert.ok(usage.cost_usd > 0);
  assert.ok(usage.prompt_chars > 1000);

  const [ledger] = rows("inbound_emails");
  assert.equal(ledger.status, "done");
  assert.match(ledger.detail, /^delivery, stored 1, duplicates 0, filed 1/);
  assert.ok(!/ack sent/i.test(ledger.detail));
});

test("the same letter forwarded again is not stored or filed twice", async () => {
  harness.geminiReply = () => SANFORD_SCAN;
  await send();
  const r = await send();
  assert.deepEqual(r.body.filed, ["already"]);
  assert.equal(rows("documents").length, 1);
  assert.equal(rows("privileges").length, 1);
  assert.equal(harness.gemini.length, 1, "an already filed document is not read again");
  assert.match(toPhysician().at(-1).text, /Already filed: Sanford Health Plan - credentialing approval\.pdf/);
});

test("the letter left unfiled by the old flow is filed when it is forwarded again", async () => {
  // What production holds today: documents 3d81af20, a request attachment, never filed.
  rows("documents").push({
    id: "3d81af20-ab10-4f82-8606-7b1105e07e96", user_id: PROFILE, name: "Letter330567.pdf", mime_type: "application/pdf",
    size_bytes: letter().bytes.byteLength, size: letter().bytes.byteLength, storage_path: `${CLERK}/3d81af20-ab10-4f82-8606-7b1105e07e96`,
    linked_to: null, type: "request-attachment-inbox",
  });
  harness.geminiReply = () => SANFORD_SCAN;
  const r = await send();
  assert.deepEqual(r.body.filed, ["created"]);
  assert.equal(rows("documents").length, 1, "the existing row is filed, not a second copy");
  const [doc] = rows("documents");
  assert.equal(doc.linked_to, `privileges:${rows("privileges")[0].id}`);
  assert.equal(doc.type, "application/pdf");
});

test("a renewal adds to the record on file: empty fields filled, nothing overwritten, and the expiration is left for the physician", async () => {
  rows("privileges").push({ id: "p1", user_id: PROFILE, type: "Full Admitting Privileges", name: "Sanford", facility: "Sanford Health Plan, Inc.", state: null, appointment_date: "2025-09-24", expiration_date: "2026-09-30", custom_fields: null, favorite: true });
  harness.geminiReply = () => SANFORD_SCAN;
  const r = await send();
  assert.deepEqual(r.body.filed, ["updated"]);
  assert.equal(rows("privileges").length, 1);
  const [p] = rows("privileges");
  assert.equal(p.type, "Full Admitting Privileges", "a filled field is never overwritten");
  assert.equal(p.appointment_date, "2025-09-24");
  assert.equal(p.state, "ND", "an empty field is filled");
  // Never moved by email: a misread or forged date that extends a
  // credential switches off the reminder that stops it lapsing.
  assert.equal(p.expiration_date, "2026-09-30", "the record's expiration is not moved");
  assert.equal(p.favorite, true);
  const text = toPhysician()[0].text;
  assert.match(text, /Added to an existing record: .* -> Privileges \(filled \d+ empty fields?\)/);
  assert.match(text, /This file shows an expiration of 09\/30\/2027; your record shows 09\/30\/2026\. The date on your record was not changed/);
  assert.equal(rows("documents")[0].linked_to, "privileges:p1");
});

test("an earlier expiration never moves the date back", async () => {
  rows("privileges").push({ id: "p1", user_id: PROFILE, type: "Other", facility: "Sanford Health Plan", appointment_date: "2026-09-24", expiration_date: "2028-09-30", state: "ND", name: "x", custom_fields: { "Provider Number": "330567" } });
  harness.geminiReply = () => SANFORD_SCAN;
  const r = await send();
  assert.deepEqual(r.body.filed, ["linked"]);
  assert.equal(rows("privileges")[0].expiration_date, "2028-09-30");
  assert.match(toPhysician()[0].text, /the file is now attached to it/);
});

test("a request with no attachment is still a request (unchanged)", async () => {
  const r = await send({
    subject: "Fwd: Board certificate",
    text: `---------- Forwarded message ---------
From: Marisol Castellano <m.castellano@ruhealth.example>
Date: Thu, Sep 11, 2026
Subject: BOARD CERTIFICATE
To: Eric Whitney <${ME}>

Hello Dr Whitney

Can you please send me a copy of your board certificate.  Thank you`,
    attachments: [],
  });
  assert.equal(r.body.intent, "request");
  assert.equal(rows("document_requests").length, 1);
  assert.equal(harness.gemini.length, 0);
  assert.deepEqual(rows("document_requests")[0].proposal.items.map((i) => i.ask), ["board certificate"]);
});

test("a checklist request keeps its attachment with the request, unfiled", async () => {
  const r = await send({
    subject: "Fwd: Reappointment",
    text: `---------- Forwarded message ---------
From: Kyle Ortega <k.ortega@penrose.example>
Date: Thu, Sep 11, 2026
Subject: Reappointment
To: Eric Whitney <${ME}>

Dr. Whitney,

We need the following to complete your reappointment:
- Colorado license
- DEA
- Please complete the attached reappointment application

Thanks,
Kyle`,
    attachments: [{ filename: "Reappointment_Application.pdf", contentType: "application/pdf", bytes: pdf("form") }],
  });
  assert.equal(r.body.intent, "request");
  assert.equal(rows("document_requests").length, 1);
  assert.equal(harness.gemini.length, 0, "a request's checklist is not filed as a credential");
  assert.equal(rows("documents")[0].type, "request-attachment-inbox");
});

test("both: the approval is filed, the form stays with the request, and the request is made", async () => {
  harness.geminiReply = () => SANFORD_SCAN;
  const r = await send({
    subject: "Fwd: Your appointment",
    text: `---------- Forwarded message ---------
From: Medical Staff <medstaff@sanfordhealth.example>
Date: Thu, Sep 25, 2026
Subject: Your appointment
To: Eric Whitney <${ME}>

Congratulations, your application has been approved. Attached is your approval letter.

Please sign and return the attached attestation by 10/1.`,
    attachments: [letter(), { filename: "Attestation_Form.pdf", contentType: "application/pdf", bytes: pdf("attestation form") }],
  });
  assert.equal(r.body.intent, "both");
  assert.equal(rows("privileges").length, 1);
  assert.equal(rows("document_requests").length, 1);
  const docs = rows("documents");
  assert.equal(docs.find((d) => d.name === "Attestation_Form.pdf")?.type, "request-attachment-inbox");
  assert.ok(docs.some((d) => d.linked_to?.startsWith("privileges:")));
  assert.equal(harness.gemini.length, 1, "only the finished document is read");
  const summary = toPhysician()[0].text;
  assert.match(summary, /From the same email:\nFiled: Sanford Health Plan credentialing approval -> Privileges/);
  // The filed letter is never proposed back to the people who sent it.
  const proposal = rows("document_requests")[0].proposal;
  const filedId = docs.find((d) => d.linked_to?.startsWith("privileges:")).id;
  assert.ok(!proposal.docIds.includes(filedId));
});

test("cme@: a certificate becomes a CME entry and the reply says so", async () => {
  harness.geminiReply = () => ({ documentType: "cme", confidence: "high", extracted: { title: "Spine Summit 2026", category: "AMA PRA Category 1", hours: "7.5", date: "2026-08-14", provider: "AANS", topics: ["Opioid Prescribing", 3] } });
  const r = await send({ to: "cme@credentialdomd.com", subject: "Fwd: certificate", text: "Here you go", attachments: [{ filename: "cert.pdf", contentType: "application/pdf", bytes: pdf("cme") }] });
  assert.deepEqual(r.body.filed, ["created"]);
  const [c] = rows("cme");
  assert.equal(c.hours, 7.5);
  assert.deepEqual(c.topics, ["Opioid Prescribing"]);
  assert.equal(c.date, "2026-08-14");
  assert.equal(rows("documents")[0].linked_to, `cme:${c.id}`);
  assert.equal(rows("documents")[0].type, "application/pdf");
  const reply = toPhysician()[0];
  assert.equal(reply.from, "CredentialDOMD <whit@credentialdomd.com>");
  assert.match(reply.text, /Filed: Spine Summit 2026 -> CME \(7\.5 hours, completed 08\/14\/2026\)/);
  assert.match(reply.text, /Import transcript/);
});

test("a receipt is kept in the inbox under a readable name, because Expenses or Deductions is the physician's call", async () => {
  harness.geminiReply = () => ({ documentType: "receipt", confidence: "high", extracted: { merchant: "Alamo Rent A Car", date: "2026-09-12", total: 45.2, category: "Tolls" } });
  const r = await send({ subject: "Fwd: your receipt", text: "Please find attached your receipt.", attachments: [{ filename: "r.pdf", contentType: "application/pdf", bytes: pdf("receipt") }] });
  assert.deepEqual(r.body.filed, ["unfiled"]);
  const [doc] = rows("documents");
  assert.equal(doc.type, "email-inbox");
  assert.equal(doc.linked_to, null);
  assert.equal(doc.name, "Receipt - Alamo Rent A Car - 2026-09-12.pdf");
  assert.match(toPhysician()[0].text, /Saved, not filed yet: r\.pdf, a receipt from Alamo Rent A Car for \$45\.20 on 09\/12\/2026 \(open the app > Documents to file it\)/);
});

test("a scan that fails leaves the file in the inbox and says so; the call is still metered", async () => {
  harness.geminiReply = () => ({ status: 503, text: JSON.stringify({ error: { message: "overloaded" } }) });
  const r = await send();
  assert.deepEqual(r.body.filed, ["unfiled"]);
  assert.equal(rows("documents")[0].type, "email-inbox");
  assert.equal(rows("privileges").length, 0);
  assert.match(toPhysician()[0].text, /Saved, not filed yet: Letter330567\.pdf \(open the app > Documents to file it\)/);
  assert.equal(rows("ai_usage").length, 1);
  assert.equal(rows("ai_usage")[0].ok, false);
  assert.equal(rows("ai_usage")[0].status, 503);
});

test("one attachment failing to file does not stop the next", async () => {
  let calls = 0;
  harness.geminiReply = () => (++calls === 1 ? SANFORD_SCAN : { documentType: "license", confidence: "high", extracted: { type: "DEA Registration", name: "DEA Registration", licenseNumber: "FW1234567", state: "ND", expirationDate: "2028-01-31" } });
  harness.failInsert = (table) => (table === "privileges" ? "privileges is down" : null);
  const r = await send({ attachments: [letter(), { filename: "dea.pdf", contentType: "application/pdf", bytes: pdf("dea") }] });
  assert.deepEqual(r.body.filed.sort(), ["created", "unfiled"]);
  assert.equal(rows("licenses").length, 1);
  const byName = Object.fromEntries(rows("documents").map((d) => [d.linked_to ? "filed" : "inbox", d]));
  assert.equal(byName.inbox.type, "email-inbox");
  assert.match(toPhysician()[0].text, /Saved, not filed yet: Letter330567\.pdf/);
  assert.match(toPhysician()[0].text, /Filed: DEA Registration -> Licenses \(expires 01\/31\/2028\)/);
});

test("an 'other' document creates the physician's category once, then files into it", async () => {
  const badge = (num) => ({ documentType: "other", confidence: "high", extracted: {
    name: "Sanford Hospital ID Badge", issuer: "Sanford Health", number: num, expirationDate: "2027-12-31",
    facts: [{ label: "Department", value: "Neurosurgery" }, { label: "Patient MRN", value: "00481234" }],
    suggestedCategory: { name: "Hospital ID Badges", icon: "\u{1FAAA}", fields: ["Department", "Badge number"] },
  } });
  harness.geminiReply = () => badge("B-100");
  await send({ subject: "Fwd: badge", text: "For your records.", attachments: [{ filename: "badge.jpg", contentType: "image/jpeg", bytes: pdf("badge1") }] });
  const [cat] = rows("custom_categories");
  assert.equal(rows("custom_categories").length, 1);
  assert.equal(cat.name, "Hospital ID Badges");
  assert.equal(cat.origin, "uploader");
  assert.equal(cat.user_id, PROFILE);
  const [rec] = rows("custom_records");
  assert.equal(rec.category_id, cat.id);
  assert.deepEqual(rec.document_ids, [rows("documents")[0].id]);
  assert.ok(!JSON.stringify(rows("custom_records")).includes("00481234"), "a patient MRN is never stored");
  assert.match(toPhysician()[0].text, /Created a new category: Hospital ID Badges\nFiled: Sanford Hospital ID Badge -> Hospital ID Badges \(expires 12\/31\/2027\)/);
  assert.match(toPhysician()[0].text, /Left out on purpose: a medical record number/);

  // Hidden later, then a second badge arrives: the category comes back, no twin.
  cat.archived_at = "2026-09-26T00:00:00Z";
  harness.geminiReply = () => ({ ...badge("B-200"), extracted: { ...badge("B-200").extracted, name: "Sanford Parking Badge", suggestedCategory: { name: "hospital id badge" } } });
  await send({ subject: "Fwd: badge 2", text: "For your records.", attachments: [{ filename: "badge2.jpg", contentType: "image/jpeg", bytes: pdf("badge2") }] });
  assert.equal(rows("custom_categories").length, 1, "case and plural do not make a second category");
  assert.equal(rows("custom_categories")[0].archived_at, null, "filing into a hidden category brings it back");
  assert.equal(rows("custom_records").length, 2);
});

test("a file that reads as a patient record is deleted, as the app does on upload", async () => {
  harness.geminiReply = () => ({ documentType: "unknown", confidence: "low", extracted: { note: "Operative note. Patient name: J. Doe. MRN 00481234. Date of birth 03/14/1961. Pre-op diagnosis: SDH" } });
  const r = await send({ subject: "Fwd: op note", text: "see attached", attachments: [{ filename: "op-note.pdf", contentType: "application/pdf", bytes: pdf("op note") }] });
  assert.deepEqual(r.body.filed, ["removed"]);
  assert.equal(rows("documents").length, 0);
  assert.equal(db().files.size, 0);
  assert.match(toPhysician()[0].text, /Not kept: op-note\.pdf reads like a patient record/);
});

test("an account that may not use the shared key keeps the file, unread", async () => {
  resetWorld();
  seed({ access: "pending" });
  const r = await send();
  assert.deepEqual(r.body.filed, ["unfiled"]);
  assert.equal(harness.gemini.length, 0);
  assert.equal(rows("documents").length, 1);
  assert.equal(rows("documents")[0].type, "email-inbox");
});

test("a contract is Practice scope: a Credential-only membership keeps it unfiled, never half-written", async () => {
  harness.access = { credential: true, practice: false };
  harness.geminiReply = () => ({ documentType: "agreement", confidence: "high", extracted: { facility: "Penrose Hospital", agency: "Weatherby", startDate: "2026-10-01", endDate: "2026-10-14", hourlyRate: 250 } });
  const r = await send({ subject: "Fwd: your agreement", text: "Attached is your signed agreement for your records.", attachments: [{ filename: "agreement.pdf", contentType: "application/pdf", bytes: pdf("contract") }] });
  assert.deepEqual(r.body.filed, ["unfiled"]);
  assert.equal(rows("locum_contracts").length, 0);
  assert.equal(rows("documents")[0].linked_to, null);

  resetWorld(); seed();
  harness.geminiReply = () => ({ documentType: "agreement", confidence: "high", extracted: { facility: "Penrose Hospital", agency: "Weatherby", startDate: "2026-10-01", endDate: "2026-10-14", hourlyRate: 250 } });
  const ok = await send({ subject: "Fwd: your agreement", text: "Attached is your signed agreement for your records.", attachments: [{ filename: "agreement.pdf", contentType: "application/pdf", bytes: pdf("contract") }] });
  assert.deepEqual(ok.body.filed, ["created"]);
  assert.equal(rows("locum_contracts")[0].hourly_rate, 250);
  assert.equal(rows("documents")[0].linked_to, `locumContracts:${rows("locum_contracts")[0].id}`);
});

test("a Word document is screened, then kept for File with AI instead of being refused", async () => {
  const cv = makeDocx(["Eric Whitney, DO", "Curriculum Vitae", "Neurological Surgery"]);
  const r = await send({ subject: "Fwd: CV", text: "Attached is my updated CV.", attachments: [{ filename: "Whitney CV.docx", contentType: DOCX, bytes: cv }] });
  assert.equal(r.body.intent, "delivery");
  assert.equal(rows("documents").length, 1);
  assert.equal(rows("documents")[0].type, "email-inbox");
  assert.equal(harness.gemini.length, 0, "the server cannot read a .docx; the app can");
  assert.match(toPhysician()[0].text, /Saved, not filed yet: Whitney CV\.docx/);
});

test("an attachment that cannot be kept is named in the reply, never dropped silently", async () => {
  harness.geminiReply = () => SANFORD_SCAN;
  await send({ attachments: [letter(), { filename: "original message.eml", contentType: "message/rfc822", bytes: pdf("eml") }, { filename: "smime.p7s", contentType: "application/pkcs7-signature", bytes: pdf("sig") }] });
  const text = toPhysician()[0].text;
  assert.match(text, /Filed: Sanford Health Plan credentialing approval -> Privileges/);
  assert.match(text, /Not kept: original message\.eml\. Only PDFs, photos and Word, Excel or text files are saved/);
  assert.ok(!text.includes("smime.p7s"), "a mail signature is not a document");
  assert.equal(rows("documents").length, 1);
});

test("no reply ever carries an em dash, even when the scan does", async () => {
  harness.geminiReply = () => ({ ...SANFORD_SCAN, extracted: { ...SANFORD_SCAN.extracted, facility: `Sanford ${EM_DASH} Fargo` } });
  await send();
  for (const m of harness.sent) assert.ok(!m.text.includes(EM_DASH), m.text);
  assert.ok(!rows("documents")[0].name.includes(EM_DASH));
});

// ---- Review of 2026-09-25 -------------------------------------------------

const forwardFrom = (who, subject, body) => `---------- Forwarded message ---------
From: ${who}
Date: Thu, Sep 25, 2026
Subject: ${subject}
To: Eric Whitney <${ME}>

${body}`;

test("a request with a form attached is still a request: the row, the summary, and the form stays with it", async () => {
  harness.geminiReply = () => SANFORD_SCAN;
  const r = await send({
    subject: "Fwd: Application",
    text: forwardFrom("Kim Lee <kim.lee@stmarys.example>", "Application", "Dr. Whitney,\n\nPlease fill out the attached application and return it to me by Friday.\n\nThanks,\nKim"),
    attachments: [{ filename: "Whitney_Sanford.pdf", contentType: "application/pdf", bytes: pdf("blank application") }],
  });
  assert.equal(r.body.intent, "request");
  assert.equal(rows("document_requests").length, 1, "the request is made");
  assert.equal(rows("privileges").length, 0, "the requester's form is not filed as the physician's record");
  assert.equal(harness.gemini.length, 0);
  assert.equal(rows("documents")[0].type, "request-attachment-inbox");
  assert.equal(rows("documents")[0].linked_to, null);
});

test("both: blank forms and generically named files stay with the request; only a finished credential is filed", async () => {
  // The blank privileges delineation reads as a privilege at St. Mary's, with no dates.
  harness.geminiReply = () => ({ documentType: "privilege", confidence: "medium", extracted: { facility: "St. Mary's Hospital", type: "Neurosurgery core privileges" } });
  const r = await send({
    subject: "Fwd: Welcome",
    text: forwardFrom("Medical Staff <medstaff@stmarys.example>", "Welcome", "Welcome to St. Mary's! Attached is your initial appointment packet. Please complete and return both documents by 10/15."),
    attachments: [
      { filename: "StMarys_Initial_Application.pdf", contentType: "application/pdf", bytes: pdf("application") },
      { filename: "Whitney_Privileges.pdf", contentType: "application/pdf", bytes: pdf("delineation") },
      { filename: "COI Request Form.pdf", contentType: "application/pdf", bytes: pdf("coi form") },
      // Named like the finished document, but blank: the scan has no dates.
      { filename: "DEA Registration.pdf", contentType: "application/pdf", bytes: pdf("blank dea") },
    ],
  });
  assert.equal(r.body.intent, "both");
  assert.equal(rows("document_requests").length, 1);
  assert.equal(rows("privileges").length, 0, "no phantom privilege at St. Mary's");
  assert.equal(rows("insurance").length, 0);
  for (const d of rows("documents")) {
    assert.equal(d.type, "request-attachment-inbox", `${d.name} stays with the request`);
    assert.equal(d.linked_to, null, d.name);
  }
  assert.equal(harness.gemini.length, 2, "files named like forms are not even read");
});

test("an unverified forward keeps and reads its files but writes nothing to the records", async () => {
  // SPF passes for the attacker's own envelope domain, nothing is aligned,
  // and the physician's domain publishes no DMARC: not a failure, not a pass.
  harness.rawAuth = "mx.resend.com; spf=pass smtp.mailfrom=bounce.attacker.example; dkim=none; dmarc=none header.from=elryx.com";
  rows("licenses").push({ id: "dea", user_id: PROFILE, type: "DEA Registration", name: "DEA Registration", license_number: "FW1234567", state: "ND", expiration_date: "2025-10-31" });
  harness.geminiReply = () => ({ documentType: "license", confidence: "high", extracted: { type: "DEA Registration", licenseNumber: "FW1234567", state: "ND", issuedDate: "2026-01-01", expirationDate: "2030-10-31" } });
  const r = await send({ subject: "Fwd: DEA", text: "Attached is your renewed DEA registration.", attachments: [{ filename: "DEA certificate.pdf", contentType: "application/pdf", bytes: pdf("fake dea") }] });
  assert.equal(r.body.intent, "delivery");
  assert.equal(r.body.verified, false);
  assert.deepEqual(r.body.filed, ["unfiled"]);
  assert.equal(harness.gemini.length, 1, "still read, so a patient record would still be caught");
  assert.deepEqual(rows("licenses"), [{ id: "dea", user_id: PROFILE, type: "DEA Registration", name: "DEA Registration", license_number: "FW1234567", state: "ND", expiration_date: "2025-10-31" }], "the record is untouched");
  const [doc] = rows("documents");
  assert.equal(doc.linked_to, null);
  assert.equal(doc.type, "email-inbox");
  const text = toPhysician()[0].text;
  assert.match(text, /Saved, not filed yet: DEA certificate\.pdf, which reads as DEA Registration -> Licenses\. This message could not be verified as coming from you, so nothing in your records was added or changed/);
  assert.match(text, /Mail from elryx\.com arrives without a DMARC pass or a DKIM signature for elryx\.com/);

  // cme@ holds the same line.
  resetWorld(); seed();
  harness.rawAuth = "mx.resend.com; spf=pass smtp.mailfrom=bounce.attacker.example; dkim=none; dmarc=none";
  harness.geminiReply = () => ({ documentType: "cme", confidence: "high", extracted: { title: "Spine Summit 2026", hours: 7.5, date: "2026-08-14" } });
  const c = await send({ to: "cme@credentialdomd.com", subject: "Fwd: certificate", text: "Here you go", attachments: [{ filename: "cert.pdf", contentType: "application/pdf", bytes: pdf("cme") }] });
  assert.equal(c.body.verified, false);
  assert.equal(rows("cme").length, 0);
  assert.equal(rows("documents")[0].linked_to, null);

  // A patient record is still caught and removed on an unverified forward.
  resetWorld(); seed();
  harness.rawAuth = "mx.resend.com; spf=none; dkim=none; dmarc=none";
  harness.geminiReply = () => ({ documentType: "unknown", confidence: "low", extracted: { note: "Operative note. Patient name: J. Doe. MRN 00481234." } });
  const op = await send({ subject: "Fwd: op note", text: "see attached", attachments: [{ filename: "op-note.pdf", contentType: "application/pdf", bytes: pdf("op note") }] });
  assert.deepEqual(op.body.filed, ["removed"]);
  assert.equal(rows("documents").length, 0);
  assert.equal(db().files.size, 0);
  assert.ok(!/could not be verified/.test(toPhysician()[0].text), "nothing was withheld for want of verification");
});

test("a second DEA with another number is its own record; the old one keeps its number and date", async () => {
  rows("licenses").push({ id: "dea", user_id: PROFILE, type: "DEA Registration", name: "DEA Registration", license_number: "FW1234567", state: "ND", expiration_date: "2025-10-31" });
  harness.geminiReply = () => ({ documentType: "license", confidence: "high", extracted: { type: "DEA Registration", name: "DEA Registration", licenseNumber: "FW7654321", state: "ND", expirationDate: "2029-10-31" } });
  const r = await send({ subject: "Fwd: DEA", text: "Attached is your DEA registration.", attachments: [{ filename: "dea.pdf", contentType: "application/pdf", bytes: pdf("dea 2") }] });
  assert.deepEqual(r.body.filed, ["created"]);
  assert.equal(rows("licenses").length, 2);
  const old = rows("licenses").find((l) => l.id === "dea");
  assert.equal(old.license_number, "FW1234567");
  assert.equal(old.expiration_date, "2025-10-31");
});

test("a patient record whose file cannot be removed keeps its row and says so, instead of claiming it was deleted", async () => {
  harness.geminiReply = () => ({ documentType: "unknown", confidence: "low", extracted: { note: "Operative note. Patient name: J. Doe. MRN 00481234. Date of birth 03/14/1961." } });
  harness.failRemove = () => "storage is down";
  const r = await send({ subject: "Fwd: op note", text: "see attached", attachments: [{ filename: "op-note.pdf", contentType: "application/pdf", bytes: pdf("op note") }] });
  assert.deepEqual(r.body.filed, ["unfiled"]);
  assert.equal(rows("documents").length, 1, "the row stays, so the file can still be found and deleted");
  assert.equal(db().files.size, 1);
  const text = toPhysician()[0].text;
  assert.match(text, /could not be deleted automatically\. Open the app > Documents and delete it/);
  assert.ok(!/was deleted/.test(text), text);
});

test("an office file that reads as a patient record is never stored, on docs@ and on cme@", async () => {
  const csv = new TextEncoder().encode("Case log export\nPatient Name,MRN,Procedure\nJ Doe,MRN 00481234,Operative note: craniotomy\n");
  const r = await send({ subject: "Fwd: case log", text: "Attached is my case log for your records.", attachments: [{ filename: "case_log_2026.csv", contentType: "text/csv", bytes: csv }] });
  assert.equal(r.body.stored, 0);
  assert.equal(rows("documents").length, 0, "no documents row");
  assert.equal(db().files.size, 0, "no Storage upload");
  assert.equal(harness.gemini.length, 0);
  assert.match(toPhysician()[0].text, /Not kept: case_log_2026\.csv reads like a patient record \(it contains a medical record number/);

  const xlsx = makeXlsx(["Patient Name", "MRN", "Discharge summary"]);
  await send({ to: "cme@credentialdomd.com", subject: "Fwd: log", text: "log", attachments: [{ filename: "log.xlsx", contentType: XLSX, bytes: xlsx }] });
  assert.equal(rows("documents").length, 0);
  assert.equal(db().files.size, 0);
  assert.match(toPhysician().at(-1).text, /Not kept: log\.xlsx reads like a patient record/);
});

test("an office file that cannot be read cannot be screened, so it is not stored, and the reply says what to send instead", async () => {
  harness.geminiReply = () => SANFORD_SCAN;
  const r = await send({ attachments: [letter(), { filename: "old.doc", contentType: "application/msword", bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]) }] });
  assert.deepEqual(r.body.filed, ["created"]);
  assert.equal(rows("documents").length, 1, "only the letter is stored");
  assert.match(toPhysician()[0].text, /Not kept: old\.doc could not be read here, so it could not be checked for patient information\. Save it as a PDF, \.docx or \.xlsx and forward it again\./);
});
