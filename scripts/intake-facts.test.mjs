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
  RECORDS_PROMPT, withoutConditions, agreementEffective, agreementCoverageStart,
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
  assert.deepEqual(onContract.records, [{ section: "locumContracts", fields: { notes: note }, sources: { notes: note }, matchExistingId: "con-1", notesVerbatim: note, noteOnly: true }]);
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

// ── Review findings, 2026-09-28 ─────────────────────────────────────────────
// New exports are read through the modules' namespaces, so each test below
// fails on its own (not the whole file) against code without its fix.
import * as Facts from "../supabase/functions/_shared/intakeFacts.mjs";
import * as Records from "../src/utils/intakeRecords.js";

const fieldMap = (rec) => Object.fromEntries((rec?.fields || []).map((f) => [f.field, f.value]));
const limitsOf = (q, text = q) => {
  const { records } = verifyRecords(one([["provider", "Quillfeather Staffing", "Quillfeather Staffing"], ["coveragePerClaim", "1000000", q], ["coverageAggregate", "3000000", q]]), ctx([text, "Quillfeather Staffing"]));
  return [records[0]?.fields.coveragePerClaim ?? null, records[0]?.fields.coverageAggregate ?? null];
};

test("a limit's label may come before its amount: every common layout keeps both limits", () => {
  for (const q of [
    "The limits are per incident $1,000,000 and aggregate $3,000,000",
    "a per claim limit of $1,000,000 and an aggregate limit of $3,000,000",
    "Each Claim: $1,000,000 Aggregate: $3,000,000",
    "The limits are $1,000,000 per incident and $3,000,000 aggregate",
    "an aggregate of $3,000,000 and $1,000,000 per claim",
    "$1,000,000 per claim $3,000,000 aggregate",
    "The per claim limit is $1,000,000; the aggregate limit is $3,000,000",
  ]) assert.deepEqual(limitsOf(q), ["1000000", "3000000"], q);
  // And still never swapped.
  const swapped = verifyRecords(one([["provider", "Quillfeather Staffing", "Quillfeather Staffing"], ["coveragePerClaim", "3000000", "Each Claim: $1,000,000 Aggregate: $3,000,000"], ["coverageAggregate", "1000000", "Each Claim: $1,000,000 Aggregate: $3,000,000"]]), ctx(["Each Claim: $1,000,000 Aggregate: $3,000,000 Quillfeather Staffing"]));
  assert.deepEqual(swapped.records, []);
});

test("\"1M/3M\" and spelled-out limits are amounts; a bare digit run still is not", () => {
  assert.deepEqual(amountsIn("The limits are 1M/3M").map((a) => a.value), ["1000000", "3000000"]);
  assert.deepEqual(amountsIn("limits 1MM per claim and 3MM aggregate").map((a) => a.value), ["1000000", "3000000"]);
  assert.deepEqual(amountsIn("one million dollars per incident and three million dollars aggregate").map((a) => a.value), ["1000000", "3000000"]);
  assert.deepEqual(amountsIn("3M Company, suite 4471902"), [], "a scale with no limit word near it, and a bare number, are not amounts");
  assert.deepEqual(limitsOf("The limits are 1M/3M"), ["1000000", "3000000"]);
  assert.deepEqual(limitsOf("one million dollars per incident and three million dollars aggregate"), ["1000000", "3000000"]);
});

test("matchRecord: a policy on file with blank limits is the same policy, by its provider or its name, and is filled rather than doubled", () => {
  const onFile = [{ id: "hand", provider: "Quillfeather Staffing (through its insurer)", type: "Medical Professional Liability Coverage" }];
  assert.equal(matchRecord("insurance", OWNER_FIELDS, onFile)?.id, "hand");
  // The agency in the row's name, the actual carrier in its provider.
  const named = [{ id: "n", name: "Quillfeather Staffing malpractice", provider: "Osterly Example Mutual", coveragePerClaim: "1000000" }];
  assert.equal(matchRecord("insurance", OWNER_FIELDS, named)?.id, "n");
  // A row whose limits differ, or a name that names no one, is not it.
  assert.equal(matchRecord("insurance", OWNER_FIELDS, [{ id: "x", provider: "Quillfeather Staffing", coveragePerClaim: "2000000" }]), null);
  assert.equal(matchRecord("insurance", OWNER_FIELDS, [{ id: "y", name: "Malpractice coverage" }]), null);
  // The exact limits win over a blank row.
  assert.equal(matchRecord("insurance", OWNER_FIELDS, [...onFile, { id: "exact", provider: "Quillfeather Staffing", coveragePerClaim: "1000000", coverageAggregate: "3000000" }])?.id, "exact");
  const plan = planRecords([{ section: "insurance", fields: OWNER_FIELDS, sources: {}, matchExistingId: null }], { insurance: onFile });
  assert.deepEqual([plan[0].op, plan[0].id, Object.keys(plan[0].changes).sort()], ["update", "hand", ["coverageAggregate", "coveragePerClaim", "notes"]]);
});

