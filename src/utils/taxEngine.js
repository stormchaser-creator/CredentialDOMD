import {
  FED, CA, CO, ND, bracketTax, TAX_YEAR, FILING_STATUSES,
  NO_INCOME_TAX_STATES, MODELED_STATES,
} from "./taxConstants.js";

/**
 * Multistate tax estimate for a locum physician. Cash basis: income counts
 * when a payment lands, allocated to the state where the work happened
 * (contract.workState). Supports S-corp (W-2 salary + K-1 distribution)
 * and sole-proprietor (Schedule C + SE tax) entity models.
 *
 * Resident state and filing status come from settings.taxPrep. The resident
 * state is taxed on everything with a credit for tax paid to work states;
 * each work state is taxed by the ratio method (schedule tax on all income
 * x that state's share of income). States without a loaded model are
 * reported as unmodeled, never estimated with borrowed brackets.
 *
 * This is a PLANNING estimate. The numbers that ride on facts only a
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

const VALID_FS = new Set(FILING_STATUSES.map(f => f.id));

/**
 * State income tax on ALL income, as if the taxpayer were a full-year
 * resident of `st`. Returns null when no model is loaded for that state.
 * `agi` = pass-through + other income; `fedTaxable` = after federal std deduction.
 */
function stateScheduleTax(st, fs, agi, fedTaxable) {
  if (NO_INCOME_TAX_STATES.includes(st)) return { taxable: 0, tax: 0, label: "no state income tax" };
  if (st === "CA") {
    const taxable = Math.max(0, agi - CA.STD_DEDUCTION[fs]);
    const tax = bracketTax(taxable, CA.BRACKETS[fs]) + CA.MHST_RATE * Math.max(0, taxable - CA.MHST_THRESHOLD);
    return { taxable, tax, label: "FTB schedule + 1% BHST over $1M" };
  }
  if (st === "CO") {
    return { taxable: fedTaxable, tax: CO.FLAT_RATE * fedTaxable, label: `${(CO.FLAT_RATE * 100).toFixed(2)}% flat on federal taxable income` };
  }
  if (st === "ND") {
    return { taxable: fedTaxable, tax: bracketTax(fedTaxable, ND.BRACKETS[fs]), label: "0 / 1.95 / 2.5% schedule on federal taxable income" };
  }
  return null;
}

/**
 * Full estimate. `tp` = settings.taxPrep:
 * { residentState, filingStatus, entity: "scorp"|"soleprop", scorpSalary, otherIncome, priorYearTax }
 * `ready` is false until residentState and filingStatus are both set; the
 * math then falls back to MFJ so callers never crash, but the UI must not
 * show those numbers.
 */
