import test from "node:test";
import assert from "node:assert/strict";
import { fakeWorld, fakePdfFor, IDS, SUBJECT } from "./fakeWorld.mjs";
import { invoiceEmailDocuments, invoiceEmailDraft, invoiceEmailSendBody, fileToBase64 } from "../../src/utils/invoiceEmailSend.js";
import { invoiceEmailKeys, emailDraftBody } from "../../src/utils/invoiceEmailDraft.js";
import { outgoingFileNames } from "../../src/utils/docLabel.js";

// Review of release/goal2 (2026-10-01), "Email it for me" (send-invoice-email
// with a draft, the invoice recorded only once the send is confirmed):
//  T1 a draft that went out, or may have, left no trace any other device
//     could see until the phone's record landed: a lost answer and a page iOS
//     threw away left the Mac's days unbilled with nothing asking. Its number
//     is now stamped as shared on the account's number ledger, as a share
//     hand-off stamps it, so every device asks "Did it go out?";
//  T2 its receipts went to the billing office as "image.jpg" and
//     "image (2).jpg" while the share sheet named the same receipts by what
//     they are. The function now names them the same way.
// Synthetic account, real handler, fake database, Storage and Resend.

const TO = "billing@hospital.example";
const workArgs = (number) => ({
  number, physician: "Synthetic Physician, DO", npi: "9999999999", email: "doc@example.test",
  facility: "Synthetic Hospital", agency: "Synthetic Locums", periodStart: "2026-09-05", periodEnd: "2026-09-06",
  terms: "$2,000.00 per on-call day", lines: [{ date: "2026-09-05", label: "Call coverage day", detail: "", amount: 2000 }],
  totalMin: 0, total: 2000,
});
const expenseArgs = (number) => ({
  number, kind: "expenses", physician: "Synthetic Physician, DO", npi: "9999999999", email: "doc@example.test",
  facility: "Synthetic Locums", periodStart: "2026-09-05", periodEnd: "2026-09-06", terms: "Reimbursable travel expenses per agreement.",
  lines: [
    { date: "2026-09-05", label: "Airfare: Example Air", detail: "receipt on file", amount: 400, expenseId: "x-air" },
    { date: "2026-09-06", label: "Lodging: Example Inn", detail: "receipt on file", amount: 300, expenseId: "x-inn" },
  ],
  totalMin: 0, total: 700,
});
async function prepare(env, { number = "INV-20260910-1", args = workArgs(number), draft = emailDraftBody({ number, entryIds: ["e1", "e2"], contractId: IDS.contract }), keys = invoiceEmailKeys(SUBJECT, number) } = {}) {
  const check = await env.call({ action: "check", invoiceId: keys.invoiceId, pdfBytes: fakePdfFor(args).size, ...(draft ? { draft } : {}) });
  if (check.status !== 200) return { check };
  const documents = invoiceEmailDocuments({ args, check: check.body, pdfFor: fakePdfFor });
  const preview = invoiceEmailDraft({ documents, sender: check.body.sender, to: TO });
  const body = invoiceEmailSendBody({ invoiceId: keys.invoiceId, requestId: keys.requestId, draft: preview, pdfBase64: await fileToBase64(documents.pdf), confirmResend: false, invoiceDraft: draft || undefined });
  return { check, body, keys };
}

test("T1 a draft that went out stamps its number as shared, with its agreement and the send's time", async () => {
  const env = fakeWorld();
  const { body } = await prepare(env);
  const sent = await env.call(body);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual(Object.fromEntries(env.world.shared), { "INV-20260910-1": { at: sent.body.sentAt, contractId: IDS.contract } });
});

test("T1 one whose send could not be confirmed is stamped too; one that failed, or a recorded invoice's, is not", async () => {
  const unknown = fakeWorld({ mailOutcome: () => ({ state: "unknown" }) });
  const u = await prepare(unknown);
  assert.equal((await unknown.call(u.body)).status, 502);
  assert.ok(unknown.world.shared.has("INV-20260910-1"), "it may have gone: every device asks");

  const failed = fakeWorld({ mailOutcome: () => ({ state: "failed" }) });
  const f = await prepare(failed);
  assert.equal((await failed.call(f.body)).status, 502);
  assert.equal(failed.world.shared.size, 0, "nothing went: nothing to ask about");

  const recorded = fakeWorld();
  const r = await prepare(recorded, { number: "EXP-0007", args: expenseArgs("EXP-0007"), draft: null, keys: { invoiceId: IDS.invoice, requestId: invoiceEmailKeys(SUBJECT, "EXP-0007").requestId } });
  assert.equal((await recorded.call(r.body)).status, 200);
  assert.equal(recorded.world.shared.size, 0, "already recorded: its row says it went");

  const typed = fakeWorld();
  const t = await prepare(typed, { number: "A-17", draft: emailDraftBody({ number: "A-17", entryIds: ["e1"], contractId: IDS.contract }) });
  assert.equal((await typed.call(t.body)).status, 200);
  assert.equal(typed.world.shared.size, 0, "a number the app did not issue is never stamped (mark_invoice_number_shared's rule)");
});

