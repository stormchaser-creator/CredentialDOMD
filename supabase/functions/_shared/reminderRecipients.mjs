// Who the daily reminder email (send-reminders) goes to.
//
// A profile is a recipient when its email reminders are on, it has an email
// address and its access is active. "On" is the app's rule
// (app/utils/reminderPreferences.js): blank means on, only an explicit false
// is off. Before 2026-09-29 the query read .eq("notify_email", true), so the
// 7 of 8 active accounts whose row was blank never got a digest while their
// Settings switch showed ON.
//
// The PostgREST filter NOT (notify_email IS FALSE) keeps true and null and
// drops false. isReminderRecipient is the same rule in JavaScript, and
// tests/reminder-recipients.test.mjs holds the two to one truth table
// (including a run of the SQL on a disposable PostgreSQL).
//
// Plain JavaScript so the Deno function and the node tests share one copy.
import { emailRemindersOn, reminderLeadDays, notifyFreqDays } from './app/utils/reminderPreferences.js';

export { reminderLeadDays, notifyFreqDays };

// The server's own send state (reminder_email_fingerprint, reminder_emailed_at)
// and the member's banner snooze: snoozed_until and alerts_fingerprint, the
// list the banner showed when they snoozed. alerts_fingerprint is read only
// to tell what the member has seen, never compared as the server's state
// and never written; last_notified is not read (reminderCadence.mjs says why).
// degree_type picks the reminder line's board for a PA or NP licence
// (reminderRenewalLine.mjs).
export const RECIPIENT_COLUMNS = 'id, name, email, notify_email, reminder_lead_days, notify_freq_days, snoozed_until, alerts_fingerprint, reminder_email_fingerprint, reminder_emailed_at, access_status, degree_type';

/**
 * The profiles query send-reminders runs, on a supabase-js client. profileId
 * narrows it to one account (an admin's manual run); the rules still apply.
 */
export function reminderRecipientsQuery(db, profileId) {
  let query = db.from('profiles')
    .select(RECIPIENT_COLUMNS)
    // Blank means on: `notify_email=not.is.false`, i.e. NOT (notify_email IS FALSE).
    .not('notify_email', 'is', false)
    .not('email', 'is', null)
    .neq('email', '')
    .eq('access_status', 'active');
  if (profileId) query = query.eq('id', profileId);
  return query;
}

/** The query's rule, for one profile row. */
export function isReminderRecipient(row) {
  return !!row && typeof row === 'object'
    && emailRemindersOn(row.notify_email)
    && typeof row.email === 'string' && row.email !== ''
    && row.access_status === 'active';
}
