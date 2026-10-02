import test from "node:test";
import assert from "node:assert/strict";
import { fakeWorld, fakePdfFor, IDS, SUBJECT } from "./fakeWorld.mjs";
import { invoiceEmailDocuments, invoiceEmailDraft, invoiceEmailSendBody, fileToBase64 } from "../../src/utils/invoiceEmailSend.js";
import { invoiceEmailKeys, againRequestId, emailDraftBody, stableUuid } from "../../src/utils/invoiceEmailDraft.js";

// "Email it for me" (2026-10-01): an invoice from Work log, Days & call or
// Expenses goes out through send-invoice-email BEFORE it is recorded (the
// app records it once the send is confirmed). The function reads a draft in
// place of the invoice row while no row has its id. Synthetic account, real
// handler, fake database, Storage and Resend (fakeWorld.mjs).

const TO = "billing@hospital.example";
const ACCOUNT = SUBJECT;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

/** What the email screen does for an invoice not recorded yet: check with the draft, preview, Send body. */
async function prepare(env, { number = "INV-20260910-1", args = workArgs(number), draft = emailDraftBody({ number, entryIds: ["e1", "e2"], contractId: IDS.contract }), to = TO, keys = invoiceEmailKeys(ACCOUNT, number), requestId = keys.requestId, confirmResend = false } = {}) {
  const provisional = fakePdfFor(args);
  const check = await env.call({ action: "check", invoiceId: keys.invoiceId, pdfBytes: provisional.size, draft });
  if (check.status !== 200) return { check };
  const documents = invoiceEmailDocuments({ args, check: check.body, pdfFor: fakePdfFor });
  const preview = invoiceEmailDraft({ documents, sender: check.body.sender, to });
  const body = invoiceEmailSendBody({ invoiceId: keys.invoiceId, requestId, draft: preview, pdfBase64: await fileToBase64(documents.pdf), confirmResend, invoiceDraft: draft });
  return { check, documents, preview, body, keys };
}

test("the keys: one invoice id and one request id per account and number, as UUIDs, the same every time", () => {
  const a = invoiceEmailKeys(ACCOUNT, "INV-20260910-1");
  assert.match(a.invoiceId, UUID);
  assert.match(a.requestId, UUID);
  assert.notEqual(a.invoiceId, a.requestId);
  assert.deepEqual(invoiceEmailKeys(ACCOUNT, " inv-20260910-1 "), a, "the same number in any case or spacing");
  assert.notDeepEqual(invoiceEmailKeys(ACCOUNT, "INV-20260910-2"), a, "another number, other keys");
  assert.notDeepEqual(invoiceEmailKeys("user_other", "INV-20260910-1"), a, "another account, other keys");
  assert.match(againRequestId(a.requestId, "2026-09-10T17:00:00Z"), UUID);
  assert.notEqual(againRequestId(a.requestId, "2026-09-10T17:00:00Z"), a.requestId, "a deliberate resend is its own request");
  assert.equal(againRequestId(a.requestId, "2026-09-10T17:00:00Z"), againRequestId(a.requestId, "2026-09-10T17:00:00Z"));
  assert.equal(stableUuid("x"), stableUuid("x"));
});