test("a record the reading names is used only when the checked fields do not contradict it", () => {
  const personal = { id: "mine", provider: "Examplecare Mutual", coveragePerClaim: "2000000", coverageAggregate: "4000000", notes: "Personal policy." };
  const osterly = { id: "osterly", provider: "Osterly Example Mutual" };
  const rec = { section: "insurance", fields: { ...OWNER_FIELDS, effectiveDate: "2026-03-01" }, sources: {} };
  for (const named of [personal, osterly]) {
    const plan = planRecords([{ ...rec, matchExistingId: named.id }], { insurance: [personal, osterly] });
    assert.deepEqual(plan.map((p) => p.op), ["insert"], named.id);
  }
  assert.equal(Records.conflictsWith?.("insurance", OWNER_FIELDS, personal), true);
  assert.equal(Records.conflictsWith?.("insurance", { effectiveDate: "2026-03-01" }, personal), false, "nothing to contradict");
  assert.equal(Records.conflictsWith?.("licenses", { type: "State Medical License", state: "TX" }, { type: "State Medical License", state: "CO" }), true);
  // Named and consistent: added to.
  const same = { id: "same", provider: "Quillfeather Staffing (through its insurer)" };
  assert.deepEqual(planRecords([{ ...rec, matchExistingId: "same" }], { insurance: [same] }).map((p) => [p.op, p.id]), [["update", "same"]]);
  // A note for a record must be about that record.
  const { refs } = existingForModel({ insurance: [personal] });
  const text = "The Quillfeather Staffing policy is claims made. Examplecare Mutual renewed your policy.";
  const off = verifyRecords([{ section: "note", match_existing: "R1", fields: [{ field: "notes", value: "The Quillfeather Staffing policy is claims made.", quote: "The Quillfeather Staffing policy is claims made" }] }], ctx([text], { refs }));
  assert.deepEqual(off.records, []);
  assert.equal(off.dropped[0].why, DROP.notAbout);
  const on = verifyRecords([{ section: "note", match_existing: "R1", fields: [{ field: "notes", value: "Examplecare Mutual renewed the policy.", quote: "Examplecare Mutual renewed your policy" }] }], ctx([text], { refs }));
  assert.equal(on.records.length, 1);
});

test("the same letter again, its note worded another way, adds nothing: not to the record, not as a second proposal", () => {
  const line = sourceLine("Jordan Sample", "2026-09-25T16:10:00Z");
  const first = withSource({ section: "insurance", fields: { ...OWNER_FIELDS, notes: "Covers emergency care on an assignment. Limits $1,000,000 per incident and $3,000,000 aggregate." }, sources: {}, matchExistingId: null }, line);
  const written = { id: "w", ...recordFromFields("insurance", first.fields, { id: "w" }) };
  const again = withSource({ ...first, fields: { ...OWNER_FIELDS, notes: "Emergency care on assignments is covered, with limits of $1,000,000 per incident and $3,000,000 aggregate." } }, sourceLine("Jordan Sample", "2026-10-02T09:00:00Z"));
  assert.deepEqual(planRecords([again], { insurance: [written] }).map((p) => p.op), ["none"]);
  assert.deepEqual(planRecords([again], {}, { insurance: [first.fields] }).map((p) => p.op), ["pending"]);
  // A new amount, date or name is news; so is another sender.
  const news = withSource({ ...first, fields: { ...OWNER_FIELDS, notes: "Tail coverage runs to 12/31/2030." } }, line);
  assert.deepEqual(planRecords([news], { insurance: [written] }).map((p) => p.op), ["update"]);
  const other = withSource({ ...again }, sourceLine("Casey Example", "2026-10-02T09:00:00Z"));
  assert.deepEqual(planRecords([{ ...again, fields: { ...again.fields, notes: other.fields.notes.replace(/Source: Email from Jordan Sample[^\n]*/, "") } }], { insurance: [written] }).map((p) => p.op), ["update"]);
});

test("instructions anywhere in the sentence, and licences not said to be the physician's, are not facts", () => {
  const text = "You should add a Texas medical licence expiring 12/31/2030 to your profile. Your records should show a Texas medical licence expiring 12/31/2030. Avery Quinn holds a Texas medical licence that expires 12/31/2030. Quillfeather Staffing holds a Texas medical licence that expires 12/31/2030. Your Texas medical licence expires 12/31/2030.";
  const lic = (quote) => [{ section: "licenses", match_existing: "", fields: [
    { field: "type", value: "State Medical License", quote }, { field: "state", value: "TX", quote }, { field: "expirationDate", value: "2030-12-31", quote },
  ] }];
  for (const q of ["You should add a Texas medical licence expiring 12/31/2030 to your profile", "Your records should show a Texas medical licence expiring 12/31/2030",
    "Avery Quinn holds a Texas medical licence that expires 12/31/2030", "Quillfeather Staffing holds a Texas medical licence that expires 12/31/2030"]) {
    assert.deepEqual(verifyRecords(lic(q), ctx([text])).records, [], q);
  }
  assert.equal(verifyRecords(lic("Your Texas medical licence expires 12/31/2030"), ctx([text])).records.length, 1, "the physician's own licence stands");
});

