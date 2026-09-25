// supabase/functions/_shared/officeText.mjs: the text of a Word, Excel, CSV,
// text or RTF attachment, read on the server so email-inbound can screen it
// for patient records before anything is stored.
// Run: node --test scripts/office-text.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { officeText, officeKind, zipEntries, MAX_PART_BYTES } from "../supabase/functions/_shared/officeText.mjs";
import { screenDocument } from "../supabase/functions/_shared/app/utils/phiGuard.js";
import { makeZip, makeDocx, makeXlsx } from "./fixtures/intake/zip.mjs";

const enc = (s) => new TextEncoder().encode(s);
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

test("kinds are read from the name or the type, like the app's officeKind", () => {
  assert.equal(officeKind("CV.docx", ""), "docx");
  assert.equal(officeKind("x", DOCX), "docx");
  assert.equal(officeKind("log.xlsx", ""), "xlsx");
  assert.equal(officeKind("old.doc", ""), "doc");
  assert.equal(officeKind("old.xls", ""), "xls");
  assert.equal(officeKind("a.csv", ""), "csv");
  assert.equal(officeKind("a.txt", ""), "text");
  assert.equal(officeKind("a.rtf", ""), "rtf");
  assert.equal(officeKind("a.pdf", "application/pdf"), null);
});

test("a .docx is read through its zip, paragraphs and entities intact", async () => {
  const r = await officeText(makeDocx(["Eric Whitney, DO", "Curriculum Vitae", "Board certified & licensed in CO"]), "Whitney CV.docx", DOCX);
  assert.equal(r.kind, "docx");
  assert.match(r.text, /Eric Whitney, DO\nCurriculum Vitae\nBoard certified & licensed in CO/);
});

test("an .xlsx is read from its shared strings and cells", async () => {
  const r = await officeText(makeXlsx(["Patient Name", "MRN", "Operative note"]), "case_log_2026.xlsx", XLSX);
  assert.match(r.text, /Patient Name/);
  assert.match(r.text, /MRN/);
  assert.match(r.text, /481234/);
  assert.equal(screenDocument(`case_log_2026.xlsx\n${r.text}`)?.level, "clinical");
});

test("csv, text and rtf are decoded; rtf loses its control words", async () => {
  assert.equal((await officeText(enc("MRN,Name\n00481234,J Doe"), "log.csv", "text/csv")).text, "MRN,Name\n00481234,J Doe");
  const rtf = await officeText(enc("{\\rtf1\\ansi {\\b Operative note} MRN 00481234\\par}"), "note.rtf", "application/rtf");
  assert.match(rtf.text, /Operative note/);
  assert.ok(!rtf.text.includes("\\rtf1"));
});

test("a file that cannot be read comes back with no text, so it is never stored unscreened", async () => {
  for (const [bytes, name] of [
    [enc("%PDF-1.4 not a zip"), "fake.docx"],
    [enc("\u{d0}\u{cf}old binary"), "old.doc"],
    [enc("binary"), "old.xls"],
    [makeZip([{ name: "word/other.xml", text: "<x/>" }]), "empty.docx"],
    [makeZip([{ name: "xl/sharedStrings.xml", text: "<sst/>" }]), "nosheet.xlsx"],
  ]) {
    const r = await officeText(bytes, name, "");
    assert.equal(r.text, null, name);
    assert.ok(r.kind, name);
  }
  assert.deepEqual(await officeText(enc("%PDF"), "a.pdf", "application/pdf"), { kind: null, text: null });
});

test("a stored (uncompressed) entry is read too", async () => {
  const z = makeZip([{ name: "word/document.xml", text: "<w:p><w:t>Stored text</w:t></w:p>", store: true }]);
  assert.match((await officeText(z, "s.docx", DOCX)).text, /Stored text/);
  assert.equal(zipEntries(z)[0].method, 0);
});

test("a zip bomb is refused, not inflated without limit", async () => {
  // One part that inflates past the per-part cap from a few kilobytes.
  const huge = "A".repeat(MAX_PART_BYTES + 1024);
  const comp = deflateRawSync(Buffer.from(huge));
  assert.ok(comp.length < 100_000);
  const z = makeZip([{ name: "word/document.xml", text: huge }]);
  const r = await officeText(z, "bomb.docx", DOCX);
  assert.equal(r.text, null);
});
