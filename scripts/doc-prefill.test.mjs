// Unit-style checks for src/utils/docPrefill.js: the pure half of "upload a
// contract and the Add Agreement form fills itself". Pins the ticket fixes:
// a duplicate upload is still read, an empty coverage list still takes the
// contract's dates, analyzer JSON is coerced into the form's shape, and the
// "Use a document already uploaded" picker offers the right files in the
// right order. Run: node scripts/doc-prefill.test.mjs   (pure node, no runner)
import {
  mergeExtracted, findDuplicateDoc, attachExistingDoc, isReadableDoc,
  agreementDocCandidates, normalizeAgreementFields, withAgreementFields, isoDate,
} from "../src/utils/docPrefill.js";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`FAIL ${name}\n   got  ${g}\n   want ${w}`); }
};
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${name} ${extra}`); } };

// ── mergeExtracted: fill blanks, keep what was typed ──
eq("merge fills blanks", mergeExtracted({ facility: "" }, { facility: "Riverside", agency: "CompHealth" }), { facility: "Riverside", agency: "CompHealth" });
eq("merge keeps typed", mergeExtracted({ facility: "Typed" }, { facility: "Riverside" }), { facility: "Typed" });
eq("merge keeps typed number", mergeExtracted({ hourlyRate: 250 }, { hourlyRate: 300 }), { hourlyRate: 250 });
eq("merge skips null/empty", mergeExtracted({ facility: "" }, { facility: null, agency: "" }), { facility: "" });
eq("merge empty array is blank", mergeExtracted({ coveragePeriods: [] }, { coveragePeriods: [{ start: "2026-07-28", end: "2026-08-10" }] }), { coveragePeriods: [{ start: "2026-07-28", end: "2026-08-10" }] });
eq("merge keeps filled array", mergeExtracted({ coveragePeriods: [{ start: "2026-01-01", end: "" }] }, { coveragePeriods: [{ start: "2026-07-28", end: "2026-08-10" }] }), { coveragePeriods: [{ start: "2026-01-01", end: "" }] });
eq("merge undefined form", mergeExtracted(undefined, { a: 1 }), { a: 1 });
eq("merge junk extracted", mergeExtracted({ a: 1 }, "nope"), { a: 1 });
eq("merge fills increment when no default", mergeExtracted({ coveragePeriods: [] }, { incrementMinutes: 30 }), { coveragePeriods: [], incrementMinutes: 30 });

// ── findDuplicateDoc: same bytes, or same name + size ──
const docs = [
  { id: "a", name: "contract.pdf", size: 100, data: "data:application/pdf;base64,AAA", linkedTo: "" },
  { id: "b", name: "license.png", size: 50, storagePath: "u/b", linkedTo: "licenses:l1" },
];
eq("dup by bytes", findDuplicateDoc(docs, { name: "renamed.pdf", size: 999 }, "data:application/pdf;base64,AAA")?.id, "a");
eq("dup by name+size (bytes evicted)", findDuplicateDoc(docs, { name: "license.png", size: 50 }, "data:image/png;base64,ZZZ")?.id, "b");
eq("no dup", findDuplicateDoc(docs, { name: "new.pdf", size: 100 }, "data:application/pdf;base64,BBB"), null);
eq("no file", findDuplicateDoc(docs, null, "x"), null);

// ── attachExistingDoc: link the stored copy, never move a linked one ──
eq("attach unlinked", attachExistingDoc({ id: "a", linkedTo: "" }, "locumContracts:c1"), { id: "a", linkedTo: "locumContracts:c1" });
eq("attach already here", attachExistingDoc({ id: "a", linkedTo: "locumContracts:c1" }, "locumContracts:c1"), null);
eq("attach linked elsewhere stays", attachExistingDoc({ id: "a", linkedTo: "licenses:l1" }, "locumContracts:c1"), null);
eq("attach inbox doc leaves inbox", attachExistingDoc({ id: "a", type: "cme-certificate-inbox", mimeType: "application/pdf" }, "cme:x").type, "application/pdf");
eq("attach nothing", attachExistingDoc(null, "cme:x"), null);

// ── isReadableDoc ──
ok("readable pdf", isReadableDoc({ name: "a.pdf", type: "application/pdf" }));
ok("readable image", isReadableDoc({ name: "IMG_1.jpeg", type: "image/jpeg" }));
ok("readable docx", isReadableDoc({ name: "a.docx", type: "" }));
ok("readable mime from data url", isReadableDoc({ name: "x", data: "data:application/pdf;base64,AAA" }));
ok("old .doc not readable", !isReadableDoc({ name: "a.doc", type: "application/msword" }));
ok("zip not readable", !isReadableDoc({ name: "a.zip", type: "application/zip" }));

// ── agreementDocCandidates: right files, best first ──
const files = [
  { id: "lic", name: "dea.pdf", type: "application/pdf", data: "d", uploadedAt: "2026-08-30", linkedTo: "licenses:l1" },
  { id: "old", name: "IMG_0269.jpeg", type: "image/jpeg", data: "d", uploadedAt: "2026-08-01", linkedTo: "" },
  { id: "hint", name: "Locum Agreement 2026.pdf", type: "application/pdf", data: "d", uploadedAt: "2026-08-10", linkedTo: "" },
  { id: "agr", name: "signed.pdf", type: "application/pdf", data: "d", uploadedAt: "2026-07-01", linkedTo: "locumContracts:c9" },
  { id: "own", name: "mine.pdf", type: "application/pdf", data: "d", uploadedAt: "2026-06-01", linkedTo: "locumContracts:c1" },
  { id: "new", name: "scan.pdf", type: "application/pdf", data: "d", uploadedAt: "2026-08-20", linkedTo: "" },
  { id: "cloud", name: "later.pdf", type: "application/pdf", storagePath: "u/x", uploadedAt: "2026-08-25", linkedTo: "" },
  { id: "inbox", name: "cert.pdf", type: "cme-certificate-inbox", mimeType: "application/pdf", data: "d", uploadedAt: "2026-08-28", linkedTo: "" },
  { id: "zip", name: "stuff.zip", type: "application/zip", data: "d", uploadedAt: "2026-08-29", linkedTo: "" },
];
const cands = agreementDocCandidates(files, { contractId: "c1" });
eq("candidate order", cands.map(c => c.doc.id), ["own", "agr", "hint", "cloud", "new", "old"]);
eq("candidate ready flags", cands.map(c => c.ready), [true, true, true, false, true, true]);
eq("candidate linkedAgreement", cands.filter(c => c.linkedAgreement).map(c => c.doc.id), ["own", "agr"]);
eq("candidates without contract id", agreementDocCandidates(files).map(c => c.doc.id), ["agr", "own", "hint", "cloud", "new", "old"]);
eq("candidates empty", agreementDocCandidates(undefined), []);

// ── isoDate ──
eq("iso passthrough", isoDate("2026-07-28"), "2026-07-28");
eq("iso datetime", isoDate("2026-07-28T00:00:00Z"), "2026-07-28");
eq("iso long form", isoDate("July 28, 2026"), "2026-07-28");
eq("iso garbage", isoDate("soon"), "");
eq("iso empty", isoDate(null), "");

// ── normalizeAgreementFields: analyzer JSON → form shape ──
const raw = {
  payModel: "stipend", facility: " Riverside Community Hospital ", location: "Lafayette, CO", agency: "",
  billTo: "ap@riverside.org", callStipend: "$3,000", stipendHours: "4", overageHourlyRate: 300,
  hourlyRate: "n/a", incrementMinutes: "15", startDate: "2026-07-28", endDate: "2026-08-10",
  coveragePeriods: [{ start: "2026-07-28", end: "2026-08-10" }, { start: "2026-09-14" }, { start: "", end: "" }, null],
  callRateGrid: [{ hospital: "Main", primary: "3000", backup: "1,500" }, { hospital: "", primary: null }, "junk"],
  notes: "Cancel with 30 days notice.",
};
const norm = normalizeAgreementFields(raw);
eq("norm numbers", [norm.callStipend, norm.stipendHours, norm.overageHourlyRate, norm.incrementMinutes], [3000, 4, 300, 15]);
ok("norm drops unparsable number", !("hourlyRate" in norm));
ok("norm drops empty text", !("agency" in norm));
eq("norm trims text", norm.facility, "Riverside Community Hospital");
eq("norm periods", norm.coveragePeriods, [{ start: "2026-07-28", end: "2026-08-10" }, { start: "2026-09-14", end: "" }]);
eq("norm dates", [norm.startDate, norm.endDate], ["2026-07-28", "2026-08-10"]);
eq("norm grid", norm.callRateGrid, [{ hospital: "Main", primary: 3000, backup: 1500 }]);
eq("norm payModel kept", norm.payModel, "stipend");
eq("norm bad payModel dropped", "payModel" in normalizeAgreementFields({ payModel: "weekly" }), false);
eq("norm span becomes one block", normalizeAgreementFields({ startDate: "2026-07-28", endDate: "2026-08-10" }).coveragePeriods, [{ start: "2026-07-28", end: "2026-08-10" }]);
eq("norm end-only block", normalizeAgreementFields({ coveragePeriods: [{ end: "2026-08-10" }] }).coveragePeriods, [{ start: "2026-08-10", end: "2026-08-10" }]);
eq("norm no dates no periods", "coveragePeriods" in normalizeAgreementFields({ facility: "X" }), false);
eq("norm garbage", normalizeAgreementFields("x"), {});
eq("norm array", normalizeAgreementFields([1]), {});
eq("norm empty grid dropped", "callRateGrid" in normalizeAgreementFields({ callRateGrid: "none" }), false);

// ── withAgreementFields wraps the analyzer result ──
const wrapped = withAgreementFields({ confidence: "high", extracted: { callStipend: "$3,000", coveragePeriods: [] , startDate: "2026-07-28" } });
eq("wrap keeps confidence", wrapped.confidence, "high");
eq("wrap normalizes", wrapped.extracted, { callStipend: 3000, coveragePeriods: [{ start: "2026-07-28", end: "" }], startDate: "2026-07-28" });
eq("wrap null", withAgreementFields(null), null);

// The full path a scanned contract takes into a fresh Add Agreement form
const fresh = { coveragePeriods: [] };
const filled = mergeExtracted(fresh, wrapped.extracted);
eq("end to end: form takes dates and stipend", filled, { coveragePeriods: [{ start: "2026-07-28", end: "" }], callStipend: 3000, startDate: "2026-07-28" });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
