/**
 * Where a document that arrived by email goes, decided from what the scanner
 * read. Pure: the email-inbound edge function fetches the rows, calls
 * planFiling, and performs the writes it returns; node tests every rule
 * (scripts/intake-filing.test.mjs).
 *
 * The rules are the app's own, imported from the copies under ./app/ (see
 * scripts/sync-shared-app-modules.mjs), so a certificate forwarded to docs@
 * lands where the same certificate uploaded in Documents would:
 *
 *   scan type      section            notes
 *   license        licenses
 *   cme            cme
 *   privilege      privileges
 *   insurance      insurance
 *   healthRecord   healthRecords
 *   education      education
 *   travel         travelDocs
 *   agreement      locumContracts     numbers coerced the way the app's save does
 *   other          customRecords      category found as DocumentsSection's
 *                                     "other" branch does; created only when
 *                                     its name is a plain heading (see
 *                                     plainCategoryName), else unfiled
 *   receipt        (unfiled)          the app asks the physician to choose
 *                                     Expenses (and an agency) or Deductions,
 *                                     and that is not a guess to make for them
 *   cv / unknown   (unfiled)          never dropped: it stays in the inbox
 *
 * Only a section's real columns become columns (a single unknown key rejects
 * the whole row); everything else the scan read goes to custom_fields through
 * splitScanned, which withholds patient identifiers, SSNs, full birth dates and
 * account numbers. A record that is already on file (same licence number,
 * same facility, same policy, ...) is added to, never duplicated: empty fields
 * are filled and nothing is overwritten. Two credentials whose numbers differ
 * are never the same record, however much else they share (a second DEA, a
 * renewed passport, a second board certification). An expiration already on
 * the record is never moved by email: the reply names the date the file shows
 * and the physician changes it in the app, because a misread date or a
 * forged renewal that silently extends a licence switches off the reminder
 * that stops it lapsing.
 */
import { SECTION_FIELDS } from "./app/utils/sectionFields.js";
import { findCategory, buildCategory, packRecord, normalizeRecord, toOtherExtracted, sanitizeText, identifierReason, categoryKey } from "./app/utils/customCategories.js";
import { splitScanned } from "./app/utils/scanSplit.js";
import { OTHER_DOC_TYPE, CV_DOC_TYPE } from "./app/utils/scannerCore.js";
import { RECEIPT_DOC_TYPE, normalizeReceipt } from "./app/utils/receiptScan.js";
import { screenDocument } from "./app/utils/phiGuard.js";

// documents.type for a file that arrived at docs@ and is not filed yet. The
// app lists it under "From your inbox, not filed yet" (src/utils/inboxDocs.js).
export const EMAIL_INBOX_DOC_TYPE = "email-inbox";

export const SCAN_SECTION = Object.freeze({
  license: "licenses",
  cme: "cme",
  privilege: "privileges",
  insurance: "insurance",
  healthRecord: "healthRecords",
  education: "education",
  travel: "travelDocs",
  agreement: "locumContracts",
});

export const SECTION_TABLE = Object.freeze({
  licenses: "licenses",
  cme: "cme",
  privileges: "privileges",
  insurance: "insurance",
  healthRecords: "health_records",
  education: "education",
  travelDocs: "travel_docs",
  locumContracts: "locum_contracts",
  customRecords: "custom_records",
  customCategories: "custom_categories",
});

export const SECTION_LABEL = Object.freeze({
  licenses: "Licenses",
  cme: "CME",
  privileges: "Privileges",
  insurance: "Insurance",
  healthRecords: "Health records",
  education: "Education",
  travelDocs: "ID and travel",
  locumContracts: "Contracts",
});

// Columns the app's own scan save writes that SECTION_FIELDS (Vera's list)
// does not name. Every one was checked against production on 2026-09-25.
// travelDocs is not in SECTION_FIELDS at all; its fields are the scan card's.
const APP_SAVE_COLUMNS = Object.freeze({
  healthRecords: ["doses"],
  locumContracts: ["startDate", "endDate", "callHourlyRate"],
  travelDocs: ["type", "name", "provider", "number", "expirationDate", "notes"],
});

// Columns that are NOT NULL in production, and what an unreadable one becomes.
const REQUIRED_DEFAULTS = Object.freeze({
  licenses: { type: "Other" },
  privileges: { type: "Other" },
  insurance: { type: "Other" },
  education: { type: "Other" },
  healthRecords: { category: "Other" },
  cme: { category: "Other" },
});

