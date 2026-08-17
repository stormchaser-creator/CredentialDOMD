/**
 * Tax constants, 2026 tax year. Every figure here was verified against an
 * official source document; the source and date sit next to each block.
 * Figures marked "projected" are the latest officially published values;
 * the engine labels them in the UI. Update this file each tax year.
 *
 * Brackets are [floor, rate] pairs: the rate applies to income ABOVE the
 * floor up to the next floor. Every bracket/deduction table is keyed by
 * filing status: mfj | single | mfs | hoh.
 */

export const TAX_YEAR = 2026;
export const VERIFIED_NOTE = "Figures verified against IRS Rev. Proc. 2025-32, FTB 2025 rate schedules and 540 booklet, tax.colorado.gov, and ND Form ND-1ES 2026 (Aug 16, 2026).";

export const FILING_STATUSES = [
  { id: "mfj", label: "Married filing jointly" },
  { id: "single", label: "Single" },
  { id: "mfs", label: "Married filing separately" },
  { id: "hoh", label: "Head of household" },
];

// 50 states + DC (no territories) for the resident-state / work-state pickers.
export const TAX_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC",
];

// ─── Federal ─────────────────────────────────────────────────
// Rev. Proc. 2025-32 (IRS, Oct 2025): section 3.01 rate tables 1 to 4,
// section 3.14 standard deduction, section 3.26 QBI thresholds. Text
// extracted from irs.gov/pub/irs-drop/rp-25-32.pdf on 2026-08-16.
export const FED = {
  BRACKETS: {
    mfj: [
      [0, 0.10], [24800, 0.12], [100800, 0.22], [211400, 0.24],
      [403550, 0.32], [512450, 0.35], [768700, 0.37],
    ],
    single: [
      [0, 0.10], [12400, 0.12], [50400, 0.22], [105700, 0.24],
      [201775, 0.32], [256225, 0.35], [640600, 0.37],
    ],
    mfs: [
      [0, 0.10], [12400, 0.12], [50400, 0.22], [105700, 0.24],
      [201775, 0.32], [256225, 0.35], [384350, 0.37],
    ],
    hoh: [
      [0, 0.10], [17700, 0.12], [67450, 0.22], [105700, 0.24],
      [201750, 0.32], [256200, 0.35], [640600, 0.37],
    ],
  },
  STD_DEDUCTION: { mfj: 32200, single: 16100, mfs: 16100, hoh: 24150 },
  SS_WAGE_BASE: 184500,
  SS_RATE: 0.062,            // each side
  MEDICARE_RATE: 0.0145,     // each side
  ADDL_MEDICARE_RATE: 0.009, // employee only
  // IRC 3101(b)(2), not indexed (IRS Tax Topic 560): $250k MFJ, $125k MFS, $200k all others.
  ADDL_MEDICARE_THRESHOLD: { mfj: 250000, single: 200000, mfs: 125000, hoh: 200000 },
  FUTA_RATE: 0.006,
  FUTA_WAGE_BASE: 7000,
  SAFE_HARBOR_PCT_HIGH_AGI: 1.10, // prior-year AGI > $150k
  // SSTB (physician) QBI fully phases out above these taxable incomes
  // (Rev. Proc. 2025-32 sec. 3.26 "phase-in range amount" column).
  QBI_SSTB_PHASEOUT_END: { mfj: 553500, single: 276750, mfs: 276775, hoh: 276750 },
  QUARTERLY_DUE: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
};

