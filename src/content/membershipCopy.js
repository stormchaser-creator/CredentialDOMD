import { publicLaunchPresentation } from "./publicLaunch.mjs";
const view = publicLaunchPresentation();

// Public policy describes the launch offer. Account labels still depend on
// trusted entitlements; this copy never grants access or starts a trial.
export const MEMBERSHIP_COPY = Object.freeze({
  foundingHeadline: view.publicRateHeadline,
  credentialPrices: `${view.foundingRate} ${view.rateComparison}`,
  foundingChange: view.foundingChange,
  rateLock: "The founding and early-bird annual rates stay the same while membership remains continuously active.",
  fullPackage: view.fullPackage,
  practiceTrial: view.practiceTrial,
  lifetimePolicy: view.lifetimeException,
  promisedBeta: view.promisedBeta,
  availability: view.availability,
  refundGuarantee: view.refundGuarantee,
  billingOff: "Billing is off; no payment is collected.",
});
