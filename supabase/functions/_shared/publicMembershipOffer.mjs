const amounts = Object.freeze({ founding: 9900, earlybird: 14900, standard: 19900 });

/** Anonymous, read-only, identity-free public projection of the SQL quote policy. */
export function createPublicMembershipOfferHandler({ readOffer, origin = 'https://credentialdomd.com', origins = [origin] }) {
  const allowedOrigins = new Set(origins);
  const reply = (status, data, responseOrigin = origin) => new Response(JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin',
    'Access-Control-Allow-Origin': responseOrigin, 'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type', 'Referrer-Policy': 'no-referrer',
  } });
  return async req => {
    const requestOrigin = req.headers.get('origin');
    if (requestOrigin && !allowedOrigins.has(requestOrigin)) return reply(403, { error: 'origin_not_allowed' });
    const respond = (status, data) => reply(status, data, requestOrigin || origin);
    if (req.method === 'OPTIONS') return respond(200, {});
    if (req.method !== 'GET') return respond(405, { error: 'method_not_allowed' });
    try {
      const offer = await readOffer();
      if (offer?.schemaVersion !== 1 || !Object.hasOwn(amounts, offer.phase) || offer.annualCents !== amounts[offer.phase]
        || typeof offer.checkoutEnabled !== 'boolean' || !['available', 'temporarily_full', 'paused'].includes(offer.availability)
        || (offer.availability === 'paused') !== !offer.checkoutEnabled
        // Founding Credential includes Practice, so the $245 bundle is not
        // offered to new buyers until founding is sold out or ended.
        || (offer.bundleAvailable !== undefined && offer.bundleAvailable !== (offer.phase !== 'founding'))) throw Error('Invalid public policy');
      // Founder countdown (owner rule 2026-11-16): the database's own number,
      // capacity minus PAID founding places. Leads and accounts never reduce
      // it. Sent only while founding is offered and only as a whole number
      // from 0 to 100; anything else is left out, and the site then shows no
      // count rather than a wrong one. Never computed or defaulted here.
      const spots = offer.phase === 'founding' && Number.isInteger(offer.founderSpotsLeft)
        && offer.founderSpotsLeft >= 0 && offer.founderSpotsLeft <= 100 ? { founderSpotsLeft: offer.founderSpotsLeft } : {};
      return respond(200, { schemaVersion: 1, phase: offer.phase, annualCents: offer.annualCents,
        checkoutEnabled: offer.checkoutEnabled, availability: offer.availability, bundleAvailable: offer.phase !== 'founding', ...spots });
    } catch { return respond(503, { error: 'membership_offer_unavailable' }); }
  };
}
