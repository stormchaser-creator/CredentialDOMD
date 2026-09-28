// The app side of informational mail: src/components/features/IntakeNotes.js
// (the card in More > Requests and the banner on Home) and
// src/utils/intakeProposals.js (what Add, Edit, Dismiss and Undo write).
// The card is rendered with react-dom/server and driven with the component
// harness's hook runtime, so a tap runs its real handler. Every name and
// value here is synthetic.
// Run: node --test scripts/intake-notes-ui.test.mjs
import { test, before } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IntakeNoteCard, IntakeNotesBanner } from "../src/components/features/IntakeNotes.js";
import { noteHeadline, noteStatusLine, itemLabel, planAccept, planDismiss, editedFields, withItem, recordAnswerCorrection } from "../src/utils/intakeProposals.js";
import { loadScreens, mount, nodes, textOf, THEME } from "../tests/harness/component-harness.mjs";

const EM_DASH = String.fromCodePoint(0x2014);
const T = { ...THEME, successDim: "#efe", neutralDim: "#eee", neutral: "#777" };
const FIELDS = {
  type: "Medical Professional Liability Coverage", name: "Quillfeather Staffing assignment malpractice coverage",
  provider: "Quillfeather Staffing (through its insurer)", coveragePerClaim: "1000000", coverageAggregate: "3000000",
  effectiveDate: "2026-03-01", notes: "Covers emergency care on an assignment.\nSource: Email from Jordan Sample, 09/25/2026.",
  statusSource: "Email from Jordan Sample, 09/25/2026",
};
const SOURCES = { coveragePerClaim: "The limits are $1,000,000 per incident and $3,000,000 aggregate", effectiveDate: "Master professional services agreement effective March 1, 2026" };
const written = {
  id: "note-1", inbound_email_id: "led-1", sender: "Jordan Sample", summary: "how Quillfeather Staffing's malpractice policy covers your emergency care", verified: true, status: "new",
  items: [
    { key: "r1", kind: "record", section: "insurance", op: "add", recordId: "ins-1", fields: FIELDS, sources: SOURCES, state: "written" },
    { key: "f1", kind: "file", line: "Attached to your Quillfeather Staffing contract (Fernwick Example Hospital, 09/01/2026 to 12/31/2026): agreement.pdf, the master agreement with Quillfeather Staffing." },
  ],
};
const proposed = {
  ...written, id: "note-2", verified: false,
  items: [
    { key: "r1", kind: "record", section: "insurance", op: "add", recordId: null, fields: FIELDS, sources: SOURCES, state: "proposed" },
    { key: "l1", kind: "link", docId: "doc-1", linkedTo: "locumContracts:contract-now", name: "Quillfeather Staffing - master agreement.pdf", type: "application/pdf", target: "your Quillfeather Staffing contract (Fernwick Example Hospital, 09/01/2026 to 12/31/2026)", fileName: "Quillfeather_MSA.pdf", state: "proposed" },
  ],
};
const html = (props) => renderToStaticMarkup(React.createElement(IntakeNoteCard, { T, ...props }));

