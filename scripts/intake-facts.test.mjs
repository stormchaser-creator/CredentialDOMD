// The facts step on plain objects: src/utils/intakeRecords.js (shared with
// the app) and supabase/functions/_shared/intakeFacts.mjs (the host's check,
// the rules' one pattern, the plan against the file). The end-to-end run is
// scripts/email-inbound-facts.test.mjs. Every email here is synthetic.
// Run: node --test scripts/intake-facts.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  amountsIn, amountValue, datesIn, dateValue, stateCode, recordFromFields, matchRecord, appendChanges, recordSummary, EMAIL_FIELDS, SECTION_TYPES,
} from "../src/utils/intakeRecords.js";
import {
  verifyRecords, corpusIndex, rulesRecords, planRecords, existingForModel, attachmentText, fitItems, itemsBytes, withSource, sourceLine, DROP, RECORDS_SCHEMA,
} from "../supabase/functions/_shared/intakeFacts.mjs";
import { SECTION_FIELDS } from "../src/utils/sectionFields.js";
import { INSURANCE_TYPES } from "../src/constants/credentialTypes.js";

const LETTER = "Dr. Testa,\n\nI checked with our risk team: the Quillfeather Staffing malpractice policy covers the emergency care you give while you are on an assignment with us.\n\nThe limits are $1,000,000 per incident and $3,000,000 aggregate, as set out in Section 7.2 of your professional services agreement.\n\nJordan Sample";
const LIMITS = "The limits are $1,000,000 per incident and $3,000,000 aggregate";
const ctx = (texts = [LETTER], extra = {}) => ({ corpus: corpusIndex(texts), physicianName: "Rowan Testa", ...extra });
const one = (fields, over = {}) => [{ section: "insurance", match_existing: "", fields: fields.map(([field, value, quote]) => ({ field, value, quote })), ...over }];

// ── Amounts, dates, states ──────────────────────────────────────────────────

test("an amount is the same amount however the email writes it; a bare number is not an amount", () => {
  for (const s of ["$1,000,000", "$1M", "$1 million", "1,000,000", "1 million", "$1.0 million", "1000000"]) assert.equal(amountValue(s), "1000000", s);
  assert.equal(amountValue("$250k"), "250000");
  assert.equal(amountValue("$1,000,000 and $3,000,000"), null, "one amount or none");
  assert.deepEqual(amountsIn("policy 4471902, limits $1M/$3M").map((a) => a.value), ["1000000", "3000000"], "a policy number is not an amount");
});

test("a date is the same date however the email writes it", () => {
  for (const s of ["2026-03-01", "03/01/2026", "3/1/2026", "3/1/26", "March 1, 2026", "Mar. 1 2026", "1 March 2026", "1st of March, 2026"]) assert.equal(dateValue(s), "2026-03-01", s);
  assert.equal(dateValue("Sept 30, 2026"), "2026-09-30");
  assert.equal(dateValue("02/30/2026"), null, "not a date");
  assert.deepEqual(datesIn("from 01/01/2026 to December 31, 2026").map((d) => d.iso), ["2026-01-01", "2026-12-31"]);
});

test("states: a code or a name, to the code", () => {
  assert.equal(stateCode("co"), "CO");
  assert.equal(stateCode("North Dakota"), "ND");
  assert.equal(stateCode("Atlantis"), "");
});

// ── What an email may fill ──────────────────────────────────────────────────

test("an email fills only real columns, and never an identifying number", () => {
  for (const [section, fields] of Object.entries(EMAIL_FIELDS)) {
    for (const k of Object.keys(fields)) {
      if (section !== "locumContracts") assert.ok(SECTION_FIELDS[section].includes(k), `${section}.${k} is a column`);
      assert.ok(!/number|npi|dea/i.test(k), `${section}.${k} is not an identifier`);
    }
  }
  assert.deepEqual(Object.keys(EMAIL_FIELDS.locumContracts), ["notes"], "a contract only ever takes a note");
  assert.deepEqual(SECTION_TYPES.insurance, INSURANCE_TYPES);
  assert.ok(RECORDS_SCHEMA.items.properties.fields.items.properties.field.enum.every((f) => !/number/i.test(f)));
});

