// Categories the physician, Vera or the uploader create for information no
// built-in section holds.
//
// A category is a ROW in custom_categories, never a table or a column; a
// record filed in it is a ROW in custom_records. Nothing here ever changes the
// database schema. Per-category values live inside the record's fieldValues
// jsonb, because the sync layer writes every top-level key of a record as a
// column (toSnakeObj) and a single unknown column rejects the WHOLE row, which
// then lives on one device only.
//
// This module is pure and imports nothing that touches the network, so every
// rule in it is unit tested under plain node. Keep it that way.

import { SECTION_FIELDS, BUILT_IN_SECTIONS } from "./sectionFields.js";

// ── Limits ────────────────────────────────────────────────────────────────
// Text written here is shown back to Vera in her snapshot, so a scanned
// document could otherwise plant instructions in a category name or label.
// Short caps plus sanitising keep that surface small.
export const LIMITS = Object.freeze({
  name: 60, label: 40, description: 160, icon: 8, fields: 24, value: 2000, aliases: 8,
});

// Sections a proposal may write to with create_record / update_record. Each has
// a known field list AND a custom_fields column, so overflow always has a home.
// customCategories is deliberately absent: a category is created ONLY through
// create_category, which dedupes and screens it.
export const WRITABLE_SECTIONS = Object.freeze([...Object.keys(SECTION_FIELDS), "customRecords"]);

// custom_records columns that hold a record's common facts directly.
export const ROLE_KEYS = Object.freeze(["name", "issuer", "number", "issuedDate", "expirationDate", "notes"]);
export const ROLE_LABELS = Object.freeze({
  name: "Name", issuer: "Issued by", number: "Number / ID",
  issuedDate: "Issued", expirationDate: "Expires", notes: "Notes",
});

// Every top-level key a custom record may carry. Anything else would be sent
// as a column that does not exist and reject the whole row.
export const RECORD_COLUMNS = Object.freeze([
  "id", "categoryId", "categoryName", "fieldLabels", ...ROLE_KEYS,
  "fieldValues", "customFields", "documentIds", "favorite", "createdAt", "updatedAt",
]);
export const CATEGORY_COLUMNS = Object.freeze([
  "id", "name", "slug", "icon", "description", "fields", "aliases", "origin",
  "sortOrder", "archivedAt", "customFields", "favorite", "createdAt", "updatedAt",
]);

export const FIELD_TYPES = Object.freeze(["text", "textarea", "date", "number", "url"]);

