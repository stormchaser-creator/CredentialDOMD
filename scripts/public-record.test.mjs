// Unit-style checks for supabase/functions/public-record/normalize.ts, the
// pure half of the public-record lookup. Node 24 imports the .ts file directly
// (type stripping), the same way scripts/ai-pricing.test.mjs does.
//
// Every fixture in scripts/fixtures/public-record/ is raw JSON captured live
// on 2026-09-03 from the register named in its filename, queried with Eric
// Whitney's NPI 1518456078. The Whitney E PubMed fixture is deliberately not
// his: it is what a name match actually returns, which is the point of the
// "lead" label.
//
// Run: node scripts/public-record.test.mjs   (pure node, no test runner)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  clean, titleCase, formatPhone, formatZip, oneLineAddress, degreeFromCredential,
  licenseTypeFor, licenseKey, pubmedAuthorTerm,
  normalizeNppes, normalizeCmsClinician, normalizeAffiliations, normalizePubmed,
  buildEnvelope,
} from "../supabase/functions/public-record/normalize.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (f) => JSON.parse(readFileSync(path.join(here, "fixtures/public-record", f), "utf8"));

const NPPES = fx("nppes-1518456078.json");
const CMS = fx("cms-clinicians-mj5m-pzi6-1518456078.json");
const AFF = fx("cms-affiliations-27ea-46a8-1518456078.json");
const HOSP = fx("cms-hospitals-xubh-q36u.json");
const PM_SEARCH = fx("pubmed-esearch-whitney-e.json");
const PM_SUMMARY = fx("pubmed-esummary-whitney-e.json");

