// Unit-style checks for src/utils/publicRecord.js, the client half of the
// public-record lookup: what is already on file, how findings group, what may
// start ticked, what a lead says about itself, retrying one dead register, and
// exactly what an accepted row writes.
//
// The envelope under test is not hand-written. It is built here by the real
// buildEnvelope from supabase/functions/public-record/normalize.ts over the
// raw register captures in scripts/fixtures/public-record/, so the screen is
// tested against the findings the function actually returns for Eric Whitney's
// NPI 1518456078. If the two halves ever disagree, this suite is where it
// shows. The live lookup returns 25 papers; the committed esummary capture
// holds 5 of them, which is why the counts here are 15 and not 35.
//
// Run: node scripts/public-record-review.test.mjs   (pure node, no runner)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildEnvelope } from "../supabase/functions/public-record/normalize.ts";
import {
  clean, dedupeKey, markAlreadyOnFile,
  GROUP_ORDER, groupFindings, sortFindings,
  isSelectable, defaultSelectedIds, leadNote, needsLabel, evidenceLine, replacesLine, joinWords, countSelected,
  requestSourceFor, requestSourceForReport, retrySources, failedSourceNames,
  mergeEnvelopes, buildSavePlan, savedSummary,
} from "../src/utils/publicRecord.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (f) => JSON.parse(readFileSync(path.join(here, "fixtures/public-record", f), "utf8"));

const FETCHED = "2026-09-03T00:00:00.000Z";
const NPI = "1518456078";
const report = (id, name, status = "ok", count = 1) => ({ id, name, url: "", fetchedAt: FETCHED, status, count });

const ENVELOPE = buildEnvelope({
  nppes: fx("nppes-1518456078.json"),
  cmsClinician: fx("cms-clinicians-mj5m-pzi6-1518456078.json"),
  cmsAffiliation: fx("cms-affiliations-27ea-46a8-1518456078.json"),
  hospitals: fx("cms-hospitals-xubh-q36u.json"),
  pubmedSummary: fx("pubmed-esummary-whitney-e.json"),
  pubmedTerm: '"Whitney E"[Author]',
  sources: [
    report("nppes", "NPPES NPI Registry"),
    report("cmsClinician", "Medicare Care Compare (Doctors and Clinicians)", "ok", 3),
    report("cmsAffiliation", "Medicare Care Compare (facility affiliations)", "ok", 3),
    report("cmsHospital", "Medicare Hospital General Information", "ok", 3),
    report("pubmed", "PubMed", "ok", 5),
  ],
  errors: [],
}, { npi: NPI, fetchedAt: FETCHED });