test("a proven forward's note: what was added, from whom, with Undo, and no Add", () => {
  const out = html({ note: written });
  assert.match(out, /From Jordan Sample: how Quillfeather Staffing&#x27;s malpractice policy covers your emergency care/);
  assert.match(out, /Insurance: Quillfeather Staffing \(through its insurer\), \$1,000,000 per claim, \$3,000,000 aggregate, effective 03\/01\/2026/);
  assert.match(out, /Per claim: \$1,000,000/);
  assert.match(out, /Effective: 03\/01\/2026/);
  assert.match(out, /Added from Jordan Sample&#x27;s note\./);
  assert.match(out, />Undo</);
  assert.match(out, />Done</);
  assert.ok(!/>Add</.test(out) && !/>Dismiss</.test(out));
  assert.match(out, /Attached to your Quillfeather Staffing contract/);
  assert.ok(!out.includes(EM_DASH));
  assert.ok(!/founding|lifetime|member/i.test(out), "no membership labels");
});

test("an unverified forward's note: says nothing was added, offers Add, Edit and Dismiss at 16px on a phone, 14px on a desk", () => {
  const phone = html({ note: proposed });
  assert.match(phone, /This forward could not be verified as coming from you, so nothing was added\./);
  for (const label of ["Add", "Edit", "Dismiss"]) assert.match(phone, new RegExp(`font-size:16px[^>]*>${label}<`), label);
  assert.match(phone, /Attach Quillfeather_MSA\.pdf to your Quillfeather Staffing contract \(Fernwick Example Hospital, 09\/01\/2026 to 12\/31\/2026\)/);
  assert.ok(!/>Done</.test(phone), "not done while something waits");
  const desk = html({ note: proposed, isDesktop: true });
  assert.match(desk, /font-size:14px[^>]*>Add</);
  assert.ok(!phone.includes(EM_DASH));
});

test("answered items say so; a note with nothing in it still says what it was", () => {
  const answered = { ...proposed, items: [{ ...proposed.items[0], state: "dismissed" }, { ...proposed.items[1], state: "added" }] };
  const out = html({ note: answered });
  assert.match(out, /Dismissed\. Nothing was added\./);
  assert.match(out, /Added\./);
  assert.match(out, />Done</);
  const empty = html({ note: { ...written, items: [] } });
  assert.match(empty, /There was nothing in it to add\./);
});

test("Home: the newest note, what waits in it, and Review", () => {
  const out = renderToStaticMarkup(React.createElement(IntakeNotesBanner, { notes: [proposed, written], T }));
  assert.match(out, /From Jordan Sample: how Quillfeather/);
  assert.match(out, /2 to add or dismiss/);
  assert.match(out, />Review</);
  assert.match(out, /and 1 more/);
  assert.equal(renderToStaticMarkup(React.createElement(IntakeNotesBanner, { notes: [], T })), "");
  assert.equal(noteStatusLine(written), "Added 1 record from it");
});

// ── Taps, through the harness's hook runtime ────────────────────────────────

let Screens;
before(async () => { Screens = await loadScreens('export { IntakeNoteCard } from "./src/components/features/IntakeNotes.js";'); });

test("a tap on a line shows the words it was read from", () => {
  const m = mount(Screens.IntakeNoteCard, { props: { note: proposed, T } });
  const line = nodes(m.render()).find((n) => n.type === "button" && textOf(n) === "Per claim: $1,000,000");
  assert.ok(line);
  assert.ok(!textOf(m.render()).includes(SOURCES.coveragePerClaim));
  line.props.onClick();
  assert.ok(textOf(m.render()).includes(`"${SOURCES.coveragePerClaim}"`));
});

test("Add, Dismiss and Edit hand the item (and the physician's cleaned edits) to the screen", () => {
  const calls = [];
  const props = { note: proposed, T, onAdd: (item, edit) => calls.push(["add", item.key, edit]), onDismiss: (item) => calls.push(["dismiss", item.key]) };
  const m = mount(Screens.IntakeNoteCard, { props });
  const buttons = (label) => nodes(m.render()).filter((n) => n.type === "button" && textOf(n) === label);
  buttons("Add")[0].props.onClick();
  buttons("Dismiss")[1].props.onClick();
  buttons("Edit")[0].props.onClick();
  const input = nodes(m.render()).find((n) => n.type === "input" && n.props.value === "$3,000,000");
  assert.ok(input, "the aggregate is shown as the physician reads it");
  assert.equal(input.props.style.fontSize, 16, "16px, so a phone does not zoom");
  input.props.onChange({ target: { value: "$2 million" } });
  buttons("Add")[0].props.onClick();
  assert.deepEqual(calls.slice(0, 2), [["add", "r1", undefined], ["dismiss", "l1"]]);
  const [, key, edit] = calls[2];
  assert.equal(key, "r1");
  assert.deepEqual(edit.changed, ["coverageAggregate"]);
  assert.equal(edit.fields.coverageAggregate, "2000000");
  assert.equal(edit.fields.coveragePerClaim, "1000000", "an untouched value is kept as proposed");
});

// ── What the answers write ──────────────────────────────────────────────────

test("planAccept: a fact the file now holds is added to, not doubled; an answered item or a missing file is refused", () => {
  const item = proposed.items[0];
  const onFile = { id: "ins-hand", provider: "Quillfeather Staffing (through its insurer)", coveragePerClaim: "1000000", coverageAggregate: "3000000", notes: "Mine." };
  const plan = planAccept(item, { data: { insurance: [onFile] }, newId: () => "new" });
  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].op, "edit");
  assert.equal(plan.writes[0].record.id, "ins-hand");
  assert.equal(plan.writes[0].record.notes, `Mine.\n\n${FIELDS.notes}`);
  assert.deepEqual([plan.item.op, plan.item.recordId, plan.item.state], ["append", "ins-hand", "added"]);
  assert.match(planAccept({ ...item, state: "added" }, {}).error, /already answered/);
  assert.match(planAccept(proposed.items[1], { data: { documents: [] } }).error, /has not reached this device/);
  assert.match(planAccept(proposed.items[1], { data: { documents: [{ id: "doc-1", linkedTo: "licenses:x" }] } }).error, /filed somewhere else/);
  assert.deepEqual(planDismiss(item).item.state, "dismissed");
});

test("editedFields cleans what the physician types the way the email's values were cleaned", () => {
  const { fields, changed } = editedFields(proposed.items[0], { coveragePerClaim: "$1.5 million", effectiveDate: "April 2, 2026", policyNumber: "PL-1", notes: "" });
  assert.equal(fields.coveragePerClaim, "1500000");
  assert.equal(fields.effectiveDate, "2026-04-02");
  assert.ok(!("policyNumber" in fields), "never a field an email may not fill");
  assert.ok(!("notes" in fields), "an emptied field is left out");
  assert.deepEqual(changed.sort(), ["coveragePerClaim", "effectiveDate", "notes"]);
});

test("the headline, the labels and the corrections carry no values", () => {
  assert.equal(noteHeadline({ sender: "", summary: "" }), "From a forwarded email");
  assert.equal(itemLabel({ kind: "file", line: `a ${EM_DASH} b` }), "a, b");
  const done = withItem(proposed, { ...proposed.items[0], state: "dismissed" });
  assert.equal(done.items[0].state, "dismissed");
  const c = recordAnswerCorrection(proposed, proposed.items[0], "edit_record", { changed: ["coverageAggregate"] });
  assert.deepEqual(c.before, { kind: "Insurance", section: "insurance", fields: Object.keys(FIELDS), how: "proposed" });
  assert.deepEqual(c.after, { state: "added", changed: ["coverageAggregate"] });
  assert.ok(!/1000000|Quillfeather|Jordan/.test(JSON.stringify(c)), "a correction names fields, never values or people");
  assert.equal(recordAnswerCorrection(proposed, proposed.items[0], "something"), null);
});
