/**
 * Expense receipt post-processing for the document scanner.
 *
 * The scanner classifies a toll slip, rental car folio, rideshare, airline,
 * hotel, parking, fuel or meal receipt as "receipt" and the model returns
 * loose fields. Everything here is pure: normalize what the model said,
 * then build the exact records Work > Expenses (travelExpenses) and the
 * deduction ledger (deductibles) already use. These are the same shapes the
 * card-statement importer writes, so a scanned receipt is indistinguishable
 * from a typed or imported one downstream: expense invoicing with the
 * receipt attached, the tax estimate, and meals counted at 50%.
 */
import { EXPENSE_CATEGORIES } from "../constants/expenseCategories.js";

export const RECEIPT_DOC_TYPE = "receipt";

// What the model must pick from. Travel first (billable to an agency and
// deductible), then fees that only ever go to the ledger.
export const RECEIPT_CATEGORIES = [
  "Tolls", "Rental car", "Fuel", "Rideshare / Taxi", "Airfare", "Baggage",
  "Lodging", "Parking", "Meals",
  "License / registration fee", "CME / conference fee", "Society dues",
  "Supplies / equipment", "Software / subscription", "Other",
];

// Receipt category -> Work > Expenses category (EXPENSE_CATEGORIES). A
// category missing here cannot be billed to an agency; it is ledger-only.
export const BILLABLE_CATEGORY = {
  "Tolls": "Tolls",
  "Rental car": "Rental car",
  "Fuel": "Gas",
  "Rideshare / Taxi": "Rideshare / Taxi",
  "Airfare": "Airfare",
  "Baggage": "Baggage",
  "Lodging": "Hotel",
  "Parking": "Parking",
  "Meals": "Meals",
  "Other": "Other",
};

// Receipt category -> deduction ledger category. These strings are the
// ledger's own vocabulary (DeductionMemo / StatementImport CATEGORIES) and
// must match exactly: the tax estimate keys the 50% meals limit off them.
export const LEDGER_CATEGORY = {
  "Tolls": "Travel — parking / tolls",
  "Rental car": "Travel — rental car / fuel",
  "Fuel": "Travel — rental car / fuel",
  "Rideshare / Taxi": "Travel — ground / rideshare",
  "Airfare": "Travel — airfare",
  "Baggage": "Travel — airfare",
  "Lodging": "Travel — lodging",
  "Parking": "Travel — parking / tolls",
  "Meals": "Meals (50% deductible)",
  "License / registration fee": "License renewal fee",
  "CME / conference fee": "CME course",
  "Society dues": "Professional society dues",
  "Supplies / equipment": "Medical supplies / equipment",
  "Software / subscription": "Software / SaaS (CredentialDoMD, Doximity, etc.)",
  "Other": "Other deductible expense",
};

export const isBillableCategory = (category) =>
  Object.prototype.hasOwnProperty.call(BILLABLE_CATEGORY, category)
  && EXPENSE_CATEGORIES.includes(BILLABLE_CATEGORY[category]);

// Fallback when the model's category is not one of ours: first hit wins.
// Tolls lead because a toll invoice from a rental company names the rental
// brand too (Alamo, Hertz) and must not become "Rental car".
const CATEGORY_RULES = [
  [/\btolls?\b|tollway|platepass|tollpass|e-?toll|fastrak|e-?zpass|sunpass|txtag|express\s?lanes?/i, "Tolls"],
  [/\bparking\b|park ?mobile|\bgarage\b|\bvalet\b/i, "Parking"],
  [/\buber\b|\blyft\b|\btaxi\b|\bcab\b|\bshuttle\b|\blimo/i, "Rideshare / Taxi"],
  [/\bbaggage\b|\bbag fee|checked bag/i, "Baggage"],
  [/\bunited\b|\bdelta\b|\bsouthwest\b|american air|alaska air|\bfrontier\b|jetblue|spirit air|\bairlines?\b|\bairways\b|\bairfare\b|\bflight\b/i, "Airfare"],
  [/marriott|hyatt|hilton|westin|sheraton|holiday inn|hampton|residence inn|airbnb|\bhotel\b|\blodge\b|\binn\b|\bsuites\b|\bmotel\b|\blodging\b/i, "Lodging"],
  [/\balamo\b|\bhertz\b|\bavis\b|\benterprise\b|\bbudget\b|national car|\bsixt\b|\bthrifty\b|dollar rent|\bturo\b|rent[- ]?a[- ]?car|car rental|rental car|\brental\b/i, "Rental car"],
  [/\bshell\b|\bchevron\b|\bexxon\b|\bmobil\b|\bconoco\b|\bsinclair\b|\bbp\b|7-eleven|circle k|\bfuel\b|\bgasoline\b|\bgas\b/i, "Fuel"],
  [/restaurant|\bgrill\b|\bcafe\b|\bcoffee\b|starbucks|chipotle|doordash|grubhub|steakhouse|\bsushi\b|\bpizza\b|\bdeli\b|\bbistro\b|\bbakery\b|\bdiner\b|\bmeals?\b|\bdinner\b|\blunch\b|\bbreakfast\b/i, "Meals"],
  [/medical board|state board|licens|\bdea\b|registration fee|\bpermit\b/i, "License / registration fee"],
  [/\bcme\b|conference|symposium|\bcourse\b|\bcongress\b|\bseminar\b|\bmeeting\b|\bregistration\b/i, "CME / conference fee"],
  [/\bsociety\b|\bassociation\b|\bdues\b|\baans\b|\bcns\b|\baoa\b/i, "Society dues"],
  [/software|subscription|\bsaas\b/i, "Software / subscription"],
  [/supplies|equipment|instrument/i, "Supplies / equipment"],
];

