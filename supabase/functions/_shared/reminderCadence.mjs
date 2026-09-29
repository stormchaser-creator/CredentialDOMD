// When the daily reminder email (send-reminders) goes out to one recipient.
//
// The server keeps its own state in two columns only it reads and writes
// (migration 20260929140000): reminder_email_fingerprint, the hash of the item
// list it last emailed, and reminder_emailed_at, when it did. Until then it
// shared alerts_fingerprint and last_notified with the in-app banner, which
// stores a different fingerprint format ("soon:travelDocs:2026-11-29|...",
// src/utils/notifications.js) and stamps both on every Snooze, Email or Text
// tap. The two formats never match, so any tap made the next 13:00 UTC run
// see a "changed" list and send, whatever the cadence; the server's hex then
// made the banner drop its snoozed view. Those two columns are the app's again.
//
// The member's banner snooze (profiles.snoozed_until, written by the app) is
// honoured: nothing is sent while it is in the future. The banner snoozes for
// at most the member's own cadence, so quiet never outlasts one period.
//
// The cadence is counted in whole UTC calendar days. The cron fires at 13:00
// UTC every day and the send is stamped after Resend answers, a second or two
// later, so an elapsed-milliseconds test at the next run fell short by that
// much: Daily went out every other day and Weekly every 8 days.
//
// Plain JavaScript so the Deno function and the node tests share one copy.

const DAY_MS = 86400000;

/** The columns send-reminders owns on profiles. The app never reads or writes them. */
export const REMINDER_STATE_COLUMNS = Object.freeze(['reminder_email_fingerprint', 'reminder_emailed_at']);

/** A timestamp (ISO text, Date or ms) as ms, or NaN when blank or unreadable. */
function toMs(value) {
  if (value === null || value === undefined || value === '') return NaN;
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
}

/** Whole UTC calendar days from `from` to `to` (both ms). */
export function utcDaysBetween(from, to) {
  return Math.floor(to / DAY_MS) - Math.floor(from / DAY_MS);
}

/** True while the member's banner snooze (snoozed_until) is in the future. */
export function reminderSnoozed(snoozedUntil, now = Date.now()) {
  const until = toMs(snoozedUntil);
  return Number.isFinite(until) && until > now;
}

/**
 * The fingerprint of an item list: 24 hex characters of SHA-256 over the
 * sorted "id:expiration" pairs. Same value send-reminders always computed.
 */
export async function reminderFingerprint(items) {
  const s = items.map(i => `${i.id}:${i.exp}`).sort().join('|');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Whether send-reminders emails this recipient now.
 *
 * profile: the recipient row (reminder_email_fingerprint, reminder_emailed_at,
 * snoozed_until). fingerprint: this run's reminderFingerprint. freqDays:
 * notifyFreqDays(profile.notify_freq_days). Returns { send, reason }.
 */
export function reminderEmailDecision(profile, { fingerprint, freqDays, now = Date.now() }) {
  if (reminderSnoozed(profile?.snoozed_until, now)) return { send: false, reason: 'snoozed' };
  const last = toMs(profile?.reminder_emailed_at);
  const changed = fingerprint !== (profile?.reminder_email_fingerprint || '');
  if (!Number.isFinite(last)) return { send: true, reason: 'first email' };
  if (changed) return { send: true, reason: 'list changed' };
  if (utcDaysBetween(last, now) >= freqDays) return { send: true, reason: 'due' };
  return { send: false, reason: 'recently notified, unchanged' };
}