test("a draft is checked and sent like a recorded invoice, and its ledger row names the id it will be recorded under", async () => {
  const env = fakeWorld();
  const { check, body, keys } = await prepare(env);
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.deepEqual(check.body.receipts, { attachable: [], missing: [] });
  assert.equal(check.body.lastAttempt, null);
  const sent = await env.call(JSON.parse(JSON.stringify(body)));
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.match(sent.body.emailId, /^re_/, "the provider's id comes back: the app records only on it");
  assert.equal(env.world.mails.length, 1);
  assert.deepEqual(env.world.mails[0].to, [TO]);
  assert.deepEqual(env.world.mails[0].cc, ["doc.verified@example.test"], "a copy to the physician");
  assert.equal(env.world.mails[0].attachments[0].filename, "Invoice INV-20260910-1 from Synthetic Physician, DO.pdf");
  assert.ok(env.world.mails[0].html && env.world.mails[0].text.includes("\n\n"), "text and HTML, paragraphs kept");
  const row = env.world.ledger[0];
  assert.equal(row.invoice_id, keys.invoiceId);
  assert.equal(row.client_request_id, keys.requestId);
  assert.equal(row.status, "sent");
  assert.ok(!env.world.invoices.some((r) => r.id === keys.invoiceId), "nothing written to invoices: the app records it");

  // The app records it under that id; the next check stamps it from the ledger.
  env.world.invoices.push({ id: keys.invoiceId, user_id: IDS.profile, number: "INV-20260910-1", kind: null, entry_ids: ["e1", "e2"],
    contract_id: IDS.contract, bill_to_label: null, last_emailed_at: null, last_emailed_to: null });
  const after = await env.call({ action: "check", invoiceId: keys.invoiceId, pdfBytes: 100 });
  assert.equal(after.status, 200);
  assert.deepEqual(after.body.lastSend, { at: sent.body.sentAt, to: TO });
  const stamped = env.world.invoices.find((r) => r.id === keys.invoiceId);
  assert.equal(stamped.last_emailed_at, sent.body.sentAt, "stamped once the row is there");
  assert.equal(stamped.last_emailed_to, TO);
});

test("weak network: the same number's Send retried, at once or after the app recorded it, is a replay and mails once", async () => {
  const env = fakeWorld();
  const { body, keys } = await prepare(env);
  const results = await Promise.all([env.call(body), env.call(body)]);
  assert.equal(env.world.keys.length, 1, "one POST to the provider for two taps");
  const ok = results.find((r) => r.status === 200 && !r.body.replay);
  assert.ok(ok);
  const again = await env.call(body);
  assert.equal(again.status, 200);
  assert.equal(again.body.replay, true);
  assert.equal(again.body.emailId, ok.body.emailId, "the replay carries the provider id too");
  assert.equal(again.body.sentAt, ok.body.sentAt);
  // Recorded meanwhile: the row stands in, and the ledger still answers.
  env.world.invoices.push({ id: keys.invoiceId, user_id: IDS.profile, number: "INV-20260910-1", kind: null, entry_ids: ["e1", "e2"],
    contract_id: IDS.contract, bill_to_label: null, last_emailed_at: null, last_emailed_to: null });
  const late = await env.call(body);
  assert.equal(late.status, 200);
  assert.equal(late.body.replay, true);
  assert.equal(env.world.mails.length, 1);
});

test("a draft whose number is already on an invoice of the account is refused, checked or sent, and nothing goes", async () => {
  const env = fakeWorld();
  const taken = await prepare(env, { number: "inv-20260922-04" });
  assert.equal(taken.check.status, 409);
  assert.equal(taken.check.body.code, "invoice_number_recorded");
  assert.match(taken.check.body.error, /already on your Invoices tab, so it was not emailed\. Nothing was sent\./);

  // Free at the check, recorded on another device before Send.
  const { body } = await prepare(env, { number: "INV-20260910-7" });
  env.world.invoices.push({ id: "aaaaaaaa-0000-4000-8000-0000000000ff", user_id: IDS.profile, number: "INV-20260910-7", kind: null, entry_ids: [] });
  const refused = await env.call(body);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "invoice_number_recorded");
  assert.equal(env.world.mails.length, 0);
  assert.equal(env.world.ledger.length, 0);
  assert.equal(env.world.reservations, 0, "no hourly budget spent");
});

