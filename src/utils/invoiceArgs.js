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
import { professionCopy } from "../constants/professionCopy.js";
import { isPhysicianDegree } from "../constants/professions.js";

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
 * "Jane Doe, DO", or a placeholder when Settings has no name: "Physician"
 * for an MD or DO, "Clinician" for a PA, an NP or a member with no
 * profession chosen, since an invoice goes to a third party (DESIGN 1.3,
 * 7.2). A name typed with its degree already ("Jane Doe, DO") does not get
 * it twice. Both placeholders are outgoingText.js PLACEHOLDER_SENDERS, which
 * the covers and file names treat as no name (senderName).
 */
export const physicianLabel = (settings = {}) =>
  (settings?.name ? withDegree(settings.name, settings.degreeType) : isPhysicianDegree(settings?.degreeType) ? "Physician" : "Clinician");

/**
 * What an invoice calls the member's work and the member, for the cover
 * letter (owner decision D-2): "physician assistant services", "nurse
 * practitioner services", and "clinical services" when no profession is
 * chosen, since the invoice goes to a third party. MD and DO add nothing, so
 * their letters read exactly as before ("physician services").
 */
export function invoiceProfessionFields(settings = {}) {
  const deg = settings?.degreeType || "";
  if (isPhysicianDegree(deg)) return {};
  const copy = professionCopy(deg, { audience: "third-party" });
  return { servicesPhrase: copy.servicesPhrase, memberNoun: copy.noun };
}

/**
 * Everything an invoice says about who sends it, for every send site: the
 * sender label and, for a PA, an NP or a blank profession, the services
 * phrase and noun. A send site spreads it in place of
 * `physician: physicianLabel(s)`, one line:
 *   ...invoiceSenderFields(s),
 * MD and DO get exactly { physician } as before.
 */
export const invoiceSenderFields = (settings = {}) => ({ physician: physicianLabel(settings), ...invoiceProfessionFields(settings) });

/**
 * The sender fields the read-only archive (ReadOnlyRecords.jsx) downloads a
 * saved invoice with. That path always printed the name as typed, with no
 * degree added ("Physician" with no name), so for an MD or DO it keeps doing
 * exactly that: their archived PDFs and file names stay byte-identical. A
 * PA, an NP or a member with no profession chosen gets invoiceSenderFields.
 */
export const archiveSenderFields = (settings = {}) =>
  (isPhysicianDegree(settings?.degreeType) ? { physician: settings?.name || "Physician" } : invoiceSenderFields(settings));

/**
 * The document arguments for resending `inv`. `contract` is its agreement
 * (may be missing), `settings` the physician's profile settings, `billName`
 * what to call the payer when the agreement is gone.
 */
export function invoiceDocumentArgs(inv, contract, settings = {}, billName = "") {
  const s = settings || {};
  return {
    number: inv.number,
    ...invoiceSenderFields(s),
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
