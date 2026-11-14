// The two Credential prices on sale (owner decision 2026-11-13). Any other
// phase or amount from the database is refused: no page is ever told $199.
const amounts = Object.freeze({ founding: 9900, earlybird: 14900 });

// How many of the 100 founder places are unpaid, when the database says
// (migration 20261113130000). One aggregate integer, never a row or an
// identity. It must agree with the phase: 1 to 100 while founding is sold,
// 0 once it is not. null or absent (an older database, or a founding program
// that is not prepared) publishes no number.
function founderSpots(offer) {
  const left = offer.founderSpotsLeft;
  if (left === undefined || left === null) return {};
  if (!Number.isInteger(left) || left < 0 || left > 100 || (offer.phase === 'founding') !== (left > 0)) throw Error('Invalid public policy');
  return { founderSpotsLeft: left };
}

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
      return respond(200, { schemaVersion: 1, phase: offer.phase, annualCents: offer.annualCents,
        checkoutEnabled: offer.checkoutEnabled, availability: offer.availability, bundleAvailable: offer.phase !== 'founding',
        ...founderSpots(offer) });
    } catch { return respond(503, { error: 'membership_offer_unavailable' }); }
  };
}
