// Credential lifecycle (ticket 2c819309): historical and superseded
// credentials, appointments awaiting confirmation, and dates that are not known
// yet, without false alerts.
//
// Licenses, insurance and privileges carry four columns
// (supabase/migrations/20260925040000_credential_lifecycle.sql):
//   lifecycleStatus  active | provisional | pending_confirmation | superseded | historical
//   dateUnknown      the expiration / reappointment date is not known yet
//   supersededBy     the id of the record that replaced this one
//   statusSource     who or what reported the status, at most 200 characters
//
// The rules every screen, export, email and Vera read:
//   - Only an active or provisional record with a known date is ALERTABLE: it
//     can raise an alert, count in the compliance ring, set a state's CME
//     window and trigger a reminder email.
//   - Historical and superseded records are INACTIVE: kept, searchable, in the
//     full export with their dates, sorted last and labelled; never on the CV.
//   - Pending confirmation and date-unknown records NEED RESOLUTION: a
//     "resolve missing information" task, never an alert.
//   - A missing or unrecognised status reads as active, so a bad value can
//     only ever keep an alert on, never silence one.
//
// Pure: plain node tests and the edge-function copies mirror it.

import { CERTIFICATION_TYPE } from "../constants/credentialTypes.js";

export const LIFECYCLE_SECTIONS = Object.freeze(["licenses", "privileges", "insurance"]);
export const LIFECYCLE_STATUSES = Object.freeze(["active", "provisional", "pending_confirmation", "superseded", "historical"]);
export const STATUS_SOURCE_MAX = 200;

/** The columns each table must have before a client writing these keys ships (checked by scripts/check-tables-exist.mjs). */
export const LIFECYCLE_COLUMNS = Object.freeze({
  licenses: Object.freeze(["lifecycle_status", "date_unknown", "superseded_by", "status_source", "no_expiration"]),
  insurance: Object.freeze(["lifecycle_status", "date_unknown", "superseded_by", "status_source"]),
  privileges: Object.freeze(["lifecycle_status", "date_unknown", "superseded_by", "status_source"]),
});

/** Form and list labels. No em dashes: they read as machine text. */
export const LIFECYCLE_LABELS = Object.freeze({
  active: "Active",
  provisional: "Provisional or temporary",
  pending_confirmation: "Pending confirmation",
  superseded: "Superseded",
  historical: "Historical",
});

const INACTIVE = new Set(["superseded", "historical"]);

/** The record's status, normalised. Null, blank or unrecognised reads as active. */
export function lifecycleOf(item) {
  const raw = item && typeof item === "object" ? item.lifecycleStatus : null;
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return LIFECYCLE_STATUSES.includes(v) ? v : "active";
}

/** True only for an explicit true: a text "false" must never silence a record. */
export const isDateUnknown = (item) => !!item && item.dateUnknown === true;

/** Historical or superseded: kept for the record, never renewed. */
export const isInactive = (item) => INACTIVE.has(lifecycleOf(item));

/** Can raise an alert, count in the ring, set a CME window, send a reminder. */
export function isAlertable(item) {
  const s = lifecycleOf(item);
  return (s === "active" || s === "provisional") && !isDateUnknown(item);
}

/** Personal coverage (health, dental, vision, disability, life) has no credentialing expiration to chase. */
export const PERSONAL_COVERAGE_RE = /health insurance|dental|vision|life insurance|disability/i;
const isBoardCertType = (type) => /board certification/i.test(type || "");

/**
 * Whether "date not yet known" is a question this record can have at all.
 * A course certification, a lifetime diplomate who ticked "does not expire"
 * and personal coverage never expire, so their forms hide the checkbox. A
 * flag left over from before the type changed has no control to clear it,
 * so it must not count: normalizeLifecycle drops it and needsResolution
 * ignores it.
 */
export function dateUnknownApplies(sectionKey, item) {
  const type = String(item?.type || "");
  if (sectionKey === "licenses") return type !== CERTIFICATION_TYPE && !(item?.noExpiration === true && isBoardCertType(type));
  if (sectionKey === "insurance") return !PERSONAL_COVERAGE_RE.test(type);
  return true;
}

/**
 * Pending confirmation or date unknown, and not retired: a task to resolve,
 * not an alert. With its section, a leftover "not yet known" on a record that
 * cannot have one (dateUnknownApplies) is not a question.
 */
export function needsResolution(item, sectionKey) {
  if (!item || isInactive(item)) return false;
  if (lifecycleOf(item) === "pending_confirmation") return true;
  return isDateUnknown(item) && (!sectionKey || dateUnknownApplies(sectionKey, item));
}

/** On a CV: active and provisional only. */
export function isOnCv(item) {
  const s = lifecycleOf(item);
  return s === "active" || s === "provisional";
}

/**
 * The expiration requirement is waived: the physician said the date is not
 * known yet, or the record itself is still awaiting confirmation. Anything
 * else still needs its date, which is how the app warns before a lapse.
 */
export const expirationWaived = (form) => isDateUnknown(form) || lifecycleOf(form) === "pending_confirmation";

/**
 * The short status a list shows beside a record, or null for a plain active
 * one. Retired records say what they are; open questions say what is open.
 */
