// One year of a CA-resident S-corp locum: paid invoices in three work
// states (one contract missing its work state), a travel-expense invoice
// the agency only partly reimbursed (the Aug 26 unreimbursed-travel auto
// deduction), and estimated payments to four jurisdictions, one of them a
// state with no income so it must still be listed. Shared by
// scripts/tax-prep-desk.test.mjs; every number the test asserts is derived
// from this object through the app's own engine, never typed twice.
import { TAX_YEAR } from "../../src/utils/taxConstants.js";

const Y = String(TAX_YEAR);

export const fixture = {
  settings: {
    taxPrep: { residentState: "CA", filingStatus: "mfj", entity: "scorp", scorpSalary: "300000", otherIncome: "0", priorYearTax: "120000" },
  },
  locumContracts: [
    { id: "c-ca", name: "Bay Hospital", workState: "CA" },
    { id: "c-co", name: "Denver Neuro", workState: "CO" },
    { id: "c-tx", name: "Houston Spine", workState: "TX" },
    { id: "c-none", name: "Somewhere General" },
  ],
  invoices: [
    { id: "i1", number: "INV-001", contractId: "c-ca", totalAmount: 240000, payments: [{ date: `${Y}-02-10`, amount: 240000 }] },
    { id: "i2", number: "INV-002", contractId: "c-co", totalAmount: 160000, payments: [{ date: `${Y}-04-15`, amount: 100000 }, { date: `${Y}-05-20`, amount: 60000 }] },
    { id: "i3", number: "INV-003", contractId: "c-tx", totalAmount: 80000, paidAt: `${Y}-06-30` },
    { id: "i4", number: "INV-004", contractId: "c-none", totalAmount: 20000, payments: [{ date: `${Y}-07-01`, amount: 20000 }] },
    // Expense invoice: reimbursements are not income; the unpaid share of
    // its travel line becomes an auto deduction once a payment lands.
    { id: "i5", number: "EXP-001", kind: "expenses", contractId: "c-co", totalAmount: 1000, payments: [{ date: `${Y}-05-25`, amount: 600 }] },
  ],
  travelExpenses: [
    { id: "t1", date: `${Y}-05-02`, amount: 400, category: "Lodging", vendor: "Airport Inn", invoiceId: "i5" },
  ],
  taxPayments: [
    { id: "p1", jurisdiction: "federal", date: `${Y}-04-15`, amount: 30000, taxYear: Y, note: "Q1 1040-ES via EFTPS" },
    { id: "p2", jurisdiction: "federal", date: `${Y}-06-15`, amount: 30000, taxYear: Y, note: "Q2 1040-ES" },
    { id: "p3", jurisdiction: "CA", date: `${Y}-04-15`, amount: 12000, taxYear: Y, note: "540-ES Q1" },
    { id: "p4", jurisdiction: "CO", date: `${Y}-06-15`, amount: 2500, taxYear: Y, note: "" },
    { id: "p5", jurisdiction: "ND", date: `${Y}-01-15`, amount: 400, taxYear: Y, note: "Prior-year true-up" },
    { id: "p-old", jurisdiction: "federal", date: `${TAX_YEAR - 1}-09-15`, amount: 99999, taxYear: String(TAX_YEAR - 1), note: "last year, must not appear" },
  ],
  licenses: [], memberships: [], insurance: [], cme: [], deductibles: [],
};

// Only the tokens TaxPrep, Field, Modal and DeskTable read.
export const theme = {
  card: "#fff", border: "#ddd", input: "#f0fdf8", inputBorder: "#cde", text: "#111", textMuted: "#374151", textDim: "#6b7280",
  accent: "#10b981", accentDim: "#d1fae5", success: "#059669", successDim: "#ecfdf5", danger: "#dc2626", dangerDim: "#fef2f2",
  warning: "#d97706", warningDim: "#fffbeb", shadow1: "none", overlay: "rgba(0,0,0,0.5)",
};
