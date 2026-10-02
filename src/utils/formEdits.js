/**
 * An edit form's save over the record as it is now (review of release/goal2,
 * 2026-10-01). A form keeps the record it opened from; the app's resume
 * reload brings another device's changes into the page and, by design,
 * leaves an open form alone. Saved whole, the form put back what it opened
 * with: an expense or a day billed on the Mac meanwhile went back to
 * unbilled (its invoice id null) and was offered for a second invoice.
 *
 * `opened`: the record as the form opened it. `values`: the form now.
 * Returns the fields this form changed from `opened` (compared as JSON, so
 * a list or an object counts as one field).
 */
export function typedChanges(opened, values) {
  const was = opened && typeof opened === "object" ? opened : {};
  return Object.fromEntries(Object.entries(values && typeof values === "object" ? values : {})
    .filter(([k, v]) => JSON.stringify(v ?? null) !== JSON.stringify(was[k] ?? null)));
}

/**
 * The record to save: `current` (the record as the page has it now; the one
 * the form opened from when it is gone) with only what the form changed laid
 * over it, under the opened record's id.
 */
export function editOverCurrent(opened, values, current) {
  return { ...(current || opened || {}), ...typedChanges(opened, values), id: opened?.id ?? current?.id };
}
