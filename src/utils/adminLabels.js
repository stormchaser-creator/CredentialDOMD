/**
 * Labels the admin screens print for rows written by machines.
 *
 * Pure, so scripts/admin-labels.test.mjs can check them under plain node.
 */

// send-guide writes `note` as "guide-email CA inline": a log line naming the
// state and which form on the page was used. Useful in the table, unreadable
// on a card next to somebody's email address.
const STATE_IN_NOTE = /\bguide-email\s+([A-Z]{2})\b/;

export function leadNoteLabel(note) {
  const raw = String(note || "").trim();
  if (!raw) return "";
  const m = raw.match(STATE_IN_NOTE);
  if (m) return `${m[1]} guide`;
  return raw.length > 28 ? `${raw.slice(0, 27)}…` : raw;
}
