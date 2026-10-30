// A request whose asks are reports (case logs, NPI, references, work
// history, CV) arrives prepared: the reply already carries what was asked,
// from the physician's own records, and one approval sends it (owner ticket
// c3f23aa8, 2026-10-29). Before, each of these said "These will follow
// separately:" and the physician built the report somewhere else.
//
// Synthetic people, numbers and records only: this repository is public.
import test from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import * as requestPacketModule from "../src/utils/requestPacket.js";
import * as requestReportsModule from "../src/utils/requestReports.js";
import * as server from "../supabase/functions/_shared/requestPacket.ts";
import { reportFilesFromBody, MAX_REPORT_FILES } from "../supabase/functions/_shared/requestFlow.ts";
import { buildReportFiles } from "../src/utils/requestReportFiles.js";
import { proposalSummary, REPORTS_ELSEWHERE_REASON } from "../src/components/features/RequestPacket.js";
import { mountComponent, settle } from "./component-harness.mjs";

const { buildProposal, catalogueFromRows, noteForSelection, oneTapReady } = requestPacketModule;
const { caseLogRange, prepareProposal, withPreparedReports, reportFileSpecs, casesInRange, NOTE_BUDGET } = requestReportsModule;

const NOW = "2026-10-30";
const PHYSICIAN = { name: "Jordan Rivera", degree: "DO" };

const DATA = {
  settings: { name: "Jordan Rivera", degreeType: "DO", npi: "1234567893", email: "jordan@example.test" },
  peerReferences: [
    { id: "ref-1", name: "Pat Exemplar", degree: "MD", specialty: "Neurosurgery", institution: "Example Medical Center", relationship: "Colleague", email: "pat@example.test", phone: "555-010-0101", knownSince: "2015-06", notes: "PRIVATE NOTE never sent" },
    { id: "ref-2", name: "Casey Sample", degree: "DO", specialty: "Neurology", institution: "Sample General Hospital", relationship: "Program Director", email: "casey@example.test", phone: "555-010-0102" },
  ],
  workHistory: [
    { id: "w-1", type: "Employment", position: "Staff Neurosurgeon", employer: "Sample General Hospital", city: "Springfield", state: "IL", startDate: "2016-08-01", endDate: "2020-06-30", reasonForLeaving: "PRIVATE reason" },
    { id: "w-2", type: "Employment", position: "Attending Neurosurgeon", employer: "Example Medical Center", city: "Riverton", state: "WY", startDate: "2020-07-01", current: true },
  ],
  caseLogs: [
    { id: "c-0", date: "2025-12-31", title: "Case Before Range", category: "Spine", role: "Primary Surgeon" },
    { id: "c-1", date: "2026-01-01", title: "Case First Day", category: "Cranial", role: "Primary Surgeon", cptCodes: "61510" },
    { id: "c-2", date: "2026-06-15", title: "Case Mid Year", category: "Spine", role: "Co-Surgeon" },
    { id: "c-3", date: "2026-10-30", title: "Case Today", category: "Spine", role: "Primary Surgeon" },
    { id: "c-4", date: "", title: "Case Undated", category: "Spine", role: "Primary Surgeon" },
  ],
  education: [{ id: "e-1", type: "Residency", institution: "Example University", program: "Neurosurgery", startDate: "2009-07-01", endDate: "2016-06-30" }],
  documents: [],
};

const request = (body, extra = {}) => ({ subject: "Credentialing", body, fromName: "Sam Example", fromAddr: "sam@example.test", ...extra });
const propose = (body, data = DATA, reading) => buildProposal(request(body), catalogueFromRows([], data), PHYSICIAN, NOW, reading);
const prepare = (p, data = DATA) => prepareProposal(p, data, { fromName: "Sam Example", now: NOW });

