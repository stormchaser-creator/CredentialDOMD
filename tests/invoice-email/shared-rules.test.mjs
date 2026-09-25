import test from "node:test";
import assert from "node:assert/strict";
import {
  invoiceEmailSender, invoiceEmailSubject, invoiceEmailText, invoiceEmailFooter, recipientProblem,
  receiptsClaimed, receiptClaimProblem, uniqueAttachmentNames, invoicePdfName, composeInvoiceEmail,
  safeAttachmentName, base64Length, INVOICE_EMAIL_FROM_ADDRESS,
} from "../../src/utils/invoiceEmail.js";
import * as edgeCopy from "../../supabase/functions/_shared/app/utils/invoiceEmail.js";
import { invoiceCoverEmail } from "../../src/utils/invoiceCover.js";
import { plainDashes as helpersPlainDashes } from "../../src/utils/helpers.js";
import { plainDashes } from "../../src/utils/outgoingText.js";

// The rules the app's preview and send-invoice-email share (tickets e8cc2a02,
// 821d2f76). Synthetic people and addresses only.

const EM = String.fromCodePoint(0x2014);
const LS = String.fromCodePoint(0x2028);
const sender = invoiceEmailSender({ name: "Synthetic Physician", degree: "DO", email: "typed@example.test", verifiedEmail: "Verified@Example.test" });

test("the sender: provider-verified mailbox first, then the profile email, then a refusal", () => {
  assert.deepEqual(sender, {
    ok: true, displayName: "Synthetic Physician, DO", fromName: "Synthetic Physician, DO via CredentialDOMD",
    from: `"Synthetic Physician, DO via CredentialDOMD" <${INVOICE_EMAIL_FROM_ADDRESS}>`,
    replyTo: "verified@example.test", cc: "verified@example.test",
  });
  const typedOnly = invoiceEmailSender({ name: "Synthetic Physician", degree: "", email: " Typed@Example.test ", verifiedEmail: null });
  assert.equal(typedOnly.replyTo, "typed@example.test");
  assert.equal(typedOnly.fromName, "Synthetic Physician via CredentialDOMD", "no degree, no dangling comma");
  const badVerified = invoiceEmailSender({ name: "A", email: "typed@example.test", verifiedEmail: "not-an-address" });
  assert.equal(badVerified.replyTo, "typed@example.test", "an unusable verified value falls back to the profile email");
  const none = invoiceEmailSender({ name: "A", email: "", verifiedEmail: "" });
  assert.equal(none.ok, false);
  assert.match(none.problem, /Add your email in Settings/);
  const noName = invoiceEmailSender({ email: "typed@example.test" });
  assert.equal(noName.fromName, "CredentialDOMD");
  assert.equal(noName.displayName, "typed@example.test");
});

