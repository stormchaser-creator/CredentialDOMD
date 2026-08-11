import { FED, CA, CO, ND, bracketTax, TAX_YEAR } from "./taxConstants.js";

/**
 * Multistate tax estimate for a locum physician. Cash basis: income counts
 * when a payment lands, allocated to the state where the work happened
 * (contract.workState). Supports S-corp (W-2 salary + K-1 distribution)
 * and sole-proprietor (Schedule C + SE tax) entity models.
 *
 * This is a PLANNING estimate — the numbers that ride on facts only a
 * return preparer resolves (reasonable comp, apportionment formulas,
 * PTET elections) are surfaced as assumptions, not decided here.
 */

// Payments received in `year` for one invoice (ledger dates; legacy paidAt = full)
function paymentsInYear(inv, year) {
  const led = (inv.payments || []).filter(p => String(p.date || "").startsWith(String(year)));
  if (led.length) return led.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  if ((inv.payments || []).length) return 0; // ledger exists, nothing this year
  if (inv.paidAt && String(inv.paidAt).startsWith(String(year))) return parseFloat(inv.totalAmount) || 0;
  return 0;
}

/** Collected income by work state. Expense invoices are reimbursements, not income. */
export function incomeByState(invoices, contracts, year = TAX_YEAR) {
  const stateOf = (inv) => {
    const c = contracts.find(x => x.id === inv.contractId);
    if (c?.workState) return c.workState;
    const m = String(c?.location || "").match(/,\s*([A-Z]{2})\b/);
    return m ? m[1] : "Unassigned";
  };
  const by = {};
  let total = 0;
  const unassigned = new Set();
  for (const inv of invoices) {
    if (inv.kind === "expenses") continue;
    const amt = paymentsInYear(inv, year);
    if (amt <= 0) continue;
    const st = stateOf(inv);
    by[st] = (by[st] || 0) + amt;
    total += amt;
    if (st === "Unassigned") unassigned.add(inv.number);
  }
  return { by, total, unassignedInvoices: [...unassigned] };
}

/** Deduction total with the meals limitation applied. */
export function deductionTotal(items) {
  return items.reduce((s, d) => {
    const amt = parseFloat(d.amount) || 0;
    return s + (/meals/i.test(d.category || "") ? amt * 0.5 : amt);
  }, 0);
}

/**
 * Full estimate. `tp` = settings.taxPrep:
 * { entity: "scorp"|"soleprop", scorpSalary, otherIncome, priorYearTax }
 */
export function estimate({ income, deductions, tp }) {
  const entity = tp.entity || "scorp";
  const otherIncome = parseFloat(tp.otherIncome) || 0;
  const gross = income.total;
  const profit = Math.max(0, gross - deductions);
  const notes = [];

  let salary = 0, k1 = 0, employerPayroll = 0, employeePayroll = 0, caFranchise = 0, seTax = 0, sdi = 0;

  if (entity === "scorp") {
    salary = Math.min(parseFloat(tp.scorpSalary) || 0, profit);
    if (!salary && profit > 0) notes.push("Set your S-corp W-2 salary (reasonable compensation) — with $0 salary this estimate treats everything as distribution, which is not a filing position your CPA will take.");
    const ssEr = FED.SS_RATE * Math.min(salary, FED.SS_WAGE_BASE);
    const medEr = FED.MEDICARE_RATE * salary;
    const futa = (CA.FUTA_NET_RATE || FED.FUTA_RATE) * Math.min(salary, FED.FUTA_WAGE_BASE);
    const sui = CA.SUI_NEW_EMPLOYER_RATE * Math.min(salary, CA.SUI_WAGE_BASE) + CA.ETT_RATE * Math.min(salary, CA.SUI_WAGE_BASE);
    employerPayroll = ssEr + medEr + futa + sui;
    caFranchise = profit > 0 ? Math.max(CA.SCORP_FRANCHISE_MIN, CA.SCORP_FRANCHISE_RATE * Math.max(0, profit - salary - employerPayroll)) : 0;
    k1 = Math.max(0, profit - salary - employerPayroll - caFranchise);
    employeePayroll = FED.SS_RATE * Math.min(salary, FED.SS_WAGE_BASE)
      + FED.MEDICARE_RATE * salary
      + FED.ADDL_MEDICARE_RATE * Math.max(0, salary - FED.ADDL_MEDICARE_THRESHOLD_MFJ);
    sdi = CA.SDI_RATE * salary;
  } else {
    // Sole proprietor: SE tax on 92.35% of profit, half deductible
    const seBase = profit * 0.9235;
    seTax = FED.SS_RATE * 2 * Math.min(seBase, FED.SS_WAGE_BASE)
      + FED.MEDICARE_RATE * 2 * seBase
      + FED.ADDL_MEDICARE_RATE * Math.max(0, seBase - FED.ADDL_MEDICARE_THRESHOLD_MFJ);
    k1 = Math.max(0, profit - seTax / 2); // half-SE deduction
  }

  const passThrough = salary + k1;
  const fedTaxable = Math.max(0, passThrough + otherIncome - FED.STD_DEDUCTION_MFJ);
  if (fedTaxable > FED.QBI_SSTB_PHASEOUT_END_MFJ) {
    notes.push("No QBI deduction: physician income is an SSTB and taxable income is beyond the 199A phase-out.");
  }
  const fedIncomeTax = bracketTax(fedTaxable, FED.BRACKETS_MFJ);
  const fedTotal = fedIncomeTax + employeePayroll + seTax;

  // State sourcing: allocate the economic income by each state's revenue share
  const share = (st) => gross > 0 ? (income.by[st] || 0) / gross : 0;
  const coSource = share("CO") * passThrough;
  const ndSource = share("ND") * passThrough;

  const coTax = CO.FLAT_RATE * coSource;
  // ND ratio method: schedule tax on total income × ND-source share
  const ndScheduleTax = bracketTax(Math.max(0, passThrough + otherIncome), ND.BRACKETS_MFJ);
  const ndTax = fedTaxable > 0 ? ndScheduleTax * (ndSource / Math.max(1, passThrough + otherIncome)) : 0;

  // California resident: taxed on everything, credit for the double-taxed part
  const caTaxable = Math.max(0, passThrough + otherIncome - CA.STD_DEDUCTION_MFJ);
  const caGrossTax = bracketTax(caTaxable, CA.BRACKETS_MFJ)
    + CA.MHST_RATE * Math.max(0, caTaxable - CA.MHST_THRESHOLD);
  const ostc = caTaxable > 0
    ? Math.min(coTax + ndTax, caGrossTax * ((coSource + ndSource) / caTaxable))
    : 0;
  const caTax = Math.max(0, caGrossTax - ostc);

  const totalStateLocal = caTax + coTax + ndTax + caFranchise + sdi;
  const totalAll = fedTotal + totalStateLocal;

  return {
    gross, deductions, profit, salary, k1, employerPayroll, employeePayroll,
    caFranchise, sdi, seTax, otherIncome, fedTaxable, fedIncomeTax, fedTotal,
    states: {
      CA: { source: passThrough - coSource - ndSource, grossTax: caGrossTax, credit: ostc, owed: caTax },
      CO: { source: coSource, owed: coTax },
      ND: { source: ndSource, owed: ndTax },
    },
    totalAll,
    setAsideRate: gross > 0 ? totalAll / gross : 0,
    safeHarbor: (parseFloat(tp.priorYearTax) || 0) * FED.SAFE_HARBOR_PCT_HIGH_AGI || null,
    notes,
  };
}
