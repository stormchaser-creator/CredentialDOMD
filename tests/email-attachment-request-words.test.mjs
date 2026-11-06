// A physician forwarded docs@ an email whose documentation request lived in
// an attachment, not in the sender's typed message. The host reported the
// request was "not read properly".
//
// verifyUnderstanding (supabase/functions/_shared/intakeUnderstanding.mjs) is
// the host's check on the model's reading: an ask is kept only when its
// quote is found in the email's own subject, message or quoted history
// (unitsHolding, checked against `parts`). It never checks an ask's quote
// against an attachment's scanned words, even though those words are already
// built for this same call as `facts.attachments` (see
// supabase/functions/email-inbound/index.ts understandEmail, which passes
// `facts` into verifyUnderstanding for exactly this purpose on the records
// side). So an ask whose only source is the attachment is always dropped as
// "not the email's own words", and the request inside the attachment is
// never picked up.
//
// The attachment's words are built the way email-inbound builds them, from
// the scanner's result (intakeFacts.mjs attachmentText), not written by hand:
// until 2026-11-05 attachmentText never read a scan's notes, so a fixture that
// assumed a "notes:" line was testing words the host never had.
//
// Run: node --test tests/email-attachment-request-words.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyUnderstanding } from "../supabase/functions/_shared/intakeUnderstanding.mjs";
import { attachmentText, corpusIndex } from "../supabase/functions/_shared/intakeFacts.mjs";

const factsFor = (parts, subject, attachmentWords) => ({
  corpus: corpusIndex([subject, parts.note, parts.message, parts.history, ...attachmentWords]),
  email: [subject, parts.note, parts.message, parts.history].filter(Boolean).join("\n\n"),
  attachments: attachmentWords,
  refs: new Map(),
  physicianName: "Rowan Testa",
});

test("a documentation request whose words are only in the attachment's scanned text is still picked up as an ask", () => {
  const attachmentWords = attachmentText({ documentType: "other", extracted: {}, notes: "Please send an updated copy of your current DEA registration by 12/15/2026 to complete the reappointment file." });
  const parts = { note: "", message: "See attached.", history: "" };
  const facts = factsFor(parts, "Reappointment file", [attachmentWords]);

  const v = verifyUnderstanding({
    intent: "request",
    asks: [{ quote: "Please send an updated copy of your current DEA registration by 12/15/2026 to complete the reappointment file.", kind: "dea", who: "physician" }],
    attachments: [{ index: 1, role: "request_checklist", filing: "Keep with the request" }],
    summary: "a request for your DEA registration",
    confidence: "high",
    records: [],
  }, { subject: "Reappointment file", parts, attachmentCount: 1, facts });

  assert.equal(v.asks.length, 1, "the ask quoted straight from the attachment's own words should survive, not be dropped");
  assert.equal(v.dropped.length, 0, "no ask should be dropped as 'not the email's own words' when it is the attachment's own words");
  assert.equal(v.unclear, false);
  assert.equal(v.needsRules, false);
  assert.equal(v.asks[0].from, "attachment");
});

test("the email's own message is read together with its attachment, not instead of it", () => {
  const attachmentWords = attachmentText({ documentType: "other", extracted: {}, notes: "Current CPR/BLS certification card and a copy of your state controlled-substance registration are both still outstanding." });
  const parts = { note: "", message: "Please send the items listed in the attached checklist for my reappointment file.", history: "" };
  const facts = factsFor(parts, "Reappointment file", [attachmentWords]);

  const v = verifyUnderstanding({
    intent: "request",
    asks: [
      { quote: "Please send the items listed in the attached checklist for my reappointment file.", kind: "unknown", who: "physician" },
      { quote: "Current CPR/BLS certification card", kind: "bls", who: "physician" },
    ],
    attachments: [{ index: 1, role: "request_checklist", filing: "Keep with the request" }],
    summary: "a request for the items in the attached checklist",
    confidence: "high",
    records: [],
  }, { subject: "Reappointment file", parts, attachmentCount: 1, facts });

  // The message-level ask (the sender's own typed words) already survives
  // today; the point of this test is the second ask, named only in the
  // attachment the same email carried.
  assert.equal(v.asks.length, 2, "both the message's own ask and the attachment's own ask should be kept");
  assert.ok(v.asks.some((a) => a.quote === "Current CPR/BLS certification card"), "the item named only in the attachment should be among the kept asks");
});
