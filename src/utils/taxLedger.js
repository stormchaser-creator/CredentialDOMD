import { STATE_NAMES } from "../constants/states.js";

/**
 * The rows TaxPrep draws once the engine has run: collected income by work
 * state, one ledger row per jurisdiction (estimate, paid, remaining) and the
 * totals. On the phone these are the mini-cards and the payments ledger; at
 * desk width they are the two tables. Both read the numbers from here, so
 * the two presentations cannot drift apart. Pure functions, no React.
 */

const stateName = (st) => STATE_NAMES[st] || st;
const FRANCHISE_LABEL = "CA S-corp franchise (Form 100S)";

/** Estimated-payment records for one tax year. */
export function paymentsForYear(taxPayments, year) {
  return (taxPayments || []).filter(p => p.taxYear === String(year));
}

export function sumPayments(payments) {
  return payments.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
}

/**
 * Collected income per work state, largest first, with each state's share of
 * the year's gross as a whole-percent string. "Unassigned" is money collected
 * on a contract with no work state.
 */
export function collectedByState(income) {
  return Object.entries(income.by)
    .sort((a, b) => b[1] - a[1])
    .map(([state, amount]) => ({ state, amount, pct: ((amount / income.total) * 100).toFixed(0) }));
}

/**
 * Jurisdictions the payments ledger tracks: federal, resident state, each
 * nonresident work state, CA franchise when a CA S-corp. Any jurisdiction
 * that already has a payment recorded stays listed so records never vanish.
 *
 * Each row carries the estimate the phone card shows (`owed`, null when no
 * state model is loaded), the income collected in that jurisdiction with
 * its share of gross, what has been paid there, and the remainder. `hasEst`
 * is false until the filing profile is complete; the UI must not show an
 * estimate before that.
 */
export function jurisdictionRows({ est, income, isScorp, payments }) {
  const shares = new Map(collectedByState(income).map(r => [r.state, r]));
  const collected = (id) => shares.get(id)?.amount ?? null;
  const pct = (id) => shares.get(id)?.pct ?? null;

  const list = [{ id: "federal", label: "Federal (IRS)", kind: "federal", owed: est.fedTotal, income: income.total, pct: null }];
  if (est.resident) {
    list.push({
      id: est.resident.state,
      label: `${stateName(est.resident.state)} (resident)`,
      kind: "state",
      owed: est.resident.modeled ? est.resident.owed + est.sdi : null,
      income: collected(est.resident.state), pct: pct(est.resident.state),
    });
  }
  for (const n of est.nonresident) {
    list.push({
      id: n.state, label: `${stateName(n.state)} (nonresident)`, kind: "state",
      owed: n.modeled ? n.owed : null, income: collected(n.state), pct: pct(n.state),
    });
  }
  if (est.resident?.state === "CA" && isScorp) {
    list.push({ id: "CA-franchise", label: FRANCHISE_LABEL, kind: "franchise", owed: est.franchise, income: null, pct: null });
  }
  for (const p of payments) {
    if (!list.some(j => j.id === p.jurisdiction)) {
      list.push({
        id: p.jurisdiction,
        label: p.jurisdiction === "CA-franchise" ? FRANCHISE_LABEL : stateName(p.jurisdiction),
        kind: "other", owed: null, income: collected(p.jurisdiction), pct: pct(p.jurisdiction),
      });
    }
  }
  return list.map(j => {
    const paid = sumPayments(payments.filter(p => p.jurisdiction === j.id));
    const hasEst = est.ready && j.owed != null;
    return { ...j, paid, hasEst, remaining: hasEst ? Math.max(0, j.owed - paid) : null };
  });
}

/**
 * Desk income table rows: the ledger's jurisdictions plus, when collected
 * income has no work state, a final row carrying that money so it appears
 * where the phone's income card lists it. Nothing is estimated for it and
 * no payment can be recorded against it.
 */
export function incomeTableRows(rows, income) {
  const u = collectedByState(income).find(r => r.state === "Unassigned");
  if (!u) return rows;
  return [...rows, {
    id: "Unassigned", label: "No work state on contract", kind: "unassigned",
    owed: null, income: u.amount, pct: u.pct, paid: 0, hasEst: false, remaining: null,
  }];
}

/**
 * The headline figures: gross collected, the engine's federal and state
 * totals (which sum to est.totalAll), everything paid this year, and the
 * year's remainder. Federal, state and remaining are null until the filing
 * profile is complete.
 */
export function ledgerTotals({ est, income, payments }) {
  const paid = sumPayments(payments);
  return {
    income: income.total,
    fed: est.ready ? est.fedTotal : null,
    state: est.ready ? est.stateLocal : null,
    paid,
    remaining: est.ready ? Math.max(0, est.totalAll - paid) : null,
  };
}
