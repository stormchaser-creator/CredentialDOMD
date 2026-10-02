/**
 * What a saved invoice says when it is sent again: the arguments the PDF, the
 * Word and Excel files and the cover letter are all built from. One builder
 * for every resend path (the share sheet in Invoices.jsx and the server-sent
 * email in InvoiceEmailModal.jsx), so the two can never quote different
 * amounts, terms or lines for the same invoice.
 *
 * Pure: no React, no DOM. Nothing here writes to the invoice.
 */

import { callDayStartHour } from "./billing.js";
import { sentDay } from "./helpers.js";
import { withDegree } from "./outgoingText.js";

// Payments are a ledger, not a flag: agencies sometimes pay an invoice in
// pieces. Legacy invoices marked paid before the ledger existed count as
// paid in full.
export const paidOf = (inv) => {
  const fromLedger = (inv?.payments || []).reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
  if (fromLedger > 0) return fromLedger;
  return inv?.paidAt ? (parseFloat(inv.totalAmount) || 0) : 0;
};

// Written off = closed out without counting as money received, so tax
// estimates (which read paidOf/payments) never see a write-off as income.
export const balanceOf = (inv) => (inv?.writeOffAt ? 0 : Math.max(0, (parseFloat(inv?.totalAmount) || 0) - paidOf(inv)));

/**
 * "Jane Doe, DO", or "Physician" when Settings has no name. A name typed with
 * its degree already ("Jane Doe, DO") does not get it twice. The covers and
 * file names treat the "Physician" placeholder as no name (senderName).
 */
export const physicianLabel = (settings = {}) =>
  (settings?.name ? withDegree(settings.name, settings.degreeType) : "Physician");

/**
 * The document arguments for resending `inv`. `contract` is its agreement
 * (may be missing), `settings` the physician's profile settings, `billName`
 * what to call the payer when the agreement is gone.
 */
export function invoiceDocumentArgs(inv, contract, settings = {}, billName = "") {
  const s = settings || {};
  return {
    number: inv.number,
    physician: physicianLabel(s),
    npi: s.npi, email: s.email, phone: s.phone,
    facility: contract?.facility || billName, agency: contract?.agency, location: contract?.location, billTo: contract?.billTo,
    periodStart: inv.periodStart, periodEnd: inv.periodEnd,
    terms: inv.terms, lines: inv.lines,
    totalMin: inv.totalMinutes, total: inv.totalAmount,
    // A resend can follow a payment: the document and cover must say so.
    // The balance on paper is what was not paid. A write-off is the
    // physician's own bookkeeping (balanceOf), never a payment, so a written
    // off invoice resent after a partial payment never reads PAID IN FULL.
    paid: paidOf(inv), balance: Math.max(0, (parseFloat(inv.totalAmount) || 0) - paidOf(inv)),
    // The local day it was sent, the same day its number carries.
    issuedDate: sentDay(inv.sentAt) || undefined,
    // An expense invoice's cover says travel expenses, not physician services.
    kind: inv.kind,
    // The call-day window a day block prints (invoiceLayout.js). Lines saved
    // since the layout carry their own; older ones read the agreement's.
    ...(contract ? { dayStartHour: callDayStartHour(contract) } : {}),
  };
}
