// supabase/functions/_shared/intakeFiling.mjs: where an emailed document goes,
// what gets written, and what the physician is told.
//
// Every rule the edge function follows when it files a forwarded document is
// here, run on plain objects. The end-to-end run through the function itself
// is scripts/email-inbound-intake.test.mjs.
// Run: node --test scripts/intake-filing.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planFiling, filingTarget, sectionColumns, builtInFields, findExisting, fillEmpty, docLabel, usDate, unfiledLine,
  filingReplyText, toSnakeRow, toCamelRow, scannableMime, sectionScope, SCAN_SECTION, SECTION_TABLE, EMAIL_INBOX_DOC_TYPE,
} from "../supabase/functions/_shared/intakeFiling.mjs";
import { PRACTICE_COLLECTIONS } from "../src/utils/limitedLaunchAccess.js";
import { EMAIL_INBOX_DOC_TYPE as APP_EMAIL_INBOX_DOC_TYPE, isInboxDoc, leaveInbox } from "../src/utils/inboxDocs.js";

const NOW = "2026-09-25T16:10:00.000Z";
const USER = "profile-1";
const EM_DASH = String.fromCodePoint(0x2014);
const ids = () => { let n = 0; return () => `id-${++n}`; };
const plan = (scan, over = {}) => planFiling({ scan, docId: "doc-1", fileName: "scan.pdf", mimeType: "application/pdf", userId: USER, rows: [], categories: [], now: NOW, newId: ids(), ...over });
const scanOf = (documentType, extracted) => ({ documentType, confidence: "high", extracted });
const camel = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const META = new Set(["id", "userId", "customFields", "favorite", "createdAt", "updatedAt"]);

test("the app and the server agree on the inbox type, and the app lists and releases it", () => {
  assert.equal(EMAIL_INBOX_DOC_TYPE, APP_EMAIL_INBOX_DOC_TYPE);
  assert.equal(isInboxDoc({ type: "email-inbox" }), true);
  assert.equal(isInboxDoc({ type: "email-inbox", linkedTo: "licenses:x" }), false);
  assert.deepEqual(leaveInbox({ type: "email-inbox", mimeType: "application/pdf" }), { type: "application/pdf" });
});

test("each scan type goes to its section, and only real columns are written", () => {
  const cases = [
    ["license", "licenses", { type: "DEA Registration", name: "DEA Registration", licenseNumber: "FW1234567", state: "ND", issuedDate: "2025-02-01", expirationDate: "2028-01-31" }],
    ["cme", "cme", { title: "Spine Summit", category: "AMA PRA Category 1", hours: 7.5, date: "2026-08-14", provider: "AANS", topics: [] }],
    ["privilege", "privileges", { type: "Courtesy Privileges", name: "Courtesy", facility: "Mercy", state: "CO", appointmentDate: "2026-01-01", expirationDate: "2028-01-01" }],
    ["insurance", "insurance", { type: "Medical Malpractice (Claims-Made)", name: "COI", provider: "ProAssurance", policyNumber: "PA-1", coveragePerClaim: "1,000,000", coverageAggregate: "3,000,000", effectiveDate: "2026-01-01", expirationDate: "2027-01-01" }],
    ["healthRecord", "healthRecords", { category: "TB Test", type: "QuantiFERON-TB Gold", name: "QFT", dateAdministered: "2026-05-01", result: "Negative" }],
    ["education", "education", { type: "Residency Certificate", name: "Residency", institution: "UCLA", graduationDate: "2019-06-30", fieldOfStudy: "Neurosurgery" }],
    ["travel", "travelDocs", { type: "Passport", name: "US Passport", provider: "United States", expirationDate: "2031-03-01" }],
    ["agreement", "locumContracts", { facility: "Penrose", location: "Colorado Springs, CO", agency: "Weatherby", startDate: "2026-10-01", endDate: "2026-10-14", hourlyRate: "250", callStipend: "$1,500" }],
  ];
  for (const [type, section, extracted] of cases) {
    assert.equal(SCAN_SECTION[type], section);
    const p = plan(scanOf(type, { ...extracted, somethingElse: "kept as a detail" }));
    assert.equal(p.outcome, "created", type);
    assert.equal(p.section, section);
    assert.equal(p.table, SECTION_TABLE[section]);
    const [w] = p.writes;
    assert.equal(w.op, "insert");
    const allowed = new Set(sectionColumns(section));
    for (const k of Object.keys(w.row)) {
      const c = camel(k);
      assert.ok(allowed.has(c) || META.has(c), `${section}: ${k} is not a column`);
    }
    assert.equal(w.row.user_id, USER);
    assert.equal(w.row.favorite, false);
    assert.equal(w.row.created_at, NOW);
    assert.equal(w.row.custom_fields["Something Else"], "kept as a detail", `${section}: overflow goes to custom_fields`);
    assert.deepEqual(p.document, { linked_to: `${section}:${w.id}`, name: p.document.name, type: "application/pdf" });
    assert.match(p.document.name, /\.pdf$/);
  }
});

