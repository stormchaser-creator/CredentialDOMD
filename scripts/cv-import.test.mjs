// Reading a CV into the record: src/utils/cvImport.js, and the round trip
// back out through src/utils/cvContent.js, which is the only proof that what
// the parser writes is what the CV generator can read.
//
// The fixture is one model reply for a realistic physician CV, including the
// cases that break a naive parser: a year-only graduation, a month-and-year
// start, a license with no expiration, a type outside the app's own list, a
// state written in full, and a credential the model labelled with the
// physician's own name.
// Run: node scripts/cv-import.test.mjs
import { readFileSync } from "node:fs";
import {
  cvYearDate, normalizeCvSections, cvFindings, defaultSelectedCvIds,
  namesThePhysician, selectableIdsIn, CV_FILENAME_RE,
} from "../src/utils/cvImport.js";
import {
  markAlreadyOnFile, markPlanLocks, groupFindings, isSelectable, leadNote,
  needsLabel, buildSavePlan, savedSummary, GROUP_ORDER, replacesLine,
} from "../src/utils/publicRecord.js";
import { buildCvContent } from "../src/utils/cvContent.js";
import { DEFAULT_DATA } from "../src/constants/defaults.js";
import { EDUCATION_TYPES, WORK_HISTORY_TYPES } from "../src/constants/credentialTypes.js";

