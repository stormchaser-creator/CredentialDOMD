/**
 * Contact details, formatted the way a credentialing office expects to see
 * them and validated so a broken one cannot ride out on a CV unnoticed.
 *
 * A CV goes to hospitals, agencies, and medical staff offices. A phone
 * number typed as 5551234567 and an email quietly saved as
 * "name@gmail.c" both look fine in a settings field and both cost the
 * physician a callback.
 */

/**
 * US and Canada numbers render as (555) 123-4567, with extensions kept.
 * Anything that is not a recognizable 10 or 11 digit number is returned
 * unchanged: an international number is not ours to reformat, and mangling
 * it would be worse than leaving it alone.
 */
export function formatPhone(input) {
  if (!input) return "";
  const raw = String(input).trim();

  // Keep an extension if one was typed, in any of its usual spellings.
  const extMatch = raw.match(/(?:\s*(?:x|ext\.?|extension)\s*(\d+))\s*$/i);
  const ext = extMatch ? extMatch[1] : "";
  const body = extMatch ? raw.slice(0, extMatch.index) : raw;

  // A leading + means the user is being explicit about a country code.
  // Only reformat the North American case; leave every other country alone.
  const digits = body.replace(/\D/g, "");
  const plus = body.trim().startsWith("+");

  let core = "";
  if (digits.length === 10) core = digits;
  else if (digits.length === 11 && digits[0] === "1") core = digits.slice(1);
  else return raw; // not a NANP number, or incomplete: leave the user's text

  if (plus && digits.length === 11) {
    return `+1 (${core.slice(0, 3)}) ${core.slice(3, 6)}-${core.slice(6)}${ext ? ` x${ext}` : ""}`;
  }
  return `(${core.slice(0, 3)}) ${core.slice(3, 6)}-${core.slice(6)}${ext ? ` x${ext}` : ""}`;
}

/** Digits only, for tel: links and SMS. Empty when not a NANP number. */
export function phoneDigits(input) {
  const d = String(input || "").replace(/\D/g, "");
  if (d.length === 10) return d;
  if (d.length === 11 && d[0] === "1") return d.slice(1);
  return "";
}

// Deliberately permissive on the local part (real addresses contain +, ', and
// plenty else) and strict only where mistakes actually happen: a missing or
// obviously incomplete domain.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

// Domains people type most often, with the truncations and slips that follow.
const COMMON_TLD = /\.(com|org|net|edu|gov|io|co|us|ca|health|md|care)$/i;

/**
 * Why an email looks wrong, or "" when it looks fine.
 * Returns a sentence to show the user, not a boolean, because the useful
 * thing is telling them what to fix.
 */
export function emailProblem(input) {
  const v = String(input || "").trim();
  if (!v) return "";                       // empty is not an error, just unset
  if (!v.includes("@")) return "That address is missing an @.";
  if (!EMAIL_SHAPE.test(v)) return "That address looks incomplete.";

  const domain = v.split("@").pop() || "";
  const tld = domain.split(".").pop() || "";
  // A one-character final segment is nearly always a cut-off address
  // (gmail.c for gmail.com), which is exactly how a CV goes out unreachable.
  if (tld.length < 2) return "That address looks cut off after the dot.";
  if (!COMMON_TLD.test(domain) && tld.length === 2 && /^(co|ne|or|ed)$/i.test(tld)) {
    return "That address may be cut off. Check the ending.";
  }
  return "";
}