export function guessReceiptCategory(text) {
  const s = String(text || "");
  const hit = CATEGORY_RULES.find(([re]) => re.test(s));
  return hit ? hit[1] : "Other";
}

const str = (v, max) => {
  const s = v == null ? "" : String(v).trim();
  return max ? s.slice(0, max) : s;
};

const pad2 = (n) => String(n).padStart(2, "0");

/** Any date the model or an input hands over -> "YYYY-MM-DD" (or ""). */
export function toISODate(v) {
  const s = str(v);
  if (!s) return "";
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${pad2(m[1])}-${pad2(m[2])}`;
  }
  const d = new Date(s);
  if (isNaN(d)) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** "$1,234.56", "1234.56", 1234.56 -> 1234.56; anything unusable -> 0. */
export function toAmount(v) {
  if (typeof v === "number") return v > 0 && isFinite(v) ? Math.round(v * 100) / 100 : 0;
  const s = str(v).replace(/[^0-9.]/g, "");
  const n = parseFloat(s);
  return n > 0 && isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

const CURRENCY_SYMBOLS = { "$": "USD", "US$": "USD", "C$": "CAD", "CA$": "CAD", "€": "EUR", "£": "GBP", "¥": "JPY", "MX$": "MXN", "A$": "AUD" };

export function toCurrency(v) {
  const s = str(v).toUpperCase();
  if (!s) return "USD";
  if (/^[A-Z]{3}$/.test(s)) return s;
  return CURRENCY_SYMBOLS[s] || "USD";
}

/** "****4321", "xxxx-4321", 4321 -> "4321"; fewer than 4 digits -> "". */
export function toLast4(v) {
  const digits = str(v).replace(/\D/g, "");
  return digits.length >= 4 ? digits.slice(-4) : "";
}

/**
 * The model's loose "receipt" fields -> one clean receipt record. Also runs
 * on the reviewed fields the physician edited in the scan card, so both
 * paths meet the same normalization before a row is written.
 */
export function normalizeReceipt(extracted) {
  const e = extracted && typeof extracted === "object" && !Array.isArray(extracted) ? extracted : {};
  const merchant = str(e.merchant || e.vendor || e.name, 80);
  const description = str(e.description || e.summary, 140);
  const category = RECEIPT_CATEGORIES.includes(e.category)
    ? e.category
    : guessReceiptCategory(`${e.category || ""} ${description} ${merchant}`);
  return {
    merchant,
    date: toISODate(e.date || e.transactionDate),
    total: toAmount(e.total ?? e.amount ?? e.grandTotal),
    currency: toCurrency(e.currency),
    category,
    last4: toLast4(e.last4 ?? e.cardLast4),
    paymentMethod: str(e.paymentMethod || e.paidWith, 40),
    description,
  };
}

/** Provenance line for the record's notes: how it was paid, in what currency. */
export function receiptNote(r) {
  const parts = ["Scanned receipt"];
  if (r.description) parts.push(r.description);
  if (r.paymentMethod || r.last4) {
    parts.push(`paid with ${[r.paymentMethod, r.last4 ? `ending ${r.last4}` : ""].filter(Boolean).join(" ")}`);
  }
  if (r.currency && r.currency !== "USD") parts.push(`total in ${r.currency}`);
  return parts.join(" · ");
}

/** Work > Expenses row: the shape Expenses.jsx and StatementImport write. */
export function receiptToExpense(r, { id, agency }) {
  return {
    id,
    date: r.date,
    amount: toAmount(r.total),
    category: isBillableCategory(r.category) ? BILLABLE_CATEGORY[r.category] : "Other",
    vendor: r.merchant,
    agency: str(agency),
    notes: receiptNote(r),
  };
}

/** Deduction ledger row: the shape DeductionMemo and StatementImport write. */
export function receiptToDeduction(r, { id }) {
  const description = r.description ? `${r.merchant || "Receipt"} (${r.description})` : (r.merchant || "Scanned receipt");
  return {
    id,
    date: r.date,
    category: LEDGER_CATEGORY[r.category] || "Other deductible expense",
    description,
    merchant: r.merchant,
    amount: toAmount(r.total),
    taxYear: String(r.date || "").slice(0, 4),
    source: "receipt scan",
    notes: receiptNote(r),
  };
}

/**
 * What still blocks saving. Mirrors the Expenses form minimum (date and a
 * dollar amount) plus the importer's rule that a billed row needs an agency.
 */
export function receiptSaveIssues(fields, destination, agency) {
  const r = normalizeReceipt(fields);
  const issues = [];
  if (!r.date) issues.push("Enter the receipt date.");
  if (!(r.total > 0)) issues.push("Enter the total paid.");
  if (destination === "expense" && !str(agency)) issues.push("Pick the agency to bill.");
  return issues;
}
