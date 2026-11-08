// Pins two already-fixed parts of the 2026-11-05 incident (a documentation
// request that lived in an email's attachment, not its typed message) that
// had no test of their own:
//
//   - rulesUnderstanding's "silent" check (intakeUnderstanding.mjs, the
//     `silent` branch in rulesUnderstanding): a forward with an empty or
//     thin covering note still reads the letter's own attachment asks,
//     instead of being filed as a wordless delivery.
//   - verifyUnderstanding keeping an ask typed in the sender's own message
//     together with an ask found only in the attachment, not one instead of
//     the other.
//
// Every email and document name here is synthetic.
// Run: node --test tests/intake-attachment-note-and-combined-asks.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { rulesUnderstanding, verifyUnderstanding } from "../supabase/functions/_shared/intakeUnderstanding.mjs";
import { attachmentText, corpusIndex } from "../supabase/functions/_shared/intakeFacts.mjs";

const factsFor = (parts, subject, attachmentWords) => ({
  corpus: corpusIndex([subject, parts.note, parts.message, parts.history, ...attachmentWords]),
  email: [subject, parts.note, parts.message, parts.history].filter(Boolean).join("\n\n"),
  attachments: attachmentWords,
  refs: new Map(),
  physicianName: "Rowan Testa",
});

test("AC-2: a forward with an empty covering note still reads what the attachment itself requests", () => {
  const attachmentWords = attachmentText({
    documentType: "other",
    extracted: {},
    request_lead_in: "Please send the following documents to complete your reappointment file",
    requested_items: ["Current DEA certificate", "Current BLS card"],
  });
  const r = rulesUnderstanding({
    subject: "",
    body: "",
    attachmentNames: ["file0.pdf"],
    attachmentCount: 1,
    forwarded: true,
    attachmentWords: [attachmentWords],
    attachmentTypes: ["other"],
  });
  const fromAttachment = r.asks.filter((a) => a.from === "attachment").map((a) => a.quote);
  assert.deepEqual(fromAttachment, ["Current DEA certificate", "Current BLS card"], "an empty note must not drop the letter's own asks");
  assert.notEqual(r.intent, "delivery", "a letter with asks in it is not a wordless delivery");
});

test("AC-3: an ask typed in the sender's own message is kept together with an ask found only in the attachment", () => {
  const attachmentWords = attachmentText({ documentType: "other", extracted: {}, requested_items: ["Current ACLS card", "state controlled substance registration"] });
  const parts = { note: "", message: "Please send your current malpractice certificate along with the attached checklist items.", history: "" };
  const facts = factsFor(parts, "Credentialing file", [attachmentWords]);

  const v = verifyUnderstanding({
    intent: "request",
    asks: [
      { quote: "Please send your current malpractice certificate along with the attached checklist items.", kind: "unknown", who: "physician" },
      { quote: "Current ACLS card", kind: "acls", who: "physician" },
    ],
    attachments: [{ index: 1, role: "request_checklist", filing: "Keep with the request" }],
    summary: "a request for the checklist items",
    confidence: "high",
    records: [],
  }, { subject: "Credentialing file", parts, attachmentCount: 1, facts });

  assert.equal(v.asks.length, 2, "the sender's own typed ask and the attachment-only ask are both kept");
  assert.ok(v.asks.some((a) => a.from === "message"), "the sender's own words are not dropped for having an attachment beside them");
  assert.ok(v.asks.some((a) => a.from === "attachment" && a.quote === "Current ACLS card"), "the item named only in the attachment is kept too");
});
