// Pure helpers behind the NPI import: splitting a typed name for the registry
// search, the NPPES v2.1 name-query rules, pulling license records out of a
// registry result, and merging them into the licenses the physician already
// has. No fetch, no import.meta, so scripts/npi-import.test.mjs can load this
// in plain node. The transport lives in npiLookup.js.

// Credential and generational tails that are not part of the name the
// registry knows: "Eric Whitney, DO", "John Smith Jr.", "Jane Roe MD PhD".
const NAME_TAILS = /^(jr|sr|ii|iii|iv|md|do|phd|dds|dmd|mph|mba|facs|faans|facc|facog|faap|rn|pa|pa-c|np)\.?,?$/i;

const cleanToken = (t) => String(t || "").replace(/[.,]+$/g, "").replace(/^[.,]+/g, "").trim();

/**
 * Split a free-typed full name into the first and last name the registry
 * searches on. Handles "First Middle Last", "Last, First", trailing
 * credentials and generational suffixes. A lone token is treated as the last
 * name. Multi-word surnames are left to the caller's last token; the
 * production mirror prefix-matches every word anyway.
 */
export function splitName(full) {
  const raw = String(full || "").replace(/\s+/g, " ").trim();
  if (!raw) return { firstName: "", lastName: "" };

  const isTail = (t) => NAME_TAILS.test(cleanToken(t));
  const words = (s) => s.split(" ").map(cleanToken).filter(Boolean);

  let tokens;
  const segs = raw.split(",").map(s => s.trim()).filter(Boolean);
  if (segs.length >= 2 && words(segs[0]).length === 1 && !words(segs[1]).every(isTail)) {
    // "Whitney, Eric W." (family name first). Anything after the second
    // comma is a credential tail.
    tokens = [...words(segs[1]).filter(t => !isTail(t)), ...words(segs[0])];
  } else {
    // "Eric W. Whitney, DO" or "Eric Whitney MD": drop the tail tokens only
    // while a first and last name remain, so a real surname like "Do" stays.
    tokens = words(segs[0]);
    while (tokens.length > 2 && isTail(tokens[tokens.length - 1])) tokens.pop();
  }

  if (!tokens.length) return { firstName: "", lastName: "" };
  if (tokens.length === 1) return { firstName: "", lastName: tokens[0] };
  return { firstName: tokens[0], lastName: tokens[tokens.length - 1] };
}

// NPPES v2.1 name rules (https://npiregistry.cms.hhs.gov/api-page):
// first_name / last_name take a trailing "*" wildcard only after at least two
// characters; "state" cannot be the only criterion; limit is 1..200 and
// defaults to 10. A user-typed "*" is stripped so the API never sees "E*".
const stripStar = (s) => String(s || "").replace(/\*/g, "").trim();

/**
 * Build the NPPES query parameters for a name search, or null when there is
 * no name to search on. `wildcard` appends "*" to the first name (prefix
 * match, "Eri*" finds Eric and Erica) when the field is long enough for it.
 */
export function nameSearchParams({ firstName, lastName, state, limit = 20, wildcard = false } = {}) {
  const first = stripStar(firstName);
  const last = stripStar(lastName);
  if (!first && !last) return null;
  const params = { version: "2.1", enumeration_type: "NPI-1" };
  if (first) params.first_name = wildcard && first.length >= 2 ? `${first}*` : first;
  if (last) params.last_name = last;
  const st = String(state || "").trim().toUpperCase();
  if (st) params.state = st;
  const n = Math.max(1, Math.min(200, parseInt(limit, 10) || 20));
  params.limit = String(n);
  return params;
}

/** Same license regardless of how the number was typed: "35.123456" = "35123456". */
export function licenseKey(state, number) {
  const st = String(state || "").trim().toUpperCase();
  const num = String(number || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `${st}|${num}`;
}

/**
 * Every license record a registry result carries, one per state+number.
 * NPPES lists a taxonomy row per specialty, and two specialties often share
 * one license (or one specialty repeats across states), so rows are deduped
 * by state + license number with the primary taxonomy's description winning.
 * Rows without both a number and a state are skipped: nothing to track.
 */
export function extractLicensesFromNPI(result) {
  const rows = Array.isArray(result?.allTaxonomies) ? result.allTaxonomies : [];
  const primaryFirst = [...rows.filter(t => t?.isPrimary), ...rows.filter(t => !t?.isPrimary)];
  const seen = new Map();
  for (const t of primaryFirst) {
    const licenseNumber = String(t?.license || "").trim();
    const state = String(t?.state || "").trim().toUpperCase();
    if (!licenseNumber || !state) continue;
    const key = licenseKey(state, licenseNumber);
    const prev = seen.get(key);
    if (prev) {
      if (!prev.description && t.description) prev.description = t.description;
      continue;
    }
    seen.set(key, { licenseNumber, state, taxonomyCode: t.code || "", description: t.description || "" });
  }
  return [...seen.values()];
}

/** The license type the app files an imported state license under, by degree. */
export function licenseTypeFor(degreeType) {
  return String(degreeType || "").toUpperCase() === "DO" ? "State Medical License (DO)" : "State Medical License";
}

const fallbackId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

/**
 * Turn registry license records into new license items, skipping any the
 * physician already has (matched by state + normalized number, so a hand-typed
 * "35.123456" is not duplicated by the registry's "35123456"). Returns only
 * the items to add; the caller persists them.
 */
export function mergeNpiLicenses(existing, found, { degreeType, makeId } = {}) {
  const have = new Set((existing || []).map(l => licenseKey(l?.state, l?.licenseNumber)));
  const out = [];
  for (const nl of found || []) {
    const key = licenseKey(nl.state, nl.licenseNumber);
    if (!nl.licenseNumber || !nl.state || have.has(key)) continue;
    have.add(key);
    out.push({
      id: (makeId || fallbackId)(),
      type: licenseTypeFor(degreeType),
      name: `${nl.state} Medical License`,
      licenseNumber: nl.licenseNumber,
      state: nl.state,
      issuedDate: "",
      expirationDate: "",
      notes: `Imported from NPPES NPI Registry${nl.description ? ` (${nl.description})` : ""}`,
      npiImported: true,
    });
  }
  return out;
}

/** Tracked states after an import: existing extras plus every registry license state that is not the primary. */
export function additionalStatesAfterImport(existingAdditional, primaryState, found) {
  const primary = String(primaryState || "").toUpperCase();
  const out = [];
  for (const st of [...(existingAdditional || []), ...(found || []).map(l => l.state)]) {
    const s = String(st || "").trim().toUpperCase();
    if (!s || s === primary || out.includes(s)) continue;
    out.push(s);
  }
  return out;
}

/**
 * MD or DO from a registry credential string ("D.O.", "M.D.", "MD, PHD",
 * "DO FACOS"). Dots are stripped and whole tokens matched so "MD" inside
 * another word cannot flip the degree. Empty when neither is present.
 */
export function degreeFromCredential(credential) {
  const cred = String(credential || "").toUpperCase().replace(/\./g, "");
  if (/\bDO\b/.test(cred)) return "DO";
  if (/\bMD\b/.test(cred)) return "MD";
  return "";
}
