// Public presentation only: no account, capacity count, storage, or checkout action.
const PRICES = Object.freeze({ founding: 9900, earlybird: 14900, standard: 19900 });
const CONFIRMED = 'The app confirms your available offer before you choose to pay.';
// The Credential card's rate paragraph for each phase. The founding one is the
// page's own static text (publicLaunch foundingRate); a later phase replaces it,
// so a $149 or $199 card never keeps the founding "Practice included" line.
const RATES = Object.freeze({
  founding: `Founding Credential: $99/year for the first 100 paid members, Practice included while you are a member. That annual rate stays locked for life while membership remains continuously active. ${CONFIRMED}`,
  earlybird: `Early bird Credential: $149/year, with one 30 day Practice trial when your first annual payment is confirmed. That annual rate stays locked for life while membership remains continuously active. ${CONFIRMED}`,
  standard: `Standard Credential: $199/year, with one 30 day Practice trial when your first annual payment is confirmed. ${CONFIRMED}`,
});
// The founding offer sentences the static pages print inside a plans
// subtitle, the home FAQ, the membership card and footers (the renderer's
// withLiveOffer marks them). Equal to src/content/publicLaunch.mjs
// FOUNDING_AVAILABILITY and FOUNDING_RATE_LOCK (pinned by a test). A later
// phase states its own rate instead, so no sentence keeps offering $99 once
// the 100 founding places are paid.
const AVAILABILITY = Object.freeze({
  founding: 'Founding Credential is $99/year for the first 100 paid founding members.',
  earlybird: 'Early bird Credential is $149/year.',
  standard: 'Standard Credential is $199/year.',
});
// Leading space included: the standard rate is not locked, so it has none.
const RATE_LOCKS = Object.freeze({
  founding: ' That founding annual rate stays locked for life while membership remains continuously active.',
  earlybird: ' That early bird annual rate stays locked for life while membership remains continuously active.',
  standard: '',
});
// Founding Credential includes Practice, so while founding lasts the $245
// package is a later price, not a plan beside the $99 one.
const BUNDLE_LABELS = Object.freeze({ founding: ' / year, after founding', later: ' / year total' });
const FALLBACK = Object.freeze({ action: 'Create your account', reviewAction: 'See membership plans',
  status: 'Your offer is confirmed before payment. Your account opens when payment completes, with our 100% money back guarantee.',
  headline: 'First 100 paid founding memberships: $99/year', price: '$99', priceLabel: ' / year, founding rate for the first 100 paid members',
  heroHeadline: 'Founding Credential: $99/year for the first 100 paid members, Practice included while you are a member',
  heroNote: 'The founding annual rate stays locked for life while membership remains active.',
  heading: 'Create your account', phase: 'Membership options', rateNote: RATES.founding, bundleLabel: BUNDLE_LABELS.founding,
  availabilityOffer: AVAILABILITY.founding, rateLock: RATE_LOCKS.founding, phaseKey: 'founding' });

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
  const status = value.availability === 'paused'
    ? 'Paid checkout is paused. No payment will be taken; your account opens when payment completes.'
    : value.availability === 'temporarily_full'
      ? 'Founding checkout is temporarily unavailable. Creating an account does not reserve a place.'
      : 'Your offer is confirmed before payment. Your account opens when payment completes, with our 100% money back guarantee.';
  return { action: 'Create your account', reviewAction: value.phase === 'founding' ? 'See the $99 founding plan' : `See the ${rate} plan`, status,
    heroHeadline: `${phase} Credential: ${rate}${value.phase === 'founding' ? ' for the first 100 paid members, Practice included while you are a member' : ''}`,
    heroNote: value.phase === 'standard' ? 'One annual membership for your credentials, CME and professional records.' : `Your $${value.annualCents / 100} annual rate stays locked for life while membership remains active.`,
    headline: `${phase} Credential: ${rate}${value.phase === 'founding' ? ' for the first 100 paid founding members, Practice included while you are a member' : ''}.`,
    price: `$${value.annualCents / 100}`, priceLabel: ` / year, ${phase.toLowerCase()} Credential`,
    heading: 'Create your account', phase: `${phase} membership`,
    rateNote: RATES[value.phase], bundleLabel: value.phase === 'founding' ? BUNDLE_LABELS.founding : BUNDLE_LABELS.later,
    availabilityOffer: AVAILABILITY[value.phase], rateLock: RATE_LOCKS[value.phase], phaseKey: value.phase };
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
  const paint = value => {
    for (const [attribute, key] of [['action','action'], ['review-action','reviewAction'], ['hero-headline','heroHeadline'], ['hero-note','heroNote'], ['status','status'], ['headline','headline'], ['price','price'],
      ['price-label','priceLabel'], ['heading','heading'], ['phase','phase'], ['rate','rateNote'], ['bundle-label','bundleLabel'],
      ['availability','availabilityOffer'], ['rate-lock','rateLock']]) {
      for (const node of root.querySelectorAll(`[data-membership-${attribute}]`)) node.textContent = value[key];
    }
    for (const node of root.querySelectorAll('script[type="application/ld+json"]')) {
      if (!structuredOriginals.has(node)) structuredOriginals.set(node, node.textContent);
      const next = phaseStructuredData(structuredOriginals.get(node), value);
      if (node.textContent !== next) node.textContent = next;
    }
  };
  return async () => {
    const turn = ++generation;
    // Keep a known later phase on this page; a network failure must not turn
    // an observed $149/$199 offer back into the initial $99 founding policy.
    const unconfirmed = () => lastValidated ? { ...lastValidated, status: FALLBACK.status, action: FALLBACK.action } : FALLBACK;
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
  window.addEventListener('pageshow', () => { void refresh(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refresh(); });
  setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 60000);
}
