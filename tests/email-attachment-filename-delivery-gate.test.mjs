// A documentation request that lives in an attached letter, under a covering
// note that says nothing of its own (ticket cc9830e4).
//
// rulesUnderstanding (supabase/functions/_shared/intakeUnderstanding.mjs) is
// the reading used whenever the model is unavailable or its reply unusable.
// classifyIntent (intakeIntent.mjs) decides delivery or request from the
// subject, the covering note and the file names, never the attachment's own
// words. With an empty or thin note it says "delivery" for any file: a
// file name that reads like a finished document ("Hospital_Letter.pdf")
// leans that way by a point, and an unnamed scan ("scan001.pdf") under an
// empty note, a signature or "FYI" is "a forwarded file is a file to keep".
// Until this fix a delivery dropped the letter's asks unless the note
// pointed at the letter ("see attached"), so the letter's request was
// never read. Now a note that says nothing of a delivery itself lets the
// letter's asks through; a note that delivers ("Attached is my new badge",
// "For my file.") keeps the delivery.
//
// Every email, name and address here is synthetic.
// Run: node --test tests/email-attachment-filename-delivery-gate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { rulesUnderstanding, ackWarranted } from "../supabase/functions/_shared/intakeUnderstanding.mjs";
import { attachmentText } from "../supabase/functions/_shared/intakeFacts.mjs";

const LETTER_SCAN = {
  documentType: "other",
  confidence: "medium",
  extracted: { name: "Reappointment request letter", issuer: "Osterly Example Health" },
  request_lead_in: "Please send the following documents to complete your reappointment file",
  requested_items: ["Current DEA certificate", "Current BLS card"],
};
const ASKED = ["Current DEA certificate", "Current BLS card"];

const read = ({ subject = "Reappointment file", body = "", name = "Hospital_Letter.pdf", words = [attachmentText(LETTER_SCAN)], types = ["other"], forwarded = false } = {}) =>
  rulesUnderstanding({ subject, body, attachmentNames: [name], attachmentCount: 1, forwarded, attachmentWords: words, attachmentTypes: types });
const quotes = (r) => r.asks.map((a) => a.quote);
const fromFile = (r) => r.asks.filter((a) => a.from === "attachment").map((a) => a.quote);

test("an empty covering note does not make a file name that reads like a document erase the letter's request", () => {
  const r = read({ body: "" });
  assert.equal(r.rulesIntent, "delivery");
  assert.equal(r.intent, "mixed");
  assert.deepEqual(quotes(r), ["Reappointment file", ...ASKED]);
  assert.deepEqual(fromFile(r), ASKED);
  assert.equal(ackWarranted(r).ok, false, "never acknowledged on the attachment's asks alone");
});

test("a plain covering note with no pointer still lets the letter's request through", () => {
  const r = read({ body: "Thanks for looking into this when you have a chance." });
  assert.equal(r.intent, "mixed");
  assert.deepEqual(quotes(r), ["Reappointment file", ...ASKED]);
});

test("an unnamed scan under an empty note, a signature or FYI: the letter's asks, and no junk asks from the note", () => {
  for (const [body, name, subject] of [["", "scan001.pdf", ""], ["Dr. Smith", "scan001.pdf", "Reappointment file"], ["FYI", "Hospital_Letter.pdf", "Reappointment file"], ["", "Hospital_Letter.pdf", ""]]) {
    const r = read({ body, name, subject });
    assert.equal(r.rulesIntent, "delivery", `${name} / ${body}`);
    assert.equal(r.intent, "mixed", `${name} / ${body}`);
    assert.deepEqual(quotes(r), ASKED, `${name} / ${body}`);
  }
  // Forwarded with nothing written above it reads the same.
  assert.deepEqual(fromFile(read({ body: "", name: "scan001.pdf", subject: "", forwarded: true })), ASKED);
});

test("a delivery that says so stays a delivery, and a file with no letter words adds nothing", () => {
  for (const body of ["For my file.", "Attached is my new hospital ID badge.", "Please file this."]) {
    const r = read({ body, name: "scan001.pdf", subject: "" });
    assert.equal(r.intent, "delivery", body);
    assert.deepEqual(fromFile(r), [], body);
  }
  // A failed or unscanned file has no words, so nothing is read from it.
  for (const types of [["unknown"], ["other"]]) {
    const r = read({ body: "", name: "scan001.pdf", subject: "", words: [""], types });
    assert.equal(r.intent, "delivery");
    assert.deepEqual(r.asks, []);
  }
  // A credential's scan is never read for asks, whatever it lists.
  const card = read({ body: "", name: "scan001.pdf", subject: "", types: ["license"] });
  assert.equal(card.intent, "delivery");
  assert.deepEqual(card.asks, []);
});