test("contract numbers and increments are coerced the way the app's save does", () => {
  const p = plan(scanOf("agreement", { facility: "Penrose", hourlyRate: "250", callStipend: "$1,500", stipendHours: "four" }));
  const row = p.writes[0].row;
  assert.equal(row.hourly_rate, 250);
  assert.equal(row.call_stipend, 1500);
  assert.equal(row.stipend_hours, 0);
  assert.equal(row.increment_minutes, 15);
  assert.equal(row.min_call_minutes, 15);
});

test("cme hours become a number and topics a clean list", () => {
  const row = plan(scanOf("cme", { title: "X", hours: "2.0 hours", topics: ["Ethics", 7, ""] })).writes[0].row;
  assert.equal(row.hours, 2);
  assert.deepEqual(row.topics, ["Ethics"]);
  assert.equal(row.category, "Other", "a NOT NULL column never goes out empty");
  const bad = plan(scanOf("cme", { title: "X", hours: "several" })).writes[0].row;
  assert.equal(bad.hours, undefined);
  assert.equal(bad.custom_fields.Hours, "several");
});

test("a date that is not a date is kept as a detail, never sent to a date column", () => {
  const row = plan(scanOf("license", { type: "DEA Registration", expirationDate: "2026-02-30", issuedDate: "N/A" })).writes[0].row;
  assert.equal(row.expiration_date, undefined);
  assert.equal(row.issued_date, undefined);
  assert.equal(row.custom_fields["Expiration Date"], "2026-02-30");
  assert.equal(row.custom_fields["Issued Date"], "N/A");
});

test("required types default to Other; '' goes out as null", () => {
  const row = plan(scanOf("privilege", { facility: "Mercy", name: "" })).writes[0].row;
  assert.equal(row.type, "Other");
  assert.equal(row.name, undefined);
  assert.deepEqual(toSnakeRow({ issuedDate: "", licenseNumber: "A1" }), { issued_date: null, license_number: "A1" });
  assert.deepEqual(toCamelRow({ license_number: "A1", user_id: "u" }), { licenseNumber: "A1", userId: "u" });
});

test("identifiers are withheld: never a column, never a detail, and the physician is told", () => {
  const p = plan(scanOf("license", {
    type: "State Medical License (DO)", state: "CO", licenseNumber: "DO.0012345",
    ssn: "123-45-6789", dateOfBirth: "1970-03-14", accountNumber: "99887766",
    facts: [{ label: "Patient MRN", value: "00481234" }, { label: "Board", value: "Colorado Medical Board" }],
  }));
  const json = JSON.stringify(p.writes);
  for (const secret of ["123-45-6789", "1970-03-14", "99887766", "00481234"]) assert.ok(!json.includes(secret), secret);
  assert.equal(p.writes[0].row.custom_fields.Board, "Colorado Medical Board");
  assert.ok(p.withheld.length >= 3);
  assert.match(p.lines.join("\n"), /Left out on purpose: .*Social Security number/);
});

test("builtInFields leaves a JSON column only an array", () => {
  const { placed, extras } = builtInFields("healthRecords", { category: "Vaccination", type: "COVID-19", doses: "two", dateAdministered: "2021-04-01" });
  assert.equal(placed.doses, undefined);
  assert.equal(extras.Doses, "two");
  const ok = builtInFields("healthRecords", { category: "Vaccination", doses: [{ doseNumber: 1, date: "2021-03-01" }] });
  assert.deepEqual(ok.placed.doses, [{ doseNumber: 1, date: "2021-03-01" }]);
});