// ── Text hygiene ──────────────────────────────────────────────────────────
export function sanitizeText(value, max = LIMITS.value) {
  if (value === null || value === undefined) return "";
  let s = typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
  s = s.normalize("NFKC")
    // Matching control characters is the point: they are what gets stripped.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, " ")  // controls, zero-width, line separators
    .replace(/[{}<>`]/g, "")                                                 // template and markup characters
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? s.slice(0, max).trim() : s;
}

// ── Dedupe key ────────────────────────────────────────────────────────────
// "Hospital ID Badges", "hospital id badge" and "Badges (Hospital ID)" must be
// one category. Sorted, singularised, stop-worded tokens.
const STOP = new Set(["a", "an", "the", "of", "and", "or", "for", "my", "to", "in", "on", "record", "records", "document", "documents", "info", "information"]);
const singular = (t) => (t.length > 4 && t.endsWith("ies")) ? t.slice(0, -3) + "y"
  : (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") && !t.endsWith("us")) ? t.slice(0, -1) : t;

export function categoryKey(name) {
  const tokens = sanitizeText(name, 200).toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ").filter(Boolean)
    .filter(t => !STOP.has(t))
    .map(singular);
  return [...new Set(tokens)].sort().join(" ");
}

// ── Readers that never throw ──────────────────────────────────────────────
// custom_categories.fields and custom_records.field_values are free jsonb. A
// hand-edited restore, a future version or a bad write can put anything there,
// and these values are read on every render, so every reader is total.
export function normalizeField(f, i = 0) {
  if (!f || typeof f !== "object") return null;
  const label = sanitizeText(f.label || f.key || `Field ${i + 1}`, LIMITS.label);
  const key = typeof f.key === "string" && /^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(f.key) && !RECORD_COLUMNS.includes(f.key) ? f.key : fieldKey(label);
  if (!key) return null;
  const type = FIELD_TYPES.includes(f.type) ? f.type : "text";
  const out = { key, label: label || key, type };
  if (f.removedAt) out.removedAt = String(f.removedAt);
  return out;
}

export function normalizeCategory(c) {
  if (!c || typeof c !== "object" || typeof c.id !== "string" || !c.id) return null;
  const name = sanitizeText(c.name, LIMITS.name) || "Untitled category";
  const fields = [];
  const seen = new Set(RECORD_COLUMNS);
  for (const [i, raw] of (Array.isArray(c.fields) ? c.fields : []).entries()) {
    const f = normalizeField(raw, i);
    if (!f || seen.has(f.key)) continue;
    seen.add(f.key);
    fields.push(f);
    if (fields.length >= LIMITS.fields) break;
  }
  return {
    ...c,
    name,
    slug: typeof c.slug === "string" && c.slug ? c.slug : categoryKey(name),
    icon: sanitizeText(c.icon, LIMITS.icon) || "\u{1F5C2}\uFE0F",
    description: sanitizeText(c.description, LIMITS.description),
    fields,
    aliases: (Array.isArray(c.aliases) ? c.aliases : []).map(a => sanitizeText(a, LIMITS.name)).filter(Boolean).slice(0, LIMITS.aliases),
    archivedAt: c.archivedAt || null,
  };
}

export function normalizeRecord(r) {
  if (!r || typeof r !== "object" || typeof r.id !== "string" || !r.id) return null;
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
  return {
    ...r,
    fieldValues: obj(r.fieldValues),
    fieldLabels: obj(r.fieldLabels),
    customFields: obj(r.customFields),
    documentIds: Array.isArray(r.documentIds) ? r.documentIds.filter(x => typeof x === "string") : [],
  };
}

/** Live categories, oldest first so a newly created one never reorders the rail. */
export function liveCategories(data) {
  return (Array.isArray(data?.customCategories) ? data.customCategories : [])
    .map(normalizeCategory).filter(Boolean)
    .filter(c => !c.archivedAt)
    .sort((a, b) => (Date.parse(a.createdAt || "") || 0) - (Date.parse(b.createdAt || "") || 0) || a.name.localeCompare(b.name));
}

export function recordsIn(data, categoryId) {
  return (Array.isArray(data?.customRecords) ? data.customRecords : [])
    .map(normalizeRecord).filter(Boolean)
    .filter(r => r.categoryId === categoryId);
}

/** Records whose category is missing or archived, so nothing is ever unreachable. */
export function unsortedRecords(data) {
  const live = new Set(liveCategories(data).map(c => c.id));
  return (Array.isArray(data?.customRecords) ? data.customRecords : [])
    .map(normalizeRecord).filter(Boolean)
    .filter(r => !live.has(r.categoryId));
}

// ── Finding an existing category ──────────────────────────────────────────
// Matches archived categories too, so re-filing a badge next year revives the
// old category instead of creating a twin.
export function findCategory(categories, name) {
  const key = categoryKey(name);
  if (!key) return null;
  for (const raw of Array.isArray(categories) ? categories : []) {
    const c = normalizeCategory(raw);
    if (!c) continue;
    if (c.slug === key || categoryKey(c.name) === key) return c;
    if (c.aliases.some(a => categoryKey(a) === key)) return c;
  }
  return null;
}

// ── Field keys ────────────────────────────────────────────────────────────
export function fieldKey(label, taken = new Set()) {
  const words = sanitizeText(label, 80).normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return "";
  let key = words.map((w, i) => i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()).join("");
  if (!/^[a-z]/.test(key)) key = "f" + key;
  key = key.slice(0, 36);
  let out = key, n = 2;
  while (taken.has(out) || RECORD_COLUMNS.includes(out)) out = `${key}${n++}`;
  return out;
}

// ── Identifiers that must never reach the cloud ───────────────────────────
// CredentialDOMD is no-PHI by design. "File everything" on an unclassifiable
// document is exactly how 1,380 MRNs reached case logs in August 2026, so every
// fact passes this gate on the way in. It matches PHRASES, not bare words:
// "Patient Safety Committee" is a real reappointment item and must survive.
const IDENTIFIER_LABELS = [
  [/\b(mrn|medical\s+record(\s+(number|no\.?|#))?|med\s+rec)\b|\bmr\s*#/i, "a medical record number"],
  [/\bchart\s*(#|no\.?|number)/i, "a medical record number"],
  [/^\s*(patient|pt)(\s+name)?\s*:?\s*$|\bpt\s+(name|id|number)\b/i, "a patient identifier"],
  [/\bpatient\s+(name|id|identifier|number|no\.?|dob|date\s+of\s+birth|sticker|label|address|phone)\b/i, "a patient identifier"],
  [/\b(social\s+security|ssn|soc\.?\s*sec\.?|ss\s*no\.?)\b|\bss\s*#/i, "a Social Security number"],
  // An individual's taxpayer ID is their SSN; a W-9 is uploaded constantly by
  // locum physicians. Withheld on the label, whatever the number looks like.
  [/\b(tin|taxpayer\s+id(entification)?(\s+(number|no\.?))?|tax\s*id(\s+(number|no\.?))?)\b/i, "a Social Security number"],
  [/\b(date\s+of\s+birth|birth\s*date|dob|d\s*o\s*b)\b|^\s*(born|birthday)\s*$/i, "a full date of birth"],
  [/\b(account|acct)\.?\s*(number|no\.?|#)\b/i, "an account number"],
  [/\bencounter\s+(number|no\.?|#)\b/i, "an encounter number"],
  [/\b(driver'?s?\s+licen[cs]e|passport)\s*(number|no\.?|#)?\b/i, "a driver's licence or passport number"],
];
// Three digit groups split by any separator: 123-45-6789, 123 45 6789,
// 123.45.6789, en or em dashes. A bare nine-digit run is NOT enough on its
// own: badge, policy and licence numbers are often nine digits.
const DASHES = "\\-\u2010-\u2015";
const SSN_VALUE = new RegExp(`(?<!\\d)\\d{3}[\\s.${DASHES}]\\d{2}[\\s.${DASHES}]\\d{4}(?!\\d)`);
const SSN_WORDS = /\b(ssn|ss\s*#|social\s+security|soc\.?\s*sec|tin|taxpayer|tax\s*id)\b/i;
const NINE_DIGITS = /(?<!\d)\d{3}\D{0,3}\d{2}\D{0,3}\d{4}(?!\d)/;
// Keyword then a number or date inside free text: "MRN 00481234", "DOB 3/14/61".
const VALUE_MARKERS = [
  [/\b(mrn|mr\s*#|medical\s+record(\s+(number|no\.?|#))?)\s*[:#]?\s*\d/i, "a medical record number"],
  [/\b(dob|d\.\s*o\.\s*b\.?|date\s+of\s+birth)\s*[:#]?\s*\d/i, "a full date of birth"],
];

// Labels arrive as "Date of Birth", "dateOfBirth", "date_of_birth" or
// "D.O.B."; match them all the same way.
function normalizeLabel(label) {
  return String(label || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/(\b\w)\./g, "$1")
    .replace(/[_\-/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function identifierReason(label, value) {
  const l = normalizeLabel(label);
  const v = String(value ?? "");
  for (const [re, why] of IDENTIFIER_LABELS) if (re.test(l)) return why;
  if (SSN_VALUE.test(v)) return "a Social Security number";
  if (SSN_WORDS.test(`${l} ${v}`) && NINE_DIGITS.test(v)) return "a Social Security number";
  for (const [re, why] of VALUE_MARKERS) if (re.test(v)) return why;
  return null;
}

// ── Building a category ───────────────────────────────────────────────────
export function buildCategory(input = {}, { id, now, origin } = {}) {
  const name = sanitizeText(input.name, LIMITS.name);
  if (!name) throw new Error("A category needs a name.");
  const taken = new Set();
  const fields = [];
  for (const raw of Array.isArray(input.fields) ? input.fields : []) {
    const label = sanitizeText(typeof raw === "string" ? raw : raw?.label, LIMITS.label);
    if (!label || identifierReason(label, "")) continue;   // never define a field whose purpose is an identifier
    const key = fieldKey(label, taken);
    if (!key) continue;
    taken.add(key);
    fields.push({ key, label, type: FIELD_TYPES.includes(raw?.type) ? raw.type : "text" });
    if (fields.length >= LIMITS.fields) break;
  }
  return {
    id,
    name,
    slug: categoryKey(name),
    icon: sanitizeText(input.icon, LIMITS.icon) || "\u{1F5C2}\uFE0F",
    description: sanitizeText(input.description, LIMITS.description),
    fields,
    aliases: [],
    origin: ["user", "vera", "uploader"].includes(origin) ? origin : "user",
    sortOrder: null,
    archivedAt: null,
    ...(now ? { createdAt: now } : {}),
  };
}

// ── Packing a record ──────────────────────────────────────────────────────
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Round-trip, not Date.parse alone: JavaScript quietly rolls "2026-02-30" into
// March, while Postgres rejects it, and a rejected date column rejects the
// whole record. Only a date that survives the round trip is sent as a date.
const validDate = (s) => {
  if (!ISO_DATE.test(s)) return false;
  const t = Date.parse(s + "T00:00:00Z");
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
};

/**
 * Turn whatever a scan, Vera or a form produced into a custom record that the
 * sync layer can write whole.
 *
 * input: { name, issuer, number, issuedDate, expirationDate, notes,
 *          values: {fieldKeyOrLabel: value}, facts: [{label, value}],
 *          customFields: {label: value}, documentIds: [] }
 * Returns { record, withheld } where withheld lists every identifier that was
 * dropped, so the screen can say exactly what was not saved and why.
 */
export function packRecord(category, input = {}, { id } = {}) {
  const cat = normalizeCategory(category);
  if (!cat) throw new Error("That category no longer exists.");
  const withheld = [];
  const fieldValues = {};
  const customFields = {};
  const byLabel = new Map(cat.fields.map(f => [categoryKey(f.label), f]));
  const byKey = new Map(cat.fields.map(f => [f.key, f]));

  // Repeated labels are real: a dosimetry report has twelve "Deep dose" rows.
  // Suffix instead of overwriting, so no reading silently disappears.
  const putCustom = (label, value) => {
    const base = sanitizeText(label, LIMITS.label) || "Detail";
    let k = base, n = 2;
    while (Object.hasOwn(customFields, k)) k = `${base} (${n++})`;
    customFields[k] = value;
  };
  const place = (label, raw) => {
    const value = sanitizeText(raw, LIMITS.value);
    if (!value) return;
    const why = identifierReason(label, value);
    if (why) { withheld.push({ label: sanitizeText(label, LIMITS.label) || "Detail", reason: why }); return; }
    const field = byKey.get(label) || byLabel.get(categoryKey(label));
    if (field && !field.removedAt && !Object.hasOwn(fieldValues, field.key)) fieldValues[field.key] = value;
    else putCustom(field ? field.label : label, value);
  };

  const role = {};
  for (const k of ROLE_KEYS) {
    const v = sanitizeText(input[k], k === "notes" ? LIMITS.value : 200);
    if (!v) continue;
    const why = identifierReason(ROLE_LABELS[k], v);
    if (why) { withheld.push({ label: ROLE_LABELS[k], reason: why }); continue; }
    if ((k === "issuedDate" || k === "expirationDate") && !validDate(v)) { putCustom(ROLE_LABELS[k], v); continue; }
    role[k] = v;
  }
  if (input.values && typeof input.values === "object") for (const [k, v] of Object.entries(input.values)) place(k, v);
  if (Array.isArray(input.facts)) for (const f of input.facts) if (f && typeof f === "object") place(f.label, f.value);
  if (input.customFields && typeof input.customFields === "object") for (const [k, v] of Object.entries(input.customFields)) place(k, v);

  const fieldLabels = Object.fromEntries(cat.fields.map(f => [f.key, f.label]));
  const documentIds = [...new Set((Array.isArray(input.documentIds) ? input.documentIds : []).filter(x => typeof x === "string" && x))];

  const record = {
    ...(id ? { id } : {}),
    categoryId: cat.id,
    categoryName: cat.name,
    fieldLabels,
    name: role.name || "",
    issuer: role.issuer || "",
    number: role.number || "",
    issuedDate: role.issuedDate || "",
    expirationDate: role.expirationDate || "",
    notes: role.notes || "",
    fieldValues,
    customFields,
    documentIds,
  };
  if (!record.name) record.name = sanitizeText(input.title || fieldValues[cat.fields[0]?.key] || cat.name, 200);
  return { record: onlyColumns(record, RECORD_COLUMNS), withheld };
}

/** Last line of defence: drop any key that is not a real column. */
export function onlyColumns(obj, columns) {
  const allowed = new Set(columns);
  return Object.fromEntries(Object.entries(obj || {}).filter(([k]) => allowed.has(k)));
}

/** A record's facts for display and search, in category field order. */
export function recordFacts(category, record) {
  const r = normalizeRecord(record);
  if (!r) return [];
  const c = normalizeCategory(category);
  const out = [];
  for (const k of ROLE_KEYS) if (k !== "notes" && r[k]) out.push({ label: ROLE_LABELS[k], value: String(r[k]) });
  const labels = { ...r.fieldLabels, ...Object.fromEntries((c?.fields || []).map(f => [f.key, f.label])) };
  for (const [k, v] of Object.entries(r.fieldValues)) if (v !== "" && v != null) out.push({ label: labels[k] || k, value: sanitizeText(v) });
  for (const [k, v] of Object.entries(r.customFields)) if (v !== "" && v != null) out.push({ label: k, value: sanitizeText(v) });
  if (r.notes) out.push({ label: ROLE_LABELS.notes, value: String(r.notes) });
  return out;
}

/** Move a record to another category, keeping every value. */
export function moveRecord(record, toCategory) {
  const r = normalizeRecord(record);
  const to = normalizeCategory(toCategory);
  if (!r || !to) throw new Error("Cannot move that record.");
  const facts = [];
  for (const [k, v] of Object.entries(r.fieldValues)) facts.push({ label: r.fieldLabels[k] || k, value: v });
  const { record: moved } = packRecord(to, {
    name: r.name, issuer: r.issuer, number: r.number, issuedDate: r.issuedDate,
    expirationDate: r.expirationDate, notes: r.notes, facts,
    customFields: r.customFields, documentIds: r.documentIds,
  }, { id: r.id });
  return { ...moved, favorite: r.favorite === true };
}

// ── Checking Vera's proposals before they become approval cards ───────────
// Vera's section list is enforced by her prompt alone, and a model does not
// always follow its prompt. Before this, a record proposed into a section that
// does not exist ("awards") showed as done on Approve and lived only on the
// device, never on any screen. These rules REPAIR rather than reject, because
// a rejected card takes the information, and the uploaded file, with it.
const humanize = (s) => sanitizeText(String(s || "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " "), LIMITS.name)
  .replace(/^./, c => c.toUpperCase());

export function recordFromFields(fields = {}, customFields = {}) {
  const facts = [];
  const rec = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (v == null || v === "") continue;
    if (ROLE_KEYS.includes(k)) rec[k] = v;
    else if (k === "title") rec.name = rec.name || v;
    else facts.push({ label: humanize(k), value: v });
  }
  for (const [k, v] of Object.entries(customFields || {})) if (v != null && v !== "") facts.push({ label: k, value: v });
  return { ...rec, facts };
}

export function cleanRecordInput(r) {
  if (!r || typeof r !== "object") return {};
  const out = {};
  // A record may arrive in the built-in shape too ({ fields, customFields }).
  // Both shapes add together; neither silently replaces the other.
  if (r.fields && typeof r.fields === "object" && !Array.isArray(r.fields)) {
    const x = recordFromFields(r.fields);
    for (const k of ROLE_KEYS) if (x[k] != null) out[k] = x[k];
    out.facts = [...x.facts];
  }
  for (const k of ROLE_KEYS) if (r[k] != null) out[k] = r[k];
  if (r.values && typeof r.values === "object" && !Array.isArray(r.values)) out.values = r.values;
  if (Array.isArray(r.facts)) out.facts = [...(out.facts || []), ...r.facts.filter(f => f && typeof f === "object")].slice(0, 200);
  if (r.customFields && typeof r.customFields === "object") out.customFields = r.customFields;
  return out;
}

function mergeActionRecord(a) {
  const extra = cleanRecordInput(recordFromFields(a.fields, a.customFields));
  const base = cleanRecordInput(a.record || {});
  return { ...extra, ...base, facts: [...(extra.facts || []), ...(base.facts || [])] };
}

// Vera's snapshot names locum contracts "contracts"; the collection is locumContracts.
const LINK_ALIASES = { contracts: "locumContracts" };

export function repairActions(actions, { data } = {}) {
  const categories = Array.isArray(data?.customCategories) ? data.customCategories : [];
  const KNOWN = new Set(["create_record", "update_record", "update_document", "feedback", "draft_references",
    "export_data", "open_record", "send_packet", "create_category"]);
  return (Array.isArray(actions) ? actions : []).filter(a => a && typeof a === "object").map(a => {
    if (!KNOWN.has(a.kind)) return { ...a, invalid: "Vera proposed an action this version cannot run." };

    if (a.kind === "create_category") {
      const name = sanitizeText(a.category?.name, LIMITS.name);
      if (!name) return { ...a, invalid: "The proposed category has no name." };
      const existing = findCategory(categories, name);
      const rawRecords = Array.isArray(a.records) ? a.records : (a.record ? [a.record] : []);
      const records = rawRecords.slice(0, 25).map(cleanRecordInput);
      if ((a.fields || a.customFields) && records.length) {
        const top = mergeActionRecord({ fields: a.fields, customFields: a.customFields });
        records[0] = { ...top, ...records[0], facts: [...(top.facts || []), ...(records[0].facts || [])] };
      }
      return {
        ...a,
        category: {
          name,
          icon: sanitizeText(a.category?.icon, LIMITS.icon),
          description: sanitizeText(a.category?.description, LIMITS.description),
          fields: (Array.isArray(a.category?.fields) ? a.category.fields : []).slice(0, LIMITS.fields),
        },
        records,
        ...(existing ? { existingCategoryId: existing.id, repaired: `Filed into your existing "${existing.name}" category instead of creating a duplicate.` } : {}),
      };
    }

    if (a.kind === "create_record" || a.kind === "update_record") {
      const section = String(a.section || "");
      if (section === "customRecords") {
        if (a.kind === "update_record") return a;
        const cat = (a.categoryId && categories.find(c => c?.id === a.categoryId)) || findCategory(categories, a.category || a.categoryName);
        const record = mergeActionRecord(a);
        if (cat) return { ...a, section, categoryId: cat.id, categoryName: sanitizeText(cat.name, LIMITS.name), record };
        const name = sanitizeText(a.category || a.categoryName, LIMITS.name);
        if (!name) return { ...a, invalid: "No category was named for this record." };
        return { kind: "create_category", summary: a.summary, category: { name, fields: [] }, records: [record],
          repaired: `"${name}" is a new category, so this card creates it.` };
      }
      if (WRITABLE_SECTIONS.includes(section)) return a;
      if (BUILT_IN_SECTIONS.includes(section)) {
        const label = humanize(section);
        return { ...a, invalid: `Vera can't save to ${label} directly yet. Open ${label} and add it there.` };
      }
      // A section that does not exist. Never let it become a ghost collection.
      if (a.kind === "update_record") return { ...a, invalid: `There is no "${section}" section to update.` };
      const label = humanize(section) || "Other records";
      const record = recordFromFields(a.fields, a.customFields);
      const existing = findCategory(categories, label);
      if (existing) return { kind: "create_record", section: "customRecords", summary: a.summary,
        categoryId: existing.id, categoryName: existing.name, record,
        repaired: `Filed into your "${existing.name}" category.` };
      return { kind: "create_category", summary: a.summary, category: { name: label, fields: [] }, records: [record],
        repaired: `There is no built-in "${label}" section, so this card creates one as your own category.` };
    }
    if (a.kind === "update_document" && a.linkedTo !== undefined) {
      const raw = String(a.linkedTo || "").trim();
      if (!raw) return { ...a, linkedTo: "" };
      const colon = raw.indexOf(":");
      const section = LINK_ALIASES[raw.slice(0, colon)] || raw.slice(0, colon);
      const id = colon > 0 ? raw.slice(colon + 1) : "";
      const real = colon > 0 && id && section !== "documents" && section !== "customCategories" && BUILT_IN_SECTIONS.includes(section)
        && (Array.isArray(data?.[section]) ? data[section] : []).some(x => x?.id === id);
      if (!real) return { ...a, invalid: "That record could not be found, so the document was not filed." };
      return { ...a, linkedTo: `${section}:${id}` };
    }
    return a;
  });
}

