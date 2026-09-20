/** Public marketing presentation only. This cannot enable billing or grant access. */
export const PUBLIC_LAUNCH_MODE = Object.freeze({
  enabled: true,
  signupHref: '/app/', // Protected verified-primary signup and explicit paid opt-in.
});

// Static generators still own the listed surfaces. Do not enable paid copy while
// one of them still submits a waitlist request under a signup label. Move an ID
// into WIRED_LAUNCH_SURFACES only with its implementation and regression coverage.
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
 */
export function publicLaunchPresentation(mode = PUBLIC_LAUNCH_MODE) {
  if (typeof mode.enabled !== 'boolean') throw new Error('Public launch enabled must be a boolean');
  const enabled = mode.enabled;
  const signupHref = enabled ? reviewedSignupHref(mode.signupHref) : null;
  return Object.freeze({
    brand: 'CredentialDOMD',
    mode: enabled ? 'founding-signup' : 'waitlist',
    primaryAction: Object.freeze(enabled
      ? { kind: 'navigation', label: 'Review membership offers', shortLabel: 'Membership signup', href: signupHref, collectEmail: false }
      : { kind: 'waitlist-request', label: 'Join the waitlist', shortLabel: 'Join the waitlist', href: '/#join', collectEmail: true }),
    availability: enabled
      ? 'Create your account to review the available membership offer. Founding Credential is $99/year for the first 100 paid founding members. Availability is confirmed in the app before payment; creating an account or viewing an offer does not reserve a place. New paid membership requires a card at checkout. Nothing is charged without your agreement.'
      : 'Checkout is not open. Join the waitlist for your invitation and membership details. A waitlist request does not create a paid account or charge you; future paid access requires a card at checkout.',
    earlyRelease: 'CredentialDOMD is an early release. Some workflows are less polished, and the app will continue to evolve.',
    teamAvailability: 'Group-management features are on the roadmap and are not currently available. The individual Practice package does not provide team-wide account management. Contact support@credentialdomd.com to discuss your group’s needs; no release date or priority onboarding is promised.',
    founderParticipation: 'Founding members help shape what comes next. In the app, ask VERA for help and use support tickets to report problems or suggest improvements.',
    foundingRate: enabled
      ? 'Founding Credential is $99/year for the first 100 paid founding members, with that annual rate locked for life while membership remains continuously active. The app confirms your available offer before you choose to pay.'
      : 'The planned founding Credential offer is $99/year for eligible founding members, with that annual rate locked for life while membership remains active.',
    foundingChange: 'The $99/year founding offer replaces the previously planned $149/year founding price; this is not a claim about a previous selling price.',
    rateComparison: enabled
      ? 'After the 100 paid founding memberships, early-bird Credential is $149/year, followed by standard Credential at $199/year.'
      : 'Planned early-bird Credential is $149/year; planned standard Credential is $199/year. These are launch prices, not claims about a previous selling price.',
    earlyBirdRateLock: 'The early-bird annual rate also stays the same while membership remains active.',
    signupHeading: 'Membership signup',
    publicRateHeadline: 'Check the current Credential offer',
    publicPrice: 'Check in app',
    publicPriceLabel: ' / annual Credential membership',
    fullPackage: 'Credential + Practice is $245/year total at first purchase. The full package has no founding or early-bird discount.',
    refundGuarantee: 'No-hassle 100% money-back guarantee: request a full refund of your most recent annual membership payment, including a renewal payment, at any time. There is no request deadline or prorating. This covers your most recent annual payment, not all payments from past years. Request through Get help in the app or support@credentialdomd.com. You do not need to delete your account, saved records or reports to request a refund.',
    promisedBeta: enabled
      ? 'Eligible people who signed up under the earlier free-beta wording receive 30 days free with no card, starting when they first activate their account with a verified email address. The app shows the exact end date; signing in again does not restart those 30 days. You may opt in to $99/year Credential during the beta by adding a card and explicitly agreeing to the annual subscription. Your first charge is scheduled for your original beta end date, when your paid year starts. Choosing early does not charge you early or start a new trial. You keep the same account and saved records. If you never opt in, there is no automatic charge and nothing to cancel. Paid membership renews annually unless canceled.'
      : 'People who signed up under the earlier free-beta wording will receive 30 days free with no card. Their invitation will confirm eligibility and when those 30 days start. Continuing afterward requires an explicit $99/year Credential purchase; there is no automatic charge.',
    lifetimeException: 'Existing accounts eligible under the announced lifetime-access policy keep Credential and Practice free for life. A waitlist entry alone does not qualify for lifetime access. Account eligibility must be confirmed before asking an existing member to pay.',
    practiceTrial: 'New paid Credential members receive a separate 30-day Practice trial when their first annual payment is confirmed. It ends without an added charge. Continuing Practice requires an explicit purchase. Existing Credential members should contact support@credentialdomd.com to review options for adding Practice; no change or charge will occur without their agreement. The paid Credential membership continues, and existing Practice records remain available to read and export.',
    guideCapture: Object.freeze({
      purpose: 'requested-guide',
      submitLabel: 'Email me the guide',
      showWaitlistChoice: !enabled,
      forceGuideOnly: enabled,
      signupIsSeparateNavigation: enabled,
      signupHref,
      note: enabled
        ? 'This form requests one guide. It does not create an account, start a membership or charge you. Membership signup is a separate step.'
        : 'This form requests one guide. Joining the invitation list is a separate, optional choice.',
    }),
  });
}
