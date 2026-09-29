// send-reminders reads a physician's reminder settings the way the app shows
// them (reminderPreferences in supabase/functions/_shared/reminderRows.mjs).
//
// The profile columns notify_email, reminder_lead_days and notify_freq_days
// have no default and stay null until the physician changes one. The app
// shows DEFAULT_SETTINGS for a null: Email reminders on, lead time 90 days,
// weekly. The sender used to select only notify_email = true and fall back to
// a 60-day window, so a member who never touched the switch saw "Email
// reminders" on in Settings, was told by the setup board that reminders were
// set up, and was never sent one. Synthetic rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULT_SETTINGS } from '../src/constants/defaults.js';
import { REMINDER_DEFAULTS, reminderPreferences } from '../supabase/functions/_shared/reminderRows.mjs';

test('an untouched profile gets the reminders the app shows it: on, 90 days ahead, weekly', () => {
  assert.deepEqual(REMINDER_DEFAULTS, { notifyEmail: DEFAULT_SETTINGS.notifyEmail, leadDays: DEFAULT_SETTINGS.reminderLeadDays, freqDays: DEFAULT_SETTINGS.notifyFreqDays });
  for (const row of [{}, { notify_email: null, reminder_lead_days: null, notify_freq_days: null }, null, undefined]) {
    assert.deepEqual(reminderPreferences(row), { emailOn: true, leadDays: 90, freqDays: 7 }, JSON.stringify(row));
  }
});

test('a physician\'s own choices win: off is off, and a lead time or frequency is kept within bounds', () => {
  assert.equal(reminderPreferences({ notify_email: false }).emailOn, false);
  assert.equal(reminderPreferences({ notify_email: true }).emailOn, true);
  assert.deepEqual(reminderPreferences({ notify_email: true, reminder_lead_days: 30, notify_freq_days: 1 }), { emailOn: true, leadDays: 30, freqDays: 1 });
  assert.deepEqual(reminderPreferences({ reminder_lead_days: '120', notify_freq_days: '14' }), { emailOn: true, leadDays: 120, freqDays: 14 });
  assert.deepEqual(reminderPreferences({ reminder_lead_days: 2, notify_freq_days: 400 }), { emailOn: true, leadDays: 7, freqDays: 60 });
  assert.deepEqual(reminderPreferences({ reminder_lead_days: 5000, notify_freq_days: 0 }), { emailOn: true, leadDays: 365, freqDays: 7 });
  assert.deepEqual(reminderPreferences({ reminder_lead_days: 'soon', notify_freq_days: -3 }), { emailOn: true, leadDays: 90, freqDays: 7 });
});

test('send-reminders selects every profile whose switch is not off, and reads its settings through reminderPreferences', () => {
  const source = fs.readFileSync(new URL('../supabase/functions/send-reminders/index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\.eq\("notify_email", true\)/, 'an untouched (null) switch is on');
  assert.match(source, /\.not\("notify_email", "is", false\)/);
  assert.match(source, /const \{ emailOn, leadDays: lead, freqDays: freq \} = reminderPreferences\(p\);\s*if \(!emailOn\) continue;/);
  assert.doesNotMatch(source, /reminder_lead_days\) \|\| 60/, 'the app shows 90 days for an untouched lead time');
});
