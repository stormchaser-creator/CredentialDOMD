import { publicLaunchPresentation } from "./publicLaunch.mjs";
const view = publicLaunchPresentation();

// Public policy describes the launch offer. Account labels still depend on
// trusted entitlements; this copy never grants access or starts a trial.
export const MEMBERSHIP_COPY = Object.freeze({
  foundingHeadline: view.publicRateHeadline,
  credentialPrices: `${view.foundingRate} ${view.rateComparison}`,
  rateLock: "The founding and early bird annual rates stay the same while membership remains continuously active.",
  fullPackage: view.fullPackage,
  // The $245 offer on the membership screen, which shows it only once this
  // account's own offer is no longer founding: no founding sentence here.
  bundleOffer: view.bundleOffer,
  practiceTrial: view.practiceTrial,
  foundingOffer: view.foundingOffer,
  // Shown in place of the $245 offer while this account's offer is founding.
  bundleDuringFounding: "Founding Credential already includes Practice for as long as your membership stays active, so Credential + Practice is not offered separately while founding places remain.",
  // A paid founding member's own membership, on Profile & settings.
  foundingPracticeIncluded: "Practice is included for as long as this membership stays active.",
  lifetimePolicy: view.lifetimeException,
  promisedBeta: view.promisedBeta,
  availability: "Open More > Profile & settings and review your membership offer under Your membership. Founding Credential is $99/year for the first 100 paid founding members. Availability is confirmed before payment; viewing an offer does not reserve a place. Paid membership requires a card at checkout and your explicit agreement. You keep the same account and saved records.",
  refundGuarantee: view.refundGuarantee,
  billingOff: "Billing is off; no payment is collected.",
  // After "Contact support about adding Practice", wherever it is offered
  // (Profile & settings, the app-wide notice, the Practice archive).
  practiceSupportReview: "We will review the options and charges with you before any billing change.",
  // Lifetime access, on the membership card and More > Cancel Subscription.
  lifetimeProtected: "Your lifetime access is protected. No payment is required for those features.",
  // A paid membership whose renewal card was declined (past_due, unpaid).
  renewalPaymentFailed: "Your renewal payment did not go through. Update your card to restore editing. Your saved records stay available to read and export.",
});
