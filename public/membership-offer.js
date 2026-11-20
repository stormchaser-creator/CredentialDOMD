// Public presentation only: no account, capacity count, storage, or checkout action.
const PRICES = Object.freeze({ founding: 9900, earlybird: 14900, standard: 19900 });
const CONFIRMED = 'The app confirms your available offer before you choose to pay.';
// While founding lasts the site names one plan, the $99 Founder plan, and
// this file prints no later price. A later phase's amount is always built
// from PRICES (the same cents the server's reply is validated against).
const usd = cents => `$${cents / 100}`;
const BUNDLE_CENTS = 24500;
// Every signup link on the site says this, in every phase.
const SIGN_UP = 'Sign up today';
// The Credential card's rate paragraph for each phase. The founding one is the
// page's own static text (publicLaunch foundingRate); a later phase replaces it,
// so a later rate's card never keeps the founding "Practice included" line.
const RATES = Object.freeze({
  founding: `Founding Credential: $99/year while Founder spots last, Practice included while you are a member. That annual rate stays locked for life while membership remains continuously active. ${CONFIRMED}`,
  earlybird: `Early bird Credential: ${usd(PRICES.earlybird)}/year, with one 30 day Practice trial when your first annual payment is confirmed. That annual rate stays locked for life while membership remains continuously active. ${CONFIRMED}`,
  standard: `Standard Credential: ${usd(PRICES.standard)}/year, with one 30 day Practice trial when your first annual payment is confirmed. ${CONFIRMED}`,
});
// The founding offer sentences the static pages print inside a plans
// subtitle, the home FAQ, the membership card and footers (the renderer's
// withLiveOffer marks them). Equal to src/content/publicLaunch.mjs
// FOUNDING_AVAILABILITY and FOUNDING_RATE_LOCK (pinned by a test). A later
// phase states its own rate instead, so no sentence keeps offering $99 once
// the founding places are paid.
const AVAILABILITY = Object.freeze({
  founding: 'Founding Credential is $99/year while Founder spots last.',
  earlybird: `Early bird Credential is ${usd(PRICES.earlybird)}/year.`,
  standard: `Standard Credential is ${usd(PRICES.standard)}/year.`,
});
// Leading space included: the standard rate is not locked, so it has none.
const RATE_LOCKS = Object.freeze({
  founding: ' That founding annual rate stays locked for life while membership remains continuously active.',
  earlybird: ' That early bird annual rate stays locked for life while membership remains continuously active.',
  standard: '',
});
// Founding Credential includes Practice, so while founding lasts the
// Credential + Practice package is a later price, not a plan beside the $99 one.
const BUNDLE_LABELS = Object.freeze({ founding: ' / year, after founding', later: ' / year total' });
const FALLBACK = Object.freeze({ action: SIGN_UP, renewal: null, reviewAction: 'See membership plans',
  status: 'Your offer is confirmed before payment. Your account opens when payment completes, with our 100% money back guarantee.',
  headline: 'Founder plan: $99/year while spots last', price: '$99', priceLabel: ' / year, founding rate while Founder spots last',
  heroHeadline: 'Founding Credential: $99/year while Founder spots last, Practice included while you are a member',
  heroNote: 'The founding annual rate stays locked for life while membership remains active.',
  heading: SIGN_UP, phase: 'Membership options', rateNote: RATES.founding, bundleLabel: BUNDLE_LABELS.founding,
  availabilityOffer: AVAILABILITY.founding, rateLock: RATE_LOCKS.founding, phaseKey: 'founding',
  offerAvailability: 'available', spots: '' });

