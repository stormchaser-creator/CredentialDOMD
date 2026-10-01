// Cancel and get a refund: what the member reads (RefundSection.jsx). Every
// sentence is a fact the server enforces:
//   - the refund is the most recent annual membership payment, in full
//     (limited-refund verifies the latest paid invoice; the guarantee text
//     the offer shows is unchanged);
//   - the membership ends now: the subscription is cancelled with no
//     proration credit and settled as a deleted subscription, so the access
//     snapshot stops writes (capabilities.*.write false) and it cannot renew;
//   - nothing is deleted: a cancelled limited-launch membership schedules no
//     deletion (profiles.data_deletion_date is set by nothing on this path),
//     and read and export stay open for an active account (the Privacy
//     Policy, section 9: "Canceling a paid membership does not delete
//     anything.");
//   - a later purchase is at the standard price (has_limited_paid_purchase:
//     a paid purchase consumes founding and early bird pricing), and a paid
//     founding place is not given back.
import { membershipDate, membershipPrice } from "../utils/membershipTiming.js";

export const REFUND_COPY = Object.freeze({
  action: "Cancel and get a refund",
  finish: "Finish refund",
  keep: "Keep my membership",
  exportFirst: "Export saved records first",
  heading: "Cancel and get a refund",
  endsNow: "Your membership ends now. The subscription is cancelled today and will not renew, and you can no longer add or change records.",
  recordsKept: "Nothing is deleted. Your saved records and documents stay available to view and export until you delete them yourself. You can export a copy first.",
  rejoin: "If you join again later, you pay the standard price at that time.",
  confirm: "I understand my membership ends now and I want this payment refunded.",
  // An unfinished request whose cancellation is recorded (subscriptionCanceled).
  // The refund sweep (20260930072000) keeps finishing it in the background.
  unfinished: "Your refund is not finished yet. Your membership is cancelled, and we keep trying to return your payment for you. You can also press Finish refund to try again now.",
  // The same after a failed refund attempt: the server opened a support
  // ticket in the member's name (supportTicket, 20260930071000).
  unfinishedTicket: "Your refund is not finished yet. Your membership is cancelled. We opened a support ticket for you, which you can read in Get help, and we will finish your refund for you. You do not need to do anything. You can also press Finish refund to try again now.",
  // One that stopped before its cancellation: nothing is claimed about the
  // membership (its Stripe cancellation may have gone through unanswered),
  // nor about the money: support may have refunded the payment in the
  // dashboard, and until limited-stripe-webhook records that refund the row
  // does not hold it (20261001041500). The refund sweep (20260930072000)
  // finishes it without the member.
  notStarted: "Your refund request did not finish. We keep trying to finish it for you, which cancels your membership and completes your refund. You can also press Finish refund to do it now.",
  // An unfinished request whose payment was refunded already (support, in
  // the Stripe dashboard): limited_refund_confirm keeps that refund on the
  // row (refundStatus pending, succeeded or requires_action) until the
  // webhook, the sweep or a press records the cancellation and finishes it.
  issuedNotCancelled: "A refund of your payment was issued to the card you paid with. Your membership is not cancelled yet. We are finishing your request for you, which ends your membership. You can also press Finish refund to do it now.",
  issuedCancelled: "A refund of your payment was issued to the card you paid with, and your membership is cancelled. We are finishing your request for you. You can also press Finish refund to finish it now.",
  // needs_support: the server opened a support ticket in the member's name
  // (supportTicket, 20260930071000); the owner finishes it from there.
  needsSupport: "Your membership was cancelled, but the refund could not be completed automatically. We opened a support ticket for you, which you can read in Get help, and we will finish your refund for you. You do not need to do anything. Your saved records stay available to view and export.",
  // needs_support before any cancellation (a refund made that is not the
  // latest payment, a disputed charge, the background retries used up): the
  // membership is not cancelled yet, and nothing is promised, since a person
  // may find the refund is not owed as asked (review round 3, 2026-09-30).
  needsSupportOpen: "Your refund request needs a person to look at it, and your membership is not cancelled yet. We opened a support ticket for you, which you can read in Get help, and we will reply there. Your saved records stay available to view and export.",
  // needs_support after the cancellation for a reason where a refund may not
  // be owed as asked (reviewOnly: a disputed or partly refunded charge, say):
  // the ticket promises nothing, so neither does this (review round 4).
  needsSupportReview: "Your membership was cancelled, and your refund needs a person to look at it. We opened a support ticket for you, which you can read in Get help, and we will reply there. Your saved records stay available to view and export.",
  needsSupportReviewNoTicket: "Your membership was cancelled, and your refund needs a person to look at it. Contact support@credentialdomd.com or use Get help. Your saved records stay available to view and export.",
  // The same with no ticket on record (a server from before 20260930071000).
  needsSupportNoTicket: "Your membership was cancelled, but the refund could not be completed automatically. Contact support@credentialdomd.com or use Get help and it will be finished for you. Your saved records stay available to view and export.",
  needsSupportOpenNoTicket: "Your refund request needs a person to finish it. Contact support@credentialdomd.com or use Get help. Your saved records stay available to view and export.",
  // limited-checkout refuses a new purchase while a refund is unfinished.
  finishBeforeJoining: "Your refund is not finished yet. Press Finish refund on this page first; you can join again after that. Nothing was charged.",
  issued: "The refund has been issued to the card you paid with. Your saved records stay available to view and export.",
  onItsWay: "The refund is on its way to the card you paid with. Your saved records stay available to view and export.",
});

