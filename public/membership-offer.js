// Public presentation only: no account, capacity count, storage, or checkout action.
//
// Pricing (owner decision, 2026-11-13): the first 100 paid members are
// founders, $99/year with Practice included. After them Credential is
// $149/year (the server's phase key for it is still 'earlybird') with one
// 30 day Practice trial, and Credential + Practice is $245/year. There is no
// other Credential price: a reply naming any other phase or amount is refused.
const PRICES = Object.freeze({ founding: 9900, earlybird: 14900 });
const CONFIRMED = 'The app confirms your available offer before you choose to pay.';
// The Credential rate paragraph for each phase, as the app states it.
const RATES = Object.freeze({
  founding: `Founding Credential: $99/year for the first 100 paid members, Practice included while you are a member. That annual rate stays locked for life while membership remains continuously active. ${CONFIRMED}`,
  earlybird: `Credential: $149/year, with one 30 day Practice trial when your first annual payment is confirmed. That annual rate stays locked for life while membership remains continuously active. ${CONFIRMED}`,
});
// Equal to src/content/publicLaunch.mjs FOUNDING_AVAILABILITY and
// FOUNDING_RATE_LOCK (pinned by a test).
const AVAILABILITY = Object.freeze({
  founding: 'Founding Credential is $99/year for the first 100 paid founding members.',
  earlybird: 'Credential is $149/year.',
});
// Leading space included, so a sentence can be dropped without a double space.
const RATE_LOCKS = Object.freeze({
  founding: ' That founding annual rate stays locked for life while membership remains continuously active.',
  earlybird: ' That annual rate stays locked for life while membership remains continuously active.',
});
// Founding Credential includes Practice, so while founding lasts the $245
// package is a later price, not a plan beside the $99 one.
const BUNDLE_LABELS = Object.freeze({ founding: ' / year, after founding', later: ' / year total' });
const FALLBACK = Object.freeze({ action: 'Create your account', renewal: null, reviewAction: 'See membership plans',
  status: 'Your offer is confirmed before payment. Your account opens when payment completes, with our 100% money back guarantee.',
  headline: 'First 100 paid founding memberships: $99/year', price: '$99', priceLabel: ' / year, founding rate for the first 100 paid members',
  heroHeadline: 'Founding Credential: $99/year for the first 100 paid members, Practice included while you are a member',
  heroNote: 'The founding annual rate stays locked for life while membership remains active.',
  heading: 'Create your account', phase: 'Membership options', rateNote: RATES.founding, bundleLabel: BUNDLE_LABELS.founding,
  availabilityOffer: AVAILABILITY.founding, rateLock: RATE_LOCKS.founding, phaseKey: 'founding' });

