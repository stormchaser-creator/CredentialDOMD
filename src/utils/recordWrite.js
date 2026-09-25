// The one shape check every add and edit passes through on its way to the
// store and the cloud (AppContext addItem / editItem). Forms, the document
// scanner, Vera and the importers all arrive here, so a rule enforced here
// cannot be skipped by a path nobody remembered.
//
// Pure: plain node tests import it.

import { withoutPersonName } from "./helpers.js";

/**
 * The record as it should be stored:
 *   - a Display Name that is only the physician's own name is cleared, so the
 *     canonical label (type and state, facility, carrier) is what every share
 *     subject, notification and picker shows.
 */
export function prepareRecord(sectionKey, item, physicianName) {
  return withoutPersonName(sectionKey, item, physicianName);
}