const ALL = ENVELOPE.findings;

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`FAIL ${name}\n   got  ${g}\n   want ${w}`); }
};
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${name} ${extra}`); } };
const byId = (list, id) => list.find(f => f.id === id);
const ids = (list) => list.map(f => f.id);

// ── The envelope this screen is built on ────────────────────────────────────
eq("the fixture envelope is the one the function returns", ALL.length, 15);
eq("one license, one school, two employers, three hospitals, five papers",
  GROUP_ORDER.map(s => ALL.filter(f => f.section === s).length),
  [3, 1, 1, 2, 3, 5, 0]);

// ── Already on file ─────────────────────────────────────────────────────────
eq("clean drops the registry's dashes", clean("--"), "");
eq("license key ignores typing", dedupeKey("licenses", { state: "CA", licenseNumber: "20A-17841" }),
  dedupeKey("licenses", { state: "ca", licenseNumber: "20a17841" }));
eq("a license with no number has no key", dedupeKey("licenses", {}), "");
eq("publication keys on the pmid", dedupeKey("publications", { pmid: "42350380" }), "publications:pmid:42350380");

const ON_FILE = {
  licenses: [{ state: "CA", licenseNumber: "20A-17841", type: "State Medical License (DO)" }],
  privileges: [{ facility: "Eisenhower Medical Center" }],
  publications: [{ pmid: "42350380" }],
  workHistory: [],
};
// Only the name is on file, so the degree the registry states is still a
// proposal and the name is not.
const SETTINGS = { name: "Eric Whitney" };
const marked = markAlreadyOnFile(ALL, ON_FILE, SETTINGS);

eq("a license already typed is flagged, not proposed again",
  byId(marked, "nppes:license:CA|20A17841").alreadyOnFile, true);
eq("a privilege already on file is flagged", byId(marked, "cms:privilege:050573").alreadyOnFile, true);
eq("a hospital not on file is still proposed", byId(marked, "cms:privilege:050245").alreadyOnFile, false);
eq("a paper already saved is flagged", byId(marked, "pubmed:publication:42350380").alreadyOnFile, true);
eq("a profile value already set is flagged", byId(marked, "nppes:profile:name").alreadyOnFile, true);
eq("a profile value not set is proposed", byId(marked, "nppes:profile:practiceAddress").alreadyOnFile, false);
eq("nothing is dropped by the dedupe", marked.length, ALL.length);

// Medicare files the school as "OTHER", so the education finding has a degree
// and no school. Without a second key it would be proposed again forever.
eq("education keys on the degree when there is no school",
  dedupeKey("education", { type: "Doctor of Osteopathic Medicine (DO)" }),
  "education:type:DOCTOROFOSTEOPATHICMEDICINEDO");
eq("education still keys on the school when there is one",
  dedupeKey("education", { type: "Doctor of Osteopathic Medicine (DO)", institution: "PCOM" }), "education:PCOM");
const school = ALL.filter(f => f.section === "education");
eq("a degree already on file is flagged even when Medicare has no school",
  markAlreadyOnFile(school, { education: [{ type: "Doctor of Osteopathic Medicine (DO)", institution: "PCOM" }] })[0].alreadyOnFile, true);
eq("a different degree on file is not a match",
  markAlreadyOnFile(school, { education: [{ type: "Doctor of Medicine (MD)", institution: "PCOM" }] })[0].alreadyOnFile, false);
eq("an empty record file flags nothing", markAlreadyOnFile(ALL, {}, {}).filter(f => f.alreadyOnFile).length, 0);

// ── Grouping ────────────────────────────────────────────────────────────────
const groups = groupFindings(marked);
eq("groups read profile first, publications last",
  groups.map(g => g.title), ["Profile", "Licenses", "Education", "Work history", "Privileges", "Publications"]);
eq("an empty section is not a heading", groups.some(g => g.section === "memberships"), false);
eq("every finding lands in exactly one group",
  groups.reduce((n, g) => n + g.findings.length, 0), marked.length);
eq("a section the function grows later still shows",
  groupFindings([{ id: "x:1", section: "boardCerts", confidence: "record" }]).map(g => g.section), ["boardCerts"]);
eq("sortFindings puts records before leads inside a section",
  sortFindings([
    { id: "b", section: "privileges", confidence: "lead" },
    { id: "a", section: "privileges", confidence: "record" },
  ]).map(f => f.id), ["a", "b"]);

// ── What starts ticked ──────────────────────────────────────────────────────
const defaults = defaultSelectedIds(marked);
eq("no lead is ticked by default",
  marked.filter(f => defaults.includes(f.id)).every(f => f.confidence === "record"), true);
eq("nothing already on file is ticked",
  marked.filter(f => defaults.includes(f.id)).some(f => f.alreadyOnFile), false);
eq("the plain records that are new start ticked", defaults.sort(), [
  "cms:education:medicalSchool",
  "nppes:profile:degree",
  "nppes:profile:practiceAddress",
].sort());
eq("no hospital and no paper is ticked",
  defaults.some(id => id.startsWith("cms:privilege:") || id.startsWith("pubmed:")), false);
eq("a row already on file cannot be ticked", isSelectable(byId(marked, "cms:privilege:050573")), false);
eq("a row not on file can be", isSelectable(byId(marked, "cms:privilege:050245")), true);
eq("counting ignores rows on file",
  countSelected(marked, ["cms:privilege:050573", "cms:privilege:050245"]), 1);

// ── A profile row that would overwrite what the physician typed ─────────────
// The profile is the one section whose findings write a patch of several
// fields behind a one-line label, and primaryState is what the renewal
// reminders, the CME state and the setup gate are all read from. A ticked
// box must never be the only warning that it is about to change.
const FILLED = {
  name: "Eric E. Whitney",
  address: "Barrow Neurological Institute, 350 W Thomas Rd, Phoenix, AZ 85013",
  phone: "602-406-3000",
  primaryState: "AZ",
};
const onFilled = markAlreadyOnFile(ALL, {}, FILLED);
const filledDefaults = defaultSelectedIds(onFilled);

eq("a profile row that would overwrite a name does not start ticked",
  filledDefaults.includes("nppes:profile:name"), false);
eq("nor one that would overwrite the address and the primary state",
  filledDefaults.includes("nppes:profile:practiceAddress"), false);
ok("the name row says what it replaces",
  byId(onFilled, "nppes:profile:name").replaces.length > 0);
eq("the address row names every field it would take",
  byId(onFilled, "nppes:profile:practiceAddress").replaces.sort(),
  ["address", "phone", "primaryState"]);
eq("the line reads as a sentence",
  replacesLine(byId(onFilled, "nppes:profile:practiceAddress"), FILLED),
  "Replaces your address (Barrow Neurological Institute, 350 W Thomas Rd, Phoenix, AZ 85013), phone (602-406-3000) and primary state (AZ).");
eq("a row that replaces nothing says nothing",
  replacesLine(byId(onFilled, "nppes:profile:degree"), FILLED), "");
eq("the degree the physician has not set still starts ticked",
  filledDefaults.includes("nppes:profile:degree"), true);
ok("nothing outside the profile is dragged into this",
  onFilled.filter(f => f.section !== "settings").every(f => f.replaces === undefined));

// A blank profile is the case this feature exists for, and it must keep
// filling itself in: replacing nothing is not a judgement call.
const blankDefaults = defaultSelectedIds(markAlreadyOnFile(ALL, {}, {}));
eq("on a blank profile the name is still ticked by default",
  blankDefaults.includes("nppes:profile:name"), true);
eq("and so is the practice address", blankDefaults.includes("nppes:profile:practiceAddress"), true);
eq("a blank profile replaces nothing",
  markAlreadyOnFile(ALL, {}, {}).filter(f => (f.replaces || []).length).length, 0);

// A field already holding the register's own value is not a replacement, and
// a field the physician never filled in is not one either. Only a value that
// exists and disagrees counts.
const sameAddress = markAlreadyOnFile(ALL, {}, {
  address: "26520 Cactus Ave Ste A2006, Moreno Valley, CA 92555-3927",
  primaryState: "AZ",
});
eq("only the field that exists and disagrees counts",
  byId(sameAddress, "nppes:profile:practiceAddress").replaces, ["primaryState"]);
eq("and the row that would flip it does not start ticked",
  defaultSelectedIds(sameAddress).includes("nppes:profile:practiceAddress"), false);
eq("the sentence names just that one",
  replacesLine(byId(sameAddress, "nppes:profile:practiceAddress"), { primaryState: "AZ" }),
  "Replaces your primary state (AZ).");
eq("a profile row entirely on file is flagged and replaces nothing",
  [byId(marked, "nppes:profile:name").alreadyOnFile, byId(marked, "nppes:profile:name").replaces],
  [true, []]);

// ── What a lead says about itself ───────────────────────────────────────────
eq("every lead carries a sentence",
  marked.filter(f => f.confidence === "lead").every(f => leadNote(f).length > 0), true);
eq("a record carries none", leadNote(byId(marked, "nppes:profile:degree")), "");
eq("the hospital sentence", leadNote(byId(marked, "cms:privilege:050245")),
  "Medicare claims show you working here. Confirm before treating it as a privilege.");
eq("the paper sentence", leadNote(byId(marked, "pubmed:publication:42350380")),
  "Matched by name; check it is yours.");
// mj5m-pzi6 is Medicare enrolment, not claims. The hospital sentence above may
// say claims because 27ea-46a8 is claims-derived; this one may not.
eq("the work-history sentence names enrolment, not claims",
  leadNote(byId(marked, "cms:workHistory:5890689657")),
  "Medicare lists this as a practice location enrolled under your NPI. Confirm your title and dates.");
eq("no work-history sentence calls it a claim",
  marked.filter(f => f.section === "workHistory").some(f => /claim/i.test(leadNote(f))), false);
eq("no lead sentence claims a privilege or a verification",
  marked.filter(f => f.confidence === "lead").some(f => /\bactive\b|verified|credentialed/i.test(leadNote(f))), false);
eq("needs read as words", needsLabel(["expirationDate"]), "expiration date");
eq("two needs read as a sentence", needsLabel(["type", "expirationDate"]), "type and expiration date");
eq("three needs read as a list", needsLabel(["institution", "graduationDate", "type"]), "school, graduation date and type");
eq("no needs, no line", needsLabel([]), "");
eq("one name reads alone", joinWords(["PubMed"]), "PubMed");
eq("two names take an and", joinWords(["PubMed", "NPPES"]), "PubMed and NPPES");
eq("three dead registers read as a list",
  joinWords(["PubMed", "NPPES", "Medicare"]), "PubMed, NPPES and Medicare");
eq("nothing failed, nothing said", joinWords([]), "");
// A name match is judged on its co-authors, journal and year, so the row
// shows the citation the function already assembled rather than the bare title.
eq("a paper shows the line that identifies it",
  evidenceLine(byId(ALL, "pubmed:publication:31424740")),
  "Whitney E, Munakomi S. Hoffmann Sign. StatPearls. 2026.");
eq("a hospital carries its city in the label already, so it adds nothing",
  evidenceLine(byId(ALL, "cms:privilege:050245")), "");
eq("a profile row adds nothing", evidenceLine(byId(ALL, "nppes:profile:degree")), "");
eq("no finding at all is safe", evidenceLine(null), "");

eq("the license finding still asks for its expiration date",
  needsLabel(byId(marked, "nppes:license:CA|20A17841").needs), "expiration date");

// ── Retrying one dead register ──────────────────────────────────────────────
eq("a hospital finding came from the affiliations call",
  requestSourceFor(byId(ALL, "cms:privilege:050245")), "affiliations");
eq("a work-history finding came from the clinicians call",
  requestSourceFor("cms:workHistory:5890689657"), "cms");
eq("a license came from NPPES", requestSourceFor("nppes:license:CA|20A17841"), "nppes");
eq("a paper came from PubMed", requestSourceFor("pubmed:publication:42350380"), "pubmed");
eq("an id from nowhere maps to nothing", requestSourceFor("who:knows"), "");
eq("the hospital-name call retries with the affiliations", requestSourceForReport("cmsHospital"), "affiliations");
eq("retry asks each register once",
  retrySources([{ source: "cmsAffiliation" }, { source: "cmsHospital" }, { source: "pubmed" }]),
  ["affiliations", "pubmed"]);

const DOWN = {
  ...ENVELOPE,
  findings: ALL.filter(f => requestSourceFor(f) !== "pubmed"),
  sources: ENVELOPE.sources.map(s => s.id === "pubmed" ? { ...s, status: "error", count: 0 } : s),
  errors: [{ source: "pubmed", message: "eutils.ncbi.nlm.nih.gov returned 502" }],
};
eq("the dead register is named", failedSourceNames(DOWN), ["PubMed"]);
eq("the rest is still usable", DOWN.findings.length, 10);

const RETRIED = {
  npi: NPI,
  fetchedAt: "2026-09-03T01:00:00.000Z",
  findings: ALL.filter(f => requestSourceFor(f) === "pubmed"),
  sources: [report("pubmed", "PubMed", "ok", 5)],
  errors: [],
};
const merged = mergeEnvelopes(DOWN, RETRIED, ["pubmed"]);
eq("a retry restores the whole set", merged.findings.length, 15);
eq("a retry does not duplicate what was already there",
  new Set(ids(merged.findings)).size, merged.findings.length);
eq("a register that answered stops being an error", merged.errors, []);
eq("the retried source report is the new one",
  merged.sources.find(s => s.id === "pubmed").status, "ok");
eq("the other source reports survive", merged.sources.length, 5);
eq("the merged findings are back in reading order",
  ids(merged.findings), ids(sortFindings(merged.findings)));
eq("the merge keeps the NPI", merged.npi, NPI);
eq("the merge takes the newer fetch time", merged.fetchedAt, "2026-09-03T01:00:00.000Z");

const stillDown = mergeEnvelopes(DOWN, { findings: [], sources: [report("pubmed", "PubMed", "error", 0)], errors: [{ source: "pubmed", message: "timed out" }] }, ["pubmed"]);
eq("a retry that fails again is still one error", stillDown.errors.length, 1);
eq("and does not lose the other registers", stillDown.findings.length, 10);

// ── What a tick writes ──────────────────────────────────────────────────────
let n = 0;
const makeId = () => `id-${++n}`;

const plan = buildSavePlan(marked, [
  "nppes:profile:degree",
  "nppes:profile:practiceAddress",
  "nppes:profile:name",        // already on file: must not be written
  "cms:privilege:050573",      // already on file: must not be written
  "cms:privilege:050245",
  "cms:education:medicalSchool",
  "pubmed:publication:42089801",
], makeId);

eq("the profile is one patch", plan.settings, {
  degreeType: "DO",
  address: "26520 Cactus Ave Ste A2006, Moreno Valley, CA 92555-3927",
  phone: "951-486-4460",
  primaryState: "CA",
});
eq("a profile value already set is not rewritten", "name" in plan.settings, false);
eq("the sections written", plan.items.map(i => i.section), ["education", "privileges", "publications"]);
eq("a privilege already on file is not written a second time",
  plan.items.some(i => i.item.notes && i.item.notes.includes("050573")), false);
eq("every written record carries an id", plan.items.every(i => !!i.item.id), true);
eq("ids are not shared", new Set(plan.items.map(i => i.item.id)).size, plan.items.length);
eq("the count is what the footer shows", plan.count, 5);
eq("the count matches the selection count",
  plan.count, countSelected(marked, [
    "nppes:profile:degree", "nppes:profile:practiceAddress", "nppes:profile:name",
    "cms:privilege:050573", "cms:privilege:050245", "cms:education:medicalSchool",
    "pubmed:publication:42089801",
  ]));

const privilege = plan.items.find(i => i.section === "privileges").item;
eq("an accepted hospital carries the facility the form asks for", privilege.facility, "Arrowhead Regional Medical Center");
eq("and no status", "status" in privilege, false);
eq("and no expiration date invented for it", "expirationDate" in privilege, false);
eq("and no appointment date invented for it", "appointmentDate" in privilege, false);
ok("its note says what the affiliation is", /claims activity, not a credentialing verification/i.test(privilege.notes), privilege.notes);

const publication = plan.items.find(i => i.section === "publications").item;
eq("an accepted paper keeps its pmid", publication.pmid, "42089801");
ok("and says it was matched by name", /by author name/i.test(publication.notes), publication.notes);

const education = plan.items.find(i => i.section === "education").item;
eq("Medicare's OTHER never becomes a school", "institution" in education, false);
eq("the degree it does state is written", education.type, "Doctor of Osteopathic Medicine (DO)");

eq("nothing ticked writes nothing", buildSavePlan(marked, [], makeId), { settings: {}, settingsFindings: [], items: [], count: 0 });
eq("an id that is not in the findings writes nothing", buildSavePlan(marked, ["made:up"], makeId).count, 0);

eq("what was saved reads back grouped",
  savedSummary(plan).map(g => [g.title, g.findings.length]),
  [["Profile", 2], ["Education", 1], ["Privileges", 1], ["Publications", 1]]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