/** The app's view of a validated offer (the sign up screen reads it: src/utils/authOffer.js). */
export function offerPresentation(value) {
  if (value?.schemaVersion !== 1 || !Object.hasOwn(PRICES, value.phase)
    || value.annualCents !== PRICES[value.phase] || typeof value.checkoutEnabled !== 'boolean'
    || !['available', 'temporarily_full', 'paused'].includes(value.availability)
    || (value.availability === 'paused') !== !value.checkoutEnabled
    || (value.availability === 'temporarily_full' && value.phase !== 'founding')
    // Founding Credential includes Practice, so the bundle waits for founding to end.
    || (value.bundleAvailable !== undefined && value.bundleAvailable !== (value.phase !== 'founding'))) throw Error('Unavailable');
  // Founder places left out of 100, when the server says: 1 to 100 while
  // founding is sold, 0 once it is not. Anything else is not believed.
  const left = value.founderSpotsLeft;
  if (left !== undefined && left !== null && (!Number.isInteger(left) || left < 0 || left > 100 || (value.phase === 'founding') !== (left > 0))) throw Error('Unavailable');
  const founding = value.phase === 'founding';
  const name = founding ? 'Founding Credential' : 'Credential';
  const rate = `$${value.annualCents / 100}/year`;
  // Paused: an account made now is held at the pay first gate until checkout
  // reopens, so the line and the button say that rather than promising an
  // account that opens now.
  const paused = value.availability === 'paused';
  const status = paused
    ? 'Paid checkout is paused, so no payment is taken now. An account you create today opens when checkout reopens and your payment completes.'
    : value.availability === 'temporarily_full'
      ? 'Founding checkout is temporarily unavailable. Creating an account does not reserve a place.'
      : 'Your offer is confirmed before payment. Your account opens when payment completes, with our 100% money back guarantee.';
  // The app's signup button says the live annual price while it can be bought
  // now (funnel 2026-10-14). Paused and temporarily full keep their own words:
  // no price can be paid today. The amount is the validated annualCents above,
  // never a literal.
  const dollars = `$${value.annualCents / 100}`;
  const open = value.availability === 'available';
  return { action: paused ? 'Create your account for later' : open ? `Join for ${dollars} a year` : 'Create your account',
    // One line beside the sign up form: the annual amount and that it renews,
    // in the words of the reviewed checkout consent ("due now, then ... each
    // year while this subscription remains active. Cancel before renewal to
    // avoid the next annual charge."). Null when nothing can be paid today.
    renewal: open ? `${dollars} at checkout, then ${dollars} each year while this subscription remains active. Cancel before renewal to avoid the next annual charge.` : null,
    reviewAction: founding ? 'See the $99 founding plan' : `See the ${rate} plan`, status,
    heroHeadline: `${name}: ${rate}${founding ? ' for the first 100 paid members, Practice included while you are a member' : ''}`,
    heroNote: `Your ${dollars} annual rate stays locked for life while membership remains active.`,
    headline: `${name}: ${rate}${founding ? ' for the first 100 paid founding members, Practice included while you are a member' : ''}.`,
    price: dollars, priceLabel: founding ? ' / year, founding Credential' : ' / year, Credential',
    heading: 'Create your account', phase: founding ? 'Founding membership' : 'Credential membership',
    rateNote: RATES[value.phase], bundleLabel: founding ? BUNDLE_LABELS.founding : BUNDLE_LABELS.later,
    availabilityOffer: AVAILABILITY[value.phase], rateLock: RATE_LOCKS[value.phase], phaseKey: value.phase,
    offerAvailability: value.availability, spotsLeft: founding && Number.isInteger(left) ? left : null };
}

// ── What the public site paints ──────────────────────────────────────
// Owner decisions, 2026-11-13. While founder places remain the site shows ONE
// plan, the Founder plan: $99/year with everything included. Once the server
// reports the founders are sold out (phase 'earlybird') the site shows TWO
// cards instead: Credential, $149/year, and Credential + Practice, $245/year,
// with the 30 day Practice trial. The page carries both layouts: elements
// marked data-founder-only show while founding lasts and elements marked
// data-after-founders show afterwards; paint() switches them. With no answer
// (no script, no network, a refused reply) the page stays as printed: the
// Founder plan. No state shows any other price.
// The Founder sentences equal scripts/public-launch-render.mjs FOUNDER_PLAN
// and the later ones its AFTER_FOUNDERS (pinned by tests/site-founder-plan.test.mjs).
const FOUNDER = Object.freeze({
  headline: 'Founder plan: $99/year, everything included',
  offer: 'The Founder plan is $99/year and includes everything: credential tracking and the Practice tools.',
  rateLock: ' That annual rate stays locked for life while membership remains continuously active.',
  rate: `One plan with everything included, for the first 100 paid members. That annual rate stays locked for life while membership remains continuously active. The app confirms your offer before you choose to pay.`,
  heroNote: 'The annual rate stays locked for life while membership remains active.',
});
const AFTER = Object.freeze({
  headline: 'Credential: $149/year. Credential + Practice: $245/year',
  heroNote: 'The 100 Founder places are taken. Credential includes a 30 day Practice trial.',
  offer: 'Credential is $149/year with a 30 day Practice trial, and Credential + Practice is $245/year.',
  rateLock: ' The $149 Credential rate stays locked for life while membership remains continuously active.',
  rate: 'Credential is $149/year with one 30 day Practice trial when your first annual payment is confirmed. Credential + Practice is $245/year. The app confirms your offer before you choose to pay.',
});
// Every signup button on the site says "Sign up today" (owner decision
// 2026-11-13) in every state; the price is on the plan card, not the button.
// The app's sign up screen still reads the priced label from offerPresentation.
const SIGN_UP = 'Sign up today';
const PAUSED_STATUS = 'Paid checkout is paused, so no payment is taken now. If you sign up today, your account opens when checkout reopens and your payment completes.';
const SITE_FALLBACK = Object.freeze({ action: SIGN_UP, reviewAction: 'See the Founder plan',
  status: FALLBACK.status, headline: FOUNDER.headline, price: '$99', priceLabel: ' / year',
  heroHeadline: FOUNDER.headline, heroNote: FOUNDER.heroNote, heading: SIGN_UP, phase: 'Founder plan',
  rateNote: FOUNDER.rate, availabilityOffer: FOUNDER.offer, rateLock: FOUNDER.rateLock, phaseKey: 'founding',
  // The founder countdown is never printed or guessed: no number without a live answer.
  spots: '' });
