import { publicLaunchPresentation } from "./publicLaunch.mjs";
const view = publicLaunchPresentation();

// Public policy describes the launch offer. Account labels still depend on
// trusted entitlements; this copy never grants access or starts a trial.
export const MEMBERSHIP_COPY = Object.freeze({
  foundingHeadline: view.publicRateHeadline,
  credentialPrices: `${view.foundingRate} ${view.rateComparison}`,
  rateLock: "The founding and early-bird annual rates stay the same while membership remains continuously active.",
  fullPackage: view.fullPackage,
  practiceTrial: view.practiceTrial,
  lifetimePolicy: view.lifetimeException,
  promisedBeta: view.promisedBeta,
  availability: "Open More > Profile & settings and review your membership offer under Your membership. Founding Credential is $99/year for the first 100 paid founding members. Availability is confirmed before payment; viewing an offer does not reserve a place. Paid membership requires a card at checkout and your explicit agreement. You keep the same account and saved records.",
  refundGuarantee: view.refundGuarantee,
  billingOff: "Billing is off; no payment is collected.",
});