let pass = 0, fail = 0;
const eq = (n, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass++; else { fail++; console.log(`FAIL ${n}\n   got  ${g}\n   want ${w}`); }
};
const ok = (n, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${n} ${extra}`); } };

const RAW = JSON.parse(readFileSync(new URL("./fixtures/cv/model-reply.json", import.meta.url), "utf8"));
const SETTINGS = { name: "Daniel Logsdon", degreeType: "MD" };

// ── Dates keep the precision the CV printed, and no more ───────────────────
eq("a year becomes the first of that year", cvYearDate("2006"), "2006-01-01");
eq("a month and year becomes the first of that month", cvYearDate("June 2006"), "2006-06-01");
eq("an abbreviated month too", cvYearDate("Jun 2006"), "2006-06-01");
eq("a full date is untouched", cvYearDate("2006-07-25"), "2006-07-25");
eq("a YYYY-MM value gains the first", cvYearDate("2006-06"), "2006-06-01");
eq("a numeric month and year", cvYearDate("06/2006"), "2006-06-01");
eq("prose with a year falls back to the year", cvYearDate("graduated 2006 with honors"), "2006-01-01");
eq("nothing readable is nothing", cvYearDate("sometime"), "");
eq("empty stays empty", cvYearDate(""), "");
eq("null stays empty", cvYearDate(null), "");
// The reason year precision matters: cvContent prints a Jan-1 date as the
// bare year rather than asserting a day nobody wrote down.
{
  const data = { ...DEFAULT_DATA, settings: { ...DEFAULT_DATA.settings, name: "A B", degreeType: "MD" },
    education: [{ id: "e", type: "Doctor of Medicine (MD)", name: "MD Diploma", institution: "USC", graduationDate: cvYearDate("2006") }] };
  const cv = buildCvContent(data);
  const edu = cv.find((s) => s.title === "Education");
  ok("a year-only graduation prints as the year, never as 1 January",
    edu.items[0].primary.includes("2006") && !/January/.test(JSON.stringify(cv)));
}

// ── The physician's own name never becomes a credential label ──────────────
ok("the physician's name is recognised", namesThePhysician("Daniel Logsdon", "Daniel Logsdon"));
ok("with a degree after it too", namesThePhysician("Daniel Logsdon MD", "Daniel Logsdon"));
ok("a school is not", !namesThePhysician("Keck School of Medicine of USC", "Daniel Logsdon"));
ok("an empty name counts as unusable", namesThePhysician("", "Daniel Logsdon"));
ok("and with no name on file nothing is claimed", !namesThePhysician("Anything", ""));

// ── Normalising ────────────────────────────────────────────────────────────
const secs = normalizeCvSections(RAW, { deg: "MD", name: "Daniel Logsdon" });

eq("the profile fields that survive", Object.keys(secs.settings).sort(),
  ["address", "degreeType", "email", "name", "npi", "phone", "professionalSummary", "specialties"]);
eq("an empty highlight line is not written", secs.settings.cvHighlights, undefined);
eq("the NPI keeps its ten digits", secs.settings.npi, "1234567890");

eq("every education type is one the form offers",
  secs.education.every((e) => EDUCATION_TYPES.includes(e.type)), true);
// "Spine Fellowship" is not a value the form offers, but the form's own
// "Fellowship Certificate" shares the word that matters, so the physician does
// not have to re-pick it.
eq("a near miss lands on the option that shares its word",
  secs.education.find((e) => e.institution === "Cleveland Clinic").type, "Fellowship Certificate");
eq("something with nothing in common still falls back",
  normalizeCvSections({ education: [{ type: "Sabbatical", institution: "X" }] }).education[0].type, "Other");
eq("the physician's own name is replaced by a credential label",
  secs.education[0].name, "Doctor of Medicine (MD) - Keck School of Medicine of USC");
// The profile may hold a short form of the name while the CV prints it in
// full, so the CV's own statement of the name is tested too.
eq("a full name on the CV is caught even when the profile holds a short form",
  normalizeCvSections(RAW, { deg: "MD", name: "Dan Logsdon" }).education[0].name,
  "Doctor of Medicine (MD) - Keck School of Medicine of USC");
eq("a month-and-year start survives", secs.education[1].startDate, "2006-06-01");

eq("every work type is one the form offers",
  secs.workHistory.every((w) => WORK_HISTORY_TYPES.includes(w.type)), true);
eq("Locums reaches Locum Tenens through the shared stem", secs.workHistory[1].type, "Locum Tenens");
eq("and an unrecognisable position type falls back",
  normalizeCvSections({ workHistory: [{ type: "Consultancy", employer: "X" }] }).workHistory[0].type, "Other");
eq("a state written in full becomes its code", secs.workHistory[0].state, "CA");
eq("current reads as the select's own Yes", secs.workHistory[0].current, "Yes");
eq("and No when it is not", secs.workHistory[1].current, "No");

eq("a license with no expiration keeps the blank rather than inventing one",
  secs.licenses[0].expirationDate, "");
eq("a board certificate labelled with the physician gets a credential label",
  secs.licenses[2].name, "Board Certification (ABMS)");
eq("an unmapped state is dropped rather than guessed", secs.licenses[2].state, "");

eq("a publication with no short label borrows its citation",
  secs.publications[1].name.startsWith("Logsdon D. Minimally invasive TLIF"), true);
eq("a PMID keeps only digits", secs.publications[0].pmid, "33987654");

// ── Findings ───────────────────────────────────────────────────────────────
const findings = cvFindings(RAW, { data: DEFAULT_DATA, settings: SETTINGS });

ok("every finding has a unique id", new Set(findings.map((f) => f.id)).size === findings.length);
ok("every id is prefixed so a second read of the same CV is stable",
  findings.every((f) => f.id.startsWith("cv:")));
ok("every finding sits in a section the review screen has a title for",
  findings.every((f) => GROUP_ORDER.includes(f.section)),
  findings.filter((f) => !GROUP_ORDER.includes(f.section)).map((f) => f.section).join(", "));
ok("nothing read off a CV is ever a record", findings.every((f) => f.confidence === "lead"));
ok("every finding carries a label", findings.every((f) => f.label && f.label.length > 0));
ok("every finding names where it came from", findings.every((f) => f.source?.name === "Your CV"));
eq("the CV's own lead sentence, not the generic one",
  leadNote(findings[0]), "Read off your CV by AI. Check it against the document before you keep it.");

const bySection = (sec) => findings.filter((f) => f.section === sec);
eq("counts per section", GROUP_ORDER.map((g) => [g, bySection(g).length]),
  [["settings", 8], ["licenses", 3], ["education", 3], ["workHistory", 2], ["privileges", 1], ["publications", 2], ["memberships", 2]]);

const dateless = bySection("licenses").find((f) => f.fields.state === "CA");
eq("a license with no expiration says what you still have to add", dateless.needs, ["expirationDate"]);
eq("and the screen words it", needsLabel(dateless.needs), "expiration date");
eq("a license that HAS an expiration asks for nothing",
  bySection("licenses").find((f) => f.fields.state === "OH").needs, []);

// ── Nothing starts ticked ──────────────────────────────────────────────────
eq("nothing starts ticked", defaultSelectedCvIds(), []);
eq("and an empty selection writes nothing",
  buildSavePlan(findings, [], () => "id").count, 0);

// ── Matching against what is already on file ───────────────────────────────
{
  // The same Ohio license, typed by hand with the dot the state prints.
  const onFile = { ...DEFAULT_DATA, licenses: [{ id: "x", type: "State Medical License", state: "OH", licenseNumber: "35.123456" }] };
  const marked = markAlreadyOnFile(findings, onFile, SETTINGS);
  const oh = marked.find((f) => f.section === "licenses" && f.fields.state === "OH");
  ok("a license already on file is marked, however it was punctuated", oh.alreadyOnFile);
  ok("and cannot be ticked", !isSelectable(oh));
  const ca = marked.find((f) => f.section === "licenses" && f.fields.state === "CA");
  ok("a license that is not on file still can be", isSelectable(ca));
  eq("and it is never written even if its id is in the selection",
    buildSavePlan(marked, marked.map((f) => f.id), () => "id").items.filter((i) => i.item.state === "OH").length, 0);
}

// ── The plan gate ──────────────────────────────────────────────────────────
{
  const free = markPlanLocks(markAlreadyOnFile(findings, DEFAULT_DATA, SETTINGS), { isPro: false });
  const priv = free.filter((f) => f.section === "privileges");
  ok("a free account cannot tick a privilege into a page it cannot open",
    priv.length > 0 && priv.every((f) => f.planLocked && !isSelectable(f)));
  ok("and nothing else is locked",
    free.filter((f) => f.section !== "privileges").every((f) => !f.planLocked));
  const pro = markPlanLocks(markAlreadyOnFile(findings, DEFAULT_DATA, SETTINGS), { isPro: true });
  ok("a Pro account can", pro.filter((f) => f.section === "privileges").every(isSelectable));
}

// ── A profile row says what it would take away ─────────────────────────────
{
  const typed = { name: "Dan Logsdon", degreeType: "MD" };
  const marked = markAlreadyOnFile(findings, DEFAULT_DATA, typed);
  const nameRow = marked.find((f) => f.id === "cv:settings:name");
  eq("a profile row that overwrites something typed names it", nameRow.replaces, ["name"]);
  eq("and the sentence quotes the current value", replacesLine(nameRow, typed), "Replaces your name (Dan Logsdon).");
  const degreeRow = marked.find((f) => f.id === "cv:settings:degreeType");
  ok("a value that matches what is on file replaces nothing", degreeRow.alreadyOnFile);
}

// ── Ticking a whole group ──────────────────────────────────────────────────
{
  const marked = markPlanLocks(markAlreadyOnFile(findings, DEFAULT_DATA, SETTINGS), { isPro: false });
  const groups = groupFindings(marked);
  const priv = groups.find((g) => g.section === "privileges");
  eq("tick-all skips the rows that cannot be ticked", selectableIdsIn(priv), []);
  const edu = groups.find((g) => g.section === "education");
  eq("and takes every row that can", selectableIdsIn(edu).length, 3);
}

// ── The round trip: CV in, record, CV out ──────────────────────────────────
{
  const marked = markPlanLocks(markAlreadyOnFile(findings, DEFAULT_DATA, SETTINGS), { isPro: true });
  let n = 0;
  const plan = buildSavePlan(marked, marked.map((f) => f.id), () => `id${++n}`);
  // Two profile rows state what the physician already has, so they are marked
  // already on file and never written a second time.
  eq("only the rows that are not already on file are written",
    plan.count, marked.filter(isSelectable).length);
  eq("and the two that match what is on file are the profile ones",
    marked.filter((f) => !isSelectable(f)).map((f) => f.id), ["cv:settings:name", "cv:settings:degreeType"]);

  // Apply the plan the way the component does, into a real data object.
  const data = { ...DEFAULT_DATA, settings: { ...DEFAULT_DATA.settings, ...plan.settings } };
  for (const { section, item } of plan.items) data[section] = [...(data[section] || []), item];

  const cv = buildCvContent(data);
  const titles = cv.filter((s) => s.type === "section").map((s) => s.title);
  for (const want of ["Professional Experience", "Education", "Publications", "Professional Organizations"]) {
    ok(`the generated CV carries ${want}`, titles.includes(want));
  }
  const text = JSON.stringify(cv);
  ok("the employer read off the CV comes back out", text.includes("Arrowhead Regional Medical Center"));
  ok("the medical school comes back out", text.includes("Keck School of Medicine of USC"));
  ok("the citation comes back out verbatim", text.includes("Cureus. 2021;13(4):e14320"));
  ok("the license number comes back out", text.includes("35.123456"));
  ok("no credential is labelled with the physician's own name",
    !/"primary":"Daniel Logsdon/.test(text));
  eq("what was saved, grouped the way the screen showed it",
    savedSummary(plan).map((g) => g.section), GROUP_ORDER);
}

// ── House rules ────────────────────────────────────────────────────────────
ok("no em dash in anything the parser produces",
  !JSON.stringify(findings).includes("—"));
ok("no em dash in the CV lead sentence", !leadNote(findings[0]).includes("—"));

// ── The filename rule the setup row reads ──────────────────────────────────
for (const [name, want] of [
  ["Whitney CV 2026.pdf", true], ["logsdon-resume.docx", true], ["Résumé 2026.pdf", true],
  ["curriculum vitae.pdf", true], ["curriculum_vitae.docx", true], ["cv.pdf", true],
  ["CA license.pdf", false], ["DEA certificate.pdf", false], ["archive.zip", false], ["recv.pdf", false],
]) {
  eq(`"${name}" reads as a CV: ${want}`, CV_FILENAME_RE.test(name), want);
}

// ── Nothing throws on rubbish ──────────────────────────────────────────────
eq("an empty reply yields nothing", cvFindings({}, { data: DEFAULT_DATA, settings: SETTINGS }).length, 0);
eq("a null reply yields nothing", cvFindings(null, { data: DEFAULT_DATA, settings: SETTINGS }).length, 0);
eq("a reply of the wrong shape yields nothing",
  cvFindings({ education: "not an array", licenses: 5 }, { data: DEFAULT_DATA, settings: SETTINGS }).length, 0);
eq("no context at all does not throw", cvFindings(RAW).length > 0, true);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