test("recordFromFields: the record the app's own add stores, with no key that is not a column", () => {
  const r = recordFromFields("insurance", { provider: "Quillfeather Staffing (through its insurer)", coveragePerClaim: "1000000", policyNumber: "PL-4471902", bogus: 1 }, { id: "x" });
  assert.deepEqual(r, { type: "Other", provider: "Quillfeather Staffing (through its insurer)", coveragePerClaim: "1000000", id: "x", lifecycleStatus: "active", dateUnknown: false, statusSource: null });
  assert.deepEqual(recordFromFields("cme", { title: "Spine Update", hours: "6", date: "2026-09-12" }, { id: "c" }), { category: "Other", title: "Spine Update", hours: 6, date: "2026-09-12", id: "c" });
});

// ── The host's check ────────────────────────────────────────────────────────

test("the owner's case: every value in the email's own words, in the column's type", () => {
  const { records, dropped } = verifyRecords(one([
    ["type", "Medical Professional Liability Coverage", "the Quillfeather Staffing malpractice policy covers the emergency care"],
    ["provider", "Quillfeather Staffing (through its insurer)", "the Quillfeather Staffing malpractice policy covers the emergency care"],
    ["coveragePerClaim", "$1,000,000", LIMITS],
    ["coverageAggregate", "3000000", LIMITS],
  ]), ctx());
  assert.deepEqual(dropped, []);
  assert.deepEqual(records[0].fields, { type: "Medical Professional Liability Coverage", provider: "Quillfeather Staffing (through its insurer)", coveragePerClaim: "1000000", coverageAggregate: "3000000" });
  assert.equal(records[0].sources.coveragePerClaim, LIMITS);
});

test("a value or a name the email does not hold is dropped, and so is a quote it does not hold", () => {
  const { records, dropped } = verifyRecords(one([
    ["provider", "Brightline Mutual", "the Quillfeather Staffing malpractice policy covers the emergency care"],
    ["name", "Quillfeather Staffing malpractice coverage", "the Quillfeather Staffing malpractice policy covers the emergency care"],
    ["coveragePerClaim", "2000000", LIMITS],
    ["coverageAggregate", "3000000", "limits are three million in total for every provider"],
    ["effectiveDate", "2026-03-01", LIMITS],
    ["notes", "Limits $1,000,000 per incident and $5,000,000 aggregate.", LIMITS],
  ]), ctx());
  assert.deepEqual(dropped.map((d) => [d.field, d.why]), [
    ["provider", DROP.value], ["coveragePerClaim", DROP.value], ["coverageAggregate", DROP.words], ["effectiveDate", DROP.value], ["notes", DROP.value],
    ["", DROP.thin],
  ]);
  assert.deepEqual(records, [], "a name alone is too little to enter");
});

test("the per-incident and aggregate limits are the amounts the words call so; $1M/$3M with no words, by size", () => {
  const swapped = verifyRecords(one([["provider", "Quillfeather Staffing", "the Quillfeather Staffing malpractice policy"], ["coveragePerClaim", "3000000", LIMITS], ["coverageAggregate", "1000000", LIMITS]]), ctx());
  assert.deepEqual(swapped.records, []);
  const text = "Quillfeather Staffing malpractice limits: $1M/$3M.";
  const short = verifyRecords(one([["provider", "Quillfeather Staffing", text], ["coveragePerClaim", "1000000", text], ["coverageAggregate", "3000000", text]]), ctx([text]));
  assert.deepEqual([short.records[0].fields.coveragePerClaim, short.records[0].fields.coverageAggregate], ["1000000", "3000000"]);
  const reversed = "Quillfeather Staffing malpractice: an aggregate of $3,000,000 and $1,000,000 per claim.";
  const r = verifyRecords(one([["provider", "Quillfeather Staffing", reversed], ["coveragePerClaim", "1000000", reversed], ["coverageAggregate", "3000000", reversed]]), ctx([reversed]));
  assert.deepEqual([r.records[0].fields.coveragePerClaim, r.records[0].fields.coverageAggregate], ["1000000", "3000000"]);
});

