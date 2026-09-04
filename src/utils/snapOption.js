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