/** The text a jsPDF file draws, inflating any compressed streams. */
function pdfText(base64) {
  const buf = Buffer.from(base64, "base64");
  let out = buf.toString("latin1");
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(buf.toString("latin1")))) {
    const start = m.index + m[0].length;
    const end = buf.indexOf("endstream", start);
    try { out += inflateSync(buf.subarray(start, end)).toString("latin1"); } catch { /* not compressed */ }
  }
  return out;
}

test("a references ask arrives with the saved references in the reply, not 'follows separately'", () => {
  const before = propose("Hi Dr. Rivera,\n\nCould you send me your references?\n\nThanks,\nSam");
  assert.match(before.coverNote, /These will follow separately:\n- references/);
  const p = prepare(before);
  const item = p.items.find((i) => i.kind === "references");
  assert.equal(item.prepared.how, "text");
  assert.equal(item.prepared.count, 2);
  assert.doesNotMatch(p.coverNote, /follow separately/);
  assert.match(p.coverNote, /Professional references:/);
  assert.match(p.coverNote, /1\. Pat Exemplar, MD\nSpecialty: Neurosurgery\nInstitution: Example Medical Center\nRelationship: Colleague\nKnown since: Jun 2015\nEmail: pat@example\.test\nPhone: 555-010-0101/);
  assert.match(p.coverNote, /2\. Casey Sample, DO/);
  // The private notes field is never written into a reply.
  assert.doesNotMatch(p.coverNote, /PRIVATE/);
  assert.match(p.coverNote, /\n\nRegards,\nJordan Rivera, DO$/);
  // Nothing to attach: the references are in the note.
  assert.deepEqual(reportFileSpecs(p), []);
  assert.equal(proposalSummary(p).line, "1 item prepared from your records");
});

test("a case log ask 'from 01/2026 to present' covers exactly Jan 1 2026 through today", async () => {
  const range = caseLogRange("case logs from 01/2026 to present", NOW);
  assert.deepEqual(range, { from: "2026-01-01", to: NOW, label: "Jan 1, 2026 to Oct 30, 2026" });
  assert.deepEqual(casesInRange(DATA.caseLogs, range).map((c) => c.id), ["c-1", "c-2", "c-3"]);

  const p = prepare(propose("Hello,\n\nPlease send case logs from 01/2026 to present.\n\nThank you"));
  const item = p.items.find((i) => i.kind === "case_logs");
  assert.deepEqual({ how: item.prepared.how, from: item.prepared.from, to: item.prepared.to, count: item.prepared.count },
    { how: "file", from: "2026-01-01", to: NOW, count: 3 });
  assert.match(p.coverNote, /Attached are the documents you asked for:\n- Case log, Jan 1, 2026 to Oct 30, 2026 \(3 cases\)/);
  assert.doesNotMatch(p.coverNote, /follow separately/);

  const files = await buildReportFiles(p, DATA);
  assert.equal(files.length, 1);
  assert.match(files[0].name, /^Case Log, Jordan Rivera, DO Jan 1, 2026 to Oct 30, 2026\.pdf$/);
  assert.equal(Buffer.from(files[0].base64, "base64").subarray(0, 5).toString("latin1"), "%PDF-");
  const text = pdfText(files[0].base64);
  for (const inRange of ["Case First Day", "Case Mid Year", "Case Today"]) assert.ok(text.includes(inRange), `${inRange} is in the report`);
  for (const outOfRange of ["Case Before Range", "Case Undated"]) assert.ok(!text.includes(outOfRange), `${outOfRange} is not`);
  // The server takes exactly what the app generated.
  const accepted = reportFilesFromBody({ report_files: files });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.files[0].filename, files[0].name);
});