export function offerPresentation(value) {
  if (value?.schemaVersion !== 1 || !Object.hasOwn(PRICES, value.phase)
    || value.annualCents !== PRICES[value.phase] || typeof value.checkoutEnabled !== 'boolean'
    || !['available', 'temporarily_full', 'paused'].includes(value.availability)
    || (value.availability === 'paused') !== !value.checkoutEnabled
    || (value.availability === 'temporarily_full' && value.phase !== 'founding')
    // Founding Credential includes Practice, so the bundle waits for founding to end.
    || (value.bundleAvailable !== undefined && value.bundleAvailable !== (value.phase !== 'founding'))) throw Error('Unavailable');
  const phase = value.phase === 'founding' ? 'Founding' : value.phase === 'earlybird' ? 'Early bird' : 'Standard';
  const rate = `$${value.annualCents / 100}/year`;
  // Paused: an account made now is held at the pay first gate until checkout
  // reopens, so the status line says that rather than promising an account
  // that opens now.
  const paused = value.availability === 'paused';
  const status = paused
    ? 'Paid checkout is paused, so no payment is taken now. An account you create today opens when checkout reopens and your payment completes.'
    : value.availability === 'temporarily_full'
      ? 'Founding checkout is temporarily unavailable. Creating an account does not reserve a place.'
      : 'Your offer is confirmed before payment. Your account opens when payment completes, with our 100% money back guarantee.';
  // The signup label is the same in every state (owner, 2026-11-16); the
  // status line carries paused and temporarily full. The amount below is the
  // validated annualCents above, never a literal.
  const dollars = `$${value.annualCents / 100}`;
  const open = value.availability === 'available';
  return { action: SIGN_UP,
    // The app's signed-out screen prints this above its email box (it is a
    // line of text there, not a link). Null when nothing can be paid today.
    priceLine: open ? `Join for ${dollars} a year` : null,
    // One line beside the sign up form: the annual amount and that it renews,
    // in the words of the reviewed checkout consent ("due now, then ... each
    // year while this subscription remains active. Cancel before renewal to
    // avoid the next annual charge."). Null when nothing can be paid today.
    renewal: open ? `${dollars} at checkout, then ${dollars} each year while this subscription remains active. Cancel before renewal to avoid the next annual charge.` : null,
    reviewAction: value.phase === 'founding' ? 'See the $99 founding plan' : `See the ${rate} plan`, status,
    heroHeadline: `${phase} Credential: ${rate}${value.phase === 'founding' ? ' while Founder spots last, Practice included while you are a member' : ''}`,
    heroNote: value.phase === 'standard' ? 'One annual membership for your credentials, CME and professional records.' : `Your $${value.annualCents / 100} annual rate stays locked for life while membership remains active.`,
    headline: `${phase} Credential: ${rate}${value.phase === 'founding' ? ' while Founder spots last, Practice included while you are a member' : ''}.`,
    price: `$${value.annualCents / 100}`, priceLabel: ` / year, ${phase.toLowerCase()} Credential`,
    heading: SIGN_UP, phase: `${phase} membership`,
    rateNote: RATES[value.phase], bundleLabel: value.phase === 'founding' ? BUNDLE_LABELS.founding : BUNDLE_LABELS.later,
    availabilityOffer: AVAILABILITY[value.phase], rateLock: RATE_LOCKS[value.phase], phaseKey: value.phase,
    // For the home page (homePresentation below). The count is used only when
    // the server sends a whole number from 1 to 100 while founding is open;
    // a reply without one shows the page's static line instead (20261120150000).
    offerAvailability: value.availability,
    spots: value.phase === 'founding' && open ? founderSpotsText(value.founderSpotsLeft) : '' };
}

// ── The unified home page (landing/index.html, 2026-11-15) ───────────
// The page is printed in the Founder state: one plan, $99/year, and every
// signup link says "Sign up today". It carries none of the data-membership-*
// elements above, so nothing here can put another signup label or a later
// price back while founding lasts. Its own hooks:
//   data-founder-spots    "N spots left at $99/year" with a live count,
//                         otherwise the page's own static line
//   data-founder-only     shown while the validated phase is founding
//   data-after-founders   shown once a validated reply says founding is over,
//                         and filled from that reply (data-home-*), never
//                         from text printed in the page
//   data-home-status      the availability line, in "sign up" wording
const BUNDLE_OFFER = `Credential + Practice is ${usd(BUNDLE_CENTS)}/year total at first purchase, with no early bird discount.`;
const HOME_PAUSED = 'Paid checkout is paused, so no payment is taken now. If you sign up today, your account opens when checkout reopens and your payment completes.';
const HOME_FULL = 'Founder plan checkout is temporarily unavailable. Signing up does not reserve a place.';
// The cap itself is never printed (owner, 2026-11-20): only how many places
// are left at the founding price, e.g. "37 spots left at $99/year".
export const founderSpotsText = left => Number.isInteger(left) && left >= 1 && left <= 100
  ? `${left} ${left === 1 ? 'spot' : 'spots'} left at ${usd(PRICES.founding)}/year` : '';

