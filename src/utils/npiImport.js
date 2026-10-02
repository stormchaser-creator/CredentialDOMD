// Pure helpers behind the NPI import: splitting a typed name for the registry
// search, the NPPES v2.1 name-query rules, pulling license records out of a
// registry result, and merging them into the licenses the physician already
// has. No fetch, no import.meta, so scripts/npi-import.test.mjs can load this
// in plain node. The transport lives in npiLookup.js.
import { isAdvancedPractice, licenseKindOf, licenseTypeForNppesRow, professionFromTaxonomy } from "../constants/professions.js";

// Credential and generational tails that are not part of the name the
// registry knows: "Rowan Testa, DO", "John Smith Jr.", "Jane Roe MD PhD".
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
    // "Testa, Rowan E." (family name first). Anything after the second
    // comma is a credential tail.
    tokens = [...words(segs[1]).filter(t => !isTail(t)), ...words(segs[0])];
  } else {
    // "Rowan E. Testa, DO" or "Rowan Testa MD": drop the tail tokens only
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
 * An RN row and an NP row with the same number stay two records: they are two
 * licences (see nursingKind below).
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
    const kind = nursingKind(t.code);
    const key = kind ? `${licenseKey(state, licenseNumber)}|${kind}` : licenseKey(state, licenseNumber);
    const prev = seen.get(key);
    if (prev) {
      if (!prev.description && t.description) prev.description = t.description;
      continue;
    }
    seen.set(key, { licenseNumber, state, taxonomyCode: t.code || "", description: t.description || "" });
  }
  return [...seen.values()];
}

// Physician licence typing and the MD/DO credential reading live with the
// profession rules (src/constants/professions.js), which the public-record
// edge function shares; re-exported for the existing importers.
export { licenseTypeFor, degreeFromCredential, degreeFromNppes, nppesProfession, licenseTypeForNppesRow } from "../constants/professions.js";

const fallbackId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

// An NP's RN and APRN authority often share a state and a licence number
// (CA, MD, MA and MI note the NP authority on the RN licence), and they are
// two licences with two boards' rules. Rows of those two kinds are never
// folded into one; every other row dedupes by state and number as before.
const nursingKind = (taxonomyCode) => {
  const k = professionFromTaxonomy(taxonomyCode);
  return k === "rn" ? "rn" : k === "np" ? "aprn" : "";
};
const NURSING_KIND_OF_TYPE = { rn: "rn", aprn: "aprn" };

// The nursing kind an imported licence's own note names. The import has
// always written the registry's taxonomy description into the note
// ("Imported from NPPES NPI Registry (Registered Nurse)"), including the
// imports that filed every row as "State Medical License". "aprn" for any
// APRN role (nurse practitioner, clinical nurse specialist, nurse
// anesthetist, nurse midwife), "rn" for a registered nurse row, "none" for
// any other described row (a PA, a physician), "" when the note says
// nothing. The pre-split import kept one record per state and number with
// the primary taxonomy's description, so a CNS, CRNA or CNM note on an APRN
// number is that APRN licence, and the NP row on the same number is not new.
const IMPORT_NOTE = /Imported from NPPES NPI Registry \((.+)\)/i;
const APRN_ROLE = /\b(nurse practitioner|clinical nurse specialist|nurse anesthetist|nurse midwife|advanced practice (?:registered nurse|midwife|nurse))\b/i;
export function nursingKindFromNote(notes) {
  const m = IMPORT_NOTE.exec(String(notes || ""));
  if (!m) return "";
  const d = m[1].trim();
  if (APRN_ROLE.test(d)) return "aprn";
  if (/^registered nurse\b/i.test(d)) return "rn";
  return d ? "none" : "";
}

