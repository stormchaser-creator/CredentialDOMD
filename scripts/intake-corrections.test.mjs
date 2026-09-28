// src/utils/intakeCorrections.js: what the app records when the physician
// corrects what email intake did, and that none of it identifies anyone.
// The table is proven in tests/intake-corrections-sql.test.mjs; the prompt
// side (correctionExamples) in scripts/intake-understanding.test.mjs, and the
// two are checked against each other here. Synthetic data throughout.
// Run: node --test scripts/intake-corrections.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  arrivedByEmail, sectionOf, scrubText, bulletLines, dismissCorrection, coverNoteCorrection, relinkCorrection, keepCorrection,
  recordCorrection, CORRECTION_ACTIONS,
} from "../src/utils/intakeCorrections.js";
import { correctionExamples } from "../supabase/functions/_shared/intakeUnderstanding.mjs";

const MIGRATION = (await import("node:fs")).readFileSync(new URL("../supabase/migrations/20260928160000_intake_corrections.sql", import.meta.url), "utf8");

const request = {
  id: "req-1", inbound_ledger_id: "led-1", from_name: "Casey Example", from_addr: "casey@osterly.example",
  proposal: {
    v: 2, method: "rules", source: "rules", confidence: "keyword",
    items: [
      { ask: "Proof of malpractice coverage for Dr. Rowan Testa", kind: "coi_malpractice", status: "found", docIds: ["d1"], labels: ["Professional Liability COI"] },
      { ask: "call Casey at 555-201-3344 or casey@osterly.example", kind: "unknown", status: "missing", docIds: [], labels: [] },
    ],
  },
};

test("the actions are the migration's own list", () => {
  const listed = MIGRATION.match(/check \(action in \(([^)]*)\)\)/)[1].match(/'([a-z_]+)'/g).map((x) => x.slice(1, -1));
  assert.deepEqual([...CORRECTION_ACTIONS], listed);
});

test("an emailed document is one with an inbox type, or a MIME type only email-inbound writes", () => {
  assert.equal(arrivedByEmail({ type: "email-inbox" }), true);
  assert.equal(arrivedByEmail({ type: "request-attachment-inbox", linkedTo: "x:y" }), true);
  assert.equal(arrivedByEmail({ type: "application/pdf", mimeType: "application/pdf", linkedTo: "licenses:l" }), true);
  assert.equal(arrivedByEmail({ type: "application/pdf", linkedTo: "licenses:l" }), false, "the app's own upload");
  assert.equal(arrivedByEmail(null), false);
  assert.equal(sectionOf({ type: "email-inbox" }), "inbox");
  assert.equal(sectionOf({ type: "application/pdf", linkedTo: "licenses:l" }), "licenses");
});

test("scrubText takes out addresses, links, numbers, honorific names and the names it is given", () => {
  assert.equal(scrubText("Dr. Rowan Testa's COI, call 555-201-3344, casey@x.example, https://x.example/a", []), "the person COI, call #, ,");
  assert.equal(scrubText("Casey Example asked for the DEA", ["Casey Example"]), "the person the person asked for the DEA");
  assert.equal(scrubText("a".repeat(200), [], 20).length, 20);
  assert.equal(scrubText("proof of malpractice coverage for emergency care", [], 20), "proof of malpractice", "cut at a word");
});

test("a dismissed request records what intake read, and nothing that identifies anyone", () => {
  const row = dismissCorrection(request, { physicianName: "Rowan Testa" });
  assert.equal(row.action, "dismiss_request");
  assert.equal(row.request_id, "req-1");
  assert.equal(row.inbound_email_id, "led-1");
  assert.deepEqual(row.before, {
    intent: "request", source: "rules", confidence: "keyword",
    asks: ["Proof of malpractice coverage for the person", "call the person at # or"],
    kinds: ["coi_malpractice", "unknown"],
  });
  assert.deepEqual(row.after, { status: "dismissed" });
  const json = JSON.stringify(row);
  for (const secret of ["Rowan", "Testa", "Casey", "555", "@"]) assert.ok(!json.includes(secret), secret);
  assert.equal(dismissCorrection({}), null);
});