test("a colleague named with the letters after the name is someone else, and an email naming another clinician is only offered", () => {
  const text = "For your records, Jordan Roe, MD is insured under the Lanternfield Mutual malpractice policy with limits of $1,000,000 per claim and $3,000,000 aggregate.";
  const quote = text.replace(/\.$/, "");
  const r = verifyRecords(one([["provider", "Lanternfield Mutual", quote], ["coveragePerClaim", "1000000", quote], ["coverageAggregate", "3000000", quote]]), ctx([text]));
  assert.deepEqual(r.records, []);
  assert.ok(r.dropped.some((d) => d.why === DROP.someoneElse));
  assert.deepEqual(rulesRecords({ message: text }).flatMap((x) => verifyRecords([x], ctx([text])).records), []);
  // The physician's own coverage in a letter that also names another doctor: kept, for review.
  const letter = `${LETTER}\n\ncc: Dr. Avery Quinn`;
  const own = verifyRecords(one([["provider", "Quillfeather Staffing", "the Quillfeather Staffing malpractice policy"], ["coveragePerClaim", "1000000", LIMITS], ["coverageAggregate", "3000000", LIMITS]]), ctx([letter]));
  assert.equal(own.records.length, 1);
  assert.equal(own.review, true);
  assert.equal(verifyRecords(one([["provider", "Quillfeather Staffing", "the Quillfeather Staffing malpractice policy"], ["coveragePerClaim", "1000000", LIMITS]]), ctx()).review, false, "\"Dr. Testa\" is the physician");
  // "Fernwick Example Hospital, MD" is a hospital in Maryland.
  assert.equal(verifyRecords(one([["provider", "Quillfeather Staffing", "the Quillfeather Staffing malpractice policy"], ["coveragePerClaim", "1000000", LIMITS]]), ctx([`${LETTER} Fernwick Example Hospital, MD`])).review, false);
});

test("rules: a limit that is a requirement, a limit about another clinician, or \"through December 31\" is never coverage", () => {
  const agencies = ["Quillfeather Staffing"];
  const required = "For your file: physicians working with Quillfeather Staffing must carry their own malpractice insurance with limits of $1,000,000 per claim and $3,000,000 aggregate.";
  assert.deepEqual(rulesRecords({ message: required, agencies }), []);
  const bylaws = "Fernwick Example Hospital's medical staff bylaws call for malpractice limits of $2,000,000 per occurrence and $4,000,000 aggregate for every locum physician. The Quillfeather Staffing malpractice policy carries lower limits, so please check with them.";
  assert.deepEqual(rulesRecords({ message: bylaws, agencies }), []);
  const december = "Your malpractice coverage runs through December 31, 2026 with limits of $1,000,000 per claim and $3,000,000 aggregate.";
  assert.ok(!JSON.stringify(rulesRecords({ message: december })).includes("December ("), "no insurer named December");
  // The owner's letter still reads.
  assert.equal(rulesRecords({ message: LETTER, agencies }).length, 1);
});