test("a draft expense invoice that lists an expense another invoice bills is refused (2026-10-02); listing only its own, it attaches their receipts", async () => {
  const env = fakeWorld();
  env.world.expenses.push(
    { id: "x-air", user_id: IDS.profile, invoice_id: null },
    { id: "x-inn", user_id: IDS.profile, invoice_id: IDS.invoice }, // billed on EXP-0007 already
  );
  env.world.documents.push(
    { id: "aaaaaaaa-0000-4000-8000-0000000000a1", user_id: IDS.profile, name: "air.pdf", mime_type: "application/pdf", type: "application/pdf",
      storage_path: `${SUBJECT}/air`, size_bytes: 20, linked_to: "travelExpenses:x-air" },
    { id: "aaaaaaaa-0000-4000-8000-0000000000a2", user_id: IDS.profile, name: "inn.jpg", mime_type: "image/jpeg", type: "image/jpeg",
      storage_path: `${SUBJECT}/inn`, size_bytes: 8, linked_to: "travelExpenses:x-inn" },
  );
  env.world.storage.set(`${SUBJECT}/air`, new TextEncoder().encode("%PDF-1.4\n% air\n"));
  env.world.storage.set(`${SUBJECT}/inn`, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
  const number = "EXP-20260910-2";
  const refused = await prepare(env, {
    number, args: expenseArgs(number),
    draft: emailDraftBody({ number, kind: "expenses", entryIds: ["x-air", "x-inn"], billToLabel: "Synthetic Locums" }),
  });
  assert.equal(refused.check.status, 409);
  assert.equal(refused.check.body.code, "invoice_items_billed");
  assert.equal(env.world.mails.length, 0);
  const { check, body } = await prepare(env, {
    number, args: expenseArgs(number),
    draft: emailDraftBody({ number, kind: "expenses", entryIds: ["x-air"], billToLabel: "Synthetic Locums" }),
  });
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.deepEqual(check.body.receipts.attachable.map((r) => r.name), ["air.pdf"], "only the unbilled expense's receipt");
  const sent = await env.call(body);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual(env.world.mails[0].attachments.map((a) => a.filename), ["Invoice EXP-20260910-2 from Synthetic Physician, DO.pdf", "air.pdf"]);
});

test("a draft keeps every rule of a recorded invoice: no CredentialDOMD recipient, the hourly cap, a refused provider", async () => {
  const own = fakeWorld();
  const { body } = await prepare(own, { to: "billing@credentialdomd.com" });
  const refused = await own.call(body);
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "recipient_invalid");
  assert.equal(own.world.mails.length, 0);

  const capped = fakeWorld();
  capped.world.reserveResult = { data: [], error: null };
  const c = await prepare(capped);
  const over = await capped.call(c.body);
  assert.equal(over.status, 429);
  assert.equal(over.body.code, "send_cap_reached");
  assert.equal(capped.world.mails.length, 0);

  const failing = fakeWorld({ mailOutcome: () => ({ state: "failed" }) });
  const f = await prepare(failing);
  const no = await failing.call(f.body);
  assert.equal(no.status, 502);
  assert.equal(no.body.code, "send_failed");
  assert.equal(failing.world.ledger[0].status, "failed", "the same request may try again");
});

test("a draft that is not exactly a draft is refused before anything is read or reserved", async () => {
  const env = fakeWorld();
  const keys = invoiceEmailKeys(ACCOUNT, "INV-20260910-1");
  for (const draft of [
    { number: "INV-20260910-1", extra: true },
    { number: "" },
    { number: "INV 1; drop" },
    { number: "INV-20260910-1", kind: "work" },
    { number: "INV-20260910-1", entryIds: "e1" },
    { number: "INV-20260910-1", entryIds: ["e1", "e1"] },
    { number: "INV-20260910-1", contractId: 7 },
    { number: "INV-20260910-1", billToLabel: "x".repeat(201) },
    null,
  ]) {
    const r = await env.call({ action: "check", invoiceId: keys.invoiceId, pdfBytes: 100, draft });
    assert.equal(r.status, 400, JSON.stringify(draft));
    assert.equal(r.body.code, "invalid_request");
  }
  // No draft and no row: as before.
  const missing = await env.call({ action: "check", invoiceId: keys.invoiceId, pdfBytes: 100 });
  assert.equal(missing.status, 404);
  assert.equal(env.world.reservations, 0);
  assert.equal(env.world.mails.length, 0);
});