test("match rules find the credential already on file", () => {
  const lic = [{ id: "l1", type: "DEA Registration", state: "CA", license_number: "FW 123-4567" }, { id: "l2", type: "Certification", name: "Globus Excelsius", state: null }];
  assert.equal(findExisting("licenses", { licenseNumber: "fw1234567" }, lic)?.id, "l1", "same number, however it is punctuated");
  assert.equal(findExisting("licenses", { type: "DEA Registration", state: "ca" }, lic)?.id, "l1", "same type and state");
  assert.equal(findExisting("licenses", { type: "DEA Registration", state: "CO" }, lic), null, "another state is another licence");
  assert.equal(findExisting("licenses", { type: "Certification", name: "Medtronic course" }, lic), null, "a generic type needs the same name");
  assert.equal(findExisting("licenses", { type: "Certification", name: "globus excelsius" }, lic)?.id, "l2");

  assert.equal(findExisting("privileges", { facility: "The Mercy Hospital, Inc." }, [{ id: "p1", facility: "Mercy Hospital" }])?.id, "p1");
  assert.equal(findExisting("privileges", { facility: "Mercy Regional" }, [{ id: "p1", facility: "Mercy Hospital" }]), null);

  const ins = [{ id: "i1", policy_number: "PA-00991", provider: "ProAssurance", type: "Medical Malpractice (Claims-Made)" }];
  assert.equal(findExisting("insurance", { policyNumber: "pa00991" }, ins)?.id, "i1");
  assert.equal(findExisting("insurance", { provider: "ProAssurance", type: "Medical Malpractice (Claims-Made)" }, ins)?.id, "i1");
  assert.equal(findExisting("insurance", { provider: "ProAssurance", type: "Tail Coverage" }, ins), null);

  assert.equal(findExisting("education", { type: "Residency Certificate", institution: "UCLA" }, [{ id: "e1", type: "Residency Certificate", institution: "ucla" }])?.id, "e1");
  assert.equal(findExisting("cme", { title: "Spine Summit", date: "2026-08-14" }, [{ id: "c1", title: "Spine summit", date: "2026-08-14" }])?.id, "c1");
  assert.equal(findExisting("cme", { title: "Spine Summit", date: "2025-08-14" }, [{ id: "c1", title: "Spine summit", date: "2026-08-14" }]), null, "last year's course is another entry");
  assert.equal(findExisting("healthRecords", { type: "Influenza (Flu)", dateAdministered: "2026-10-01" }, [{ id: "h1", type: "Influenza (Flu)", date_administered: "2025-10-01" }]), null);
  assert.equal(findExisting("healthRecords", { type: "Influenza (Flu)", dateAdministered: "2025-10-01" }, [{ id: "h1", type: "Influenza (Flu)", date_administered: "2025-10-01" }])?.id, "h1");
});

test("a match fills only what is empty and moves the expiration only forward", () => {
  const existing = { id: "p1", type: "Full Admitting Privileges", facility: "Mercy", state: null, appointmentDate: "2024-01-01", expirationDate: "2026-01-01", customFields: { Note: "mine" } };
  const { changes, said } = fillEmpty(existing, { type: "Courtesy", state: "CO", appointmentDate: "2026-01-01", expirationDate: "2028-01-01" }, { Note: "theirs", Committee: "MEC" });
  assert.deepEqual(changes, { state: "CO", expirationDate: "2028-01-01", customFields: { Committee: "MEC", Note: "mine" } });
  assert.deepEqual(said, ["expiration moved to 01/01/2028", "filled 2 empty fields"]);
  assert.deepEqual(fillEmpty({ ...existing, state: "CO" }, { expirationDate: "2025-01-01" }, {}).changes, {}, "an earlier date is not a renewal");

  const p = plan(scanOf("privilege", { facility: "Mercy", type: "Courtesy", expirationDate: "2028-01-01" }), { rows: [toSnakeRow({ ...existing, userId: USER })] });
  assert.equal(p.outcome, "updated");
  assert.equal(p.recordId, "p1");
  assert.deepEqual(Object.keys(p.writes[0].row).sort(), ["expiration_date", "updated_at"]);
  assert.equal(p.document.linked_to, "privileges:p1");
  assert.match(p.lines[0], /^Added to an existing record: Mercy full admitting privileges -> Privileges \(expiration moved to 01\/01\/2028\)$/);

  const same = plan(scanOf("privilege", { facility: "Mercy", expirationDate: "2025-01-01" }), { rows: [toSnakeRow({ ...existing, state: "CO" })] });
  assert.equal(same.outcome, "linked");
  assert.deepEqual(same.writes, []);
  assert.match(same.lines[0], /the file is now attached to it/);
});