// The owner's real letter of 2026-09-28 followed its limits with a condition
// that says "required", named the agency without the "Inc." its contract
// carries, and put the agency before "provides". Each of the three kept the
// rules from reading the one fact they can, and so from reading the letter
// as informational.
test("rules: a requirement inside a condition is not one, the agency is read as the email writes it, and a limit only inside a condition is not coverage", () => {
  const limits = "In *Section 4.1 (Professional Liability Coverage)* of your agreement, Brightwater Locum Partners provides professional liability insurance for work on each Assignment at $2,000,000 per claim and a $4,000,000 annual aggregate, or more if a state statute requires it.";
  assert.equal(withoutConditions("limits of $2,000,000 per claim and $4,000,000 aggregate, raised if required under the state's law."), "limits of $2,000,000 per claim and $4,000,000 aggregate, raised .");
  const [rec] = rulesRecords({ message: `Dr. Testa,\n\n${limits}` });
  const f = fieldMap(rec);
  assert.deepEqual([f.provider, f.name, f.coveragePerClaim, f.coverageAggregate], ["Brightwater Locum Partners (through its insurer)", "Brightwater Locum Partners assignment malpractice coverage", "$2,000,000", "$4,000,000"]);
  const checked = verifyRecords([rec], ctx([limits]));
  assert.deepEqual([checked.records[0].fields.coveragePerClaim, checked.records[0].fields.coverageAggregate], ["2000000", "4000000"]);
  // An agency on file as "Copperline Physician Staffing, Inc." is the one the letter calls "Copperline Physician Staffing".
  const copper = "Your malpractice coverage for these cases is in place under Section 5.4 of your agreement. Copperline Physician Staffing arranges that coverage through its carrier at $2,000,000 per claim and $6,000,000 aggregate (higher if required under state law).";
  assert.equal(fieldMap(rulesRecords({ message: copper, agencies: ["Copperline Physician Staffing, Inc."] })[0]).provider, "Copperline Physician Staffing (through its insurer)");
  assert.deepEqual(rulesRecords({ message: copper, agencies: ["Staffing, Inc."] }), [], "a suffix-less name must still name someone");
  // "The Agency provides ..." names nobody.
  assert.deepEqual(rulesRecords({ message: "The Agency provides malpractice insurance with limits of $2,000,000 per claim and $4,000,000 aggregate." }), []);
  // Still requirements: outside the condition, or with the limits only inside it.
  assert.deepEqual(rulesRecords({ message: "Physicians must carry malpractice limits of $2,000,000 per claim and $4,000,000 aggregate as required by the bylaws; Brightwater Locum Partners provides a group policy.", agencies: ["Brightwater Locum Partners"] }), []);
  const inside = "If you are required to carry limits of $2,000,000 per claim and $4,000,000 aggregate, the Brightwater Locum Partners malpractice policy covers you.";
  // "As the bylaws require" says the requirement is there: still a requirement.
  assert.deepEqual(rulesRecords({ message: "Limits of $2,000,000 per claim and $4,000,000 aggregate, as the medical staff bylaws require. The Brightwater Locum Partners malpractice policy covers you.", agencies: ["Brightwater Locum Partners"] }), []);
  const v = verifyRecords(one([["provider", "Brightwater Locum Partners", inside], ["coveragePerClaim", "2000000", inside], ["coverageAggregate", "4000000", inside]]), ctx([inside]));
  assert.deepEqual(v.records, []);
  assert.deepEqual(v.dropped.filter((d) => d.field.startsWith("coverage")).map((d) => d.why), [DROP.requirement, DROP.requirement]);
});

test("rules: the insurer the limits sentence names is the provider, over any agency on file named elsewhere", () => {
  const letter = "This confirms that your assignment through Quillfeather Staffing is on our schedule. Your malpractice coverage through Examplecare Mutual Insurance of $1,000,000 per claim and $3,000,000 aggregate is on file with the medical staff office.";
  const f = fieldMap(rulesRecords({ message: letter, agencies: ["Quillfeather Staffing"] })[0]);
  assert.equal(f.provider, "Examplecare Mutual Insurance");
  assert.equal(f.name, "Examplecare Mutual Insurance malpractice coverage");
  const q = rulesRecords({ message: letter, agencies: ["Quillfeather Staffing"] })[0].fields.find((x) => x.field === "provider").quote;
  assert.match(q, /^Your malpractice coverage through Examplecare/);
});

test("rules: an effective date only when a sentence says the policy took effect then, never a date that ends something", () => {
  const base = `${LETTER}\n\n`;
  const eff = (tail) => fieldMap(rulesRecords({ message: base + tail, agencies: ["Quillfeather Staffing"] })[0]).effectiveDate;
  assert.equal(eff("Your credentialing file is effective through 12/31/2026."), undefined);
  assert.equal(eff("Tail coverage is in effect for claims after 12/31/2026."), undefined);
  assert.equal(eff("The policy took effect on 03/01/2026."), "2026-03-01");
});

// The owner entered the attached agreement's "effective as of" date as the
// coverage's start; the model left it out. The host takes it from the
// agreement's own words when the email states no start, and checks any the
// reading gives against that agreement.
const AGREEMENT_WORDS = "agency: Brightwater Locum Partners, LLC\nnotes: Locum services agreement between Brightwater Locum Partners, LLC and Rowan Testa, MD, effective as of January 12, 2026, for twelve months. Section 4.1: Brightwater carries malpractice insurance for the physician on every Assignment.";
const COVER_LETTER = "Following up on our call. In Section 4.1 of your agreement, Brightwater Locum Partners provides professional liability insurance on each Assignment at $2,000,000 per claim and a $4,000,000 annual aggregate.";
const agreementCtx = (email = COVER_LETTER, attachments = [AGREEMENT_WORDS], physicianName = "Rowan Testa") => ({ corpus: corpusIndex([email, ...attachments]), email, attachments, physicianName });
const BW = "Brightwater Locum Partners provides professional liability insurance";
const BW_LIMITS = "$2,000,000 per claim and a $4,000,000 annual aggregate";
const bwRecord = (extra = []) => one([["type", "Medical Professional Liability Coverage", BW], ["provider", "Brightwater Locum Partners (through its insurer)", BW], ["coveragePerClaim", "2000000", BW_LIMITS], ["coverageAggregate", "4000000", BW_LIMITS], ...extra]);

