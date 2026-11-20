import { filterAdminUsers, groupAdminAccounts, isFoundingAccount } from './adminData.js';

/**
 * Admin > Home's member counts, from the same profiles list and membership
 * facts (admin_account_memberships) that People > Accounts reads, counted
 * the same way:
 *   paying, free, unpaid: the Accounts groups (groupAdminAccounts) over the
 *     accounts Accounts lists by default (empty account records hidden,
 *     closed accounts in none of the three);
 *   founding: Accounts' "Founding members" (every account not deleted with a
 *     paid founding place or a pre-launch founding badge).
 * Null when the membership facts are not a Map (not deployed yet, or the read
 * failed): without them nobody can be placed in paying or free, and a zero
 * would read as "nobody paid".
 */
export function summarizeMembers(users, memberships, now = Date.now()) {
  if (!Array.isArray(users) || !(memberships instanceof Map)) return null;
  const groups = groupAdminAccounts(filterAdminUsers(users), memberships, now);
  return {
    paying: groups.paying.length,
    founding: users.filter(u => !u.deleted_at && isFoundingAccount(u, memberships.get(u.id))).length,
    free: groups.free.length,
    unpaid: groups.unpaid.length,
  };
}

/**
 * Founder spots left, from the public offer as the homepage's own module
 * presents it (membership-offer.js offerPresentation: "97 spots left at
 * $99/year", only while founding is open and the server sent a whole number
 * from 1 to 100). Null in every other case, so the caller shows "—".
 */
export function founderSpotsFromOffer(view) {
  if (view?.phaseKey !== 'founding' || typeof view.spots !== 'string') return null;
  const match = /^(\d+) spots? left\b/.exec(view.spots);
  const left = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(left) && left >= 1 ? left : null;
}

const OFFER_PATH = '/functions/v1/public-membership-offer';

/**
 * The same public module and endpoint the homepage and sign-in screen use
 * (utils/authOffer.js): /membership-offer.js fetchPublicOffer, with its strict
 * validation. Never founder_spots_left() (service role only). Any failure
 * resolves to null.
 */
export async function loadFounderSpotsLeft({
  origin = globalThis.location?.origin,
  supabaseUrl,
  importer = href => import(/* @vite-ignore */ href),
  fetchImpl,
} = {}) {
  try {
    if (!origin || !supabaseUrl) return null;
    const mod = await importer(new URL('/membership-offer.js', origin).href);
    const view = await mod.fetchPublicOffer(new URL(OFFER_PATH, supabaseUrl).href, fetchImpl ? { fetchImpl } : undefined);
    return founderSpotsFromOffer(view);
  } catch {
    return null;
  }
}
