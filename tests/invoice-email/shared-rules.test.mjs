import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  invoiceEmailSender, invoiceEmailSubject, invoiceEmailText, invoiceEmailFooter, recipientProblem,
  receiptsClaimed, receiptClaimProblem, uniqueAttachmentNames, invoicePdfName, composeInvoiceEmail,
  safeAttachmentName, base64Length, INVOICE_EMAIL_FROM_ADDRESS, invoiceEmailHtml, invoiceEmailHtmlBody, invoiceFileName,
} from "../../src/utils/invoiceEmail.js";
import * as edgeCopy from "../../supabase/functions/_shared/app/utils/invoiceEmail.js";
import { invoiceCoverEmail, invoiceCoverBlurb, invoiceSubject } from "../../src/utils/invoiceCover.js";
import { plainDashes as helpersPlainDashes } from "../../src/utils/helpers.js";
import { plainDashes, oneDegree } from "../../src/utils/outgoingText.js";
import * as edgeOutgoing from "../../supabase/functions/_shared/app/utils/outgoingText.js";

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
  // Named like a subject (Gmail on the iPhone takes the file name as one).
  assert.equal(invoicePdfName("INV-2026/09-01"), "Invoice INV-2026 09-01.pdf");
  assert.equal(invoicePdfName("INV-1", "Al Li, DO"), "Invoice INV-1 from Al Li, DO.pdf");
  assert.equal(invoicePdfName("INV-1", "Physician"), "Invoice INV-1.pdf", "the no-name placeholder is not a sender");
  assert.equal(invoicePdfName(""), "Invoice.pdf");
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
    text: `Hello,\n\nAttached.\n\n${invoiceEmailFooter("Synthetic Physician, DO")}`,
    html: invoiceEmailHtml("Hello,\n\nAttached.", "Synthetic Physician, DO"), attachments: ["INV-1.pdf"],
  });
  assert.equal(composeInvoiceEmail({ ...args, to: "verified@example.test" }).cc, "", "a test send to yourself is not copied to yourself");
});

test("the edge function's copy of the rules is the same code", () => {
  for (const name of ["invoiceEmailSender", "invoiceEmailText", "invoiceEmailHtml", "composeInvoiceEmail", "receiptClaimProblem", "recipientProblem", "invoiceFileName"]) {
    assert.equal(typeof edgeCopy[name], "function", name);
  }
  const input = { sender, to: "b@hospital.example", subject: `A ${EM} B`, letter: "Hello,\r\n\r\nX", attachments: [{ name: "a.pdf" }, { name: "a.pdf" }] };
  assert.deepEqual(edgeCopy.composeInvoiceEmail(input), composeInvoiceEmail(input));
});

// ── The HTML part (owner's iPhone, Oct 2026: the share-sheet body arrived as
// one run-on <div>; the server email is now multipart) ──

const LETTER = invoiceCoverEmail({
  number: "INV-0012", physician: "Synthetic <Physician> & Co, DO", npi: "9999999999", email: "doc@example.test", phone: "555-010-0100",
  facility: "Synthetic \"Regional\" Medical Center", periodStart: "2026-08-01", periodEnd: "2026-08-15", total: 3025, paid: 1500, balance: 1525,
});
const blocksOf = (html) => [...html.matchAll(/<(p|table)\b[^>]*>(.*?)<\/\1>/g)].map((m) => ({ tag: m[1], inner: m[2] }));

