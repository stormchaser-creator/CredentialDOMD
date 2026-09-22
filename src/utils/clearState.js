// What the dashboard's clear-state banner should say.
//
// The dashboard's `urgent` list deliberately excludes anything the physician
// acknowledged, so the banner can render while real renewals are due and merely
// set aside. The old wording, "All Clear / No urgent items right now", appeared
// on the same screen that listed three renewals due inside 90 days, which the
// reader then had to reconcile. When something is snoozed this names the count
// and the date it comes back instead.
//
// Imports nothing on purpose: this file must load in a plain node test, and
// src/utils/notifications.js cannot because it uses extensionless imports that
// only Vite resolves.

/**
 * @param snoozed    the dashboard's already-computed snoozed list, so this can
 *                   never disagree with the rest of the page about what counts
 * @param untilFor   (id) => the acknowledgement's end date, or null/undefined
 * @param formatDate how to render that date for a human
 */
export function clearStateBanner(snoozed, untilFor, formatDate = (d) => d) {
  const items = Array.isArray(snoozed) ? snoozed : [];
  if (!items.length) {
    return { title: "All Clear", detail: "No renewals are due, and nothing is set aside." };
  }
  const returns = items
    .map(i => (typeof untilFor === "function" ? untilFor(i?.id) : null))
    .filter(Boolean)
    .sort();
  const when = returns[0] ? `, back on ${formatDate(returns[0])}` : "";
  return {
    title: "Nothing to do today",
    detail: `${items.length} item${items.length === 1 ? "" : "s"} you set aside${when}.`,
  };
}
