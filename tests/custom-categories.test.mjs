import test from "node:test";
import assert from "node:assert/strict";
import {
  categoryKey, sanitizeText, identifierReason, buildCategory, packRecord, findCategory,
  normalizeCategory, normalizeRecord, liveCategories, recordsIn, unsortedRecords, moveRecord,
  recordFacts, onlyColumns, fieldKey, WRITABLE_SECTIONS, RECORD_COLUMNS, CATEGORY_COLUMNS, LIMITS,
} from "../src/utils/customCategories.js";

const cp = (...n) => String.fromCodePoint(...n);
const badges = () => buildCategory({ name: "Hospital ID Badges", icon: "X", fields: ["Badge number", "Facility"] }, { id: "C1", origin: "uploader" });

test("one category, however the AI spells it", () => {
  const k = categoryKey("Hospital ID Badges");
  for (const v of ["hospital id badge", "Badges (Hospital ID)", "  HOSPITAL  ID  BADGES ", "The Hospital ID Badges"]) {
    assert.equal(categoryKey(v), k, v);
  }
  assert.equal(categoryKey("Certificaci" + cp(0xf3) + "n"), "certificacion");
  assert.notEqual(categoryKey("Board Certifications"), categoryKey("Board Meetings"));
  assert.equal(categoryKey(""), "");
});

test("text that reaches Vera cannot carry markup, control characters or unbounded length", () => {
  const dirty = "a" + cp(0x200b) + "b" + cp(0x2028) + "c" + cp(0xfeff) + "{inject}<b>`x`";
  assert.equal(sanitizeText(dirty), "a b c injectbx");
  assert.equal(sanitizeText("x".repeat(500), LIMITS.name).length, LIMITS.name);
  assert.equal(sanitizeText(null), "");
  assert.equal(sanitizeText({ a: 1 }), '"a":1');
});

test("patient and personal identifiers are recognised, credential numbers are not", () => {
  for (const [label, value] of [
    ["MRN", "00482913"], ["Medical Record Number", "1"], ["Patient Name", "J.S."], ["Patient ID", "9"],
    ["Social Security", "x"], ["SSN", "x"], ["Date of Birth", "1970-01-01"], ["DOB", "x"],
    ["Account Number", "88"], ["Encounter No.", "3"], ["Passport Number", "X1"], ["Notes", "SSN 123-45-6789"],
  ]) assert.ok(identifierReason(label, value), `${label} must be withheld`);
  for (const [label, value] of [
    ["Patient Safety Committee", "Member"], ["License Number", "A12345"], ["DEA Number", "FW1234567"],
    ["Badge number", "PX-1182"], ["NPI", "1234567890"], ["Member ID", "AANS-4471"], ["Expiration", "2027-01-01"],
  ]) assert.equal(identifierReason(label, value), null, `${label} must NOT be withheld`);
});

test("building a category: name required, keys unique, identifier fields never defined", () => {
  assert.throws(() => buildCategory({ name: "  " }), /needs a name/);
  const c = buildCategory({ name: "Dosimetry", fields: ["Deep dose", "deep dose", "Date of Birth", { label: "Period", type: "date" }, { label: "Evil", type: "script" }] }, { id: "D" });
  assert.deepEqual(c.fields.map(f => f.key), ["deepDose", "deepDose2", "period", "evil"]);
  assert.equal(c.fields.find(f => f.key === "period").type, "date");
  assert.equal(c.fields.find(f => f.key === "evil").type, "text", "unknown field types fall back to text");
  assert.ok(!c.fields.some(f => /birth/i.test(f.label)), "a field whose purpose is an identifier is never created");
  assert.equal(c.slug, categoryKey("Dosimetry"));
  const many = buildCategory({ name: "Many", fields: Array.from({ length: 60 }, (_, i) => `F${i}`) }, { id: "M" });
  assert.equal(many.fields.length, LIMITS.fields);
});

test("a packed record carries ONLY real columns, so the cloud never rejects it whole", () => {
  const { record } = packRecord(badges(), {
    name: "Penrose badge", issuer: "Penrose Hospital", number: "PX-1182",
    issuedDate: "2026-01-02", expirationDate: "2028-01-02",
    values: { "Badge number": "PX-1182", facility: "Penrose" },
    facts: [{ label: "Color", value: "Blue" }],
    badgeNumber: "stray", surprise: "stray", data: "stray",
  }, { id: "R1" });
  const extra = Object.keys(record).filter(k => !RECORD_COLUMNS.includes(k));
  assert.deepEqual(extra, [], "a stray top-level key would be sent as a column and reject the row");
  assert.equal(record.categoryId, "C1");
  assert.equal(record.categoryName, "Hospital ID Badges");
  assert.deepEqual(record.fieldValues, { badgeNumber: "PX-1182", facility: "Penrose" });
  assert.deepEqual(record.customFields, { Color: "Blue" });
  assert.equal(record.expirationDate, "2028-01-02");
});