const CTX = { npi: "1518456078", fetchedAt: "2026-09-03T00:00:00.000Z" };

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`FAIL ${name}\n   got  ${g}\n   want ${w}`); }
};
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${name} ${extra}`); } };
const byId = (list, id) => list.find(f => f.id === id);

// ── Scalars ─────────────────────────────────────────────────────────────────
eq("clean trims and collapses", clean("  ERIC   WHITNEY "), "ERIC WHITNEY");
eq("clean drops the registry's dashes", clean("--"), "");
eq("clean drops N/A", clean("n/a"), "");
eq("clean null", clean(null), "");
eq("titleCase a shouting register", titleCase("EISENHOWER MEDICAL CENTER"), "Eisenhower Medical Center");
eq("titleCase keeps small words down", titleCase("CAL MED PHYSICIANS AND SURGEONS INC"), "Cal Med Physicians and Surgeons Inc");
eq("titleCase across a hyphen", titleCase("RIVERSIDE UNIVERSITY HEALTH SYSTEM-MEDICAL CENTER"), "Riverside University Health System-Medical Center");
eq("titleCase leaves mixed case alone", titleCase("McGraw Neurosurgery"), "McGraw Neurosurgery");
eq("formatPhone 10 digits", formatPhone("9095803353"), "909-580-3353");
eq("formatPhone normalizes a punctuated number", formatPhone("(909) 580-1000"), "909-580-1000");
eq("formatZip plus four", formatZip("922703221"), "92270-3221");
eq("formatZip five", formatZip("92270"), "92270");
eq("oneLineAddress", oneLineAddress({ line1: "39000 BOB HOPE DR", city: "RANCHO MIRAGE", state: "ca", zip: "922703221" }),
  "39000 Bob Hope Dr, Rancho Mirage, CA 92270-3221");
eq("degree DO", degreeFromCredential("D.O."), "DO");
eq("degree MD from a list", degreeFromCredential("MD, PHD"), "MD");
eq("degree none", degreeFromCredential("--"), "");
eq("license type DO", licenseTypeFor("DO"), "State Medical License (DO)");
eq("license type default", licenseTypeFor(""), "State Medical License");
eq("licenseKey ignores punctuation", licenseKey("ca", "20A-17841"), licenseKey("CA", "20a17841"));

// ── NPPES: the live record for NPI 1518456078 ───────────────────────────────
const nppes = normalizeNppes(NPPES, CTX);
eq("nppes name", byId(nppes, "nppes:profile:name").fields, { name: "Eric Whitney" });
eq("nppes name label carries the degree", byId(nppes, "nppes:profile:name").label, "Eric Whitney, DO");
eq("nppes degree", byId(nppes, "nppes:profile:degree").fields, { degreeType: "DO" });
eq("nppes practice address", byId(nppes, "nppes:profile:practiceAddress").fields, {
  address: "26520 Cactus Ave Ste A2006, Moreno Valley, CA 92555-3927",
  phone: "951-486-4460",
  primaryState: "CA",
});
ok("every nppes profile finding is a record", nppes.filter(f => f.section === "settings").every(f => f.confidence === "record"));

const licenses = nppes.filter(f => f.section === "licenses");
eq("one license on file", licenses.length, 1);
eq("license fields are form shaped", licenses[0].fields, {
  type: "State Medical License (DO)",
  name: "CA Medical License",
  licenseNumber: "20A17841",
  state: "CA",
  notes: "Imported from NPPES NPI Registry (Neurological Surgery)",
});
eq("license is a stated record", licenses[0].confidence, "record");
eq("license never invents an expiration", licenses[0].fields.expirationDate, undefined);
eq("license asks for the expiration", licenses[0].needs, ["expirationDate"]);
eq("license links to the registry page", licenses[0].source.url, "https://npiregistry.cms.hhs.gov/provider-view/1518456078");
eq("license names its source", licenses[0].source.name, "NPPES NPI Registry");

// Two taxonomy rows sharing one license collapse to one finding.
const twoRows = normalizeNppes({
  results: [{
    number: "1518456078",
    basic: { first_name: "ERIC", last_name: "WHITNEY", credential: "DO" },
    taxonomies: [
      { code: "207T00000X", desc: "Neurological Surgery", license: "20A17841", primary: true, state: "CA" },
      { code: "2086S0122X", desc: "Surgery of the Spine", license: "20A-17841", primary: false, state: "CA" },
      { code: "207T00000X", desc: "Neurological Surgery", license: "35123456", primary: false, state: "OH" },
      { code: "207T00000X", desc: "Neurological Surgery", license: "", primary: false, state: "NV" },
    ],
  }],
}, CTX);
eq("one license per state and number", twoRows.filter(f => f.section === "licenses").map(f => f.fields.state), ["CA", "OH"]);
eq("primary taxonomy wins the description", twoRows.filter(f => f.section === "licenses")[0].fields.notes,
  "Imported from NPPES NPI Registry (Neurological Surgery)");
eq("a taxonomy with no number is skipped", twoRows.filter(f => f.fields.state === "NV").length, 0);
// A credential the registry files as "--" names no degree, and the DO license
// list has no plain "State Medical License", so no type is guessed at.
const noDegree = normalizeNppes({
  results: [{
    number: "1518456078",
    basic: { first_name: "ERIC", last_name: "WHITNEY", credential: "--" },
    taxonomies: [{ code: "207T00000X", desc: "Neurological Surgery", license: "20A17841", primary: true, state: "CA" }],
  }],
}, CTX);
const noDegreeLicense = noDegree.filter(f => f.section === "licenses")[0];
eq("no degree means no license type is guessed", noDegreeLicense.fields.type, undefined);
eq("no degree asks for the type", noDegreeLicense.needs, ["type", "expirationDate"]);
eq("no degree still carries the number", noDegreeLicense.fields.licenseNumber, "20A17841");
eq("no degree proposes no degree", noDegree.filter(f => f.kind === "profileDegree").length, 0);

eq("nppes with no results", normalizeNppes({ results: [] }, CTX), []);
eq("nppes with nothing at all", normalizeNppes(null, CTX), []);

// ── CMS Doctors and Clinicians ──────────────────────────────────────────────
const cms = normalizeCmsClinician(CMS, CTX);
const school = byId(cms, "cms:education:medicalSchool");
eq("graduation year is a stated record", school.confidence, "record");
eq("med_sch OTHER never becomes a school", school.fields.institution, undefined);
eq("med_sch OTHER never becomes a display name", school.fields.name, undefined);
ok("the education finding says the school is missing", /OTHER/.test(school.detail) && /Add the school/.test(school.detail));
eq("education keeps the degree type", school.fields.type, "Doctor of Osteopathic Medicine (DO)");
eq("education asks for school and date", school.needs, ["institution", "graduationDate"]);
eq("education never invents a graduation date", school.fields.graduationDate, undefined);
ok("the label carries the year", school.label.includes("2018"));

const work = cms.filter(f => f.section === "workHistory");
eq("three CMS rows, two employers", work.length, 2);
eq("employers are title cased", work.map(f => f.fields.employer),
  ["Eisenhower Medical Center", "Cal Med Physicians and Surgeons Inc"]);
eq("work history is a lead", [...new Set(work.map(f => f.confidence))], ["lead"]);
eq("work history city and state", work[0].fields.city + ", " + work[0].fields.state, "Rancho Mirage, CA");
eq("work history never invents dates", [work[0].fields.startDate, work[0].fields.endDate, work[0].fields.current], [undefined, undefined, undefined]);
ok("work history links to Care Compare", work[0].source.url === "https://www.medicare.gov/care-compare/details/physician/1518456078");

// A real school name is kept, and then nothing is missing but the date.
const realSchool = normalizeCmsClinician({
  results: [{ npi: "1", cred: "MD", med_sch: "PHILADELPHIA COLLEGE OF OSTEOPATHIC MEDICINE", grd_yr: "2014", facility_name: "" }],
}, CTX);
eq("a real school is kept", realSchool[0].fields.institution, "Philadelphia College of Osteopathic Medicine");
eq("a real school needs only the date", realSchool[0].needs, ["graduationDate"]);
eq("no facility means no work history", realSchool.filter(f => f.section === "workHistory").length, 0);
eq("cms with no rows", normalizeCmsClinician({ results: [] }, CTX), []);

// ── Facility affiliations ───────────────────────────────────────────────────
const affs = normalizeAffiliations(AFF, HOSP, CTX);
eq("three hospitals", affs.length, 3);
eq("hospitals are named from their CCN", affs.map(f => f.fields.facility), [
  "Eisenhower Medical Center",
  "Arrowhead Regional Medical Center",
  "Riverside University Health System-Medical Center",
]);
eq("an affiliation is only ever a lead", [...new Set(affs.map(f => f.confidence))], ["lead"]);
eq("an affiliation lands in privileges", [...new Set(affs.map(f => f.section))], ["privileges"]);
eq("an affiliation never invents a reappointment date", affs.map(f => f.fields.expirationDate), [undefined, undefined, undefined]);
eq("an affiliation never invents a privilege type", affs.map(f => f.fields.type), [undefined, undefined, undefined]);
eq("an affiliation asks for the reappointment date", affs[0].needs, ["expirationDate"]);
ok("an affiliation says it is claims activity, not a verification",
  affs.every(f => /claims/i.test(f.detail) && /not proof of current privileges/i.test(f.detail)));
ok("an affiliation never claims a status", affs.every(f => !/\bactive\b/i.test(JSON.stringify(f.fields))));
ok("the note carries the CCN", affs[0].fields.notes.includes("050573"));
eq("an affiliation links to the hospital page", affs[0].source.url, "https://www.medicare.gov/care-compare/details/hospital/050573");

// A CCN Hospital General Information cannot name is still a real affiliation.
const unnamed = normalizeAffiliations(AFF, {}, CTX);
eq("an unnamed CCN survives", unnamed.length, 3);
eq("an unnamed CCN says what it is", unnamed[0].label, "Hospital, CCN 050573");
eq("an unnamed CCN invents no facility", unnamed[0].fields.facility, undefined);
eq("duplicate CCNs collapse", normalizeAffiliations({
  results: [
    { facility_type: "Hospital", facility_affiliations_certification_number: "050573" },
    { facility_type: "Hospital", facility_affiliations_certification_number: "050573" },
  ],
}, HOSP, CTX).length, 1);
eq("no affiliations", normalizeAffiliations({ results: [] }, {}, CTX), []);

// ── PubMed ──────────────────────────────────────────────────────────────────
eq("author term", pubmedAuthorTerm({ firstName: "Eric", lastName: "Whitney" }), '"Whitney E"[Author]');
eq("author term without a first name", pubmedAuthorTerm({ lastName: "Whitney" }), '"Whitney"[Author]');
eq("author term needs a surname", pubmedAuthorTerm({ firstName: "Eric" }), "");
// The registers shout, and the term is shown back to the physician.
eq("author term from a shouting register", pubmedAuthorTerm({ firstName: "ERIC", lastName: "WHITNEY" }), '"Whitney E"[Author]');

const pubs = normalizePubmed(PM_SUMMARY, CTX, '"Whitney E"[Author]');
eq("five records in the fixture", pubs.length, 5);
eq("every paper is a lead", [...new Set(pubs.map(f => f.confidence))], ["lead"]);
eq("every paper lands in publications", [...new Set(pubs.map(f => f.section))], ["publications"]);
ok("every paper says the match is by name",
  pubs.every(f => /Matched by author name only/.test(f.detail)));
ok("every paper shows the journal, the year and the authors",
  pubs.every(f => /\d{4}/.test(f.detail) && /Authors:/.test(f.detail)));
const volcano = byId(pubs, "pubmed:publication:42350380");
eq("the citation reads as a citation", volcano.fields.citation,
  "Luo B, Beck S, Deymier P, et al. Geometric phase sensing using seismic waves for comprehensive volcano monitoring at Kı̄lauea Hawaii. Nat Commun. 2026;17(1). doi:10.1038/s41467-026-73998-x");
eq("pmid", volcano.fields.pmid, "42350380");
eq("doi", volcano.fields.doi, "10.1038/s41467-026-73998-x");
eq("year", volcano.fields.year, "2026");
eq("link", volcano.fields.url, "https://pubmed.ncbi.nlm.nih.gov/42350380/");
ok("the short label names the journal and year", volcano.fields.name.startsWith("Nat Commun 2026: "));
ok("the note names the search term", volcano.fields.notes.includes('"Whitney E"[Author]'));
// The fixture is a seismology paper by a different Whitney E, which is exactly
// why nothing here may be presented as the physician's own work.
ok("a name match returns other people's papers", /volcano/i.test(volcano.fields.citation));

// A StatPearls chapter: PubMed leaves source and fulljournalname empty and
// carries the venue in booktitle. Reading only the journal fields dropped the
// venue out of the citation, which is the line that goes on the CV.
const chapter = byId(pubs, "pubmed:publication:31424740");
eq("a book record has no journal at all", [PM_SUMMARY.result["31424740"].source, PM_SUMMARY.result["31424740"].fulljournalname], ["", ""]);
ok("a chapter citation names the book", chapter.fields.citation.includes("StatPearls"),
  chapter.fields.citation);
eq("the chapter citation reads as a citation", chapter.fields.citation,
  "Whitney E, Munakomi S. Hoffmann Sign. StatPearls. 2026.");
ok("the chapter short name leads with the book", chapter.fields.name.startsWith("StatPearls "), chapter.fields.name);
ok("the chapter detail names the book before the year", chapter.detail.startsWith("StatPearls, 2026"), chapter.detail);
ok("the chapter detail never opens on a bare year", !/^\d{4}/.test(chapter.detail), chapter.detail);
eq("a chapter is still only a lead", chapter.confidence, "lead");

// Nothing to name the venue with leaves the title standing on its own rather
// than a name that opens on a colon.
const venueless = normalizePubmed({
  result: { uids: ["9"], "9": { uid: "9", title: "A note.", authors: [{ name: "Whitney E" }] } },
}, CTX);
eq("no venue and no year still reads", venueless[0].fields.name, "A note");

eq("pubmed with nothing", normalizePubmed(null, CTX), []);
ok("every summary came from the search fixture",
  PM_SUMMARY.result.uids.every(id => PM_SEARCH.esearchresult.idlist.includes(id)));

// ── The whole envelope ──────────────────────────────────────────────────────
const env = buildEnvelope({
  nppes: NPPES,
  cmsClinician: CMS,
  cmsAffiliation: AFF,
  hospitals: HOSP,
  pubmedSummary: PM_SUMMARY,
  pubmedTerm: '"Whitney E"[Author]',
  sources: [{ id: "nppes", name: "NPPES NPI Registry", url: "", fetchedAt: CTX.fetchedAt, status: "ok", count: 1 }],
  errors: [{ source: "pubmed", message: "PubMed timed out" }],
}, CTX);
eq("the envelope counts every finding", env.findings.length, nppes.length + cms.length + affs.length + pubs.length);
eq("the envelope carries the sources", env.sources.length, 1);
eq("the envelope carries the errors", env.errors[0].source, "pubmed");
eq("the envelope carries the npi and the timestamp", [env.npi, env.fetchedAt], ["1518456078", CTX.fetchedAt]);
eq("sections come in reading order", [...new Set(env.findings.map(f => f.section))],
  ["settings", "licenses", "education", "workHistory", "privileges", "publications"]);
ok("every finding names a source and a fetch time",
  env.findings.every(f => f.source.name && f.source.fetchedAt === CTX.fetchedAt));
ok("every finding is a record or a lead",
  env.findings.every(f => f.confidence === "record" || f.confidence === "lead"));
ok("every finding has a stable id", new Set(env.findings.map(f => f.id)).size === env.findings.length);
ok("no finding carries an empty field", env.findings.every(f => Object.values(f.fields).every(v => v !== "")));
ok("nothing user facing uses an em dash", !JSON.stringify(env).includes("—"));

// A dead register degrades: the rest still normalizes.
const degraded = buildEnvelope({
  nppes: null, cmsClinician: CMS, cmsAffiliation: null, hospitals: {}, pubmedSummary: null,
  errors: [{ source: "nppes", message: "NPPES returned 503" }],
}, CTX);
eq("a dead register costs only its own findings", degraded.findings.length, cms.length);
eq("a dead register is reported", degraded.errors[0].message, "NPPES returned 503");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
