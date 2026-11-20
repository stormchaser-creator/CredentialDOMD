/** Public marketing presentation only. This cannot enable billing or grant access. */
export const PUBLIC_LAUNCH_MODE = Object.freeze({
  enabled: true,
  signupHref: '/app/', // Protected verified-primary signup and explicit paid opt-in.
});

// Static generators still own the listed surfaces. Move an ID into
// WIRED_LAUNCH_SURFACES only with its implementation and regression coverage.
// (The waitlist these once guarded against was retired 2026-11-20.)
export const REQUIRED_LAUNCH_SURFACES = Object.freeze([
  'home', 'locums', 'help', 'cme', 'state-guides', 'state-index',
  'guide-widgets', 'watch-pages', 'legal-navigation',
]);
export const WIRED_LAUNCH_SURFACES = Object.freeze([
  'home', 'locums', 'help', 'cme', 'state-guides', 'state-index',
  'guide-widgets', 'watch-pages', 'legal-navigation',
]);

const SITE_ORIGIN = 'https://credentialdomd.com';

function reviewedSignupHref(value) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new Error('Paid launch requires a reviewed signup destination');
  }
  const url = new URL(value, SITE_ORIGIN);
  if (url.origin !== SITE_ORIGIN || url.username || url.password
    || !['/app/', '/signup/', '/join/'].some(route => url.pathname === route || url.pathname === route.slice(0, -1))
    || url.search || url.hash) {
    throw new Error('Signup destination must be a reviewed same-site app/signup route without query data or fragments');
  }
  return url.pathname;
}

/** A build refuses an accidental partial launch before touching packaged output. */
export function assertPublicLaunchReady(mode = PUBLIC_LAUNCH_MODE, wired = WIRED_LAUNCH_SURFACES) {
  if (typeof mode.enabled !== 'boolean') throw new Error('Public launch enabled must be a boolean');
  if (!mode.enabled) return;
  reviewedSignupHref(mode.signupHref);
  const missing = REQUIRED_LAUNCH_SURFACES.filter(id => !wired.includes(id));
  if (missing.length) throw new Error(`Public paid launch is not wired across: ${missing.join(', ')}`);
}

/**
 * Pure presentation contract for the static generators. A caller may render a
 * draft paid preview without satisfying the production build gate; it cannot
 * issue a request, record consent, send mail, open checkout, or change access.
 * OFF (`enabled: false`) prints every page exactly as written and has no
 * primary action: there is no waitlist to send anyone to (retired 2026-11-20).
 */
// The one sentence of `availability` that states the founding offer, and the
// rate-lock sentence the home FAQ adds after it. The static pages print them
// as written; public/membership-offer.js swaps each for the live phase's
// (its FOUNDING_AVAILABILITY and FOUNDING_RATE_LOCK, pinned equal by
// tests/public-offer-availability.test.mjs), so a page past the founding cap
// no longer offers $99 in a sentence the hero repaint does not reach.
export const FOUNDING_AVAILABILITY = 'Founding Credential is $99/year while Founder spots last.';
export const FOUNDING_RATE_LOCK = 'That founding annual rate stays locked for life while membership remains continuously active.';
// Practice under the Founder plan. The public site prints this sentence alone
// while founding lasts (owner, 2026-11-16: the $99 Founder plan is the only
// plan the site names); the app and the Terms add the later members' trial.
export const FOUNDING_PRACTICE = 'Founding Credential members have Practice included for as long as their membership stays active.';