const badge = (over = {}) => scanOf("other", {
  name: "Mercy ID Badge", issuer: "Mercy", number: "B-100", expirationDate: "2027-12-31",
  facts: [{ label: "Department", value: "Neurosurgery" }],
  suggestedCategory: { name: "Hospital ID Badges", icon: "", fields: ["Department"] },
  ...over,
});

test("other: a new category is created with origin uploader, and the record carries the document", () => {
  const p = plan(badge());
  assert.equal(p.outcome, "created");
  const [cat, rec] = p.writes;
  assert.equal(cat.table, "custom_categories");
  assert.equal(cat.row.name, "Hospital ID Badges");
  assert.equal(cat.row.origin, "uploader");
  assert.equal(cat.row.user_id, USER);
  assert.equal(cat.row.archived_at, null);
  assert.equal(rec.table, "custom_records");
  assert.equal(rec.row.category_id, cat.id);
  assert.deepEqual(rec.row.document_ids, ["doc-1"]);
  assert.equal(rec.row.field_values.department, "Neurosurgery");
  assert.equal(p.document.linked_to, `customRecords:${rec.id}`);
  assert.deepEqual(p.lines, ["Created a new category: Hospital ID Badges", "Filed: Mercy ID Badge -> Hospital ID Badges (expires 12/31/2027)"]);
});

test("other: an existing category is reused whatever its case or plural, and a hidden one comes back", () => {
  const live = [{ id: "c1", user_id: USER, name: "hospital id badge", fields: [], archived_at: null }];
  const reuse = plan(badge(), { categories: live });
  assert.equal(reuse.writes.length, 1);
  assert.equal(reuse.writes[0].row.category_id, "c1");

  const hidden = [{ ...live[0], archived_at: "2026-01-01T00:00:00Z" }];
  const revive = plan(badge(), { categories: hidden });
  assert.deepEqual(revive.writes[0], { table: "custom_categories", op: "update", id: "c1", row: { archived_at: null, updated_at: NOW } });
  assert.equal(revive.writes[1].row.category_id, "c1");
  assert.match(revive.lines[0], /Brought back your hidden category/);
});

test("other: the same record already filed is added to, not duplicated", () => {
  const cats = [{ id: "c1", user_id: USER, name: "Hospital ID Badges", fields: [{ key: "department", label: "Department" }], archived_at: null }];
  const recs = [{ id: "r1", user_id: USER, category_id: "c1", category_name: "Hospital ID Badges", name: "Mercy ID Badge", number: "", expiration_date: "2026-12-31", field_values: {}, custom_fields: {}, document_ids: ["old-doc"] }];
  const p = plan(badge(), { categories: cats, rows: recs });
  assert.equal(p.outcome, "updated");
  assert.equal(p.writes.length, 1);
  const row = p.writes[0].row;
  assert.deepEqual(row.document_ids, ["old-doc", "doc-1"]);
  assert.equal(row.expiration_date, "2027-12-31");
  assert.equal(row.number, "B-100");
  assert.deepEqual(row.field_values, { department: "Neurosurgery" });
});

test("other with no suggested name still has a home", () => {
  const p = plan(badge({ suggestedCategory: { name: "" } }));
  assert.equal(p.writes[0].row.name, "Other documents");
});