test("T1 a stamp that fails never fails the send", async () => {
  const env = fakeWorld();
  env.deps.store.markNumberShared = async () => { throw new Error("ledger unavailable"); };
  const { body } = await prepare(env);
  const sent = await env.call(body);
  assert.equal(sent.status, 200);
  assert.equal(env.world.mails.length, 1);
});

function cameraReceipts(env) {
  env.world.expenses.push(
    { id: "x-air", user_id: IDS.profile, invoice_id: null, category: "Airfare", vendor: "Example Air" },
    { id: "x-inn", user_id: IDS.profile, invoice_id: null, category: "Lodging", vendor: "Example Inn" },
  );
  env.world.documents.push(
    { id: "aaaaaaaa-0000-4000-8000-0000000000a1", user_id: IDS.profile, name: "image.jpg", mime_type: "image/jpeg", type: "image/jpeg",
      storage_path: `${SUBJECT}/air`, size_bytes: 8, linked_to: "travelExpenses:x-air" },
    { id: "aaaaaaaa-0000-4000-8000-0000000000a2", user_id: IDS.profile, name: "image.jpg", mime_type: "image/jpeg", type: "image/jpeg",
      storage_path: `${SUBJECT}/inn`, size_bytes: 8, linked_to: "travelExpenses:x-inn" },
  );
  env.world.storage.set(`${SUBJECT}/air`, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
  env.world.storage.set(`${SUBJECT}/inn`, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8]));
}
const SHARED_NAMES = () => outgoingFileNames(
  [{ name: "image.jpg", linkedTo: "travelExpenses:x-air", type: "image/jpeg" }, { name: "image.jpg", linkedTo: "travelExpenses:x-inn", type: "image/jpeg" }],
  { settings: { name: "Synthetic Physician", degreeType: "DO" }, travelExpenses: [{ id: "x-air", category: "Airfare", vendor: "Example Air" }, { id: "x-inn", category: "Lodging", vendor: "Example Inn" }] },
).map((n) => n.name);

test("T2 camera receipts go out by what they are, the names the share sheet gives them", async () => {
  const env = fakeWorld();
  cameraReceipts(env);
  const number = "EXP-20260930-2";
  const { check, body } = await prepare(env, { number, args: expenseArgs(number), draft: emailDraftBody({ number, kind: "expenses", entryIds: ["x-air", "x-inn"], billToLabel: "Synthetic Locums" }) });
  assert.equal(check.status, 200, JSON.stringify(check.body));
  const expected = ["Airfare, Example Air, Synthetic Physician DO.jpg", "Lodging, Example Inn, Synthetic Physician DO.jpg"];
  assert.deepEqual(SHARED_NAMES(), expected, "the share sheet's names");
  assert.deepEqual(check.body.receipts.attachable.map((r) => r.name), expected, "the preview shows them");
  const sent = await env.call(body);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual(env.world.mails[0].attachments.map((a) => a.filename), ["Invoice EXP-20260930-2 from Synthetic Physician, DO.pdf", ...expected]);
});

test("T2 a resend from the Invoices tab names them the same way; a name the physician gave is kept", async () => {
  const env = fakeWorld();
  env.world.documents.find((d) => d.id === IDS.docHotel).name = "IMG_0269.jpeg";
  const { check, body } = await prepare(env, { number: "EXP-0007", args: expenseArgs("EXP-0007"), draft: null, keys: { invoiceId: IDS.invoice, requestId: invoiceEmailKeys(SUBJECT, "EXP-0007").requestId } });
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.deepEqual(check.body.receipts.attachable.map((r) => r.name), ["airfare.pdf", "Lodging, Example Inn, Synthetic Physician DO.jpeg"]);
  const sent = await env.call(body);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual(env.world.mails[0].attachments.slice(1).map((a) => a.filename), ["airfare.pdf", "Lodging, Example Inn, Synthetic Physician DO.jpeg"]);
});
