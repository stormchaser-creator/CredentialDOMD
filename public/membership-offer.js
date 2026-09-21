// Public presentation only: no account, capacity count, storage, or checkout action.
const PRICES = Object.freeze({ founding: 9900, earlybird: 14900, standard: 19900 });
const FALLBACK = Object.freeze({ action: 'Create your account', reviewAction: 'See membership plans',
  status: 'Your offer is confirmed before payment. Creating an account does not reserve a founding place.',
  headline: 'First 100 paid founding memberships: $99/year', price: '$99', priceLabel: ' / year, founding rate for the first 100 paid members',
  heroHeadline: 'Founding offer: $99/year for the first 100 paid members',
  heroNote: 'The founding annual rate stays locked for life while membership remains active.',
  heading: 'Create your account', phase: 'Membership options' });

export function offerPresentation(value) {
  if (value?.schemaVersion !== 1 || !Object.hasOwn(PRICES, value.phase)
    || value.annualCents !== PRICES[value.phase] || typeof value.checkoutEnabled !== 'boolean'
    || !['available', 'temporarily_full', 'paused'].includes(value.availability)
    || (value.availability === 'paused') !== !value.checkoutEnabled
    || (value.availability === 'temporarily_full' && value.phase !== 'founding')) throw Error('Unavailable');
  const phase = value.phase === 'founding' ? 'Founding' : value.phase === 'earlybird' ? 'Early-bird' : 'Standard';
  const rate = `$${value.annualCents / 100}/year`;
  const status = value.availability === 'paused'
    ? 'Paid checkout is paused. You can create your account now; no payment will be taken.'
    : value.availability === 'temporarily_full'
      ? 'Founding checkout is temporarily unavailable. Creating an account does not reserve a place.'
      : 'Your offer is confirmed before payment. Creating an account does not reserve a founding place.';
  return { action: 'Create your account', reviewAction: value.phase === 'founding' ? 'See the $99 founding plan' : `See the ${rate} plan`, status,
    heroHeadline: `${phase} Credential: ${rate}${value.phase === 'founding' ? ' for the first 100 paid members' : ''}`,
    heroNote: value.phase === 'standard' ? 'One annual membership for your credentials, CME and professional records.' : `Your $${value.annualCents / 100} annual rate stays locked for life while membership remains active.`,
    headline: `${phase} Credential: ${rate}${value.phase === 'founding' ? ' for the first 100 paid founding members' : ''}.`,
    price: `$${value.annualCents / 100}`, priceLabel: ` / year, ${phase.toLowerCase()} Credential`,
    heading: 'Create your account', phase: `${phase} membership` };
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
  const paint = value => {
    for (const [attribute, key] of [['action','action'], ['review-action','reviewAction'], ['hero-headline','heroHeadline'], ['hero-note','heroNote'], ['status','status'], ['headline','headline'], ['price','price'],
      ['price-label','priceLabel'], ['heading','heading'], ['phase','phase']]) {
      for (const node of root.querySelectorAll(`[data-membership-${attribute}]`)) node.textContent = value[key];
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