/** "N of 100 founder spots left", from the server's count of paid founder places. */
export const founderSpotsText = left => Number.isInteger(left) && left >= 1 && left <= 100 ? `${left} of 100 founder spots left` : '';

/** The site's view of a validated offer (the value offerPresentation returned). */
export function sitePresentation(view) {
  if (!view || !Object.hasOwn(PRICES, view.phaseKey) || typeof view.status !== 'string' || typeof view.action !== 'string') throw Error('Unavailable');
  const paused = view.offerAvailability === 'paused';
  if (view.phaseKey === 'founding') {
    return { ...SITE_FALLBACK,
      // Not while every remaining place is held by an open checkout: "N left"
      // beside "temporarily unavailable" would read as a contradiction.
      spots: view.offerAvailability === 'temporarily_full' ? '' : founderSpotsText(view.spotsLeft),
      status: view.offerAvailability === 'temporarily_full'
        ? 'Founder plan checkout is temporarily unavailable. Signing up does not reserve a place.' : paused ? PAUSED_STATUS : view.status };
  }
  return { action: SIGN_UP, reviewAction: 'See membership plans',
    status: paused ? PAUSED_STATUS : view.status, headline: AFTER.headline, price: '$149', priceLabel: ' / year',
    heroHeadline: AFTER.headline, heroNote: AFTER.heroNote, heading: SIGN_UP, phase: 'Membership',
    rateNote: AFTER.rate, availabilityOffer: AFTER.offer, rateLock: AFTER.rateLock, phaseKey: 'soldout', spots: '' };
}

/**
 * Structured data (JSON-LD) text for the site view. While the Founder plan is
 * on sale the page's own text stands. After the founders, every Founder
 * offer sentence is swapped for the two-plan one, always from the page's
 * original text. Unparseable text is left alone.
 */
export function phaseStructuredData(original, value) {
  if (value?.phaseKey !== 'soldout') return original;
  let data;
  try { data = JSON.parse(original); } catch { return original; }
  const swap = text => text.split(FOUNDER.rate).join(AFTER.rate)
    .split(FOUNDER.offer).join(AFTER.offer)
    .split(FOUNDER.rateLock).join(AFTER.rateLock);
  const walk = node => typeof node === 'string' ? swap(node)
    : Array.isArray(node) ? node.map(walk)
      : node && typeof node === 'object' ? Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)])) : node;
  return JSON.stringify(walk(data)).replace(/</g, '\\u003c');
}

