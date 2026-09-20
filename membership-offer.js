// Public presentation only: no account, capacity count, storage, or checkout action.
const PRICES = Object.freeze({ founding: 9900, earlybird: 14900, standard: 19900 });
const FALLBACK = Object.freeze({ action: 'Review membership offers', status: 'Check availability in app.',
  headline: 'Check the current Credential offer', price: 'Check in app', priceLabel: ' / annual Credential membership',
  heading: 'Membership signup', phase: 'Membership options' });

export function offerPresentation(value) {
  if (value?.schemaVersion !== 1 || !Object.hasOwn(PRICES, value.phase)
    || value.annualCents !== PRICES[value.phase] || typeof value.checkoutEnabled !== 'boolean'
    || !['available', 'temporarily_full', 'paused'].includes(value.availability)
    || (value.availability === 'paused') !== !value.checkoutEnabled
    || (value.availability === 'temporarily_full' && value.phase !== 'founding')) throw Error('Unavailable');
  if (value.availability === 'paused') return { ...FALLBACK, status: 'Paid checkout is paused. Check availability in app.' };
  if (value.availability === 'temporarily_full') return { ...FALLBACK, status: 'Founding checkout is temporarily unavailable. Check availability in app.' };
  const phase = value.phase === 'founding' ? 'Founding' : value.phase === 'earlybird' ? 'Early-bird' : 'Standard';
  const rate = `$${value.annualCents / 100}/year`;
  return { action: `Review ${rate} offer`, status: `${phase} Credential: ${rate}. Your available offer is confirmed before payment; viewing it does not reserve a place.`,
    headline: `${phase} Credential: ${rate}${value.phase === 'founding' ? ' for the first 100 paid founding members' : ''}.`,
    price: `$${value.annualCents / 100}`, priceLabel: ` / year, ${phase.toLowerCase()} Credential`,
    heading: `${phase} membership signup`, phase: `${phase} membership` };
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
  const paint = value => {
    for (const [attribute, key] of [['action','action'], ['status','status'], ['headline','headline'], ['price','price'],
      ['price-label','priceLabel'], ['heading','heading'], ['phase','phase']]) {
      for (const node of root.querySelectorAll(`[data-membership-${attribute}]`)) node.textContent = value[key];
    }
  };
  return async () => {
    const turn = ++generation;
    paint(FALLBACK);
    try {
      const value = await fetchPublicOffer(endpoint, options);
      if (turn === generation) paint(value);
    } catch { if (turn === generation) paint(FALLBACK); }
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