test("an attached agreement's effective date: read from its words, one date, and only the agreement's", () => {
  const a = agreementEffective([AGREEMENT_WORDS]);
  assert.equal(a.iso, "2026-01-12");
  assert.deepEqual(a.quotes, ["Locum services agreement between Brightwater Locum Partners, LLC and Rowan Testa, MD, effective as of January 12, 2026", "effective as of January 12, 2026"]);
  assert.equal(agreementEffective(["notes: Physician staffing agreement with Example Staffing, effective on 07/06/2026 and continuing until either party ends it."]).iso, "2026-07-06");
  assert.equal(agreementEffective(["notes: Agreement, Example Staffing and the physician; effective as of May 18, 2026; one-year term."]).iso, "2026-05-18", "the agreement named earlier in the sentence");
  assert.equal(agreementEffective(["notes: The certificate is effective as of May 18, 2026."]), null, "not an agreement");
  assert.equal(agreementEffective(["notes: Agreement signed May 18, 2026, terminating December 31, 2026."]), null, "no effective date");
  assert.equal(agreementEffective([AGREEMENT_WORDS, "notes: Master agreement effective as of March 2, 2026."]), null, "two agreements that differ");
  // The email states its own start: the agreement's is not used.
  assert.equal(agreementCoverageStart("Your malpractice policy took effect on 02/01/2026 under the agreement.", [AGREEMENT_WORDS]), null);
  // Nothing ties malpractice cover to the agreement: not used.
  assert.equal(agreementCoverageStart("Your badge is ready.", ["notes: Locum services agreement effective as of January 12, 2026."]), null);
  assert.equal(agreementCoverageStart(COVER_LETTER, [AGREEMENT_WORDS]).iso, "2026-01-12");
  assert.match(RECORDS_PROMPT, /effectiveDate \(when the coverage began[^)]*"effective as of <date>"/);
});

test("verifyRecords: an insurance record takes the attached agreement's start, with the agreement's words as its source", () => {
  // The reading gave no start: the host fills it.
  const filled = verifyRecords(bwRecord(), agreementCtx());
  assert.equal(filled.records[0].fields.effectiveDate, "2026-01-12");
  assert.equal(filled.records[0].sources.effectiveDate, "Locum services agreement between Brightwater Locum Partners, LLC and Rowan Testa, MD, effective as of January 12, 2026");
  // Without the physician's name, the sentence that names a doctor is not quoted; the date's own words are.
  assert.equal(verifyRecords(bwRecord(), agreementCtx(COVER_LETTER, [AGREEMENT_WORDS], "")).records[0].sources.effectiveDate, "effective as of January 12, 2026");
  // The reading gave the agreement's start, from the agreement's words: kept.
  const given = verifyRecords(bwRecord([["effectiveDate", "2026-01-12", "effective as of January 12, 2026"]]), agreementCtx());
  assert.deepEqual([given.records[0].fields.effectiveDate, given.records[0].sources.effectiveDate], ["2026-01-12", "effective as of January 12, 2026"]);
  // Another date from an attachment is not the agreement's start: dropped, and the agreement's is used.
  const other = "notes: Locum services agreement between Brightwater Locum Partners, LLC and Rowan Testa, MD, effective as of January 12, 2026, for twelve months. Signed February 3, 2026. Section 4.1: Brightwater carries malpractice insurance for the physician on every Assignment.";
  const wrong = verifyRecords(bwRecord([["effectiveDate", "2026-02-03", "Signed February 3, 2026"]]), agreementCtx(COVER_LETTER, [other]));
  assert.equal(wrong.records[0].fields.effectiveDate, "2026-01-12");
  assert.ok(wrong.dropped.some((d) => d.field === "effectiveDate" && d.why === DROP.agreementDate));
  // The email states its own start: that one, never the agreement's.
  const own = `${COVER_LETTER} The policy took effect on 02/01/2026.`;
  const stated = verifyRecords(bwRecord([["effectiveDate", "2026-01-12", "effective as of January 12, 2026"]]), agreementCtx(own));
  assert.equal(stated.records[0].fields.effectiveDate, undefined);
  assert.ok(stated.dropped.some((d) => d.why === DROP.agreementDate));
  assert.equal(verifyRecords(bwRecord([["effectiveDate", "2026-02-01", "The policy took effect on 02/01/2026"]]), agreementCtx(own)).records[0].fields.effectiveDate, "2026-02-01");
  // Another carrier's policy is not the agreement's party's coverage.
  const mutual = "Your Lanternfield Mutual malpractice policy has limits of $2,000,000 per claim and $4,000,000 aggregate under your agreement.";
  const lf = verifyRecords(one([["provider", "Lanternfield Mutual", mutual], ["coveragePerClaim", "2000000", mutual]]), agreementCtx(mutual));
  assert.equal(lf.records[0].fields.effectiveDate, undefined);
  // A start alone never makes a record worth entering.
  assert.deepEqual(verifyRecords(one([["provider", "Brightwater Locum Partners (through its insurer)", BW]]), agreementCtx()).records, []);
  // Without the email apart from the attachments, the corpus alone is the check, as before.
  assert.equal(verifyRecords(bwRecord(), { corpus: corpusIndex([COVER_LETTER, AGREEMENT_WORDS]), physicianName: "Rowan Testa" }).records[0].fields.effectiveDate, undefined);
});