// Turn whatever a scan or a reclassified card holds into role fields + facts.
export function toOtherExtracted(extracted) {
  const ex = extracted && typeof extracted === "object" ? extracted : {};
  const pick = (...keys) => keys.map(k => ex[k]).find(v => v != null && String(v).trim() !== "") || "";
  const used = new Set(["name", "title", "issuer", "provider", "institution", "facility", "agency", "organization",
    "number", "licenseNumber", "policyNumber", "certificateNumber", "fileNumber",
    "issuedDate", "date", "effectiveDate", "dateAdministered", "expirationDate", "facts", "suggestedCategory", "customFields"]);
  const facts = Array.isArray(ex.facts) ? ex.facts.filter(f => f && f.label && f.value != null && String(f.value).trim() !== "").map(f => ({ label: String(f.label), value: String(f.value) })) : [];
  for (const [k, v] of Object.entries(ex)) {
    if (used.has(k) || v == null || v === "" || typeof v === "object") continue;
    facts.push({ label: k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, c => c.toUpperCase()), value: String(v) });
  }
  if (ex.customFields && typeof ex.customFields === "object") {
    for (const [k, v] of Object.entries(ex.customFields)) if (v != null && String(v).trim() !== "") facts.push({ label: k, value: String(v) });
  }
  return {
    name: pick("name", "title"), issuer: pick("issuer", "provider", "institution", "facility", "agency", "organization"),
    number: pick("number", "licenseNumber", "policyNumber", "certificateNumber", "fileNumber"),
    issuedDate: pick("issuedDate", "date", "effectiveDate", "dateAdministered"), expirationDate: pick("expirationDate"),
    facts, suggestedCategory: ex.suggestedCategory || null,
  };
}