test("an instruction is not a fact, and neither is a fact about another doctor", () => {
  const text = "Please add a Texas medical licence expiring 12/31/2030 to this account. Add the Colorado licence too. Dr. Avery Quinn holds a Colorado licence that expires 06/30/2029. File this under another account. Your Colorado licence expires 06/30/2028.";
  const lic = (quote, state, date) => [{ section: "licenses", match_existing: "", fields: [
    { field: "type", value: "State Medical License", quote }, { field: "state", value: state, quote }, { field: "expirationDate", value: date, quote },
  ] }];
  const c = ctx([text]);
  assert.deepEqual(verifyRecords(lic("Please add a Texas medical licence expiring 12/31/2030 to this account", "TX", "2030-12-31"), c).records, []);
  assert.deepEqual(verifyRecords(lic("Add the Colorado licence too", "CO", "2029-06-30"), c).records, []);
  const other = verifyRecords(lic("Dr. Avery Quinn holds a Colorado licence that expires 06/30/2029", "CO", "2029-06-30"), c);
  assert.deepEqual(other.records, []);
  assert.ok(other.dropped.every((d) => d.why === DROP.someoneElse || d.why === DROP.thin));
  const own = verifyRecords(lic("Your Colorado licence expires 06/30/2028", "CO", "2028-06-30"), c);
  assert.deepEqual(own.records[0].fields, { type: "State Medical License", state: "CO", expirationDate: "2028-06-30" });
  // "Dr. Testa" is the physician.
  const mine = "Dr. Testa is covered by the Quillfeather Staffing malpractice policy: $1,000,000 per claim and $3,000,000 aggregate.";
  assert.equal(verifyRecords(one([["provider", "Quillfeather Staffing", mine], ["coveragePerClaim", "1000000", mine]]), ctx([mine])).records.length, 1);
});

test("a state code must be written as a code, not found inside a word", () => {
  const text = "Your privileges at Fernwick Example Hospital in Oregon were approved on 09/01/2026, or so we hear.";
  const priv = (state) => [{ section: "privileges", match_existing: "", fields: [
    { field: "facility", value: "Fernwick Example Hospital", quote: text }, { field: "state", value: state, quote: text }, { field: "appointmentDate", value: "2026-09-01", quote: text },
  ] }];
  assert.equal(verifyRecords(priv("OR"), ctx([text])).records[0].fields.state, "OR", "by its name");
  const noState = verifyRecords(priv("IN"), ctx([text]));
  assert.equal(noState.records[0].fields.state, undefined, "\"in\" is a word, not Indiana");
});

test("identifiers are never kept: in a value, or in the words a value rests on", () => {
  const text = "Your certificate lists policy number PL-4471902 and NPI 1234567893. The Quillfeather Staffing malpractice limits are $1,000,000 per claim and $3,000,000 aggregate. Code FW1234567 applies.";
  const { records, dropped } = verifyRecords(one([
    ["provider", "Quillfeather Staffing", "The Quillfeather Staffing malpractice limits are $1,000,000 per claim and $3,000,000 aggregate"],
    ["coveragePerClaim", "1000000", "The Quillfeather Staffing malpractice limits are $1,000,000 per claim and $3,000,000 aggregate"],
    ["name", "Quillfeather PL-4471902", "Your certificate lists policy number PL-4471902 and NPI 1234567893"],
    ["notes", "Code FW1234567 applies.", "Code FW1234567 applies"],
    ["effectiveDate", "2026-01-01", "Your certificate lists policy number PL-4471902 and NPI 1234567893"],
  ]), ctx([text]));
  assert.deepEqual(dropped.map((d) => d.field).sort(), ["effectiveDate", "name", "notes"]);
  assert.ok(!/4471902|1234567893|FW1234567/.test(JSON.stringify(records)));
});

