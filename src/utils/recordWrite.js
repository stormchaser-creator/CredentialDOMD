// The one shape check every add and edit passes through on its way to the
// store and the cloud (AppContext addItem / editItem). Forms, the document
// scanner, Vera and the importers all arrive here, so a rule enforced here
// cannot be skipped by a path nobody remembered.
//
// Pure: plain node tests import it.

import { withoutPersonName } from "./helpers.js";
import { normalizeLifecycle } from "./lifecycle.js";

/**
 * The record as it should be stored:
 *   - a Display Name that is only the physician's own name is cleared, so the
 *     canonical label (type and state, facility, carrier) is what every share
 *     subject, notification and picker shows (ticket 5bef10ac);
 *   - a licence, privilege or policy's lifecycle keys are cleaned: a status
 *     from the five, strict booleans, a replacement link only on a superseded
 *     record, a one-line source of at most 200 characters (ticket 2c819309).
 *     Each is a real column, and a value no reader understands would only
 *     ever be read as "active". "Date not yet known" is cleared once a date
 *     arrives, which takes `previous`, the stored record an edit replaces
 *     (null on an add): an edit that keeps the old date keeps the flag.
 */
export function prepareRecord(sectionKey, item, physicianName, previous = null) {
  return normalizeLifecycle(sectionKey, withoutPersonName(sectionKey, item, physicianName), previous);
}