test("an edited cover note records the lines taken out and added; a note sent as drafted records nothing", () => {
  const drafted = "Hello Casey,\n\nAttached are the documents you asked for:\n- Professional Liability COI\n\nRegards,\nRowan Testa, MD";
  const sent = "Hello Casey,\n\nNot on file:\n- Colorado DEA\n\nRegards,\nRowan Testa, MD";
  const row = coverNoteCorrection(request, drafted, sent, { physicianName: "Rowan Testa" });
  assert.equal(row.action, "edit_cover_note");
  assert.deepEqual(row.after.removedAsks, ["Professional Liability COI"]);
  assert.deepEqual(row.after.addedAsks, ["Colorado DEA"]);
  assert.equal(row.after.cleared, false);
  assert.equal(coverNoteCorrection(request, drafted, `${drafted}\n`), null, "a trailing newline is not an edit");
  assert.equal(coverNoteCorrection(request, drafted, "").after.cleared, true);
  assert.deepEqual(bulletLines(drafted), ["Professional Liability COI"]);
});

test("an emailed document moved out of the inbox, or to another record, is recorded; the app's own uploads are not", () => {
  const inbox = { id: "d", type: "email-inbox", mimeType: "application/pdf" };
  assert.deepEqual(relinkCorrection(inbox, "locumContracts:c1", { scanType: "agreement" }), {
    action: "move_document", request_id: null, inbound_email_id: null,
    before: { section: "inbox", scanType: "agreement", kind: "document" }, after: { section: "locumContracts" },
  });
  const filed = { id: "d", type: "application/pdf", mimeType: "application/pdf", linkedTo: "customRecords:r1" };
  assert.equal(relinkCorrection(filed, "locumContracts:c1").action, "relink_document");
  assert.equal(relinkCorrection(filed, "customRecords:r2"), null, "same section is not a correction");
  assert.equal(relinkCorrection({ id: "d", type: "application/pdf", linkedTo: "licenses:l" }, "cme:c"), null, "an upload is not intake's doing");
  assert.equal(relinkCorrection(filed, "").after.section, "unlinked");
});

test("Keep as plain document on an emailed document is recorded", () => {
  const row = keepCorrection({ id: "d", type: "email-inbox" }, { scanType: "other", suggested: "Attestations" });
  assert.deepEqual(row.before, { section: "inbox", scanType: "other", suggested: "Attestations" });
  assert.equal(keepCorrection({ id: "d", type: "application/pdf" }, { scanType: "cme" }), null);
});

test("each recorded row reads back as a prompt example", () => {
  const rows = [
    dismissCorrection(request, { physicianName: "Rowan Testa" }),
    coverNoteCorrection(request, "- A", "- B"),
    relinkCorrection({ type: "email-inbox" }, "locumContracts:c", { scanType: "agreement" }),
    keepCorrection({ type: "email-inbox" }, { scanType: "other", suggested: "Attestations" }),
  ];
  const lines = correctionExamples(rows);
  assert.equal(lines.length, 4);
  assert.equal(lines[0], "Dismissed an email that was read as a request for Proof of malpractice coverage for the, call the person at # or (read as request): it asked for nothing they would answer.");
  assert.equal(lines[1], "Edited the drafted reply before sending: took out A; added B.");
  assert.equal(lines[2], "Moved a forwarded agreement from inbox to locumContracts.");
});

test("recordCorrection writes one row as the account and never throws", async () => {
  const inserted = [];
  const client = { from: (t) => ({ insert: async (row) => { inserted.push([t, row]); return { error: null }; } }) };
  assert.equal(await recordCorrection(client, "profile-1", keepCorrection({ type: "email-inbox" }, { scanType: "cme" })), true);
  assert.equal(inserted[0][0], "intake_corrections");
  assert.equal(inserted[0][1].user_id, "profile-1");
  assert.equal(await recordCorrection(client, null, { action: "keep_as_document" }), false, "no account, no write");
  assert.equal(await recordCorrection(client, "p", null), false);
  assert.equal(await recordCorrection(client, "p", { action: "delete_everything" }), false);
  const broken = { from: () => ({ insert: async () => { throw new Error("offline"); } }) };
  assert.equal(await recordCorrection(broken, "p", { action: "keep_as_document", before: {}, after: {} }), false);
  const refused = { from: () => ({ insert: async () => ({ error: { message: "relation does not exist" } }) }) };
  assert.equal(await recordCorrection(refused, "p", { action: "keep_as_document", before: {}, after: {} }), false);
});