test("a case log ask with no range is every case; one that cannot be read is not guessed", () => {
  assert.deepEqual(caseLogRange("case logs", NOW), { all: true, label: "all cases" });
  assert.deepEqual(caseLogRange("Logs 12-months", NOW), { from: "2025-10-30", to: NOW, label: "Oct 30, 2025 to Oct 30, 2026" });
  assert.deepEqual(caseLogRange("case logs since March 2025", NOW).from, "2025-03-01");
  assert.deepEqual(caseLogRange("case logs for 2025", NOW), { from: "2025-01-01", to: "2025-12-31", label: "Jan 1, 2025 to Dec 31, 2025" });
  assert.equal(caseLogRange("most recent case logs", NOW), null);

  const all = prepare(propose("Please send your case logs."));
  assert.equal(all.items[0].prepared.count, 5);
  assert.match(all.coverNote, /- Case log, all cases \(5 cases\)/);

  // A range the rules cannot read sends nothing rather than every case.
  const unread = prepare(propose("Please send case logs for the prior fiscal year."));
  assert.match(unread.items[0].ask, /prior fiscal year/);
  assert.equal(unread.items[0].prepared, undefined);
  assert.match(unread.items[0].notPrepared, /date range/);
  assert.match(unread.coverNote, /These will follow separately:/);

  const empty = prepare(propose("Please send case logs from 01/2020 to 12/2020."));
  assert.equal(empty.items[0].prepared, undefined);
  assert.equal(empty.items[0].notPrepared, "No cases logged from Jan 1, 2020 to Dec 31, 2020.");
});

test("an NPI ask puts the profile's NPI in the note, and says so only when there is one", () => {
  const p = prepare(propose("Please send the following:\n- NPI"));
  assert.match(p.coverNote, /Hello Sam,\n\nMy NPI is 1234567893\.\n\nRegards,/);
  assert.doesNotMatch(p.coverNote, /follow separately/);

  const none = prepare(propose("Please send the following:\n- NPI"), { ...DATA, settings: { ...DATA.settings, npi: "" } });
  assert.equal(none.items[0].prepared, undefined);
  assert.match(none.items[0].notPrepared, /No NPI in your profile/);
  assert.match(none.coverNote, /These will follow separately:\n- NPI/);
  assert.doesNotMatch(none.coverNote, /My NPI/);
});

test("work history and the CV: the list in the note, the CV attached as a PDF", async () => {
  const p = prepare(propose("Please send the following:\n- Work history\n- CV"));
  assert.match(p.coverNote, /Work history:\n- Attending Neurosurgeon, Example Medical Center, Riverton, WY, Jul 2020 to present\n- Staff Neurosurgeon, Sample General Hospital, Springfield, IL, Aug 2016 to Jun 2020/);
  assert.doesNotMatch(p.coverNote, /PRIVATE/);
  assert.match(p.coverNote, /Attached are the documents you asked for:\n- CV/);
  assert.deepEqual(reportFileSpecs(p).map((s) => s.file), ["cv"]);
  const files = await buildReportFiles(p, DATA);
  assert.equal(files[0].name, "CV Jordan Rivera, DO.pdf");
  assert.ok(pdfText(files[0].base64).includes("Jordan Rivera"));
});

test("a request with nothing to prepare is exactly what it was", () => {
  const docs = [{ id: "d-dea", name: "DEA registration.pdf", mime: "application/pdf" }];
  const records = { ...DATA, dea: [{ id: "dea-1", state: "IL", expirationDate: "2028-01-31", linkedTo: null }] };
  const p = buildProposal(request("Please send a copy of your BLS card."), catalogueFromRows(docs, records), PHYSICIAN, NOW);
  assert.ok(p.items.every((i) => i.status !== "report"));
  assert.equal(prepare(p), p, "same object back");
  const rows = [{ id: "r-1", status: "new", from_name: "Sam Example", proposal: p }];
  assert.equal(withPreparedReports(rows, DATA, { now: NOW }), rows, "same array back");
  // A replied row's proposal is the record of what went: never touched.
  const replied = [{ id: "r-2", status: "replied", proposal: propose("Please send your references.") }];
  assert.equal(withPreparedReports(replied, DATA, { now: NOW }), replied);
});