const JSON_COLUMNS = new Set(["topics", "doses", "coveragePeriods", "callRateGrid"]);
const CONTRACT_NUMBERS = ["hourlyRate", "callHourlyRate", "callStipend", "stipendHours", "overageHourlyRate", "orientationFee", "orientationHourlyRate", "dayRate"];

// Locum contracts are Practice scope (src/utils/limitedLaunchAccess.js
// PRACTICE_COLLECTIONS, and credentialdo_document_scope in SQL, which makes a
// document linked to one Practice scope too). Everything else filed here is
// Credential. The edge function checks the scope before it writes, so a
// Credential-only membership never gets a contract row it could not have
// written from the app.
export const sectionScope = (section) => (section === "locumContracts" ? "practice" : "credential");

/** The camelCase keys that may be written as columns of a section's table. */
export function sectionColumns(section) {
  return [...new Set([...(SECTION_FIELDS[section] || []), ...(APP_SAVE_COLUMNS[section] || [])])];
}

// Types Gemini reads inline. A GIF, TIFF or BMP is stored and left unfiled.
const SCANNABLE = new Set(["application/pdf", "image/png", "image/jpeg", "image/jpg", "image/webp", "image/heic", "image/heif"]);
export const scannableMime = (mime) => SCANNABLE.has(String(mime || "").toLowerCase());

// --- Row shapes -------------------------------------------------------------
const camelToSnake = (k) => k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
const snakeToCamel = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

/** DB row -> the app's camelCase record. */
export function toCamelRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) out[snakeToCamel(k)] = v;
  return out;
}

/** The app's record -> DB row, "" as null exactly like the sync layer's toSnakeObj. */
export function toSnakeRow(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) out[camelToSnake(k)] = v === "" ? null : v;
  return out;
}

// --- Small helpers ----------------------------------------------------------
const isBlank = (v) => v == null || v === "" || (Array.isArray(v) && v.length === 0)
  || (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const validDate = (s) => {
  if (typeof s !== "string" || !ISO_DATE.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
};
const isDateKey = (k) => k === "date" || /Date$/.test(k);
const humanLabel = (k) => String(k).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());

// Model text shown back in an email: controls and markup stripped, and no em
// or en dash, which is house style for anything a physician reads.
const DASHES = /[\u{2013}\u{2014}]/gu;
export const plain = (v, max = 120) => sanitizeText(v, max).replace(DASHES, "-");

const normKey = (v) => String(v ?? "").toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "")
  .replace(/[^a-z0-9]+/g, " ").trim();
const normNumber = (v) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const FACILITY_NOISE = new Set(["the", "inc", "llc", "llp", "pc", "pllc", "pa", "corp", "corporation", "co", "company", "ltd", "of", "and"]);
const normFacility = (v) => normKey(v).split(" ").filter((t) => t && !FACILITY_NOISE.has(t)).join(" ");
const same = (a, b, f = normKey) => { const x = f(a); return !!x && x === f(b); };
// Both sides carry an identifying number and the numbers differ: two
// credentials, whatever else they share.
const numbersConflict = (a, b) => { const x = normNumber(a), y = normNumber(b); return !!x && !!y && x !== y; };
// Types that name a kind of credential rather than one credential. Two board
// certifications share "Board Certification (ABMS)" and are two records; the
// name tells them apart.
const GENERIC_TYPES = new Set(["", "other", "certification", "certificate", "board certification", "board certification abms", "board certification aoa"]);

/** "2026-09-24" -> "09/24/2026". */
export function usDate(iso) {
  if (!validDate(iso)) return String(iso ?? "");
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}