test("nothing is silently dropped: repeated labels keep every reading", () => {
  const dos = buildCategory({ name: "Dosimetry", fields: [] }, { id: "D" });
  const facts = Array.from({ length: 12 }, (_, i) => ({ label: "Deep dose", value: `${i + 1} mrem` }));
  const { record } = packRecord(dos, { facts });
  const readings = Object.values(record.customFields);
  assert.equal(readings.length, 12);
  assert.ok(Object.hasOwn(record.customFields, "Deep dose (12)"));
});

test("identifiers are withheld AND reported, the rest of the record still saves", () => {
  const { record, withheld } = packRecord(badges(), {
    name: "Penrose badge",
    facts: [{ label: "MRN", value: "00482913" }, { label: "Date of Birth", value: "1970-01-01" },
            { label: "Color", value: "Blue" }, { label: "Notes", value: "SSN 123-45-6789" }],
    notes: "Social Security 123-45-6789",
  });
  assert.deepEqual(withheld.map(w => w.reason).sort(),
    ["a Social Security number", "a Social Security number", "a full date of birth", "a medical record number"]);
  const text = JSON.stringify(record);
  for (const leak of ["00482913", "1970-01-01", "123-45-6789"]) assert.ok(!text.includes(leak), `${leak} leaked`);
  assert.deepEqual(record.customFields, { Color: "Blue" });
});

test("a bad date is kept as text rather than rejecting the row", () => {
  const { record } = packRecord(badges(), { name: "x", expirationDate: "Dec 2027", issuedDate: "2026-02-30" });
  assert.equal(record.expirationDate, "");
  assert.equal(record.issuedDate, "");
  assert.equal(record.customFields.Expires, "Dec 2027");
  assert.equal(record.customFields.Issued, "2026-02-30");
});

test("finding an existing category by spelling, alias, or even when archived", () => {
  const cats = [
    { ...badges(), createdAt: "2026-01-01" },
    { id: "C2", name: "Dosimetry", aliases: ["Radiation badge reports"], archivedAt: "2026-03-01" },
  ];
  assert.equal(findCategory(cats, "hospital id badge").id, "C1");
  assert.equal(findCategory(cats, "Radiation Badge Report").id, "C2");
  assert.equal(findCategory(cats, "dosimetry").id, "C2", "an archived category is revived, not duplicated");
  assert.equal(findCategory(cats, "Parking permits"), null);
});

test("readers never throw on malformed stored data", () => {
  for (const bad of [null, 5, "x", {}, { id: "" }, { id: 7 }]) assert.equal(normalizeCategory(bad), null);
  const c = normalizeCategory({ id: "Z", name: null, fields: { oops: 1 }, aliases: "nope" });
  assert.equal(c.name, "Untitled category");
  assert.deepEqual(c.fields, []);
  assert.deepEqual(c.aliases, []);
  const r = normalizeRecord({ id: "R", fieldValues: [1, 2], documentIds: "d1", customFields: null });
  assert.deepEqual(r.fieldValues, {});
  assert.deepEqual(r.documentIds, []);
  assert.doesNotThrow(() => liveCategories({ customCategories: [null, 3, { id: "A", name: "A" }] }));
  assert.doesNotThrow(() => recordFacts(null, { id: "R", fieldValues: { a: { deep: 1 } } }));
});

test("every record stays reachable: archived or missing categories surface as unsorted", () => {
  const data = {
    customCategories: [{ id: "L", name: "Live" }, { id: "A", name: "Gone", archivedAt: "2026-01-01" }],
    customRecords: [{ id: "r1", categoryId: "L" }, { id: "r2", categoryId: "A" }, { id: "r3", categoryId: "MISSING" }],
  };
  assert.deepEqual(liveCategories(data).map(c => c.id), ["L"]);
  assert.deepEqual(recordsIn(data, "L").map(r => r.id), ["r1"]);
  assert.deepEqual(unsortedRecords(data).map(r => r.id).sort(), ["r2", "r3"]);
});

test("moving a record keeps every value", () => {
  const from = badges();
  const to = buildCategory({ name: "Facility access", fields: ["Facility"] }, { id: "C9" });
  const { record } = packRecord(from, { name: "Penrose", values: { "Badge number": "PX-1", facility: "Penrose" }, facts: [{ label: "Color", value: "Blue" }], documentIds: ["d1"] }, { id: "R1" });
  const moved = moveRecord({ ...record, favorite: true }, to);
  assert.equal(moved.id, "R1");
  assert.equal(moved.categoryId, "C9");
  assert.equal(moved.fieldValues.facility, "Penrose");
  assert.equal(moved.customFields["Badge number"], "PX-1", "a value with no matching field moves to details, not the bin");
  assert.equal(moved.customFields.Color, "Blue");
  assert.deepEqual(moved.documentIds, ["d1"]);
  assert.equal(moved.favorite, true);
});