// ─── California ──────────────────────────────────────────────
// Official 2025 Schedules X/Y/Z (ftb.ca.gov/forms/2025/2025-540-tax-rate-schedules.pdf)
// and the 2025 540 booklet standard deduction chart, both read 2026-08-16.
// 2026 indexed figures publish ~Oct 2026; treat these as the floor.
export const CA = {
  BRACKETS: {
    mfj: [
      [0, 0.01], [22158, 0.02], [52528, 0.04], [82904, 0.06],
      [115084, 0.08], [145448, 0.093], [742958, 0.103],
      [891542, 0.113], [1485906, 0.123],
    ],
    single: [
      [0, 0.01], [11079, 0.02], [26264, 0.04], [41452, 0.06],
      [57542, 0.08], [72724, 0.093], [371479, 0.103],
      [445771, 0.113], [742953, 0.123],
    ],
    mfs: [
      [0, 0.01], [11079, 0.02], [26264, 0.04], [41452, 0.06],
      [57542, 0.08], [72724, 0.093], [371479, 0.103],
      [445771, 0.113], [742953, 0.123],
    ],
    hoh: [
      [0, 0.01], [22173, 0.02], [52530, 0.04], [67716, 0.06],
      [83805, 0.08], [98990, 0.093], [505208, 0.103],
      [606251, 0.113], [1010417, 0.123],
    ],
  },
  STD_DEDUCTION: { mfj: 11412, single: 5706, mfs: 5706, hoh: 11412 },
  MHST_RATE: 0.01,           // Behavioral Health Services Tax, Form 540 line 62
  MHST_THRESHOLD: 1000000,   // not indexed, same for every filing status
  SCORP_FRANCHISE_RATE: 0.015,
  SCORP_FRANCHISE_MIN: 800,
  SDI_RATE: 0.013,           // 2026 official (up from 1.2%); uncapped since SB 951
  SUI_NEW_EMPLOYER_RATE: 0.034,
  SUI_WAGE_BASE: 7000,
  ETT_RATE: 0.001,
  // CA is a FUTA credit-reduction state: net 1.8% for 2025 wages; the 2026
  // determination lands Nov 10, 2026 and likely steps to 2.1%.
  FUTA_NET_RATE: 0.018,
};

// ─── Colorado ────────────────────────────────────────────────
export const CO = {
  // Statutory 4.40%. tax.colorado.gov Individual Income Tax Guide (read
  // 2026-08-16) lists 4.4% for 2025 and has not yet printed a 2026 row; the
  // Aug 11 check found the SB 24-228 TABOR trigger did not fire for 2026
  // (2024 was the 4.25% year). Flat rate, so filing status does not change
  // the schedule. CO taxable income starts from federal taxable income.
  FLAT_RATE: 0.044,
};

// ─── North Dakota ────────────────────────────────────────────
// 2026 Forms ND-1 / ND-EZ Tax Rate Schedules, printed on Form ND-1ES 2026
// (SFN 28709, 12-2025), tax.nd.gov, read 2026-08-16. ND taxable income
// starts from federal taxable income. Nonresidents pay schedule tax x
// ND-source ratio (ND-1ES lines 15 to 19).
export const ND = {
  BRACKETS: {
    mfj: [[0, 0], [82800, 0.0195], [304850, 0.025]],
    single: [[0, 0], [49575, 0.0195], [250400, 0.025]],
    mfs: [[0, 0], [41400, 0.0195], [152425, 0.025]],
    hoh: [[0, 0], [66400, 0.0195], [277600, 0.025]],
  },
};

// States with no individual income tax on wages or business income
// (AK, FL, NV, NH, SD, TN, TX, WA, WY). NH finished repealing its interest
// and dividends tax on 2025-01-01. WA taxes certain capital gains only;
// that is outside this estimate.
export const NO_INCOME_TAX_STATES = ["AK", "FL", "NV", "NH", "SD", "TN", "TX", "WA", "WY"];

// Which states this engine can model. Anything else is labeled "state model
// not loaded yet" in the UI, never estimated with borrowed brackets.
export const MODELED_STATES = ["CA", "CO", "ND"];
export const isStateModeled = (st) => MODELED_STATES.includes(st) || NO_INCOME_TAX_STATES.includes(st);

/** Progressive tax on `income` over [floor, rate] brackets. */
export function bracketTax(income, brackets) {
  let tax = 0;
  for (let i = 0; i < brackets.length; i++) {
    const [floor, rate] = brackets[i];
    if (income <= floor) break;
    const ceil = i + 1 < brackets.length ? brackets[i + 1][0] : Infinity;
    tax += (Math.min(income, ceil) - floor) * rate;
  }
  return tax;
}