export function lifecycleNote(item) {
  const s = lifecycleOf(item);
  if (s === "historical") return "Historical";
  if (s === "superseded") return "Superseded";
  if (s === "pending_confirmation") return "Pending confirmation";
  if (isDateUnknown(item)) return "Date not yet known";
  if (s === "provisional") return "Provisional";
  return null;
}

/** "Historical", "Superseded", ... with "date not yet known" added when it applies; exports and share text. */
export function lifecycleSummary(item) {
  const s = lifecycleOf(item);
  const base = LIFECYCLE_LABELS[s];
  return isDateUnknown(item) ? `${base}, date not yet known` : base;
}

/**
 * The record as it may be written. Only keys already present are touched, so
 * a record from any other path is left exactly as it came:
 *   - status: one of the five, anything else becomes active
 *   - dateUnknown / noExpiration: strict booleans. "Does not expire" means
 *     something only on a board certification or a course certification; on
 *     any other licence type it is a hidden leftover and is cleared, so it can
 *     never override "not known yet"
 *   - dateUnknown is cleared where the record cannot have that question
 *     (dateUnknownApplies), and as soon as a date arrives: on an add, or on an
 *     edit whose date differs from `previous`. A form, a scan, Vera or a date
 *     fix typing the reappointment date must re-arm the alert, the ring and
 *     the reminder email. An edit that keeps the same date keeps the flag:
 *     that is a stale date the physician marked not yet known.
 *   - supersededBy: kept only on a superseded record, never pointing at itself
 *   - statusSource: one line, at most 200 characters, blank becomes null
 * Other sections are returned unchanged.
 */
export function normalizeLifecycle(sectionKey, item, previous = null) {
  if (!LIFECYCLE_SECTIONS.includes(sectionKey) || !item || typeof item !== "object") return item;
  const has = (k) => Object.prototype.hasOwnProperty.call(item, k);
  if (!["lifecycleStatus", "dateUnknown", "supersededBy", "statusSource", "noExpiration"].some(has)) return item;
  const out = { ...item };
  if (has("lifecycleStatus")) out.lifecycleStatus = lifecycleOf(out);
  if (has("dateUnknown")) out.dateUnknown = out.dateUnknown === true;
  if (has("noExpiration")) {
    const type = String(out.type || "");
    out.noExpiration = out.noExpiration === true
      && (sectionKey !== "licenses" || type === CERTIFICATION_TYPE || isBoardCertType(type));
  }
  if (out.dateUnknown === true) {
    const date = typeof out.expirationDate === "string" ? out.expirationDate.trim() : out.expirationDate;
    const dateArrived = !!date && (!previous || previous.expirationDate !== out.expirationDate);
    if (dateArrived || !dateUnknownApplies(sectionKey, out)) out.dateUnknown = false;
  }
  if (has("supersededBy")) {
    const ref = typeof out.supersededBy === "string" ? out.supersededBy.trim() : "";
    out.supersededBy = lifecycleOf(out) === "superseded" && ref && ref !== out.id ? ref : null;
  }
  if (has("statusSource")) {
    const text = typeof out.statusSource === "string" ? out.statusSource.replace(/\s+/g, " ").trim() : "";
    out.statusSource = text ? text.slice(0, STATUS_SOURCE_MAX) : null;
  }
  return out;
}

/**
 * The form fields a licence, privilege or policy form adds for its lifecycle.
 * `records` are the section's own records, for the "Replaced by" picker;
 * `labelOf(record)` names one. `dateNoun` is what the date is called
 * ("Expiration", "Reappointment").
 */
export function lifecycleFields({ sectionKey, records = [], labelOf = (r) => r?.id || "", dateNoun = "Expiration" } = {}) {
  const statusOptions = LIFECYCLE_STATUSES.map((value) => ({ value, label: LIFECYCLE_LABELS[value] }));
  return {
    dateUnknown: {
      key: "dateUnknown", label: `${dateNoun} date`, type: "checkbox",
      checkboxLabel: `${dateNoun} date not yet known`,
      hint: "Kept without a made-up date. It shows as a task to resolve, never as an alert.",
      show: (f) => dateUnknownApplies(sectionKey, f),
    },
    status: [
      {
        key: "lifecycleStatus", label: "Status", type: "choice", options: statusOptions, defaultValue: "active",
        hint: "Historical and superseded records stay searchable and in the full export with their numbers and dates. They never raise renewal alerts or count toward compliance.",
      },
      {
        key: "supersededBy", label: "Replaced by", type: "choice",
        show: (f) => lifecycleOf(f) === "superseded",
        options: (f) => records
          .filter((r) => r && r.id && r.id !== f.id)
          .map((r) => ({ value: r.id, label: labelOf(r) })),
        placeholder: "Choose the record that replaced it",
      },
      {
        key: "statusSource", label: "Status source", maxLength: STATUS_SOURCE_MAX,
        show: (f) => lifecycleOf(f) !== "active" || isDateUnknown(f) || !!f.statusSource,
        placeholder: "e.g. Medical staff office email, 9/18/2026",
        hint: "Who or what reported this status.",
      },
    ],
  };
}

/**
 * The form after one field changes. Typing the date answers "not yet known",
 * so the checkbox unticks where the physician can see it, rather than the
 * flag silently outliving the date (normalizeLifecycle clears it on save too).
 */
export function withFormField(form, key, value) {
  const next = { ...form, [key]: value };
  if (key === "expirationDate" && value && next.dateUnknown === true) next.dateUnknown = false;
  return next;
}
