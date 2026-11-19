// customFields keys the app writes on a record for its own settings: the
// physician's answer to a question the app asked, or the app's mark on a
// record it made. They are app settings, not license data, so the record
// view (CrudSection), the read-only archive and the support viewer leave
// them out. Every key here must be one the app itself writes.

/** On a state medical license: the day the physician said "I don't prescribe controlled substances here" (stateDuties.js). */
export const CSR_DECLINED_FIELD = "No state controlled substance registration (not prescribing here)";

/** On a state medical license: the date the physician entered as their first license in that state (stateDuties.js). */
export const FIRST_LICENSED_FIELD = "firstLicensedHere";

/** On a State Controlled Substance record: the date the physician entered as their first registration in that state (stateDuties.js). */
export const FIRST_REGISTERED_FIELD = "firstRegisteredHere";

/** lifecycle.BOARD_APP_MADE_FIELD, the mark on a board record the app made (spelled here so this module imports nothing). */
export const BOARD_APP_MADE_KEY = "appMadeBoardRecord";

/** Every app-made customFields key, for the views that hide them. */
export const APP_MARKER_FIELDS = Object.freeze(new Set([CSR_DECLINED_FIELD, FIRST_LICENSED_FIELD, FIRST_REGISTERED_FIELD, BOARD_APP_MADE_KEY]));