test("only what was prepared leaves 'follows separately'; the rest keeps it, with the reason for the physician", () => {
  const thin = { ...DATA, peerReferences: [], caseLogs: [] };
  const p = prepare(propose("Please send the following:\n- NPI\n- References\n- Case logs"), thin);
  assert.match(p.coverNote, /My NPI is 1234567893\./);
  assert.match(p.coverNote, /These will follow separately:\n- References\n- Case logs/);
  assert.match(p.items.find((i) => i.kind === "references").notPrepared, /No references saved/);
  assert.match(p.items.find((i) => i.kind === "case_logs").notPrepared, /No cases logged/);
  assert.equal(proposalSummary(p).line, "1 item prepared from your records, 2 follow separately");
});

test("a record that reads like a patient identifier or an SSN is not mailed out", () => {
  const bad = { ...DATA, peerReferences: [{ id: "ref-x", name: "Pat Exemplar", email: "pat@example.test", phone: "SSN 123-45-6789" }] };
  const p = prepare(propose("Could you send me your references?"), bad);
  assert.equal(p.items[0].prepared, undefined);
  assert.match(p.items[0].notPrepared, /Social Security number/);
  assert.doesNotMatch(p.coverNote, /123-45-6789/);
  const badCase = { ...DATA, caseLogs: [{ id: "c-x", date: "2026-02-01", title: "Craniotomy MRN 00481234", category: "Cranial" }] };
  const q = prepare(propose("Please send case logs from 01/2026 to present."), badCase);
  assert.equal(q.items[0].prepared, undefined);
  assert.match(q.items[0].notPrepared, /medical record number/);
});

test("text that would push the note past the send's limit follows separately instead", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `ref-${i}`, name: `Reference Person ${i}`, degree: "MD", specialty: "Neurosurgery", institution: "Example Medical Center", relationship: "Colleague", email: `ref${i}@example.test`, phone: `555-010-${String(1000 + i)}` }));
  const p = prepare(propose("Please send the following:\n- NPI\n- References"), { ...DATA, peerReferences: many });
  assert.ok(p.coverNote.length <= NOTE_BUDGET);
  assert.match(p.coverNote, /My NPI is 1234567893\./);
  assert.match(p.coverNote, /These will follow separately:\n- References/);
  assert.match(p.items.find((i) => i.kind === "references").notPrepared, /Too long/);
});

test("the note follows the ticks with prepared reports in it, and the server copy writes the same note", () => {
  const docs = [{ id: "d-bls", name: "BLS card.pdf", mime: "application/pdf" }];
  const records = { ...DATA, certifications: [{ id: "bls-1", type: "BLS", expirationDate: "2027-12-31", linkedTo: null }] };
  const base = buildProposal(request("Please send the following:\n- BLS\n- NPI\n- Case logs from 01/2026 to present"), catalogueFromRows(docs, records), PHYSICIAN, NOW);
  const p = prepare(base);
  for (const sel of [p.docIds, [], null]) {
    const a = noteForSelection(p, sel, PHYSICIAN, "Sam Example");
    const b = server.noteForSelection(p, sel, PHYSICIAN, "Sam Example");
    assert.equal(b, a);
    // The prepared case log is attached however the documents are ticked.
    assert.match(a, /- Case log, Jan 1, 2026 to Oct 30, 2026 \(3 cases\)/);
    assert.match(a, /My NPI is 1234567893\./);
  }
  assert.equal(noteForSelection(p, p.docIds, PHYSICIAN, "Sam Example"), p.coverNote);
  // A malformed prepared field reads as not prepared in both copies.
  const junk = { ...base, items: base.items.map((i) => (i.kind === "npi" ? { ...i, prepared: { how: "file" } } : i)) };
  assert.match(noteForSelection(junk, junk.docIds, PHYSICIAN, "Sam"), /These will follow separately:\n- NPI/);
  assert.equal(server.noteForSelection(junk, junk.docIds, PHYSICIAN, "Sam"), noteForSelection(junk, junk.docIds, PHYSICIAN, "Sam"));
});

