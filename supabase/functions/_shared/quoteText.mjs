/**
 * Text as a quote is compared: the one rule the understanding step
 * (intakeUnderstanding.mjs, for asks) and the facts step (intakeFacts.mjs,
 * for records) both check a model's quote against the email with. Its own
 * module so the two can share it without importing each other.
 *
 * Pure: node tests it through both callers.
 */

// The entities an HTML-only email leaves behind once its tags are gone, by
// name; any other is decoded by number. stripHtml (email-inbound) uses the
// same table, so the text the model is shown and the text a quote is checked
// against are decoded alike.
const ENTITIES = Object.freeze({
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d", ldquo: "\u201c",
  sbquo: "\u201a", bdquo: "\u201e", ndash: "\u2013", mdash: "\u2014", hellip: "\u2026", shy: "\u00ad", zwsp: "", zwj: "", zwnj: "",
  bull: "\u2022", middot: "\u00b7", laquo: "\u00ab", raquo: "\u00bb", copy: "\u00a9", reg: "\u00ae", trade: "\u2122", deg: "\u00b0",
  ensp: " ", emsp: " ", thinsp: " ", lsaquo: "\u2039", rsaquo: "\u203a",
});

/** HTML character references decoded once, left to right ("&amp;lt;" is "&lt;"); an unknown name stays as written. */
export function decodeEntities(s) {
  return String(s ?? "").replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,9});/gi, (m, e) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/**
 * Text as a quote is compared: HTML entities decoded, Unicode compatibility
 * forms folded, zero-width characters gone (Outlook puts U+200B in), curly
 * apostrophes straight, double quote marks and angle brackets gone, every
 * dash a hyphen, soft hyphens and reply chevrons gone, emphasis marks gone,
 * whitespace one space, lower case. Applied to the email and to the quote
 * alike, so a curly apostrophe matches a straight one and a line wrapped by
 * the mail client matches the same sentence unwrapped.
 */
export function normalizeForQuote(s) {
  return decodeEntities(s)
    .normalize("NFKC")
    .replace(/\r\n?/g, "\n")
    .replace(/^[ \t]*(?:>[ \t]?)+/gm, "")
    .replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, "")
    .replace(/[\u2018\u2019\u201a\u201b\u2032`\u00b4]/g, "'")
    // Double quote marks are dropped altogether: a model copying 'the "BLS
    // card"' often leaves them out, and they carry no words. Angle brackets
    // go too: the prompt shows them as look-alikes (asData).
    .replace(/["\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb<>\u2039\u203a]/g, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[*_]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const EDGE = /^[\s"'.,;:!?()[\]-]+|[\s"'.,;:!?()[\]-]+$/g;
/** A quote as it is looked for: normalised, with the punctuation at its ends gone. */
export const quoteKey = (quote) => normalizeForQuote(quote).replace(EDGE, "");

/** Does `quote` occur in the email? `normalizedEmail` is normalizeForQuote(email text). */
export function quoteOccurs(quote, normalizedEmail) {
  const q = quoteKey(quote);
  if (q.length < 3 || !/[a-z0-9]/.test(q)) return false;
  return String(normalizedEmail ?? "").includes(q);
}
