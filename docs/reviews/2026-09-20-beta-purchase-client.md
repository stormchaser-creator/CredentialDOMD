# Optional purchase during the historical beta

## Result

An eligible account can review Credential or Credential + Practice while its protected 30-day beta is active. This stays in the same signed-in account and does not write, copy, reset, or delete its saved records or original beta dates.

The client uses the authenticated server quote to display the exact first-charge and paid-year start date, annual price, required card at optional checkout, and renewal terms. It makes no quote or checkout request automatically. Consent starts unchecked and resets for a new offer. The checkout request still contains only the quote ID, consent hash, and explicit confirmation.

The date promise is “$0 before [exact date]”, with an explanation that Checkout completed after that date collects the annual payment then. An original deferred Checkout can be resumed after beta only when the authoritative response identifies that exact offer as resumable. Its new consent explicitly authorizes payment now for the original paid-year start; it never presents a zero-now promise after beta.

After opt-in, a validated scheduled membership replaces the no-charge beta banner, prevents another purchase, and exposes billing management even if new sales are paused. Pending payment does not grant paid write access. Cancellation before the first charge is distinguished from later renewal cancellation, which does not itself void an unpaid invoice.

The included Credential plan Practice trial begins at the first confirmed annual payment; it does not become paid Practice automatically. Existing lifetime protection and ordinary immediate annual purchases remain unchanged.

The review also displays the owner-approved 100% no-hassle money-back guarantee on the most recent annual membership payment, including renewals, with the existing support request path. It does not claim an automatic refund processor.

## Required server contract

- Quote: `paymentTiming`, `amountDueNowCents`, `betaEndsAt`, `firstChargeAt`, and `paymentAtCheckout`. Deferred dates must match the original protected beta and the next whole Stripe second, preserving PostgreSQL fractional seconds. The browser validates and displays these dates; it never submits a replacement date or price.
- Entitlements: `scheduledMembership` with the offer, annual amount, exact start, status, `cancelAtPeriodEnd`, and `firstChargeCanceled`. Paid access continues to depend on `purchasedOfferId` and server capabilities.
- An expired-beta deferred quote requires `checkoutResumeAvailable` and the matching `checkoutResumeOfferId` from current authority. New checkout cannot be inferred from the old quote.
- Backend ownership checks, protected timing persistence, verified payment settlement, original-anchor billing, and provider cancellation remain server responsibilities.

## Verification and release limits

Synthetic tests exercise the real membership click handlers, rendered consent and notices, cancellation screen, subscription hook, transport validator, timestamp precision, same-account state, stale consent, both offers, and owned expired-beta resume. Existing limited-launch tests cover session replacement, read/export access, protected writes, invitation gating, and persistence.

Focused lint and the production build pass. No provider request, database change, real card, customer submission, email, or activation occurs in this source work. This client must ship with the reviewed backend timing/snapshot changes after the provider integration is verified; a local synthetic pass does not establish Stripe's live behavior.
