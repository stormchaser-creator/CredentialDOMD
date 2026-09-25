import test from "node:test";
import assert from "node:assert/strict";
import { fakeWorld, fakePdfFor, expenseInvoice, workInvoice, contract, settings, IDS, SUBJECT } from "./fakeWorld.mjs";
import { invoiceDocumentArgs } from "../../src/utils/invoiceArgs.js";
import { invoiceEmailDocuments, invoiceEmailDraft, invoiceEmailSendBody, fileToBase64 } from "../../src/utils/invoiceEmailSend.js";
import { invoiceCoverEmail, invoiceSubject } from "../../src/utils/invoiceCover.js";
import { invoiceEmailFooter } from "../../src/utils/invoiceEmail.js";
import { reservationVerdict, sendWindowStart, fromBase64, toBase64 } from "../../supabase/functions/_shared/invoiceEmailHandler.mjs";

// send-invoice-email end to end, minus the network: the app's own draft code
// on one side, the real edge handler on the other, a fake database, Storage
// and Resend underneath (tests/invoice-email/fakeWorld.mjs). Tickets e8cc2a02
// and 821d2f76: server-sent mail is the only path that keeps the letter's
// line breaks.

const REQUEST = "bbbbbbbb-0000-4000-8000-000000000001";
const TO = "billing@hospital.example";

/** What the app does: check, build the documents and the draft, then the Send body. */
async function prepare(env, { invoice = expenseInvoice(), to = TO, requestId = REQUEST } = {}) {
  const args = invoiceDocumentArgs(invoice, contract(), settings(), "Synthetic Locums");
  const provisional = fakePdfFor(args);
  const check = await env.call({ action: "check", invoiceId: invoice.id, pdfBytes: provisional.size });
  assert.equal(check.status, 200, JSON.stringify(check.body));
  const documents = invoiceEmailDocuments({ args, check: check.body, pdfFor: fakePdfFor });
  const draft = invoiceEmailDraft({ documents, sender: check.body.sender, to });
  const body = invoiceEmailSendBody({ invoiceId: invoice.id, requestId, draft, pdfBase64: await fileToBase64(documents.pdf) });
  return { args, check: check.body, documents, draft, body };
}
const decodeText = (b64) => new TextDecoder().decode(fromBase64(b64));

test("the letter keeps its line breaks end to end: preview, request, handler, Resend payload", async () => {
  const env = fakeWorld();
  const { draft, body } = await prepare(env, { invoice: workInvoice() });
  const sent = await env.call(JSON.parse(JSON.stringify(body)));
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(env.world.mails.length, 1);
  const mail = env.world.mails[0];
  assert.equal(mail.text, draft.email.text, "the text Resend got is the text the preview showed");
  const paragraphs = mail.text.split("\n\n");
  assert.equal(paragraphs[0], "Hello,");
  assert.match(paragraphs[1], /^Attached is invoice INV-20260920-01 for physician services at Synthetic Hospital \(via Synthetic Locums\), covering Sep 14, 2026 through Sep 20, 2026\.$/);
  assert.equal(paragraphs[2], "Total due: $12,500.50");
  assert.equal(paragraphs.at(-2), "Thank you,\nSynthetic Physician, DO\nNPI 9999999999\ndoc@example.test", "the signature keeps its own lines");
  assert.equal(paragraphs.at(-1), invoiceEmailFooter("Synthetic Physician, DO"));
  assert.doesNotMatch(mail.text, /\r|\u{2014}/u, "plain newlines, no em dash");
  assert.ok(!mail.html, "text/plain only: nothing for a client to re-flow");
});

