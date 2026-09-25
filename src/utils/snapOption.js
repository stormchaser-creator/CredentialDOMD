/**
 * Snap a value that came from a document scan onto the exact option a form
 * offers, when the two differ only in how they are written.
 *
 * The scanner is told which values to return, but the string it is told and
 * the string the form lists can drift apart by one character and nobody
 * notices: the travel-document picklist offered "Driver’s License" with a
 * curly apostrophe while the scanner prompt asked for "Driver's License" with
 * a straight one, so a scanned licence could never match the list. A physician
 * ended up with two entries that read identically and were different types.
 *
 * Matching widens in three steps and stops at the first hit: exact, then
 * case-insensitive, then punctuation-normalized (curly quotes to straight,
 * dashes to hyphen, runs of whitespace to one space). A value that matches
 * nothing is returned untouched, because a scan can legitimately report
 * something the list does not have and the form shows it as "(from document)".
 */

import { STATES, STATE_NAMES } from "../constants/states.js";

const FOLD = (s) => String(s ?? "")
  .replace(/[‘’ʼ′]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/[‐-―−]/g, "-")
  .replace(/\s+/g, " ")
  .trim()
  .toLowerCase();

export function snapToOption(value, options) {
  const raw = typeof value === "string" ? value : "";
  if (!raw) return value;
  const list = (options || []).filter((o) => typeof o === "string");
  if (!list.length) return value;
  if (list.includes(raw)) return raw;
  const ci = list.find((o) => o.toLowerCase() === raw.toLowerCase());
  if (ci) return ci;
  const folded = FOLD(raw);
  const near = list.find((o) => FOLD(o) === folded);
  return near || value;
}

/** Snap every field named in `optionsByKey`, leaving the rest alone. */
export function snapFields(fields, optionsByKey) {
  const out = { ...(fields || {}) };
  for (const [key, options] of Object.entries(optionsByKey || {})) {
    if (key in out) out[key] = snapToOption(out[key], options);
  }
  return out;
}

/**
 * The two-letter code for a state the way a document or a scan wrote it:
 * "ND", "nd", "N.D.", "North Dakota", "north dakota ", "State of Colorado".
 * Null when nothing matches, so the caller can refuse the value instead of
 * saving free text that every state-keyed lookup (renewal box, CME window,
 * state matrix) then silently misses.
 */
export function canonicalState(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  const code = trimmed.replace(/\./g, "").replace(/\s+/g, "").toUpperCase();
  if (code.length === 2 && STATES.includes(code)) return code;
  const folded = FOLD(trimmed).replace(/^state of /, "").replace(/^commonwealth of /, "");
  const hit = Object.entries(STATE_NAMES).find(([, name]) => FOLD(name) === folded);
  return hit && STATES.includes(hit[0]) ? hit[0] : null;
}

/**
 * A scanned value for one form select, snapped to the option it means. The
 * state field also accepts full names. A value that matches nothing is
 * returned untouched so the form can show it and the physician can choose.
 */
export function canonicalizeSelectValue(fieldDef, raw) {
  if (!fieldDef || fieldDef.type !== "select" || typeof raw !== "string") return raw;
  const options = fieldDef.groups ? fieldDef.groups.flatMap(g => g.options) : (fieldDef.options || []);
  if (fieldDef.key === "state") {
    const code = canonicalState(raw);
    if (code && options.includes(code)) return code;
  }
  return snapToOption(raw, options);
}

/**
 * A scan result for a licence, privilege or policy with its State and Type
 * snapped onto the form's own options. Anything that does not match is left
 * as read, and the review card refuses to save it until the physician picks.
 */
export function canonicalScanFields(fields, { typeOptions } = {}) {
  const out = { ...(fields || {}) };
  if (typeof out.state === "string" && out.state.trim()) {
    const code = canonicalState(out.state);
    if (code) out.state = code;
  }
  if (typeof out.type === "string" && out.type.trim() && Array.isArray(typeOptions)) {
    out.type = snapToOption(out.type, typeOptions);
  }
  return out;
}
