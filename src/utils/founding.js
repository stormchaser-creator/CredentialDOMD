/**
 * Founding member helpers. Pure (no React, no Supabase) so the badge label
 * and the profile mapping can be checked from node (scripts/founding.test.mjs).
 *
 * A founding member is either a physician activated before launch (the
 * number Postgres assigned in activation order, migration
 * 20260902g_founding_members.sql) or one who paid for a founding place
 * (profiles.is_founding_member, set from limited_founding_slots by migration
 * 20261114120000). Invites and waitlist rows never carry either.
 */

/** The one emoji for founding members: badge, Settings profile, Admin. */
export const FOUNDING_EMOJI = "\u{1F3C5}"; // 🏅

/**
 * Always "Founding member". The owner decided (2026-11-14) that the badge
 * recognises the member without telling them their number; the argument is
 * kept so existing callers need no change.
 */
export function foundingLabel(_number) {
  return "Founding member";
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