test("the preview is what is sent: from, to, cc, reply_to, subject and every attachment name", async () => {
  const env = fakeWorld();
  const { draft, body } = await prepare(env);
  const res = await env.call(body);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const mail = env.world.mails[0];
  const e = draft.email;
  assert.equal(mail.from, e.from);
  assert.equal(mail.from, '"Synthetic Physician, DO via CredentialDOMD" <docs@credentialdomd.com>');
  assert.deepEqual(mail.to, [e.to]);
  assert.deepEqual(mail.cc, [e.cc]);
  assert.deepEqual(mail.reply_to, [e.replyTo]);
  assert.equal(mail.subject, e.subject);
  assert.equal(mail.subject, invoiceSubject(invoiceDocumentArgs(expenseInvoice(), contract(), settings(), "")));
  assert.deepEqual(mail.attachments.map((a) => a.filename), e.attachments);
  assert.deepEqual(e.attachments, ["EXP-0007.pdf", "airfare.pdf", "hotel.jpg"]);
  assert.deepEqual(res.body.sent, { ...e }, "the response echoes the composed message, field for field");
  // The invoice PDF that rode is byte for byte the one the app built for the preview.
  assert.equal(mail.attachments[0].content, body.pdf.base64);
  assert.equal(mail.attachments[0].content_type, "application/pdf");
  assert.equal(mail.attachments[2].content_type, "image/jpeg");
});

test("a change between preview and Send is refused, not sent: the server's message must equal the preview", async () => {
  const env = fakeWorld();
  const { body } = await prepare(env);
  env.world.profile.name = "Renamed Physician";
  const res = await env.call(body);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "preview_stale");
  assert.equal(res.body.field, "from");
  assert.equal(env.world.keys.length, 0, "Resend was never called");
  assert.equal(env.world.reservations, 0, "no hourly budget spent");

  const tampered = await prepare(fakeWorld());
  const env2 = fakeWorld();
  const res2 = await env2.call({ ...tampered.body, preview: { ...tampered.body.preview, text: tampered.body.preview.text.replace("Hello,", "Hi,") } });
  assert.equal(res2.body.code, "preview_stale");
  assert.equal(res2.body.field, "text");
  assert.equal(env2.world.keys.length, 0);
});

test("cc and reply_to are the physician's verified mailbox, the profile email when none, and no self-copy", async () => {
  const env = fakeWorld();
  const { body } = await prepare(env);
  await env.call(body);
  assert.deepEqual(env.world.mails[0].reply_to, ["doc.verified@example.test"]);
  assert.deepEqual(env.world.mails[0].cc, ["doc.verified@example.test"]);

  const typedOnly = fakeWorld({ profile: { verified_email: null } });
  const t = await prepare(typedOnly);
  assert.equal(t.check.sender.replyTo, "doc@example.test");
  await typedOnly.call(t.body);
  assert.deepEqual(typedOnly.world.mails[0].reply_to, ["doc@example.test"]);
  assert.deepEqual(typedOnly.world.mails[0].cc, ["doc@example.test"]);

  const self = fakeWorld();
  const s = await prepare(self, { to: "doc.verified@example.test" });
  const res = await self.call(s.body);
  assert.equal(res.status, 200);
  assert.equal(self.world.mails[0].cc, undefined, "a test send to yourself is not copied to yourself");

  const noMailbox = fakeWorld({ profile: { verified_email: null, email: "" } });
  const r = await noMailbox.call({ action: "check", invoiceId: IDS.invoice, pdfBytes: 100 });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "sender_email_missing");
});

test("a receipt that cannot be attached is named before Send, and neither the letter nor the PDF claims it", async () => {
  const env = fakeWorld();
  env.world.storage.delete(`${SUBJECT}/${IDS.docHotel}`);
  const { check, documents, draft, body } = await prepare(env);
  assert.deepEqual(check.receipts.attachable.map((r) => r.name), ["airfare.pdf"]);
  assert.deepEqual(check.receipts.missing, [{ id: IDS.docHotel, name: "hotel.jpg", linkedTo: `travelExpenses:${IDS.expHotel}`, reason: "unavailable" }]);
  assert.match(documents.missingText, /1 receipt could not be attached \(hotel\.jpg\) because they could not be read from your account storage\./);
  assert.match(draft.email.text, /The receipt is attached\./);
  assert.doesNotMatch(draft.email.text, /2 receipts/);
  const pdf = JSON.parse(decodeText(body.pdf.base64).split("\n")[1]);
  assert.match(pdf.lines[0].detail, /receipt attached$/, "the airfare receipt rides");
  assert.equal(pdf.lines[1].detail, "receipt on file", "the hotel receipt does not, so its line does not claim it");
  const res = await env.call(body);
  assert.equal(res.status, 200);
  assert.deepEqual(env.world.mails[0].attachments.map((a) => a.filename), ["EXP-0007.pdf", "airfare.pdf"]);

  // Lines saved before they carried expenseId cannot say which receipt is
  // theirs, so with any receipt missing none of them may say "attached".
  const legacy = expenseInvoice();
  legacy.lines = legacy.lines.map((l) => ({ date: l.date, label: l.label, amount: l.amount, detail: "receipt attached" }));
  const old = await prepare(fakeWorld(), { invoice: legacy });
  const allThere = JSON.parse(decodeText(old.body.pdf.base64).split("\n")[1]);
  assert.deepEqual(allThere.lines.map((l) => l.detail), ["receipt attached", "receipt attached"], "every receipt rides, so every line may say so");
  const env2 = fakeWorld();
  env2.world.storage.delete(`${SUBJECT}/${IDS.docHotel}`);
  const partial = await prepare(env2, { invoice: legacy });
  const onFile = JSON.parse(decodeText(partial.body.pdf.base64).split("\n")[1]);
  assert.deepEqual(onFile.lines.map((l) => l.detail), ["receipt on file", "receipt on file"]);
});