/** The home page's view of a validated offer, or of FALLBACK when there is none. */
export function homePresentation(view) {
  const founding = view.phaseKey === 'founding';
  const status = view.offerAvailability === 'paused' ? HOME_PAUSED
    : view.offerAvailability === 'temporarily_full' ? HOME_FULL : FALLBACK.status;
  if (founding) return { founding, status, spots: view.spots || '', plan: '', price: '', headline: '', note: '', rate: '', bundle: '' };
  return { founding, status, spots: '', plan: view.phase, price: view.price, headline: view.heroHeadline,
    note: view.heroNote, rate: view.rateNote, bundle: BUNDLE_OFFER };
}

/**
 * The home page's structured data once founding is over: the Founder offer
 * and the cost answer are replaced by the validated plan, always from the
 * page's original text. While founding lasts the text is returned untouched.
 */
export function homeStructuredData(original, view) {
  if (view.phaseKey === 'founding' || !Object.hasOwn(RATES, view.phaseKey)) return original;
  let data;
  try { data = JSON.parse(original); } catch { return original; }
  if (!Array.isArray(data?.['@graph'])) return original;
  for (const node of data['@graph']) {
    if (node?.['@type'] === 'SoftwareApplication' && node.offers?.name === 'Founder plan') {
      node.offers = { ...node.offers, name: view.heroHeadline.split(':')[0], price: view.price.replace('$', ''), description: view.rateNote };
    }
    if (node?.['@type'] === 'FAQPage' && Array.isArray(node.mainEntity)) {
      const cost = node.mainEntity.find(item => item?.name === 'How much does it cost?');
      if (cost?.acceptedAnswer) cost.acceptedAnswer.text = `${view.rateNote} Card required at checkout.`;
    }
  }
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

/**
 * Structured data (JSON-LD) text with every founding offer sentence swapped
 * for the phase's own. Always from the page's original text, so a later
 * phase replaces an earlier one's words too. Unparseable text is left alone.
 */
export function phaseStructuredData(original, value) {
  const phase = Object.hasOwn(AVAILABILITY, value?.phaseKey) ? value.phaseKey : 'founding';
  if (phase === 'founding') return original;
  let data;
  try { data = JSON.parse(original); } catch { return original; }
  const swap = text => text.split(RATES.founding).join(RATES[phase])
    .split(AVAILABILITY.founding).join(AVAILABILITY[phase])
    .split(RATE_LOCKS.founding).join(RATE_LOCKS[phase]);
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
  const staticSpots = new WeakMap();
  const paint = value => {
    for (const [attribute, key] of [['action','action'], ['review-action','reviewAction'], ['hero-headline','heroHeadline'], ['hero-note','heroNote'], ['status','status'], ['headline','headline'], ['price','price'],
      ['price-label','priceLabel'], ['heading','heading'], ['phase','phase'], ['rate','rateNote'], ['bundle-label','bundleLabel'],
      ['availability','availabilityOffer'], ['rate-lock','rateLock']]) {
      for (const node of root.querySelectorAll(`[data-membership-${attribute}]`)) node.textContent = value[key];
    }
    const home = homePresentation(value);
    for (const node of root.querySelectorAll('[data-founder-spots]')) {
      if (!staticSpots.has(node)) staticSpots.set(node, node.textContent);
      node.textContent = home.spots || staticSpots.get(node);
    }
    for (const node of root.querySelectorAll('[data-founder-only]')) node.hidden = !home.founding;
    for (const node of root.querySelectorAll('[data-after-founders]')) node.hidden = home.founding;
    for (const key of ['status', 'plan', 'price', 'headline', 'note', 'rate', 'bundle']) {
      for (const node of root.querySelectorAll(`[data-home-${key}]`)) node.textContent = home[key];
    }
    for (const node of root.querySelectorAll('script[type="application/ld+json"]')) {
      if (!structuredOriginals.has(node)) structuredOriginals.set(node, node.textContent);
      const next = homeStructuredData(phaseStructuredData(structuredOriginals.get(node), value), value);
      if (node.textContent !== next) node.textContent = next;
    }
  };
  return async () => {
    const turn = ++generation;
    // Keep a known later phase on this page; a network failure must not turn
    // an observed later offer back into the initial $99 founding policy.
    const unconfirmed = () => lastValidated ? { ...lastValidated, status: FALLBACK.status, action: FALLBACK.action, offerAvailability: 'available', spots: '' } : FALLBACK;
    paint(unconfirmed());
    try {
      const value = await fetchPublicOffer(endpoint, options);
      if (turn === generation) { lastValidated = value; paint(value); }
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