/**
 * Every "state|number|kind" a set of licences on file answers to, kind being
 * "rn", "aprn" or "" (any other licence). An RN or APRN licence answers to
 * its own kind. A licence typed before the profession was set (the import
 * filed every row as "State Medical License"), or never typed, is one of the
 * two nursing licences, not both, and answers to the kind its evidence shows:
 *  1. the taxonomy description in its own import note;
 *  2. otherwise the registry: when the rows being offered (`offered`, each
 *     { state, licenseNumber, kind }) carry exactly one nursing kind on its
 *     state and number, that kind;
 *  3. otherwise (no evidence, or an RN and an APRN row on one number) the
 *     APRN key when no APRN licence with that state and number holds it,
 *     else the RN key no RN licence holds.
 * The registry's row for it is never offered as a second, new licence, and
 * the other licence sharing its number still is. Two legacy records on one
 * number answer to both.
 */
export function licenseKeysOnFile(licenses, offered = []) {
  const out = new Set(), held = new Set(), legacy = [];
  const offeredKinds = new Map();
  for (const o of offered || []) {
    if (o?.kind !== "rn" && o?.kind !== "aprn") continue;
    const k = licenseKey(o.state, o.licenseNumber);
    if (k === "|") continue;
    if (!offeredKinds.has(k)) offeredKinds.set(k, new Set());
    offeredKinds.get(k).add(o.kind);
  }
  for (const l of licenses || []) {
    const k = licenseKey(l?.state, l?.licenseNumber);
    if (k === "|") continue;
    const kind = licenseKindOf(l?.type);
    const nursing = NURSING_KIND_OF_TYPE[kind] || "";
    out.add(`${k}|${nursing}`);
    if (nursing) held.add(`${k}|${nursing}`);
    else if (kind === "medical" || kind == null) legacy.push({ k, noted: nursingKindFromNote(l?.notes) });
  }
  const ambiguous = [];
  for (const { k, noted } of legacy) {
    if (noted === "none") continue;
    const fromRegistry = offeredKinds.get(k);
    const n = noted || (fromRegistry?.size === 1 ? [...fromRegistry][0] : "");
    if (!n) { ambiguous.push(k); continue; }
    held.add(`${k}|${n}`);
    out.add(`${k}|${n}`);
  }
  for (const k of ambiguous) {
    const n = ["aprn", "rn"].find((x) => !held.has(`${k}|${x}`));
    if (!n) continue;
    held.add(`${k}|${n}`);
    out.add(`${k}|${n}`);
  }
  return out;
}

/**
 * Turn registry license records into new license items, skipping any the
 * physician already has (matched by state + normalized number, so a hand-typed
 * "35.123456" is not duplicated by the registry's "35123456"). Returns only
 * the items to add; the caller persists them.
 *
 * MD and DO accounts get today's medical licences exactly. PA and NP accounts
 * type each row by its NUCC taxonomy (licenseTypeForNppesRow), take APRN rows
 * first, then PA, RN, medical and the rest, and keep an RN and an APRN row
 * that share a number as two records. A blank account keeps today's result
 * except that a row the taxonomy shows is a PA, APRN or RN licence is typed
 * as one, never as a medical licence.
 */
export function mergeNpiLicenses(existing, found, { degreeType, makeId } = {}) {
  const app = isAdvancedPractice(degreeType);
  const keyOf = (state, number, kind) => app ? `${licenseKey(state, number)}|${kind}` : licenseKey(state, number);
  const offered = (found || []).map((nl) => ({ state: nl?.state, licenseNumber: nl?.licenseNumber, kind: nursingKind(nl?.taxonomyCode) }));
  const have = app ? licenseKeysOnFile(existing, offered) : new Set((existing || []).map(l => keyOf(l?.state, l?.licenseNumber, "")));
  const ORDER = { np: 0, pa: 1, rn: 2, physician: 3 };
  const rank = (nl) => ORDER[professionFromTaxonomy(nl?.taxonomyCode)] ?? 4;
  const rows = app ? [...(found || [])].sort((a, b) => rank(a) - rank(b)) : (found || []);
  const out = [];
  for (const nl of rows) {
    const key = keyOf(nl.state, nl.licenseNumber, nursingKind(nl.taxonomyCode));
    if (!nl.licenseNumber || !nl.state || have.has(key)) continue;
    have.add(key);
    const { type, name } = licenseTypeForNppesRow(nl, degreeType);
    out.push({
      id: (makeId || fallbackId)(),
      type,
      name,
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