test("a receipt that vanishes after the preview stops the whole send; the same Send works after the preview is rebuilt", async () => {
  const env = fakeWorld();
  const first = await prepare(env);
  env.world.storage.delete(`${SUBJECT}/${IDS.docHotel}`);
  const res = await env.call(first.body);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "receipts_changed");
  assert.deepEqual(res.body.missing.map((m) => m.name), ["hotel.jpg"]);
  assert.equal(env.world.keys.length, 0, "a letter that says 2 receipts never went with 1");
  assert.equal(env.world.ledger[0].status, "failed", "nothing went out, so the request may try again");

  const again = await prepare(env);   // what the app does on receipts_changed
  const ok = await env.call(again.body);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(env.world.mails.length, 1);
  assert.match(env.world.mails[0].text, /The receipt is attached\./);
  assert.equal(env.world.ledger.length, 1, "the same request id, retried");
  assert.equal(env.world.ledger[0].attempts, 2);
  assert.deepEqual(env.world.keys, [`invoice-email-${env.world.ledger[0].id}-2`], "a fresh Resend idempotency key per attempt");
});

test("a letter that claims receipts the email does not carry is refused before anything is reserved", async () => {
  const env = fakeWorld();
  const { body } = await prepare(env);
  const res = await env.call({ ...body, receiptIds: body.receiptIds.slice(0, 1) });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "receipt_claim_mismatch");
  assert.match(res.body.error, /says 2 receipts are attached, but only 1 is/);
  assert.equal(env.world.keys.length, 0);
  assert.equal(env.world.reservations, 0);
});

test("only receipts this invoice bills can ride, from this account", async () => {
  const env = fakeWorld();
  // An expense that is stamped with this invoice but is not in its entryIds
  // (a second device's offline send) is not billed here: intersect, never union.
  env.world.invoices[0].entry_ids = [IDS.expAir];
  const { check } = await prepare(env);
  assert.deepEqual(check.receipts.attachable.map((r) => r.id), [IDS.docAir]);
  // Another account's document linked to the same expense id is never read.
  const env2 = fakeWorld();
  env2.world.documents[1].user_id = IDS.otherProfile;
  const c2 = await prepare(env2);
  assert.deepEqual(c2.check.receipts.attachable.map((r) => r.id), [IDS.docAir]);
  // A storage path outside the account's own folder is never fetched.
  const env3 = fakeWorld();
  env3.world.documents[1].storage_path = `user_someoneelse/${IDS.docHotel}`;
  env3.world.storage.set(`user_someoneelse/${IDS.docHotel}`, new Uint8Array([1, 2, 3]));
  const c3 = await prepare(env3);
  assert.deepEqual(c3.check.receipts.missing.map((r) => [r.id, r.reason]), [[IDS.docHotel, "unavailable"]]);
  // A client that claims the foreign-path receipt anyway (a consistent draft
  // built from a doctored check) is refused, and the foreign object is never read.
  const doctored = { ...c3.check, receipts: { attachable: [...c3.check.receipts.attachable, { id: IDS.docHotel, name: "hotel.jpg", linkedTo: `travelExpenses:${IDS.expHotel}`, size: 3 }], missing: [] } };
  const args = invoiceDocumentArgs(expenseInvoice(), contract(), settings(), "Synthetic Locums");
  const docs = invoiceEmailDocuments({ args, check: doctored, pdfFor: fakePdfFor });
  const forged = invoiceEmailSendBody({ invoiceId: IDS.invoice, requestId: REQUEST, draft: invoiceEmailDraft({ documents: docs, sender: doctored.sender, to: TO }), pdfBase64: await fileToBase64(docs.pdf) });
  const res = await env3.call(forged);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "receipts_changed");
  assert.equal(env3.world.keys.length, 0);
  assert.equal(env3.world.reads.includes("read"), false, "no Storage read at all");
  // And a receipt id the invoice does not bill cannot be slipped into a send.
  const env4 = fakeWorld();
  const c4 = await prepare(env4);
  const stranger = "dddddddd-0000-4000-8000-000000000001";
  const res4 = await env4.call({ ...c4.body, receiptIds: [...c4.body.receiptIds, stranger] });
  assert.equal(res4.status, 409);
  assert.equal(res4.body.code, "receipts_changed");
  assert.deepEqual(res4.body.missing.map((m) => m.id), [stranger]);
  assert.equal(env4.world.keys.length, 0);
});

