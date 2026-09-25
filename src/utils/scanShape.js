// The shape a scanned licence, privilege or policy must have before the
// review card (ScanReviewCard.jsx) will save it.
//
// A scan's "North Dakota" or "florida " is snapped onto the form's own option
// ("ND", "FL"). A value that still matches nothing blocks Save instead of
// being stored as free text: a free-text state silently misses every
// state-keyed lookup (the renewal box, the CME window, the state matrix), and
// a free-text type is how "Driver License" reached the licences table.
//
// Pure: plain node tests import it.

import { STATES } from "../constants/states.js";
import { canonicalScanFields } from "./snapOption.js";

// Record kinds whose State must be one of the form's own options, and the
// kinds whose Type must be. Privilege and policy types are snapped but not
// enforced: production already holds "Hospital Privileges" and four spellings
// of professional liability that the lists do not offer, and forcing a pick
// would make the physician claim a narrower privilege or policy than the
// document says. A licence type decides which renewal, CME and DEA rules
// apply, so it has to be one the app knows.
const SHAPED_STATE = new Set(["license", "privilege"]);
const SHAPED_TYPE = new Set(["license"]);
// Type is a NOT NULL column on these tables: a blank one rejects the whole row.
const TYPE_REQUIRED = new Set(["license", "privilege", "insurance"]);

/** The scan's values with State and Type snapped onto the form's options (`typeOptions`). */
export function canonicalForDocType(docType, fields, typeOptions) {
  if (!TYPE_REQUIRED.has(docType)) return fields;
  return canonicalScanFields(fields, { typeOptions });
}

/** What still stops Save: { typeIssue, stateIssue }, each null or the sentence the card shows. */
export function scanShapeIssues(docType, edited, typeOptions) {
  const out = { typeIssue: null, stateIssue: null };
  if (!TYPE_REQUIRED.has(docType)) return out;
  const type = String(edited?.type ?? "").trim();
  if (!type) out.typeIssue = "Select the type above before saving.";
  else if (SHAPED_TYPE.has(docType) && Array.isArray(typeOptions) && !typeOptions.includes(edited.type)) {
    out.typeIssue = `The document reads "${type}" as the type, which is not on the list. Select the type above before saving.`;
  }
  if (SHAPED_STATE.has(docType)) {
    const state = String(edited?.state ?? "").trim();
    const required = docType === "license" && /license|dea/i.test(edited?.type || "");
    if (state && !STATES.includes(edited.state)) {
      out.stateIssue = `The document reads "${state}" as the state, which is not on the list. Select the issuing state above before saving.`;
    } else if (!state && required) {
      out.stateIssue = "Select the issuing state above before saving. Without it this won\u{2019}t show up in your state compliance tracking.";
    }
  }
  return out;
}