test("the From header cannot be broken by a name with quotes, brackets or line breaks", () => {
  const s = invoiceEmailSender({ name: 'Evil "Name"\r\nBcc: x@y.test <z>', degree: "MD", email: "a@example.test" });
  assert.doesNotMatch(s.from.slice(1, s.from.indexOf('" <')), /["<>\r\n]/);
  assert.match(s.from, /^"[^"]+ via CredentialDOMD" <docs@credentialdomd\.com>$/);
});

test("the subject is one line with no em dash and nothing SSN-shaped", () => {
  assert.equal(invoiceEmailSubject(`Invoice INV-1 ${EM} Synthetic\r\nHospital`), "Invoice INV-1, Synthetic Hospital");
  assert.equal(invoiceEmailSubject("Invoice for 123-45-6789"), "Invoice for [SSN removed]");
  assert.equal(invoiceEmailSubject("x".repeat(400)).length, 200);
});

test("the letter keeps every line break it was written with, and gains exactly one footer paragraph", () => {
  const letter = ["Hello,", "Attached is invoice INV-1.", "Invoice total: $1,000.00\nPaid to date: $400.00\nBalance due: $600.00", "Thank you,\nSynthetic Physician, DO"].join("\n\n");
  const text = invoiceEmailText(letter, "Synthetic Physician, DO");
  assert.equal(text, `${letter}\n\n${invoiceEmailFooter("Synthetic Physician, DO")}`);
  assert.equal(text.split("\n\n").length, 5, "four paragraphs and the footer");
  assert.ok(text.includes("Invoice total: $1,000.00\nPaid to date: $400.00\nBalance due: $600.00"), "money stays on its own lines");
});

test("every kind of line break becomes a plain newline; blank runs and trailing spaces are tidied", () => {
  const text = invoiceEmailText(`Hello,  \r\n\r\n\r\n\r\nLine one\rLine two${LS}Line three`, "X");
  assert.equal(text, `Hello,\n\nLine one\nLine two\nLine three\n\n${invoiceEmailFooter("X")}`);
  assert.doesNotMatch(text, /\r/);
});

test("no em dash and no SSN leaves in the body", () => {
  const text = invoiceEmailText(`Coverage ${EM} nights\n${EM} note\nSSN 123456789 and 123-45-6789`, "X");
  assert.ok(!text.includes(EM));
  assert.match(text, /Coverage, nights\nnote\nSSN \[SSN removed\] and \[SSN removed\]/);
});

test("plainDashes moved to outgoingText.js and helpers.js still exports the same function", () => {
  assert.equal(helpersPlainDashes, plainDashes);
});

test("the receipt claim is read from the app's own wording, and anything else is refused", () => {
  for (const n of [0, 1, 2, 7]) {
    const letter = invoiceCoverEmail({ number: "EXP-1", kind: "expenses", total: 10, receipts: n, physician: "P" });
    assert.equal(receiptsClaimed(invoiceEmailText(letter, "P")), n, `invoiceCover's ${n}-receipt letter`);
    assert.equal(receiptClaimProblem(letter, n), null);
  }
  // A work invoice never mentions receipts.
  assert.equal(receiptsClaimed(invoiceCoverEmail({ number: "INV-1", total: 10, facility: "Synthetic Hospital" })), 0);
  assert.equal(receiptsClaimed("Receipts attached."), null, "a claim in another form cannot be counted");
  assert.equal(receiptsClaimed("The receipt is attached. The receipt is attached."), null, "two claims cannot be counted");
});

test("a letter that claims more receipts than ride, or fewer, is refused with a reason", () => {
  const two = invoiceCoverEmail({ number: "EXP-1", kind: "expenses", total: 10, receipts: 2 });
  assert.match(receiptClaimProblem(two, 1), /says 2 receipts are attached, but only 1 is/);
  assert.match(receiptClaimProblem(two, 0), /but none is/);
  const none = invoiceCoverEmail({ number: "EXP-1", kind: "expenses", total: 10, receipts: 0 });
  assert.match(receiptClaimProblem(none, 2), /2 receipts ride with the invoice, but the letter does not say so/);
});

test("recipients: an address, not ours", () => {
  assert.equal(recipientProblem("billing@hospital.example"), null);
  assert.equal(recipientProblem(" Billing@Hospital.Example "), null);
  assert.match(recipientProblem(""), /Enter the billing office/);
  assert.match(recipientProblem("billing@"), /valid recipient/);
  assert.match(recipientProblem("a@b.c"), /valid recipient/);
  assert.match(recipientProblem("docs@credentialdomd.com"), /CredentialDOMD address/);
  assert.match(recipientProblem("x@mail.credentialdomd.com"), /CredentialDOMD address/);
});

test("attachment names are safe, unique and the PDF is named from the invoice number", () => {
  assert.equal(invoicePdfName("INV-2026/09-01"), "INV-2026_09-01.pdf");
  assert.equal(invoicePdfName(""), "invoice.pdf");
  assert.deepEqual(uniqueAttachmentNames(["INV-1.pdf", "receipt.jpg", "Receipt.jpg", "receipt.jpg", "a:b"]),
    ["INV-1.pdf", "receipt.jpg", "Receipt (2).jpg", "receipt (3).jpg", "a_b"]);
  assert.equal(safeAttachmentName(safeAttachmentName(' x/"y".pdf ')), safeAttachmentName(' x/"y".pdf '), "idempotent, so both sides agree");
  assert.equal(base64Length(3), 4);
  assert.equal(base64Length(4), 8);
});

test("the composed message: the physician gets a copy unless they are the recipient", () => {
  const args = { sender, subject: "Invoice INV-1", letter: "Hello,\n\nAttached.", attachments: [{ name: "INV-1.pdf" }] };
  const out = composeInvoiceEmail({ ...args, to: "Billing@Hospital.Example" });
  assert.deepEqual(out, {
    from: sender.from, fromName: sender.fromName, to: "billing@hospital.example", cc: "verified@example.test",
    replyTo: "verified@example.test", subject: "Invoice INV-1",
    text: `Hello,\n\nAttached.\n\n${invoiceEmailFooter("Synthetic Physician, DO")}`, attachments: ["INV-1.pdf"],
  });
  assert.equal(composeInvoiceEmail({ ...args, to: "verified@example.test" }).cc, "", "a test send to yourself is not copied to yourself");
});

test("the edge function's copy of the rules is the same code", () => {
  for (const name of ["invoiceEmailSender", "invoiceEmailText", "composeInvoiceEmail", "receiptClaimProblem", "recipientProblem"]) {
    assert.equal(typeof edgeCopy[name], "function", name);
  }
  const input = { sender, to: "b@hospital.example", subject: `A ${EM} B`, letter: "Hello,\r\n\r\nX", attachments: [{ name: "a.pdf" }, { name: "a.pdf" }] };
  assert.deepEqual(edgeCopy.composeInvoiceEmail(input), composeInvoiceEmail(input));
});