test("idempotency: a retried tap is answered from the ledger and never mails twice", async () => {
  const env = fakeWorld();
  const { body } = await prepare(env);
  const one = await env.call(body);
  const two = await env.call(body);
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  assert.equal(two.body.replay, true);
  assert.equal(two.body.to, TO);
  assert.equal(two.body.sentAt, one.body.sentAt);
  assert.equal(env.world.keys.length, 1, "Resend was called once");
  assert.equal(env.world.reservations, 1, "the replay spent no hourly budget");
});

test("idempotency: two taps at once send one email", async () => {
  const env = fakeWorld();
  const { body } = await prepare(env);
  const results = await Promise.all([env.call(body), env.call(body), env.call(body)]);
  assert.equal(env.world.keys.length, 1, "exactly one POST to Resend");
  assert.equal(env.world.ledger.length, 1);
  assert.equal(results.filter((r) => r.status === 200 && !r.body.replay).length, 1);
  for (const r of results.filter((x) => x.status !== 200)) assert.equal(r.body.code, "send_in_progress");
});

test("idempotency: an unconfirmed send is never retried under the same request id", async () => {
  const env = fakeWorld({ mailOutcome: () => ({ state: "unknown" }) });
  const { body } = await prepare(env);
  const first = await env.call(body);
  assert.equal(first.status, 502);
  assert.equal(first.body.code, "send_unconfirmed");
  assert.match(first.body.error, /Check your copy at doc\.verified@example\.test before sending again/);
  env.world.mailOutcome = () => ({ state: "sent", providerId: "re_2" });
  const retry = await env.call(body);
  assert.equal(retry.status, 409);
  assert.equal(retry.body.code, "send_unconfirmed");
  assert.equal(env.world.keys.length, 1, "the billing office is not mailed a second time");
  assert.equal(env.world.invoices[0].last_emailed_at, null, "an unconfirmed send is not recorded as sent");
});

test("idempotency: a send Resend refused may be retried with the same request id", async () => {
  let n = 0;
  const env = fakeWorld({ mailOutcome: () => (++n === 1 ? { state: "failed" } : { state: "sent", providerId: "re_ok" }) });
  const { body } = await prepare(env);
  const first = await env.call(body);
  assert.equal(first.status, 502);
  assert.equal(first.body.code, "send_failed");
  const second = await env.call(body);
  assert.equal(second.status, 200);
  assert.equal(env.world.keys.length, 2);
  assert.notEqual(env.world.keys[0], env.world.keys[1]);
  assert.equal(env.world.ledger[0].status, "sent");
  assert.equal(env.world.ledger[0].provider_id, "re_ok");
});

test("idempotency: a request id reused for another invoice is refused", async () => {
  const env = fakeWorld();
  const a = await prepare(env);
  await env.call(a.body);
  const b = await prepare(env, { invoice: workInvoice() });
  const res = await env.call(b.body);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "request_reused");
  assert.equal(env.world.keys.length, 1);
});