test("a record names only a record the model was shown, by ref, and a contract takes only a note", () => {
  const { lines, refs } = existingForModel({
    insurance: [{ id: "ins-1", type: "Medical Malpractice (Claims-Made)", provider: "Example Mutual", policyNumber: "PL-9", coveragePerClaim: "1000000", expirationDate: "2027-06-30" }],
    locumContracts: [{ id: "con-1", facility: "Fernwick Example Hospital", agency: "Quillfeather Staffing", startDate: "2026-09-01" }],
  });
  assert.deepEqual(lines, ["R1 insurance: Medical Malpractice (Claims-Made), Example Mutual, per claim 1000000, expirationDate 2027-06-30", "R2 locumContracts: Fernwick Example Hospital, agency Quillfeather Staffing, startDate 2026-09-01"]);
  assert.ok(!lines.join().includes("PL-9") && !lines.join().includes("ins-1"));
  const note = "Section 9 of the agreement applies to every assignment with Quillfeather Staffing.";
  const c = ctx([note], { refs });
  const onContract = verifyRecords([{ section: "note", match_existing: "R2", fields: [{ field: "notes", value: note, quote: note }, { field: "facility", value: "Elsewhere", quote: note }] }], c);
  assert.deepEqual(onContract.records, [{ section: "locumContracts", fields: { notes: note }, sources: { notes: note }, matchExistingId: "con-1" }]);
  assert.deepEqual(verifyRecords([{ section: "locumContracts", match_existing: "", fields: [{ field: "notes", value: note, quote: note }] }], c).records, [], "never a new contract");
  assert.deepEqual(verifyRecords([{ section: "note", match_existing: "R9", fields: [{ field: "notes", value: note, quote: note }] }], c).records, [], "an unknown ref names nothing");
});

test("attachmentText: an attachment's words for the model and the check, no identifying number", () => {
  const t = attachmentText({ documentType: "insurance", extracted: { provider: "Example Mutual", policyNumber: "PL-4471902", billTo: "ap@x.example", notes: "Claims made, $1M/$3M." } });
  assert.equal(t, "provider: Example Mutual\nnotes: Claims made, $1M/$3M.");
  assert.equal(attachmentText({ patientRecord: true }), "");
});

// ── The rules' one pattern ──────────────────────────────────────────────────

test("rulesRecords: a malpractice limit with the agency named, and nothing else", () => {
  const [r] = rulesRecords({ message: LETTER, subject: "Malpractice coverage", agencies: ["Quillfeather Staffing"] });
  const fields = Object.fromEntries(r.fields.map((f) => [f.field, f.value]));
  assert.equal(fields.provider, "Quillfeather Staffing (through its insurer)");
  assert.equal(fields.name, "Quillfeather Staffing assignment malpractice coverage");
  const { records } = verifyRecords([r], ctx());
  assert.deepEqual([records[0].fields.coveragePerClaim, records[0].fields.coverageAggregate], ["1000000", "3000000"]);
  // No agency on file: the email's own "the <Name> malpractice policy".
  assert.equal(rulesRecords({ message: LETTER }).length, 1);
  // An insurer is the provider itself.
  const insurer = "Your coverage is through Example Mutual Insurance. Malpractice limits are $2,000,000 per occurrence and $4,000,000 aggregate.";
  assert.equal(Object.fromEntries(rulesRecords({ message: insurer })[0].fields.map((f) => [f.field, f.value])).provider, "Example Mutual Insurance");
  // Limits with nothing about malpractice, or no name, or no aggregate: nothing.
  assert.deepEqual(rulesRecords({ message: "The auto policy limits are $1,000,000 per incident and $3,000,000 aggregate for Fleet Co." }), []);
  assert.deepEqual(rulesRecords({ message: "Malpractice limits are $1,000,000 per incident and $3,000,000 aggregate." }), []);
  assert.deepEqual(rulesRecords({ message: "The Quillfeather Staffing malpractice policy pays $1,000,000 per incident." }), []);
});

// ── Against the file ────────────────────────────────────────────────────────

const OWNER_FIELDS = { type: "Medical Professional Liability Coverage", provider: "Quillfeather Staffing (through its insurer)", coveragePerClaim: "1000000", coverageAggregate: "3000000", notes: "Covers emergency care." };

test("matchRecord: the same carrier and the same limits, however written; other limits are another policy", () => {
  const rows = [{ id: "a", provider: "Quillfeather Staffing", coveragePerClaim: "$1,000,000", coverageAggregate: "$3,000,000" }, { id: "b", provider: "Example Mutual", coveragePerClaim: "1000000", coverageAggregate: "3000000" }];
  assert.equal(matchRecord("insurance", OWNER_FIELDS, rows)?.id, "a");
  assert.equal(matchRecord("insurance", { ...OWNER_FIELDS, coverageAggregate: "5000000" }, rows), null);
  assert.equal(matchRecord("insurance", { provider: "Quillfeather Staffing", type: "Tail Coverage" }, [{ id: "c", provider: "Quillfeather Staffing", type: "Tail Coverage" }])?.id, "c");
});

