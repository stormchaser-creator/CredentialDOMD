// Unit-style checks for src/utils/receiptScan.js: the pure post-processing
// between the scanner's "receipt" JSON and the Work > Expenses / deduction
// ledger rows. Run: node scripts/receipt-scan.test.mjs
// Pure node, no test runner. Exit code 1 on any failure.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  RECEIPT_DOC_TYPE, RECEIPT_CATEGORIES, BILLABLE_CATEGORY, LEDGER_CATEGORY, isBillableCategory,
  guessReceiptCategory, toISODate, toAmount, toCurrency, toLast4,
  normalizeReceipt, receiptNote, receiptToExpense, receiptToDeduction, receiptSaveIssues,
} from "../src/utils/receiptScan.js";
import { EXPENSE_CATEGORIES } from "../src/constants/expenseCategories.js";
import { deductionTotal } from "../src/utils/taxEngine.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => readFileSync(path.join(here, "..", rel), "utf8");
let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`FAIL ${name}\n   got  ${g}\n   want ${w}`); }
};
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${name} ${extra}`); } };

// ── vocabulary stays in sync with the forms that consume it ──
eq("doc type token", RECEIPT_DOC_TYPE, "receipt");
for (const [cat, target] of Object.entries(BILLABLE_CATEGORY)) {
  ok(`billable ${cat} -> ${target} exists on the Expenses form`, EXPENSE_CATEGORIES.includes(target));
  ok(`billable source ${cat} is a receipt category`, RECEIPT_CATEGORIES.includes(cat));
}
const ledgerSources = [src("src/components/features/locum/DeductionMemo.jsx"), src("src/components/features/locum/StatementImport.jsx")];
for (const cat of RECEIPT_CATEGORIES) {
  const target = LEDGER_CATEGORY[cat];
  ok(`ledger mapping for ${cat}`, typeof target === "string" && target.length > 0);
  ok(`ledger ${cat} -> ${target} is a ledger category`, ledgerSources.every(s => s.includes(`"${target}"`)));
}
ok("tolls chip on the Expenses form", EXPENSE_CATEGORIES.includes("Tolls"));
eq("license fee is ledger-only", isBillableCategory("License / registration fee"), false);
eq("tolls are billable", isBillableCategory("Tolls"), true);
eq("garbage is not billable", isBillableCategory("Nonsense"), false);

// ── primitives ──
eq("date iso", toISODate("2026-08-15"), "2026-08-15");
eq("date iso with time", toISODate("2026-08-15T10:22:00Z"), "2026-08-15");
eq("date us slashes", toISODate("8/15/2026"), "2026-08-15");
eq("date us two-digit year", toISODate("08/15/26"), "2026-08-15");
eq("date long form", toISODate("August 15, 2026"), "2026-08-15");
eq("date blank", toISODate(""), "");
eq("date garbage", toISODate("soon"), "");
eq("amount dollars", toAmount("$23.40"), 23.4);
eq("amount thousands", toAmount("1,234.56"), 1234.56);
eq("amount number", toAmount(42.105), 42.11);
eq("amount zero", toAmount("0.00"), 0);
eq("amount negative", toAmount(-5), 0);
eq("amount garbage", toAmount("free"), 0);
eq("currency default", toCurrency(""), "USD");
eq("currency lowercase", toCurrency("usd"), "USD");
eq("currency symbol", toCurrency("$"), "USD");
eq("currency euro", toCurrency("€"), "EUR");
eq("currency cad", toCurrency("CAD"), "CAD");
eq("currency junk", toCurrency("dollars"), "USD");
eq("last4 masked", toLast4("****4321"), "4321");
eq("last4 number", toLast4(4321), "4321");
eq("last4 short", toLast4("21"), "");
eq("last4 full pan takes tail", toLast4("4111 1111 1111 1234"), "1234");

// ── category fallback: the model's string is not in our list ──
eq("alamo toll -> tolls, not rental", guessReceiptCategory("Alamo Rent A Car Toll charges Denver"), "Tolls");
eq("platepass -> tolls", guessReceiptCategory("PlatePass administrative fee"), "Tolls");
eq("alamo rental -> rental car", guessReceiptCategory("Alamo Rent A Car 3-day rental"), "Rental car");
eq("uber -> rideshare", guessReceiptCategory("Uber trip"), "Rideshare / Taxi");
eq("united -> airfare", guessReceiptCategory("United Airlines"), "Airfare");
eq("bag fee -> baggage", guessReceiptCategory("United checked bag fee"), "Baggage");
eq("marriott -> lodging", guessReceiptCategory("Marriott Denver Tech Center"), "Lodging");
eq("shell -> fuel", guessReceiptCategory("Shell Oil 12345"), "Fuel");
eq("starbucks -> meals", guessReceiptCategory("Starbucks"), "Meals");
eq("parking garage -> parking", guessReceiptCategory("DIA Parking Garage"), "Parking");
eq("medical board -> license fee", guessReceiptCategory("Colorado Medical Board renewal"), "License / registration fee");
eq("conference -> cme fee", guessReceiptCategory("CNS Annual Meeting registration"), "CME / conference fee");
eq("unknown -> other", guessReceiptCategory("Zyxwv Holdings"), "Other");

// ── normalizeReceipt: the Alamo toll case from the ticket ──
const alamoRaw = {
  merchant: " Alamo Rent A Car ", date: "08/15/2026", total: "$23.40", currency: "$",
  category: "Tolls", last4: "****4321", paymentMethod: "Visa", description: "Toll charges, Denver rental Aug 12-15",
};
const alamo = normalizeReceipt(alamoRaw);
eq("alamo normalized", alamo, {
  merchant: "Alamo Rent A Car", date: "2026-08-15", total: 23.4, currency: "USD", category: "Tolls",
  last4: "4321", paymentMethod: "Visa", description: "Toll charges, Denver rental Aug 12-15",
});
eq("bad model category falls back by keyword", normalizeReceipt({ merchant: "Alamo", category: "Toll fees", total: 5 }).category, "Tolls");
eq("missing category guesses from merchant", normalizeReceipt({ merchant: "Lyft", total: 18 }).category, "Rideshare / Taxi");
eq("aliases: vendor/amount/cardLast4", normalizeReceipt({ vendor: "Hertz", amount: "310.55", cardLast4: "9876", date: "2026-07-02" }),
  { merchant: "Hertz", date: "2026-07-02", total: 310.55, currency: "USD", category: "Rental car", last4: "9876", paymentMethod: "", description: "" });
eq("null extracted survives", normalizeReceipt(null), { merchant: "", date: "", total: 0, currency: "USD", category: "Other", last4: "", paymentMethod: "", description: "" });
eq("array extracted survives", normalizeReceipt([1, 2]).total, 0);

// ── notes carry payment provenance ──
eq("note with card", receiptNote(alamo), "Scanned receipt · Toll charges, Denver rental Aug 12-15 · paid with Visa ending 4321");
eq("note bare", receiptNote(normalizeReceipt({ merchant: "X" })), "Scanned receipt");
ok("note flags foreign currency", receiptNote(normalizeReceipt({ merchant: "X", currency: "CAD" })).includes("total in CAD"));
ok("note has no em dash", !receiptNote(alamo).includes("—"));

// ── Work > Expenses row: the shape Expenses.jsx / StatementImport write ──
const exp = receiptToExpense(alamo, { id: "e1", agency: " MPLT Healthcare " });
eq("expense keys", Object.keys(exp).sort(), ["agency", "amount", "category", "date", "id", "notes", "vendor"]);
eq("expense row", exp, {
  id: "e1", date: "2026-08-15", amount: 23.4, category: "Tolls", vendor: "Alamo Rent A Car",
  agency: "MPLT Healthcare", notes: "Scanned receipt · Toll charges, Denver rental Aug 12-15 · paid with Visa ending 4321",
});
eq("lodging bills as Hotel", receiptToExpense(normalizeReceipt({ merchant: "Hyatt", category: "Lodging", total: 200, date: "2026-08-01" }), { id: "e2", agency: "A" }).category, "Hotel");
eq("fuel bills as Gas", receiptToExpense(normalizeReceipt({ merchant: "Shell", category: "Fuel", total: 40, date: "2026-08-01" }), { id: "e3", agency: "A" }).category, "Gas");
eq("ledger-only category falls to Other when forced billable", receiptToExpense(normalizeReceipt({ merchant: "Board", category: "License / registration fee", total: 40, date: "2026-08-01" }), { id: "e4", agency: "A" }).category, "Other");

// ── deduction row: the shape DeductionMemo / StatementImport write ──
const ded = receiptToDeduction(alamo, { id: "d1" });
eq("deduction keys", Object.keys(ded).sort(), ["amount", "category", "date", "description", "id", "merchant", "notes", "source", "taxYear"]);
eq("deduction row", ded, {
  id: "d1", date: "2026-08-15", category: "Travel — parking / tolls",
  description: "Alamo Rent A Car (Toll charges, Denver rental Aug 12-15)", merchant: "Alamo Rent A Car",
  amount: 23.4, taxYear: "2026", source: "receipt scan",
  notes: "Scanned receipt · Toll charges, Denver rental Aug 12-15 · paid with Visa ending 4321",
});
eq("deduction description without detail", receiptToDeduction(normalizeReceipt({ merchant: "Hyatt", total: 1, date: "2026-01-01" }), { id: "d2" }).description, "Hyatt");

// ── meals keep the ledger's 50% treatment ──
const meal = receiptToDeduction(normalizeReceipt({ merchant: "Steuben's", category: "Meals", total: "64.00", date: "2026-08-14" }), { id: "d3" });
eq("meals ledger category", meal.category, "Meals (50% deductible)");
eq("meals at 50% in the tax estimate", deductionTotal([meal]), 32);
eq("tolls at 100%", deductionTotal([ded]), 23.4);

// ── save gate ──
eq("ok expense", receiptSaveIssues(alamoRaw, "expense", "MPLT"), []);
eq("ok deduction", receiptSaveIssues(alamoRaw, "deduction", ""), []);
eq("expense needs agency", receiptSaveIssues(alamoRaw, "expense", "  "), ["Pick the agency to bill."]);
eq("needs date and total", receiptSaveIssues({ merchant: "X" }, "deduction", ""), ["Enter the receipt date.", "Enter the total paid."]);
eq("zero total blocked", receiptSaveIssues({ ...alamoRaw, total: "0" }, "deduction", ""), ["Enter the total paid."]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