/**
 * Apply an edit to an existing record without losing anything.
 *
 * Starts from the record's own values, then lays the incoming edit over them:
 * an incoming value for a field replaces the old one (it never reappears as a
 * duplicate detail), a blank incoming value clears that field, and anything the
 * edit does not mention is kept. Used by Vera's updates and by the category
 * screen, including the Unsorted view, whose form shows none of a record's
 * category fields and so must never clear them.
 *
 * incoming: { name, issuer, number, issuedDate, expirationDate, notes,
 *             values: {fieldKeyOrLabel: value}, facts: [{label, value}],
 *             customFields: {label: value} }
 */
export function updateRecord(category, existing, incoming = {}, { addDocumentIds = [] } = {}) {
  const ex = normalizeRecord(existing);
  if (!ex) throw new Error("Record not found. It may have been deleted.");
  const cat = normalizeCategory(category)
    || normalizeCategory({ id: ex.categoryId || "unsorted", name: ex.categoryName || "Your records",
      fields: Object.entries(ex.fieldLabels).map(([key, label]) => ({ key, label })) });
  const byKey = new Map(cat.fields.map(f => [f.key, f]));
  const byLabel = new Map(cat.fields.map(f => [categoryKey(f.label), f]));
  const values = { ...ex.fieldValues };
  const extraFacts = [];
  const take = (label, value) => {
    const f = byKey.get(label) || byLabel.get(categoryKey(label));
    if (f) values[f.key] = value; else if (value != null && String(value).trim() !== "") extraFacts.push({ label, value });
  };
  if (incoming.values && typeof incoming.values === "object") for (const [k, v] of Object.entries(incoming.values)) take(k, v);
  for (const f of Array.isArray(incoming.facts) ? incoming.facts : []) if (f && typeof f === "object") take(f.label, f.value);
  const role = (k) => (Object.hasOwn(incoming, k) && incoming[k] != null ? incoming[k] : ex[k]);
  const { record, withheld } = packRecord(cat, {
    name: role("name"), issuer: role("issuer"), number: role("number"),
    issuedDate: role("issuedDate"), expirationDate: role("expirationDate"), notes: role("notes"),
    values, facts: extraFacts,
    customFields: { ...ex.customFields, ...(incoming.customFields && typeof incoming.customFields === "object" ? incoming.customFields : {}) },
    documentIds: [...ex.documentIds, ...addDocumentIds],
  }, { id: ex.id });
  // A record kept under Unsorted keeps its original category, not the stand-in.
  if (!normalizeCategory(category)) { record.categoryId = ex.categoryId || null; record.categoryName = ex.categoryName || ""; }
  return { record: { ...record, favorite: ex.favorite === true }, withheld };
}
