/** Public marketing presentation only. This cannot enable billing or grant access. */
export const PUBLIC_LAUNCH_MODE = Object.freeze({
  enabled: false,
  signupHref: null, // Set only after the real signup/checkout route is reviewed.
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
      ? { kind: 'navigation', label: 'Sign up: Credential $149/year', shortLabel: 'Sign up · $149/year', href: signupHref, collectEmail: false }
      : { kind: 'waitlist-request', label: 'Join the waitlist', shortLabel: 'Join the waitlist', href: '/#join', collectEmail: true }),
    availability: enabled
      ? 'Early-bird signup is open. New members can choose Credential for $149/year, with that annual rate locked while membership remains active. Paid membership requires a card at checkout. Review your offer before choosing to pay.'
      : 'Checkout is not open. Join the waitlist for your invitation and membership details. A waitlist request does not create a paid account or charge you; future paid access requires a card at checkout.',
    earlyRelease: 'CredentialDOMD is an early release. Some workflows are less polished, and the app will continue to evolve.',
    founderParticipation: 'Founding members help shape what comes next. In the app, ask VERA for help and use support tickets to report problems or suggest improvements.',
    foundingRate: enabled
      ? 'The $99/year founding Credential offer is reserved for eligible earlier waitlist members and individually confirmed founding members, with that annual rate locked for life while their membership remains active.'
      : 'The planned founding Credential offer is $99/year for eligible founding members, with that annual rate locked for life while membership remains active.',
    rateComparison: enabled
      ? 'The founding offer applies to Credential. Early-bird Credential is $149/year; standard Credential is $199/year.'
      : 'Planned early-bird Credential is $149/year; planned standard Credential is $199/year. These are launch prices, not claims about a previous selling price.',
    earlyBirdRateLock: 'The early-bird annual rate also stays the same while membership remains active.',
    signupHeading: 'Early-bird signup',
    publicRateHeadline: 'Early-bird Credential: $149/year, locked while membership remains active.',
    publicPrice: '$149',
    publicPriceLabel: ' / year, early-bird Credential',
    fullPackage: 'Credential + Practice is $245/year total. The full package has no founding or early-bird discount.',
    promisedBeta: enabled
      ? 'Eligible people who signed up under the earlier free-beta wording receive 30 days free with no card, starting when they first activate their account with a verified email address. The app shows the exact end date; signing in again does not restart those 30 days. Continuing afterward requires an explicit $99/year Credential purchase; there is no automatic charge.'
      : 'People who signed up under the earlier free-beta wording will receive 30 days free with no card. Their invitation will confirm eligibility and when those 30 days start. Continuing afterward requires an explicit $99/year Credential purchase; there is no automatic charge.',
    lifetimeException: 'Existing accounts eligible under the announced lifetime-access policy keep Credential and Practice free for life. A waitlist entry alone does not qualify for lifetime access. Account eligibility must be confirmed before asking an existing member to pay.',
    practiceTrial: 'New paid Credential members receive a separate 30-day Practice trial. It ends without an added charge. Continuing Practice requires an explicit purchase; the paid Credential membership continues.',
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