// Review of 2026-09-29: the host gave an insurance record the attached
// agreement's date when the agreement's words anywhere held "malpractice"
// and "provide" (negated or not), when the email alone named malpractice and
// "agreement" (a housing agreement then passed), and when the agreement was
// the agency's contract with a hospital; and it did so over a start the
// email gave in other words than "effective". Each of these wrote a wrong
// date on a verified forward.
const GIVES = "Locum services agreement between Brightwater Locum Partners, LLC and Rowan Testa, MD, effective as of April 1, 2026. Section 4: Brightwater provides malpractice insurance for the physician on each Assignment.";
/** The start the host writes on the rules' record, with one attached agreement. */
const rulesStart = (email, notes, physicianName = "Rowan Testa") => {
  const attachments = [`agency: Brightwater Locum Partners, LLC\nnotes: ${notes}`];
  const { records } = verifyRecords(rulesRecords({ message: email, physicianName }), agreementCtx(email, attachments, physicianName));
  assert.equal(records.length, 1, "the record itself is still read");
  return records[0].fields.effectiveDate;
};

test("an attached agreement's start only when that same agreement gives the physician the cover, and the physician is a party to it", () => {
  assert.equal(rulesStart(COVER_LETTER, GIVES), "2026-04-01");
  assert.equal(rulesStart(COVER_LETTER, GIVES, ""), "2026-04-01", "without the name, a doctor's letters name the party");
  // The agreement says the agency gives no cover, or puts it on the physician.
  for (const notes of [
    "Locum services agreement between Brightwater Locum Partners, LLC and Rowan Testa, MD, effective as of April 1, 2026. Section 4: Brightwater does not provide malpractice insurance; Physician shall maintain professional liability insurance at Physician's own expense.",
    "Locum services agreement between Brightwater Locum Partners, LLC and Rowan Testa, MD, effective as of April 1, 2026. Section 4: Physician shall maintain professional liability insurance and provide Brightwater a certificate.",
    "Locum services agreement between Brightwater Locum Partners, LLC and Rowan Testa, MD, effective as of April 1, 2026. Section 4: Brightwater shall not be responsible for malpractice coverage; the physician's own policy covers each Assignment.",
    // No malpractice cover in it at all, however the email ties cover to "your agreement".
    "Housing agreement between Brightwater Locum Partners, LLC and Rowan Testa, MD for the apartment near the assignment, effective as of October 30, 2026.",
    // The agency's contract with a hospital, with and without "between".
    "Facility services agreement between Brightwater Locum Partners, LLC and Harborview Example Hospital, effective as of January 1, 2024. Section 3: Brightwater provides malpractice insurance for each locum physician it places.",
    "Facility services agreement, Brightwater Locum Partners, LLC and Harborview Example Hospital; effective as of January 1, 2024. Section 3: Brightwater provides malpractice insurance for each locum physician it places.",
    // Another doctor's agreement.
    "Locum services agreement between Brightwater Locum Partners, LLC and Jordan Vale, MD, effective as of April 1, 2026. Section 4: Brightwater provides malpractice insurance for the physician on each Assignment.",
  ]) {
    for (const email of [COVER_LETTER, "Brightwater Locum Partners provides your professional liability insurance per your agreement, at $2,000,000 per claim and a $4,000,000 annual aggregate."]) {
      assert.equal(rulesStart(email, notes), undefined, notes);
    }
  }
  // A hospital in Maryland is not a doctor, when the host has no name to go by.
  assert.equal(rulesStart(COVER_LETTER, "Facility services agreement between Brightwater Locum Partners, LLC and Harborview Example Hospital, MD, effective as of January 1, 2024. Section 3: Brightwater provides malpractice insurance for each locum physician it places.", ""), undefined);
  // Parties named without "between", the agreement's own word for the physician, or the email calling it theirs.
  assert.equal(rulesStart(COVER_LETTER, "Independent contractor agreement, Brightwater Locum Partners, LLC and Rowan Testa, MD; effective as of April 1, 2026. Section 4: Brightwater provides malpractice insurance for each Assignment."), "2026-04-01");
  assert.equal(rulesStart(COVER_LETTER, "Physician staffing agreement, effective as of 04/01/2026, between Brightwater Physician Staffing, Inc. and the physician. Section 4: Brightwater insures the physician for professional liability on each Assignment."), "2026-04-01");
  assert.equal(rulesStart(COVER_LETTER, "Master services agreement effective April 1, 2026. Section 4: malpractice coverage is provided for each Assignment through the agency's insurer."), "2026-04-01", "the email calls it 'your agreement'");
  assert.equal(rulesStart("In Section 4.1 of the agreement, Brightwater Locum Partners provides professional liability insurance on each Assignment at $2,000,000 per claim and a $4,000,000 annual aggregate.", "Master services agreement effective April 1, 2026. Section 4: malpractice coverage is provided for each Assignment through the agency's insurer."), undefined, "nothing says it is the physician's");
  // Cover that leaves some work out is still cover.
  assert.equal(rulesStart(COVER_LETTER, `${GIVES} Administrative tasks are not insured.`), "2026-04-01");
  // The reading's start from such an agreement is dropped the same way.
  const hospital = "agency: Brightwater Locum Partners, LLC\nnotes: Facility services agreement between Brightwater Locum Partners, LLC and Harborview Example Hospital, effective as of January 1, 2024. Section 3: Brightwater provides malpractice insurance for each locum physician it places.";
  const v = verifyRecords(bwRecord([["effectiveDate", "2024-01-01", "effective as of January 1, 2024"]]), agreementCtx(COVER_LETTER, [hospital]));
  assert.equal(v.records[0].fields.effectiveDate, undefined);
  assert.ok(v.dropped.some((d) => d.field === "effectiveDate" && d.why === DROP.agreementDate));
});

