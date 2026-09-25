// supabase/functions/_shared/intakeIntent.mjs: is a docs@ forward a request,
// a document to keep, or both?
//
// The case that started it is first: Sanford Health Plan's credentialing
// approval letter (body verbatim from production, 2026-09-25), which was read
// as a request for "Whitney, DO". Then every request fixture the packet
// matcher is tested on, which must stay requests with or without a file.
// Run: node --test scripts/intake-intent.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyIntent, attachmentRole, currentMessage } from "../supabase/functions/_shared/intakeIntent.mjs";
import { REQUEST_1, REQUEST_2, REQUESTS } from "./request-packet.test.mjs";

const SANFORD = readFileSync(new URL("./fixtures/intake/sanford-approval-body.txt", import.meta.url), "utf8");
const SANFORD_SUBJECT = "Sanford Health Plan Initial Application Approval Letter for Eric";

test("Sanford's approval letter is a delivery", () => {
  const r = classifyIntent({ subject: SANFORD_SUBJECT, body: SANFORD, attachmentNames: ["Letter330567.pdf"], attachmentCount: 1 });
  assert.equal(r.intent, "delivery");
  assert.equal(r.requestScore, 0);
  assert.ok(r.reasons.join(" ").includes("approval letter"), r.reasons.join(" | "));
  // As it arrived: the forward's own subject, Fwd: and all.
  assert.equal(classifyIntent({ subject: `Fwd: ${SANFORD_SUBJECT} E. Whitney, DO`, body: SANFORD, attachmentNames: ["Letter330567.pdf"] }).intent, "delivery");
});

test("with no attachment, anything is a request (unchanged)", () => {
  assert.equal(classifyIntent({ subject: SANFORD_SUBJECT, body: SANFORD, attachmentNames: [], attachmentCount: 0 }).intent, "request");
  assert.equal(classifyIntent({ subject: "Congratulations", body: "Your privileges have been approved." }).intent, "request");
  assert.equal(classifyIntent({}).intent, "request");
});

const REAL_REQUESTS = Object.entries({ REQUEST_1, REQUEST_2, ...REQUESTS })
  // subjectOnly and empty have no body at all; with a file attached they are
  // a document sent with a title, which is the point of "delivery". The
  // Sanford letter is the delivery the first test is about.
  .filter(([name]) => !["subjectOnly", "empty", "sanfordApproval"].includes(name));

test("every request fixture stays a request, with or without an attachment", () => {
  assert.ok(REAL_REQUESTS.length >= 9);
  for (const [name, r] of REAL_REQUESTS) {
    for (const names of [[], ["scan.pdf"], ["Credentialing checklist.pdf"], ["Provider_CV_Request_Form.pdf", "Reappointment_Application.pdf"]]) {
      const c = classifyIntent({ subject: r.subject, body: r.body, attachmentNames: names });
      assert.equal(c.intent, "request", `${name} with ${JSON.stringify(names)}: ${c.reasons.join(" | ")}`);
    }
  }
});

test("a document plus an ask is both", () => {
  const r = classifyIntent({
    subject: "Your appointment",
    body: "Congratulations, your application has been approved. Attached is your approval letter.\n\nPlease sign and return the attached attestation by 10/1.",
    attachmentNames: ["Approval Letter.pdf", "Attestation_Form.pdf"],
  });
  assert.equal(r.intent, "both");
  assert.ok(r.requestScore >= 2 && r.deliveryScore >= 2);
});

test("weak words on both sides do not make 'both'", () => {
  // "certificate" and "your license" lean delivery but never settle it.
  const r = classifyIntent({ subject: "License", body: "Please send your license and your board certificate.", attachmentNames: ["form.pdf"] });
  assert.equal(r.intent, "request");
});

test("delivery phrases", () => {
  const cases = [
    "Please find attached your certificate of insurance.",
    "Attached is your renewed DEA registration.",
    "Enclosed please find your new card. For your records.",
    "This is notification that your license has been renewed.",
    "Congratulations! Welcome to the medical staff.",
  ];
  for (const body of cases) assert.equal(classifyIntent({ subject: "", body, attachmentNames: ["doc.pdf"] }).intent, "delivery", body);
});

test("request phrases", () => {
  const cases = [
    "We still need your DEA before the committee meets.",
    "Could you please provide your current CV?",
    "The following documents are outstanding: DEA, CSR.",
    "Your reappointment application is due by 10/1.",
    "We are missing your TB test.",
    "Required documents:\n1. DEA\n2. Board certificate\n3. CV",
  ];
  for (const body of cases) assert.equal(classifyIntent({ subject: "", body, attachmentNames: ["x.pdf"] }).intent, "request", body);
});

test("a forwarded file with no words at all is a file to keep", () => {
  const r = classifyIntent({ subject: "Fwd:", body: "", attachmentNames: ["scan0001.pdf"] });
  assert.equal(r.intent, "delivery");
  assert.match(r.reasons.join(" "), /file to keep/);
  assert.equal(classifyIntent({ subject: "FYI", body: "fyi", attachmentCount: 2 }).intent, "delivery");
});

test("a quoted request below a delivery does not make it a request", () => {
  const body = `Attached is your approval letter.

On Mon, Sep 1, 2026 at 8:00 AM Credentialing <cred@hosp.example> wrote:
> Please send your DEA and we still need your CV.`;
  assert.equal(classifyIntent({ subject: "", body, attachmentNames: ["letter.pdf"] }).intent, "delivery");
  assert.ok(!currentMessage(body).includes("DEA"));
  // A From: line alone is not a quoted block.
  assert.ok(currentMessage("From: Sanford Health Plan\nPlease see the attached letter.").includes("Please see"));
  assert.ok(!currentMessage("hello\nFrom: A <a@b.c>\nSent: Monday\nSubject: x\nplease send DEA").includes("DEA"));
});

test("attachment names: forms and finished documents", () => {
  assert.equal(attachmentRole("Reappointment_Application.pdf"), "form");
  assert.equal(attachmentRole("Credentialing checklist.pdf"), "form");
  assert.equal(attachmentRole("Attestation_Form.pdf"), "form");
  assert.equal(attachmentRole("Approval Letter.pdf"), "document");
  assert.equal(attachmentRole("Initial Application Approval Letter.pdf"), "document", "a letter about an application is a letter");
  assert.equal(attachmentRole("COI-2026.pdf"), "document");
  assert.equal(attachmentRole("Letter330567.pdf"), "unknown");
  assert.equal(attachmentRole("scan0001.jpg"), "unknown");
});

test("the count wins over the names when both are given", () => {
  assert.equal(classifyIntent({ subject: "", body: "Attached is your letter.", attachmentNames: [], attachmentCount: 1 }).intent, "delivery");
  assert.equal(classifyIntent({ subject: "", body: "Attached is your letter.", attachmentNames: ["a.pdf"], attachmentCount: 0 }).intent, "request");
});
