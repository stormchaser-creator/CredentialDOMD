/**
 * Tax constants, 2026 tax year. Every figure here was web-verified against
 * official sources (IRS revenue procedures, FTB, tax.colorado.gov, tax.nd.gov)
 * on 2026-08-11 — see VERIFIED_NOTE. Figures marked "projected" are the
 * latest officially published values indexed forward; the engine labels
 * them in the UI. Update this file each tax year.
 *
 * Brackets are [floor, rate] pairs: the rate applies to income ABOVE the
 * floor up to the next floor.
 */

export const TAX_YEAR = 2026;
export const VERIFIED_NOTE = "Figures verified against IRS/FTB/CO/ND sources on Aug 11, 2026.";

// ─── Federal (MFJ) ───────────────────────────────────────────
export const FED = {
  BRACKETS_MFJ: [
    [0, 0.10], [24800, 0.12], [100800, 0.22], [211400, 0.24],
    [403550, 0.32], [512450, 0.35], [768700, 0.37],
  ],
  STD_DEDUCTION_MFJ: 32200,
  SS_WAGE_BASE: 184500,
  SS_RATE: 0.062,            // each side
  MEDICARE_RATE: 0.0145,     // each side
  ADDL_MEDICARE_RATE: 0.009, // employee only
  ADDL_MEDICARE_THRESHOLD_MFJ: 250000,
  FUTA_RATE: 0.006,
  FUTA_WAGE_BASE: 7000,
  SAFE_HARBOR_PCT_HIGH_AGI: 1.10, // prior-year AGI > $150k
  // SSTB (physician) QBI fully phases out above this MFJ taxable income
  // (Rev. Proc. 2025-32: threshold $403,500 + $150,000 OBBBA range)
  QBI_SSTB_PHASEOUT_END_MFJ: 553500,
  QUARTERLY_DUE: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
};

// ─── California (resident; MFJ) ──────────────────────────────
export const CA = {
  // Official 2025 Schedule Y (FTB) — 2026 indexed brackets publish ~Oct 2026;
  // treat as the floor, thresholds only move up.
  BRACKETS_MFJ: [
    [0, 0.01], [22158, 0.02], [52528, 0.04], [82904, 0.06],
    [115084, 0.08], [145448, 0.093], [742958, 0.103],
    [891542, 0.113], [1485906, 0.123],
  ],
  MHST_RATE: 0.01,           // Behavioral Health Services Tax (renamed 2025), Form 540 line 62
  MHST_THRESHOLD: 1000000,   // not indexed
  STD_DEDUCTION_MFJ: 11412,  // official 2025; 2026 pending
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

// ─── Colorado (nonresident) ──────────────────────────────────
export const CO = {
  // 2026 confirmed 4.40% — the SB 24-228 TABOR trigger did not fire for 2026
  // per the June 2026 forecast (2024 was the 4.25% year).
  FLAT_RATE: 0.044,
};

// ─── North Dakota (nonresident; MFJ) ─────────────────────────
export const ND = {
  // Official 2026 MFJ schedule (tax.nd.gov): 0% to $82,800, 1.95% to
  // $304,850, 2.5% above. Nonresidents pay schedule tax x ND-source ratio.
  BRACKETS_MFJ: [
    [0, 0], [82800, 0.0195], [304850, 0.025],
  ],
};

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