test("a prepared request goes on the same one tap it went on before", () => {
  const reading = { confidence: "high", asks: [{ quote: "Could you send me your references?", kind: "references" }] };
  const p = { ...propose("Could you send me your references?", DATA, reading), verified: true };
  assert.equal(oneTapReady(p), true);
  assert.equal(oneTapReady(prepare(p)), true);
});

test("send-packet-email takes prepared reports only as PDFs, at most three", () => {
  assert.deepEqual(reportFilesFromBody({}), { ok: true, files: [] });
  assert.deepEqual(reportFilesFromBody({ report_files: null }), { ok: true, files: [] });
  const pdf = Buffer.from("%PDF-1.3\nsynthetic\n%%EOF").toString("base64");
  const ok = reportFilesFromBody({ report_files: [{ name: "../Case Log.pdf", base64: pdf }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.files[0].filename, ".. Case Log.pdf", "no path separators survive");
  assert.equal(reportFilesFromBody({ report_files: [{ name: "x", base64: pdf }] }).files[0].filename, "x.pdf");
  assert.equal(reportFilesFromBody({ report_files: [{ name: "x.pdf", base64: Buffer.from("<html>").toString("base64") }] }).ok, false);
  assert.equal(reportFilesFromBody({ report_files: [{ name: "x.pdf", base64: "not base64!" }] }).ok, false);
  assert.equal(reportFilesFromBody({ report_files: [{ name: "x.pdf" }] }).ok, false);
  assert.equal(reportFilesFromBody({ report_files: "x" }).ok, false);
  assert.equal(reportFilesFromBody({ report_files: Array.from({ length: MAX_REPORT_FILES + 1 }, () => ({ name: "x.pdf", base64: pdf })) }).ok, false);
});

test("Approve and send carries the generated report, and is not offered where it cannot be generated", async () => {
  const T = { text: "#000", textMuted: "#555", textDim: "#777", border: "#ccc", success: "#0a0", successDim: "#efe", danger: "#a00", warning: "#a60", accent: "#06c", accentDim: "#eef" };
  const reading = { confidence: "high", asks: [{ quote: "Please send case logs from 01/2026 to present.", kind: "case_logs" }] };
  const proposal = prepare({ ...propose("Please send case logs from 01/2026 to present.", DATA, reading), verified: true });
  const req = { id: "11111111-1111-4111-8111-111111111111", status: "new", from_addr: "sam@example.test", from_name: "Sam Example", proposal };
  const modules = { requestPacket: requestPacketModule, requestReports: requestReportsModule };
  const bodies = [];
  const ui = await mountComponent("src/components/features/RequestPacket.js", {
    exportName: "ApproveSendButton", modules,
    props: { request: req, T, accountEmail: "jordan@example.test", send: async (b) => { bodies.push(b); return { ok: true, to: "sam@example.test", attached: 1 }; },
      buildReportFiles: async (r) => buildReportFiles(r.proposal, DATA) },
  });
  const button = ui.nodes().find((n) => n.type === "button");
  assert.equal(button.props.children, "Approve and send 1 document");
  await button.props.onClick({ stopPropagation() {} });
  await settle();
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].doc_ids, []);
  assert.match(bodies[0].text, /- Case log, Jan 1, 2026 to Oct 30, 2026 \(3 cases\)/);
  assert.equal(bodies[0].report_files.length, 1);
  assert.equal(reportFilesFromBody(bodies[0]).ok, true);

  const without = await mountComponent("src/components/features/RequestPacket.js", {
    exportName: "ApproveSendButton", modules,
    props: { request: req, T, accountEmail: "jordan@example.test", send: async () => { throw new Error("must not send"); } },
  });
  const texts = without.nodes().filter((n) => n.type === "div").map((n) => n.props.children).filter((c) => typeof c === "string");
  assert.ok(texts.includes(REPORTS_ELSEWHERE_REASON));
  assert.equal(without.nodes().find((n) => n.type === "button").props.disabled, true);
});