test("appendChanges: fills what is empty, adds a note once, never moves an expiration", () => {
  const existing = { id: "a", provider: "Quillfeather Staffing", expirationDate: "2027-01-01", notes: "Mine.\n\nCovers emergency care.\nSource: Email from Jordan Sample, 09/25/2026." };
  const { changes } = appendChanges("insurance", existing, { ...OWNER_FIELDS, expirationDate: "2029-01-01", effectiveDate: "2026-03-01", notes: "Covers emergency care.\nSource: Email from Jordan Sample, 10/02/2026." });
  assert.deepEqual(changes, { type: "Medical Professional Liability Coverage", coveragePerClaim: "1000000", coverageAggregate: "3000000", effectiveDate: "2026-03-01" });
  assert.deepEqual(appendChanges("insurance", { notes: "Mine." }, { notes: "New term." }).changes, { notes: "Mine.\n\nNew term." });
});

test("planRecords: a new fact, an addition, nothing when the file says it, nothing when it waits for an answer", () => {
  const rec = withSource({ section: "insurance", fields: OWNER_FIELDS, sources: {}, matchExistingId: null }, sourceLine("Jordan Sample", "2026-09-25T16:10:00Z"));
  assert.equal(rec.fields.statusSource, "Email from Jordan Sample, 09/25/2026");
  assert.equal(rec.fields.notes, "Covers emergency care.\nSource: Email from Jordan Sample, 09/25/2026.");
  assert.deepEqual(planRecords([rec], {}).map((p) => p.op), ["insert"]);
  const written = { id: "w", ...recordFromFields("insurance", rec.fields, { id: "w" }) };
  assert.deepEqual(planRecords([rec], { insurance: [written] }).map((p) => p.op), ["none"], "the same letter again");
  const later = withSource({ ...rec, fields: { ...OWNER_FIELDS } }, sourceLine("Jordan Sample", "2026-10-02T09:00:00Z"));
  assert.deepEqual(planRecords([later], { insurance: [written] }).map((p) => p.op), ["none"], "forwarded again another day");
  const [add] = planRecords([{ ...rec, fields: { ...rec.fields, effectiveDate: "2026-03-01" } }], { insurance: [written] });
  assert.deepEqual([add.op, add.id, Object.keys(add.changes)], ["update", "w", ["effectiveDate"]]);
  assert.deepEqual(add.before, { effectiveDate: null });
  assert.deepEqual(planRecords([rec], {}, { insurance: [rec.fields] }).map((p) => p.op), ["pending"]);
  assert.equal(planRecords([rec, { ...rec, fields: { ...rec.fields, effectiveDate: "2026-03-01" } }], {}).length, 1, "the same fact twice in one email is one record");
});

test("recordSummary and fitItems: a line the physician reads, and a note that fits in 4 KB", () => {
  assert.equal(recordSummary("insurance", { ...OWNER_FIELDS, effectiveDate: "2026-03-01" }), "Insurance: Quillfeather Staffing (through its insurer), $1,000,000 per claim, $3,000,000 aggregate, effective 03/01/2026");
  const long = "x".repeat(600);
  const items = [1, 2, 3].map((i) => ({ key: `r${i}`, kind: "record", section: "insurance", fields: { ...OWNER_FIELDS, notes: long }, sources: Object.fromEntries(Object.keys(OWNER_FIELDS).map((k) => [k, long.slice(0, 200)])), state: "proposed" }));
  assert.ok(itemsBytes(items) > 3800);
  const fitted = fitItems(items);
  assert.ok(itemsBytes(fitted) <= 3800);
  assert.deepEqual(fitted.map((i) => i.fields.coveragePerClaim), ["1000000", "1000000", "1000000"], "never a value the physician would add");
  // An append to a long note on file: what Undo would restore of the note goes first.
  const append = [{ key: "r1", kind: "record", section: "insurance", op: "append", fields: { effectiveDate: "2026-03-01", notes: "New." }, sources: {}, before: { effectiveDate: null, notes: "y".repeat(3000) }, after: { effectiveDate: "2026-03-01", notes: `${"y".repeat(3000)}\n\nNew.` }, state: "written" }];
  const small = fitItems(append);
  assert.ok(itemsBytes(small) <= 3800);
  assert.deepEqual([small[0].before, small[0].after], [{ effectiveDate: null }, { effectiveDate: "2026-03-01" }]);
});