export function estimate({ income, deductions, tp }) {
  const entity = tp.entity || "scorp";
  const fs = VALID_FS.has(tp.filingStatus) ? tp.filingStatus : "mfj";
  const res = tp.residentState || null;
  const ready = VALID_FS.has(tp.filingStatus) && !!res;
  const otherIncome = parseFloat(tp.otherIncome) || 0;
  const gross = income.total;
  const profit = Math.max(0, gross - deductions);
  const notes = [];
  const caEntity = res === "CA"; // CA payroll/franchise items ride on a CA-domiciled entity

  let salary = 0, k1 = 0, employerPayroll = 0, employeePayroll = 0, franchise = 0, seTax = 0, sdi = 0;

  if (entity === "scorp") {
    salary = Math.min(parseFloat(tp.scorpSalary) || 0, profit);
    if (!salary && profit > 0) notes.push("Set your S-corp W-2 salary (reasonable compensation). With $0 salary this estimate treats everything as distribution, which is not a filing position your CPA will take.");
    const ssEr = FED.SS_RATE * Math.min(salary, FED.SS_WAGE_BASE);
    const medEr = FED.MEDICARE_RATE * salary;
    const futa = (caEntity ? CA.FUTA_NET_RATE : FED.FUTA_RATE) * Math.min(salary, FED.FUTA_WAGE_BASE);
    const sui = caEntity
      ? CA.SUI_NEW_EMPLOYER_RATE * Math.min(salary, CA.SUI_WAGE_BASE) + CA.ETT_RATE * Math.min(salary, CA.SUI_WAGE_BASE)
      : 0;
    employerPayroll = ssEr + medEr + futa + sui;
    franchise = caEntity && profit > 0
      ? Math.max(CA.SCORP_FRANCHISE_MIN, CA.SCORP_FRANCHISE_RATE * Math.max(0, profit - salary - employerPayroll))
      : 0;
    k1 = Math.max(0, profit - salary - employerPayroll - franchise);
    employeePayroll = FED.SS_RATE * Math.min(salary, FED.SS_WAGE_BASE)
      + FED.MEDICARE_RATE * salary
      + FED.ADDL_MEDICARE_RATE * Math.max(0, salary - FED.ADDL_MEDICARE_THRESHOLD[fs]);
    sdi = caEntity ? CA.SDI_RATE * salary : 0;
    if (res && !caEntity && salary > 0) {
      notes.push(`Employer-side state unemployment insurance and any entity-level state tax for ${res} are not in this estimate.`);
    }
  } else {
    // Sole proprietor: SE tax on 92.35% of profit, half deductible
    const seBase = profit * 0.9235;
    seTax = FED.SS_RATE * 2 * Math.min(seBase, FED.SS_WAGE_BASE)
      + FED.MEDICARE_RATE * 2 * seBase
      + FED.ADDL_MEDICARE_RATE * Math.max(0, seBase - FED.ADDL_MEDICARE_THRESHOLD[fs]);
    k1 = Math.max(0, profit - seTax / 2); // half-SE deduction
  }

  const passThrough = salary + k1;
  const agi = passThrough + otherIncome;
  const fedTaxable = Math.max(0, agi - FED.STD_DEDUCTION[fs]);
  if (fedTaxable > FED.QBI_SSTB_PHASEOUT_END[fs]) {
    notes.push("No QBI deduction: physician income is an SSTB and taxable income is beyond the 199A phase-out.");
  }
  const fedIncomeTax = bracketTax(fedTaxable, FED.BRACKETS[fs]);
  const fedTotal = fedIncomeTax + employeePayroll + seTax;

  // State sourcing: allocate the economic income by each state's revenue share
  const share = (st) => gross > 0 ? (income.by[st] || 0) / gross : 0;
  const workStates = Object.keys(income.by).filter(st => st !== "Unassigned");

  // Nonresident work states: schedule tax on all income x that state's share (ratio method)
  const nonresident = [];
  for (const st of workStates) {
    if (st === res) continue;
    const source = share(st) * passThrough;
    const model = stateScheduleTax(st, fs, agi, fedTaxable);
    if (!model) { nonresident.push({ state: st, source, owed: null, modeled: false }); continue; }
    const ratio = agi > 0 ? Math.min(1, source / agi) : 0;
    nonresident.push({ state: st, source, owed: model.tax * ratio, modeled: true, label: model.label });
  }
  const modeledNR = nonresident.filter(n => n.modeled);
  const nrOwed = modeledNR.reduce((s, n) => s + n.owed, 0);
  const nrSource = modeledNR.reduce((s, n) => s + n.source, 0);

  // Resident state: taxed on everything, credit for the double-taxed part
  let resident = null;
  if (res) {
    const model = stateScheduleTax(res, fs, agi, fedTaxable);
    if (!model) {
      resident = { state: res, modeled: false, source: passThrough - nonresident.reduce((s, n) => s + n.source, 0), grossTax: null, credit: null, owed: null };
    } else {
      const grossTax = model.tax;
      const credit = model.taxable > 0
        ? Math.min(nrOwed, grossTax * Math.min(1, nrSource / model.taxable))
        : 0;
      resident = {
        state: res, modeled: true, label: model.label,
        source: passThrough - nonresident.reduce((s, n) => s + n.source, 0),
        grossTax, credit, owed: Math.max(0, grossTax - credit),
        noIncomeTax: NO_INCOME_TAX_STATES.includes(res),
      };
    }
  }

  const unmodeled = [
    ...(resident && !resident.modeled ? [res] : []),
    ...nonresident.filter(n => !n.modeled).map(n => n.state),
  ];

  const stateLocal = (resident?.owed || 0) + nrOwed + franchise + sdi;
  const totalAll = fedTotal + stateLocal;

  return {
    ready, filingStatus: fs, residentState: res,
    gross, deductions, profit, salary, k1, employerPayroll, employeePayroll,
    franchise, sdi, seTax, otherIncome, agi, fedTaxable, fedIncomeTax, fedTotal,
    resident, nonresident, unmodeled, stateLocal,
    totalAll,
    setAsideRate: gross > 0 ? totalAll / gross : 0,
    safeHarbor: (parseFloat(tp.priorYearTax) || 0) * FED.SAFE_HARBOR_PCT_HIGH_AGI || null,
    notes,
    supportedStates: [...MODELED_STATES],
  };
}
