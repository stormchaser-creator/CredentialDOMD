import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import { outgoingFileNames } from "../src/utils/docLabel.js";
import { buildCaseLogCsv, buildCaseLogPdf, caseLogCsvName } from "../src/utils/caseLogReport.js";
import { buildCvContent } from "../src/utils/cvContent.js";
import { fileShareText, referencesShareText, referencesLetter, bundleShareText } from "../src/utils/shareText.js";
import { buildReferenceText } from "../src/utils/referenceDraft.js";
import { buildCredentialRows, generateCredentialZip } from "../src/utils/credentialExport.js";
import { loadScreens } from "./harness/component-harness.mjs";

// The export engine's imports have no extensions, so it is bundled.
const { buildExport, makeSpreadsheetFile } = await loadScreens('export * from "./src/utils/exportData.js";');

// What a credentialing office, a program or an accountant receives from the
// app's other share paths. Synthetic people and records only.

const settings = { name: "Ana Li", degreeType: "DO", npi: "1234567893", email: "ana@example.test" };
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("camera names never go out: a file is named for what it is, and repeats are told apart", () => {
  const data = { settings, licenses: [{ id: "l1", type: "State Medical License", state: "CO" }, { id: "l2", type: "DEA Registration", state: "CO" }] };
  const names = outgoingFileNames([
    { name: "image.jpg", linkedTo: "licenses:l1" },
    { name: "IMG_0269.jpeg", linkedTo: "licenses:l2" },
    { name: "image.jpg", linkedTo: "licenses:l2" },
    { name: "DEA Registration CO.pdf", linkedTo: "licenses:l2" },
    { name: "scan (3).pdf" },
  ], data).map((n) => n.name);
  assert.deepEqual(names, [
    "State Medical License, CO, Ana Li DO.jpg",
    "DEA Registration, CO, Ana Li DO (1 of 2).jpeg",
    "DEA Registration, CO, Ana Li DO (2 of 2).jpg",
    "DEA Registration CO.pdf",
    "Document 5, Ana Li DO.pdf",
  ]);
  const { blurb, letter } = bundleShareText(settings, outgoingFileNames([{ name: "image.jpg", linkedTo: "licenses:l1" }], data).map((n) => ({ label: n.label })));
  assert.match(blurb, /1\. State Medical License, CO, Ana Li DO\./);
  assert.doesNotMatch(blurb + letter, /image/);
  for (const f of ["src/components/features/ShareModal.jsx", "src/components/features/DocumentsSection.jsx", "src/components/features/AssistantSection.jsx"]) {
    assert.match(read(f), /outgoingFileNames\(/, f);
  }
});

test("the case log: whole procedure names, Undated instead of a dash, page N of M, and a CSV Excel reads", async () => {
  const long = "Craniotomy for tumor resection, supratentorial, with intraoperative neuronavigation and awake mapping of language cortex";
  const cases = [{ date: "2026-08-12", title: long, facility: "Hôpital Exemple", category: "Cranial" }, { title: "Undated case" }];
  const pdf = buildCaseLogPdf(cases, { physician: "Ana Li, DO" });
  const raw = Buffer.from(await pdf.arrayBuffer()).toString("latin1");
  const runs = [...raw.matchAll(/\((.*?)\) Tj/g)].map((m) => m[1]).join(" ");
  assert.ok(runs.includes("awake") && runs.includes("cortex"), "the procedure is not cut at 90 characters");
  assert.ok(runs.includes("Undated") && !raw.includes("\x97"), "no em dash for a missing date");
  assert.ok(runs.includes("Aug 12, 2026"));
  assert.match(runs, /page 1 of 1/);
  const csv = buildCaseLogCsv(cases);
  assert.ok(csv.startsWith("\u{FEFF}Date,"), "a byte-order mark");
  assert.ok(csv.includes("\r\n") && csv.includes("Hôpital Exemple"));
  assert.equal(caseLogCsvName("Ana Li, DO", "2026-27"), "Case Log, Ana Li, DO 2026-27.csv");
});

test("the CV prints a reference's degree once and privileges in the same range style as experience", () => {
  const cv = buildCvContent({
    settings,
    peerReferences: [{ id: "r1", name: "Jordan Sample, MD", degree: "MD" }, { id: "r2", name: "Casey Test", degree: "DO" }],
    privileges: [{ id: "p1", facility: "Example Regional", state: "ND", appointmentDate: "2024-03-01" }],
  }, "clinical");
  const items = cv.flatMap((s) => s.items || []).map((i) => i.primary);
  assert.ok(items.includes("Jordan Sample, MD") && items.includes("Casey Test, DO"));
  assert.ok(!items.some((t) => /MD, MD/.test(t || "")));
  assert.ok(items.some((t) => /^Example Regional: \(March 1, 2024 – current\) ND$/.test(t || "")), items.join(" | "));
});

test("a file shared alone carries a title and a short email, not an empty body", () => {
  const { title, text } = fileShareText({ what: "CME transcript for the Colorado medical license renewal", settings });
  assert.equal(title, "CME transcript for the Colorado medical license renewal: Ana Li, DO");
  assert.equal(text, "Hello, attached is the CME transcript for the Colorado medical license renewal for Ana Li, DO (NPI 1234567893).\n\nPlease reach out with any questions.\n\nThank you,\nAna Li, DO \u{b7} NPI 1234567893 \u{b7} ana@example.test");
  assert.match(read("src/utils/cvPdf.js"), /navigator\.share\(\{ title, text, files: \[file\] \}\)/);
  // fix/links-iphone hands the share to shareAtHandoff; the payload is the same.
  assert.match(read("src/utils/cmeTranscriptPdf.js"), /shareAtHandoff\(\{ title, text, files:/);
  assert.match(read("src/utils/cmeTranscriptPdf.js"), /fileName: transcriptFileName\(stateName, physicianBlock\(data\)\)/);
});

test("references name whose they are, number each person and sign off", () => {
  const refs = [{ name: "Jordan Sample", degree: "MD", knownSince: "2015-06", phone: "555-010-0101" }, { name: "Pat Exemplar", degree: "DO" }];
  const share = referencesShareText(settings, refs);
  assert.ok(share.startsWith("Hello, here are 2 professional references for Ana Li, DO (NPI 1234567893).\n\n1. Jordan Sample, MD."));
  assert.match(share.replace(/\s*\n+\s*/g, " "), /Phone: 555-010-0101\. 2\. Pat Exemplar, DO\./, "two people never run together");
  assert.match(buildReferenceText(refs[0]), /\nKnown since: Jun 2015\n/);
  const letter = referencesLetter(settings, refs);
  assert.ok(letter.startsWith("To whom it may concern,\n\nHere are 2 professional references for Ana Li, DO"));
  assert.ok(letter.endsWith("Thank you,\nAna Li, DO\nNPI 1234567893\nana@example.test"));
});

test("the packet summary never carries the physician's private notes", async () => {
  const data = { settings, licenses: [{ id: "l", type: "State Medical License", state: "CO", expirationDate: "2027-04-30", notes: "portal login; fee AmEx" }], documents: [] };
  assert.equal(buildCredentialRows(data)[0].Notes, "");
  assert.equal(buildCredentialRows(data, { privateNotes: true })[0].Notes, "portal login; fee AmEx", "only the account export the physician keeps");
  const zip = await JSZip.loadAsync(await (await generateCredentialZip(data)).arrayBuffer());
  const sheet = await zip.file("CredentialDOMD_Export/credentials_summary.xlsx").async("uint8array");
  const rows = XLSX.utils.sheet_to_json(XLSX.read(sheet, { type: "array" }).Sheets.Credentials);
  assert.ok(!JSON.stringify(rows).includes("portal login"));
});

test("Vera's exports: money as currency, columns sized, memos labelled private", async () => {
  const { rows, label } = buildExport({ invoices: [{ number: "INV-1", totalAmount: 18225, sentAt: "2026-09-02T15:00:00Z" }] }, { section: "invoices" });
  const file = makeSpreadsheetFile({ rows, label, filename: "x.xlsx" });
  const ws = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array", cellStyles: true }).Sheets.Invoices;
  assert.equal(ws.B2.w, "$18,225.00");
  assert.ok(ws["!cols"]?.length === 4);
  const lic = buildExport({ licenses: [{ type: "DEA Registration", notes: "memo" }] }, { section: "licenses" }).rows[0];
  assert.equal(lic["Private notes"], "memo");
  assert.ok(!("Notes" in lic));
});

test("the deduction memo prints alone, dark on white, with no controls and grouped amounts", () => {
  const src = read("src/components/features/locum/DeductionMemo.jsx");
  assert.match(src, /@media print \{/);
  assert.match(src, /\.cmd-deduction-memo, \.cmd-deduction-memo \* \{ visibility: visible !important; color: #111 !important;/);
  assert.match(src, /<div data-print-hide="" style=\{\{ display: "flex", gap: 8, marginBottom: 14 \}\}>/, "the action buttons");
  assert.match(src, /data-print-hide=""\n\s+aria-label=\{`Remove/, "the delete marks");
  assert.match(src, /1099 Deduction Memo, Tax Year \{yearFilter\}/, "a printed title with the year");
  assert.doesNotMatch(src, /toFixed\(2\)/, "every amount through the grouped formatter");
});