test("access: a Credential-only account is refused before anything of its invoice is read", async () => {
  const env = fakeWorld({ access: { practice: false } });
  for (const body of [{ action: "check", invoiceId: IDS.invoice, pdfBytes: 100 },
    { action: "send", invoiceId: IDS.invoice, requestId: REQUEST, to: TO, subject: "x", letter: "x", receiptIds: [], pdf: { name: "a.pdf", base64: "JVBERi0=" }, preview: {} }]) {
    const res = await env.call(body);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, "membership_read_only");
    assert.match(res.body.error, /does not include sending Practice records/);
  }
  assert.deepEqual([...new Set(env.world.reads)], ["access"], "no profile, invoice, storage, ledger or mail");
  // Membership that cannot be checked refuses too, retryably.
  const env2 = fakeWorld();
  env2.deps.accessDb.rpc = async () => ({ data: null, error: { message: "down" } });
  const res2 = await env2.call({ action: "check", invoiceId: IDS.invoice, pdfBytes: 100 });
  assert.equal(res2.status, 503);
  assert.equal(res2.body.code, "access_policy_unavailable");
  // Signed out is 401.
  const out = fakeWorld({ signedOut: true });
  assert.equal((await out.call({ action: "check", invoiceId: IDS.invoice, pdfBytes: 1 })).status, 401);
});

test("rate limit: over the hourly cap, or a ledger that cannot answer, refuses without mailing", async () => {
  const env = fakeWorld();
  const { body } = await prepare(env);
  env.world.reserveResult = { data: null, error: null };
  const cap = await env.call(body);
  assert.equal(cap.status, 429);
  assert.equal(cap.body.code, "send_cap_reached");
  env.world.reserveResult = { data: null, error: { message: "relation does not exist" } };
  const down = await env.call(body);
  assert.equal(down.status, 429);
  assert.equal(down.body.code, "send_ledger_unavailable");
  assert.equal(down.headers.get("retry-after"), "60");
  assert.equal(env.world.keys.length, 0);
  assert.equal(env.world.ledger.length, 0, "no claim is taken before the budget is");
  assert.equal(reservationVerdict({ data: [] }).code, "send_cap_reached");
  assert.equal(reservationVerdict(undefined).code, "send_ledger_unavailable");
  assert.equal(reservationVerdict({ data: "id" }).send, true);
  assert.equal(sendWindowStart(Date.parse("2026-09-25T15:00:00Z")), "2026-09-25T14:00:00.000Z");
});

test("no amount or invoice term changes: the email is built from the resend's own arguments and the invoice gains only the stamp", async () => {
  const env = fakeWorld();
  const client = expenseInvoice();
  const before = structuredClone(client);
  const rowBefore = structuredClone(env.world.invoices[0]);
  const { args, draft, body } = await prepare(env, { invoice: client });
  // The arguments are exactly the resend's: invoiceDocumentArgs is the one builder.
  assert.equal(args.total, 700);
  assert.equal(args.paid, 100);
  assert.equal(args.balance, 600);
  assert.equal(args.terms, before.terms);
  // The letter is the cover letter the app already writes, word for word.
  assert.equal(draft.letter, invoiceCoverEmail({ ...args, receipts: 2 }, { attached: true }));
  assert.match(draft.email.text, /Invoice total: \$700\.00\nPaid to date: \$100\.00\nBalance due: \$600\.00/);
  const pdf = JSON.parse(decodeText(body.pdf.base64).split("\n")[1]);
  assert.deepEqual([pdf.total, pdf.paid, pdf.balance, pdf.terms], [700, 100, 600, before.terms]);
  assert.deepEqual(pdf.lines.map((l) => [l.date, l.label, l.amount]), before.lines.map((l) => [l.date, l.label, l.amount]));
  const res = await env.call(body);
  assert.equal(res.status, 200);
  assert.deepEqual(client, before, "the app's invoice object is untouched");
  const rowAfter = env.world.invoices[0];
  assert.deepEqual({ ...rowAfter, last_emailed_at: null, last_emailed_to: null }, rowBefore, "only the two stamp columns changed");
  assert.equal(rowAfter.updated_at, rowBefore.updated_at, "updated_at untouched: a stale device cannot win on it");
  assert.equal(rowAfter.last_emailed_at, res.body.sentAt);
  assert.equal(rowAfter.last_emailed_to, TO);
});

