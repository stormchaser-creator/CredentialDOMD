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
// The member's banner snooze (profiles.snoozed_until, written by the app) holds
// the email while it is in the future, with one exception: an item the member
// has been told about neither by the last email nor by the banner they
// snoozed (an acknowledgement lapsed, a record came into the lead window, a
// date moved nearer). That item is sent. The snooze can run a whole Monthly
// period, so holding a new item behind it let a DEA due in 6 days lapse with
// no email. An item that only left the list (an expired record ageing past
// the query's 30 day back window, which the banner still lists) or moved
// later (a renewal) wakes nothing. A member the server has never emailed has
// no list to compare, so the snooze holds their first email.
//
// What the member saw is read, never written: alerts_fingerprint, which the
// app stamps with snoozed_until on every Snooze tap ("exp:licenses:2026-09-05|
// soon:travelDocs:2026-11-29|...", src/utils/notifications.js). It names a
// section and a date, one part per item, never the record. So the banner
// accounts for as many items with a given section and date as it has parts
// for them, less the ones the last email already told; any more than that
// (a second record with the same date, its acknowledgement lapsed) is new.
//
// An item stops counting as told once it leaves a run's list (acknowledged,
// moved out of the window): every run that does not send keeps only the
// items still listed (reminderToldStill), with the stored hash and
// reminder_emailed_at left as they were. So when it returns under the same
// snooze (the acknowledgement lapsed) it is new, although the whole list now
// hashes to what the last email held. Without a snooze the same item is a
// changed list and is sent, whatever the cadence: a nothing-due run narrows
// too, and a Monthly member's DEA acknowledged that day would otherwise come
// back unannounced until the next monthly email. A run that could not read
// every table narrows nothing (send-reminders), since a missing table's
// items are not gone.
//
// The stored fingerprint is "<24 hex>;<item>,<item>...": the 24-hex hash of
// the sorted "id:expiration" pairs (the value send-reminders always stored),
// then one "<12 hex of the id's SHA-256>:<app section>:<expiration>" per
// item, so a run can tell a new item from one that left. "Changed" is a
// different hash, or (both lists itemised) an item the told list lacks. A row stamped before the
// items were kept holds the bare hash; its "changed" reads exactly as before.
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
 * The app's section name for each table send-reminders reads
 * (src/lib/supabase.js TABLE_MAP), as the banner's fingerprint names it.
 */
export const APP_SECTIONS = Object.freeze({
  licenses: 'licenses', privileges: 'privileges', insurance: 'insurance', health_records: 'healthRecords',
  screenings: 'screenings', professional_memberships: 'memberships', travel_docs: 'travelDocs', custom_records: 'customRecords',
});

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The fingerprint of an item list ({ id, exp, table }): the 24-hex hash of the
 * sorted "id:expiration" pairs, then the per-item list (see the header). An
 * empty list is "<hash>;", a list known to hold nothing.
 */
export async function reminderFingerprint(items) {
  const hash = (await sha256Hex(items.map(i => `${i.id}:${i.exp}`).sort().join('|'))).slice(0, 24);
  const list = await Promise.all(items.map(async i =>
    `${(await sha256Hex(String(i.id))).slice(0, 12)}:${APP_SECTIONS[i.table] || i.table || ''}:${i.exp}`));
  return `${hash};${list.sort().join(',')}`;
}

/** A stored or computed fingerprint as { hash, items }; items is null when it holds the hash alone. */
function readFingerprint(value) {
  const s = String(value || '');
  const cut = s.indexOf(';');
  if (cut < 0) return { hash: s, items: null };
  const items = s.slice(cut + 1).split(',').filter(Boolean).map(t => {
    const [id, sec, exp] = t.split(':');
    return { id, sec, exp, token: t };
  });
  return { hash: s.slice(0, cut), items };
}

/** How many expired or due parts the banner's fingerprint holds for each "section:date". */
function bannerCounts(alertsFingerprint) {
  const counts = new Map();
  for (const part of String(alertsFingerprint || '').split('|')) {
    const [kind, sec, date] = part.split(':');
    if ((kind === 'exp' || kind === 'soon') && sec && date) counts.set(`${sec}:${date}`, (counts.get(`${sec}:${date}`) || 0) + 1);
  }
  return counts;
}