test("an attached agreement's start never replaces a start the email states, in whatever words", () => {
  const begins = "Brightwater Locum Partners provides your malpractice insurance: $1,000,000 per claim and $3,000,000 aggregate. Your coverage begins with your first shift on November 2, 2026.";
  assert.equal(rulesStart(begins, GIVES), undefined);
  for (const email of [
    begins,
    `${COVER_LETTER} Your coverage starts November 2.`,
    `${COVER_LETTER} Your first shift is on 11/02/2026.`,
    `${COVER_LETTER} You are insured from 11/2/2026.`,
    `${COVER_LETTER} Coverage commences on your start date of 11/2.`,
    `${COVER_LETTER} The policy took effect on 02/01/2026.`,
  ]) assert.equal(agreementCoverageStart(email, [GIVES], { physicianName: "Rowan Testa" }), null, email);
  // A date that is neither a start nor about the coverage leaves the agreement's, and so does a quoted message's header.
  assert.equal(agreementCoverageStart(`Following up on your email of September 25, 2026. ${COVER_LETTER}`, [GIVES], { physicianName: "Rowan Testa" }).iso, "2026-04-01");
  assert.equal(agreementCoverageStart(`${COVER_LETTER}\n\n> From: Rowan Testa\n> Sent: Monday, September 28, 2026 9:00 AM\n> Subject: Malpractice coverage\n> Is my coverage in place?`, [GIVES], { physicianName: "Rowan Testa" }).iso, "2026-04-01");
  // The reading: the email's own start is kept, and the agreement's is dropped beside it.
  const own = verifyRecords(one([["provider", "Brightwater Locum Partners (through its insurer)", "Brightwater Locum Partners provides your malpractice insurance"], ["coveragePerClaim", "1000000", "$1,000,000 per claim and $3,000,000 aggregate"], ["effectiveDate", "2026-11-02", "Your coverage begins with your first shift on November 2, 2026"]]), agreementCtx(begins, [GIVES]));
  assert.equal(own.records[0].fields.effectiveDate, "2026-11-02");
  const theirs = verifyRecords(one([["provider", "Brightwater Locum Partners (through its insurer)", "Brightwater Locum Partners provides your malpractice insurance"], ["coveragePerClaim", "1000000", "$1,000,000 per claim and $3,000,000 aggregate"], ["effectiveDate", "2026-04-01", "effective as of April 1, 2026"]]), agreementCtx(begins, [GIVES]));
  assert.equal(theirs.records[0].fields.effectiveDate, undefined);
  assert.ok(theirs.dropped.some((d) => d.field === "effectiveDate" && d.why === DROP.agreementDate));
});

test("an insurance expiration is when the coverage ends, never an agreement's term, a renewal or tail wording", () => {
  const text = "Master professional services agreement effective March 1, 2026 through February 28, 2027, renewing automatically. Tail coverage is in effect for claims after 12/31/2026. Your Quillfeather Staffing policy expires on 06/30/2027.";
  const exp = (quote, value) => verifyRecords(one([["provider", "Quillfeather Staffing", "Your Quillfeather Staffing policy expires on 06/30/2027"], ["expirationDate", value, quote]]), ctx([text])).records[0]?.fields.expirationDate;
  assert.equal(exp("effective March 1, 2026 through February 28, 2027, renewing automatically", "2027-02-28"), undefined);
  assert.equal(exp("Tail coverage is in effect for claims after 12/31/2026", "2026-12-31"), undefined);
  assert.equal(exp("Your Quillfeather Staffing policy expires on 06/30/2027", "2027-06-30"), "2027-06-30");
});

