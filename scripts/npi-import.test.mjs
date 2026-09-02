// Unit-style checks for src/utils/npiImport.js, the pure half of the NPI
// import: name splitting for the registry search, the NPPES v2.1 name-query
// rules (wildcard only after two characters, state never alone), license
// extraction that keeps EVERY state the registry lists and dedupes the rows
// two specialties share, and the merge that never duplicates a license the
// physician already typed. Run: node scripts/npi-import.test.mjs
// Pure node, no test runner. Exit code 1 on any failure.
import {
  splitName, nameSearchParams, licenseKey, extractLicensesFromNPI,
  licenseTypeFor, mergeNpiLicenses, additionalStatesAfterImport, degreeFromCredential,
} from "../src/utils/npiImport.js";

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`FAIL ${name}\n   got  ${g}\n   want ${w}`); }
};
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.log(`FAIL ${name} ${extra}`); } };

// ── splitName ──
eq("name first last", splitName("Eric Whitney"), { firstName: "Eric", lastName: "Whitney" });
eq("name middle initial", splitName("Eric W. Whitney"), { firstName: "Eric", lastName: "Whitney" });
eq("name trailing credential", splitName("Eric Whitney, DO"), { firstName: "Eric", lastName: "Whitney" });
eq("name two credentials", splitName("Jane Roe MD PhD"), { firstName: "Jane", lastName: "Roe" });
eq("name generational", splitName("John Smith Jr."), { firstName: "John", lastName: "Smith" });
eq("name last-first", splitName("Whitney, Eric"), { firstName: "Eric", lastName: "Whitney" });
eq("name last-first with credential", splitName("Whitney, Eric W., DO"), { firstName: "Eric", lastName: "Whitney" });
eq("name surname Do survives", splitName("Anh Do"), { firstName: "Anh", lastName: "Do" });
eq("name single token", splitName("Whitney"), { firstName: "", lastName: "Whitney" });
eq("name whitespace", splitName("  Eric   Whitney  "), { firstName: "Eric", lastName: "Whitney" });
eq("name empty", splitName(""), { firstName: "", lastName: "" });
eq("name null", splitName(null), { firstName: "", lastName: "" });

// ── nameSearchParams (NPPES v2.1 rules) ──
eq("params plain", nameSearchParams({ firstName: "Eric", lastName: "Whitney", state: "ca" }),
  { version: "2.1", enumeration_type: "NPI-1", first_name: "Eric", last_name: "Whitney", state: "CA", limit: "20" });
eq("params wildcard on first", nameSearchParams({ firstName: "Eri", lastName: "Whitney", wildcard: true }).first_name, "Eri*");
eq("params wildcard needs two chars", nameSearchParams({ firstName: "E", lastName: "Whitney", wildcard: true }).first_name, "E");
eq("params user star stripped", nameSearchParams({ firstName: "Er*", lastName: "Whit*ney" }), { version: "2.1", enumeration_type: "NPI-1", first_name: "Er", last_name: "Whitney", limit: "20" });
eq("params last only", nameSearchParams({ lastName: "Whitney" }), { version: "2.1", enumeration_type: "NPI-1", last_name: "Whitney", limit: "20" });
eq("params state alone is nothing", nameSearchParams({ state: "OH" }), null);
eq("params empty", nameSearchParams({}), null);
eq("params limit clamp high", nameSearchParams({ lastName: "X", limit: 999 }).limit, "200");
eq("params limit clamp low", nameSearchParams({ lastName: "X", limit: 0 }).limit, "20");

// ── licenseKey ──
eq("key normalizes punctuation and case", licenseKey("oh", "35.123456"), licenseKey("OH", "35123456"));
eq("key spaces", licenseKey("CA ", " A 12345 "), "CA|A12345");
ok("key state matters", licenseKey("CA", "1") !== licenseKey("OH", "1"));

