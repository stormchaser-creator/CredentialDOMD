const amounts = Object.freeze({ founding: 9900, earlybird: 14900, standard: 19900 });

/** Anonymous, read-only, identity-free public projection of the SQL quote policy. */
export function createPublicMembershipOfferHandler({ readOffer, origin = 'https://credentialdomd.com' }) {
  const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin',
    'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type', 'Referrer-Policy': 'no-referrer',
  } });
  return async req => {
    if (req.headers.get('origin') && req.headers.get('origin') !== origin) return reply(403, { error: 'origin_not_allowed' });
    if (req.method === 'OPTIONS') return reply(200, {});
    if (req.method !== 'GET') return reply(405, { error: 'method_not_allowed' });
    try {
      const offer = await readOffer();
      if (offer?.schemaVersion !== 1 || !Object.hasOwn(amounts, offer.phase) || offer.annualCents !== amounts[offer.phase]
        || typeof offer.checkoutEnabled !== 'boolean' || !['available', 'temporarily_full', 'paused'].includes(offer.availability)
        || (offer.availability === 'paused') !== !offer.checkoutEnabled) throw Error('Invalid public policy');
      return reply(200, { schemaVersion: 1, phase: offer.phase, annualCents: offer.annualCents,
        checkoutEnabled: offer.checkoutEnabled, availability: offer.availability });
    } catch { return reply(503, { error: 'membership_offer_unavailable' }); }
  };
}
