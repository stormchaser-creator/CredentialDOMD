// A physician's ticket asked that an emailed documentation request have its
// own typed message read along with its attachments, not instead of them.
//
// rulesUnderstanding (supabase/functions/_shared/intakeUnderstanding.mjs) is
// the fallback reading used when the model path is unavailable. It always
// parses the sender's own message for asks (parseAsks) and keeps them beside
// any ask it reads from an attachment (attachmentAsks): the attachment path
// only ever adds to what the message already found, it never replaces it.
// This pins that combination on the rules path, with no product change: the
// code already keeps both.
//
// Every email, name and address here is synthetic.
// Run: node --test tests/email-attachment-message-read-with-attachment.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { rulesUnderstanding } from "../supabase/functions/_shared/intakeUnderstanding.mjs";
import { attachmentText } from "../supabase/functions/_shared/intakeFacts.mjs";

const LETTER_SCAN = {
  documentType: "other",
  confidence: "medium",
  extracted: { name: "Reappointment request letter", issuer: "Osterly Example Health" },
  request_lead_in: "Please send the following documents to complete your reappointment file",
  requested_items: ["Current DEA certificate", "Current BLS card"],
};

test("the rules fallback keeps the sender's own typed request alongside an attachment's own asks", () => {
  const r = rulesUnderstanding({
    subject: "Reappointment file",
    body: "Please also send your updated malpractice certificate by Friday.",
    attachmentNames: ["Hospital_Letter.pdf"],
    attachmentCount: 1,
    forwarded: false,
    attachmentWords: [attachmentText(LETTER_SCAN)],
    attachmentTypes: ["other"],
  });

  const ownMessage = r.asks.filter((a) => a.from !== "attachment").map((a) => a.quote);
  const fromAttachment = r.asks.filter((a) => a.from === "attachment").map((a) => a.quote);
  assert.ok(ownMessage.some((q) => /malpractice certificate/.test(q)), "the sender's own typed ask must survive");
  assert.deepEqual(fromAttachment, ["Current DEA certificate", "Current BLS card"], "the attachment's own asks must survive alongside it");
});