test("receipts, CVs, unknowns and failed scans stay in the inbox, never dropped", () => {
  assert.deepEqual(filingTarget(scanOf("receipt", {})), { kind: "unfiled", reason: "receipt" });
  assert.deepEqual(filingTarget(scanOf("cv", {})), { kind: "unfiled", reason: "cv" });
  assert.deepEqual(filingTarget(scanOf("unknown", {})), { kind: "unfiled", reason: "unknown" });
  assert.deepEqual(filingTarget(null), { kind: "unfiled", reason: "error" });

  const receipt = plan(scanOf("receipt", { merchant: "Alamo Rent A Car", date: "2026-09-12", total: "45.2", category: "Tolls" }), { fileName: "IMG_1.jpg" });
  assert.equal(receipt.outcome, "unfiled");
  assert.deepEqual(receipt.writes, []);
  assert.deepEqual(receipt.document, { name: "Receipt - Alamo Rent A Car - 2026-09-12.jpg" });
  assert.match(receipt.lines[0], /^Saved, not filed yet: IMG_1\.jpg, a receipt from Alamo Rent A Car for \$45\.20 on 09\/12\/2026 \(open the app > Documents to file it\)/);

  const cv = plan(scanOf("cv", {}), { fileName: "cv.pdf" });
  assert.equal(cv.document, null);
  assert.match(cv.lines[0], /looks like your CV/);
  assert.equal(plan(null, { fileName: "x.pdf" }).lines[0], "Saved, not filed yet: x.pdf (open the app > Documents to file it)");
  assert.equal(unfiledLine("a.pdf", "unknown"), "Saved, not filed yet: a.pdf (open the app > Documents to file it)");
});

test("a scan that reads as a patient record is marked for removal", () => {
  const p = plan(scanOf("unknown", { text: "Operative note. MRN 00481234. Date of birth 03/14/1961. Discharge summary." }), { fileName: "op.pdf" });
  assert.equal(p.outcome, "removed");
  assert.deepEqual(p.writes, []);
  assert.match(p.lines[0], /^Not kept: op\.pdf reads like a patient record/);
  // A credential that mentions a birth date is not a chart.
  assert.equal(plan(scanOf("license", { type: "State Medical License (DO)", state: "CO", notes: "date of birth on file" })).outcome, "created");
});

test("labels: readable names that keep the extension, US dates, no em dashes", () => {
  assert.equal(docLabel(["Sanford Health Plan", "credentialing approval"], "Letter330567.PDF"), "Sanford Health Plan - credentialing approval.pdf");
  assert.equal(docLabel(["", ""], "Letter.pdf"), "Letter.pdf");
  assert.equal(docLabel(["A/B: C", ""], "x.png"), "A B C.png");
  assert.equal(usDate("2026-09-24"), "09/24/2026");
  const p = plan(scanOf("privilege", { facility: `Sanford ${EM_DASH} Fargo`, type: "Credentialing Approval", appointmentDate: "2026-09-24" }));
  assert.ok(!JSON.stringify(p.lines).includes(EM_DASH));
  assert.ok(!p.document.name.includes(EM_DASH));
  const dea = plan(scanOf("license", { type: "DEA Registration", name: "DEA Registration", state: "ND", expirationDate: "2028-01-31" }));
  assert.equal(dea.lines[0], "Filed: DEA Registration -> Licenses (expires 01/31/2028)");
});

test("the physician's reply: plain text, real line breaks, no em dash", () => {
  const text = filingReplyText({
    results: [{ lines: ["Filed: A -> Licenses"] }, { lines: [`Saved, not filed yet: b.pdf ${EM_DASH} x`] }],
    notes: ["1 attachment was skipped for size."], appUrl: "https://credentialdomd.com/app/",
  });
  assert.equal(text, [
    "Got it. Here is where everything went:", "",
    "Filed: A -> Licenses", "Saved, not filed yet: b.pdf - x", "",
    "1 attachment was skipped for size.", "",
    "Open the app: https://credentialdomd.com/app/ (Documents)", "",
    "CredentialDOMD", "https://credentialdomd.com",
  ].join("\n"));
  assert.match(filingReplyText({ results: [], appUrl: "u" }), /^Nothing new was added to your Documents\./);
});

test("the write scope of each filing section is the app's", () => {
  for (const section of [...Object.values(SCAN_SECTION), "customRecords"]) {
    assert.equal(sectionScope(section), PRACTICE_COLLECTIONS.has(section) ? "practice" : "credential", section);
  }
  assert.equal(sectionScope("locumContracts"), "practice");
});

test("only what Gemini reads inline is scanned", () => {
  for (const m of ["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "IMAGE/JPEG"]) assert.ok(scannableMime(m), m);
  for (const m of ["image/tiff", "image/gif", "application/msword", "", null]) assert.ok(!scannableMime(m), String(m));
});
