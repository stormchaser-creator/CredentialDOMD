// The one shape check every add and edit passes through on its way to the
// store and the cloud (AppContext addItem / editItem). Forms, the document
// scanner, Vera and the importers all arrive here, so a rule enforced here
// cannot be skipped by a path nobody remembered.
//
// Pure: plain node tests import it.

import { withoutPersonName, isCurrentJob } from "./helpers.js";
import { normalizeLifecycle } from "./lifecycle.js";
import { withRequiredDefaults } from "./syncRules.js";
import { billedWRVU, billedCodes, sameCodes } from "./caseBilling.js";
import { identifierReason } from "./identifierGate.js";

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
 *     (null on an add): an edit that keeps the old date keeps the flag;
 *   - a blank Type or Category the database requires (cme.category,
 *     education.type, case_logs.category...) becomes "Other". The forms ask
 *     for it first; a path that skips the form (the manual CME form and the
 *     import review let a blank credit type through, Vera, an importer) no
 *     longer sends a row the cloud refuses whole (utils/syncRules.js);
 *   - a case log carries the wRVU its codes bill, and work history's Current
 *     Position is a boolean (caseBilling, currentAsBoolean below).
 */
export function prepareRecord(sectionKey, item, physicianName, previous = null) {
  if (sectionKey === "shareLog") return shareLogShape(item);
  return withRequiredDefaults(sectionKey, withoutDictatedIdentifiers(sectionKey, caseBilling(sectionKey, currentAsBoolean(sectionKey, normalizeLifecycle(sectionKey, withPlausibleDates(withoutPersonName(sectionKey, item, physicianName), previous), previous)), previous)));
}

// A year before 1900 is a date still being typed (a desktop date field fires
// 0002-05-01 on the first year digit), never a credential's real date. It is
// not stored: an edit keeps the date it had, an add leaves it blank.
const CHECKED_DATES = ["expirationDate", "issuedDate"];
function withPlausibleDates(item, previous) {
  if (!item || typeof item !== "object") return item;
  let out = item;
  for (const key of CHECKED_DATES) {
    const value = item[key];
    const year = typeof value === "string" ? /^(\d{4})-/.exec(value)?.[1] : null;
    if (year && Number(year) < 1900) {
      if (out === item) out = { ...item };
      out[key] = previous?.[key] ?? "";
    }
  }
  return out;
}

// share_log's method CHECK (migration 20260723_locum_worklog) and the names
// older writers used for the same thing.
const SHARE_METHOD_ALIASES = { copy: "clipboard", download: "share" };

/**
 * A share_log entry in the shape the table takes: sent_at (never the
 * sharedAt Vera's packet share once wrote), a section (NOT NULL; a packet
 * of documents is "documents"), and a method the CHECK allows ("copy" is
 * "clipboard"). A renewal PDF saved on a desktop was logged as "download"
 * and never synced; it left the device, so it lands as "share" rather than
 * waiting in the queue forever. supabase.js clientRow repairs the same on
 * the way out, for rows already cached or queued in the old shape.
 */
export function shareLogShape(item) {
  if (!item || typeof item !== "object") return item;
  const out = { ...item };
  if (out.sharedAt !== undefined) {
    if (!out.sentAt) out.sentAt = out.sharedAt;
    delete out.sharedAt;
  }
  if (!out.section) out.section = "documents";
  if (SHARE_METHOD_ALIASES[out.method]) out.method = SHARE_METHOD_ALIASES[out.method];
  return out;
}

// A case's wRVU is saved with it. A case entered in the form (or dictated)
// carried no number, so its card and the totals read 0 while its detail view
// billed a total; an edit that changed the codes kept the imported number and
// the imported line detail, which then listed a removed code as billed. When
// the codes are unchanged, the imported number and detail stay: they can
// carry modifier and bundling adjustments the catalog cannot reproduce.
function caseBilling(sectionKey, item, previous) {
  if (sectionKey !== "caseLogs" || !item || typeof item !== "object") return item;
  const hasNumber = (r) => r && [r.wRvu, r.w_rvu].some(v => v !== null && v !== undefined && v !== "" && Number.isFinite(parseFloat(v)));
  const codesChanged = !!previous && !sameCodes(item.cptCodes, previous.cptCodes);
  if (!codesChanged && hasNumber(item)) return item;
  const next = { ...item };
  if (codesChanged && next.customFields && typeof next.customFields === "object") {
    const { cptDetail: _detail, componentAudit: _audit, ...rest } = next.customFields;
    next.customFields = rest;
  }
  delete next.w_rvu;
  if (billedCodes(next).some(c => Number(c.wRVU) > 0)) next.wRvu = billedWRVU(next);
  else if (codesChanged || "wRvu" in next) next.wRvu = null;
  return next;
}

// Work history's "Current Position" is a boolean column. The form used to
// store "Yes"/"No", which the cloud turned into true/false, so after a reload
// the form, the detail view and Send each read a different value.
function currentAsBoolean(sectionKey, item) {
  if (sectionKey !== "workHistory" || !item || typeof item !== "object" || !("current" in item)) return item;
  return { ...item, current: isCurrentJob(item.current) };
}

/**
 * An RVU entry's dictation (encounters.spoken_text) syncs to the cloud. The
 * RVU log refuses a dictation with a patient identifier before it is coded or
 * saved; this is the wall behind it for any other path: a spoken text the
 * identifier gate flags is not stored. The codes and the rest stay.
 */
function withoutDictatedIdentifiers(sectionKey, item) {
  if (sectionKey !== "encounters" || !item?.spokenText || !identifierReason("", item.spokenText)) return item;
  return { ...item, spokenText: "" };
}
