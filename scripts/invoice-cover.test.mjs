// Unit-style checks for src/utils/invoiceCover.js (the wording every invoice
// send path uses: subject, share-sheet blurb, cover letter, money/period
// text, the text-invoice rule) plus the mailto helper it depends on.
// Renders a realistic partially-paid invoice first so the output can be
// eyeballed, then pins the rules that were broken in ticket e8cc2a02.
// Run: node scripts/invoice-cover.test.mjs   (pure node, no test runner)
import {
  money, invoicePayment, invoicePeriod, invoiceSubject, invoiceCoverBlurb, invoiceCoverEmail,
  normalizeInvoiceText, invoiceTextOnlyShare, invoiceCoverNotice, TEXT_RULE, MAILTO_BODY_MAX,
} from "../src/utils/invoiceCover.js";
import { mailtoHref } from "../src/utils/helpers.js";
import { dutyDayPay } from "../src/utils/dutyPay.js";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`FAIL ${name}\n   got  ${g}\n   want ${w}`); }
};
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${name} ${extra}`); } };

const EM_DASH = "—";
const BOX = /[─-╿]/;

// ── A realistic partially-paid invoice: three line items, one payment in ──
const partial = {
  number: "INV-0012",
  physician: "Rowan Testa, DO", npi: "1234567890", email: "rowan@example.com",
  facility: "Cedar Ridge Regional Medical Center", agency: "Summit Staffing",
  location: "Larkfield, CA", billTo: "ap@example.com",
  periodStart: "2026-08-01", periodEnd: "2026-08-15",
  terms: "$1,500.00 per on-call day covering the first 4 hours of logged work, time beyond @ $300.00/hr; billed in 15-minute increments",
  lines: [
    { date: "2026-08-01", label: "On-call coverage", detail: "on-call coverage, no calls required", amount: 1500 },
    { date: "2026-08-02", label: "Call", detail: "7:15 PM to 9:00 PM, 105 min @ $300.00/hr", amount: 525 },
    { date: "2026-08-15", label: "Orientation (one-time)", detail: "", amount: 1000 },
  ],
  total: 3025, paid: 1500, balance: 1525,
  issuedDate: "2026-08-16",
};
const unpaid = { ...partial, paid: 0, balance: 3025 };
const settled = { ...partial, paid: 3025, balance: 0 };

const subject = invoiceSubject(partial);
const blurb = invoiceCoverBlurb(partial);
const letter = invoiceCoverEmail(partial);
const mailto = mailtoHref("", subject, letter);

console.log("── subject ──\n" + subject);
console.log("\n── share-sheet blurb (partially paid) ──\n" + blurb);
console.log("\n── cover letter (partially paid) ──\n" + letter);
console.log("\n── cover letter (unpaid) ──\n" + invoiceCoverEmail(unpaid));
console.log("\n── cover letter (paid in full) ──\n" + invoiceCoverEmail(settled));
console.log("\n── mailto body, decoded, CR shown as <CR> ──\n" + decodeURIComponent(mailto.split("&body=")[1]).replace(/\r/g, "<CR>"));
console.log("");

// ── Money and period wording ──
eq("money formats US currency", money(1234.5), "$1,234.50");
eq("money pins en-US grouping", money("12000"), "$12,000.00");
eq("money handles junk as zero", money(undefined), "$0.00");
eq("money keeps the sign in front of the dollar", money(-50), "-$50.00");
eq("period spans two dates with 'through'", invoicePeriod(partial), "Aug 1, 2026 through Aug 15, 2026");
eq("period collapses a single day", invoicePeriod({ periodStart: "2026-08-01", periodEnd: "2026-08-01" }), "Aug 1, 2026");
eq("period empty when unknown", invoicePeriod({}), "");

// ── Payment state drives the wording ──
eq("partial payment state", invoicePayment(partial), { total: 3025, paid: 1500, balance: 1525, hasPayment: true, partial: true, settled: false });
eq("unpaid state", invoicePayment(unpaid).partial, false);
eq("settled state", invoicePayment(settled).settled, true);
eq("balance derived when not supplied", invoicePayment({ total: 100, paid: 40 }).balance, 60);
eq("a bare invoice (first send) has no payment", invoicePayment({ total: 100 }), { total: 100, paid: 0, balance: 100, hasPayment: false, partial: false, settled: false });

// ── Subject ──
eq("subject names the sender and the facility", subject, "Invoice INV-0012 from Rowan Testa, DO for Cedar Ridge Regional Medical Center");
eq("subject degrades without a facility", invoiceSubject({ number: "INV-0001", physician: "Rowan Testa, DO" }), "Invoice INV-0001 from Rowan Testa, DO");
ok("subject has no em dash", !subject.includes(EM_DASH));

// ── Share-sheet blurb (owner's iPhone, Oct 2026: Gmail put it in one <div>
// with raw CRLFs, so it read as one run-on paragraph that repeated the
// subject and had no greeting) ──
const paras = blurb.split("\n\n");
const flat = blurb.replace(/\s*\n+\s*/g, " ");
eq("blurb: greeting sentence, money, questions, sign-off", paras.length, 4);
ok("blurb opens with a greeting, not the subject line", paras[0].startsWith("Hello, attached is invoice INV-0012 for physician services at Cedar Ridge Regional Medical Center (via Summit Staffing), covering Aug 1, 2026 through Aug 15, 2026."), paras[0]);
ok("blurb never restates the subject", !blurb.includes(subject));
ok("blurb names the invoice number once", blurb.split("INV-0012").length === 2);
eq("partial blurb: what is owed first, then the total and what was paid", paras[1], "Balance due: $1,525.00 (invoice total $3,025.00, paid to date $1,500.00).");
eq("blurb offers to answer questions", paras[2], "Please reach out with any questions.");
// Gmail and iOS Mail collapse the breaks, so the NPI, email and phone ran
// inline after the name and wrapped mid-address on a phone. The attached
// invoice prints them (FROM block, questions line); the blurb signs with the
// name alone.
eq("blurb signs off with the name and degree alone", paras[3], "Thank you,\nRowan Testa, DO");
ok("blurb carries no NPI, email or phone", !/NPI|@|555/.test(invoiceCoverBlurb({ ...partial, phone: "555-010-0100" })));
eq("collapsed to one paragraph it still reads as a short email", flat,
  "Hello, attached is invoice INV-0012 for physician services at Cedar Ridge Regional Medical Center (via Summit Staffing), covering Aug 1, 2026 through Aug 15, 2026. "
  + "Balance due: $1,525.00 (invoice total $3,025.00, paid to date $1,500.00). Please reach out with any questions. "
  + "Thank you, Rowan Testa, DO");
ok("collapsed, the blurb is short enough to read at a glance", flat.length <= 310, String(flat.length));
ok("every paragraph but the signature ends a sentence, so the collapse never glues two together", paras.slice(0, 3).every((p) => /[.)]$/.test(p)));
ok("blurb has no em dash", !blurb.includes(EM_DASH));
ok("blurb has no CR", !blurb.includes("\r"));
ok("partial blurb never calls the full amount 'total due'", !blurb.includes("Total due"));
ok("unpaid blurb states total due", invoiceCoverBlurb(unpaid).includes("\n\nTotal due: $3,025.00.\n\n"));
ok("settled blurb says paid in full", invoiceCoverBlurb(settled).includes("Invoice total: $3,025.00, paid in full."));
ok("blurb says 'below' when the invoice text follows in the same body", invoiceCoverBlurb(partial, { attached: false }).startsWith("Hello, below is invoice INV-0012"));
{
  const bare = invoiceCoverBlurb({ number: "INV-0003", total: 200 });
  ok("bare blurb has no undefined/null", !/undefined|null/.test(bare), bare);
  ok("bare blurb states the total due", bare.includes("Total due: $200.00."));
  ok("bare blurb signs off without a name", bare.endsWith("Please reach out with any questions.\n\nThank you."), bare);
  ok("the no-name placeholder never signs a blurb", invoiceCoverBlurb({ number: "INV-0003", total: 200, physician: "Physician" }).endsWith("Thank you."));
  ok("the no-name placeholder is not a sender in the subject", invoiceSubject({ number: "INV-0003", physician: "Physician" }) === "Invoice INV-0003");
  ok("with no name the blurb signs with the email", invoiceCoverBlurb({ number: "INV-0003", total: 200, physician: "Physician", npi: "1234567890", email: "rowan@example.com" }).endsWith("Thank you,\nrowan@example.com"));
  ok("a doubled degree signs once", invoiceCoverBlurb({ ...partial, physician: "Rowan Testa, DO, DO" }).endsWith("Thank you,\nRowan Testa, DO"));
  eq("a doubled degree reads once in the subject", invoiceSubject({ number: "INV-0003", physician: "Rowan Testa, DO, DO", facility: "Cedar Ridge" }), "Invoice INV-0003 from Rowan Testa, DO for Cedar Ridge");
  ok("a phone on the profile signs the cover letter", invoiceCoverEmail({ ...partial, phone: "555-010-0100" }).endsWith("rowan@example.com\n555-010-0100"));
}

// ── Written off after a partial payment: never PAID IN FULL ──
{
  const wo = invoicePayment({ total: 6400, paid: 1000, balance: 0 });
  eq("a balance of 0 with paid < total is not settled", [wo.settled, wo.partial, wo.balance], [false, true, 5400]);
  ok("its blurb never says paid in full", !/paid in full/i.test(invoiceCoverBlurb({ number: "X", total: 6400, paid: 1000, balance: 0 })));
  eq("paid in full means the payments reached the total", invoicePayment({ total: 100, paid: 100, balance: 0 }).settled, true);
}

// ── Cover letter ──
ok("letter uses plain \\n (mailtoHref adds CRLF; clipboard pastes cleanly)", !letter.includes("\r"));
ok("letter has no em dash", !letter.includes(EM_DASH));
eq("letter paragraphs", letter.split("\n\n").length, 5);
ok("letter opens with a salutation", letter.startsWith("Hello,\n\n"));
ok("letter puts the money on its own lines, each a sentence", letter.includes("\n\nInvoice total: $3,025.00.\nPaid to date: $1,500.00.\nBalance due: $1,525.00.\n\n"));
ok("unpaid letter shows a single total-due line", invoiceCoverEmail(unpaid).includes("\n\nTotal due: $3,025.00.\n\n"));
ok("settled letter says paid in full", invoiceCoverEmail(settled).includes("Invoice total: $3,025.00.\nPaid in full. No balance is due."));
ok("letter signs off on separate lines", letter.endsWith("Thank you,\nRowan Testa, DO\nNPI 1234567890\nrowan@example.com"));
{
  const bare = invoiceCoverEmail({ number: "INV-0003", total: 200 });
  ok("bare letter has no undefined/null", !/undefined|null/.test(bare), bare);
  ok("bare letter signs off without a dangling comma", bare.endsWith("Please reach out with any questions.\n\nThank you."));
}

// ── mailto: CRLF, single encoding, no truncation for a normal letter ──
{
  const body = mailto.split("&body=")[1];
  const decoded = decodeURIComponent(body);
  ok("mailto body is CRLF-delimited", /\r\n/.test(decoded) && !/(^|[^\r])\n/.test(decoded));
  eq("mailto body round-trips to the letter", decoded.replace(/\r\n/g, "\n"), letter);
  ok("mailto body is encoded exactly once", !body.includes("%25"));
  ok("mailto subject is encoded", mailto.includes(`?subject=${encodeURIComponent(subject)}&body=`));
  ok("a normal cover letter sits well under the mailto ceiling", letter.length < MAILTO_BODY_MAX, `${letter.length}`);
  ok("mailto ceiling is under iOS Mail's ~2,000-character cutoff", MAILTO_BODY_MAX > 1000 && MAILTO_BODY_MAX <= 2000);
}

// ── Text-invoice rule ──
ok("rule is plain ASCII", /^-+$/.test(TEXT_RULE));
ok("rule fits a phone-width Mail body", TEXT_RULE.length <= 32);
{
  const legacy = ["INVOICE INV-0004", "─".repeat(40), "From: Rowan Testa, DO", "─".repeat(40), "TOTAL DUE: $900.00"].join("\r\n");
  const fixed = normalizeInvoiceText(legacy);
  ok("legacy box rules are replaced", !BOX.test(fixed));
  eq("legacy CRLF is normalized to \\n", fixed.split("\n").length, 5);
  eq("legacy rule count preserved", fixed.split("\n").filter(l => l === TEXT_RULE).length, 2);
  eq("normalize tolerates missing text", normalizeInvoiceText(undefined), "");
}

// ── House rule: nothing user-facing in this module carries an em dash ──
for (const inv of [partial, unpaid, settled, { number: "X" }]) {
  for (const s of [invoiceSubject(inv), invoiceCoverBlurb(inv), invoiceCoverEmail(inv)]) {
    ok("no em dash anywhere in cover wording", !s.includes(EM_DASH), s);
  }
}

// ── Cover letter when the invoice is pasted under it (long legacy text, no file share) ──
{
  const below = invoiceCoverEmail(partial, { attached: false });
  ok("letter says 'Below' when the invoice text is pasted under it", below.includes("Below is invoice INV-0012 for physician services"));
  ok("'Below' letter never claims an attachment", !/attached/i.test(below));
  eq("'Below' letter keeps the same paragraphs", below.split("\n\n").length, 5);
  ok("default letter still says 'Attached'", letter.includes("Attached is invoice INV-0012"));
}

// ── Day-rate invoice lines (dutyPay): no em dash, still keyed as call lines ──
{
  const contract = { dayRate: 1875.4, callRateGrid: [{ hospital: "Cedar Ridge Regional Medical Center (CRRMC)", primary: 450, backup: 225 }] };
  const pay = dutyDayPay(contract, { date: "2026-08-03", workedDay: true, callPeriods: [{ hospital: "Cedar Ridge Regional Medical Center (CRRMC)", role: "primary" }] });
  // The role before the hospital: "(CRRMC) (primary)" read as a typo.
  eq("day-rate call line label", pay.lines[1].label, "On call (primary): Cedar Ridge Regional Medical Center (CRRMC)");
  ok("day-rate call line still keys as a call line (summarizeDuties/DutyLog use startsWith)", pay.lines[1].label.startsWith("On call"));
  for (const l of pay.lines) ok("no em dash in day-rate line labels", !l.label.includes(EM_DASH), l.label);
  eq("day-rate day total", pay.total, 2325.4);
}

// -- Expense invoices say what they are (ticket e8cc2a02) --
{
  const expense = {
    number: "EXP-0003", kind: "expenses", physician: "Rowan Testa, DO", npi: "1234567890", email: "rowan@example.com",
    facility: "Summit Locums", periodStart: "2026-08-03", periodEnd: "2026-08-09", total: 412.37,
  };
  const eBlurb = invoiceCoverBlurb({ ...expense, receipts: 3 });
  const eLetter = invoiceCoverEmail({ ...expense, receipts: 3 });
  console.log("\n-- expense blurb --\n" + eBlurb + "\n\n-- expense letter --\n" + eLetter + "\n");
  for (const t of [eBlurb, eLetter]) {
    ok("expense cover never says physician services", !/physician services/.test(t), t);
    ok("expense cover never claims days of coverage", !/day of coverage|work performed/.test(t), t);
    ok("expense cover names reimbursable travel expenses", t.includes("reimbursable travel expenses incurred Aug 3, 2026 through Aug 9, 2026"), t);
    ok("expense cover counts the receipts that ride along", t.includes("3 receipts are attached."), t);
    ok("expense cover has no em dash", !t.includes(EM_DASH));
  }
  ok("expense blurb opens with a greeting naming the expense invoice", eBlurb.startsWith("Hello, attached is invoice EXP-0003 for reimbursable travel expenses incurred Aug 3, 2026 through Aug 9, 2026.\n\n"), eBlurb);
  eq("expense letter keeps five paragraphs", eLetter.split("\n\n").length, 5);
  ok("one receipt reads in the singular", invoiceCoverBlurb({ ...expense, receipts: 1 }).includes("The receipt is attached."));
  for (const receipts of [0, undefined, -2, "x"]) {
    ok(`no receipt claim when none ride along (${receipts})`, !/receipt/i.test(invoiceCoverEmail({ ...expense, receipts })) && !/receipt/i.test(invoiceCoverBlurb({ ...expense, receipts })));
  }
  ok("a work invoice never mentions receipts, even if a count leaks in", !/receipt/i.test(invoiceCoverBlurb({ ...partial, receipts: 2 })));
  ok("work invoice letter wording is unchanged", letter.includes("The invoice itemizes each day of coverage and the work performed under the terms of our agreement. Please reach out"));
  ok("expense 'below' letter never claims an attachment", !/attached/i.test(invoiceCoverEmail(expense, { attached: false })));
}

// -- No file rides along: the message is the letter plus the itemized invoice (ticket 821d2f76) --
{
  const text = ["INVOICE INV-0012", String.fromCodePoint(0x2500).repeat(40), "TOTAL DUE: $3,025.00"].join("\n");
  const body = invoiceTextOnlyShare(partial, text);
  ok("text-only share opens with a greeting that says the invoice follows", body.startsWith("Hello, below is invoice INV-0012 for physician services"));
  ok("text-only share carries the itemized invoice under the greeting", body.includes(`.\n\n${normalizeInvoiceText(text)}\n\nPlease reach out with any questions.`));
  // No file rides along, so nothing else carries the contact lines: the full signature stays.
  ok("text-only share signs off last, with the full signature", body.endsWith("Thank you,\nRowan Testa, DO \u{b7} NPI 1234567890 \u{b7} rowan@example.com"));
  ok("text-only share keeps the phone", invoiceTextOnlyShare({ ...partial, phone: "555-010-0100" }, text).endsWith("rowan@example.com \u{b7} 555-010-0100"));
  ok("text-only share never mentions the clipboard", !/clipboard/i.test(body));
  ok("text-only share never claims an attachment", !/attached/i.test(body));
  ok("text-only share normalizes the legacy wide rule", !BOX.test(body));
}

// -- The sender, never the recipient, hears about the clipboard --
for (const inv of [partial, unpaid, settled, { number: "X" }]) {
  for (const t of [invoiceCoverBlurb(inv), invoiceCoverEmail(inv), invoiceCoverBlurb(inv, { attached: false })]) {
    ok("no recipient-facing cover mentions the clipboard", !/clipboard/i.test(t), t);
  }
}
ok("a share with the letter copied tells the sender", /clipboard/.test(invoiceCoverNotice("share+cover") || ""));
ok("a Word/Excel download with the letter copied says so", /downloaded/.test(invoiceCoverNotice("download+cover") || ""));
eq("nothing to say when the letter was not copied", invoiceCoverNotice("share"), null);
eq("nothing to say after a text-only share (it carried the letter)", invoiceCoverNotice("share-text+cover"), null);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