test("the send is recorded: the next check says when and to whom, and an older send never overwrites a newer stamp", async () => {
  const env = fakeWorld();
  const { body } = await prepare(env);
  const sent = await env.call(body);
  const again = await env.call({ action: "check", invoiceId: IDS.invoice, pdfBytes: 100 });
  assert.deepEqual(again.body.lastSend, { at: sent.body.sentAt, to: TO });
  env.world.invoices[0].last_emailed_at = "2026-12-01T00:00:00.000Z";
  await env.call(body);   // replay of the older send
  assert.equal(env.world.invoices[0].last_emailed_at, "2026-12-01T00:00:00.000Z");
});

test("bad input is refused before anything is reserved or read from Storage", async () => {
  const env = fakeWorld();
  const { body } = await prepare(env);
  const cases = [
    [{ ...body, to: "not an address" }, 400, "recipient_invalid"],
    [{ ...body, to: "docs@credentialdomd.com" }, 400, "recipient_invalid"],
    [{ ...body, pdf: { name: "EXP-0007.pdf", base64: toBase64(new TextEncoder().encode("<html>not a pdf")) } }, 400, "pdf_invalid"],
    [{ ...body, pdf: { name: "EXP-0007.pdf", base64: "%%%%" } }, 400, "pdf_invalid"],
    [{ ...body, requestId: "not-a-uuid" }, 400, "invalid_request"],
    [{ ...body, letter: "x".repeat(5001) }, 400, "letter_too_long"],
    [{ ...body, extra: 1 }, 400, "invalid_request"],
    [{ ...body, invoiceId: IDS.otherProfile }, 404, "invoice_not_found"],
  ];
  for (const [input, status, code] of cases) {
    const res = await env.call(input);
    assert.equal(res.status, status, `${code}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, code);
  }
  const huge = await env.call(null, { raw: JSON.stringify({ ...body, pdf: { name: "a.pdf", base64: "A".repeat(9 * 1024 * 1024) } }) });
  assert.equal(huge.status, 413);
  assert.equal(env.world.keys.length, 0);
  assert.equal(env.world.reservations, 0);
  assert.equal(env.world.reads.includes("read"), false);
  assert.equal((await env.call(null, { method: "GET" })).status, 405);
});

test("the caps: an email carries at most 10 files and 25 MB, and the rest are named before Send", async () => {
  const env = fakeWorld();
  // Twelve receipts on the airfare expense.
  for (let i = 0; i < 12; i++) {
    const id = `cccccccc-0000-4000-8000-${String(i).padStart(12, "0")}`;
    env.world.documents.push({ id, user_id: IDS.profile, name: `r${String(i).padStart(2, "0")}.jpg`, mime_type: "image/jpeg", type: "image/jpeg",
      storage_path: `${SUBJECT}/${id}`, linked_to: `travelExpenses:${IDS.expAir}` });
    env.world.storage.set(`${SUBJECT}/${id}`, new Uint8Array(10));
  }
  const { check, draft } = await prepare(env);
  assert.equal(check.receipts.attachable.length, 9, "the invoice PDF plus nine receipts");
  assert.equal(check.receipts.missing.length, 5);
  assert.ok(check.receipts.missing.every((m) => m.reason === "too_many"));
  assert.match(draft.missingText, /5 receipts could not be attached .* because one email carries at most 10 files\./);
  assert.match(draft.email.text, /9 receipts are attached\./);

  // 18 MB is 24 MB of base64: the airfare fits, the 1 MB hotel photo then does not.
  const big = fakeWorld();
  big.world.storage.set(`${SUBJECT}/${IDS.docAir}`, new Uint8Array(18 * 1024 * 1024));
  big.world.storage.set(`${SUBJECT}/${IDS.docHotel}`, new Uint8Array(1024 * 1024));
  const b = await prepare(big);
  assert.deepEqual(b.check.receipts.attachable.map((r) => r.name), ["airfare.pdf"]);
  assert.deepEqual(b.check.receipts.missing.map((m) => [m.name, m.reason]), [["hotel.jpg", "too_large"]]);
});
