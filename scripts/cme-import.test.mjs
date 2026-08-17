// Unit-style checks for src/utils/cmeImport.js. Run: node scripts/cme-import.test.mjs
// Pure node, no test runner. Exit code 1 on any failure.
import { readFileSync, existsSync } from "node:fs";
import { inflateSync, inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  parseCSV, sniffDelimiter, guessMapping, detectSource, findHeaderRow,
  normalizeDate, parseHours, mapCreditType, guessTopics,
  rowsFromTable, dedupeKey, markDuplicates, toCmeEntry,
  parseTranscriptText, textToTable, extractPdfText, looksLikeCeBroker, parseCeBrokerPages, rowsFromAI,
  looksLikeCmePassport, parseCmePassportText, IMPORT_SOURCES, pickSheet,
} from "../src/utils/cmeImport.js";
import { createRequire } from "node:module";

const here = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`FAIL ${name}\n   got  ${g}\n   want ${w}`); }
};
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${name} ${extra}`); } };

// ── dates ──
eq("date mdy", normalizeDate("3/11/2024"), "2024-03-11");
eq("date iso", normalizeDate("2024-03-11"), "2024-03-11");
eq("date iso time", normalizeDate("2024-03-11T14:00:00Z"), "2024-03-11");
eq("date long", normalizeDate("March 11, 2024"), "2024-03-11");
eq("date short month", normalizeDate("Sep 5 2023"), "2023-09-05");
eq("date dmy words", normalizeDate("5 Sep 2023"), "2023-09-05");
eq("date 2-digit year", normalizeDate("3/11/24"), "2024-03-11");
eq("date excel serial", normalizeDate(44742), "2022-06-30");
eq("date excel serial string", normalizeDate("44742"), "2022-06-30");
eq("date compact", normalizeDate("20240311"), "2024-03-11");
eq("date bad", normalizeDate("n/a"), "");
eq("date bad month", normalizeDate("13/40/2024"), "");

// ── hours ──
eq("hours plain", parseHours("1.5"), 1.5);
eq("hours suffix", parseHours("2 AMA PRA Category 1 Credits"), 2);
eq("hours number", parseHours(3), 3);
eq("hours blank", parseHours(""), null);
eq("hours text", parseHours("n/a"), null);

// ── credit type mapping ──
eq("cat1", mapCreditType("AMA PRA Category 1 Credit(s)", "MD"), { category: "AMA PRA Category 1", assumed: false });
eq("cat2", mapCreditType("Category 2", "MD"), { category: "AMA PRA Category 2", assumed: false });
eq("aoa 1a", mapCreditType("AOA Category 1-A", "DO"), { category: "AOA Category 1-A", assumed: false });
eq("aoa 1a compact", mapCreditType("1A", "DO"), { category: "AOA Category 1-A", assumed: false });
eq("aoa on MD list", mapCreditType("AOA Category 1-A", "MD"), { category: "Other", assumed: false });
eq("moc lifelong MD", mapCreditType("Lifelong Learning", "MD"), { category: "MOC Part II (Lifelong Learning)", assumed: false });
eq("moc lifelong DO", mapCreditType("Lifelong Learning", "DO"), { category: "OCC Component 2 (Lifelong Learning)", assumed: false });
eq("self assessment MD", mapCreditType("Self-Assessment", "MD"), { category: "Self-Assessment", assumed: false });
eq("practice assessment MD", mapCreditType("Practice Assessment", "MD"), { category: "MOC Part IV (Practice Improvement)", assumed: false });
eq("practice assessment DO", mapCreditType("Improvement in Medical Practice", "DO"), { category: "OCC Component 4 (Practice Assessment)", assumed: false });
eq("blank -> assumed", mapCreditType("", "MD"), { category: "AMA PRA Category 1", assumed: true });
eq("general -> assumed", mapCreditType("General", "MD"), { category: "AMA PRA Category 1", assumed: true });
eq("grand rounds", mapCreditType("Grand Rounds", "MD"), { category: "Grand Rounds", assumed: false });

// ── topics ──
eq("topics opioid", guessTopics("Opioid Prescribing: Balancing Pain Control and Misuse"), ["Opioid Prescribing", "Pain Management", "Prescriptive Practice"]);
eq("topics medical errors subject", guessTopics("FL Course", "Medical Errors"), ["Medical Errors Prevention"]);
eq("topics trafficking", guessTopics("Human Trafficking: Recognizing the Signs"), ["Human Trafficking"]);
eq("topics none", guessTopics("Advances in Lumbar Fusion"), []);
ok("topics only from list", guessTopics("ethics bias suicide dementia telehealth").every(t => ["Ethics", "Implicit Bias", "Suicide Prevention", "Geriatric Medicine", "Telemedicine"].includes(t)));

// ── CSV ──
const csv = 'Activity Title,Completion Date,Provider,Credits,Credit Type,Certificate #\n"Sepsis, Early Recognition",03/11/2024,Mayo Clinic,1.5,AMA PRA Category 1,C-123\n"Line ""two""",2024-04-02,UCSF,2,,';
eq("sniff comma", sniffDelimiter(csv), ",");
const table = parseCSV(csv);
eq("csv rows", table.length, 3);
eq("csv quoted comma", table[1][0], "Sepsis, Early Recognition");
eq("csv doubled quote", table[2][0], 'Line "two"');
const tsv = "Title\tDate\tHours\nA\t1/2/2024\t1\n";
eq("sniff tab", sniffDelimiter(tsv), "\t");
eq("tsv parse", parseCSV(tsv)[1], ["A", "1/2/2024", "1"]);
eq("bom stripped", parseCSV("﻿a,b\n1,2")[0], ["a", "b"]);

const map = guessMapping(table[0]);
eq("map generic", map, { date: 1, title: 0, provider: 2, hours: 3, category: 4, topics: null, certificateNumber: 5 });
eq("source generic", detectSource(table[0]).id, "generic");
const rows = rowsFromTable(table, map, { deg: "MD", headerIndex: 0, source: detectSource(table[0]) });
eq("rows count", rows.length, 2);
eq("row1 date", rows[0].date, "2024-03-11");
eq("row1 title", rows[0].title, "Sepsis, Early Recognition");
eq("row1 hours", rows[0].hours, 1.5);
eq("row1 category", rows[0].category, "AMA PRA Category 1");
eq("row1 not assumed", rows[0].categoryAssumed, false);
eq("row1 topics", rows[0].topics, ["Infection Control"]);
eq("row1 cert", rows[0].certificateNumber, "C-123");
eq("row2 assumed", rows[1].categoryAssumed, true);
eq("row2 warnings", rows[1].warnings, []);

// header row not first
const messy = [["CE Report"], ["Created: 8/30/2024"], [], ["Course", "Completed", "Provider", "Reported by", "Subject areas covered", "Credits earned"], ["X", "3/11/2024", "P", "P", "General", "1"]];
eq("find header", findHeaderRow(messy), 3);
eq("cebroker table source", detectSource(messy[3]).id, "cebroker-table");
const mm = guessMapping(messy[3]);
eq("cebroker table map", mm, { date: 1, title: 0, provider: 2, hours: 5, category: null, topics: 4, certificateNumber: null });

// ── PARS batch template (verified header row) ──
const parsHeader = ["Record Action", "ACCME Activity ID", "Completion Date", "First Name", "Last Name", "Date of Birth", "Licensing State", "Licensing ID or NPI", "Number of CME Credits", "Certifying Board", "Certifying Board ID", "Total Board Credits", "Credit Type ", "Credits Awarded for Credit Type"];
const parsSrc = detectSource(parsHeader);
eq("pars source", parsSrc.id, "pars-batch");
ok("pars verified", parsSrc.verified === true);
const parsMap = guessMapping(parsHeader);
eq("pars map date", parsMap.date, 2);
eq("pars map hours", parsMap.hours, 8);
eq("pars map cert=activity id", parsMap.certificateNumber, 1);
const parsRows = rowsFromTable([parsHeader, ["Add", "202212345", "44742", "All", "Learner", "09/10", "Maine", "1234567", "10", "ABIM", "999999", "5", "Medical Knowledge", "1"]], parsMap, { deg: "MD", headerIndex: 0, source: parsSrc });
eq("pars row count", parsRows.length, 1);
eq("pars row date (excel serial)", parsRows[0].date, "2022-06-30");
eq("pars row hours", parsRows[0].hours, 10);
eq("pars row title fallback", parsRows[0].title, "ACCME activity 202212345");
eq("pars row category", parsRows[0].category, "AMA PRA Category 1");
eq("pars row note", parsRows[0].notes, "PARS: reported for ABIM MOC; MOC credit type: Medical Knowledge");

// The real ACCME template (downloaded from accme.org/resource/excel-learner-batch-template/):
// row 1 is guidance text, row 2 the header, and the workbook has ValidValues /
// Reference sheets with more rows than the data sheet.
const parsXlsx = path.join(here, "fixtures", "accme-917_20240125_Learner_Excel_CME_MOC_Template.xlsx");
if (existsSync(parsXlsx)) {
  const XLSX = createRequire(import.meta.url)("xlsx");
  const wb = XLSX.read(readFileSync(parsXlsx), { type: "buffer", cellDates: false });
  const sheets = wb.SheetNames.map(n => ({ name: n, table: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: "" }).filter(r => r.some(v => String(v).trim() !== "")).map(r => r.map(v => String(v ?? "").trim())) }));
  const picked = pickSheet(sheets);
  eq("pars xlsx picks data sheet", picked.name, "Sheet1");
  const hi = findHeaderRow(picked.table);
  eq("pars xlsx header is row 2", hi, 1);
  const s2 = detectSource(picked.table[hi]);
  eq("pars xlsx source", s2.id, "pars-batch");
  const r2 = rowsFromTable(picked.table, guessMapping(picked.table[hi]), { deg: "MD", headerIndex: hi, source: s2 });
  eq("pars xlsx sample rows", r2.map(r => [r.date, r.hours, r.title]), [["2022-06-30", 10, "ACCME activity 202212345"], ["2022-06-30", 5, "ACCME activity 202212345"]]);
} else {
  console.log("skip: ACCME template fixture missing");
}

// PARS-like learner report (matched by name, unverified)
const lr = ["Provider Name", "Activity ID", "Activity Title", "Completion Date", "Credits", "First Name", "Last Name"];
eq("pars learner source", detectSource(lr).id, "pars-learner");
ok("pars learner unverified flag", detectSource(lr).verified === false);

// PARS Learner Search screen columns (from ACCME's state-board guide screenshot; download headers unverified)
const ls = ["Board", "Name", "DOB", "Learner ID", "Activity", "Completion", "Submission", "Credits Awarded", "Status"];
const lsSrc = detectSource(ls);
eq("pars learner search source", lsSrc.id, "pars-learner-search");
ok("pars learner search unverified", lsSrc.verified === false);
const lsMap = guessMapping(ls);
eq("pars learner search map", [lsMap.date, lsMap.title, lsMap.hours, lsMap.provider], [5, 4, 7, null]);
const lsRows = rowsFromTable([ls, ["NC", "Sarah Test", "1/1", "999995", "JAMA Network Multimedia Activity ID: 201577374", "7/12/21", "11/22/21", "0.5 AMA PRA Category 1 Credit™", "Accepted"]], lsMap, { deg: "MD", headerIndex: 0, source: lsSrc });
eq("pars learner search row", [lsRows[0].date, lsRows[0].hours, lsRows[0].category, lsRows[0].categoryAssumed], ["2021-07-12", 0.5, "AMA PRA Category 1", false]);

// Sources list is what the picker shows: every entry states its columns and verification
ok("sources have columns + status", IMPORT_SOURCES.every(s => s.label && s.columns && s.status && typeof s.verified === "boolean"));
ok("sources: no em dashes", IMPORT_SOURCES.every(s => !/—/.test(JSON.stringify(s))));

// ── dedupe ──
const existing = [{ date: "2024-03-11", title: "Sepsis, Early Recognition", hours: "1.5" }];
const marked = markDuplicates(rows, existing);
eq("dup flagged", marked[0].duplicate, true);
eq("dup unticked", marked[0].include, false);
eq("non-dup kept", marked[1].duplicate, false);
eq("dedupe key normalises", dedupeKey({ date: "2024-03-11", title: "SEPSIS   early-recognition!", hours: 1.5 }), dedupeKey(existing[0]));
const dupInFile = markDuplicates([rows[1], { ...rows[1], key: "x" }], []);
eq("dup within import", dupInFile[1].duplicate, true);

// ── entry shaping ──
const entry = toCmeEntry(rows[0]);
eq("entry keys", Object.keys(entry).sort(), ["category", "certificateNumber", "date", "hours", "notes", "provider", "title", "topics"]);
eq("entry hours string", entry.hours, "1.5");
ok("entry has no id (caller adds)", !("id" in entry));

// ── pasted text ──
const pasted = `Course History
Prevention of Medical Errors    3/11/2024    Florida Medical Association    2 credits
Opioid Prescribing Update  Jan 5, 2023  1.5 AMA PRA Category 1 Credits
Total 3.5`;
const trows = parseTranscriptText(pasted, { deg: "MD" });
eq("text rows", trows.length, 2);
eq("text row1", [trows[0].date, trows[0].title, trows[0].hours, trows[0].provider], ["2024-03-11", "Prevention of Medical Errors", 2, "Florida Medical Association"]);
eq("text row2", [trows[1].date, trows[1].hours, trows[1].category], ["2023-01-05", 1.5, "AMA PRA Category 1"]);
eq("text row2 title", trows[1].title, "Opioid Prescribing Update");

// ── text -> table ──
const pdfish = "CME Transcript\nDate   Activity   Provider   Hours\n03/11/2024   Prevention of Medical Errors   FMA   2.0\n2023-09-05   Opioid Update   Mayo Clinic   1.5";
const tt = textToTable(pdfish);
ok("textToTable splits on gaps", tt && tt.length === 4 && tt[2].length === 4, JSON.stringify(tt));
eq("textToTable header row", findHeaderRow(tt), 1);
const ttMap = guessMapping(tt[1]);
eq("textToTable map", ttMap, { date: 0, title: 1, provider: 2, hours: 3, category: null, topics: null, certificateNumber: null });
eq("textToTable rows", rowsFromTable(tt, ttMap, { deg: "MD", headerIndex: 1 }).map(r => [r.date, r.title, r.hours]), [["2024-03-11", "Prevention of Medical Errors", 2], ["2023-09-05", "Opioid Update", 1.5]]);
ok("textToTable prose -> null", textToTable("just one line") === null);

// ── AI reply shaping ──
const ai = rowsFromAI('```json\n[{"date":"2024-03-11","title":"T","provider":"P","hours":"2","creditType":"AMA PRA Category 1","subjects":"","certificateNumber":"C1"}]\n```', "MD");
eq("ai row", [ai[0].date, ai[0].hours, ai[0].category, ai[0].certificateNumber], ["2024-03-11", 2, "AMA PRA Category 1", "C1"]);
let threw = false; try { rowsFromAI("not json"); } catch { threw = true; } ok("ai bad json throws", threw);

// ── PDF: CE Broker-style report rendered by headless Chrome (Identity-H fonts + object streams) ──
const pdfPath = path.join(here, "fixtures", "cebroker-ce-report.pdf");
if (existsSync(pdfPath)) {
  const inflate = async (b) => { try { return inflateSync(b); } catch { return inflateRawSync(b); } };
  const ex = await extractPdfText(readFileSync(pdfPath), { inflate });
  ok("pdf pages", ex.pages.length === 1, `got ${ex.pages.length}`);
  ok("pdf readable", !ex.unreadable, ex.text.slice(0, 200));
  ok("pdf text has title", /Prevention of Medical Errors/.test(ex.text), ex.text.slice(0, 300));
  ok("pdf looks like CE Broker", looksLikeCeBroker(ex.text));
  const ceb = parseCeBrokerPages(ex.pages, { deg: "MD" });
  eq("ceb row count", ceb.length, 4);
  if (ceb.length === 4) {
    eq("ceb r1", [ceb[0].date, ceb[0].title, ceb[0].provider, ceb[0].hours], ["2024-03-11", "Prevention of Medical Errors for Florida Physicians", "FLORIDA MEDICAL ASSOCIATION", 2]);
    eq("ceb r1 topics", ceb[0].topics, ["Medical Errors Prevention"]);
    eq("ceb r1 category assumed", [ceb[0].category, ceb[0].categoryAssumed], ["AMA PRA Category 1", true]);
    ok("ceb r1 note has course #", /CE Broker course #20-900105/.test(ceb[0].notes), ceb[0].notes);
    eq("ceb r1 no cert #", ceb[0].certificateNumber, "");
    eq("ceb r2 total not per-subject", ceb[1].hours, 4);
    eq("ceb r2 provider", ceb[1].provider, "THE RX CONSULTANT, CONTINUING EDUCATION NETWORK");
    ok("ceb r2 topics", ceb[1].topics.includes("Opioid Prescribing") && ceb[1].topics.includes("Controlled Substances"), JSON.stringify(ceb[1].topics));
    eq("ceb r3 zero hours", [ceb[2].hours, ceb[2].title], [0, "FL RN Test Course #3"]);
    eq("ceb r4", [ceb[3].date, ceb[3].hours, ceb[3].topics], ["2022-09-08", 1, ["Human Trafficking"]]);
  } else {
    console.log("   rows:", JSON.stringify(ceb.map(r => [r.date, r.title, r.hours]), null, 0));
    console.log("   text:\n" + ex.text);
  }
} else {
  console.log("skip: fixture PDF missing (render scripts/fixtures/cebroker-ce-report.html with headless Chrome)");
}

// ── CME Passport transcript: text shape (as extractPdfText emits it) ──
const cmep = `Accredited Continuing Education Transcript
Vincent Van Gogh   Transcript Dates:   12/2/2021 - 4/21/2022
Completion Date   Activity   Credits Earned
4/21/2022   Testing out CME Passport   7 AMA PRA Category 1 Credits™
Western Regional Medical Center   7 ABO Points
7 Improvement in Medical Practice
7 Lifelong Learning
2/16/2022   Testing 5013 via Excel   5 ABO Points
AAA Test Organization   5 Lifelong Learning
12/2/2021   Opioid Analgesics: Risk Evaluation and Mitigation Strategy   1.5 AMA PRA Category 1 Credits™
Update for Ophthalmic Surgeons
Western Regional Medical Center
OFFICIAL TRANSCRIPT
Published 4/21/2022   1 of 1`;
ok("cmep detect", looksLikeCmePassport(cmep));
ok("cmep not cebroker", !looksLikeCeBroker(cmep));
const cp = parseCmePassportText(cmep, { deg: "MD" });
eq("cmep row count", cp.length, 3);
eq("cmep r1", [cp[0].date, cp[0].title, cp[0].provider, cp[0].hours, cp[0].category, cp[0].categoryAssumed], ["2022-04-21", "Testing out CME Passport", "Western Regional Medical Center", 7, "AMA PRA Category 1", false]);
eq("cmep r1 note", cp[0].notes, "CME Passport: 7 ABO Points, 7 Improvement in Medical Practice, 7 Lifelong Learning");
eq("cmep r2 moc-only", [cp[1].hours, cp[1].category, cp[1].provider], [5, "MOC Part II (Lifelong Learning)", "AAA Test Organization"]);
eq("cmep r3 wrapped title", [cp[2].title, cp[2].provider, cp[2].hours], ["Opioid Analgesics: Risk Evaluation and Mitigation Strategy Update for Ophthalmic Surgeons", "Western Regional Medical Center", 1.5]);
ok("cmep r3 topics", cp[2].topics.includes("Opioid Prescribing"), JSON.stringify(cp[2].topics));

const cmepPdf = path.join(here, "fixtures", "cmepassport-transcript.pdf");
if (existsSync(cmepPdf)) {
  const inflate = async (b) => { try { return inflateSync(b); } catch { return inflateRawSync(b); } };
  const ex = await extractPdfText(readFileSync(cmepPdf), { inflate });
  ok("cmep pdf detect", looksLikeCmePassport(ex.text), ex.text.slice(0, 200));
  const r = parseCmePassportText(ex.text, { deg: "MD" });
  eq("cmep pdf rows", r.map(x => [x.date, x.hours]), [["2022-04-21", 7], ["2022-02-16", 5], ["2022-02-02", 5], ["2021-12-02", 1.5]]);
  eq("cmep pdf r4 title", r[3].title, "Opioid Analgesics: Risk Evaluation and Mitigation Strategy Update for Ophthalmic Surgeons");
  eq("cmep pdf r3 category", r[2].category, "MOC Part II (Lifelong Learning)");
} else {
  console.log("skip: fixture PDF missing (render scripts/fixtures/cmepassport-transcript.html with headless Chrome)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