// "Credentialing Approval" reads better in a sentence as "credentialing
// approval"; "DEA Registration" must keep its capitals.
function softCase(s) {
  const words = String(s || "").split(/\s+/).filter(Boolean);
  if (words.length && words.every((w) => /^[A-Z][a-z'()-]*$/.test(w) || /^(?:of|and|for|the|in|to|a)$/.test(w))) return words.join(" ").toLowerCase();
  return words.join(" ");
}

// --- Where a scan goes ------------------------------------------------------

/**
 * { kind: "section", section } | { kind: "custom" } |
 * { kind: "unfiled", reason: "receipt" | "cv" | "unknown" | "error" }
 */
export function filingTarget(scan) {
  const t = scan && typeof scan === "object" ? scan.documentType : null;
  if (!t) return { kind: "unfiled", reason: "error" };
  if (SCAN_SECTION[t]) return { kind: "section", section: SCAN_SECTION[t] };
  if (t === OTHER_DOC_TYPE) return { kind: "custom" };
  if (t === RECEIPT_DOC_TYPE) return { kind: "unfiled", reason: "receipt" };
  if (t === CV_DOC_TYPE) return { kind: "unfiled", reason: "cv" };
  return { kind: "unfiled", reason: "unknown" };
}

// --- Built-in sections ------------------------------------------------------

/**
 * What a scan of a built-in type becomes: { placed, extras, withheld }, with
 * placed holding only real columns and every value in a shape its column
 * accepts. Anything that would be rejected (a date that is not a date, hours
 * that are not a number) is kept in extras rather than dropped.
 */
export function builtInFields(section, extracted) {
  const ex = extracted && typeof extracted === "object" && !Array.isArray(extracted) ? { ...extracted } : {};
  const { placed, extras, withheld } = splitScanned(ex, sectionColumns(section));
  const putExtra = (label, value) => {
    const text = sanitizeText(Array.isArray(value) ? value.join(", ") : typeof value === "object" ? JSON.stringify(value) : value);
    if (!text) return;
    const why = identifierReason(label, text);
    if (why) { withheld.push({ label, reason: why }); return; }
    let k = label, n = 2;
    while (Object.hasOwn(extras, k)) k = `${label} (${n++})`;
    extras[k] = text;
  };
  for (const k of Object.keys(placed)) {
    const v = placed[k];
    // locum_contracts keeps its start and end as text; every other date key
    // is a date column, and one bad date rejects the whole row.
    const textDate = section === "locumContracts" && (k === "startDate" || k === "endDate");
    if (isDateKey(k) && !textDate && !validDate(String(v))) { putExtra(humanLabel(k), v); delete placed[k]; continue; }
    if (JSON_COLUMNS.has(k)) {
      if (!Array.isArray(v)) { putExtra(humanLabel(k), v); delete placed[k]; }
      continue;
    }
    if (v && typeof v === "object") { putExtra(humanLabel(k), v); delete placed[k]; }
  }
  if (section === "cme") {
    if ("hours" in placed) {
      const n = typeof placed.hours === "number" ? placed.hours : parseFloat(String(placed.hours).replace(/[^0-9.]/g, ""));
      if (Number.isFinite(n)) placed.hours = n; else { putExtra("Hours", placed.hours); delete placed.hours; }
    }
    placed.topics = Array.isArray(placed.topics) ? placed.topics.filter((t) => typeof t === "string" && t.trim()) : [];
  }
  if (section === "locumContracts") {
    // The app's own save (DocumentsSection.handleSave): contract terms drive
    // billing math, so every rate is a number and the increments default to 15.
    for (const k of CONTRACT_NUMBERS) {
      if (!(k in placed)) continue;
      const n = parseFloat(String(placed[k]).replace(/[$,\s]/g, ""));
      placed[k] = Number.isFinite(n) ? n : 0;
    }
    placed.incrementMinutes = parseInt(placed.incrementMinutes, 10) || 15;
    placed.minCallMinutes = parseInt(placed.minCallMinutes, 10) || 15;
  }
  return { placed, extras, withheld };
}

/**
 * The record already on file that this scan is another copy of, or null.
 * The first rule of each section is the identifying number; every fallback
 * after it is refused when both sides carry a number and the numbers differ,
 * so a second DEA, a renewed passport or a new malpractice policy becomes a
 * record of its own instead of rewriting the old one.
 */
export function findExisting(section, fields, rows) {
  const f = fields || {};
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === "object").map(toCamelRow);
  const hit = (pred) => list.find((r) => pred(r)) || null;
  switch (section) {
    case "licenses":
      return hit((r) => same(f.licenseNumber, r.licenseNumber, normNumber))
        || hit((r) => !numbersConflict(f.licenseNumber, r.licenseNumber)
          && same(f.type, r.type) && normKey(f.state) === normKey(r.state)
          // A state tells two licences of one type apart. With no state on
          // either side (a board certification, a BLS card), or a type that
          // names a kind of credential, only the same name does.
          && ((normKey(f.state) !== "" && !GENERIC_TYPES.has(normKey(f.type))) || same(f.name, r.name)));
    case "privileges":
      return hit((r) => same(f.facility, r.facility, normFacility));
    case "insurance":
      return hit((r) => same(f.policyNumber, r.policyNumber, normNumber))
        || hit((r) => !numbersConflict(f.policyNumber, r.policyNumber)
          && same(f.provider, r.provider, normFacility) && same(f.type, r.type));
    case "education":
      return hit((r) => same(f.type, r.type) && same(f.institution, r.institution, normFacility));
    case "cme":
      return hit((r) => !numbersConflict(f.certificateNumber, r.certificateNumber) && same(f.title, r.title) && same(f.date, r.date));
    case "healthRecords":
      return hit((r) => same(f.type, r.type) && same(f.dateAdministered, r.dateAdministered));
    case "travelDocs":
      // A renewed passport always carries a new number: it is a new record,
      // not the old one with a later date and a cancelled number.
      return hit((r) => same(f.number, r.number, normNumber))
        || hit((r) => !numbersConflict(f.number, r.number) && same(f.type, r.type) && same(f.provider, r.provider));
    case "locumContracts":
      return hit((r) => same(f.facility, r.facility, normFacility) && same(f.startDate, r.startDate));
    default:
      return null;
  }
}

/**
 * The sentence for a file whose expiration is later than the record's. The
 * record's date is never moved by email (see the header): the physician is
 * told what the file shows and changes it in the app.
 */
export function laterDateNote(fileDate, recordDate) {
  return `This file shows an expiration of ${usDate(fileDate)}; your record shows ${usDate(recordDate)}. The date on your record was not changed: open the app to update it if the file is the newer one.`;
}

/**
 * Fill only what is empty on the record. An expiration fills an empty one;
 * an expiration already there is never moved, and a later one in the file
 * comes back as `note` for the reply. Returns the camelCase changes
 * (possibly none), a few words on what happened, and the note ("" if none).
 */
export function fillEmpty(existing, placed, extras) {
  const ex = existing || {};
  const changes = {};
  const said = [];
  let note = "";
  let filled = 0;
  for (const [k, v] of Object.entries(placed || {})) {
    if (k === "expirationDate") continue;
    if (isBlank(v) || !isBlank(ex[k])) continue;
    changes[k] = v;
    filled++;
  }
  const next = placed?.expirationDate;
  if (validDate(next)) {
    const was = String(ex.expirationDate ?? "").slice(0, 10);
    if (isBlank(ex.expirationDate)) { changes.expirationDate = next; filled++; }
    else if (validDate(was) && next > was) note = laterDateNote(next, was);
  }
  const current = ex.customFields && typeof ex.customFields === "object" && !Array.isArray(ex.customFields) ? ex.customFields : {};
  const added = Object.fromEntries(Object.entries(extras || {}).filter(([k]) => !Object.hasOwn(current, k)));
  if (Object.keys(added).length) {
    changes.customFields = { ...added, ...current };
    filled += Object.keys(added).length;
  }
  if (filled) said.push(`filled ${filled} empty field${filled === 1 ? "" : "s"}`);
  return { changes, said, note };
}

// --- Labels -----------------------------------------------------------------

/** [primary, secondary] words that name a record, for the file name and the email. */
function nameParts(section, f) {
  const typeWord = (t) => (t && !GENERIC_TYPES.has(normKey(t)) ? softCase(plain(t, 60)) : "");
  switch (section) {
    case "licenses": return [plain(f.name, 80) || plain(f.type, 80) || "License", f.name ? "" : plain(f.state, 4)];
    case "privileges": {
      const primary = plain(f.facility, 80) || plain(f.name, 80) || "Privileges";
      const second = typeWord(f.type) || (f.name && plain(f.name, 80) !== primary ? softCase(plain(f.name, 80)) : "privileges");
      return [primary, second];
    }
    case "insurance": return [plain(f.provider, 80) || plain(f.name, 80) || "Insurance", typeWord(f.type) || (f.provider ? softCase(plain(f.name, 80)) : "")];
    case "cme": return [plain(f.title, 100) || "CME certificate", ""];
    case "healthRecords": return [plain(f.name, 80) || plain(f.type, 80) || plain(f.category, 40) || "Health record", ""];
    case "education": return [plain(f.name, 80) || [plain(f.type, 60), plain(f.institution, 60)].filter(Boolean).join(" - ") || "Education", ""];
    case "travelDocs": return [plain(f.name, 80) || plain(f.type, 60) || "ID document", ""];
    case "locumContracts": return [plain(f.facility, 80) || plain(f.agency, 80) || "Contract", "agreement"];
    default: return [plain(f.name, 80) || "Document", ""];
  }
}

const joinParts = (parts, sep) => {
  const [a, b] = parts;
  if (!b || normKey(a).includes(normKey(b))) return a;
  return `${a}${sep}${b}`;
};

/** A readable document name that keeps the original extension. */
export function docLabel(parts, fileName) {
  const ext = (String(fileName || "").match(/\.[A-Za-z0-9]{1,5}$/)?.[0] || "").toLowerCase();
  // deno-lint-ignore no-control-regex
  const base = joinParts(parts, " - ").replace(/[\\/:*?"<>|\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return base ? `${base}${ext}` : String(fileName || "document");
}

const PRIMARY_DATE = {
  licenses: ["issuedDate", "issued"],
  privileges: ["appointmentDate", "approved"],
  insurance: ["effectiveDate", "effective"],
  cme: ["date", "completed"],
  healthRecords: ["dateAdministered", "given"],
  education: ["graduationDate", "graduated"],
  locumContracts: ["startDate", "starts"],
  customRecords: ["issuedDate", "issued"],
};

function details(section, f) {
  const out = [];
  if (section === "cme" && Number.isFinite(f.hours) && f.hours > 0) out.push(`${f.hours} hour${f.hours === 1 ? "" : "s"}`);
  const [key, word] = PRIMARY_DATE[section] || [];
  if (key && validDate(f[key])) out.push(`${word} ${usDate(f[key])}`);
  if (validDate(f.expirationDate)) out.push(`expires ${usDate(f.expirationDate)}`);
  return out;
}

const withDetails = (text, d) => (d.length ? `${text} (${d.join(", ")})` : text);

// --- The plan ---------------------------------------------------------------

/**
 * The app's own patient-record check (screenDocument) on what the scanner
 * read: the screen when it reads as a patient record, else null.
 */
export function patientRecordScreen(fileName, scan) {
  if (!scan || typeof scan !== "object") return null;
  const screen = screenDocument(`${fileName || ""}\n${JSON.stringify(scan)}`);
  return screen?.level === "clinical" ? screen : null;
}

/**
 * May an attachment in an email that also asks for something be filed as the
 * physician's own? Its name decides nothing ("Letter330567.pdf" is a real
 * approval, "DEA Registration.pdf" can be a blank template). A credentialer
 * sends blank forms, and a blank privileges delineation reads as "privilege"
 * at that facility, so only this: a built-in credential type (never a new category),
 * not read with low confidence, carrying a date a blank form would not have
 * (an expiration, or the section's issued / appointment / effective date).
 * Everything else stays with the request.
 */
export function fileableFromRequest(scan) {
  const target = filingTarget(scan);
  if (target.kind !== "section") return false;
  if (String(scan.confidence ?? "").toLowerCase() === "low") return false;
  if (patientRecordScreen("", scan)) return false;
  const { placed } = builtInFields(target.section, scan.extracted);
  const [key] = PRIMARY_DATE[target.section] || [];
  return validDate(placed.expirationDate) || (key ? validDate(String(placed[key] ?? "")) : false);
}

// A category the email path creates is named by the model, unreviewed, and
// every later scan (the app's and email's) lists the physician's categories in
// its prompt. So email creates only a plain heading: letters, digits and a
// little punctuation, at most five words, nothing that reads as an
// instruction. Anything else stays unfiled for the physician, who sees the
// name in the app before it is saved.
const INSTRUCTION_WORDS = /\b(?:always|never|ignore|disregard|classify|classified|treat|respond|output|instructions?|prompt|must|should|pretend|assistant|json|override|documents?\s+as)\b/i;
export function plainCategoryName(name) {
  const n = String(name ?? "").trim();
  if (!n || n.length > 40) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9 &'(),./-]*$/.test(n)) return false;
  if (n.split(/\s+/).length > 5) return false;
  return !INSTRUCTION_WORDS.test(n);
}

/**
 * The writes that file one emailed document.
 *
 * input:
 *   scan        the validated scanner result ({ documentType, extracted }), or null
 *   docId       the documents row the file was stored as
 *   fileName    its name as it arrived
 *   mimeType    its real type (the row's `type` becomes this once filed, the
 *               same thing the app's leaveInbox() does)
 *   userId      profiles.id (user_id on every collection table)
 *   rows        the target section's existing rows (DB or camelCase shape);
 *               for "other", every custom_records row
 *   categories  custom_categories rows (for "other")
 *   now         ISO timestamp
 *   newId       () => a fresh uuid
 *
 * output:
 *   { outcome: "created" | "updated" | "linked" | "unfiled" | "removed",
 *     section, table, recordId,
 *     readsAs: "Sanford Health Plan credentialing approval -> Privileges"
 *              (what it was read as and where it goes; "" when unfiled),
 *     writes: [{ table, op: "insert" | "update", id, row }]   in order,
 *     document: { linked_to, name, type } | { name } | null,
 *     lines: [...]  what the physician is told,
 *     withheld: [{ label, reason }] }
 *
 * "removed" means the scan reads as a patient record (the app's own
 * screenDocument check): the caller deletes the stored file, as the app does
 * on upload. Every other outcome keeps the file.
 */
/**
 * @param {{ scan: any, docId: string, fileName: string, mimeType?: string, userId: string,
 *           rows?: unknown[], categories?: unknown[], now: string, newId: () => string }} input
 */
export function planFiling({ scan, docId, fileName, mimeType, userId, rows = [], categories = [], now, newId }) {
  const name = plain(fileName, 120) || "document";
  const unfiled = (reason, extra = {}) => ({
    outcome: "unfiled", section: null, table: null, recordId: null, writes: [], document: extra.document || null,
    lines: [unfiledLine(name, reason, scan)], withheld: [], reason,
  });

  if (scan && typeof scan === "object") {
    const screen = patientRecordScreen(fileName, scan);
    if (screen) {
      return {
        outcome: "removed", section: null, table: null, recordId: null, writes: [], document: null, withheld: [],
        lines: [`Not kept: ${name} reads like a patient record (it contains ${screen.reasons.join(" and ")}). CredentialDOMD holds your credentials, not patient charts, so the file was deleted. Forward the credential itself instead.`],
      };
    }
  }

  const target = filingTarget(scan);
  if (target.kind === "unfiled") {
    if (target.reason === "receipt") {
      const r = normalizeReceipt(scan.extracted);
      const label = docLabel([`Receipt - ${plain(r.merchant, 60) || "expense"}`, r.date || ""], fileName);
      return unfiled("receipt", { document: { name: label } });
    }
    return unfiled(target.reason);
  }
  if (target.kind === "custom") return planCustom({ scan, docId, fileName, mimeType, userId, rows, categories, now, newId, name });

  const section = target.section;
  const table = SECTION_TABLE[section];
  const { placed, extras, withheld } = builtInFields(section, scan.extracted);
  const parts = nameParts(section, placed);
  const display = joinParts(parts, " ");
  const label = SECTION_LABEL[section];
  const linkTo = (id) => ({ linked_to: `${section}:${id}`, name: docLabel(parts, fileName), type: mimeType || "application/octet-stream" });
  const withheldLine = withheldNote(withheld);

  const existing = findExisting(section, placed, rows);
  if (existing) {
    const { changes, said, note } = fillEmpty(existing, placed, extras);
    const writes = Object.keys(changes).length
      ? [{ table, op: "update", id: existing.id, row: { ...toSnakeRow(changes), updated_at: now } }]
      : [];
    const merged = { ...existing, ...changes };
    const what = said.length ? said.join(", ") : "the file is now attached to it";
    return {
      outcome: writes.length ? "updated" : "linked", section, table, recordId: existing.id, writes,
      readsAs: `${joinParts(nameParts(section, merged), " ")} -> ${label}`,
      document: linkTo(existing.id),
      lines: [`Added to an existing record: ${joinParts(nameParts(section, merged), " ")} -> ${label} (${what})`, ...(note ? [note] : []), ...withheldLine],
      withheld,
    };
  }

  const id = newId();
  const record = {
    ...(REQUIRED_DEFAULTS[section] || {}),
    ...placed,
    id,
    userId,
    customFields: extras,
    favorite: false,
    createdAt: now,
    updatedAt: now,
  };
  for (const [k, v] of Object.entries(REQUIRED_DEFAULTS[section] || {})) if (isBlank(record[k])) record[k] = v;
  return {
    outcome: "created", section, table, recordId: id, readsAs: `${display} -> ${label}`,
    writes: [{ table, op: "insert", id, row: toSnakeRow(record) }],
    document: linkTo(id),
    lines: [withDetails(`Filed: ${display} -> ${label}`, details(section, placed)), ...withheldLine],
    withheld,
  };
}

function planCustom({ scan, docId, fileName, mimeType, userId, rows, categories, now, newId, name }) {
  const table = SECTION_TABLE.customRecords;
  const start = toOtherExtracted(scan.extracted);
  const suggested = start.suggestedCategory && typeof start.suggestedCategory === "object" ? start.suggestedCategory : {};
  const cats = (Array.isArray(categories) ? categories : []).filter((c) => c && typeof c === "object").map(toCamelRow);
  const writes = [];
  const lines = [];

  // DocumentsSection's "other" branch: reuse a category with the same name
  // (case, plural and word order do not matter, archived ones included),
  // otherwise create it with origin "uploader"; filing into a hidden category
  // brings it back rather than putting the record somewhere nobody looks.
  const wanted = plain(suggested.name, 60) || "Other documents";
  let category = findCategory(cats, wanted);
  if (category) {
    const raw = cats.find((c) => c.id === category.id);
    if (raw?.archivedAt) {
      writes.push({ table: SECTION_TABLE.customCategories, op: "update", id: category.id, row: { archived_at: null, updated_at: now } });
      lines.push(`Brought back your hidden category: ${plain(category.name, 60)}`);
    }
  } else {
    // The suggested name is never echoed back when it is refused: it is
    // model text, and the refusal is for text that should not be repeated.
    const refused = () => ({ outcome: "unfiled", section: null, table: null, recordId: null, writes: [], document: null, withheld: [], reason: "category", lines: [unfiledLine(name, "category", scan)] });
    if (!plainCategoryName(wanted)) return refused();
    let built;
    try {
      built = buildCategory({ name: wanted, icon: suggested.icon || "", fields: suggested.fields || [] }, { id: newId(), origin: "uploader", now });
    } catch {
      return refused();
    }
    category = built;
    writes.push({
      table: SECTION_TABLE.customCategories, op: "insert", id: built.id,
      row: toSnakeRow({ ...built, userId, customFields: {}, favorite: false, createdAt: now, updatedAt: now }),
    });
    lines.push(`Created a new category: ${plain(built.name, 60)}`);
  }

  const input = {
    name: start.name, issuer: start.issuer, number: start.number,
    issuedDate: start.issuedDate, expirationDate: start.expirationDate, facts: start.facts,
  };
  const recs = (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r === "object").map(toCamelRow).map(normalizeRecord).filter(Boolean);
  const { record: incoming, withheld } = packRecord(category, input, {});
  // The same number is the same record. The same name is only when the
  // numbers do not disagree and the name is not just the category's own
  // (packRecord names a record after its category when the scan gave no
  // name, so two hospitals' badges would both be "Hospital ID Badges").
  const catKey = categoryKey(category.name);
  const existing = recs.find((r) => r.categoryId === category.id
    && ((incoming.number && same(incoming.number, r.number, normNumber))
      || (incoming.name && same(incoming.name, r.name) && categoryKey(incoming.name) !== catKey
        && !numbersConflict(incoming.number, r.number))));
  const catName = plain(category.name, 60);
  const withheldLine = withheldNote(withheld);
  const parts = [plain(incoming.name, 80) || catName, ""];
  const linkTo = (id) => ({ linked_to: `customRecords:${id}`, name: docLabel(parts, fileName), type: mimeType || "application/octet-stream" });

  if (existing) {
    const changes = {};
    const said = [];
    let filled = 0;
    for (const k of ["name", "issuer", "number", "issuedDate", "notes"]) {
      if (!isBlank(incoming[k]) && isBlank(existing[k])) { changes[k] = incoming[k]; filled++; }
    }
    let note = "";
    if (validDate(incoming.expirationDate)) {
      const was = String(existing.expirationDate || "").slice(0, 10);
      if (isBlank(existing.expirationDate)) { changes.expirationDate = incoming.expirationDate; filled++; }
      else if (validDate(was) && incoming.expirationDate > was) note = laterDateNote(incoming.expirationDate, was);
    }
    const addNew = (cur, inc) => Object.fromEntries(Object.entries(inc || {}).filter(([k, v]) => !isBlank(v) && !Object.hasOwn(cur || {}, k)));
    const fv = addNew(existing.fieldValues, incoming.fieldValues);
    if (Object.keys(fv).length) { changes.fieldValues = { ...existing.fieldValues, ...fv }; filled += Object.keys(fv).length; }
    const cf = addNew(existing.customFields, incoming.customFields);
    if (Object.keys(cf).length) { changes.customFields = { ...existing.customFields, ...cf }; filled += Object.keys(cf).length; }
    if (!existing.documentIds.includes(docId)) changes.documentIds = [...existing.documentIds, docId];
    if (filled) said.push(`filled ${filled} empty field${filled === 1 ? "" : "s"}`);
    writes.push({ table, op: "update", id: existing.id, row: { ...toSnakeRow(changes), updated_at: now } });
    return {
      outcome: "updated", section: "customRecords", table, recordId: existing.id, writes,
      readsAs: `${plain(existing.name, 80) || catName} -> ${catName}`,
      document: linkTo(existing.id), withheld,
      lines: [...lines, `Added to an existing record: ${plain(existing.name, 80) || catName} -> ${catName} (${said.length ? said.join(", ") : "the file is now attached to it"})`, ...(note ? [note] : []), ...withheldLine],
    };
  }

  const id = newId();
  const { record } = packRecord(category, { ...input, documentIds: docId ? [docId] : [] }, { id });
  writes.push({ table, op: "insert", id, row: toSnakeRow({ ...record, userId, favorite: false, createdAt: now, updatedAt: now }) });
  return {
    outcome: "created", section: "customRecords", table, recordId: id, writes,
    readsAs: `${plain(record.name, 80) || catName} -> ${catName}`,
    document: linkTo(id), withheld,
    lines: [...lines, withDetails(`Filed: ${plain(record.name, 80) || catName} -> ${catName}`, details("customRecords", record)), ...withheldLine],
  };
}

function withheldNote(withheld) {
  const reasons = [...new Set((withheld || []).map((w) => w.reason))];
  if (!reasons.length) return [];
  return [`Left out on purpose: ${reasons.join(", ")}. CredentialDOMD does not keep patient identifiers, Social Security numbers, full birth dates or account numbers.`];
}

/**
 * The one line for a file that stays in the inbox. readsAs (for an
 * unverified forward) is what the scan made of it, so the physician still
 * learns where it would go.
 */
export function unfiledLine(name, reason, scan, readsAs = "") {
  const tail = "(open the app > Documents to file it)";
  if (reason === "receipt") {
    const r = normalizeReceipt(scan?.extracted);
    const what = [r.merchant ? `from ${plain(r.merchant, 60)}` : "", r.total > 0 ? `for $${r.total.toFixed(2)}` : "", validDate(r.date) ? `on ${usDate(r.date)}` : ""].filter(Boolean).join(" ");
    return `Saved, not filed yet: ${name}, a receipt${what ? ` ${what}` : ""} ${tail}. A receipt goes to Expenses or to Deductions, and that is your choice.`;
  }
  if (reason === "cv") return `Saved, not filed yet: ${name} looks like your CV ${tail}. File with AI reads it into your record.`;
  if (reason === "category") return `Saved, not filed yet: ${name} fits none of your sections, and a new category is not created from email without you seeing its name ${tail}.`;
  if (reason === "unverified") return `Saved, not filed yet: ${name}${readsAs ? `, which reads as ${readsAs}` : ""}. This message could not be verified as coming from you, so nothing in your records was added or changed ${tail}.`;
  return `Saved, not filed yet: ${name} ${tail}`;
}

/**
 * The physician's confirmation, plain text with real line breaks.
 * results: [{ lines: [...] }]; notes: extra sentences (skips, failures).
 * @param {{ results?: Array<{ lines?: string[] }>, notes?: string[], appUrl: string, footer?: string, tip?: string }} input
 */
export function filingReplyText({ results = [], notes = [], appUrl, footer = "CredentialDOMD\nhttps://credentialdomd.com", tip = "" }) {
  const lines = results.flatMap((r) => r.lines || []);
  const parts = [];
  if (lines.length) parts.push(`Got it. Here is where ${lines.length === 1 && results.length === 1 ? "it" : "everything"} went:\n\n${lines.join("\n")}`);
  else parts.push("Nothing new was added to your Documents.");
  if (notes.length) parts.push(notes.join("\n"));
  if (tip) parts.push(tip);
  parts.push(`Open the app: ${appUrl} (Documents)`);
  parts.push(footer);
  return parts.join("\n\n").replace(DASHES, "-");
}