export function publicLaunchPresentation(mode = PUBLIC_LAUNCH_MODE) {
  if (typeof mode.enabled !== 'boolean') throw new Error('Public launch enabled must be a boolean');
  const enabled = mode.enabled;
  const signupHref = enabled ? reviewedSignupHref(mode.signupHref) : null;
  return Object.freeze({
    brand: 'CredentialDOMD',
    mode: enabled ? 'founding-signup' : 'off',
    primaryAction: enabled
      ? Object.freeze({ kind: 'navigation', label: 'Sign up today', shortLabel: 'Sign up', href: signupHref, collectEmail: false })
      : null,
    availability: enabled
      ? `${FOUNDING_AVAILABILITY} Availability is confirmed before payment; signing up does not reserve a place. Paid membership requires a card at checkout and your explicit agreement.`
      : 'Checkout is not open. Future paid access requires a card at checkout.',
    earlyRelease: 'CredentialDOMD is an early release. Some workflows are less polished, and the app will continue to evolve.',
    teamAvailability: 'Group-management features are on the roadmap and are not currently available. The individual Practice package does not provide team-wide account management. Contact support@credentialdomd.com to discuss your group’s needs; no release date or priority onboarding is promised.',
    founderParticipation: 'Founding members help shape what comes next. In the app, ask VERA for help and use support tickets to report problems or suggest improvements.',
    // Owner decision, 2026-09-28: founding members keep Practice while they are members.
    foundingOffer: 'Founding Credential: $99/year while Founder spots last, Practice included while you are a member',
    foundingRate: enabled
      ? 'Founding Credential: $99/year while Founder spots last, Practice included while you are a member. That annual rate stays locked for life while membership remains continuously active. The app confirms your available offer before you choose to pay.'
      : 'The planned founding Credential offer is $99/year for eligible founding members, with that annual rate locked for life while membership remains active.',
    // No later price is printed while founding lasts (owner, 2026-11-16). A
    // later phase states its own rate from the live offer (public/membership-offer.js).
    rateComparison: enabled
      ? ''
      : 'Planned early-bird Credential is $149/year; planned standard Credential is $199/year. These are launch prices, not claims about a previous selling price.',
    earlyBirdRateLock: 'The early bird annual rate also stays the same while membership remains active.',
    signupHeading: 'Sign up today',
    publicRateHeadline: 'Founder plan: $99/year while spots last',
    publicPrice: '$99',
    publicPriceLabel: ' / year, founding rate while Founder spots last',
    // The $245 package as sold once a buyer's offer is no longer founding.
    bundleOffer: 'Credential + Practice is $245/year total at first purchase, with no early bird discount.',
    // Every buyer whose offer is founding gets Practice in the $99 Credential,
    // so the package is not sold to them (20260928190000, all origins).
    fullPackage: 'Credential + Practice is $245/year total at first purchase, with no early bird discount. It is not offered to founding buyers, because founding Credential at $99/year already includes Practice while you are a member.',
    refundGuarantee: 'No-hassle 100% money-back guarantee: request a full refund of your most recent annual membership payment, including a renewal payment, at any time. There is no request deadline or prorating. This covers your most recent annual payment, not all payments from past years. Request through Get help in the app or support@credentialdomd.com. You do not need to delete your account, saved records or reports to request a refund.',
    promisedBeta: enabled
      ? 'Eligible people who signed up under the earlier free-beta wording receive 30 days free with no card, starting when they first activate their account with a verified email address. The app shows the exact end date; signing in again does not restart those 30 days. You may opt in to $99/year Credential during the beta by adding a card and explicitly agreeing to the annual subscription. Your first charge is scheduled for your original beta end date, when your paid year starts. Choosing early does not charge you early or start a new trial. You keep the same account and saved records. If you never opt in, there is no automatic charge and nothing to cancel. Paid membership renews annually unless canceled.'
      : 'People who signed up under the earlier free-beta wording will receive 30 days free with no card. Their invitation will confirm eligibility and when those 30 days start. Continuing afterward requires an explicit $99/year Credential purchase; there is no automatic charge.',
    lifetimeException: 'Members whose accounts were already active before paid membership launched, and accounts the founder has personally gifted, keep Credential and Practice free for life. Requesting a guide or giving an email address for a resource, or an account that was created but never active before launch, does not qualify. People who signed up under the earlier no-card wording get 30 days free with no card, starting at first sign-in, and then choose whether to pay. There is no automatic charge.',
    foundingPractice: FOUNDING_PRACTICE,
    practiceTrial: `${FOUNDING_PRACTICE} Early bird and standard Credential members receive a separate 30 day Practice trial when their first annual payment is confirmed. It ends without an added charge, and continuing Practice requires an explicit purchase. Early bird and standard members who want Practice after the trial can contact support@credentialdomd.com to review options; no change or charge will occur without their agreement. The paid Credential membership continues, and existing Practice records remain available to read and export.`,
    // A guide form only ever requests a guide (guide_request, 20261120220000).
    guideCapture: Object.freeze({
      purpose: 'requested-guide',
      submitLabel: 'Email me the guide',
      signupIsSeparateNavigation: enabled,
      signupHref,
      note: enabled
        ? 'This form requests one guide. It does not create an account, start a membership or charge you. Membership signup is a separate step.'
        : 'This form requests one guide. It does not create an account, start a membership or charge you.',
    }),
  });
}
