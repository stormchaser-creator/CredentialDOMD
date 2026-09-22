import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveDocument, resolveDocuments, missingReceiptMessage, billedReceiptDocs,
} from "../src/utils/receiptFiles.js";

const dataUrl = (mime, text) => `data:${mime};base64,${Buffer.from(text).toString("base64")}`;
const blobOf = (text, type) => new Blob([new TextEncoder().encode(text)], { type });

test("a receipt cached on the device is used without touching the network", async () => {
  let called = false;
  const r = await resolveDocument(
    { id: "d1", name: "hotel.pdf", type: "application/pdf", data: dataUrl("application/pdf", "PDFBYTES"), storagePath: "u/1" },
    { download: async () => { called = true; return null; } });
  assert.equal(r.reason, null);
  assert.equal(r.file.name, "hotel.pdf");
  assert.equal(r.file.type, "application/pdf");
  assert.equal(await r.file.text(), "PDFBYTES");
  assert.equal(called, false, "a locally cached receipt must not cost a download");
});

test("a receipt stripped from the device cache is fetched from storage", async () => {
  // saveData in src/utils/storage.js deletes `data` once storagePath exists,
  // which is exactly why the send used to drop receipts silently.
  const r = await resolveDocument(
    { id: "d2", name: "process (2).pdf", type: "application/pdf", storagePath: "user_abc/uuid" },
    { download: async (p) => (p === "user_abc/uuid" ? blobOf("REAL", "application/pdf") : null) });
  assert.equal(r.reason, null);
  assert.equal(r.file.name, "process (2).pdf", "spaces and parentheses are preserved");
  assert.equal(await r.file.text(), "REAL");
});

test("failures are named honestly and never silently dropped", async () => {
  const gone = await resolveDocument({ id: "a", name: "x.pdf", storagePath: "u/x" }, { download: async () => null });
  assert.equal(gone.reason, "unavailable");
  assert.equal(gone.file, null);

  // No storagePath and no bytes: retrying can never help, so say so.
  const never = await resolveDocument({ id: "b", name: "y.pdf" }, { download: async () => blobOf("x") });
  assert.equal(never.reason, "never_uploaded");

  const corrupt = await resolveDocument({ id: "c", name: "z.pdf", data: "not-a-data-url" }, {});
  assert.equal(corrupt.reason, "corrupt");

  const thrown = await resolveDocument({ id: "d", name: "t.pdf", storagePath: "u/t" },
    { download: async () => { throw new Error("network"); } });
  assert.equal(thrown.reason, "corrupt");
});

test("the inbox sentinel never becomes the attachment's MIME type", async () => {
  // A receipt that arrived by email carries type = "request-attachment-inbox"
  // and the real type in mimeType. The old send used raw doc.type, which
  // produced an attachment a mail client will not open.
  const r = await resolveDocument(
    { id: "e", name: "r.pdf", type: "request-attachment-inbox", mimeType: "application/pdf", storagePath: "u/r" },
    { download: async () => blobOf("X", "application/pdf") });
  assert.equal(r.file.type, "application/pdf");
});

test("results are keyed by document id, never by filename", async () => {
  // Two receipts from one camera roll share a name; keying by name would
  // credit one expense with the other's proof.
  const docs = [
    { id: "one", name: "IMG_0001.jpg", type: "image/jpeg", storagePath: "u/1" },
    { id: "two", name: "IMG_0001.jpg", type: "image/jpeg", storagePath: "u/2" },
  ];
  const { files, missing, byId } = await resolveDocuments(docs,
    { download: async (p) => (p === "u/1" ? blobOf("A", "image/jpeg") : null) });
  assert.equal(files.length, 1);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].id, "two");
  assert.equal(byId.get("one").reason, null);
  assert.equal(byId.get("two").reason, "unavailable");
});

test("the whole bundle shares one time budget instead of stalling per file", async () => {
  // Nine receipts at a 20s per-file timeout would freeze a live invoice for
  // three minutes. Anything past the budget is reported, not attempted.
  const docs = Array.from({ length: 5 }, (_, i) => ({ id: `d${i}`, name: `r${i}.pdf`, storagePath: `u/${i}` }));
  let attempts = 0;
  let clock = 0;
  const { files, missing } = await resolveDocuments(docs, {
    budgetMs: 100,
    now: () => clock,
    download: async () => { attempts += 1; clock += 60; return blobOf("x"); },
  });
  assert.equal(attempts, 2, "the loop stops attempting once the budget is spent");
  assert.equal(files.length, 2);
  assert.equal(missing.length, 3);
  assert.ok(missing.every(m => m.reason === "timeout"));
});

test("the missing-receipt message names the files and the real reason", () => {
  assert.equal(missingReceiptMessage([]), "");
  const one = missingReceiptMessage([{ name: "process (2).pdf", reason: "offline" }]);
  assert.match(one, /1 receipt could not be attached/);
  assert.match(one, /process \(2\)\.pdf/);
  assert.match(one, /you are offline/);
  const many = missingReceiptMessage([
    { name: "a.pdf", reason: "timeout" }, { name: "b.pdf", reason: "timeout" },
    { name: "c.pdf", reason: "timeout" }, { name: "d.pdf", reason: "timeout" }]);
  assert.match(many, /4 receipts/);
  assert.match(many, /and 1 more/);
});

test("a resend attaches proof for the expenses this invoice bills, and no others", () => {
  const invoice = { id: "INV1", kind: "expenses", entryIds: ["e1", "e2"] };
  const expenses = [
    { id: "e1", invoiceId: "INV1" },
    { id: "e2", invoiceId: "INV1" },
    { id: "e3", invoiceId: "INV2" },                 // billed on another invoice
    { id: "e4", invoiceId: "INV1" },                 // claims this invoice but is not in entryIds
  ];
  const documents = [
    { id: "r1", linkedTo: "travelExpenses:e1" },
    { id: "r2", linkedTo: "travelExpenses:e2" },
    { id: "r3", linkedTo: "travelExpenses:e3" },
    { id: "r4", linkedTo: "travelExpenses:e4" },
    { id: "rx", linkedTo: "licenses:e1" },           // different collection, same id shape
  ];
  const got = billedReceiptDocs(invoice, expenses, documents).map(d => d.id).sort();
  assert.deepEqual(got, ["r1", "r2"], "a union would have attached r3 or r4 to someone else's bill");
});

test("only expense invoices carry receipts, and bad input is survivable", () => {
  const docs = [{ id: "r1", linkedTo: "travelExpenses:e1" }];
  const exps = [{ id: "e1", invoiceId: "INV1" }];
  assert.deepEqual(billedReceiptDocs({ id: "INV1", kind: null, entryIds: ["e1"] }, exps, docs), []);
  assert.deepEqual(billedReceiptDocs({ id: "INV1", kind: "expenses" }, exps, docs), []);
  assert.deepEqual(billedReceiptDocs(null, exps, docs), []);
  assert.deepEqual(billedReceiptDocs({ id: "INV1", kind: "expenses", entryIds: ["e1"] }, null, null), []);
});