test("a note may use a common abbreviation, or the initials of words the email writes, and no other", () => {
  const text = `${LETTER}\n\nThe master services agreement governs each assignment.`;
  const note = (value) => verifyRecords(one([["provider", "Quillfeather Staffing", "the Quillfeather Staffing malpractice policy"], ["coveragePerClaim", "1000000", LIMITS], ["notes", value, "the Quillfeather Staffing malpractice policy covers the emergency care"]]), ctx([text])).records[0].fields.notes;
  assert.equal(note("Covers ER care on a Quillfeather Staffing assignment."), "Covers ER care on a Quillfeather Staffing assignment.");
  assert.equal(note("Per the MSA, coverage is per assignment."), "Per the MSA, coverage is per assignment.");
  assert.equal(note("Also covers the XYZ programme."), undefined);
});

test("a record written without the physician's say carries the email's own words as its note, never the reading's", () => {
  const text = "Your Lanternfield Mutual malpractice policy is claims made and does not include tail coverage after your assignment ends. Limits are $1,000,000 per claim and $3,000,000 aggregate.";
  const { records } = verifyRecords(one([
    ["provider", "Lanternfield Mutual", "Your Lanternfield Mutual malpractice policy is claims made"],
    ["coveragePerClaim", "1000000", "Limits are $1,000,000 per claim and $3,000,000 aggregate"],
    ["notes", "Tail coverage is included after the assignment ends.", "does not include tail coverage after your assignment ends"],
  ]), ctx([text]));
  assert.equal(records[0].fields.notes, "Tail coverage is included after the assignment ends.", "the reading's words stay on a proposal, which he reads first");
  const written = Facts.asWritten?.(records[0]);
  assert.equal(written?.fields.notes, "Does not include tail coverage after your assignment ends.");
  assert.equal(written?.fields.coveragePerClaim, "1000000");
});

test("identifiers the gate missed: \"policy PHY2291B\", \"Policy: PHY2291B\", \"policy BM-7Q2-993\"", () => {
  for (const q of [
    "Lanternfield Mutual provides $1,000,000 per claim and $3,000,000 aggregate under policy PHY2291B",
    "Policy: PHY2291B. Lanternfield Mutual provides $1,000,000 per claim and $3,000,000 aggregate",
    "Lanternfield Mutual provides $1,000,000 per claim and $3,000,000 aggregate under policy BM-7Q2-993",
  ]) {
    const r = verifyRecords(one([["provider", "Lanternfield Mutual", q], ["coveragePerClaim", "1000000", q], ["coverageAggregate", "3000000", q]]), ctx([q]));
    assert.deepEqual(r.records, [], q);
    assert.ok(r.dropped.every((d) => d.why === DROP.identifier || d.why === DROP.thin), q);
  }
  // Section numbers, years and limits are not identifiers.
  const fine = "Lanternfield Mutual provides $1,000,000 per claim and $3,000,000 aggregate under Section 7.2 for policy year 2026";
  assert.equal(verifyRecords(one([["provider", "Lanternfield Mutual", fine], ["coveragePerClaim", "1000000", fine]]), ctx([fine])).records.length, 1);
});

test("a date filled on a record marked \"date not yet known\" clears the mark, and Undo would put it back", () => {
  const lic = { id: "L1", type: "State Medical License", state: "CO", expirationDate: null, dateUnknown: true };
  assert.deepEqual(appendChanges("licenses", lic, { expirationDate: "2028-05-31" }).changes, { expirationDate: "2028-05-31", dateUnknown: false });
  const [p] = planRecords([{ section: "licenses", fields: { type: "State Medical License", state: "CO", expirationDate: "2028-05-31" }, sources: {}, matchExistingId: "L1" }], { licenses: [lic] });
  assert.deepEqual([p.op, p.changes, p.before], ["update", { expirationDate: "2028-05-31", dateUnknown: false }, { expirationDate: null, dateUnknown: true }]);
  // A record not waiting for a date keeps what it has.
  assert.deepEqual(appendChanges("licenses", { ...lic, dateUnknown: false }, { expirationDate: "2028-05-31" }).changes, { expirationDate: "2028-05-31" });
});

test("itemsBytes counts what the table's check counts (jsonb as text), and minimalItems fits what the full note could not", () => {
  const items = [{ key: "r1", kind: "record", fields: { a: "1", b: [1, 2] }, state: "written" }];
  // PostgreSQL writes jsonb back as {"a": "1", "b": [1, 2]}: a space after each colon and comma.
  assert.equal(itemsBytes(items), '[{"key": "r1", "kind": "record", "fields": {"a": "1", "b": [1, 2]}, "state": "written"}]'.length);
  const big = [1, 2, 3, 4, 5, 6].map((i) => ({ key: `r${i}`, kind: "record", section: "cme", op: "add", recordId: `id-${i}`, fields: { title: "t".repeat(100), notes: "n".repeat(600) }, sources: { title: "s".repeat(200), notes: "s".repeat(200) }, before: { notes: "b".repeat(300) }, state: "written" }));
  const min = Facts.minimalItems?.(big);
  assert.ok(min && itemsBytes(min) <= 3800);
  assert.deepEqual(min.map((i) => [i.recordId, i.state, i.fields.title.length]), big.map((i) => [i.recordId, "written", 100]));
});
