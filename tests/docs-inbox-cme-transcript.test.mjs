// A CME certificate mailed to docs@ with a one-line signature, read by the
// rules (the model call was unavailable). Shaped like the email of
// 2026-11-17 (synthetic name and number): subject "OMED CME", body a
// signature, one PDF named "<name>-Transcript-OMED26 CME Attestation and
// Evaluation.pdf". The rules called "Attestation" a blank form and
// then read "Dr. <name>" as the ask, so the certificate was stored as a
// request attachment, unfiled, under a request for the physician's own name.
// Run: node --test tests/docs-inbox-cme-transcript.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { attachmentRole, classifyIntent } from "../supabase/functions/_shared/intakeIntent.mjs";
import { rulesUnderstanding } from "../supabase/functions/_shared/intakeUnderstanding.mjs";

const EMAIL = {
  subject: "OMED CME",
  body: "Dr. Rowan Testa\n555-010-0199",
  attachmentNames: ["Rowan Testa-Transcript-OMED26 CME Attestation and Evaluation.pdf"],
  attachmentCount: 1,
  forwarded: false,
};

test("a CME transcript is a finished document, not a form", () => {
  for (const n of [
    EMAIL.attachmentNames[0],
    "CME_Transcript_2026.pdf",
    "Certificate of Completion - Spine Summit.pdf",
    "Attendance Certificate Attestation.pdf",
  ]) assert.equal(attachmentRole(n), "document", n);
});

test("a blank form stays a form, even beside a transcript word", () => {
  for (const n of ["CME Attestation.pdf", "CME Attestation Form.pdf", "Transcript Request Form.pdf", "Transcript request.pdf", "CME Transcript Checklist.pdf"]) {
    assert.equal(attachmentRole(n), "form", n);
  }
});

test("the email is a delivery, so the certificate is filed and no request is made", () => {
  const rules = classifyIntent(EMAIL);
  assert.equal(rules.intent, "delivery", rules.reasons.join(" | "));
  assert.equal(rules.requestScore, 0);
  const reading = rulesUnderstanding({ ...EMAIL, why: "the AI service answered 400" });
  assert.equal(reading.intent, "delivery");
  assert.equal(reading.unclear, false);
});