/**
 * Whether this run's list holds an item the stored told items do not (by
 * record), or one due sooner than they said. With the told items as the last
 * email stored them this is never true while the hash is unchanged (the same
 * "id:expiration" pairs); it is true once a held run has narrowed them
 * (reminderToldStill) and a forgotten item is listed again.
 */
function itemNotInTold(current, emailed) {
  const told = new Map(emailed.items.map(i => [i.id, i.exp]));
  return current.items.some(i => {
    const was = told.get(i.id);
    return was === undefined || i.exp < was;
  });
}

/**
 * Whether this run's list holds an item the member has not been told about:
 * new to the last email (or due sooner than it said) and more than the
 * banner they snoozed over can account for. The banner names section and
 * date only, so for each "section:date" its parts first cover the items the
 * email told, and only the rest exempt new ones. A list read without items
 * (a hand-made value) cannot be told apart, so any change counts.
 */
function itemNotYetTold(current, emailed, alertsFingerprint) {
  if (!current.items) return true;
  const banner = bannerCounts(alertsFingerprint);
  const told = new Map((emailed.items || []).map(i => [i.id, i.exp]));
  const byKey = new Map();
  for (const i of current.items) {
    const key = `${i.sec}:${i.exp}`;
    const c = byKey.get(key) || { told: 0, fresh: 0 };
    const was = told.get(i.id);
    if (was === undefined || i.exp < was) c.fresh += 1; else c.told += 1;
    byKey.set(key, c);
  }
  for (const [key, c] of byKey) {
    if (c.fresh > Math.max(0, (banner.get(key) || 0) - c.told)) return true;
  }
  return false;
}

/**
 * After a run that sends nothing: the stored fingerprint with its told items
 * narrowed to the ones still in this run's list (fingerprint, from
 * reminderFingerprint), keeping its hash, so an item that left and comes back
 * reads as new. null when nothing changes (no email yet, a bare legacy hash,
 * a hand-made run value, or every told item still listed).
 */
export function reminderToldStill(stored, fingerprint) {
  const emailed = readFingerprint(stored);
  const current = readFingerprint(fingerprint);
  if (!emailed.hash || !emailed.items || !current.items) return null;
  const listed = new Set(current.items.map(i => i.id));
  const kept = emailed.items.filter(i => listed.has(i.id));
  if (kept.length === emailed.items.length) return null;
  return `${emailed.hash};${kept.map(i => i.token).join(',')}`;
}

/**
 * Whether send-reminders emails this recipient now.
 *
 * profile: the recipient row (reminder_email_fingerprint, reminder_emailed_at,
 * snoozed_until, alerts_fingerprint). fingerprint: this run's reminderFingerprint. freqDays:
 * notifyFreqDays(profile.notify_freq_days). Returns { send, reason }.
 */
export function reminderEmailDecision(profile, { fingerprint, freqDays, now = Date.now() }) {
  const last = toMs(profile?.reminder_emailed_at);
  const current = readFingerprint(fingerprint);
  const emailed = readFingerprint(profile?.reminder_email_fingerprint);
  // Told items narrowed by a held run (reminderToldStill) can hold fewer
  // items than the unchanged hash, so with both item lists an item missing
  // from them (or due sooner) is a change too: a DEA acknowledged on a
  // nothing-due day and listed again when the acknowledgement lapses hashes
  // to the last email, snoozed or not.
  const items = !!(current.items && emailed.items);
  const changed = current.hash !== emailed.hash || (items && itemNotInTold(current, emailed));
  // Under a snooze, with both item lists the items decide; without them only
  // a changed hash can wake it.
  const compare = items ? true : changed;
  if (reminderSnoozed(profile?.snoozed_until, now)) {
    return Number.isFinite(last) && compare && itemNotYetTold(current, emailed, profile?.alerts_fingerprint)
      ? { send: true, reason: 'list changed' }
      : { send: false, reason: 'snoozed' };
  }
  if (!Number.isFinite(last)) return { send: true, reason: 'first email' };
  if (changed) return { send: true, reason: 'list changed' };
  if (utcDaysBetween(last, now) >= freqDays) return { send: true, reason: 'due' };
  return { send: false, reason: 'recently notified, unchanged' };
}