// ── extractLicensesFromNPI: every state, deduped, primary first ──
const multi = { allTaxonomies: [
  { code: "208600000X", description: "Surgery", license: "35123456", state: "OH", isPrimary: false },
  { code: "2086S0105X", description: "Surgical Critical Care", license: "35123456", state: "OH", isPrimary: false },
  { code: "208G00000X", description: "Thoracic Surgery", license: "A12345", state: "CA", isPrimary: true },
  { code: "208600000X", description: "Surgery", license: "", state: "TX", isPrimary: false },
  { code: "208600000X", description: "Surgery", license: "999", state: "", isPrimary: false },
] };
const ex = extractLicensesFromNPI(multi);
eq("extract count (OH once, CA once, TX/blank dropped)", ex.length, 2);
eq("extract primary first", ex.map(l => l.state), ["CA", "OH"]);
eq("extract OH keeps first description", ex[1].description, "Surgery");
eq("extract fields", ex[0], { licenseNumber: "A12345", state: "CA", taxonomyCode: "208G00000X", description: "Thoracic Surgery" });
eq("extract dedupes punctuation variants", extractLicensesFromNPI({ allTaxonomies: [
  { license: "35.123456", state: "OH", isPrimary: true }, { license: "35123456", state: "oh" },
] }).length, 1);
eq("extract lowercase state uppercased", extractLicensesFromNPI({ allTaxonomies: [{ license: "1", state: "oh" }] })[0].state, "OH");
eq("extract empty", extractLicensesFromNPI(null), []);
eq("extract no taxonomies", extractLicensesFromNPI({}), []);

// ── licenseTypeFor / degreeFromCredential ──
eq("type MD", licenseTypeFor("MD"), "State Medical License");
eq("type DO", licenseTypeFor("DO"), "State Medical License (DO)");
eq("type unset", licenseTypeFor(""), "State Medical License");
eq("degree D.O.", degreeFromCredential("D.O."), "DO");
eq("degree MD, PHD", degreeFromCredential("MD, PHD"), "MD");
eq("degree DO FACOS", degreeFromCredential("DO FACOS"), "DO");
eq("degree OD is not DO", degreeFromCredential("OD"), "");
eq("degree DMD is not MD", degreeFromCredential("DMD"), "");
eq("degree empty", degreeFromCredential(""), "");

// ── mergeNpiLicenses ──
let n = 0;
const makeId = () => `id${++n}`;
const existing = [
  { id: "x", type: "State Medical License", state: "OH", licenseNumber: "35.123456" },
  { id: "y", type: "DEA Registration", state: "CA", licenseNumber: "BW1234567" },
];
const merged = mergeNpiLicenses(existing, ex, { degreeType: "DO", makeId });
eq("merge skips the hand-typed OH license", merged.map(l => l.state), ["CA"]);
eq("merge item shape", merged[0], {
  id: "id1", type: "State Medical License (DO)", name: "CA Medical License", licenseNumber: "A12345", state: "CA",
  issuedDate: "", expirationDate: "", notes: "Imported from NPPES NPI Registry (Thoracic Surgery)", npiImported: true,
});
eq("merge adds both when nothing exists", mergeNpiLicenses([], ex, { degreeType: "MD", makeId }).map(l => [l.state, l.type]), [["CA", "State Medical License"], ["OH", "State Medical License"]]);
eq("merge is idempotent", mergeNpiLicenses([...existing, ...merged], ex, { makeId }), []);
eq("merge dedupes within one batch", mergeNpiLicenses([], [{ state: "OH", licenseNumber: "1" }, { state: "OH", licenseNumber: "0001".replace(/^0+/, "") }], { makeId }).length, 1);
eq("merge drops blanks", mergeNpiLicenses([], [{ state: "", licenseNumber: "1" }, { state: "OH", licenseNumber: "" }], { makeId }), []);
eq("merge no description note", mergeNpiLicenses([], [{ state: "OH", licenseNumber: "7" }], { makeId })[0].notes, "Imported from NPPES NPI Registry");
ok("merge default id", typeof mergeNpiLicenses([], [{ state: "OH", licenseNumber: "7" }])[0].id === "string");

// ── additionalStatesAfterImport ──
eq("states adds non-primary", additionalStatesAfterImport([], "CA", ex), ["OH"]);
eq("states keeps existing order and dedupes", additionalStatesAfterImport(["NY", "OH"], "CA", ex), ["NY", "OH"]);
eq("states excludes primary", additionalStatesAfterImport(["CA"], "CA", ex), ["OH"]);
eq("states empty", additionalStatesAfterImport([], "", []), []);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
