// Pay first (owner decision 2026-09-30: "whats the point of creating an
// account without paying for it"). Signing up and paying are one step: a new
// account goes straight to its current offer's review (the one place the
// offer is confirmed) and on to Stripe Checkout, and nothing in the app is
// usable until the payment is confirmed (the server keeps the account
// 'pending' until then; App.jsx shows only the membership card).

/**
 * Pay first: a signed-up account that has not paid, where the only thing to
 * do is pay. Not a free beta, lifetime access, a scheduled purchase, a
 * manual invitation that activates without payment, or a Checkout that just
 * completed and is being confirmed (still so after its notice is dismissed:
 * useBillingReturn keeps it until the membership shows it).
 */
export function payFirstMode(limitedLaunch, access, invitation) {
  if (!limitedLaunch?.enabled || !limitedLaunch.publicSignupEnabled || access?.accessStatus !== "pending") return false;
  if (access.lifetime?.credential || access.lifetime?.practice || access.scheduledMembership || access.freeBeta?.state === "active") return false;
  if (invitation && access.invitationActivationEnabled === true) return false;
  const back = limitedLaunch.billingReturn;
  return !(back?.kind === "complete" && ["confirming", "delayed"].includes(back.phase));
}
