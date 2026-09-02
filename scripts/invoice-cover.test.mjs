// Unit-style checks for src/utils/invoiceCover.js (the wording every invoice
// send path uses: subject, share-sheet blurb, cover letter, money/period
// text, the text-invoice rule) plus the mailto helper it depends on.
// Renders a realistic partially-paid invoice first so the output can be
// eyeballed, then pins the rules that were broken in ticket e8cc2a02.
// Run: node scripts/invoice-cover.test.mjs   (pure node, no test runner)
import {
  money, invoicePayment, invoicePeriod, invoiceSubject, invoiceCoverBlurb, invoiceCoverEmail,
  normalizeInvoiceText, TEXT_RULE, MAILTO_BODY_MAX,
} from "../src/utils/invoiceCover.js";
import { mailtoHref } from "../src/utils/helpers.js";

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
  physician: "Eric Whitney, DO", npi: "1234567890", email: "eric@example.com",
  facility: "Arrowhead Regional Medical Center", agency: "ANMG",
  location: "Colton, CA", billTo: "ap@example.com",
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
eq("subject names the sender and the facility", subject, "Invoice INV-0012 from Eric Whitney, DO for Arrowhead Regional Medical Center");
eq("subject degrades without a facility", invoiceSubject({ number: "INV-0001", physician: "Eric Whitney, DO" }), "Invoice INV-0001 from Eric Whitney, DO");
ok("subject has no em dash", !subject.includes(EM_DASH));

// ── Share-sheet blurb ──
const [blurbLead, ...blurbRest] = blurb.split("\n\n");
eq("blurb leads with the subject line (iOS Mail may promote it)", blurbLead.trim(), subject + ".");
ok("blurb body is one flowing paragraph", blurbRest.length === 1 && !blurbRest[0].includes("\n"));
ok("blurb reads correctly with every line break stripped", /Medical Center\. Attached is invoice/.test(blurb.replace(/\n/g, "")));
ok("blurb has no em dash", !blurb.includes(EM_DASH));
ok("blurb has no CR", !blurb.includes("\r"));
ok("partial blurb never calls the full amount 'total due'", !blurb.includes("Total due"));
ok("partial blurb states total, paid, balance", blurb.includes("Invoice total: $3,025.00. Paid to date: $1,500.00. Balance due: $1,525.00."));
ok("unpaid blurb states total due", invoiceCoverBlurb(unpaid).includes("Total due: $3,025.00."));
ok("settled blurb says paid in full", invoiceCoverBlurb(settled).includes("Invoice total: $3,025.00, paid in full."));
ok("blurb signs with name, NPI, email", blurb.includes("Thank you, Eric Whitney, DO (NPI 1234567890, eric@example.com)."));
ok("blurb mentions the period", blurb.includes("covering Aug 1, 2026 through Aug 15, 2026"));
ok("blurb says 'Below' when the invoice text follows in the same body", invoiceCoverBlurb(partial, { attached: false }).includes("Below is invoice INV-0012"));
{
  const bare = invoiceCoverBlurb({ number: "INV-0003", total: 200 });
  ok("bare blurb has no undefined/null", !/undefined|null/.test(bare), bare);
  ok("bare blurb falls back to 'your facility'", bare.includes("at your facility"));
}

// ── Cover letter ──
ok("letter uses plain \\n (mailtoHref adds CRLF; clipboard pastes cleanly)", !letter.includes("\r"));
ok("letter has no em dash", !letter.includes(EM_DASH));
eq("letter paragraphs", letter.split("\n\n").length, 5);
ok("letter opens with a salutation", letter.startsWith("Hello,\n\n"));
ok("letter puts the money on its own lines", letter.includes("\n\nInvoice total: $3,025.00\nPaid to date: $1,500.00\nBalance due: $1,525.00\n\n"));
ok("unpaid letter shows a single total-due line", invoiceCoverEmail(unpaid).includes("\n\nTotal due: $3,025.00\n\n"));
ok("settled letter says paid in full", invoiceCoverEmail(settled).includes("Invoice total: $3,025.00\nPaid in full. No balance is due."));
ok("letter signs off on separate lines", letter.endsWith("Thank you,\nEric Whitney, DO\nNPI 1234567890\neric@example.com"));
{
  const bare = invoiceCoverEmail({ number: "INV-0003", total: 200 });
  ok("bare letter has no undefined/null", !/undefined|null/.test(bare), bare);
  ok("bare letter sign-off has no dangling blank lines", bare.endsWith("Thank you,"));
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
  const legacy = ["INVOICE INV-0004", "─".repeat(40), "From: Eric Whitney, DO", "─".repeat(40), "TOTAL DUE: $900.00"].join("\r\n");
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

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
