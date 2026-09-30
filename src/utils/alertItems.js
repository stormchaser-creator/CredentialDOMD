// Which records Home, the bell and the reminder email watch for renewal.
//
// One list, so the three can never disagree again. Home built its own list
// and the bell (generateAlerts) built a shorter one, and neither held travel
// documents or screenings, which the daily reminder email
// (supabase/functions/send-reminders TABLES) has always named. A passport
// expiring in 20 days was emailed with "open the app to snooze it" and the
// app had nothing to snooze.
//
// Extensions spelled out so pure-node test scripts can import this module.
import { localToday } from "./dateDays.js";
import { categoryLabelFor } from "./customCategories.js";

/**
 * A membership the physician has ended ("Ended", on or before today) is not
 * renewed: it never alerts, never counts in the ring and is never emailed
 * (supabase/functions/_shared/reminderRows.mjs applies the same rule). It
 * used to sit on Home as EXPIRED indefinitely once its old renewal date
 * passed. Work history, rotations and contracts also carry an endDate, so the
 * rule is applied to memberships only.
 */
export function membershipEnded(item, today = localToday()) {
  const end = String(item?.endDate ?? item?.end_date ?? "").slice(0, 10);
  return !!end && end <= today;
}

/** The records that can still lapse: ended memberships left out. */
export function lapsingRecords(list, today = localToday()) {
  return (list || []).filter(i => !(i?._sec === "memberships" && membershipEnded(i, today)));
}

/**
 * Every record the credentials pages track, tagged with its section (`_sec`),
 * the label Home shows for it (`_cat`) and, for a custom category, the rail
 * entry it lives under (`_rail`). The standing ring, the tiles and Quick
 * Share read this list.
 */
export function credentialRecords(data) {
  const d = data || {};
  const tag = (list, sec, cat) => (list || []).map(x => ({ ...x, _sec: sec, _cat: cat }));
  return [
    ...tag(d.licenses, "licenses", "License"),
    ...tag(d.cme, "cme", "CME"),
    ...tag(d.privileges, "privileges", "Privilege"),
    ...tag(d.insurance, "insurance", "Insurance"),
    ...tag(d.caseLogs, "caseLogs", "Case"),
    ...tag(d.healthRecords, "healthRecords", "Health"),
    ...tag(d.education, "education", "Education"),
    ...tag(d.workHistory, "workHistory", "Work"),
    ...tag(d.peerReferences, "peerReferences", "Reference"),
    ...tag(d.malpracticeHistory, "malpracticeHistory", "Malpractice"),
    ...tag(d.publications, "publications", "Publication"),
    ...tag(d.memberships, "memberships", "Organization"),
    // Records in the physician's own categories, so one with an expiry date
    // warns like any credential. _rail is where it lives on the Credentials page.
    ...(d.customRecords || []).filter(r => r && r.id).map(r => ({
      ...r, _sec: "customRecords", _cat: categoryLabelFor(d, r) || "Record", _rail: `custom:${r.categoryId || "unsorted"}`,
    })),
  ];
}

/**
 * The records that can raise a renewal alert: the credentials above plus
 * travel documents and screenings, the two sections the reminder email names
 * that the credentials list does not. They alert and can be acknowledged;
 * they are not part of the standing ring or its tiles.
 */
export function alertRecords(data, credentials = credentialRecords(data)) {
  const d = data || {};
  return lapsingRecords([
    ...credentials,
    ...(d.travelDocs || []).map(t => ({ ...t, _sec: "travelDocs", _cat: "Travel" })),
    ...(d.screenings || []).map(s => ({ ...s, _sec: "screenings", _cat: "Screening" })),
  ]);
}

/** Sections alertRecords covers, for the check against the email's tables. */
export const ALERT_SECTIONS = Object.freeze([
  "licenses", "cme", "privileges", "insurance", "caseLogs", "healthRecords", "education",
  "workHistory", "peerReferences", "malpracticeHistory", "publications", "memberships",
  "customRecords", "travelDocs", "screenings",
]);
