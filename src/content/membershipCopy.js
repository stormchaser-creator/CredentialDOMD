import { getPublicBillingOffer } from "../../supabase/functions/_shared/billingCatalog.mjs";

const annual = (id, phase) => `$${getPublicBillingOffer(id, phase).unitAmount / 100}/year`;

// Public policy describes the planned launch. Account labels still depend on
// trusted entitlements; this copy never grants access or starts a trial.
export const MEMBERSHIP_COPY = Object.freeze({
  foundingHeadline: `Founding Credential offer lowered to ${annual("core", "founding")}.`,
  credentialPrices: `Planned Credential pricing is ${annual("core", "founding")} for eligible waitlist founding members, ${annual("core", "earlybird")} for early-bird members, and ${annual("core", "standard")} standard. Your offer and eligibility will be shown before you choose to pay.`,
  foundingChange: "The previously planned founding Credential price was $149/year.",
  rateLock: "The founding and early-bird annual rates stay the same while membership remains active.",
  fullPackage: `Credential + Practice is planned at ${annual("core_locum")} total for all new paid members.`,
  practiceTrial: "Credential customers will receive a free 30-day Practice trial. It ends without a charge. Continuing Practice requires an explicit purchase; your Credential membership continues.",
  lifetimePolicy: "Planned lifetime-access policy: accounts already registered when this policy was announced will keep Credential and Practice free for life. A waitlist entry alone does not qualify. Account eligibility will be confirmed before billing opens.",
  billingOff: "Billing is off; no payment is collected.",
});
