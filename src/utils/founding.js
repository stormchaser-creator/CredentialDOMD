/**
 * Founding member helpers. Pure (no React, no Supabase) so the badge label
 * and the profile mapping can be checked from node (scripts/founding.test.mjs).
 *
 * A founding member is a physician who signed up and was activated; the
 * number is assigned by Postgres in activation order (migration
 * 20260902g_founding_members.sql) and only ever read here. Invites and
 * waitlist rows never carry a number.
 */

/** The one emoji for founding members: badge, Settings profile, Admin. */
export const FOUNDING_EMOJI = "\u{1F3C5}"; // 🏅

/** "Founding member #7"; "Founding member" when the number is not known. */
export function foundingLabel(number) {
  const n = Number(number);
  return Number.isInteger(n) && n > 0 ? `Founding member #${n}` : "Founding member";
}

/** Emoji plus label, for text-only surfaces (Admin pill, titles). */
export function foundingText(number) {
  return `${FOUNDING_EMOJI} ${foundingLabel(number)}`;
}

/**
 * The read-only founding facts a profiles row contributes to settings.
 * Never written back: neither key is in SETTINGS_TO_PROFILE.
 */
export function foundingFromProfile(row) {
  const out = {};
  if (!row) return out;
  const n = row.founding_number;
  if (Number.isInteger(n) && n > 0) {
    out.foundingNumber = n;
    out.isFoundingMember = true;
  } else if (row.is_founding_member === true) {
    out.isFoundingMember = true;
  }
  return out;
}