test("writable sections: records yes, category rows and internal logs no", () => {
  assert.ok(WRITABLE_SECTIONS.includes("customRecords"));
  assert.ok(WRITABLE_SECTIONS.includes("licenses"));
  for (const k of ["customCategories", "documents", "shareLog", "notificationLog", "alertAcks", "invoices"]) {
    assert.ok(!WRITABLE_SECTIONS.includes(k), `${k} must not be writable through create_record`);
  }
});

test("column lists match the migration exactly", async () => {
  const { readFileSync } = await import("node:fs");
  const sql = readFileSync(new URL("../supabase/migrations/20260925010000_custom_categories.sql", import.meta.url), "utf8");
  const snake = (k) => k.replace(/[A-Z]/g, c => "_" + c.toLowerCase());
  for (const k of RECORD_COLUMNS) assert.ok(sql.includes(`('custom_records','${snake(k)}',`), `custom_records.${snake(k)} missing from the migration`);
  for (const k of CATEGORY_COLUMNS) assert.ok(sql.includes(`('custom_categories','${snake(k)}',`), `custom_categories.${snake(k)} missing from the migration`);
});

test("field keys are safe identifiers and never collide with the fixed columns", () => {
  assert.equal(fieldKey("Badge #"), "badge");
  assert.equal(fieldKey("2nd reading"), "f2ndReading");
  assert.equal(fieldKey("Name"), "name2", "a field called Name must not overwrite the name column");
  assert.equal(fieldKey(""), "");
  assert.deepEqual(onlyColumns({ a: 1, b: 2 }, ["a"]), { a: 1 });
});

// ── Regressions found by the adversarial review, 2026-09-24 ──────────────────
import { repairActions, updateRecord } from "../src/utils/customCategories.js";

test("identifiers are caught however the label is spelled, and inside free text", () => {
  const en = cp(0x2013);
  for (const [label, value] of [
    ["dateOfBirth", "1961-03-14"], ["patient_name", "Jane Doe"], ["medicalRecordNumber", "1"], ["D.O.B.", "x"],
    ["MR#", "9"], ["Patient", "Jane Doe"], ["Taxpayer Identification Number", "123456789"], ["TIN", "x"],
    ["Notes", "SSN 123456789"], ["Notes", "123 45 6789"], ["Notes", "123.45.6789"], ["Notes", "123" + en + "45" + en + "6789"],
    ["Notes", "seen, MRN 00481234"], ["Notes", "DOB 3/14/1961"], ["Chart #", "7"],
  ]) assert.ok(identifierReason(label, value), `${label} = ${value} must be withheld`);
  for (const [label, value] of [
    ["Patient Safety Committee", "Member"], ["Account Manager", "Kim"], ["Badge number", "123456789"],
    ["License Number", "A12345"], ["Member ID", "AANS-4471"], ["Policy number", "123456789"],
  ]) assert.equal(identifierReason(label, value), null, `${label} = ${value} must be kept`);
});

test("a field labelled ID never collides with the record's id column", () => {
  assert.equal(fieldKey("ID"), "id2");
  assert.equal(fieldKey("Category ID"), "categoryId2");
  const c = normalizeCategory({ id: "C", name: "Badges", fields: [{ key: "id", label: "ID" }, { key: "documentIds", label: "Docs" }] });
  assert.ok(!c.fields.some(f => RECORD_COLUMNS.includes(f.key)), "no field may shadow a record column");
});

test("Vera's two record shapes add together instead of one replacing the other", () => {
  const data = { customCategories: [{ id: "C1", name: "Badges" }] };
  const [a] = repairActions([{ kind: "create_record", section: "customRecords", categoryId: "C1",
    record: { name: "Penrose" }, fields: { expirationDate: "2028-01-01", color: "blue" }, customFields: { Access: "OR" } }], { data });
  assert.equal(a.record.name, "Penrose");
  assert.equal(a.record.expirationDate, "2028-01-01");
  assert.deepEqual(a.record.facts.map(f => f.label).sort(), ["Access", "Color"]);
  const [b] = repairActions([{ kind: "create_category", category: { name: "Awards" }, record: { name: "Best Resident" } }], { data });
  assert.equal(b.records.length, 1, "a singular record must not be dropped");
});

