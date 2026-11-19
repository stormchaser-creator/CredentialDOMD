// One-time state courses due within a set time of licensure (Alabama's
// boundaries course within 12 months, Kentucky's head trauma course within 5
// years) in the daily reminder email (send-reminders).
//
// The app alerts on such a course inside the reminder lead window while it
// is unmet, counted only from a first-licensure (or first-registration) date
// the physician entered (src/utils/stateDuties.js licensureDeadlineAlerts,
// called from src/utils/notifications.js generateAlerts). The email names
// the same courses by running that same code, copied verbatim into
// _shared/app/ by scripts/sync-shared-app-modules.mjs, on the data the app
// builds: every licence record and every CME record of the member (rows as
// the app loads them, reminderBoardSteps.mjs appRecordOf) and
//   settings: { specialties: profiles.specialties, degreeType: profiles.degree_type }
// A course already logged, one whose date passed, and one past the lead
// window raise nothing, exactly as in the app.
//
// Plain JavaScript so the Deno function and the node tests share one copy.
import { licensureDeadlineAlerts } from './app/utils/stateDuties.js';
import { appRecordOf, specialtiesOf } from './reminderBoardSteps.mjs';

/** The section name the email's fingerprint gives a licensure deadline (reminderCadence.mjs). */
export const LICENSURE_SECTION = 'licensure';

/** The `data` the app's state duties code reads. */
export function licensureDataFor(profile, records) {
  return {
    settings: { specialties: specialtiesOf(profile?.specialties), degreeType: profile?.degree_type ?? '' },
    licenses: (records?.licenses || []).map(appRecordOf),
    cme: (records?.cme || []).map(appRecordOf),
  };
}

const dayDiff = (iso, today) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);

/**
 * The reminder items for a member's licensure deadlines due within `lead`
 * days: { id: "licensure:<state>:<topic>", table: "licensure", label, name,
 * exp, days, state }. `today` is the run's date (send-reminders counts days
 * from it). Throws when the app code throws; the caller leaves them out.
 */
export function reminderLicensureItems(profile, records, { lead, now = new Date(), today = now.toISOString().slice(0, 10) }) {
  if (!records) return [];
  return licensureDeadlineAlerts(licensureDataFor(profile, records), lead, now).map(a => ({
    id: a.key, table: LICENSURE_SECTION, label: 'State requirement', name: a.label,
    exp: a.renewal, days: dayDiff(a.renewal, today), state: a.state, type: null, isDea: false, isLicense: false,
  }));
}
