/**
 * The return from Stripe Checkout. limited-checkout sends a buyer back to
 * /app/?billing=complete (success_url) or /app/?billing=canceled (cancel_url).
 *
 * "complete" means Stripe finished the Checkout, not that the membership is
 * recorded: the webhook settles it a moment later. The app says so and asks
 * for a fresh membership answer on a short backoff until the answer shows the
 * purchase, then takes the parameter out of the address so a reload or a
 * shared link does not say it again.
 */

// About 53 seconds in all; then the notice offers "Check again".
export const BILLING_RETURN_DELAYS_MS = Object.freeze([1000, 2000, 3000, 5000, 8000, 13000, 21000]);

export const BILLING_RETURN_COPY = Object.freeze({
  confirming: "Payment received. Confirming your membership...",
  // An opt-in during a free beta collects $0 at Checkout; saying "Payment
  // received" would be untrue.
  confirmingDeferred: "Checkout complete. No payment was taken today. Confirming your membership...",
  confirmed: "Your membership is confirmed.",
  delayed: "Confirming your membership is taking longer than usual. Check again in a minute, or contact support@credentialdomd.com.",
  canceled: "Checkout was canceled. Nothing was charged.",
});

/** "complete", "canceled" or null, from a location.search string. */
export function readBillingReturn(search) {
  try {
    const value = new URLSearchParams(typeof search === "string" ? search : "").get("billing");
    return value === "complete" || value === "canceled" ? value : null;
  } catch { return null; }
}

/** The same address without the billing parameter; everything else, the hash included, stays. */
export function withoutBillingReturn({ pathname = "/", search = "", hash = "" } = {}) {
  const params = new URLSearchParams(search);
  params.delete("billing");
  const rest = params.toString();
  return `${pathname}${rest ? `?${rest}` : ""}${hash || ""}`;
}

/** Take the parameter out of the address bar without a navigation. True when it was there. */
export function clearBillingReturn(win = globalThis.window) {
  try {
    const { location, history } = win || {};
    if (!location || !history?.replaceState || !readBillingReturn(location.search)) return false;
    history.replaceState(history.state, "", withoutBillingReturn(location));
    return true;
  } catch { return false; }
}

/** True once a fresh membership answer shows the purchase: paid, or scheduled for the beta's end. */
export function membershipLanded(access) {
  return !!access && access.needsRefresh !== true && (!!access.purchasedOfferId || !!access.scheduledMembership);
}