test("a real section Vera cannot write is refused plainly, never turned into a duplicate category", () => {
  for (const section of ["malpracticeHistory", "peerReferences", "caseLogs", "travelDocs"]) {
    const [a] = repairActions([{ kind: "create_record", section, fields: { note: "x" } }], { data: {} });
    assert.equal(a.kind, "create_record", `${section} must not become create_category`);
    assert.match(a.invalid, /can't save to .* directly/);
  }
  const [invented] = repairActions([{ kind: "create_record", section: "awards", fields: { name: "x" } }], { data: {} });
  assert.equal(invented.kind, "create_category", "a truly invented section still becomes a proposed category");
});

test("a document is filed only to a record that exists", () => {
  const data = { locumContracts: [{ id: "K1" }], licenses: [{ id: "L1" }] };
  const run = (linkedTo) => repairActions([{ kind: "update_document", id: "d", linkedTo }], { data })[0];
  assert.equal(run("contracts:K1").linkedTo, "locumContracts:K1", "Vera's snapshot name maps to the real collection");
  assert.equal(run("licenses:L1").linkedTo, "licenses:L1");
  assert.equal(run("").linkedTo, "", "unlinking is always allowed");
  for (const bad of ["licenses:GONE", "documents:x", "justAnId", "customCategories:C1", "nowhere:1"]) assert.ok(run(bad).invalid, `${bad} must be refused`);
});

test("an update replaces what it names, clears what it blanks, and keeps everything else", () => {
  const cat = badges();
  const existing = { id: "R1", categoryId: "C1", categoryName: "Hospital ID Badges", name: "Penrose", issuer: "Penrose",
    fieldValues: { badgeNumber: "OLD", facility: "Penrose" }, customFields: { Color: "Blue" }, documentIds: ["d1"], favorite: true };
  const { record } = updateRecord(cat, existing, { values: { "Badge number": "NEW" }, expirationDate: "2028-01-01" }, { addDocumentIds: ["d2"] });
  assert.equal(record.fieldValues.badgeNumber, "NEW");
  assert.equal(record.fieldValues.facility, "Penrose", "an unmentioned value is kept");
  assert.ok(!Object.values(record.customFields).includes("OLD"), "the replaced value must not reappear as a detail");
  assert.equal(record.customFields.Color, "Blue");
  assert.equal(record.issuer, "Penrose");
  assert.equal(record.expirationDate, "2028-01-01");
  assert.deepEqual(record.documentIds, ["d1", "d2"]);
  assert.equal(record.favorite, true);
  const cleared = updateRecord(cat, existing, { issuer: "", values: { facility: "" } }).record;
  assert.equal(cleared.issuer, "");
  assert.ok(!("facility" in cleared.fieldValues), "a blanked field is cleared");
});

test("editing a record under Unsorted never erases its category values", () => {
  const existing = { id: "R1", categoryId: "GONE", categoryName: "Hospital ID Badges", name: "Penrose",
    fieldLabels: { badgeNumber: "Badge number" }, fieldValues: { badgeNumber: "PX-1" } };
  const { record } = updateRecord(null, existing, { name: "Penrose", notes: "renewed", values: {} });
  assert.equal(record.fieldValues.badgeNumber, "PX-1");
  assert.equal(record.categoryId, "GONE", "it keeps its original category");
  assert.equal(record.categoryName, "Hospital ID Badges");
  assert.equal(record.notes, "renewed");
});

test("a record with no category stays uncategorised when edited", () => {
  const { record } = updateRecord(null, { id: "R2", name: "Loose", fieldValues: {} }, { notes: "x" });
  assert.equal(record.categoryId, null, "the stand-in category's id must never be saved");
  assert.equal(record.categoryName, "");
});

// ── Regressions found by the spreadsheet-guard review, 2026-09-25 ────────────
test("a trailing # and the export spellings of a patient's name or ID are identifiers", () => {
  // A "#" ending the label has no word boundary after it; these all slipped through.
  for (const label of ["Acct #", "Account #", "Acct#", "Hospital Account #", "Patient Acct #", "Encounter #", "Encounter ID",
    "Patient Last Name", "Patient First Name", "Patient Full Name", "Patient_Last_Name", "PatientLastName",
    "Patient's Name", "Patient" + cp(0x2019) + "s Name", "Pt. Name", "Pt. ID", "Pt Last Name", "Patient #", "Pt #",
    "Account No.", "Acct. No."]) {
    assert.ok(identifierReason(label, ""), `${label} must be withheld`);
  }
  for (const label of ["Patient Safety Committee", "Patient Satisfaction Score", "Patient Notes", "Account Manager",
    "Accounting", "Member ID", "PTAN", "PT License Number", "Opt Out Number", "Encounters"]) {
    assert.equal(identifierReason(label, ""), null, `${label} must be kept`);
  }
});