test("the HTML part: greeting, paragraphs, a two-column money block, a signature block and the grey footer", () => {
  const html = invoiceEmailHtml(LETTER, "Synthetic Physician, DO");
  assert.match(html, /^<!DOCTYPE html><html><head><meta charset="utf-8">/);
  assert.match(html, /<meta name="color-scheme" content="light dark">/, "dark mode keeps the client's own colours");
  assert.doesNotMatch(html, /<style|<link|<img|<script|src=|url\(/i, "inline styles only, no images, nothing external");
  const blocks = blocksOf(html);
  assert.deepEqual(blocks[0], { tag: "p", inner: "Hello," }, "a greeting paragraph first");
  assert.match(blocks[1].inner, /^Attached is invoice INV-0012 for physician services at Synthetic &quot;Regional&quot; Medical Center/);
  assert.equal(blocks[2].tag, "table", "the money is set apart");
  const rows = [...blocks[2].inner.matchAll(/<tr><td[^>]*>([^<]*)<\/td><td[^>]*>([^<]*)<\/td><\/tr>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(rows, [["Invoice total", "$3,025.00"], ["Paid to date", "$1,500.00"], ["Balance due", "$1,525.00"]], "two columns: label and amount");
  assert.match(blocks[2].inner, /<tr><td style="[^"]*font-weight:700;">Balance due/, "what is owed is the bold last row");
  const sig = blocks.findIndex((b) => b.inner === "Thank you,");
  assert.ok(sig > 2, "a sign-off");
  assert.equal(blocks[sig + 1].inner,
    "<strong>Synthetic &lt;Physician&gt; &amp; Co, DO</strong>"
    + '<br><span style="color:#6b7280;font-size:14px;">NPI 9999999999</span>'
    + '<br><span style="color:#6b7280;font-size:14px;">doc@example.test</span>'
    + '<br><span style="color:#6b7280;font-size:14px;">555-010-0100</span>', "name bold, then NPI, email and phone in grey");
  const footer = blocks.at(-1);
  assert.match(footer.inner, /^Sent from CredentialDOMD on behalf of Synthetic Physician, DO\./);
  assert.match(html, /<p style="[^"]*color:#6b7280;font-size:12px;[^"]*">Sent from CredentialDOMD/, "the footer is small and grey");
});

// With no name in Settings the letter's signature starts with the NPI or the
// email, and the HTML set that contact line in bold where a name belongs.
test("the HTML signature bolds only a name, never an NPI, email or phone standing in for one", () => {
  const sigOf = (inv) => {
    const blocks = blocksOf(invoiceEmailHtmlBody(invoiceCoverEmail({ number: "INV-1", total: 100, ...inv }), "x"));
    return blocks[blocks.findIndex((b) => b.inner === "Thank you,") + 1].inner;
  };
  const grey = (t) => `<span style="color:#6b7280;font-size:14px;">${t}</span>`;
  assert.equal(sigOf({ physician: "Physician", npi: "9999999901", email: "al@example.test" }), `${grey("al@example.test")}<br>${grey("NPI 9999999901")}`, "the email signs ahead of the NPI");
  assert.equal(sigOf({ physician: "Physician", email: "al@example.test" }), grey("al@example.test"));
  assert.equal(sigOf({ physician: "Physician", phone: "(555) 010-0199" }), grey("(555) 010-0199"));
  assert.equal(sigOf({ physician: "Al Li, DO", email: "al@example.test" }), `<strong>Al Li, DO</strong><br>${grey("al@example.test")}`);
  for (const inv of [{ physician: "Physician", npi: "9999999901" }, { physician: "", email: "al@example.test" }]) {
    assert.doesNotMatch(sigOf(inv), /<strong>/);
  }
});

test("a degree printed twice by a send site reads once in the file name", () => {
  assert.equal(invoiceFileName({ number: "INV-1", physician: "Jordan Rivera, DO, DO" }, "pdf"), "Invoice INV-1 from Jordan Rivera, DO.pdf");
  assert.equal(invoiceFileName({ number: "INV-1", physician: "Ann Do, DO" }, "pdf"), "Invoice INV-1 from Ann Do, DO.pdf", "a surname that spells a degree stays");
  assert.equal(invoicePdfName("INV-1", "Jordan Rivera, MD, MD"), "Invoice INV-1 from Jordan Rivera, MD.pdf");
});

// A degree typed into the name with a space ("Jordan Rivera DO") and then
// ", DO" appended by a send site reached the Gmail subject, the blurb and
// the PDF as "Jordan Rivera DO, DO": oneDegree only looked for a comma.
test("a degree typed without a comma, then appended again, reads once", () => {
  assert.equal(oneDegree("Jordan Rivera DO, DO"), "Jordan Rivera DO");
  assert.equal(oneDegree("Jordan Rivera D.O., DO"), "Jordan Rivera D.O.");
  assert.equal(oneDegree("Jordan Rivera, DO, DO"), "Jordan Rivera, DO");
  assert.equal(oneDegree("Ann Do, DO"), "Ann Do, DO", "a surname that spells a degree stays");
  assert.equal(oneDegree("Jordan Rivera MD, DO"), "Jordan Rivera MD, DO", "two different degrees stay");
  assert.equal(edgeOutgoing.oneDegree("Jordan Rivera DO, DO"), "Jordan Rivera DO", "the edge copy agrees");
  const inv = { number: "INV-1", physician: "Jordan Rivera DO, DO", facility: "Example Hospital", total: 100 };
  assert.equal(invoiceFileName(inv, "pdf"), "Invoice INV-1 from Jordan Rivera DO.pdf");
  assert.equal(invoiceSubject(inv), "Invoice INV-1 from Jordan Rivera DO for Example Hospital");
  assert.match(invoiceCoverBlurb(inv), /Thank you,\nJordan Rivera DO$/);
});

// Gmail on the iPhone takes the file name less its extension as the subject.
// Stripping the trailing dot ("D.O.pdf") made that subject "...Rivera, D.O".
test("a name ending in a dotted degree keeps its period in the file name and so in the Gmail subject", () => {
  const gmailSubject = (name) => name.replace(/\.pdf$/, "");
  for (const physician of ["Jordan Rivera, D.O.", "Jordan Rivera, D.O., DO"]) {
    assert.equal(gmailSubject(invoiceFileName({ number: "INV-1", physician }, "pdf")), "Invoice INV-1 from Jordan Rivera, D.O.");
  }
  assert.equal(gmailSubject(invoiceFileName({ number: "INV-1", physician: "Jordan Rivera, M.D." }, "pdf")), "Invoice INV-1 from Jordan Rivera, M.D.");
  assert.equal(invoiceFileName({ number: "INV-1", physician: "Jordan Rivera, M.D." }, "pdf"), "Invoice INV-1 from Jordan Rivera, M.D..pdf");
});

// The email the server sends sets its own subject, so the kept period only
// showed on its attachment as "D.O..pdf".
test("the server email's attachment drops a dotted degree's period instead of reading D.O..pdf", () => {
  assert.equal(invoicePdfName("INV-1", "Jordan Rivera, D.O."), "Invoice INV-1 from Jordan Rivera, D.O.pdf");
  assert.equal(invoicePdfName("INV-1", "Jordan Rivera, M.D."), "Invoice INV-1 from Jordan Rivera, M.D.pdf");
  assert.equal(edgeCopy.invoicePdfName("INV-1", "Jordan Rivera, D.O."), "Invoice INV-1 from Jordan Rivera, D.O.pdf", "the edge copy agrees");
  assert.equal(invoicePdfName("INV-1", "Al Li, DO"), "Invoice INV-1 from Al Li, DO.pdf");
  assert.doesNotMatch(invoicePdfName("INV-1", "Jordan Rivera, D.O."), /\.\.pdf$/);
});

test("a file name cut at 100 characters never ends in a stray period or comma", () => {
  for (let len = 76; len <= 100; len++) { // 76+: "Invoice INV-1 from " + name + ", D.O." passes 100
    const physician = `${"A".repeat(len)}, D.O.`;
    for (const name of [invoiceFileName({ number: "INV-1", physician }, "pdf"), invoicePdfName("INV-1", physician)]) {
      assert.doesNotMatch(name, /[.,\s]\.pdf$/, name);
      assert.ok(name.length <= 104, name);
    }
  }
  const short = invoiceFileName({ number: "INV-1", physician: "Jordan Rivera, D.O." }, "pdf");
  assert.equal(short, "Invoice INV-1 from Jordan Rivera, D.O..pdf", "an uncut dotted degree keeps its period for the Gmail subject");
});

// The cut stripped only trailing punctuation, so a name cut inside ", D.O."
// read "..., D.pdf" (Gmail subject "..., D") and a longer name was cut
// mid-word ("...Villanueva Montenegr.pdf").
test("a file name cut at 100 characters ends on a whole word, never a partial word or degree", () => {
  const ends = [];
  for (let len = 1; len <= 60; len++) {
    for (const number of ["INV-1", "INV-20260915-1"]) {
      for (const degree of ["D.O.", "DO", "M.D."]) {
        const physician = `Jordan ${"B".repeat(len)} Villanueva Montenegro, ${degree}`;
        const whole = `Invoice ${number} from ${physician}`;
        for (const name of [invoiceFileName({ number, physician }, "pdf"), invoicePdfName(number, physician), edgeCopy.invoiceFileName({ number, physician }, "pdf")]) {
          const base = name.replace(/\.pdf$/, "");
          assert.ok(base.length <= 100, name);
          assert.ok(whole.startsWith(base), `${name} is a cut of ${whole}`);
          if (whole.length > 100) {
            assert.match(whole.slice(base.length), /^[\s,.]/, `${name} stops at a word boundary`);
            assert.doesNotMatch(base, /(,|\s)[A-Z]$/, `${name} has no stray single letter`);
            assert.doesNotMatch(base, /[,\s]$|\sfrom$/, name);
            ends.push(base.split(" ").pop());
          }
        }
      }
    }
  }
  assert.ok(ends.length > 0, "the loop reached names over 100 characters");
  assert.ok(ends.every((w) => /^(Villanueva|Montenegro|B+|Jordan)$/.test(w)), [...new Set(ends)].join(" "));
  assert.equal(invoiceFileName({ number: "INV-20260915-1", physician: `Jordan ${"B".repeat(45)} Villanueva Montenegro, D.O.` }, "pdf"),
    `Invoice INV-20260915-1 from Jordan ${"B".repeat(45)} Villanueva.pdf`);
  const oneWord = invoiceFileName({ number: "INV-1", physician: "C".repeat(120) }, "pdf");
  assert.match(oneWord, /^Invoice INV-1 from C+\.pdf$/, "a name with no spaces is still named, cut inside");
  assert.equal(oneWord.length, 104);
});

// The footer added its own period after a name that already ended in one.
test("the footer never reads D.O.. after a name that ends in a dotted degree", () => {
  const dotted = invoiceEmailSender({ name: "Jordan Rivera, D.O.", degree: "DO", email: "j@example.test" });
  assert.equal(invoiceEmailFooter(dotted.displayName),
    "Sent from CredentialDOMD on behalf of Jordan Rivera, D.O. Reply to this email to reach Jordan Rivera, D.O. directly.");
  assert.equal(invoiceEmailFooter("Jordan Rivera, DO"),
    "Sent from CredentialDOMD on behalf of Jordan Rivera, DO. Reply to this email to reach Jordan Rivera, DO directly.");
  assert.equal(edgeCopy.invoiceEmailFooter("Jordan Rivera, M.D."),
    "Sent from CredentialDOMD on behalf of Jordan Rivera, M.D. Reply to this email to reach Jordan Rivera, M.D. directly.", "the edge copy agrees");
  const mail = composeInvoiceEmail({
    sender: dotted, to: "billing@example.test", subject: "Invoice INV-1", letter: "Hello,\n\nAttached.\n\nThank you,\nJordan Rivera, D.O.",
  });
  for (const part of [mail.text, mail.html].filter(Boolean)) assert.doesNotMatch(part, /D\.O\.\./, part);
  const packet = readFileSync(new URL("../../supabase/functions/send-packet-email/index.ts", import.meta.url), "utf8");
  assert.match(packet, /const footer = invoiceEmailFooter\(displayName\);/, "send-packet-email signs with the same footer");
  assert.doesNotMatch(packet, /on behalf of \$\{displayName\}\./);
});

test("the HTML part escapes every typed value and leaves no raw line break in a text node", () => {
  const html = invoiceEmailHtmlBody(`Hello,\n\n<script>alert(1)</script> & "x" 'y'\nsecond line\n\nThank you,\nA <b>B</b>`, "<img src=x>");
  assert.doesNotMatch(html, /<script|<b>|<img/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &amp; &quot;x&quot; &#39;y&#39;<br>second line/);
  assert.match(html, /<strong>A &lt;b&gt;B&lt;\/b&gt;<\/strong>/);
  assert.match(html, /on behalf of &lt;img src=x&gt;/);
  for (const text of html.split(/<[^>]+>/)) assert.ok(!/[\r\n\u{2028}\u{2029}]/u.test(text), `raw break in ${JSON.stringify(text)}`);
});

test("the HTML part says what the text part says, paragraph for paragraph", () => {
  const text = invoiceEmailText(LETTER, "X");
  const html = invoiceEmailHtml(LETTER, "X");
  const words = (s) => s.replace(/[\s:.]+/g, " ").trim();
  const fromHtml = html.slice(html.indexOf("<body")).replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  assert.equal(words(fromHtml), words(text));
});

test("invoice file names read as a subject and are safe on every filesystem", () => {
  assert.equal(invoiceFileName({ number: "INV-20260915-1", physician: "Al Li, DO" }, "pdf"), "Invoice INV-20260915-1 from Al Li, DO.pdf");
  assert.equal(invoiceFileName({ number: "INV-1", physician: "Al Li, DO" }, "docx"), "Invoice INV-1 from Al Li, DO.docx");
  assert.equal(invoiceFileName({ number: "INV-1", physician: "Al Li, DO" }, "xlsx"), "Invoice INV-1 from Al Li, DO.xlsx");
  assert.equal(invoiceFileName({ number: "INV-1" }, "pdf"), "Invoice INV-1.pdf");
  assert.equal(invoiceFileName({ number: `A/B:C*D?"E<F>G|H${EM}I` }, "pdf"), "Invoice A B C D E F G H, I.pdf", "no path characters, no em dash");
  assert.ok(invoiceFileName({ number: "INV-1", physician: "x".repeat(300) }, "pdf").length <= 104);
});
