// Order for the CME provider directory: free first, then the providers that
// cover the physician's unmet topics, then specialty matches.
//
// The rank of "free" is 0, and the old `rank || 5` read 0 as missing, so the
// free providers sorted after every paid one, the reverse of the intent.

const PRICE_ORDER = Object.freeze({ free: 0, freemium: 1, paid: 2, subscription: 3, membership: 4 });
const priceRank = (p) => PRICE_ORDER[p?.pricing] ?? 5;

export function compareProviders(a, b, { unmetTopics = [], specialtyIds = new Set() } = {}) {
  const byPrice = priceRank(a) - priceRank(b);
  if (byPrice !== 0) return byPrice;
  const rel = (p) => (p.topics || []).filter(t => unmetTopics.includes(t)).length;
  if (rel(b) !== rel(a)) return rel(b) - rel(a);
  const spec = (p) => (specialtyIds.has(p.id) ? 0 : 1);
  return spec(a) - spec(b);
}
