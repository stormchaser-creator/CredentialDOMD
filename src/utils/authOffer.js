// The signed-out screen used to show an email box and nothing else, so a physician who
// pressed "Create your account" on the site met no price and no offer. This loads the
// SAME reviewed public module the website uses (/membership-offer.js: strict schema,
// fixed price table, size caps, no redirects) instead of re-implementing it, so the app
// can never state a price the site would refuse. Any failure resolves to null and the
// screen renders exactly as before. Nothing here reads or writes account state.
const OFFER_PATH = "/functions/v1/public-membership-offer";

export async function loadAuthOffer({
  origin = globalThis.location?.origin,
  supabaseUrl,
  importer = href => import(/* @vite-ignore */ href),
  fetchImpl,
} = {}) {
  try {
    if (!origin || !supabaseUrl) return null;
    const mod = await importer(new URL("/membership-offer.js", origin).href);
    // fetchPublicOffer validates the reply and returns the site's own presentation, including
    // its truthful wording when checkout is paused or founding places are temporarily full.
    const view = await mod.fetchPublicOffer(new URL(OFFER_PATH, supabaseUrl).href, fetchImpl ? { fetchImpl } : undefined);
    if (typeof view?.heroHeadline !== "string" || typeof view?.status !== "string") return null;
    return { headline: view.heroHeadline, status: view.status };
  } catch {
    return null;
  }
}