export async function fetchPublicOffer(endpoint, { fetchImpl = globalThis.fetch, timeoutMs = 6000 } = {}) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || !/^[a-z0-9]+\.supabase\.co$/.test(url.hostname)
    || url.port || url.username || url.password || url.search || url.hash
    || url.pathname !== '/functions/v1/public-membership-offer') throw Error('Unavailable');
  const controller = new AbortController();
  let timer, reader;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(Error('Unavailable')); }, timeoutMs);
  });
  try {
    return await Promise.race([timeout, (async () => {
      const response = await fetchImpl(url.href, { method: 'GET', headers: { Accept: 'application/json' },
        credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw Error('Unavailable'); }
      if (!response.ok || !/^application\/json\b/i.test(response.headers.get('content-type') || '')
        || Number(response.headers.get('content-length')) > 2048 || !response.body) throw Error('Unavailable');
      reader = response.body.getReader();
      const chunks = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) throw Error('Unavailable');
        if (done) break;
        size += value.byteLength;
        if (size > 2048) throw Error('Unavailable');
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return offerPresentation(JSON.parse(new TextDecoder().decode(bytes)));
    })()]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    try { reader?.cancel().catch(() => {}); } catch { /* no data or identifiers are logged */ }
  }
}

export function createOfferUpdater(root, endpoint, options) {
  let generation = 0;
  let lastValidated = null;
  const structuredOriginals = new WeakMap();
  const paint = value => {
    for (const [attribute, key] of [['action','action'], ['review-action','reviewAction'], ['hero-headline','heroHeadline'], ['hero-note','heroNote'], ['status','status'], ['headline','headline'], ['price','price'],
      ['price-label','priceLabel'], ['heading','heading'], ['phase','phase'], ['rate','rateNote'],
      ['availability','availabilityOffer'], ['rate-lock','rateLock']]) {
      for (const node of root.querySelectorAll(`[data-membership-${attribute}]`)) node.textContent = value[key];
    }
    // The founder countdown: shown only with a number the server just gave.
    for (const node of root.querySelectorAll('[data-membership-spots]')) { node.textContent = value.spots || ''; node.hidden = !value.spots; }
    // The two layouts the page carries: the Founder card and its wording while
    // founding lasts, the two plan cards once the founders are sold out.
    const founding = value.phaseKey === 'founding';
    for (const node of root.querySelectorAll('[data-founder-only]')) node.hidden = !founding;
    for (const node of root.querySelectorAll('[data-after-founders]')) node.hidden = founding;
    for (const node of root.querySelectorAll('script[type="application/ld+json"]')) {
      if (!structuredOriginals.has(node)) structuredOriginals.set(node, node.textContent);
      const next = phaseStructuredData(structuredOriginals.get(node), value);
      if (node.textContent !== next) node.textContent = next;
    }
  };
  return async () => {
    const turn = ++generation;
    // Keep a known sold-out state on this page; a network failure must not turn
    // an observed later phase back into the $99 Founder offer.
    // An unconfirmed view never keeps a count: an old number may be wrong.
    const unconfirmed = () => !lastValidated ? SITE_FALLBACK
      : { ...lastValidated, spots: '', action: SITE_FALLBACK.action, status: lastValidated.phaseKey === 'founding' ? SITE_FALLBACK.status : lastValidated.status };
    paint(unconfirmed());
    try {
      const value = await fetchPublicOffer(endpoint, options);
      const site = sitePresentation(value);
      if (turn === generation) { lastValidated = site; paint(site); }
    } catch { if (turn === generation) paint(unconfirmed()); }
  };
}

if (typeof document !== 'undefined') {
  const endpoint = document.querySelector('script[data-membership-endpoint]')?.dataset.membershipEndpoint;
  const refresh = createOfferUpdater(document, endpoint);
  void refresh();
  // Recheck long-lived and back-forward-cache pages without caching a public price.
  // pageshow also fires on every first load (persisted false), right after the
  // refresh above, so only a page restored from the back forward cache asks again.
  // Without this check every view sent two requests and cold started two workers.
  window.addEventListener('pageshow', event => { if (event.persisted) void refresh(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refresh(); });
  setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 60000);
}