/** The refund sentence for a quote: amount, date, what it is. */
export function refundSentence(view) {
  return `We will refund ${membershipPrice(view.amountCents)}, your most recent annual membership payment, made on ${membershipDate(view.paidAt)}, in full to the card you paid with.`;
}

/** A refund Stripe accepted for an unfinished request (refundStatus): the money is on its way back. */
export function refundIssued(view) {
  return view?.state === "resume" && ["pending", "succeeded", "requires_action"].includes(view.refundStatus);
}

/** The refund sentence for a request whose payment was refunded already. */
export function refundIssuedSentence(view) {
  return `A refund of ${membershipPrice(view.amountCents)}, your annual membership payment made on ${membershipDate(view.paidAt)}, was issued to the card you paid with.`;
}

/** The confirm button: it names the amount. */
export function refundButton(view) {
  return `Cancel membership and refund ${membershipPrice(view.amountCents)}`;
}

/** The alternative that keeps access and gets no refund. */
export function keepUntilSentence(periodEnd) {
  return `Prefer to keep your membership until ${membershipDate(periodEnd)} without a refund? Use Manage paid subscription to turn off renewal instead.`;
}

/** A recorded, finished refund. */
export function refundedSentence(view) {
  return `Refunded: ${membershipPrice(view.amountCents)} on ${membershipDate(view.refundedAt)}. Your membership has ended and will not renew.`;
}

const MESSAGES = Object.freeze({
  refund_in_progress: "Your refund is already being processed. Check again in a minute.",
  refund_pending: "Your refund did not finish. Nothing was refunded twice. Press Finish refund to complete it.",
  refund_quote_changed: "Your latest payment changed. Review the refund again before confirming.",
  no_refundable_payment: "There is no payment on this membership to refund right now. Contact support@credentialdomd.com if you think this is a mistake.",
  refund_not_available: "Lifetime access has no payment to refund.",
  // A disputed or partly refunded charge with no request on record: a person
  // looks first, and nothing is promised.
  refund_needs_support: "This payment needs a person to look at it. Contact support@credentialdomd.com or use Get help.",
  no_paid_membership: "No paid membership was found on this account.",
  // Refunded in full already (support, in the Stripe dashboard).
  payment_already_refunded: "Your most recent payment has already been refunded. Nothing was changed. If your membership still shows as renewing, contact support@credentialdomd.com or use Get help.",
});

const UNCONFIRMED = "We could not confirm the result yet. Check again to see where your refund stands.";

/**
 * What to say when a refund request did not answer with an outcome.
 * `acted`: the refund itself was asked for (not a quote). A failure the
 * server did not name may come after Stripe cancelled and refunded (a ledger
 * write that failed, say), so it never says nothing changed (review round 4).
 */
export function refundMessage(error, { acted = false } = {}) {
  if (MESSAGES[error?.code]) return MESSAGES[error.code];
  // The answer did not arrive in time: the server may have finished.
  if (acted || error?.phase === "timeout" || error?.phase === "network") return UNCONFIRMED;
  return "The refund could not be started. Nothing was changed. Please try again.";
}
